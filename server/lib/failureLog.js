/* One log line per failed model call — WHAT failed, never WHAT WAS SENT.
 *
 * A truncated, refused or unparseable answer used to leave no trace on the
 * server at all: the CheckError went straight into the client's JSON body and
 * the only evidence that answer quality was slipping was a user saying so.
 * server.js's central error handler now writes this line for every such
 * failure on a model route, desktop and extension alike.
 *
 * Every field comes from a closed set this server chose, so the line cannot
 * carry a user's text or identity even by accident:
 *   route  — the request path, and only for the fixed set of model routes
 *   kind   — the CheckError's `reason` when lib/llm.js set one (unparseable,
 *            empty) else its `kind` (truncated, refusal, timeout, network, …)
 *   model  — an id from ALLOWED_MODELS, else "unlisted"
 *   effort — a real effort level, "none" when the request carried none
 * The error MESSAGE is deliberately absent: OpenAI's own wording is passed
 * through in some messages, and nobody can promise what that echoes.
 */
import { ALLOWED_MODELS } from "./llm.js";
import { CheckError } from "./errors.js";

const EFFORTS = new Set(["minimal", "low", "medium", "high"]);
const KIND = /^[a-z_]{1,32}$/;

/* Kinds this server raises about the CALLER or its own configuration rather
 * than about an answer — the day's budget, a missing key. Only logged when
 * they came out of the model facade (err.llm), e.g. OpenAI rejecting the key. */
const NOT_MODEL_FAILURES = new Set(["budget", "no_key"]);

/**
 * Whether `err` is a model failure worth a log line: anything that left the
 * model facade (lib/llm.js tags those with `err.llm`), or any other 5xx
 * CheckError raised while handling a model route (a grade that failed
 * verification, a source search that came back empty). Caller errors —
 * validation, quotas, rate limits — are 4xx and never logged.
 */
export function isModelFailure(err) {
  if (!(err instanceof CheckError)) return false;
  if (err.llm) return true;
  return Number(err.status) >= 500 && !NOT_MODEL_FAILURES.has(err.kind);
}

const safeModel = (m) => (m == null ? "-" : ALLOWED_MODELS.has(m) ? m : "unlisted");
const safeEffort = (e) => (e == null ? "none" : EFFORTS.has(e) ? e : "unlisted");
const safeKind = (k) => (typeof k === "string" && KIND.test(k) ? k : "unknown");

/**
 * The line. `trace` is what the route knew before the call ({ model, effort },
 * either may be null); the facade's tag, when present, wins, because it
 * records what was actually sent — including an effort dropped by the
 * one-shot fallback.
 */
export function modelFailureLine(route, err, trace = {}) {
  const sent = err?.llm ?? null;
  const model = safeModel(sent ? sent.model : trace?.model);
  const effort = sent ? safeEffort(sent.effort) : trace?.effort == null ? "-" : safeEffort(trace.effort);
  const status = Number.isInteger(err?.status) ? err.status : "-";
  return `[tracely] model call failed route=${route} kind=${safeKind(err?.reason ?? err?.kind)} status=${status} model=${model} effort=${effort}`;
}

/* When OpenAI last said the account is out of credit. One timestamp, no
 * detail: /api/status reports it so an outage caused by an empty balance is
 * visible at a glance instead of looking like ordinary rate limiting. */
const OUT_OF_CREDIT_WINDOW_MS = 15 * 60_000;
let outOfCreditAt = 0;

export function noteUpstreamFailure(err, now = Date.now()) {
  if (err?.reason === "out_of_credit") outOfCreditAt = now;
}

/** `{ outOfCreditAt }` (ISO) if OpenAI refused for lack of credit in the last 15 minutes, else null. */
export function upstreamStatus(now = Date.now()) {
  return outOfCreditAt && now - outOfCreditAt < OUT_OF_CREDIT_WINDOW_MS
    ? { outOfCreditAt: new Date(outOfCreditAt).toISOString() }
    : null;
}
