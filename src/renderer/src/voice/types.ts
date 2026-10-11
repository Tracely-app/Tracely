/* The contract between Tracer's voice engine (voice/session.ts) and the UI
 * that draws it (components/voice/*). The engine owns the WebRTC call; the UI
 * only reads snapshots and calls the handle. Keep both sides to this file.
 */
import type { VoiceId } from '@shared/voices'

export type VoiceState =
  | 'idle'
  | 'requesting-mic'
  | 'connecting'
  | 'listening'
  | 'user-speaking'
  | 'assistant-speaking'
  | 'ending'
  | 'ended'
  | 'error'

export interface VoiceCaption {
  id: string
  role: 'user' | 'assistant'
  text: string
  final: boolean
}

export type VoiceErrorKind =
  | 'mic-denied'
  | 'mic-missing'
  | 'plan'
  | 'daily-limit'
  | 'busy'
  | 'network'
  | 'server'
  | 'ended-by-limit'
  /** OpenAI's safety filter ended the call (session.closed reason "content"). */
  | 'safety'

/**
 * Something the student should know during a call that does not end it; the
 * state line says it in place of whose turn it is. 'ended-idle' is the one
 * that outlives the call: it explains an 'ended' state the student didn't
 * cause.
 */
export type VoiceNotice =
  | 'still-there' // nothing heard for a while: the call ends in a few seconds unless they talk
  | 'mic-silent' // the microphone stopped sending sound
  | 'answer-blocked' // a safety check cut the persona off mid-answer; the call goes on
  | 'no-playback' // the persona's voice can't be played
  | 'ended-idle' // the call was ended after a quiet spell

export interface VoiceSnapshot {
  state: VoiceState
  voiceId: VoiceId
  muted: boolean
  elapsedSec: number
  maxSec: number
  remainingTodaySec: number | null
  /** 0..1, smoothed microphone level */
  inputLevel: number
  /** 0..1, smoothed level of the voice speaking back */
  outputLevel: number
  captions: VoiceCaption[]
  error: { kind: VoiceErrorKind; message: string } | null
  /** true when the server runs keyless (TRACELY_MOCK) or in the preview harness */
  mock: boolean
  /** A non-fatal problem worth saying (VoiceNotice); absent or null when there is none. */
  notice?: VoiceNotice | null
}

export interface VoiceSessionHandle {
  start(): Promise<void>
  end(): Promise<void>
  setMuted(muted: boolean): void
  getSnapshot(): VoiceSnapshot
  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void
}
