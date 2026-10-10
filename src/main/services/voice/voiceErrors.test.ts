import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseVoiceIpcError } from '../../../shared/ipc-contract.ts'
import { VoiceCallError, voiceIpcErrorFrom, voiceKindFor } from './voiceErrors.ts'

// The shape client.ts's ServerCallError carries, for each way /api/voice/*
// can fail (SPEC "HTTP contract": 400 bad_request, 409 voice_busy, 429
// plan_limit | voice_daily | rate, 502 upstream, 503 no_key | budget).
const http = (status: number, kind?: string, message = 'server words') => ({ stage: 'http', status, kind, message })

describe('voice error mapping', () => {
  it('maps the three account kinds to what the UI shows, keeping the server sentence', () => {
    deepStrictEqual(voiceIpcErrorFrom(http(429, 'plan_limit', 'Voice is part of Pro.'), 'start'), {
      kind: 'plan',
      message: 'Voice is part of Pro.'
    })
    strictEqual(voiceIpcErrorFrom(http(429, 'voice_daily'), 'start').kind, 'daily-limit')
    strictEqual(voiceIpcErrorFrom(http(409, 'voice_busy'), 'start').kind, 'busy')
  })

  it("falls back to its own sentence when the server sent none (readErrorEnvelope's placeholder)", () => {
    const e = voiceIpcErrorFrom(http(429, 'voice_daily', 'Tracely server request failed (429)'), 'start')
    deepStrictEqual(e, { kind: 'daily-limit', message: "You've used today's voice minutes. They come back tomorrow." })
    strictEqual(voiceIpcErrorFrom(http(409, 'voice_busy', ''), 'start').message.startsWith('A voice call'), true)
  })

  it('calls an unreachable server or a timeout network, in plain words rather than fetch internals', () => {
    for (const stage of ['network', 'timeout']) {
      const e = voiceIpcErrorFrom({ stage, kind: stage, message: 'Could not reach the Tracely server (ECONNRESET).' }, 'start')
      deepStrictEqual(e, { kind: 'network', message: "Couldn't reach Tracely. Check your connection and try again." })
    }
  })

  it('calls everything else server, with a sentence for the kinds a student can act on', () => {
    const cases: Array<[ReturnType<typeof http> | Record<string, unknown>, RegExp]> = [
      [http(429, 'rate'), /Wait a minute/],
      [http(503, 'budget'), /daily budget/],
      [http(503, 'no_key'), /isn't available right now/],
      [http(503, 'voice_off'), /isn't available right now/],
      [http(502, 'upstream'), /OpenAI couldn't open the call/],
      [http(404, undefined, 'Not found'), /isn't available on this Tracely server yet/],
      [http(400, 'bad_request'), /couldn't start the call/],
      [{ stage: 'local' }, /no Tracely server/],
      [{ stage: 'unreadable', status: 200, kind: 'unreadable' }, /couldn't start the call/]
    ]
    for (const [failure, sentence] of cases) {
      const e = voiceIpcErrorFrom(failure, 'start')
      strictEqual(e.kind, 'server', JSON.stringify(failure))
      ok(sentence.test(e.message), `${JSON.stringify(failure)} → ${e.message}`)
    }
  })

  it('says the call will close on its own when ending fails', () => {
    ok(/close on its own/.test(voiceIpcErrorFrom(http(500), 'end').message))
  })

  it('treats a non-object throw as server', () => {
    strictEqual(voiceIpcErrorFrom('boom', 'start').kind, 'server')
    strictEqual(voiceIpcErrorFrom(null, 'end').kind, 'server')
    strictEqual(voiceKindFor({}), 'server')
  })

  it('passes a VoiceCallError through unchanged, and its message parses back to the same error', () => {
    const err = new VoiceCallError({ kind: 'busy', message: 'A call is already starting.' })
    deepStrictEqual(voiceIpcErrorFrom(err, 'start'), { kind: 'busy', message: 'A call is already starting.' })
    deepStrictEqual(parseVoiceIpcError(`Error invoking remote method 'voice:start': ${String(err)}`), {
      kind: 'busy',
      message: 'A call is already starting.'
    })
  })
})
