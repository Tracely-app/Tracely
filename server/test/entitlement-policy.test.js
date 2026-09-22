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
