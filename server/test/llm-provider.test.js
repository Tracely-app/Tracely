/**
 * The provider seam, exercised end to end with a stubbed fetch.
 *
 * Worth having because NOTHING else reaches lib/llm.js without a key: mock
 * mode short-circuits inside lib/ai.js, well above the transport, so the whole
 * module was previously covered only by whether the server booted. A refactor
 * that silently dropped `reasoning`, or renamed a body field, would have
 * shipped green and only shown up as a 400 in production.
 *
 * Stubbing fetch rather than the provider module on purpose: the thing under
 * test IS the request body that leaves this process.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { structuredCall, textCall, webSearchCall, DEFAULT_EFFORT, providerId, hasApiKey } from "../lib/llm.js";
import * as openai from "../lib/providers/openai.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" } },
};

/** Capture the outgoing request and answer with a canned Responses payload. */
function stubFetch(reply, { status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply,
    };
  };
  return calls;
}

const okReply = (text = '{"verdict":"sound"}') => ({
  model: "gpt-5-nano",
  output_text: text,
  usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
});

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";

test("openai is the active provider, and the key is read from the environment", () => {
  assert.equal(providerId, "openai");
  assert.ok(hasApiKey());
});

test("a structured call sends the Responses json_schema format, strict", async () => {
  const calls = stubFetch(okReply());
  const { parsed, usage } = await structuredCall({
    model: "gpt-5-nano", system: "SYS", user: "USER", schema: SCHEMA, maxTokens: 512, what: "critique", name: "critique",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test-not-a-real-key");

  const body = calls[0].body;
  assert.equal(body.model, "gpt-5-nano");
  assert.equal(body.instructions, "SYS");
  assert.equal(body.input, "USER");
  assert.equal(body.max_output_tokens, 512);
  assert.deepEqual(body.text, { format: { type: "json_schema", name: "critique", schema: SCHEMA, strict: true } });
  assert.deepEqual(body.reasoning, { effort: DEFAULT_EFFORT });

  assert.deepEqual(parsed, { verdict: "sound" });
  // input_tokens is the TOTAL and cached is a subset of it; costMicroCents
  // subtracts one from the other, so passing them through unchanged matters.
  assert.deepEqual(usage, { input: 100, output: 20, cached: 40 });
});

test("an unknown model resolves down to the cheap one before it is sent", async () => {
  const calls = stubFetch(okReply());
  await structuredCall({ model: "gpt-9-imaginary", system: "S", user: "U", schema: SCHEMA, maxTokens: 64, what: "x" });
  assert.equal(calls[0].body.model, "gpt-5-nano");
});

test("a web search call carries the tool and no schema", async () => {
  const calls = stubFetch(okReply("plain text"));
  await webSearchCall({ model: "gpt-5-nano", system: "S", user: "U", maxTokens: 64, what: "sources" });
  assert.deepEqual(calls[0].body.tools, [{ type: "web_search" }]);
  assert.equal(calls[0].body.text, undefined);
});

test("a text call passes the message history through untouched", async () => {
  const calls = stubFetch({ model: "gpt-5-nano", output_text: "  hi  " });
  const messages = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
  const { text } = await textCall({ model: "gpt-5-nano", system: "S", messages, maxTokens: 64, what: "tracer" });
  assert.deepEqual(calls[0].body.input, messages);
  assert.equal(calls[0].body.text, undefined);
  assert.equal(text, "hi");
});

test("effort is omitted for a model family that does not take it", () => {
  assert.ok(openai.supportsEffort("gpt-5-nano"));
  assert.ok(openai.supportsEffort("gpt-6-astra"));
  assert.ok(openai.supportsEffort("o3-mini"));
  assert.ok(!openai.supportsEffort("gpt-4.1"));
});

test("a truncated answer is its own kind, so runFactCheck can split and retry", async () => {
  stubFetch({ model: "gpt-5-nano", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
  await assert.rejects(
    () => structuredCall({ model: "gpt-5-nano", system: "S", user: "U", schema: SCHEMA, maxTokens: 8, what: "check" }),
    (err) => err.kind === "truncated",
  );
});

test("a refusal is not reported as an empty answer", async () => {
  stubFetch({ model: "gpt-5-nano", output: [{ content: [{ type: "refusal", refusal: "no" }] }] });
  await assert.rejects(
    () => structuredCall({ model: "gpt-5-nano", system: "S", user: "U", schema: SCHEMA, maxTokens: 64, what: "check" }),
    (err) => err.kind === "refusal",
  );
});

test("the vendor's error vocabulary maps onto ours, and 401 stays no_key", () => {
  assert.equal(openai.mapError(401, {}).kind, "no_key");
  assert.equal(openai.mapError(429, {}).kind, "rate_limit");
  assert.equal(openai.mapError(500, {}).kind, "server");
  const notFound = openai.mapError(400, { error: { code: "model_not_found", message: "no such model" } });
  assert.equal(notFound.kind, "server");
  // It must name the file to edit — this is the likeliest failure after a
  // model or provider change, and the vendor's own wording does not help.
  assert.match(notFound.message, /shared\/plan\.js/);
});

test("a schema that breaks OpenAI strict mode fails here, not in production", () => {
  assert.throws(
    () => openai.assertSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, "bad"),
    /additionalProperties:false/,
  );
  assert.throws(
    () => openai.assertSchema({ type: "object", additionalProperties: false, properties: { a: { type: "string" } }, required: [] }, "bad"),
    /missing a/,
  );
});
