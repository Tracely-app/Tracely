/**
 * The wire behaviour of lib/llm.js, pinned.
 *
 * Before the provider seam these paths had no test at all: textCall,
 * webSearchCall, citation extraction, the output[] walk and its refusal
 * branch, the error mapper, and the one-shot effort fallback. They matter more
 * than their coverage suggested, because every CheckError kind and message
 * here reaches the shipped extension verbatim (server.js serialises them into
 * the JSON error body on /api/check, /api/flow and /api/sources). A reworded
 * message is a user-visible change to a build under Web Store review.
 *
 * The seam was checked byte-for-byte against the pre-seam module across 35
 * scenarios before this file was written; these are the ones worth keeping.
 */
import test from "node:test";
import assert from "node:assert/strict";

let n = 0;
const fresh = () => import(`../lib/llm.js?t=${n++}`); // effort state is per module instance
const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const bad = (status, json) => ({ ok: false, status, json: async () => json });
const SCHEMA = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

function stub(...replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r;
  };
  return calls;
}
const kindOf = async (p) => p.then(() => null, (e) => ({ kind: e.kind, status: e.status, message: e.message, retryAfter: e.retryAfter }));

test.beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.TRACELY_LLM_PROVIDER;
});

test("structuredCall sends the Responses API strict json_schema body", async () => {
  const llm = await fresh();
  const calls = stub(ok({ model: "gpt-5.6-terra", output_text: '{"a":"x"}', usage: { input_tokens: 5, output_tokens: 7, input_tokens_details: { cached_tokens: 2 } } }));
  const r = await llm.structuredCall({ model: "gpt-5.6-terra", system: "S", user: "U", schema: SCHEMA, maxTokens: 99, what: "w", name: "nm" });
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].headers.Authorization, "Bearer sk-test");
  assert.deepEqual(calls[0].body, {
    model: "gpt-5.6-terra", instructions: "S", input: "U", max_output_tokens: 99,
    text: { format: { type: "json_schema", name: "nm", schema: SCHEMA, strict: true } },
    reasoning: { effort: "low" },
  });
  assert.deepEqual(r, { parsed: { a: "x" }, model: "gpt-5.6-terra", usage: { input: 5, output: 7, cached: 2, cacheWrite: 0 } });
});

test("usage reads cache writes from input_tokens_details.cache_write_tokens, apart from cache reads", async () => {
  // The exact shape a real gpt-5.6-luna answer carried on 2026-09-21: a
  // first-seen prefix is a WRITE (billed at 1.25x input), the same prefix a
  // moment later a READ. Both are subsets of input_tokens.
  let llm = await fresh();
  stub(ok({ model: "m", output_text: '{"a":"x"}', usage: { input_tokens: 4979, output_tokens: 5, input_tokens_details: { cache_write_tokens: 4976, cached_tokens: 0 } } }));
  let r = await llm.structuredCall({ model: "m", schema: SCHEMA, what: "w" });
  assert.deepEqual(r.usage, { input: 4979, output: 5, cached: 0, cacheWrite: 4976 });

  llm = await fresh();
  stub(ok({ model: "m", output_text: '{"a":"x"}', usage: { input_tokens: 4979, output_tokens: 5, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 4976 } } }));
  r = await llm.structuredCall({ model: "m", schema: SCHEMA, what: "w" });
  assert.deepEqual(r.usage, { input: 4979, output: 5, cached: 4976, cacheWrite: 0 });

  // A failure that was billed carries its cache writes too, so the spend cap
  // prices a truncated cold call at the write rate.
  llm = await fresh();
  stub(ok({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1500, output_tokens: 16000, input_tokens_details: { cache_write_tokens: 1400 } } }));
  const truncated = await llm.structuredCall({ model: "m", schema: SCHEMA, what: "w" }).catch((e) => e);
  assert.deepEqual(truncated.llm.usage, { input: 1500, output: 16000, cached: 0, cacheWrite: 1400 });
});

test("textCall passes history through and trims the reply", async () => {
  const llm = await fresh();
  const calls = stub(ok({ model: "m", output_text: "  hi  " }));
  const r = await llm.textCall({ model: "gpt-5.6-luna", system: "S", messages: [{ role: "user", content: "q" }], maxTokens: 10, what: "t", effort: "high" });
  assert.deepEqual(calls[0].body, { model: "gpt-5.6-luna", instructions: "S", input: [{ role: "user", content: "q" }], max_output_tokens: 10, reasoning: { effort: "high" } });
  assert.equal(r.text, "hi");
});

test("webSearchCall sends the web_search tool, no effort unless asked, and returns url citations", async () => {
  // With no effort it still sends none — the vendor's default, which is what
  // every source search the shipped extension makes has always run at.
  // Lowering that default wants a measurement on this prompt, not a drive-by.
  const llm = await fresh();
  const calls = stub(ok({ output: [{ content: [{ type: "output_text", text: "t", annotations: [
    { type: "url_citation", url: "https://a.org", title: "A" }, { type: "url_citation", url: "https://b.org" }, { type: "file_citation", url: "x" },
  ] }] }] }));
  const r = await llm.webSearchCall({ model: "nope", system: "S", user: "q", maxTokens: 5, what: "s" });
  assert.deepEqual(calls[0].body, { model: "gpt-5.6-luna", instructions: "S", input: "q", max_output_tokens: 5, tools: [{ type: "web_search" }] });
  assert.deepEqual(r.citations, [{ url: "https://a.org", title: "A" }, { url: "https://b.org", title: "" }]);
});

test("webSearchCall passes a caller's effort through, normalises junk, and never sends minimal", async () => {
  // web_search does not run at "minimal"; sending it would draw a 400 that the
  // fallback reads as "no effort for this model". null/undefined is "not
  // asked", which sends nothing, as above.
  for (const [given, sent] of [["high", "high"], ["medium", "medium"], ["low", "low"], ["turbo", "low"], ["minimal", "low"], [null, undefined], [undefined, undefined]]) {
    const llm = await fresh();
    const calls = stub(ok({ output_text: "t" }));
    await llm.webSearchCall({ model: "gpt-5.6-terra", system: "S", user: "q", maxTokens: 5, what: "s", effort: given });
    assert.deepEqual(calls[0].body.reasoning, sent === undefined ? undefined : { effort: sent }, `effort ${JSON.stringify(given)}`);
  }
});

test("a web search reports every web_search_call it made — the tool bills per call", async () => {
  // A live gpt-5.6-luna answer on /api/find-sources (2026-09-21) carried two:
  // action "search", then "open_page". The route used to record one.
  const searched = (...actions) => actions.map((type) => ({ type: "web_search_call", status: "completed", action: { type } }));
  let llm = await fresh();
  stub(ok({ output_text: "t", output: [...searched("search", "open_page"), { type: "reasoning" }, { type: "message", content: [] }] }));
  let r = await llm.webSearchCall({ model: "gpt-5.6-luna", system: "S", user: "q", maxTokens: 5, what: "s", effort: "low" });
  assert.equal(r.webSearchCalls, 2, "every item counts, whatever its action");
  assert.deepEqual(r.sent, { model: "gpt-5.6-luna", effort: "low" });

  llm = await fresh();
  stub(ok({ output_text: "t" }));
  assert.equal((await llm.webSearchCall({ model: "gpt-5.6-luna", system: "S", user: "q", maxTokens: 5, what: "s" })).webSearchCalls, 0);

  llm = await fresh();
  stub(ok({ output_text: '{"a":"x"}', output: searched("search", "search", "find_in_page") }));
  r = await llm.webSearchStructuredCall({ model: "gpt-5.6-luna", system: "S", user: "q", schema: SCHEMA, maxTokens: 5, what: "s" });
  assert.equal(r.webSearchCalls, 3);

  // A failed answer that searched carries the count with its usage.
  llm = await fresh();
  stub(ok({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: searched("search", "search"), usage: { input_tokens: 10, output_tokens: 6000 } }));
  const err = await llm.webSearchCall({ model: "gpt-5.6-terra", system: "S", user: "q", maxTokens: 6000, what: "s" }).catch((e) => e);
  assert.deepEqual(err.llm, { model: "gpt-5.6-terra", effort: null, usage: { input: 10, output: 6000, cached: 0, cacheWrite: 0 }, webSearchCalls: 2 });
});

test("a web search that rejects effort does not switch effort off for that model's structured calls", async () => {
  // Keyed apart on purpose: a web_search-specific refusal must not put the
  // same model's /api/check onto the expensive no-effort path.
  const llm = await fresh();
  const calls = stub(
    bad(400, { error: { message: "reasoning.effort is not supported with the web_search tool" } }),
    ok({ output_text: "t" }),
    ok({ output_text: "t" }),
    ok({ output_text: '{"a":"x"}' }),
  );
  await llm.webSearchCall({ model: "gpt-5.6-luna", system: "S", user: "q", maxTokens: 5, what: "s", effort: "low" }); // rejects, retries without
  await llm.webSearchCall({ model: "gpt-5.6-luna", system: "S", user: "q", maxTokens: 5, what: "s", effort: "low" }); // stays off for web search
  await llm.structuredCall({ model: "gpt-5.6-luna", schema: SCHEMA, what: "w" });                     // structured: still on
  assert.equal(calls[1].body.reasoning, undefined);
  assert.equal(calls[2].body.reasoning, undefined);
  assert.deepEqual(calls[3].body.reasoning, { effort: "low" });
});

test("a failure leaving the facade carries the model and effort it was sent at, and nothing is serialised", async () => {
  // `usage` rides along whenever the vendor ANSWERED (and so billed) before
  // the failure: a truncation spends every output token it was allowed.
  let llm = await fresh();
  stub(ok({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 900, output_tokens: 16000 } }));
  const truncated = await llm.structuredCall({ model: "gpt-5.6-terra", schema: SCHEMA, what: "w", effort: "high" }).catch((e) => e);
  assert.equal(truncated.kind, "truncated");
  assert.deepEqual(truncated.llm, { model: "gpt-5.6-terra", effort: "high", usage: { input: 900, output: 16000, cached: 0, cacheWrite: 0 } });
  assert.ok(!Object.keys(truncated).includes("llm"), "the tag must not be enumerable");

  llm = await fresh();
  stub(ok({ output_text: "not json {", usage: { input_tokens: 3, output_tokens: 4 } }));
  const garbage = await llm.structuredCall({ model: "gpt-5.6-luna", schema: SCHEMA, what: "fact check" }).catch((e) => e);
  assert.equal(garbage.kind, "server");
  assert.equal(garbage.reason, "unparseable");
  assert.equal(garbage.message, "Model returned unparseable fact check output.", "the wire message is unchanged");
  assert.deepEqual(garbage.llm.usage, { input: 3, output: 4, cached: 0, cacheWrite: 0 });

  llm = await fresh();
  stub(bad(400, { error: { message: "Unsupported parameter: 'reasoning.effort'" } }), ok({ output: [{ content: [{ type: "refusal", refusal: "no" }] }] }));
  const refused = await llm.structuredCall({ model: "gpt-5.6-luna", schema: SCHEMA, what: "w" }).catch((e) => e);
  assert.equal(refused.kind, "refusal");
  assert.deepEqual(refused.llm, { model: "gpt-5.6-luna", effort: null, usage: { input: 0, output: 0, cached: 0, cacheWrite: 0 } }, "the retry went without effort, and the tag says so");

  llm = await fresh();
  stub(ok({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 10, output_tokens: 6000 } }));
  const webTrunc = await llm.webSearchCall({ model: "gpt-5.6-terra", system: "S", user: "q", maxTokens: 6000, what: "s" }).catch((e) => e);
  assert.deepEqual(webTrunc.llm, { model: "gpt-5.6-terra", effort: null, usage: { input: 10, output: 6000, cached: 0, cacheWrite: 0 } });

  llm = await fresh();
  stub(new TypeError("fetch failed"));
  const net = await llm.webSearchCall({ model: "gpt-5.6-luna", system: "S", user: "q", maxTokens: 5, what: "s", effort: "medium" }).catch((e) => e);
  assert.equal(net.kind, "network");
  assert.deepEqual(net.llm, { model: "gpt-5.6-luna", effort: "medium" }, "nothing answered, so nothing was billed and no usage is claimed");
});

test("a raw output[] array is walked, and a refusal part is its own error", async () => {
  let llm = await fresh();
  stub(ok({ output: [{ content: [{ type: "output_text", text: '{"a":' }, { type: "output_text", text: '"y"}' }] }] }));
  assert.deepEqual((await llm.structuredCall({ schema: SCHEMA, what: "w" })).parsed, { a: "y" });
  llm = await fresh();
  stub(ok({ output: [{ content: [{ type: "refusal", refusal: "no" }] }] }));
  assert.deepEqual(await kindOf(llm.structuredCall({ schema: SCHEMA, what: "w" })), { kind: "refusal", status: 502, message: "The model declined this request.", retryAfter: undefined });
});

test("every HTTP failure maps to the kind and message the extension shows", async () => {
  const cases = [
    [bad(401, {}), { kind: "no_key", status: 503, message: "OpenAI rejected the API key." }],
    [bad(429, {}), { kind: "rate_limit", status: 429, message: "OpenAI rate limit or quota reached — try again shortly.", retryAfter: 30 }],
    [bad(404, { error: { code: "model_not_found", message: "gone" } }), { kind: "server", status: 500, message: "OpenAI does not recognise that model. Fix MODEL_TIERS in lib/llm.js (OpenAI said: gone)" }],
    [bad(500, {}), { kind: "server", status: 502, message: "OpenAI had a server error — try again." }],
    [bad(400, { error: { message: "nope" } }), { kind: "bad_request", status: 502, message: "nope" }],
    [bad(403, {}), { kind: "bad_request", status: 502, message: "OpenAI returned 403." }],
    [Object.assign(new Error("x"), { name: "TimeoutError" }), { kind: "timeout", status: 504, message: "The model took too long to answer — try a smaller portion of text." }],
    [new Error("x"), { kind: "network", status: 502, message: "Could not reach OpenAI." }],
  ];
  for (const [reply, want] of cases) {
    const llm = await fresh();
    stub(reply);
    assert.deepEqual(await kindOf(llm.structuredCall({ schema: SCHEMA, what: "w" })), { retryAfter: undefined, ...want });
  }
});

test("no key is a 503 no_key, and nothing is sent", async () => {
  delete process.env.OPENAI_API_KEY;
  const llm = await fresh();
  const calls = stub();
  assert.deepEqual(await kindOf(llm.structuredCall({ schema: SCHEMA, what: "w" })),
    { kind: "no_key", status: 503, message: "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env", retryAfter: undefined });
  assert.equal(calls.length, 0);
});

test("a 400 that blames effort retries once without it, and effort stays off after", async () => {
  const llm = await fresh();
  const calls = stub(
    bad(400, { error: { message: "Unsupported parameter: 'reasoning.effort'" } }),
    ok({ output_text: '{"a":"1"}' }),
    ok({ output_text: '{"a":"2"}' }),
  );
  assert.deepEqual((await llm.structuredCall({ schema: SCHEMA, what: "w" })).parsed, { a: "1" });
  await llm.structuredCall({ schema: SCHEMA, what: "w" });
  assert.equal(calls.length, 3);
  assert.ok(calls[0].body.reasoning, "first attempt carries effort");
  assert.equal(calls[1].body.reasoning, undefined, "the retry drops it");
  assert.equal(calls[2].body.reasoning, undefined, "and the process remembers");
});

test("truncation is its own kind, so runFactCheck can split the batch", async () => {
  const llm = await fresh();
  stub(ok({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: "{" }));
  assert.equal((await kindOf(llm.structuredCall({ schema: SCHEMA, what: "fact check" }))).kind, "truncated");
});

test("an unknown TRACELY_LLM_PROVIDER fails loudly instead of falling back", async () => {
  process.env.TRACELY_LLM_PROVIDER = "anthropic";
  const llm = await fresh();
  const calls = stub(ok({ output_text: '{"a":"x"}' }));
  const e = await kindOf(llm.structuredCall({ schema: SCHEMA, what: "w" }));
  assert.equal(e.kind, "server");
  assert.match(e.message, /Unknown TRACELY_LLM_PROVIDER "anthropic"\. Registered: openai/);
  assert.equal(calls.length, 0, "a typo must not reach any vendor");
  process.env.TRACELY_LLM_PROVIDER = "OpenAI"; // case and whitespace are forgiven
  stub(ok({ output_text: '{"a":"x"}' }));
  assert.deepEqual((await (await fresh()).structuredCall({ schema: SCHEMA, what: "w" })).parsed, { a: "x" });
});

test("the facade keeps its thirteen exports, plus only additive ones", async () => {
  // webSearchStructuredCall is one addition: the desktop's forced,
  // schema-checked source search. normalizeEffort is the other: server.js
  // normalises a client's effort once at the route. The original thirteen
  // are unchanged.
  const llm = await fresh();
  assert.deepEqual(Object.keys(llm).sort(), [
    "ALLOWED_MODELS", "DEFAULT_MODEL", "MODEL_PRICES", "MODEL_TIERS", "WEB_SEARCH_CALL_DOLLARS",
    "assertStrictSchema", "chooseModel", "costMicroCents", "hasApiKey", "mapApiError",
    "normalizeEffort", "structuredCall", "textCall", "webSearchCall", "webSearchStructuredCall",
  ]);
  assert.ok(llm.ALLOWED_MODELS instanceof Set);
});

test("an invalid effort becomes the default, and cannot switch effort off for everyone", async () => {
  // One malformed value from any client used to draw a 400 naming
  // `reasoning.effort`, which the fallback reads as "vendor does not support
  // effort" — disabling it process-wide. null used to send no effort at all,
  // which is OpenAI's own (expensive) default.
  for (const junk of [{}, "turbo", null, "", 0, 7]) {
    const llm = await fresh();
    const calls = stub(ok({ output_text: '{"a":"x"}' }), ok({ output_text: '{"a":"x"}' }));
    await llm.structuredCall({ schema: SCHEMA, what: "w", effort: junk });
    assert.deepEqual(calls[0].body.reasoning, { effort: "low" }, `effort ${JSON.stringify(junk)} should send "low"`);
    await llm.structuredCall({ schema: SCHEMA, what: "w", effort: "medium" });
    assert.deepEqual(calls[1].body.reasoning, { effort: "medium" }, "a valid level still passes through untouched");
  }
  const llm = await fresh();
  const calls = stub(ok({ output_text: "t" }));
  await llm.textCall({ messages: [], what: "t", effort: { evil: true } });
  assert.deepEqual(calls[0].body.reasoning, { effort: "low" });
});

test("a model that rejects effort does not switch it off for other models", async () => {
  // The flag was process-wide, so one route's model rejecting effort would put
  // every other route — including the extension's /api/check — onto the
  // expensive no-effort path until restart.
  const llm = await fresh();
  const calls = stub(
    bad(400, { error: { message: "Unsupported parameter: 'reasoning.effort'" } }),
    ok({ output_text: '{"a":"1"}' }),
    ok({ output_text: '{"a":"2"}' }),
    ok({ output_text: '{"a":"3"}' }),
  );
  await llm.structuredCall({ model: "gpt-5.6-terra", schema: SCHEMA, what: "w" });      // rejects, retries without
  await llm.structuredCall({ model: "gpt-5.6-luna", schema: SCHEMA, what: "w" });   // different model: effort still sent
  await llm.structuredCall({ model: "gpt-5.6-terra", schema: SCHEMA, what: "w" });      // the model that rejected: stays off
  assert.equal(calls[1].body.reasoning, undefined);
  assert.deepEqual(calls[2].body.reasoning, { effort: "low" });
  assert.equal(calls[3].body.reasoning, undefined);
});
