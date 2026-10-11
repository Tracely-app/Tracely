import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseVoiceIpcError } from '../../../shared/ipc-contract.ts'
import type { TranscriptMessage } from './transcript.ts'
import { VoiceCallError } from './voiceErrors.ts'
import { clipVoiceContext, createVoiceService, normalizeStart, type VoiceEndpoint } from './voiceSession.ts'

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n'
const ANSWER = 'v=0\r\no=- 9 9 IN IP4 203.0.113.1\r\n'
const OK_START = { sdp: ANSWER, sessionId: 'live_1', voice: { id: 'atlas', name: 'Atlas' }, maxSeconds: 900, remainingSeconds: 1500 }

type Call = { endpoint: VoiceEndpoint; body: Record<string, unknown> }

/** A fake server: answers per endpoint, records every call. */
function fakeServer(answers: Partial<Record<VoiceEndpoint, (body: Record<string, unknown>) => Promise<unknown>>>) {
  const calls: Call[] = []
  const callServer = async <T>(endpoint: VoiceEndpoint, body: Record<string, unknown>): Promise<T> => {
    calls.push({ endpoint, body })
    const answer = answers[endpoint]
    if (!answer) throw new Error(`unexpected ${endpoint}`)
    return (await answer(body)) as T
  }
  return { calls, callServer }
}

function service(server: ReturnType<typeof fakeServer>, extra: Partial<Parameters<typeof createVoiceService>[0]> = {}) {
  const saved: Array<{ messages: TranscriptMessage[]; conversationId?: string }> = []
  const svc = createVoiceService({
    callServer: server.callServer,
    currentContext: () => 'The student\'s most recent draft, titled "Screens":\nScreen time causes depression.',
    appendTranscript: (messages, conversationId) => {
      saved.push({ messages, conversationId })
      return true
    },
    ...extra
  })
  return { svc, saved }
}

/** A ServerCallError-shaped failure, as client.ts throws it. */
const httpError = (status: number, kind: string, message = 'server words') =>
  Object.assign(new Error(message), { stage: 'http', status, kind })

async function voiceError(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    ok(error instanceof VoiceCallError, `expected VoiceCallError, got ${String(error)}`)
    return parseVoiceIpcError((error as Error).message)
  }
  throw new Error('expected a rejection')
}

describe('voice start', () => {
  it('sends the offer, the persona and the latest draft, and returns the answer', async () => {
    const server = fakeServer({ 'voice/session': async () => OK_START })
    const { svc } = service(server)
    const res = await svc.start({ sdp: OFFER, voiceId: 'atlas' })
    deepStrictEqual(res, OK_START)
    deepStrictEqual(server.calls, [
      {
        endpoint: 'voice/session',
        body: { sdp: OFFER, voiceId: 'atlas', context: 'The student\'s most recent draft, titled "Screens":\nScreen time causes depression.' }
      }
    ])
    strictEqual(svc.openSessionId(), 'live_1')
  })

  it('caps the context at the 4,000 characters the server accepts, and survives no draft', async () => {
    const server = fakeServer({ 'voice/session': async () => OK_START })
    const { svc } = service(server, { currentContext: () => 'x'.repeat(9000) })
    await svc.start({ sdp: OFFER, voiceId: 'linden' })
    const context = server.calls[0].body.context as string
    strictEqual(context.length, 4000)
    ok(context.endsWith('[…truncated]'))

    const server2 = fakeServer({ 'voice/session': async () => OK_START })
    const { svc: svc2 } = service(server2, {
      currentContext: () => {
        throw new Error('no database yet')
      }
    })
    await svc2.start({ sdp: OFFER, voiceId: 'linden' })
    strictEqual(server2.calls[0].body.context, '')
    strictEqual(clipVoiceContext('short'), 'short')
  })

  it('passes a keyless server\'s mock answer through without an SDP', async () => {
    const mock = { mock: true, sessionId: 'mock_1', voice: { id: 'kip', name: 'Kip' }, maxSeconds: 900, remainingSeconds: 1800 }
    const { svc } = service(fakeServer({ 'voice/session': async () => mock }))
    deepStrictEqual(await svc.start({ sdp: OFFER, voiceId: 'kip' }), mock)
  })

  it('maps the server refusals the UI must explain', async () => {
    const cases: Array<[Error, string]> = [
      [httpError(429, 'plan_limit', 'Voice is part of Pro.'), 'plan'],
      [httpError(429, 'voice_daily'), 'daily-limit'],
      [httpError(409, 'voice_busy'), 'busy'],
      [Object.assign(new Error('Could not reach'), { stage: 'network', kind: 'network' }), 'network'],
      [httpError(502, 'upstream'), 'server'],
      [httpError(503, 'budget'), 'server']
    ]
    for (const [failure, kind] of cases) {
      const { svc } = service(fakeServer({ 'voice/session': async () => Promise.reject(failure) }))
      strictEqual((await voiceError(svc.start({ sdp: OFFER, voiceId: 'linden' }))).kind, kind, failure.message)
      strictEqual(svc.openSessionId(), null)
    }
    const { svc } = service(fakeServer({ 'voice/session': async () => Promise.reject(httpError(429, 'plan_limit', 'Voice is part of Pro.')) }))
    strictEqual((await voiceError(svc.start({ sdp: OFFER, voiceId: 'linden' }))).message, 'Voice is part of Pro.')
  })
})

describe('voice start, the edges', () => {
  it('gives up after its deadline with a network error, and hangs up the session if it answers late', async () => {
    let answerLate: (v: unknown) => void = () => {}
    const server = fakeServer({
      'voice/session': () => new Promise((resolve) => (answerLate = resolve)),
      'voice/end': async () => ({ seconds: 0 })
    })
    const { svc } = service(server, { startTimeoutMs: 20 })
    const err = await voiceError(svc.start({ sdp: OFFER, voiceId: 'linden' }))
    strictEqual(err.kind, 'network')
    ok(/too long/.test(err.message))
    answerLate({ ...OK_START, sessionId: 'live_late' })
    await new Promise((r) => setTimeout(r, 5))
    deepStrictEqual(server.calls.map((c) => [c.endpoint, c.body.sessionId ?? null]), [
      ['voice/session', null],
      ['voice/end', 'live_late']
    ])
    strictEqual(svc.openSessionId(), null)
  })

  it('refuses an answer with no SDP and closes the session it names', async () => {
    const server = fakeServer({
      'voice/session': async () => ({ sessionId: 'live_2', maxSeconds: 900, remainingSeconds: 900 }),
      'voice/end': async () => ({ seconds: 0 })
    })
    const { svc } = service(server)
    strictEqual((await voiceError(svc.start({ sdp: OFFER, voiceId: 'linden' }))).kind, 'server')
    await new Promise((r) => setTimeout(r, 0))
    deepStrictEqual(server.calls[1], { endpoint: 'voice/end', body: { sessionId: 'live_2' } })
    strictEqual(svc.openSessionId(), null)
  })

  it('refuses a second start while the first is still connecting', async () => {
    let finish: (v: unknown) => void = () => {}
    const server = fakeServer({ 'voice/session': () => new Promise((resolve) => (finish = resolve)) })
    const { svc } = service(server)
    const first = svc.start({ sdp: OFFER, voiceId: 'linden' })
    strictEqual((await voiceError(svc.start({ sdp: OFFER, voiceId: 'linden' }))).kind, 'busy')
    finish(OK_START)
    strictEqual((await first).sessionId, 'live_1')
  })

  it('closes the call it opened before starting another, so a reloaded renderer is not told it is busy', async () => {
    let n = 0
    const server = fakeServer({
      'voice/session': async () => ({ ...OK_START, sessionId: `live_${++n}` }),
      'voice/end': async () => ({ seconds: 42 })
    })
    const { svc } = service(server)
    await svc.start({ sdp: OFFER, voiceId: 'linden' })
    await svc.start({ sdp: OFFER, voiceId: 'linden' })
    deepStrictEqual(server.calls.map((c) => c.endpoint), ['voice/session', 'voice/end', 'voice/session'])
    deepStrictEqual(server.calls[1].body, { sessionId: 'live_1' })
    strictEqual(svc.openSessionId(), 'live_2')
  })

  it('fills what the server left out from the registry, and never trusts junk numbers', () => {
    const req = { sdp: OFFER, voiceId: 'hollis' as const }
    deepStrictEqual(normalizeStart({ sdp: ANSWER, sessionId: 's', maxSeconds: -1, remainingSeconds: 'lots' }, req), {
      sdp: ANSWER,
      sessionId: 's',
      voice: { id: 'hollis', name: 'Hollis' },
      maxSeconds: 900,
      remainingSeconds: 900
    })
    strictEqual(normalizeStart({ ...OK_START, voice: { id: 'arbor', name: 'Arbor' } }, req).voice.id, 'linden')
  })
})

describe('voice end and transcript', () => {
  it('ends by session id, returns the metered seconds and forgets the open call', async () => {
    const server = fakeServer({ 'voice/session': async () => OK_START, 'voice/end': async () => ({ seconds: 245 }) })
    const { svc } = service(server)
    await svc.start({ sdp: OFFER, voiceId: 'atlas' })
    deepStrictEqual(await svc.end('live_1'), { seconds: 245 })
    deepStrictEqual(server.calls[1], { endpoint: 'voice/end', body: { sessionId: 'live_1' } })
    strictEqual(svc.openSessionId(), null)
    await svc.endOpen()
    strictEqual(server.calls.length, 2)
  })

  it('reads a junk seconds value as 0 and maps a failed end to a typed error', async () => {
    const { svc } = service(fakeServer({ 'voice/end': async () => ({ seconds: 'x' }) }))
    deepStrictEqual(await svc.end('gone'), { seconds: 0 })
    const { svc: down } = service(fakeServer({ 'voice/end': async () => Promise.reject(httpError(503, 'budget')) }))
    const err = await voiceError(down.end('live_1'))
    strictEqual(err.kind, 'server')
    ok(/close on its own/.test(err.message))
  })

  it('does not hold the UI when the server never answers an end', async () => {
    const { svc } = service(fakeServer({ 'voice/end': () => new Promise(() => {}) }), { endTimeoutMs: 20 })
    await rejects(svc.end('live_1'), VoiceCallError)
  })

  it('saves the transcript as chat messages into the conversation asked for', () => {
    const { svc, saved } = service(fakeServer({}))
    const res = svc.saveTranscript({
      conversationId: 'conv_9',
      turns: [
        { role: 'user', text: 'Is this too broad?' },
        { role: 'assistant', text: 'A bit.' },
        { role: 'assistant', text: 'What do you most want to prove?' }
      ]
    })
    deepStrictEqual(res, { saved: true })
    deepStrictEqual(saved, [
      {
        conversationId: 'conv_9',
        messages: [
          { role: 'user', content: 'Is this too broad?' },
          { role: 'tracer', content: 'A bit. What do you most want to prove?' }
        ]
      }
    ])
  })

  it('answers saved:false for an empty call or a store that cannot append', () => {
    const { svc, saved } = service(fakeServer({}))
    deepStrictEqual(svc.saveTranscript({ turns: [{ role: 'user', text: '  ' }] }), { saved: false })
    strictEqual(saved.length, 0)
    const failing = service(fakeServer({}), {
      appendTranscript: () => {
        throw new Error('database is locked')
      }
    })
    deepStrictEqual(failing.svc.saveTranscript({ turns: [{ role: 'user', text: 'hi' }] }), { saved: false })
    const refusing = service(fakeServer({}), { appendTranscript: () => false })
    deepStrictEqual(refusing.svc.saveTranscript({ turns: [{ role: 'user', text: 'hi' }] }), { saved: false })
  })
})
