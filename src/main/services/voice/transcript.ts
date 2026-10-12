import type { VoiceTranscriptTurn } from '@shared/ipc-contract'
import type { TracerRole } from '@shared/types'
import { VOICE_MAX_TURN_CHARS } from './voiceSchemas.ts'

/** A transcript turn in the Tracer chat's own vocabulary, ready to store. */
export interface TranscriptMessage {
  role: TracerRole
  content: string
}

/**
 * A call's final captions as Tracer chat messages.
 *
 * - `assistant` becomes `tracer`, the chat's word for it; nothing is prefixed
 *   (the message type has no field to mark a message as spoken, and a "(spoken)"
 *   tag in the text would be sent back to the model as history on the next turn).
 * - Blank turns are dropped, whitespace inside a turn collapses.
 * - Consecutive turns by the same speaker join into one message: the live
 *   transcript splits a turn wherever the speaker paused, and a chat that
 *   alternates reads — and is re-sent as history — far better than ten
 *   one-line bubbles from Tracer in a row.
 * - A message over VOICE_MAX_TURN_CHARS is cut with an ellipsis rather than
 *   refused, so one long answer cannot lose the whole call.
 */
export function transcriptMessages(turns: readonly VoiceTranscriptTurn[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const turn of turns) {
    const text = turn.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const role: TracerRole = turn.role === 'user' ? 'user' : 'tracer'
    const last = out[out.length - 1]
    if (last && last.role === role) last.content = `${last.content} ${text}`
    else out.push({ role, content: text })
  }
  for (const m of out) {
    if (m.content.length > VOICE_MAX_TURN_CHARS) m.content = `${m.content.slice(0, VOICE_MAX_TURN_CHARS - 1).trimEnd()}…`
  }
  return out
}

/**
 * `count` ISO timestamps, strictly increasing, all after `lastIso`.
 *
 * tracer_messages is ordered by created_at alone, and a transcript is written
 * in one go — at `new Date()` per row, a burst of inserts shares a millisecond
 * and the order of a tie is SQLite's to choose. One millisecond apart, starting
 * no earlier than one past the conversation's newest message, keeps the
 * transcript in spoken order and after everything already in the chat (a
 * clock that stepped backwards included).
 */
export function transcriptTimestamps(lastIso: string | null, nowMs: number, count: number): string[] {
  const lastMs = lastIso ? Date.parse(lastIso) : Number.NaN
  let t = Number.isFinite(lastMs) ? Math.max(nowMs, lastMs + 1) : nowMs
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(new Date(t++).toISOString())
  return out
}
