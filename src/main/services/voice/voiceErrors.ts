import {
  VOICE_KIND_COPY,
  formatVoiceIpcError,
  type VoiceIpcError,
  type VoiceIpcErrorKind
} from '../../../shared/ipc-contract.ts'

/**
 * A failed voice call to the server, turned into something the voice UI can
 * show: one of six kinds, and a sentence a student can read (and, for the
 * two limits, when they lift).
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
  /** When a quota lifts (ISO-8601) — ServerCallError.resetAt, from voice_daily / voice_monthly. */
  resetAt?: string
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
  readonly resetAt?: string

  constructor(error: VoiceIpcError) {
    super(formatVoiceIpcError(error))
    this.name = 'VoiceCallError'
    this.kind = error.kind
    this.plain = error.message
    if (error.resetAt) this.resetAt = error.resetAt
  }
}

/** The server's error kinds for /api/voice/* (SPEC "HTTP contract"), by what the UI shows. */
export function voiceKindFor(failure: FailureLike): VoiceIpcErrorKind {
  if (failure.kind === 'plan_limit') return 'plan'
  if (failure.kind === 'voice_daily') return 'daily-limit'
  if (failure.kind === 'voice_monthly') return 'monthly-limit'
  if (failure.kind === 'voice_busy') return 'busy'
  if (failure.stage === 'network' || failure.stage === 'timeout') return 'network'
  return 'server'
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
  // Every sentence below is about starting; a failed hang-up only ever needs
  // to say the call will end anyway (the server closes it at its cap).
  if (action === 'end') return fallback
  if (failure.status === 404) return "Voice isn't available on this Tracely server yet."
  switch (failure.kind) {
    // appGate's per-minute limiter answers 429 rate_limit ('rate' kept as an alias).
    case 'rate_limit':
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
  if (error instanceof VoiceCallError) {
    const known: VoiceIpcError = { kind: error.kind, message: error.plain }
    if (error.resetAt) known.resetAt = error.resetAt
    return known
  }
  const failure: FailureLike = typeof error === 'object' && error !== null ? (error as FailureLike) : {}
  const kind = voiceKindFor(failure)
  if (kind === 'server') return { kind, message: serverSentence(failure, action) }
  // The account kinds have one wording, shared with the renderer that shows it.
  // The limits also say when they lift; the renderer puts that in local time.
  const limit = kind === 'daily-limit' || kind === 'monthly-limit'
  if (limit && typeof failure.resetAt === 'string' && failure.resetAt) {
    return { kind, message: VOICE_KIND_COPY[kind], resetAt: failure.resetAt }
  }
  return { kind, message: VOICE_KIND_COPY[kind] }
}
