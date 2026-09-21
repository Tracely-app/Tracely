/** Typed-ish fetch wrappers — the renderer's only path to the server. */

/* ── usage metering ─────────────────────────────────────────────────────────
   Every response carrying {usage:{input,output}, model} is accumulated; after
   each accumulation a "tracely:usage" event fires on window with cumulative
   {input, output, cost}.

   Prices come from /shared/prices.js, the SAME table the server's spend cap
   bills against. This used to be its own table keyed by Anthropic family name
   — opus / sonnet / haiku, matched by substring — and no OpenAI model id
   contains any of those, so every call landed in an unpriced bucket and the
   header read $0.00 for any session, however long. A model with no price
   still counts its tokens; it just adds nothing to the dollar figure, which
   is the honest answer for a model we cannot price. */
import { priceFor } from "/shared/prices.js";

let totalIn = 0, totalOut = 0, cost = 0;

function recordUsage(data) {
  const u = data?.usage;
  if (!u || typeof u !== "object") return;
  const input = Number(u.input) || 0;
  const output = Number(u.output) || 0;
  if (input === 0 && output === 0) return;
  const cached = Math.min(Number(u.cached) || 0, input);
  totalIn += input;
  totalOut += output;
  const p = priceFor(data.model);
  if (p) cost += ((input - cached) * p.input + cached * p.cached + output * p.output) / 1e6;
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
  //
  // detect / grade / structure send the RAW draft as `draft`. The server's
  // AI routes speak the desktop's contract — numbered sentences or paragraphs
  // in `text` — and `draft` is the explicit way to say "this is not numbered,
  // split it for me". The field name is the switch; nothing sniffs content.
  detectClaims: (draft, opts = {}) => call("/api/detect-claims", { draft, ...opts }),
  evidence: (req) => call("/api/evidence", req),                 // {claimId?, claim, query, claimType}
  critique: (req) => call("/api/critique", req),                 // {claim, sentence, citedRef?, sources?, model?} → {critique, verdict, suggestedRevision, citationFix}
  grade: (req) => call("/api/grade", req),                       // {draft, level, rubric?, model?} → relay grade, or {components[], custom:true}
  structure: (draft) => call("/api/structure", { draft }),
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
