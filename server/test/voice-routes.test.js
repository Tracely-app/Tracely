/**
 * Tracer Voice over HTTP: POST /api/voice/session and /api/voice/end on a
 * real server.js, with OpenAI's create call and the sideband WebSocket
 * stubbed inside the server process (test/helpers/voice-harness.js). The
 * ledger is read straight from the server's SQLite file.
 *
 * Four servers: hosted (fake Supabase, enforcement on), hosted with a 3 s cap
 * and a two-cent app pool, local (no Supabase: open, unmetered) and mock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { voiceHarness, fakeSupabase, bootServer, post, readLog, ledger, seedLedger, until, openVoiceRows } from "./helpers/voice-harness.js";
import { VOICE_BASE_PROMPT, VOICE_PERSONAS } from "../lib/voices.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(HERE, "..", "server.js");
const SERVER_SRC = readFileSync(SERVER_JS, "utf8");
const TMP = mkdtempSync(path.join(tmpdir(), "tracely-voice-routes-"));
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });
// lib/voice.js imports lib/db.js, which opens a database at import time:
// point this process's at the scratch dir, never server/data.
process.env.TRACELY_DATA_DIR = mkdtempSync(path.join(TMP, "self-"));
const { buildSessionBody, voiceCostMicroCents, dayResetAt, monthResetAt } = await import("../lib/voice.js");
const { usageMonth } = await import("../shared/plan.js");
const H = voiceHarness(TMP);
const KEY = "sk-test-not-a-real-key";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const offer = (mode = "ok") => `v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\na=x-test:${mode}\r\n`;
const APP_POOL = "__global_app__";

test("wired: start is an APP route; end spends nothing and is gated by nothing; never the extension's", () => {
  const set = (name) => new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(SERVER_SRC)[1];
  assert.ok(set("APP_AI_ROUTES").includes(`"/api/voice/session"`), "/api/voice/session in APP_AI_ROUTES");
  assert.ok(!set("APP_AI_ROUTES").includes(`"/api/voice/end"`), "/api/voice/end is not behind appGate (budget, limiter)");
  for (const p of ["/api/voice/session", "/api/voice/end"]) {
    assert.ok(!set("EXTENSION_API").includes(`"${p}"`), `${p} not in EXTENSION_API`);
    assert.ok(!set("PAID_ROUTES").includes(`"${p}"`), `${p} not in PAID_ROUTES`);
  }
});

test.describe("hosted (enforcement on)", () => {
  const supabase = fakeSupabase();
  const LOG = H.newLog("hosted");
  let S;
  test.before(async () => {
    await new Promise((r) => supabase.listen(0, "127.0.0.1", r));
    S = await bootServer({ tmp: TMP, stub: H.stub, serverJs: SERVER_JS, env: {
      SUPABASE_URL: `http://127.0.0.1:${supabase.address().port}`, SUPABASE_ANON_KEY: "anon",
      OPENAI_API_KEY: KEY, TRACELY_TEST_VOICE_LOG: LOG, TRACELY_APP_DAILY_BUDGET_USD: "20",
    } });
  });
  test.after(() => { S?.child.kill(); supabase.close(); });
  const start = (token, body) => post(S.base, "/api/voice/session", { token, body: { sdp: offer(), voiceId: "wren", ...body } });

  test("Free and Student: 429 plan_limit, and OpenAI is never asked", async () => {
    for (const plan of ["free", "student"]) {
      const r = await start(`tok-${plan}-pat`);
      assert.equal(r.status, 429, plan);
      assert.deepEqual(r.body.error, { kind: "plan_limit", message: "Voice is part of Pro." });
    }
    assert.equal(readLog(LOG).length, 0);
  });

  test("a bad body is a 400", async () => {
    for (const body of [{ sdp: "hello" }, { voiceId: "alloy" }, { context: "x".repeat(4001) }, { sdp: 42 }]) {
      const r = await start("tok-pro-bad", body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(r.body.error.kind, "bad_request");
    }
  });

  test("Pro: the exact OpenAI request, the answer, one at a time, metered into the ledger", async () => {
    const r = await start("tok-pro-alice", { voiceId: "rory", context: "Thesis: school should start later." });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { sdp: "v=0\r\no=openai answer\r\n", sessionId: r.body.sessionId, voice: { id: "rory", name: "Rory" }, maxSeconds: 900, remainingSeconds: 1800, remainingMonthSeconds: 7200, resetAt: dayResetAt() });
    assert.match(r.body.sessionId, /^live_ok_\d+$/);

    const create = readLog(LOG).find((e) => e.kind === "create");
    assert.equal(create.url, "https://api.openai.com/v1/live/sessions");
    assert.equal(create.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(create.headers["OpenAI-Safety-Identifier"], sha("user:u-pro-alice"), "sha256 of the caller id");
    assert.ok(!JSON.stringify(create).includes("u-pro-alice"), "the raw caller id is never sent");
    assert.deepEqual(create.body, buildSessionBody({ voiceId: "rory", context: "Thesis: school should start later.", sdp: offer() }));
    assert.equal(create.body.session.model, "gpt-live-1");
    assert.equal(create.body.session.audio.output.voice, "willow");
    assert.equal(create.body.session.store, false);
    assert.equal(create.body.session.instructions, `${VOICE_BASE_PROMPT}\n\n${VOICE_PERSONAS.rory.prompt}`, "trusted text only");
    assert.deepEqual(create.body.session.input, [{ type: "message", role: "user", content: [{ type: "input_text",
      text: "The student's current draft (for reference; never read it back at length):\n\n<student_draft>\nThesis: school should start later.\n</student_draft>" }] }],
      "the draft is startup history, never instructions");
    assert.deepEqual(create.body.session.client.data_channel.allowed_client_events, []);
    assert.deepEqual(create.body.session.client.data_channel.allowed_server_events.map((e) => e.type),
      ["session.started", "session.input_transcript.delta", "session.output_transcript.delta", "session.closed", "error"]);

    const attach = await until(() => readLog(LOG).find((e) => e.kind === "attach" && e.sessionId === r.body.sessionId));
    assert.equal(attach.url, `wss://api.openai.com/v1/live/sessions/${r.body.sessionId}/attach`);
    assert.equal(attach.keyed, true, "the sideband carries the key");
    assert.equal(attach.safetyId, sha("user:u-pro-alice"));

    const again = await start("tok-pro-alice");
    assert.equal(again.status, 409);
    assert.equal(again.body.error.kind, "voice_busy");

    // The fake reported 61.5 s; ending sends session.close and reads the final seconds.
    const end = await post(S.base, "/api/voice/end", { token: "tok-pro-alice", body: { sessionId: r.body.sessionId } });
    assert.deepEqual(end, { status: 200, body: { seconds: 62 } });
    assert.ok(readLog(LOG).some((e) => e.kind === "send" && e.sessionId === r.body.sessionId && e.message.type === "session.close"));
    assert.equal(ledger(S.dataDir, "user:u-pro-alice", "voice_seconds"), 62);
    assert.equal(ledger(S.dataDir, "user:u-pro-alice", "account_ucents"), 0, "voice is not fair-use spend (its daily cap bounds it)");
    assert.equal(ledger(S.dataDir, APP_POOL, "spend_ucents"), voiceCostMicroCents(61.5));
    assert.equal(voiceCostMicroCents(61.5), 5_125_000, "61.5 s at $0.05/min");

    assert.deepEqual(await post(S.base, "/api/voice/end", { token: "tok-pro-alice", body: { sessionId: r.body.sessionId } }), { status: 200, body: { seconds: 62 } }, "idempotent");
    assert.equal(ledger(S.dataDir, "user:u-pro-alice", "voice_seconds"), 62, "charged once");
    assert.deepEqual(await post(S.base, "/api/voice/end", { token: "tok-pro-alice", body: { sessionId: "live_unknown_1" } }), { status: 200, body: { seconds: 0 } });
    assert.equal((await post(S.base, "/api/voice/end", { token: "tok-pro-alice", body: {} })).status, 400);

    const next = await start("tok-pro-alice");
    assert.equal(next.status, 200, "the slot is free again");
    assert.equal(next.body.remainingSeconds, 1800 - 62);
    await post(S.base, "/api/voice/end", { token: "tok-pro-alice", body: { sessionId: next.body.sessionId } });
  });

  test("the daily cap: 429 voice_daily when today's seconds are spent", async () => {
    seedLedger(S.dataDir, "user:u-pro-dora", "voice_seconds", 1790);
    const r = await start("tok-pro-dora");
    assert.equal(r.status, 429);
    assert.equal(r.body.error.kind, "voice_daily");
    seedLedger(S.dataDir, "user:u-pro-dora", "voice_seconds", 1500);
    const ok = await start("tok-pro-dora");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.maxSeconds, 300, "never longer than what is left today");
    assert.equal(ok.body.remainingSeconds, 300);
    await post(S.base, "/api/voice/end", { token: "tok-pro-dora", body: { sessionId: ok.body.sessionId } });
  });

  test("a start the desktop gave up on is closed at once, so the retry isn't 409", async () => {
    const ac = new AbortController();
    const aborted = fetch(`${S.base}/api/voice/session`, {
      method: "POST", signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-pro-hal" },
      body: JSON.stringify({ sdp: offer("slow"), voiceId: "kip" }),
    }).catch((e) => e.name);
    setTimeout(() => ac.abort(), 100);
    assert.equal(await aborted, "AbortError");
    const closed = await until(() => readLog(LOG).find((e) => e.kind === "send" && /^live_slow_/.test(e.sessionId) && e.message.type === "session.close"));
    assert.ok(closed, "the orphan call is closed");
    await until(() => ledger(S.dataDir, "user:u-pro-hal", "voice_seconds") > 0);
    const retry = await start("tok-pro-hal");
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    await post(S.base, "/api/voice/end", { token: "tok-pro-hal", body: { sessionId: retry.body.sessionId } });
  });

  test("a stranger can't end someone else's session", async () => {
    const r = await start("tok-pro-erin");
    const stranger = await post(S.base, "/api/voice/end", { token: "tok-pro-fay", body: { sessionId: r.body.sessionId } });
    assert.deepEqual(stranger.body, { seconds: 0 });
    assert.equal((await start("tok-pro-erin")).status, 409, "still open");
    await post(S.base, "/api/voice/end", { token: "tok-pro-erin", body: { sessionId: r.body.sessionId } });
  });
});

/* A 3 s session cap and a $0.02 app pool: one 15 s set-up (1.25 cents) fits,
 * a leaked 1.25-cent hold on top of it would not. */
test.describe("hosted, a 3 s cap and a two-cent pool", () => {
  const supabase = fakeSupabase();
  const LOG = H.newLog("cap");
  let S;
  test.before(async () => {
    await new Promise((r) => supabase.listen(0, "127.0.0.1", r));
    S = await bootServer({ tmp: TMP, stub: H.stub, serverJs: SERVER_JS, env: {
      SUPABASE_URL: `http://127.0.0.1:${supabase.address().port}`, SUPABASE_ANON_KEY: "anon",
      OPENAI_API_KEY: KEY, TRACELY_TEST_VOICE_LOG: LOG, TRACELY_APP_DAILY_BUDGET_USD: "0.02", TRACELY_VOICE_MAX_SECONDS: "3",
    } });
  });
  test.after(() => { S?.child.kill(); supabase.close(); });
  const start = (token, mode) => post(S.base, "/api/voice/session", { token, body: { sdp: offer(mode), voiceId: "atlas" } });

  test("no sideband: 502 upstream, no SDP handed out, the hold released", async () => {
    const r = await start("tok-pro-gus", "nows");
    assert.equal(r.status, 502);
    assert.equal(r.body.error.kind, "upstream");
    assert.equal(r.body.sdp, undefined);
    assert.equal(r.body.sessionId, undefined);
    assert.equal(ledger(S.dataDir, APP_POOL, "spend_ucents"), voiceCostMicroCents(15), "the pool pays OpenAI's 15 s set-up");
    assert.equal(ledger(S.dataDir, "user:u-pro-gus", "voice_seconds"), 0, "the student pays nothing");
    assert.match(S.output(), /model call failed route=\/api\/voice\/session kind=sideband status=502/);
  });

  test("the cap: session.close at maxSeconds, then the charge (at least 15 s); the hold had been released", async () => {
    const r = await start("tok-pro-gus", "ticks"); // would be 503 budget had the failed attempt's hold leaked
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.maxSeconds, 3);
    const close = await until(() => readLog(LOG).find((e) => e.kind === "send" && e.sessionId === r.body.sessionId && e.message.type === "session.close"), 5000);
    assert.equal(close.atSeconds, 3, "sent when the meter reached the cap");
    await until(() => ledger(S.dataDir, "user:u-pro-gus", "voice_seconds") > 0);
    assert.equal(ledger(S.dataDir, "user:u-pro-gus", "voice_seconds"), 15, "billed at least the 15 s set-up");
    assert.equal(ledger(S.dataDir, "user:u-pro-gus", "account_ucents"), 0);
    assert.equal(ledger(S.dataDir, APP_POOL, "spend_ucents"), 2 * voiceCostMicroCents(15));
    assert.equal(readLog(LOG).filter((e) => e.kind === "send" && e.message.type === "session.close").length, 1, "once");
    assert.equal((await start("tok-pro-gus", "ticks")).status, 503, "the pool is spent: a new call is refused");
    const end = await post(S.base, "/api/voice/end", { token: "tok-pro-gus", body: { sessionId: r.body.sessionId } });
    assert.equal(end.status, 200, "but hanging up is never refused for the budget");
  });
});

test.describe("restarts never un-meter a call", () => {
  const supabase = fakeSupabase();
  let LOG; // one per test: every server's stub numbers its sessions from 1
  let env;
  test.before(async () => {
    await new Promise((r) => supabase.listen(0, "127.0.0.1", r));
    env = { SUPABASE_URL: `http://127.0.0.1:${supabase.address().port}`, SUPABASE_ANON_KEY: "anon",
      OPENAI_API_KEY: KEY, TRACELY_APP_DAILY_BUDGET_USD: "20" };
  });
  test.beforeEach((t) => { LOG = H.newLog(`restart-${t.name.slice(0, 12).replace(/\W/g, "_")}`); });
  test.after(() => supabase.close());
  const boot = (dataDir) => bootServer({ tmp: TMP, stub: H.stub, serverJs: SERVER_JS, env: { ...env, TRACELY_TEST_VOICE_LOG: LOG }, dataDir });
  const call = (S, token) => post(S.base, "/api/voice/session", { token, body: { sdp: offer(), voiceId: "wren" } });
  const attached = (id) => readLog(LOG).filter((e) => e.kind === "attach" && e.sessionId === id).length;
  const exitOf = (child) => new Promise((r) => child.once("exit", (code) => r(code)));

  test("SIGTERM (a deploy) closes and charges every open call before the process exits", async () => {
    const S = await boot();
    const r = await call(S, "tok-pro-ivy");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await until(() => attached(r.body.sessionId));
    assert.equal(openVoiceRows(S.dataDir), 1);
    const exited = exitOf(S.child);
    S.child.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.ok(readLog(LOG).some((e) => e.kind === "send" && e.sessionId === r.body.sessionId && e.message.type === "session.close"));
    assert.equal(ledger(S.dataDir, "user:u-pro-ivy", "voice_seconds"), 62);
    assert.equal(openVoiceRows(S.dataDir), 0);
  });

  test("a crash leaves the call's row; the next boot re-attaches and the call is metered and closable again", async () => {
    const A = await boot();
    const r = await call(A, "tok-pro-jo");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await until(() => attached(r.body.sessionId));
    const exited = exitOf(A.child);
    A.child.kill("SIGKILL");
    await exited;
    assert.equal(ledger(A.dataDir, "user:u-pro-jo", "voice_seconds"), 0, "nothing charged by the dead process");
    const B = await boot(A.dataDir);
    try {
      await until(() => attached(r.body.sessionId) === 2);
      assert.match(B.output(), /voice: resuming 1 call/);
      assert.equal((await call(B, "tok-pro-jo")).status, 409, "the slot is claimed again");
      const end = await post(B.base, "/api/voice/end", { token: "tok-pro-jo", body: { sessionId: r.body.sessionId } });
      assert.deepEqual(end, { status: 200, body: { seconds: 62 } });
      assert.equal(ledger(B.dataDir, "user:u-pro-jo", "voice_seconds"), 62);
      assert.equal(openVoiceRows(B.dataDir), 0);
    } finally {
      B.child.kill();
    }
  });
});

test.describe("local (no Supabase): open and unmetered", () => {
  const LOG = H.newLog("local");
  let S;
  test.before(async () => {
    S = await bootServer({ tmp: TMP, stub: H.stub, serverJs: SERVER_JS, env: { OPENAI_API_KEY: KEY, TRACELY_TEST_VOICE_LOG: LOG } });
  });
  test.after(() => S?.child.kill());

  test("any caller gets a session; nothing lands in the ledger", async () => {
    const r = await post(S.base, "/api/voice/session", { body: { sdp: offer(), voiceId: "linden" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.voice.name, "Linden");
    assert.equal(r.body.remainingSeconds, 1800);
    const end = await post(S.base, "/api/voice/end", { body: { sessionId: r.body.sessionId } });
    assert.deepEqual(end.body, { seconds: 62 });
    assert.equal(ledger(S.dataDir, APP_POOL, "spend_ucents"), 0);
  });
});

test.describe("mock (TRACELY_MOCK=1, no key)", () => {
  const LOG = H.newLog("mock");
  let S;
  test.before(async () => {
    S = await bootServer({ tmp: TMP, stub: H.stub, serverJs: SERVER_JS, env: { TRACELY_MOCK: "1", TRACELY_TEST_VOICE_LOG: LOG } });
  });
  test.after(() => S?.child.kill());

  test("the canned answer, no network; a bad body is still a 400", async () => {
    const r = await post(S.base, "/api/voice/session", { body: { sdp: offer(), voiceId: "sterling" } });
    assert.deepEqual(r, { status: 200, body: { mock: true, sessionId: "mock_1", voice: { id: "sterling", name: "Sterling" }, maxSeconds: 900, remainingSeconds: 1800, remainingMonthSeconds: 7200, resetAt: dayResetAt() } });
    assert.deepEqual((await post(S.base, "/api/voice/end", { body: { sessionId: "mock_1" } })).body, { seconds: 0 });
    assert.equal((await post(S.base, "/api/voice/session", { body: { sdp: "nope", voiceId: "sterling" } })).status, 400);
    assert.equal(readLog(LOG).length, 0, "OpenAI never called");
  });
});

/* Follow-up round (2026-10-10): POST /api/voice/eligibility, the monthly
 * allowance and resetAt, over HTTP. */
test("wired: eligibility is an APP route (appGate), never the extension's", () => {
  const set = (name) => new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(SERVER_SRC)[1];
  assert.ok(set("APP_AI_ROUTES").includes(`"/api/voice/eligibility"`));
  assert.ok(!set("EXTENSION_API").includes(`"/api/voice/eligibility"`));
  assert.ok(!set("PAID_ROUTES").includes(`"/api/voice/eligibility"`));
});

test.describe("eligibility and the allowance (hosted)", () => {
  const supabase = fakeSupabase();
  const LOG = H.newLog("eligibility");
  let S;
  test.before(async () => {
    await new Promise((r) => supabase.listen(0, "127.0.0.1", r));
    S = await bootServer({ tmp: TMP, stub: H.stub, serverJs: SERVER_JS, env: {
      SUPABASE_URL: `http://127.0.0.1:${supabase.address().port}`, SUPABASE_ANON_KEY: "anon",
      OPENAI_API_KEY: KEY, TRACELY_TEST_VOICE_LOG: LOG, TRACELY_APP_DAILY_BUDGET_USD: "20",
    } });
  });
  test.after(() => { S?.child.kill(); supabase.close(); });
  const elig = (token, body = {}) => post(S.base, "/api/voice/eligibility", { token, body });
  const month = () => usageMonth(Date.now());

  test("Pro: allowed with the numbers; Free: plan; nothing reaches OpenAI, nothing is held", async () => {
    assert.deepEqual(await elig("tok-pro-ella"), { status: 200, body: { allowed: true, maxSeconds: 900, remainingSeconds: 1800, remainingMonthSeconds: 7200, resetAt: dayResetAt() } });
    assert.deepEqual(await elig("tok-free-finn"), { status: 200, body: { allowed: false, reason: "plan", message: "Voice is part of Pro." } });
    const raw = await fetch(`${S.base}/api/voice/eligibility`, { method: "POST", headers: { Authorization: "Bearer tok-pro-ella" } });
    assert.equal(raw.status, 200, "an empty body is fine");
    assert.equal((await raw.json()).allowed, true);
    assert.equal(readLog(LOG).length, 0, "no create, no attach");
    assert.equal(ledger(S.dataDir, APP_POOL, "spend_ucents"), 0);
  });

  test("busy while a call is open; daily and monthly limits answer resetAt", async () => {
    const r = await post(S.base, "/api/voice/session", { token: "tok-pro-gwen", body: { sdp: offer(), voiceId: "kip" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.remainingMonthSeconds, 7200);
    assert.equal(r.body.resetAt, dayResetAt());
    assert.equal((await elig("tok-pro-gwen")).body.reason, "busy");
    await post(S.base, "/api/voice/end", { token: "tok-pro-gwen", body: { sessionId: r.body.sessionId } });
    assert.equal(ledger(S.dataDir, "user:u-pro-gwen", "voice_seconds", month()), 62, "the month row is charged too");
    assert.equal((await elig("tok-pro-gwen")).body.remainingMonthSeconds, 7200 - 62);

    seedLedger(S.dataDir, "user:u-pro-hana", "voice_seconds", 1795);
    assert.deepEqual((await elig("tok-pro-hana")).body, { allowed: false, reason: "daily-limit", message: "You've used today's voice time. It resets at midnight.", resetAt: dayResetAt() });
    const daily = await post(S.base, "/api/voice/session", { token: "tok-pro-hana", body: { sdp: offer(), voiceId: "kip" } });
    assert.deepEqual(daily, { status: 429, body: { error: { kind: "voice_daily", message: "You've used today's voice time. It resets at midnight.", resetAt: dayResetAt() } } });

    seedLedger(S.dataDir, "user:u-pro-iris", "voice_seconds", 7200, month());
    assert.equal((await elig("tok-pro-iris")).body.reason, "monthly-limit");
    const monthly = await post(S.base, "/api/voice/session", { token: "tok-pro-iris", body: { sdp: offer(), voiceId: "kip" } });
    assert.deepEqual(monthly, { status: 429, body: { error: { kind: "voice_monthly", message: "You've used this month's voice minutes. They come back on the 1st.", resetAt: monthResetAt() } } });
    assert.equal(readLog(LOG).filter((e) => e.kind === "create").length, 1, "only gwen's call reached OpenAI");
  });
});

test.describe("eligibility in mock (TRACELY_MOCK=1, no key)", () => {
  const LOG = H.newLog("mock-eligibility");
  let S;
  test.before(async () => {
    S = await bootServer({ tmp: TMP, stub: H.stub, serverJs: SERVER_JS, env: { TRACELY_MOCK: "1", TRACELY_TEST_VOICE_LOG: LOG, TRACELY_VOICE_MONTHLY_SECONDS: "0" } });
  });
  test.after(() => S?.child.kill());

  test("allowed with no key and no network; no monthly cap is null", async () => {
    assert.deepEqual(await post(S.base, "/api/voice/eligibility", { body: {} }),
      { status: 200, body: { allowed: true, maxSeconds: 900, remainingSeconds: 1800, remainingMonthSeconds: null, resetAt: dayResetAt() } });
    const r = await post(S.base, "/api/voice/session", { body: { sdp: offer(), voiceId: "hollis" } });
    assert.equal(r.body.mock, true);
    assert.equal(r.body.remainingMonthSeconds, null);
    assert.equal(r.body.resetAt, dayResetAt());
    assert.equal(readLog(LOG).length, 0, "OpenAI never called");
  });
});
