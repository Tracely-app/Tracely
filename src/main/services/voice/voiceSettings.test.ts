import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { DEFAULT_VOICE_ID, VOICES } from '../../../shared/voices.ts'
import { VOICE_IDS, readVoiceSettings, voiceSettingWrites, voiceSettingsShape } from './voiceSettings.ts'

const schema = z.object(voiceSettingsShape)

// The DEFAULTS rows settingsRepo seeds — what getAllSettingsRaw answers for an
// install that never touched a voice setting.
// Behaviour change (finding 14): transcripts are no longer saved by default.
const DEFAULT_ROWS = { voiceId: 'linden', voiceCaptions: 'true', voiceSaveTranscript: 'false', voiceConsent: 'false' }

describe('voice settings', () => {
  it('reads the defaults as linden, captions on, transcripts not saved, no consent', () => {
    deepStrictEqual(readVoiceSettings(DEFAULT_ROWS), {
      voiceId: 'linden',
      voiceCaptions: true,
      voiceSaveTranscript: false,
      voiceConsent: false
    })
    strictEqual(DEFAULT_VOICE_ID, 'linden')
  })

  it('reads a stored persona id this build does not know as the default', () => {
    strictEqual(readVoiceSettings({ ...DEFAULT_ROWS, voiceId: 'arbor' }).voiceId, DEFAULT_VOICE_ID)
    strictEqual(readVoiceSettings({ ...DEFAULT_ROWS, voiceId: '' }).voiceId, DEFAULT_VOICE_ID)
    strictEqual(readVoiceSettings({}).voiceId, DEFAULT_VOICE_ID)
  })

  it('reads every registered persona id back as itself', () => {
    for (const v of VOICES) strictEqual(readVoiceSettings({ voiceId: v.id }).voiceId, v.id)
  })

  it('reads a junk flag as its default: never consent, never saving, captions still on', () => {
    const junk = readVoiceSettings({ voiceCaptions: 'yes', voiceSaveTranscript: '', voiceConsent: 'TRUE' })
    strictEqual(junk.voiceConsent, false)
    strictEqual(junk.voiceCaptions, true)
    strictEqual(junk.voiceSaveTranscript, false)
    strictEqual(readVoiceSettings({ voiceSaveTranscript: 'true' }).voiceSaveTranscript, true)
    deepStrictEqual(
      readVoiceSettings({ voiceCaptions: 'false', voiceSaveTranscript: 'false', voiceConsent: 'true' }),
      { voiceId: 'linden', voiceCaptions: false, voiceSaveTranscript: false, voiceConsent: true }
    )
  })

  it('accepts a patch naming a registered persona and rejects any other id', () => {
    strictEqual(schema.parse({ voiceId: 'sterling' }).voiceId, 'sterling')
    strictEqual(schema.safeParse({ voiceId: 'arbor' }).success, false)
    strictEqual(schema.safeParse({ voiceId: 'Linden' }).success, false)
    strictEqual(schema.safeParse({ voiceCaptions: 'true' }).success, false)
    deepStrictEqual(schema.parse({}), {})
  })

  it('enumerates exactly the seven personas, linden first', () => {
    deepStrictEqual(VOICE_IDS, ['linden', 'atlas', 'wren', 'rory', 'kip', 'hollis', 'sterling'])
  })

  it('writes only the keys a patch carries, as the strings the table stores', () => {
    deepStrictEqual(voiceSettingWrites({}), [])
    deepStrictEqual(voiceSettingWrites({ voiceId: 'wren', voiceConsent: true }), [
      ['voiceId', 'wren'],
      ['voiceConsent', 'true']
    ])
    deepStrictEqual(voiceSettingWrites({ voiceCaptions: false, voiceSaveTranscript: false }), [
      ['voiceCaptions', 'false'],
      ['voiceSaveTranscript', 'false']
    ])
  })
})
