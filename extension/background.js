/* Tracely — relaying background worker.

   ONE engine. Every API call is relayed to a Tracely server: the local one at
   localhost:4477 if a developer is running it, otherwise the hosted one at
   api.jointracely.com. The server keeps all the features that need it —
   web-search sources, URL citing, the Docs write-back bridge.

   There was a second engine, STANDALONE, which called api.openai.com directly
   with a key the user pasted into the options page. It is gone; the long
   comment where it used to live says why.

   The worker probes both servers on startup and every 60s (plus lazily when a
   request arrives and the last probe is stale). Content scripts talk to it
   with the { type: "tracely-api", path, body } protocol, and can ask
   { type: "tracely-getState" } to learn whether a server answered.

   The relay is not an open proxy: it only talks to those two hosts, and only
   on the endpoints listed below.

   Accounts: an optional Supabase sign-in (options page) puts an access token
   in chrome.storage.local, which rides along as an Authorization header on
   every relayed call. The SERVER reads that header and decides which model
   tier the account may use — this worker only carries the token. */
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

/* A hand copy of lib/llm.js's MODEL_TIERS — the two ids the server serves.
   An MV3 worker cannot import from the server tree, and the extension ships
   without a build step, so this is the one unavoidable duplicate of those
   ids; test/models.test.js fails if it stops matching. Since the 2026-09-21
   plan policy the SERVER picks which of them runs, per route and per plan:
   the fast one for every check, flow and source search, the thorough one for
   Pro's "Explain in depth" while the monthly allowance lasts. */
const FAST_MODEL = "gpt-5.6-luna";
const THOROUGH_MODEL = "gpt-6-astra";
const ALLOWED_MODELS = new Set([FAST_MODEL, THOROUGH_MODEL]);

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
      } catch { /* not reachable — try the next */ }
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

/* Any key stored by a build that still had the standalone engine is dropped
   here, on every worker wake. Nothing reads it now, so leaving it would mean
   an OpenAI credential sitting in chrome.storage on every existing install
   with no screen left that can show or clear it. */
chrome.storage.local.remove("apiKey");

/* Likewise the retired Faster↔Smarter stop. Nothing has read it since 2.20.0
   — the server picks the model per route — and what it holds may be an id
   (`gpt-5.6-terra`) the server no longer serves. Dropping it here, beside the
   key, is what actually reaches every install: the options page is a screen
   most people never open, so a cleanup that only runs there leaves the value
   sitting in storage on almost every 2.19.x upgrade. */
chrome.storage.local.remove("model");

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
const SUPABASE_URL = "https://sxifbtelrtbsgnnwnmdf.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN4aWZidGVscnRic2dubndubWRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyMzc1MTIsImV4cCI6MjEwMTgxMzUxMn0.B_xYQkW28rIDu2yByuIJwg8-m__-czUWLuT1_4yz6fA";

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
//
// `userId` is kept because the options page's upgrade link attaches it as
// client_reference_id (it is never handed to a content script — see
// fromExtensionPage).
// This used to take only the first three arguments, so the cached entitlement
// never had a userId and every tracely-entitlement answer said null — the
// server sent the id and the worker dropped it on the floor.
//
// `beta` records that the server granted the test build's Pro plan, so the
// options page can say "Pro (beta)" and not offer to sell it.
/* The OPTIONAL fields a 2026-09-21-or-later server adds to /api/entitlement:
   the limits this caller is metered at, the source searches used today and
   this month, Pro's Thorough allowance as a whole percent, and the fair-use
   state. The options page draws its meters from them and the widgets ignore
   them; every one is optional, so an older server (or a local one, which
   meters nothing) simply leaves them out and the page says nothing.

   Everything is re-validated here rather than passed through: this is the
   one place a server answer becomes state the pages render. */
function entitlementExtras(data) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const day = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const out = {};
  const l = data?.limits;
  if (l && typeof l === "object") {
    out.limits = {
      checksPerDay: num(l.checksPerDay),
      aiActionsPerDay: num(l.aiActionsPerDay),
      flowPerDay: num(l.flowPerDay),
      sources: { day: num(l.sources?.day), month: num(l.sources?.month) },
    };
  }
  const s = data?.usage?.sources;
  if (s && typeof s === "object") out.usage = { sources: { today: num(s.today) ?? 0, month: num(s.month) ?? 0 } };
  const t = data?.thorough;
  if (t && typeof t === "object" && num(t.remainingPct) !== null) {
    out.thorough = { remainingPct: Math.max(0, Math.min(100, Math.round(t.remainingPct))), resetsOn: day(t.resetsOn), suspended: t.suspended === true };
  }
  const f = data?.fairUse;
  if (f && typeof f === "object" && ["ok", "day", "month"].includes(f.state)) {
    out.fairUse = { state: f.state, resetsOn: day(f.resetsOn) };
  }
  return out;
}

async function storeEntitlement(plan, email, enforced, { userId = null, beta = false, extras = null } = {}) {
  const entitlement = {
    plan: normalizePlan(plan),
    email: email ?? null,
    userId: typeof userId === "string" && userId ? userId : null,
    enforced: enforced !== false,
    beta: beta === true,
    ...(extras ?? {}),
    fetchedAt: Date.now(),
  };
  await chrome.storage.local.set({ entitlement });
  return entitlement;
}

/* ── the test build (X-Tracely-Beta) ─────────────────────────────────────────
   The team's test build is this same extension, loaded unpacked, with one
   extra file: beta.json, {"token": "..."}, written into the zip by
   `server/scripts/pack-extension.sh --beta` and never committed. When the file
   is there AND Chrome says this copy was loaded unpacked, every request to the
   server carries the token as X-Tracely-Beta, and a server that recognises it
   serves the caller as Pro (on its own spend pool).

   Both halves are required. The manifest `key` gives the unpacked build the
   SAME id as the Web Store build, so the id cannot tell them apart —
   installType can: the store copy is "normal", Load-unpacked is
   "development". A store build that somehow shipped the file still sends
   nothing. getSelf needs no "management" permission.

   The token is not a secret against the testers who hold the zip; it is a
   switch the server can revoke by editing .env. Never throws: any failure —
   no file, bad JSON, no management API — just means no beta. Cached for the
   worker's lifetime; a new build is a new worker. */
let betaTokenPromise = null;
function betaToken() {
  if (!betaTokenPromise) {
    betaTokenPromise = (async () => {
      try {
        const self = await chrome.management?.getSelf?.();
        if (self?.installType !== "development") return "";
        const res = await fetch(chrome.runtime.getURL("beta.json"));
        if (!res.ok) return "";
        const data = await res.json();
        const token = typeof data?.token === "string" ? data.token.trim() : "";
        // Visible ASCII only. Anything else is not a legal header value, and
        // fetch() would THROW on every relayed call — which the relay reads as
        // "the server died" and turns into an offline widget.
        return /^[\x21-\x7E]{1,512}$/.test(token) ? token : "";
      } catch {
        return "";
      }
    })();
  }
  return betaTokenPromise;
}

/* Adds X-Tracely-Beta (test build) and X-Tracely-Install to a headers object.
   The install id belongs on /api/entitlement as much as on a relayed call:
   the server reports per-CALLER metering there — the Thorough allowance, the
   fair-use state, the searches used — and without a caller id it has nobody
   to report about. A signed-out Pro tester was told nothing about the
   allowance the page has a meter for. */
async function withBeta(headers = {}) {
  const token = await betaToken();
  if (token) headers["X-Tracely-Beta"] = token;
  const install = await installId();
  if (install) headers["X-Tracely-Install"] = install;
  return headers;
}

// A build switch (store copy -> test build, or back) happens through an
// install or reload, and must not wait out a cached entitlement from the other
// build: the widgets clamp their stored stop to whatever plan they are shown.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ entitlement: null }).catch(() => {});
});

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
    /* On a failure, a store build caches free: signed out IS free there, so
       it is the right answer, not a guess. The test build's answer depends on
       the server (it grants Pro), so a failure there is "we don't know" —
       never cached, exactly like the signed-in path below. Cached, one
       offline wake or one 503 put a tester on free for the whole TTL, and the
       widgets and options page wrote that downgrade into their saved stop. */
    const unknown = async () => ((await betaToken())
      ? { ...FREE_ENTITLEMENT, beta: false, fetchedAt: 0 }
      : storeEntitlement(DEFAULT_PLAN, null, true));
    // Signed out still asks, because the answer carries `enforced` — a server
    // with no Supabase project clamps nothing and the picker must say so.
    if (!(await serverReachable())) return unknown();
    try {
      const res = await fetch(`${SERVER}/api/entitlement`, { headers: await withBeta() });
      if (!res.ok) return unknown();
      const data = await res.json().catch(() => ({}));
      // Signed out is free — UNLESS the server granted the test build's Pro
      // plan, which it says with `beta: true`. Only that flag lifts the plan
      // here; a bare `plan` in a signed-out answer is still ignored.
      const beta = data?.beta === true;
      return storeEntitlement(beta ? data?.plan : DEFAULT_PLAN, null, data?.enforced, { beta, extras: entitlementExtras(data) });
    } catch {
      return unknown();
    }
  }
  if (!(await serverReachable())) {
    // No server to ask. Do not cache a guess — the answer is "we don't know",
    // and the next call once the server is back should be a real one.
    return { ...FREE_ENTITLEMENT, fetchedAt: 0 };
  }
  try {
    let res = await fetch(`${SERVER}/api/entitlement`, { headers: await withBeta({ Authorization: `Bearer ${authToken}` }) });
    if (res.status === 401) {
      const fresh = await refreshAccessToken();
      if (!fresh) {
        await clearAuth();
        // Signed out now. On the test build that is still a question for the
        // server (the beta grant needs no account), so ask it as signed out
        // rather than storing free for the TTL.
        if (await betaToken()) return fetchEntitlement({ force: true });
        return storeEntitlement(DEFAULT_PLAN, null, true);
      }
      res = await fetch(`${SERVER}/api/entitlement`, { headers: await withBeta({ Authorization: `Bearer ${fresh}` }) });
    }
    if (!res.ok) return { ...FREE_ENTITLEMENT, fetchedAt: 0 };
    const data = await res.json().catch(() => ({}));
    return storeEntitlement(data?.plan, typeof data?.email === "string" ? data.email : null, data?.enforced, {
      userId: data?.userId,
      beta: data?.beta === true,
      extras: entitlementExtras(data),
    });
  } catch {
    return { ...FREE_ENTITLEMENT, fetchedAt: 0 };
  }
}

/* ── server relay (unchanged behavior) ───────────────────────────────────── */

// Throws on network failure (the server just died) so the caller can mark the
// probe stale; returns the protocol envelope for HTTP responses.
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
  // The test build's Pro grant has to reach every route the server gates on
  // it, not only /api/entitlement — the plan is decided per request.
  const beta = await betaToken();
  if (beta) headers["X-Tracely-Beta"] = beta;
  const res = await fetch(`${SERVER}${path}`, body === undefined
    ? (token || beta ? { headers } : undefined)
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

/* The STANDALONE ENGINE used to live here: ~360 lines that called
   api.openai.com directly with a key the user pasted into the options page,
   re-implementing check, flow and sources against the raw Responses API.

   It is gone, and the reasons are worth keeping.

   It could not be metered. The whole point of a bring-your-own key is that
   OpenAI bills the user, so `maxStop()` opened every model to anyone who
   pasted one — a free account with the top model, permanently, one field
   away. Against a product whose plans ARE the model ceiling, that is not a
   power-user affordance, it is the pricing page with an opt-out.

   It was also a second implementation of the checking pipeline, hand-mirrored
   from lib/factcheck.js, and every prompt or schema change had to be made
   twice or the two engines quietly disagreed about the same sentence.

   And it read badly. The options page led with a key field and the words "no
   sign-in, no plan, every model unlocked" directly above the Sign in button,
   so the first thing a new user saw was the case against making an account.

   What it cost us to remove: nothing that worked offline still does. There is
   no local fallback now — if neither server answers, checks stop, and the
   status line says so rather than recommending a purchase.

/* ── messaging ───────────────────────────────────────────────────────────── */

/* The order page, with the signed-in account id as `uid`, which the page
   forwards to Stripe as client_reference_id — the first and only reliable
   rung of the webhook's account mapping (email matching is wrong exactly when
   a student pays with a parent's card). Mirrors options.js orderUrl. Built
   HERE for the widgets' PRO link (tracely-open-order) so the id never enters
   a host page's DOM. */
const ORDER_URL = "https://jointracely.com/order";
function orderUrl(userId) {
  if (!userId) return ORDER_URL; // signed out: Stripe falls back to email
  return `${ORDER_URL}?uid=${encodeURIComponent(userId)}`;
}

/* Whether a message came from one of this extension's OWN pages (the options
   page) rather than a content script. A content script runs inside somebody
   else's page and draws into an OPEN shadow root on it, so anything it is
   handed can end up readable by that page's scripts — which is why the
   account id never goes to one (see tracely-entitlement). */
function fromExtensionPage(sender) {
  const base = chrome.runtime.getURL("");
  return typeof sender?.url === "string" && sender.url.startsWith(base);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "tracely-getState") {
    (async () => {
      const up = await serverReachable();
      sendResponse({ ok: true, server: Boolean(up), mode: up ? "server" : "offline" });
    })();
    return true; // async sendResponse
  }

  /* What the options page and the widgets ask to learn the account state.

     One flag says "there is no plan to apply here": `unenforced`, meaning the
     server reported `enforced: false` — it has no Supabase project configured
     and clamps nothing. Locking the picker there would show an upgrade prompt
     for a server that will serve the top model on request. That is the mode a
     plain `node server.js` with the stock .env runs in.

     There was a second, `byoKey`, which opened every stop for anyone who had
     pasted their own OpenAI key. It went with the standalone engine above.

     It defaults to false on any non-answer, so an unreachable worker or a
     server too old to send the field leaves the picker on the free tier. */
  if (msg?.type === "tracely-entitlement") {
    (async () => {
      try {
        const [{ authToken }, ent, up] = await Promise.all([getAuth(), fetchEntitlement({ force: msg.force === true }), serverReachable()]);
        sendResponse({
          ok: true,
          configured: authConfigured(),
          signedIn: Boolean(authToken),
          plan: normalizePlan(ent?.plan),
          email: ent?.email ?? null,
          // Carried so the options page's upgrade link can attach
          // client_reference_id — the only thing that lets the Stripe webhook
          // map a payment to THIS account rather than guessing from the
          // payer's email. Extension pages only: a content script would put it
          // in a link inside an open shadow root on every site, where any
          // page's scripts could read a stable cross-site account id.
          userId: fromExtensionPage(sender) ? ent?.userId ?? null : null,
          unenforced: Boolean(up) && ent?.enforced === false,
          // The server granted this test build's Pro plan (X-Tracely-Beta).
          // The options page shows "Pro (beta)" and hides the ways to buy.
          beta: ent?.beta === true,
          // The metering the server reported for this caller (entitlementExtras).
          // Absent from an older or local server's answer, and from a guess.
          limits: ent?.limits ?? null,
          usage: ent?.usage ?? null,
          thorough: ent?.thorough ?? null,
          fairUse: ent?.fairUse ?? null,
          // No real answer behind this (server unreachable or erroring, never
          // cached): show it, but do not SAVE anything because of it — a
          // widget or the options page writing a clamp to the free stop here
          // would outlive the outage.
          provisional: !(Number(ent?.fetchedAt) > 0),
        });
      } catch (err) {
        // Fail closed, but still answer: an unanswered probe would leave the
        // widget with no tier at all.
        sendResponse({ ok: true, configured: authConfigured(), signedIn: false, plan: DEFAULT_PLAN, email: null, userId: null, unenforced: false, beta: false, limits: null, usage: null, thorough: null, fairUse: null, provisional: true, message: err?.message });
      }
    })();
    return true; // async sendResponse
  }

  /* The widgets' PRO link. The widget lives in an open shadow root on the
     host page, so it never holds the account id; it asks here, and the order
     page opens in a new tab with the id attached. Answers ok:false on any
     failure so the widget can fall back to the plain link. chrome.tabs.create
     needs no permission. */
  if (msg?.type === "tracely-open-order") {
    (async () => {
      try {
        const ent = await fetchEntitlement();
        await chrome.tabs.create({ url: orderUrl(ent?.userId) });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, message: err?.message });
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
          // Server died between probe and call. Remember it so the next call
          // re-probes rather than retrying a host we just watched fail.
          serverUp = false;
          lastProbeAt = Date.now();
        }
      }
      sendResponse({
        ok: false,
        offline: true,
        kind: "no_engine",
        message: "Tracely is offline — the server did not answer. Checks will run again when it is back.",
      });
    } catch (err) {
      sendResponse({ ok: false, kind: err?.kind ?? "server", message: err?.message ?? String(err) });
    }
  })();
  return true; // async sendResponse
});
