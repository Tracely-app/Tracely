/**
 * Paying less for repeated work, with every answer unchanged (2026-10-17):
 * the hourly usage lines that show what the prompt cache saves, the optional
 * prompt_cache_key on a caller's checks, and that the key never changes what
 * is asked. (The extension's hold on a failed batch is in
 * ext-check-timing.test.js; the desktop's pinned search query in webSources.ts.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "tracely-cost-"));
process.env.TRACELY_DATA_DIR = TMP;
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
delete process.env.TRACELY_MOCK;

const { tallyCall, takeUsageLines } = await import("../lib/usageTally.js");
const { structuredCall } = await import("../lib/llm.js");
const { runFactCheck } = await import("../lib/factcheck.js");

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

test("the hourly usage line says how much of each route's input the cache served and wrote — counts only", () => {
  takeUsageLines(); // start clean
  tallyCall("/api/check", { usage: { input: 2500, cached: 1600, cacheWrite: 0, output: 400 }, cost: 900_000 });
  tallyCall("/api/check", { usage: { input: 2500, cached: 0, cacheWrite: 1600, output: 300 }, cost: 1_100_000 });
  tallyCall("/api/sources", { usage: { input: 13_700, output: 900 }, webSearchCalls: 1, cost: 12_800_000 });
  tallyCall("a user's sentence that must never be a key", { usage: { input: 10 } });
  const lines = takeUsageLines();
  assert.deepEqual(lines, [
    "[tracely] usage route=/api/check calls=2 in=5000 cached=1600 (32%) write=1600 (32%) out=700 searches=0 cost=$0.0200",
    "[tracely] usage route=/api/sources calls=1 in=13700 cached=0 (0%) write=0 (0%) out=900 searches=1 cost=$0.1280",
    "[tracely] usage route=other calls=1 in=10 cached=0 (0%) write=0 (0%) out=0 searches=0 cost=$0.0000",
  ]);
  assert.deepEqual(takeUsageLines(), [], "each take starts the next hour fresh");
});

function stub(steps) {
  const sent = [];
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    return steps[Math.min(sent.length - 1, steps.length - 1)](body);
  };
  return sent;
}
const answer = (payload) => (body) => ({ ok: true, status: 200, json: async () => ({ status: "completed", model: body.model, output_text: JSON.stringify(payload), output: [], usage: { input_tokens: 10, output_tokens: 5 } }) });

test("a cache key is sent when given, changes nothing else, and a vendor that refuses it is answered without it", async () => {
  const sent = stub([answer({ ok: true })]);
  await structuredCall({ model: "gpt-5.6-luna", system: "s", user: "u", schema: SCHEMA, maxTokens: 100, what: "t", effort: "low", cacheKey: "tc-abc" });
  await structuredCall({ model: "gpt-5.6-luna", system: "s", user: "u", schema: SCHEMA, maxTokens: 100, what: "t", effort: "low" });
  assert.equal(sent[0].prompt_cache_key, "tc-abc");
  assert.equal(sent[1].prompt_cache_key, undefined, "absent unless asked for");
  const { prompt_cache_key: _k, ...rest } = sent[0];
  assert.deepEqual(rest, sent[1], "the request is otherwise byte-for-byte the same");

  const refused = stub([() => ({ ok: false, status: 400, json: async () => ({ error: { message: "Unknown parameter: 'prompt_cache_key'.", param: "prompt_cache_key" } }) }), answer({ ok: true })]);
  const r = await structuredCall({ model: "gpt-6-astra", system: "s", user: "u", schema: SCHEMA, maxTokens: 100, what: "t", effort: "low", cacheKey: "tc-abc" });
  assert.deepEqual(r.parsed, { ok: true }, "the call still answers");
  assert.equal(refused[1].prompt_cache_key, undefined, "retried without the key");
  await structuredCall({ model: "gpt-6-astra", system: "s", user: "u", schema: SCHEMA, maxTokens: 100, what: "t", effort: "low", cacheKey: "tc-abc" });
  assert.equal(refused[2].prompt_cache_key, undefined, "and not sent again to a model that refused it");
});

test("every shard of a check carries the caller's key", async () => {
  const sent = stub([(body) => {
    const ids = [...String(body.input).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    return answer({ findings: ids.map((id) => ({ id, verdict: "accurate", explanation: "", revision: "", confidence: "high", basis: "" })) })(body);
  }]);
  const sentences = Array.from({ length: 20 }, (_, i) => ({ id: `s${i + 1}`, text: `Sentence number ${i + 1} is here.` }));
  await runFactCheck({ text: "doc", sentences, model: "gpt-5.6-luna", effort: "medium", cacheKey: "tc-k1" }).catch(() => {});
  assert.ok(sent.length >= 2, `sharded (${sent.length} calls)`);
  assert.ok(sent.every((b) => b.prompt_cache_key === "tc-k1"), "each call keyed alike, so they land on the same cache");
});
