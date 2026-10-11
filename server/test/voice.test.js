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
  const keyed = V.safetyIdentifier("user:u-abc", "server-secret");
  assert.match(keyed, /^[0-9a-f]{64}$/);
  assert.notEqual(keyed, V.safetyIdentifier("user:u-abc", ""), "keyed: can't be recomputed from the user id alone");
  assert.equal(keyed, V.safetyIdentifier("user:u-abc", "server-secret"), "and stable per caller");
});

test("with TRACELY_SAFETY_ID_SECRET the create and the sideband carry the keyed hash", async () => {
  const env = { ...ENV, TRACELY_SAFETY_ID_SECRET: "server-secret" };
  await start(gateFor("pro", "hmac"), {}, env);
  const want = V.safetyIdentifier("user:u-hmac", "server-secret");
  assert.equal(fetches.at(-1).headers["OpenAI-Safety-Identifier"], want);
  assert.equal(lastWS().opts.headers["OpenAI-Safety-Identifier"], want);
});

test("the session body: gpt-live-1, the persona's voice, nothing stored, captions-only data channel", () => {
  const body = V.buildSessionBody({ voiceId: "hollis", context: "Draft text.", sdp: SDP });
  assert.deepEqual(body, {
    session: {
      model: "gpt-live-1",
      instructions: `${VOICE_BASE_PROMPT}\n\n${VOICE_PERSONAS.hollis.prompt}`,
      input: [{ type: "message", role: "user", content: [{ type: "input_text",
        text: "The student's current draft (for reference; never read it back at length):\n\n<student_draft>\nDraft text.\n</student_draft>" }] }],
      audio: { output: { voice: "delta" } },
      store: false,
      client: { data_channel: { allowed_client_events: [], allowed_server_events: [
        { type: "session.started" }, { type: "session.input_transcript.delta" }, { type: "session.output_transcript.delta" }, { type: "session.closed" }, { type: "error" },
      ] } },
    },
    transport: { type: "webrtc", sdp: SDP },
  });
});

test("no draft, no startup history", () => {
  const body = V.buildSessionBody({ voiceId: "kip", context: "  ", sdp: SDP });
  assert.equal("input" in body.session, false);
  assert.equal(body.session.instructions, `${VOICE_BASE_PROMPT}\n\n${VOICE_PERSONAS.kip.prompt}`);
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
  assert.deepEqual(out, { sdp: "v=0\r\nanswer", sessionId: out.sessionId, voice: { id: "wren", name: "Wren" }, maxSeconds: 900, remainingSeconds: 1800, remainingMonthSeconds: 7200, resetAt: V.dayResetAt() });
  const sent = fetches.at(-1);
  assert.equal(sent.url, "https://api.openai.com/v1/live/sessions");
  assert.equal(sent.headers.Authorization, "Bearer sk-test-not-a-real-key");
  assert.equal(sent.headers["OpenAI-Safety-Identifier"], V.safetyIdentifier("user:u-meter", ""));
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
  assert.equal(usageCount("user:u-meter", today(), "account_ucents"), 0, "voice is not fair-use spend: its own daily cap bounds it");
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

test("safety: the student's words are checked in memory; a high-risk moment steers the model once per call", async () => {
  await start(gateFor("pro", "safe"));
  const ws = lastWS();
  const said = (delta) => ws.emit({ type: "session.input_transcript.delta", delta, start_ms: 0, end_ms: 1 });
  said("So my thesis is that ");
  said("school should start later.");
  ws.emit({ type: "session.output_transcript.delta", delta: "I want to die laughing" }); // the model's words aren't checked
  assert.deepEqual(ws.sent, []);
  said("Honestly I don’t want to ");
  said("live anymore");
  const steer = { type: "session.instructions.append", delegation_id: null, content: V.SAFETY_RULES.find((r) => r.id === "distress").content };
  assert.deepEqual(ws.sent, [steer], "fragments are joined; curly apostrophes are read");
  assert.match(steer.content, /trusted adult/);
  assert.match(steer.content, /988/);
  said("I want to die");
  assert.equal(ws.sent.length, 1, "once per call");
  said(" can we talk about sex");
  assert.deepEqual(ws.types(), ["session.instructions.append", "session.instructions.append"]);
  assert.equal(ws.sent[1].content, V.SAFETY_RULES.find((r) => r.id === "sexual").content);
  ws.emit({ type: "session.closed", reason: "client_hangup", usage: { seconds: 30 } });
});

test("safety: a hard topic in the essay or an idiom isn't a crisis", () => {
  const hits = (text) => V.SAFETY_RULES.filter((r) => r.pattern.test(text)).map((r) => r.id);
  for (const ok of ["it just hit me that my thesis is weak", "beats me why that works", "the character kills himself in act five", "sexism in the workplace", "this paragraph is killing me"]) {
    assert.deepEqual(hits(ok), [], ok);
  }
  for (const [text, id] of [["my stepdad hurts me", "distress"], ["im being abused", "distress"], ["i keep thinking about self harm", "distress"], ["i'm scared to go home", "distress"], ["send nudes", "sexual"]]) {
    assert.deepEqual(hits(text), [id], text);
  }
  assert.equal(V.HEARD_CHARS, 500);
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

test("a Pro account over its fair-use month still gets voice, and voice never adds to fair use", async () => {
  const { usageMonth } = await import("../shared/plan.js");
  const { effectivePlan } = await import("../lib/entitlement.js");
  const gate = gateFor("pro", "fairuse");
  usageAdd("user:u-fairuse", usageMonth(Date.now()), "account_ucents", 8 * 100_000_000); // Pro's $8 month, spent
  assert.equal(effectivePlan(gate.ent, gate.callerId), "free", "the account runs at Free limits elsewhere");
  const out = await start(gate);
  const ws = lastWS();
  const ending = V.endSession({ gate, body: { sessionId: out.sessionId } });
  ws.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 600 } });
  await ending;
  assert.equal(usageCount("user:u-fairuse", usageMonth(Date.now()), "account_ucents"), 8 * 100_000_000, "unchanged by the call");
  assert.equal(usageCount("user:u-fairuse", today(), "voice_seconds"), 600);
});

test("voice switched off is the operator's choice, not a model failure for the failure log", async () => {
  const { isModelFailure } = await import("../lib/failureLog.js");
  const err = await start(gateFor("pro", "off"), {}, { ...ENV, TRACELY_VOICE_MAX_SECONDS: "0" }).catch((e) => e);
  assert.equal(err.kind, "voice_off");
  assert.equal(isModelFailure(err), false);
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

const T0 = Date.parse("2026-10-10T15:00:00Z");

test("a create that may have made a session anyway (timeout, dropped, unreadable 2xx) charges the pool its 15 s set-up; a clean refusal doesn't", async () => {
  const pool = () => usageCount(SPEND_POOLS.app.account, today(), "spend_ucents");
  const tryWith = async (name, fetchImpl) => {
    const before = pool();
    const err = await V.startSession({ gate: gateFor("pro", name), env: ENV, readBody: async () => ({ sdp: SDP, voiceId: "wren" }), fetchImpl, WebSocketImpl: FakeWS }).catch((e) => e);
    assert.equal(err.status, 502, name);
    assert.equal(usageCount(`user:u-${name}`, today(), "voice_seconds"), 0, "never the student");
    assert.equal(reservedMicroCents("app"), 0);
    return pool() - before;
  };
  const fifteen = V.voiceCostMicroCents(15);
  assert.equal(await tryWith("amb-net", async () => { throw new DOMException("timed out", "TimeoutError"); }), fifteen);
  assert.equal(await tryWith("amb-junk", async () => new Response("<html>gateway</html>", { status: 200 })), fifteen);
  assert.equal(await tryWith("amb-half", async () => new Response(JSON.stringify({ session: { id: "live_h" } }), { status: 201 })), fifteen);
  assert.equal(await tryWith("amb-500", async () => new Response("{}", { status: 500 })), 0);
  assert.equal(await tryWith("amb-quota", async () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 })), 0);
  assert.equal(V.liveSessionCount(), 0);
});

test("a dropped sideband re-attaches at once and the meter carries on; a second drop backs off, the slot held throughout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
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
  assert.equal(lastWS(), second, "the second re-attach waits for the backoff");
  await assert.rejects(start(gate), (e) => e.kind === "voice_busy", "no second call beside one that may be live");
  t.mock.timers.tick(V.REATTACH_BACKOFF_MS[0]);
  await tick();
  const third = lastWS();
  assert.notEqual(third, second);
  third.emit({ type: "session.closed", reason: "client_hangup", usage: { seconds: 95 } });
  assert.equal(V.liveSessionCount(), 0);
  assert.equal(usageCount("user:u-drop", today(), "voice_seconds"), 95, "session.closed's real total");
});

test("a sideband that never comes back: retries until the session can't be running, then the cap is billed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const gate = gateFor("pro", "gone");
  await start(gate, {}, { ...ENV, TRACELY_VOICE_MAX_SECONDS: "120" });
  lastWS().emit({ type: "session.usage.updated", usage: { seconds: 40 } });
  FakeWS.mode = "error";
  const before = FakeWS.all.length;
  lastWS().close();
  for (let i = 0; i < 40; i++) { t.mock.timers.tick(5000); await tick(); }
  assert.ok(FakeWS.all.length - before >= 6, "kept trying, backing off");
  assert.ok(FakeWS.all.slice(before).every((ws) => ws.sent.length === 0));
  assert.equal(V.liveSessionCount(), 0, "let go after the deadline (cap + grace + close wait)");
  assert.equal(usageCount("user:u-gone", today(), "voice_seconds"), 120, "the close never went out: the call may have run to its cap");
  assert.equal(reservedMicroCents("app"), 0);
});

test("a close asked for while the sideband is down goes out on the re-attached socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const gate = gateFor("pro", "gap");
  const out = await start(gate);
  FakeWS.mode = "hang";
  lastWS().close(); // the re-attach hangs (up to 5 s)
  const pending = lastWS();
  const ending = V.endSession({ gate, body: { sessionId: out.sessionId }, waitMs: 0 });
  t.mock.timers.tick(1);
  assert.equal((await ending).seconds, 0);
  assert.deepEqual(pending.sent, [], "nothing to send on yet");
  t.mock.timers.tick(5000); // that attach times out; the next one opens
  await tick();
  FakeWS.mode = "open";
  t.mock.timers.tick(V.REATTACH_BACKOFF_MS[0]);
  await tick();
  const next = lastWS();
  assert.notEqual(next, pending);
  assert.deepEqual(next.types(), ["session.close"], "the close went out on the new socket");
  assert.equal(next.closed, false, "and it waits for session.closed");
  t.mock.timers.tick(3000);
  assert.equal(V.liveSessionCount(), 1);
  next.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 66 } });
  assert.equal(V.liveSessionCount(), 0);
  assert.equal(usageCount("user:u-gap", today(), "voice_seconds"), 66);
});

test("a close that went out before the sideband was lost bills to its close wait, not the cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const gate = gateFor("pro", "lostclose");
  const out = await start(gate, {}, { ...ENV, TRACELY_VOICE_MAX_SECONDS: "600" });
  const ws = lastWS();
  t.mock.timers.tick(100_000);
  void V.endSession({ gate, body: { sessionId: out.sessionId }, waitMs: 0 });
  assert.deepEqual(ws.types(), ["session.close"]);
  FakeWS.mode = "error";
  ws.close(); // lost before session.closed; it never comes back
  for (let i = 0; i < 200 && V.liveSessionCount(); i++) { t.mock.timers.tick(5000); await tick(); }
  assert.equal(V.liveSessionCount(), 0);
  assert.equal(usageCount("user:u-lostclose", today(), "voice_seconds"), 100 + V.CLOSE_WAIT_MS / 1000);
});

test("a backstop: a sideband that goes quiet without closing can't hold the slot forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  await start(gateFor("pro", "quiet"), {}, { ...ENV, TRACELY_VOICE_MAX_SECONDS: "60" });
  const ws = lastWS();
  ws.readyState = 3; // CLOSED, but no close event ever arrives
  t.mock.timers.tick((60 + V.CAP_GRACE_SECONDS) * 1000);
  assert.deepEqual(ws.sent, [], "nothing can go out on it");
  assert.equal(V.liveSessionCount(), 1);
  t.mock.timers.tick(2 * V.CLOSE_WAIT_MS);
  assert.equal(V.liveSessionCount(), 0);
  assert.equal(usageCount("user:u-quiet", today(), "voice_seconds"), 60, "no close ever went out: the cap");
  assert.equal(reservedMicroCents("app"), 0);
});

test("usage events that never come: the wall-clock guard closes, and an unconfirmed close bills the wall clock", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const gate = gateFor("pro", "stale");
  await start(gate, {}, { ...ENV, TRACELY_VOICE_MAX_SECONDS: "300" });
  const ws = lastWS();
  ws.emit({ type: "session.usage.updated", usage: { seconds: 10 } }); // then nothing more
  t.mock.timers.tick((300 + V.CAP_GRACE_SECONDS) * 1000);
  assert.deepEqual(ws.types(), ["session.close"]);
  assert.equal(V.liveSessionCount(), 1);
  t.mock.timers.tick(V.CLOSE_WAIT_MS); // no session.closed: close_unconfirmed
  assert.equal(V.liveSessionCount(), 0);
  assert.equal(usageCount("user:u-stale", today(), "voice_seconds"), 300 + V.CAP_GRACE_SECONDS + V.CLOSE_WAIT_MS / 1000, "the wall clock, not the stale 10 s");
});

test("an open call has a voice_open row until it is charged", async () => {
  const { voiceOpenAll } = await import("../lib/db.js");
  const gate = gateFor("pro", "row");
  const out = await start(gate, {}, { ...ENV, TRACELY_VOICE_MAX_SECONDS: "600" });
  const [row] = voiceOpenAll();
  assert.deepEqual({ ...row, created_at: typeof row.created_at }, {
    session_id: out.sessionId, caller_key: "user:u-row", caller_id: "user:u-row", created_at: "number", max_seconds: 600, enforced: 1,
  });
  lastWS().emit({ type: "session.closed", reason: "client_hangup", usage: { seconds: 20 } });
  assert.deepEqual(voiceOpenAll(), []);
});

test("shutdown: every open call is closed and charged, on the wall clock when unconfirmed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const { voiceOpenAll } = await import("../lib/db.js");
  await start(gateFor("pro", "sd-a"));
  const a = lastWS();
  await start(gateFor("pro", "sd-b"));
  const b = lastWS();
  t.mock.timers.tick(60_000);
  const down = V.shutdownVoice({ waitMs: 2000 });
  assert.deepEqual(a.types(), ["session.close"]);
  assert.deepEqual(b.types(), ["session.close"]);
  a.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 58.5 } });
  t.mock.timers.tick(2000); // b never confirms
  assert.deepEqual(await down, { charged: 2, kept: 0 });
  assert.equal(usageCount("user:u-sd-a", today(), "voice_seconds"), 59, "confirmed: the real seconds");
  assert.equal(usageCount("user:u-sd-b", today(), "voice_seconds"), 62, "unconfirmed: the wall clock");
  assert.deepEqual(voiceOpenAll(), []);
  assert.equal(V.liveSessionCount(), 0);
});

test("shutdown with the sideband down keeps the row; the next boot re-attaches and meters the call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const { voiceOpenAll } = await import("../lib/db.js");
  const gate = gateFor("pro", "resume");
  const out = await start(gate);
  FakeWS.mode = "hang";
  lastWS().close();
  const down = V.shutdownVoice({ waitMs: 2000 });
  t.mock.timers.tick(2000);
  assert.deepEqual(await down, { charged: 0, kept: 1 });
  assert.equal(usageCount("user:u-resume", today(), "voice_seconds"), 0, "not charged twice: the next boot charges it");
  assert.equal(voiceOpenAll().length, 1);
  assert.equal(V.liveSessionCount(), 0);
  // The next process (here: the same module, everything in memory dropped).
  FakeWS.mode = "open";
  t.mock.timers.tick(30_000);
  assert.equal(V.resumeOpenSessions({ env: ENV, WebSocketImpl: FakeWS }), 1);
  await tick();
  const ws = lastWS();
  assert.equal(ws.url, V.attachUrl(out.sessionId));
  assert.equal(ws.opts.headers["OpenAI-Safety-Identifier"], V.safetyIdentifier("user:u-resume", ""));
  await assert.rejects(start(gate), (e) => e.kind === "voice_busy", "the slot is claimed again");
  assert.equal(reservedMicroCents("app"), 75_000_000);
  const ending = V.endSession({ gate, body: { sessionId: out.sessionId } });
  assert.deepEqual(ws.types(), ["session.close"], "the resumed call can be ended");
  ws.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 80 } });
  assert.deepEqual(await ending, { seconds: 80 });
  assert.equal(usageCount("user:u-resume", today(), "voice_seconds"), 80);
  assert.deepEqual(voiceOpenAll(), []);
  assert.equal(reservedMicroCents("app"), 0);
});

test("boot: a leftover row already past its deadline is charged its cap at once", async () => {
  const { voiceOpenPut, voiceOpenAll } = await import("../lib/db.js");
  const pool0 = usageCount(SPEND_POOLS.app.account, today(), "spend_ucents");
  voiceOpenPut({ sessionId: "live_old_1", callerKey: "user:u-crashed", callerId: "user:u-crashed", createdAt: Date.now() - 3600_000, maxSeconds: 300, enforced: true });
  const before = FakeWS.all.length;
  assert.equal(V.resumeOpenSessions({ env: ENV, WebSocketImpl: FakeWS }), 1);
  assert.equal(FakeWS.all.length, before, "no attach for a call that can't be running");
  assert.equal(usageCount("user:u-crashed", today(), "voice_seconds"), 300);
  assert.equal(usageCount(SPEND_POOLS.app.account, today(), "spend_ucents") - pool0, V.voiceCostMicroCents(300));
  assert.deepEqual(voiceOpenAll(), []);
  assert.equal(V.liveSessionCount(), 0);
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
  assert.deepEqual(a, { mock: true, sessionId: "mock_1", voice: { id: "kip", name: "Kip" }, maxSeconds: 900, remainingSeconds: 1800, remainingMonthSeconds: 7200, resetAt: V.dayResetAt() });
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
  // No session.closed in time: answer the best estimate, charge nothing yet,
  // and keep the slot; a late session.closed is still read for the real total.
  lastWS().emit({ type: "session.usage.updated", usage: { seconds: 33 } });
  assert.deepEqual(await V.endSession({ gate: gateFor("pro", "owner"), body: { sessionId: out.sessionId }, waitMs: 20 }), { seconds: 33 });
  assert.equal(V.liveSessionCount(), 1, "held until session.closed or the close wait");
  assert.equal(usageCount("user:u-owner", today(), "voice_seconds"), 0);
  lastWS().emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 34.2 } });
  assert.equal(V.liveSessionCount(), 0);
  assert.equal(usageCount("user:u-owner", today(), "voice_seconds"), 35);
  assert.deepEqual(await V.endSession({ gate: gateFor("pro", "owner"), body: { sessionId: out.sessionId } }), { seconds: 34 });
});

// ── the monthly allowance and resetAt (follow-up round, 2026-10-10) ──────

const thisMonth = async () => (await import("../shared/plan.js")).usageMonth(Date.now());

test("env: the monthly allowance defaults to 2 hours; junk is the default; an explicit 0 is NO monthly cap", () => {
  assert.equal(V.DEFAULT_MONTHLY_SECONDS, 7200);
  assert.equal(V.voiceMonthlySeconds({}), 7200);
  for (const junk of ["", "  ", "lots", "-5", "1.5"]) assert.equal(V.voiceMonthlySeconds({ TRACELY_VOICE_MONTHLY_SECONDS: junk }), 7200, junk);
  assert.equal(V.voiceMonthlySeconds({ TRACELY_VOICE_MONTHLY_SECONDS: " 600 " }), 600);
  assert.equal(V.voiceMonthlySeconds({ TRACELY_VOICE_MONTHLY_SECONDS: "0" }), 0);
});

test("resetAt: today's seconds come back at the server's next local midnight, the month's at 00:00 UTC on the 1st", () => {
  const at = new Date(2026, 9, 10, 15, 30).getTime(); // 10 Oct 2026, 15:30 local
  assert.equal(V.dayResetAt(at), new Date(2026, 9, 11).toISOString());
  assert.equal(usageDay(Date.parse(V.dayResetAt(at))), "2026-10-11", "the instant the next usage day starts");
  assert.equal(usageDay(Date.parse(V.dayResetAt(at)) - 1), "2026-10-10");
  assert.equal(V.dayResetAt(new Date(2026, 11, 31, 23, 59).getTime()), new Date(2027, 0, 1).toISOString(), "year end");
  assert.equal(V.monthResetAt(Date.UTC(2026, 9, 10, 12)), "2026-11-01T00:00:00.000Z");
  assert.equal(V.monthResetAt(Date.UTC(2026, 11, 31, 23, 59)), "2027-01-01T00:00:00.000Z");
  assert.equal(V.monthResetAt(Date.UTC(2026, 9, 31, 23, 59, 59)), "2026-11-01T00:00:00.000Z");
});

test("the month: a call is charged to the month row too, capped by what is left, refused under 15 s with resetAt", async () => {
  const month = await thisMonth();
  const pro = gateFor("pro", "monthly");
  const out = await start(pro);
  assert.equal(out.remainingMonthSeconds, 7200);
  assert.equal(out.resetAt, V.dayResetAt());
  const ending = V.endSession({ gate: pro, body: { sessionId: out.sessionId } });
  lastWS().emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 40.2 } });
  await ending;
  assert.equal(usageCount("user:u-monthly", today(), "voice_seconds"), 41, "the day row");
  assert.equal(usageCount("user:u-monthly", month, "voice_seconds"), 41, "and the month row");

  usageAdd("user:u-monthly", month, "voice_seconds", 7200 - 41 - 100); // 100 s left this month
  const capped = await start(pro);
  assert.equal(capped.remainingMonthSeconds, 100);
  assert.equal(capped.maxSeconds, 100, "a call never outlasts the month");
  assert.equal(capped.remainingSeconds, 1800 - 41, "today's is its own figure");
  V._resetVoiceForTests();
  usageAdd("user:u-monthly", month, "voice_seconds", 90); // 10 s left
  const err = await start(pro).catch((e) => e);
  assert.equal(err.kind, "voice_monthly");
  assert.equal(err.status, 429);
  assert.equal(err.message, "You've used this month's voice minutes. They come back on the 1st.");
  assert.equal(err.resetAt, V.monthResetAt());
  assert.equal(V.liveSessionCount(), 0, "nothing claimed");
});

test("voice_daily carries resetAt; the month wins when both are spent; 0 means no monthly cap", async () => {
  const month = await thisMonth();
  const pro = gateFor("pro", "both");
  usageAdd("user:u-both", today(), "voice_seconds", 1795);
  const daily = await start(pro).catch((e) => e);
  assert.equal(daily.kind, "voice_daily");
  assert.equal(daily.resetAt, V.dayResetAt());
  usageAdd("user:u-both", month, "voice_seconds", 7195);
  const monthly = await start(pro).catch((e) => e);
  assert.equal(monthly.kind, "voice_monthly", "the month comes back later, so it is the answer");
  assert.equal(monthly.resetAt, V.monthResetAt());

  const uncapped = { ...ENV, TRACELY_VOICE_MONTHLY_SECONDS: "0" };
  const pro2 = gateFor("pro", "uncapped");
  usageAdd("user:u-uncapped", month, "voice_seconds", 1_000_000);
  const out = await start(pro2, {}, uncapped);
  assert.equal(out.remainingMonthSeconds, null, "no monthly cap: nothing to count down");
  assert.equal(out.maxSeconds, 900);
});

test("a local server: the configured allowances, nothing read from the ledger", () => {
  usageAdd("user:u-local-ledger", today(), "voice_seconds", 1800);
  const a = V.voiceAllowance({ ent: { enforced: false, plan: "free" }, callerId: "user:u-local-ledger" }, {});
  assert.deepEqual(a, { remainingSeconds: 1800, remainingMonthSeconds: 7200, resetAt: V.dayResetAt() });
});

test("eligibility: allowed, with the same numbers a start would get; no fetch, no socket, no hold, no slot", async () => {
  const before = { fetches: fetches.length, sockets: FakeWS.all.length };
  const pro = gateFor("pro", "elig");
  usageAdd("user:u-elig", today(), "voice_seconds", 300);
  usageAdd("user:u-elig", await thisMonth(), "voice_seconds", 6000);
  assert.deepEqual(V.checkEligibility({ gate: pro, env: {} }), {
    allowed: true, maxSeconds: 900, remainingSeconds: 1500, remainingMonthSeconds: 1200, resetAt: V.dayResetAt(),
  }, "no OPENAI_API_KEY needed");
  assert.deepEqual({ fetches: fetches.length, sockets: FakeWS.all.length }, before);
  assert.equal(reservedMicroCents("app"), 0);
  assert.equal(V.liveSessionCount(), 0);
  assert.deepEqual(V.checkEligibility({ gate: LOCAL, env: {} }), { allowed: true, maxSeconds: 900, remainingSeconds: 1800, remainingMonthSeconds: 7200, resetAt: V.dayResetAt() });
});

test("eligibility: each refusal as {allowed:false, reason, message}, resetAt on the two limits", async () => {
  const elig = (gate, env = ENV) => V.checkEligibility({ gate, env });
  for (const plan of ["free", "student"]) {
    assert.deepEqual(elig(gateFor(plan, `e-${plan}`)), { allowed: false, reason: "plan", message: "Voice is part of Pro." });
  }
  for (const off of [{ TRACELY_VOICE_MAX_SECONDS: "0" }, { TRACELY_VOICE_DAILY_SECONDS: "0" }]) {
    assert.deepEqual(elig(gateFor("pro", "e-off"), off), { allowed: false, reason: "off", message: "Voice conversations are turned off on this server." });
  }
  assert.equal(elig(gateFor("free", "e-off2"), { TRACELY_VOICE_MAX_SECONDS: "0" }).reason, "off", "the switch first, like a start");

  const busyGate = gateFor("pro", "e-busy");
  await start(busyGate);
  assert.deepEqual(elig(busyGate), { allowed: false, reason: "busy", message: "You already have a voice conversation open. End it before starting another." });

  usageAdd("user:u-e-day", today(), "voice_seconds", 1790);
  assert.deepEqual(elig(gateFor("pro", "e-day")), { allowed: false, reason: "daily-limit", message: "You've used today's voice time. It resets at midnight.", resetAt: V.dayResetAt() });
  usageAdd("user:u-e-month", await thisMonth(), "voice_seconds", 7190);
  assert.deepEqual(elig(gateFor("pro", "e-month")), { allowed: false, reason: "monthly-limit", message: "You've used this month's voice minutes. They come back on the 1st.", resetAt: V.monthResetAt() });
  const bad = await (async () => { try { V.checkEligibility({ gate: { get ent() { throw new TypeError("boom"); } }, env: ENV }); } catch (e) { return e; } })();
  assert.ok(bad instanceof TypeError, "anything that isn't a voice refusal is still an error");
});

// ── the sideband breaker and the per-caller limit on failed set-ups ──────

test("breaker: 3 sideband attach failures in 60 s → 502 upstream for 120 s with no OpenAI call; then tried again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  FakeWS.mode = "error";
  for (const name of ["br-a", "br-b"]) await assert.rejects(start(gateFor("pro", name)), (e) => e.reason === "sideband");
  t.mock.timers.tick(59_000);
  assert.equal(V.voiceBreakerOpen(), false, "two failures: still closed");
  await assert.rejects(start(gateFor("pro", "br-c")), (e) => e.reason === "sideband");
  assert.equal(V.voiceBreakerOpen(), true, "the third within 60 s opens it");

  FakeWS.mode = "open";
  const before = { fetches: fetches.length, sockets: FakeWS.all.length };
  const err = await start(gateFor("pro", "br-d")).catch((e) => e);
  assert.equal(err.status, 502);
  assert.equal(err.kind, "upstream");
  assert.equal(err.reason, "breaker_open");
  assert.deepEqual({ fetches: fetches.length, sockets: FakeWS.all.length }, before, "OpenAI never asked");
  assert.equal(reservedMicroCents("app"), 0, "nothing held");
  assert.equal(V.liveSessionCount(), 0, "no slot claimed");
  await assert.rejects(start(gateFor("free", "br-e")), (e) => e.kind === "plan_limit", "policy refusals still come first");

  t.mock.timers.tick(V.BREAKER_OPEN_MS - 1); // 120 s from the failure that opened it
  assert.equal(V.voiceBreakerOpen(), true);
  t.mock.timers.tick(1);
  assert.equal(V.voiceBreakerOpen(), false, "closed after 120 s");
  const out = await start(gateFor("pro", "br-d"));
  assert.match(out.sessionId, /^live_/);
});

test("breaker: failures spread over more than 60 s, or a success between them, don't open it; re-attaches don't count", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  FakeWS.mode = "error";
  await assert.rejects(start(gateFor("pro", "sp-a")));
  await assert.rejects(start(gateFor("pro", "sp-b")));
  t.mock.timers.tick(61_000);
  await assert.rejects(start(gateFor("pro", "sp-c")));
  assert.equal(V.voiceBreakerOpen(), false, "the first fell out of the window");
  FakeWS.mode = "open";
  await start(gateFor("pro", "sp-ok"));
  const okWS = lastWS();
  FakeWS.mode = "error";
  await assert.rejects(start(gateFor("pro", "sp-d")));
  assert.equal(V.voiceBreakerOpen(), false, "a success forgets the earlier failures");

  const before = FakeWS.all.length;
  okWS.close(); // the live call's sideband drops and can't come back
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(5000); await tick(); }
  assert.ok(FakeWS.all.length - before >= 3, "it kept re-attaching (and failing)");
  assert.equal(V.voiceBreakerOpen(), false, "a live call's failed re-attaches are its own business");
});

test("per caller: 5 failed set-ups in 10 minutes → 429 rate_limit before OpenAI is asked; others unaffected", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const refused = async () => new Response(JSON.stringify({ error: { code: "invalid_sdp" } }), { status: 400 }); // a clean refusal: no breaker
  const tryWith = (name, fetchImpl = refused) =>
    V.startSession({ gate: gateFor("pro", name), env: ENV, readBody: async () => ({ sdp: SDP, voiceId: "wren" }), fetchImpl, WebSocketImpl: FakeWS });
  let asked = 0;
  const counting = async (...a) => { asked++; return refused(...a); };
  for (let i = 0; i < V.VOICE_FAILED_SETUPS; i++) await assert.rejects(tryWith("lim", counting), (e) => e.status === 502);
  assert.equal(V.voiceBreakerOpen(), false, "a clean refusal is not a sideband failure");
  const err = await tryWith("lim", counting).catch((e) => e);
  assert.equal(err.status, 429);
  assert.equal(err.kind, "rate_limit");
  assert.equal(err.message, "Too many voice calls failed to start. Try again in a few minutes.");
  assert.equal(err.retryAfter, 600);
  assert.equal(asked, V.VOICE_FAILED_SETUPS, "the sixth never reached OpenAI");
  assert.equal(reservedMicroCents("app"), 0);
  await assert.rejects(tryWith("other"), (e) => e.status === 502, "another caller still gets through to OpenAI");
  t.mock.timers.tick(V.VOICE_FAILED_SETUP_WINDOW_MS);
  await assert.rejects(tryWith("lim", counting), (e) => e.status === 502, "the window passed: OpenAI is asked again");
  assert.equal(asked, V.VOICE_FAILED_SETUPS + 1);
  // Refusals before OpenAI is asked (busy, the daily cap) are not failed set-ups.
  const pro = gateFor("pro", "lim-busy");
  const first = await start(pro);
  for (let i = 0; i < 8; i++) await assert.rejects(start(pro), (e) => e.kind === "voice_busy");
  const ending = V.endSession({ gate: pro, body: { sessionId: first.sessionId } });
  lastWS().emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 20 } });
  await ending;
  assert.match((await start(pro)).sessionId, /^live_/, "eight busy refusals counted for nothing");
});
