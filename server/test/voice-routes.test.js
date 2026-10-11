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

import { voiceHarness, fakeSupabase, bootServer, post, readLog, ledger, seedLedger, until } from "./helpers/voice-harness.js";
import { VOICE_BASE_PROMPT, VOICE_PERSONAS } from "../lib/voices.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(HERE, "..", "server.js");
const SERVER_SRC = readFileSync(SERVER_JS, "utf8");
const TMP = mkdtempSync(path.join(tmpdir(), "tracely-voice-routes-"));
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });
// lib/voice.js imports lib/db.js, which opens a database at import time:
// point this process's at the scratch dir, never server/data.
process.env.TRACELY_DATA_DIR = mkdtempSync(path.join(TMP, "self-"));
const { buildSessionBody, voiceCostMicroCents } = await import("../lib/voice.js");
const H = voiceHarness(TMP);
const KEY = "sk-test-not-a-real-key";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const offer = (mode = "ok") => `v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\na=x-test:${mode}\r\n`;
const APP_POOL = "__global_app__";

test("wired: both routes are APP routes, never the extension's", () => {
  const set = (name) => new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(SERVER_SRC)[1];
  for (const p of ["/api/voice/session", "/api/voice/end"]) {
    assert.ok(set("APP_AI_ROUTES").includes(`"${p}"`), `${p} in APP_AI_ROUTES`);
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
    assert.deepEqual(r.body, { sdp: "v=0\r\no=openai answer\r\n", sessionId: r.body.sessionId, voice: { id: "rory", name: "Rory" }, maxSeconds: 900, remainingSeconds: 1800 });
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
    assert.equal(create.body.session.instructions,
      `${VOICE_BASE_PROMPT}\n\n${VOICE_PERSONAS.rory.prompt}\n\nThe student's current draft (for reference; never read it back at length):\n\nThesis: school should start later.`);
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
    const end = await post(S.base, "/api/voice/end", { token: "tok-pro-gus", body: { sessionId: r.body.sessionId } });
    assert.equal(end.status, 503, "the pool is spent: appGate refuses every app route, end included");
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
    assert.deepEqual(r, { status: 200, body: { mock: true, sessionId: "mock_1", voice: { id: "sterling", name: "Sterling" }, maxSeconds: 900, remainingSeconds: 1800 } });
    assert.deepEqual((await post(S.base, "/api/voice/end", { body: { sessionId: "mock_1" } })).body, { seconds: 0 });
    assert.equal((await post(S.base, "/api/voice/session", { body: { sdp: "nope", voiceId: "sterling" } })).status, 400);
    assert.equal(readLog(LOG).length, 0, "OpenAI never called");
  });
});
