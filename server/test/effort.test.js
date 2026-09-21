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

test("the flow check sends an effort too", async () => {
  const sent = stubFetch();
  await runFlowCheck({ text: "One paragraph.\n\nAnother paragraph entirely." });
  assert.equal(sent[0].reasoning?.effort, "low");
});
