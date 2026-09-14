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

/** Cheapest first, like PLANS. */
export const MODEL_TIERS = ["fast", "balanced", "thorough"];

export const MODEL_FOR_TIER = {
  fast: "gpt-5-nano",
  balanced: "gpt-5.4",
  thorough: "gpt-6-astra",
};

export const TIER_FOR_MODEL = {
  "gpt-5-nano": "fast",
  "gpt-5.4": "balanced",
  "gpt-6-astra": "thorough",
};

/** The best tier each plan may reach. Free never leaves `fast`. */
export const PLAN_MODEL_CEILING = { free: "fast", student: "balanced", pro: "thorough" };

export function modelTierRank(tier) {
  const i = MODEL_TIERS.indexOf(tier);
  return i === -1 ? 0 : i;
}

export function ceilingModelFor(plan) {
  return MODEL_FOR_TIER[PLAN_MODEL_CEILING[plan] ?? PLAN_MODEL_CEILING[DEFAULT_PLAN]];
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
 */
export function clampModel(requested, plan) {
  const ceiling = PLAN_MODEL_CEILING[plan] ?? PLAN_MODEL_CEILING[DEFAULT_PLAN];
  const tier = TIER_FOR_MODEL[requested];
  if (!tier) return MODEL_FOR_TIER.fast;
  return modelTierRank(tier) <= modelTierRank(ceiling) ? requested : MODEL_FOR_TIER[ceiling];
}

// ── free-tier metering ─────────────────────────────────────────────────

/** What the pricing page promises free accounts: "5 source searches a day". */
export const FREE_DAILY_SOURCE_SEARCHES = 5;

/**
 * Checks a free caller may run per day.
 *
 * Measured 2026-09-13 against the real API: a check on the fast model costs
 * 0.014 cents for one sentence and PLATEAUS at 0.084 cents around twenty (the
 * output is bounded by how much explanation the findings need, not by sentence
 * count). The extension fires at most one check per 10s, so 400 checks is
 * about an hour of continuous typing and costs at most ~34 cents — and far
 * less in practice, because the server caches on a hash of the input, so
 * re-checking unchanged text is free.
 *
 * Sized for a real student writing an essay, not for a demo. If this ever
 * needs raising, the number to recompute is (limit x 0.084 cents x expected
 * daily free users) against the global budget in shared/guards.js.
 */
export const FREE_DAILY_CHECKS = 400;

/** null means "not metered" — a paid plan is bounded by the global budget. */
export function dailyCheckLimit(plan) {
  return normalizePlan(plan) === "free" ? FREE_DAILY_CHECKS : null;
}

/** null means "not metered" — a paid plan is bounded by the rolling cost guards, not by a quota. */
export function dailySourceSearchLimit(plan) {
  return normalizePlan(plan) === "free" ? FREE_DAILY_SOURCE_SEARCHES : null;
}

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
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whether one more metered call fits. `limit === null` is unmetered. */
export function withinDailyLimit(used, limit) {
  if (limit === null) return true;
  return used < limit;
}
