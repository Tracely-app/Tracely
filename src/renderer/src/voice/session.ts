/* Tracer Voice's engine: one spoken call with Tracer, as a VoiceSessionHandle.
 *
 * The renderer owns the media. start() asks main for the OS microphone
 * permission, opens the mic, builds an RTCPeerConnection with the mic track and
 * the "oai-events" data channel (created BEFORE the offer, as OpenAI's WebRTC
 * guide requires), waits briefly for ICE gathering, and hands the offer to main
 * (voice:start), which adds the draft and asks the Tracely server for the
 * session. The answer comes back the same way; from then on audio flows
 * straight between this peer and OpenAI. The key never reaches this process.
 *
 * What the UI sees is a VoiceSnapshot (voice/types.ts), replaced — never
 * mutated — whenever something changes, so React can read it with
 * useSyncExternalStore.
 *
 * Facts this file is built on (developers.openai.com, fetched 2026-10-10):
 * - The data channel carries session.started, session.input_transcript.delta /
 *   session.output_transcript.delta ({delta, start_ms, end_ms}; no item ids and
 *   no "done" event), session.closed ({reason: close_requested | expired |
 *   content | remote_hangup | connection_lost}) and error.
 * - GPT-Live has no speech started/stopped events, so who is talking comes from
 *   the audio itself: an AnalyserNode on each direction, smoothed, with
 *   hysteresis.
 * - Some moderation errors only cut Tracer off mid-sentence and leave the call
 *   up, so an `error` event alone does not end the call here; a closed peer or
 *   session.closed does.
 * - The server allows the client no events (allowed_client_events: []), so a
 *   call ends by closing the peer plus voice:end, and mute is local
 *   (track.enabled = false).
 *
 * A mock answer (mock: true — a keyless server or the preview harness) carries
 * no SDP. The engine then plays a deterministic demo conversation in the
 * persona's words, so every state of the UI runs without a key.
 *
 * Node runs this file's tests directly (type stripping), so value imports are
 * relative with an explicit `.ts`, and nothing here imports lib/api.ts (its
 * '@shared' alias does not resolve under node --test): the caller passes the
 * api — useVoiceSession passes tracelyApi.voice.
 */
import type {
  VoiceMicStatus,
  VoiceStartRequest,
  VoiceStartResponse,
  VoiceTranscriptTurn
} from '@shared/ipc-contract'
import type { VoiceId } from '@shared/voices'
// Relative with `.ts` so node --test can load it (the alias resolves only in the build).
import { VOICE_KIND_COPY } from '../../../shared/ipc-contract.ts'
import type {
  VoiceCaption,
  VoiceErrorKind,
  VoiceSessionHandle,
  VoiceSnapshot,
  VoiceState
} from './types'

/** The slice of tracelyApi.voice the engine calls. Errors carry `kind` (VoiceApiError). */
export interface VoiceApi {
  ensureMic(): Promise<{ status: VoiceMicStatus }>
  start(req: VoiceStartRequest): Promise<VoiceStartResponse>
  end(sessionId: string): Promise<{ seconds: number }>
  saveTranscript(turns: VoiceTranscriptTurn[], conversationId?: string): Promise<{ saved: boolean }>
}

/** The few RTCDataChannel members the engine touches (a fake in tests). */
export interface VoiceDataChannel {
  readonly readyState: string
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  close(): void
}

/** The few RTCPeerConnection members the engine touches (a fake in tests). */
export interface VoicePeer {
  readonly iceGatheringState: string
  readonly connectionState: string
  readonly localDescription: { sdp: string } | null
  onicegatheringstatechange: (() => void) | null
  onconnectionstatechange: (() => void) | null
  ontrack: ((ev: { streams: readonly MediaStream[]; track: MediaStreamTrack }) => void) | null
  addTrack(track: MediaStreamTrack, stream: MediaStream): unknown
  createDataChannel(label: string): VoiceDataChannel
  createOffer(): Promise<{ type: string; sdp?: string }>
  setLocalDescription(desc: { type: string; sdp?: string }): Promise<void>
  setRemoteDescription(desc: { type: 'answer'; sdp: string }): Promise<void>
  close(): void
}

/** Reads one direction's loudness, 0..1 RMS of the latest audio frame. */
export interface VoiceMeter {
  rms(): number
  dispose(): void
}

/** Where Tracer's voice plays: an <audio autoplay> the engine keeps (never in the DOM). */
export interface VoiceSpeaker {
  play(stream: MediaStream): void
  stop(): void
}

export type VoicePlatform = 'mac' | 'windows' | 'other'

/** Everything with a side effect, injectable so the tests can run in Node. */
export interface VoiceDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createPeer(): VoicePeer
  /** null when Web Audio is unavailable: levels then stay at 0 and the call still works. */
  createMeter(stream: MediaStream): VoiceMeter | null
  createSpeaker(): VoiceSpeaker
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  platform: VoicePlatform
  /**
   * Where the preview harness's window.__previewEmitVoice dispatches
   * PREVIEW_VOICE_EVENT (Partial<VoiceSnapshot> as `detail`); null outside it.
   */
  previewEvents: EventTarget | null
  /** Hang up when the window goes away (or main closes it to the tray); returns the unsubscribe. */
  onUnload(fn: () => void): () => void
}

export interface VoiceSessionOptions {
  voiceId: VoiceId
  api: VoiceApi
  deps?: Partial<VoiceDeps>
  /** Read at hang-up: save the final captions to the Tracer chat (the voiceSaveTranscript setting). */
  shouldSaveTranscript?: () => boolean
  /** The conversation the panel shows, for the saved transcript. */
  conversationId?: () => string | null | undefined
}

/** What a finished call left behind, for the summary line after End. */
export interface VoiceCallResult {
  /** Seconds talked, by the engine's own clock (from session.started). */
  seconds: number
  /** null: nothing to save, or saving is off; else whether the store took it. */
  transcriptSaved: boolean | null
  /**
   * What the server metered and charged against today's allowance (its
   * voice:end answer), or null when it could not be asked. Prefer it to
   * `seconds` for "minutes left today".
   */
  serverSeconds: number | null
}

/** fn(), with a synchronous throw turned into a rejection. */
function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn()
  } catch (e) {
    return Promise.reject(e)
  }
}

/**
 * A data-channel frame as text. Chrome delivers binary SCTP messages as an
 * ArrayBuffer (binaryType defaults to 'arraybuffer'), and String() of one is
 * "[object ArrayBuffer]" — session.started sent that way would be lost and
 * the call would time out as a network error.
 */
export function frameText(data: unknown): string | null {
  if (typeof data === 'string') return data
  try {
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data)
  } catch {
    return null
  }
  return null
}

function serverSecondsFrom(r: unknown): number | null {
  const v = (r as { seconds?: unknown } | null)?.seconds
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** The engine is a VoiceSessionHandle plus a little the UI needs after End. */
export interface VoiceEngine extends VoiceSessionHandle {
  result(): VoiceCallResult | null
  /** Resolves with result() once a finished call has told the server and saved its transcript. */
  settled(): Promise<VoiceCallResult | null>
  /** Drop listeners and timers; ends a call that is still open. */
  dispose(): void
}

// ── Constants ───────────────────────────────────────────────────────────────

/** The preview harness's event (preview/mockApi.ts PREVIEW_VOICE_EVENT, pinned by a test). */
export const PREVIEW_VOICE_EVENT = 'tracely:preview-voice'
export const DATA_CHANNEL_LABEL = 'oai-events'
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
}
/** Send the offer with whatever candidates exist after this long (the spec's ≤ 3 s). */
export const ICE_GATHER_TIMEOUT_MS = 3000
/** From the answer to session.started; past this the call failed to connect. */
export const CONNECT_TIMEOUT_MS = 15000
/** A caption closes after this long without a delta (or a gap this long on the session timeline). */
export const CAPTION_PAUSE_MS = 1200
/** Level sampling: 25 Hz is plenty for the orb (it springs between samples). */
export const TICK_MS = 40
/** If the server's close at the cap never arrives, hang up this long after it. */
export const CAP_GRACE_SEC = 10

// ── Levels and who is speaking ──────────────────────────────────────────────

/** RMS (0..1 of full scale) to a 0..1 level: −58 dBFS is silence, −14 dBFS is loud speech. */
export function rmsToLevel(rms: number): number {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db + 58) / 44))
}

/** One smoothing step: fast attack so syllables land, slow release so the orb doesn't flicker. */
export function smoothLevel(prev: number, raw: number, attack = 0.55, release = 0.12): number {
  const k = raw > prev ? attack : release
  const next = prev + (raw - prev) * k
  return next < 0.002 ? 0 : next
}

export interface SpeechGate {
  /** Feed one smoothed level at time `now` (ms); returns whether this voice is speaking. */
  update(level: number, now: number): boolean
  readonly active: boolean
}

/**
 * Hysteresis on a level: on above `on` for `onMs`, off below `off` for
 * `offMs`. The gap and the hang-over keep a pause between words from reading
 * as the end of a turn.
 */
export function createSpeechGate(on = 0.24, off = 0.12, onMs = 80, offMs = 500): SpeechGate {
  let active = false
  let since: number | null = null
  return {
    get active() {
      return active
    },
    update(level, now) {
      const crossing = active ? level < off : level > on
      if (!crossing) since = null
      else if (since === null) since = now
      else if (now - since >= (active ? offMs : onMs)) {
        active = !active
        since = null
      }
      return active
    }
  }
}

// ── Captions ────────────────────────────────────────────────────────────────

/** The captions plus what merging the next delta needs to know. Immutable. */
export interface CaptionLog {
  captions: VoiceCaption[]
  /** engine clock (ms) of the last delta, for the pause rule */
  lastDeltaAt: number
  /** end_ms of the last delta on the session timeline, when the event carried one */
  lastEndMs: number | null
  nextId: number
}

export const EMPTY_CAPTIONS: CaptionLog = { captions: [], lastDeltaAt: 0, lastEndMs: null, nextId: 1 }

function closeLast(captions: VoiceCaption[]): VoiceCaption[] {
  const last = captions[captions.length - 1]
  if (!last || last.final) return captions
  return [...captions.slice(0, -1), { ...last, final: true }]
}

/**
 * Merge one transcript delta. It extends the open caption when that caption
 * is the same speaker's and no pause came between (on the engine's clock, or
 * on the session timeline when the event carries start_ms); otherwise the
 * open caption is finalized and a new one starts.
 */
export function addTranscriptDelta(
  log: CaptionLog,
  role: VoiceCaption['role'],
  delta: string,
  now: number,
  startMs?: number,
  endMs?: number
): CaptionLog {
  if (!delta) return log
  const last = log.captions[log.captions.length - 1]
  const timelineGap =
    typeof startMs === 'number' && log.lastEndMs !== null ? startMs - log.lastEndMs : 0
  const paused = now - log.lastDeltaAt > CAPTION_PAUSE_MS || timelineGap > CAPTION_PAUSE_MS
  const lastEndMs = typeof endMs === 'number' ? endMs : log.lastEndMs
  if (last && !last.final && last.role === role && !paused) {
    const captions = [...log.captions.slice(0, -1), { ...last, text: last.text + delta }]
    return { captions, lastDeltaAt: now, lastEndMs, nextId: log.nextId }
  }
  const caption: VoiceCaption = { id: `c${log.nextId}`, role, text: delta.replace(/^\s+/, ''), final: false }
  return {
    captions: [...closeLast(log.captions), caption],
    lastDeltaAt: now,
    lastEndMs,
    nextId: log.nextId + 1
  }
}

/** Finalize the open caption once its speaker has been quiet for CAPTION_PAUSE_MS. */
export function settleCaptions(log: CaptionLog, now: number): CaptionLog {
  const last = log.captions[log.captions.length - 1]
  if (!last || last.final || now - log.lastDeltaAt <= CAPTION_PAUSE_MS) return log
  return { ...log, captions: closeLast(log.captions) }
}

/** The finished call's captions as transcript turns (empty ones dropped), oldest first. */
export function transcriptTurns(captions: readonly VoiceCaption[]): VoiceTranscriptTurn[] {
  return captions
    .map((c) => ({ role: c.role, text: c.text.trim() }))
    .filter((t) => t.text.length > 0)
}

// ── Errors, in plain words with a next step ─────────────────────────────────

export type VoiceError = NonNullable<VoiceSnapshot['error']>

export function micDeniedMessage(platform: VoicePlatform): string {
  if (platform === 'mac') {
    return "Tracely can't use your microphone. Turn it on in System Settings → Privacy & Security → Microphone, then try again."
  }
  if (platform === 'windows') {
    return "Tracely can't use your microphone. Turn on microphone access in Windows Settings → Privacy & security → Microphone, including \"Let desktop apps access your microphone\", then try again."
  }
  return "Tracely can't use your microphone. Allow microphone access for Tracely in your system settings, then try again."
}

const SERVER_FALLBACK = "Tracely couldn't start the call. Try again in a moment."

/**
 * voice.start's rejection (a VoiceApiError carries `kind`) as the snapshot's
 * error. The account kinds read the one shared wording (VOICE_KIND_COPY, which
 * main tags them with too); a server error keeps main's sentence.
 */
export function startError(err: unknown): VoiceError {
  const kind = (err as { kind?: unknown } | null)?.kind
  if (kind === 'plan' || kind === 'daily-limit' || kind === 'busy' || kind === 'network') {
    return { kind, message: VOICE_KIND_COPY[kind] }
  }
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return { kind: 'server', message: raw.trim() || SERVER_FALLBACK }
}

/** getUserMedia's rejection: no permission, no device, or a device another app holds. */
export function micError(err: unknown, platform: VoicePlatform): VoiceError {
  const name = (err as { name?: unknown } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { kind: 'mic-denied', message: micDeniedMessage(platform) }
  }
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
    return {
      kind: 'mic-missing',
      message: 'Your microphone is busy in another app. Close the app using it, then try again.'
    }
  }
  return {
    kind: 'mic-missing',
    message: 'No microphone found. Plug one in or choose one in your sound settings, then try again.'
  }
}

/**
 * When OpenAI's safety filter ends a call. The student may be under 18 and
 * may just have said something worrying, so this is supportive and names
 * where to get help rather than reading as a fault.
 */
export const SAFETY_ENDED_MESSAGE =
  'This call was stopped by an automatic safety check. If something is worrying you, please talk to a trusted adult. In the US you can call or text 988 any time; elsewhere, contact your local emergency number.'

/**
 * Why the call ended when the student didn't end it (session.closed's reason,
 * or 'connection_lost' for a peer that dropped). The server's close at the cap
 * arrives as close_requested; OpenAI's own limit as expired.
 */
export function closedError(reason: unknown, maxSec: number, remainingTodaySec: number | null): VoiceError {
  if (reason === 'expired' || reason === 'close_requested') {
    const dailyBound = remainingTodaySec !== null && remainingTodaySec <= maxSec
    return {
      kind: 'ended-by-limit',
      message: dailyBound
        ? "That's all of today's voice minutes. They reset tomorrow — you can keep chatting by text."
        : `That's the ${Math.round(maxSec / 60)}-minute limit for one call. Start a new call any time.`
    }
  }
  if (reason === 'content') return { kind: 'safety', message: SAFETY_ENDED_MESSAGE }
  return { kind: 'network', message: 'The call dropped. Check your internet connection, then start a new call.' }
}

// ── Words the UI shows for a snapshot ───────────────────────────────────────

/** 245 → "4:05"; never negative. */
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The line under the orb: what is happening, in a few words. */
export function voiceStateLine(snap: Pick<VoiceSnapshot, 'state' | 'muted' | 'error'>, name: string): string {
  switch (snap.state) {
    case 'idle':
      return `Talk with ${name}`
    case 'requesting-mic':
      return 'Waiting for the microphone…'
    case 'connecting':
      return 'Connecting…'
    case 'listening':
      return snap.muted ? 'Muted' : 'Listening'
    case 'user-speaking':
      return snap.muted ? 'Muted' : 'Listening'
    case 'assistant-speaking':
      return `${name} is speaking`
    case 'ending':
      return 'Ending the call…'
    case 'ended':
      return 'Call ended'
    case 'error':
      return errorTitle(snap.error?.kind)
  }
}

/** A short headline per error; the snapshot's message carries the next step. */
export function errorTitle(kind: VoiceErrorKind | undefined): string {
  switch (kind) {
    case 'mic-denied':
      return 'Microphone is off for Tracely'
    case 'mic-missing':
      return 'No microphone available'
    case 'plan':
      return 'Voice is part of Pro'
    case 'daily-limit':
      return "Today's voice minutes are used"
    case 'busy':
      return 'Another call is open'
    case 'network':
      return "Couldn't connect"
    case 'ended-by-limit':
      return 'Time limit reached'
    case 'safety':
      return 'Call ended'
    default:
      return 'Something went wrong'
  }
}

/**
 * What the polite live region says. Turn-taking is left out on purpose: a
 * screen reader announcing every "speaking"/"listening" flip would talk over
 * the call itself.
 */
export function voiceAnnouncement(snap: Pick<VoiceSnapshot, 'state' | 'muted' | 'error'>, name: string): string {
  if (snap.state === 'listening' || snap.state === 'user-speaking' || snap.state === 'assistant-speaking') {
    return snap.muted ? `On a call with ${name}. Microphone muted.` : `On a call with ${name}. Microphone on.`
  }
  if (snap.state === 'error') return `${errorTitle(snap.error?.kind)}. ${snap.error?.message ?? ''}`.trim()
  return voiceStateLine(snap, name)
}

// ── The keyless demo (mock: true) ───────────────────────────────────────────

/** A mock call "connects" this long after the answer, like a real one. */
export const MOCK_CONNECT_MS = 900

/** Each persona's two demo lines, in its own voice (the greeting follows its recorded preview clip). */
const MOCK_LINES: Record<VoiceId, [string, string]> = {
  linden: [
    "Hi, I'm Linden! Your opening already has a clear point of view. What are you working on today?",
    'Mm-hm. Your claim is strong, but the study you cite only shows a link. What would it take to show the cause?'
  ],
  atlas: [
    "I'm Atlas. Read me the sentence you're least sure about, and we'll look at it slowly.",
    'Good. Now, what would a skeptical reader ask right after that sentence?'
  ],
  wren: [
    "Wren here. Right, tell me your claim in one sentence, and we'll see if the evidence agrees.",
    "Mm, I'm not sure that follows. Your source says linked to, and you've written causes. Why?"
  ],
  rory: [
    "Hiya, I'm Rory! Tell me what got you curious about this topic in the first place.",
    "Oh, that's a grand spark. Could your opening start with that moment instead of a definition?"
  ],
  kip: [
    "G'day, I'm Kip! Big essay? No worries. What's your main point, in one sentence?",
    "Nice, that's step one sorted. Next tiny step: find one source that measured exactly that."
  ],
  hollis: [
    "Hey there, I'm Hollis. No rush at all. How's the draft feeling so far?",
    "That's completely normal. Let's look at just that one paragraph together, nice and slow."
  ],
  sterling: [
    "Sterling, debate coach. Every claim you make, I'm going to argue against. Ready?",
    'Here is my counter: the study only shows a link. How do you answer a teacher who says that?'
  ]
}

const MOCK_USER_LINES = [
  "Can you look at my second paragraph? I'm not sure the evidence fits.",
  'So I need a source that actually measured it?'
]

export interface MockSegment {
  role: VoiceCaption['role']
  from: number
  to: number
  text: string
}

/** The demo's timeline in ms from session start: Tracer, the student, Tracer, the student. */
export function mockScript(voiceId: VoiceId): MockSegment[] {
  const [greet, reply] = MOCK_LINES[voiceId] ?? MOCK_LINES.linden
  const lines: [VoiceCaption['role'], string][] = [
    ['assistant', greet],
    ['user', MOCK_USER_LINES[0]],
    ['assistant', reply],
    ['user', MOCK_USER_LINES[1]]
  ]
  const segments: MockSegment[] = []
  let at = 500
  for (const [role, text] of lines) {
    // About three words a second, as people talk.
    const ms = Math.round((text.split(/\s+/).length / (role === 'assistant' ? 3.1 : 2.8)) * 1000)
    segments.push({ role, from: at, to: at + ms, text })
    at += ms + 700
  }
  return segments
}

export interface MockFrame {
  state: Extract<VoiceState, 'listening' | 'user-speaking' | 'assistant-speaking'>
  inputLevel: number
  outputLevel: number
  captions: VoiceCaption[]
}

/** A syllable-like envelope, deterministic in t (ms): a few bumps a second over a slow swell. */
function speechEnvelope(t: number, rate: number, seed: number): number {
  const s = t / 1000
  const syllables = Math.abs(Math.sin(s * Math.PI * rate + seed))
  const phrase = 0.62 + 0.38 * Math.sin(s * Math.PI * 0.9 + seed * 2)
  return Math.min(1, 0.18 + 0.7 * syllables * phrase)
}

/**
 * The demo at `t` ms after session start, as a pure function so a test can
 * pin it and a screenshot is the same every time. Words appear at speaking
 * pace; a line is final once its turn is over. Muted, the student's turns are
 * silent (the level stays at zero and the state stays listening).
 */
export function mockFrame(t: number, script: readonly MockSegment[], muted: boolean): MockFrame {
  let state: MockFrame['state'] = 'listening'
  let inputLevel = muted ? 0 : 0.02 + 0.015 * Math.abs(Math.sin(t / 370))
  let outputLevel = 0
  const captions: VoiceCaption[] = []
  script.forEach((seg, i) => {
    if (t < seg.from) return
    const words = seg.text.split(/\s+/)
    const shown = Math.min(words.length, Math.ceil(((t - seg.from) / (seg.to - seg.from)) * words.length))
    captions.push({ id: `m${i + 1}`, role: seg.role, text: words.slice(0, shown).join(' '), final: t >= seg.to })
    if (t >= seg.to) return
    if (seg.role === 'assistant') {
      state = 'assistant-speaking'
      outputLevel = speechEnvelope(t - seg.from, 5.2, i)
    } else if (!muted) {
      state = 'user-speaking'
      inputLevel = speechEnvelope(t - seg.from, 4.4, i + 1)
    }
  })
  return { state, inputLevel, outputLevel, captions }
}

// ── The real browser behind VoiceDeps ───────────────────────────────────────

function detectPlatform(): VoicePlatform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Mac/i.test(ua)) return 'mac'
  if (/Windows/i.test(ua)) return 'windows'
  return 'other'
}

/** One AudioContext per meter, closed with it, so nothing outlives the call. */
function browserMeter(stream: MediaStream): VoiceMeter | null {
  const Ctx = typeof AudioContext === 'undefined' ? null : AudioContext
  if (!Ctx) return null
  try {
    const ctx = new Ctx()
    void ctx.resume().catch(() => {})
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    return {
      rms() {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        return Math.sqrt(sum / buf.length)
      },
      dispose() {
        source.disconnect()
        void ctx.close().catch(() => {})
      }
    }
  } catch {
    return null
  }
}

function browserSpeaker(): VoiceSpeaker {
  let el: HTMLAudioElement | null = null
  return {
    play(stream) {
      el ??= new Audio()
      el.autoplay = true
      el.srcObject = stream
      void el.play().catch(() => {})
    },
    stop() {
      if (!el) return
      el.pause()
      el.srcObject = null
    }
  }
}

export function browserDeps(): VoiceDeps {
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createPeer: () => new RTCPeerConnection() as unknown as VoicePeer,
    createMeter: browserMeter,
    createSpeaker: browserSpeaker,
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
    platform: detectPlatform(),
    // Only the dev server (the preview harness, npm run dev) listens for the
    // harness's forced states; a built app never does.
    previewEvents: dev && typeof window !== 'undefined' ? window : null,
    onUnload(fn) {
      // pagehide: a reload or a real close. onHangUp: main closed the window,
      // which only hides it to the tray (no pagehide), or is quitting.
      window.addEventListener('pagehide', fn)
      let offHangUp: (() => void) | undefined
      try {
        offHangUp = window.tracely?.voice?.onHangUp?.(fn)
      } catch {
        /* no desktop bridge (web, preview): pagehide is all there is */
      }
      return () => {
        window.removeEventListener('pagehide', fn)
        offHangUp?.()
      }
    }
  }
}

// ── The engine ──────────────────────────────────────────────────────────────

function sameCaptions(a: readonly VoiceCaption[], b: readonly VoiceCaption[]): boolean {
  if (a.length !== b.length) return false
  const x = a[a.length - 1]
  const y = b[b.length - 1]
  return !x || (x.id === y.id && x.text === y.text && x.final === y.final)
}

/** The states of a connected call — import this rather than spelling the list again. */
export const LIVE_STATES: readonly VoiceState[] = ['listening', 'user-speaking', 'assistant-speaking']

export function createVoiceSession(options: VoiceSessionOptions): VoiceEngine {
  const { api, voiceId } = options
  const deps: VoiceDeps = { ...browserDeps(), ...options.deps }
  const listeners = new Set<(s: VoiceSnapshot) => void>()
  let snap: VoiceSnapshot = {
    state: 'idle',
    voiceId,
    muted: false,
    elapsedSec: 0,
    maxSec: 0,
    remainingTodaySec: null,
    inputLevel: 0,
    outputLevel: 0,
    captions: [],
    error: null,
    mock: false
  }

  // The call's parts; all null outside a call.
  let mic: MediaStream | null = null
  let peer: VoicePeer | null = null
  let channel: VoiceDataChannel | null = null
  let inMeter: VoiceMeter | null = null
  let outMeter: VoiceMeter | null = null
  let speaker: VoiceSpeaker | null = null
  let ticker: unknown = null
  let connectTimer: unknown = null
  let dropTimer: unknown = null

  let sessionId: string | null = null
  /** engine clock (ms) at session.started — the call's zero for the timer */
  let startedAt: number | null = null
  let mockScriptLines: MockSegment[] | null = null
  let captionLog: CaptionLog = EMPTY_CAPTIONS
  const inGate = createSpeechGate()
  const outGate = createSpeechGate()

  let startPromise: Promise<void> | null = null
  let finishPromise: Promise<void> | null = null
  /** set once the call is over (or being torn down): every await in start() checks it */
  let over = false
  /** the preview harness forced a state: the tick loop stops writing over it */
  let forced = false
  let result: VoiceCallResult | null = null

  function update(patch: Partial<VoiceSnapshot>): void {
    let changed = false
    for (const key of Object.keys(patch) as (keyof VoiceSnapshot)[]) {
      if (patch[key] !== snap[key]) changed = true
    }
    if (!changed) return
    snap = { ...snap, ...patch }
    for (const fn of [...listeners]) fn(snap)
  }

  function elapsedNow(): number {
    return startedAt === null ? 0 : Math.max(0, Math.floor((deps.now() - startedAt) / 1000))
  }

  function stopTimers(): void {
    if (ticker !== null) deps.clearInterval(ticker)
    if (connectTimer !== null) deps.clearTimeout(connectTimer)
    if (dropTimer !== null) deps.clearTimeout(dropTimer)
    ticker = connectTimer = dropTimer = null
  }

  /** Close every part of the call. Safe to repeat. */
  function teardownMedia(): void {
    stopTimers()
    if (channel) {
      channel.onmessage = null
      channel.onclose = null
      try {
        channel.close()
      } catch {
        /* already closed */
      }
    }
    if (peer) {
      peer.ontrack = null
      peer.onconnectionstatechange = null
      peer.onicegatheringstatechange = null
      try {
        peer.close()
      } catch {
        /* already closed */
      }
    }
    mic?.getTracks().forEach((t) => t.stop())
    inMeter?.dispose()
    outMeter?.dispose()
    speaker?.stop()
    mic = peer = channel = inMeter = outMeter = speaker = null
  }

  /**
   * End the call, once, whoever ends it: the student (err null), the server's
   * cap, a dropped connection, a failed start. Media stops at once; then the
   * server is told (non-fatal — closing the peer already ended the call, and
   * the server charges from its own meter), then the transcript is saved when
   * that is on.
   */
  function finish(err: VoiceError | null): Promise<void> {
    if (finishPromise) return finishPromise
    over = true
    // The promise exists before the body runs: the body's first update()
    // calls listeners synchronously, and one that awaits settled() then must
    // wait for this call's result rather than read a null one.
    let settle!: () => void
    finishPromise = new Promise<void>((resolve) => (settle = resolve))
    void (async () => {
      try {
        await finishBody(err)
      } finally {
        settle()
      }
    })()
    return finishPromise
  }

  async function finishBody(err: VoiceError | null): Promise<void> {
    const seconds = elapsedNow()
    const captions = captionLog.captions.map((c) => (c.final ? c : { ...c, final: true }))
    captionLog = { ...captionLog, captions }
    teardownMedia()
    update({
      state: err ? 'error' : 'ending',
      error: err,
      inputLevel: 0,
      outputLevel: 0,
      elapsedSec: seconds,
      captions
    })
    const id = sessionId
    const turns = transcriptTurns(captions)
    // Not after a safety stop: the transcript may hold what tripped the filter,
    // and a saved one is re-sent as history with the next typed message.
    const save = turns.length > 0 && err?.kind !== 'safety' && options.shouldSaveTranscript?.() === true
    // Both requests leave in this same tick: the save is local and must not
    // wait seconds for the server's hang-up, or a quit or reload in between
    // (the page is going away) loses the transcript.
    const ended: Promise<number | null> = id
      ? attempt(() => api.end(id)).then((r) => serverSecondsFrom(r), () => null)
      : Promise.resolve(null)
    const saving: Promise<boolean | null> = save
      ? attempt(() => api.saveTranscript(turns, options.conversationId?.() ?? undefined)).then(
          (r) => r.saved,
          () => false
        )
      : Promise.resolve(null)
    const [serverSeconds, transcriptSaved] = await Promise.all([ended, saving])
    result = { seconds, transcriptSaved, serverSeconds }
    if (!err) update({ state: 'ended' })
    // An error stays the snapshot; tell subscribers once more so the ones
    // that read result() see it now that it exists.
    else for (const fn of [...listeners]) fn(snap)
  }

  function onStarted(): void {
    if (over || snap.state !== 'connecting') return
    if (connectTimer !== null) deps.clearTimeout(connectTimer)
    connectTimer = null
    startedAt = deps.now()
    update({ state: 'listening', elapsedSec: 0 })
  }

  function onServerEvent(data: unknown): void {
    let ev: { type?: unknown; delta?: unknown; start_ms?: unknown; end_ms?: unknown; reason?: unknown }
    const text = frameText(data)
    if (text === null) return
    try {
      ev = JSON.parse(text)
    } catch {
      return
    }
    if (over || !ev || typeof ev !== 'object') return
    switch (ev.type) {
      case 'session.started':
        onStarted()
        return
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        if (typeof ev.delta !== 'string') return
        const role = ev.type === 'session.input_transcript.delta' ? 'user' : 'assistant'
        captionLog = addTranscriptDelta(
          captionLog,
          role,
          ev.delta,
          deps.now(),
          typeof ev.start_ms === 'number' ? ev.start_ms : undefined,
          typeof ev.end_ms === 'number' ? ev.end_ms : undefined
        )
        if (!forced) update({ captions: captionLog.captions })
        return
      }
      case 'session.closed':
        void finish(closedError(ev.reason, snap.maxSec, snap.remainingTodaySec))
        return
      // 'error' is deliberately not an end: some moderation errors only cut
      // Tracer off mid-sentence and the call carries on. If the call does end,
      // session.closed or the peer closing says so.
      default:
        return
    }
  }

  function onPeerState(): void {
    const s = peer?.connectionState
    if (over || !s) return
    if (s === 'failed' || s === 'closed') {
      void finish(closedError('connection_lost', snap.maxSec, snap.remainingTodaySec))
    } else if (s === 'disconnected') {
      // Often recovers by itself (a Wi-Fi hiccup); give it a few seconds.
      if (dropTimer === null) {
        dropTimer = deps.setTimeout(() => {
          dropTimer = null
          if (peer?.connectionState === 'disconnected') onPeerStateLost()
        }, 4000)
      }
    } else if (dropTimer !== null) {
      deps.clearTimeout(dropTimer)
      dropTimer = null
    }
  }

  function onPeerStateLost(): void {
    void finish(closedError('connection_lost', snap.maxSec, snap.remainingTodaySec))
  }

  function onRemoteTrack(ev: { streams: readonly MediaStream[]; track: MediaStreamTrack }): void {
    if (over) return
    const stream = ev.streams[0] ?? new MediaStream([ev.track])
    speaker ??= deps.createSpeaker()
    speaker.play(stream)
    outMeter?.dispose()
    outMeter = deps.createMeter(stream)
  }

  /** 25 times a second: levels, who is speaking, the timer, the caption pause rule, the cap. */
  function tick(): void {
    if (over || forced) return
    const now = deps.now()
    if (mockScriptLines) {
      if (startedAt === null || now < startedAt) return
      const f = mockFrame(now - startedAt, mockScriptLines, snap.muted)
      if (!sameCaptions(f.captions, captionLog.captions)) captionLog = { ...captionLog, captions: f.captions }
      update({
        state: f.state,
        inputLevel: smoothLevel(snap.inputLevel, f.inputLevel),
        outputLevel: smoothLevel(snap.outputLevel, f.outputLevel),
        elapsedSec: elapsedNow(),
        captions: captionLog.captions
      })
    } else {
      const inputLevel = smoothLevel(snap.inputLevel, snap.muted ? 0 : rmsToLevel(inMeter?.rms() ?? 0))
      const outputLevel = smoothLevel(snap.outputLevel, rmsToLevel(outMeter?.rms() ?? 0))
      if (!LIVE_STATES.includes(snap.state)) {
        update({ inputLevel, outputLevel })
        return
      }
      const userOn = inGate.update(inputLevel, now) && !snap.muted
      const assistantOn = outGate.update(outputLevel, now)
      captionLog = settleCaptions(captionLog, now)
      update({
        state: assistantOn ? 'assistant-speaking' : userOn ? 'user-speaking' : 'listening',
        inputLevel,
        outputLevel,
        elapsedSec: elapsedNow(),
        captions: captionLog.captions
      })
    }
    // The server closes the call at its cap; if that close never arrives, hang up anyway.
    if (snap.maxSec > 0 && snap.elapsedSec >= snap.maxSec + CAP_GRACE_SEC) {
      void finish(closedError('expired', snap.maxSec, snap.remainingTodaySec))
    }
  }

  function waitForIce(pc: VoicePeer): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        deps.clearTimeout(timer)
        pc.onicegatheringstatechange = null
        resolve()
      }
      const timer = deps.setTimeout(done, ICE_GATHER_TIMEOUT_MS)
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') done()
      }
    })
  }

  async function runStart(): Promise<void> {
    forced = false
    update({ state: 'requesting-mic', error: null, captions: [], elapsedSec: 0 })

    // 1. The OS permission. A refusal never rejects; an IPC failure reads as unknown.
    const status = await api.ensureMic().then((r) => r.status, () => 'unknown' as const)
    if (over) return
    if (status === 'denied' || status === 'restricted') {
      return finish({ kind: 'mic-denied', message: micDeniedMessage(deps.platform) })
    }

    // 2. The microphone itself, with the browser's echo/noise/gain processing.
    let stream: MediaStream
    try {
      stream = await deps.getUserMedia(MIC_CONSTRAINTS)
    } catch (e) {
      return finish(micError(e, deps.platform))
    }
    if (over) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    mic = stream
    update({ state: 'connecting' })

    // 3. The peer: mic track out, the event channel BEFORE the offer.
    const pc = deps.createPeer()
    peer = pc
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream)
    const dc = pc.createDataChannel(DATA_CHANNEL_LABEL)
    channel = dc
    dc.onmessage = (ev) => onServerEvent(ev.data)
    dc.onclose = () => {
      if (!over) void finish(closedError('connection_lost', snap.maxSec, snap.remainingTodaySec))
    }
    pc.ontrack = onRemoteTrack
    pc.onconnectionstatechange = onPeerState
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitForIce(pc)
    if (over) return
    const sdp = pc.localDescription?.sdp ?? offer.sdp ?? ''

    // 4. The server: main adds the draft; the answer comes back the same way.
    let res: VoiceStartResponse
    try {
      res = await api.start({ sdp, voiceId })
    } catch (e) {
      return finish(startError(e))
    }
    if (over) {
      // Ended while the server was answering: hang up the session it just opened.
      await api.end(res.sessionId).catch(() => undefined)
      return
    }
    sessionId = res.sessionId
    update({ maxSec: res.maxSeconds, remainingTodaySec: res.remainingSeconds, mock: res.mock === true })
    inMeter = deps.createMeter(stream)

    if (res.mock === true || !res.sdp) {
      // Keyless: no call to connect. Let go of the mic and the peer (nothing
      // would hear them) and play the demo conversation instead.
      teardownMedia()
      mockScriptLines = mockScript(voiceId)
      startedAt = deps.now() + MOCK_CONNECT_MS
      ticker = deps.setInterval(tick, TICK_MS)
      return
    }

    // 5. Connect, then wait for session.started on the channel.
    await pc.setRemoteDescription({ type: 'answer', sdp: res.sdp })
    if (over) return
    connectTimer = deps.setTimeout(() => {
      connectTimer = null
      if (!over && snap.state === 'connecting') {
        void finish({ kind: 'network', message: "The call didn't connect. Check your internet connection, then try again." })
      }
    }, CONNECT_TIMEOUT_MS)
    ticker = deps.setInterval(tick, TICK_MS)
  }

  async function start(): Promise<void> {
    if (startPromise || over) return startPromise ?? undefined
    startPromise = runStart().catch((e: unknown) => {
      // createOffer / setLocalDescription / setRemoteDescription: a broken
      // peer. The browser's words ("Failed to execute 'setRemoteDescription'
      // on 'RTCPeerConnection': …") are for the console, not the student.
      console.warn('[voice] peer setup failed', e)
      return finish({ kind: 'server', message: "Tracely couldn't set up the call. Try again in a moment." })
    })
    return startPromise
  }

  function end(): Promise<void> {
    if (!startPromise) {
      // Nothing was started. In the preview a forced state can still be "hung up".
      if (forced && snap.state !== 'idle') update({ state: 'ended', inputLevel: 0, outputLevel: 0 })
      return Promise.resolve()
    }
    return finish(null)
  }

  function setMuted(muted: boolean): void {
    mic?.getAudioTracks().forEach((t) => {
      t.enabled = !muted
    })
    update(muted ? { muted, inputLevel: 0 } : { muted })
  }

  // The preview harness's driver: window.__previewEmitVoice(partial) forces a
  // state for review and screenshots, and the demo stops writing over it.
  const onPreview = (ev: Event): void => {
    const detail = (ev as CustomEvent<Partial<VoiceSnapshot>>).detail
    if (!detail || typeof detail !== 'object') return
    forced = true
    update(detail)
  }
  deps.previewEvents?.addEventListener(PREVIEW_VOICE_EVENT, onPreview)
  const offUnload = deps.onUnload(() => {
    if (startPromise) void finish(null)
  })

  let disposed = false
  return {
    start,
    end,
    setMuted,
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    result: () => result,
    settled: async () => {
      await finishPromise
      return result
    },
    dispose() {
      if (disposed) return
      disposed = true
      deps.previewEvents?.removeEventListener(PREVIEW_VOICE_EVENT, onPreview)
      offUnload()
      if (startPromise) void finish(null)
      else {
        // Never started: it never will (React StrictMode disposes the first
        // engine it makes; a start queued for that one must not open a call).
        over = true
        stopTimers()
      }
    }
  }
}
