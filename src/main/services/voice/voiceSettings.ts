import { z } from 'zod'
import type { AppSettings } from '@shared/types'
import { VOICES, voiceById, type VoiceId } from '../../../shared/voices.ts'

/**
 * Tracer Voice's four settings, as settingsHandlers reads and writes them.
 *
 * Split out of settingsHandlers.ts because that file imports electron, so
 * `npm test` cannot load it — and "a stored persona id this build does not
 * know" is exactly the case worth a test. settingsHandlers spreads
 * `voiceSettingsShape` into its zod schema, spreads `readVoiceSettings` into
 * buildSettings, and writes what `voiceSettingWrites` returns.
 */

export type VoiceSettings = Pick<AppSettings, 'voiceId' | 'voiceCaptions' | 'voiceSaveTranscript' | 'voiceConsent'>

/** Every persona id, in registry order — the zod enum both IPC schemas use. */
export const VOICE_IDS = VOICES.map((v) => v.id) as [VoiceId, ...VoiceId[]]

/**
 * The patch half. An id outside the registry is REJECTED here, the same way
 * an unknown theme is: the renderer only ever offers VOICES, so anything else
 * is a bug to surface, not a value to save.
 */
export const voiceSettingsShape = {
  voiceId: z.enum(VOICE_IDS).optional(),
  voiceCaptions: z.boolean().optional(),
  voiceSaveTranscript: z.boolean().optional(),
  voiceConsent: z.boolean().optional()
}

/**
 * The read half. A stored row is not trusted the way a patch is checked: a
 * hand edit, or a newer build that added a persona and was then downgraded,
 * can leave an id this build has no card for, and that reads as the default.
 * A junk flag reads as its default: the two that default on are turned off
 * only by a row saying 'false', and consent is given only by a row saying
 * 'true' — a corrupted row must never count as having accepted the
 * disclosure.
 */
export function readVoiceSettings(raw: Record<string, string | undefined>): VoiceSettings {
  return {
    voiceId: voiceById(raw.voiceId).id,
    voiceCaptions: raw.voiceCaptions !== 'false',
    voiceSaveTranscript: raw.voiceSaveTranscript !== 'false',
    voiceConsent: raw.voiceConsent === 'true'
  }
}

/** The rows a validated patch writes, as [key, stored string] pairs. */
export function voiceSettingWrites(patch: Partial<VoiceSettings>): Array<[keyof VoiceSettings, string]> {
  const writes: Array<[keyof VoiceSettings, string]> = []
  if (patch.voiceId !== undefined) writes.push(['voiceId', patch.voiceId])
  if (patch.voiceCaptions !== undefined) writes.push(['voiceCaptions', String(patch.voiceCaptions)])
  if (patch.voiceSaveTranscript !== undefined) {
    writes.push(['voiceSaveTranscript', String(patch.voiceSaveTranscript)])
  }
  if (patch.voiceConsent !== undefined) writes.push(['voiceConsent', String(patch.voiceConsent)])
  return writes
}
