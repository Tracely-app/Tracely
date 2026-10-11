/* Tracer Voice: a spoken conversation with Tracer on OpenAI gpt-live-1.
 *
 * The desktop's renderer makes a WebRTC offer; the server trades it for
 * OpenAI's answer (POST /v1/live/sessions, our key), and media then flows
 * renderer <-> OpenAI directly. The key never leaves the server and the
 * server never sees audio it keeps: it attaches a SIDEBAND WebSocket to the
 * same session only to read `session.usage.updated` (cumulative seconds), to
 * send `session.close` at the cap, and to charge on `session.closed`.
 * An unmetered session is never handed out: no sideband in 5 s, no SDP. A
 * sideband lost later is re-attached until the session can no longer be
 * running, and an end that `session.closed` never confirmed bills the wall
 * clock (or the cap, when the close could not be delivered at all).
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
 * The meter lives in memory, but a restart can't un-meter a call: SIGTERM
 * closes and charges every open call (shutdownVoice), and each call handed
 * out has a voice_open row until it is charged, which the next boot resumes
 * after a crash (resumeOpenSessions; server/DEPLOY.md).
 *
 * Docs read 2026-10-10 (developers.openai.com/api/docs/guides/voice-webrtc,
 * live-conversations, voice-server-controls, live-delegation; reference
 * resources/live/sideband-websocket). */
import { createHash, createHmac } from "node:crypto";
import { CheckError } from "./errors.js";
import { usageAdd, usageCount, voiceOpenPut, voiceOpenDelete, voiceOpenAll } from "./db.js";
import { SPEND_POOLS, MICRO_CENTS_PER_USD, reserveSpend, poolRoom } from "./spend.js";
import { isDailyQuotaKey } from "./entitlement.js";
import { rollingCounter, keyedRateLimiter } from "../shared/guards.js";
import { usageDay, usageMonth, planRank } from "../shared/plan.js";
import { VOICE_PERSONAS, buildInstructions, draftInput, isVoiceId } from "./voices.js";

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
/* 2 hours a month (about $6 at the price above): a PLACEHOLDER until Sam
 * prices voice (server/BILLING.md). Without it a Pro account could talk the
 * daily 30 min every day, about $46 a month. */
export const DEFAULT_MONTHLY_SECONDS = 7200;
/* The sideband closes a call when neither side has said anything for this
 * long (no transcript delta either way): a forgotten or muted window would
 * otherwise bill to the cap. */
export const DEFAULT_IDLE_SECONDS = 180;
export const MAX_SDP_CHARS = 20_000;
export const MAX_CONTEXT_CHARS = 4000;
export const ATTACH_TIMEOUT_MS = 5000;
export const CREATE_TIMEOUT_MS = 15_000;
/* How long the server waits for `session.closed` after sending
 * `session.close` before it finalizes on the wall clock. */
export const CLOSE_WAIT_MS = 10_000;
/* The wall-clock guard sends `session.close` this long after maxSeconds:
 * usage events arrive only around the close, so it is the real cap. */
export const CAP_GRACE_SECONDS = 5;
/* After a lost sideband: one re-attach at once, then these waits between
 * tries, the last repeating, until the session's deadline. */
export const REATTACH_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);

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

/** TRACELY_VOICE_MONTHLY_SECONDS per account per usage month. Same rule as
 *  the others for empty or junk (the default), but an explicit 0 means NO
 *  monthly cap — unlike the daily and per-call variables, where 0 is voice
 *  off. */
export function voiceMonthlySeconds(env = process.env) {
  return envSeconds(env.TRACELY_VOICE_MONTHLY_SECONDS, DEFAULT_MONTHLY_SECONDS);
}

/** TRACELY_VOICE_IDLE_SECONDS: silence on both sides before the server
 *  closes a call. Empty or junk is the default; an explicit 0 turns the idle
 *  close off (the per-call cap still bounds every call). */
export function voiceIdleSeconds(env = process.env) {
  return envSeconds(env.TRACELY_VOICE_IDLE_SECONDS, DEFAULT_IDLE_SECONDS);
}

// ── when allowances come back ─────────────────────────────────────────────

/** When today's voice seconds reset, as ISO-8601: the next usage-day
 *  boundary, i.e. the server's local midnight (shared/plan.js usageDay). */
export function dayResetAt(at = Date.now()) {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
}

/** When this month's voice seconds reset, as ISO-8601: 00:00 UTC on the 1st
 *  of next month (shared/plan.js usageMonth is a UTC month). */
export function monthResetAt(at = Date.now()) {
  const d = new Date(at);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
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

/** OpenAI-Safety-Identifier: a stable hash of the caller, never the raw id.
 *  Keyed with TRACELY_SAFETY_ID_SECRET when the server has one, so nobody
 *  holding a user id can recompute it; plain SHA-256 otherwise. Stable per
 *  caller either way (OpenAI ties abuse reports to it): set the secret once. */
export function safetyIdentifier(callerId, secret = process.env.TRACELY_SAFETY_ID_SECRET) {
  if (!callerId) return null;
  const key = String(secret ?? "").trim();
  return (key ? createHmac("sha256", key) : createHash("sha256")).update(String(callerId)).digest("hex");
}

// ── the request ──────────────────────────────────────────────────────────

/** The body POSTed to /v1/live/sessions. The draft rides in `input` (startup
 *  history, untrusted), never in `instructions` (lib/voices.js). */
export function buildSessionBody({ voiceId, context, sdp }) {
  const input = draftInput(context);
  return {
    session: {
      model: VOICE_MODEL,
      instructions: buildInstructions(voiceId),
      ...(input.length ? { input } : {}),
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

/* A failure after which OpenAI may have created (and billed the 15 s set-up
 * of) a session we never saw: the request timed out or dropped, or a 2xx
 * answer was unreadable. A clean HTTP refusal created nothing. */
function ambiguous(err) {
  err.ambiguous = true;
  return err;
}

/** POST /v1/live/sessions → { id, sdp }. `fetchImpl` defaults to the global
 *  fetch AT CALL TIME, so a test's preloaded stub is the one used. Errors
 *  carry `ambiguous` when a session may exist anyway. */
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
    throw ambiguous(upstream("network"));
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.error?.code;
    throw upstream(code === "insufficient_quota" ? "out_of_credit" : res.status === 429 ? "rate" : res.status === 401 ? "auth" : "http");
  }
  const id = data?.session?.id;
  const sdp = data?.transport?.sdp;
  if (typeof id !== "string" || !id || typeof sdp !== "string" || !sdp.startsWith("v=0")) throw ambiguous(upstream("bad_answer"));
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

// ── when OpenAI's side is failing: a breaker and a per-caller limit ─────

/* Every start that reaches OpenAI costs the pool a 15 s set-up when the
 * sideband then fails, and a student pressing "Try again" during an outage
 * would pay for each one. After BREAKER_FAILURES sideband attach failures
 * within BREAKER_WINDOW_MS, starts answer 502 for BREAKER_OPEN_MS without
 * calling OpenAI; then they're tried again (a success forgets the failures).
 * Only a start's own attach counts: a live call's re-attach loop can fail for
 * reasons of its own (the call ended at OpenAI). Process-wide, in memory. */
export const BREAKER_FAILURES = 3;
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_OPEN_MS = 120_000;
/* And per caller: VOICE_FAILED_SETUPS failed set-ups (any start that asked
 * OpenAI and got no call: a refusal, a timeout, no sideband) in
 * VOICE_FAILED_SETUP_WINDOW_MS, then 429 rate_limit — one client can't
 * hammer OpenAI with offers it rejects, and appRate's 30 a minute is too
 * loose for a call that bills 15 s. */
export const VOICE_FAILED_SETUPS = 5;
export const VOICE_FAILED_SETUP_WINDOW_MS = 600_000;

let sidebandFailures = rollingCounter(BREAKER_FAILURES, BREAKER_WINDOW_MS);
let breakerOpenUntil = 0;
let failedSetups = keyedRateLimiter(VOICE_FAILED_SETUPS, VOICE_FAILED_SETUP_WINDOW_MS);

function noteSidebandFailure(now = Date.now()) {
  sidebandFailures.stamp();
  if (sidebandFailures.ok()) return;
  breakerOpenUntil = now + BREAKER_OPEN_MS;
  sidebandFailures = rollingCounter(BREAKER_FAILURES, BREAKER_WINDOW_MS);
  console.error(`[tracely] voice: sideband breaker open for ${BREAKER_OPEN_MS / 1000} s after ${BREAKER_FAILURES} attach failures in ${BREAKER_WINDOW_MS / 1000} s`);
}
function noteSidebandSuccess() {
  sidebandFailures = rollingCounter(BREAKER_FAILURES, BREAKER_WINDOW_MS);
}

/** Whether starts are being refused without asking OpenAI (introspection, tests). */
export function voiceBreakerOpen(now = Date.now()) {
  return now < breakerOpenUntil;
}

// ── live sessions, metered ───────────────────────────────────────────────

const live = new Map();  // caller key -> its one session (starting or open)
const byId = new Map();  // OpenAI session id -> session
const ended = new Map(); // OpenAI session id -> { key, seconds }: /api/voice/end is idempotent
const ENDED_KEEP = 500;
const POOL_SPEND_KIND = "spend_ucents"; // lib/spend.js KIND: the app pool's running total
const OPEN = 1; // WebSocket.OPEN

/* A local (unenforced) server may have no caller id at all; it has one user. */
const callerKeyOf = (gate) => gate?.callerId ?? "local";
const unref = (t) => (t?.unref?.(), t);
const safeReason = (r) => (typeof r === "string" && /^[a-z_]{1,32}$/.test(r) ? r : "unknown");
const closeQuietly = (ws) => { try { ws?.close(); } catch { /* already closed */ } };

function busy() {
  return new CheckError("voice_busy", "You already have a voice conversation open. End it before starting another.", { status: 409 });
}

/** Take the caller's one slot, synchronously (no await between check and set). */
function claim(gate, maxSeconds) {
  const key = callerKeyOf(gate);
  if (live.has(key)) throw busy();
  const s = newSession({ key, callerId: gate?.callerId ?? null, enforced: Boolean(gate?.ent?.enforced), maxSeconds });
  live.set(key, s);
  return s;
}

function newSession({ key, callerId, enforced, maxSeconds, id = null, createdAt = null }) {
  return {
    key, callerId, enforced, maxSeconds,
    id, ws: null, reattach: null, attempts: 0, seconds: 0, createdAt, reservation: null,
    // closeWanted: we asked for the end (cap, /end, shutdown); closeSent: and
    // session.close went out on an open sideband.
    closeWanted: false, closeSent: false, closeSentAt: null, finalized: false, reason: null,
    heard: "", steered: new Set(), // the safety window (in memory only) and the rules already sent
    idleSeconds: 0, lastTranscriptAt: null, // the idle close: when either side last said anything
    capTimer: null, closeTimer: null, retryTimer: null, backstopTimer: null, idleTimer: null, waiters: [],
  };
}

/* The open call's row (db.js voice_open): a crash leaves it for the next boot
 * (resumeOpenSessions). Bookkeeping must never fail a call or a charge. */
function persist(s) {
  try {
    voiceOpenPut({ sessionId: s.id, callerKey: s.key, callerId: s.callerId, createdAt: s.createdAt, maxSeconds: s.maxSeconds, enforced: s.enforced });
  } catch (e) {
    console.error("[tracely] could not record an open voice session:", e?.message);
  }
}
function unpersist(id) {
  try { voiceOpenDelete(id); } catch (e) { console.error("[tracely] could not clear an open voice session:", e?.message); }
}

function clearTimers(s) {
  for (const t of [s.capTimer, s.closeTimer, s.retryTimer, s.backstopTimer, s.idleTimer]) clearTimeout(t);
  s.capTimer = s.closeTimer = s.retryTimer = s.backstopTimer = s.idleTimer = null;
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

/** Send on the sideband; false when there is no open socket to send on. */
function send(s, message) {
  if (!s.ws || (s.ws.readyState ?? OPEN) !== OPEN) return false;
  try { s.ws.send(JSON.stringify(message)); return true; } catch { return false; }
}

/** Ask OpenAI to end the session. On an open sideband it goes out now, and
 *  if `session.closed` doesn't follow in CLOSE_WAIT_MS the session is
 *  finalized on the wall clock. With no open sideband (a re-attach in
 *  flight) it waits for the next socket (listen sends it). */
function sendClose(s) {
  if (s.finalized) return;
  s.closeWanted = true;
  if (s.closeSent || !send(s, { type: "session.close" })) return;
  s.closeSent = true;
  s.closeSentAt ??= Date.now();
  s.closeTimer = unref(setTimeout(() => finalize(s, "close_unconfirmed"), CLOSE_WAIT_MS));
}

/** The latest a session can still be running: the cap guard plus the close
 *  wait. A lost sideband keeps re-attaching (and the slot stays claimed)
 *  until then. */
const deadlineOf = (s) => s.createdAt + (s.maxSeconds + CAP_GRACE_SECONDS) * 1000 + CLOSE_WAIT_MS;

/* The wall-clock guard: session.close at maxSeconds + grace even if no usage
 * event ever arrives (OpenAI sends session.usage.updated only around the
 * close, measured live 2026-10-10, so this is usually what fires). */
function armCapGuard(s) {
  const ms = s.createdAt + (s.maxSeconds + CAP_GRACE_SECONDS) * 1000 - Date.now();
  s.capTimer = unref(setTimeout(() => sendClose(s), Math.max(0, ms)));
  // And a backstop, one close wait past the deadline, so no session can sit
  // in memory (holding a slot and a hold) if every other path went quiet.
  s.backstopTimer = unref(setTimeout(() => finalize(s, "deadline"), Math.max(0, deadlineOf(s) + CLOSE_WAIT_MS - Date.now())));
}

/* The idle close: when neither side has said anything (no transcript delta
 * either way) for s.idleSeconds, the sideband sends session.close. A muted
 * or forgotten window would otherwise bill to the cap ($0.75 and half a
 * student's day); OpenAI's guide leaves inactivity to the application
 * (guides/live-conversations, "Close idle sessions and resume"). One timer
 * per idle window: when it fires early (words came since) it re-arms for the
 * new deadline. Only times are kept here, never the words. */
function armIdle(s) {
  clearTimeout(s.idleTimer);
  s.idleTimer = null;
  if (s.finalized || !(s.idleSeconds > 0) || s.lastTranscriptAt == null) return;
  const dueAt = () => s.lastTranscriptAt + s.idleSeconds * 1000;
  s.idleTimer = unref(setTimeout(() => {
    s.idleTimer = null;
    if (s.finalized || s.closeWanted) return;
    if (Date.now() < dueAt()) { armIdle(s); return; }
    console.log(`[tracely] voice: closing a call with no words either way for ${s.idleSeconds} s`);
    sendClose(s);
  }, Math.max(0, dueAt() - Date.now())));
}

/* Charge once, whatever ended it: the app pool in micro-cents and the
 * account's voice seconds for the daily and monthly caps, both on what OpenAI bills (at
 * least VOICE_MIN_BILLED_SECONDS). Never account_ucents (see the top).
 * Only `session.closed` (confirmed) carries the real total. Otherwise the
 * meter is stale by design: a close that went out bills the wall clock since
 * the session was created (to its close wait at most); a close that never
 * could (no sideband to the end) bills the client's cap, since the call may
 * have run that long. */
function finalize(s, reason, { confirmed = false } = {}) {
  if (s.finalized) return;
  s.finalized = true;
  s.reason = reason;
  clearTimers(s);
  const at = Date.now();
  if (!confirmed && s.createdAt != null) {
    // When did it end? Now, if a close is out on the live socket; a close
    // wait after the first close that went out, if that socket was lost
    // since; and if no close ever went out, it may have run to the cap.
    const endAt = s.closeSent ? at : s.closeSentAt != null ? Math.min(at, s.closeSentAt + CLOSE_WAIT_MS) : null;
    s.seconds = Math.max(s.seconds, endAt != null ? (endAt - s.createdAt) / 1000 : s.maxSeconds);
  }
  try {
    if (s.enforced) {
      const billed = billedSeconds(s.seconds);
      chargePool(voiceCostMicroCents(billed), at);
      if (isDailyQuotaKey(s.callerId)) {
        // The day row (the daily cap) and the month row (the monthly one).
        usageAdd(s.callerId, usageDay(at), VOICE_SECONDS_KIND, Math.ceil(billed));
        usageAdd(s.callerId, usageMonth(at), VOICE_SECONDS_KIND, Math.ceil(billed));
      }
    }
  } catch (e) {
    console.error("[tracely] could not record a voice session's spend:", e?.message);
  } finally {
    s.reservation?.release();
  }
  if (live.get(s.key) === s) live.delete(s.key);
  if (s.id) {
    unpersist(s.id);
    byId.delete(s.id);
    ended.set(s.id, { key: s.key, seconds: Math.round(s.seconds) });
    if (ended.size > ENDED_KEEP) ended.delete(ended.keys().next().value);
  }
  closeQuietly(s.ws);
  console.log(`[tracely] voice session ended reason=${safeReason(reason)} seconds=${Math.round(s.seconds)}`);
  for (const wake of s.waiters.splice(0)) wake();
}

/* Student safety on the sideband. Many students are under 18, and OpenAI's
 * under-18 guidance asks for an escalation path for high-risk moments; its
 * voice guide puts transcript guardrails on exactly this connection
 * (guides/voice-server-controls, "Apply conversation guardrails"). The
 * student's words arrive as session.input_transcript.delta: the last
 * HEARD_CHARS are kept on the session, in memory only — never logged, never
 * stored — and checked against two short lists. A hit sends that rule's
 * session.instructions.append once per call. Each instruction is
 * conditional, so a student only DISCUSSING a hard topic in their writing
 * (a character's suicide, a history of abuse) is not derailed. */
export const HEARD_CHARS = 500;
const HURTER = "(?:he|she|they|someone|somebody|my (?:dad|mom|mum|father|mother|step ?(?:dad|mom|mum|father|mother)|brother|sister|boyfriend|girlfriend|parents?|uncle|aunt|cousin|teacher|coach))";
export const SAFETY_RULES = Object.freeze([
  Object.freeze({
    id: "distress",
    pattern: new RegExp(
      "\\b(?:kill(?:ing)? my ?self|suicid\\w*|end(?:ing)? (?:it all|my life)|take my (?:own )?life|(?:want|wanna|going) to die|wish i (?:was|were) dead|better off dead" +
      "|don'?t want to (?:live|be alive|be here anymore)|no reason to live|self[- ]?harm\\w*|hurt(?:ing)? my ?self|cut(?:ting)? my ?self" +
      `|${HURTER} (?:hits|hurts|beats|touches|touched|hit|hurt|abuses|abused) me|i(?:'?m| am|'?ve been| have been) (?:being )?(?:abused|beaten)` +
      "|(?:not safe|unsafe) at home|(?:scared|afraid) to go home)\\b"),
    content: "The student may have just said they are in distress or unsafe. If they are talking about themselves, or about someone hurting them, stop the writing help, respond with warmth, don't ask for details, and encourage them to talk to a trusted adult right now; tell them that in the US they can call or text 988 any time, and elsewhere they should contact local emergency services. Don't end the conversation abruptly. If they were only discussing a topic in their writing, carry on gently and age-appropriately.",
  }),
  Object.freeze({
    id: "sexual",
    pattern: /\b(?:sex|sexual(?:ly)?|sexy|nudes?|naked|porn\w*|horny)\b/,
    content: "The student just mentioned something sexual. Keep the conversation age-appropriate: don't engage with sexual content or role-play, and kindly steer back to their writing. If they say someone is pressuring or hurting them, respond with warmth, encourage them to talk to a trusted adult right away, and tell them that in the US they can call or text 988 any time. If it is only a topic in their writing, stay factual and age-appropriate.",
  }),
]);

/** The student said `delta`: keep the window, check it, steer once per rule. */
function heard(s, delta) {
  s.heard = (s.heard + delta).slice(-HEARD_CHARS);
  const text = s.heard.toLowerCase().replace(/[‘’ʼ]/g, "'");
  for (const rule of SAFETY_RULES) {
    if (s.steered.has(rule.id) || !rule.pattern.test(text)) continue;
    // Marked only once it went out: in a re-attach gap the window still
    // holds the words, and the next delta tries again.
    if (send(s, { type: "session.instructions.append", delegation_id: null, content: rule.content })) s.steered.add(rule.id);
  }
}

/* Reflected audio (PCM16 at 24 kHz, both directions) is nearly all of the
 * sideband's traffic and is never read, so only frames that can name an
 * event we act on are parsed. */
const WANTED = /"session\.(usage\.updated|closed|delegation\.created|input_transcript\.delta|output_transcript\.delta)"/;

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
    finalize(s, typeof ev.reason === "string" ? ev.reason : "closed", { confirmed: true });
  } else if (ev?.type === "session.delegation.created" && typeof ev.delegation?.id === "string") {
    send(s, { type: "session.commentary.append", delegation_id: ev.delegation.id, content: DELEGATION_REPLY });
  } else if (ev?.type === "session.input_transcript.delta" && typeof ev.delta === "string") {
    s.lastTranscriptAt = Date.now();
    heard(s, ev.delta);
  } else if (ev?.type === "session.output_transcript.delta") {
    s.lastTranscriptAt = Date.now(); // the model's words: only the time is kept
  }
}

function listen(s, ws) {
  s.ws = ws;
  ws.addEventListener("message", (ev) => onMessage(s, ev.data));
  ws.addEventListener("close", () => { if (s.ws === ws) onSidebandClosed(s); });
  // A close asked for while no sideband was open goes out on this one, and
  // the session then ends on `session.closed`, not on this socket closing.
  if (s.closeWanted && !s.closeSent) sendClose(s);
}

/* The sideband dropped without `session.closed`. The sideband is the only
 * way to close a live session (there is no hangup endpoint for it) and usage
 * is cumulative, so re-attach — at once, then backing off — until it works
 * or the session can no longer be running (deadlineOf). The caller's slot
 * stays claimed throughout: a second call can't open beside one that may
 * still be live. A close that went out on the lost socket is re-sent. */
function onSidebandClosed(s) {
  if (s.finalized) return;
  s.ws = null;
  if (s.closeSent) {
    s.closeSent = false;
    clearTimeout(s.closeTimer);
    s.closeTimer = null;
  }
  reattachSoon(s);
}

function reattachSoon(s) {
  if (s.finalized) return;
  const delay = s.attempts === 0 ? 0 : REATTACH_BACKOFF_MS[Math.min(s.attempts - 1, REATTACH_BACKOFF_MS.length - 1)];
  if (Date.now() + delay > deadlineOf(s)) {
    finalize(s, "sideband_lost");
    return;
  }
  s.attempts++;
  const attempt = () => {
    s.retryTimer = null;
    s.reattach().then((ws) => (s.finalized ? closeQuietly(ws) : listen(s, ws)), () => reattachSoon(s));
  };
  if (delay === 0) attempt();
  else s.retryTimer = unref(setTimeout(attempt, delay));
}

// ── the two routes (server.js wires them; appGate runs before start) ─────

let mockSessions = 0;

/** The feature switch and the plan: the refusals that need neither the body
 *  nor the ledger. */
function checkSwitchAndPlan(gate, limits) {
  if (limits.maxSeconds <= 0 || limits.dailySeconds <= 0) {
    throw new CheckError("voice_off", "Voice conversations are turned off on this server.", { status: 503 });
  }
  // The billing plan, not effectivePlan: a Pro account over its fair-use
  // limit is still paying for Pro, and voice has its own daily cap.
  if (gate?.ent?.enforced && planRank(gate.ent.plan) < planRank("pro")) {
    throw new CheckError("plan_limit", "Voice is part of Pro.", { status: 429 });
  }
}

/**
 * What the caller may still talk: today's seconds (usageDay row), this
 * month's (usageMonth row, the source-search month pattern) and when today's
 * come back. Only an enforced caller with a quota identity is metered; a
 * local server answers the configured allowances untouched.
 * `remainingMonthSeconds` is null when there is no monthly cap
 * (TRACELY_VOICE_MONTHLY_SECONDS=0).
 */
export function voiceAllowance(gate, env = process.env, at = Date.now()) {
  const { dailySeconds } = voiceLimits(env);
  const monthlySeconds = voiceMonthlySeconds(env);
  const metered = Boolean(gate?.ent?.enforced) && isDailyQuotaKey(gate?.callerId);
  const used = (period) => (metered ? usageCount(gate.callerId, period, VOICE_SECONDS_KIND) : 0);
  return {
    remainingSeconds: Math.max(0, dailySeconds - used(usageDay(at))),
    remainingMonthSeconds: monthlySeconds > 0 ? Math.max(0, monthlySeconds - used(usageMonth(at))) : null,
    resetAt: dayResetAt(at),
  };
}

/** The allowance, refused when less than one billed minimum (15 s) is left:
 *  the month first when both are spent, since it comes back later. Returns
 *  the allowance and the longest call it allows. */
function checkAllowance(gate, env, limits, at = Date.now()) {
  const a = voiceAllowance(gate, env, at);
  if (a.remainingMonthSeconds !== null && a.remainingMonthSeconds < VOICE_MIN_BILLED_SECONDS) {
    throw new CheckError("voice_monthly", "You've used this month's voice minutes. They come back on the 1st.", { status: 429, resetAt: monthResetAt(at) });
  }
  if (a.remainingSeconds < VOICE_MIN_BILLED_SECONDS) {
    throw new CheckError("voice_daily", "You've used today's voice time. It resets at midnight.", { status: 429, resetAt: a.resetAt });
  }
  const maxSeconds = Math.min(limits.maxSeconds, a.remainingSeconds, a.remainingMonthSeconds ?? Infinity);
  return { allowance: a, maxSeconds };
}

/**
 * POST /api/voice/session. The order is the policy: feature switch, plan,
 * key, body, one-at-a-time, the day's and the month's seconds, the breaker
 * and the caller's failed set-ups, then money held before OpenAI is asked.
 * `readBody` is a thunk so a refusal never needs the body.
 */
export async function startSession({ gate, readBody, mock = false, env = process.env, fetchImpl, WebSocketImpl }) {
  const limits = voiceLimits(env);
  checkSwitchAndPlan(gate, limits);
  const enforced = Boolean(gate?.ent?.enforced);
  const key = String(env.OPENAI_API_KEY ?? "").trim();
  if (!key && !mock) {
    throw new CheckError("no_key", "No OpenAI API key configured. Add OPENAI_API_KEY to tracely/.env", { status: 503 });
  }
  const request = validateSessionRequest(await readBody());
  const voice = { id: request.voiceId, name: VOICE_PERSONAS[request.voiceId].name };
  if (live.has(callerKeyOf(gate))) throw busy();

  const { allowance: { remainingSeconds, remainingMonthSeconds, resetAt }, maxSeconds } = checkAllowance(gate, env, limits);
  const quota = { maxSeconds, remainingSeconds, remainingMonthSeconds, resetAt };
  if (mock) return { mock: true, sessionId: `mock_${++mockSessions}`, voice, ...quota };

  // OpenAI's side is failing (the breaker), or this caller's starts keep
  // failing: refuse before anything is asked or held.
  if (voiceBreakerOpen()) throw upstream("breaker_open");
  if (!failedSetups.ok(callerKeyOf(gate))) {
    throw new CheckError("rate_limit", "Too many voice calls failed to start. Try again in a few minutes.", { status: 429, retryAfter: VOICE_FAILED_SETUP_WINDOW_MS / 1000 });
  }

  const s = claim(gate, maxSeconds);
  let created = false;
  let asked = false;
  try {
    if (enforced) {
      if (!poolRoom({ pool: "app", env }).room) {
        throw new CheckError("budget", "Voice conversations have hit today's usage limit. They reset at midnight.", { status: 503 });
      }
      s.reservation = reserveSpend("app", voiceCostMicroCents(billedSeconds(maxSeconds)));
    }
    const safetyId = safetyIdentifier(gate?.callerId, env.TRACELY_SAFETY_ID_SECRET ?? "");
    asked = true;
    const { id, sdp } = await startLiveSession({ key, body: buildSessionBody(request), safetyId, fetchImpl });
    created = true;
    s.createdAt = Date.now();
    // "Include the same connection headers required when creating the session."
    const headers = safetyId ? { "OpenAI-Safety-Identifier": safetyId } : {};
    s.reattach = () => attachSideband({ url: attachUrl(id), key, headers, WebSocketImpl });
    const ws = await s.reattach().catch((err) => { noteSidebandFailure(); throw err; });
    noteSidebandSuccess();
    s.id = id;
    byId.set(id, s);
    listen(s, ws);
    armCapGuard(s);
    s.idleSeconds = voiceIdleSeconds(env);
    s.lastTranscriptAt = s.createdAt; // silence is counted from the start
    armIdle(s);
    persist(s);
    return { sdp, sessionId: id, voice, ...quota };
  } catch (err) {
    // OpenAI billed (or may have billed: a timeout, a dropped or unreadable
    // answer) the 15 s set-up of a session we never handed out: the pool
    // pays it; the student isn't charged for our failure.
    if (enforced && (created || err?.ambiguous)) chargePool(voiceCostMicroCents(VOICE_MIN_BILLED_SECONDS), Date.now());
    if (asked) failedSetups.stamp(s.key);
    abandon(s);
    throw err;
  }
}

/* A refusal's kind → the eligibility answer's `reason`. */
const ELIGIBILITY_REASON = Object.freeze({
  plan_limit: "plan", voice_daily: "daily-limit", voice_monthly: "monthly-limit", voice_off: "off", voice_busy: "busy",
});

/**
 * POST /api/voice/eligibility: would a call start now? The same checks as
 * startSession in the same order — switch, plan, one-at-a-time, the day and
 * the month — with no body, no key, no OpenAI call and nothing reserved, so
 * the desktop can ask before the consent sheet and the microphone prompt.
 * → {allowed:true, maxSeconds, remainingSeconds, remainingMonthSeconds, resetAt}
 * | {allowed:false, reason, message, resetAt?} (resetAt on the two limits).
 */
export function checkEligibility({ gate, env = process.env, at = Date.now() }) {
  try {
    const limits = voiceLimits(env);
    checkSwitchAndPlan(gate, limits);
    if (live.has(callerKeyOf(gate))) throw busy();
    const { allowance, maxSeconds } = checkAllowance(gate, env, limits, at);
    return { allowed: true, maxSeconds, ...allowance };
  } catch (err) {
    const reason = err instanceof CheckError ? ELIGIBILITY_REASON[err.kind] : undefined;
    if (!reason) throw err;
    return { allowed: false, reason, message: err.message, ...(err.resetAt ? { resetAt: err.resetAt } : {}) };
  }
}

/**
 * POST /api/voice/end → { seconds }. Idempotent: a session already ended
 * answers its seconds again; an id this caller never opened (another
 * caller's, a mock's, one from before a restart) answers 0. Sends
 * `session.close` and waits up to `waitMs` for `session.closed`'s final
 * seconds. If they don't come in time it does NOT charge here: the session
 * stays with `session.closed` (the real seconds, read even if it arrives
 * late) or the close-wait timer (the wall clock), and this answers the best
 * estimate so far.
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
  }
  if (s.finalized) return { seconds: Math.round(s.seconds) };
  return { seconds: Math.round(Math.max(s.seconds, (Date.now() - s.createdAt) / 1000)) };
}

// ── restarts: never an un-metered call ───────────────────────────────────

/**
 * SIGTERM/SIGINT (server.js): close every open call, wait up to `waitMs` for
 * `session.closed`, and charge what is left on the wall clock ("shutdown").
 * A call whose close could not go out (its sideband was down) is not
 * charged here: its voice_open row stays for the next boot, which resumes
 * it. "Restart the server to reset the meter" must not be a way out
 * (lib/spend.js says the same of the budget).
 */
export async function shutdownVoice({ waitMs = 2000 } = {}) {
  const open = [...byId.values()].filter((s) => !s.finalized);
  for (const s of open) sendClose(s);
  await new Promise((resolve) => {
    let left = open.length;
    if (!left) return resolve();
    const t = unref(setTimeout(resolve, waitMs));
    for (const s of open) s.waiters.push(() => { if (--left === 0) { clearTimeout(t); resolve(); } });
  });
  let charged = 0, kept = 0;
  for (const s of open) {
    if (s.finalized) { charged++; continue; }
    if (s.closeSent) { finalize(s, "shutdown"); charged++; continue; }
    abandon(s); // the row stays: resumeOpenSessions picks it up
    byId.delete(s.id);
    kept++;
  }
  return { charged, kept };
}

/**
 * At boot (server.js): every voice_open row is a call the last process never
 * charged (a crash, or a close that couldn't go out at shutdown). Re-attach
 * to each to resume the meter, the cap guard and the close — the same loop
 * as a lost sideband, so one that never answers is billed its cap once it
 * can no longer be running. A row already past that point (or with no key
 * to attach with) is charged its cap at once.
 */
export function resumeOpenSessions({ env = process.env, WebSocketImpl } = {}) {
  let rows = [];
  try { rows = voiceOpenAll(); } catch (e) { console.error("[tracely] could not read open voice sessions:", e?.message); }
  const key = String(env.OPENAI_API_KEY ?? "").trim();
  for (const r of rows) {
    if (byId.has(r.session_id)) continue;
    const s = newSession({
      key: r.caller_key, callerId: r.caller_id, enforced: Boolean(r.enforced), maxSeconds: Number(r.max_seconds) || 0,
      id: r.session_id, createdAt: Number(r.created_at) || 0,
    });
    if (!key || Date.now() > deadlineOf(s)) { finalize(s, "resumed_expired"); continue; }
    if (!live.has(s.key)) live.set(s.key, s);
    byId.set(s.id, s);
    if (s.enforced) s.reservation = reserveSpend("app", voiceCostMicroCents(billedSeconds(s.maxSeconds)));
    const safetyId = safetyIdentifier(s.callerId, env.TRACELY_SAFETY_ID_SECRET ?? "");
    s.reattach = () => attachSideband({ url: attachUrl(s.id), key, headers: safetyId ? { "OpenAI-Safety-Identifier": safetyId } : {}, WebSocketImpl });
    armCapGuard(s);
    // A resumed call gets a fresh idle window: what was said before the
    // restart is unknown.
    s.idleSeconds = voiceIdleSeconds(env);
    s.lastTranscriptAt = Date.now();
    armIdle(s);
    reattachSoon(s);
  }
  if (rows.length) console.log(`[tracely] voice: resuming ${rows.length} call(s) left open by the last process`);
  return rows.length;
}

/** For tests and /api/status-style introspection: how many sessions are live. */
export function liveSessionCount() {
  return live.size;
}

/** Tests only: forget every session without charging. */
export function _resetVoiceForTests() {
  for (const s of [...live.values(), ...byId.values()]) abandon(s);
  for (const r of voiceOpenAll()) voiceOpenDelete(r.session_id);
  live.clear();
  byId.clear();
  ended.clear();
  mockSessions = 0;
  sidebandFailures = rollingCounter(BREAKER_FAILURES, BREAKER_WINDOW_MS);
  breakerOpenUntil = 0;
  failedSetups = keyedRateLimiter(VOICE_FAILED_SETUPS, VOICE_FAILED_SETUP_WINDOW_MS);
}
