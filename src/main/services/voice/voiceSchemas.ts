import { z } from 'zod'
import { VOICE_IDS } from './voiceSettings.ts'

/**
 * What the four voice channels accept from the renderer. A leaf (zod and the
 * persona ids only) so voiceSchemas.test.ts can load it; voiceHandlers.ts
 * parses every payload with these before anything reaches the service.
 *
 * The bounds match what POST /api/voice/session accepts (server/lib/voice.js),
 * so a payload the server would 400 is refused here first, with no round trip.
 */

/** An SDP offer is a few kB; the server refuses anything over this. */
export const VOICE_MAX_SDP_CHARS = 20_000
/** The draft sent as context. The server refuses anything over this. */
export const VOICE_MAX_CONTEXT_CHARS = 4_000
/**
 * Transcript bounds. A 15-minute call is a few hundred caption turns at most;
 * these exist so a runaway renderer cannot hand main megabytes, not to trim a
 * real conversation. Over-long turns are cut on save (VOICE_MAX_TURN_CHARS),
 * not refused — losing the end of one long answer beats losing the whole call.
 */
export const VOICE_MAX_TRANSCRIPT_TURNS = 1_000
export const VOICE_MAX_TURN_INPUT_CHARS = 20_000
export const VOICE_MAX_TURN_CHARS = 4_000

export const voiceStartSchema = z.object({
  sdp: z
    .string()
    .max(VOICE_MAX_SDP_CHARS)
    .refine((s) => s.startsWith('v=0'), { message: 'sdp must be an SDP offer (v=0…)' }),
  voiceId: z.enum(VOICE_IDS)
})

export const voiceEndSchema = z.object({
  sessionId: z.string().min(1).max(200)
})

export const voiceSaveTranscriptSchema = z.object({
  turns: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(VOICE_MAX_TURN_INPUT_CHARS)
      })
    )
    .max(VOICE_MAX_TRANSCRIPT_TURNS),
  conversationId: z.string().min(1).max(200).optional()
})

/** voice:ensure-mic takes nothing; the preload sends {}. */
export const voiceEnsureMicSchema = z.object({})
