/* The one place Tracely talks to a model.
 *
 * A FACADE over a provider. Every caller imports structuredCall, textCall and
 * webSearchCall from here with the same signatures they have always had; this
 * file owns the flow around a call (schema check, model choice, the effort
 * policy and its one-shot fallback, completeness, parsing) and delegates the
 * vendor-specific parts — request body, transport, error envelope, reading
 * text / citations / usage back — to the active provider in lib/providers/.
 *
 * OpenAI is the only provider registered, and it serves every call. The seam
 * exists so that moving to another vendor is a new file in lib/providers/ plus
 * TRACELY_LLM_PROVIDER, rather than an edit to every checker. The Responses
 * API is still spoken over plain fetch with no SDK, which is why this server
 * has ZERO runtime dependencies.
 *
 * Three call shapes cover every AI function in this codebase:
 *   structuredCall — JSON matching a schema, used by every checker
 *   textCall       — free text with history, used by Tracer
 *   webSearchCall  — the built-in web_search tool, used only by findSources
 */
import { CheckError } from "./errors.js";
import { openai } from "./providers/openai.js";

/* MODEL TIERS — the only place model IDs appear on the server.
 *
 * The tier NAMES (fast / thorough) are shared/plan.js's vocabulary, because
 * that file decides which tier a plan may reach and it must be able to name
 * the same things. test/models.test.js pins the two together.
 *
 * Chosen by a measured, blind-judged eval of 13 configs on the production
 * code paths (eval/models/FINDINGS.md, 2026-09-21), then cut to two tiers by
 * the plan policy of the same day (FINDINGS.md, "Plan policy"):
 *   - fast: gpt-5.6-luna was the most accurate fact check measured at any
 *     price (100% at effort medium, vs 74% for gpt-5-nano at low, which never
 *     flagged an uncited statistic), and at low effort it beat the retired
 *     relay's gpt-4.1 on the desktop critique. It runs every volume route on
 *     every plan (shared/plan.js modelForRoute).
 *   - thorough: gpt-6-astra gave the most thorough explanations, at ~30x
 *     fast's cost per check. Pro only, only on the desktop critique and the
 *     one-sentence "Explain in depth", and only out of a monthly allowance.
 *   - gpt-5.6-terra (the old "balanced") is RETIRED: it lost to luna on both
 *     measured tasks at ~8-10x the cost. Its price row stays in
 *     shared/prices.js so historical usage still prices; clients that still
 *     send its id get fast (shared/plan.js LEGACY_MODEL_TIER).
 * If an id is wrong the API answers 400 `model_not_found`, and mapApiError
 * turns that into a message naming this constant, so the fix is one line here
 * rather than a hunt. Retired ids that shipped clients still send are
 * translated to their tier by shared/plan.js currentModelId, never here.
 *
 * Prices per 1M tokens, input / cached / output / cache write:
 *   fast      gpt-5.6-luna    $0.20 / $0.02 / $1.20  / $0.25
 *   thorough  gpt-6-astra     $10.00 / $1.00 / $50.00 / $12.50
 */
export const MODEL_TIERS = {
  fast: "gpt-5.6-luna",
  thorough: "gpt-6-astra",
};

/* The same prices as DATA, because the spend cap has to do arithmetic with
 * them and a number in a comment cannot be summed. They live in
 * shared/prices.js — a leaf module the web app's spend meter also loads — and
 * are re-exported here so every existing importer is unchanged. */
import { MODEL_PRICES, WEB_SEARCH_CALL_DOLLARS } from "../shared/prices.js";
export { MODEL_PRICES, WEB_SEARCH_CALL_DOLLARS };

/* Cost in MICRO-CENTS (1e-6 of a cent), as an integer.
 *
 * Integer micro-cents rather than float cents because the running total is a
 * SQLite INTEGER column that gets incremented thousands of times a day, and
 * accumulating float cents drifts. At this resolution the cheapest thing we
 * can bill — one cached input token on the fast tier ($0.02 per 1M) — is still
 * 2 micro-cents, so nothing rounds to zero.
 *
 * An unknown model is priced as the MOST expensive tier, not as zero. Getting
 * this wrong in the other direction means a model rename silently uncaps
 * spending, which is the failure this module exists to prevent.
 *
 * Input tokens come in three kinds (lib/providers/openai.js usageOf): cache
 * READS (`cached`), cache WRITES (`cacheWrite`) and the fresh remainder. Both
 * cache counts are subsets of `input`, so the fresh remainder is input minus
 * both — a write is billed once, at the write rate, never again as fresh
 * input. A model with no `cacheWrite` price bills a write at its input rate.
 */
export function costMicroCents(model, usage, { webSearchCalls = 0 } = {}) {
  const p = MODEL_PRICES[model]
    ?? MODEL_PRICES[String(model).replace(/-\d{4}-\d{2}-\d{2}$/, "")] // a dated snapshot id
    ?? MODEL_PRICES[MODEL_TIERS.thorough];
  // Math.max(0, NaN) is NaN, not 0 — so a non-finite token count used to
  // produce a NaN cost, which usageAdd then floored to zero. A malformed usage
  // block must cost SOMETHING or it is a free call.
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const cached = n(usage?.cached);
  const written = n(usage?.cacheWrite);
  const fresh = n(n(usage?.input) - cached - written);
  const out = n(usage?.output);
  const dollars =
    (fresh * p.input + cached * p.cached + written * (p.cacheWrite ?? p.input) + out * p.output) / 1e6 +
    webSearchCalls * WEB_SEARCH_CALL_DOLLARS;
  return Math.max(0, Math.round(dollars * 100 * 1e6));
}
export const ALLOWED_MODELS = new Set(Object.values(MODEL_TIERS));
// Cost mandate: the cheap model unless something explicitly asks otherwise.
export const DEFAULT_MODEL = MODEL_TIERS.fast;
export const chooseModel = (m) => (ALLOWED_MODELS.has(m) ? m : DEFAULT_MODEL);

/* ── providers ─────────────────────────────────────────────────────────────
 * Registered by name. TRACELY_LLM_PROVIDER picks one, read at CALL time
 * rather than import time because server.js re-reads .env while it runs
 * (loadEnvFile), and a value pasted in mid-session has to take effect the way
 * the API key does. Unset means OpenAI, which is the only thing registered —
 * so today the variable can only ever select the one provider, or be a typo,
 * and a typo fails loudly on the first call instead of silently falling back
 * to a vendor nobody chose. */
const PROVIDERS = { openai };

function provider() {
  const name = (process.env.TRACELY_LLM_PROVIDER ?? "").trim().toLowerCase() || "openai";
  const p = PROVIDERS[name];
  if (!p) {
    throw new CheckError("server", `Unknown TRACELY_LLM_PROVIDER "${name}". Registered: ${Object.keys(PROVIDERS).join(", ")}.`, { status: 500 });
  }
  return p;
}

/* The key is cached per provider, and the cache is STICKY: a key that has
 * been seen keeps working after the variable is removed. That matches what
 * this module has always done and what server.js expects of hasApiKey(). */
const cachedKeys = new Map();
export function hasApiKey() {
  return Boolean(apiKey(provider()));
}
function apiKey(p) {
  const k = process.env[p.keyEnv]?.trim();
  if (k) cachedKeys.set(p.name, k);
  return cachedKeys.get(p.name) ?? null;
}

/* OpenAI's strict mode is stricter than Anthropic's was: EVERY property must
 * appear in `required`, and every object needs additionalProperties:false. A
 * schema that breaks either is a 400 at call time, in production, on a path
 * that may only run for one user. Checking it here turns that into a precise
 * local failure naming the offending object. */
export function assertStrictSchema(schema, where = "schema") {
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") {
      const props = Object.keys(node.properties ?? {});
      const req = new Set(node.required ?? []);
      if (node.additionalProperties !== false) {
        throw new CheckError("server", `${where}: ${path} must set additionalProperties:false for OpenAI strict mode`, { status: 500 });
      }
      const missing = props.filter((p) => !req.has(p));
      if (missing.length) {
        throw new CheckError("server", `${where}: ${path} must list every property in "required" for OpenAI strict mode — missing ${missing.join(", ")}`, { status: 500 });
      }
      for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`);
    }
    if (node.type === "array") walk(node.items, `${path}[]`);
    // A union (the check's two finding shapes): strict mode wants every
    // branch strict, and a branch this walker skipped would 400 at OpenAI.
    (node.anyOf ?? []).forEach((b, i) => walk(b, `${path}|${i}`));
  };
  walk(schema, "root");
  return schema;
}

async function post(p, body, { timeoutMs = 120_000 } = {}) {
  const key = apiKey(p);
  if (!key) throw new CheckError("no_key", p.missingKeyMessage, { status: 503 });
  return p.send(body, { key, timeoutMs });
}

/* Kept as an export with its (status, json) signature. It maps the ACTIVE
 * provider's error envelope, which today is OpenAI's. */
export function mapApiError(status, json) {
  return provider().mapError(status, json);
}

/* Reasoning effort is the OpenAI equivalent of the old output_config.effort,
 * and it is what the paid "intelligence" tier actually buys. Non-reasoning
 * models 400 on it, so it is opt-in by model family — and because that family
 * list is a guess made without a key to probe, a 400 that blames the parameter
 * disables it for the process rather than failing the user's request.
 *
 * DEFAULT_EFFORT is "low" and it is a DEFAULT, not a suggestion: omitting
 * `reasoning` entirely does NOT mean "don't reason", it means OpenAI picks, and
 * what OpenAI picks is expensive — on gpt-5-nano (2026-09-13) it cost 4x the
 * output tokens and 3x the latency of "low" for the same verdicts, and
 * "minimal" flagged needs_citation on "According to Smith (2019)…", the
 * false-positive class the rubric work exists to stop.
 *
 * On the current tiers the measurement is the model eval,
 * eval/models/FINDINGS.md (2026-09-21, the real check and critique paths,
 * 2 reps each, blind-judged). For the fast tier, gpt-5.6-luna:
 *
 *   task                  low                   medium
 *   fact check (55 x 2)   90%, 5 harmful        100%, 0 harmful   (p = 0.001)
 *   40-sentence check     93%                   99%
 *   desktop critique      48/52, judge 7.13     48/52, judge 6.58
 *   cost, 1-sentence      0.038-0.067 cents     0.039-0.068 cents
 *
 * So the default stays "low" — the critique and every unmeasured route — and
 * /api/check alone runs the fast tier at "medium" (shared/plan.js
 * modelForRoute pins every route's effort on a hosted server). astra was
 * measured only at "low". "high" and "minimal" were not measured
 * on any current tier. Re-run the eval before moving either. */
const DEFAULT_EFFORT = "low";

/* Effort is WHITELISTED here, at the one place every call passes through.
 *
 * It was forwarded as given. /api/check and /api/flow pass the client's
 * `effort` straight through factcheck.js unvalidated, so any value a client
 * sent went into `reasoning.effort`. Two consequences, both on extension
 * routes:
 *   - A junk value ({}, "turbo") draws a 400 that names the parameter, which
 *     is exactly what the fallback below reads as "this vendor does not do
 *     effort" — so ONE malformed request would switch effort off for every
 *     user of the process until restart, putting every later call on the
 *     no-effort path described above: ~4x the tokens, ~3x the latency.
 *   - null, "" and 0 sent no `reasoning` at all, which is that same expensive
 *     path, chosen by anyone who POSTs `"effort": null`.
 * Now anything that is not a real effort level becomes DEFAULT_EFFORT. The
 * shipped extension only ever sends low / medium / high, all unchanged, and
 * lib/ai.js already applied this rule to its own callers. The ONLY thing that
 * can now disable effort is the vendor rejecting a valid level — what the
 * fallback was for. */
const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high"]);
/* Exported (additively) so server.js can normalise a client's effort ONCE at
 * the route and log the level it will actually send. */
export const normalizeEffort = (e) => (VALID_EFFORTS.has(e) ? e : DEFAULT_EFFORT);

/* Every failure leaving this facade carries the model and effort it was SENT
 * at, so server.js can log what failed without logging what was sent — the
 * user's text never appears in the tag. Non-enumerable, and never serialised:
 * the wire body is built from kind/message/retryAfter alone. `effort: null`
 * means the request carried no reasoning effort.
 *
 * When the vendor ANSWERED before the failure — truncated at
 * max_output_tokens, a refusal, empty or unparseable output — that answer was
 * billed, and a truncation is the dearest call there is (every output token
 * allowed). `usage` carries what it cost so the caller can still record it;
 * it used to vanish with the error, so the spend cap never saw it. Absent
 * when nothing was billed (a network error, a rejected request). */
function tagFailure(err, sent, p = null, json = null) {
  if (err instanceof CheckError && !err.llm) {
    const tag = { model: sent.model, effort: sent.effort ?? null };
    if (p && json) {
      tag.usage = p.usageOf(json);
      // A failed answer that searched was billed per search too.
      const searches = webSearchCallsOf(p, json);
      if (searches > 0) tag.webSearchCalls = searches;
    }
    Object.defineProperty(err, "llm", { value: tag, enumerable: false, configurable: true });
  }
  return err;
}

/* The web_search tool calls an answer made — billed per call, and invisible in
 * the token usage. 0 for a provider that cannot say. */
const webSearchCallsOf = (p, json) => (typeof p.webSearchCallsOf === "function" ? p.webSearchCallsOf(json) : 0);

/* The two "server" failures that are really answer-quality failures get a
 * finer `reason` for the log. Same kind, same status, same wire message as
 * before — only the log line can tell them apart. */
const unparseable = (what) => Object.assign(new CheckError("server", `Model returned unparseable ${what} output.`, { status: 502 }), { reason: "unparseable" });
const noContent = (what) => Object.assign(new CheckError("server", `Model returned no content for ${what}.`, { status: 502 }), { reason: "empty" });

/* Keyed per provider AND MODEL, because "does this accept reasoning effort" is
 * a fact about one model, not about the process.
 *
 * It was a single process-wide flag: the first 400 that blamed the parameter
 * switched effort off for every later call on every route. That coupled the
 * routes to each other — a desktop-only route on one model rejecting effort
 * would have put the extension's /api/check, on a different model, onto the
 * expensive no-effort path until restart. Now a rejection disables effort for
 * the model that rejected it and nothing else. For a single model that is
 * exactly the old behaviour: set by the first rejection, never reset. */
const effortDisabled = new Set();
const effortKey = (p, model) => `${p.name}:${model}`;
const effortFor = (p, model) => !effortDisabled.has(effortKey(p, model)) && p.supportsEffort(model);

/** A call that must return JSON matching `schema`. */
export async function structuredCall({ model, system, user, schema, maxTokens, what, name = "result", effort = DEFAULT_EFFORT }) {
  assertStrictSchema(schema, what);
  const p = provider();
  const chosen = chooseModel(model);
  const level = normalizeEffort(effort);
  const withEffort = effortFor(p, chosen);
  const sent = { model: chosen, effort: withEffort ? level : null };
  let json = null;
  try {
    const body = p.structuredBody({ model: chosen, system, user, schema, maxTokens, name, effort: withEffort ? level : undefined });

    try {
      json = await post(p, body);
    } catch (err) {
      if (!withEffort || !p.isEffortError(err)) throw err;
      effortDisabled.add(effortKey(p, chosen));
      sent.effort = null;
      json = await post(p, p.structuredBody({ model: chosen, system, user, schema, maxTokens, name, effort: undefined }));
    }
    p.checkComplete(json, what);
    const text = p.extractText(json);
    if (!text) throw noContent(what);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw unparseable(what);
    }
    return { parsed, model: p.modelOf(json), usage: p.usageOf(json) };
  } catch (err) {
    throw tagFailure(err, sent, p, json);
  }
}

/** A free-text call with conversation history. Returns the reply text. */
export async function textCall({ model, system, messages, maxTokens, what, effort = DEFAULT_EFFORT }) {
  const p = provider();
  const chosen = chooseModel(model);
  const level = effortFor(p, chosen) ? normalizeEffort(effort) : undefined;
  const sent = { model: chosen, effort: level ?? null };
  let json = null;
  try {
    // No effort fallback here, and none was ever added: a textCall that 400s on
    // effort fails. structuredCall is where the retry has been measured.
    const body = p.textBody({ model: chosen, system, messages, maxTokens, effort: level });
    json = await post(p, body);
    p.checkComplete(json, what);
    return { text: p.extractText(json).trim(), model: p.modelOf(json), usage: p.usageOf(json) };
  } catch (err) {
    throw tagFailure(err, sent, p, json);
  }
}

/* Whether a model takes reasoning effort ALONGSIDE the web_search tool is its
 * own fact, keyed apart from effortKey: OpenAI refuses web_search at
 * "minimal" effort, and that refusal must not switch effort off for the same
 * model's structured calls — which would put every /api/check on that model
 * onto the expensive no-effort path described above. */
const webEffortKey = (p, model) => `${effortKey(p, model)}:web_search`;

/** A call that may search the web before answering. Returns raw text.
 *
 * `schema` (optional) constrains that text to strict JSON; the search stays
 * the model's choice, unlike webSearchStructuredCall below, and the text is
 * still returned raw for the caller to parse. /api/sources passes one so the
 * citation fields come back in every source, empty when the page is silent. */
export async function webSearchCall({ model, system, user, maxTokens, what, effort, schema, name = "result" }) {
  if (schema) assertStrictSchema(schema, what);
  const p = provider();
  const chosen = chooseModel(model);
  // With NO effort it sends none, exactly as it always has: the source search
  // runs at the vendor's default. That is a known cost (the no-effort path
  // above) and it is what every source search from the store build runs at;
  // the model eval did not cover this route (eval/models/FINDINGS.md), so
  // lowering it wants a fresh measurement on this prompt, not a drive-by
  // default. An effort the CALLER chose (/api/sources passes one through,
  // though no shipped widget sends it) is sent, normalised; "minimal" is
  // raised to "low" because web_search does not run at minimal.
  const normalized = effort == null ? null : normalizeEffort(effort);
  const level = normalized === "minimal" ? "low" : normalized;
  const withEffort = level != null && effortFor(p, chosen) && !effortDisabled.has(webEffortKey(p, chosen));
  const sent = { model: chosen, effort: withEffort ? level : null };
  let json = null;
  try {
    // Searching then writing is slower than writing, hence the longer timeout.
    const build = (e) => p.webSearchBody({ model: chosen, system, user, maxTokens, effort: e, schema, name });
    try {
      json = await post(p, build(withEffort ? level : undefined), { timeoutMs: 180_000 });
    } catch (err) {
      if (!withEffort || !p.isEffortError(err)) throw err;
      effortDisabled.add(webEffortKey(p, chosen));
      sent.effort = null;
      json = await post(p, build(undefined), { timeoutMs: 180_000 });
    }
    p.checkComplete(json, what);
    return {
      text: p.extractText(json), citations: p.extractCitations(json), model: p.modelOf(json), usage: p.usageOf(json),
      // What the search tool will bill (per call), and what was sent — the
      // caller may still fail on this answer and must tag that failure.
      webSearchCalls: webSearchCallsOf(p, json), sent: { ...sent },
    };
  } catch (err) {
    throw tagFailure(err, sent, p, json);
  }
}

/**
 * A web search that must happen, answering JSON that matches `schema`.
 *
 * ADDITIVE. webSearchCall above is what the extension's /api/sources uses and
 * it stays separate: it offers the tool without forcing it, returns the text
 * raw for the caller to parse, and the caller harvests url citations as a
 * backstop. This is the desktop's source finder, which forces
 * the search and parses a strict schema, exactly as the relay did.
 */
export async function webSearchStructuredCall({ model, system, user, schema, maxTokens, what, name = "result", effort = DEFAULT_EFFORT }) {
  assertStrictSchema(schema, what);
  const p = provider();
  if (!p.webSearchStructuredBody) throw new CheckError("server", `Provider "${p.name}" cannot run a forced web search.`, { status: 500 });
  const chosen = chooseModel(model);
  const level = normalizeEffort(effort);
  const withEffort = effortFor(p, chosen);
  const sent = { model: chosen, effort: withEffort ? level : null };
  let json = null;
  try {
    const build = (e) => p.webSearchStructuredBody({ model: chosen, system, user, schema, name, maxTokens, effort: e });
    try {
      json = await post(p, build(withEffort ? level : undefined), { timeoutMs: 180_000 });
    } catch (err) {
      if (!withEffort || !p.isEffortError(err)) throw err;
      effortDisabled.add(effortKey(p, chosen));
      sent.effort = null;
      json = await post(p, build(undefined), { timeoutMs: 180_000 });
    }
    p.checkComplete(json, what);
    const text = p.extractText(json);
    if (!text) throw noContent(what);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw unparseable(what);
    }
    return { parsed, citations: p.extractCitations(json), model: p.modelOf(json), usage: p.usageOf(json), webSearchCalls: webSearchCallsOf(p, json) };
  } catch (err) {
    throw tagFailure(err, sent, p, json);
  }
}
