import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFactCheck, findSources, runFlowCheck, hasApiKey, CheckError, checkPromptBytes } from "./lib/factcheck.js";
import * as ai from "./lib/ai.js";
import * as reasoning from "./lib/reasoning.js";
import * as evidence from "./lib/evidence.js";
import * as store from "./lib/store.js";
import * as watch from "./lib/watch.js";
import { db, uuid, cacheGet, cacheSet, hashKey, upsertSource,
         billingEventSeen, billingEventRecord, billingCustomerLink, billingCustomerLookup } from "./lib/db.js";
import { planForRequest, sourceSearchQuota, recordSourceSearch, checkQuota, recordCheck, aiQuota, recordAi,
         callerId, entitlementConfigured, forgetCachedPlans, withBetaGrant, betaTokens, isDailyQuotaKey,
         flowQuota, recordFlow, recordAccountSpend, recordThorough, reserveThorough, thoroughState,
         fairUseState, effectivePlan } from "./lib/entitlement.js";
import { spendState, recordSpend, spendSummary, poolRoom, reserveSpend, MICRO_CENTS_PER_USD } from "./lib/spend.js";
import { verifyStripeSignature, planChangeForEvent, writePlanToSupabase, findUserIdByEmail, webhookConfigured } from "./lib/billing.js";
import { clampModel, currentModelId, planRank, DEFAULT_PLAN, FREE_DAILY_AI_CALLS, modelForRoute, THOROUGH_RESERVE_USD,
         THOROUGH_MAX_TOKENS, FLOW_MIN_INTERVAL_MS, monthDayLabel, dailyCheckLimit, dailyAiLimit, dailyFlowLimit,
         dailySourceSearchLimit, monthlySourceSearchLimit } from "./shared/plan.js";
import { MODEL_TIERS, ALLOWED_MODELS, normalizeEffort, costMicroCents } from "./lib/llm.js";
import { GUARDS, SPEND, rollingCounter, keyedRateLimiter } from "./shared/guards.js";
import { problemsFor, markFor } from "./shared/marks.js";
import { isModelFailure, modelFailureLine, noteUpstreamFailure, upstreamStatus } from "./lib/failureLog.js";
import { fetchUrlMetadata } from "./lib/citeMeta.js";

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

/* Routes whose failures are MODEL failures, logged by the central error
 * handler (lib/failureLog.js): the extension's three model routes, the one
 * paid watch route, and every desktop AI route. A fixed set, so the logged
 * `route` can never be a path carrying an id. */
const MODEL_ROUTES = new Set(["/api/check", "/api/flow", "/api/sources", "/api/watch/critique", ...APP_AI_ROUTES]);

/* The extension's model routes, which record their spend into `gate.pool`.
 * A call on one of them that fails AFTER the vendor answered (truncated,
 * refused, unparseable) was still billed; the central handler records that
 * cost from the error's tag into the same pool, so the ceiling sees it. The
 * app routes keep their own accounting (appCall), untouched. */
const EXTENSION_MODEL_ROUTES = new Set(["/api/check", "/api/flow", "/api/sources"]);

// Source searches by one IDENTIFIED caller ("user:" / "install:") on a hosted
// server: a rolling hourly window per caller, shared by the desktop's
// /api/find-sources and the extension's /api/sources — one person, one hour.
// It sits on top of the pool's global window (webSearchCounter for the
// extension pool, whatever the caller id, since an install id rotates freely);
// only the paid pool, which reserves every call, has no global window.
const callerSearchRate = keyedRateLimiter(SPEND.appCallerSearchesPerHour, 3_600_000);
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
      // X-Tracely-Beta is the beta build's Pro grant (lib/entitlement.js
      // withBetaGrant). Appended, never reordered: the first three are baked
      // into the extension under Web Store review.
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tracely-Install, X-Tracely-Beta",
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

// "Paste a URL and cite it" (/api/cite-url) — free metadata fetch, no AI
// involved: lib/citeMeta.js fetchUrlMetadata.

// Rolling-window backstops (spec §14): the caps that hold when "one analysis"
// stops being a meaningful unit. Stamped BEFORE each call.
// A teacher's rubric is a page, not a book. Enough for any real one.
const MAX_CUSTOM_RUBRIC_CHARS = 6000;
const webSearchCounter = rollingCounter(GUARDS.maxWebSearchesPerHour);
// Beta-pool source searches: their own window, so testers (who are Pro, with
// no daily source quota) cannot take the hour every store user shares.
const betaWebSearchCounter = rollingCounter(SPEND.betaWebSearchesPerHour);
const critiqueCounter = rollingCounter(60);

// ── model tiering (token optimization) ─────────────────────────────────
// Decided here, once, so every surface prices identically.
//   economy (default): the FAST tier for everything — a full essay session
//     lands in single-digit cents. This is the hard cost mandate.
//   smart: the fast tier everywhere except the two places the THOROUGH tier
//     measured better — critique and "Explain in depth" (checkDeep). It used
//     the balanced tier for critique, grading and checks until 2026-09-22;
//     that tier is gone, and fast was the more accurate model on every task
//     the eval measured (shared/plan.js THOROUGH_ROUTES). A correction is
//     its own task, on fast, as it is hosted — it used to share critique's.
//     A thorough critique runs under THOROUGH_MAX_TOKENS here too (appCall,
//     lib/watch.js), so smart's cost profile matches the hosted one.
//   uniform: the user's chosen model everywhere (they pay for what they pick).
// LOCAL runs only: a hosted server chooses with shared/plan.js modelForRoute.
// Read from the tier table rather than written out, so a model rename is one
// edit in lib/llm.js instead of a hunt through every file that names one.
const H = MODEL_TIERS.fast;
const T = MODEL_TIERS.thorough;
const TIERS = {
  economy: { detect: H, structure: H, tracer: H, critique: H, correction: H, grade: H, sources: H, check: H, checkDeep: H },
  smart:   { detect: H, structure: H, tracer: H, critique: T, correction: H, grade: H, sources: H, check: H, checkDeep: T },
};
function pickModel(task) {
  const p = store.prefs.get();
  const strat = p.modelStrategy ?? "economy";
  // A local prefs row saved before the 2026-09-21 remap can still name a
  // retired id; it means the tier it named (shared/plan.js currentModelId).
  const model = currentModelId(p.model);
  if (strat === "uniform") return model;
  return (TIERS[strat] ?? TIERS.economy)[task] ?? model;
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

/* A client's model id as one this server serves, before any plan clamp: a
 * retired id that shipped builds still send ("gpt-5-nano" from the Fast stop,
 * "gpt-5.4" from Balanced — extension <= 2.19.2 and pre-remap desktops)
 * becomes its tier's current model, so an old build keeps the tier it asked
 * for; anything else unrecognised is the fast tier, as it always was. */
function servedModel(requested) {
  const id = currentModelId(requested);
  return ALLOWED_MODELS.has(id) ? id : MODEL_TIERS.fast;
}

/* LOCAL /api/check runs each tier at the ONE effort the eval measured it at,
 * whatever the client sent (eval/models/FINDINGS.md) — a hosted server takes
 * the effort from shared/plan.js modelForRoute, the same numbers:
 *   fast      gpt-5.6-luna   medium — 100% vs 90% at low (0 vs 5 harmful
 *                                     verdicts); builds <= 2.19.2 send "low"
 *                                     from their Fast stop
 *   thorough  gpt-6-astra    low    — builds <= 2.19.2 send "medium" from
 *                                     their Thorough stop, a config nobody
 *                                     measured; before 2026-09-21 hosted
 *                                     /api/check ignored the client's model,
 *                                     so that pair never reached astra
 * Nothing else was measured on this route, and "high" on astra is also the
 * dearest check there is, so no client level passes through. /api/check only:
 * the desktop critique measured no better at medium and no other route was
 * measured, so everything else keeps the client's effort or the default. */
const CHECK_EFFORT = {
  [MODEL_TIERS.fast]: "medium",
  [MODEL_TIERS.thorough]: "low",
};
function checkEffort(model, level) {
  return Object.hasOwn(CHECK_EFFORT, model) ? CHECK_EFFORT[model] : level;
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
      it runs low, sources are shed before checks: a source search costs
      ~10-25x a typing-pause check, so dropping it buys that much runway.
   2. PER-CALLER DAILY QUOTA — bounds accidents and casual overuse, which is
      most of the real risk. Keyed on a signed-in id or a client-supplied
      install id; an address alone cannot carry a daily quota without locking
      out a whole school, so it does not get one.
   3. PER-CALLER RATE LIMIT — smooths bursts, in memory, keyed on the caller
      (including the address rung, which is safe for a per-minute window even
      when it is not safe for a day).

   Stamped BEFORE the call on the counters that gate admission, and the actual
   COST is recorded after, because cost is not knowable until the usage comes
   back. The extension pool can therefore overshoot by the calls in flight
   when it trips — bounded by layer 3 and, at fast-model prices, a fraction of
   a cent. The beta and paid pools serve the thorough model, where that
   reasoning fails (a beta caller rotates its install id, so layer 3 bounds
   nothing), so they reserve a worst-case cost per admitted call instead — see
   WORST_CALL below and lib/spend.js reserveSpend.

   `enforced: false` (no Supabase configured) disables all three. A plain
   `node server.js` with an empty .env behaves exactly as it did before any of
   this existed, which is how the local-first install runs. */
const checkRate = keyedRateLimiter(SPEND.callerChecksPerMinute);
const sourceRate = keyedRateLimiter(SPEND.callerSourcesPerMinute);
// The app routes' own limiter — see APP_AI_ROUTES for why it is not checkRate.
const appRate = keyedRateLimiter(SPEND.appCallerCallsPerMinute);
// One /api/flow call per caller per FLOW_MIN_INTERVAL_MS, on a hosted server.
const flowRate = keyedRateLimiter(1, FLOW_MIN_INTERVAL_MS);

function stampCallerRate(ent, id, kind) {
  if (!ent.enforced || !id) return;
  const rate = kind === "sources" ? sourceRate : checkRate;
  if (!rate.ok(id)) {
    throw new CheckError("rate_limit", "Slow down a moment — too many requests in the last minute.", { status: 429, retryAfter: 60 });
  }
  rate.stamp(id);
}

/* The most one call on an extension model route can cost, per model: the
 * route's own output ceiling (maxTokens in lib/factcheck.js — keep in step)
 * plus the most input it can send:
 *   check   40 sentences x 2,000 chars + a context trimmed to <= 6,000 chars
 *           + the prompt: ~22k tokens
 *   flow    a document clamped to 12,000 chars + the prompt: ~4k tokens
 *   sources claim + correction + context (<= 10,000 chars) plus the pages
 *           web_search reads back, which NOTHING we send bounds — so this is
 *           an allowance, not a bound: 40k tokens and 3 search calls, ~1.7x
 *           the most seen live (2026-09-21 smoke run: /api/sources 13.3k
 *           and one search; the desktop's forced /api/find-sources 23.7k
 *           and two web_search_call items). A search past it is still
 *           recorded at its real cost, calls counted (searchFee).
 * Every input token is priced as a cache WRITE, the dearest way input is
 * billed: a first-seen prompt on the tier models costs 1.25x input
 * (shared/prices.js cacheWrite), and a cold call is the worst case.
 * Held against the beta and paid pools while the call is in flight, so a
 * burst cannot be admitted against money the calls ahead of it are about to
 * spend. On gpt-6-astra that is ~$1.10 / $0.45 / $0.83; on gpt-5.6-luna
 * ~2.5 / 1.1 / 4.7 cents.
 *
 * It is the worst case of ONE call. A check that truncates splits
 * (factcheck.js checkBatch) into two more calls, recursively, each up to this
 * same worst case — three or more calls where one was reserved. So before
 * each split the route holds two more worst cases against the pool
 * (admitSplitCalls), under the test admission used; with no room, it does
 * not split and the check fails as truncated. Every call made is recorded,
 * including the ones that truncated. */
const WORST_CALL = {
  "/api/check": { input: 24_000, output: 16_000, webSearchCalls: 0 },
  "/api/flow": { input: 4_000, output: 8_000, webSearchCalls: 0 },
  "/api/sources": { input: 40_000, output: 6_000, webSearchCalls: 3 },
};
function worstCallMicroCents(route, model) {
  const w = WORST_CALL[route];
  if (!w) return 0;
  return costMicroCents(model, { input: w.input, cacheWrite: w.input, output: w.output }, { webSearchCalls: w.webSearchCalls });
}
/* The web_search fee to record for a source search: every web_search_call
 * the answer carried (lib/providers/openai.js webSearchCallsOf), and never
 * fewer than the one search the route exists to make — the count the fee was
 * always recorded at, and what a mock or an answer that reports none is
 * charged. Over-counting is the safe direction for a spend cap. */
function searchFee(calls) {
  return Math.max(1, Number.isInteger(calls) ? calls : 0);
}

/* A split's two halves, admitted like a call: true when the gate holds no
 * reservation (the extension pool and a local server, which reserve nothing
 * for a first call either), otherwise only if the pool has room for both. */
function admitSplitCalls(gate, route, model) {
  return gate.reservation ? gate.reservation.extend(2 * worstCallMicroCents(route, model)) : true;
}

/* `extension` is true only for EXTENSION_API routes, and only those choose
 * between the three pools below; every other paid route is on the extension
 * pool exactly as before.
 *
 *   beta       A caller whose X-Tracely-Beta token matches (withBetaGrant)
 *              runs as Pro here while the beta pool has room.
 *   paid       A Student or Pro account (its own plan, not a beta grant) runs
 *              here while the paid pool has room — so the thorough model can
 *              never empty the day free users run on.
 *   extension  Everyone else, and anyone whose pool above is spent: a beta
 *              caller at its own plan, a paid caller at the FAST model
 *              (`modelCeiling`), their plan and quotas otherwise unchanged.
 *
 * "Room" counts calls in flight (lib/spend.js poolRoom), and it is the same
 * test for a check and a source search: the extension pool's 20% shed line is
 * about keeping ITS checks alive and means nothing to a pool that falls back
 * rather than refusing. So beta and paid usage is never refused BECAUSE of
 * those pools — the worst either does is fall back — and never draws on the
 * extension pool while its own pool can still pay.
 *
 * The pool is decided first, then the caller's rate is stamped (which may
 * 429), and only then is the worst case reserved, so no refusal can leak a
 * reservation. The handler releases it in a `finally`. The returned `pool`
 * is where the route must record its spend. */
async function spendGate(req, { kind = "check", extension = false, route = null } = {}) {
  const ent = await planForRequest(req);
  const id = callerId(req, ent);

  let pick = null;
  let modelCeiling = null;
  // The plan the caller HOLDS on this route (Pro for a beta tester), whichever
  // pool ends up paying: what a plan-only feature ("Explain in depth") is
  // judged on, so a spent pool degrades it to the fast model, never a 403.
  const granted = extension ? withBetaGrant(ent, req) : ent;
  if (extension) {
    const beta = granted.beta ? poolRoom({ enforced: ent.enforced, pool: "beta" }) : null;
    if (beta?.room) {
      pick = { ent: granted, pool: "beta", budget: beta.budget };
    } else if (ent.enforced && planRank(ent.plan) > planRank(DEFAULT_PLAN)) {
      const paid = poolRoom({ enforced: true, pool: "paid" });
      if (paid.room) pick = { ent, pool: "paid", budget: paid.budget };
      else modelCeiling = DEFAULT_PLAN;
    }
  }

  if (!pick) {
    const budget = spendState({ enforced: ent.enforced });
    if (!budget.allowed) {
      // Deliberately not "try again later" — it resets at midnight, and a
      // string that implies minutes when it means hours is a lie users notice.
      throw new CheckError("budget", "Tracely has hit its daily usage limit. It resets at midnight.", { status: 503 });
    }
    if (kind === "sources" && !budget.sourcesAllowed) {
      throw new CheckError("budget", "Source search is paused for today to keep fact-checking available. Checking still works.", { status: 503 });
    }
    pick = { ent, pool: "extension", budget };
  }

  stampCallerRate(pick.ent, id, kind);

  /* The FAST model's worst case, whatever the plan: every extension route
   * runs it on a hosted server (modelForRoute), and the one call that may run
   * the thorough model — "Explain in depth" — holds its own worst case on top
   * before it runs (admitThorough). This used to reserve the plan's ceiling,
   * ~$1.10 per Pro check, which ran a paid pool dry on reservations alone. */
  const reservation = pick.pool !== "extension" && pick.budget.enforced
    ? reserveSpend(pick.pool, worstCallMicroCents(route, MODEL_TIERS.fast))
    : null;
  return { ent: pick.ent, holder: granted, callerId: id, budget: pick.budget, pool: pick.pool, reservation, modelCeiling };
}

/* The model an extension model route runs at: appModelFor's rule (the client's
 * request clamped to the plan when hosted, pickModel locally), then the
 * gate's `modelCeiling` when a paid caller's pool is spent. It also shrinks
 * the gate's reservation to the worst case of the model actually chosen —
 * reserved at the plan's ceiling, because the body had not been read yet. */
function extensionModel(gate, route, model) {
  const chosen = gate.modelCeiling ? clampModel(model, gate.modelCeiling) : model;
  gate.reservation?.resize(worstCallMicroCents(route, chosen));
  return chosen;
}

/* ── the hosted model policy (shared/plan.js modelForRoute) ─────────────
 * On a hosted server the SERVER picks model, effort and output ceiling per
 * route; the client's model id only chooses Pro's thorough model over fast on
 * a thorough route, and its effort is never read. `plan` is the EFFECTIVE
 * plan (lib/entitlement.js effectivePlan): an account over its fair-use limit
 * runs at Free's, so its Thorough allowance is off too. */
function hostedChoice(route, ent, id, { requested, thoroughAvailable = false } = {}) {
  return modelForRoute(route, effectivePlan(ent, id), { requested, thoroughAvailable });
}

/* What one thorough call holds, in micro-cents, against the account's
 * allowance and, on the beta and paid pools, against the pool as well: its
 * worst case on the thorough model FOR THIS PROMPT. The input side is the
 * prompt's UTF-8 size (lib/factcheck.js checkPromptBytes, lib/reasoning.js
 * critiquePromptBytes) — a byte-level BPE token covers at least one byte, so
 * B bytes are at most B tokens in any script, where a fixed token guess is
 * blown ~3x by CJK text — plus a little message framing, priced cold as cache
 * writes; the output side is the route's ceiling (THOROUGH_MAX_TOKENS, which
 * counts reasoning tokens too). Never below the route's fixed floor
 * (THOROUGH_RESERVE_USD), which is all a route without a ceiling holds. */
const THOROUGH_FRAMING_TOKENS = 256;
function thoroughWorstMicroCents(route, promptBytes = 0) {
  const floor = Math.round((THOROUGH_RESERVE_USD[route] ?? 0) * MICRO_CENTS_PER_USD);
  const maxOut = THOROUGH_MAX_TOKENS[route];
  if (!maxOut) return floor;
  const input = Math.max(0, Number(promptBytes) || 0) + THOROUGH_FRAMING_TOKENS;
  return Math.max(floor, costMicroCents(MODEL_TIERS.thorough, { input, cacheWrite: input, output: maxOut }));
}

/* Admission to the thorough model for one call: the account's allowance
 * (reserveThorough), then — when the gate holds a pool reservation — room in
 * that pool for the thorough worst case too. A beta tester's allowance is
 * keyed on an install id they can rotate, so the POOL is what bounds a
 * rotating tester, exactly as it bounds their checks. Not while a paid
 * caller's pool is spent (modelCeiling: that caller runs fast). Returns the
 * allowance hold (release it after recording) or null: run on fast. */
function admitThorough(gate, route, requested, promptBytes = 0) {
  if (!gate.ent.enforced || gate.modelCeiling) return null;
  const worst = thoroughWorstMicroCents(route, promptBytes);
  const hold = reserveThorough(gate.ent, gate.callerId, route, { requested, worstMicroCents: worst });
  if (!hold) return null;
  if (gate.reservation && !gate.reservation.extend(worst)) {
    hold.release();
    return null;
  }
  return hold;
}

/* Every model call's cost, charged ONCE (recordSpend prices it) to the pool
 * that paid, the caller's fair-use total, and — on the thorough model — its
 * Thorough allowance. The failed-but-billed path in the central handler uses
 * it too, so a call that truncated still counts against both. */
function chargeCall(gate, { model, usage, webSearchCalls = 0, pool }) {
  const cost = recordSpend({ model, usage, webSearchCalls, enforced: gate.ent.enforced, pool });
  recordAccountSpend(gate.callerId, cost);
  // A request holding a thorough admission makes exactly one call, on the
  // thorough model. The id is checked too, with a dated snapshot suffix
  // stripped: the vendor may answer "gpt-6-astra-2026-08-01", and an
  // exact-match test would let every such call skip the allowance.
  const base = String(model ?? "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (gate.thoroughHold || base === MODEL_TIERS.thorough) recordThorough(gate.callerId, cost);
  return cost;
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
  return { ent, callerId: id, budget, pool: "app" };
}

/**
 * The model a call runs at WITHOUT the hosted policy — in practice, a LOCAL
 * (unenforced) server: pickModel, the server-side tiering over the one prefs
 * row, exactly as before. Every hosted route chooses with hostedChoice
 * (shared/plan.js modelForRoute) instead.
 *
 * It never reads pickModel on a hosted server: that row is writable by
 * `PUT /api/prefs`, and before 2026-09-21 an anonymous caller could set
 * {modelStrategy:"uniform", model:"gpt-6-astra"} and every app route, for
 * everyone, ran the thorough model. The enforced branch below (the client's
 * request clamped to the plan) is the pre-policy rule, kept as the fallback
 * for any caller that is not routed through hostedChoice.
 */
function appModelFor(task, ent, requested) {
  if (!ent.enforced) return pickModel(task);
  return clampModel(servedModel(requested), ent.plan);
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
/* ── refusal copy (decision document §7, "Server messages") ─────────────
 * Every quota refusal keeps kind "plan_limit" and status 429, which shipped
 * clients already handle; only the words changed. An account over its
 * fair-use limit is metered at Free's numbers (effectivePlan), so its refusal
 * says THAT instead of quoting Starter's allowance at a paying user. */
function fairUseMessage(fu) {
  const month = fu.state === "month";
  const until = month ? monthDayLabel(fu.resetsOn) : "midnight";
  return `This account has reached its fair-use limit for ${month ? "this month" : "today"}, so it's running at Starter limits until ${until}.`;
}
function quotaRefusal(ent, id, message) {
  const fu = fairUseState(ent, id);
  const text = fu.state === "day" || fu.state === "month" ? fairUseMessage(fu) : message;
  return new CheckError("plan_limit", text, { status: 429 });
}
const checkLimitMessage = (q) =>
  `Starter includes ${q.limit} checks a day, and today's are used. They reset at midnight — Student and Pro have no daily check limit.`;
const aiLimitMessage = (q) =>
  `Starter includes ${q.limit ?? FREE_DAILY_AI_CALLS} AI actions a day, and today's are used. They reset at midnight — Student and Pro have no daily limit.`;
const flowLimitMessage = (q) => `You've used today's ${q.limit} flow checks. They reset at midnight.`;
function sourceLimitMessage(q) {
  if (q.blockedBy === "month") {
    return `You've used this month's ${q.monthLimit} source searches. They reset on ${monthDayLabel(q.resetsOn)}. Checking still works.`;
  }
  return `You've used today's ${q.limit} source searches. They reset at midnight.`;
}

const AI_QUOTA = {
  check: aiQuota,
  record: recordAi,
  refused: (q, ent, id) => quotaRefusal(ent, id, aiLimitMessage(q)),
};
// find-sources draws on the SAME source allowance (day AND month) as the
// extension's /api/sources: one plan, one allowance, whichever surface spends it.
const SOURCE_QUOTA = {
  check: sourceSearchQuota,
  record: recordSourceSearch,
  refused: (q, ent, id) => quotaRefusal(ent, id, sourceLimitMessage(q)),
};

/* `webSearchCalls` is a count, or a function of the result for a route whose
 * answer says how many searches it made (find-sources, searchFee).
 *
 * `route` is the policy route a HOSTED server chooses on (shared/plan.js
 * ROUTES, via hostedChoice); `task` is the local tiering's (pickModel), and
 * `effort` the client's, read on a LOCAL server only — hosted, the server
 * decides both model and effort. `run(model, effort, maxTokens)`; the cache
 * key is `key(model, effort)`, so an answer is never served across either.
 *
 * On a thorough route (critique) the allowance is reserved BEFORE the cache is
 * read, because the key is the model that would run. The hold rides on the
 * gate and the central handler releases it in its `finally`, after a failed
 * call's billed cost is charged — so no admission can see the allowance with
 * that cost neither held nor spent. */
async function appCall(gate, { task, route = task, requested, effort = undefined, cache = null, webSearchCalls = 0, quota: meter = AI_QUOTA, promptBytes = 0, run }) {
  const hosted = gate.ent.enforced;
  const hold = hosted ? admitThorough(gate, route, requested, promptBytes) : null;
  if (hold) gate.thoroughHold = hold;
  // Local: pickModel, the client's effort, and — on the thorough model, on a
  // route that has one — the same output ceiling as hosted (a 16,000-token
  // astra critique is 80 cents of output on the user's own key).
  const localModel = hosted ? null : appModelFor(task, gate.ent, requested);
  const choice = hosted
    ? hostedChoice(route, gate.ent, gate.callerId, { requested, thoroughAvailable: Boolean(hold) })
    : { model: localModel, effort, maxTokens: localModel === MODEL_TIERS.thorough ? THOROUGH_MAX_TOKENS[route] : undefined };
  const { model } = choice;
  const key = cache ? cache.key(model, choice.effort) : null;
  if (cache && !MOCK) {
    const hit = cacheGet(cache.kind, key, { maxAgeMs: cache.maxAgeMs, version: cache.version ?? 1 });
    if (hit) return hit;
  }
  const quota = meter.check(gate.ent, gate.callerId);
  if (!quota.allowed) throw meter.refused(quota, gate.ent, gate.callerId);
  meter.record(gate.ent, gate.callerId);
  const result = await run(model, choice.effort, choice.maxTokens);
  const searches = typeof webSearchCalls === "function" ? webSearchCalls(result) : webSearchCalls;
  chargeCall(gate, { model: result?.model ?? model, usage: result?.usage, webSearchCalls: searches, pool: "app" });
  if (cache && !MOCK) cacheSet(cache.kind, key, result, { version: cache.version ?? 1 });
  return result;
}

/* /api/entitlement's OPTIONAL fields (hosted only — a local server meters
 * nothing, so it reports none): the limits the caller is metered at right now
 * (the EFFECTIVE plan's; null = no daily limit), today's and this month's
 * source searches, Pro's Thorough allowance as a whole percent (never
 * dollars), and the fair-use state when one applies. Old clients ignore them. */
function entitlementDetails(ent, id) {
  const plan = effectivePlan(ent, id);
  const q = sourceSearchQuota(ent, id);
  const t = thoroughState(ent, id);
  const fu = fairUseState(ent, id);
  return {
    limits: {
      checksPerDay: dailyCheckLimit(plan),
      aiActionsPerDay: dailyAiLimit(plan),
      flowPerDay: dailyFlowLimit(plan),
      sources: { day: dailySourceSearchLimit(plan), month: monthlySourceSearchLimit(plan) },
    },
    usage: { sources: { today: q.used, month: q.monthUsed } },
    ...(t.allowanceMicroCents > 0 ? { thorough: { remainingPct: t.remainingPct, resetsOn: t.resetsOn, ...(t.suspended ? { suspended: true } : {}) } } : {}),
    ...(fu.state ? { fairUse: { state: fu.state, resetsOn: fu.resetsOn } } : {}),
  };
}

function requireKey() {
  if (!hasApiKey() && !MOCK) {
    throw new CheckError("no_key", "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env", { status: 503 });
  }
}

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders(req);
  // For the failure log only: the route, and the model/effort an extension
  // route resolved before its call. Never the request body.
  let route = null;
  const trace = { model: null, effort: null };
  // Hoisted so the `finally` below can release the gate's spend reservation
  // however the request ends.
  let gate = null;

  try {
    let url;
    try {
      url = new URL(req.url, `http://localhost:${PORT}`);
    } catch {
      json(res, 400, { error: { kind: "bad_request", message: "Malformed request URL" } }, cors);
      return;
    }
    route = url.pathname;

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
    //
    // The beta grant and the paid pool are offered on EXTENSION_API routes
    // only: never on the app routes (appGate never sees them) and never on the
    // app-private paid routes that happen to share spendGate.
    if (APP_AI_ROUTES.has(url.pathname)) {
      gate = await appGate(req);
    } else if (PAID_ROUTES.has(url.pathname)) {
      gate = await spendGate(req, {
        kind: SOURCE_ROUTES.has(url.pathname) ? "sources" : "check",
        extension: EXTENSION_API.has(url.pathname),
        route: url.pathname,
      });
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
      // `betaBudget` (optional) appears only while beta tokens are configured,
      // so a server with beta off answers exactly the shape it always had.
      // `paidBudget` (optional) is the Student/Pro pool on the extension's
      // routes; like both others it is spend on disk, not calls in flight.
      const betaOn = betaTokens().length > 0;
      json(res, 200, {
        hasKey: hasApiKey() || MOCK, mock: MOCK, docsBridge: bridgeConfigured(),
        budget: spendSummary({ enforced: entitlementConfigured() }),
        ...(betaOn ? { betaBudget: spendSummary({ enforced: entitlementConfigured(), pool: "beta" }) } : {}),
        paidBudget: spendSummary({ enforced: entitlementConfigured(), pool: "paid" }),
        // `upstream` (optional) appears only while OpenAI is refusing for lack
        // of credit (seen in the last 15 minutes) — the one outage the spend
        // pools above can't show, because it is the account, not our ceiling.
        ...(upstreamStatus() ? { upstream: upstreamStatus() } : {}),
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
      const ent = withBetaGrant(await planForRequest(req), req); // beta: Pro, see spendGate
      // `userId` rides along so the client can attach it to a Stripe checkout
      // as client_reference_id. Without it the webhook can only map a payment
      // to an account by EMAIL, which is wrong exactly when it matters most:
      // a student paying with a parent's card. Not a disclosure — the caller
      // presented that user's own token, and the id is inside it.
      json(res, 200, {
        plan: ent.plan, email: ent.email, userId: ent.userId, enforced: ent.enforced, checkedAt: Date.now(), ...(ent.beta ? { beta: true } : {}),
        ...(ent.enforced ? entitlementDetails(ent, callerId(req, ent)) : {}),
      }, cors);
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

      const { text, sentences, model, effort, deep: deepFlag } = (await parseJsonBody(req)) ?? {};
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

      /* "Explain in depth" (extension 2.20.0): `deep: true` on ONE sentence.
       * Pro's (and a beta tester's) — judged on the plan the caller HOLDS
       * (gate.holder), so a spent pool or a fair-use period runs it on the
       * fast model rather than refusing it. Only `true` counts: an old build
       * never sends the field. */
      const deep = deepFlag === true;
      if (deep && sentences.length !== 1) {
        throw new CheckError("bad_request", "deep needs exactly one sentence");
      }
      if (deep && gate.ent.enforced && planRank(gate.holder.plan) < planRank("pro")) {
        throw new CheckError("plan_required", "Explain in depth comes with Pro.", { status: 403 });
      }

      const started = Date.now();
      // Hosted (enforced): the SERVER decides (modelForRoute) — the fast
      // model at medium for every check, whatever the client's slider sent;
      // for "Explain in depth", the thorough model at low under a 2,000-token
      // ceiling while the caller's Thorough allowance covers its 15-cent
      // worst case (admitThorough), else the fast model at medium. Never
      // refused for the allowance. Local (unenforced): server-side tiering
      // (pickModel) and the measured effort per tier, exactly as before.
      const { ent, callerId: who } = gate;
      const quota = checkQuota(ent, who);
      if (!quota.allowed) throw quotaRefusal(ent, who, checkLimitMessage(quota));
      recordCheck(ent, who); // before the call, not after
      let modelUsed, level, maxTokens;
      if (ent.enforced) {
        const hold = deep ? admitThorough(gate, "checkDeep", MODEL_TIERS.thorough, checkPromptBytes({ text, sentences })) : null;
        if (hold) gate.thoroughHold = hold;
        const choice = hostedChoice(deep ? "checkDeep" : "check", ent, who, { requested: MODEL_TIERS.thorough, thoroughAvailable: Boolean(hold) });
        // extensionModel shrinks the pool hold to the model chosen — never on
        // a thorough call, whose hold admitThorough has just grown.
        modelUsed = hold ? choice.model : extensionModel(gate, "/api/check", choice.model);
        ({ effort: level, maxTokens } = choice);
      } else {
        modelUsed = extensionModel(gate, "/api/check", appModelFor(deep ? "checkDeep" : "check", ent, model));
        level = checkEffort(modelUsed, normalizeEffort(effort));
        maxTokens = deep && modelUsed === MODEL_TIERS.thorough ? THOROUGH_MAX_TOKENS.checkDeep : undefined;
      }
      Object.assign(trace, { model: modelUsed, effort: level });
      const result = await runFactCheck({
        text, sentences, model: modelUsed, effort: level, mock: MOCK, maxTokens,
        admitSplit: () => admitSplitCalls(gate, "/api/check", modelUsed),
      });
      chargeCall(gate, { model: result.model ?? modelUsed, usage: result.usage, pool: gate.pool });
      // `thorough` (optional, deep only, hosted): whether this answer came from
      // the thorough model, and the allowance left — a whole percent, never
      // dollars — as the meter shows it. `suspended` (only when true, as on
      // /api/entitlement) says the allowance is OFF for fair use rather than
      // spent: without it a client cannot tell the two apart, and tells a
      // paying account its allowance is used up while most of it remains.
      let thorough;
      if (deep && ent.enforced) {
        const t = thoroughState(gate.holder, who);
        thorough = {
          used: modelUsed === MODEL_TIERS.thorough,
          remainingPct: t.remainingPct,
          resetsOn: t.resetsOn,
          ...(t.suspended ? { suspended: true } : {}),
        };
      }
      json(res, 200, { ...result, modelUsed, plan: ent.plan, ms: Date.now() - started, ...(thorough ? { thorough } : {}) }, cors);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/sources") {
      loadEnvFile();
      if (!hasApiKey() && !MOCK) {
        json(res, 503, { error: { kind: "no_key", message: "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env" } }, cors);
        return;
      }

      const { claim, correction, context, model, effort } = (await parseJsonBody(req)) ?? {};
      if (typeof claim !== "string" || !claim.trim() || claim.length > 2000) {
        throw new CheckError("bad_request", "claim must be a non-empty string of at most 2000 characters");
      }
      if (correction != null && (typeof correction !== "string" || correction.length > 2000)) {
        throw new CheckError("bad_request", "correction must be a string of at most 2000 characters");
      }
      if (context != null && (typeof context !== "string" || context.length > 6000)) {
        throw new CheckError("bad_request", "context must be a string of at most 6000 characters");
      }

      /* Hourly windows, before the quota. An IDENTIFIED caller on a hosted
       * server ("user:" / "install:") gets a window of its own
       * (callerSearchRate, shared with the desktop's /api/find-sources), ON
       * TOP of a global window for the pool that pays:
       *   - extension pool: the process-wide 15/hour counter, for EVERY
       *     caller. An install id is the client's to rotate, and this pool
       *     holds no reservation (spendState sees only spend already on
       *     disk), so this counter is the only bound on a burst of fresh ids;
       *   - beta pool: its own global window, for the same reason;
       *   - paid pool: none — every call reserves its worst case first, so
       *     the pool itself is the bound, and its callers are paying accounts.
       * A local server keeps the global counter, as before. */
      const { ent, callerId: who } = gate;
      const perCaller = ent.enforced && isDailyQuotaKey(who);
      const globalCounter = gate.pool === "beta" ? betaWebSearchCounter : gate.pool === "paid" ? null : webSearchCounter;
      if (globalCounter && !globalCounter.ok()) {
        throw new CheckError("rate_limit", "Web-search hourly cap reached — try again later.", { status: 429, retryAfter: 600 });
      }
      if (perCaller && !callerSearchRate.ok(who)) {
        throw new CheckError("rate_limit", "Source search is limited to a few dozen an hour — try again later.", { status: 429, retryAfter: 600 });
      }

      // The day AND month source quota (SOURCE_LIMITS, at the effective
      // plan), one count with the desktop's /api/find-sources. Keyed on
      // callerId, so an anonymous extension user is metered too.
      const quota = sourceSearchQuota(ent, who);
      if (!quota.allowed) throw quotaRefusal(ent, who, sourceLimitMessage(quota));
      recordSourceSearch(ent, who); // before the call, not after

      globalCounter?.stamp(); // before the call, not after
      if (perCaller) callerSearchRate.stamp(who);
      const started = Date.now();
      // Hosted: the fast model with NO effort sent (modelForRoute "sources") —
      // the vendor default every source search was measured at; the client's
      // model and effort are not read. Local: pickModel, and the client's
      // effort when it sent one (normalised), as before.
      const choice = ent.enforced ? hostedChoice("sources", ent, who) : null;
      const modelUsed = extensionModel(gate, "/api/sources", choice ? choice.model : appModelFor("sources", ent, model));
      const level = choice ? choice.effort : effort == null ? undefined : normalizeEffort(effort);
      Object.assign(trace, { model: modelUsed, effort: level });
      const { webSearchCalls, ...result } = await findSources({ claim, correction, context, model: modelUsed, effort: level, mock: MOCK });
      // The tool fee is most of this route's cost and is invisible in the
      // token usage, so pricing it off tokens alone would under-count the
      // expensive route ~5x on the fast tier — and a reasoning model can
      // search more than once per answer, so the calls are counted.
      chargeCall(gate, { model: result.model ?? modelUsed, usage: result.usage, webSearchCalls: searchFee(webSearchCalls), pool: gate.pool });
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
      const { text, model, effort } = (await parseJsonBody(req)) ?? {};
      if (typeof text !== "string" || !text.trim()) throw new CheckError("bad_request", "text required");
      if (text.length > GUARDS.maxInputChars) throw new CheckError("bad_request", "text too long");
      /* Hosted: at most ONE flow call per caller per FLOW_MIN_INTERVAL_MS
       * (120 s) — a 429 "flow_rate" that shipped extensions (which re-ran flow
       * every 45 s while someone typed at the end of a document) swallow in
       * requestFlow's empty catch — and the daily flow quota (DAILY_FLOW, at
       * the effective plan). Stamped after the body is valid, before the call.
       * Every key counts, address keys included: this is a rate limit, not a
       * daily quota, and the extension always sends its install id. */
      const { ent, callerId: who } = gate;
      if (ent.enforced && who) {
        if (!flowRate.ok(who)) {
          throw new CheckError("flow_rate", "Flow feedback refreshes every couple of minutes — try again shortly.", { status: 429, retryAfter: Math.ceil(FLOW_MIN_INTERVAL_MS / 1000) });
        }
        const quota = flowQuota(ent, who);
        if (!quota.allowed) throw quotaRefusal(ent, who, flowLimitMessage(quota));
        flowRate.stamp(who);
        recordFlow(ent, who); // before the call, not after
      }
      const started = Date.now();
      // Hosted: the fast model at low, PINNED (modelForRoute "flow") — the
      // client's model and effort are not read. Local: the client's model as
      // one this server serves (servedModel) and its effort, as before.
      const choice = ent.enforced ? hostedChoice("flow", ent, who) : null;
      const modelUsed = extensionModel(gate, "/api/flow", choice ? choice.model : allowedModel(ent, servedModel(model)));
      const level = choice ? choice.effort : normalizeEffort(effort);
      Object.assign(trace, { model: modelUsed, effort: level });
      const result = await runFlowCheck({ text, model: modelUsed, effort: level, mock: MOCK });
      chargeCall(gate, { model: result.model ?? modelUsed, usage: result.usage, pool: gate.pool });
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
        effort,
        cache: {
          kind: "detect", version: 2, maxAgeMs: 24 * 3600_000,
          key: (model, level) => hashKey(`${raw !== null ? "draft" : "text"}|${model}|${level ?? ""}|${raw ?? numbered}`),
        },
        run: async (model, effort) => {
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
        effort: body.effort,
        // What the thorough hold is sized from (thoroughWorstMicroCents).
        promptBytes: reasoning.critiquePromptBytes(input),
        cache: {
          kind: "critique", version: 2, maxAgeMs: 7 * 24 * 3600_000,
          key: (model) => hashKey(["crit2", model, input.claimText, input.strengthScore ?? "null", input.evidenceSummary ?? "", input.referenceCheck ?? "none"].join("|")),
        },
        run: (model, effort, maxTokens) => {
          if (!hosted) critiqueCounter.stamp(); // before the call
          return reasoning.critique({ ...input, model, effort, maxTokens });
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
        task: "correction",
        route: "correction",
        requested: body.model,
        effort: body.effort,
        cache: {
          kind: "correction", maxAgeMs: 7 * 24 * 3600_000,
          key: (model) => hashKey(["corr", model, String(body.claimText ?? ""), ...passages.map(String)].join("|")),
        },
        run: (model, effort) => reasoning.correction({ claimText: body.claimText, contradictingPassages: passages, model, effort }),
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
        effort,
        cache: { kind: "grade", version: 2, maxAgeMs: 7 * 24 * 3600_000, key: (model) => hashKey(`grade2|${model}|${prompt}`) },
        run: (model, effort) => reasoning.gradeDraft({ text: prompt, model, effort }),
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
        effort: body.effort,
        cache: { kind: "structure", version: 2, maxAgeMs: 24 * 3600_000, key: (model) => hashKey(`struct2|${model}|${prompt}`) },
        run: (model, effort) => reasoning.classifyStructure({ text: prompt, model, effort }),
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
          effort,
          run: (model, effort) => reasoning.tracerReply({ message, history: body.history, context: body.context, model, effort }),
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
        effort,
        run: (model, effort) => reasoning.tracerReply({
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
    // relay ran it. Separate from the extension's /api/sources on purpose (its
    // own prompt, the app spend pool), but ONE allowance with it: the day and
    // month source quota (SOURCE_QUOTA) and the per-caller hourly window
    // (callerSearchRate). Hosted, it runs the fast model at low.
    if (req.method === "POST" && url.pathname === "/api/find-sources") {
      loadEnvFile();
      requireKey();
      const body = (await parseJsonBody(req)) ?? {};
      if (typeof body.claim !== "string" || !body.claim.trim()) throw new CheckError("bad_request", "claim required");
      if (gate.ent.enforced && gate.callerId) {
        if (!callerSearchRate.ok(gate.callerId)) {
          throw new CheckError("rate_limit", "Source search is limited to a few dozen an hour — try again later.", { status: 429, retryAfter: 600 });
        }
        callerSearchRate.stamp(gate.callerId); // before the call
      }
      const result = await appCall(gate, {
        task: "sources",
        route: "findSources",
        requested: body.model,
        effort: body.effort,
        quota: SOURCE_QUOTA,
        // The web_search tool fee is most of this route's cost and is invisible
        // in the token usage; a forced search can make more than one call.
        webSearchCalls: (r) => searchFee(r?.webSearchCalls),
        cache: {
          kind: "find-sources", maxAgeMs: 7 * 24 * 3600_000,
          key: (model) => hashKey(["src", model, body.claim, body.context ?? ""].join("|")),
        },
        run: (model, effort) => reasoning.findSources({ claim: body.claim, context: body.context, model, effort }),
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
    if (url.pathname === "/api/prefs" && req.method === "PUT") {
      /* Refused on a hosted (enforced) server. The prefs row is ONE row shared
       * by every caller and this route has no authentication, so on a public
       * box it was a way for anyone with curl to rewrite settings everyone
       * reads — until 2026-09-21 including the model every extension user's
       * /api/check ran at. Its only callers are the web renderer's bridge
       * (src/renderer/src/bridge/httpApi.ts) and the vanilla web app
       * (public/app/api.js), both built for a LOCAL server; on the hosted box
       * the browser's Origin is already refused before this line. A local,
       * single-user server keeps it exactly as it was. */
      loadEnvFile();
      if (entitlementConfigured()) {
        throw new CheckError("forbidden", "Preferences cannot be changed on a hosted Tracely server.", { status: 403 });
      }
      json(res, 200, store.prefs.set((await parseJsonBody(req)) ?? {}), cors);
      return;
    }
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
    // Before the headersSent bail-out, so a failure is logged even when the
    // response can no longer carry it. One line, no user text (failureLog.js).
    noteUpstreamFailure(err);
    if (MODEL_ROUTES.has(route) && isModelFailure(err)) console.error(modelFailureLine(route, err, trace));
    /* A call that failed AFTER the vendor answered was billed. Charged like
     * any other call (chargeCall): the pool that paid, the caller's fair-use
     * total, and the Thorough allowance when it ran the thorough model — all
     * before the `finally` below lets go of what was held for it. The app
     * routes (pool "app") are charged here too: before the Thorough allowance
     * a failed desktop call went unrecorded, and an astra critique that
     * truncated would have been free against the allowance. */
    if (gate?.pool && (EXTENSION_MODEL_ROUTES.has(route) || APP_AI_ROUTES.has(route)) && err?.llm?.usage) {
      try {
        const searched = SOURCE_ROUTES.has(route) || route === "/api/find-sources";
        chargeCall(gate, { model: err.llm.model, usage: err.llm.usage, webSearchCalls: searched ? searchFee(err.llm.webSearchCalls) : 0, pool: gate.pool });
      } catch (e) {
        console.error("[tracely] could not record a failed call's spend:", e?.message);
      }
    }
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof CheckError) {
      json(res, err.status, { error: { kind: err.kind, message: err.message, retryAfter: err.retryAfter } }, cors);
    } else {
      console.error("[tracely] unexpected error:", err);
      json(res, 500, { error: { kind: "server", message: "Internal server error" } }, cors);
    }
  } finally {
    // The route has recorded its real cost (or failed) by now; what the gate
    // held for it goes back to the pool, and a thorough call's hold to the
    // account's allowance.
    gate?.reservation?.release();
    gate?.thoroughHold?.release();
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
