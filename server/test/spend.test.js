/**
 * The spend cap.
 *
 * These tests exist because the failure being prevented is asymmetric: a cap
 * that is too tight produces a complaint, and a cap that does not hold
 * produces a bill nobody notices until the statement. So every property here
 * is stated as "what must remain true", and the two that matter most are the
 * ones that sound least like features:
 *
 *   1. A plain `node server.js` with an empty .env meters NOTHING. That is how
 *      the local-first install runs, and it must behave exactly as it did
 *      before any of this existed.
 *   2. An ADDRESS never carries a daily quota. Tracely's market is schools,
 *      and a few hundred students behind one campus address are
 *      indistinguishable from one attacker behind it.
 *
 * The database is redirected with TRACELY_DATA_DIR before any import that
 * touches it, because the spend ledger is a real table and a test that bumped
 * the developer's real counter would consume their actual daily budget.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync as fsReadFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(tmpdir(), "tracely-spend-"));
process.env.TRACELY_DATA_DIR = DIR;
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

const { costMicroCents, MODEL_TIERS, MODEL_PRICES } = await import("../lib/llm.js");
const { spendState, recordSpend, dailyBudgetMicroCents, spentTodayMicroCents, reserveSpend, reservedMicroCents, poolRoom } = await import("../lib/spend.js");
const { callerId, isDailyQuotaKey, clientAddress, checkQuota, recordCheck,
        sourceSearchQuota, recordSourceSearch, aiQuota, recordAi } = await import("../lib/entitlement.js");
const { FREE_DAILY_CHECKS, FREE_DAILY_SOURCE_SEARCHES, FREE_DAILY_AI_CALLS } = await import("../shared/plan.js");
const { SPEND, dailyBudgetUsd, keyedRateLimiter } = await import("../shared/guards.js");

const HOSTED = { plan: "free", userId: null, enforced: true };
const LOCAL = { plan: "free", userId: null, enforced: false };
const PAID = { plan: "pro", userId: "u-paid", enforced: true };
// A distinct day per test, so the shared ledger cannot leak between them.
let dayN = 0;
const nextAt = () => Date.UTC(2030, 0, 1 + dayN++, 12);

// ── cost arithmetic ──────────────────────────────────────────────────────

test("costMicroCents reproduces the prices measured against the real API", () => {
  // An 11-sentence check on the fast model, cold (the prefix a cache write),
  // from the model eval (eval/models/FINDINGS.md, 2026-09-21): 1,371 input
  // tokens of which 1,368 were cache writes, 621 output — 0.1088 cents.
  const c = costMicroCents("gpt-5.6-luna", { input: 1371, output: 621, cached: 0, cacheWrite: 1368 });
  assert.equal((c / 1e6).toFixed(4), "0.1088");
});

test("a dated model id prices the same as its family", () => {
  // OpenAI answered gpt-5-nano calls as "gpt-5-nano-2025-08-07". The current
  // tiers echo bare ids, but pricing the reply by the id it RETURNS is the
  // whole point, so a dated suffix must still resolve.
  const bare = costMicroCents(MODEL_TIERS.fast, { input: 1000, output: 1000 });
  const dated = costMicroCents(`${MODEL_TIERS.fast}-2026-09-01`, { input: 1000, output: 1000 });
  assert.equal(dated, bare);
});

test("a retired tier id is priced as an unknown model — the top tier — never at its old rate", () => {
  // Legacy ids are translated to their tier's current model before any call
  // (shared/plan.js currentModelId), so nothing prices one. If one ever got
  // here, the only safe answer is the most expensive tier.
  for (const retired of ["gpt-5-nano", "gpt-5.4"]) {
    assert.equal(MODEL_PRICES[retired], undefined, `${retired} is still in the price table`);
    const u = { input: 1000, output: 1000 };
    assert.equal(costMicroCents(retired, u), costMicroCents(MODEL_TIERS.thorough, u));
  }
});

test("an unknown model prices as the MOST expensive tier, never as free", () => {
  const unknown = costMicroCents("gpt-99-unreleased", { input: 1000, output: 1000 });
  const top = costMicroCents(MODEL_TIERS.thorough, { input: 1000, output: 1000 });
  assert.equal(unknown, top);
  assert.ok(unknown > 0, "a model rename must not silently uncap spending");
});

test("the web_search call fee dominates a source search, and is not in the tokens", () => {
  const tokensOnly = costMicroCents(MODEL_TIERS.fast, { input: 1000, output: 800 });
  const withSearch = costMicroCents(MODEL_TIERS.fast, { input: 1000, output: 800 }, { webSearchCalls: 1 });
  assert.ok(withSearch - tokensOnly === 1e6, "one search should add exactly 1 cent");
  // ~10x on the fast tier (a 1,000-in / 800-out search is ~0.12 cents of tokens).
  assert.ok(withSearch > tokensOnly * 5, "pricing sources off tokens alone under-counts them badly");
});

test("cached input is charged at the cached rate, not the fresh rate", () => {
  const allFresh = costMicroCents(MODEL_TIERS.fast, { input: 1000, output: 0, cached: 0 });
  const allCached = costMicroCents(MODEL_TIERS.fast, { input: 1000, output: 0, cached: 1000 });
  assert.ok(allCached < allFresh);
  assert.equal(allCached, Math.round(1000 * MODEL_PRICES[MODEL_TIERS.fast].cached / 1e6 * 100 * 1e6));
});

test("cache writes are charged at the cacheWrite rate, once, and never again as fresh input", () => {
  // The thorough model bills a first-seen prefix at 1.25x input. 4,976 of
  // 4,979 input tokens came back as cache writes on a real cold call.
  const m = MODEL_TIERS.thorough;
  const p = MODEL_PRICES[m];
  assert.ok(p.cacheWrite > p.input, "the thorough tier bills cache writes above its input rate");
  const micro = (dollarsPerM, tokens) => tokens * dollarsPerM / 1e6 * 100 * 1e6;

  const cold = costMicroCents(m, { input: 4979, output: 5, cached: 0, cacheWrite: 4976 });
  assert.equal(cold, Math.round(micro(p.input, 3) + micro(p.cacheWrite, 4976) + micro(p.output, 5)));

  const asFresh = costMicroCents(m, { input: 4979, output: 5, cached: 0 });
  assert.ok(cold > asFresh, "reading a write as plain input under-counts the call");
  assert.ok(cold < asFresh * 1.26, "and a write is not ALSO billed as fresh input");

  // Reads, writes and fresh input in one call: each at its own rate.
  const mixed = costMicroCents(m, { input: 1000, output: 100, cached: 600, cacheWrite: 300 });
  assert.equal(mixed, Math.round(micro(p.input, 100) + micro(p.cached, 600) + micro(p.cacheWrite, 300) + micro(p.output, 100)));

  // Junk in the new field costs nothing extra and never goes negative.
  for (const cacheWrite of [NaN, -50, undefined, null, "12"]) {
    assert.equal(costMicroCents(m, { input: 1000, output: 0, cacheWrite }), costMicroCents(m, { input: 1000, output: 0 }));
  }
});

test("a model with no cacheWrite price bills a write at its input rate", () => {
  // Every current tier has a cacheWrite price, so the fallback is exercised on
  // a throwaway row rather than skipped — a guard that quietly stops running
  // is worse than none.
  const m = "test-model-without-cache-write";
  MODEL_PRICES[m] = { input: 1.0, cached: 0.1, output: 2.0 };
  try {
    assert.equal(costMicroCents(m, { input: 1000, output: 0, cacheWrite: 1000 }), costMicroCents(m, { input: 1000, output: 0 }));
    assert.equal(costMicroCents(m, { input: 1000, output: 0, cacheWrite: 1000 }), 100_000);
  } finally {
    delete MODEL_PRICES[m];
  }
});

test("an unknown model's cache writes price at the MOST expensive tier's write rate", () => {
  const u = { input: 2000, output: 500, cached: 200, cacheWrite: 1500 };
  assert.equal(costMicroCents("gpt-99-unreleased", u), costMicroCents(MODEL_TIERS.thorough, u));
});

test("junk usage cannot produce a negative cost", () => {
  for (const u of [{}, { input: -5, output: -5 }, { input: NaN }, null]) {
    assert.ok(costMicroCents(MODEL_TIERS.fast, u) >= 0);
  }
});

// ── the global budget ────────────────────────────────────────────────────

test("local mode has no budget at all", () => {
  const s = spendState({ enforced: false, at: nextAt() });
  assert.equal(s.enforced, false);
  assert.equal(s.allowed, true);
  assert.equal(s.budget, null);
});

test("TRACELY_DAILY_BUDGET_USD=0 is the documented way to turn the ceiling off", () => {
  const s = spendState({ enforced: true, at: nextAt(), env: { TRACELY_DAILY_BUDGET_USD: "0" } });
  assert.equal(s.enforced, false);
  assert.equal(s.allowed, true);
});

test("a junk budget falls back to the default rather than to unlimited", () => {
  for (const raw of ["", "abc", "-5", undefined]) {
    assert.equal(dailyBudgetUsd({ TRACELY_DAILY_BUDGET_USD: raw }), SPEND.defaultDailyBudgetUsd);
  }
});

test("spend accumulates and eventually refuses", () => {
  const at = nextAt();
  const env = { TRACELY_DAILY_BUDGET_USD: "0.01" }; // 1 cent
  assert.equal(spendState({ at, env }).allowed, true);
  // One source search is 1 cent, so exactly one exhausts a 1-cent day.
  recordSpend({ model: MODEL_TIERS.fast, usage: { input: 10, output: 10 }, webSearchCalls: 1, at });
  const after = spendState({ at, env });
  assert.equal(after.allowed, false, "the budget must refuse once spent");
  assert.equal(after.remaining, 0);
});

test("recording spend in local mode is a no-op — an unmetered run cannot fill a budget", () => {
  const at = nextAt();
  recordSpend({ model: MODEL_TIERS.thorough, usage: { input: 1e6, output: 1e6 }, enforced: false, at });
  assert.equal(spendState({ at, env: { TRACELY_DAILY_BUDGET_USD: "0.01" } }).spent, 0);
});

test("sources are shed BEFORE checks when the budget runs low", () => {
  const at = nextAt();
  const env = { TRACELY_DAILY_BUDGET_USD: "1" }; // 100 cents
  // Spend past the shed threshold but not the whole budget.
  const budget = dailyBudgetMicroCents(env);
  const target = Math.ceil(budget * (1 - SPEND.shedSourcesAtRemainingPct) + 1);
  recordSpend({ model: MODEL_TIERS.fast, usage: { input: 0, output: 0 }, webSearchCalls: target / 1e6, at });
  const s = spendState({ at, env });
  assert.equal(s.allowed, true, "checking must survive");
  assert.equal(s.sourcesAllowed, false, "the 16x-cost route goes first");
});

test("the day key rolls over, so yesterday's spend does not bind today", () => {
  const env = { TRACELY_DAILY_BUDGET_USD: "0.01" };
  const yesterday = Date.UTC(2031, 5, 1, 12);
  const today = Date.UTC(2031, 5, 2, 12);
  recordSpend({ model: MODEL_TIERS.fast, usage: {}, webSearchCalls: 1, at: yesterday });
  assert.equal(spendState({ at: yesterday, env }).allowed, false);
  assert.equal(spendState({ at: today, env }).allowed, true);
});

// ── who a quota counts against ───────────────────────────────────────────

test("callerId prefers a signed-in id over anything the client can send", () => {
  const req = { headers: { "x-tracely-install": "spoofed" }, socket: { remoteAddress: "1.2.3.4" } };
  assert.equal(callerId(req, { userId: "u-1" }), "user:u-1");
});

test("callerId falls to the install header, then to the address", () => {
  const withInstall = { headers: { "x-tracely-install": "abc" }, socket: { remoteAddress: "1.2.3.4" } };
  assert.match(callerId(withInstall, {}), /^install:[0-9a-f]{32}$/);
  const addrOnly = { headers: {}, socket: { remoteAddress: "1.2.3.4" } };
  assert.match(callerId(addrOnly, {}), /^addr:[0-9a-f]{32}$/);
  assert.equal(callerId({ headers: {}, socket: {} }, {}), null);
});

test("a raw client identifier never appears in the caller id", () => {
  const req = { headers: { "x-tracely-install": "install-secret-abc" }, socket: { remoteAddress: "9.9.9.9" } };
  const id = callerId(req, {});
  assert.ok(!id.includes("install-secret-abc"));
  assert.ok(!callerId({ headers: {}, socket: { remoteAddress: "9.9.9.9" } }, {}).includes("9.9.9.9"));
});

test("an over-long install header is ignored rather than hashed into a key", () => {
  const req = { headers: { "x-tracely-install": "x".repeat(5000) }, socket: { remoteAddress: "1.2.3.4" } };
  assert.match(callerId(req, {}), /^addr:/);
});

test("X-Forwarded-For is IGNORED unless the operator declares trusted hops", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.9" }, socket: { remoteAddress: "10.0.0.1" } };
  delete process.env.TRACELY_TRUSTED_PROXY_HOPS;
  assert.equal(clientAddress(req), "10.0.0.1", "a client-set header must not mint rate-limit keys");
  process.env.TRACELY_TRUSTED_PROXY_HOPS = "1";
  assert.equal(clientAddress(req), "203.0.113.9");
  delete process.env.TRACELY_TRUSTED_PROXY_HOPS;
});

test("a spoofed forwarding chain cannot reach past the trusted hops", () => {
  process.env.TRACELY_TRUSTED_PROXY_HOPS = "1";
  // The client sends "1.1.1.1"; our own proxy APPENDS the peer it actually
  // saw. The appended one is the only trustworthy entry — believing the
  // client's would let anyone mint a fresh rate-limit key per request, which
  // is the whole reason the hop count exists.
  const spoofed = { headers: { "x-forwarded-for": "1.1.1.1, 203.0.113.9" }, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(clientAddress(spoofed), "203.0.113.9");
  // A single entry behind one proxy is the ordinary case: that IS the client.
  const honest = { headers: { "x-forwarded-for": "198.51.100.7" }, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(clientAddress(honest), "198.51.100.7");
  // Two of our own proxies: the client's entry is two from the right.
  process.env.TRACELY_TRUSTED_PROXY_HOPS = "2";
  const twoHops = { headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" }, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(clientAddress(twoHops), "198.51.100.7");
  // Declared more hops than the header can support: trust the socket, never a guess.
  process.env.TRACELY_TRUSTED_PROXY_HOPS = "3";
  assert.equal(clientAddress(twoHops), "10.0.0.1");
  delete process.env.TRACELY_TRUSTED_PROXY_HOPS;
});

// ── daily quotas ─────────────────────────────────────────────────────────

test("LOCAL MODE METERS NOTHING — the property the local-first install depends on", () => {
  const at = nextAt();
  const id = "install:local";
  assert.equal(checkQuota(LOCAL, id, at).limit, null);
  assert.equal(sourceSearchQuota(LOCAL, id, at).limit, null);
  for (let i = 0; i < FREE_DAILY_CHECKS + 50; i++) recordCheck(LOCAL, id, at);
  assert.equal(checkQuota(LOCAL, id, at).allowed, true);
});

test("an ANONYMOUS hosted caller with an install id IS metered — the hole this closes", () => {
  const at = nextAt();
  const id = "install:anon-1";
  const q = checkQuota(HOSTED, id, at);
  assert.equal(q.limit, FREE_DAILY_CHECKS, "anonymous used to come back limit:null");
  assert.equal(q.allowed, true);
});

test("an ADDRESS-ONLY caller gets NO daily quota — a whole school shares one", () => {
  const at = nextAt();
  const id = "addr:deadbeefdeadbeefdeadbeefdeadbeef";
  assert.equal(isDailyQuotaKey(id), false);
  assert.equal(checkQuota(HOSTED, id, at).limit, null);
  assert.equal(sourceSearchQuota(HOSTED, id, at).limit, null);
});

test("the check quota actually runs out, and counts before the call", () => {
  const at = nextAt();
  const id = "install:heavy";
  for (let i = 0; i < FREE_DAILY_CHECKS; i++) recordCheck(HOSTED, id, at);
  const q = checkQuota(HOSTED, id, at);
  assert.equal(q.used, FREE_DAILY_CHECKS);
  assert.equal(q.allowed, false);
});

test("a paid plan is not check-metered, but its source searches are (its own day and month limits)", () => {
  // Since the 2026-09-21 plan policy every plan meters source searches
  // (SOURCE_LIMITS); checks stay unmetered on paid plans, bounded by fair use.
  const at = nextAt();
  assert.equal(checkQuota(PAID, "user:u-paid", at).limit, null);
  const q = sourceSearchQuota(PAID, "user:u-paid", at);
  assert.equal(q.limit, 40);
  assert.equal(q.monthLimit, 250);
});

test("anonymous source searches are now metered at the free limit", () => {
  const at = nextAt();
  const id = "install:anon-sources";
  assert.equal(sourceSearchQuota(HOSTED, id, at).limit, FREE_DAILY_SOURCE_SEARCHES);
  for (let i = 0; i < FREE_DAILY_SOURCE_SEARCHES; i++) recordSourceSearch(HOSTED, id, at);
  assert.equal(sourceSearchQuota(HOSTED, id, at).allowed, false);
});

test("checks and source searches are counted separately", () => {
  const at = nextAt();
  const id = "install:mixed";
  for (let i = 0; i < FREE_DAILY_SOURCE_SEARCHES; i++) recordSourceSearch(HOSTED, id, at);
  assert.equal(sourceSearchQuota(HOSTED, id, at).allowed, false);
  assert.equal(checkQuota(HOSTED, id, at).allowed, true, "using up searches must not block checking");
});

// ── the desktop's app routes: their own quota, their own spend pool ──────

test("desktop AI calls are counted apart from extension checks", () => {
  // Under one kind, a free user's desktop use would eat their 400 extension
  // checks — and the reverse.
  const at = nextAt();
  const id = "install:both-products";
  for (let i = 0; i < FREE_DAILY_AI_CALLS; i++) recordAi(HOSTED, id, at);
  assert.equal(aiQuota(HOSTED, id, at).allowed, false, "the free AI allowance runs out");
  assert.equal(checkQuota(HOSTED, id, at).used, 0, "and the extension's check count never moved");
  assert.equal(checkQuota(HOSTED, id, at).allowed, true);
});

test("the free AI allowance is 150, Student and Pro are unmetered", () => {
  const at = nextAt();
  assert.equal(FREE_DAILY_AI_CALLS, 150, "the relay's number, so a free desktop user keeps what they had");
  assert.equal(aiQuota(HOSTED, "install:free-ai", at).limit, 150);
  // The relay had no "student" key, so Student paid and got the free 150.
  assert.equal(aiQuota({ ...PAID, plan: "student" }, "user:u-student", at).limit, null);
  assert.equal(aiQuota(PAID, "user:u-pro", at).limit, null);
  assert.equal(aiQuota(LOCAL, "install:local-ai", at).limit, null, "a local run meters nothing");
  assert.equal(aiQuota(HOSTED, "addr:deadbeefdeadbeefdeadbeefdeadbeef", at).limit, null, "an address never carries a daily quota");
});

test("the app pool and the extension pool are separate days", () => {
  const at = nextAt();
  const env = { TRACELY_DAILY_BUDGET_USD: "1", TRACELY_APP_DAILY_BUDGET_USD: "1" };
  // Burn the whole app day on thorough-model output.
  recordSpend({ model: MODEL_TIERS.thorough, usage: { input: 0, output: 30_000 }, at, pool: "app" });
  assert.equal(spendState({ at, env, pool: "app" }).allowed, false, "the app pool is spent");
  assert.equal(spendState({ at, env }).allowed, true, "the extension pool never saw it");
  assert.equal(spendState({ at, env }).spent, 0);
});

test("TRACELY_APP_DAILY_BUDGET_USD follows the extension budget's rules", () => {
  assert.equal(dailyBudgetMicroCents({}, "app"), SPEND.defaultAppDailyBudgetUsd * 1e8, "absent is the default");
  assert.equal(dailyBudgetMicroCents({ TRACELY_APP_DAILY_BUDGET_USD: "" }, "app"), SPEND.defaultAppDailyBudgetUsd * 1e8, "empty is absent, not 0");
  assert.equal(dailyBudgetMicroCents({ TRACELY_APP_DAILY_BUDGET_USD: "lots" }, "app"), SPEND.defaultAppDailyBudgetUsd * 1e8, "junk is the default, not unlimited");
  assert.equal(dailyBudgetMicroCents({ TRACELY_APP_DAILY_BUDGET_USD: "0" }, "app"), 0, "explicit 0 is off");
  assert.equal(dailyBudgetMicroCents({ TRACELY_APP_DAILY_BUDGET_USD: "3" }, "app"), 3e8);
  // …and setting the app's never moves the extension's.
  assert.equal(dailyBudgetMicroCents({ TRACELY_APP_DAILY_BUDGET_USD: "3" }), SPEND.defaultDailyBudgetUsd * 1e8);
});

// ── the beta pool: testers' Pro grant, kept off the extension's day ──────

test("the beta pool is its own day: beta spend never touches the extension or app pools", () => {
  const at = nextAt();
  const env = { TRACELY_DAILY_BUDGET_USD: "1", TRACELY_APP_DAILY_BUDGET_USD: "1", TRACELY_BETA_DAILY_BUDGET_USD: "1" };
  recordSpend({ model: MODEL_TIERS.thorough, usage: { input: 0, output: 30_000 }, at, pool: "beta" });
  assert.equal(spendState({ at, env, pool: "beta" }).allowed, false, "the beta pool is spent");
  assert.equal(spendState({ at, env }).spent, 0, "the extension pool never saw it");
  assert.equal(spendState({ at, env, pool: "app" }).spent, 0, "nor did the app pool");
  assert.equal(spentTodayMicroCents(at, "extension"), 0);
});

test("TRACELY_BETA_DAILY_BUDGET_USD follows the other budgets' rules", () => {
  const def = SPEND.defaultBetaDailyBudgetUsd * 1e8;
  assert.equal(SPEND.defaultBetaDailyBudgetUsd, 10);
  assert.equal(dailyBudgetMicroCents({}, "beta"), def, "absent is the default");
  assert.equal(dailyBudgetMicroCents({ TRACELY_BETA_DAILY_BUDGET_USD: "" }, "beta"), def, "empty is absent, not 0");
  assert.equal(dailyBudgetMicroCents({ TRACELY_BETA_DAILY_BUDGET_USD: "  " }, "beta"), def, "blank is absent");
  assert.equal(dailyBudgetMicroCents({ TRACELY_BETA_DAILY_BUDGET_USD: "NaN" }, "beta"), def, "NaN is junk, and junk is the default");
  assert.equal(dailyBudgetMicroCents({ TRACELY_BETA_DAILY_BUDGET_USD: "-1" }, "beta"), def, "negative is junk");
  assert.equal(dailyBudgetMicroCents({ TRACELY_BETA_DAILY_BUDGET_USD: "0" }, "beta"), 0, "explicit 0 turns the ceiling off");
  assert.equal(dailyBudgetMicroCents({ TRACELY_BETA_DAILY_BUDGET_USD: "2.5" }, "beta"), 2.5e8);
  assert.equal(dailyBudgetMicroCents({ TRACELY_BETA_DAILY_BUDGET_USD: "3" }), SPEND.defaultDailyBudgetUsd * 1e8, "and never moves the extension's");
});

test("the beta pool is unmetered on a local run, like every pool", () => {
  const at = nextAt();
  recordSpend({ model: MODEL_TIERS.thorough, usage: { input: 1e6, output: 1e6 }, enforced: false, at, pool: "beta" });
  assert.equal(spentTodayMicroCents(at, "beta"), 0);
  assert.equal(spendState({ enforced: false, at, pool: "beta" }).allowed, true);
});

// ── the paid pool: Student/Pro on the extension routes ───────────────────

test("the paid pool is its own day, and TRACELY_PAID_DAILY_BUDGET_USD follows the other budgets' rules", () => {
  const at = nextAt();
  const env = { TRACELY_DAILY_BUDGET_USD: "1", TRACELY_PAID_DAILY_BUDGET_USD: "1" };
  recordSpend({ model: MODEL_TIERS.thorough, usage: { input: 0, output: 30_000 }, at, pool: "paid" });
  assert.equal(spendState({ at, env, pool: "paid" }).allowed, false, "the paid pool is spent");
  assert.equal(spendState({ at, env }).spent, 0, "the extension pool never saw it");

  const def = SPEND.defaultPaidDailyBudgetUsd * 1e8;
  assert.equal(SPEND.defaultPaidDailyBudgetUsd, 10);
  assert.equal(dailyBudgetMicroCents({}, "paid"), def);
  assert.equal(dailyBudgetMicroCents({ TRACELY_PAID_DAILY_BUDGET_USD: "" }, "paid"), def, "empty is absent, not 0");
  assert.equal(dailyBudgetMicroCents({ TRACELY_PAID_DAILY_BUDGET_USD: "NaN" }, "paid"), def);
  assert.equal(dailyBudgetMicroCents({ TRACELY_PAID_DAILY_BUDGET_USD: "0" }, "paid"), 0, "explicit 0 turns the ceiling off");
  assert.equal(dailyBudgetMicroCents({ TRACELY_PAID_DAILY_BUDGET_USD: "3" }), SPEND.defaultDailyBudgetUsd * 1e8, "and never moves the extension's");
});

// ── in-flight reservations ───────────────────────────────────────────────

test("poolRoom counts calls in flight: a reserving pool stops admitting before the calls land", () => {
  const at = nextAt();
  const env = { TRACELY_BETA_DAILY_BUDGET_USD: "1" };
  assert.equal(reservedMicroCents("beta"), 0);
  assert.equal(poolRoom({ at, env, pool: "beta" }).room, true);
  const a = reserveSpend("beta", 0.6e8); // $0.60 in flight
  assert.equal(poolRoom({ at, env, pool: "beta" }).room, true, "$0.40 unreserved is still room");
  const b = reserveSpend("beta", 0.6e8); // admitted on that room: at most one call over
  assert.equal(poolRoom({ at, env, pool: "beta" }).room, false, "held reservations cover the pool");
  assert.equal(poolRoom({ at, env, pool: "beta" }).budget.remaining, 1e8, "spendState still reports spend on disk only");
  a.release();
  assert.equal(poolRoom({ at, env, pool: "beta" }).room, true, "a finished call gives its hold back");
  b.release();
  b.release(); // idempotent: the handler's finally may release what a route already did
  assert.equal(reservedMicroCents("beta"), 0);
  assert.equal(reservedMicroCents("extension"), 0, "pools hold separately");
});

test("a reservation only ever shrinks, and an unmetered pool always has room", () => {
  const r = reserveSpend("paid", 1000);
  r.resize(400);
  assert.equal(r.amount, 400);
  assert.equal(reservedMicroCents("paid"), 400);
  r.resize(5000); // never above what admission allowed
  assert.equal(r.amount, 400);
  r.release();
  r.resize(900); // a released hold stays released
  assert.equal(reservedMicroCents("paid"), 0);

  const big = reserveSpend("beta", 1e12);
  assert.equal(poolRoom({ enforced: false, pool: "beta" }).room, true, "local: nothing is metered");
  assert.equal(poolRoom({ env: { TRACELY_BETA_DAILY_BUDGET_USD: "0" }, pool: "beta" }).room, true, "an explicit 0 removes the ceiling");
  big.release();
  assert.throws(() => reserveSpend("nope", 1), /unknown spend pool/);
});

test("extend grows a hold for a request's further calls, only while the pool has room", () => {
  // A check that truncates splits into two more calls; they are admitted
  // exactly as the first call was, or not made.
  const at = nextAt();
  const env = { TRACELY_BETA_DAILY_BUDGET_USD: "1" };
  const r = reserveSpend("beta", 0.3e8); // $0.30
  assert.equal(r.extend(0.6e8, { at, env }), true, "$0.70 unreserved: room");
  assert.equal(r.amount, 0.9e8);
  assert.equal(reservedMicroCents("beta"), 0.9e8);
  assert.equal(r.extend(0.6e8, { at, env }), true, "$0.10 left is still room: the last admission may go over");
  assert.equal(reservedMicroCents("beta"), 1.5e8);
  assert.equal(r.extend(1, { at, env }), false, "no room: nothing held");
  assert.equal(r.amount, 1.5e8);
  r.resize(1e8); // resize still only shrinks
  assert.equal(r.amount, 1e8);
  r.release();
  assert.equal(reservedMicroCents("beta"), 0, "release gives back everything, extensions included");
  assert.equal(r.extend(1, { at, env }), false, "a released hold cannot grow");
  assert.equal(reservedMicroCents("beta"), 0);

  const unmetered = reserveSpend("paid", 1e12);
  assert.equal(unmetered.extend(5, { at, env: { TRACELY_PAID_DAILY_BUDGET_USD: "0" } }), true, "no ceiling: always room");
  unmetered.release();
});

// ── rate limiting ────────────────────────────────────────────────────────

test("the rate limiter admits up to the limit, then refuses", () => {
  const rl = keyedRateLimiter(3, 60_000);
  for (let i = 0; i < 3; i++) { assert.equal(rl.ok("k"), true); rl.stamp("k"); }
  assert.equal(rl.ok("k"), false);
  assert.equal(rl.ok("other"), true, "keys are independent");
});

test("the rate limiter's key map is bounded against a rotating attacker", () => {
  const rl = keyedRateLimiter(5, 60_000, 10);
  for (let i = 0; i < 500; i++) rl.stamp(`k${i}`);
  assert.ok(rl.size() <= 10, `map grew to ${rl.size()}`);
});

// ── the header has to survive the browser ────────────────────────────────

test("X-Tracely-Beta is APPENDED to the preflight's allowed headers, the frozen three intact", () => {
  // The beta build sends it on every relayed call and on /api/entitlement;
  // unlisted, the preflight fails and every tester is silently free. The
  // first three are baked into the extension under Web Store review, so they
  // must survive exactly, in order.
  const server = srcOf("server.js");
  const m = server.match(/"Access-Control-Allow-Headers":\s*"([^"]+)"/);
  assert.ok(m, "Access-Control-Allow-Headers not found in server.js");
  assert.deepEqual(m[1].split(",").map((h) => h.trim()), ["Content-Type", "Authorization", "X-Tracely-Install", "X-Tracely-Beta"]);
});

test("X-Tracely-Install is allowed through the CORS preflight", async () => {
  // The extension sends this header; if Access-Control-Allow-Headers does not
  // list it the browser blocks the preflight and it never arrives. The server
  // would then key every extension user on the address rung, which carries no
  // daily quota by design — so the quota layer would be silently dead. Same
  // failure shape as /api/flow missing from background.js's API_PATHS.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const pathMod = await import("node:path");
  const here = pathMod.dirname(fileURLToPath(import.meta.url));
  const server = readFileSync(pathMod.join(here, "..", "server.js"), "utf8");
  const m = server.match(/"Access-Control-Allow-Headers":\s*"([^"]+)"/);
  assert.ok(m, "Access-Control-Allow-Headers not found in server.js");
  const allowed = m[1].split(",").map((h) => h.trim().toLowerCase());
  assert.ok(allowed.includes("x-tracely-install"), `preflight allows only: ${m[1]}`);

  // And the extension must actually send it, or the quota layer is dead from
  // the other end.
  const ext = [pathMod.join(here, "..", "extension"), pathMod.join(here, "..", "..", "extension")]
    .map((d) => pathMod.join(d, "background.js"))
    .find((f) => { try { readFileSync(f); return true; } catch { return false; } });
  assert.ok(ext, "could not locate extension/background.js");
  assert.match(readFileSync(ext, "utf8"), /X-Tracely-Install/,
    "background.js must send the header the server meters on");
});

// ── billing identity ────────────────────────────────────────────────────

test("/api/entitlement exposes userId, and the extension forwards it", async () => {
  // The Stripe webhook resolves a payment to an account via
  // client_reference_id first; the other two rungs (a learned customer
  // mapping, then the payer's email) are weaker, and email matching is wrong
  // exactly when a student pays with a parent's card. Nothing fills the first
  // rung unless the account id reaches the checkout link, which means it has
  // to travel server -> worker -> link. Each hop is pinned here because a
  // break anywhere along it is silent: checkout still succeeds, the payment
  // just lands on nobody.
  //
  // The last hop differs by page. The options page (an extension page) builds
  // the link itself. The widgets live in an OPEN shadow root on host pages,
  // so the id must never reach them — any site could read it — and their PRO
  // link asks the worker to open the order page with the id instead.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const pathMod = await import("node:path");
  const here = pathMod.dirname(fileURLToPath(import.meta.url));
  const root = pathMod.join(here, "..");

  const server = readFileSync(pathMod.join(root, "server.js"), "utf8");
  const route = server.slice(server.indexOf('url.pathname === "/api/entitlement"'));
  assert.match(route.slice(0, 900), /userId:\s*ent\.userId/, "/api/entitlement must return userId");

  const extDir = [pathMod.join(root, "extension"), pathMod.join(root, "..", "extension")]
    .find((d) => { try { readFileSync(pathMod.join(d, "background.js")); return true; } catch { return false; } });
  assert.ok(extDir, "could not locate extension/");

  const bg = readFileSync(pathMod.join(extDir, "background.js"), "utf8");
  assert.match(bg, /userId:\s*fromExtensionPage\(sender\)\s*\?\s*ent\?\.userId/,
    "the worker must forward userId to its own pages, and only to them");

  for (const file of ["options.js", "background.js"]) {
    const src = readFileSync(pathMod.join(extDir, file), "utf8");
    assert.match(src, /function orderUrl\(/, `${file} must build the upgrade link through orderUrl()`);
    assert.match(src, /uid=\$\{encodeURIComponent\(userId\)\}/, `${file} must attach uid`);
  }
  assert.match(bg, /tabs\.create\(\{ url: orderUrl\(ent\?\.userId\) \}\)/, "the widgets' PRO link opens WITH the id");

  const content = readFileSync(pathMod.join(extDir, "content.js"), "utf8");
  assert.doesNotMatch(content, /uid=/, "content.js must never put the account id in a host page");
  assert.match(content, /type: "tracely-open-order"/, "the widgets' PRO link must go through the worker");
});

test("orderUrl degrades to a bare link when signed out rather than sending uid=null", () => {
  // Reproduces the helper options.js and background.js carry. `uid=null` as a literal
  // string would reach Stripe as a client_reference_id of "null", which is
  // worse than none: the webhook would key a real payment to a fake account.
  const ORDER_URL = "https://jointracely.com/order";
  const orderUrl = (userId) => (!userId ? ORDER_URL : `${ORDER_URL}?uid=${encodeURIComponent(userId)}`);
  assert.equal(orderUrl(null), ORDER_URL);
  assert.equal(orderUrl(undefined), ORDER_URL);
  assert.equal(orderUrl(""), ORDER_URL);
  assert.equal(orderUrl("abc-123"), `${ORDER_URL}?uid=abc-123`);
  assert.equal(orderUrl("a b/c"), `${ORDER_URL}?uid=a%20b%2Fc`);
});

// ── the cancellation path ────────────────────────────────────────────────

test("a paying subscriber is never sent to the pricing page to cancel", async () => {
  // The public FAQ promises "cancel in one click". manageLink used to point at
  // /order for EVERY state, so a subscriber trying to leave was shown the
  // plans they were already on — and there was no cancellation path at all.
  // Card networks expect a subscription business to offer one.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const pathMod = await import("node:path");
  const here = pathMod.dirname(fileURLToPath(import.meta.url));
  const extDir = [pathMod.join(here, "..", "extension"), pathMod.join(here, "..", "..", "extension")]
    .find((d) => { try { readFileSync(pathMod.join(d, "options.js")); return true; } catch { return false; } });
  assert.ok(extDir, "could not locate extension/");
  const src = readFileSync(pathMod.join(extDir, "options.js"), "utf8");

  assert.match(src, /const PORTAL_URL\s*=/, "options.js must carry a Stripe customer-portal URL slot");
  // Three distinct destinations, not one. The free branch goes to pricing; a
  // paid branch must not. Asserted on the PROPERTY (the paid branch's href is
  // built from PORTAL_URL) rather than on the exact spelling — the first
  // version of this matched `manage.href = PORTAL_URL` literally and broke the
  // moment the URL gained a ?prefilled_email= query, which was an improvement
  // to the thing it was guarding.
  const portalStart = src.indexOf("} else if (PORTAL_URL) {");
  assert.ok(portalStart > 0, "the portal branch is missing");
  const portalBranch = src.slice(portalStart, src.indexOf("} else {", portalStart));
  assert.match(portalBranch, /PORTAL_URL/, "a paid plan with a portal must link to the portal");
  // The load-bearing half: the paid branch must not reach the pricing page by
  // ANY route. A "does it mention PORTAL_URL" check alone is useless — a
  // branch can set href to orderUrl() and still mention PORTAL_URL two lines
  // later, which is precisely what slipped past the first version of this.
  assert.ok(!/orderUrl\s*\(/.test(portalBranch), "the portal branch must not fall back to the order page");
  assert.match(src, /mailto:\$\{SUPPORT_EMAIL\}/, "with no portal configured it must offer a real way to cancel, not the pricing page");

  // And the pricing-page link must be reachable ONLY from the free branch.
  // Both paid branches, to the end of the if-chain — not a fixed character
  // window, which silently stops covering the code as it grows.
  const paidHalf = src.slice(src.indexOf("} else if (PORTAL_URL) {"), src.indexOf("$(\"acctHint\")"));
  assert.ok(!/orderUrl\s*\(/.test(paidHalf), "neither paid branch may fall back to the order page");
});

// ── the Stripe setup script's load-bearing choices ───────────────────────

test("stripe-setup creates two products, not two prices on one", async () => {
  // The customer portal's Switch plan cannot list two prices that share a
  // product AND a recurring interval. Switch plan is what stops a Student who
  // opens the Pro link being billed for both, so one product would quietly
  // remove the only protection against double-subscription.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const pathMod = await import("node:path");
  const here = pathMod.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(pathMod.join(here, "..", "scripts", "stripe-setup.mjs"), "utf8");

  const plans = [...src.matchAll(/product:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(plans).size, 2, "expected two distinct product names");

  // Prices must be advertised amounts. $10 is the struck-through "was" price
  // on the pricing page and must never become a sellable price object.
  const cents = [...src.matchAll(/cents:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(cents.sort((a, b) => a - b), [499, 999]);
  assert.ok(!cents.includes(1000), "$10 must not be a price — it is display only");
});

test("stripe-setup never sets tax_behavior on a price", () => {
  // tax_behavior is IMMUTABLE once set to inclusive or exclusive. Leaving it
  // unset lets the account default govern, which stays a settings change;
  // baking it in means new price ids, re-edited links and re-edited .env.
  const src = srcOf("scripts/stripe-setup.mjs");
  const pFrom = src.indexOf('await post("prices"');
  assert.ok(pFrom > 0, "the price creation call is missing");
  const priceCall = src.slice(pFrom, src.indexOf("priceIds[p.env] = price.id", pFrom));
  assert.ok(priceCall.length > 40, "the price slice is empty — the assertion below would pass vacuously");
  assert.ok(!/tax_behavior/.test(priceCall), "a price must not carry tax_behavior");
});

test("stripe-setup subscribes all four webhook events", () => {
  const src = srcOf("scripts/stripe-setup.mjs");
  for (const e of ["checkout.session.completed", "customer.subscription.created",
                   "customer.subscription.updated", "customer.subscription.deleted"]) {
    assert.match(src, new RegExp(e.replace(/\./g, "\\.")), `missing event ${e}`);
  }
});

test("stripe-setup leaves Manage downgrades off and defaults to a dry run", () => {
  const src = srcOf("scripts/stripe-setup.mjs");
  // Enabling manage_downgrades attaches a subscription schedule, and a
  // customer with a scheduled update CANNOT cancel until it resolves — which
  // silently revokes the cancel path the pricing page promises.
  assert.ok(!/manage_downgrades/.test(src) || /manage_downgrades[^\n]*false/.test(src),
    "manage downgrades must not be enabled");
  assert.match(src, /const APPLY = process\.argv\.includes\("--apply"\)/,
    "the script must change nothing without an explicit --apply");
});

test("stripe-setup puts no user id in Payment Link metadata", () => {
  // A link's metadata is ONE static value copied onto every session, so a user
  // id there maps every paying customer onto a single Supabase account.
  const src = srcOf("scripts/stripe-setup.mjs");
  // Both bounds must come from AFTER the post call. "linkUrls[p.key]" also
  // appears earlier, in the reuse branch, so searching from 0 sliced BACKWARDS
  // and produced an empty string — on which the no-user-id check passed
  // vacuously while the metadata check failed. An empty slice satisfies every
  // negative assertion you can write.
  const from = src.indexOf('await post("payment_links"');
  assert.ok(from > 0, "the payment-link creation call is missing");
  const linkCall = src.slice(from, src.indexOf("linkUrls[p.key]", from))
    // Strip comments first: the block carries a comment EXPLAINING why no user
    // id is here, and matching that made the test fail on its own rationale.
    .replace(/\/\/[^\n]*/g, "");
  assert.match(linkCall, /metadata\[price_id\]/);
  assert.ok(!/supabase|user_id|uid/i.test(linkCall), "no user identifier belongs in link metadata");
});

// ESM: no require() available, and these run before the awaited imports in the
// tests above, so the modules are pulled in at the top of the file instead.
function srcOf(rel) {
  return fsReadFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8");
}

// ── the Supabase project the code points at ──────────────────────────────

test("the extension's Supabase project is live, not a dead one", () => {
  /* The old project (epafyygdvvkgpdkbevqi) was deleted while the extension,
   * the manifest's host_permissions and the server's .env all still named it.
   * Nothing errored: planForRequest fails CLOSED to 'free', so every account
   * silently read as unpaid and no subscriber could ever have been entitled.
   * That is the worst shape a config bug can take — it looks exactly like
   * "nobody has bought yet".
   *
   * This cannot check liveness offline, but it CAN pin the three places that
   * must agree, so a future move updates all of them or fails here. */
  const bg = srcOf("../extension/background.js");
  const url = bg.match(/const SUPABASE_URL = "https:\/\/([a-z0-9]+)\.supabase\.co"/);
  assert.ok(url, "SUPABASE_URL not found in background.js");
  const ref = url[1];

  // The anon key is a JWT whose payload names the project it belongs to. A
  // key from a different project is the exact mismatch that produced this bug.
  const anon = bg.match(/const SUPABASE_ANON_KEY = "([^"]+)"/);
  assert.ok(anon, "SUPABASE_ANON_KEY not found");
  const payload = JSON.parse(Buffer.from(anon[1].split(".")[1], "base64url").toString());
  assert.equal(payload.ref, ref, "the anon key belongs to a different project than SUPABASE_URL");
  assert.equal(payload.role, "anon", "that is not an anon key — a service_role key must never ship in the extension");

  // host_permissions must name the same project or the worker cannot reach it.
  const manifest = JSON.parse(srcOf("../extension/manifest.json"));
  assert.ok(manifest.host_permissions.includes(`https://${ref}.supabase.co/*`),
    `host_permissions does not allow ${ref}.supabase.co`);
});

// ── the pinned extension id ──────────────────────────────────────────────

test("the manifest key derives the extension id Supabase and the server expect", async () => {
  /* The `key` field fixes the extension id for unpacked builds, so every
   * teammate's local copy shares ONE id with the published extension — which
   * means one chromiumapp.org entry in Supabase's redirect allowlist covers
   * all of them. Without it each unpacked copy gets an id derived from its
   * folder path, and Google sign-in fails for everyone but whoever registered
   * theirs.
   *
   * Chrome derives the id as sha256(DER public key), first 16 bytes, each hex
   * nibble mapped 0-f onto a-p. Deriving it here means a swapped key is caught
   * before it silently breaks sign-in for the whole team. */
  const { createHash } = await import("node:crypto");
  const manifest = JSON.parse(srcOf("../extension/manifest.json"));
  assert.ok(manifest.key, "manifest.key is missing — unpacked ids would vary per folder");

  const der = Buffer.from(manifest.key, "base64");
  assert.equal(der[0], 0x30, "key is not a DER SEQUENCE");
  assert.ok(der.length > 200, `key is only ${der.length} bytes — truncated?`);

  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  assert.equal(id, "dffmoeebkkghhgcklkbmaibfhgiegmdm",
    "the manifest key no longer derives the id registered with Supabase and the Web Store");
});
