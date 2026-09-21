import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFactCheck, findSources, runFlowCheck, hasApiKey, CheckError } from "./lib/factcheck.js";
import * as ai from "./lib/ai.js";
import * as reasoning from "./lib/reasoning.js";
import * as evidence from "./lib/evidence.js";
import * as store from "./lib/store.js";
import * as watch from "./lib/watch.js";
import { db, uuid, cacheGet, cacheSet, hashKey, upsertSource,
         billingEventSeen, billingEventRecord, billingCustomerLink, billingCustomerLookup } from "./lib/db.js";
import { planForRequest, sourceSearchQuota, recordSourceSearch, checkQuota, recordCheck, aiQuota, recordAi,
         callerId, entitlementConfigured, forgetCachedPlans } from "./lib/entitlement.js";
import { spendState, recordSpend, spendSummary } from "./lib/spend.js";
import { verifyStripeSignature, planChangeForEvent, writePlanToSupabase, findUserIdByEmail, webhookConfigured } from "./lib/billing.js";
import { clampModel, FREE_DAILY_AI_CALLS } from "./shared/plan.js";
import { MODEL_TIERS, ALLOWED_MODELS } from "./lib/llm.js";
import { GUARDS, SPEND, rollingCounter, keyedRateLimiter } from "./shared/guards.js";
import { problemsFor, markFor } from "./shared/marks.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 4477;
const MOCK = process.env.TRACELY_MOCK === "1";

const STATIC_FILES = {
  "/": { file: "public/index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "public/index.html", type: "text/html; charset=utf-8" },
  "/classic": { file: "public/index.html", type: "text/html; charset=utf-8" },
  "/classic/": { file: "public/index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "public/style.css", type: "text/css; charset=utf-8" },
  "/harness.html": { file: "public/harness.html", type: "text/html; charset=utf-8" },
  "/ext-content.js": { file: "extension/content.js", type: "text/javascript; charset=utf-8" },
};

// ── the built Electron renderer (ui/dist-web) is THE app when present ──
// Their build lands at ui/dist-web (index.html, floating.html, overlay.html,
// assets/*). When index.html exists there, / serves it; until the first build
// exists, / falls back to public/index.html so nothing breaks. The vanilla
// app stays reachable at /classic/ either way (its /app/* and /shared/*
// absolute paths are untouched below).
// Two layouts: standalone (~/tracely with the renderer vendored at ui/) and
// in-repo (server/ inside the Tracely repo, renderer built at ../dist-web).
import { existsSync as _existsSync } from "node:fs";
const UI_DIST = ["ui/dist-web", "../dist-web"].find((p) => _existsSync(path.join(ROOT, p, "index.html"))) ?? "ui/dist-web";
const UI_PAGES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/floating.html": "floating.html",
  "/overlay.html": "overlay.html",
};
function resolveUiPage(pathname) {
  const name = UI_PAGES[pathname];
  if (!name) return null;
  const file = path.join(UI_DIST, name);
  if (!existsSync(path.join(ROOT, file))) return null; // pre-build fallback
  return { file, type: "text/html; charset=utf-8" };
}

// Directory-based static serving for the app modules and shared decision code,
// plus the built renderer's hashed assets. Same traversal guard for all of
// them: flat directories, [A-Za-z0-9._-] filenames only (Vite's hashed names
// fit), and only extensions we have a content type for.
const STATIC_DIRS = { "/app/": "public/app", "/shared/": "shared", "/assets/": path.join(UI_DIST, "assets") };
const STATIC_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};
function resolveStatic(pathname) {
  for (const [prefix, dir] of Object.entries(STATIC_DIRS)) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = pathname.slice(prefix.length);
    if (!/^[A-Za-z0-9._-]+$/.test(rel)) return null; // flat dir, no traversal
    const type = STATIC_TYPES[path.extname(rel)];
    if (!type) return null;
    return { file: path.join(dir, rel), type };
  }
  return null;
}

// .env values may be corrected while the server runs; values we loaded from
// .env may be overwritten by .env again, but real shell-exported vars win.
const envFileKeys = new Set();
function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const seen = new Set();
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    const value = raw.replace(/^["']|["']$/g, "");
    if (!value) continue;
    seen.add(key);
    if (!process.env[key] || envFileKeys.has(key)) {
      process.env[key] = value;
      envFileKeys.add(key);
    }
  }
  for (const key of [...envFileKeys]) {
    if (!seen.has(key)) {
      delete process.env[key];
      envFileKeys.delete(key);
    }
  }
}
loadEnvFile();

// ── request gatekeeping ────────────────────────────────────────────────
// This server fronts the user's OpenAI API key, so hostile web pages must
// not be able to drive it: origins are allowlisted (docs.google.com for the
// extension widget, plus our own pages), the Host header is pinned to kill
// DNS-rebinding, and we listen on loopback only.
const SELF_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const PINNED_EXTENSION = process.env.TRACELY_EXTENSION_ID
  ? `chrome-extension://${process.env.TRACELY_EXTENSION_ID}`
  : null;

function originAllowed(origin) {
  if (!origin) return true; // curl / non-browser clients; Host check still applies
  if (SELF_ORIGINS.has(origin) || origin === "https://docs.google.com") return true;
  if (PINNED_EXTENSION) return origin === PINNED_EXTENSION;
  return origin.startsWith("chrome-extension://");
}

// The extension surface (docs.google.com widget + chrome-extension pages) only
// needs the legacy check endpoints. Every other /api route — storage CRUD and
// the paid pipeline — is app-private: same-origin (or origin-less curl) only,
// so a hostile Docs add-on or stray extension can't read essays, wipe history,
// or burn the user's OpenAI credits.
// /api/billing/webhook is deliberately NOT here: Stripe calls it server-to-
// server with no Origin, and listing it would also hand it to every page the
// extension surface can reach.
const EXTENSION_API = new Set(["/api/status", "/api/check", "/api/flow", "/api/sources", "/api/cite-url", "/api/docs/apply", "/api/entitlement"]);

/* Every route that can reach a model, and therefore spend money.
 *
 * Gated CENTRALLY rather than route by route, because the ten routes outside
 * EXTENSION_API were entirely unmetered and nobody noticed: routeAllowedForOrigin
 * only blocks cross-ORIGIN callers, and a curl request sends no Origin header
 * at all, so "app-private" meant private from browsers and open to everyone
 * else. A central set also means the fifteenth route is covered by existing
 * code rather than by whoever adds it remembering to.
 *
 * `sources` is called out separately because OpenAI bills web_search per call
 * on top of tokens — about 16x a check — so it has its own rate limit and is
 * shed first when the daily budget runs low.
 */
const PAID_ROUTES = new Set([
  "/api/check", "/api/flow", "/api/sources", "/api/evidence", "/api/compare-source",
  "/api/watch/critique", "/api/watch/fix", "/api/cite-url",
]);

/* The desktop app's AI routes. They are gated by appGate, NOT spendGate, and
 * that separation is the point.
 *
 * They used to sit in PAID_ROUTES, which meant they shared the extension's
 * per-caller rate limiter and its daily spend pool — while never recording
 * any spend of their own. Two failures, pointing opposite ways: unmetered,
 * the $10/day ceiling could not see them at all; metered into the shared
 * pool, one busy desktop user on the thorough model could empty the day and
 * 503 every extension user's /api/check. They now have their own pool, their
 * own limiter, their own daily quota kind, and their own model choice — so the
 * desktop can exhaust only the desktop. None of them is extension-reachable
 * (they are not in EXTENSION_API), which is what makes changing them safe. */
const APP_AI_ROUTES = new Set([
  "/api/detect-claims", "/api/critique", "/api/grade", "/api/structure", "/api/tracer",
  "/api/correction", "/api/find-sources",
]);

// The desktop's source searches: their own rolling window, per caller. The
// extension's /api/sources has a process-wide 15/hour counter; sharing it
// would let desktop traffic 429 every extension user's source search.
const appSearchRate = keyedRateLimiter(SPEND.appCallerSearchesPerHour, 3_600_000);
const SOURCE_ROUTES = new Set(["/api/sources", "/api/compare-source"]);
function routeAllowedForOrigin(origin, pathname) {
  if (!origin || SELF_ORIGINS.has(origin)) return true;
  if (!pathname.startsWith("/api/")) return true; // static files are harmless
  return EXTENSION_API.has(pathname);
}

function hostAllowed(host) {
  return host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}` || host === `[::1]:${PORT}`;
}

function corsHeaders(req) {
  const origin = req.headers.origin ?? "";
  if (originAllowed(origin) && origin && !SELF_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      // Authorization is not a CORS-safelisted request header: without it here
      // the preflight fails and the extension's signed-in calls never leave
      // the browser — silently, as a network error rather than a 401.
      // X-Tracely-Install must be listed or the browser blocks the preflight
      // and the header never arrives — which would silently collapse every
      // extension user onto the address rung, where the server deliberately
      // refuses to apply a daily quota. Exactly the failure shape as /api/flow
      // missing from background.js's API_PATHS: works, does nothing, says
      // nothing. test/spend.test.js pins this list against the header.
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tracely-Install",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    };
  }
  return {};
}

function json(res, status, body, extraHeaders = {}) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new CheckError("bad_request", "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseJsonBody(req) {
  if (!/^application\/json/i.test(req.headers["content-type"] ?? "")) {
    throw new CheckError("bad_request", "Content-Type must be application/json", { status: 415 });
  }
  try {
    return JSON.parse(await readBody(req));
  } catch (e) {
    if (e instanceof CheckError) throw e;
    throw new CheckError("bad_request", "Invalid JSON body");
  }
}

// ── Google Docs bridge (Apps Script web app the user deployed once) ────
// The one place verdicts map to in-doc highlight colors, so every surface agrees.
const HIGHLIGHT_COLORS = {
  false: "#F5C6C2",        // red tint — a fact the check believes is wrong
  questionable: "#FCE8B2", // amber tint — attribution / unverifiable
  incoherent: "#FBD8BE",   // orange tint — doesn't carry / doesn't make sense
};
const BRIDGE_ACTIONS = new Set(["ping", "highlight", "clearHighlights", "replace", "appendLine"]);

function bridgeConfigured() {
  return Boolean(process.env.GOOGLE_DOCS_BRIDGE_URL && process.env.TRACELY_BRIDGE_TOKEN);
}

async function applyToDoc(body) {
  const { docId, action, sentence, verdict, find, replacement, line } = body;
  if (typeof docId !== "string" || !/^[A-Za-z0-9_-]{10,100}$/.test(docId)) {
    throw new CheckError("bad_request", "docId missing or malformed");
  }
  if (!BRIDGE_ACTIONS.has(action)) {
    throw new CheckError("bad_request", "unknown docs action");
  }
  const payload = { token: process.env.TRACELY_BRIDGE_TOKEN, docId, action };
  if (action === "highlight") {
    if (typeof sentence !== "string" || !sentence.trim() || sentence.length > 4000) {
      throw new CheckError("bad_request", "highlight needs a sentence (max 4000 chars)");
    }
    payload.sentence = sentence;
    payload.color = HIGHLIGHT_COLORS[verdict] ?? HIGHLIGHT_COLORS.questionable;
  } else if (action === "replace") {
    if (typeof find !== "string" || !find.trim() || find.length > 4000 || typeof replacement !== "string" || replacement.length > 4000) {
      throw new CheckError("bad_request", "replace needs find + replacement (max 4000 chars)");
    }
    payload.find = find;
    payload.replacement = replacement;
  } else if (action === "appendLine") {
    if (typeof line !== "string" || !line.trim() || line.length > 1200) {
      throw new CheckError("bad_request", "appendLine needs a line (max 1200 chars)");
    }
    payload.line = line;
  }

  let res;
  try {
    res = await fetch(process.env.GOOGLE_DOCS_BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
      redirect: "follow", // Apps Script answers via a 302 to googleusercontent
    });
  } catch (e) {
    throw new CheckError("server", `Could not reach the Docs bridge: ${e?.message ?? e}`, { status: 502 });
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new CheckError("server", "Docs bridge returned a non-JSON response — check the deployment is a Web App with access set to Anyone", { status: 502 });
  }
  if (!data.ok) {
    throw new CheckError("server", `Docs bridge error: ${data.error ?? "unknown"}`, { status: 502 });
  }
  return data;
}

// ── "Paste a URL and cite it" — free metadata fetch, no AI involved ────
const PRIVATE_HOST = /^(localhost$|.*\.local$|127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\]$|172\.(1[6-9]|2\d|3[01])\.)/i;

function metaLookup(html, attr, name) {
  const tags = html.match(/<meta\s[^>]*>/gi) ?? [];
  for (const t of tags) {
    if (new RegExp(`${attr}\\s*=\\s*["']${name}["']`, "i").test(t)) {
      const c = t.match(/content\s*=\s*["']([^"']*)["']/i);
      if (c?.[1]) return decodeEntities(c[1]);
    }
  }
  return "";
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

async function fetchUrlMetadata(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new CheckError("bad_request", "That doesn't look like a URL");
  }
  if (!/^https?:$/.test(u.protocol)) throw new CheckError("bad_request", "Only http(s) URLs can be cited");
  if (PRIVATE_HOST.test(u.hostname)) throw new CheckError("bad_request", "Local and private addresses can't be cited");

  let res;
  try {
    res = await fetch(u, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Tracely/1.0; local fact-checker)" },
    });
  } catch (e) {
    throw new CheckError("server", `Couldn't fetch that URL: ${e?.cause?.message ?? e?.message ?? e}`, { status: 502 });
  }
  // Per the reference: 404/410 mean the page doesn't exist; auth walls and rate limits do not.
  if (res.status === 404 || res.status === 410) {
    throw new CheckError("bad_request", `That page returns ${res.status} — it doesn't seem to exist`);
  }
  let html = "";
  try {
    html = (await res.text()).slice(0, 500_000);
  } catch { /* binary or unreadable body — fall through to URL-derived metadata */ }

  const title =
    metaLookup(html, "property", "og:title") ||
    decodeEntities(html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "") ||
    u.href;
  const publisher = metaLookup(html, "property", "og:site_name") || u.hostname.replace(/^www\./, "");
  const snippet = metaLookup(html, "name", "description") || metaLookup(html, "property", "og:description");

  return {
    title: title.trim().slice(0, 200),
    url: u.href.slice(0, 600),
    publisher: publisher.trim().slice(0, 100),
    snippet: snippet.trim().slice(0, 300),
    stance: "manual",
  };
}

// Rolling-window backstops (spec §14): the caps that hold when "one analysis"
// stops being a meaningful unit. Stamped BEFORE each call.
// A teacher's rubric is a page, not a book. Enough for any real one.
const MAX_CUSTOM_RUBRIC_CHARS = 6000;
const webSearchCounter = rollingCounter(GUARDS.maxWebSearchesPerHour);
const critiqueCounter = rollingCounter(60);

// ── model tiering (token optimization) ─────────────────────────────────
// Decided here, once, so every surface prices identically.
//   economy (default): the FAST tier for everything — a full essay session
//     lands in single-digit cents. This is the hard cost mandate.
//   smart: the fast tier for the frequent mechanical passes, the BALANCED tier
//     for the two judgment calls (critique, grading).
//   uniform: the user's chosen model everywhere (they pay for what they pick).
// Read from the tier table rather than written out, so a model rename is one
// edit in lib/llm.js instead of a hunt through every file that names one.
const H = MODEL_TIERS.fast;
const S = MODEL_TIERS.balanced;
const TIERS = {
  economy: { detect: H, structure: H, tracer: H, critique: H, grade: H, sources: H, check: H },
  smart:   { detect: H, structure: H, tracer: H, critique: S, grade: S, sources: H, check: S },
};
function pickModel(task) {
  const p = store.prefs.get();
  const strat = p.modelStrategy ?? "economy";
  if (strat === "uniform") return p.model;
  return (TIERS[strat] ?? TIERS.economy)[task] ?? p.model;
}

// The watch loop reuses the exact same tiering — detection is always priced
// like every other surface's detection.
watch.init({ pickModel });

// ── entitlement ────────────────────────────────────────────────────────
// Tiering above decides what this server WANTS to spend; the plan decides
// what the caller is allowed to. The clamp is applied last, so a request can
// only ever move a model down.
//
// `ent.enforced` is false when no Supabase project is configured, and then
// nothing is clamped at all — not "clamped to free". A local run with an
// empty .env must reach the same model it reached before entitlement existed.
function allowedModel(ent, requested) {
  return ent.enforced ? clampModel(requested, ent.plan) : requested;
}

/**
 * POST /api/billing/webhook.
 *
 * The raw body is read as a string and verified BEFORE anything parses it —
 * see lib/billing.js for why a re-serialized body can never match. Stripe
 * retries until it gets a 2xx, so the recorded event id is the replay guard:
 * a duplicate delivery is a 200 that did nothing.
 */
async function handleStripeWebhook(req, res) {
  loadEnvFile(); // the secret may have been pasted in while the server ran
  if (!webhookConfigured()) {
    json(res, 503, { error: { kind: "no_billing", message: "Billing is not configured — see BILLING.md" } });
    return;
  }

  const raw = await readBody(req);
  const verdict = verifyStripeSignature(raw, req.headers["stripe-signature"] ?? "", process.env.STRIPE_WEBHOOK_SECRET);
  if (!verdict.ok) {
    console.error(`[tracely] rejected Stripe webhook (${verdict.reason})`);
    json(res, 400, { error: { kind: "bad_signature", message: "Signature verification failed" } });
    return;
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    json(res, 400, { error: { kind: "bad_request", message: "Invalid JSON body" } });
    return;
  }
  if (!event?.id) {
    json(res, 400, { error: { kind: "bad_request", message: "Event has no id" } });
    return;
  }
  // Replay: answer 200 so Stripe stops retrying something already applied.
  if (billingEventSeen(event.id)) {
    json(res, 200, { received: true, duplicate: true });
    return;
  }

  const change = planChangeForEvent(event);
  if (!change) {
    billingEventRecord({ id: event.id, type: event.type, outcome: "ignored", payload: event });
    json(res, 200, { received: true, ignored: true });
    return;
  }

  // Learn the customer → user mapping first: later subscription events carry a
  // customer and no user id, and this is where that link is available.
  billingCustomerLink(change);

  let userId = change.userId ?? billingCustomerLookup(change.customerId)?.user_id ?? null;
  if (!userId && change.email) userId = await findUserIdByEmail(change.email);

  let outcome = "recorded";
  if (change.plan == null) outcome = "no_plan"; // an unrecognised price is not a downgrade
  else if (!userId) outcome = "no_user";
  else {
    const written = await writePlanToSupabase(userId, change.plan);
    outcome = written.ok ? "applied" : `failed:${written.reason}`;
    if (written.ok) {
      billingCustomerLink({ ...change, userId });
      forgetCachedPlans(); // an upgrade must not wait out the 60s plan cache
    }
  }

  // Record only after the write is decided, so the replay guard never marks an
  // event done that never landed — anything unapplied stays retryable.
  //
  // `no_user` is retryable and NOT recorded, which is the whole reason it is
  // grouped with a failed write. Stripe does not guarantee event ordering, and
  // customer.subscription.created/updated routinely arrives BEFORE the
  // checkout.session.completed that carries the Supabase user id — so the
  // event that actually says "this account is Pro" can land while
  // billing_customers still knows nothing about the customer. Recording it
  // would 200 the only event that mattered and Stripe would never send it
  // again: the customer pays and is never upgraded, with `no_user` sitting in
  // the ledger as the only trace. A 500 buys Stripe's retry schedule (~3 days
  // of backoff), by which time the checkout event has landed and the lookup
  // resolves. `no_plan` is different and IS recorded: it is a settled answer,
  // not a missing prerequisite.
  if (outcome.startsWith("failed:") || outcome === "no_user") {
    console.error(`[tracely] Stripe event ${event.id} (${event.type}) not applied: ${outcome} — asking Stripe to retry`);
    json(res, 500, { error: { kind: "billing_retry", message: "Could not apply the plan change yet" } });
    return;
  }
  billingEventRecord({ id: event.id, type: event.type, userId, customerId: change.customerId, plan: change.plan, outcome, payload: event });
  json(res, 200, { received: true, outcome });
}

/* ── the spend gate ─────────────────────────────────────────────────────
   One function in front of every route that can reach a model — all fourteen,
   not just the four the extension uses. The other ten were entirely unmetered,
   and a route nobody calls is still a route anybody can call.

   Three layers, because no single one survives both failure modes:

   1. GLOBAL DAILY BUDGET (lib/spend.js) — the only thing that bounds a
      determined attacker, because it does not depend on identity at all. When
      it runs low, sources are shed before checks: a source search costs ~16x
      a check, so dropping it buys 16x the runway.
   2. PER-CALLER DAILY QUOTA — bounds accidents and casual overuse, which is
      most of the real risk. Keyed on a signed-in id or a client-supplied
      install id; an address alone cannot carry a daily quota without locking
      out a whole school, so it does not get one.
   3. PER-CALLER RATE LIMIT — smooths bursts, in memory, keyed on the caller
      (including the address rung, which is safe for a per-minute window even
      when it is not safe for a day).

   Stamped BEFORE the call on the counters that gate admission, and the actual
   COST is recorded after, because cost is not knowable until the usage comes
   back. The budget can therefore overshoot by the calls in flight when it
   trips — bounded by layer 3 and, at fast-model prices, a fraction of a cent.

   `enforced: false` (no Supabase configured) disables all three. A plain
   `node server.js` with an empty .env behaves exactly as it did before any of
   this existed, which is how the local-first install runs. */
const checkRate = keyedRateLimiter(SPEND.callerChecksPerMinute);
const sourceRate = keyedRateLimiter(SPEND.callerSourcesPerMinute);
// The app routes' own limiter — see APP_AI_ROUTES for why it is not checkRate.
const appRate = keyedRateLimiter(SPEND.appCallerCallsPerMinute);

async function spendGate(req, { kind = "check" } = {}) {
  const ent = await planForRequest(req);
  const id = callerId(req, ent);
  const budget = spendState({ enforced: ent.enforced });

  if (!budget.allowed) {
    // Deliberately not "try again later" — it resets at midnight, and a
    // string that implies minutes when it means hours is a lie users notice.
    throw new CheckError("budget", "Tracely has hit its daily usage limit. It resets at midnight.", { status: 503 });
  }
  if (kind === "sources" && !budget.sourcesAllowed) {
    throw new CheckError("budget", "Source search is paused for today to keep fact-checking available. Checking still works.", { status: 503 });
  }

  if (ent.enforced && id) {
    const rate = kind === "sources" ? sourceRate : checkRate;
    if (!rate.ok(id)) {
      throw new CheckError("rate_limit", "Slow down a moment — too many requests in the last minute.", { status: 429, retryAfter: 60 });
    }
    rate.stamp(id);
  }

  return { ent, callerId: id, budget };
}

/* The app routes' gate: the same shape as spendGate, over the APP pool and
 * the app limiter. Budget first, then velocity, both before the body is read. */
async function appGate(req) {
  const ent = await planForRequest(req);
  const id = callerId(req, ent);
  const budget = spendState({ enforced: ent.enforced, pool: "app" });
  if (!budget.allowed) {
    throw new CheckError("budget", "Tracely's writing checks have hit their daily usage limit. They reset at midnight.", { status: 503 });
  }
  if (ent.enforced && id) {
    if (!appRate.ok(id)) {
      throw new CheckError("rate_limit", "Slow down a moment — too many requests in the last minute.", { status: 429, retryAfter: 60 });
    }
    appRate.stamp(id);
  }
  return { ent, callerId: id, budget };
}

/**
 * Which model an app-route call runs at.
 *
 * On a hosted server (enforced) it is what the CLIENT asked for, clamped to
 * the caller's plan: the desktop resolves the user's chosen tier against their
 * plan and sends that model, so a Pro user who picked "fast" gets fast, and
 * nobody gets above their ceiling. An unrecognised request resolves DOWN to
 * the fast model, never up (clampModel's rule).
 *
 * It deliberately does NOT read pickModel on a hosted server. pickModel reads
 * ONE global prefs row, which `PUT /api/prefs` lets any caller rewrite with no
 * authentication — and before this, an anonymous caller could set
 * {modelStrategy:"uniform", model:"gpt-6-astra"} and every app route, for
 * everyone, ran the thorough model. Locally (not enforced) there is one user
 * and that row is theirs, so local runs keep pickModel exactly as before.
 *
 * The extension's routes still use pickModel + allowedModel, unchanged.
 */
function appModelFor(task, ent, requested) {
  if (!ent.enforced) return pickModel(task);
  return clampModel(ALLOWED_MODELS.has(requested) ? requested : MODEL_TIERS.fast, ent.plan);
}

/**
 * One app-route model call: the cache, the daily quota, the call, the spend.
 *
 * A cache hit is free and is NOT counted against the quota — only calls that
 * reach a model are. The quota is stamped before the call (like every counter
 * here), and the spend is recorded after it, into the app pool.
 *
 * `cache` is { kind, key(model), maxAgeMs, version } or null; the key is built
 * from the RESOLVED model so a Free answer is never served to a Pro request.
 */
const AI_QUOTA = {
  check: aiQuota,
  record: recordAi,
  refused: () => new CheckError(
    "plan_limit",
    `Free accounts get ${FREE_DAILY_AI_CALLS} AI checks a day, and today's ${FREE_DAILY_AI_CALLS} are used. It resets at midnight — or upgrade for unlimited checks.`,
    { status: 429 },
  ),
};
// find-sources draws on the SAME daily source allowance as the extension's
// /api/sources: one plan, one allowance, whichever surface spends it.
const SOURCE_QUOTA = {
  check: sourceSearchQuota,
  record: recordSourceSearch,
  refused: (q) => new CheckError(
    "plan_limit",
    `Free accounts get ${q.limit} source searches a day, and today's ${q.limit} are used. It resets at midnight — or upgrade for unlimited searches.`,
    { status: 429 },
  ),
};

async function appCall(gate, { task, requested, cache = null, webSearchCalls = 0, quota: meter = AI_QUOTA, run }) {
  const model = appModelFor(task, gate.ent, requested);
  const key = cache ? cache.key(model) : null;
  if (cache && !MOCK) {
    const hit = cacheGet(cache.kind, key, { maxAgeMs: cache.maxAgeMs, version: cache.version ?? 1 });
    if (hit) return hit;
  }
  const quota = meter.check(gate.ent, gate.callerId);
  if (!quota.allowed) throw meter.refused(quota);
  meter.record(gate.ent, gate.callerId);
  const result = await run(model);
  recordSpend({ model: result?.model ?? model, usage: result?.usage, webSearchCalls, enforced: gate.ent.enforced, pool: "app" });
  if (cache && !MOCK) cacheSet(cache.kind, key, result, { version: cache.version ?? 1 });
  return result;
}

function requireKey() {
  if (!hasApiKey() && !MOCK) {
    throw new CheckError("no_key", "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env", { status: 503 });
  }
}

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders(req);

  try {
    let url;
    try {
      url = new URL(req.url, `http://localhost:${PORT}`);
    } catch {
      json(res, 400, { error: { kind: "bad_request", message: "Malformed request URL" } }, cors);
      return;
    }

    if (!hostAllowed(req.headers.host ?? "")) {
      json(res, 403, { error: { kind: "forbidden", message: "Bad Host header" } });
      return;
    }
    if (!originAllowed(req.headers.origin)) {
      json(res, 403, { error: { kind: "forbidden", message: "Origin not allowed" } });
      return;
    }
    if (!routeAllowedForOrigin(req.headers.origin, url.pathname)) {
      // No ACAO header on purpose — the browser must not see this response.
      json(res, 403, { error: { kind: "forbidden", message: "Origin not allowed for this endpoint" } });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // One gate in front of everything that can spend. Routes below reuse
    // `gate.ent` instead of resolving the plan again — planForRequest caches
    // for 60s, so a second call would be cheap, but one resolution per request
    // is one answer per request.
    let gate = null;
    if (APP_AI_ROUTES.has(url.pathname)) {
      gate = await appGate(req);
    } else if (PAID_ROUTES.has(url.pathname)) {
      gate = await spendGate(req, { kind: SOURCE_ROUTES.has(url.pathname) ? "sources" : "check" });
    }

    const staticHit = (req.method === "GET" && (resolveUiPage(url.pathname) ?? STATIC_FILES[url.pathname] ?? resolveStatic(url.pathname))) || null;
    if (staticHit) {
      const { file, type } = staticHit;
      let data;
      try {
        data = readFileSync(path.join(ROOT, file));
      } catch {
        json(res, 404, { error: { kind: "not_found", message: `${file} is missing on disk` } }, cors);
        return;
      }
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(data);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      loadEnvFile(); // hot-pickup: user just added or corrected the key in .env
      // `budget` is here so the operator can see the day's spend BEFORE it
      // trips, rather than learning about it from a user's 503. It reports
      // percentages and dollars, never a caller's identity.
      json(res, 200, {
        hasKey: hasApiKey() || MOCK, mock: MOCK, docsBridge: bridgeConfigured(),
        budget: spendSummary({ enforced: entitlementConfigured() }),
      }, cors);
      return;
    }

    // Who is signed in, and what they get. Never an error: an anonymous user
    // is a free user, and the extension must keep working while signed out.
    //
    // `enforced` is the honest half. When no Supabase project is configured
    // this server clamps NOTHING (see allowedModel), so a client that locked
    // its model picker to the free tier and showed an upgrade prompt would be
    // lying about a server that will happily serve the top model. Reporting it lets the
    // extension open every stop in exactly the mode the README calls "set none
    // of these env vars and nothing changes".
    if (req.method === "GET" && url.pathname === "/api/entitlement") {
      loadEnvFile();
      const ent = await planForRequest(req);
      // `userId` rides along so the client can attach it to a Stripe checkout
      // as client_reference_id. Without it the webhook can only map a payment
      // to an account by EMAIL, which is wrong exactly when it matters most:
      // a student paying with a parent's card. Not a disclosure — the caller
      // presented that user's own token, and the id is inside it.
      json(res, 200, { plan: ent.plan, email: ent.email, userId: ent.userId, enforced: ent.enforced, checkedAt: Date.now() }, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/billing/webhook") {
      await handleStripeWebhook(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/docs/apply") {
      loadEnvFile();
      if (!bridgeConfigured()) {
        json(res, 503, { error: { kind: "no_bridge", message: "Docs bridge not set up — see README: paste docs-bridge/Code.gs into script.google.com, deploy, and put the URL in .env" } }, cors);
        return;
      }
      const body = (await parseJsonBody(req)) ?? {};
      const result = await applyToDoc(body);
      json(res, 200, result, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/check") {
      loadEnvFile();
      if (!hasApiKey() && !MOCK) {
        json(res, 503, { error: { kind: "no_key", message: "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env" } }, cors);
        return;
      }

      const { text, sentences, model, effort } = (await parseJsonBody(req)) ?? {};
      if (typeof text !== "string" || text.length > 30_000) {
        throw new CheckError("bad_request", "text must be a string of at most 30,000 characters");
      }
      if (!Array.isArray(sentences) || sentences.length === 0 || sentences.length > 40) {
        throw new CheckError("bad_request", "sentences must be a non-empty array of at most 40 items");
      }
      for (const s of sentences) {
        if (!s || typeof s.id !== "string" || typeof s.text !== "string" || s.text.length > 2000 || s.id.length > 40) {
          throw new CheckError("bad_request", "each sentence needs an id and text (max 2000 chars)");
        }
      }

      const started = Date.now();
      // Tiering owns the model — the widget's dropdown only applies in
      // "uniform" strategy (cost mandate: economy = the cheap tier everywhere)
      // — and the plan owns the ceiling above that.
      const { ent, callerId: who } = gate;
      const quota = checkQuota(ent, who);
      if (!quota.allowed) {
        throw new CheckError(
          "plan_limit",
          `Free accounts get ${quota.limit} checks a day, and today's are used. It resets at midnight — or upgrade for unlimited checking.`,
          { status: 429 },
        );
      }
      recordCheck(ent, who); // before the call, not after
      const modelUsed = allowedModel(ent, pickModel("check"));
      const result = await runFactCheck({ text, sentences, model: modelUsed, effort, mock: MOCK });
      recordSpend({ model: result.model ?? modelUsed, usage: result.usage, enforced: ent.enforced });
      json(res, 200, { ...result, modelUsed, plan: ent.plan, ms: Date.now() - started }, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sources") {
      loadEnvFile();
      if (!hasApiKey() && !MOCK) {
        json(res, 503, { error: { kind: "no_key", message: "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env" } }, cors);
        return;
      }

      const { claim, correction, context, model } = (await parseJsonBody(req)) ?? {};
      if (typeof claim !== "string" || !claim.trim() || claim.length > 2000) {
        throw new CheckError("bad_request", "claim must be a non-empty string of at most 2000 characters");
      }
      if (correction != null && (typeof correction !== "string" || correction.length > 2000)) {
        throw new CheckError("bad_request", "correction must be a string of at most 2000 characters");
      }
      if (context != null && (typeof context !== "string" || context.length > 6000)) {
        throw new CheckError("bad_request", "context must be a string of at most 6000 characters");
      }

      if (!webSearchCounter.ok()) {
        throw new CheckError("rate_limit", "Web-search hourly cap reached — try again later.", { status: 429, retryAfter: 600 });
      }

      // The free tier's daily quota, on top of the cost guard above and the
      // global budget in spendGate. Keyed on callerId rather than ent.userId,
      // which is what used to leave every anonymous caller unmetered — and
      // anonymous is the DEFAULT, since the extension needs no sign-in.
      const { ent, callerId: who } = gate;
      const quota = sourceSearchQuota(ent, who);
      if (!quota.allowed) {
        throw new CheckError(
          "plan_limit",
          `Free accounts get ${quota.limit} source searches a day, and today's ${quota.limit} are used. It resets at midnight — or upgrade for unlimited searches.`,
          { status: 429 },
        );
      }
      recordSourceSearch(ent, who); // before the call, not after

      webSearchCounter.stamp(); // before the call, not after
      const started = Date.now();
      const modelUsed = allowedModel(ent, pickModel("sources"));
      const result = await findSources({ claim, correction, context, model: modelUsed, mock: MOCK });
      // webSearchCalls: 1 — the tool fee is most of this route's cost and is
      // invisible in the token usage, so pricing it off tokens alone would
      // under-count the expensive route by ~16x.
      recordSpend({ model: result.model ?? modelUsed, usage: result.usage, webSearchCalls: 1, enforced: ent.enforced });
      json(res, 200, { ...result, modelUsed, plan: ent.plan, ms: Date.now() - started }, cors);
      return;
    }

    // Flow coaching: paragraph-level "this jumps" review over the whole doc.
    // No web search, one call, cached client-side per structural change.
    if (req.method === "POST" && url.pathname === "/api/flow") {
      loadEnvFile();
      if (!hasApiKey() && !MOCK) {
        json(res, 503, { error: { kind: "no_key", message: "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env" } }, cors);
        return;
      }
      const { text, model } = (await parseJsonBody(req)) ?? {};
      if (typeof text !== "string" || !text.trim()) throw new CheckError("bad_request", "text required");
      if (text.length > GUARDS.maxInputChars) throw new CheckError("bad_request", "text too long");
      const started = Date.now();
      // The only route that ever honoured the client's model directly, which
      // makes it the one the clamp matters most on.
      const { ent } = gate;
      const modelUsed = allowedModel(ent, model);
      const result = await runFlowCheck({ text, model: modelUsed, mock: MOCK });
      recordSpend({ model: result.model ?? modelUsed, usage: result.usage, enforced: ent.enforced });
      json(res, 200, { ...result, modelUsed, plan: ent.plan, ms: Date.now() - started }, cors);
      return;
    }

    // ── pipeline routes ────────────────────────────────────────────────
    /* ── the desktop's reasoning (lib/reasoning.js) ─────────────────────
     * Every route below speaks the retired relay's contract, so the desktop's
     * request builders and parsers work against it unchanged. The web app
     * sends a raw `draft` where the desktop sends numbered text, and gets the
     * same reasoning through a thin adapter. All of them go through appGate
     * and appCall: their own pool, limiter and quota, never the extension's. */

    if (req.method === "POST" && url.pathname === "/api/detect-claims") {
      loadEnvFile();
      requireKey();
      const body = (await parseJsonBody(req)) ?? {};
      const { effort, model: requested } = body;
      // `draft` (or un-numbered `text` from an older caller) is split here with
      // the desktop's sentence splitter; numbered `text` is the desktop's own.
      const raw = typeof body.draft === "string" ? body.draft : typeof body.text === "string" && !reasoning.isNumbered(body.text) ? body.text : null;
      const numbered = raw === null && typeof body.text === "string" ? body.text : null;
      if (!(raw ?? numbered ?? "").trim()) throw new CheckError("bad_request", "text required");
      const result = await appCall(gate, {
        task: "detect",
        requested,
        cache: {
          kind: "detect", version: 2, maxAgeMs: 24 * 3600_000,
          key: (model) => hashKey(`${raw !== null ? "draft" : "text"}|${model}|${effort ?? ""}|${raw ?? numbered}`),
        },
        run: async (model) => {
          if (numbered !== null) return reasoning.detectClaims({ text: numbered, model, effort });
          const r = await reasoning.detectClaimsInDraft({ draft: raw, model, effort });
          // The web app keys dismissal and merge state on an id salted with the
          // start offset, so one claim asserted twice gets two ids.
          r.claims = r.claims.map((c) => ({ ...c, id: hashKey(`claim|${c.text}|${c.start}`).slice(0, 16) }));
          return r;
        },
      });
      json(res, 200, result, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/evidence") {
      // Free scholarly retrieval — no key required, providers fail to empty.
      const { claim, query, claimType } = (await parseJsonBody(req)) ?? {};
      if (typeof claim !== "string" || !claim.trim() || claim.length > 2000) throw new CheckError("bad_request", "claim required (max 2000 chars)");
      const key = hashKey(`${claimType ?? ""}|${query ?? ""}|${claim}`);
      let result = cacheGet("evidence", key, { maxAgeMs: 6 * 3600_000, version: 2 });
      // Degraded sweeps (a provider failed) and empty results go stale fast:
      // a moment of network trouble must not be frozen as "no evidence" for 6h.
      if (result && ((result.searched?.failed?.length ?? 0) > 0 || (result.sources ?? []).length === 0)) {
        result = cacheGet("evidence", key, { maxAgeMs: 5 * 60_000, version: 2 });
      }
      if (!result) {
        result = await evidence.gatherEvidence({ claim, query, claimType });
        for (const s of result.sources ?? []) {
          const row = upsertSource(s);
          s.id = row.id;
        }
        // An all-providers-failed sweep is a failure, not an empty result —
        // never cache it (lib/db.js: failures are simply not cached).
        if ((result.searched?.providers?.length ?? 0) > 0) {
          cacheSet("evidence", key, result, { version: 2 });
        }
      }
      json(res, 200, result, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/critique") {
      loadEnvFile();
      requireKey();
      // The global 60/hour critique cap is a SINGLE-USER backstop: on a local
      // server it bounds one person's auto-critique. On a hosted server it
      // would be 60 an hour for every user combined, so there the per-caller
      // quota, the app limiter and the app budget bound it instead.
      const hosted = gate.ent.enforced;
      if (!hosted && !critiqueCounter.ok()) throw new CheckError("rate_limit", "Critique hourly cap reached — try again later.", { status: 429, retryAfter: 600 });
      const body = (await parseJsonBody(req)) ?? {};
      // The desktop sends the relay's request, with the evidence summary and
      // the reference lookup already built on its side. The web app and older
      // callers send a claim and raw sources; they are turned into the same
      // request with NO reference lookup, which keeps "fabricated" unreachable
      // for them — Pass 2(c) may only return it when a lookup ran.
      let input;
      if (typeof body.claimText === "string") {
        if (!("strengthScore" in body)) throw new CheckError("bad_request", "strengthScore is required (a number or null)");
        input = { claimText: body.claimText, strengthScore: body.strengthScore, evidenceSummary: body.evidenceSummary, referenceCheck: body.referenceCheck ?? undefined };
      } else if (typeof body.claim === "string" && body.claim.trim()) {
        input = reasoning.critiqueInputFromSources(body);
      } else {
        throw new CheckError("bad_request", "claimText required");
      }
      const result = await appCall(gate, {
        task: "critique",
        requested: body.model,
        cache: {
          kind: "critique", version: 2, maxAgeMs: 7 * 24 * 3600_000,
          key: (model) => hashKey(["crit2", model, input.claimText, input.strengthScore ?? "null", input.evidenceSummary ?? "", input.referenceCheck ?? "none"].join("|")),
        },
        run: (model) => {
          if (!hosted) critiqueCounter.stamp(); // before the call
          return reasoning.critique({ ...input, model, effort: body.effort });
        },
      });
      json(res, 200, result, cors);
      return;
    }

    // A second opinion on a contradiction the desktop's local NLI flagged.
    if (req.method === "POST" && url.pathname === "/api/correction") {
      loadEnvFile();
      requireKey();
      const body = (await parseJsonBody(req)) ?? {};
      const passages = Array.isArray(body.contradictingPassages) ? body.contradictingPassages : [];
      const result = await appCall(gate, {
        task: "critique",
        requested: body.model,
        cache: {
          kind: "correction", maxAgeMs: 7 * 24 * 3600_000,
          key: (model) => hashKey(["corr", model, String(body.claimText ?? ""), ...passages.map(String)].join("|")),
        },
        run: (model) => reasoning.correction({ claimText: body.claimText, contradictingPassages: passages, model, effort: body.effort }),
      });
      json(res, 200, result, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/grade") {
      loadEnvFile();
      requireKey();
      const body = (await parseJsonBody(req)) ?? {};
      const { level, rubric, model: requested, effort } = body;
      const raw = typeof body.draft === "string" ? body.draft : typeof body.text === "string" && !reasoning.isNumbered(body.text) ? body.text : null;
      const numbered = raw === null && typeof body.text === "string" ? body.text : null;
      if ((raw ?? numbered ?? "").trim().length < 40) throw new CheckError("bad_request", "text too short to grade");
      /* A pasted rubric (web app: Settings → Custom rubric) replaces the
         built-in one, through its own prompt — the relay grader is written
         against the owner's rubric and cannot grade against another. Capped
         because it goes into the SYSTEM prompt verbatim, and an unbounded
         paste is an unbounded bill. */
      const custom = typeof rubric === "string" && rubric.trim() ? rubric.trim().slice(0, MAX_CUSTOM_RUBRIC_CHARS) : null;
      if (custom) {
        const clipped = (raw ?? reasoning.unnumber(numbered, /\n\s*\n/).join("\n\n")).slice(0, GUARDS.maxInputChars);
        const result = await appCall(gate, {
          task: "grade",
          requested,
          cache: { kind: "grade", maxAgeMs: 7 * 24 * 3600_000, key: (model) => hashKey(`grade|${model}|${level ?? 12}|${hashKey(custom)}|${clipped}`) },
          run: (model) => ai.gradeWithCustomRubric({ text: clipped, rubric: custom, level, model }),
        });
        json(res, 200, result, cors);
        return;
      }
      // The desktop sends the prompt its buildGradePrompt made; a raw draft is
      // split and capped here by the very same function.
      const fromDraft = raw !== null ? reasoning.gradePromptFromDraft(raw) : null;
      const prompt = fromDraft ? fromDraft.prompt : numbered;
      const result = await appCall(gate, {
        task: "grade",
        requested,
        cache: { kind: "grade", version: 2, maxAgeMs: 7 * 24 * 3600_000, key: (model) => hashKey(`grade2|${model}|${prompt}`) },
        run: (model) => reasoning.gradeDraft({ text: prompt, model, effort }),
      });
      json(res, 200, fromDraft ? { ...result, paragraphTexts: fromDraft.paragraphTexts } : result, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/structure") {
      loadEnvFile();
      requireKey();
      const body = (await parseJsonBody(req)) ?? {};
      const raw = typeof body.draft === "string" ? body.draft : typeof body.text === "string" && !reasoning.isNumbered(body.text) ? body.text : null;
      const prompt = raw !== null ? reasoning.structurePromptFromDraft(raw) : typeof body.text === "string" ? body.text : "";
      if (!prompt.trim()) throw new CheckError("bad_request", "text required");
      const result = await appCall(gate, {
        task: "structure",
        requested: body.model,
        cache: { kind: "structure", version: 2, maxAgeMs: 24 * 3600_000, key: (model) => hashKey(`struct2|${model}|${prompt}`) },
        run: (model) => reasoning.classifyStructure({ text: prompt, model, effort: body.effort }),
      });
      json(res, 200, result, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tracer") {
      loadEnvFile();
      requireKey();
      const body = (await parseJsonBody(req)) ?? {};
      const { message, model: requested, effort } = body;
      if (typeof message !== "string" || !message.trim()) throw new CheckError("bad_request", "message required");
      // Not cached: a chat turn depends on the whole conversation so far.

      // The desktop's form: stateless, the client holds the history.
      if (!("conversationId" in body) && !("draft" in body) && !("documentId" in body)) {
        const out = await appCall(gate, {
          task: "tracer",
          requested,
          run: (model) => reasoning.tracerReply({ message, history: body.history, context: body.context, model, effort }),
        });
        json(res, 200, out, cors);
        return;
      }

      // The web app's form: the server keeps the conversation. The SAME
      // reasoning answers it — only where the history lives differs.
      let convId = body.conversationId;
      if (!convId) {
        convId = uuid();
        db.prepare("INSERT INTO tracer_conversations (id, document_id, created_at) VALUES (?,?,?)").run(convId, body.documentId ?? null, Date.now());
      }
      const stored = db.prepare("SELECT role, content FROM tracer_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30").all(convId).reverse();
      while (stored.length > 0 && stored[0].role !== "user") stored.shift();
      const out = await appCall(gate, {
        task: "tracer",
        requested,
        run: (model) => reasoning.tracerReply({
          message,
          history: stored.map((m) => ({ role: m.role === "user" ? "user" : "tracer", content: m.content })),
          context: typeof body.draft === "string" ? body.draft : "",
          model,
          effort,
        }),
      });
      // Both turns are written only after the reply exists, so a failed call
      // leaves no orphaned question in the history.
      const now = Date.now();
      db.prepare("INSERT INTO tracer_messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)")
        .run(uuid(), convId, "user", message.slice(0, 4000), now);
      db.prepare("INSERT INTO tracer_messages (id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)")
        .run(uuid(), convId, "assistant", out.reply, now + 1);
      json(res, 200, { ...out, conversationId: convId }, cors);
      return;
    }

    // The desktop's web search for sources, forced and schema-checked as the
    // relay ran it. Separate from the extension's /api/sources on purpose: its
    // own prompt, its own per-caller hourly window, the app spend pool.
    if (req.method === "POST" && url.pathname === "/api/find-sources") {
      loadEnvFile();
      requireKey();
      const body = (await parseJsonBody(req)) ?? {};
      if (typeof body.claim !== "string" || !body.claim.trim()) throw new CheckError("bad_request", "claim required");
      if (gate.ent.enforced && gate.callerId) {
        if (!appSearchRate.ok(gate.callerId)) {
          throw new CheckError("rate_limit", "Source search is limited to a few dozen an hour — try again later.", { status: 429, retryAfter: 600 });
        }
        appSearchRate.stamp(gate.callerId); // before the call
      }
      const result = await appCall(gate, {
        task: "sources",
        requested: body.model,
        quota: SOURCE_QUOTA,
        // The web_search tool fee is most of this route's cost and is invisible
        // in the token usage.
        webSearchCalls: 1,
        cache: {
          kind: "find-sources", maxAgeMs: 7 * 24 * 3600_000,
          key: (model) => hashKey(["src", model, body.claim, body.context ?? ""].join("|")),
        },
        run: (model) => reasoning.findSources({ claim: body.claim, context: body.context, model, effort: body.effort }),
      });
      json(res, 200, result, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/compare-source") {
      // Free — resolves the writer's own citation against Crossref + Open Library.
      const { citedRef } = (await parseJsonBody(req)) ?? {};
      if (typeof citedRef !== "string" || !citedRef.trim()) throw new CheckError("bad_request", "citedRef required");
      if (typeof evidence.compareSource !== "function") throw new CheckError("server", "compare not built yet", { status: 501 });
      json(res, 200, await evidence.compareSource({ citedRef }), cors);
      return;
    }

    // ── macOS Screen Watch routes ──────────────────────────────────────
    // App-private on purpose: NOT in EXTENSION_API, so docs.google.com and
    // chrome-extension origins are rejected by routeAllowedForOrigin above.
    if (req.method === "GET" && url.pathname === "/api/watch/state") {
      json(res, 200, { ...watch.getState(), watchApps: store.prefs.get().watchApps ?? [] }, cors);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/watch/toggle") {
      const { enabled } = (await parseJsonBody(req)) ?? {};
      if (typeof enabled !== "boolean") throw new CheckError("bad_request", "enabled must be a boolean");
      store.prefs.set({ watchEnabled: enabled });
      watch.setEnabled(enabled);
      json(res, 200, { ...watch.getState(), watchApps: store.prefs.get().watchApps ?? [] }, cors);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/watch/critique") {
      // Paid, button-triggered — the ONLY path to a critique on this surface.
      loadEnvFile();
      requireKey();
      const { key } = (await parseJsonBody(req)) ?? {};
      if (typeof key !== "string" || !key.trim()) throw new CheckError("bad_request", "key required");
      json(res, 200, await watch.critiqueFinding(key), cors);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/watch/fix") {
      const { key } = (await parseJsonBody(req)) ?? {};
      if (typeof key !== "string" || !key.trim()) throw new CheckError("bad_request", "key required");
      json(res, 200, await watch.applyFix(key), cors);
      return;
    }

    // ── contract-gap routes for the Electron renderer's bridge ─────────
    // App-private (NOT in EXTENSION_API). Shapes track ui/src/shared/
    // ipc-contract.ts as closely as our data allows; the bridge adapts.
    if (url.pathname === "/api/documents/latest" && req.method === "GET") {
      // DOCUMENTS_LATEST → { document: <row> | null } (most recently opened).
      json(res, 200, { document: store.documents.latest() }, cors);
      return;
    }
    if (url.pathname === "/api/evidence/for-claim" && req.method === "GET") {
      // EVIDENCE_GET_FOR_CLAIM, keyed by claim TEXT (our claim ids are
      // per-analysis salts, so text is the stable key our DB can answer with).
      json(res, 200, store.evidenceForClaim(url.searchParams.get("claimText") ?? ""), cors);
      return;
    }
    if (url.pathname === "/api/settings/scan-apps" && req.method === "POST") {
      // SETTINGS_SCAN_INSTALLED_APPS — static macOS candidate list; the real
      // scan is a Windows registry read we don't have. `exe` matches the
      // contract's ScannedApp shape.
      json(res, 200, {
        found: [
          { name: "TextEdit", exe: "TextEdit.app" },
          { name: "Notes", exe: "Notes.app" },
          { name: "Pages", exe: "Pages.app" },
          { name: "Microsoft Word", exe: "Microsoft Word.app" },
          { name: "Mail", exe: "Mail.app" },
        ],
      }, cors);
      return;
    }

    // ── storage routes ─────────────────────────────────────────────────
    if (url.pathname === "/api/documents" && req.method === "GET") {
      json(res, 200, { documents: store.documents.list(url.searchParams.get("sort") ?? undefined) }, cors);
      return;
    }
    if (url.pathname === "/api/documents" && req.method === "POST") {
      json(res, 200, store.documents.create((await parseJsonBody(req)) ?? {}), cors);
      return;
    }
    const docMatch = url.pathname.match(/^\/api\/documents\/([A-Za-z0-9-]{8,40})$/);
    if (docMatch) {
      if (req.method === "GET") { json(res, 200, store.documents.get(docMatch[1]), cors); return; }
      if (req.method === "PUT") { json(res, 200, store.documents.update(docMatch[1], (await parseJsonBody(req)) ?? {}), cors); return; }
      if (req.method === "DELETE") { json(res, 200, store.documents.remove(docMatch[1]), cors); return; }
    }
    if (url.pathname === "/api/library" && req.method === "GET") {
      json(res, 200, { items: store.library.list(url.searchParams.get("q") ?? "") }, cors);
      return;
    }
    if (url.pathname === "/api/library" && req.method === "POST") {
      json(res, 200, store.library.add((await parseJsonBody(req)) ?? {}), cors);
      return;
    }
    const libMatch = url.pathname.match(/^\/api\/library\/([A-Za-z0-9-]{8,40})$/);
    if (libMatch) {
      if (req.method === "PUT") { json(res, 200, store.library.update(libMatch[1], (await parseJsonBody(req)) ?? {}), cors); return; }
      if (req.method === "DELETE") { json(res, 200, store.library.remove(libMatch[1]), cors); return; }
    }
    if (url.pathname === "/api/prefs" && req.method === "GET") { json(res, 200, store.prefs.get(), cors); return; }
    if (url.pathname === "/api/prefs" && req.method === "PUT") { json(res, 200, store.prefs.set((await parseJsonBody(req)) ?? {}), cors); return; }
    if (url.pathname === "/api/stats" && req.method === "GET") { json(res, 200, store.stats(), cors); return; }
    if (url.pathname === "/api/analyses" && req.method === "POST") { json(res, 200, store.analyses.create((await parseJsonBody(req)) ?? {}), cors); return; }
    if (url.pathname === "/api/analyses" && req.method === "GET") {
      json(res, 200, { analyses: store.analyses.forDocument(url.searchParams.get("documentId") ?? "") }, cors);
      return;
    }
    if (url.pathname === "/api/clear-history" && req.method === "POST") {
      json(res, 200, store.clearHistory((await parseJsonBody(req)) ?? {}), cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cite-url") {
      const { url: pageUrl } = (await parseJsonBody(req)) ?? {};
      if (typeof pageUrl !== "string" || pageUrl.length > 2000) {
        throw new CheckError("bad_request", "url must be a string of at most 2000 characters");
      }
      const source = await fetchUrlMetadata(pageUrl);
      json(res, 200, { source }, cors);
      return;
    }

    json(res, 404, { error: { kind: "not_found", message: "Not found" } }, cors);
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof CheckError) {
      json(res, err.status, { error: { kind: err.kind, message: err.message, retryAfter: err.retryAfter } }, cors);
    } else {
      console.error("[tracely] unexpected error:", err);
      json(res, 500, { error: { kind: "server", message: "Internal server error" } }, cors);
    }
  }
});

process.on("unhandledRejection", (err) => console.error("[tracely] unhandled rejection:", err));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Tracely running at http://localhost:${PORT}${MOCK ? "  (MOCK MODE — no API calls)" : ""}`);
  if (!hasApiKey() && !MOCK) {
    console.log("No OPENAI_API_KEY found yet — add it to tracely/.env and the server will pick it up automatically.");
  }
  // Screen Watch survives restarts: resume when the user left it on.
  if (process.platform === "darwin" && store.prefs.get().watchEnabled) {
    watch.setEnabled(true);
    console.log("Screen Watch resumed (prefs.watchEnabled).");
  }
});
