import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  VoiceEndResponse,
  VoiceEnsureMicResponse,
  VoiceSaveTranscriptResponse,
  VoiceStartResponse
} from '@shared/ipc-contract'
import { ensureMicAccess, voiceService } from '../services/voice'
import {
  voiceEndSchema,
  voiceEnsureMicSchema,
  voiceSaveTranscriptSchema,
  voiceStartSchema
} from '../services/voice/voiceSchemas'

/**
 * Tracer Voice. Four channels, each parsed with its zod schema
 * (services/voice/voiceSchemas.ts) before the service sees it.
 *
 * The audio never comes through here: the renderer's RTCPeerConnection talks to
 * OpenAI directly once it has the answer SDP. What main owns is the OS mic
 * permission, the server round trip (the key stays on the server, and main is
 * what reads the draft to send as context), hanging up, and the transcript.
 *
 * start and end reject with a tagged message (`[voice:<kind>] …`) because the
 * bridge keeps nothing but the message; lib/api.ts turns it back into a kind.
 *
 * Deliberately NOT here: a session.setPermissionRequestHandler. Electron's
 * default grants media to our own renderer, and a handler written for the mic
 * would have to re-decide every other permission too.
 */
export function registerVoiceHandlers(): void {
  ipcMain.handle(IPC.VOICE_ENSURE_MIC, async (_event, raw): Promise<VoiceEnsureMicResponse> => {
    voiceEnsureMicSchema.parse(raw ?? {})
    return { status: await ensureMicAccess() }
  })

  ipcMain.handle(IPC.VOICE_START, async (_event, raw): Promise<VoiceStartResponse> => {
    const req = voiceStartSchema.parse(raw)
    return await voiceService.start(req)
  })

  ipcMain.handle(IPC.VOICE_END, async (_event, raw): Promise<VoiceEndResponse> => {
    const { sessionId } = voiceEndSchema.parse(raw)
    return await voiceService.end(sessionId)
  })

  ipcMain.handle(IPC.VOICE_SAVE_TRANSCRIPT, (_event, raw): VoiceSaveTranscriptResponse => {
    const req = voiceSaveTranscriptSchema.parse(raw)
    return voiceService.saveTranscript(req)
  })
}
