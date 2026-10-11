import { systemPreferences } from 'electron'
import type { VoiceMicStatus } from '@shared/ipc-contract'
import { callServer } from '../ai/client'
import { currentContext } from '../ai/tracer'
import { appendVoiceTranscript } from '../storage/tracerRepo'
import { resolveMicAccess } from './micAccess'
import { createVoiceService, type VoiceEndpoint, type VoiceService } from './voiceSession'

/**
 * The voice service with its real dependencies: callServer for the two
 * /api/voice/* routes, Tracer's own draft context (the same text a typed turn
 * sends, capped again to the server's 4,000 characters), and the Tracer
 * conversation store. Everything with a decision in it is in voiceSession.ts.
 */
export const voiceService: VoiceService = createVoiceService({
  callServer: <T>(endpoint: VoiceEndpoint, body: Record<string, unknown>) => callServer<T>(endpoint, body),
  currentContext,
  appendTranscript: (messages, conversationId) => appendVoiceTranscript(conversationId, messages).length > 0
})

/** The OS microphone permission, asking once on macOS when nobody has yet. */
export function ensureMicAccess(): Promise<VoiceMicStatus> {
  return resolveMicAccess(process.platform, systemPreferences)
}
