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
 * in-flight calls at the moment it trips. On the extension pool that is
 * bounded by the per-caller rate limits and, at fast-model prices, worth a
 * fraction of a cent. The pools that serve the expensive models (`beta`,
 * `paid`) cannot lean on that — a beta caller rotates its install id freely —
 * so their admissions RESERVE a worst-case cost first (reserveSpend below)
 * and the ceiling is checked against spend plus what is still in flight.
 */
import { usageCount, usageAdd } from "./db.js";
import { costMicroCents } from "./llm.js";
import { usageDay } from "../shared/plan.js";
import { SPEND, dailyBudgetUsd } from "../shared/guards.js";

const KIND = "spend_ucents";
export const MICRO_CENTS_PER_USD = 100 * 1e6;

/* Four pools, each its own ceiling and its own running total.
 *
 * `extension` is the pool this module has always had — same synthetic account,
 * same variable — and it is the default everywhere, so every existing caller
 * is unchanged. `app` is the desktop's (see SPEND in shared/guards.js for why
 * the two must not share a day): a desktop Pro user on the thorough model can
 * spend its budget and never touch the extension's. `beta` is the beta
 * testers' Pro grant on the extension routes (server.js spendGate): spent
 * first, and when it is gone the tester falls back to their own plan on the
 * extension pool rather than being refused. `paid` is Student and Pro
 * accounts on the extension routes, for the same reason `app` exists: their
 * slider reaches models ~10x (gpt-5.6-terra) and 40-50x (gpt-6-astra) the
 * fast one's price per token, and on the shared pool
 * one of them could empty the day and 503 every free user. When it is spent
 * they drop to the fast model on the extension pool — the day everyone had
 * before the slider meant anything. */
export const SPEND_POOLS = {
  extension: { account: "__global__", variable: "TRACELY_DAILY_BUDGET_USD", fallback: SPEND.defaultDailyBudgetUsd },
  app: { account: "__global_app__", variable: "TRACELY_APP_DAILY_BUDGET_USD", fallback: SPEND.defaultAppDailyBudgetUsd },
  beta: { account: "__global_beta__", variable: "TRACELY_BETA_DAILY_BUDGET_USD", fallback: SPEND.defaultBetaDailyBudgetUsd },
  paid: { account: "__global_paid__", variable: "TRACELY_PAID_DAILY_BUDGET_USD", fallback: SPEND.defaultPaidDailyBudgetUsd },
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
    // A source search costs ~10-25x a typing-pause check on the fast tier
    // (OpenAI bills web_search per call on top of tokens), so shedding them
    // first buys that much runway for the feature people actually notice
    // missing.
    sourcesAllowed: remaining > 0 && remainingPct > SPEND.shedSourcesAtRemainingPct,
  };
}

/* ── in-flight reservations ──────────────────────────────────────────────
 *
 * The ceiling above is checked at ADMISSION and the cost lands AFTER the call,
 * so everything admitted while `remaining > 0` runs — which is fine at fast-
 * model prices and not fine on the thorough model, where one check can cost a
 * dollar. A caller holding the beta token can rotate its install id per
 * request, so the per-caller limiter bounds nothing there: forty concurrent
 * checks were all admitted against a $1 pool and spent $20.
 *
 * So an admission to a reserving pool holds a WORST-CASE cost for the call it
 * admits, and a pool admits only while its spend plus everything still held
 * leaves room. A request that makes MORE calls — a fact check that truncates
 * and splits into two halves — admits them the same way before making them
 * (`extend`), and stops splitting when there is no room. The overshoot is
 * then at most the last admission — one call's worst case, or a split's two
 * — however many requests arrive at once. In memory on purpose: a
 * reservation lives for one request, and a restart ends every request it
 * could be holding. */
const held = new Map(); // key -> micro-cents reserved by calls in flight

/* Pools are held under their own name; an ACCOUNT's holds (the Thorough
 * allowance, lib/entitlement.js reserveThorough) under "account:<key>". The
 * pool names are fixed words, so the two can never collide. */
const accountHoldKey = (key) => `account:${key}`;

/* One hold against `key`. `room` is asked by `extend` before it grows the
 * hold (a pool's poolRoom); null means an extension is always taken. */
function hold(key, microCents, room) {
  let amount = Math.max(0, Math.round(Number(microCents) || 0));
  held.set(key, (held.get(key) ?? 0) + amount);
  let open = true;
  return {
    get amount() { return amount; },
    resize(next) {
      if (!open) return;
      const n = Math.max(0, Math.min(amount, Math.round(Number(next) || 0)));
      held.set(key, Math.max(0, (held.get(key) ?? 0) - amount + n));
      amount = n;
    },
    extend(more, opts = {}) {
      if (!open || (room && !room(opts))) return false;
      const n = Math.max(0, Math.round(Number(more) || 0));
      held.set(key, (held.get(key) ?? 0) + n);
      amount += n;
      return true;
    },
    release() {
      if (!open) return;
      open = false;
      held.set(key, Math.max(0, (held.get(key) ?? 0) - amount));
      amount = 0;
    },
  };
}

/** Micro-cents currently reserved by in-flight calls on `pool`. */
export function reservedMicroCents(pool = "extension") {
  return held.get(pool) ?? 0;
}

/**
 * Reserve `microCents` against `pool` for one call. `resize` only ever
 * SHRINKS it (once the route knows the model it will actually run — never
 * above what admission allowed); `extend` grows it for further calls the same
 * request is about to make, and only under the test admission used (poolRoom),
 * returning whether it was taken. `release` is idempotent, so the request
 * handler can release in a `finally` whatever happened.
 */
export function reserveSpend(pool, microCents) {
  poolOf(pool);
  return hold(pool, microCents, ({ at = Date.now(), env = process.env } = {}) => poolRoom({ pool, at, env }).room);
}

/**
 * The same hold, against ONE ACCOUNT rather than a pool: `key` is the
 * account's own id for what is being held ("thorough:user:<id>", "thorough:
 * install:<hash>"). The caller decides admission (lib/entitlement.js
 * reserveThorough compares spend plus reservedAccountMicroCents with the
 * allowance) — a hold only
 * makes calls already admitted visible to the next admission, so a burst
 * cannot all be admitted against the same unspent money.
 */
export function reserveAccount(key, microCents) {
  return hold(accountHoldKey(key), microCents, null);
}

/** Micro-cents currently reserved against one account key (reserveAccount). */
export function reservedAccountMicroCents(key) {
  return held.get(accountHoldKey(key)) ?? 0;
}

/**
 * Whether `pool` can take one more call, counting what is in flight. Returns
 * `{ budget, room }`: `budget` is spendState's answer (spend on disk only),
 * `room` is true when the pool is unmetered or its remaining budget minus
 * every held reservation is still above zero. Takes no reservation itself —
 * the caller reserves once it has decided, so a refusal further down its gate
 * cannot leak one.
 */
export function poolRoom({ enforced = true, at = Date.now(), env = process.env, pool = "extension" } = {}) {
  const budget = spendState({ enforced, at, env, pool });
  if (!budget.enforced) return { budget, room: true };
  return { budget, room: budget.remaining - reservedMicroCents(pool) > 0 };
}

/**
 * Record what a completed model call cost into `pool`. Returns THAT CALL'S
 * cost in micro-cents (0 when unenforced), so the caller can charge the same
 * amount to the account's fair-use total and its Thorough allowance without
 * pricing the call twice (server.js recordCall).
 */
export function recordSpend({ model, usage, webSearchCalls = 0, enforced = true, at = Date.now(), pool = "extension" }) {
  if (!enforced) return 0;
  const cost = costMicroCents(model, usage, { webSearchCalls });
  if (cost > 0) usageAdd(poolOf(pool).account, usageDay(at), KIND, cost);
  return cost;
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
