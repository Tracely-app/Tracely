/* Unclaimed purchases (lib/billing.js settleChange + claimPendingForUser,
 * lib/db.js billing_pending).
 *
 * The scenario that motivated it, 2026-09-23: a tester bought Pro from the
 * website without having signed in. Stripe sent customer.subscription.created
 * and checkout.session.completed with a customer and an email but no account
 * id; the webhook answered 500 (no_user) fifteen times and the tester stayed
 * on Free. Now the purchase is recorded against the customer and placed when
 * an event links that customer to an account, or when the payer's email
 * signs in. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.TRACELY_DATA_DIR = mkdtempSync(path.join(tmpdir(), "tracely-pending-"));
const { settleChange, claimPendingForUser } = await import("../lib/billing.js");
const db = await import("../lib/db.js");

/* Fake stores: the same shapes lib/db.js offers, in memory. */
function fakes({ writeOk = true } = {}) {
  const customers = new Map(); // customerId → { user_id, email }
  const pending = new Map();   // customerId → { customer_id, email, plan }
  const users = new Map();     // email → userId, for findByEmail
  const written = [];
  const deps = {
    link: ({ customerId, userId, email }) => {
      if (!customerId) return;
      const prev = customers.get(customerId) ?? { user_id: null, email: null };
      customers.set(customerId, { user_id: userId ?? prev.user_id, email: email ?? prev.email });
    },
    lookup: (id) => customers.get(id) ?? null,
    findByEmail: async (email) => users.get(email.toLowerCase()) ?? null,
    writePlan: async (userId, plan) => { if (!writeOk) return { ok: false, reason: "http_500" }; written.push([userId, plan]); return { ok: true }; },
    pendingGet: (id) => pending.get(id) ?? null,
    pendingPut: ({ customerId, email, plan }) => pending.set(customerId, { customer_id: customerId, email: email ? email.toLowerCase() : null, plan }),
    pendingDelete: (id) => pending.delete(id),
    pendingByEmail: (email) => [...pending.values()].find((r) => r.email === email.toLowerCase()) ?? null,
    forget: () => { deps.forgot++; },
    forgot: 0,
  };
  return { deps, customers, pending, users, written };
}
const created = (customerId, plan, extra = {}) => ({ type: "customer.subscription.created", userId: null, customerId, email: null, plan, ...extra });
const checkout = (customerId, { userId = null, email = null, plan = null } = {}) => ({ type: "checkout.session.completed", userId, customerId, email, plan });

test("the usual order: subscription.created names the price first, checkout names the account — the checkout adopts the pending plan", async () => {
  const f = fakes();
  const a = await settleChange(created("cus_1", "pro"), f.deps);
  assert.deepEqual(a, { outcome: "pending", userId: null, plan: "pro" });
  assert.deepEqual(f.pending.get("cus_1"), { customer_id: "cus_1", email: null, plan: "pro" });
  const b = await settleChange(checkout("cus_1", { userId: "user-A", email: "a@example.com" }), f.deps);
  assert.deepEqual(b, { outcome: "applied", userId: "user-A", plan: "pro" }, "no price on the checkout, the pending plan is the answer");
  assert.deepEqual(f.written, [["user-A", "pro"]]);
  assert.equal(f.pending.has("cus_1"), false, "claimed");
  assert.deepEqual(f.customers.get("cus_1"), { user_id: "user-A", email: "a@example.com" });
  assert.equal(f.deps.forgot, 1, "the plan cache is dropped on an upgrade");
});

test("the tester's case: paid from the website signed out, then signed in with the same Google email", async () => {
  const f = fakes();
  const c = await settleChange(checkout("cus_2", { email: "Tester@Example.com", plan: "pro" }), f.deps);
  assert.equal(c.outcome, "pending");
  const s = await settleChange(created("cus_2", "pro"), f.deps);
  assert.equal(s.outcome, "pending", "the second event re-records, it does not error");
  assert.deepEqual(f.pending.get("cus_2"), { customer_id: "cus_2", email: "tester@example.com", plan: "pro" }, "the email is learned from the checkout and kept lower-case");
  // Four days later the tester signs in. Stripe stopped retrying on day three.
  const claimed = await claimPendingForUser({ userId: "user-T", email: "tester@example.com" }, f.deps);
  assert.equal(claimed, "pro");
  assert.deepEqual(f.written, [["user-T", "pro"]]);
  assert.equal(f.pending.size, 0);
  assert.deepEqual(f.customers.get("cus_2"), { user_id: "user-T", email: "tester@example.com" }, "the customer is linked, so the cancellation later finds the account");
  // ...and when he cancels, the subscription.deleted carries only the customer.
  const d = await settleChange({ type: "customer.subscription.deleted", userId: null, customerId: "cus_2", email: null, plan: "free" }, f.deps);
  assert.deepEqual(d, { outcome: "applied", userId: "user-T", plan: "free" });
  assert.deepEqual(f.written.at(-1), ["user-T", "free"]);
});

test("a never-claimed subscription that ends is dropped, not retried", async () => {
  const f = fakes();
  await settleChange(created("cus_3", "student"), f.deps);
  assert.equal(f.pending.size, 1);
  const d = await settleChange({ type: "customer.subscription.deleted", userId: null, customerId: "cus_3", email: null, plan: "free" }, f.deps);
  assert.deepEqual(d, { outcome: "unclaimed_ended", userId: null, plan: "free" });
  assert.equal(f.pending.size, 0);
  assert.deepEqual(f.written, []);
});

test("claiming is case-insensitive, never claims a free record, and leaves the record when the write fails", async () => {
  const f = fakes({ writeOk: false });
  await settleChange(checkout("cus_4", { email: "Mixed.Case@Example.com", plan: "student" }), f.deps);
  assert.equal(await claimPendingForUser({ userId: "user-M", email: "mixed.case@example.com" }, f.deps), null, "the write failed");
  assert.equal(f.pending.size, 1, "still there for the next resolve");
  const ok = fakes();
  ok.pending.set("cus_5", { customer_id: "cus_5", email: "free@example.com", plan: "free" });
  assert.equal(await claimPendingForUser({ userId: "user-F", email: "free@example.com" }, ok.deps), null, "a free record grants nothing");
  assert.equal(await claimPendingForUser({ userId: "user-N", email: "nobody@example.com" }, ok.deps), null);
  assert.equal(await claimPendingForUser({ userId: null, email: "x@example.com" }, ok.deps), null);
});

test("nothing to key on — no account, no customer — stays a retryable no_user; a failed write is retryable and keeps the record", async () => {
  const f = fakes();
  const r = await settleChange({ type: "customer.subscription.created", userId: null, customerId: null, email: null, plan: "pro" }, f.deps);
  assert.equal(r.outcome, "no_user");
  const g = fakes({ writeOk: false });
  await settleChange(created("cus_6", "pro"), g.deps);
  const w = await settleChange(checkout("cus_6", { userId: "user-W" }), g.deps);
  assert.equal(w.outcome, "failed:http_500");
  assert.equal(g.pending.has("cus_6"), true, "not deleted until the plan is actually on the account");
});

test("an unknown price is no_plan even when an account is named, and an email already on file resolves the user", async () => {
  const f = fakes();
  f.users.set("known@example.com", "user-K");
  const n = await settleChange(checkout("cus_7", { userId: "user-K" }), f.deps);
  assert.deepEqual(n, { outcome: "no_plan", userId: "user-K", plan: null });
  const e = await settleChange(created("cus_8", "pro", { email: "known@example.com" }), f.deps);
  assert.deepEqual(e, { outcome: "applied", userId: "user-K", plan: "pro" }, "findByEmail placed it, as before");
});

test("db: billing_pending upserts by customer, matches email case-insensitively, and deletes", () => {
  db.billingPendingPut({ customerId: "cus_db", email: "Pay@Example.com", plan: "pro", eventId: "evt_1" });
  assert.deepEqual(db.billingPendingByCustomer("cus_db").plan, "pro");
  assert.equal(db.billingPendingByEmail("PAY@example.com").customer_id, "cus_db");
  db.billingPendingPut({ customerId: "cus_db", email: null, plan: "student", eventId: "evt_2" });
  const row = db.billingPendingByCustomer("cus_db");
  assert.equal(row.plan, "student", "a later event replaces the plan");
  assert.equal(row.email, "pay@example.com", "and keeps the email it already knew");
  assert.equal(row.event_id, "evt_2");
  db.billingPendingPut({ customerId: "", email: "x@example.com", plan: "pro" });
  db.billingPendingPut({ customerId: "cus_none", email: "x@example.com", plan: "" });
  assert.equal(db.billingPendingByCustomer("cus_none"), null, "no plan, no record");
  db.billingPendingDelete("cus_db");
  assert.equal(db.billingPendingByCustomer("cus_db"), null);
  assert.equal(db.billingPendingByEmail("pay@example.com"), null);
});
