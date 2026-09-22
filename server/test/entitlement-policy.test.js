/**
 * The plan policy's entitlement layer (lib/entitlement.js): month rows, the
 * day+month source-search quota, the flow quota, per-account spend, the
 * fair-use limit (effectivePlan) and Pro's Thorough allowance.
 *
 * No server, no model: these are the counters server.js consults. The
 * database is redirected with TRACELY_DATA_DIR before anything imports it, so
 * nothing here touches a developer's real counters. Times are mid-day UTC and
 * a whole day apart, so the local-midnight day boundary (usageDay) and the
 * UTC month boundary (usageMonth) land the same way in every timezone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(tmpdir(), "tracely-policy-"));
process.env.TRACELY_DATA_DIR = DIR;
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

const E = await import("../lib/entitlement.js");
const { usageCount, usageBump } = await import("../lib/db.js");
const { spentTodayMicroCents, recordSpend, reservedAccountMicroCents } = await import("../lib/spend.js");
const P = await import("../shared/plan.js");

const USD = 100 * 1e6; // micro-cents per dollar
const at = (month, day) => Date.UTC(2026, month - 1, day, 12); // noon UTC
const SEP = (d) => at(9, d);
const OCT = (d) => at(10, d);

let n = 0;
/** A fresh signed-in account on `plan`, and its caller id. */
function account(plan, extra = {}) {
  const userId = `policy-${plan}-${++n}`;
  return { ent: { plan, userId, email: null, enforced: true, ...extra }, id: `user:${userId}` };
}
/** A fresh anonymous beta tester: Pro by grant, keyed on an install id. */
function betaTester() {
  return { ent: { plan: "pro", userId: null, email: null, enforced: true, beta: true }, id: `install:beta-${++n}` };
}

test("month rows sit beside day rows without either reader seeing the other", () => {
  const id = "user:rows";
  usageBump(id, P.usageDay(SEP(15)), "source_search");
  usageBump(id, P.usageMonth(SEP(15)), "source_search");
  usageBump(id, P.usageMonth(SEP(15)), "source_search");
  assert.equal(P.usageMonth(SEP(15)), "2026-09");
  assert.equal(P.usageMonth(SEP(15)).length, 7);
  assert.equal(usageCount(id, P.usageDay(SEP(15)), "source_search"), 1);
  assert.equal(usageCount(id, "2026-09", "source_search"), 2);
  assert.equal(usageCount(id, "2026-10", "source_search"), 0);
});

// ── source searches: day and month ──────────────────────────────────────

test("source searches: Free stops at 5 a day, and resumes the next day", () => {
  const { ent, id } = account("free");
  for (let i = 0; i < 5; i++) {
    assert.equal(E.sourceSearchQuota(ent, id, SEP(15)).allowed, true);
    E.recordSourceSearch(ent, id, SEP(15));
  }
  const q = E.sourceSearchQuota(ent, id, SEP(15));
  assert.deepEqual([q.allowed, q.limit, q.used, q.monthLimit, q.monthUsed, q.blockedBy], [false, 5, 5, 40, 5, "day"]);
  assert.equal(q.resetsOn, P.nextUsageDay(SEP(15)));
  const tomorrow = E.sourceSearchQuota(ent, id, SEP(16));
  assert.deepEqual([tomorrow.allowed, tomorrow.used, tomorrow.monthUsed, tomorrow.blockedBy], [true, 0, 5, null]);
});

test("source searches: Free stops at 40 a month, resets on the 1st", () => {
  const { ent, id } = account("free");
  for (let d = 2; d <= 9; d++) for (let i = 0; i < 5; i++) E.recordSourceSearch(ent, id, SEP(d));
  const q = E.sourceSearchQuota(ent, id, SEP(20));
  assert.deepEqual([q.allowed, q.used, q.monthUsed, q.blockedBy, q.resetsOn], [false, 0, 40, "month", "2026-10-01"]);
  const oct = E.sourceSearchQuota(ent, id, OCT(2));
  assert.deepEqual([oct.allowed, oct.month, oct.monthUsed], [true, "2026-10", 0]);
});

test("source searches: month wins when the day and the month are both spent", () => {
  const { ent, id } = account("free");
  for (let d = 2; d <= 8; d++) for (let i = 0; i < 5; i++) E.recordSourceSearch(ent, id, SEP(d));
  for (let i = 0; i < 5; i++) E.recordSourceSearch(ent, id, SEP(9));
  const q = E.sourceSearchQuota(ent, id, SEP(9));
  assert.deepEqual([q.blockedBy, q.resetsOn], ["month", "2026-10-01"]);
});

test("source searches: every plan is metered at its own day and month limits", () => {
  for (const [plan, day, month] of [["free", 5, 40], ["student", 20, 100], ["pro", 40, 250]]) {
    const { ent, id } = account(plan);
    const q = E.sourceSearchQuota(ent, id, SEP(15));
    assert.deepEqual([q.limit, q.monthLimit], [day, month], plan);
  }
});

test("source searches: recordSourceSearch bumps both rows and returns the day count", () => {
  const { ent, id } = account("student");
  assert.equal(E.recordSourceSearch(ent, id, SEP(15)), 1);
  assert.equal(E.recordSourceSearch(ent, id, SEP(15)), 2);
  assert.equal(usageCount(id, P.usageDay(SEP(15)), "source_search"), 2);
  assert.equal(usageCount(id, "2026-09", "source_search"), 2);
});

test("source searches: unenforced, address and keyless callers are not metered and write nothing", () => {
  const local = { plan: "free", userId: null, email: null, enforced: false };
  const hosted = { plan: "free", userId: null, email: null, enforced: true };
  for (const [ent, id] of [[local, "install:local"], [hosted, "addr:school"], [hosted, null]]) {
    const q = E.sourceSearchQuota(ent, id, SEP(15));
    assert.deepEqual([q.allowed, q.limit, q.monthLimit], [true, null, null]);
    assert.equal(E.recordSourceSearch(ent, id, SEP(15)), 0);
    if (id) assert.equal(usageCount(id, "2026-09", "source_search"), 0);
  }
});

test("source searches: a beta tester gets Pro's limits on their install id", () => {
  const { ent, id } = betaTester();
  const q = E.sourceSearchQuota(ent, id, SEP(15));
  assert.deepEqual([q.limit, q.monthLimit], [40, 250]);
  E.recordSourceSearch(ent, id, SEP(15));
  assert.equal(usageCount(id, "2026-09", "source_search"), 1);
});

// ── flow ───────────────────────────────────────────────────────────────

test("flow: 40 a day on Free, 150 on Student and Pro, counted under its own kind", () => {
  for (const [plan, limit] of [["free", 40], ["student", 150], ["pro", 150]]) {
    const { ent, id } = account(plan);
    assert.equal(E.flowQuota(ent, id, SEP(15)).limit, limit, plan);
  }
  const { ent, id } = account("free");
  for (let i = 0; i < 40; i++) E.recordFlow(ent, id, SEP(15));
  assert.deepEqual([E.flowQuota(ent, id, SEP(15)).allowed, E.flowQuota(ent, id, SEP(15)).used], [false, 40]);
  assert.equal(E.flowQuota(ent, id, SEP(16)).allowed, true);
  assert.equal(E.checkQuota(ent, id, SEP(15)).used, 0, "flow never eats the check allowance");
});

test("flow: unenforced and address callers are not metered", () => {
  const local = { plan: "free", userId: null, email: null, enforced: false };
  assert.equal(E.flowQuota(local, "install:x", SEP(15)).limit, null);
  assert.equal(E.recordFlow(local, "install:x", SEP(15)), 0);
  const hosted = { plan: "free", userId: null, email: null, enforced: true };
  assert.equal(E.flowQuota(hosted, "addr:school", SEP(15)).limit, null);
});

// ── per-account spend ──────────────────────────────────────────────────

test("account spend accumulates on a day row and a month row", () => {
  const { id } = account("pro");
  E.recordAccountSpend(id, 1000, SEP(15));
  const t = E.recordAccountSpend(id, 500, SEP(15));
  assert.deepEqual([t.dayMicroCents, t.monthMicroCents, t.month], [1500, 1500, "2026-09"]);
  const next = E.recordAccountSpend(id, 200, SEP(16));
  assert.deepEqual([next.dayMicroCents, next.monthMicroCents], [200, 1700]);
  assert.deepEqual([E.accountSpend(id, OCT(2)).dayMicroCents, E.accountSpend(id, OCT(2)).monthMicroCents], [0, 0]);
});

test("account spend ignores zero, negative and non-numbers, and address or keyless callers", () => {
  const { id } = account("student");
  for (const bad of [0, -5, NaN, undefined, "x"]) E.recordAccountSpend(id, bad, SEP(15));
  assert.equal(E.accountSpend(id, SEP(15)).monthMicroCents, 0);
  assert.equal(usageCount(id, "2026-09", "account_ucents"), 0);
  E.recordAccountSpend("addr:school", 1000, SEP(15));
  assert.equal(usageCount("addr:school", "2026-09", "account_ucents"), 0);
  assert.equal(E.recordAccountSpend(null, 1000, SEP(15)).monthMicroCents, 0);
});

test("account spend never lands in a pool's daily spend", () => {
  const before = spentTodayMicroCents(SEP(15), "extension");
  E.recordAccountSpend(account("pro").id, 5 * USD, SEP(15));
  assert.equal(spentTodayMicroCents(SEP(15), "extension"), before);
});

test("recordSpend returns the call's cost, and 0 when unenforced", () => {
  const usage = { input: 1000, output: 100 };
  const cost = recordSpend({ model: "gpt-5.6-luna", usage, at: SEP(15), pool: "paid" });
  assert.ok(cost > 0);
  assert.equal(spentTodayMicroCents(SEP(15), "paid"), cost);
  assert.equal(recordSpend({ model: "gpt-5.6-luna", usage, enforced: false, at: SEP(15), pool: "paid" }), 0);
});

// ── fair use ───────────────────────────────────────────────────────────

test("fair use: Pro over $2 in a day acts as Free until midnight, then Pro again", () => {
  const { ent, id } = account("pro");
  E.recordAccountSpend(id, 1.99 * USD, SEP(15));
  assert.equal(E.fairUseState(ent, id, SEP(15)).state, "ok");
  assert.equal(E.effectivePlan(ent, id, SEP(15)), "pro");
  E.recordAccountSpend(id, 0.01 * USD, SEP(15));
  const s = E.fairUseState(ent, id, SEP(15));
  assert.deepEqual([s.state, s.resetsOn, s.limits.day, s.limits.month], ["day", P.nextUsageDay(SEP(15)), 2 * USD, 8 * USD]);
  assert.equal(E.effectivePlan(ent, id, SEP(15)), "free");
  assert.equal(ent.plan, "pro", "the plan itself is untouched");
  assert.equal(E.effectivePlan(ent, id, SEP(16)), "pro");
});

test("fair use: Pro over $8 in a month acts as Free until the 1st", () => {
  const { ent, id } = account("pro");
  for (let d = 2; d <= 5; d++) E.recordAccountSpend(id, 1.9 * USD, SEP(d)); // $7.60, never $2 in a day
  assert.equal(E.effectivePlan(ent, id, SEP(6)), "pro");
  E.recordAccountSpend(id, 0.4 * USD, SEP(6));
  const s = E.fairUseState(ent, id, SEP(7));
  assert.deepEqual([s.state, s.resetsOn], ["month", "2026-10-01"]);
  assert.equal(E.effectivePlan(ent, id, SEP(30)), "free");
  assert.equal(E.effectivePlan(ent, id, OCT(1) + 3_600_000), "pro");
});

test("fair use: Student's limits are $1 a day and $4 a month", () => {
  const { ent, id } = account("student");
  E.recordAccountSpend(id, 1 * USD, SEP(15));
  assert.equal(E.fairUseState(ent, id, SEP(15)).state, "day");
  assert.equal(E.effectivePlan(ent, id, SEP(15)), "free");
  for (let d = 16; d <= 18; d++) E.recordAccountSpend(id, 0.99 * USD, SEP(d));
  assert.equal(E.effectivePlan(ent, id, SEP(19)), "student"); // $3.97
  E.recordAccountSpend(id, 0.03 * USD, SEP(19));
  assert.equal(E.fairUseState(ent, id, SEP(19)).state, "month");
});

test("fair use: beta testers, Free, unenforced and address callers have no limit", () => {
  const signedInBeta = account("pro", { beta: true });
  const anonBeta = betaTester();
  const free = account("free");
  for (const { ent, id } of [signedInBeta, anonBeta, free]) {
    E.recordAccountSpend(id, 50 * USD, SEP(15));
    assert.equal(E.fairUseState(ent, id, SEP(15)).state, null);
    assert.equal(E.effectivePlan(ent, id, SEP(15)), ent.plan);
  }
  const local = { plan: "pro", userId: "local", email: null, enforced: false };
  assert.equal(E.effectivePlan(local, "user:local", SEP(15)), "pro");
  assert.equal(E.effectivePlan({ plan: "pro", enforced: true }, "addr:school", SEP(15)), "pro");
  assert.equal(E.effectivePlan(undefined, null), "free");
});

test("fair use: over the limit, every quota meters at Free's numbers", () => {
  const { ent, id } = account("pro");
  assert.deepEqual([E.checkQuota(ent, id, SEP(15)).limit, E.aiQuota(ent, id, SEP(15)).limit], [null, null]);
  E.recordAccountSpend(id, 2 * USD, SEP(15));
  assert.equal(E.checkQuota(ent, id, SEP(15)).limit, P.FREE_DAILY_CHECKS);
  assert.equal(E.aiQuota(ent, id, SEP(15)).limit, P.FREE_DAILY_AI_CALLS);
  assert.equal(E.flowQuota(ent, id, SEP(15)).limit, 40);
  const q = E.sourceSearchQuota(ent, id, SEP(15));
  assert.deepEqual([q.limit, q.monthLimit], [5, 40]);
  E.recordCheck(ent, id, SEP(15));
  assert.equal(E.checkQuota(ent, id, SEP(15)).used, 1);
  assert.equal(E.checkQuota(ent, id, SEP(16)).limit, null, "back to unmetered after midnight");
});
