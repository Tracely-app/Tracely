/* The sharded, objective check (lib/factcheck.js runFactCheck).
 *
 *  - A list longer than one shard runs as concurrent calls, and the findings
 *    come back in the INPUT order whatever order the calls answered in.
 *  - The route's admission hook is asked once, for the extra calls; refused
 *    (or throwing), the check runs as ONE call, exactly as before.
 *  - A shard that fails still reports what the other shards were billed.
 *  - The model's two finding shapes both flatten to the wire shape, and a
 *    "false" that names no basis is demoted to "questionable".
 *  - The union schema passes the strict-mode walker, and a non-strict branch
 *    does not. */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
process.env.TRACELY_CHECK_SHARD = "3";

const { runFactCheck, shardSentences, normalizeFinding, CHECK_SHARD_SENTENCES } = await import("../lib/factcheck.js");
const { assertStrictSchema } = await import("../lib/llm.js");

const sentence = (i) => ({ id: `s${i}`, text: `Sentence ${i}.` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Answers each call with one finding per sentence it was sent. `delayFor`
 * lets a later shard answer FIRST, to prove the merge keeps input order. */
function stubFetch({ delayFor = () => 0, fail = () => false, shape = "union", omit = () => false } = {}) {
  const calls = [];
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    // The Responses body carries the user prompt as a plain string (providers/openai.js structuredBody).
    const user = typeof body.input === "string" ? body.input : JSON.stringify(body.input);
    const ids = [...user.matchAll(/^\[(s\d+)\]/gm)].map((m) => m[1]);
    calls.push(ids);
    await sleep(delayFor(ids));
    if (fail(ids)) {
      return { ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) };
    }
    const findings = ids.filter((id) => !omit(id, calls.length)).map((id) => {
      const n = Number(id.slice(1));
      if (shape === "flat") return { id, verdict: n % 2 ? "accurate" : "false", explanation: "x", revision: "y", confidence: "high" };
      return n % 2
        ? { id, verdict: "accurate" }
        : { id, verdict: "false", basis: `Fact ${n} is otherwise.`, explanation: `Wrong ${n}.`, revision: `Right ${n}.`, confidence: "high" };
    });
    return {
      ok: true,
      json: async () => ({ status: "completed", model: body.model, output_text: JSON.stringify({ findings }), output: [], usage: { input_tokens: 10, output_tokens: 5 } }),
    };
  };
  return calls;
}

test("shardSentences: near-equal shards, never more than the shard size, input order kept", () => {
  assert.equal(CHECK_SHARD_SENTENCES, 3);
  assert.deepEqual(shardSentences([1, 2, 3]).map((s) => s.length), [3]);
  assert.deepEqual(shardSentences([1, 2, 3, 4]).map((s) => s.length), [2, 2]);
  assert.deepEqual(shardSentences([1, 2, 3, 4, 5, 6, 7]).map((s) => s.length), [3, 3, 1]);
  assert.deepEqual(shardSentences([1, 2, 3, 4, 5, 6, 7], 8), [[1, 2, 3, 4, 5, 6, 7]]);
  assert.deepEqual(shardSentences([1, 2, 3, 4, 5]).flat(), [1, 2, 3, 4, 5]);
});

test("a long list runs as concurrent shards and the findings come back in input order", async () => {
  // The first shard answers LAST.
  const calls = stubFetch({ delayFor: (ids) => (ids[0] === "s1" ? 60 : 0) });
  const sentences = [1, 2, 3, 4, 5, 6, 7].map(sentence);
  const r = await runFactCheck({ text: "doc", sentences });
  assert.equal(calls.length, 3, "three shards of 3/3/1");
  assert.deepEqual(r.findings.map((f) => f.id), sentences.map((s) => s.id));
  assert.equal(r.shards, 3);
  assert.deepEqual(r.usage, { input: 30, output: 15, cached: 0, cacheWrite: 0 }, "usage is the sum of every shard");
  const f2 = r.findings.find((f) => f.id === "s2");
  assert.equal(f2.verdict, "false");
  assert.equal(f2.basis, "Fact 2 is otherwise.");
  assert.equal(f2.explanation, "Wrong 2.");
  const f1 = r.findings.find((f) => f.id === "s1");
  assert.deepEqual(f1, { id: "s1", verdict: "accurate", explanation: "", revision: "", confidence: "medium" }, "a clean finding carries no basis");
});

test("admitCalls is asked once with the number of EXTRA calls; refused or throwing, the check is one call", async () => {
  const sentences = [1, 2, 3, 4, 5, 6, 7].map(sentence);
  let asked = [];
  let calls = stubFetch();
  await runFactCheck({ text: "doc", sentences, admitCalls: (n) => { asked.push(n); return true; } });
  assert.deepEqual(asked, [2]);
  assert.equal(calls.length, 3);

  calls = stubFetch();
  const r = await runFactCheck({ text: "doc", sentences, admitCalls: () => false });
  assert.equal(calls.length, 1, "refused: one call");
  assert.deepEqual(r.findings.map((f) => f.id), sentences.map((s) => s.id));
  assert.equal(r.shards, undefined);

  calls = stubFetch();
  await runFactCheck({ text: "doc", sentences, admitCalls: () => { throw new Error("db"); } });
  assert.equal(calls.length, 1, "a hook that throws refuses");

  calls = stubFetch();
  await runFactCheck({ text: "doc", sentences: sentences.slice(0, 3), admitCalls: () => { throw new Error("never asked"); } });
  assert.equal(calls.length, 1, "one shard never asks");
});

test("a failing shard reports what the other shards were billed", async () => {
  stubFetch({ fail: (ids) => ids[0] === "s4" });
  const sentences = [1, 2, 3, 4, 5, 6, 7].map(sentence);
  const err = await runFactCheck({ text: "doc", sentences }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.llm?.usage?.input, 20, "the two shards that answered were billed 10 input tokens each");
  assert.equal(err.llm?.usage?.output, 10);
});

test("normalizeFinding: both model shapes and the old flat shape flatten to the wire shape", () => {
  assert.deepEqual(normalizeFinding({ id: "a", verdict: "accurate" }),
    { id: "a", verdict: "accurate", explanation: "", revision: "", confidence: "medium" });
  assert.deepEqual(normalizeFinding({ id: "b", verdict: "needs_citation", basis: "A government statistics office.", explanation: "Cite the source.", revision: "should be dropped", confidence: "high" }),
    { id: "b", verdict: "needs_citation", explanation: "Cite the source.", revision: "", confidence: "high", basis: "A government statistics office." });
  // The old flat shape (a mock, an older test) still reads.
  assert.deepEqual(normalizeFinding({ id: "c", verdict: "accurate", explanation: "ignored", revision: "ignored", confidence: "low" }),
    { id: "c", verdict: "accurate", explanation: "", revision: "", confidence: "low" });
  assert.equal(normalizeFinding({ id: "d", verdict: "nonsense" }).verdict, "no_claim");
});

test("a 'false' with no stated basis is a doubt, not a contradiction: demoted to questionable", () => {
  const f = normalizeFinding({ id: "e", verdict: "false", basis: "", explanation: "Seems off.", revision: "Fixed.", confidence: "high" });
  assert.equal(f.verdict, "questionable");
  assert.equal(f.explanation, "Seems off.");
  assert.equal(f.basis, undefined);
  const g = normalizeFinding({ id: "f", verdict: "false", basis: "The Wall is not visible unaided from orbit.", explanation: "", revision: "x", confidence: "high" });
  assert.equal(g.verdict, "false");
  assert.equal(g.explanation, g.basis, "an empty explanation falls back to the basis");
});

test("the union schema is strict-mode clean, and a loose branch is caught", () => {
  const ok = { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { anyOf: [
    { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
    { type: "object", additionalProperties: false, required: ["id", "why"], properties: { id: { type: "string" }, why: { type: "string" } } },
  ] } } } };
  assert.doesNotThrow(() => assertStrictSchema(ok, "t"));
  const loose = structuredClone(ok);
  delete loose.properties.items.items.anyOf[1].additionalProperties;
  assert.throws(() => assertStrictSchema(loose, "t"), /additionalProperties:false/);
  const unlisted = structuredClone(ok);
  unlisted.properties.items.items.anyOf[1].required = ["id"];
  assert.throws(() => assertStrictSchema(unlisted, "t"), /missing why/);
});

test("an id the model left out is asked again once, on its own; a second miss stands", async () => {
  // The first call drops s2; the retry (call 2, for s2 alone) answers it.
  let calls = stubFetch({ omit: (id, n) => id === "s2" && n === 1 });
  const r = await runFactCheck({ text: "doc", sentences: [1, 2, 3].map(sentence) });
  assert.deepEqual(calls, [["s1", "s2", "s3"], ["s2"]]);
  assert.deepEqual(r.findings.map((f) => f.id).sort(), ["s1", "s2", "s3"]);
  assert.equal(r.usage.input, 20, "both calls billed");
  // Dropped twice: asked once more, then left for the client's next cycle.
  calls = stubFetch({ omit: (id) => id === "s2" });
  const r2 = await runFactCheck({ text: "doc", sentences: [1, 2, 3].map(sentence) });
  assert.deepEqual(calls, [["s1", "s2", "s3"], ["s2"]]);
  assert.deepEqual(r2.findings.map((f) => f.id), ["s1", "s3"]);
  // Everything missing is not a miss to retry — that is an answer that did not parse to any id.
  calls = stubFetch({ omit: () => true });
  const r3 = await runFactCheck({ text: "doc", sentences: [1, 2].map(sentence) });
  assert.equal(calls.length, 1);
  assert.deepEqual(r3.findings, []);
});
