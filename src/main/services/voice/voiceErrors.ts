import { formatVoiceIpcError, type VoiceIpcError, type VoiceIpcErrorKind } from '../../../shared/ipc-contract.ts'

/**
 * A failed voice call to the server, turned into something the voice UI can
 * show: one of five kinds, and a sentence a student can read.
 *
 * Reads the shape client.ts's ServerCallError carries (`stage`, `status`, the
 * server's `kind`, `message`) structurally, so this file stays a leaf `npm
 * test` can load — client.ts imports electron-side modules and cannot be.
 */
export interface FailureLike {
  stage?: string
  status?: number
  kind?: string
  message?: string
}

export type VoiceAction = 'start' | 'end'

/**
 * Thrown by the voice service; its message is the tagged form the renderer's
 * api wrapper parses back (shared/ipc-contract.ts formatVoiceIpcError), since
 * the bridge drops every property but the message.
 */
export class VoiceCallError extends Error {
  readonly kind: VoiceIpcErrorKind
  readonly plain: string

  constructor(error: VoiceIpcError) {
    super(formatVoiceIpcError(error))
    this.name = 'VoiceCallError'
    this.kind = error.kind
    this.plain = error.message
  }
}

/** The server's error kinds for /api/voice/* (SPEC "HTTP contract"), by what the UI shows. */
export function voiceKindFor(failure: FailureLike): VoiceIpcErrorKind {
  if (failure.kind === 'plan_limit') return 'plan'
  if (failure.kind === 'voice_daily') return 'daily-limit'
  if (failure.kind === 'voice_busy') return 'busy'
  if (failure.stage === 'network' || failure.stage === 'timeout') return 'network'
  return 'server'
}

const PLAIN: Record<Exclude<VoiceIpcErrorKind, 'server'>, string> = {
  plan: 'Voice is part of Pro.',
  'daily-limit': "You've used today's voice minutes. They come back tomorrow.",
  busy: 'A voice call is already open on this account. End it, then try again.',
  network: "Couldn't reach Tracely. Check your connection and try again."
}

/**
 * Plain words for the `server` kinds worth naming. The server's own message is
 * written for a developer log as often as for a student, so the ones a student
 * can act on (or should stop retrying) get a sentence of their own.
 */
function serverSentence(failure: FailureLike, action: VoiceAction): string {
  const fallback =
    action === 'start'
      ? "Tracely couldn't start the call. Try again in a moment."
      : "Tracely couldn't end the call cleanly. It will close on its own."
  if (failure.stage === 'local') return 'This build has no Tracely server, so voice cannot start.'
  if (failure.status === 404) return "Voice isn't available on this Tracely server yet."
  switch (failure.kind) {
    case 'rate':
      return 'Too many tries in a row. Wait a minute, then try again.'
    case 'budget':
      return "Voice is resting for today: Tracely's daily budget is used up. Try again tomorrow."
    case 'no_key':
    case 'voice_off':
      return "Voice isn't available right now."
    case 'upstream':
      return "OpenAI couldn't open the call. Try again in a moment."
    default:
      return fallback
  }
}

/** Any failure from a voice server call, as the typed error the renderer shows. */
export function voiceIpcErrorFrom(error: unknown, action: VoiceAction): VoiceIpcError {
  if (error instanceof VoiceCallError) return { kind: error.kind, message: error.plain }
  const failure: FailureLike = typeof error === 'object' && error !== null ? (error as FailureLike) : {}
  const kind = voiceKindFor(failure)
  if (kind === 'server') return { kind, message: serverSentence(failure, action) }
  // The server's own sentence for these three ("Voice is part of Pro.") is the
  // one the spec wrote for students; ours is only the fallback — including for
  // the placeholder readErrorEnvelope writes when the body had no message.
  const raw = kind !== 'network' && typeof failure.message === 'string' ? failure.message.trim() : ''
  const serverMessage = /^Tracely server request failed/.test(raw) ? '' : raw
  return { kind, message: serverMessage || PLAIN[kind] }
}
