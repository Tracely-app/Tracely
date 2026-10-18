/**
 * The test build's Pro grant, the honest model choice on the extension's
 * routes, the prefs lockdown and the model-failure log — over real HTTP.
 *
 * Four real servers, each spawned from server.js with its own data dir:
 *
 *   A  hosted (enforced), mock model, beta OFF
 *   B  hosted (enforced), mock model, beta ON with a 1-cent beta pool
 *   C  local (unenforced), mock model, beta ON
 *   D  hosted (enforced), REAL request path with OpenAI stubbed by a preload,
 *      so the tests can read the exact model and effort the server sent, and
 *      make a call truncate / refuse / return garbage on demand
 *   E  hosted (enforced), mock model, a 1-cent PAID pool and a 1.2-cent beta
 *      pool — where the pools' edges are
 *   G  hosted (enforced), the stubbed path again, but every call is held
 *      until the test lets it go and costs real money at thorough-model
 *      prices — a concurrent burst of "Explain in depth" checks
 *   H  hosted (enforced), the stubbed path with a 2-cent beta pool — smaller
 *      than one check's worst case (~2.5 cents on luna), so a check is
 *      admitted but its split is not
 *
 * "Enforced" needs a Supabase project, so a mock one runs here and answers
 * /auth/v1/user for three canned tokens (free, student, pro). No real network
 * is touched: the model is mocked (A-C) or stubbed (D).
 *
 * What is pinned, and why each matters:
 *   - A beta token is honoured only when TRACELY_BETA_TOKENS lists it, lifts
 *     the caller to Pro on the EXTENSION's routes, and never on the desktop's.
 *   - Beta spend lands in its own pool, and when that runs dry the tester
 *     drops to their own plan on the extension pool — never a 503, and never
 *     the extension pool while the beta pool can pay.
 *   - Hosted /api/check and /api/sources run the model the SERVER chooses per
 *     route (shared/plan.js modelForRoute: luna on every plan since the
 *     2026-09-21 plan policy), whatever the client asks for — never one
 *     global prefs row for everybody, and never the client's slider.
 *   - PUT /api/prefs, which rewrote that row with no authentication, is
 *     refused on a hosted server and unchanged on a local one.
 *   - A failed model call leaves one log line naming route, kind, model and
 *     effort — and none of the user's text — and what it was billed still
 *     reaches the pool.
 *   - A burst of beta calls with rotating install ids cannot be admitted
 *     against money the calls ahead of it are about to spend.
 *   - Student and Pro calls on the extension's routes spend a pool of their
 *     own, and fall back to the fast model — never a 503 — when it is spent.
 *   - Beta source searches have their own hourly window, apart from the one
 *     every store user shares.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.js");
const TMP = mkdtempSync(path.join(tmpdir(), "tracely-beta-"));
// Before any import that opens the database (lib/entitlement.js → lib/db.js).
process.env.TRACELY_DATA_DIR = TMP;
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

const { betaTokens, betaTokenMatches, withBetaGrant } = await import("../lib/entitlement.js");
const { CheckError } = await import("../lib/errors.js");
const { isModelFailure, modelFailureLine } = await import("../lib/failureLog.js");

const BETA = { "X-Tracely-Beta": "right-token" };

// ── the helpers, as units ────────────────────────────────────────────────

test("betaTokens: comma-separated, trimmed, blanks dropped; absent or empty is none", () => {
  assert.deepEqual(betaTokens({}), []);
  assert.deepEqual(betaTokens({ TRACELY_BETA_TOKENS: "" }), []);
  assert.deepEqual(betaTokens({ TRACELY_BETA_TOKENS: " , ," }), []);
  assert.deepEqual(betaTokens({ TRACELY_BETA_TOKENS: " a ,, b ," }), ["a", "b"]);
});

test("betaTokenMatches: exact, case-sensitive, and nothing matches when beta is off", () => {
  const env = { TRACELY_BETA_TOKENS: "alpha-1, bravo-2" };
  assert.equal(betaTokenMatches("alpha-1", env), true);
  assert.equal(betaTokenMatches("bravo-2", env), true, "every listed token works, not just the first");
  for (const wrong of ["Alpha-1", "alpha-", "alpha-11", " alpha-1", "", null, undefined, 42, {}]) {
    assert.equal(betaTokenMatches(wrong, env), false, `matched ${JSON.stringify(wrong)}`);
  }
  assert.equal(betaTokenMatches("alpha-1", {}), false, "no TRACELY_BETA_TOKENS means no beta at all");
  assert.equal(betaTokenMatches("", { TRACELY_BETA_TOKENS: "" }), false, "an empty header cannot match an empty list");
});

test("withBetaGrant: Pro for a match, a NEW object, and the entitlement it was given untouched", () => {
  const env = { TRACELY_BETA_TOKENS: "right-token" };
  const req = (v) => ({ headers: v === undefined ? {} : { "x-tracely-beta": v } });
  const free = Object.freeze({ plan: "free", email: null, userId: null, enforced: true });

  assert.equal(withBetaGrant(free, req(undefined), env), free, "no header: the same object back");
  assert.equal(withBetaGrant(free, req("wrong"), env), free, "a wrong token: the same object back");
  assert.equal(withBetaGrant(free, req("right-token"), {}), free, "beta off: the same object back");

  const granted = withBetaGrant(free, req("right-token"), env);
  assert.notEqual(granted, free, "a cached entitlement must never be mutated into Pro");
  assert.deepEqual(granted, { plan: "pro", email: null, userId: null, enforced: true, beta: true });

  const student = withBetaGrant({ plan: "student", userId: "u", email: "e", enforced: true }, req("right-token"), env);
  assert.equal(student.plan, "pro", "max(plan, pro)");
  assert.equal(student.userId, "u", "a signed-in tester is still metered and billed as themselves");
  assert.equal(withBetaGrant({ plan: "pro", enforced: true }, req("right-token"), env).plan, "pro");
  assert.equal(withBetaGrant(free, req(["right-token"]), env).beta, true, "a repeated header reads its first value");
  assert.equal(withBetaGrant(free, req(" right-token "), env).beta, true, "surrounding space is not part of a header value");
  assert.equal(withBetaGrant(free, req("x".repeat(500)), { TRACELY_BETA_TOKENS: "x".repeat(500) }), free,
    "an over-long header is ignored rather than hashed");
});

test("the failure line names route, kind, model and effort — never the message or anything unlisted", () => {
  const leak = "My essay says the Treaty of Paris was 1783 — student@example.test";
  const tagged = new CheckError("bad_request", leak, { status: 502 });
  Object.defineProperty(tagged, "llm", { value: { model: "gpt-6-astra", effort: "medium" }, enumerable: false });
  const line = modelFailureLine("/api/check", tagged, { model: "gpt-5.6-luna", effort: "high" });
  assert.equal(line, "[tracely] model call failed route=/api/check kind=bad_request status=502 model=gpt-6-astra effort=medium",
    "the facade's tag wins over the route's trace: it is what was actually sent");
  assert.ok(!line.includes("Treaty") && !line.includes("student@"), "the message never reaches the log");

  const reasoned = Object.assign(new CheckError("server", leak, { status: 502 }), { reason: "unparseable" });
  assert.match(modelFailureLine("/api/flow", reasoned, { model: "gpt-5.6-luna", effort: "low" }), /kind=unparseable status=502 model=gpt-5.6-luna effort=low$/);
  // Anything that is not a value this server chose is refused a place in the line.
  const junk = Object.assign(new CheckError("server", "x", { status: 502 }), { reason: leak });
  assert.match(modelFailureLine("/api/check", junk, { model: leak, effort: leak }), /kind=unknown status=502 model=unlisted effort=unlisted$/);
  const noEffort = new CheckError("refusal", leak, { status: 502 });
  Object.defineProperty(noEffort, "llm", { value: { model: "gpt-5.6-luna", effort: null } });
  assert.match(modelFailureLine("/api/grade", noEffort), /model=gpt-5.6-luna effort=none$/);
});

test("only model failures are logged — never a caller's own 4xx, the budget, or a missing key", () => {
  const tag = (e) => Object.defineProperty(e, "llm", { value: { model: "gpt-5.6-luna", effort: "low" } });
  assert.equal(isModelFailure(new CheckError("bad_request", "text required")), false);
  assert.equal(isModelFailure(new CheckError("plan_limit", "used up", { status: 429 })), false);
  assert.equal(isModelFailure(new CheckError("rate_limit", "slow down", { status: 429 })), false);
  assert.equal(isModelFailure(new CheckError("budget", "daily limit", { status: 503 })), false);
  assert.equal(isModelFailure(new CheckError("no_key", "no key", { status: 503 })), false);
  assert.equal(isModelFailure(new Error("boom")), false, "non-CheckErrors have their own log line already");
  assert.equal(isModelFailure(new CheckError("server", "unusable grade", { status: 502 })), true);
  assert.equal(isModelFailure(tag(new CheckError("rate_limit", "OpenAI 429", { status: 429 }))), true, "anything out of the facade counts");
  assert.equal(isModelFailure(tag(new CheckError("no_key", "OpenAI rejected the key", { status: 503 }))), true);
});

// ── the servers ──────────────────────────────────────────────────────────

const USERS = {
  "tok-free": { id: "u-free", email: "free@example.test", app_metadata: {} },
  "tok-student": { id: "u-student", email: "student@example.test", app_metadata: { plan: "student" } },
  "tok-pro": { id: "u-pro", email: "pro@example.test", app_metadata: { plan: "pro" } },
};
const supabase = http.createServer((req, res) => {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
  const user = req.url === "/auth/v1/user" ? USERS[token] : undefined;
  res.writeHead(user ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify(user ?? { msg: "invalid token" }));
});

/* D's OpenAI: a preload that swaps globalThis.fetch for api.openai.com only.
 * It records model + effort per call and answers from the request's own
 * schema; a TRIGGER word in the input picks a failure (TRIGGER-SPLIT truncates
 * only a batch of more than one sentence, so a split's halves answer).
 * Written to a temp dir at runtime, because anything under test/ would be run
 * as a test file. */
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
// G's calls wait on the test's openaiHold server until it answers.
const HOLD = process.env.TRACELY_TEST_OPENAI_HOLD;
const [IN, OUT] = String(process.env.TRACELY_TEST_OPENAI_USAGE || "1,1").split(",").map(Number);
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith("https://api.openai.com/")) return real(url, init);
  if (HOLD) await real(HOLD, { method: "POST" }).then((r) => r.text());
  const body = JSON.parse(init.body);
  appendFileSync(process.env.TRACELY_TEST_OPENAI_LOG, JSON.stringify({ model: body.model, effort: body.reasoning?.effort ?? null, webSearch: Array.isArray(body.tools) }) + "\\n");
  const input = JSON.stringify(body.input);
  const batch = (String(body.input).match(/^\\[[^\\]]+\\] /gm) || []).length;
  const truncated = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1000, output_tokens: 16000 } };
  let reply;
  if (input.includes("TRIGGER-TRUNCATE")) reply = truncated;
  else if (input.includes("TRIGGER-SPLIT") && batch > 1) reply = truncated;
  else if (input.includes("TRIGGER-REFUSE")) reply = { output: [{ content: [{ type: "refusal", refusal: "no" }] }] };
  else if (input.includes("TRIGGER-GARBAGE")) reply = { output_text: "this is not json {" };
  else if (body.tools && input.includes("TRIGGER-3SEARCH")) reply = { output_text: JSON.stringify({ sources: [{ title: "A", url: "https://a.example/", publisher: "a", snippet: "s", stance: "supports" }] }), output: ["search", "open_page", "search"].map((type) => ({ type: "web_search_call", action: { type } })) };
  else if (body.tools && input.includes("TRIGGER-NOSOURCES")) reply = { output_text: "nothing I could use", output: ["search", "search"].map((type) => ({ type: "web_search_call", action: { type } })) };
  else if (body.tools) reply = { output_text: JSON.stringify({ sources: [{ title: "A", url: "https://a.example/", publisher: "a", snippet: "s", stance: "supports" }] }) };
  else reply = { output_text: JSON.stringify(emptyFor(body.text?.format?.schema)) };
  return new Response(JSON.stringify({ status: "completed", model: body.model, usage: { input_tokens: IN, output_tokens: OUT }, ...reply }), { status: 200, headers: { "Content-Type": "application/json" } });
};
`);
const openaiLog = () => readFileSync(OPENAI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/* G's OpenAI calls park here (TRACELY_TEST_OPENAI_HOLD) until the test lets
 * them go, so a burst is in flight AT ONCE by construction. A fixed 400 ms
 * delay was not: on a slow runner the burst's last admissions came after its
 * first calls had answered and released their holds, and the room that freed
 * admitted a seventh thorough call (PR #350's CI, 2026-10-14). Rightly so: a
 * stub that answers in 5 ms does it every time, with never more than five in
 * flight and $0.98 of the $1 spent. */
const parked = [];
let onPark = () => {};
const openaiHold = http.createServer((req, res) => { parked.push(res); onPark(); });
/** How many calls are parked once `n` are, or after `ms` if they never are. */
function parkedCalls(n, ms = 20_000) {
  return new Promise((resolve) => {
    const settle = () => { clearTimeout(timer); onPark = () => {}; resolve(parked.length); };
    const timer = setTimeout(settle, ms);
    onPark = () => { if (parked.length >= n) settle(); };
    onPark();
  });
}
const releaseParked = () => { for (const res of parked.splice(0)) res.end(); };

// Everything that could change these servers' behaviour is cleared, so a
// developer's shell cannot make the suite pass or fail.
const SCRUB = ["TRACELY_BETA_TOKENS", "TRACELY_BETA_DAILY_BUDGET_USD", "TRACELY_DAILY_BUDGET_USD", "TRACELY_APP_DAILY_BUDGET_USD", "TRACELY_PAID_DAILY_BUDGET_USD",
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "OPENAI_API_KEY", "TRACELY_MOCK", "TRACELY_EXTENSION_ID", "TRACELY_TRUSTED_PROXY_HOPS", "TRACELY_LLM_PROVIDER"];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.includes(k)));

/* A port the OS just handed out, so it is free and ephemeral. A fixed random
 * range was not safe: Node's fetch refuses the Fetch standard's "bad ports"
 * (5060, 5061, 6000, 6566, 6665-6669, 6697 — "bad port", forever), and local
 * services hold others (AirPlay on 5000, Postgres on 5432, Discord on 6463).
 * Any of those made a test server look like it never started. */
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/* Should the port be taken between the probe and the child's listen, the
 * child exits at once and the next attempt takes a fresh port. A boot that
 * still fails kills everything started so far: the servers that DID boot
 * used to be left running, and `node --test` never exited. */
const booted = [];
async function boot(env, { preload } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = await freePort();
    const child = spawn(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []), SERVER], {
      env: { ...baseEnv, PORT: String(p), TRACELY_DATA_DIR: mkdtempSync(path.join(TMP, "data-")), ...env },
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
      try { if ((await fetch(`${base}/api/status`)).ok && !exited) return { base, child, stderr: () => stderr }; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();
    if (!exited) throw new Error(`server on ${p} did not start: ${stderr}`);
    // It exited before answering — most likely the port was taken. Next one.
  }
  throw new Error("could not find a free port for a test server");
}

let A, B, C, D, E, G, H, I, J, K;
const G_LOG = path.join(TMP, "openai-g.jsonl");
writeFileSync(G_LOG, "");
// I and J (2026-10-17): bursts against the FREE pools, which used to reserve nothing.
const I_LOG = path.join(TMP, "openai-i.jsonl");
writeFileSync(I_LOG, "");
const J_LOG = path.join(TMP, "openai-j.jsonl");
writeFileSync(J_LOG, "");
const H_LOG = path.join(TMP, "openai-h.jsonl");
writeFileSync(H_LOG, "");
test.before(async () => {
  await new Promise((r) => supabase.listen(0, "127.0.0.1", r));
  await new Promise((r) => openaiHold.listen(0, "127.0.0.1", r));
  const hosted = { SUPABASE_URL: `http://127.0.0.1:${supabase.address().port}`, SUPABASE_ANON_KEY: "anon" };
  [A, B, C, D, E, G, H, I, J, K] = await Promise.all([
    boot({ ...hosted, TRACELY_MOCK: "1" }),
    boot({ ...hosted, TRACELY_MOCK: "1", TRACELY_BETA_TOKENS: " old-token , right-token ", TRACELY_BETA_DAILY_BUDGET_USD: "0.01" }),
    boot({ TRACELY_MOCK: "1", TRACELY_BETA_TOKENS: "right-token" }),
    boot({ ...hosted, OPENAI_API_KEY: "sk-test-not-a-real-key", TRACELY_BETA_TOKENS: "right-token", TRACELY_TEST_OPENAI_LOG: OPENAI_LOG }, { preload: STUB }),
    boot({ ...hosted, TRACELY_MOCK: "1", TRACELY_BETA_TOKENS: "right-token", TRACELY_BETA_DAILY_BUDGET_USD: "0.012", TRACELY_PAID_DAILY_BUDGET_USD: "0.01" }),
    boot({
      ...hosted, OPENAI_API_KEY: "sk-test-not-a-real-key", TRACELY_BETA_TOKENS: "right-token", TRACELY_BETA_DAILY_BUDGET_USD: "1",
      TRACELY_TEST_OPENAI_LOG: G_LOG, TRACELY_TEST_OPENAI_HOLD: `http://127.0.0.1:${openaiHold.address().port}/`, TRACELY_TEST_OPENAI_USAGE: "4000,2000",
    }, { preload: STUB }),
    boot({ ...hosted, OPENAI_API_KEY: "sk-test-not-a-real-key", TRACELY_BETA_TOKENS: "right-token", TRACELY_BETA_DAILY_BUDGET_USD: "0.02", TRACELY_TEST_OPENAI_LOG: H_LOG }, { preload: STUB }),
    boot({
      ...hosted, OPENAI_API_KEY: "sk-test-not-a-real-key", TRACELY_DAILY_BUDGET_USD: "0.1",
      TRACELY_TEST_OPENAI_LOG: I_LOG, TRACELY_TEST_OPENAI_DELAY_MS: "400", TRACELY_TEST_OPENAI_USAGE: "4000,2000",
    }, { preload: STUB }),
    boot({
      ...hosted, OPENAI_API_KEY: "sk-test-not-a-real-key", TRACELY_APP_DAILY_BUDGET_USD: "0.05",
      TRACELY_TEST_OPENAI_LOG: J_LOG, TRACELY_TEST_OPENAI_DELAY_MS: "400", TRACELY_TEST_OPENAI_USAGE: "4000,2000",
    }, { preload: STUB }),
    // K: a DEPLOYED box whose Supabase lines went missing (TRACELY_HOSTED stands in for release.json).
    boot({ TRACELY_HOSTED: "1", TRACELY_MOCK: "1" }),
  ]).catch((err) => {
    for (const child of booted) child.kill(); // or the run never exits
    throw err;
  });
});
test.after(() => {
  for (const s of [A, B, C, D, E, G, H, I, J, K]) s?.child.kill();
  supabase.close();
  releaseParked();
  openaiHold.close();
});

function call(srv, method, p, { body, install = "install-default", token, headers = {} } = {}) {
  return fetch(`${srv.base}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "X-Tracely-Install": install,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}
const entitlement = (srv, opts) => call(srv, "GET", "/api/entitlement", opts);
const status = (srv) => call(srv, "GET", "/api/status").then((r) => r.body);
const SENTENCE = "Water boils at 100 degrees Celsius at sea level.";
const check = (srv, extra = {}, opts = {}) =>
  call(srv, "POST", "/api/check", { ...opts, body: { text: SENTENCE, sentences: [{ id: "s1", text: SENTENCE }], ...extra } });
const sources = (srv, extra = {}, opts = {}) =>
  call(srv, "POST", "/api/sources", { ...opts, body: { claim: "Water boils at 100 degrees Celsius at sea level.", ...extra } });
const DRAFT = "Social media harms teenagers.\n\nStudies since 2012 show a rise in anxiety among heavy users.\n\nSchools should therefore limit phone use.";

// ── A: hosted, beta off ──────────────────────────────────────────────────

test("beta off (no TRACELY_BETA_TOKENS): the header grants nothing, and /api/status is unchanged", async () => {
  const e = await entitlement(A, { headers: BETA });
  assert.equal(e.status, 200);
  assert.equal(e.body.plan, "free");
  assert.ok(!("beta" in e.body), "beta is omitted, not false, when the grant did not apply");
  const r = await check(A, { model: "gpt-6-astra" }, { headers: BETA, install: "a-beta-off" });
  assert.equal(r.status, 200);
  assert.equal(r.body.modelUsed, "gpt-5.6-luna");
  assert.equal(r.body.plan, "free");
  assert.ok(!("betaBudget" in (await status(A))), "no beta, no betaBudget");
});

test("hosted /api/check runs luna on every plan, whatever the client asks for", async () => {
  // The server decides per route (modelForRoute). A shipped extension's
  // Balanced or Thorough stop is cosmetic until 2.20.0; Pro's thorough model
  // is reached only through deep:true ("Explain in depth", thorough.test.js).
  const cases = [
    [{ token: "tok-pro" }, "gpt-5.6-terra", "gpt-5.6-luna"],   // the retired balanced id is fast
    [{ token: "tok-pro" }, "gpt-6-astra", "gpt-5.6-luna"],     // a typing check is never astra
    [{ token: "tok-pro" }, undefined, "gpt-5.6-luna"],
    [{ token: "tok-pro" }, "gpt-99-imaginary", "gpt-5.6-luna"],
    [{ token: "tok-student" }, "gpt-6-astra", "gpt-5.6-luna"],
    [{ token: "tok-free" }, "gpt-5.6-terra", "gpt-5.6-luna"],
    [{}, "gpt-6-astra", "gpt-5.6-luna"],                      // anonymous is free
  ];
  for (const [who, asked, expected] of cases) {
    const r = await check(A, asked === undefined ? {} : { model: asked }, { ...who, install: `a-check-${who.token ?? "anon"}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.modelUsed, expected, `${who.token ?? "anonymous"} asking for ${asked}`);
  }
});

test("hosted /api/sources follows the same rule: luna for everyone", async () => {
  // (A caller may run 4 searches a minute; the retired-id test below spends
  // the rest of tok-pro's, terra included.)
  const cases = [
    ["tok-pro", "gpt-6-astra", "gpt-5.6-luna"],
    ["tok-student", "gpt-6-astra", "gpt-5.6-luna"],
    ["tok-free", "gpt-6-astra", "gpt-5.6-luna"],
    ["tok-pro", "nonsense", "gpt-5.6-luna"],
  ];
  for (const [token, asked, expected] of cases) {
    const r = await sources(A, { model: asked }, { token, install: `a-src-${token}-${asked}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.modelUsed, expected, `${token} asking for ${asked}`);
  }
});

/* Extension <= 2.19.2 — testers' copies and the Web Store build under review
 * — sends "gpt-5-nano" from its Fast stop and "gpt-5.4" from Balanced, 2.19.3+
 * sends "gpt-5.6-terra" from Balanced, and a pre-remap desktop sends the same
 * ids. Since the 2026-09-21 plan policy every one of them means fast (the
 * balanced tier is retired), and they must still be answered, never refused. */
test("a retired id from a shipped build is answered on fast on /api/check and /api/sources", async () => {
  const checks = [
    [{ token: "tok-pro" }, "gpt-5.4", "gpt-5.6-luna"],
    [{ token: "tok-student" }, "gpt-5.4", "gpt-5.6-luna"],
    [{ token: "tok-student" }, "gpt-5.6-terra", "gpt-5.6-luna"],
    [{ token: "tok-free" }, "gpt-5.4", "gpt-5.6-luna"],
    [{ token: "tok-pro" }, "gpt-5-nano", "gpt-5.6-luna"],
    [{}, "gpt-5-nano", "gpt-5.6-luna"],
    [{ token: "tok-pro" }, "gpt-5.4-mini", "gpt-5.6-luna"], // a lookalike is not an alias: DOWN to fast
    [{ token: "tok-pro" }, "toString", "gpt-5.6-luna"],
  ];
  for (const [who, asked, expected] of checks) {
    const r = await check(A, { model: asked }, { ...who, install: `a-legacy-${who.token ?? "anon"}-${asked}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.modelUsed, expected, `${who.token ?? "anonymous"} asking /api/check for ${asked}`);
  }
  const searches = [["tok-student", "gpt-5.4", "gpt-5.6-luna"], ["tok-pro", "gpt-5.6-terra", "gpt-5.6-luna"], ["tok-pro", "gpt-5-nano", "gpt-5.6-luna"], ["tok-free", "gpt-5.4", "gpt-5.6-luna"]];
  for (const [token, asked, expected] of searches) {
    const r = await sources(A, { model: asked }, { token, install: `a-legacy-src-${token}-${asked}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.modelUsed, expected, `${token} asking /api/sources for ${asked}`);
  }
});

test("a pre-remap desktop's retired id is answered on fast on the app routes", async () => {
  const r = await call(A, "POST", "/api/structure", { body: { text: DRAFT, model: "gpt-5.4" }, token: "tok-student", install: "a-legacy-desktop" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.model, /^gpt-5\.6-luna/, `a Student's old balanced request ran ${r.body.model}`);
  const terra = await call(A, "POST", "/api/structure", { body: { text: DRAFT + " terra", model: "gpt-5.6-terra" }, token: "tok-pro", install: "a-legacy-desktop-pro" });
  assert.equal(terra.status, 200, JSON.stringify(terra.body));
  assert.match(terra.body.model, /^gpt-5\.6-luna/, `a Pro desktop's old balanced request ran ${terra.body.model}`);
  const free = await call(A, "POST", "/api/structure", { body: { text: DRAFT + " free", model: "gpt-5.4" }, token: "tok-free", install: "a-legacy-desktop-free" });
  assert.match(free.body.model, /^gpt-5\.6-luna/, "and never above the plan");
});

test("hosted PUT /api/prefs is refused, GET still answers, and the row cannot steer anyone's model", async () => {
  const put = await call(A, "PUT", "/api/prefs", { body: { modelStrategy: "uniform", model: "gpt-6-astra" } });
  assert.equal(put.status, 403);
  assert.equal(put.body.error.kind, "forbidden");
  assert.equal(typeof put.body.error.message, "string");
  const get = await call(A, "GET", "/api/prefs");
  assert.equal(get.status, 200);
  assert.notEqual(get.body.model, "gpt-6-astra", "the refused write did not land");
  const r = await check(A, {}, { token: "tok-pro", install: "a-after-prefs" });
  assert.equal(r.body.modelUsed, "gpt-5.6-luna");
});

// ── B: hosted, beta on, a 1-cent beta pool ───────────────────────────────

test("beta on: no header or a wrong token is free; the right token is Pro with beta:true", async () => {
  const none = await entitlement(B);
  assert.equal(none.body.plan, "free");
  assert.ok(!("beta" in none.body));
  for (const wrong of ["wrong-token", "right-toke", "right-token2", "RIGHT-TOKEN", "old-token,right-token"]) {
    const r = await entitlement(B, { headers: { "X-Tracely-Beta": wrong } });
    assert.equal(r.body.plan, "free", `"${wrong}" was granted`);
    assert.ok(!("beta" in r.body));
  }
  const right = await entitlement(B, { headers: BETA });
  assert.equal(right.status, 200);
  assert.equal(right.body.plan, "pro");
  assert.equal(right.body.beta, true);
  assert.equal(right.body.enforced, true, "enforced keeps meaning 'this server clamps'");
  assert.equal(right.body.userId, null);
  const old = await entitlement(B, { headers: { "X-Tracely-Beta": "old-token" } });
  assert.equal(old.body.beta, true, "every token in the comma-separated list works");
});

test("a signed-in free user with the token is Pro, and the grant never sticks to their cached plan", async () => {
  const granted = await entitlement(B, { token: "tok-free", headers: BETA });
  assert.equal(granted.body.plan, "pro");
  assert.equal(granted.body.beta, true);
  assert.equal(granted.body.userId, "u-free", "still themselves");
  assert.equal(granted.body.email, "free@example.test");
  // Same bearer token, inside the 60s plan cache, no header: free again.
  const after = await entitlement(B, { token: "tok-free" });
  assert.equal(after.body.plan, "free", "the grant leaked into the cached entitlement");
  assert.ok(!("beta" in after.body));
  const student = await entitlement(B, { token: "tok-student", headers: BETA });
  assert.equal(student.body.plan, "pro");
});

test("a beta caller runs /api/check at Pro, signed in or out; the same caller without the header does not", async () => {
  // Every check runs luna since the 2026-09-21 plan policy, Pro's included.
  // What Pro adds on /api/check is "Explain in depth" (deep:true), which a
  // free caller is refused — so that is what tells the grant apart here.
  // (Whether it then runs on astra is thorough.test.js's; B's 1-cent beta
  // pool cannot hold astra's worst case, so here it answers on luna.)
  const out = await check(B, { model: "gpt-6-astra" }, { headers: BETA, install: "beta-tester-1" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.modelUsed, "gpt-5.6-luna");
  assert.equal(out.body.plan, "pro");
  const deep = await check(B, { deep: true }, { headers: BETA, install: "beta-tester-1" });
  assert.equal(deep.status, 200, JSON.stringify(deep.body));
  assert.equal(deep.body.plan, "pro");
  const signedIn = await check(B, { deep: true }, { token: "tok-free", headers: BETA, install: "beta-tester-2" });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.plan, "pro");
  const plain = await check(B, { model: "gpt-6-astra" }, { install: "beta-tester-1" });
  assert.equal(plain.body.modelUsed, "gpt-5.6-luna");
  assert.equal(plain.body.plan, "free");
  const plainDeep = await check(B, { deep: true }, { install: "beta-tester-1" });
  assert.equal(plainDeep.status, 403, JSON.stringify(plainDeep.body));
  assert.equal(plainDeep.body.error.kind, "plan_required");
});

test("the desktop's app routes ignore the beta header entirely", async () => {
  const r = await call(B, "POST", "/api/structure", { body: { text: DRAFT, model: "gpt-6-astra" }, headers: BETA, install: "beta-desktop" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.model, /^gpt-5.6-luna/, `a beta header reached an app route and ran ${r.body.model}`);
});

test("beta spend lands in the beta pool; the extension pool is untouched", async () => {
  const before = await status(B);
  assert.deepEqual(before.betaBudget, { enforced: true, budgetUsd: 0.01, spentUsd: 0, remainingPct: 1, sourcesAllowed: true });
  assert.equal(before.budget.spentUsd, 0);

  // A source search costs exactly one cent (the web_search fee) even on the
  // mock model, which makes it the one call whose spend is visible here.
  const r = await sources(B, { model: "gpt-6-astra" }, { headers: BETA, install: "beta-tester-1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.modelUsed, "gpt-5.6-luna", "every source search runs luna, the client's id ignored");
  assert.equal(r.body.plan, "pro");

  const after = await status(B);
  assert.equal(after.betaBudget.spentUsd, 0.01, "the beta pool paid");
  assert.equal(after.budget.spentUsd, 0, "the extension pool never saw it");
});

test("an exhausted beta pool drops the tester to their own plan on the extension pool — never a 503", async () => {
  const c = await check(B, { model: "gpt-6-astra" }, { headers: BETA, install: "beta-tester-1" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.modelUsed, "gpt-5.6-luna", "back on the free model");
  assert.equal(c.body.plan, "free");

  const s = await sources(B, { model: "gpt-6-astra" }, { headers: BETA, install: "beta-tester-1" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.modelUsed, "gpt-5.6-luna");
  assert.equal(s.body.plan, "free");

  const after = await status(B);
  assert.equal(after.budget.spentUsd, 0.01, "the fallback search was paid by the extension pool");
  assert.equal(after.betaBudget.spentUsd, 0.01, "and not by the spent beta pool");

  // The grant itself is unchanged: the pool only decides who pays.
  const e = await entitlement(B, { headers: BETA });
  assert.equal(e.body.plan, "pro");
  assert.equal(e.body.beta, true);
});

// ── C: local, unenforced ─────────────────────────────────────────────────

test("a local server keeps server-side tiering (pickModel) and a writable prefs row", async () => {
  const put = await call(C, "PUT", "/api/prefs", { body: { modelStrategy: "uniform", model: "gpt-6-astra" } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await check(C, { model: "gpt-5.6-luna" })).body.modelUsed, "gpt-6-astra", "uniform: the prefs row decides");
  assert.equal((await sources(C, { model: "gpt-5.6-luna" })).body.modelUsed, "gpt-6-astra");

  // A prefs row saved before the remap names a retired id: it means its tier,
  // which for both old balanced ids is fast since the 2026-09-21 plan policy.
  for (const legacy of ["gpt-5.4", "gpt-5.6-terra"]) {
    assert.equal((await call(C, "PUT", "/api/prefs", { body: { modelStrategy: "uniform", model: legacy } })).status, 200);
    assert.equal((await check(C, {})).body.modelUsed, "gpt-5.6-luna", `a legacy ${legacy} prefs row means fast`);
  }

  assert.equal((await call(C, "PUT", "/api/prefs", { body: { modelStrategy: "economy" } })).status, 200);
  assert.equal((await check(C, { model: "gpt-6-astra" })).body.modelUsed, "gpt-5.6-luna", "economy: the fast tier, whatever was asked");

  const e = await entitlement(C, { headers: BETA });
  assert.equal(e.body.enforced, false, "nothing is clamped locally, beta or not");
});

// ── D: the real request path, OpenAI stubbed ─────────────────────────────

async function sent(fn) {
  const n = openaiLog().length;
  const r = await fn();
  return { r, calls: openaiLog().slice(n) };
}

test("/api/flow runs luna at low for everyone, whatever model and effort the client sends", async () => {
  // Pinned by the server since the 2026-09-21 plan policy (flow.test.js has
  // the rest): the client's effort was passed straight through, "high" included.
  const text = "Social media harms teenagers. Studies since 2012 show a rise in anxiety among heavy users.";
  let { r, calls } = await sent(() => call(D, "POST", "/api/flow", { body: { text, model: "gpt-6-astra", effort: "high" }, headers: BETA, install: "d-flow-beta" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls.map(({ model, effort }) => ({ model, effort })), [{ model: "gpt-5.6-luna", effort: "low" }]);

  ({ r, calls } = await sent(() => call(D, "POST", "/api/flow", { body: { text, model: "gpt-6-astra", effort: "medium" }, install: "d-flow-free" })));
  assert.deepEqual(calls.map(({ model, effort }) => ({ model, effort })), [{ model: "gpt-5.6-luna", effort: "low" }]);
  assert.equal(r.body.modelUsed, "gpt-5.6-luna");

  ({ calls } = await sent(() => call(D, "POST", "/api/flow", { body: { text, effort: "turbo" }, install: "d-flow-junk" })));
  assert.equal(calls[0].effort, "low", "junk becomes the default, never OpenAI's own");
});

test("/api/sources runs luna at low, whatever the client sends", async () => {
  // The store build sends no effort here, and every one of its source
  // searches has always run at the vendor's default. The server now holds
  // every caller to that, so a client's "high" can no longer buy a dearer search.
  let { r, calls } = await sent(() => sources(D, { model: "gpt-5.6-terra" }, { install: "d-src-free" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls.map(({ model, effort, webSearch }) => ({ model, effort, webSearch })), [{ model: "gpt-5.6-luna", effort: "low", webSearch: true }]);

  ({ r, calls } = await sent(() => sources(D, { model: "gpt-6-astra", effort: "high" }, { headers: BETA, install: "d-src-beta" })));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls.map(({ model, effort }) => ({ model, effort })), [{ model: "gpt-5.6-luna", effort: "low" }]);

  ({ calls } = await sent(() => sources(D, { effort: "turbo" }, { install: "d-src-junk" })));
  assert.equal(calls[0].effort, "low", "a junk level is not passed through either");
});

test("/api/check sends the model it reports to the provider, not just in modelUsed", async () => {
  let { r, calls } = await sent(() => check(D, { model: "gpt-5.6-terra", effort: "low" }, { token: "tok-pro", install: "d-check-pro" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.modelUsed, "gpt-5.6-luna");
  assert.deepEqual(calls.map(({ model, effort }) => ({ model, effort })), [{ model: "gpt-5.6-luna", effort: "medium" }]);
  // Pro's "Explain in depth", within the allowance: astra at low, and the same id in modelUsed.
  ({ r, calls } = await sent(() => check(D, { deep: true }, { token: "tok-pro", install: "d-check-deep" })));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.modelUsed, "gpt-6-astra");
  assert.deepEqual(calls.map(({ model, effort }) => ({ model, effort })), [{ model: "gpt-6-astra", effort: "low" }]);
});

test("/api/check runs luna at its measured effort, whatever model and effort the client sends", async () => {
  // eval/models/FINDINGS.md: gpt-5.6-luna checks at 100% at medium and 90% at
  // low. Builds up to 2.19.5 send "low" from their Fast stop and "medium" from
  // their Thorough stop, with whichever id that stop names.
  const who = [["gpt-5-nano", {}], ["gpt-5.6-terra", { token: "tok-pro" }], ["gpt-6-astra", { headers: BETA }]];
  for (const [model, caller] of who) {
    for (const asked of ["low", undefined, "minimal", "turbo", "medium", "high"]) {
      const body = asked === undefined ? { model } : { model, effort: asked };
      const { r, calls } = await sent(() => check(D, body, { install: `d-eff-${model}-${asked}`, ...caller }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.modelUsed, "gpt-5.6-luna");
      assert.deepEqual(calls.map(({ model: m, effort }) => ({ model: m, effort })), [{ model: "gpt-5.6-luna", effort: "medium" }], `${model} asked at ${asked}`);
    }
  }
  // The store build's Thorough stop, exactly as 2.19.2 sends it: astra at medium. A typing check is never astra.
  let { calls } = await sent(() => check(D, { model: "gpt-6-astra", effort: "medium" }, { token: "tok-pro", install: "d-eff-store-thorough" }));
  assert.deepEqual(calls.map(({ model, effort }) => ({ model, effort })), [{ model: "gpt-5.6-luna", effort: "medium" }]);

  // Not the other routes: /api/flow runs at its own pinned low.
  const text = "Social media harms teenagers. Studies since 2012 show a rise in anxiety among heavy users.";
  ({ calls } = await sent(() => call(D, "POST", "/api/flow", { body: { text, model: "gpt-5.6-luna", effort: "medium" }, install: "d-floor-flow" })));
  assert.deepEqual(calls.map(({ model, effort }) => ({ model, effort })), [{ model: "gpt-5.6-luna", effort: "low" }]);
});

test("a retired id reaches the provider as its tier's current model (fast) — on /api/check and /api/flow", async () => {
  let { r, calls } = await sent(() => check(D, { model: "gpt-5.4", effort: "low" }, { token: "tok-student", install: "d-legacy-check" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(calls.map(({ model }) => model), ["gpt-5.6-luna"]);
  assert.equal(r.body.modelUsed, "gpt-5.6-luna");

  const text = "Social media harms teenagers. Studies since 2012 show a rise in anxiety among heavy users.";
  // One caller per id: /api/flow admits one call per caller per 120 s, and a
  // signed-in caller is one caller whatever install id it sends.
  const callers = { "gpt-5.4": { token: "tok-pro" }, "gpt-5.6-terra": { headers: BETA }, "gpt-5-nano": {} };
  for (const [legacy, who] of Object.entries(callers)) {
    ({ r, calls } = await sent(() => call(D, "POST", "/api/flow", { body: { text, model: legacy, effort: "high" }, ...who, install: `d-legacy-flow-${legacy}` })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(calls.map(({ model, effort }) => ({ model, effort })), [{ model: "gpt-5.6-luna", effort: "low" }], legacy);
    assert.equal(r.body.modelUsed, "gpt-5.6-luna");
  }
});

async function logLine(srv, needle) {
  for (let i = 0; i < 40; i++) {
    const line = srv.stderr().split("\n").find((l) => l.includes(needle));
    if (line) return line;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test("a failed model call logs route, kind, model and effort — and none of the user's text", async () => {
  const secret = "PRIVATE-ESSAY-7731 my grandmother emigrated in 1952";
  const install = "install-SECRET-4242";
  const text = `TRIGGER-TRUNCATE ${secret}`;
  const r = await call(D, "POST", "/api/check", { body: { text, sentences: [{ id: "s1", text }] }, install, token: "tok-free" });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.kind, "truncated", "the wire error is unchanged");
  const truncated = await logLine(D, "route=/api/check");
  // effort=medium: the fast tier's /api/check effort, logged as sent.
  assert.equal(truncated, "[tracely] model call failed route=/api/check kind=truncated status=502 model=gpt-5.6-luna effort=medium");

  const garbage = await call(D, "POST", "/api/flow", { body: { text: `TRIGGER-GARBAGE ${secret}`, model: "gpt-6-astra", effort: "high" }, headers: BETA, install });
  assert.equal(garbage.status, 502);
  // The model and effort the server pinned for /api/flow, not the ones asked for.
  assert.equal(await logLine(D, "route=/api/flow"), "[tracely] model call failed route=/api/flow kind=unparseable status=502 model=gpt-5.6-luna effort=low");

  // A desktop route passes the same handler.
  const refused = await call(D, "POST", "/api/structure", { body: { text: `${DRAFT} TRIGGER-REFUSE ${secret}` }, install });
  assert.equal(refused.status, 502, JSON.stringify(refused.body));
  assert.match(await logLine(D, "route=/api/structure") ?? "", /^\[tracely\] model call failed route=\/api\/structure kind=refusal status=502 model=gpt-5.6-luna effort=\w+$/);

  // A caller's own mistake is not a model failure.
  const before = D.stderr();
  const bad = await call(D, "POST", "/api/check", { body: { text: secret, sentences: [] }, install });
  assert.equal(bad.status, 400);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(D.stderr(), before, "a 400 wrote a log line");

  const log = D.stderr();
  for (const leak of ["PRIVATE-ESSAY", "grandmother", "TRIGGER-", "install-SECRET", "u-free", "free@example.test", "right-token"]) {
    assert.ok(!log.includes(leak), `the server log carries ${leak}:\n${log}`);
  }
});

test("a truncated call's billed cost reaches the pool that admitted it", async () => {
  // The truncation spends every output token allowed. It used to vanish with
  // the error, so the pool — for beta, the only bound — never saw it.
  const before = await status(D);
  const text = "TRIGGER-TRUNCATE the pool must see this";
  const r = await call(D, "POST", "/api/check", { body: { text, sentences: [{ id: "s1", text }], model: "gpt-6-astra" }, headers: BETA, install: "d-trunc-beta" });
  assert.equal(r.status, 502);
  let after = await status(D);
  // 1,000 in + 16,000 out on gpt-5.6-luna (every check's model) = $0.0194
  assert.equal(Number((after.betaBudget.spentUsd - before.betaBudget.spentUsd).toFixed(4)), 0.0194);
  assert.equal(after.budget.spentUsd, before.budget.spentUsd, "and only there");

  // "Explain in depth" on the thorough model: the same, at astra's price.
  const mid = after;
  const deep = await call(D, "POST", "/api/check", { body: { text, sentences: [{ id: "s1", text }], deep: true }, headers: BETA, install: "d-trunc-deep" });
  assert.equal(deep.status, 502);
  after = await status(D);
  // 1,000 in + 16,000 out on gpt-6-astra = $0.81
  assert.equal(Number((after.betaBudget.spentUsd - mid.betaBudget.spentUsd).toFixed(4)), 0.81);
  assert.equal(after.budget.spentUsd, before.budget.spentUsd, "and only there");
});

test("a split check that fails in a half still records the truncated call and the half that answered", async () => {
  // Both sentences: truncates. [s1]: answers. [s2]: truncates, cannot split,
  // throws. The route used to record only that last call's usage.
  const before = await status(D);
  const body = { text: "A short essay.", sentences: [{ id: "s1", text: "Plain one." }, { id: "s2", text: "TRIGGER-TRUNCATE two." }], model: "gpt-6-astra" };
  const { r, calls } = await sent(() => call(D, "POST", "/api/check", { body, headers: BETA, install: "d-split-fail" }));
  assert.equal(r.status, 502);
  assert.equal(r.body.error.kind, "truncated");
  assert.equal(calls.length, 3);
  const after = await status(D);
  // 2 x (1,000 in + 16,000 out) on gpt-5.6-luna = $0.0388, plus the tiny half.
  assert.equal(Number((after.betaBudget.spentUsd - before.betaBudget.spentUsd).toFixed(4)), 0.0388);
});

test("a source search records every web_search_call its answer made, and keeps the count off the wire", async () => {
  // OpenAI bills the tool per call; a reasoning model can make several.
  let before = await status(D);
  const r = await sources(D, { claim: "TRIGGER-3SEARCH water boils at 100 C.", model: "gpt-6-astra" }, { headers: BETA, install: "d-3search" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!("webSearchCalls" in r.body), "the extension's response shape is unchanged");
  let after = await status(D);
  assert.equal(Number((after.betaBudget.spentUsd - before.betaBudget.spentUsd).toFixed(2)), 0.03, "three calls, a cent each");

  // An answer that reports no search is still charged the one the route exists for.
  before = after;
  await sources(D, { model: "gpt-6-astra" }, { headers: BETA, install: "d-1search" });
  after = await status(D);
  assert.equal(Number((after.betaBudget.spentUsd - before.betaBudget.spentUsd).toFixed(2)), 0.01);

  // A search that found nothing usable was billed — tokens and searches — and is recorded.
  before = after;
  const none = await sources(D, { claim: "TRIGGER-NOSOURCES something obscure.", model: "gpt-6-astra" }, { headers: BETA, install: "d-nosources" });
  assert.equal(none.status, 502);
  assert.equal(none.body.error.message, "No usable sources came back — try again.", "the wire error is unchanged");
  after = await status(D);
  assert.equal(Number((after.betaBudget.spentUsd - before.betaBudget.spentUsd).toFixed(2)), 0.02);
});

// A split: the whole batch truncates, each half answers.
const SPLIT = { text: "TRIGGER-SPLIT essay.", sentences: [{ id: "s1", text: "One." }, { id: "s2", text: "Two." }] };

test("a truncated check splits when the pool has room for the halves", async () => {
  const before = await status(D);
  const { r, calls } = await sent(() => call(D, "POST", "/api/check", { body: { ...SPLIT, model: "gpt-6-astra" }, headers: BETA, install: "d-split-ok" }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(calls.length, 3, "the truncated call and two halves");
  const after = await status(D);
  // 1,000 in + 16,000 out on gpt-5.6-luna = $0.0194, plus two tiny halves.
  assert.equal(Number((after.betaBudget.spentUsd - before.betaBudget.spentUsd).toFixed(4)), 0.0194, "the truncated call is paid for too");
});

// ── H: a beta pool too small for a split ─────────────────────────────────

test("a split is admitted against the pool like a call: no room, no halves, the check fails as truncated", async () => {
  // A 2-cent pool admits one check (a pool admits while anything is left
  // unheld) and then holds its worst case on luna, ~2.5 cents. The halves
  // would be two more worst cases, and nothing is left unheld; a split used
  // to run on money nobody had held.
  const hLog = () => readFileSync(H_LOG, "utf8").split("\n").filter(Boolean);
  let n = hLog().length;
  const r = await call(H, "POST", "/api/check", { body: { ...SPLIT, model: "gpt-6-astra" }, headers: BETA, install: "h-split-beta" });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.kind, "truncated", "the wire error a truncated single sentence gives");
  assert.equal(hLog().length - n, 1, "no halves were sent");
  const st = await status(H);
  assert.equal(st.betaBudget.spentUsd, 0.0194, "the truncated call is recorded");

  // The extension pool reserves nothing, so a fast check still splits there.
  n = hLog().length;
  const free = await call(H, "POST", "/api/check", { body: SPLIT, install: "h-split-free" });
  assert.equal(free.status, 200, JSON.stringify(free.body));
  assert.equal(free.body.modelUsed, "gpt-5.6-luna");
  assert.equal(hLog().length - n, 3);
});

// ── E: the pools' edges ──────────────────────────────────────────────────

test("a beta source search stays on the beta pool below its 20% line, until the pool is actually spent", async () => {
  const s1 = await sources(E, { model: "gpt-6-astra" }, { headers: BETA, install: "e-beta-src" });
  assert.equal(s1.body.modelUsed, "gpt-5.6-luna");
  assert.equal(s1.body.plan, "pro");
  let st = await status(E);
  assert.equal(st.betaBudget.spentUsd, 0.01);
  assert.ok(st.betaBudget.remainingPct < 0.2, "below the extension pool's shed line");

  const s2 = await sources(E, { model: "gpt-6-astra" }, { headers: BETA, install: "e-beta-src" });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  assert.equal(s2.body.modelUsed, "gpt-5.6-luna");
  assert.equal(s2.body.plan, "pro");
  st = await status(E);
  assert.equal(st.betaBudget.spentUsd, 0.02, "at most one call over the ceiling");
  assert.equal(st.budget.spentUsd, 0, "the extension pool never paid while the beta pool had room");

  const s3 = await sources(E, { model: "gpt-6-astra" }, { headers: BETA, install: "e-beta-src" });
  assert.equal(s3.status, 200);
  assert.equal(s3.body.plan, "free", "spent: now the tester's own plan");
});

test("Student and Pro calls on the extension's routes spend the paid pool, never the free users' day", async () => {
  const r = await sources(E, { model: "gpt-6-astra" }, { token: "tok-pro", install: "e-pro" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.modelUsed, "gpt-5.6-luna");
  const st = await status(E);
  assert.equal(st.paidBudget.spentUsd, 0.01, "the paid pool paid");
  assert.equal(st.budget.spentUsd, 0.01, "the extension pool only has the beta fallback search from before");
});

test("a spent paid pool drops a paying caller to the fast model on the extension pool — plan kept, never a 503", async () => {
  const before = await status(E);
  const c = await check(E, { model: "gpt-6-astra" }, { token: "tok-pro", install: "e-pro" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.modelUsed, "gpt-5.6-luna");
  assert.equal(c.body.plan, "pro", "still Pro: unmetered quotas, just the fast model");
  const s = await sources(E, { model: "gpt-5.6-terra" }, { token: "tok-student", install: "e-student" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.modelUsed, "gpt-5.6-luna");
  assert.equal(s.body.plan, "student");
  const after = await status(E);
  assert.equal(Number((after.budget.spentUsd - before.budget.spentUsd).toFixed(4)), 0.01, "that search was paid by the extension pool");
  assert.equal(after.paidBudget.spentUsd, 0.01);
});

// ── C: the beta search window ────────────────────────────────────────────

test("beta source searches have their own hourly window, apart from the one store users share", async () => {
  for (let i = 0; i < 30; i++) {
    const r = await sources(C, {}, { headers: BETA, install: `c-beta-${i}` });
    assert.equal(r.status, 200, `beta search ${i + 1}: ${JSON.stringify(r.body)}`);
  }
  const over = await sources(C, {}, { headers: BETA, install: "c-beta-over" });
  assert.equal(over.status, 429);
  assert.equal(over.body.error.message, "Web-search hourly cap reached — try again later.", "the same wording the store build knows");
  const store = await sources(C, {}, { install: "c-store-user" });
  assert.equal(store.status, 200, "30 beta searches did not touch the window store users share");
});

// ── G: a concurrent burst against the beta pool ──────────────────────────

test("a burst of beta checks with rotating install ids cannot overspend the beta pool", async () => {
  // The review's case, on the only check that still reaches the thorough
  // model: "Explain in depth" (deep:true). $1 pool, calls priced at 4k in /
  // 2k out ($0.14 on gpt-6-astra, inside its 15-cent reservation), a fresh
  // install id — so a fresh Thorough allowance — per request. The allowance
  // cannot bound a tester who rotates ids; the POOL must: each astra
  // admission holds luna's check worst case (~2.5 cents) plus astra's 15
  // cents: five fit in $1, and a pool admits while anything is left unheld,
  // so at most six at once. Every call is held (openaiHold) until all forty
  // are in flight, so no hold is released, and no room freed, mid-burst.
  //
  // The first check goes alone, so the pool has served a thorough call
  // whatever order the other 39 are gated in: forty luna holds come to
  // $1.008 by themselves, and an order that gated all forty before any read
  // its body would admit none.
  const text = "Water boils at 100 degrees Celsius at sea level.";
  const deepCheck = (i) => call(G, "POST", "/api/check", { body: { text, sentences: [{ id: "s1", text }], deep: true, model: "gpt-6-astra", effort: "high" }, headers: BETA, install: `g-burst-${i}` });
  const first = deepCheck(0);
  const firstParked = await parkedCalls(1);
  const rest = Array.from({ length: 39 }, (_, i) => deepCheck(i + 1));
  const inFlight = await parkedCalls(40);
  releaseParked();
  const burst = await Promise.all([first, ...rest]);
  assert.equal(firstParked, 1, "the first check reached the model on its own");
  assert.equal(inFlight, 40, `${inFlight} of 40 checks were in flight at once`);
  assert.ok(burst.every((r) => r.status === 200), "beta never refuses: the overflow falls back");
  const astra = burst.filter((r) => r.body.modelUsed === "gpt-6-astra").length;
  assert.ok(astra >= 1, "the pool still served someone");
  assert.ok(astra <= 6, `${astra} thorough calls admitted against a $1 pool at once`);
  const st = await status(G);
  // At most the pool plus the one call admitted last (its worst case, 15 cents).
  assert.ok(st.betaBudget.spentUsd <= 1 + 0.15, `beta pool spent $${st.betaBudget.spentUsd} of $1`);
});

// ── I, J: bursts against the free pools (2026-10-17) ─────────────────────
// The extension and app pools used to check spend on disk only, so every
// request admitted before the first charge landed ran; an install id rotates
// freely, so the caller windows bounded nothing, and the overshoot was
// concurrency x worst case. Now each admission holds the route's worst case
// on the fast model and a pool admits only while it has room for what is in
// flight, refusing with the budget 503 every installed build already knows.

test("a burst of free checks with rotating install ids is refused once what is in flight fills the extension pool", async () => {
  // $0.10 pool; a check's worst case on gpt-5.6-luna is ~2.52 cents, so four
  // admissions fill it, and the pool admits while anything is left unheld.
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => check(I, {}, { install: `i-burst-${i}` })));
  const ok = burst.filter((r) => r.status === 200).length;
  const refused = burst.filter((r) => r.status === 503);
  assert.ok(ok >= 1, "the pool still served someone");
  assert.ok(ok <= 4, `${ok} checks admitted against a $0.10 pool at once`);
  assert.equal(ok + refused.length, 30, "every other call is the budget refusal");
  assert.ok(refused.every((r) => r.body.error.kind === "budget"), "the kind installed builds already handle");
  assert.equal(readFileSync(I_LOG, "utf8").split("\n").filter(Boolean).length, ok, "no refused call reached the model");
  // Spent once the burst is over: the reservations are released, so a check is admitted again.
  assert.equal((await check(I, {}, { install: "i-after" })).status, 200, "a released reservation frees the pool");
});

test("a burst of desktop calls with rotating install ids is refused once what is in flight fills the app pool", async () => {
  // $0.05 pool; detect-claims' worst case (WORST_CALL) is ~2.17 cents: three fit.
  const body = { draft: "Water boils at 100 degrees Celsius at sea level. Paris is the capital of France." };
  const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => call(J, "POST", "/api/detect-claims", { body, install: `j-burst-${i}` })));
  const ok = burst.filter((r) => r.status === 200).length;
  assert.ok(ok >= 1 && ok <= 3, `${ok} desktop calls admitted against a $0.05 pool at once`);
  assert.ok(burst.filter((r) => r.status !== 200).every((r) => r.status === 503 && r.body.error.kind === "budget"));
  assert.equal(readFileSync(J_LOG, "utf8").split("\n").filter(Boolean).length, ok, "no refused call reached the model");
});

test("a deployed server missing its Supabase settings refuses what spends, instead of running unmetered", async () => {
  // Metering hung on SUPABASE_URL/SUPABASE_ANON_KEY alone, so a blank line in
  // the box's .env (re-read live) put the public server in LOCAL mode: no
  // pools, no quotas, the client's model honoured, PUT /api/prefs open.
  const r = await check(K, {}, { install: "k-1" });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.kind, "budget", "a refusal installed builds already show as final");
  const app = await call(K, "POST", "/api/detect-claims", { body: { draft: "Water boils at 100 degrees Celsius." }, install: "k-2" });
  assert.equal(app.status, 503);
  const prefs = await call(K, "PUT", "/api/prefs", { body: { modelStrategy: "uniform", model: "gpt-6-astra" } });
  assert.equal(prefs.status, 403, "the shared prefs row stays closed");
  assert.equal((await call(K, "GET", "/api/status")).status, 200, "status still answers, for the healthcheck");
});
