import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VOICE_KIND_COPY, parseVoiceIpcError } from '../../../shared/ipc-contract.ts'
import { VoiceCallError, voiceIpcErrorFrom, voiceKindFor } from './voiceErrors.ts'

// The shape client.ts's ServerCallError carries, for each way /api/voice/*
// can fail (SPEC "HTTP contract": 400 bad_request, 409 voice_busy, 429
// plan_limit | voice_daily | rate_limit (appGate), 502 upstream, 503 no_key |
// budget | voice_off).
const http = (status: number, kind?: string, message = 'server words') => ({ stage: 'http', status, kind, message })

describe('voice error mapping', () => {
  // Behaviour change (finding 26): main used to keep the server's sentence
  // and had a fallback table of its own, both then replaced by the renderer's
  // copy. There is one wording now, VOICE_KIND_COPY, used by both ends.
  it('maps the three account kinds, and network, to what the UI shows, in the one shared wording', () => {
    deepStrictEqual(voiceIpcErrorFrom(http(429, 'plan_limit', 'Voice is part of Pro.'), 'start'), {
      kind: 'plan',
      message: VOICE_KIND_COPY.plan
    })
    deepStrictEqual(voiceIpcErrorFrom(http(429, 'voice_daily', 'Tracely server request failed (429)'), 'start'), {
      kind: 'daily-limit',
      message: VOICE_KIND_COPY['daily-limit']
    })
    deepStrictEqual(voiceIpcErrorFrom(http(409, 'voice_busy', ''), 'start'), { kind: 'busy', message: VOICE_KIND_COPY.busy })
  })

  it('calls an unreachable server or a timeout network, in plain words rather than fetch internals', () => {
    for (const stage of ['network', 'timeout']) {
      const e = voiceIpcErrorFrom({ stage, kind: stage, message: 'Could not reach the Tracely server (ECONNRESET).' }, 'start')
      deepStrictEqual(e, { kind: 'network', message: VOICE_KIND_COPY.network })
    }
  })

  it('calls everything else server, with a sentence for the kinds a student can act on', () => {
    const cases: Array<[ReturnType<typeof http> | Record<string, unknown>, RegExp]> = [
      [http(429, 'rate_limit'), /Wait a minute/],
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
