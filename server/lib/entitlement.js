/**
 * Who is calling, and what they are entitled to.
 *
 * The extension puts a Supabase access token in the Authorization header of
 * every relayed call; this module turns that header into a plan by asking
 * Supabase who the token belongs to, and reads the answer out of the user's
 * metadata with shared/plan.js's precedence rules (app_metadata first — it is
 * the half only the service role can write).
 *
 * **Nothing here throws and nothing here answers high.** Supabase down, a
 * revoked token, a body that isn't JSON, a 500 — every path lands on `free`,
 * because this sits in front of the endpoints the extension needs to keep
 * working. A user who cannot be identified is an anonymous user, and an
 * anonymous user is a free user; that is not an error condition.
 *
 * **With no SUPABASE_URL configured, entitlement is off entirely.** Not "off
 * meaning everyone is free" — off meaning nothing is clamped and nothing is
 * metered, so a local run with an empty .env behaves exactly as this server
 * did before any of this existed. That is what `enforced` carries.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { usageCount, usageBump, usageAdd } from "./db.js";
import { MICRO_CENTS_PER_USD, reserveAccount, reservedAccountMicroCents } from "./spend.js";
import {
  DEFAULT_PLAN,
  planRank,
  planFromMetadata,
  usageDay,
  usageMonth,
  nextUsageDay,
  nextMonthStart,
  dailySourceSearchLimit,
  monthlySourceSearchLimit,
  dailyCheckLimit,
  dailyAiLimit,
  dailyFlowLimit,
  fairUseLimits,
  thoroughMonthlyUsd,
  wantsThorough,
  THOROUGH_RESERVE_USD,
  withinDailyLimit,
} from "../shared/plan.js";

// Every check call asks, and a browser extension re-asks on every keystroke
// burst, so the same token must not become a Supabase round trip each time.
// 60s is short enough that an upgrade takes effect while the user is still
// looking at the checkout tab.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;

// A hung auth server must not hang a fact-check. Past this we answer free,
// which is the same answer we would give if the token were bad.
const SUPABASE_TIMEOUT_MS = 4_000;

const cache = new Map();

export function entitlementConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

/** The bearer token on a request, or null. Anything malformed is "no token". */
export function bearerToken(req) {
  const header = req?.headers?.authorization ?? "";
  const m = /^Bearer[ \t]+(\S+)$/.exec(header.trim());
  return m ? m[1] : null;
}

function anonymous() {
  return { plan: DEFAULT_PLAN, email: null, userId: null, enforced: entitlementConfigured() };
}

function cacheKey(token) {
  // The token never goes in a Map key we might log; its hash identifies it.
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Resolve a token against Supabase. Failures — including a token Supabase
 * rejects — are cached too: a stale token attached to a retry loop would
 * otherwise hammer /auth/v1/user once per keystroke burst.
 */
async function resolveToken(token) {
  const base = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
  try {
    const res = await fetch(`${base}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
    if (!res.ok) return anonymous();
    const user = await res.json();
    if (!user || typeof user !== "object" || !user.id) return anonymous();
    return {
      // app_metadata only — user_metadata is account-holder writable, see shared/plan.js.
      plan: planFromMetadata(user.app_metadata),
      email: typeof user.email === "string" ? user.email : null,
      userId: user.id,
      enforced: true,
    };
  } catch {
    return anonymous();
  }
}

/**
 * The entitlement for one request: `{ plan, email, userId, enforced }`.
 *
 * `userId` is what the meter counts against — null means "we do not know who
 * this is", which is how a local, signed-out run stays unmetered.
 */
export async function planForRequest(req) {
  if (!entitlementConfigured()) return anonymous();
  const token = bearerToken(req);
  if (!token) return anonymous();

  const key = cacheKey(token);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const value = await resolveToken(token);
  if (cache.size >= CACHE_MAX) {
    // Cheap bound: the Map iterates in insertion order, so this drops oldest.
    for (const k of cache.keys()) {
      cache.delete(k);
      if (cache.size < CACHE_MAX) break;
    }
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Testing/reload seam — a plan changed by a webhook should not wait 60s. */
export function forgetCachedPlans() {
  cache.clear();
}

// ── the beta grant ─────────────────────────────────────────────────────
/* Testers on the unpacked beta build (Tracely-<version>-beta.zip, which
 * carries beta.json) send X-Tracely-Beta: <token>. A token listed in
 * TRACELY_BETA_TOKENS lifts the caller to Pro on the EXTENSION's routes only
 * — server.js applies this in spendGate and /api/entitlement and nowhere
 * else, so the desktop's app routes never see it.
 *
 * Applied per request, OUTSIDE planForRequest's 60s cache, for two reasons:
 * the cache is keyed on the bearer token (a signed-out tester has none), and
 * a grant cached against a user would outlive the header that earned it.
 * withBetaGrant returns a NEW object — mutating the cached entitlement would
 * hand Pro to that user's next request with no header at all.
 *
 * TRACELY_BETA_TOKENS is read from the env passed in, which server.js
 * refreshes from .env on every request (loadEnvFile), so adding or revoking a
 * token needs no restart. Empty or absent means beta is off. */
export const BETA_HEADER = "x-tracely-beta";

/** The configured tokens: comma-separated, trimmed, blanks dropped. */
export function betaTokens(env = process.env) {
  return String(env?.TRACELY_BETA_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

/* Constant-time over equal-length buffers: both sides are SHA-256'd first, so
 * timingSafeEqual never throws on a length mismatch and the comparison leaks
 * neither the token nor its length. Every configured token is compared — no
 * early exit — so the timing does not say which one matched either. */
export function betaTokenMatches(presented, env = process.env) {
  const tokens = betaTokens(env);
  if (tokens.length === 0 || typeof presented !== "string" || !presented) return false;
  const digest = (s) => createHash("sha256").update(s).digest();
  const mine = digest(presented);
  let matched = false;
  for (const t of tokens) {
    if (timingSafeEqual(mine, digest(t))) matched = true;
  }
  return matched;
}

/**
 * The entitlement a request gets once its beta header is considered:
 * unchanged without a valid token, else `{ ...ent, plan: max(plan, "pro"),
 * beta: true }`. `enforced`, `userId` and `email` are untouched, so a
 * signed-in tester is still metered and billed as themselves.
 */
export function withBetaGrant(ent, req, env = process.env) {
  const presented = headerOf(req, BETA_HEADER);
  if (!presented || !betaTokenMatches(presented, env)) return ent;
  const plan = planRank(ent?.plan) >= planRank("pro") ? ent.plan : "pro";
  return { ...ent, plan, beta: true };
}

// ── free-tier metering ─────────────────────────────────────────────────
// Only IDENTIFIED free accounts are metered. Anonymous callers are counted by
// nothing, exactly as before entitlement existed, because the local server has
// no account to meter and Sam running it with no sign-in must be unaffected.

const SOURCE_SEARCH_KIND = "source_search";
const CHECK_KIND = "check";
const AI_KIND = "ai"; // the desktop's app routes — never shares a count with "check"
const FLOW_KIND = "flow";
/* Micro-cent totals, not call counts (usageAdd). Kinds of their own so an
 * operator summing a pool's "spend_ucents" (lib/spend.js) never adds an
 * account's spend in twice: the pools are "__global*__" accounts, these are
 * "user:" / "install:" ones. */
const ACCOUNT_SPEND_KIND = "account_ucents";
const THOROUGH_KIND = "thorough_ucents";

/* ── day rows and month rows ──────────────────────────────────────────────
 * Monthly counters live in the same entitlement_usage table as the daily
 * ones, under day = "YYYY-MM" (usageMonth) instead of "YYYY-MM-DD" (usageDay).
 * The column is TEXT and the two shapes can never be equal, so no migration
 * and no collision. Every reader matches the key EXACTLY (db.js usageCount;
 * spend.js reads its pools by usageDay) — nothing sums or prunes a range of
 * days — so a month row is invisible to every daily reader, and vice versa.
 * Keep it that way: a reader that ever does `day LIKE '2026-09%'` must
 * exclude the 7-character month keys. */

/**
 * The identity a quota counts against, as a namespaced string.
 *
 * Preference order, and the reason for each rung:
 *
 *  1. `user:<supabase id>` — the only identity we control. A signed-in caller
 *     is metered exactly as before this function existed.
 *  2. `install:<hash>` — an id the extension generates once and stores in
 *     chrome.storage.local, sent as X-Tracely-Install. CLIENT-SUPPLIED, so a
 *     determined attacker rotates it freely; it is here because it correctly
 *     separates honest users who share an address, which is the common case.
 *     Hashed so a log line never carries a raw client identifier.
 *  3. `addr:<hash>` — last resort, and deliberately NOT used for a daily
 *     quota anywhere. See the note in shared/guards.js: a few hundred real
 *     students behind one school or CGNAT address are indistinguishable from
 *     one attacker behind it, so an address-keyed DAILY cap either locks out
 *     the school or does nothing. It is a rate-limit key only.
 *
 * Returns null when there is nothing to key on at all, which means "do not
 * meter" — the same answer a local run gets.
 */
export function callerId(req, ent) {
  if (ent?.userId) return `user:${ent.userId}`;
  const install = headerOf(req, "x-tracely-install");
  if (install) return `install:${shortHash(install)}`;
  const addr = clientAddress(req);
  return addr ? `addr:${shortHash(addr)}` : null;
}

/** Whether this caller id can carry a DAILY quota (see rung 3 above). */
export function isDailyQuotaKey(id) {
  return typeof id === "string" && !id.startsWith("addr:");
}

function headerOf(req, name) {
  const v = req?.headers?.[name];
  const s = Array.isArray(v) ? v[0] : v;
  const trimmed = String(s ?? "").trim();
  // Bounded: a header is attacker-controlled, and an unbounded one would be
  // hashed into a map key.
  return trimmed && trimmed.length <= 200 ? trimmed : "";
}

/**
 * The client address, honouring X-Forwarded-For ONLY when the operator says a
 * proxy is in front of us.
 *
 * TRACELY_TRUSTED_PROXY_HOPS is the number of proxies WE control, counted from
 * the right of the header. Without it the header is ignored entirely, because
 * X-Forwarded-For is set by the client on a direct connection — trusting it
 * unconditionally would let anyone mint a fresh rate-limit key per request,
 * which is worse than having no key at all.
 */
export function clientAddress(req) {
  const hops = Number(process.env.TRACELY_TRUSTED_PROXY_HOPS);
  if (Number.isInteger(hops) && hops > 0) {
    const chain = headerOf(req, "x-forwarded-for").split(",").map((p) => p.trim()).filter(Boolean);
    /* Each proxy APPENDS the peer it saw, so the header reads
     *   [ anything the client chose to send..., what proxy 1 saw, ... ]
     * and with `hops` proxies of our own the last trustworthy entry is
     * chain[length - hops]. Everything to its LEFT is attacker-controlled.
     *
     * This was chain[length - hops - 1], one position too far left, which
     * landed squarely ON the attacker-controlled part: a client sending
     * `X-Forwarded-For: 1.1.1.1` got 1.1.1.1 back as its rate-limit key and
     * could mint a fresh one per request — the exact thing the hop count
     * exists to prevent.
     *
     * hops=1, [client]            -> chain[0] = client
     * hops=1, [spoof, real]       -> chain[1] = real
     * hops=2, [client, proxy1]    -> chain[0] = client
     */
    const idx = chain.length - hops;
    if (idx >= 0 && idx < chain.length) return chain[idx];
    // Fewer entries than declared hops: the header cannot be what we expect,
    // so believe the socket rather than a guess.
  }
  return req?.socket?.remoteAddress || "";
}

function shortHash(v) {
  return createHash("sha256").update(String(v)).digest("hex").slice(0, 32);
}

/** Whether this caller is metered at all: an enforced server and a key that can carry a quota. */
function metered(ent, id) {
  // Unenforced (no Supabase configured) is the local run: meter nothing, the
  // same answer this server gave before entitlement existed. No key, or an
  // address-only key: nothing that can carry a quota without locking out a
  // shared school address — the global budget in lib/spend.js bounds those.
  return Boolean(ent?.enforced) && isDailyQuotaKey(id);
}

/**
 * Where an account stands against one daily quota.
 * `limit: null` means unmetered — a plan with no limit for this kind, an
 * anonymous caller, or a server with no Supabase configured.
 *
 * The limit is the EFFECTIVE plan's (effectivePlan): a paid account over its
 * fair-use limit is metered at Free's numbers until the limit resets.
 */
function dailyQuota(ent, id, kind, limitFor, at) {
  const day = usageDay(at);
  if (!metered(ent, id)) return { limit: null, used: 0, allowed: true, day };
  const limit = limitFor(effectivePlan(ent, id, at));
  if (limit === null) return { limit: null, used: 0, allowed: true, day };
  const used = usageCount(id, day, kind);
  return { limit, used, allowed: withinDailyLimit(used, limit), day };
}

/**
 * Where a caller stands against its daily source-search quota.
 *
 * `id` comes from callerId(req, ent). It used to be ent.userId, which made
 * every anonymous caller unmetered — and since the extension needs no
 * sign-in, anonymous is the DEFAULT path, so on a hosted server that meant
 * unlimited 1-cent web searches to anyone with curl.
 */
/*
 * Source searches are limited per day AND per month (SOURCE_LIMITS), and the
 * extension's /api/sources and the desktop's /api/find-sources draw on this
 * one count. `limit` / `used` stay the DAY's numbers (the shape every caller
 * already reads); `monthLimit` / `monthUsed` are the month row's (usageMonth).
 * `allowed` needs both. `blockedBy` says which ran out — "month" wins when
 * both have, since it resets later — and `resetsOn` ("YYYY-MM-DD") when.
 */
export function sourceSearchQuota(ent, id, at = Date.now()) {
  const day = usageDay(at);
  const month = usageMonth(at);
  if (!metered(ent, id)) {
    return { limit: null, used: 0, allowed: true, day, month, monthLimit: null, monthUsed: 0, blockedBy: null, resetsOn: null };
  }
  const plan = effectivePlan(ent, id, at);
  const limit = dailySourceSearchLimit(plan);
  const monthLimit = monthlySourceSearchLimit(plan);
  const used = usageCount(id, day, SOURCE_SEARCH_KIND);
  const monthUsed = usageCount(id, month, SOURCE_SEARCH_KIND);
  const blockedBy = !withinDailyLimit(monthUsed, monthLimit) ? "month" : !withinDailyLimit(used, limit) ? "day" : null;
  const resetsOn = blockedBy === "month" ? nextMonthStart(at) : blockedBy === "day" ? nextUsageDay(at) : null;
  return { limit, used, allowed: blockedBy === null, day, month, monthLimit, monthUsed, blockedBy, resetsOn };
}

/** Stamped BEFORE the search, like every other counter here: bumps the day row and the month row, returns the new DAY count. */
export function recordSourceSearch(ent, id, at = Date.now()) {
  const q = sourceSearchQuota(ent, id, at);
  if (q.limit === null) return 0;
  usageBump(id, q.month, SOURCE_SEARCH_KIND);
  return usageBump(id, q.day, SOURCE_SEARCH_KIND);
}

/** The same, for checks — the hot path, one per 10s while someone types. */
export function checkQuota(ent, id, at = Date.now()) {
  return dailyQuota(ent, id, CHECK_KIND, dailyCheckLimit, at);
}

export function recordCheck(ent, id, at = Date.now()) {
  const q = checkQuota(ent, id, at);
  if (q.limit === null) return 0;
  return usageBump(id, q.day, CHECK_KIND);
}

/* The desktop's AI calls. Same rungs and same rules as checks — unenforced and
 * address-only callers are unmetered, paid plans are unmetered — under a kind
 * of their own so the two products never draw on one allowance. */
export function aiQuota(ent, id, at = Date.now()) {
  return dailyQuota(ent, id, AI_KIND, dailyAiLimit, at);
}

export function recordAi(ent, id, at = Date.now()) {
  const q = aiQuota(ent, id, at);
  if (q.limit === null) return 0;
  return usageBump(id, q.day, AI_KIND);
}

/* Flow checks (/api/flow), a usage kind of their own (DAILY_FLOW). Metered on
 * every plan, keyed and gated like checks. The 120 s per-caller floor
 * (FLOW_MIN_INTERVAL_MS) is a rate limiter in server.js, not a counter here. */
export function flowQuota(ent, id, at = Date.now()) {
  return dailyQuota(ent, id, FLOW_KIND, dailyFlowLimit, at);
}

export function recordFlow(ent, id, at = Date.now()) {
  const q = flowQuota(ent, id, at);
  if (q.limit === null) return 0;
  return usageBump(id, q.day, FLOW_KIND);
}

// ── per-account spend and the fair-use limit ───────────────────────────
/* What one caller's model calls cost, in micro-cents, on its day row and its
 * month row: the input to the fair-use limit (FAIR_USE) and the evidence when
 * someone asks why their account dropped to Free limits. server.js charges
 * every call here with the cost recordSpend returned, whichever pool paid.
 *
 * Recorded for every key that can carry a quota ("user:" and "install:"), so
 * the operator can compare real per-account spend with the usage model; the
 * LIMIT applies only to signed-in paid accounts (effectivePlan). Address keys
 * and null are not recorded, for the reason they carry no quota. */
export function accountSpend(id, at = Date.now()) {
  if (!isDailyQuotaKey(id)) return { dayMicroCents: 0, monthMicroCents: 0, day: usageDay(at), month: usageMonth(at) };
  const day = usageDay(at);
  const month = usageMonth(at);
  return {
    dayMicroCents: usageCount(id, day, ACCOUNT_SPEND_KIND),
    monthMicroCents: usageCount(id, month, ACCOUNT_SPEND_KIND),
    day,
    month,
  };
}

/** Adds one call's cost to the caller's day and month rows; returns the new totals. Nothing is written for a zero cost (an unenforced server's recordSpend returns 0). */
export function recordAccountSpend(id, microCents, at = Date.now()) {
  if (!isDailyQuotaKey(id) || !(Number(microCents) > 0)) return accountSpend(id, at);
  const day = usageDay(at);
  const month = usageMonth(at);
  return {
    dayMicroCents: usageAdd(id, day, ACCOUNT_SPEND_KIND, microCents),
    monthMicroCents: usageAdd(id, month, ACCOUNT_SPEND_KIND, microCents),
    day,
    month,
  };
}

/**
 * Where a caller stands against its fair-use limit:
 * `{ state, resetsOn, limits, dayMicroCents, monthMicroCents }`.
 *
 * `state` is null when no limit applies — an unenforced server, a free plan
 * (it has quotas instead), a beta tester (the beta pool and
 * betaWebSearchesPerHour bound them), or a key that carries no quota. Else
 * "ok", "day" (over today's limit: resets at local midnight) or "month" (over
 * this month's: resets on the 1st). Month wins when both are over, since it
 * resets later. `limits` are in micro-cents.
 */
export function fairUseState(ent, id, at = Date.now()) {
  const none = { state: null, resetsOn: null, limits: null, dayMicroCents: 0, monthMicroCents: 0 };
  if (!metered(ent, id) || ent.beta) return none;
  const usd = fairUseLimits(ent.plan);
  if (!usd) return none;
  const limits = { day: Math.round(usd.day * MICRO_CENTS_PER_USD), month: Math.round(usd.month * MICRO_CENTS_PER_USD) };
  const { dayMicroCents, monthMicroCents } = accountSpend(id, at);
  const state = monthMicroCents >= limits.month ? "month" : dayMicroCents >= limits.day ? "day" : "ok";
  const resetsOn = state === "month" ? nextMonthStart(at) : state === "day" ? nextUsageDay(at) : null;
  return { state, resetsOn, limits, dayMicroCents, monthMicroCents };
}

/**
 * The plan a caller is METERED and ROUTED at right now: `ent.plan`, except
 * that a paid, non-beta account over its fair-use limit acts as "free" until
 * the limit resets (midnight for the day's, the 1st for the month's).
 *
 * Never a refusal beyond what Free gets, and never a change to the plan
 * itself — billing, /api/entitlement's `plan` and the account are untouched;
 * the quotas (checkQuota, sourceSearchQuota, ...) and modelForRoute read this
 * instead, so Pro's Thorough allowance is off for the same period.
 */
export function effectivePlan(ent, id, at = Date.now()) {
  const plan = ent?.plan ?? DEFAULT_PLAN;
  const { state } = fairUseState(ent, id, at);
  return state === "day" || state === "month" ? DEFAULT_PLAN : plan;
}

// ── Pro's Thorough allowance ───────────────────────────────────────────
/* A MONTHLY allowance of thorough-model spend at API cost
 * (THOROUGH_MONTHLY_USD), keyed on the caller id — `user:<id>`, or
 * `install:<hash>` for an anonymous beta tester, whose grant is Pro — on a
 * "YYYY-MM" month row. It resets on the 1st (usageMonth, UTC). Calls in flight
 * hold their worst case (sized from the prompt, at least
 * THOROUGH_RESERVE_USD) under "thorough:<id>" in
 * lib/spend.js, so a burst cannot all be admitted against the same unspent
 * allowance. */
const thoroughHoldKey = (id) => `thorough:${id}`;

/**
 * `{ allowanceMicroCents, usedMicroCents, reservedMicroCents, remainingPct,
 * resetsOn, suspended }` for one caller this month.
 *
 * `allowanceMicroCents` is 0 for a plan without one (free, student) and for a
 * caller no allowance can be keyed on (an address, or nobody). `remainingPct`
 * is a whole percent, 0-100, of the allowance not yet SPENT (floored, so 100
 * means untouched) — what the meter shows; it ignores holds, which last one
 * request. `suspended` is true while the account is over its fair-use limit,
 * when the allowance is off (effectivePlan). `resetsOn` is "YYYY-MM-DD".
 */
export function thoroughState(ent, id, at = Date.now()) {
  const resetsOn = nextMonthStart(at);
  const keyed = isDailyQuotaKey(id);
  const allowanceMicroCents = keyed ? Math.round(thoroughMonthlyUsd(ent?.plan) * MICRO_CENTS_PER_USD) : 0;
  const usedMicroCents = keyed && ent?.enforced ? usageCount(id, usageMonth(at), THOROUGH_KIND) : 0;
  const reservedMicroCents = keyed ? reservedAccountMicroCents(thoroughHoldKey(id)) : 0;
  const remainingPct = allowanceMicroCents > 0
    ? Math.max(0, Math.min(100, Math.floor((100 * (allowanceMicroCents - usedMicroCents)) / allowanceMicroCents)))
    : 0;
  const suspended = allowanceMicroCents > 0 && effectivePlan(ent, id, at) !== (ent?.plan ?? DEFAULT_PLAN);
  return { allowanceMicroCents, usedMicroCents, reservedMicroCents, remainingPct, resetsOn, suspended };
}

/** Charges one thorough call's cost (recordSpend's return) to the caller's month row; returns the new month total. */
export function recordThorough(id, microCents, at = Date.now()) {
  const month = usageMonth(at);
  if (!isDailyQuotaKey(id) || !(Number(microCents) > 0)) return isDailyQuotaKey(id) ? usageCount(id, month, THOROUGH_KIND) : 0;
  return usageAdd(id, month, THOROUGH_KIND, microCents);
}

/**
 * Admission to the thorough model for ONE call: a hold on the allowance
 * (lib/spend.js reserveAccount — `release()` it in a `finally`, after
 * recordThorough), or null, meaning run the same call on the fast model.
 * Never a refusal.
 *
 * Admitted only when all of these hold:
 *  - the server is enforced and the caller has a key (an unenforced local run
 *    chooses its model with pickModel and never asks);
 *  - `route` is a thorough route, the EFFECTIVE plan reaches thorough (so an
 *    account over its fair-use limit gets fast), and `requested` asks for the
 *    thorough tier (wantsThorough);
 *  - the allowance minus what is spent minus every hold in flight still
 *    covers this call's worst case (`worstMicroCents`, sized from its prompt's
 *    bytes and its maxTokens; at least THOROUGH_RESERVE_USD) — so the
 *    allowance cannot be overshot by calls that stay inside their maxTokens.
 * Check-and-hold is synchronous, so two requests cannot both be admitted
 * against the same remainder.
 */
export function reserveThorough(ent, id, route, { requested, worstMicroCents = null, at = Date.now() } = {}) {
  if (!metered(ent, id)) return null;
  if (!wantsThorough(route, effectivePlan(ent, id, at), requested)) return null;
  // `worstMicroCents`: this call's own worst case, sized from its prompt
  // (server.js thoroughWorstMicroCents); never below the route's fixed floor.
  const floor = Math.round((THOROUGH_RESERVE_USD[route] ?? 0) * MICRO_CENTS_PER_USD);
  const worst = Math.max(floor, Number.isFinite(worstMicroCents) ? Math.round(worstMicroCents) : 0);
  if (!(worst > 0)) return null;
  const s = thoroughState(ent, id, at);
  if (s.allowanceMicroCents - s.usedMicroCents - s.reservedMicroCents < worst) return null;
  return reserveAccount(thoroughHoldKey(id), worst);
}
