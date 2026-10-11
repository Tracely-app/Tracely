import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  VOICE_MAX_SDP_CHARS,
  VOICE_MAX_TRANSCRIPT_TURNS,
  voiceEndSchema,
  voiceEnsureMicSchema,
  voiceSaveTranscriptSchema,
  voiceStartSchema
} from './voiceSchemas.ts'

const OFFER = 'v=0\r\no=- 4611 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'

describe('voice:start payload', () => {
  it('accepts an SDP offer and a registered persona', () => {
    deepStrictEqual(voiceStartSchema.parse({ sdp: OFFER, voiceId: 'wren' }), { sdp: OFFER, voiceId: 'wren' })
  })

  it('refuses what the server would 400: not an offer, too long, an unknown persona, missing fields', () => {
    const bad: unknown[] = [
      { sdp: 'hello', voiceId: 'linden' },
      { sdp: ` ${OFFER}`, voiceId: 'linden' },
      { sdp: 'v=0' + 'a'.repeat(VOICE_MAX_SDP_CHARS), voiceId: 'linden' },
      { sdp: OFFER, voiceId: 'arbor' },
      { sdp: OFFER },
      { voiceId: 'linden' },
      { sdp: 42, voiceId: 'linden' },
      null,
      undefined
    ]
    for (const payload of bad) strictEqual(voiceStartSchema.safeParse(payload).success, false, JSON.stringify(payload))
  })

  it('drops keys it does not know — the renderer cannot smuggle a context or a model past main', () => {
    deepStrictEqual(voiceStartSchema.parse({ sdp: OFFER, voiceId: 'kip', context: 'x', model: 'y' }), {
      sdp: OFFER,
      voiceId: 'kip'
    })
  })
})

describe('voice:end, voice:ensure-mic and voice:save-transcript payloads', () => {
  it('needs a non-empty session id', () => {
    strictEqual(voiceEndSchema.parse({ sessionId: 'mock_1' }).sessionId, 'mock_1')
    strictEqual(voiceEndSchema.safeParse({ sessionId: '' }).success, false)
    strictEqual(voiceEndSchema.safeParse({}).success, false)
    strictEqual(voiceEndSchema.safeParse({ sessionId: 'x'.repeat(201) }).success, false)
  })

  it('takes an empty object for ensure-mic', () => {
    deepStrictEqual(voiceEnsureMicSchema.parse({}), {})
  })

  it('takes user/assistant turns and an optional conversation id', () => {
    const req = { turns: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }], conversationId: 'c1' }
    deepStrictEqual(voiceSaveTranscriptSchema.parse(req), req)
    deepStrictEqual(voiceSaveTranscriptSchema.parse({ turns: [] }), { turns: [] })
  })

  it('refuses other roles, non-string text and a runaway number of turns', () => {
    strictEqual(voiceSaveTranscriptSchema.safeParse({ turns: [{ role: 'tracer', text: 'x' }] }).success, false)
    strictEqual(voiceSaveTranscriptSchema.safeParse({ turns: [{ role: 'user', text: 3 }] }).success, false)
    const many = Array.from({ length: VOICE_MAX_TRANSCRIPT_TURNS + 1 }, () => ({ role: 'user', text: 'x' }))
    strictEqual(voiceSaveTranscriptSchema.safeParse({ turns: many }).success, false)
    strictEqual(voiceSaveTranscriptSchema.safeParse({}).success, false)
  })
})
