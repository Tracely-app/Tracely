/**
 * lib/voice.js in process: the session body OpenAI gets, the sideband meter,
 * the caps and what a session is charged. No network: fetch and WebSocket are
 * passed in (the route tests, test/voice-routes.test.js, drive the same code
 * over HTTP with preloaded stubs).
 *
 * The database is redirected with TRACELY_DATA_DIR before any import that
 * opens it, like test/spend.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(tmpdir(), "tracely-voice-"));
process.env.TRACELY_DATA_DIR = DIR;
process.on("exit", () => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

const V = await import("../lib/voice.js");
const { VOICE_PERSONAS, VOICE_BASE_PROMPT } = await import("../lib/voices.js");
const { reservedMicroCents, SPEND_POOLS } = await import("../lib/spend.js");
const { usageCount, usageAdd } = await import("../lib/db.js");
const { usageDay } = await import("../shared/plan.js");

/* A WebSocket stand-in: opens (or errors, or hangs) on the next microtask,
 * records what the server sends, and lets a test emit server events. */
class FakeWS extends EventTarget {
  static all = [];
  static mode = "open";
  constructor(url, opts) {
    super();
    Object.assign(this, { url, opts, sent: [], closed: false });
    FakeWS.all.push(this);
    const mode = FakeWS.mode;
    queueMicrotask(() => {
      if (mode === "open") this.dispatchEvent(new Event("open"));
      else if (mode === "error") this.dispatchEvent(new Event("error"));
    });
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { if (this.closed) return; this.closed = true; this.dispatchEvent(new Event("close")); }
  emit(ev) { this.dispatchEvent(new MessageEvent("message", { data: typeof ev === "string" ? ev : JSON.stringify(ev) })); }
  types() { return this.sent.map((m) => m.type); }
}
const lastWS = () => FakeWS.all.at(-1);

const fetches = [];
const fetchOk = async (url, init) => {
  fetches.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ session: { id: `live_${fetches.length}` }, transport: { type: "webrtc", sdp: "v=0\r\nanswer" } }), { status: 201 });
};
const SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
const ENV = { OPENAI_API_KEY: "sk-test-not-a-real-key" };
const gateFor = (plan, name, enforced = true) => ({ ent: { enforced, plan, userId: `u-${name}` }, callerId: `user:u-${name}` });
const LOCAL = { ent: { enforced: false, plan: "free" }, callerId: null };
const start = (gate, extra = {}, env = ENV) =>
  V.startSession({ gate, env, readBody: async () => ({ sdp: SDP, voiceId: "wren", ...extra }), fetchImpl: fetchOk, WebSocketImpl: FakeWS });
const today = () => usageDay(Date.now());
const tick = () => new Promise((r) => setImmediate(r));

test.beforeEach(() => { V._resetVoiceForTests(); FakeWS.mode = "open"; });

test("env: empty or junk is the default, an explicit 0 is off", () => {
  assert.deepEqual(V.voiceLimits({}), { maxSeconds: 900, dailySeconds: 1800 });
  assert.deepEqual(V.voiceLimits({ TRACELY_VOICE_MAX_SECONDS: "", TRACELY_VOICE_DAILY_SECONDS: "lots" }), { maxSeconds: 900, dailySeconds: 1800 });
  assert.deepEqual(V.voiceLimits({ TRACELY_VOICE_MAX_SECONDS: "-5", TRACELY_VOICE_DAILY_SECONDS: "1.5" }), { maxSeconds: 900, dailySeconds: 1800 });
  assert.deepEqual(V.voiceLimits({ TRACELY_VOICE_MAX_SECONDS: " 120 ", TRACELY_VOICE_DAILY_SECONDS: "0" }), { maxSeconds: 120, dailySeconds: 0 });
});

test("money: $0.05 a minute in integer micro-cents, at least the 15 s set-up", () => {
  assert.equal(V.VOICE_PRICE_PER_MIN_USD, 0.05);
  assert.equal(V.voiceCostMicroCents(60), 5_000_000);
  assert.equal(V.voiceCostMicroCents(900), 75_000_000);
  assert.equal(V.voiceCostMicroCents(61.5), 5_125_000);
  assert.equal(V.voiceCostMicroCents(NaN), 0);
  assert.ok(Number.isInteger(V.voiceCostMicroCents(7.3)));
  assert.equal(V.billedSeconds(3), 15);
  assert.equal(V.billedSeconds(42.5), 42.5);
});

test("the safety identifier is a SHA-256 of the caller, never the caller", () => {
  const id = V.safetyIdentifier("user:u-abc");
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.ok(!id.includes("u-abc"));
  assert.equal(V.safetyIdentifier(null), null);
});

test("the session body: gpt-live-1, the persona's voice, nothing stored, captions-only data channel", () => {
  const body = V.buildSessionBody({ voiceId: "hollis", context: "Draft text.", sdp: SDP });
  assert.deepEqual(body, {
    session: {
      model: "gpt-live-1",
      instructions: `${VOICE_BASE_PROMPT}\n\n${VOICE_PERSONAS.hollis.prompt}\n\nThe student's current draft (for reference; never read it back at length):\n\nDraft text.`,
      audio: { output: { voice: "delta" } },
      store: false,
      client: { data_channel: { allowed_client_events: [], allowed_server_events: [
        { type: "session.started" }, { type: "session.input_transcript.delta" }, { type: "session.output_transcript.delta" }, { type: "session.closed" }, { type: "error" },
      ] } },
    },
    transport: { type: "webrtc", sdp: SDP },
  });
});

test("the body is checked: an SDP offer, a known voice, a bounded draft", () => {
  const ok = { sdp: SDP, voiceId: "kip" };
  assert.deepEqual(V.validateSessionRequest(ok), { ...ok, context: "" });
  for (const bad of [null, [], "x", { ...ok, sdp: "hello" }, { ...ok, sdp: 5 }, { ...ok, sdp: "v=0" + "a".repeat(20_000) },
    { ...ok, voiceId: "alloy" }, { ...ok, voiceId: "toString" }, { ...ok, context: 7 }, { ...ok, context: "x".repeat(4001) }]) {
    assert.throws(() => V.validateSessionRequest(bad), (e) => e.kind === "bad_request" && e.status === 400, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.equal(V.validateSessionRequest({ ...ok, context: "x".repeat(4000) }).context.length, 4000);
});

test("attachSideband: the key on the handshake; error, close or timeout is a 502 that closes the socket", async () => {
  const ws = await V.attachSideband({ url: V.attachUrl("live_1"), key: "sk-k", headers: { "OpenAI-Safety-Identifier": "h" }, WebSocketImpl: FakeWS });
  assert.equal(ws.url, "wss://api.openai.com/v1/live/sessions/live_1/attach");
  assert.deepEqual(ws.opts.headers, { Authorization: "Bearer sk-k", "OpenAI-Safety-Identifier": "h" });
  FakeWS.mode = "error";
  await assert.rejects(V.attachSideband({ url: "wss://x", key: "k", WebSocketImpl: FakeWS }), (e) => e.status === 502 && e.kind === "upstream");
  FakeWS.mode = "hang";
  const t0 = Date.now();
  await assert.rejects(V.attachSideband({ url: "wss://x", key: "k", WebSocketImpl: FakeWS, timeoutMs: 40 }), (e) => e.reason === "sideband_timeout");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(lastWS().closed, true, "the hung socket is closed");
  assert.equal(V.ATTACH_TIMEOUT_MS, 5000);
});

test("startLiveSession: what an upstream failure looks like", async () => {
  const answer = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const run = (f) => V.startLiveSession({ key: "k", body: {}, fetchImpl: f });
  await assert.rejects(run(answer(429, { error: { code: "insufficient_quota" } })), (e) => e.status === 502 && e.reason === "out_of_credit");
  await assert.rejects(run(answer(500, {})), (e) => e.status === 502 && e.reason === "http");
  await assert.rejects(run(answer(201, { session: { id: "live_x" } })), (e) => e.reason === "bad_answer");
  await assert.rejects(run(async () => { throw new TypeError("fetch failed"); }), (e) => e.reason === "network");
});

test("a metered session: one per caller, the hold, the cumulative meter, the charge", async () => {
  const gate = gateFor("pro", "meter");
  const out = await start(gate, { context: "My essay." });
  assert.deepEqual(out, { sdp: "v=0\r\nanswer", sessionId: out.sessionId, voice: { id: "wren", name: "Wren" }, maxSeconds: 900, remainingSeconds: 1800 });
  const sent = fetches.at(-1);
  assert.equal(sent.url, "https://api.openai.com/v1/live/sessions");
  assert.equal(sent.headers.Authorization, "Bearer sk-test-not-a-real-key");
  assert.equal(sent.headers["OpenAI-Safety-Identifier"], V.safetyIdentifier("user:u-meter"));
  assert.ok(!JSON.stringify(sent).includes("u-meter"), "the raw caller id never leaves");
  assert.equal(sent.body.session.audio.output.voice, "vesper");
  assert.equal(reservedMicroCents("app"), 75_000_000, "the worst case (900 s) is held while the session is open");
  await assert.rejects(start(gate), (e) => e.status === 409 && e.kind === "voice_busy");

  const ws = lastWS();
  assert.equal(ws.url, V.attachUrl(out.sessionId));
  ws.emit({ type: "session.usage.updated", usage: { seconds: 30 } });
  ws.emit({ type: "session.usage.updated", usage: { seconds: 12 } }); // never backwards
  ws.emit({ type: "session.input_audio.append", audio: "A".repeat(50_000) }); // reflected audio: ignored
  const ending = V.endSession({ gate, body: { sessionId: out.sessionId } });
  await tick();
  assert.deepEqual(ws.types(), ["session.close"]);
  ws.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 60.4 } });
  assert.deepEqual(await ending, { seconds: 60 });
  assert.equal(ws.closed, true);
  assert.equal(reservedMicroCents("app"), 0, "the hold is released");
  assert.equal(usageCount("user:u-meter", today(), "voice_seconds"), 61, "seconds rounded up for the daily cap");
  assert.equal(usageCount("user:u-meter", today(), "account_ucents"), V.voiceCostMicroCents(60.4));
  assert.equal(usageCount(SPEND_POOLS.app.account, today(), "spend_ucents"), V.voiceCostMicroCents(60.4));
  assert.deepEqual(await V.endSession({ gate, body: { sessionId: out.sessionId } }), { seconds: 60 }, "idempotent");
  assert.equal(V.liveSessionCount(), 0);
  await start(gate); // the slot is free again
});

test("the cap: session.close once at maxSeconds, then session.closed finalizes", async () => {
  const gate = gateFor("pro", "cap");
  const out = await start(gate, {}, { ...ENV, TRACELY_VOICE_MAX_SECONDS: "20" });
  assert.equal(out.maxSeconds, 20);
  const ws = lastWS();
  ws.emit({ type: "session.usage.updated", usage: { seconds: 19.5 } });
  assert.deepEqual(ws.types(), []);
  ws.emit({ type: "session.usage.updated", usage: { seconds: 20 } });
  ws.emit({ type: "session.usage.updated", usage: { seconds: 21 } });
  assert.deepEqual(ws.types(), ["session.close"], "sent exactly once");
  ws.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 21.2 } });
  assert.equal(V.liveSessionCount(), 0);
  assert.equal(usageCount("user:u-cap", today(), "voice_seconds"), 22);
});

test("a client-mode delegation is answered aloud (commentary) so the model never waits on a tool", async () => {
  await start(gateFor("pro", "deleg"));
  const ws = lastWS();
  ws.emit({ type: "session.delegation.created", offset_ms: 900, delegation: { id: "item_9", type: "delegation", target: "client" } });
  assert.deepEqual(ws.sent, [{ type: "session.commentary.append", delegation_id: "item_9", content: V.DELEGATION_REPLY }]);
});

test("policy: off switch, Pro only when enforced, the key, the daily cap", async () => {
  const pro = gateFor("pro", "policy");
  await assert.rejects(start(pro, {}, { ...ENV, TRACELY_VOICE_MAX_SECONDS: "0" }), (e) => e.status === 503 && e.kind === "voice_off");
  await assert.rejects(start(pro, {}, { ...ENV, TRACELY_VOICE_DAILY_SECONDS: "0" }), (e) => e.kind === "voice_off");
  for (const plan of ["free", "student"]) {
    await assert.rejects(start(gateFor(plan, `p-${plan}`)), (e) => e.status === 429 && e.kind === "plan_limit" && e.message === "Voice is part of Pro.");
  }
  await assert.rejects(start(pro, {}, {}), (e) => e.status === 503 && e.kind === "no_key");
  let read = false;
  await assert.rejects(V.startSession({ gate: gateFor("free", "nobody"), env: ENV, readBody: async () => { read = true; return {}; } }), (e) => e.kind === "plan_limit");
  assert.equal(read, false, "a refusal never reads the body");

  usageAdd("user:u-policy", today(), "voice_seconds", 1700);
  const capped = await start(pro);
  assert.equal(capped.maxSeconds, 100, "a session never outlasts what is left today");
  assert.equal(capped.remainingSeconds, 100);
  V._resetVoiceForTests();
  usageAdd("user:u-policy", today(), "voice_seconds", 90); // 10 s left: less than the 15 s minimum
  await assert.rejects(start(pro), (e) => e.status === 429 && e.kind === "voice_daily");
});

test("the app pool: no room is a 503 before OpenAI is asked", async () => {
  const before = fetches.length;
  usageAdd(SPEND_POOLS.app.account, today(), "spend_ucents", 20_000); // more than the $0.0001 day below
  await assert.rejects(start(gateFor("pro", "pool"), {}, { ...ENV, TRACELY_APP_DAILY_BUDGET_USD: "0.0001" }), (e) => e.status === 503 && e.kind === "budget");
  assert.equal(fetches.length, before);
  assert.equal(reservedMicroCents("app"), 0);
  assert.equal(V.liveSessionCount(), 0);
});

test("no sideband, no session: a 502 with no SDP, the hold released, the 15 s set-up paid by the pool only", async () => {
  const gate = gateFor("pro", "noattach");
  const pool0 = usageCount(SPEND_POOLS.app.account, today(), "spend_ucents");
  FakeWS.mode = "error";
  await assert.rejects(start(gate), (e) => e.status === 502 && e.kind === "upstream");
  assert.equal(reservedMicroCents("app"), 0);
  assert.equal(V.liveSessionCount(), 0);
  assert.equal(usageCount(SPEND_POOLS.app.account, today(), "spend_ucents") - pool0, V.voiceCostMicroCents(15));
  assert.equal(usageCount("user:u-noattach", today(), "voice_seconds"), 0, "the student isn't charged for our failure");
  assert.equal(usageCount("user:u-noattach", today(), "account_ucents"), 0);
  FakeWS.mode = "open";
  await start(gate); // and can try again
});

test("a dropped sideband re-attaches once; a second loss charges the wall clock and lets go", async () => {
  const gate = gateFor("pro", "drop");
  const out = await start(gate);
  const first = lastWS();
  first.emit({ type: "session.usage.updated", usage: { seconds: 40 } });
  first.close();
  await tick();
  const second = lastWS();
  assert.notEqual(second, first);
  assert.equal(second.url, V.attachUrl(out.sessionId));
  assert.equal(V.liveSessionCount(), 1, "still metered");
  second.emit({ type: "session.usage.updated", usage: { seconds: 70 } });
  second.close();
  await tick();
  assert.equal(V.liveSessionCount(), 0);
  assert.equal(usageCount("user:u-drop", today(), "voice_seconds"), 70);
});

test("a local server (enforcement off): open to every plan, nothing metered", async () => {
  const out = await start(LOCAL);
  assert.equal(out.remainingSeconds, 1800);
  assert.equal(fetches.at(-1).headers["OpenAI-Safety-Identifier"], undefined, "no caller, no identifier");
  assert.equal(reservedMicroCents("app"), 0);
  await assert.rejects(start(LOCAL), (e) => e.kind === "voice_busy");
  const ws = lastWS();
  const ending = V.endSession({ gate: LOCAL, body: { sessionId: out.sessionId } });
  ws.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 5 } });
  assert.deepEqual(await ending, { seconds: 5 });
});

test("mock: the canned answer, no network, no slot taken", async () => {
  const before = fetches.length;
  const a = await V.startSession({ gate: LOCAL, env: {}, mock: true, readBody: async () => ({ sdp: SDP, voiceId: "kip" }) });
  const b = await V.startSession({ gate: LOCAL, env: {}, mock: true, readBody: async () => ({ sdp: SDP, voiceId: "kip" }) });
  assert.deepEqual(a, { mock: true, sessionId: "mock_1", voice: { id: "kip", name: "Kip" }, maxSeconds: 900, remainingSeconds: 1800 });
  assert.equal(b.sessionId, "mock_2");
  assert.equal(fetches.length, before);
  assert.deepEqual(await V.endSession({ gate: LOCAL, body: { sessionId: "mock_1" } }), { seconds: 0 });
});

test("end: unknown ids and other callers' ids answer 0; a missing id is a 400", async () => {
  const out = await start(gateFor("pro", "owner"));
  assert.deepEqual(await V.endSession({ gate: gateFor("pro", "stranger"), body: { sessionId: out.sessionId } }), { seconds: 0 });
  assert.equal(V.liveSessionCount(), 1, "a stranger cannot end it");
  assert.deepEqual(await V.endSession({ gate: LOCAL, body: { sessionId: "live_never" } }), { seconds: 0 });
  await assert.rejects(V.endSession({ gate: LOCAL, body: {} }), (e) => e.status === 400);
  // No session.closed in time: charge what was seen and let go.
  lastWS().emit({ type: "session.usage.updated", usage: { seconds: 33 } });
  assert.deepEqual(await V.endSession({ gate: gateFor("pro", "owner"), body: { sessionId: out.sessionId }, waitMs: 20 }), { seconds: 33 });
  assert.equal(V.liveSessionCount(), 0);
});
