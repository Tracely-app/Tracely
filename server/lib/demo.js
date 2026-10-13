/**
 * "Try Tracely": the public, capped demo document at /try.
 *
 * A page this server hosts (public/try.html) runs the extension's own engine
 * (content.js, served as /ext-content.js) over an editable sample essay, and
 * its calls come here through three routes of their own — /api/demo/check,
 * /api/demo/sources and /api/demo/review — which server.js aliases into the
 * /api/check, /api/sources and /api/review handlers after demoGate.
 *
 * Who may spend, and how much (server.js demoGate, in order):
 *   1. TRACELY_DEMO_SECRET shorter than 32 characters (empty, "off", or the
 *      "# off" an inline comment leaves), or TRACELY_DEMO_DAILY_BUDGET_USD
 *      set to anything but a positive number ("0", "0 # off", "off", "-1"):
 *      the try-out is OFF (503 demo_closed). Never a per-boot random
 *      secret — a restart would then hand every visitor a fresh allowance.
 *   2. A signed visitor cookie, minted by GET /try: `tracely_demo=<id>.<mac>`.
 *      Missing or forged on an API call: 403 demo_session.
 *   3. The caller is `demo:<sha256(id)>` at the FREE plan, enforced even on a
 *      box with no Supabase: the fast model, "Explain in depth" refused, the
 *      beta header ignored.
 *   4. The "demo" pool (lib/spend.js): asked in the gate, and reserved only
 *      once the body is read (demoAdmit) — a reservation taken before would
 *      be held by a body sent a byte a second. Spent is 503 demo_closed,
 *      NEVER the extension pool; full of calls in flight is 503 demo_busy.
 *   5. A per-visitor daily allowance (demo_check / demo_sources /
 *      demo_review usage rows), checked after the body is read and stamped
 *      just before the model call: over is 429 demo_limit.
 *   6. Rolling per-address windows, never a daily count (schools share one
 *      address): calls an hour, and dollars an hour — a share of the pool,
 *      counting what the address's calls in flight hold.
 *   7. The try-out's own hourly web-search window.
 *   8. Text caps well under the extension's (SPEND.demoMax*): 400.
 *
 * The cookie is fairness for honest visitors, not a cap: reloading /try in a
 * private window mints a fresh one. The pool and the per-address window are
 * what bound spend. Nothing here stores text; the usage rows are counts under
 * a hashed id, swept with every other usage row after 13 months.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { usageCount, usageBump } from "./db.js";
import { dailyBudgetMicroCents, poolRoom } from "./spend.js";
import { CheckError } from "./errors.js";
import { SPEND } from "../shared/guards.js";
import { usageDay } from "../shared/plan.js";

export const DEMO_COOKIE = "tracely_demo";
export const DEMO_COOKIE_MAX_AGE_S = 86_400;
const ID_BYTES = 16;

export const DEMO_MESSAGES = {
  off: "The try-out isn't available right now.",
  spent: "The try-out has reached its limit for today. It comes back at midnight.",
  session: "Your try-out session has expired. Reload the page to start again.",
  sourcesPaused: "Source search is paused on the try-out for today. Checking still works.",
  busy: "The try-out is busy on your network right now. Try again in a little while.",
  poolBusy: "The try-out is busy — try again in a minute.",
  searchesBusy: "Source search on the try-out is busy right now. Try again in a few minutes.",
};

/** The HMAC key as configured ("" when unset). Re-read per request. Under
 * DEMO_SECRET_MIN_CHARS it switches the try-out off (demoOff): the
 * documented `openssl rand -hex 32` is 64. */
export function demoSecret(env = process.env) {
  return String(env.TRACELY_DEMO_SECRET ?? "").trim();
}
export const DEMO_SECRET_MIN_CHARS = 32;

/** The try-out page's own origin (e.g. https://api.jointracely.com), or null. */
export function demoPublicOrigin(env = process.env) {
  const v = String(env.TRACELY_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/\s]+$/i.test(v) ? v : null;
}

// ── the visitor cookie ──────────────────────────────────────────────────
const mac = (secret, id) => createHmac("sha256", secret).update(`tracely-demo.${id}`, "utf8").digest();

/** A fresh visitor: a random id and its signed cookie value. */
export function mintVisitor(secret) {
  const id = randomBytes(ID_BYTES).toString("base64url");
  return { id, value: `${id}.${mac(secret, id).toString("base64url")}` };
}

/** The visitor id a cookie value proves, or null. lib/billing.js's pattern:
 * the comparison is timingSafeEqual, behind a length check we chose rather
 * than the exception it throws on a mismatch. */
export function verifyVisitor(value, secret) {
  if (!secret || typeof value !== "string" || value.length > 128) return null;
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return null;
  const expected = mac(secret, m[1]);
  const given = Buffer.from(m[2], "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected) ? m[1] : null;
}

/** One cookie's value from a Cookie header — a bounded parse, first match wins. */
export function readCookie(header, name = DEMO_COOKIE) {
  if (typeof header !== "string" || !header) return null;
  const pairs = header.slice(0, 8192).split(";", 64);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

/** The visitor id this request carries, or null (no secret, no cookie, forged). */
export function visitorOf(req, env = process.env) {
  return verifyVisitor(readCookie(req?.headers?.cookie), demoSecret(env));
}

/** The Set-Cookie value for a visitor. Secure + SameSite=Lax: sent inside the
 * www.jointracely.com iframe (same site), never with a cross-site POST. */
export function visitorCookie(value) {
  return `${DEMO_COOKIE}=${value}; Path=/; Max-Age=${DEMO_COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`;
}

/** The quota key: hashed, so no log line or usage row carries the cookie. */
export function demoCallerId(visitorId) {
  return `demo:${createHash("sha256").update(String(visitorId)).digest("hex")}`;
}

/** The per-address window's key (a hash of server.js clientAddress). */
export function demoAddressKey(address) {
  return `demo-addr:${createHash("sha256").update(String(address ?? "")).digest("hex").slice(0, 32)}`;
}

// ── limits ───────────────────────────────────────────────────────────────
/* A whole number from the environment: empty or junk is the default (as the
 * budgets read), an explicit non-negative integer is used as given. */
function intFromEnv(env, variable, fallback) {
  const text = String(env[variable] ?? "").trim();
  if (!text) return fallback;
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** What one visitor gets per day, and the longest text a demo call takes. */
export function demoLimits(env = process.env) {
  return {
    check: intFromEnv(env, "TRACELY_DEMO_CHECKS", SPEND.demoChecksPerVisitor),
    sources: intFromEnv(env, "TRACELY_DEMO_SOURCES", SPEND.demoSourcesPerVisitor),
    review: intFromEnv(env, "TRACELY_DEMO_REVIEWS", SPEND.demoReviewsPerVisitor),
    maxChars: SPEND.demoMaxChars,
  };
}

/**
 * Why the try-out is switched off, or null when it is on:
 *   "no_secret"     TRACELY_DEMO_SECRET unset or empty;
 *   "short_secret"  under DEMO_SECRET_MIN_CHARS — "off", "0", or the "# off"
 *                   that `TRACELY_DEMO_SECRET= # off` leaves (loadEnvFile
 *                   keeps an inline comment as the value);
 *   "budget"        TRACELY_DEMO_DAILY_BUDGET_USD set to anything but a
 *                   positive number — "0" (which every other pool reads as
 *                   "no ceiling"), "0 # off", "off", "false", "-1", "$0" —
 *                   or one that rounds to nothing. Only an absent or empty
 *                   value is the default $2: the other pools read junk as
 *                   their default, but here a value an operator wrote to
 *                   switch a public page off must never leave it on.
 */
export function demoOffReason(env = process.env) {
  const secret = demoSecret(env);
  if (!secret) return "no_secret";
  if (secret.length < DEMO_SECRET_MIN_CHARS) return "short_secret";
  const raw = String(env.TRACELY_DEMO_DAILY_BUDGET_USD ?? "").trim();
  if (raw && !(Number.isFinite(Number(raw)) && Number(raw) > 0)) return "budget";
  return dailyBudgetMicroCents(env, "demo") <= 0 ? "budget" : null;
}

/** True when the try-out is switched off (demoOffReason). */
export function demoOff(env = process.env) {
  return demoOffReason(env) !== null;
}

/**
 * The demo pool's admission, asked by demoGate and again by demoAdmit just
 * before it reserves. Room: the day's spend state. A SPENT day: 503
 * demo_closed ("comes back at midnight" — the page closes for the session).
 * No room only because of calls in flight: 503 demo_busy. Those calls end in
 * seconds and release what they hold, so the page must not close for it.
 */
export function demoPoolAdmission(env = process.env, at = Date.now()) {
  const { budget, room } = poolRoom({ enforced: true, pool: "demo", at, env });
  if (room) return budget;
  if (!budget.allowed) throw new CheckError("demo_closed", DEMO_MESSAGES.spent, { status: 503 });
  throw new CheckError("demo_busy", DEMO_MESSAGES.poolBusy, { status: 503, retryAfter: 60 });
}

/** The next local midnight, when the pool and the allowances reset. */
export function demoResetAt(at = Date.now()) {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
}

export const DEMO_USAGE_KINDS = { check: "demo_check", sources: "demo_sources", review: "demo_review" };

/** Today's demo calls by one caller id, per kind. */
export function demoUsed(id, at = Date.now()) {
  const day = usageDay(at);
  return Object.fromEntries(Object.entries(DEMO_USAGE_KINDS).map(([k, kind]) => [k, usageCount(id, day, kind)]));
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const LIMIT_MESSAGES = {
  check: (n) => `That's the try-out: you've used your ${plural(n, "check", "checks")} for today. Install Tracely free to keep going.`,
  sources: (n) => `You've used your ${plural(n, "source search", "source searches")} for this try-out. Checks still work.`,
  review: (n) => `You've used your ${plural(n, "writing review", "writing reviews")} for this try-out. Checks still work.`,
};
const fmt = (n) => n.toLocaleString("en-US");

/**
 * Admission for one demo call, AFTER the route has read and validated its
 * body: the text caps (400), then the visitor's allowance for `gate.demo.kind`
 * (429 demo_limit), then the pool (demoPoolAdmission) — and only then the
 * pool reservation, `gate.demo.reserve()` (server.js demoReservation: one
 * call's worst case, counted under the address's dollar window too, which
 * may 429), as `gate.reservation`: extensionModel shrinks it, a split or an
 * extra shard extends it, and the handler's `finally` releases it. Stamps no
 * allowance — demoRecord does, just before the model call, so a request
 * refused on the way (a 400, the review route's once-a-minute window, an
 * hourly search window) never uses up an allowance. The handlers make no
 * await between this and the model call, so concurrent requests cannot both
 * take the last allowance or the last of the pool.
 */
export function demoAdmit(gate, { text, sentences, context, claim, correction } = {}, env = process.env) {
  const { kind } = gate.demo;
  const tooLong = `The try-out checks up to ${fmt(SPEND.demoMaxChars)} characters at a time. Shorten the text and try again.`;
  if ((kind === "check" || kind === "review") && typeof text === "string" && text.length > SPEND.demoMaxChars) {
    throw new CheckError("bad_request", tooLong);
  }
  if (kind === "check" && Array.isArray(sentences) && sentences.length > SPEND.demoMaxSentences) {
    throw new CheckError("bad_request", `The try-out checks up to ${SPEND.demoMaxSentences} sentences at a time. Shorten the text and try again.`);
  }
  /* What a check SENDS the model is the sentences, with `text` as context —
   * so the cap must hold for them too, or a short `text` carries 40
   * sentences of 2,000 characters (80,000 characters, five shards of ~16 KB).
   * content.js cuts every sentence out of the text it sends, so an honest
   * check's sentences are all in it and can add up to no more than it. */
  if (kind === "check" && Array.isArray(sentences)) {
    const list = sentences.map((s) => (typeof s?.text === "string" ? s.text : ""));
    const total = list.reduce((n, t) => n + t.length, 0);
    if (total > SPEND.demoMaxChars || list.some((t) => typeof text !== "string" || !text.includes(t))) {
      throw new CheckError("bad_request", tooLong);
    }
  }
  if (kind === "sources" && typeof context === "string" && context.length > SPEND.demoMaxContextChars) {
    throw new CheckError("bad_request", `The try-out sends up to ${fmt(SPEND.demoMaxContextChars)} characters of context with a source search.`);
  }
  if (kind === "sources" && ((typeof claim === "string" && claim.length > SPEND.demoMaxClaimChars) ||
      (typeof correction === "string" && correction.length > SPEND.demoMaxClaimChars))) {
    throw new CheckError("bad_request", `The try-out finds sources for a sentence of up to ${fmt(SPEND.demoMaxClaimChars)} characters.`);
  }
  const limit = demoLimits(env)[kind];
  if (demoUsed(gate.callerId)[kind] >= limit) {
    // `feature` rides on the error body (server.js), so the page knows WHICH
    // allowance ran out: out of sources, checks still work.
    const err = new CheckError("demo_limit", LIMIT_MESSAGES[kind](limit), { status: 429 });
    err.feature = kind;
    throw err;
  }
  demoPoolAdmission(env);
  gate.reservation = gate.demo.reserve();
}

/** Stamps one demo call against the visitor's allowance — before the call. */
export function demoRecord(gate, at = Date.now()) {
  return usageBump(gate.callerId, usageDay(at), DEMO_USAGE_KINDS[gate.demo.kind]);
}

/**
 * GET /api/demo/status: whether the try-out is open, what this visitor has
 * left today, the limits, and when both reset. Off (no secret, budget 0): a
 * 200 with open:false, so the page can say so. On, with no valid cookie:
 * 403 demo_session, like every other demo route. `open` is the DAY: false
 * only when the pool is spent (or the try-out off), because the page closes
 * for the session on it. `busy` (only when true) is a pool whose room is
 * taken by calls in flight — seconds, not the day. `sourcesPaused` (only
 * when true) is the pool's 20% line: checks go on, source search does not.
 */
export function demoStatus(req, env = process.env, at = Date.now()) {
  const limits = demoLimits(env);
  const resetAt = demoResetAt(at);
  if (demoOff(env)) return { open: false, left: { check: 0, sources: 0, review: 0 }, limits, resetAt };
  const visitor = visitorOf(req, env);
  if (!visitor) throw new CheckError("demo_session", DEMO_MESSAGES.session, { status: 403 });
  const used = demoUsed(demoCallerId(visitor), at);
  const { budget, room } = poolRoom({ enforced: true, pool: "demo", at, env });
  const left = Object.fromEntries(Object.keys(DEMO_USAGE_KINDS).map((k) => [k, Math.max(0, limits[k] - used[k])]));
  const open = budget.allowed;
  return { open, left, limits, resetAt, ...(open && !room ? { busy: true } : {}), ...(open && !budget.sourcesAllowed ? { sourcesPaused: true } : {}) };
}
