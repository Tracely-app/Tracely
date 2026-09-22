/**
 * /api/flow on a hosted server, over real HTTP (decision document §2, §3):
 *   - it runs the fast model at low effort, PINNED — the client's model and
 *     effort are never read (shipped extensions send their slider's);
 *   - one flow call per caller per FLOW_MIN_INTERVAL_MS (120 s), answered
 *     429 kind "flow_rate" with retryAfter, which shipped builds' requestFlow
 *     swallows; a malformed request does not use up the interval;
 *   - the daily flow quota (DAILY_FLOW: Free 40, Student and Pro 150), which
 *     the floor makes unreachable in a test's lifetime, so the day's count is
 *     seeded straight into the server's database (node:sqlite, WAL) first.
 * OpenAI is stubbed by a preload that logs what the server sent.
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
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { usageDay, FLOW_MIN_INTERVAL_MS } from "../shared/plan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.js");
const TMP = mkdtempSync(path.join(tmpdir(), "tracely-flow-"));
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
  return new Response(JSON.stringify({ status: "completed", model: body.model, usage, ...reply }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    const dataDir = mkdtempSync(path.join(TMP, "data-"));
    const child = spawn(process.execPath, ["--import", STUB, SERVER], {
      env: { ...baseEnv, PORT: String(p), TRACELY_DATA_DIR: dataDir, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let exited = false;
    child.on("exit", () => { exited = true; });
    child.stderr.on("data", (d) => { stderr += d; });
    const base = `http://127.0.0.1:${p}`;
    for (let i = 0; i < 200 && !exited; i++) {
      try { if ((await fetch(`${base}/api/status`)).ok && !exited) return { base, child, dataDir }; } catch { /* not up yet */ }
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

const DRAFT = (tag) => `Social media harms teenagers. TAG-${tag}\n\nStudies since 2012 show a rise in anxiety.\n\nSchools should therefore limit phone use.`;
const flow = (tag, opts = {}, body = {}) => call("POST", "/api/flow", { install: `inst-${tag}`, ...opts, body: { text: DRAFT(tag), ...body } });

/* Sets one account's count for today straight in the server's database. */
function seedToday(account, kind, count) {
  const db = new DatabaseSync(path.join(S.dataDir, "tracely.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.prepare("INSERT INTO entitlement_usage (account_id, day, kind, count, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(account_id, day, kind) DO UPDATE SET count = excluded.count").run(account, usageDay(), kind, count, Date.now());
  } finally {
    db.close();
  }
}

test("flow runs the fast model at low effort whatever the request asks for, on every plan", async () => {
  const asks = [["tok-free-pin", "gpt-5-nano", "high"], ["tok-student-pin", "gpt-6-astra", "medium"], ["tok-pro-pin", "gpt-6-astra", "high"], ["tok-pro-pin2", "gpt-5.6-terra", undefined], ["tok-pro-pin3", "junk", "junk"]];
  for (const [token, model, effort] of asks) {
    const tag = `pin-${token}`;
    const r = await flow(tag, { token }, { model, effort });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.modelUsed, LUNA, `${token} asking for ${model}`);
    assert.deepEqual(openaiLog(tag).map((c) => [c.model, c.effort]), [[LUNA, "low"]]);
  }
});

test("one flow call per caller per 120 s: the second is a 429 flow_rate with retryAfter, and never reaches the model", async () => {
  const first = await flow("floor-1", { install: "floor-install" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await flow("floor-2", { install: "floor-install" });
  assert.equal(second.status, 429);
  assert.equal(second.body.error.kind, "flow_rate");
  assert.equal(second.body.error.retryAfter, FLOW_MIN_INTERVAL_MS / 1000);
  assert.equal(openaiLog("floor-2").length, 0);
  const other = await flow("floor-other", { install: "floor-install-other" });
  assert.equal(other.status, 200, "the floor is per caller");
});

test("the floor is keyed on the account, not the install: a signed-in user cannot dodge it by rotating installs", async () => {
  assert.equal((await flow("acct-1", { token: "tok-pro-floor", install: "a1" })).status, 200);
  const r = await flow("acct-2", { token: "tok-pro-floor", install: "a2" });
  assert.equal(r.status, 429);
  assert.equal(r.body.error.kind, "flow_rate");
});

test("a malformed flow request does not use up the caller's interval", async () => {
  const bad = await call("POST", "/api/flow", { install: "floor-bad", body: { text: "" } });
  assert.equal(bad.status, 400);
  assert.equal((await flow("floor-bad-then-good", { install: "floor-bad" })).status, 200);
});

test("the daily flow quota: Free stops at 40, Student and Pro at 150 — a 429 plan_limit that never reaches the model", async () => {
  const cases = [["free", 40], ["student", 150], ["pro", 150]];
  for (const [plan, limit] of cases) {
    seedToday(`user:u-${plan}-fq-under`, "flow", limit - 1);
    const under = await flow(`fq-${plan}-under`, { token: `tok-${plan}-fq-under` });
    assert.equal(under.status, 200, `${plan}: the ${limit}th of the day runs`);

    seedToday(`user:u-${plan}-fq-over`, "flow", limit);
    const over = await flow(`fq-${plan}-over`, { token: `tok-${plan}-fq-over` });
    assert.equal(over.status, 429, `${plan}: the ${limit + 1}th is refused`);
    assert.equal(over.body.error.kind, "plan_limit");
    assert.equal(over.body.error.message, `You've used today's ${limit} flow checks. They reset at midnight.`);
    assert.equal(openaiLog(`fq-${plan}-over`).length, 0);
  }
});

test("a quota refusal does not use up the interval, and an anonymous install is metered like an account", async () => {
  const install = "fq-install";
  const account = `install:${createHash("sha256").update(install).digest("hex").slice(0, 32)}`;
  seedToday(account, "flow", 40);
  const refused = await flow("fq-anon-over", { install });
  assert.equal(refused.body.error?.kind, "plan_limit");
  seedToday(account, "flow", 39);
  const next = await flow("fq-anon-next", { install });
  assert.equal(next.status, 200, "refused by the quota, so the floor was never stamped");
});

test("flow spend is charged to the caller's fair-use total like every other call", async () => {
  const token = "tok-pro-flowspend";
  assert.equal((await flow("spend-flow", { token }, {})).status, 200);
  const db = new DatabaseSync(path.join(S.dataDir, "tracely.db"));
  try {
    const row = db.prepare("SELECT count FROM entitlement_usage WHERE account_id = ? AND day = ? AND kind = 'account_ucents'").get("user:u-pro-flowspend", usageDay());
    assert.equal(row?.count, 220_000, "5,000 in + 1,000 out on luna = 0.22 cents");
  } finally {
    db.close();
  }
});
