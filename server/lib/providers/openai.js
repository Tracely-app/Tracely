/* The OpenAI half of lib/llm.js — everything that would be different if
 * Tracely called a different vendor, and nothing that would not.
 *
 * WHAT BELONGS HERE: the endpoint, the auth header, the shape of the request
 * body, the shape of the response, and the vendor's error vocabulary. Those
 * are the four things a second provider would have to answer differently.
 *
 * WHAT DOES NOT: how hard we try, when we retry, what we do about a truncated
 * answer, and which model a plan may reach. Those are Tracely's policy and
 * they stay in llm.js, where they apply to every provider — a second provider
 * that quietly re-decided them would be a second product.
 *
 * Kind strings on CheckError are part of the wire contract with the extension
 * and the web app (`error.kind`), so they are the same words whichever
 * provider produced the failure.
 */
import { CheckError } from "../errors.js";

const API = "https://api.openai.com/v1/responses";

export const id = "openai";
export const label = "OpenAI";

let cachedKey = null;
/* Read per call, not once at import: server.js re-reads .env while running so
 * a key can be pasted in without a restart. The cache only ever remembers a
 * key that WAS set, so a momentarily empty env does not un-configure us. */
export function apiKey() {
  const k = process.env.OPENAI_API_KEY?.trim();
  if (k) cachedKey = k;
  return cachedKey;
}

export function missingKeyError() {
  return new CheckError("no_key", "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env", { status: 503 });
}

/* OpenAI's strict mode is stricter than Anthropic's was: EVERY property must
 * appear in `required`, and every object needs additionalProperties:false. A
 * schema that breaks either is a 400 at call time, in production, on a path
 * that may only run for one user. Checking it here turns that into a precise
 * local failure naming the offending object.
 *
 * Provider-specific because it encodes one vendor's schema dialect. A second
 * provider supplies its own, or a no-op. */
export function assertSchema(schema, where = "schema") {
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

/* Reasoning effort is what the paid "intelligence" tier actually buys.
 * Non-reasoning models 400 on it, so it is opt-in by model family — and
 * because that family list is a guess made without a key to probe, llm.js
 * treats a 400 blaming the parameter as a signal to stop sending it rather
 * than as the user's failed request. */
export const supportsEffort = (m) => /^(gpt-5|gpt-6|o\d)/.test(String(m));

/** Build a request body. `kind` is one of structured | text | search. */
export function buildRequest({ kind, model, system, input, maxTokens, schema, schemaName, effort, tools }) {
  const body = {
    model,
    instructions: system,
    input,
    max_output_tokens: maxTokens,
  };
  if (kind === "structured") {
    body.text = { format: { type: "json_schema", name: schemaName, schema, strict: true } };
  }
  if (kind === "search") {
    body.tools = tools ?? [{ type: "web_search" }];
  }
  if (effort) body.reasoning = { effort };
  return body;
}

/** True when this error is the provider complaining about `reasoning`. */
export function isEffortRejection(err) {
  return /reasoning|effort/i.test(String(err?.message ?? ""));
}

/** Strip the effort parameter from a body we are about to retry. */
export function withoutEffort(body) {
  const { reasoning, ...rest } = body;
  return rest;
}

export async function send(body, { timeoutMs = 120_000 } = {}) {
  const key = apiKey();
  if (!key) throw missingKeyError();
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
  if (!res.ok) throw mapError(res.status, json);
  return json;
}

export function mapError(status, json) {
  const msg = String(json?.error?.message ?? "");
  const code = String(json?.error?.code ?? "");
  if (status === 401) return new CheckError("no_key", "OpenAI rejected the API key.", { status: 503 });
  if (status === 429) return new CheckError("rate_limit", "OpenAI rate limit or quota reached — try again shortly.", { status: 429, retryAfter: 30 });
  if (code === "model_not_found" || /does not exist|not found/i.test(msg)) {
    // The most likely failure on day one of a model change, so it says exactly
    // what to edit rather than surfacing OpenAI's wording.
    return new CheckError("server", `OpenAI does not recognise that model. Fix MODEL_FOR_TIER in shared/plan.js (OpenAI said: ${msg.slice(0, 120)})`, { status: 500 });
  }
  if (status >= 500) return new CheckError("server", "OpenAI had a server error — try again.", { status: 502 });
  return new CheckError("bad_request", msg || `OpenAI returned ${status}.`, { status: 502 });
}

/* The Responses API returns a typed output array. The SDK synthesises
 * `output_text`; over raw HTTP we walk it ourselves, and we have to look for a
 * refusal item, which carries no text at all. */
export function extractText(json) {
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
export function extractCitations(json) {
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

export function extractUsage(json) {
  const u = json?.usage ?? {};
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cached: u.input_tokens_details?.cached_tokens ?? 0,
  };
}

/** The model the provider says it actually ran. */
export function modelOf(json) {
  return json?.model;
}

/** Non-null when the answer was cut short by the output ceiling. */
export function truncatedReason(json) {
  return json?.status === "incomplete" && json?.incomplete_details?.reason === "max_output_tokens"
    ? "max_output_tokens"
    : null;
}
