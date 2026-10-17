/**
 * The spend audit of 2026-10-17: ways one request made the server spend more
 * than anything recorded or reserved. Each test drives lib/llm.js (and the two
 * callers that threw billed failures untagged) with a stubbed fetch and
 * asserts on the request body or the failure's `llm` tag — the only places
 * these mistakes show. The pool-level bursts are in beta-grant.test.js (I, J).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { structuredCall, webSearchCall } from "../lib/llm.js";
import { gradeWithCustomRubric } from "../lib/ai.js";
import { tracerReply } from "../lib/reasoning.js";

process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
delete process.env.TRACELY_MOCK;

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const okAnswer = (body, payload = { ok: true }) => ({
  ok: true, status: 200,
  json: async () => ({ status: "completed", model: body.model, output_text: JSON.stringify(payload), output: [], usage: { input_tokens: 100, output_tokens: 50 } }),
});
const rejection = (error) => ({ ok: false, status: 400, json: async () => ({ error }) });

/** Script the vendor: each call gets the next step (a function of the body). */
function script(steps) {
  const sent = [];
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    const step = steps[Math.min(sent.length - 1, steps.length - 1)];
    return step(body);
  };
  return sent;
}

test("a refusal that merely mentions reasoning does not switch effort off for every later caller", async () => {
  // The vendor's prompt refusals can link to its reasoning guide, and the old
  // test read any such message as "this model refuses effort" and latched it
  // BEFORE the retry, so one crafted prompt from any caller put every later
  // call on the model onto the vendor's costlier default until restart.
  const refuse = () => rejection({ message: "Invalid prompt: your prompt was flagged. See https://platform.openai.com/docs/guides/reasoning" });
  const sent = script([refuse, refuse, okAnswer]);
  await assert.rejects(structuredCall({ model: "gpt-5.6-luna", system: "s", user: "u", schema: SCHEMA, maxTokens: 100, what: "t", effort: "low" }));
  assert.equal(sent.length, 2, "it retried once without effort, and that failed too");
  await structuredCall({ model: "gpt-5.6-luna", system: "s", user: "u", schema: SCHEMA, maxTokens: 100, what: "t", effort: "low" });
  assert.deepEqual(sent[2].reasoning, { effort: "low" }, "the next caller still sends its effort");
});

test("a real rejection of the effort parameter switches it off only once the call succeeds without it", async () => {
  const sent = script([() => rejection({ message: "Unsupported parameter: 'reasoning.effort'.", param: "reasoning.effort" }), okAnswer]);
  await structuredCall({ model: "gpt-6-astra", system: "s", user: "u", schema: SCHEMA, maxTokens: 100, what: "t", effort: "low" });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].reasoning, undefined, "retried without it");
  await structuredCall({ model: "gpt-6-astra", system: "s", user: "u", schema: SCHEMA, maxTokens: 100, what: "t", effort: "low" });
  assert.equal(sent[2].reasoning, undefined, "and from then on, for that model");
});

test("an error that is not a 400 is never read as an effort rejection", async () => {
  const sent = script([() => ({ ok: false, status: 503, json: async () => ({ error: { message: "reasoning service overloaded" } }) })]);
  await assert.rejects(structuredCall({ model: "gpt-5.6-luna", system: "s", user: "u", schema: SCHEMA, maxTokens: 100, what: "t", effort: "low" }), (e) => e.kind === "server");
  assert.equal(sent.length, 1, "no retry without effort");
});

test("a web search caps its search calls, and a vendor that refuses the cap is answered without it", async () => {
  const sources = (body) => ({
    ok: true, status: 200,
    json: async () => ({ status: "completed", model: body.model, output_text: "[]", output: [{ type: "web_search_call" }], usage: { input_tokens: 10, output_tokens: 10 } }),
  });
  const capped = script([sources]);
  await webSearchCall({ model: "gpt-5.6-luna", system: "s", user: "u", maxTokens: 100, what: "source search", maxSearches: 3 });
  assert.equal(capped[0].max_tool_calls, 3, "max_tool_calls is sent");

  const refused = script([() => rejection({ message: "Unknown parameter: 'max_tool_calls'.", param: "max_tool_calls" }), sources]);
  const r = await webSearchCall({ model: "gpt-5.4-mini-test", system: "s", user: "u", maxTokens: 100, what: "source search", maxSearches: 3 });
  assert.equal(r.text, "[]", "the search still answers");
  assert.equal(refused.length, 2);
  assert.equal(refused[1].max_tool_calls, undefined, "retried without the cap");
});

test("a call we gave up on is charged its worst case, not nothing", async () => {
  // The vendor runs and bills a request the client drops; it used to come back
  // with no usage and be recorded as free.
  globalThis.fetch = async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); };
  const err = await structuredCall({ model: "gpt-5.6-luna", system: "system prompt", user: "x".repeat(2_000), schema: SCHEMA, maxTokens: 16_000, what: "t", effort: "low" }).catch((e) => e);
  assert.equal(err.kind, "timeout", "the wire error is unchanged");
  assert.equal(err.llm.estimated, true);
  assert.equal(err.llm.usage.output, 16_000, "every output token it allowed");
  assert.ok(err.llm.usage.input >= 2_000, "at least the request's bytes as input");
  assert.equal(err.llm.usage.cacheWrite, err.llm.usage.input, "priced as cold cache writes");
  assert.equal(Object.keys(err).includes("llm"), false, "the tag stays off the wire");

  const search = await webSearchCall({ model: "gpt-5.6-luna", system: "s", user: "u", maxTokens: 3_000, what: "source search", maxSearches: 3 }).catch((e) => e);
  assert.equal(search.llm.webSearchCalls, 3, "a timed-out search is charged every search it allowed");
  assert.ok(search.llm.usage.input >= 3 * 12_000, "and the pages those searches could read back");
});

test("a custom-rubric grade with nothing to score carries the billed answer's cost", async () => {
  script([(body) => okAnswer(body, { components: [] })]);
  const err = await gradeWithCustomRubric({ text: "A draft.", rubric: "Be nice.", level: 10 }).catch((e) => e);
  assert.equal(err.kind, "bad_request", "the same error the desktop shows");
  assert.deepEqual(err.llm.usage && { input: err.llm.usage.input, output: err.llm.usage.output }, { input: 100, output: 50 });
});

test("an empty Tracer reply carries the billed answer's cost", async () => {
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ status: "completed", model: body.model, output_text: "   ", output: [], usage: { input_tokens: 70, output_tokens: 5 } }) };
  };
  const err = await tracerReply({ message: "Hi", history: [], context: "" }).catch((e) => e);
  assert.equal(err.kind, "server");
  assert.equal(err.llm?.usage?.input, 70);
});
