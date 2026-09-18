/* Tracely — engine-switching background worker.

   Two engines, picked automatically:
   • SERVER mode — the local Tracely server (localhost:4477) is reachable:
     relay every API call to it exactly as before. The server keeps ALL
     features: web-search sources, URL citing, the Docs write-back bridge.
   • STANDALONE mode — no server, but an OpenAI API key is configured on
     the options page (chrome.storage.local): serve the core flows directly
     from this worker with raw fetches to api.openai.com. Checks and
     web-search source lookups work; cite-url and the Docs bridge do not
     (the widget hides them).

   The worker probes the server on startup and every 60s (plus lazily when a
   request arrives and the last probe is stale). Content scripts talk to it
   with the same { type: "tracely-api", path, body } protocol as before, and
   can ask { type: "tracely-getState" } to learn the current mode.

   The relay is not an open proxy: it only talks to the local Tracely server
   or api.openai.com, and only on the endpoints listed below. The API key
   is read from chrome.storage.local and sent ONLY to api.openai.com.

   Accounts: an optional Supabase sign-in (options page) puts an access token
   in chrome.storage.local, which rides along as an Authorization header on
   every server-mode relay. The SERVER reads that header and decides which
   model tier the account may use — this worker only carries the token. */
"use strict";

/* Two possible backends, probed in order.

   LOCAL first, because a developer running the server on their own machine
   must keep working exactly as before. HOSTED is Tracely's own API.

   The hosted host is declared in the manifest and probed FROM THE START, even
   before it exists. That is deliberate: adding a host permission later is a
   PRIVILEGE INCREASE, and Chrome disables an extension for every existing
   user until they manually re-accept it — the single largest silent
   user-loss event available to us. Reserving it now costs an unanswered
   request per probe and makes switching the backend on a pure server-side
   change. It is also genuinely used rather than declared "just in case",
   which is what an unused permission would be. */
const LOCAL_SERVER = "http://localhost:4477";
const HOSTED_SERVER = "https://api.jointracely.com";
let SERVER = LOCAL_SERVER;
// Mirrors the server's EXTENSION_API set. Docs mode relays through here too,
// so the Docs bridge endpoint is included (server mode only).
const API_PATHS = new Set(["/api/status", "/api/check", "/api/flow", "/api/sources", "/api/cite-url", "/api/docs/apply", "/api/entitlement"]);

const PROBE_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 1500;

/* A hand copy of lib/llm.js's MODEL_TIERS. An MV3 worker cannot import from
   the server tree, and the extension ships without a build step, so this is
   the one unavoidable duplicate of those ids — test/models.test.js fails if
   it stops matching. */
const FAST_MODEL = "gpt-5-nano";
const ALLOWED_MODELS = new Set([FAST_MODEL, "gpt-5.4", "gpt-6-astra"]);
const ALLOWED_EFFORT = new Set(["low", "medium", "high"]);
const DEFAULT_MODEL = FAST_MODEL; // cost mandate: cheap unless explicitly chosen
const VERDICTS = ["accurate", "needs_citation", "false", "questionable", "incoherent", "no_claim"];

/* ── server probe ────────────────────────────────────────────────────────── */

let serverUp = null; // null = never probed
let lastProbeAt = 0;
let probePromise = null;

function probeServer() {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    serverUp = false;
    for (const base of [LOCAL_SERVER, HOSTED_SERVER]) {
      try {
        const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (res.ok) { SERVER = base; serverUp = true; break; }
      } catch { /* not reachable — try the next, then fall back to BYO key */ }
    }
    lastProbeAt = Date.now();
    probePromise = null;
    return serverUp;
  })();
  return probePromise;
}

async function serverReachable() {
  if (serverUp === null || Date.now() - lastProbeAt > PROBE_INTERVAL_MS) await probeServer();
  return serverUp;
}

probeServer(); // top level runs on every worker wake — this IS the startup probe
setInterval(probeServer, PROBE_INTERVAL_MS); // ticks while the worker stays alive

function getConfig() {
  return chrome.storage.local.get({ apiKey: "", model: DEFAULT_MODEL, enabledSites: [] });
}

/* ── accounts (Supabase) ─────────────────────────────────────────────────── */

/* The same Supabase project the desktop app signs into, so one account covers
   both. The anon key is not a secret — it names the project, not a user, and
   every Supabase browser client ships it; access control is Supabase's RLS
   plus the server's own token verification.

   Blank these two and the extension still works: `authConfigured()` goes
   false, the options page says accounts are not set up in this build, and
   everyone is a free user with an unmetered local server. That is the mode
   Sam and Merrick run in.

   Changing the project means changing the matching entry in manifest.json's
   host_permissions too — the token refresh below is a direct fetch to it. */
const SUPABASE_URL = "https://epafyygdvvkgpdkbevqi.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVwYWZ5eWdkdnZrZ3Bka2JldnFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NTUwOTIsImV4cCI6MjEwMTQzMTA5Mn0.8H-PInYTl37J2YZ7N1uKoUr_oDwVG53QmgloCJ3vETA";

const PLANS = ["free", "student", "pro"];
const DEFAULT_PLAN = "free";
const ENTITLEMENT_TTL_MS = 5 * 60_000; // fresh enough to notice a checkout, cheap enough to ask on every render

function authConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

// Mirrors normalizePlan in the desktop app's shared/plan.ts: case and stray
// space are forgiven because the value is written by whatever provisions the
// subscription, and ANYTHING else is free. Nothing here ever fails open.
function normalizePlan(value) {
  if (typeof value !== "string") return DEFAULT_PLAN;
  const normalized = value.trim().toLowerCase();
  return PLANS.includes(normalized) ? normalized : DEFAULT_PLAN;
}

function getAuth() {
  return chrome.storage.local.get({ authToken: "", refreshToken: "" });
}

async function clearAuth() {
  await chrome.storage.local.set({ authToken: "", refreshToken: "", entitlement: null });
}

// One attempt, then give up and sign the user out locally. A refresh token
// that Supabase has already rotated or revoked is not going to start working
// on a retry, and a checker that keeps stalling on auth is worse than a
// checker that quietly drops to free.
async function refreshAccessToken() {
  if (!authConfigured()) return "";
  const { refreshToken } = await getAuth();
  if (!refreshToken) return "";
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      await clearAuth();
      return "";
    }
    const data = await res.json().catch(() => ({}));
    const token = String(data?.access_token ?? "");
    if (!token) {
      await clearAuth();
      return "";
    }
    await chrome.storage.local.set({
      authToken: token,
      refreshToken: String(data?.refresh_token ?? refreshToken),
      entitlement: null, // a new token can carry a new plan — re-ask rather than trust the cache
    });
    return token;
  } catch {
    // Offline. Keep the tokens: the network coming back should not cost a
    // sign-in, and every caller already treats "no answer" as free.
    return "";
  }
}

/* Sign-in runs entirely in Chrome's own auth window. Supabase's implicit flow
   hands the tokens back in the fragment of the redirect URL, which is exactly
   what launchWebAuthFlow resolves with — no PKCE code exchange, and no remote
   code, which the Web Store forbids.

   The redirect target is https://<extension-id>.chromiumapp.org/, so that URL
   has to be on the Supabase project's allowed-redirect list or Supabase
   refuses the hand-back. */
async function signIn() {
  if (!authConfigured()) throw new Error("This build has no Supabase project configured, so accounts are unavailable.");
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl =
    `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectUri)}`;

  const finalUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!finalUrl) throw new Error("Sign-in was cancelled.");

  const url = new URL(finalUrl);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  // Supabase reports refusals as query params and successes in the fragment.
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? fragment.get("error_description");
  if (error) throw new Error(error);

  const accessToken = fragment.get("access_token") ?? "";
  if (!accessToken) throw new Error("Sign-in returned no access token.");
  await chrome.storage.local.set({
    authToken: accessToken,
    refreshToken: fragment.get("refresh_token") ?? "",
    entitlement: null,
  });
  return fetchEntitlement({ force: true });
}

async function signOut() {
  const { authToken } = await getAuth();
  if (authConfigured() && authToken) {
    // Best effort: revoking the session server-side is good hygiene, but the
    // sign-out the user asked for is the local one, and it must not fail
    // because the network did.
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${authToken}` },
      });
    } catch { /* already gone as far as this browser is concerned */ }
  }
  await clearAuth();
}

/* ── entitlement (GET /api/entitlement) ──────────────────────────────────── */

// `enforced: true` is the safe default for a non-answer: it means "assume the
// server WILL clamp", which shows the free tier rather than opening stops the
// call would not actually be served at.
const FREE_ENTITLEMENT = { plan: DEFAULT_PLAN, email: null, enforced: true };

// Cached in chrome.storage rather than in a worker variable: the service
// worker is evicted constantly, and the options page and every content script
// want the same answer. Content scripts watch the `entitlement` key to know
// when a plan changed.
async function cachedEntitlement() {
  const { entitlement } = await chrome.storage.local.get({ entitlement: null });
  if (!entitlement || typeof entitlement !== "object") return null;
  if (Date.now() - Number(entitlement.fetchedAt ?? 0) > ENTITLEMENT_TTL_MS) return null;
  return entitlement;
}

// `enforced` is what the server says about itself: false means it has no
// Supabase project configured and clamps nothing, so the picker should not
// pretend otherwise. Only an explicit `false` counts — a server too old to
// send the field, or a body missing it, stays enforced.
async function storeEntitlement(plan, email, enforced) {
  const entitlement = {
    plan: normalizePlan(plan),
    email: email ?? null,
    enforced: enforced !== false,
    fetchedAt: Date.now(),
  };
  await chrome.storage.local.set({ entitlement });
  return entitlement;
}

/* Never throws and never answers above free — this is on the path of every
   render and every relayed call. Signed out, server down, a body in a shape
   nobody expected: all free. Guessing high spends money on an account that is
   not paying; guessing low shows a paying user an upgrade prompt that one
   refresh clears. */
async function fetchEntitlement({ force = false } = {}) {
  if (!force) {
    const cached = await cachedEntitlement();
    if (cached) return cached;
  }
  const { authToken } = await getAuth();
  if (!authToken) {
    // Signed out still asks, because the answer carries `enforced` — a server
    // with no Supabase project clamps nothing and the picker must say so.
    if (!(await serverReachable())) return storeEntitlement(DEFAULT_PLAN, null, true);
    try {
      const res = await fetch(`${SERVER}/api/entitlement`);
      if (!res.ok) return storeEntitlement(DEFAULT_PLAN, null, true);
      const data = await res.json().catch(() => ({}));
      return storeEntitlement(DEFAULT_PLAN, null, data?.enforced);
    } catch {
      return storeEntitlement(DEFAULT_PLAN, null, true);
    }
  }
  if (!(await serverReachable())) {
    // No server to ask. Do not cache a guess — the answer is "we don't know",
    // and the next call once the server is back should be a real one.
    return { ...FREE_ENTITLEMENT, fetchedAt: 0 };
  }
  try {
    let res = await fetch(`${SERVER}/api/entitlement`, { headers: { Authorization: `Bearer ${authToken}` } });
    if (res.status === 401) {
      const fresh = await refreshAccessToken();
      if (!fresh) {
        await clearAuth();
        return storeEntitlement(DEFAULT_PLAN, null, true);
      }
      res = await fetch(`${SERVER}/api/entitlement`, { headers: { Authorization: `Bearer ${fresh}` } });
    }
    if (!res.ok) return { ...FREE_ENTITLEMENT, fetchedAt: 0 };
    const data = await res.json().catch(() => ({}));
    return storeEntitlement(data?.plan, typeof data?.email === "string" ? data.email : null, data?.enforced);
  } catch {
    return { ...FREE_ENTITLEMENT, fetchedAt: 0 };
  }
}

/* ── server relay (unchanged behavior) ───────────────────────────────────── */

// Throws on network failure (server just died) so the caller can fall through
// to standalone; returns the protocol envelope for HTTP responses.
//
// The access token rides along when there is one. The server is what reads it
// and decides which model the call actually runs at — the `model` in the body
// is a request, not a grant.
/* A stable per-install id, sent as X-Tracely-Install on every relayed call.
 *
 * The server meters free usage per caller, and a signed-in caller is metered by
 * its Supabase id. Most users never sign in — that is a deliberate product
 * promise — so without this header they all collapse onto the client ADDRESS,
 * which the server refuses to put a daily quota on: a few hundred students
 * behind one school address are indistinguishable from one attacker behind it.
 * This is what lets an honest user on a shared address get their own quota.
 *
 * It is NOT a credential and not a defence: it is client-generated, so anyone
 * can rotate it. The server's global daily budget is what bounds a determined
 * caller. This separates honest users from each other, which is the common
 * case and the one worth getting right.
 *
 * Random per install, never derived from anything about the user or machine,
 * and it identifies a browser profile rather than a person. */
let installIdPromise = null;
function installId() {
  if (!installIdPromise) {
    installIdPromise = (async () => {
      try {
        const got = await chrome.storage.local.get({ installId: "" });
        if (got.installId) return got.installId;
        const fresh = crypto.randomUUID();
        await chrome.storage.local.set({ installId: fresh });
        return fresh;
      } catch {
        // Storage unavailable: go without. The server falls back to the
        // address rung, which still rate-limits — it just cannot give this
        // caller a daily quota of its own.
        return "";
      }
    })();
  }
  return installIdPromise;
}

async function relay(path, body, { token = "", retried = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const install = await installId();
  if (install) headers["X-Tracely-Install"] = install;
  const res = await fetch(`${SERVER}${path}`, body === undefined
    ? (token ? { headers } : undefined)
    : { method: "POST", headers, body: JSON.stringify(body) });

  // An expired token must cost the user a re-auth at worst, never a broken
  // check: refresh once, and failing that drop to anonymous — which the
  // server serves as a free user.
  if (res.status === 401 && token && !retried) {
    const fresh = await refreshAccessToken();
    if (fresh) return relay(path, body, { token: fresh, retried: true });
    await clearAuth();
    return relay(path, body, { token: "", retried: true });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, status: res.status, message: data?.error?.message ?? `HTTP ${res.status}`, kind: data?.error?.kind };
  }
  return { ok: true, data };
}

/* ── standalone engine: raw calls to api.openai.com ──────────────────────── */

function apiErr(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

async function openaiFetch(apiKey, payload) {
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
  } catch {
    throw apiErr("network", "Could not reach OpenAI — check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw apiErr("auth", "OpenAI rejected the API key — check it in Tracely options");
    if (res.status === 429) throw apiErr("rate_limit", "Rate limited or out of quota — try again in a minute");
    if (res.status >= 500) throw apiErr("overloaded", "OpenAI had a server error — try again shortly");
    throw apiErr("server", data?.error?.message ?? `OpenAI error ${res.status}`);
  }
  return data;
}

/* The Responses API returns a typed output array rather than a content list.
   These three walk it the same way lib/llm.js does on the server. */
function outputText(data) {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  let text = "";
  for (const item of data.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "refusal") throw apiErr("refusal", "The model declined this request.");
      if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  return text;
}

function outputCitations(data) {
  const out = [];
  for (const item of data.output ?? []) {
    for (const part of item.content ?? []) {
      for (const a of part.annotations ?? []) {
        if (a?.type === "url_citation" && a.url) out.push({ url: a.url, title: a.title ?? "" });
      }
    }
  }
  return out;
}

const wasTruncated = (data) =>
  data?.status === "incomplete" && data?.incomplete_details?.reason === "max_output_tokens";

/* Reasoning effort is what the paid tier buys. gpt-5-nano is the free tier's
   model and takes it too, but a model that rejects the parameter answers 400,
   so it is only ever sent when the caller asked for a level above the floor. */
function jsonFormat(name, schema) {
  return { format: { type: "json_schema", name, schema, strict: true } };
}

function pickModel(bodyModel, cfgModel) {
  if (ALLOWED_MODELS.has(bodyModel)) return bodyModel;
  if (ALLOWED_MODELS.has(cfgModel)) return cfgModel;
  return DEFAULT_MODEL;
}

/* ── /api/check equivalent (ported from lib/factcheck.js) ────────────────── */

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["accurate", "needs_citation", "false", "questionable", "incoherent", "no_claim"] },
          explanation: { type: "string" },
          revision: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["id", "verdict", "explanation", "revision", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

function checkSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Tracely, a rigorous real-time fact-checker and clarity editor embedded in a writing tool. The author sees your findings as underlines while they type.

You receive the full document for context plus a list of sentences to evaluate. Return exactly one finding for EVERY listed sentence id — no more, no fewer.

Verdicts:
- "false": the sentence contains at least one factual claim that is verifiably wrong.
- "questionable": claims that are unverifiable, seriously disputed, misleading, or stated with false precision.
- "incoherent": the sentence does not make sense — internally contradictory, a non-sequitur, garbled to the point of obscuring meaning, or a conclusion that does not follow from its premise.
- "needs_citation": the claim appears ACCURATE but is the kind of assertion that needs a source — a statistic, study finding, quote, dated event, or specific non-common-knowledge fact — and neither a citation marker nor an attribution appears in or around the sentence.
- "accurate": contains factual claims and they are correct, and either they are common knowledge or a citation/attribution is present.
- "no_claim": coherent but contains no checkable factual claim (opinions, greetings, instructions, questions, clearly framed fiction).

Rules:
- Judge each sentence in the context of the whole document (resolve pronouns and references from surrounding text).
- explanation: at most 25 words, concrete. For "false", state the correct fact. For "needs_citation", name what kind of source would support it. For "accurate" and "no_claim", use an empty string.
- revision: a minimal rewrite of the sentence that fixes the problem while preserving the author's voice and intent. Empty string for "accurate", "no_claim", and "needs_citation" (nothing to rewrite — it needs a source, not different words). Never include surrounding sentences.
- A citation can be a bracketed marker like [1], a parenthetical (Author, year), or prose attribution ("According to…", "X reported…"). Any of these count as cited — never flag them "needs_citation".
- Widely known facts (capitals, famous dates, basic science) are common knowledge: "accurate", not "needs_citation".
- Precedence: a wrong claim is "false" and an unverifiable one "questionable" even if it also lacks a citation.
- Ignore bracketed citation markers like [1] when judging a sentence.
- Do not flag style, tone, or grammar unless it makes the sentence incoherent.
- Reasonable, widely used approximations are accurate, not questionable.
- Be decisive: reserve "questionable" for genuine uncertainty, not as a hedge on facts you know.
- Today's date is ${today}. If a claim depends on events you cannot verify because they postdate your knowledge, mark it "questionable" and say why.`;
}

function checkUserPrompt(text, sentences) {
  const list = sentences.map((s) => `[${s.id}] ${s.text}`).join("\n");
  return `DOCUMENT:\n"""\n${text}\n"""\n\nSENTENCES TO EVALUATE:\n${list}\n\nReturn one finding per id.`;
}

async function standaloneCheck(body, cfg) {
  const model = pickModel(body?.model, cfg.model);
  const effort = ALLOWED_EFFORT.has(body?.effort) ? body.effort : "low";
  const text = String(body?.text ?? "").slice(0, 30_000);
  const sentences = (Array.isArray(body?.sentences) ? body.sentences : [])
    .filter((s) => s && typeof s.id === "string" && typeof s.text === "string")
    .slice(0, 40)
    .map((s) => ({ id: s.id.slice(0, 40), text: s.text.slice(0, 2000) }));
  if (sentences.length === 0) return { findings: [], model };
  return checkBatch({ text, sentences, model, effort, apiKey: cfg.apiKey });
}

async function checkBatch({ text, sentences, model, effort, apiKey }) {
  const payload = {
    model,
    instructions: checkSystemPrompt(),
    input: checkUserPrompt(text, sentences),
    max_output_tokens: 16_000,
    text: jsonFormat("findings", FINDINGS_SCHEMA),
  };
  if (effort && effort !== "low") payload.reasoning = { effort };

  const response = await openaiFetch(apiKey, payload);

  if (wasTruncated(response)) {
    // Output budget exhausted — split the batch so each retry makes progress.
    if (sentences.length > 1) {
      const mid = Math.ceil(sentences.length / 2);
      const first = await checkBatch({ text, sentences: sentences.slice(0, mid), model, effort, apiKey });
      const second = await checkBatch({ text, sentences: sentences.slice(mid), model, effort, apiKey });
      return { findings: [...first.findings, ...second.findings], model: second.model };
    }
    throw apiErr("server", "Response was truncated — try checking a smaller portion of text.");
  }

  const raw = outputText(response);
  if (!raw) throw apiErr("server", "Model returned no text content.");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw apiErr("server", "Model returned unparseable output.");
  }

  const validIds = new Set(sentences.map((s) => s.id));
  const findings = (Array.isArray(parsed.findings) ? parsed.findings : [])
    .filter((f) => f && validIds.has(f.id))
    .map((f) => ({
      id: f.id,
      verdict: VERDICTS.includes(f.verdict) ? f.verdict : "no_claim",
      explanation: String(f.explanation ?? "").slice(0, 400),
      revision: String(f.revision ?? "").slice(0, 2000),
      confidence: ["high", "medium", "low"].includes(f.confidence) ? f.confidence : "medium",
    }));

  return { findings, model: response.model };
}

/* ── /api/sources equivalent (ported from lib/factcheck.js findSources) ──── */

/* ── flow coaching (standalone) — mirrors lib/factcheck.js runFlowCheck ──── */
const FLOW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issues"],
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["passage", "explanation", "transition"],
        properties: {
          passage: { type: "string", description: "The first sentence of the passage that reads abruptly, copied VERBATIM from the document." },
          explanation: { type: "string", description: "One or two sentences: what the reader loses at this jump." },
          transition: { type: "string", description: "A single sentence that could be inserted immediately BEFORE the passage to bridge the gap. Plain prose, no quotes." },
        },
      },
    },
  },
};

const FLOW_SYSTEM = `You are Tracely's flow coach. You read a student's essay as a whole and find places where the WRITING JUMPS — where a reader would lose the thread.

Flag a passage only when one of these is true:
- The paragraph changes subject with no transition from what came before.
- An idea, term, or example arrives before it has been set up.
- Two adjacent paragraphs are in the wrong order for the argument.
- A conclusion appears without the step that earns it.

Do NOT flag: grammar, word choice, tone, sentence length, factual errors, or anything a proofreader would catch. Those are other tools' jobs. Do not flag a paragraph merely for starting a new topic if a transition is already present.

Be strict. Most well-organized essays have ZERO flow issues; return an empty list in that case. Never report more than 3, and rank the most damaging first.

For each issue:
- "passage": copy the FIRST SENTENCE of the offending passage exactly as it appears in the document, character for character. It must be findable with an exact string search. Never paraphrase it, never add ellipses.
- "explanation": what the reader loses here, in plain language, addressed to the writer. Max 2 sentences.
- "transition": one sentence the writer could insert immediately before that passage to bridge the gap, written in their voice and using their subject matter. It must stand alone as prose.`;

async function standaloneFlow(body, cfg) {
  const model = pickModel(body?.model, cfg.model);
  const text = String(body?.text ?? "");
  if (!text.trim()) throw apiErr("bad_request", "No text to review.");
  const doc = text.length > 12_000 ? text.slice(0, 12_000) + "\n[… document truncated …]" : text;

  const response = await openaiFetch(cfg.apiKey, {
    model,
    instructions: FLOW_SYSTEM,
    input: `DOCUMENT:\n\n${doc}\n\nFind the flow problems. Return an empty list if the piece already reads smoothly.`,
    max_output_tokens: 8_000,
    text: jsonFormat("flow", FLOW_SCHEMA),
  });

  let parsed = {};
  try {
    parsed = JSON.parse(outputText(response) || "{}");
  } catch {
    throw apiErr("server", "Model returned unparseable output.");
  }
  // Drop anything we could not find verbatim — an unlocatable anchor draws nothing.
  const norm = (v) => v.toLowerCase().replace(/\s+/g, " ").trim();
  const hay = norm(text);
  const issues = (Array.isArray(parsed.issues) ? parsed.issues : [])
    .map((i) => ({
      passage: String(i?.passage ?? "").trim().slice(0, 400),
      explanation: String(i?.explanation ?? "").slice(0, 400),
      transition: String(i?.transition ?? "").slice(0, 400),
    }))
    .filter((i) => i.passage.length >= 12 && hay.includes(norm(i.passage)))
    .slice(0, 3);
  return { issues, model: response.model };
}

const SOURCES_SYSTEM = `You are Tracely's source finder. Given a claim from a document (and optionally a proposed correction), use web search to find authoritative sources that address it.

After researching, your FINAL message must be ONLY a JSON object, no prose, in this exact shape:
{"sources":[{"title":"...","url":"...","publisher":"...","snippet":"...","stance":"supports"|"refutes"|"context"}]}

Rules:
- 3 to 5 sources, ranked best-first. Prefer primary and authoritative sources (scientific bodies, encyclopedias, government agencies, reputable news) over blogs and content farms.
- "stance" is relative to the ORIGINAL claim: "supports" backs the claim as written, "refutes" contradicts it, "context" informs without settling it.
- "snippet": one sentence (max 30 words) describing what the source says about the claim.
- Use real URLs from your search results only. Never invent URLs.`;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function standaloneSources(body, cfg) {
  const model = pickModel(body?.model, cfg.model);
  const claim = String(body?.claim ?? "").slice(0, 2000);
  if (!claim.trim()) throw apiErr("bad_request", "No claim to research.");
  const correction = body?.correction ? String(body.correction).slice(0, 2000) : "";
  const context = body?.context ? String(body.context).slice(0, 6000) : "";

  const userMsg =
    `CLAIM:\n${claim}\n` +
    (correction ? `\nPROPOSED CORRECTION:\n${correction}\n` : "") +
    (context ? `\nDOCUMENT CONTEXT (excerpt):\n${context.slice(0, 3000)}\n` : "") +
    `\nFind sources, then output only the JSON object.`;

  // OpenAI runs the search server-side and returns one finished response, so
  // there is no pause/resume turn to drive here — the whole loop the previous
  // provider needed is gone.
  const response = await openaiFetch(cfg.apiKey, {
    model,
    instructions: SOURCES_SYSTEM,
    input: userMsg,
    max_output_tokens: 6_000,
    tools: [{ type: "web_search" }],
  });

  const fullText = outputText(response);

  let sources = [];
  const jsonMatch = fullText.match(/\{[\s\S]*"sources"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.sources)) sources = parsed.sources;
    } catch { /* fall through to citation harvest */ }
  }

  // Harvest search citations as backup candidates (and to backfill a thin
  // list). OpenAI hangs these off the text as url_citation annotations, which
  // carry a title and URL but no excerpt.
  const harvested = outputCitations(response).map((c) => ({
    title: c.title || c.url,
    url: c.url,
    publisher: hostOf(c.url),
    snippet: "",
    stance: "context",
  }));

  const seen = new Set();
  const merged = [];
  for (const s of [...sources, ...harvested]) {
    const url = String(s?.url ?? "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    merged.push({
      title: String(s.title ?? url).slice(0, 200),
      url: url.slice(0, 600),
      publisher: String(s.publisher ?? hostOf(url)).slice(0, 100),
      snippet: String(s.snippet ?? "").slice(0, 300),
      stance: ["supports", "refutes", "context"].includes(s.stance) ? s.stance : "context",
    });
    if (merged.length >= 6) break;
  }

  if (merged.length === 0) {
    throw apiErr("server", "No usable sources came back — try again.");
  }

  return { sources: merged, model: response.model };
}

/* ── standalone dispatch ─────────────────────────────────────────────────── */

async function standalone(path, body, cfg) {
  if (path === "/api/status") {
    // Shape-compatible with the server's status: no Docs bridge in standalone.
    return { ok: true, data: { ok: true, standalone: true, docsBridge: false, hasKey: true, model: cfg.model } };
  }
  if (path === "/api/check") return { ok: true, data: await standaloneCheck(body, cfg) };
  if (path === "/api/sources") return { ok: true, data: await standaloneSources(body, cfg) };
  if (path === "/api/flow") return { ok: true, data: await standaloneFlow(body, cfg) };
  // /api/cite-url and /api/docs/apply have no standalone equivalent — the
  // widget hides those affordances when it learns the mode.
  return { ok: false, kind: "standalone_unsupported", message: "This feature needs the local Tracely server" };
}

/* ── messaging ───────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "tracely-getState") {
    (async () => {
      const cfg = await getConfig();
      const up = await serverReachable();
      sendResponse({
        ok: true,
        server: Boolean(up),
        hasKey: Boolean(cfg.apiKey),
        mode: up ? "server" : cfg.apiKey ? "standalone" : "offline",
      });
    })();
    return true; // async sendResponse
  }

  /* What the options page and the widgets ask to learn the account state.

     Two flags say "there is no plan to apply here", for different reasons, and
     the UIs open every model stop on either:

     • `byoKey` — standalone mode. The call is served by the user's own
       OpenAI key and billed to them by OpenAI, so there is nothing of ours
       to meter and no sign-in to require.
     • `unenforced` — the local server reported `enforced: false`, meaning it
       has no Supabase project configured and clamps nothing. Locking the
       picker there would show an upgrade prompt for a server that will serve
       the top model on request. That is the mode a plain `node server.js` with the
       stock .env runs in.

     Both default to false on any non-answer, so an unreachable worker or a
     server too old to send the field leaves the picker on the free tier. */
  if (msg?.type === "tracely-entitlement") {
    (async () => {
      try {
        const [{ authToken }, cfg, ent, up] = await Promise.all([getAuth(), getConfig(), fetchEntitlement({ force: msg.force === true }), serverReachable()]);
        sendResponse({
          ok: true,
          configured: authConfigured(),
          signedIn: Boolean(authToken),
          plan: normalizePlan(ent?.plan),
          email: ent?.email ?? null,
          // Carried so the upgrade link can attach client_reference_id — the
          // only thing that lets the Stripe webhook map a payment to THIS
          // account rather than guessing from the payer's email.
          userId: ent?.userId ?? null,
          byoKey: !up && Boolean(cfg.apiKey),
          unenforced: Boolean(up) && ent?.enforced === false,
        });
      } catch (err) {
        // Fail closed, but still answer: an unanswered probe would leave the
        // widget with no tier at all.
        sendResponse({ ok: true, configured: authConfigured(), signedIn: false, plan: DEFAULT_PLAN, email: null, userId: null, byoKey: false, unenforced: false, message: err?.message });
      }
    })();
    return true; // async sendResponse
  }

  if (msg?.type === "tracely-signIn") {
    (async () => {
      try {
        const ent = await signIn();
        sendResponse({ ok: true, plan: normalizePlan(ent?.plan), email: ent?.email ?? null });
      } catch (err) {
        sendResponse({ ok: false, message: err?.message ?? String(err) });
      }
    })();
    return true; // async sendResponse
  }

  if (msg?.type === "tracely-signOut") {
    (async () => {
      try {
        await signOut();
      } catch { /* clearAuth already ran, or storage is gone with the profile */ }
      sendResponse({ ok: true });
    })();
    return true; // async sendResponse
  }

  if (msg?.type !== "tracely-api" || typeof msg.path !== "string" || !API_PATHS.has(msg.path)) {
    return false;
  }
  (async () => {
    try {
      if (await serverReachable()) {
        try {
          const { authToken } = await getAuth();
          sendResponse(await relay(msg.path, msg.body, { token: authToken }));
          return;
        } catch {
          // Server died between probe and call — remember, fall to standalone.
          serverUp = false;
          lastProbeAt = Date.now();
        }
      }
      const cfg = await getConfig();
      if (!cfg.apiKey) {
        sendResponse({
          ok: false,
          offline: true,
          kind: "no_engine",
          message: "Tracely server offline and no API key set — start the server, or add a key in Tracely options",
        });
        return;
      }
      sendResponse(await standalone(msg.path, msg.body, cfg));
    } catch (err) {
      sendResponse({ ok: false, kind: err?.kind ?? "server", message: err?.message ?? String(err) });
    }
  })();
  return true; // async sendResponse
});
