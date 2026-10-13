/**
 * "Try Tracely": the public try-out page's routes, gate and pool, over real
 * HTTP (lib/demo.js, server.js demoGate).
 *
 * Servers, each spawned from server.js with its own data dir:
 *
 *   ON     hosted (a mock Supabase), mock model, try-out configured with the
 *          default $2 pool (an EMPTY budget line), a beta token configured,
 *          TRACELY_PUBLIC_ORIGIN = https://api.jointracely.com
 *   OFF    mock model, no TRACELY_DEMO_SECRET
 *   ZERO   the secret, and an explicit TRACELY_DEMO_DAILY_BUDGET_USD=0
 *   NOTED  the secret, and a budget of "0  # off" (an inline .env comment)
 *   SHORT  a secret of "# off" (what `TRACELY_DEMO_SECRET= # off` leaves)
 *   JUNK   no budget line (the default $2), junk check allowance, 1 review
 *   TINY   hosted, a 1-cent pool: one mock source search (1 cent) spends it
 *   LOW    a 1.2-cent pool: one search leaves it under the 20% line
 *   LOCAL  TRACELY_PUBLIC_ORIGIN is the server's own localhost origin
 *   PRICED OpenAI stubbed by a preload: slow, priced checks, a pool of
 *          2.5 worst-case checks — a burst of fresh cookies
 *   HOLD   mock model, a pool of 1.5 worst-case checks — bodies that never
 *          finish arriving
 *   METER  OpenAI stubbed, 0.32-cent checks, a 8-cent pool: an address's
 *          dollar window is 1 cent an hour
 *
 * Every call carries its own X-Forwarded-For (TRACELY_TRUSTED_PROXY_HOPS=1)
 * unless a test names one, so the per-address window of one test never
 * refuses another's. No real network is touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.js");
const TMP = mkdtempSync(path.join(tmpdir(), "tracely-demo-"));
// Before any import that opens the database (lib/demo.js → lib/db.js).
process.env.TRACELY_DATA_DIR = TMP;
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

const demo = await import("../lib/demo.js");
const { costMicroCents } = await import("../lib/llm.js");
const { SPEND } = await import("../shared/guards.js");

// At least 32 characters: a shorter secret switches the try-out off.
const SECRET = "test-secret-for-the-try-out-0123456789";
const PUBLIC = "https://api.jointracely.com";
const FRAME = "frame-ancestors https://jointracely.com https://www.jointracely.com";
const COOKIE_RE = /^tracely_demo=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax$/;
const LUNA = "gpt-5.6-luna";

// ── lib/demo.js, in process ──────────────────────────────────────────────

test("visitor cookie: minted ids verify under their secret only, and a forgery is null", () => {
  const v = demo.mintVisitor(SECRET);
  assert.equal(demo.verifyVisitor(v.value, SECRET), v.id);
  assert.equal(demo.verifyVisitor(v.value, "another-secret"), null, "a cookie from another secret");
  assert.equal(demo.verifyVisitor(v.value, ""), null, "no secret, no visitor — never a per-boot fallback");
  const [id, mac] = v.value.split(".");
  const other = demo.mintVisitor(SECRET);
  assert.equal(demo.verifyVisitor(`${other.id}.${mac}`, SECRET), null, "a MAC moved onto another id");
  assert.equal(demo.verifyVisitor(`${id}.${mac.slice(0, -2)}`, SECRET), null, "a short MAC (length check, no throw)");
  for (const junk of [undefined, null, "", "x", `${id}`, `${id}.`, `${id}.${mac}.extra`, "a".repeat(500)]) {
    assert.equal(demo.verifyVisitor(junk, SECRET), null, `junk ${String(junk).slice(0, 20)}`);
  }
  assert.notEqual(demo.mintVisitor(SECRET).id, demo.mintVisitor(SECRET).id, "random per visitor");
  assert.match(demo.visitorCookie(v.value), COOKIE_RE);
});

test("readCookie: the named cookie from a real header, bounded, first match wins", () => {
  assert.equal(demo.readCookie("a=1; tracely_demo=abc.def; b=2"), "abc.def");
  assert.equal(demo.readCookie("tracely_demo=first; tracely_demo=second"), "first");
  assert.equal(demo.readCookie("xtracely_demo=no"), null);
  assert.equal(demo.readCookie(undefined), null);
  assert.equal(demo.readCookie(`${"junk=1; ".repeat(2000)}tracely_demo=late`), null, "parsing stops at 8 KB / 64 pairs");
});

test("the caller id is a hash of the visitor id — never the cookie — and carries a daily quota", () => {
  const v = demo.mintVisitor(SECRET);
  const id = demo.demoCallerId(v.id);
  assert.match(id, /^demo:[0-9a-f]{64}$/);
  assert.ok(!id.includes(v.id));
  assert.equal(demo.demoCallerId(v.id), id, "stable");
  assert.match(demo.demoAddressKey("203.0.113.9"), /^demo-addr:[0-9a-f]{32}$/);
});

test("limits and the off switch read the environment like the budgets do", () => {
  assert.deepEqual(demo.demoLimits({}), { check: 10, sources: 2, review: 2, maxChars: 3000 });
  assert.deepEqual(demo.demoLimits({ TRACELY_DEMO_CHECKS: "3", TRACELY_DEMO_SOURCES: "junk", TRACELY_DEMO_REVIEWS: " " }),
    { check: 3, sources: 2, review: 2, maxChars: 3000 }, "explicit wins; junk and empty are the default");
  assert.equal(demo.demoLimits({ TRACELY_DEMO_SOURCES: "0" }).sources, 0, "an explicit 0 allowance is honoured");
  assert.equal(demo.demoLimits({ TRACELY_DEMO_CHECKS: "-1" }).check, 10);
  assert.equal(demo.demoOff({}), true, "no secret: off");
  assert.equal(demo.demoOff({ TRACELY_DEMO_SECRET: "  " }), true, "a blank secret: off");
  // A secret under 32 characters is off: "off", "0", the "# off" an inline
  // comment leaves, and anything shorter than `openssl rand -hex 32` makes.
  for (const short of ["s", "off", "0", "# off", "x".repeat(31)]) {
    assert.equal(demo.demoOffReason({ TRACELY_DEMO_SECRET: short }), "short_secret", `secret ${JSON.stringify(short)}`);
  }
  assert.equal(demo.demoOff({ TRACELY_DEMO_SECRET: "x".repeat(32) }), false, "32 characters is enough");
  assert.equal(demo.demoOff({ TRACELY_DEMO_SECRET: SECRET }), false, "secret, no budget line: the default $2");
  assert.equal(demo.demoOff({ TRACELY_DEMO_SECRET: SECRET, TRACELY_DEMO_DAILY_BUDGET_USD: "" }), false, "empty is absent");
  assert.equal(demo.demoOff({ TRACELY_DEMO_SECRET: SECRET, TRACELY_DEMO_DAILY_BUDGET_USD: "0.5" }), false, "a positive number is on");
  // Anything else an operator writes is OFF — never the default: the values
  // someone writes to switch a public page off must never leave it on.
  for (const junk of ["0", "lots", "0 # off", "0  # off", "off", "false", "none", "-1", "$0", "0,00", "2 # two dollars", "Infinity"]) {
    assert.equal(demo.demoOffReason({ TRACELY_DEMO_SECRET: SECRET, TRACELY_DEMO_DAILY_BUDGET_USD: junk }), "budget", `budget ${JSON.stringify(junk)}`);
  }
  assert.equal(demo.demoOff({ TRACELY_DEMO_SECRET: SECRET, TRACELY_DEMO_DAILY_BUDGET_USD: "0.0000000001" }), true, "a budget that rounds to nothing is off");
  assert.equal(demo.demoOffReason({ TRACELY_DEMO_SECRET: SECRET }), null);
  assert.equal(SPEND.defaultDemoDailyBudgetUsd, 2);
  assert.ok(new Date(demo.demoResetAt()).getTime() > Date.now());
});

// ── the servers ──────────────────────────────────────────────────────────

// "Hosted" needs a Supabase project; this one knows no tokens, so every
// extension caller is the anonymous free plan, enforced.
const supabase = http.createServer((req, res) => {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ msg: "invalid token" }));
});

/* PRICED's OpenAI: a preload swapping globalThis.fetch for api.openai.com
 * only — slow, and every answer billed at TRACELY_TEST_OPENAI_USAGE tokens;
 * TRIGGER-TRUNCATE in the input truncates (1,000 in, 16,000 out).
 * Written to the temp dir, because anything under test/ runs as a test. */
const STUB = path.join(TMP, "openai-stub.mjs");
writeFileSync(STUB, `
const real = globalThis.fetch;
const emptyFor = (s) => {
  const out = {};
  for (const [k, v] of Object.entries(s?.properties ?? {})) {
    const t = Array.isArray(v.type) ? v.type[0] : v.type;
    out[k] = t === "array" ? [] : t === "object" ? emptyFor(v) : t === "number" || t === "integer" ? 0 : t === "boolean" ? false : "";
  }
  return out;
};
const DELAY = Number(process.env.TRACELY_TEST_OPENAI_DELAY_MS || 0);
const LOG = process.env.TRACELY_TEST_OPENAI_LOG === "1";
const [IN, OUT] = String(process.env.TRACELY_TEST_OPENAI_USAGE || "1,1").split(",").map(Number);
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith("https://api.openai.com/")) return real(url, init);
  if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
  const body = JSON.parse(init.body);
  if (LOG) console.error("[stub] openai call max_output_tokens=" + body.max_output_tokens);
  const truncated = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1000, output_tokens: 16000 } };
  const reply = JSON.stringify(body.input).includes("TRIGGER-TRUNCATE") ? truncated : { output_text: JSON.stringify(emptyFor(body.text?.format?.schema)) };
  return new Response(JSON.stringify({ status: "completed", model: body.model, usage: { input_tokens: IN, output_tokens: OUT }, ...reply }), { status: 200, headers: { "Content-Type": "application/json" } });
};
`);

// Nothing from a developer's shell may change these servers' behaviour.
const SCRUB = ["TRACELY_BETA_TOKENS", "TRACELY_BETA_DAILY_BUDGET_USD", "TRACELY_DAILY_BUDGET_USD", "TRACELY_APP_DAILY_BUDGET_USD", "TRACELY_PAID_DAILY_BUDGET_USD",
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "OPENAI_API_KEY", "TRACELY_MOCK", "TRACELY_EXTENSION_ID", "TRACELY_TRUSTED_PROXY_HOPS", "TRACELY_LLM_PROVIDER",
  "TRACELY_DEMO_SECRET", "TRACELY_PUBLIC_ORIGIN", "TRACELY_DEMO_DAILY_BUDGET_USD", "TRACELY_DEMO_CHECKS", "TRACELY_DEMO_SOURCES", "TRACELY_DEMO_REVIEWS"];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.includes(k)));

// A port the OS just handed out (beta-grant.test.js explains why not a range).
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

// `env` may be a function of the port, for a server whose settings name it.
const booted = [];
async function boot(env, { preload } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = await freePort();
    const child = spawn(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []), SERVER], {
      env: { ...baseEnv, PORT: String(p), TRACELY_DATA_DIR: mkdtempSync(path.join(TMP, "data-")), TRACELY_TRUSTED_PROXY_HOPS: "1", ...(typeof env === "function" ? env(p) : env) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    booted.push(child);
    let stderr = "";
    let exited = false;
    child.on("exit", () => { exited = true; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.resume();
    const base = `http://127.0.0.1:${p}`;
    for (let i = 0; i < 200 && !exited; i++) {
      try { if ((await fetch(`${base}/api/status`)).ok && !exited) return { base, port: p, child, stderr: () => stderr }; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();
    if (!exited) throw new Error(`server on ${p} did not start: ${stderr}`);
  }
  throw new Error("could not find a free port for a test server");
}

let ON, OFF, ZERO, NOTED, SHORT, JUNK, TINY, LOW, LOCAL, PRICED, HOLD, METER;
// A try-out check's worst case on the fast model (server.js WORST_CALL
// "/api/demo/check": its own 6,000-token output ceiling, not the
// extension's 16,000). PRICED's pool is room for two and a half of them.
const WORST_CHECK = costMicroCents(LUNA, { input: 8_000, cacheWrite: 8_000, output: SPEND.demoCheckMaxTokens });
const PRICED_BUDGET_USD = (2.5 * WORST_CHECK) / (100 * 1e6);
test.before(async () => {
  await new Promise((r) => supabase.listen(0, "127.0.0.1", r));
  const hosted = { SUPABASE_URL: `http://127.0.0.1:${supabase.address().port}`, SUPABASE_ANON_KEY: "anon" };
  const on = { TRACELY_MOCK: "1", TRACELY_DEMO_SECRET: SECRET };
  [ON, OFF, ZERO, NOTED, SHORT, JUNK, TINY, LOW, LOCAL, PRICED, HOLD, METER] = await Promise.all([
    boot({ ...hosted, ...on, TRACELY_PUBLIC_ORIGIN: `${PUBLIC}/`, TRACELY_DEMO_DAILY_BUDGET_USD: "", TRACELY_BETA_TOKENS: "right-token" }),
    boot({ TRACELY_MOCK: "1", TRACELY_PUBLIC_ORIGIN: PUBLIC }),
    boot({ ...on, TRACELY_DEMO_DAILY_BUDGET_USD: "0" }),
    boot({ ...on, TRACELY_DEMO_DAILY_BUDGET_USD: "0  # off" }),
    boot({ TRACELY_MOCK: "1", TRACELY_DEMO_SECRET: "# off" }),
    boot({ ...on, TRACELY_DEMO_CHECKS: "nope", TRACELY_DEMO_REVIEWS: "1" }),
    boot({ ...hosted, ...on, TRACELY_DEMO_DAILY_BUDGET_USD: "0.01" }),
    boot({ ...on, TRACELY_DEMO_DAILY_BUDGET_USD: "0.012" }),
    boot((p) => ({ ...on, TRACELY_PUBLIC_ORIGIN: `http://127.0.0.1:${p}` })),
    boot({ OPENAI_API_KEY: "sk-test-not-a-real-key", TRACELY_DEMO_SECRET: SECRET, TRACELY_DEMO_DAILY_BUDGET_USD: String(PRICED_BUDGET_USD),
      TRACELY_TEST_OPENAI_DELAY_MS: "1500", TRACELY_TEST_OPENAI_USAGE: "4000,2000" }, { preload: STUB }),
    boot({ ...on, TRACELY_DEMO_DAILY_BUDGET_USD: String((1.5 * WORST_CHECK) / (100 * 1e6)) }),
    boot({ OPENAI_API_KEY: "sk-test-not-a-real-key", TRACELY_DEMO_SECRET: SECRET, TRACELY_DEMO_DAILY_BUDGET_USD: "0.08",
      TRACELY_TEST_OPENAI_DELAY_MS: "500", TRACELY_TEST_OPENAI_USAGE: "4000,2000", TRACELY_TEST_OPENAI_LOG: "1" }, { preload: STUB }),
  ]).catch((err) => {
    for (const child of booted) child.kill(); // or the run never exits
    throw err;
  });
});
test.after(() => {
  for (const child of booted) child.kill();
  supabase.close();
});

let addrSeq = 0;
const freshAddr = () => `198.51.${Math.floor(++addrSeq / 250)}.${addrSeq % 250 + 1}`;
/* One request. `cookie` is a visitor ({ value }) or a raw string; `addr` is
 * the client address the proxy hop reports (fresh per call by default). */
async function call(srv, method, p, { body, cookie, addr = freshAddr(), headers = {} } = {}) {
  const r = await fetch(`${srv.base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: `tracely_demo=${typeof cookie === "string" ? cookie : cookie.value}` } : {}),
      "X-Forwarded-For": addr,
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: r.status, body: json, text, headers: r.headers };
}
const visitor = () => demo.mintVisitor(SECRET);
const SENTENCE = "The Great Wall of China is the only man-made structure visible from space.";
const checkBody = (extra = {}) => ({ text: SENTENCE, sentences: [{ id: "s1", text: SENTENCE }], ...extra });
const demoCheck = (srv, cookie, opts = {}) => call(srv, "POST", "/api/demo/check", { ...opts, cookie, body: checkBody(opts.extra) });
const demoSources = (srv, cookie, opts = {}) => call(srv, "POST", "/api/demo/sources", { ...opts, cookie, body: { claim: SENTENCE, ...opts.extra } });
const demoReview = (srv, cookie, opts = {}) => call(srv, "POST", "/api/demo/review", { ...opts, cookie, body: { text: `${SENTENCE} ${SENTENCE}`, kind: "essay", ...opts.extra } });
const demoStatus = (srv, cookie, opts = {}) => call(srv, "GET", "/api/demo/status", { ...opts, cookie });
const status = (srv) => call(srv, "GET", "/api/status").then((r) => r.body);
const errorOf = (r) => r.body?.error ?? {};

// ── /try: the page, its frame rule and its cookie ───────────────────────

test("GET /try (and /try/) may be framed by the website only, mints a cookie, and is never cached", async () => {
  for (const p of ["/try", "/try/"]) {
    const r = await call(ON, "GET", p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type"), /^text\/html/);
    assert.equal(r.headers.get("content-security-policy"), FRAME, `${p} names the website as its only framer`);
    assert.equal(r.headers.get("x-frame-options"), null, "no X-Frame-Options: DENY would override the CSP in older browsers");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("set-cookie") ?? "", COOKIE_RE, `${p} mints the visitor cookie`);
  }
});

test("a visitor who already holds a valid cookie is not given another; a forged one is replaced", async () => {
  const v = visitor();
  const kept = await call(ON, "GET", "/try", { cookie: v });
  assert.equal(kept.status, 200);
  assert.equal(kept.headers.get("set-cookie"), null);
  assert.equal(kept.headers.get("content-security-policy"), FRAME, "the frame rule is on every /try response");
  const forged = await call(ON, "GET", "/try", { cookie: `${v.id}.${"A".repeat(43)}` });
  assert.match(forged.headers.get("set-cookie") ?? "", COOKIE_RE);
});

test("every other page keeps its old headers: no frame rule, no cookie", async () => {
  for (const p of ["/", "/try.js", "/try.css", "/ext-content.js", "/style.css"]) {
    const r = await call(ON, "GET", p);
    assert.equal(r.headers.get("content-security-policy"), null, `${p} carries no CSP`);
    assert.equal(r.headers.get("set-cookie"), null, `${p} sets no cookie`);
  }
  const js = await call(ON, "GET", "/try.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /^text\/javascript/);
  assert.match((await call(ON, "GET", "/try.css")).headers.get("content-type"), /^text\/css/);
});

test("the cookie GET /try mints is the one the demo routes accept, end to end", async () => {
  const page = await call(ON, "GET", "/try");
  const value = /^tracely_demo=([^;]+)/.exec(page.headers.get("set-cookie"))[1];
  const r = await demoCheck(ON, value);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.findings), "the /api/check body, unchanged");
  assert.equal(r.body.plan, "free");
  assert.equal(r.body.modelUsed, LUNA);
  const s = await demoStatus(ON, value);
  assert.equal(s.body.left.check, 9);
});

// ── who may call ─────────────────────────────────────────────────────────

test("no cookie, or a forged one, is 403 demo_session on every demo route — and spends nothing", async () => {
  const v = visitor();
  const forgeries = [undefined, "junk", `${v.id}.${"A".repeat(43)}`, demo.mintVisitor("not-the-secret").value];
  for (const cookie of forgeries) {
    for (const r of [await demoCheck(ON, cookie), await demoSources(ON, cookie), await demoReview(ON, cookie), await demoStatus(ON, cookie)]) {
      assert.equal(r.status, 403, `cookie ${String(cookie).slice(0, 12)}: ${JSON.stringify(r.body)}`);
      assert.equal(errorOf(r).kind, "demo_session");
      assert.match(errorOf(r).message, /Reload the page/);
    }
  }
  assert.equal((await status(ON)).demoBudget.spentUsd, 0);
});

test("the public origin reaches the demo routes and the page — and nothing else of the API", async () => {
  const v = visitor();
  const origin = { Origin: PUBLIC };
  assert.equal((await demoCheck(ON, v, { headers: origin })).status, 200);
  assert.equal((await demoStatus(ON, v, { headers: origin })).status, 200);
  assert.equal((await call(ON, "GET", "/try", { headers: origin })).status, 200);
  for (const [method, p, body] of [["POST", "/api/check", checkBody()], ["POST", "/api/sources", { claim: SENTENCE }], ["POST", "/api/review", { text: SENTENCE }],
    ["GET", "/api/documents"], ["GET", "/api/library"], ["GET", "/api/entitlement"], ["GET", "/api/status"], ["POST", "/api/detect-claims", { draft: SENTENCE }]]) {
    const r = await call(ON, method, p, { body, headers: origin, cookie: v });
    assert.equal(r.status, 403, `${method} ${p} from the public origin`);
    assert.equal(errorOf(r).message, "Origin not allowed for this endpoint");
    assert.equal(r.headers.get("access-control-allow-origin"), null, "the browser must not see the refusal");
  }
});

test("no other origin reaches the demo routes: not the extension, not Docs, not a stranger", async () => {
  const v = visitor();
  for (const origin of ["chrome-extension://dffmoeebkkghhgcklkbmaibfhgiegmdm", "https://docs.google.com", "https://www.jointracely.com", "https://evil.example"]) {
    const r = await demoCheck(ON, v, { headers: { Origin: origin } });
    assert.equal(r.status, 403, origin);
    assert.equal(errorOf(r).kind, "forbidden");
  }
  assert.equal((await demoStatus(ON, v)).body.left.check, 10, "none of them counted");
});

test("where the public origin is also the server's own (a local run), the public rule wins", async () => {
  const v = visitor();
  const self = { Origin: `http://127.0.0.1:${LOCAL.port}` };
  assert.equal((await demoCheck(LOCAL, v, { headers: self })).status, 200);
  assert.equal((await call(LOCAL, "POST", "/api/check", { body: checkBody(), headers: self })).status, 403, "/api/check refused for the public origin");
  assert.equal((await call(LOCAL, "GET", "/api/documents", { headers: self })).status, 403);
  const other = { Origin: `http://localhost:${LOCAL.port}` };
  assert.equal((await call(LOCAL, "POST", "/api/check", { body: checkBody(), headers: other })).status, 200, "the other self origin is untouched");
});

// ── what a visitor gets ──────────────────────────────────────────────────

test("/api/demo/status: open, the allowance left, the limits and the reset", async () => {
  const v = visitor();
  const r = await demoStatus(ON, v);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["left", "limits", "open", "resetAt"]);
  assert.equal(r.body.open, true);
  assert.deepEqual(r.body.left, { check: 10, sources: 2, review: 2 });
  assert.deepEqual(r.body.limits, { check: 10, sources: 2, review: 2, maxChars: 3000 });
  const reset = new Date(r.body.resetAt);
  assert.ok(reset.getTime() > Date.now() && reset.getTime() - Date.now() <= 25 * 3600_000, "the next local midnight");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("the 11th check from one visitor is 429 demo_limit (feature check); another visitor is unaffected", async () => {
  const v = visitor();
  const addr = freshAddr();
  for (let i = 1; i <= 10; i++) assert.equal((await demoCheck(ON, v, { addr })).status, 200, `check ${i}`);
  const r = await demoCheck(ON, v, { addr });
  assert.equal(r.status, 429);
  assert.equal(errorOf(r).kind, "demo_limit");
  assert.equal(errorOf(r).feature, "check");
  assert.match(errorOf(r).message, /10 checks/);
  assert.deepEqual((await demoStatus(ON, v)).body.left, { check: 0, sources: 2, review: 2 });
  assert.equal((await demoCheck(ON, visitor(), { addr })).status, 200, "a new visitor on the same address");
});

test("the 3rd source search is 429 demo_limit (feature sources), and checks still work", async () => {
  const v = visitor();
  for (let i = 1; i <= 2; i++) {
    const r = await demoSources(ON, v);
    assert.equal(r.status, 200, `search ${i}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.sources), "the /api/sources body, unchanged");
  }
  const r = await demoSources(ON, v);
  assert.equal(r.status, 429);
  assert.deepEqual([errorOf(r).kind, errorOf(r).feature], ["demo_limit", "sources"]);
  assert.match(errorOf(r).message, /2 source searches.*Checks still work/);
  assert.equal((await demoCheck(ON, v)).status, 200);
});

test("the review allowance (TRACELY_DEMO_REVIEWS=1): demo_limit comes before the once-a-minute window", async () => {
  const v = visitor();
  const first = await demoReview(JUNK, v);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(Array.isArray(first.body.findings), "the /api/review body, unchanged");
  const r = await demoReview(JUNK, v);
  assert.equal(r.status, 429);
  assert.deepEqual([errorOf(r).kind, errorOf(r).feature], ["demo_limit", "review"]);
  assert.match(errorOf(r).message, /1 writing review for/);
});

test("over-cap text is 400 with a plain message — and uses up no allowance", async () => {
  const v = visitor();
  const long = `${"An essay sentence that goes on for a while. ".repeat(70)}`.slice(0, 3001);
  const cases = [
    [await demoCheck(ON, v, { extra: { text: long } }), /3,000 characters/],
    [await demoReview(ON, v, { extra: { text: long } }), /3,000 characters/],
    [await demoSources(ON, v, { extra: { context: "c".repeat(1501) } }), /1,500 characters of context/],
  ];
  for (const [r, msg] of cases) {
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(errorOf(r).kind, "bad_request");
    assert.match(errorOf(r).message, msg);
  }
  const many = Array.from({ length: 41 }, (_, i) => ({ id: `s${i}`, text: "Short." }));
  assert.equal((await demoCheck(ON, v, { extra: { text: "Short.", sentences: many } })).status, 400, "41 sentences");
  // The model is sent the SENTENCES, so the cap holds for them: a short text
  // cannot carry two 2,000-character sentences, nor a sentence not in it.
  const big = (c) => ({ id: `big-${c}`, text: c.repeat(2000) });
  for (const [sentences, why] of [[[big("a"), big("b")], "4,000 characters of sentences under a short text"],
    [[{ id: "s1", text: "Not a sentence of this text at all." }], "a sentence the text does not contain"]]) {
    const r = await demoCheck(ON, v, { extra: { text: "Short essay.", sentences } });
    assert.equal(r.status, 400, why);
    assert.match(errorOf(r).message, /3,000 characters/, why);
  }
  for (const extra of [{ claim: "c".repeat(601) }, { correction: "c".repeat(601) }]) {
    const r = await demoSources(ON, v, { extra });
    assert.equal(r.status, 400, Object.keys(extra)[0]);
    assert.match(errorOf(r).message, /a sentence of up to 600 characters/);
  }
  // A sentence cut from the text, as content.js sends it: within the cap.
  const full = `${SENTENCE} ${"x".repeat(3000 - SENTENCE.length - 1)}`;
  assert.equal((await demoCheck(ON, v, { extra: { text: full } })).status, 200, "exactly 3,000 is allowed");
  assert.deepEqual((await demoStatus(ON, v)).body.left, { check: 9, sources: 2, review: 2 }, "only the call that ran counted");
});

test("the try-out is the free plan: Explain in depth is 403, and the beta header grants nothing", async () => {
  const v = visitor();
  const deep = await demoCheck(ON, v, { extra: { deep: true } });
  assert.equal(deep.status, 403);
  assert.equal(errorOf(deep).kind, "plan_required");
  const beta = { "X-Tracely-Beta": "right-token" };
  const deepBeta = await demoCheck(ON, v, { extra: { deep: true }, headers: beta });
  assert.equal(deepBeta.status, 403, "a valid beta token is ignored on the try-out");
  const plain = await demoCheck(ON, v, { extra: { model: "gpt-6-astra" }, headers: beta });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.plan, "free");
  assert.equal(plain.body.modelUsed, LUNA, "the fast model, whatever the client asks for");
  // The same token IS live on this server's extension routes — so it was the try-out that ignored it.
  const ent = await call(ON, "GET", "/api/entitlement", { headers: beta });
  assert.equal(ent.body.plan, "pro");
  assert.ok(!("betaBudget" in (await status(ON))) || (await status(ON)).betaBudget.spentUsd === 0, "nothing reached the beta pool");
});

test("the 201st call in an hour from one address is 429 — a rolling window, keyed on the address alone", async () => {
  const addr = freshAddr();
  assert.equal(SPEND.demoAddressCallsPerHour, 200, "wide enough for a classroom: the dollar window bounds spend");
  // Twenty visitors, ten checks each: none reaches its own allowance or its
  // per-minute window, so only the address can refuse the next one.
  for (let n = 0; n < 20; n++) {
    const v = visitor();
    const results = await Promise.all(Array.from({ length: 10 }, () => demoCheck(ON, v, { addr })));
    assert.deepEqual(results.map((r) => r.status), Array(10).fill(200), `visitor ${n + 1}`);
  }
  const r = await demoCheck(ON, visitor(), { addr });
  assert.equal(r.status, 429);
  assert.equal(errorOf(r).kind, "rate_limit");
  assert.match(errorOf(r).message, /busy on your network/);
  assert.equal((await demoCheck(ON, visitor(), { addr: freshAddr() })).status, 200, "another address is unaffected");
});

// ── the pool ─────────────────────────────────────────────────────────────

test("no TRACELY_DEMO_SECRET: the try-out is off — 503 demo_closed, status open:false, no cookie, no demoBudget", async () => {
  const v = visitor();
  for (const r of [await demoCheck(OFF, v), await demoSources(OFF, v), await demoReview(OFF, v)]) {
    assert.equal(r.status, 503);
    assert.equal(errorOf(r).kind, "demo_closed");
    assert.equal(errorOf(r).message, "The try-out isn't available right now.");
  }
  const s = await demoStatus(OFF);
  assert.equal(s.status, 200, "the page can still ask, and is told it is closed");
  assert.equal(s.body.open, false);
  assert.deepEqual(s.body.left, { check: 0, sources: 0, review: 0 });
  const page = await call(OFF, "GET", "/try");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy"), FRAME);
  assert.equal(page.headers.get("set-cookie"), null, "no secret, no cookie");
  assert.ok(!("demoBudget" in (await status(OFF))), "a server without the try-out answers /api/status's old shape");
});

test("budget 0, a budget with an inline comment and a too-short secret are OFF; an empty budget is the default $2", async () => {
  const v = visitor();
  for (const [srv, name] of [[ZERO, "budget 0"], [NOTED, "budget '0  # off'"], [SHORT, "secret '# off'"]]) {
    const r = await demoCheck(srv, v);
    assert.equal(r.status, 503, name);
    assert.equal(errorOf(r).kind, "demo_closed", name);
    assert.equal(errorOf(r).message, "The try-out isn't available right now.", name);
    assert.equal((await demoStatus(srv, v)).body.open, false, name);
    assert.equal((await call(srv, "GET", "/try")).headers.get("set-cookie"), null, `${name}: no cookie`);
    assert.deepEqual((await status(srv)).demoBudget, { enforced: false }, `${name}: /api/status says it is off`);
  }
  assert.match(NOTED.stderr(), /the try-out is OFF: TRACELY_DEMO_DAILY_BUDGET_USD is not a positive number/);
  assert.match(SHORT.stderr(), /the try-out is OFF: TRACELY_DEMO_SECRET is shorter than 32 characters/);
  assert.ok(!SHORT.stderr().includes("# off"), "the boot line never prints the secret");
  for (const srv of [ON, JUNK]) {
    const b = (await status(srv)).demoBudget;
    assert.equal(b.enforced, true, "the try-out pool is enforced even with no Supabase (JUNK has none)");
    assert.equal(b.budgetUsd, 2);
  }
  assert.equal((await demoCheck(JUNK, v)).status, 200);
  assert.equal((await demoStatus(JUNK, v)).body.limits.check, 10, "a junk TRACELY_DEMO_CHECKS is the default");
});

test("a spent try-out pool is 503 demo_closed — and the extension pool is untouched and still serving", async () => {
  const v = visitor();
  const first = await demoSources(TINY, v);
  assert.equal(first.status, 200, "admitted while the pool had room");
  let s = await status(TINY);
  assert.equal(s.demoBudget.spentUsd, 0.01, "a mock search records its one-cent fee to the demo pool");
  assert.equal(s.budget.enforced, true);
  assert.equal(s.budget.spentUsd, 0, "and nothing to the extension's");
  for (const r of [await demoCheck(TINY, v), await demoCheck(TINY, visitor()), await demoReview(TINY, visitor())]) {
    assert.equal(r.status, 503);
    assert.equal(errorOf(r).kind, "demo_closed");
    assert.match(errorOf(r).message, /reached its limit for today\. It comes back at midnight\./);
  }
  assert.equal((await demoStatus(TINY, v)).body.open, false);
  const ext = await call(TINY, "POST", "/api/check", { body: checkBody(), headers: { "X-Tracely-Install": "an-extension-user" } });
  assert.equal(ext.status, 200, "the extension's /api/check never saw the try-out's day");
  const extSearch = await call(TINY, "POST", "/api/sources", { body: { claim: SENTENCE }, headers: { "X-Tracely-Install": "an-extension-user" } });
  assert.equal(extSearch.status, 200);
  s = await status(TINY);
  assert.equal(s.demoBudget.spentUsd, 0.01, "the extension's search did not land in the demo pool");
  assert.equal(s.budget.spentUsd, 0.01);
});

test("under 20% of the pool left, source search pauses on the try-out and checking goes on", async () => {
  assert.equal((await demoSources(LOW, visitor())).status, 200, "1 of 1.2 cents spent: 17% left");
  const r = await demoSources(LOW, visitor());
  assert.equal(r.status, 503);
  assert.equal(errorOf(r).kind, "budget");
  assert.equal(errorOf(r).message, "Source search is paused on the try-out for today. Checking still works.");
  const v = visitor();
  assert.equal((await demoCheck(LOW, v)).status, 200);
  const s = await demoStatus(LOW, v);
  assert.equal(s.body.open, true);
  assert.equal(s.body.sourcesPaused, true);
});

test("the try-out's searches have their own hourly window: the 11th is refused, the extension's are not", async () => {
  for (let n = 0; n < 5; n++) {
    const v = visitor();
    for (let i = 0; i < 2; i++) assert.equal((await demoSources(JUNK, v)).status, 200, `visitor ${n + 1} search ${i + 1}`);
  }
  const r = await demoSources(JUNK, visitor());
  assert.equal(r.status, 429);
  assert.equal(errorOf(r).kind, "rate_limit");
  assert.match(errorOf(r).message, /try-out is busy/);
  const ext = await call(JUNK, "POST", "/api/sources", { body: { claim: SENTENCE }, headers: { "X-Tracely-Install": "store-user" } });
  assert.equal(ext.status, 200, "ten try-out searches took nothing from the extension's 15 an hour");
});

test("a burst of fresh cookies cannot be admitted past the pool: each call reserves its worst case first", async () => {
  // 2.5 worst cases of room: three admitted while the first calls are still
  // in flight (1.5 s each), every other one refused — never the 503 of a
  // check that ran. Refused as BUSY, not closed: nothing is spent yet, and
  // the page closes for the session on demo_closed.
  const pending = Promise.all(Array.from({ length: 6 }, () => demoCheck(PRICED, visitor())));
  await new Promise((r) => setTimeout(r, 500));
  const during = await demoStatus(PRICED, visitor());
  assert.deepEqual([during.body.open, during.body.busy], [true, true], "in flight is busy, never a closed day");
  const burst = await pending;
  const ok = burst.filter((r) => r.status === 200);
  assert.equal(ok.length, 3, JSON.stringify(burst.map((r) => [r.status, errorOf(r).kind])));
  for (const r of burst.filter((x) => x.status !== 200)) {
    assert.equal(errorOf(r).kind, "demo_busy");
    assert.equal(errorOf(r).message, "The try-out is busy — try again in a minute.");
  }
  assert.equal("busy" in (await demoStatus(PRICED, visitor())).body, false, "and not busy once they have answered");
  const b = (await status(PRICED)).demoBudget;
  const oneCall = costMicroCents(LUNA, { input: 4000, output: 2000 }) / (100 * 1e6);
  assert.ok(Math.abs(b.spentUsd - 3 * oneCall) < 1e-4, `the three that ran were charged to the demo pool: ${b.spentUsd}`);
  assert.ok(b.spentUsd <= PRICED_BUDGET_USD, "and the day stayed inside its ceiling");
});

test("a demo call that fails after OpenAI answered is still charged — to the demo pool — and logged as the demo route", async () => {
  const before = (await status(PRICED)).demoBudget.spentUsd;
  const text = "TRIGGER-TRUNCATE the demo pool must see this";
  const r = await call(PRICED, "POST", "/api/demo/check", { cookie: visitor(), body: { text, sentences: [{ id: "s1", text }] } });
  assert.equal(r.status, 502);
  assert.equal(errorOf(r).kind, "truncated", "the /api/check error, unchanged");
  const after = (await status(PRICED)).demoBudget.spentUsd;
  // 1,000 in + 16,000 out on gpt-5.6-luna = $0.0194 (beta-grant.test.js).
  assert.equal(Number((after - before).toFixed(4)), 0.0194);
  for (let i = 0; i < 40 && !PRICED.stderr().includes("route=/api/demo/check"); i++) await new Promise((res) => setTimeout(res, 25));
  assert.match(PRICED.stderr(), /\[tracely\] model call failed route=\/api\/demo\/check kind=truncated status=502 model=gpt-5\.6-luna/);
  assert.ok(!PRICED.stderr().includes("the demo pool must see this"), "and none of the visitor's text");
});

test("an address's dollar window: charged plus held, an eighth of the pool an hour — a burst included", async () => {
  // METER: an 8-cent pool, so an address may use 1 cent an hour; a check
  // holds 0.92 cents (its worst case) while in flight and is charged 0.32.
  const burstAddr = freshAddr();
  const burst = await Promise.all(Array.from({ length: 4 }, () => demoCheck(METER, visitor(), { addr: burstAddr })));
  assert.deepEqual(burst.map((r) => r.status).sort(), [200, 200, 429, 429],
    `two held reach the window before anything is charged: ${JSON.stringify(burst.map((r) => [r.status, errorOf(r).kind]))}`);
  for (const r of burst.filter((x) => x.status === 429)) {
    assert.equal(errorOf(r).kind, "rate_limit");
    assert.match(errorOf(r).message, /busy on your network/);
  }
  // One at a time from a fresh address: charged 0, 0.32, 0.64, 0.96 cents
  // before each — all under 1 — and 1.28 before the fifth.
  const addr = freshAddr();
  const v = visitor();
  for (let i = 1; i <= 4; i++) assert.equal((await demoCheck(METER, v, { addr })).status, 200, `check ${i}`);
  const refused = await demoCheck(METER, v, { addr });
  assert.equal(refused.status, 429);
  assert.equal(errorOf(refused).kind, "rate_limit");
  assert.equal((await demoStatus(METER, v)).body.left.check, 6, "a refused call uses up no allowance");
  assert.equal((await demoCheck(METER, v, { addr: freshAddr() })).status, 200, "another address is unaffected");
});

test("a try-out check asks the model for at most 6,000 output tokens; the extension's /api/check keeps 16,000", async () => {
  assert.match(METER.stderr(), /\[stub\] openai call max_output_tokens=6000/);
  assert.ok(!METER.stderr().includes("max_output_tokens=16000"), "no demo call ran at the extension's ceiling");
  const r = await call(METER, "POST", "/api/check", { body: checkBody(), headers: { "X-Tracely-Install": "an-extension-user" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (let i = 0; i < 40 && !METER.stderr().includes("max_output_tokens=16000"); i++) await new Promise((res) => setTimeout(res, 25));
  assert.match(METER.stderr(), /max_output_tokens=16000/);
});

/* A demo check whose body never finishes: the headers, then one byte every
 * 200 ms of a body that claims 100,000. `closed` resolves with how long the
 * server let it run. */
function slowBody(srv, cookie, addr = freshAddr()) {
  return new Promise((resolve, reject) => {
    const s = net.connect(srv.port, "127.0.0.1", () => {
      const started = Date.now();
      s.write(`POST /api/demo/check HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n` +
        `Cookie: tracely_demo=${cookie.value}\r\nX-Forwarded-For: ${addr}\r\n\r\n{"text":"`);
      const tick = setInterval(() => s.write("a"), 200);
      const closed = new Promise((r) => s.on("close", () => { clearInterval(tick); r(Date.now() - started); }));
      resolve({ socket: s, closed });
    });
    s.on("error", reject);
  });
}

test("a body sent a byte at a time holds nothing of the pool, and has 10 s to arrive", async () => {
  // HOLD's pool is 1.5 worst-case checks: two calls holding theirs would
  // close it. These two have passed the gate and are still sending.
  const slow = await Promise.all([slowBody(HOLD, visitor()), slowBody(HOLD, visitor())]);
  for (const s of slow) s.socket.on("error", () => {});
  await new Promise((r) => setTimeout(r, 400));
  const s = await demoStatus(HOLD, visitor());
  assert.equal(s.body.open, true);
  assert.equal("busy" in s.body, false, "nothing is held for a body still arriving");
  const r = await demoCheck(HOLD, visitor());
  assert.equal(r.status, 200, `another visitor is served: ${JSON.stringify(r.body)}`);
  const ms = await Promise.all(slow.map((x) => x.closed));
  for (const t of ms) assert.ok(t >= 9_000 && t < 13_000, `the server ended the slow body at its deadline: ${t} ms`);
});

test("a demo route answers POST only: another method is 404 and takes no slot of the address window", async () => {
  const v = visitor();
  const addr = freshAddr();
  for (let i = 0; i < SPEND.demoAddressCallsPerHour + 1; i++) {
    const r = await call(HOLD, "GET", "/api/demo/check", { cookie: v, addr });
    assert.equal(r.status, 404, `GET ${i + 1}`);
  }
  assert.equal((await demoCheck(HOLD, v, { addr })).status, 200, "the address still has its whole window");
  assert.equal((await demoStatus(HOLD, v)).body.left.check, 9, "and only the POST counted");
});

// ── the shipped contract is untouched ────────────────────────────────────

test("the demo routes sit in no other set, and the public origin is never a self origin", () => {
  const src = readFileSync(SERVER, "utf8");
  const setLine = (name) => src.slice(src.indexOf(`const ${name} = new Set([`), src.indexOf("]);", src.indexOf(`const ${name} = new Set([`)));
  for (const name of ["EXTENSION_API", "PAID_ROUTES", "APP_AI_ROUTES", "MODEL_ROUTES", "EXTENSION_MODEL_ROUTES", "SOURCE_ROUTES"]) {
    assert.ok(!setLine(name).includes("/api/demo"), `${name} does not name a demo route`);
  }
  const self = src.slice(src.indexOf("const SELF_ORIGINS"), src.indexOf("\n", src.indexOf("const SELF_ORIGINS")));
  assert.ok(!/PUBLIC|demo/i.test(self), "SELF_ORIGINS never includes TRACELY_PUBLIC_ORIGIN");
  const rule = src.slice(src.indexOf("function routeAllowedForOrigin"), src.indexOf("\n}", src.indexOf("function routeAllowedForOrigin")));
  assert.ok(rule.indexOf("demoPublicOrigin()") < rule.indexOf("SELF_ORIGINS.has"), "the public rule is decided before the self-origin pass");
  assert.match(src, /"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tracely-Install, X-Tracely-Beta"/, "the CORS list is unchanged");
});
