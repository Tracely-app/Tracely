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
 * The tier NAMES (fast / balanced / thorough) are shared/plan.js's vocabulary,
 * because that file decides which tier a plan may reach and it must be able to
 * name the same three things. test/models.test.js pins the two together.
 *
 * These were read off OpenAI's pricing page rather than probed, because this
 * machine has no OpenAI key to probe with. If one is wrong the API answers 400
 * `model_not_found`, and mapApiError turns that into a message naming this
 * constant, so the fix is one line here rather than a hunt.
 *
 * Prices per 1M tokens at the time of writing, input / cached / output:
 *   fast      gpt-5-nano    $0.05 / $0.005 / $0.40
 *   balanced  gpt-5.4       $2.50 / $0.25  / $15.00
 *   thorough  gpt-6-astra   $10.00 / $1.00 / $50.00
 */
export const MODEL_TIERS = {
  fast: "gpt-5-nano",
  balanced: "gpt-5.4",
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
 *     "(omitted)" row of the table above: ~4x the tokens, ~3x the latency.
 *   - null, "" and 0 sent no `reasoning` at all, which is that same expensive
 *     row, chosen by anyone who POSTs `"effort": null`.
 * Now anything that is not a real effort level becomes DEFAULT_EFFORT. The
 * shipped extension only ever sends low / medium / high, all unchanged, and
 * lib/ai.js already applied this rule to its own callers. The ONLY thing that
 * can now disable effort is the vendor rejecting a valid level — what the
 * fallback was for. */
const VALID_EFFORTS = new Set(["minimal", "low", "medium", "high"]);
const normalizeEffort = (e) => (VALID_EFFORTS.has(e) ? e : DEFAULT_EFFORT);

/* Keyed per provider AND MODEL, because "does this accept reasoning effort" is
 * a fact about one model, not about the process.
 *
 * It was a single process-wide flag: the first 400 that blamed the parameter
 * switched effort off for every later call on every route. That coupled the
 * routes to each other — a desktop-only route on one model rejecting effort
 * would have put the extension's /api/check, on a different model, onto the
 * expensive "(omitted)" row until restart. Now a rejection disables effort for
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
  const body = p.structuredBody({ model: chosen, system, user, schema, maxTokens, name, effort: withEffort ? level : undefined });

  let json;
  try {
    json = await post(p, body);
  } catch (err) {
    if (!withEffort || !p.isEffortError(err)) throw err;
    effortDisabled.add(effortKey(p, chosen));
    json = await post(p, p.structuredBody({ model: chosen, system, user, schema, maxTokens, name, effort: undefined }));
  }
  p.checkComplete(json, what);
  const text = p.extractText(json);
  if (!text) throw new CheckError("server", `Model returned no content for ${what}.`, { status: 502 });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CheckError("server", `Model returned unparseable ${what} output.`, { status: 502 });
  }
  return { parsed, model: p.modelOf(json), usage: p.usageOf(json) };
}

/** A free-text call with conversation history. Returns the reply text. */
export async function textCall({ model, system, messages, maxTokens, what, effort = DEFAULT_EFFORT }) {
  const p = provider();
  const chosen = chooseModel(model);
  // No effort fallback here, and none was ever added: a textCall that 400s on
  // effort fails. structuredCall is where the retry has been measured.
  const body = p.textBody({ model: chosen, system, messages, maxTokens, effort: effortFor(p, chosen) ? normalizeEffort(effort) : undefined });
  const json = await post(p, body);
  p.checkComplete(json, what);
  return { text: p.extractText(json).trim(), model: p.modelOf(json), usage: p.usageOf(json) };
}

/** A call that may search the web before answering. Returns raw text. */
export async function webSearchCall({ model, system, user, maxTokens, what }) {
  const p = provider();
  // Searching then writing is slower than writing, hence the longer timeout.
  // It sends no reasoning effort — it never has, so every source search runs
  // at the vendor's default. That is a known cost (see the effort table
  // above) and changing it wants a fresh measurement, not a drive-by edit.
  const json = await post(p, p.webSearchBody({ model: chooseModel(model), system, user, maxTokens }), { timeoutMs: 180_000 });
  p.checkComplete(json, what);
  return { text: p.extractText(json), citations: p.extractCitations(json), model: p.modelOf(json), usage: p.usageOf(json) };
}
