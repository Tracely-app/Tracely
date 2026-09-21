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
import { createHash } from "node:crypto";
import { usageCount, usageBump } from "./db.js";
import {
  DEFAULT_PLAN,
  planFromMetadata,
  usageDay,
  dailySourceSearchLimit,
  dailyCheckLimit,
  dailyAiLimit,
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

// ── free-tier metering ─────────────────────────────────────────────────
// Only IDENTIFIED free accounts are metered. Anonymous callers are counted by
// nothing, exactly as before entitlement existed, because the local server has
// no account to meter and Sam running it with no sign-in must be unaffected.

const SOURCE_SEARCH_KIND = "source_search";
const CHECK_KIND = "check";
const AI_KIND = "ai"; // the desktop's app routes — never shares a count with "check"

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

/**
 * Where an account stands against its daily source-search quota.
 * `limit: null` means unmetered — a paid plan, an anonymous caller, or a
 * server with no Supabase configured.
 */
function dailyQuota(ent, id, kind, limitFor, at) {
  const day = usageDay(at);
  // Unenforced (no Supabase configured) is the local run: meter nothing, the
  // same answer this server gave before entitlement existed.
  if (!ent?.enforced) return { limit: null, used: 0, allowed: true, day };
  // No key, or an address-only key: nothing that can carry a daily quota
  // without locking out a shared school address. The global budget in
  // lib/spend.js is what bounds these callers.
  if (!id || !isDailyQuotaKey(id)) return { limit: null, used: 0, allowed: true, day };
  const limit = limitFor(ent.plan);
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
export function sourceSearchQuota(ent, id, at = Date.now()) {
  return dailyQuota(ent, id, SOURCE_SEARCH_KIND, dailySourceSearchLimit, at);
}

/** Stamped BEFORE the search, like every other counter in this codebase. */
export function recordSourceSearch(ent, id, at = Date.now()) {
  const q = sourceSearchQuota(ent, id, at);
  if (q.limit === null) return 0;
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
