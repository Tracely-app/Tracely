import { test } from "node:test";
import assert from "node:assert/strict";
import { mapApiError } from "../lib/llm.js";
import { modelFailureLine, noteUpstreamFailure, upstreamStatus, isModelFailure } from "../lib/failureLog.js";

const quotaBody = { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } };

test("OpenAI out of credit maps to a final budget error, not a retryable rate limit", () => {
  const err = mapApiError(429, quotaBody);
  assert.equal(err.kind, "budget");
  assert.equal(err.status, 503);
  assert.equal(err.reason, "out_of_credit");
  assert.equal(err.retryAfter, undefined);
  assert.doesNotMatch(err.message, /try again shortly/i);
  assert.doesNotMatch(err.message, /quota|billing|OpenAI/, "the user-facing message names no vendor or billing detail");
});

test("the monthly hard limit is treated the same way", () => {
  const err = mapApiError(429, { error: { message: "Billing hard limit has been reached", code: "billing_hard_limit_reached" } });
  assert.equal(err.kind, "budget");
  assert.equal(err.reason, "out_of_credit");
});

test("an ordinary 429 is still a retryable rate limit", () => {
  const err = mapApiError(429, { error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" } });
  assert.equal(err.kind, "rate_limit");
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 30);
});

test("the failure log line says out_of_credit, never the vendor's message", () => {
  const err = mapApiError(429, quotaBody);
  err.llm = { model: "gpt-5.6-luna", effort: "medium" };
  assert.equal(isModelFailure(err), true);
  const line = modelFailureLine("/api/check", err);
  assert.match(line, /kind=out_of_credit status=503 model=gpt-5\.6-luna effort=medium/);
  assert.doesNotMatch(line, /quota|billing/);
});

test("/api/status upstream flag: set by an out-of-credit failure, clears after 15 minutes, ignores others", () => {
  const t0 = 1_800_000_000_000;
  noteUpstreamFailure(mapApiError(429, { error: { code: "rate_limit_exceeded" } }), t0 - 60 * 60_000);
  assert.equal(upstreamStatus(t0 - 60 * 60_000), null, "a rate limit does not set it");
  noteUpstreamFailure(mapApiError(429, quotaBody), t0);
  assert.deepEqual(upstreamStatus(t0 + 60_000), { outOfCreditAt: new Date(t0).toISOString() });
  assert.equal(upstreamStatus(t0 + 16 * 60_000), null);
});
