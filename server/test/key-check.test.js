/**
 * /api/status `keyCheck`: does OpenAI ACCEPT the key, not only is one set.
 *
 * On 2026-10-13 production answered `hasKey: true` and healthcheck.sh said
 * healthy while every model call answered 503 no_key ("OpenAI rejected the
 * API key."). Pinned here:
 *   - the probe is GET /v1/models (no tokens): 200 accepted, 401 rejected,
 *     anything else — and a restricted key's "missing scopes" 401 — unknown;
 *   - it runs only when asked (?keyCheck=1), at most once a minute per key,
 *     and a plain /api/status — the extension's 1.5 s probe — never waits on it;
 *   - every real call records the key accepted or rejected, for free;
 *   - the field is additive: absent until something has tried the key, and
 *     every field /api/status already had is still there.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { keyStatus, structuredCall } from "../lib/llm.js";

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const REJECTED = { error: { message: "Incorrect API key provided: sk-tes*****. You can find your API key at https://platform.openai.com/account/api-keys.", type: "invalid_request_error", code: "invalid_api_key" } };
const SCOPED = { error: { message: "You have insufficient permissions for this operation. Missing scopes: api.model.read.", type: "invalid_request_error", code: null } };
const SCHEMA = { type: "object", properties: { ok: { type: "string" } }, required: ["ok"], additionalProperties: false };

/** Answers every fetch with `answer(url, init)` → [status, json] (or throws), and logs the request. */
function stubFetch(answer) {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), method: init.method ?? "GET", body: init.body, auth: init.headers?.Authorization });
    const [status, json] = await answer(String(url), init);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return sent;
}
const useKey = (k) => { process.env.OPENAI_API_KEY = k; };

test("nothing is known, and nothing is sent, until a call or a probe tries the key", async () => {
  useKey("sk-unit-untried");
  const sent = stubFetch(() => [200, { data: [] }]);
  assert.equal(await keyStatus(), null);
  assert.equal(sent.length, 0, "a plain keyStatus() never reaches the provider");
});

test("the probe is a GET to /v1/models with the key and no body; a 200 is accepted", async () => {
  useKey("sk-unit-good");
  const sent = stubFetch(() => [200, { object: "list", data: [] }]);
  const k = await keyStatus({ probe: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.openai.com/v1/models");
  assert.equal(sent[0].method, "GET");
  assert.equal(sent[0].body, undefined, "no model runs, so no tokens");
  assert.equal(sent[0].auth, "Bearer sk-unit-good");
  assert.equal(k.valid, true);
  assert.equal(k.by, "probe");
  assert.ok(!("status" in k), "an accepted key carries no status");
  assert.ok(Number.isFinite(Date.parse(k.checkedAt)));
});

test("a 401 is a rejected key; a restricted key's missing-scope 401, a 5xx and no answer cannot tell", async () => {
  useKey("sk-unit-revoked");
  stubFetch(() => [401, REJECTED]);
  assert.deepEqual(pick(await keyStatus({ probe: true })), { valid: false, by: "probe", status: 401 });

  useKey("sk-unit-restricted");
  stubFetch(() => [401, SCOPED]);
  assert.deepEqual(pick(await keyStatus({ probe: true })), { valid: null, by: "probe", status: 401 });

  useKey("sk-unit-openai-down");
  stubFetch(() => [503, { error: { message: "The server is overloaded" } }]);
  assert.deepEqual(pick(await keyStatus({ probe: true })), { valid: null, by: "probe", status: 503 });

  useKey("sk-unit-no-answer");
  stubFetch(() => { throw new TypeError("fetch failed"); });
  assert.deepEqual(pick(await keyStatus({ probe: true })), { valid: null, by: "probe" });
});
const pick = ({ valid, by, status }) => ({ valid, by, ...(status !== undefined ? { status } : {}) });

test("one probe a minute per key, however many ask at once; a new key is probed at once", async () => {
  useKey("sk-unit-rate-a");
  let release;
  const gate = new Promise((r) => { release = r; });
  const sent = stubFetch(async () => { await gate; return [200, { data: [] }]; });
  const both = Promise.all([keyStatus({ probe: true }), keyStatus({ probe: true })]);
  release();
  const [a, b] = await both;
  assert.equal(sent.length, 1, "two askers share one probe");
  assert.equal(a.valid, true);
  assert.deepEqual(a, b);
  assert.deepEqual(await keyStatus({ probe: true }), a, "within the minute: the last verdict, no new probe");
  assert.equal(sent.length, 1);

  useKey("sk-unit-rate-b");
  assert.equal(await keyStatus(), null, "a verdict belongs to the key it judged");
  await keyStatus({ probe: true });
  assert.equal(sent.length, 2, "a replaced key is probed without waiting out the minute");
  assert.equal(sent[1].auth, "Bearer sk-unit-rate-b");
});

test("every real call records the key: a 401 rejected, an answer accepted, anything else unchanged", async () => {
  useKey("sk-unit-calls");
  stubFetch(() => [401, REJECTED]);
  await assert.rejects(structuredCall({ system: "s", user: "u", schema: SCHEMA, maxTokens: 10, what: "test" }),
    (e) => e.kind === "no_key" && e.message === "OpenAI rejected the API key.");
  assert.deepEqual(pick(await keyStatus()), { valid: false, by: "call" });

  stubFetch(() => [500, { error: { message: "boom" } }]);
  await assert.rejects(structuredCall({ system: "s", user: "u", schema: SCHEMA, maxTokens: 10, what: "test" }), (e) => e.kind === "server");
  assert.equal((await keyStatus()).valid, false, "a 5xx says nothing about the key");

  stubFetch(() => [200, { status: "completed", model: "gpt-5.6-luna", output_text: '{"ok":"yes"}', usage: { input_tokens: 1, output_tokens: 1 } }]);
  await structuredCall({ system: "s", user: "u", schema: SCHEMA, maxTokens: 10, what: "test" });
  assert.deepEqual(pick(await keyStatus()), { valid: true, by: "call" });
});

/* ── over HTTP: a real server, OpenAI stubbed in its process ──────────────── */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server.js");
const TMP = mkdtempSync(path.join(tmpdir(), "tracely-keycheck-"));
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

/* This key is revoked: /v1/responses and /v1/models both answer 401, and the
 * probe takes TRACELY_TEST_PROBE_DELAY_MS to answer. Every probe is logged.
 * Written to a temp dir, because anything under test/ is run as a test. */
const PROBE_LOG = path.join(TMP, "probes.log");
const STUB = path.join(TMP, "openai-401.mjs");
writeFileSync(PROBE_LOG, "");
writeFileSync(STUB, `
import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
const REJECTED = ${JSON.stringify(REJECTED)};
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith("https://api.openai.com/")) return real(url, init);
  if (String(url) === "https://api.openai.com/v1/models") {
    appendFileSync(process.env.TRACELY_TEST_PROBE_LOG, "probe\\n");
    await new Promise((r) => setTimeout(r, Number(process.env.TRACELY_TEST_PROBE_DELAY_MS || 0)));
  }
  return new Response(JSON.stringify(REJECTED), { status: 401, headers: { "Content-Type": "application/json" } });
};
`);
const probes = () => readFileSync(PROBE_LOG, "utf8").split("\n").filter(Boolean).length;

const SCRUB = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "OPENAI_API_KEY", "TRACELY_MOCK", "TRACELY_LLM_PROVIDER", "TRACELY_BETA_TOKENS", "TRACELY_DEMO_SECRET"];
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
    const child = spawn(process.execPath, ["--import", pathToFileURL(STUB).href, SERVER], {
      env: { ...baseEnv, PORT: String(p), TRACELY_DATA_DIR: mkdtempSync(path.join(TMP, "data-")), TRACELY_TEST_PROBE_LOG: PROBE_LOG, ...env },
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
const PROBE_DELAY_MS = 1500;
let REVOKED, MOCKED;
test.before(async () => {
  [REVOKED, MOCKED] = await Promise.all([
    boot({ OPENAI_API_KEY: "sk-test-revoked", TRACELY_TEST_PROBE_DELAY_MS: String(PROBE_DELAY_MS) }),
    boot({ OPENAI_API_KEY: "sk-test-revoked", TRACELY_MOCK: "1" }),
  ]);
});
test.after(() => { REVOKED?.child.kill(); MOCKED?.child.kill(); });
const get = (srv, p) => realFetch(`${srv.base}${p}`).then((r) => r.json());

test("a revoked key: hasKey says true, keyCheck says false — first from a real call, then from the probe", async () => {
  const before = await get(REVOKED, "/api/status");
  assert.equal(before.hasKey, true);
  assert.ok(!("keyCheck" in before), "absent until something has tried the key");
  for (const f of ["hasKey", "mock", "docsBridge", "budget", "paidBudget"]) assert.ok(f in before, `/api/status lost ${f}`);
  assert.equal(probes(), 0, "a plain /api/status never probes");

  // The 2026-10-13 outage, as a user saw it.
  const text = "Water boils at 100 degrees Celsius at sea level.";
  const r = await realFetch(`${REVOKED.base}/api/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, sentences: [{ id: "s1", text }] }) });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.kind, "no_key");
  const afterCall = (await get(REVOKED, "/api/status")).keyCheck;
  assert.equal(afterCall.valid, false);
  assert.equal(afterCall.by, "call");
  assert.equal(probes(), 0);

  // ?keyCheck=1 probes; the extension's plain probe, meanwhile, does not wait.
  const asked = get(REVOKED, "/api/status?keyCheck=1");
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  const plain = await get(REVOKED, "/api/status");
  assert.ok(Date.now() - t0 < PROBE_DELAY_MS - 500, `a plain /api/status waited ${Date.now() - t0} ms on the probe`);
  assert.equal(plain.keyCheck.by, "call", "the plain answer is the verdict so far");
  const probed = (await asked).keyCheck;
  assert.deepEqual({ valid: probed.valid, by: probed.by, status: probed.status }, { valid: false, by: "probe", status: 401 });
  assert.equal(probes(), 1);

  assert.equal((await get(REVOKED, "/api/status?keyCheck=1")).keyCheck.checkedAt, probed.checkedAt, "asked again within the minute: the same verdict");
  assert.equal(probes(), 1, "and no second probe");
});

test("a mock server never probes and reports no keyCheck", async () => {
  const before = probes();
  const s = await get(MOCKED, "/api/status?keyCheck=1");
  assert.equal(s.mock, true);
  assert.ok(!("keyCheck" in s));
  assert.equal(probes(), before);
});
