/* The one place Tracely talks to a model.
 *
 * OpenAI Responses API over plain fetch — no SDK, which is why this server now
 * has ZERO runtime dependencies. It also means the request shape here and the
 * one in extension/background.js (which cannot load an SDK at all under MV3)
 * are the same shape, so a change to either is legible against the other.
 *
 * Two call shapes cover all eight AI functions in this codebase:
 *   structuredCall — JSON matching a schema, used by every checker
 *   webSearchCall  — the built-in web_search tool, used only by findSources
 */
import { CheckError } from "./errors.js";

const API = "https://api.openai.com/v1/responses";

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

let cachedKey = null;
export function hasApiKey() {
  return Boolean(apiKey());
}
function apiKey() {
  const k = process.env.OPENAI_API_KEY?.trim();
  if (k) cachedKey = k;
  return cachedKey;
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

async function post(body, { timeoutMs = 120_000 } = {}) {
  const key = apiKey();
  if (!key) throw new CheckError("no_key", "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env", { status: 503 });
  let res;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError") throw new CheckError("timeout", "The model took too long to answer — try a smaller portion of text.", { status: 504 });
    throw new CheckError("network", "Could not reach OpenAI.", { status: 502 });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw mapApiError(res.status, json);
  return json;
}

export function mapApiError(status, json) {
  const msg = String(json?.error?.message ?? "");
  const code = String(json?.error?.code ?? "");
  if (status === 401) return new CheckError("no_key", "OpenAI rejected the API key.", { status: 503 });
  if (status === 429) return new CheckError("rate_limit", "OpenAI rate limit or quota reached — try again shortly.", { status: 429, retryAfter: 30 });
  if (code === "model_not_found" || /does not exist|not found/i.test(msg)) {
    // The most likely failure on day one of this migration, so it says exactly
    // what to edit rather than surfacing OpenAI's wording.
    return new CheckError("server", `OpenAI does not recognise that model. Fix MODEL_TIERS in lib/llm.js (OpenAI said: ${msg.slice(0, 120)})`, { status: 500 });
  }
  if (status >= 500) return new CheckError("server", "OpenAI had a server error — try again.", { status: 502 });
  return new CheckError("bad_request", msg || `OpenAI returned ${status}.`, { status: 502 });
}

/* The Responses API returns a typed output array. The SDK synthesises
 * `output_text`; over raw HTTP we walk it ourselves, and we have to look for a
 * refusal item, which carries no text at all. */
function extractText(json) {
  if (typeof json.output_text === "string" && json.output_text) return json.output_text;
  let text = "";
  for (const item of json.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "refusal") throw new CheckError("refusal", "The model declined this request.", { status: 502 });
      if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  return text;
}

/* web_search results are attached to the text as annotations rather than as a
 * separate block type. They are the backstop for findSources: if the model's
 * JSON comes back thin or unparseable, these are real URLs it actually read. */
function extractCitations(json) {
  const out = [];
  for (const item of json.output ?? []) {
    for (const part of item.content ?? []) {
      for (const a of part.annotations ?? []) {
        if (a?.type === "url_citation" && a.url) out.push({ url: a.url, title: a.title ?? "" });
      }
    }
  }
  return out;
}

function usageOf(json) {
  const u = json?.usage ?? {};
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cached: u.input_tokens_details?.cached_tokens ?? 0,
  };
}

function checkComplete(json, what) {
  if (json?.status === "incomplete" && json?.incomplete_details?.reason === "max_output_tokens") {
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
const supportsEffort = (m) => /^(gpt-5|gpt-6|o\d)/.test(String(m));
const DEFAULT_EFFORT = "low";
let effortSupported = true;

/** A call that must return JSON matching `schema`. */
export async function structuredCall({ model, system, user, schema, maxTokens, what, name = "result", effort = DEFAULT_EFFORT }) {
  assertStrictSchema(schema, what);
  const chosen = chooseModel(model);
  const body = {
    model: chosen,
    instructions: system,
    input: user,
    max_output_tokens: maxTokens,
    text: { format: { type: "json_schema", name, schema, strict: true } },
  };
  const withEffort = Boolean(effort) && effortSupported && supportsEffort(chosen);
  if (withEffort) body.reasoning = { effort };

  let json;
  try {
    json = await post(body);
  } catch (err) {
    if (!withEffort || !/reasoning|effort/i.test(String(err?.message ?? ""))) throw err;
    effortSupported = false;
    delete body.reasoning;
    json = await post(body);
  }
  checkComplete(json, what);
  const text = extractText(json);
  if (!text) throw new CheckError("server", `Model returned no content for ${what}.`, { status: 502 });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CheckError("server", `Model returned unparseable ${what} output.`, { status: 502 });
  }
  return { parsed, model: json.model, usage: usageOf(json) };
}

/** A free-text call with conversation history. Returns the reply text. */
export async function textCall({ model, system, messages, maxTokens, what, effort = DEFAULT_EFFORT }) {
  const chosen = chooseModel(model);
  const body = {
    model: chosen,
    instructions: system,
    // The Responses API takes the same {role, content} items the old Messages
    // API did, so the caller's history passes straight through.
    input: messages,
    max_output_tokens: maxTokens,
  };
  if (effort && effortSupported && supportsEffort(chosen)) body.reasoning = { effort };
  const json = await post(body);
  checkComplete(json, what);
  return { text: extractText(json).trim(), model: json.model, usage: usageOf(json) };
}

/** A call that may search the web before answering. Returns raw text. */
export async function webSearchCall({ model, system, user, maxTokens, what }) {
  const json = await post({
    model: chooseModel(model),
    instructions: system,
    input: user,
    max_output_tokens: maxTokens,
    tools: [{ type: "web_search" }],
  }, { timeoutMs: 180_000 }); // searching then writing is slower than writing
  checkComplete(json, what);
  return { text: extractText(json), citations: extractCitations(json), model: json.model, usage: usageOf(json) };
}
