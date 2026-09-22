/**
 * Which plan an account is on, and what that entitles it to.
 *
 * The server half of the same vocabulary the desktop app carries in
 * src/shared/plan.ts. Both sides must agree on the words and on the
 * precedence, so this file is a deliberate mirror of that one — change one
 * and change the other.
 *
 * **`free` is the answer to every question this module cannot answer.** No
 * token, an expired token, a metadata field holding something nobody
 * anticipated, a read that threw — all of it is `free`. Guessing high spends
 * the top model on an account that is not paying for it; guessing low shows a
 * paying user an upgrade prompt they can clear by signing in again. Only one
 * of those is recoverable.
 *
 * A leaf: no imports at all, so tests and the browser can both load it.
 */

/** Cheapest first. The order IS the entitlement ordering — see planRank. */
export const PLANS = ["free", "student", "pro"];

export const DEFAULT_PLAN = "free";

export function isPlan(value) {
  return typeof value === "string" && PLANS.includes(value);
}

/**
 * Anything at all, narrowed to a plan. Case and surrounding space are forgiven
 * because the value is written by whatever provisions the subscription rather
 * than by this server; a stored `"Pro "` is the same intent as `"pro"`.
 */
export function normalizePlan(value) {
  if (typeof value !== "string") return DEFAULT_PLAN;
  const normalized = value.trim().toLowerCase();
  return isPlan(normalized) ? normalized : DEFAULT_PLAN;
}

export function planRank(plan) {
  const i = PLANS.indexOf(plan);
  return i === -1 ? 0 : i;
}

/**
 * The plan a Supabase user carries, read from `app_metadata` and NOWHERE ELSE.
 *
 * `app_metadata` is the half of a Supabase user only the service role can
 * write, so it is the half the Stripe webhook can be trusted to have set.
 *
 * **`user_metadata` is not read at all, not even as a fallback.** It is
 * writable by the account holder — one `PUT /auth/v1/user` with their own
 * access token and `{"data":{"plan":"pro"}}` sets it — so any path that reads
 * it is a self-service upgrade button. "Only as a fallback when app_metadata
 * is silent" is not a safe qualifier: an account that has never been through
 * the Stripe webhook has NO app_metadata.plan, which is every free account, so
 * the fallback would be the only source consulted for exactly the users who
 * have not paid. There are no legacy accounts to rescue — this vocabulary
 * shipped with the webhook that writes it.
 *
 * Absent, junk, or a non-object: all `free`.
 */
export function planFromMetadata(appMetadata) {
  if (typeof appMetadata !== "object" || appMetadata === null) return DEFAULT_PLAN;
  return normalizePlan(appMetadata.plan);
}

// ── model tiers ────────────────────────────────────────────────────────
// Named for what the reader gets rather than for a model, because the models
// behind them have been renamed twice already — and the whole set changed
// providers once. The ids here must be exactly lib/llm.js's MODEL_TIERS or a
// clamp would silently fall back to the default instead of to the plan's
// ceiling; test/models.test.js fails the build if they drift. This file stays
// a leaf (no imports) so the browser and the tests can both load it, which is
// why the mirror is pinned by a test rather than by an import.
//
// TWO tiers since the plan policy of 2026-09-21 (the decision is summarised in
// eval/models/FINDINGS.md, "Plan policy"). gpt-5.6-luna was both the most
// accurate model measured and the cheapest, so it runs every high-volume route
// on every plan. gpt-5.6-terra ("balanced") lost to luna on both measured tasks
// at ~8-10x the cost and is retired: its id is a LEGACY id below, and its price
// row stays in shared/prices.js so historical usage still prices. gpt-6-astra
// is Pro's "thorough" model, but only where it measured better (the desktop
// critique and a one-sentence "Explain in depth"), and only out of a capped
// monthly allowance — see modelForRoute.

/** Cheapest first, like PLANS. */
export const MODEL_TIERS = ["fast", "thorough"];

export const MODEL_FOR_TIER = {
  fast: "gpt-5.6-luna",
  thorough: "gpt-6-astra",
};

export const TIER_FOR_MODEL = {
  "gpt-5.6-luna": "fast",
  "gpt-6-astra": "thorough",
};

/**
 * Retired model ids that clients already in people's hands still send, and
 * the tier each one now means.
 *
 * Extension builds up to 2.19.2 send "gpt-5-nano" from the Fast stop and
 * "gpt-5.4" from Balanced; 2.19.3-2.19.5 send "gpt-5.6-terra" from Balanced;
 * desktop builds send the same ids from their MODEL_FOR_TIER. None of them can
 * be changed by a server deploy. All three mean FAST now: the tier they asked
 * for (balanced) no longer exists, and fast was the more accurate model on
 * every task the eval measured, so "the middle stop" becomes the best checker
 * rather than a dearer one.
 *
 * These ids only. Every other unrecognised id still resolves down to fast
 * (clampModel), and nothing ever RUNS a retired id: it is translated before
 * the model is chosen, priced or logged.
 */
export const LEGACY_MODEL_TIER = {
  "gpt-5-nano": "fast",
  "gpt-5.4": "fast",
  "gpt-5.6-terra": "fast",
};

/** A client's model id with a retired one (LEGACY_MODEL_TIER) translated to its tier's current model; anything else unchanged. */
export function currentModelId(requested) {
  if (typeof requested !== "string" || !Object.hasOwn(LEGACY_MODEL_TIER, requested)) return requested;
  return MODEL_FOR_TIER[LEGACY_MODEL_TIER[requested]];
}

/** The best tier each plan may reach. Only Pro reaches thorough, and only on THOROUGH_ROUTES. */
export const PLAN_MODEL_CEILING = { free: "fast", student: "fast", pro: "thorough" };

export function modelTierRank(tier) {
  const i = MODEL_TIERS.indexOf(tier);
  return i === -1 ? 0 : i;
}

export function ceilingModelFor(plan) {
  return MODEL_FOR_TIER[PLAN_MODEL_CEILING[plan] ?? PLAN_MODEL_CEILING[DEFAULT_PLAN]];
}

/** The tier a client's model id asks for (retired ids translated), or null when it names no tier. Own keys only. */
export function requestedTier(requested) {
  const id = currentModelId(requested);
  return typeof id === "string" && Object.hasOwn(TIER_FOR_MODEL, id) ? TIER_FOR_MODEL[id] : null;
}

/**
 * The model a call actually runs at: what was asked for, clamped to the plan.
 *
 * The requested model is a REQUEST, never a grant — it arrives from a prefs
 * row or an extension build that both outlive the plan current when they were
 * written, and a cancelled Pro subscription leaves `claude-opus-5` sitting in
 * SQLite. Narrowing here rather than at each call site is what makes "a stale
 * preference cannot leak a paid model" a property of one function.
 *
 * An unrecognised or absent request resolves DOWN to the fast model rather
 * than up to the plan's ceiling. The desktop app's `resolveModelTier` resolves
 * an unreadable preference up, because there the input is the user's own
 * stored tier; here the input is a string from a client we do not trust, and
 * the pre-entitlement behaviour of every route was already "unknown model →
 * the cheap default" (factcheck.js DEFAULT_MODEL). Resolving up would turn
 * "the client sent nothing" into a bill.
 *
 * A retired id an old client still sends is translated to its tier's current
 * model first (currentModelId), so it is clamped as the tier it asked for.
 * The lookup is own-keys only: "toString" or "constructor" is not a model.
 *
 * On a hosted server the routes choose with modelForRoute, which is stricter
 * (the plan ceiling applies on THOROUGH_ROUTES only); clampModel remains the
 * rule for the paid pool's fallback and for the desktop mirror's contract.
 */
export function clampModel(requested, plan) {
  const ceiling = PLAN_MODEL_CEILING[plan] ?? PLAN_MODEL_CEILING[DEFAULT_PLAN];
  const tier = requestedTier(requested);
  if (!tier) return MODEL_FOR_TIER.fast;
  return modelTierRank(tier) <= modelTierRank(ceiling) ? MODEL_FOR_TIER[tier] : MODEL_FOR_TIER[ceiling];
}

// ── the model and effort per route ─────────────────────────────────────
/* THE SERVER DECIDES, per route. The client's model and effort are NOT a
 * request on any route except the thorough-eligible ones, and there they only
 * choose between Pro's thorough and fast. Everything else runs the fast model
 * at the effort that route was measured (or pinned) at, whatever was sent —
 * so an old extension's slider, a stale desktop setting, or a curl asking for
 * gpt-6-astra at effort "high" all get the same answer.
 *
 * Route names (server.js maps each HTTP route to one):
 *   check        /api/check — typing pauses and whole documents   luna medium
 *   checkDeep    /api/check deep:true, exactly one sentence          astra low / luna medium
 *                ("Explain in depth", extension 2.20.0)
 *   flow         /api/flow                                          luna low
 *   sources      /api/sources                                       luna, NO effort sent
 *                (the vendor default — what every source search was measured at)
 *   findSources  /api/find-sources                                  luna low
 *   detect, structure, tracer, correction                           luna low
 *   critique     /api/critique                                      astra low / luna low
 *   grade        /api/grade                                         luna low (see GRADE_ON_THOROUGH)
 *
 * luna@medium on /api/check measured 100% (0 harmful verdicts) against 90% at
 * low; nothing else was measured at medium, so everything else is low (the
 * lib/llm.js default). astra was measured at low only. */
export const ROUTES = ["check", "checkDeep", "flow", "sources", "findSources", "detect", "structure", "tracer", "correction", "critique", "grade"];

/* astra grading was never measured. Flip only if the grade eval shows a gain. */
export const GRADE_ON_THOROUGH = false;

/** The routes where Pro's thorough model may run — the two places astra measured better. */
export const THOROUGH_ROUTES = new Set(["checkDeep", "critique", ...(GRADE_ON_THOROUGH ? ["grade"] : [])]);

const ROUTE_EFFORT = { check: "medium", checkDeep: "medium", sources: undefined };
const DEFAULT_ROUTE_EFFORT = "low";
const THOROUGH_EFFORT = "low";

/* The output ceiling each thorough call runs under. It is what makes its
 * worst case (THOROUGH_RESERVE_USD) a bound: astra output is $50 per 1M
 * tokens, and the routes' own ceilings (16,000) would let one call cost 80
 * cents of output alone. An explanation is a paragraph; a critique a few. */
export const THOROUGH_MAX_TOKENS = { checkDeep: 2_000, critique: 4_000 };

/* What each thorough call RESERVES against the allowance before it runs: its
 * worst case on gpt-6-astra, priced cold ($12.50/1M input as cache writes,
 * $50/1M output). checkDeep: ~4k input (one sentence + a context capped at
 * 6,000 characters + the prompt) + 2,000 out = 5 + 10 cents. critique: ~12k
 * input (claim + four abstracts + the relay prompt) + 4,000 out = 15 + 20
 * cents. A call runs on astra only while the allowance minus everything
 * already reserved still covers this, so the allowance cannot be overshot by
 * calls that stay within these bounds. */
export const THOROUGH_RESERVE_USD = { checkDeep: 0.15, critique: 0.35, grade: 0.9 };

/** Whether this route, on this plan, with this request, asks for the thorough model (before the allowance is consulted). */
export function wantsThorough(route, plan, requested) {
  if (!THOROUGH_ROUTES.has(route)) return false;
  if ((PLAN_MODEL_CEILING[plan] ?? PLAN_MODEL_CEILING[DEFAULT_PLAN]) !== "thorough") return false;
  return requestedTier(requested) === "thorough";
}

/**
 * The model, effort and output ceiling one call runs at, decided by the
 * server: `{ model, effort, maxTokens, thorough }`.
 *
 * `requested` is the client's model id. It is read ONLY on a thorough route
 * for a plan that reaches thorough, and there it only picks thorough over
 * fast — the desktop's Thorough setting (its default), or the extension's
 * "Explain in depth" (server.js passes the thorough id for deep:true).
 * `thoroughAvailable` is the allowance's answer (server.js reserves first);
 * absent means NO, so nothing reaches astra without a reservation behind it.
 * When it is false the same call runs on fast — never refused.
 *
 * `effort` undefined means "send none" (sources); `maxTokens` undefined means
 * the route's own ceiling.
 */
export function modelForRoute(route, plan, { requested, thoroughAvailable = false } = {}) {
  if (thoroughAvailable && wantsThorough(route, plan, requested)) {
    return { model: MODEL_FOR_TIER.thorough, effort: THOROUGH_EFFORT, maxTokens: THOROUGH_MAX_TOKENS[route], thorough: true };
  }
  const effort = Object.hasOwn(ROUTE_EFFORT, route) ? ROUTE_EFFORT[route] : DEFAULT_ROUTE_EFFORT;
  return { model: MODEL_FOR_TIER.fast, effort, maxTokens: undefined, thorough: false };
}

// ── the Thorough allowance and the fair-use limit ──────────────────────
/* Pro's thorough model comes out of a MONTHLY allowance, at API cost, per
 * account (`user:<id>`, or `install:<hash>` for an anonymous beta tester).
 * $1.50 buys about 50 explanations or 28-96 critiques. It resets on the 1st
 * (UTC, usageMonth). When it cannot cover a call's reservation, that call runs
 * on the fast model. Shown to people as a percentage, never as dollars. */
export const THOROUGH_MONTHLY_USD = { pro: 1.5 };

export function thoroughMonthlyUsd(plan) {
  return THOROUGH_MONTHLY_USD[normalizePlan(plan)] ?? 0;
}

/* The fair-use limit: all model spend by one signed-in PAID account, per day
 * (local midnight) and per month (the 1st, UTC). Over either, the account runs
 * at FREE limits until it resets (lib/entitlement.js effectivePlan) — never a
 * refusal beyond what Free gets, and the plan and billing are unchanged. Pro's
 * includes its Thorough allowance. Beta testers have none: the beta pool and
 * betaWebSearchesPerHour bound them. At regular use a Student spends ~4 cents
 * a day and a Pro ~9, so these trip only far beyond normal writing. */
export const FAIR_USE = {
  student: { day: 1, month: 4 },
  pro: { day: 2, month: 8 },
};

/** `{ day, month }` in dollars for a paid plan, or null (free has no fair-use limit — it has quotas). */
export function fairUseLimits(plan) {
  return FAIR_USE[normalizePlan(plan)] ?? null;
}

// ── metering ───────────────────────────────────────────────────────────

/* Source searches per plan, per day and per month. The extension's
 * /api/sources and the desktop's /api/find-sources draw on ONE count. A search
 * is ~16x a check (OpenAI bills web_search per call on top of tokens), so this
 * is the one volume allowance every plan has; Student's 100 a month is always
 * more than Free's 40. Beta testers get Pro's, keyed on their install id. */
export const SOURCE_LIMITS = {
  free: { day: 5, month: 40 },
  student: { day: 20, month: 100 },
  pro: { day: 40, month: 250 },
};

/** What the pricing page promises free accounts: "5 source searches a day (40 a month)". */
export const FREE_DAILY_SOURCE_SEARCHES = SOURCE_LIMITS.free.day;
export const FREE_MONTHLY_SOURCE_SEARCHES = SOURCE_LIMITS.free.month;

/* Flow checks (/api/flow) per day, a usage kind of their own. The shipped
 * extension re-ran flow up to ~72 times an hour while someone typed at the end
 * of a document (its structure signature includes each paragraph's closing
 * words), on every plan, unmetered. The server now holds every caller to one
 * flow call per FLOW_MIN_INTERVAL_MS as well — a 429 the shipped
 * extension's requestFlow swallows silently. */
export const DAILY_FLOW = { free: 40, student: 150, pro: 150 };
export const FLOW_MIN_INTERVAL_MS = 120_000;

export function dailyFlowLimit(plan) {
  return DAILY_FLOW[normalizePlan(plan)];
}

/**
 * Checks a free caller may run per day.
 *
 * Sized on 2026-09-13 against gpt-5-nano, whose check plateaued at 0.084
 * cents, so 400 checks cost at most ~34 cents. Re-measured on the current
 * fast tier (gpt-5.6-luna at effort medium, which /api/check runs the fast
 * tier at) in the model eval, eval/models/FINDINGS.md, 2026-09-21 — each
 * range runs from measured (cache-warm) to cold:
 *   - a 1-sentence typing-pause check: 0.039-0.068 cents
 *   - a 3-sentence typing-pause check: 0.074-0.104 cents
 *   - a first check or paste (40 sentences): 0.34-0.39 cents
 *   - a free user at this cap, 1 first check + 399 typing-pause checks:
 *     $0.23-0.35 a day ASSUMING an even mix of 1- and 3-sentence checks
 *     (0.0565-0.086 cents each, the eval's own convention) — the same ~34
 *     cents the 400 was sized against. The full range, all 1-sentence warm
 *     to all 3-sentence cold, is $0.16-0.42.
 * Plan on the COLD end. The warm figures assume a re-sent document reads
 * from the prompt cache; in the 2026-09-21 smoke run (one probe) the same
 * document re-sent with a different sentence to check read nothing from it
 * and wrote it again — only a byte-identical request hit — and a
 * typing-pause check's sentence list changes every time. Cold, the even mix
 * is $0.35 a day at the cap.
 * The extension fires at most one check per 10s, so 400 checks is about an
 * hour of continuous typing, and the Docs widget keeps each sentence's
 * verdict (by hash), so re-checking unchanged text costs nothing — the
 * server itself does not cache /api/check. luna does NOT plateau the way nano
 * did: a caller sending a full 40-sentence batch every time could reach
 * ~$1.56 at the cap, which the per-caller rate limit and the global budget
 * bound, not this number.
 *
 * Kept at 400. The trade-off of the new model is capacity: the $10/day
 * extension pool covers ~29-44 free users at the cap on that even mix, and
 * ~24 if every check is a cold 3-sentence one (it covered ~60-69 on nano).
 * If this ever needs raising, the number to recompute, at its upper bound, is
 * (0.39 cents + (limit - 1) x 0.104 cents) x expected capped users per day,
 * against the global budget in shared/guards.js.
 */
export const FREE_DAILY_CHECKS = 400;

/* The desktop app's AI calls — detect, critique, grade, structure, tracer,
 * correction — on the free tier. 150 is the relay's number, carried over so a
 * free desktop user keeps the allowance they had before the relay retired.
 * Counted under its own usage kind ("ai"), never "check": sharing a kind would
 * let desktop use eat a free extension user's 400 checks.
 *
 * Paid plans are unmetered here, as they are for checks, and bounded instead
 * by their fair-use limit (FAIR_USE) and the app pool's daily budget. That
 * also fixes the relay's accident: it had no "student" key, so Student paid
 * for a plan and got the free 150. */
export const FREE_DAILY_AI_CALLS = 150;
export function dailyAiLimit(plan) {
  return normalizePlan(plan) === "free" ? FREE_DAILY_AI_CALLS : null;
}

/** null means "not metered" — a paid plan is bounded by its fair-use limit and the pools. */
export function dailyCheckLimit(plan) {
  return normalizePlan(plan) === "free" ? FREE_DAILY_CHECKS : null;
}

/** Source searches a plan may run today. Every plan is metered (SOURCE_LIMITS). */
export function dailySourceSearchLimit(plan) {
  return SOURCE_LIMITS[normalizePlan(plan)].day;
}

/** Source searches a plan may run this month (usageMonth). */
export function monthlySourceSearchLimit(plan) {
  return SOURCE_LIMITS[normalizePlan(plan)].month;
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * The calendar day a usage row belongs to, as `YYYY-MM-DD` in the server's own
 * timezone.
 *
 * Local, not UTC, because the promise is "5 a day" to a person, and a UTC
 * boundary lands mid-evening for most of the US — a student would watch their
 * quota reset while they were still writing. Derived from the local getters
 * rather than from toISOString for exactly that reason.
 */
export function usageDay(at = Date.now()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * The calendar month a MONTHLY usage row belongs to, as `YYYY-MM` in UTC.
 *
 * Monthly counters (source searches, the fair-use limit, the Thorough
 * allowance) share entitlement_usage with the daily ones: the `day` column is
 * TEXT, and a `YYYY-MM` key can never equal a `YYYY-MM-DD` one, so no
 * migration and no collision. Every reader of that table matches the key
 * exactly (lib/db.js usageCount); nothing sums a range of days.
 *
 * UTC, unlike usageDay: a month is a billing-sized period, "resets on the 1st"
 * is the promise, and hours either side of it change nothing a writer notices.
 */
export function usageMonth(at = Date.now()) {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** The first day of the NEXT usage month, as `YYYY-MM-DD` — when monthly counters reset. */
export function nextMonthStart(at = Date.now()) {
  const d = new Date(at);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-01`;
}

/** The NEXT usage day, as `YYYY-MM-DD` — when daily counters reset (local midnight). */
export function nextUsageDay(at = Date.now()) {
  const d = new Date(at);
  return usageDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12).getTime());
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `YYYY-MM-DD` as people read it in a message: "Oct 1". Anything else is returned as given. */
export function monthDayLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  if (!m) return String(ymd ?? "");
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/** Whether one more metered call fits. `limit === null` is unmetered. */
export function withinDailyLimit(used, limit) {
  if (limit === null) return true;
  return used < limit;
}
