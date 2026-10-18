/**
 * What every charged model call cost, by route, logged once an hour
 * (2026-10-17, server.js chargeCall).
 *
 * The point is the PROMPT CACHE. OpenAI reports how much of each prompt it read
 * from its cache (`cached`, priced at a tenth of input) and how much it wrote
 * to it (`cacheWrite`, 1.25x input — shared/prices.js), and nothing recorded
 * either, so whether a caching lever saves money or costs it was unknowable:
 * eval/models/FINDINGS.md left the check-side levers waiting for exactly this.
 * One line per route: calls, tokens in, the share read from and written to the
 * cache, tokens out, web searches, dollars.
 *
 * Counts and dollars only — never a word of anyone's text, and no caller id.
 * In memory: a restart loses at most an hour of a statistic, never a limit.
 */
import { MICRO_CENTS_PER_USD } from "./spend.js";

const tally = new Map(); // route -> { calls, input, cached, cacheWrite, output, searches, microCents }
const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

export function tallyCall(route, { usage, webSearchCalls = 0, cost = 0 } = {}) {
  const key = typeof route === "string" && /^\/api\/[a-z/-]+$/.test(route) ? route : "other";
  const t = tally.get(key) ?? { calls: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, searches: 0, microCents: 0 };
  t.calls += 1;
  t.input += n(usage?.input);
  t.cached += n(usage?.cached);
  t.cacheWrite += n(usage?.cacheWrite);
  t.output += n(usage?.output);
  t.searches += n(webSearchCalls);
  t.microCents += n(cost);
  tally.set(key, t);
}

/** The log lines for everything tallied since the last take, and a fresh start. */
export function takeUsageLines() {
  const lines = [...tally].sort(([a], [b]) => a.localeCompare(b)).map(([route, t]) => {
    const pct = (part) => (t.input > 0 ? `${Math.round((100 * part) / t.input)}%` : "-");
    const usd = (t.microCents / MICRO_CENTS_PER_USD).toFixed(4);
    return `[tracely] usage route=${route} calls=${t.calls} in=${t.input} cached=${t.cached} (${pct(t.cached)}) write=${t.cacheWrite} (${pct(t.cacheWrite)}) out=${t.output} searches=${t.searches} cost=$${usd}`;
  });
  tally.clear();
  return lines;
}
