/* The OpenAI provider — everything about talking to a model that is specific
 * to OpenAI's Responses API, and nothing that is not.
 *
 * lib/llm.js is the facade every caller imports; it owns the FLOW (validate the
 * schema, pick the model, apply the effort policy, retry once without effort,
 * check the answer is complete, parse it) and asks the active provider for the
 * parts that differ between vendors: the request body, the transport, the
 * error envelope, and how to read text, citations and usage back out.
 *
 * Moved here verbatim from llm.js. Every message, status and `retryAfter`
 * below is WIRE-VISIBLE: server.js serialises CheckError kind + message
 * straight into the JSON error body, and the shipped extension shows them to
 * users on /api/check, /api/flow and /api/sources. Reword nothing here without
 * an extension release in mind.
 *
 * A second provider implements this same object shape and is registered in
 * llm.js's PROVIDERS. It must translate the wire model ids (the MODEL_TIERS
 * values — the extension sends them and cannot be changed without a release)
 * into its own ids inside the body builders; shared/plan.js's TIER_FOR_MODEL
 * is the map from a wire id to the tier it stands for.
 */
import { CheckError } from "../errors.js";

const API = "https://api.openai.com/v1/responses";

export const openai = {
  name: "openai",
  keyEnv: "OPENAI_API_KEY",
  missingKeyMessage: "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env",

  /* Reasoning effort is opt-in by model family: non-reasoning models 400 on
   * it. The family list is a guess made without a key to probe, which is why
   * the facade treats a 400 that blames the parameter as "turn it off" rather
   * than as a failed request (isEffortError). */
  supportsEffort: (m) => /^(gpt-5|gpt-6|o\d)/.test(String(m)),
  isEffortError: (err) => /reasoning|effort/i.test(String(err?.message ?? "")),

  structuredBody({ model, system, user, schema, maxTokens, name, effort }) {
    const body = {
      model,
      instructions: system,
      input: user,
      max_output_tokens: maxTokens,
      text: { format: { type: "json_schema", name, schema, strict: true } },
    };
    if (effort) body.reasoning = { effort };
    return body;
  },

  textBody({ model, system, messages, maxTokens, effort }) {
    const body = {
      model,
      instructions: system,
      // The Responses API takes the same {role, content} items the old Messages
      // API did, so the caller's history passes straight through.
      input: messages,
      max_output_tokens: maxTokens,
    };
    if (effort) body.reasoning = { effort };
    return body;
  },

  webSearchBody({ model, system, user, maxTokens }) {
    return {
      model,
      instructions: system,
      input: user,
      max_output_tokens: maxTokens,
      tools: [{ type: "web_search" }],
    };
  },

  /* A web search that MUST happen and must answer in a strict schema — the
   * desktop's source finder. `tool_choice: "required"` forces a tool call, and
   * web_search is the only tool offered, so the model searches before it
   * writes. The relay forced it for a measured reason: offered the tool and
   * allowed to decline, the model wrote plausible URLs from memory, and a
   * student cannot tell an invented link from a real one. */
  webSearchStructuredBody({ model, system, user, schema, name, maxTokens, effort }) {
    const body = {
      model,
      instructions: system,
      input: user,
      max_output_tokens: maxTokens,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      text: { format: { type: "json_schema", name, schema, strict: true } },
    };
    if (effort) body.reasoning = { effort };
    return body;
  },

  /* Reads the global fetch at CALL time, never at import: test/effort.test.js
   * swaps globalThis.fetch after this module has loaded. */
  async send(body, { key, timeoutMs }) {
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
    if (!res.ok) throw openai.mapError(res.status, json);
    return json;
  },

  mapError(status, json) {
    const msg = String(json?.error?.message ?? "");
    const code = String(json?.error?.code ?? "");
    if (status === 401) return new CheckError("no_key", "OpenAI rejected the API key.", { status: 503 });
    if (status === 429) return new CheckError("rate_limit", "OpenAI rate limit or quota reached — try again shortly.", { status: 429, retryAfter: 30 });
    if (code === "model_not_found" || /does not exist|not found/i.test(msg)) {
      // The most likely failure on day one of a migration, so it says exactly
      // what to edit rather than surfacing OpenAI's wording.
      return new CheckError("server", `OpenAI does not recognise that model. Fix MODEL_TIERS in lib/llm.js (OpenAI said: ${msg.slice(0, 120)})`, { status: 500 });
    }
    if (status >= 500) return new CheckError("server", "OpenAI had a server error — try again.", { status: 502 });
    return new CheckError("bad_request", msg || `OpenAI returned ${status}.`, { status: 502 });
  },

  checkComplete(json, what) {
    if (json?.status === "incomplete" && json?.incomplete_details?.reason === "max_output_tokens") {
      // Its own kind, because runFactCheck answers truncation by SPLITTING the
      // batch and retrying rather than failing — behaviour worth keeping, and it
      // needs to tell this apart from every other server error.
      throw new CheckError("truncated", `The ${what} response was truncated — try a smaller portion of text.`, { status: 502 });
    }
  },

  /* The Responses API returns a typed output array. The SDK synthesises
   * `output_text`; over raw HTTP we walk it ourselves, and we have to look for
   * a refusal item, which carries no text at all. */
  extractText(json) {
    if (typeof json.output_text === "string" && json.output_text) return json.output_text;
    let text = "";
    for (const item of json.output ?? []) {
      for (const part of item.content ?? []) {
        if (part.type === "refusal") throw new CheckError("refusal", "The model declined this request.", { status: 502 });
        if (part.type === "output_text" && typeof part.text === "string") text += part.text;
      }
    }
    return text;
  },

  /* web_search results are attached to the text as annotations rather than as
   * a separate block type. They are the backstop for findSources: if the
   * model's JSON comes back thin or unparseable, these are real URLs it read. */
  extractCitations(json) {
    const out = [];
    for (const item of json.output ?? []) {
      for (const part of item.content ?? []) {
        for (const a of part.annotations ?? []) {
          if (a?.type === "url_citation" && a.url) out.push({ url: a.url, title: a.title ?? "" });
        }
      }
    }
    return out;
  },

  /* OpenAI semantics: `cached` is a SUBSET of `input`, and reasoning tokens are
   * already inside `output`. costMicroCents relies on both. A provider whose
   * usage reports cache reads separately must normalise to this shape. */
  usageOf(json) {
    const u = json?.usage ?? {};
    return {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cached: u.input_tokens_details?.cached_tokens ?? 0,
    };
  },

  modelOf: (json) => json.model,
};
