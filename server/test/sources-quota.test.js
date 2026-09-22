/**
 * Source searches on a hosted server, over real HTTP (decision document §3):
 *   - the extension's /api/sources and the desktop's /api/find-sources draw on
 *     ONE count, per day and per month (SOURCE_LIMITS: Free 5/40, Student
 *     20/100, Pro 40/250), refused with the §7 copy;
 *   - /api/sources runs the fast model with no effort sent, find-sources the
 *     fast model at low, whatever the client asks;
 *   - an IDENTIFIED caller ("user:" / "install:") has a 25-an-hour window of
 *     its own, shared by both routes; the process-wide 15-an-hour counter now
 *     holds only callers with nothing to key on, so identified traffic can no
 *     longer take the hour every anonymous-by-address caller shares.
 * Month counts are seeded straight into the server's database (node:sqlite).
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
import { usageDay, usageMonth, nextMonthStart, monthDayLabel } from "../shared/plan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.js");
const TMP = mkdtempSync(path.join(tmpdir(), "tracely-sources-"));
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
    TRACELY_PAID_DAILY_BUDGET_USD: "20", TRACELY_APP_DAILY_BUDGET_USD: "20", TRACELY_DAILY_BUDGET_USD: "20",
    // So callers with no install id can be told apart by address (X-Forwarded-For).
    TRACELY_TRUSTED_PROXY_HOPS: "1",
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

const sources = (tag, opts = {}, body = {}) =>
  call("POST", "/api/sources", { ...opts, body: { claim: `Screen time causes anxiety in teenagers. TAG-${tag}`, ...body } });
const findSources = (tag, opts = {}, body = {}) =>
  call("POST", "/api/find-sources", { ...opts, body: { claim: `Screen time causes anxiety in teenagers. TAG-${tag}`, ...body } });

/* Sets one account's source-search count for a day ("YYYY-MM-DD") or a month
 * ("YYYY-MM") row straight in the server's database. */
function seed(account, key, count) {
  const db = new DatabaseSync(path.join(S.dataDir, "tracely.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.prepare("INSERT INTO entitlement_usage (account_id, day, kind, count, updated_at) VALUES (?, ?, 'source_search', ?, ?) " +
      "ON CONFLICT(account_id, day, kind) DO UPDATE SET count = excluded.count").run(account, key, count, Date.now());
  } finally {
    db.close();
  }
}

test("/api/sources runs the fast model with no effort sent, find-sources the fast model at low — whatever the client asks", async () => {
  for (const [token, model, effort] of [["tok-pro-model", "gpt-6-astra", "high"], ["tok-free-model", "gpt-5.6-terra", "low"]]) {
    const ext = await sources(`model-ext-${token}`, { token }, { model, effort });
    assert.equal(ext.status, 200, JSON.stringify(ext.body));
    assert.equal(ext.body.modelUsed, LUNA);
    assert.deepEqual(openaiLog(`model-ext-${token}`).map((c) => [c.model, c.effort, c.webSearch]), [[LUNA, null, true]]);
    const app = await findSources(`model-app-${token}`, { token }, { model, effort });
    assert.equal(app.status, 200, JSON.stringify(app.body));
    assert.deepEqual(openaiLog(`model-app-${token}`).map((c) => [c.model, c.effort]), [[LUNA, "low"]]);
  }
});

test("the extension and the desktop share ONE daily source count: Free's 5 across both, then both refuse", async () => {
  const token = "tok-free-shared";
  for (let i = 0; i < 3; i++) assert.equal((await sources(`shared-ext-${i}`, { token })).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await findSources(`shared-app-${i}`, { token })).status, 200);
  const e = await call("GET", "/api/entitlement", { token });
  assert.deepEqual(e.body.usage.sources, { today: 5, month: 5 }, "each search bumps the day row and the month row");
  const message = "You've used today's 5 source searches. They reset at midnight.";
  for (const r of [await findSources("shared-app-over", { token }), await sources("shared-ext-over", { token })]) {
    assert.equal(r.status, 429);
    assert.equal(r.body.error.kind, "plan_limit");
    assert.equal(r.body.error.message, message);
  }
  assert.equal(openaiLog("shared-app-over").length + openaiLog("shared-ext-over").length, 0);
});
