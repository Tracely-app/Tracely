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
  fast: "gpt-5.6-luna",
  balanced: "gpt-5.6-terra",
  thorough: "gpt-6-astra",
};

export const TIER_FOR_MODEL = {
  "gpt-5.6-luna": "fast",
  "gpt-5.6-terra": "balanced",
  "gpt-6-astra": "thorough",
};

/**
 * Retired model ids that clients already in people's hands still send, and
 * the tier each one asked for.
 *
 * The tiers were remapped on 2026-09-21 (eval/models/FINDINGS.md): fast moved
 * off gpt-5-nano and balanced off gpt-5.4. Extension builds up to 2.19.2 —
 * testers' copies and the Web Store build under review — send "gpt-5-nano"
 * from the Fast stop and "gpt-5.4" from Balanced, and desktop builds from
 * before the remap send the same ids from their MODEL_FOR_TIER. None of them
 * can be changed by a server deploy. Without this map both ids are
 * unrecognised and resolve DOWN to fast, which quietly takes a Student's
 * Balanced stop away; with it, an old build keeps the tier it asked for and
 * runs that tier's current model. (Thorough was already "gpt-6-astra".)
 *
 * These ids only. Every other unrecognised id still resolves down to fast
 * (clampModel), and nothing ever RUNS a retired id: it is translated before
 * the model is chosen, priced or logged.
 */
export const LEGACY_MODEL_TIER = {
  "gpt-5-nano": "fast",
  "gpt-5.4": "balanced",
};

/** A client's model id with a retired one (LEGACY_MODEL_TIER) translated to its tier's current model; anything else unchanged. */
export function currentModelId(requested) {
  if (typeof requested !== "string" || !Object.hasOwn(LEGACY_MODEL_TIER, requested)) return requested;
  return MODEL_FOR_TIER[LEGACY_MODEL_TIER[requested]];
}

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
 *
 * A retired id an old client still sends is translated to its tier's current
 * model first (currentModelId), so it is clamped as the tier it asked for.
 * The lookup is own-keys only: "toString" or "constructor" is not a model.
 */
export function clampModel(requested, plan) {
  const ceiling = PLAN_MODEL_CEILING[plan] ?? PLAN_MODEL_CEILING[DEFAULT_PLAN];
  const id = currentModelId(requested);
  const tier = typeof id === "string" && Object.hasOwn(TIER_FOR_MODEL, id) ? TIER_FOR_MODEL[id] : null;
  if (!tier) return MODEL_FOR_TIER.fast;
  return modelTierRank(tier) <= modelTierRank(ceiling) ? id : MODEL_FOR_TIER[ceiling];
}

// ── free-tier metering ─────────────────────────────────────────────────

/** What the pricing page promises free accounts: "5 source searches a day". */
export const FREE_DAILY_SOURCE_SEARCHES = 5;

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
 * The extension fires at most one check per 10s, so 400 checks is about an
 * hour of continuous typing, and the server caches on a hash of the input,
 * so re-checking unchanged text is free. luna does NOT plateau the way nano
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
 * Paid plans are unmetered here, as they are for checks and sources, and
 * bounded instead by the app pool's daily budget. That also fixes the relay's
 * accident: it had no "student" key, so Student paid for a plan and got the
 * free 150. */
export const FREE_DAILY_AI_CALLS = 150;
export function dailyAiLimit(plan) {
  return normalizePlan(plan) === "free" ? FREE_DAILY_AI_CALLS : null;
}

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
