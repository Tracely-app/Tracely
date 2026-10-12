import type {
  VoiceEligibilityReason,
  VoiceEligibilityResponse,
  VoiceEndResponse,
  VoiceSaveTranscriptRequest,
  VoiceSaveTranscriptResponse,
  VoiceStartRequest,
  VoiceStartResponse
} from '@shared/ipc-contract'
import { voiceById } from '../../../shared/voices.ts'
import { VOICE_DEFAULT_MAX_SECONDS } from '../../../shared/voicePolicy.ts'
import { VoiceCallError, voiceIpcErrorFrom, type FailureLike } from './voiceErrors.ts'
import { VOICE_MAX_CONTEXT_CHARS } from './voiceSchemas.ts'
import { transcriptMessages, type TranscriptMessage } from './transcript.ts'

/**
 * Main's half of a Tracer Voice call, with its dependencies injected so the
 * whole of it runs under `npm test` (index.ts wires the real ones).
 *
 * Main never touches audio. It trades the renderer's offer SDP for OpenAI's
 * answer through the Tracely server — adding the latest draft as context on
 * the way, because main is what can read the documents table — then hangs up
 * on request and files the transcript into the Tracer chat.
 */

/**
 * The server creates the OpenAI session (up to its CREATE_TIMEOUT_MS, 15 s)
 * and then attaches its meter (ATTACH_TIMEOUT_MS, 5 s) before answering, so a
 * healthy start is a few seconds and a slow one that still succeeds can take
 * 20. This deadline sits above that sum with room for the network, or a slow
 * success would be abandoned and its paid set-up wasted (pinned against the
 * server's numbers in voiceSession.test.ts). callServer's own deadline is a
 * minute, which is far longer than anyone will watch "Connecting…".
 */
export const VOICE_START_TIMEOUT_MS = 25_000
/** Hanging up must never hold the UI; the server also closes on its own. */
export const VOICE_END_TIMEOUT_MS = 8_000
/** The eligibility check reads a few counters; anything slower is not worth holding the voice view for. */
export const VOICE_ELIGIBILITY_TIMEOUT_MS = 8_000

export type VoiceEndpoint = 'voice/session' | 'voice/end' | 'voice/eligibility'

export interface VoiceServiceDeps {
  callServer<T>(endpoint: VoiceEndpoint, body: Record<string, unknown>): Promise<T>
  /** services/ai/tracer.ts currentContext — the latest draft, already capped. */
  currentContext(): string
  /** Appends to the Tracer conversation; false (or a throw) when it could not. */
  appendTranscript(messages: TranscriptMessage[], conversationId?: string): boolean
  startTimeoutMs?: number
  endTimeoutMs?: number
  eligibilityTimeoutMs?: number
}

export interface VoiceService {
  start(req: VoiceStartRequest): Promise<VoiceStartResponse>
  end(sessionId: string): Promise<VoiceEndResponse>
  saveTranscript(req: VoiceSaveTranscriptRequest): VoiceSaveTranscriptResponse
  /**
   * May this account start a call now? Clears the line first, the way a start
   * does (a call main opened and never saw end would otherwise answer busy).
   * Rejects with a VoiceCallError only when it could not ask.
   */
  eligibility(): Promise<VoiceEligibilityResponse>
  /** Hangs up whatever call main last started and has not seen ended. Never throws. */
  endOpen(): Promise<void>
  /** The call main last started and has not seen ended, if any. */
  openSessionId(): string | null
}

/** What /api/voice/session answers, before anything in it is trusted. */
interface RawStart {
  sdp?: unknown
  sessionId?: unknown
  voice?: { id?: unknown; name?: unknown } | null
  maxSeconds?: unknown
  remainingSeconds?: unknown
  remainingMonthSeconds?: unknown
  resetAt?: unknown
  mock?: unknown
}

const TRUNCATED = '\n[…truncated]'

/** The draft, cut to what the server accepts (it 400s anything longer). */
export function clipVoiceContext(context: string): string {
  if (context.length <= VOICE_MAX_CONTEXT_CHARS) return context
  return context.slice(0, VOICE_MAX_CONTEXT_CHARS - TRUNCATED.length) + TRUNCATED
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** An ISO-8601 instant the renderer can read back, or null. */
export function isoInstant(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || !/^[0-9][0-9T:.+\-Z]*$/.test(value)) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/**
 * The server's answer as the contract promises it, or a `server` error. A
 * real call without an answer SDP has nothing to connect to, so it is refused
 * here rather than handed to a peer connection that would hang on it.
 */
export function normalizeStart(raw: RawStart | null | undefined, req: VoiceStartRequest): VoiceStartResponse {
  const r = raw ?? {}
  const sessionId = typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : null
  const mock = r.mock === true
  const sdp = typeof r.sdp === 'string' && r.sdp.startsWith('v=0') ? r.sdp : undefined
  if (!sessionId || (!mock && !sdp)) {
    throw new VoiceCallError({ kind: 'server', message: "Tracely answered without a call to connect. Try again." })
  }
  const persona = voiceById(typeof r.voice?.id === 'string' ? r.voice.id : req.voiceId)
  const name = typeof r.voice?.name === 'string' && r.voice.name ? r.voice.name : persona.name
  const maxSeconds = seconds(r.maxSeconds) || VOICE_DEFAULT_MAX_SECONDS
  const response: VoiceStartResponse = {
    sessionId,
    voice: { id: persona.id, name },
    maxSeconds,
    remainingSeconds: seconds(r.remainingSeconds) ?? maxSeconds
  }
  const month = seconds(r.remainingMonthSeconds)
  if (month !== null) response.remainingMonthSeconds = month
  const resetAt = isoInstant(r.resetAt)
  if (resetAt) response.resetAt = resetAt
  if (sdp) response.sdp = sdp
  if (mock) response.mock = true
  return response
}

/** What /api/voice/eligibility answers, before anything in it is trusted. */
interface RawEligibility {
  allowed?: unknown
  reason?: unknown
  message?: unknown
  maxSeconds?: unknown
  remainingSeconds?: unknown
  remainingMonthSeconds?: unknown
  resetAt?: unknown
}

const ELIGIBILITY_REASONS: readonly VoiceEligibilityReason[] = ['plan', 'daily-limit', 'monthly-limit', 'off', 'busy']

/** A refusal's sentence when the server sent none (the renderer words plan and the limits itself). */
const REFUSAL_FALLBACK: Record<VoiceEligibilityReason, string> = {
  plan: 'Voice is part of Pro.',
  'daily-limit': "You've used today's voice minutes.",
  'monthly-limit': "You've used this month's voice minutes.",
  off: "Voice isn't available right now.",
  busy: 'Another voice call is still open on this account. Wait a minute for it to close, then try again.'
}

/**
 * The server's eligibility answer as the contract promises it. A reason this
 * build doesn't know (a newer server) is `off`, with the server's sentence;
 * an answer that is neither allowed nor refused is a `server` error.
 */
export function normalizeEligibility(raw: RawEligibility | null | undefined): VoiceEligibilityResponse {
  const r = raw ?? {}
  const resetAt = isoInstant(r.resetAt)
  if (r.allowed === true) {
    const maxSeconds = seconds(r.maxSeconds) || VOICE_DEFAULT_MAX_SECONDS
    const ok: VoiceEligibilityResponse = { allowed: true, maxSeconds, remainingSeconds: seconds(r.remainingSeconds) ?? maxSeconds }
    const month = seconds(r.remainingMonthSeconds)
    if (month !== null) ok.remainingMonthSeconds = month
    if (resetAt) ok.resetAt = resetAt
    return ok
  }
  if (r.allowed === false) {
    const reason = ELIGIBILITY_REASONS.find((x) => x === r.reason) ?? 'off'
    const message = typeof r.message === 'string' && r.message.trim() ? r.message.trim() : REFUSAL_FALLBACK[reason]
    const refused: VoiceEligibilityResponse = { allowed: false, reason, message }
    if (resetAt) refused.resetAt = resetAt
    return refused
  }
  throw new VoiceCallError({ kind: 'server', message: "Tracely's voice check sent an answer this app can't read." })
}

/**
 * A failed eligibility call that is still an answer: the server refused with
 * an HTTP error instead of `allowed: false` (an account limit, voice switched
 * off, the server's daily budget spent). null when it is a real failure.
 */
export function refusalFromFailure(failure: FailureLike): VoiceEligibilityResponse | null {
  const resetAt = isoInstant(failure.resetAt)
  const refuse = (reason: VoiceEligibilityReason, message = REFUSAL_FALLBACK[reason]): VoiceEligibilityResponse =>
    resetAt ? { allowed: false, reason, message, resetAt } : { allowed: false, reason, message }
  switch (failure.kind) {
    case 'plan_limit':
      return refuse('plan')
    case 'voice_daily':
      return refuse('daily-limit')
    case 'voice_monthly':
      return refuse('monthly-limit')
    case 'voice_busy':
      return refuse('busy')
    case 'voice_off':
    case 'no_key':
      return refuse('off')
    case 'budget':
      return refuse('off', "Voice is resting for today: Tracely's daily budget is used up. Try again tomorrow.")
    default:
      return null
  }
}

/** Resolves or rejects with `promise`, or rejects after `ms` and calls `onLate`. */
function withDeadline<T>(promise: Promise<T>, ms: number, onLate: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onLate()
      reject(new Error('deadline'))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export function createVoiceService(deps: VoiceServiceDeps): VoiceService {
  const startMs = deps.startTimeoutMs ?? VOICE_START_TIMEOUT_MS
  const endMs = deps.endTimeoutMs ?? VOICE_END_TIMEOUT_MS
  const eligibilityMs = deps.eligibilityTimeoutMs ?? VOICE_ELIGIBILITY_TIMEOUT_MS
  // The server allows one open call per account and answers a second start
  // with 409 voice_busy. A renderer that reloaded mid-call (or crashed) never
  // sent its end, so main remembers what it opened and closes it first. It is
  // forgotten only once the server confirms the end: a hang-up that failed
  // (offline after a drop, sleep) is retried before the next start.
  let open: string | null = null
  /** Ends in flight, by session id: a second end of the same call joins the first. */
  const ending = new Map<string, Promise<VoiceEndResponse>>()
  /** The start in flight, if any: a new start waits for it rather than racing it. */
  let starting: Promise<unknown> | null = null

  function end(sessionId: string): Promise<VoiceEndResponse> {
    const inFlight = ending.get(sessionId)
    if (inFlight) return inFlight
    const p = (async (): Promise<VoiceEndResponse> => {
      try {
        const raw = await withDeadline(
          deps.callServer<{ seconds?: unknown }>('voice/end', { sessionId }),
          endMs,
          () => {}
        )
        if (open === sessionId) open = null
        return { seconds: seconds(raw?.seconds) ?? 0 }
      } catch (error) {
        throw new VoiceCallError(voiceIpcErrorFrom(error, 'end'))
      } finally {
        ending.delete(sessionId)
      }
    })()
    ending.set(sessionId, p)
    return p
  }

  /** Every end in flight, settled (each has its own deadline). */
  function endsSettled(): Promise<unknown> {
    return Promise.allSettled([...ending.values()])
  }

  function start(req: VoiceStartRequest): Promise<VoiceStartResponse> {
    const previous = starting
    const p = runStart(req, previous)
    const mine: Promise<unknown> = p.catch(() => undefined)
    starting = mine
    void mine.then(() => {
      if (starting === mine) starting = null
    })
    return p
  }

  async function runStart(req: VoiceStartRequest, previous: Promise<unknown> | null): Promise<VoiceStartResponse> {
    // A start still in flight belongs to a renderer that has since given up
    // on it (End during "Connecting…", then Talk again): let it finish, then
    // close what it opened below, rather than answer this one busy.
    await clearLine(previous)

    let context = ''
    try {
      context = clipVoiceContext(deps.currentContext())
    } catch {
      // No draft to read is not a reason to refuse a conversation.
    }

    const pending = deps.callServer<RawStart>('voice/session', { sdp: req.sdp, voiceId: req.voiceId, context })
    let late = false
    let raw: RawStart
    try {
      raw = await withDeadline(pending, startMs, () => (late = true))
    } catch (error) {
      if (!late) throw new VoiceCallError(voiceIpcErrorFrom(error, 'start'))
      // The server may still answer — with a session nobody will ever
      // connect to, holding the account's one line and its reservation until
      // the cap. Hang that one up the moment it arrives.
      pending.then(
        (answer) => {
          const id = answer?.sessionId
          if (typeof id === 'string' && id) void end(id).catch(() => undefined)
        },
        () => undefined
      )
      throw new VoiceCallError({ kind: 'network', message: 'Tracely took too long to start the call. Try again.' })
    }

    let response: VoiceStartResponse
    try {
      response = normalizeStart(raw, req)
    } catch (error) {
      // A session id with no answer SDP is a session the server opened and
      // nobody can join: close it rather than let it hold the line.
      const id = raw?.sessionId
      if (typeof id === 'string' && id) void end(id).catch(() => undefined)
      throw error
    }
    open = response.sessionId
    return response
  }

  /**
   * Waits out a start still in flight (`previous`), then makes sure the
   * account's one line is free of anything main opened: the server holds it
   * until a hang-up it was just sent completes ("Try again" right after an
   * error races it otherwise), and a call never seen ending is ended now.
   */
  async function clearLine(previous: Promise<unknown> | null): Promise<void> {
    if (previous) await previous
    await endsSettled()
    if (open) await end(open).catch(() => undefined)
  }

  async function eligibility(): Promise<VoiceEligibilityResponse> {
    // Asked only when no call is live in a renderer (the voice view before it
    // starts one, Settings with the Tracer panel gone), so anything main still
    // holds open is stale and would make the server answer busy.
    await clearLine(starting)
    let late = false
    let raw: RawEligibility
    try {
      raw = await withDeadline(
        deps.callServer<RawEligibility>('voice/eligibility', {}),
        eligibilityMs,
        () => (late = true)
      )
    } catch (error) {
      if (late) throw new VoiceCallError({ kind: 'network', message: 'Tracely took too long to answer. Try again.' })
      const failure: FailureLike = typeof error === 'object' && error !== null ? (error as FailureLike) : {}
      const refused = refusalFromFailure(failure)
      if (refused) return refused
      throw new VoiceCallError(voiceIpcErrorFrom(error, 'start'))
    }
    return normalizeEligibility(raw)
  }

  function saveTranscript(req: VoiceSaveTranscriptRequest): VoiceSaveTranscriptResponse {
    const messages = transcriptMessages(req.turns)
    if (messages.length === 0) return { saved: false }
    try {
      return { saved: deps.appendTranscript(messages, req.conversationId) === true }
    } catch {
      return { saved: false }
    }
  }

  return {
    start,
    end,
    saveTranscript,
    eligibility,
    endOpen: async () => {
      if (open) await end(open).catch(() => undefined)
    },
    openSessionId: () => open
  }
}
