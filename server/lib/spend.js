/**
 * The global daily spend ceiling — the only layer that actually bounds cost.
 *
 * Every other guard in this codebase meters a CALLER, and on a hosted Tracely
 * the default caller is anonymous: the extension deliberately works with no
 * sign-in, an install id is client-generated and therefore rotatable, and the
 * client address cannot carry a daily quota because a few hundred students
 * behind one school address look exactly like one attacker behind it. So
 * per-caller quotas bound accidents and casual overuse — most of the real
 * risk — and THIS bounds the determined case. Nothing else does.
 *
 * Two consequences worth being honest about:
 *
 *  - When the budget is exhausted, everyone is refused, including people who
 *    did nothing wrong. That is the trade being made. An unbounded bill is the
 *    alternative, and a 503 is recoverable where a card statement is not.
 *  - Because it is a ceiling on the DAY, an attacker can still burn the whole
 *    day's budget. Set TRACELY_DAILY_BUDGET_USD to what you can afford to lose
 *    in a day, because that is precisely what it is.
 *
 * SQLite-backed, not in memory: an in-memory total resets on restart, and
 * "crash the server to reset the budget" is a bypass. It shares the
 * entitlement_usage table under a synthetic account id, so there is no
 * migration — the table was already (account_id, day, kind, count).
 *
 * Spend is recorded AFTER a call, because the cost is not knowable until the
 * usage comes back. That means the budget can be overshot by at most the
 * in-flight calls at the moment it trips. Bounded by the per-caller rate
 * limits and, at fast-model prices, worth a fraction of a cent.
 */
import { usageCount, usageAdd } from "./db.js";
import { costMicroCents } from "./llm.js";
import { usageDay } from "../shared/plan.js";
import { SPEND, dailyBudgetUsd } from "../shared/guards.js";

const KIND = "spend_ucents";
const MICRO_CENTS_PER_USD = 100 * 1e6;

/* Three pools, each its own ceiling and its own running total.
 *
 * `extension` is the pool this module has always had — same synthetic account,
 * same variable — and it is the default everywhere, so every existing caller
 * is unchanged. `app` is the desktop's (see SPEND in shared/guards.js for why
 * the two must not share a day): a desktop Pro user on the thorough model can
 * spend its budget and never touch the extension's. `beta` is the beta
 * testers' Pro grant on the extension routes (server.js spendGate): spent
 * first, and when it is gone the tester falls back to their own plan on the
 * extension pool rather than being refused. */
export const SPEND_POOLS = {
  extension: { account: "__global__", variable: "TRACELY_DAILY_BUDGET_USD", fallback: SPEND.defaultDailyBudgetUsd },
  app: { account: "__global_app__", variable: "TRACELY_APP_DAILY_BUDGET_USD", fallback: SPEND.defaultAppDailyBudgetUsd },
  beta: { account: "__global_beta__", variable: "TRACELY_BETA_DAILY_BUDGET_USD", fallback: SPEND.defaultBetaDailyBudgetUsd },
};
function poolOf(name) {
  const p = SPEND_POOLS[name];
  if (!p) throw new Error(`unknown spend pool "${name}"`);
  return p;
}

/** The day's ceiling in micro-cents. 0 means "unlimited" (see spendState). */
export function dailyBudgetMicroCents(env = process.env, pool = "extension") {
  const p = poolOf(pool);
  return Math.round(dailyBudgetUsd(env, p.variable, p.fallback) * MICRO_CENTS_PER_USD);
}

export function spentTodayMicroCents(at = Date.now(), pool = "extension") {
  return usageCount(poolOf(pool).account, usageDay(at), KIND);
}

/**
 * Where the day stands.
 *
 * `enforced` is false when there is no budget to enforce — either the caller
 * passed enforced:false (a local run with no Supabase, which must behave
 * exactly as this server did before any of this existed) or the operator set
 * TRACELY_DAILY_BUDGET_USD=0, which is the documented way to turn the ceiling
 * off on a box whose spending is controlled some other way.
 */
export function spendState({ enforced = true, at = Date.now(), env = process.env, pool = "extension" } = {}) {
  const budget = dailyBudgetMicroCents(env, pool);
  if (!enforced || budget <= 0) {
    return { enforced: false, budget: null, spent: 0, remaining: null, remainingPct: 1, allowed: true, sourcesAllowed: true };
  }
  const spent = spentTodayMicroCents(at, pool);
  const remaining = Math.max(0, budget - spent);
  const remainingPct = budget > 0 ? remaining / budget : 0;
  return {
    enforced: true,
    budget,
    spent,
    remaining,
    remainingPct,
    allowed: remaining > 0,
    // Sources cost ~16x a check (OpenAI bills web_search per call on top of
    // tokens), so shedding them first buys 16x the runway for the feature
    // people actually notice missing.
    sourcesAllowed: remaining > 0 && remainingPct > SPEND.shedSourcesAtRemainingPct,
  };
}

/** Record what a completed model call cost. Returns the new day total. */
export function recordSpend({ model, usage, webSearchCalls = 0, enforced = true, at = Date.now(), pool = "extension" }) {
  if (!enforced) return 0;
  const cost = costMicroCents(model, usage, { webSearchCalls });
  if (cost <= 0) return spentTodayMicroCents(at, pool);
  return usageAdd(poolOf(pool).account, usageDay(at), KIND, cost);
}

/** For /api/status and the operator, in human units. */
export function spendSummary(opts = {}) {
  const s = spendState(opts);
  if (!s.enforced) return { enforced: false };
  return {
    enforced: true,
    budgetUsd: s.budget / MICRO_CENTS_PER_USD,
    spentUsd: Number((s.spent / MICRO_CENTS_PER_USD).toFixed(4)),
    remainingPct: Number(s.remainingPct.toFixed(3)),
    sourcesAllowed: s.sourcesAllowed,
  };
}
