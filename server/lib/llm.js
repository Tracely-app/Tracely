/* The one place Tracely talks to a model.
 *
 * This module owns POLICY — which model, how hard it tries, what happens when
 * an answer is truncated or a parameter is rejected. The vendor's wire format
 * lives behind a provider in lib/providers/, so those two concerns can change
 * independently.
 *
 * ── The provider seam ─────────────────────────────────────────────────────
 * There is exactly one provider today and it is OpenAI, over plain fetch with
 * no SDK — which is why this server still has ZERO runtime dependencies, and
 * why the request shape here and the one in extension/background.js (which
 * cannot load an SDK at all under MV3) remain legible against each other.
 *
 * The seam exists because moving vendors is otherwise a rewrite of this file
 * under time pressure. It does NOT make the switch free, and pretending
 * otherwise would be the trap: the three model ids are hand-copied into
 * extension/background.js, content.js and options.js, so the models a provider
 * offers are part of the SHIPPED EXTENSION's contract. Changing provider means
 * changing shared/plan.js's ids and releasing the extension. What the seam
 * buys is that none of the transport has to be rewritten to do it.
 *
 * Two call shapes cover all eight AI functions in this codebase:
 *   structuredCall — JSON matching a schema, used by every checker
 *   webSearchCall  — the built-in web_search tool, used only by findSources
 * plus textCall, free prose with history, used only by Tracer.
 */
import { CheckError } from "./errors.js";
import { MODEL_FOR_TIER } from "../shared/plan.js";
import { MODEL_PRICES, WEB_SEARCH_CALL_DOLLARS } from "../shared/prices.js";
import * as openai from "./providers/openai.js";

/* The active provider. A registry rather than a bare import so that adding a
 * second one is an entry here, and so the chosen one is visible in one line
 * instead of being implied by what happens to be imported. */
const PROVIDERS = { openai };
const provider = PROVIDERS[process.env.TRACELY_LLM_PROVIDER?.trim() || "openai"] ?? openai;

export const providerId = provider.id;

/* MODEL TIERS — the ids this server will actually send.
 *
 * The tier NAMES (fast / balanced / thorough) are shared/plan.js's vocabulary,
 * because that file decides which tier a plan may reach and it must be able to
 * name the same three things. test/models.test.js pins the two together.
 *
 * The IDS live in shared/plan.js too, and are mirrored here under this
 * module's historical name so every importer keeps working. They are the
 * ACTIVE PROVIDER's ids: they are not a property of this module, which is why
 * they are not defined in it.
 *
 * These were read off OpenAI's pricing page rather than probed, because this
 * machine has no OpenAI key to probe with. If one is wrong the API answers 400
 * `model_not_found`, and the provider's mapError turns that into a message
 * naming shared/plan.js, so the fix is one line rather than a hunt.
 *
 * Prices per 1M tokens at the time of writing, input / cached / output:
 *   fast      gpt-5-nano    $0.05 / $0.005 / $0.40
 *   balanced  gpt-5.4       $2.50 / $0.25  / $15.00
 *   thorough  gpt-6-astra   $10.00 / $1.00 / $50.00
 */
export const MODEL_TIERS = MODEL_FOR_TIER;

/* The same prices as DATA, because the spend cap has to do arithmetic with
 * them and a number in a comment cannot be summed. Dollars per 1M tokens.
 *
 * They live in shared/prices.js and are re-exported here: the browser's usage
 * meter needs them and cannot load this module.
 *
 * `search` is the part that surprises people: OpenAI bills the built-in
 * web_search tool PER CALL ($10 per 1000) on top of tokens, so one source
 * search costs about as much as 16 fact checks. Measured 2026-09-13.
 */
export { MODEL_PRICES, WEB_SEARCH_CALL_DOLLARS };

/* Cost in MICRO-CENTS (1e-6 of a cent), as an integer.
 *
 * Integer micro-cents rather than float cents because the running total is a
 * SQLite INTEGER column that gets incremented thousands of times a day, and
 * accumulating float cents drifts. At this resolution the cheapest thing we
 * can bill — one cached input token on gpt-5-nano — is still 5 micro-cents, so
 * nothing rounds to zero.
 *
 * An unknown model is priced as the MOST expensive tier, not as zero. Getting
 * this wrong in the other direction means a model rename silently uncaps
 * spending, which is the failure this module exists to prevent.
 */
export function costMicroCents(model, usage, { webSearchCalls = 0 } = {}) {
  const p = MODEL_PRICES[model]
    ?? MODEL_PRICES[String(model).replace(/-\d{4}-\d{2}-\d{2}$/, "")] // gpt-5-nano-2025-08-07
    ?? MODEL_PRICES[MODEL_TIERS.thorough];
  // Math.max(0, NaN) is NaN, not 0 — so a non-finite token count used to
  // produce a NaN cost, which usageAdd then floored to zero. A malformed usage
  // block must cost SOMETHING or it is a free call.
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const cached = n(usage?.cached);
  const fresh = n(n(usage?.input) - cached);
  const out = n(usage?.output);
  const dollars =
    (fresh * p.input + cached * p.cached + out * p.output) / 1e6 +
    webSearchCalls * WEB_SEARCH_CALL_DOLLARS;
  return Math.max(0, Math.round(dollars * 100 * 1e6));
}
export const ALLOWED_MODELS = new Set(Object.values(MODEL_TIERS));
// Cost mandate: the cheap model unless something explicitly asks otherwise.
export const DEFAULT_MODEL = MODEL_TIERS.fast;
export const chooseModel = (m) => (ALLOWED_MODELS.has(m) ? m : DEFAULT_MODEL);

export function hasApiKey() {
  return Boolean(provider.apiKey());
}

/* Kept under their old names because callers and tests import them. Both are
 * the active provider's dialect, not ours. */
export const assertStrictSchema = (schema, where) => provider.assertSchema(schema, where);
export const mapApiError = (status, json) => provider.mapError(status, json);

function checkComplete(json, what) {
  if (provider.truncatedReason(json)) {
    // Its own kind, because runFactCheck answers truncation by SPLITTING the
    // batch and retrying rather than failing — behaviour worth keeping, and it
    // needs to tell this apart from every other server error.
    throw new CheckError("truncated", `The ${what} response was truncated — try a smaller portion of text.`, { status: 502 });
  }
}

/* Reasoning effort is the OpenAI equivalent of the old output_config.effort,
 * and it is what the paid "intelligence" tier actually buys. Non-reasoning
 * models 400 on it, so it is opt-in by model family — and because that family
 * list is a guess made without a key to probe, a 400 that blames the parameter
 * disables it for the process rather than failing the user's request.
 *
 * DEFAULT_EFFORT is "low" and it is a DEFAULT, not a suggestion: omitting
 * `reasoning` entirely does NOT mean "don't reason", it means OpenAI picks, and
 * what OpenAI picks is expensive. Measured on gpt-5-nano against the real fact
 * check prompt, 8 deliberately hard sentences, 2026-09-13:
 *
 *   effort      secs   output tokens   verdicts correct
 *   (omitted)   33.3   6165            8/8
 *   minimal      4.8    347            6/8
 *   low         10.5   1546            8/8
 *   medium      29.4   5187            8/8
 *
 * So the shipped default was paying 4x the tokens and 3x the latency for
 * nothing over "low". "minimal" is NOT the answer despite being cheapest: it
 * flagged needs_citation on a sentence reading "According to Smith (2019)…",
 * which is precisely the false-positive class the rubric work exists to stop.
 * Anything that raises this above "low" should re-run that comparison first. */
export const DEFAULT_EFFORT = "low";
let effortSupported = true;

/* One send, with the effort retry. The retry is POLICY and lives here: a
 * provider that rejects the parameter should cost the caller nothing, and that
 * judgement should not be re-made by each provider. */
async function sendWithEffortFallback(body, wantsEffort, options) {
  try {
    return await provider.send(body, options);
  } catch (err) {
    if (!wantsEffort || !provider.isEffortRejection(err)) throw err;
    effortSupported = false;
    return provider.send(provider.withoutEffort(body), options);
  }
}

function effortFor(effort, model) {
  return Boolean(effort) && effortSupported && provider.supportsEffort(model) ? effort : null;
}

/** A call that must return JSON matching `schema`. */
export async function structuredCall({ model, system, user, schema, maxTokens, what, name = "result", effort = DEFAULT_EFFORT }) {
  assertStrictSchema(schema, what);
  const chosen = chooseModel(model);
  const useEffort = effortFor(effort, chosen);
  const body = provider.buildRequest({
    kind: "structured",
    model: chosen,
    system,
    input: user,
    maxTokens,
    schema,
    schemaName: name,
    effort: useEffort,
  });

  const json = await sendWithEffortFallback(body, Boolean(useEffort));
  checkComplete(json, what);
  const text = provider.extractText(json);
  if (!text) throw new CheckError("server", `Model returned no content for ${what}.`, { status: 502 });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CheckError("server", `Model returned unparseable ${what} output.`, { status: 502 });
  }
  return { parsed, model: provider.modelOf(json), usage: provider.extractUsage(json) };
}

/** A free-text call with conversation history. Returns the reply text. */
export async function textCall({ model, system, messages, maxTokens, what, effort = DEFAULT_EFFORT }) {
  const chosen = chooseModel(model);
  const useEffort = effortFor(effort, chosen);
  const body = provider.buildRequest({
    kind: "text",
    model: chosen,
    system,
    // The Responses API takes the same {role, content} items the old Messages
    // API did, so the caller's history passes straight through.
    input: messages,
    maxTokens,
    effort: useEffort,
  });
  const json = await sendWithEffortFallback(body, Boolean(useEffort));
  checkComplete(json, what);
  return { text: provider.extractText(json).trim(), model: provider.modelOf(json), usage: provider.extractUsage(json) };
}

/** A call that may search the web before answering. Returns raw text. */
export async function webSearchCall({ model, system, user, maxTokens, what }) {
  const body = provider.buildRequest({
    kind: "search",
    model: chooseModel(model),
    system,
    input: user,
    maxTokens,
  });
  // searching then writing is slower than writing
  const json = await provider.send(body, { timeoutMs: 180_000 });
  checkComplete(json, what);
  return {
    text: provider.extractText(json),
    citations: provider.extractCitations(json),
    model: provider.modelOf(json),
    usage: provider.extractUsage(json),
  };
}
