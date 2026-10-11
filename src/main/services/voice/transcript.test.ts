import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { transcriptMessages, transcriptTimestamps } from './transcript.ts'
import { VOICE_MAX_TURN_CHARS } from './voiceSchemas.ts'

describe('transcriptMessages', () => {
  it("speaks the chat's vocabulary: assistant is tracer, nothing is prefixed", () => {
    deepStrictEqual(
      transcriptMessages([
        { role: 'user', text: 'Is my thesis too broad?' },
        { role: 'assistant', text: 'A little. What is the one claim you most want to prove?' }
      ]),
      [
        { role: 'user', content: 'Is my thesis too broad?' },
        { role: 'tracer', content: 'A little. What is the one claim you most want to prove?' }
      ]
    )
  })

  it('joins a speaker split by pauses into one message and drops blank turns', () => {
    deepStrictEqual(
      transcriptMessages([
        { role: 'assistant', text: 'Right.' },
        { role: 'assistant', text: '  ' },
        { role: 'assistant', text: 'So   what would a skeptic ask?\n' },
        { role: 'user', text: 'Um' },
        { role: 'user', text: 'whether it is causal' }
      ]),
      [
        { role: 'tracer', content: 'Right. So what would a skeptic ask?' },
        { role: 'user', content: 'Um whether it is causal' }
      ]
    )
  })

  it('answers nothing for a call where nobody said anything', () => {
    deepStrictEqual(transcriptMessages([]), [])
    deepStrictEqual(transcriptMessages([{ role: 'user', text: ' \n ' }]), [])
  })

  it('cuts an over-long message with an ellipsis instead of refusing it', () => {
    const [m] = transcriptMessages([{ role: 'assistant', text: 'word '.repeat(2000) }])
    strictEqual(m.content.length <= VOICE_MAX_TURN_CHARS, true)
    strictEqual(m.content.endsWith('…'), true)
  })
})

describe('transcriptTimestamps', () => {
  const NOW = Date.parse('2026-10-10T12:00:00.000Z')

  it('is strictly increasing, one millisecond apart, from now', () => {
    deepStrictEqual(transcriptTimestamps(null, NOW, 3), [
      '2026-10-10T12:00:00.000Z',
      '2026-10-10T12:00:00.001Z',
      '2026-10-10T12:00:00.002Z'
    ])
  })

  it('starts after the newest message even when the clock is behind it or equal to it', () => {
    deepStrictEqual(transcriptTimestamps('2026-10-10T12:00:05.000Z', NOW, 2), [
      '2026-10-10T12:00:05.001Z',
      '2026-10-10T12:00:05.002Z'
    ])
    deepStrictEqual(transcriptTimestamps('2026-10-10T12:00:00.000Z', NOW, 1), ['2026-10-10T12:00:00.001Z'])
  })

  it('ignores an unreadable newest timestamp', () => {
    deepStrictEqual(transcriptTimestamps('not a date', NOW, 1), ['2026-10-10T12:00:00.000Z'])
    deepStrictEqual(transcriptTimestamps(null, NOW, 0), [])
  })
})
