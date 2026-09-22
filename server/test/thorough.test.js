/**
 * Pro's Thorough allowance over real HTTP: "Explain in depth" (/api/check
 * deep:true) and the desktop's /api/critique — the only two calls that may
 * run the thorough model on a hosted server (shared/plan.js THOROUGH_ROUTES).
 *
 * One hosted server (a mock Supabase makes it enforced) with OpenAI stubbed by
 * a preload, so each test reads the exact model, effort and output ceiling the
 * server sent. Every stubbed call reports 5,000 input + 1,000 output tokens:
 * 10 cents on gpt-6-astra, 0.22 cents on gpt-5.6-luna. Against the $1.50
 * allowance and the 15-cent (explanation) / 35-cent (critique) reservation:
 *   - an explanation runs on astra while allowance - spent - held >= 15 cents,
 *     so 14 sequential ones fit (140 cents) and the 15th runs on luna;
 *   - a burst can never be admitted past the allowance: at most 150 / 15 = 10
 *     explanations hold at once;
 *   - Free and Student are refused "Explain in depth" (403 plan_required);
 *   - a failed call that was billed is charged to the allowance, and every
 *     hold is released however the request ended.
 * A marker in the input steers the stub: TRIGGER-SLOW waits 300 ms,
 * TRIGGER-DATED answers with a dated snapshot id ("gpt-6-astra-2026-08-01"),
 * TRIGGER-TRUNCATE / TRIGGER-GARBAGE fail, TRIGGER-USAGE-<in>-<out> overrides
 * the token counts. Each test uses its own account so no count is shared.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextMonthStart, nextUsageDay } from "../shared/plan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.js");
const TMP = mkdtempSync(path.join(tmpdir(), "tracely-thorough-"));
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

const ASTRA = "gpt-6-astra";
const LUNA = "gpt-5.6-luna";

/* Tokens "tok-<plan>-<name>" are accounts "u-<plan>-<name>" on that plan. */
const supabase = http.createServer((req, res) => {
  const m = /^Bearer tok-(free|student|pro)-([\w-]+)$/.exec(req.headers.authorization ?? "");
  const user = req.url === "/auth/v1/user" && m
    ? { id: `u-${m[1]}-${m[2]}`, email: `${m[2]}@example.test`, app_metadata: m[1] === "free" ? {} : { plan: m[1] } }
    : undefined;
  res.writeHead(user ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify(user ?? { msg: "invalid token" }));
});

/* OpenAI, stubbed in the server process: answers from the request's own
 * schema and logs what it was sent. Written to a temp dir at runtime, because
 * anything under test/ would be run as a test file. */
const OPENAI_LOG = path.join(TMP, "openai.jsonl");
const STUB = path.join(TMP, "openai-stub.mjs");
writeFileSync(OPENAI_LOG, "");
writeFileSync(STUB, `
import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
const emptyFor = (s) => {
  if (!s) return {};
  const out = {};
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    const t = Array.isArray(v.type) ? v.type[0] : v.type;
    out[k] = t === "array" ? [] : t === "object" ? emptyFor(v) : t === "number" || t === "integer" ? 0 : t === "boolean" ? false : "";
  }
  return out;
};
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith("https://api.openai.com/")) return real(url, init);
  const body = JSON.parse(init.body);
  const input = JSON.stringify(body.input);
  if (input.includes("TRIGGER-SLOW")) await new Promise((r) => setTimeout(r, 300));
  const tag = (/TAG-([\\w-]+)/.exec(input) || [])[1] || null;
  appendFileSync(process.env.TRACELY_TEST_OPENAI_LOG, JSON.stringify({ tag, model: body.model, effort: body.reasoning?.effort ?? null, maxTokens: body.max_output_tokens ?? null, webSearch: Array.isArray(body.tools) }) + "\\n");
  const u = /TRIGGER-USAGE-(\\d+)-(\\d+)/.exec(input);
  const usage = u ? { input_tokens: Number(u[1]), output_tokens: Number(u[2]) } : { input_tokens: 5000, output_tokens: 1000 };
  let reply;
  if (input.includes("TRIGGER-TRUNCATE")) reply = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1000, output_tokens: 16000 } };
  else if (input.includes("TRIGGER-GARBAGE")) reply = { output_text: "this is not json {" };
  else if (body.tools) reply = { output_text: JSON.stringify({ sources: [{ title: "A", url: "https://a.example/", publisher: "a", snippet: "s", stance: "supports" }] }) };
  else reply = { output_text: JSON.stringify(emptyFor(body.text?.format?.schema)) };
  const model = input.includes("TRIGGER-DATED") ? body.model + "-2026-08-01" : body.model;
  return new Response(JSON.stringify({ status: "completed", model, usage, ...reply }), { status: 200, headers: { "Content-Type": "application/json" } });
};
`);
const openaiLog = (tag) => readFileSync(OPENAI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.tag === tag);

const SCRUB = ["TRACELY_BETA_TOKENS", "TRACELY_BETA_DAILY_BUDGET_USD", "TRACELY_DAILY_BUDGET_USD", "TRACELY_APP_DAILY_BUDGET_USD", "TRACELY_PAID_DAILY_BUDGET_USD",
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "OPENAI_API_KEY", "TRACELY_MOCK", "TRACELY_EXTENSION_ID", "TRACELY_TRUSTED_PROXY_HOPS", "TRACELY_LLM_PROVIDER"];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.includes(k)));
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
async function boot(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = await freePort();
    const child = spawn(process.execPath, ["--import", STUB, SERVER], {
      env: { ...baseEnv, PORT: String(p), TRACELY_DATA_DIR: mkdtempSync(path.join(TMP, "data-")), ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let exited = false;
    child.on("exit", () => { exited = true; });
    child.stderr.on("data", (d) => { stderr += d; });
    const base = `http://127.0.0.1:${p}`;
    for (let i = 0; i < 200 && !exited; i++) {
      try { if ((await fetch(`${base}/api/status`)).ok && !exited) return { base, child }; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();
    if (!exited) throw new Error(`server on ${p} did not start: ${stderr}`);
  }
  throw new Error("could not find a free port for a test server");
}

let S;
test.before(async () => {
  await new Promise((r) => supabase.listen(0, "127.0.0.1", r));
  S = await boot({
    SUPABASE_URL: `http://127.0.0.1:${supabase.address().port}`, SUPABASE_ANON_KEY: "anon",
    OPENAI_API_KEY: "sk-test-not-a-real-key", TRACELY_TEST_OPENAI_LOG: OPENAI_LOG,
    TRACELY_BETA_TOKENS: "right-token", TRACELY_BETA_DAILY_BUDGET_USD: "20",
    TRACELY_PAID_DAILY_BUDGET_USD: "20", TRACELY_APP_DAILY_BUDGET_USD: "20",
  });
});
test.after(() => { S?.child.kill(); supabase.close(); });

function call(method, p, { body, install, token, headers = {} } = {}) {
  return fetch(`${S.base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(install ? { "X-Tracely-Install": install } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}
/* One "Explain in depth" request: one sentence carrying the stub's markers. */
const explain = (tag, opts = {}, { extra = "", body = {} } = {}) => {
  const text = `The Treaty of Paris was signed in 1783. TAG-${tag} ${extra}`.trim();
  return call("POST", "/api/check", { install: `inst-${tag}`, ...opts, body: { text, sentences: [{ id: "s1", text }], deep: true, ...body } });
};

// ── Explain in depth: admission ──────────────────────────────────────────

test("Pro: Explain in depth runs the thorough model at low under a 2,000-token ceiling, and reports the allowance", async () => {
  const r = await explain("pro-first", { token: "tok-pro-first" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.modelUsed, ASTRA);
  assert.deepEqual(r.body.thorough, { used: true, remainingPct: 93, resetsOn: nextMonthStart() },
    "10 of 150 cents spent: 93% left, floored; resets on the 1st");
  assert.deepEqual(openaiLog("pro-first"), [{ tag: "pro-first", model: ASTRA, effort: "low", maxTokens: 2000, webSearch: false }]);
});

test("the client's model and effort are ignored: an ordinary check is the fast model at medium on every plan", async () => {
  const asks = [[ASTRA, "high"], ["gpt-5.6-terra", "low"], ["gpt-5.4", "medium"], ["gpt-5-nano", "low"], ["junk", "junk"], [undefined, undefined]];
  for (const [i, [model, effort]] of asks.entries()) {
    for (const plan of ["free", "student", "pro"]) {
      const tag = `plain-${plan}-${i}`;
      const text = `The Treaty of Paris was signed in 1783. TAG-${tag}`;
      const r = await call("POST", "/api/check", { token: `tok-${plan}-plain`, body: { text, sentences: [{ id: "s1", text }], model, effort } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.modelUsed, LUNA, `${plan} asking ${model}`);
      assert.ok(!("thorough" in r.body), "no thorough field on an ordinary check");
      assert.deepEqual(openaiLog(tag).map((c) => [c.model, c.effort, c.maxTokens]), [[LUNA, "medium", 16000]]);
    }
  }
});

test("Free, Student and anonymous callers are refused Explain in depth — 403 plan_required, no model call", async () => {
  for (const opts of [{ token: "tok-free-deep" }, { token: "tok-student-deep" }, { install: "anon-deep" }]) {
    const tag = `refused-${opts.token ?? "anon"}`;
    const r = await explain(tag, opts);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error.kind, "plan_required");
    assert.equal(r.body.error.message, "Explain in depth comes with Pro.");
    assert.equal(openaiLog(tag).length, 0);
  }
});

test("Explain in depth takes exactly one sentence; `deep` other than true is an ordinary check", async () => {
  const text = "One claim. TAG-two-sentences Another claim.";
  const two = await call("POST", "/api/check", { token: "tok-pro-two", body: { text, sentences: [{ id: "a", text: "One claim." }, { id: "b", text: "Another claim." }], deep: true } });
  assert.equal(two.status, 400);
  assert.equal(two.body.error.kind, "bad_request");
  const truthy = await explain("deep-string", { token: "tok-free-truthy" }, { body: { deep: "true" } });
  assert.equal(truthy.status, 200, "only the boolean true asks for depth — an old build never sends the field");
  assert.equal(truthy.body.modelUsed, LUNA);
});

// ── Explain in depth: the allowance's edge ───────────────────────────────

test("an explanation runs on astra only while the allowance covers its 15-cent worst case; then the same call runs on luna, never refused", async () => {
  const seen = [];
  for (let i = 0; i < 15; i++) {
    const r = await explain(`drain-${i}`, { token: "tok-pro-drain" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    seen.push([r.body.modelUsed, r.body.thorough.used]);
  }
  assert.deepEqual(seen.slice(0, 14), Array(14).fill([ASTRA, true]), "150 - 10k >= 15 for k = 0..13");
  assert.deepEqual(seen[14], [LUNA, false], "10 cents left cannot cover a 15-cent worst case");
  const last = openaiLog("drain-14");
  assert.deepEqual(last.map((c) => [c.model, c.effort, c.maxTokens]), [[LUNA, "medium", 16000]], "the fallback is an ordinary check");
  const after = await explain("drain-after", { token: "tok-pro-drain" });
  assert.deepEqual(after.body.thorough, { used: false, remainingPct: 6, resetsOn: nextMonthStart() },
    "a luna fallback is not charged to the allowance");
});

test("no overshoot under concurrency: a burst of 18 explanations admits exactly 10 (150 / 15), and every hold is released after", async () => {
  const burst = await Promise.all(Array.from({ length: 18 }, (_, i) => explain(`burst-${i}`, { token: "tok-pro-burst" }, { extra: "TRIGGER-SLOW" })));
  for (const r of burst) assert.equal(r.status, 200, JSON.stringify(r.body));
  const ran = burst.filter((r) => r.body.thorough.used);
  assert.equal(ran.length, 10);
  assert.ok(ran.every((r) => r.body.modelUsed === ASTRA));
  const astraCalls = Array.from({ length: 18 }, (_, i) => openaiLog(`burst-${i}`)).flat().filter((c) => c.model === ASTRA);
  assert.equal(astraCalls.length, 10, "what was sent to the provider, not just what was reported");
  // 100 of 150 cents spent and nothing still held: 50 cents covers another.
  const next = await explain("burst-next", { token: "tok-pro-burst" });
  assert.equal(next.body.thorough.used, true, "holds from the burst were released");
  assert.equal(next.body.thorough.remainingPct, 26, "110 of 150 cents spent");
});

test("the hold is sized from the prompt's bytes, not a flat guess: a burst of CJK explanations (~27k bytes, ~44 cents each) admits 3, not 10", async () => {
  // 6,000 characters of context and a 2,000-character sentence, both accepted
  // by the route: ~8k characters, but ~27k UTF-8 bytes, which bound its tokens.
  const cjk = (tag) => {
    const sentence = `TAG-${tag} TRIGGER-SLOW ${"文".repeat(1970)}`;
    const text = "中".repeat(6000);
    return call("POST", "/api/check", { token: "tok-pro-cjk", body: { text, sentences: [{ id: "s1", text: sentence }], deep: true } });
  };
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => cjk(`cjk-${i}`)));
  for (const r of burst) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(burst.filter((r) => r.body.thorough.used).length, 3, "3 x ~44 cents fit in 150; a flat 15-cent hold admitted 10");
  const astraCalls = Array.from({ length: 6 }, (_, i) => openaiLog(`cjk-${i}`)).flat().filter((c) => c.model === ASTRA);
  assert.equal(astraCalls.length, 3);
  assert.ok(astraCalls.every((c) => c.maxTokens === 2000));
});

test("a critique's hold is sized from its prompt too: a burst of CJK critiques at the route's limits (~65 cents each) admits 2", async () => {
  const body = (tag) => ({
    claimText: `TAG-${tag} ${"文".repeat(1980)}`, strengthScore: 0.4,
    evidenceSummary: `TRIGGER-SLOW ${"中".repeat(3980)}`, referenceCheck: "字".repeat(1200), model: ASTRA,
  });
  const burst = await Promise.all(Array.from({ length: 4 }, (_, i) => call("POST", "/api/critique", { token: "tok-pro-cjkcrit", body: body(`cjkcrit-${i}`) })));
  for (const r of burst) assert.equal(r.status, 200, JSON.stringify(r.body));
  const models = Array.from({ length: 4 }, (_, i) => openaiLog(`cjkcrit-${i}`)[0]?.model);
  assert.equal(models.filter((m) => m === ASTRA).length, 2, `3 x ~65 cents would overshoot 150: ${models}`);
});

test("a thorough call that fails after being billed is charged to the allowance, and no failure leaks a hold", async () => {
  const token = "tok-pro-fail";
  const cut = await explain("fail-truncate", { token }, { extra: "TRIGGER-TRUNCATE" });
  assert.notEqual(cut.status, 200);
  assert.equal(openaiLog("fail-truncate")[0].model, ASTRA);
  const e = await call("GET", "/api/entitlement", { token });
  assert.equal(e.body.thorough.remainingPct, 46, "the truncated call's 81 cents (1k in, 16k out on astra) reached the allowance");
  // 12 failed calls would hold 180 cents if a failure leaked its hold.
  for (let i = 0; i < 12; i++) {
    const g = await explain(`fail-garbage-${i}`, { token }, { extra: "TRIGGER-GARBAGE TRIGGER-USAGE-1-1" });
    assert.notEqual(g.status, 200);
  }
  const ok = await explain("fail-after", { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.thorough.used, true, "the allowance is not stuck behind released holds");
});

// ── beta testers and the fair-use limit ──────────────────────────────────

test("a beta tester gets Explain in depth on an allowance keyed on their install id, paid for by the beta pool", async () => {
  const BETA = { "X-Tracely-Beta": "right-token" };
  const before = (await call("GET", "/api/status")).body.betaBudget.spentUsd;
  const first = await explain("beta-1", { install: "beta-install-a", headers: BETA });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.modelUsed, first.body.thorough.remainingPct], [ASTRA, 93]);
  const again = await explain("beta-2", { install: "beta-install-a", headers: BETA });
  assert.equal(again.body.thorough.remainingPct, 86, "the same install, the same allowance");
  const e = await call("GET", "/api/entitlement", { install: "beta-install-a", headers: BETA });
  assert.equal(e.body.thorough.remainingPct, 86);
  assert.ok(!("fairUse" in e.body), "beta testers have no fair-use limit");
  const after = (await call("GET", "/api/status")).body.betaBudget.spentUsd;
  assert.equal(Number((after - before).toFixed(4)), 0.2, "two 10-cent astra calls on the beta pool");
  const without = await explain("beta-no-header", { install: "beta-install-a" });
  assert.equal(without.status, 403, "the same install without the token is a free caller");
});

test("fair use: a Pro account past $2 today runs at Starter limits — Explain in depth falls back to luna, and /api/entitlement says why", async () => {
  const token = "tok-pro-fair";
  const text = "Water boils at 100 degrees Celsius. TAG-fair-big TRIGGER-USAGE-10000000-0";
  const big = await call("POST", "/api/check", { token, body: { text, sentences: [{ id: "s1", text }] } });
  assert.equal(big.status, 200, JSON.stringify(big.body));
  const e = await call("GET", "/api/entitlement", { token });
  assert.equal(e.body.plan, "pro", "the plan itself is untouched");
  assert.deepEqual(e.body.fairUse, { state: "day", resetsOn: nextUsageDay() });
  assert.equal(e.body.thorough.suspended, true);
  assert.deepEqual(e.body.limits, { checksPerDay: 400, aiActionsPerDay: 150, flowPerDay: 40, sources: { day: 5, month: 40 } });
  const deep = await explain("fair-deep", { token });
  assert.equal(deep.status, 200, "never a 403: the account still holds Pro");
  assert.deepEqual([deep.body.modelUsed, deep.body.thorough.used], [LUNA, false]);
});

test("/api/entitlement: a Pro account sees its limits, source usage and Thorough allowance; a free one no allowance", async () => {
  const pro = await call("GET", "/api/entitlement", { token: "tok-pro-ent" });
  assert.deepEqual(pro.body.limits, { checksPerDay: null, aiActionsPerDay: null, flowPerDay: 150, sources: { day: 40, month: 250 } });
  assert.deepEqual(pro.body.usage, { sources: { today: 0, month: 0 } });
  assert.deepEqual(pro.body.thorough, { remainingPct: 100, resetsOn: nextMonthStart() });
  assert.deepEqual(pro.body.fairUse, { state: "ok", resetsOn: null });
  const free = await call("GET", "/api/entitlement", { token: "tok-free-ent" });
  assert.equal(free.body.limits.checksPerDay, 400);
  assert.ok(!("thorough" in free.body) && !("fairUse" in free.body));
});

// ── the desktop's critique ───────────────────────────────────────────────

const critique = (tag, token, model, extra = "") => call("POST", "/api/critique", {
  token, body: { claimText: `Screen time causes anxiety. TAG-${tag} ${extra}`.trim(), strengthScore: 0.4, evidenceSummary: "two surveys", model, effort: "high" },
});

test("critique: Pro on Thorough gets astra at low under 4,000 tokens; Pro on Fast, Student and Free get luna at low", async () => {
  const cases = [
    ["crit-pro-thorough", "tok-pro-crit", ASTRA, [ASTRA, "low", 4000]],
    ["crit-pro-fast", "tok-pro-crit", LUNA, [LUNA, "low", null]],
    ["crit-pro-legacy", "tok-pro-crit", "gpt-5.6-terra", [LUNA, "low", null]],
    ["crit-student", "tok-student-crit", ASTRA, [LUNA, "low", null]],
    ["crit-free", "tok-free-crit", ASTRA, [LUNA, "low", null]],
  ];
  for (const [tag, token, model, [m, effort, maxTokens]] of cases) {
    const r = await critique(tag, token, model);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [sent] = openaiLog(tag);
    assert.equal(sent.model, m, tag);
    assert.equal(sent.effort, effort, `${tag}: the client's "high" is never sent`);
    if (maxTokens) assert.equal(sent.maxTokens, maxTokens, tag);
    else assert.notEqual(sent.maxTokens, 4000, `${tag}: the route's own ceiling`);
  }
});

test("critique allowance: astra while it covers its hold (~39 cents: the prompt bytes plus 4,000 out; 12 at 10 cents), then luna — never refused", async () => {
  const models = [];
  for (let i = 0; i < 13; i++) {
    const r = await critique(`crit-drain-${i}`, "tok-pro-critdrain", ASTRA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    models.push(openaiLog(`crit-drain-${i}`)[0].model);
  }
  assert.deepEqual(models, [...Array(12).fill(ASTRA), LUNA], "150 - 10k >= ~39 for k = 0..11");
  const e = await call("GET", "/api/entitlement", { token: "tok-pro-critdrain" });
  assert.equal(e.body.thorough.remainingPct, 20);
});

test("critique and Explain in depth draw on ONE allowance per account", async () => {
  const token = "tok-pro-shared";
  await critique("shared-crit", token, ASTRA);
  const r = await explain("shared-deep", { token });
  assert.equal(r.body.thorough.remainingPct, 86, "10 cents from the critique, 10 from the explanation");
});

test("a thorough call answered under a dated snapshot id is still charged to the allowance", async () => {
  const token = "tok-pro-dated";
  const first = await explain("dated-1", { token }, { extra: "TRIGGER-DATED" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.model, `${ASTRA}-2026-08-01`, "what the vendor said it ran");
  assert.equal(first.body.thorough.remainingPct, 93, "charged as the thorough model it is");
  await critique("dated-crit", token, ASTRA, "TRIGGER-DATED");
  const e = await call("GET", "/api/entitlement", { token });
  assert.equal(e.body.thorough.remainingPct, 86);
});

// ── local (unenforced) smart strategy ───────────────────────────────────

test("local smart: a critique runs astra under the hosted 4,000-token ceiling; a correction is its own task, on luna", async () => {
  const L = await boot({ OPENAI_API_KEY: "sk-test-not-a-real-key", TRACELY_TEST_OPENAI_LOG: OPENAI_LOG });
  try {
    const at = (p, body) => fetch(`${L.base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    const put = await fetch(`${L.base}/api/prefs`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelStrategy: "smart" }) });
    assert.equal(put.status, 200);
    const crit = await at("/api/critique", { claimText: "Screen time causes anxiety. TAG-local-crit", strengthScore: 0.4, evidenceSummary: "two surveys" });
    assert.equal(crit.status, 200, JSON.stringify(crit.body));
    assert.deepEqual(openaiLog("local-crit").map((c) => [c.model, c.maxTokens]), [[ASTRA, 4000]], "not the route's 16,000 on astra");
    const corr = await at("/api/correction", { claimText: "The Treaty of Paris was signed in 1783. TAG-local-corr", contradictingPassages: ["It was signed in 1783."] });
    assert.equal(corr.status, 200, JSON.stringify(corr.body));
    assert.deepEqual(openaiLog("local-corr").map((c) => c.model), [LUNA], "a correction never follows critique onto astra");
  } finally {
    L.child.kill();
  }
});
