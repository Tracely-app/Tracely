/**
 * What each model costs, as DATA — one table, read by the server's spend cap
 * and by the web app's spend meter.
 *
 * A leaf module on purpose: no imports, so the browser can load it from
 * /shared/ exactly as the server loads it from lib/llm.js. It lived only in
 * llm.js until the web app's meter was found pricing every call by Anthropic
 * family name ("opus" / "sonnet" / "haiku") months after the server moved to
 * OpenAI. None of those substrings is in an OpenAI model id, so every call
 * fell into the meter's "other" bucket at $0 and the header showed $0.00 for
 * any session, however long. A copy of a price table is a price table that is
 * wrong the next time prices change; this is the only copy.
 *
 * Dollars per 1M tokens. The ids MUST equal lib/llm.js MODEL_TIERS — pinned by
 * test/models.test.js.
 *
 * `cacheWrite` is what a first-seen prompt prefix costs on a model that bills
 * cache writes (1.25x input); usage reports those tokens as
 * `input_tokens_details.cache_write_tokens`, a subset of input. A model with
 * no `cacheWrite` here bills a write at its plain input rate.
 *
 * `WEB_SEARCH_CALL_DOLLARS` is the part that surprises people: OpenAI bills
 * the built-in web_search tool PER CALL ($10 per 1000) on top of tokens, so
 * the fee alone for one source search costs about as much as 10-25
 * typing-pause fact checks on the fast tier (0.039-0.104 cents each,
 * eval/models/FINDINGS.md), or ~3 full 40-sentence checks.
 */
export const MODEL_PRICES = {
  "gpt-5.6-luna":  { input: 0.20, cached: 0.02, output: 1.20, cacheWrite: 0.25 },
  "gpt-5.6-terra": { input: 2.00, cached: 0.20, output: 12.00, cacheWrite: 2.50 },
  "gpt-6-astra":   { input: 10.00, cached: 1.00, output: 50.00, cacheWrite: 12.50 },
};
export const WEB_SEARCH_CALL_DOLLARS = 0.01;

/* A dated snapshot ("gpt-5-nano-2025-08-07" was one) is what the API may echo
 * back as `model`, so a lookup by the echoed id has to fall back to its
 * family. (The current tiers echo their bare ids.) */
export function priceFor(model) {
  const id = String(model ?? "");
  return MODEL_PRICES[id] ?? MODEL_PRICES[id.replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? null;
}
