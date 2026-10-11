/* Tracer Voice: a spoken conversation with Tracer on OpenAI gpt-live-1.
 *
 * The desktop's renderer makes a WebRTC offer; the server trades it for
 * OpenAI's answer (POST /v1/live/sessions, our key), and media then flows
 * renderer <-> OpenAI directly. The key never leaves the server and the
 * server never sees audio it keeps: it attaches a SIDEBAND WebSocket to the
 * same session only to read `session.usage.updated` (cumulative seconds), to
 * send `session.close` at the cap, and to charge on `session.closed`.
 * An unmetered session is never handed out: no sideband in 5 s, no SDP.
 *
 * Cost policy (server/CLAUDE.md, "Voice"): Pro only when enforced; one live
 * session per caller; TRACELY_VOICE_MAX_SECONDS per session (900) and
 * TRACELY_VOICE_DAILY_SECONDS per account per day (1800, entitlement_usage
 * kind "voice_seconds"); the app pool reserves the session's worst case at
 * start and is charged the real seconds at the end, in integer micro-cents.
 * Voice is NOT added to the account's fair-use total (account_ucents): the
 * daily seconds cap bounds it, and 30 min a day ($1.50) would trip Pro's $8
 * month in about five days and drop a paying account to Free on every
 * feature. The plan check reads the billing plan for the same reason. The
 * price is its own constant here, NOT shared/prices.js or MODEL_TIERS
 * (test/models.test.js pins those).
 *
 * In memory on purpose, like spend.js's reservations: a restart drops every
 * live meter (server/DEPLOY.md). The client hangs up on its own timer anyway.
 *
 * Docs read 2026-10-10 (developers.openai.com/api/docs/guides/voice-webrtc,
 * live-conversations, voice-server-controls, live-delegation; reference
 * resources/live/sideband-websocket). */
import { createHash } from "node:crypto";
import { CheckError } from "./errors.js";
import { usageAdd, usageCount } from "./db.js";
import { SPEND_POOLS, MICRO_CENTS_PER_USD, reserveSpend, poolRoom } from "./spend.js";
import { isDailyQuotaKey } from "./entitlement.js";
import { usageDay, planRank } from "../shared/plan.js";
import { VOICE_PERSONAS, buildInstructions, isVoiceId } from "./voices.js";

export const VOICE_MODEL = "gpt-live-1";
/* $0.05 a minute, billed per second, never rounded up to a minute
 * (developers.openai.com/api/docs/models/gpt-live-1). */
export const VOICE_PRICE_PER_MIN_USD = 0.05;
/* Creating a WebRTC session bills 15 s up front, credited against the
 * session's duration once it runs — so every session costs at least 15 s. */
export const VOICE_MIN_BILLED_SECONDS = 15;
export const VOICE_SECONDS_KIND = "voice_seconds";
export const LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
export const attachUrl = (sessionId) => `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;

export const DEFAULT_MAX_SECONDS = 900;
export const DEFAULT_DAILY_SECONDS = 1800;
export const MAX_SDP_CHARS = 20_000;
export const MAX_CONTEXT_CHARS = 4000;
export const ATTACH_TIMEOUT_MS = 5000;
export const CREATE_TIMEOUT_MS = 15_000;
/* How long the server waits for `session.closed` after sending
 * `session.close` before it finalizes on the last seconds it saw. */
export const CLOSE_WAIT_MS = 10_000;
/* The wall-clock guard fires this long after maxSeconds, in case usage
 * events stop arriving. */
export const CAP_GRACE_SECONDS = 5;

/* What the renderer's data channel may see: captions and lifecycle only.
 * It may send nothing (it hangs up by closing the peer). The reference types
 * allowed_server_events as ServerEventSelector objects, `{ type }`. */
export const ALLOWED_SERVER_EVENTS = Object.freeze([
  "session.started", "session.input_transcript.delta", "session.output_transcript.delta", "session.closed", "error",
]);

/* When GPT-Live asks for backend help ("lemme take a look…") it waits for the
 * result, and with no `delegation` configured (client mode) the result is ours
 * to send. Tracer has no lookup tool, so the sideband answers at once with
 * session.commentary.append, the event for results the model should say aloud.
 * session.thinking.append is only quiet background context: measured live on
 * 2026-10-10 it left the model silent until the cap, while commentary got a
 * spoken answer from the draft within a second (2 of 2 delegations; the model
 * delegated on 3 of 9 calls about "what's weak in my thesis"). */
export const DELEGATION_REPLY =
  "There is no lookup or tool in this conversation, and you already have the student's whole draft in your instructions. Answer the student right now from that draft, in your own voice, in one to three sentences, then ask one question. If something can't be answered from the draft, say so plainly and tell them how they could check it.";

// ── configuration, read per request ──────────────────────────────────────

/** A whole number of seconds from the environment: empty or junk is the
 *  default, an explicit 0 is 0 (the feature off). */
export function envSeconds(raw, fallback) {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : fallback;
}

export function voiceLimits(env = process.env) {
  return {
    maxSeconds: envSeconds(env.TRACELY_VOICE_MAX_SECONDS, DEFAULT_MAX_SECONDS),
    dailySeconds: envSeconds(env.TRACELY_VOICE_DAILY_SECONDS, DEFAULT_DAILY_SECONDS),
  };
}

// ── money ────────────────────────────────────────────────────────────────

const finiteSeconds = (s) => (Number.isFinite(s) && s > 0 ? s : 0);

/** What OpenAI bills for a session that ran `seconds`. */
export function billedSeconds(seconds) {
  return Math.max(VOICE_MIN_BILLED_SECONDS, finiteSeconds(seconds));
}

/** `seconds` of gpt-live-1 in integer micro-cents (60 s = 5,000,000). */
export function voiceCostMicroCents(seconds) {
  return Math.round((finiteSeconds(seconds) * VOICE_PRICE_PER_MIN_USD * MICRO_CENTS_PER_USD) / 60);
}

/** OpenAI-Safety-Identifier: a stable hash of the caller, never the raw id. */
export function safetyIdentifier(callerId) {
  return callerId ? createHash("sha256").update(String(callerId)).digest("hex") : null;
}

// ── the request ──────────────────────────────────────────────────────────

/** The body POSTed to /v1/live/sessions. */
export function buildSessionBody({ voiceId, context, sdp }) {
  return {
    session: {
      model: VOICE_MODEL,
      instructions: buildInstructions(voiceId, context),
      audio: { output: { voice: VOICE_PERSONAS[voiceId].base } },
      // No `delegation` key at all: the API rejects `delegation: null` with
      // 400 invalid_type (measured live 2026-10-10); omitting it is client mode.
      store: false,
      client: { data_channel: { allowed_client_events: [], allowed_server_events: ALLOWED_SERVER_EVENTS.map((type) => ({ type })) } },
    },
    transport: { type: "webrtc", sdp },
  };
}

/** The desktop's body, checked: {sdp, voiceId, context?}. */
export function validateSessionRequest(body) {
  const bad = (m) => new CheckError("bad_request", m);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("A JSON object is required");
  const { sdp, voiceId, context } = body;
  if (typeof sdp !== "string" || !sdp.startsWith("v=0") || sdp.length > MAX_SDP_CHARS) {
    throw bad(`sdp must be an SDP offer (starting "v=0", at most ${MAX_SDP_CHARS} characters)`);
  }
  if (!isVoiceId(voiceId)) throw bad("voiceId must be one of Tracer's voices");
  if (context != null && (typeof context !== "string" || context.length > MAX_CONTEXT_CHARS)) {
    throw bad(`context must be a string of at most ${MAX_CONTEXT_CHARS} characters`);
  }
  return { sdp, voiceId, context: typeof context === "string" ? context : "" };
}

// ── OpenAI ───────────────────────────────────────────────────────────────

/* A 502 the client can show, with a log-safe `reason` (failureLog.js reads
 * it); never the vendor's body text. */
function upstream(reason, message = "Couldn't start the voice conversation. Try again in a moment.") {
  const err = new CheckError("upstream", message, { status: 502 });
  err.reason = reason;
  return err;
}

/** POST /v1/live/sessions → { id, sdp }. `fetchImpl` defaults to the global
 *  fetch AT CALL TIME, so a test's preloaded stub is the one used. */
export async function startLiveSession({ key, body, safetyId, fetchImpl = globalThis.fetch, timeoutMs = CREATE_TIMEOUT_MS }) {
  let res;
  try {
    res = await fetchImpl(LIVE_SESSIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(safetyId ? { "OpenAI-Safety-Identifier": safetyId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw upstream("network");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.error?.code;
    throw upstream(code === "insufficient_quota" ? "out_of_credit" : res.status === 429 ? "rate" : res.status === 401 ? "auth" : "http");
  }
  const id = data?.session?.id;
  const sdp = data?.transport?.sdp;
  if (typeof id !== "string" || !id || typeof sdp !== "string" || !sdp.startsWith("v=0")) throw upstream("bad_answer");
  return { id, sdp };
}

/** Open the sideband: resolves with the open socket, or rejects (502) on an
 *  error, a close or `timeoutMs` without `open`, closing what it opened.
 *  Node's global WebSocket (undici) sends `headers` on the handshake. */
export function attachSideband({ url, key, headers = {}, WebSocketImpl = globalThis.WebSocket, timeoutMs = ATTACH_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let ws = null;
    let settled = false;
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      reject(upstream(reason));
    };
    const timer = setTimeout(() => fail("sideband_timeout"), timeoutMs);
    try {
      ws = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${key}`, ...headers } });
    } catch {
      fail("sideband");
      return;
    }
    ws.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => fail("sideband"));
    ws.addEventListener("close", () => fail("sideband"));
  });
}

// ── live sessions, metered ───────────────────────────────────────────────

const live = new Map();  // caller key -> its one session (starting or open)
const byId = new Map();  // OpenAI session id -> session
const ended = new Map(); // OpenAI session id -> { key, seconds }: /api/voice/end is idempotent
const ENDED_KEEP = 500;
const POOL_SPEND_KIND = "spend_ucents"; // lib/spend.js KIND: the app pool's running total

/* A local (unenforced) server may have no caller id at all; it has one user. */
const callerKeyOf = (gate) => gate?.callerId ?? "local";
const unref = (t) => (t?.unref?.(), t);
const safeReason = (r) => (typeof r === "string" && /^[a-z_]{1,32}$/.test(r) ? r : "unknown");

function busy() {
  return new CheckError("voice_busy", "You already have a voice conversation open. End it before starting another.", { status: 409 });
}

/** Take the caller's one slot, synchronously (no await between check and set). */
function claim(gate, voiceId, maxSeconds) {
  const key = callerKeyOf(gate);
  if (live.has(key)) throw busy();
  const s = {
    key, callerId: gate?.callerId ?? null, enforced: Boolean(gate?.ent?.enforced), voiceId, maxSeconds,
    id: null, ws: null, reattach: null, reattached: false, seconds: 0, startedAt: Date.now(),
    reservation: null, closeSent: false, finalized: false, reason: null, timers: [], waiters: [],
  };
  live.set(key, s);
  return s;
}

function clearTimers(s) {
  for (const t of s.timers.splice(0)) clearTimeout(t);
}

/** A session that never reached the student: free the slot and the hold. */
function abandon(s) {
  s.finalized = true;
  clearTimers(s);
  s.reservation?.release();
  if (live.get(s.key) === s) live.delete(s.key);
}

function chargePool(microCents, at) {
  if (microCents > 0) usageAdd(SPEND_POOLS.app.account, usageDay(at), POOL_SPEND_KIND, microCents);
}

function send(s, message) {
  try { s.ws?.send(JSON.stringify(message)); } catch { /* the close handler finalizes */ }
}

/** Ask OpenAI to end the session; finalize on the last seconds seen if
 *  `session.closed` doesn't follow. */
function sendClose(s) {
  if (s.finalized || s.closeSent) return;
  s.closeSent = true;
  send(s, { type: "session.close" });
  s.timers.push(unref(setTimeout(() => finalize(s, "close_unconfirmed"), CLOSE_WAIT_MS)));
}

/* Charge once, whatever ended it: the app pool in micro-cents and the
 * account's voice seconds for the daily cap, both on what OpenAI bills (at
 * least VOICE_MIN_BILLED_SECONDS). Never account_ucents (see the top). */
function finalize(s, reason) {
  if (s.finalized) return;
  s.finalized = true;
  s.reason = reason;
  clearTimers(s);
  const at = Date.now();
  try {
    if (s.enforced) {
      const billed = billedSeconds(s.seconds);
      const cost = voiceCostMicroCents(billed);
      chargePool(cost, at);
      if (isDailyQuotaKey(s.callerId)) usageAdd(s.callerId, usageDay(at), VOICE_SECONDS_KIND, Math.ceil(billed));
    }
  } catch (e) {
    console.error("[tracely] could not record a voice session's spend:", e?.message);
  } finally {
    s.reservation?.release();
  }
  if (live.get(s.key) === s) live.delete(s.key);
  if (s.id) {
    byId.delete(s.id);
    ended.set(s.id, { key: s.key, seconds: Math.round(s.seconds) });
    if (ended.size > ENDED_KEEP) ended.delete(ended.keys().next().value);
  }
  try { s.ws?.close(); } catch { /* already closed */ }
  console.log(`[tracely] voice session ended reason=${safeReason(reason)} seconds=${Math.round(s.seconds)}`);
  for (const wake of s.waiters.splice(0)) wake();
}

/* Reflected audio (PCM16 at 24 kHz, both directions) is nearly all of the
 * sideband's traffic and is never read, so only frames that can name an
 * event we act on are parsed. */
const WANTED = /"session\.(usage\.updated|closed|delegation\.created)"/;

function onMessage(s, data) {
  if (s.finalized) return;
  const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : null;
  if (!text || !WANTED.test(text)) return;
  let ev;
  try { ev = JSON.parse(text); } catch { return; }
  const seen = finiteSeconds(Number(ev?.usage?.seconds));
  if (ev?.type === "session.usage.updated") {
    // Cumulative: the latest value is the total, never a sum.
    s.seconds = Math.max(s.seconds, seen);
    if (s.seconds >= s.maxSeconds) sendClose(s);
  } else if (ev?.type === "session.closed") {
    s.seconds = Math.max(s.seconds, seen);
    finalize(s, typeof ev.reason === "string" ? ev.reason : "closed");
  } else if (ev?.type === "session.delegation.created" && typeof ev.delegation?.id === "string") {
    send(s, { type: "session.commentary.append", delegation_id: ev.delegation.id, content: DELEGATION_REPLY });
  }
}

function listen(s, ws) {
  s.ws = ws;
  ws.addEventListener("message", (ev) => onMessage(s, ev.data));
  ws.addEventListener("close", () => { if (s.ws === ws) onSidebandClosed(s); });
}

/* The sideband dropped without `session.closed`. Usage is cumulative, so ONE
 * re-attach restores the meter; if that fails too, charge the larger of the
 * seconds seen and the wall-clock time since start, and let go. */
function onSidebandClosed(s) {
  if (s.finalized) return;
  if (s.closeSent || s.reattached || !s.reattach) {
    finalize(s, "sideband_lost");
    return;
  }
  s.reattached = true;
  s.ws = null;
  s.reattach().then(
    (ws) => { if (s.finalized) { try { ws.close(); } catch { /* */ } } else listen(s, ws); },
    () => { s.seconds = Math.max(s.seconds, (Date.now() - s.startedAt) / 1000); finalize(s, "sideband_lost"); },
  );
}

// ── the two routes (server.js wires them; appGate has already run) ───────

let mockSessions = 0;

/**
 * POST /api/voice/session. The order is the policy: feature switch, plan,
 * key, body, one-at-a-time, daily cap, then money held before OpenAI is
 * asked. `readBody` is a thunk so a refusal never needs the body.
 */
export async function startSession({ gate, readBody, mock = false, env = process.env, fetchImpl, WebSocketImpl }) {
  const limits = voiceLimits(env);
  if (limits.maxSeconds <= 0 || limits.dailySeconds <= 0) {
    throw new CheckError("voice_off", "Voice conversations are turned off on this server.", { status: 503 });
  }
  const enforced = Boolean(gate?.ent?.enforced);
  // The billing plan, not effectivePlan: a Pro account over its fair-use
  // limit is still paying for Pro, and voice has its own daily cap.
  if (enforced && planRank(gate.ent.plan) < planRank("pro")) {
    throw new CheckError("plan_limit", "Voice is part of Pro.", { status: 429 });
  }
  const key = String(env.OPENAI_API_KEY ?? "").trim();
  if (!key && !mock) {
    throw new CheckError("no_key", "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env", { status: 503 });
  }
  const request = validateSessionRequest(await readBody());
  const voice = { id: request.voiceId, name: VOICE_PERSONAS[request.voiceId].name };
  if (live.has(callerKeyOf(gate))) throw busy();

  let remainingSeconds = limits.dailySeconds;
  if (enforced && isDailyQuotaKey(gate.callerId)) {
    remainingSeconds = Math.max(0, limits.dailySeconds - usageCount(gate.callerId, usageDay(), VOICE_SECONDS_KIND));
    if (remainingSeconds < VOICE_MIN_BILLED_SECONDS) {
      throw new CheckError("voice_daily", "You've used today's voice time. It resets at midnight.", { status: 429 });
    }
  }
  const maxSeconds = Math.min(limits.maxSeconds, remainingSeconds);
  if (mock) return { mock: true, sessionId: `mock_${++mockSessions}`, voice, maxSeconds, remainingSeconds };

  const s = claim(gate, request.voiceId, maxSeconds);
  let created = false;
  try {
    if (enforced) {
      if (!poolRoom({ pool: "app", env }).room) {
        throw new CheckError("budget", "Voice conversations have hit today's usage limit. They reset at midnight.", { status: 503 });
      }
      s.reservation = reserveSpend("app", voiceCostMicroCents(billedSeconds(maxSeconds)));
    }
    const safetyId = safetyIdentifier(gate?.callerId);
    const { id, sdp } = await startLiveSession({ key, body: buildSessionBody(request), safetyId, fetchImpl });
    created = true;
    // "Include the same connection headers required when creating the session."
    const headers = safetyId ? { "OpenAI-Safety-Identifier": safetyId } : {};
    s.reattach = () => attachSideband({ url: attachUrl(id), key, headers, WebSocketImpl });
    const ws = await s.reattach();
    s.id = id;
    byId.set(id, s);
    listen(s, ws);
    s.timers.push(unref(setTimeout(() => sendClose(s), (maxSeconds + CAP_GRACE_SECONDS) * 1000)));
    return { sdp, sessionId: id, voice, maxSeconds, remainingSeconds };
  } catch (err) {
    // OpenAI billed the 15 s set-up of a session we never handed out: the
    // pool pays it; the student isn't charged for our failure.
    if (created && enforced) chargePool(voiceCostMicroCents(VOICE_MIN_BILLED_SECONDS), Date.now());
    abandon(s);
    throw err;
  }
}

/**
 * POST /api/voice/end → { seconds }. Idempotent: a session already ended
 * answers its seconds again; an id this caller never opened (another
 * caller's, a mock's, one from before a restart) answers 0. Sends
 * `session.close` and waits up to `waitMs` for `session.closed`'s final
 * seconds before charging what it has.
 */
export async function endSession({ gate, body, waitMs = 3000 }) {
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) {
    throw new CheckError("bad_request", "sessionId required");
  }
  const key = callerKeyOf(gate);
  const s = byId.get(sessionId);
  if (!s || s.key !== key) {
    const done = ended.get(sessionId);
    return { seconds: done && done.key === key ? done.seconds : 0 };
  }
  if (!s.finalized) {
    sendClose(s);
    await new Promise((resolve) => {
      const t = setTimeout(resolve, waitMs);
      s.waiters.push(() => { clearTimeout(t); resolve(); });
    });
    finalize(s, "ended_unconfirmed"); // a no-op when session.closed arrived
  }
  return { seconds: Math.round(s.seconds) };
}

/** For tests and /api/status-style introspection: how many sessions are live. */
export function liveSessionCount() {
  return live.size;
}

/** Tests only: forget every session without charging. */
export function _resetVoiceForTests() {
  for (const s of live.values()) abandon(s);
  live.clear();
  byId.clear();
  ended.clear();
  mockSessions = 0;
}
