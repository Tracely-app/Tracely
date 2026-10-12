import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VOICE_KIND_COPY, parseVoiceIpcError } from '../../../shared/ipc-contract.ts'
import { VoiceCallError, voiceIpcErrorFrom, voiceKindFor } from './voiceErrors.ts'
import { readErrorEnvelope } from '../ai/serverCallPolicy.ts'
import { voiceEligibilitySchema } from './voiceSchemas.ts'
import { createVoiceService, isoInstant, normalizeEligibility, normalizeStart, type VoiceEndpoint } from './voiceSession.ts'

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n'
const ANSWER = 'v=0\r\no=- 9 9 IN IP4 203.0.113.1\r\n'
const RESET = '2026-10-11T05:00:00.000Z'
const MONTH_RESET = '2026-11-01T00:00:00.000Z'

type Answer = (body: Record<string, unknown>) => Promise<unknown>

function rig(answers: Partial<Record<VoiceEndpoint, Answer>>, eligibilityTimeoutMs?: number) {
  const calls: VoiceEndpoint[] = []
  const svc = createVoiceService({
    callServer: async <T>(endpoint: VoiceEndpoint, body: Record<string, unknown>): Promise<T> => {
      calls.push(endpoint)
      const answer = answers[endpoint]
      if (!answer) throw new Error(`unexpected ${endpoint}`)
      return (await answer(body)) as T
    },
    currentContext: () => 'draft',
    appendTranscript: () => true,
    eligibilityTimeoutMs
  })
  return { svc, calls }
}

const httpError = (status: number, kind: string, resetAt?: string) =>
  Object.assign(new Error('server words'), { stage: 'http', status, kind, resetAt })

async function tagged(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    ok(error instanceof VoiceCallError, String(error))
    return parseVoiceIpcError((error as Error).message)
  }
  throw new Error('expected a rejection')
}

describe('voice eligibility (main)', () => {
  it('asks the server with an empty body and passes an allowed answer through', async () => {
    const answer = { allowed: true, maxSeconds: 900, remainingSeconds: 1200, remainingMonthSeconds: 5400, resetAt: RESET }
    let body: Record<string, unknown> | null = null
    const { svc, calls } = rig({ 'voice/eligibility': async (b) => ((body = b), answer) })
    deepStrictEqual(await svc.eligibility(), answer)
    deepStrictEqual(calls, ['voice/eligibility'])
    deepStrictEqual(body, {})
  })

  it('passes each refusal through with its reason, message and resetAt', async () => {
    for (const reason of ['plan', 'daily-limit', 'monthly-limit', 'off', 'busy'] as const) {
      const answer = { allowed: false, reason, message: `No: ${reason}.`, resetAt: RESET }
      const { svc } = rig({ 'voice/eligibility': async () => answer })
      deepStrictEqual(await svc.eligibility(), answer)
    }
  })

  it('reads an HTTP refusal as an answer, with the resetAt from its body', async () => {
    const cases: [string, number, string][] = [
      ['plan_limit', 429, 'plan'],
      ['voice_daily', 429, 'daily-limit'],
      ['voice_monthly', 429, 'monthly-limit'],
      ['voice_busy', 409, 'busy'],
      ['voice_off', 503, 'off'],
      ['no_key', 503, 'off'],
      ['budget', 503, 'off']
    ]
    for (const [kind, status, reason] of cases) {
      const { svc } = rig({ 'voice/eligibility': async () => Promise.reject(httpError(status, kind, MONTH_RESET)) })
      const res = await svc.eligibility()
      strictEqual(res.allowed, false, kind)
      if (res.allowed) continue
      strictEqual(res.reason, reason, kind)
      strictEqual(res.resetAt, MONTH_RESET, kind)
      ok(res.message.length > 0)
    }
  })

  it('rejects, tagged, only when it could not ask: network, a slow server, an older server', async () => {
    const net = Object.assign(new Error('offline'), { stage: 'network', kind: 'network' })
    strictEqual((await tagged(rig({ 'voice/eligibility': async () => Promise.reject(net) }).svc.eligibility())).kind, 'network')
    const slow = rig({ 'voice/eligibility': () => new Promise(() => {}) }, 20)
    strictEqual((await tagged(slow.svc.eligibility())).kind, 'network')
    const old = rig({ 'voice/eligibility': async () => Promise.reject(httpError(404, 'not_found')) })
    strictEqual((await tagged(old.svc.eligibility())).kind, 'server')
  })

  it('hangs up a call main still holds open before asking, so a stale line is not "busy"', async () => {
    const { svc, calls } = rig({
      'voice/session': async () => ({ sdp: ANSWER, sessionId: 'live_1', voice: { id: 'atlas', name: 'Atlas' }, maxSeconds: 900, remainingSeconds: 900 }),
      'voice/end': async () => Promise.reject(Object.assign(new Error('offline'), { stage: 'network' })),
      'voice/eligibility': async () => ({ allowed: true, maxSeconds: 900, remainingSeconds: 600 })
    })
    await svc.start({ sdp: OFFER, voiceId: 'atlas' })
    await svc.end('live_1').catch(() => undefined) // the hang-up failed: main still holds it
    strictEqual(svc.openSessionId(), 'live_1')
    await svc.eligibility()
    deepStrictEqual(calls, ['voice/session', 'voice/end', 'voice/end', 'voice/eligibility'])
  })

  it('voice:eligibility takes an empty object', () => {
    deepStrictEqual(voiceEligibilitySchema.parse({}), {})
  })
})

describe('voice eligibility answers, normalized', () => {
  it('fills an allowed answer missing its numbers from the defaults, and drops a resetAt it cannot read', () => {
    deepStrictEqual(normalizeEligibility({ allowed: true, resetAt: 'tomorrow' }), {
      allowed: true,
      maxSeconds: 900,
      remainingSeconds: 900
    })
  })

  it("words a refusal without a sentence, and calls a reason it doesn't know 'off'", () => {
    deepStrictEqual(normalizeEligibility({ allowed: false, reason: 'busy' }), {
      allowed: false,
      reason: 'busy',
      message: 'Another voice call is still open on this account. Wait a minute for it to close, then try again.'
    })
    const odd = normalizeEligibility({ allowed: false, reason: 'maintenance', message: 'Back at noon.' })
    deepStrictEqual(odd, { allowed: false, reason: 'off', message: 'Back at noon.' })
  })

  it('refuses an answer that is neither allowed nor refused', () => {
    try {
      normalizeEligibility({ ok: 1 } as never)
      throw new Error('expected a throw')
    } catch (error) {
      ok(error instanceof VoiceCallError)
      strictEqual((error as VoiceCallError).kind, 'server')
    }
  })

  it('isoInstant keeps only readable instants', () => {
    strictEqual(isoInstant(RESET), RESET)
    strictEqual(isoInstant('2026-10-11T00:00:00+02:00'), '2026-10-11T00:00:00+02:00')
    strictEqual(isoInstant('2026-13-45T99:00:00Z'), null)
    strictEqual(isoInstant('soon'), null)
    strictEqual(isoInstant(1760000000), null)
  })
})

describe('the monthly limit and resetAt on start', () => {
  it('voice_monthly is monthly-limit, and both limits carry the refusal body resetAt', () => {
    strictEqual(voiceKindFor({ kind: 'voice_monthly' }), 'monthly-limit')
    deepStrictEqual(voiceIpcErrorFrom(httpError(429, 'voice_monthly', MONTH_RESET), 'start'), {
      kind: 'monthly-limit',
      message: VOICE_KIND_COPY['monthly-limit'],
      resetAt: MONTH_RESET
    })
    deepStrictEqual(voiceIpcErrorFrom(httpError(429, 'voice_daily', RESET), 'start'), {
      kind: 'daily-limit',
      message: VOICE_KIND_COPY['daily-limit'],
      resetAt: RESET
    })
    // Only the limits say when they lift.
    deepStrictEqual(voiceIpcErrorFrom(httpError(409, 'voice_busy', RESET), 'start'), {
      kind: 'busy',
      message: VOICE_KIND_COPY.busy
    })
  })

  it('a refused start rejects with the resetAt in its tag', async () => {
    const { svc } = rig({ 'voice/session': async () => Promise.reject(httpError(429, 'voice_daily', RESET)) })
    deepStrictEqual(await tagged(svc.start({ sdp: OFFER, voiceId: 'linden' })), {
      kind: 'daily-limit',
      message: VOICE_KIND_COPY['daily-limit'],
      resetAt: RESET
    })
  })

  it("passes the start answer's month figure and resetAt on, and leaves out what it can't read", () => {
    const base = { sdp: ANSWER, sessionId: 's', voice: { id: 'wren', name: 'Wren' }, maxSeconds: 600, remainingSeconds: 600 }
    const req = { sdp: OFFER, voiceId: 'wren' as const }
    const res = normalizeStart({ ...base, remainingMonthSeconds: 3000, resetAt: RESET }, req)
    strictEqual(res.remainingMonthSeconds, 3000)
    strictEqual(res.resetAt, RESET)
    const bad = normalizeStart({ ...base, remainingMonthSeconds: -1, resetAt: 'later' }, req)
    ok(!('remainingMonthSeconds' in bad) && !('resetAt' in bad))
  })
})

describe("the error envelope keeps a refusal's resetAt", () => {
  it('reads resetAt from {error:{kind,message,resetAt}}, and nothing when it is absent', () => {
    deepStrictEqual(readErrorEnvelope({ error: { kind: 'voice_daily', message: 'Used up.', resetAt: RESET } }, 429), {
      message: 'Used up.',
      kind: 'voice_daily',
      resetAt: RESET
    })
    deepStrictEqual(readErrorEnvelope({ error: { kind: 'voice_busy', message: 'Busy.' } }, 409), {
      message: 'Busy.',
      kind: 'voice_busy'
    })
  })
})
