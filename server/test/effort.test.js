/**
 * Reasoning effort must actually reach the API.
 *
 * Omitting `reasoning` from a Responses request does NOT mean "do not reason".
 * It means OpenAI chooses, and what it chooses is expensive. Measured on
 * gpt-5-nano against the real fact-check prompt over 8 hard sentences
 * (2026-09-13): omitted = 33.3s / 6165 output tokens, low = 10.5s / 1546, with
 * identical verdicts. runFactCheck shipped destructuring `effort` and never
 * using it, so every check in production paid that 4x for nothing.
 *
 * That bug is invisible in every way that usually catches things — the call
 * succeeds, the verdicts are right, the tests pass, and nothing logs. Only the
 * latency and the bill move. Hence this file: it asserts on the request body
 * itself, which is the only place the mistake is visible.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runFactCheck, runFlowCheck } from "../lib/factcheck.js";

process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";

/** Capture request bodies and answer with a well-formed empty response. */
function stubFetch(reply) {
  const sent = [];
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    const schema = body.text?.format?.schema;
    const payload = reply ? reply(body) : JSON.stringify(emptyFor(schema));
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        model: body.model,
        output_text: payload,
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
  };
  return sent;
}
function emptyFor(schema) {
  if (!schema) return "{}";
  const out = {};
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    out[k] = v.type === "array" ? [] : v.type === "object" ? emptyFor(v) : v.type === "number" ? 0 : "";
  }
  return out;
}

const SENTENCES = [{ id: "s1", text: "The sky is blue." }];

test("a fact check with no explicit effort still sends reasoning.effort", async () => {
  const sent = stubFetch();
  await runFactCheck({ text: "The sky is blue.", sentences: SENTENCES });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reasoning?.effort, "low", "the shipped default must not be OpenAI's default");
});

test("an explicit effort is honoured — the slider is not decorative", async () => {
  const sent = stubFetch();
  await runFactCheck({ text: "The sky is blue.", sentences: SENTENCES, effort: "medium" });
  assert.equal(sent[0].reasoning?.effort, "medium");
});

test("a batch split by truncation keeps the effort on both halves", async () => {
  // First call truncates, forcing checkBatch to halve and retry.
  let n = 0;
  const sent = [];
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    const truncated = n++ === 0;
    return {
      ok: true,
      json: async () => ({
        status: truncated ? "incomplete" : "completed",
        incomplete_details: truncated ? { reason: "max_output_tokens" } : undefined,
        model: body.model,
        output_text: truncated ? "" : JSON.stringify({ findings: [] }),
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
  };
  await runFactCheck({
    text: "a b",
    sentences: [{ id: "s1", text: "First." }, { id: "s2", text: "Second." }],
    effort: "medium",
  });
  assert.ok(sent.length >= 3, "expected one truncated call plus two halves");
  for (const body of sent) assert.equal(body.reasoning?.effort, "medium");
});

test("a split check's usage sums every call's cache reads AND writes, the truncated one included", async () => {
  // Dropping cacheWrite in the sum would price the halves' cache writes as
  // plain input — under the 1.25x write rate the tier models bill.
  let n = 0;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const truncated = n++ === 0;
    return {
      ok: true,
      json: async () => ({
        status: truncated ? "incomplete" : "completed",
        incomplete_details: truncated ? { reason: "max_output_tokens" } : undefined,
        model: body.model,
        output_text: truncated ? "" : JSON.stringify({ findings: [] }),
        output: [],
        usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 70 } },
      }),
    };
  };
  const r = await runFactCheck({ text: "a b", sentences: [{ id: "s1", text: "First." }, { id: "s2", text: "Second." }] });
  assert.equal(n, 3, "one truncated call plus two halves");
  assert.deepEqual(r.usage, { input: 300, output: 30, cached: 60, cacheWrite: 210 });
});

/* A split check whose calls answer as scripted: "trunc" (billed, truncated),
 * "ok" (billed, answered), "timeout" (nothing came back, nothing billed). */
function scriptedFetch(script, usage = { input_tokens: 1000, output_tokens: 16000 }) {
  let n = 0;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const step = script[n++] ?? "ok";
    if (step === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const truncated = step === "trunc";
    return {
      ok: true,
      json: async () => ({
        status: truncated ? "incomplete" : "completed",
        incomplete_details: truncated ? { reason: "max_output_tokens" } : undefined,
        model: body.model,
        output_text: truncated ? "" : JSON.stringify({ findings: [] }),
        output: [],
        usage,
      }),
    };
  };
  return () => n;
}
const TWO = [{ id: "s1", text: "First." }, { id: "s2", text: "Second." }];

test("a split whose second half truncates still reports every call it was billed for", async () => {
  // Outer truncates, half 1 answers, half 2 (one sentence, cannot split)
  // truncates and throws. The route records only the error's usage, which
  // used to be half 2's alone — the outer call's 16k output tokens vanished.
  const calls = scriptedFetch(["trunc", "ok", "trunc"]);
  const err = await runFactCheck({ text: "a b", sentences: TWO, model: "gpt-6-astra" }).catch((e) => e);
  assert.equal(calls(), 3);
  assert.equal(err.kind, "truncated", "the wire error is unchanged");
  assert.deepEqual(err.llm.usage, { input: 3000, output: 48000, cached: 0, cacheWrite: 0 });
  assert.equal(err.llm.model, "gpt-6-astra");
  assert.equal(Object.keys(err).includes("llm"), false, "the tag stays off the wire");
});

test("a split whose half fails with nothing billed still carries what the calls before it cost", async () => {
  const calls = scriptedFetch(["trunc", "ok", "timeout"]);
  const err = await runFactCheck({ text: "a b", sentences: TWO, model: "gpt-6-astra", effort: "low" }).catch((e) => e);
  assert.equal(calls(), 3);
  assert.equal(err.kind, "timeout");
  assert.deepEqual(err.llm.usage, { input: 2000, output: 32000, cached: 0, cacheWrite: 0 }, "the truncated call + half 1");
  assert.deepEqual({ model: err.llm.model, effort: err.llm.effort }, { model: "gpt-6-astra", effort: "low" });
});

test("a nested split that fails carries every level's billed calls", async () => {
  // 4 sentences: outer truncates; half [s1,s2] truncates, [s1] ok, [s2] truncates.
  const calls = scriptedFetch(["trunc", "trunc", "ok", "trunc"]);
  const four = [...TWO, { id: "s3", text: "Third." }, { id: "s4", text: "Fourth." }];
  const err = await runFactCheck({ text: "a b", sentences: four, model: "gpt-6-astra" }).catch((e) => e);
  assert.equal(calls(), 4, "the second top-level half never ran");
  assert.deepEqual(err.llm.usage, { input: 4000, output: 64000, cached: 0, cacheWrite: 0 });
});

test("a split is asked for before it is made: refused, the check fails as truncated with the call it made", async () => {
  // The route's admitSplit holds the halves' worst case against a spend pool;
  // one reservation covers ONE call, and a split makes two more.
  let calls = scriptedFetch(["trunc"]);
  let asked = 0;
  const err = await runFactCheck({ text: "a b", sentences: TWO, model: "gpt-6-astra", admitSplit: () => { asked++; return false; } }).catch((e) => e);
  assert.equal(asked, 1);
  assert.equal(calls(), 1, "no halves without admission");
  assert.equal(err.kind, "truncated");
  assert.deepEqual(err.llm.usage, { input: 1000, output: 16000, cached: 0, cacheWrite: 0 }, "the truncated call is still recorded");

  // Admitted at every level: a nested split asks once per split.
  calls = scriptedFetch(["trunc", "trunc", "ok", "ok", "ok"]);
  asked = 0;
  const four = [...TWO, { id: "s3", text: "Third." }, { id: "s4", text: "Fourth." }];
  const r = await runFactCheck({ text: "a b", sentences: four, model: "gpt-6-astra", admitSplit: () => { asked++; return true; } });
  assert.equal(asked, 2);
  assert.equal(calls(), 5);
  assert.equal(r.usage.output, 80000);

  // A hook that throws refuses rather than losing the truncated call's usage.
  calls = scriptedFetch(["trunc"]);
  const thrown = await runFactCheck({ text: "a b", sentences: TWO, admitSplit: () => { throw new Error("db"); } }).catch((e) => e);
  assert.equal(calls(), 1);
  assert.equal(thrown.kind, "truncated");
  assert.equal(thrown.llm.usage.output, 16000);
});

test("the flow check sends an effort too", async () => {
  const sent = stubFetch();
  await runFlowCheck({ text: "One paragraph.\n\nAnother paragraph entirely." });
  assert.equal(sent[0].reasoning?.effort, "low");
});
