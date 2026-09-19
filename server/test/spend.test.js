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
const { spendState, recordSpend, dailyBudgetMicroCents } = await import("../lib/spend.js");
const { callerId, isDailyQuotaKey, clientAddress, checkQuota, recordCheck,
        sourceSearchQuota, recordSourceSearch } = await import("../lib/entitlement.js");
const { FREE_DAILY_CHECKS, FREE_DAILY_SOURCE_SEARCHES } = await import("../shared/plan.js");
const { SPEND, dailyBudgetUsd, keyedRateLimiter } = await import("../shared/guards.js");

const HOSTED = { plan: "free", userId: null, enforced: true };
const LOCAL = { plan: "free", userId: null, enforced: false };
const PAID = { plan: "pro", userId: "u-paid", enforced: true };
// A distinct day per test, so the shared ledger cannot leak between them.
let dayN = 0;
const nextAt = () => Date.UTC(2030, 0, 1 + dayN++, 12);

// ── cost arithmetic ──────────────────────────────────────────────────────

test("costMicroCents reproduces the prices measured against the real API", () => {
  // 10-sentence check on the fast model, measured 2026-09-13 at 0.0641 cents.
  const c = costMicroCents("gpt-5-nano", { input: 974, output: 1481, cached: 0 });
  assert.equal((c / 1e6).toFixed(4), "0.0641");
});

test("a dated model id prices the same as its family", () => {
  // OpenAI answers with "gpt-5-nano-2025-08-07", not "gpt-5-nano". Pricing the
  // reply by the id it RETURNS is the whole point, so the suffix must resolve.
  const bare = costMicroCents("gpt-5-nano", { input: 1000, output: 1000 });
  const dated = costMicroCents("gpt-5-nano-2025-08-07", { input: 1000, output: 1000 });
  assert.equal(dated, bare);
});

test("an unknown model prices as the MOST expensive tier, never as free", () => {
  const unknown = costMicroCents("gpt-99-unreleased", { input: 1000, output: 1000 });
  const top = costMicroCents(MODEL_TIERS.thorough, { input: 1000, output: 1000 });
  assert.equal(unknown, top);
  assert.ok(unknown > 0, "a model rename must not silently uncap spending");
});

test("the web_search call fee dominates a source search, and is not in the tokens", () => {
  const tokensOnly = costMicroCents("gpt-5-nano", { input: 1000, output: 800 });
  const withSearch = costMicroCents("gpt-5-nano", { input: 1000, output: 800 }, { webSearchCalls: 1 });
  assert.ok(withSearch - tokensOnly === 1e6, "one search should add exactly 1 cent");
  assert.ok(withSearch > tokensOnly * 20, "pricing sources off tokens alone under-counts them badly");
});

test("cached input is charged at the cached rate, not the fresh rate", () => {
  const allFresh = costMicroCents("gpt-5-nano", { input: 1000, output: 0, cached: 0 });
  const allCached = costMicroCents("gpt-5-nano", { input: 1000, output: 0, cached: 1000 });
  assert.ok(allCached < allFresh);
  assert.equal(allCached, Math.round(1000 * MODEL_PRICES["gpt-5-nano"].cached / 1e6 * 100 * 1e6));
});

test("junk usage cannot produce a negative cost", () => {
  for (const u of [{}, { input: -5, output: -5 }, { input: NaN }, null]) {
    assert.ok(costMicroCents("gpt-5-nano", u) >= 0);
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
  recordSpend({ model: "gpt-5-nano", usage: { input: 10, output: 10 }, webSearchCalls: 1, at });
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
  recordSpend({ model: "gpt-5-nano", usage: { input: 0, output: 0 }, webSearchCalls: target / 1e6, at });
  const s = spendState({ at, env });
  assert.equal(s.allowed, true, "checking must survive");
  assert.equal(s.sourcesAllowed, false, "the 16x-cost route goes first");
});

test("the day key rolls over, so yesterday's spend does not bind today", () => {
  const env = { TRACELY_DAILY_BUDGET_USD: "0.01" };
  const yesterday = Date.UTC(2031, 5, 1, 12);
  const today = Date.UTC(2031, 5, 2, 12);
  recordSpend({ model: "gpt-5-nano", usage: {}, webSearchCalls: 1, at: yesterday });
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

test("a paid plan is not check-metered — it is bounded by the global budget", () => {
  const at = nextAt();
  assert.equal(checkQuota(PAID, "user:u-paid", at).limit, null);
  assert.equal(sourceSearchQuota(PAID, "user:u-paid", at).limit, null);
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
  // to travel server -> worker -> page. Each hop is pinned here because a
  // break anywhere along it is silent: checkout still succeeds, the payment
  // just lands on nobody.
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
  assert.match(bg, /userId:\s*ent\?\.userId/, "the worker must forward userId to the UI");

  for (const file of ["options.js", "content.js"]) {
    const src = readFileSync(pathMod.join(extDir, file), "utf8");
    assert.match(src, /function orderUrl\(/, `${file} must build the upgrade link through orderUrl()`);
    assert.match(src, /uid=\$\{encodeURIComponent\(userId\)\}/, `${file} must attach uid`);
  }
});

test("orderUrl degrades to a bare link when signed out rather than sending uid=null", () => {
  // Reproduces the helper both extension files carry. `uid=null` as a literal
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
