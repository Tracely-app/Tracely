/** Typed-ish fetch wrappers — the renderer's only path to the server. */

import { MODEL_PRICES, MODEL_FOR_TIER } from "/shared/plan.js";

/* ── usage metering ─────────────────────────────────────────────────────────
   Every response carrying {usage:{input,output}, model} is accumulated into a
   per-model ledger; after each accumulation a "tracely:usage" event
   fires on window with cumulative {input, output, cost}. Cost is a rough
   estimate from public per-MTok pricing. */
/* Prices come from /shared/plan.js — the same table lib/llm.js bills the spend
   cap with, so the meter and the ledger cannot disagree.

   This was a local table keyed on the model FAMILIES `opus` / `sonnet` /
   `haiku`, left behind by the move to OpenAI. `familyOf("gpt-5-nano")` matched
   none of them, fell through to `other`, and `other` had no price — so the
   meter reported $0.00 for every call made since that migration. Keyed on the
   exact model id now, with an unknown id priced as the dearest tier rather
   than as free, which is the same direction lib/llm.js rounds. */
const ledger = new Map(); // model id -> { input, output }

function priceFor(model) {
  return (
    MODEL_PRICES[model]
    ?? MODEL_PRICES[String(model).replace(/-\d{4}-\d{2}-\d{2}$/, "")] // gpt-5-nano-2025-08-07
    ?? MODEL_PRICES[MODEL_FOR_TIER.thorough]
  );
}

function recordUsage(data) {
  const u = data?.usage;
  if (!u || typeof u !== "object") return;
  const input = Number(u.input) || 0;
  const output = Number(u.output) || 0;
  if (input === 0 && output === 0) return;
  const model = String(data.model ?? "");
  const tally = ledger.get(model) ?? { input: 0, output: 0 };
  tally.input += input;
  tally.output += output;
  ledger.set(model, tally);

  let totalIn = 0, totalOut = 0, cost = 0;
  for (const [id, t] of ledger) {
    totalIn += t.input;
    totalOut += t.output;
    const p = priceFor(id);
    cost += (t.input * p.input + t.output * p.output) / 1e6;
  }
  window.dispatchEvent(new CustomEvent("tracely:usage", {
    detail: { input: totalIn, output: totalOut, cost },
  }));
}

async function call(path, body, method) {
  const res = await fetch(path, body === undefined
    ? { method: method ?? "GET" }
    : { method: method ?? "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data?.error?.message ?? `HTTP ${res.status}`), {
      kind: data?.error?.kind, retryAfter: data?.error?.retryAfter, status: res.status,
    });
  }
  recordUsage(data);
  return data;
}

export const api = {
  status: () => call("/api/status"),

  // pipeline
  detectClaims: (text, opts = {}) => call("/api/detect-claims", { text, ...opts }),
  evidence: (req) => call("/api/evidence", req),                 // {claimId?, claim, query, claimType}
  critique: (req) => call("/api/critique", req),                 // {claim, sentence, citedRef?, sources?, model?}
  grade: (req) => call("/api/grade", req),                       // {text, level, rubric?, model?} → {components, custom?, model}
  structure: (text) => call("/api/structure", { text }),
  tracer: (req) => call("/api/tracer", req),                     // {conversationId?, documentId?, message}
  citeUrl: (url) => call("/api/cite-url", { url }),
  compareSource: (req) => call("/api/compare-source", req),      // {citedRef} → free Crossref/OpenLibrary resolution
  findSources: (req) => call("/api/sources", req),               // legacy web-search fallback

  documents: {
    list: (sort) => call(`/api/documents${sort ? `?sort=${sort}` : ""}`),
    get: (id) => call(`/api/documents/${id}`),
    create: (doc) => call("/api/documents", doc),
    update: (id, patch) => call(`/api/documents/${id}`, patch, "PUT"),
    remove: (id) => call(`/api/documents/${id}`, undefined, "DELETE"),
  },
  library: {
    list: (q) => call(`/api/library${q ? `?q=${encodeURIComponent(q)}` : ""}`),
    add: (item) => call("/api/library", item),                   // {source, note}
    update: (id, patch) => call(`/api/library/${id}`, patch, "PUT"),
    remove: (id) => call(`/api/library/${id}`, undefined, "DELETE"),
  },
  prefs: {
    get: () => call("/api/prefs"),
    set: (patch) => call("/api/prefs", patch, "PUT"),
  },
  stats: () => call("/api/stats"),
  analyses: {
    create: (a) => call("/api/analyses", a),
    forDocument: (docId) => call(`/api/analyses?documentId=${docId}`),
  },
  clearHistory: (alsoLibrary) => call("/api/clear-history", { alsoLibrary }),
};
