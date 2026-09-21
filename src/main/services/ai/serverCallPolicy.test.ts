import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_TIMEOUT_MS,
  FINAL_KINDS,
  FIND_SOURCES_TIMEOUT_MS,
  isTimeout,
  readErrorEnvelope,
  shouldRetry,
  timeoutFor
} from './serverCallPolicy.ts'

describe('shouldRetry — only where no answer was produced', () => {
  it('retries a request the network dropped', () => {
    strictEqual(shouldRetry({ stage: 'network' }), true)
  })

  it('retries a gateway status with no kind (a proxy error page)', () => {
    for (const status of [502, 503, 504]) strictEqual(shouldRetry({ stage: 'http', status }), true)
  })

  it('retries a gateway status whose kind describes an outage', () => {
    strictEqual(shouldRetry({ stage: 'http', status: 502, kind: 'server' }), true)
    strictEqual(shouldRetry({ stage: 'http', status: 502, kind: 'network' }), true)
    strictEqual(shouldRetry({ stage: 'http', status: 504, kind: 'timeout' }), true)
  })

  it('never retries a gateway status whose kind is an answer', () => {
    // Each of these would come back the same — and truncated/refusal/
    // bad_request would pay for the same model call twice.
    for (const kind of ['truncated', 'refusal', 'bad_request', 'no_key', 'plan_limit', 'budget']) {
      for (const status of [502, 503, 504]) {
        strictEqual(shouldRetry({ stage: 'http', status, kind }), false, `${status} ${kind}`)
      }
    }
    deepStrictEqual(
      [...FINAL_KINDS].sort(),
      ['bad_request', 'budget', 'no_key', 'plan_limit', 'refusal', 'truncated']
    )
  })

  it('never retries a 429, whatever its kind', () => {
    // The server's 429s are the per-minute limiter (60s), the critique cap
    // (600s) and the daily quota. 800ms later none of them has cleared.
    for (const kind of [undefined, 'rate_limit', 'plan_limit']) {
      strictEqual(shouldRetry({ stage: 'http', status: 429, kind }), false)
    }
  })

  it('never retries any other 4xx', () => {
    for (const status of [400, 401, 403, 404, 413, 415]) strictEqual(shouldRetry({ stage: 'http', status }), false)
  })

  it('never retries after a 200 whose body could not be read', () => {
    // The regression this module exists for: the old client saw no status on
    // a JSON SyntaxError and retried — after the model call was billed.
    strictEqual(shouldRetry({ stage: 'unreadable', status: 200 }), false)
    strictEqual(shouldRetry({ stage: 'unreadable', status: 200, kind: 'timeout' }), false)
  })

  it('never retries a timeout or a failure before sending', () => {
    strictEqual(shouldRetry({ stage: 'timeout' }), false)
    strictEqual(shouldRetry({ stage: 'local' }), false)
  })

  it('never retries an http failure that somehow has no status', () => {
    strictEqual(shouldRetry({ stage: 'http' }), false)
  })
})

describe('readErrorEnvelope', () => {
  it("reads the server's object envelope", () => {
    deepStrictEqual(
      readErrorEnvelope({ error: { kind: 'plan_limit', message: 'Free accounts get 150 AI checks a day.', retryAfter: 3600 } }, 429),
      { message: 'Free accounts get 150 AI checks a day.', kind: 'plan_limit', retryAfter: 3600 }
    )
  })

  it('reads the string envelope (the relay, and a non-JSON body)', () => {
    deepStrictEqual(readErrorEnvelope({ error: 'Sign in to use Tracely.' }, 401), { message: 'Sign in to use Tracely.' })
    deepStrictEqual(readErrorEnvelope({ error: 'Bad Gateway' }, 502), { message: 'Bad Gateway' })
  })

  it('never produces "[object Object]"', () => {
    strictEqual(readErrorEnvelope({ error: { kind: 'server' } }, 502).message, 'Tracely server request failed (502)')
    strictEqual(readErrorEnvelope({ error: { message: { nested: true } } }, 500).message, 'Tracely server request failed (500)')
  })

  it('falls back to the status when there is nothing to read', () => {
    for (const body of [null, undefined, 'text', 42, {}, { error: '' }, { error: '   ' }, { error: null }]) {
      deepStrictEqual(readErrorEnvelope(body, 503), { message: 'Tracely server request failed (503)' })
    }
  })

  it('ignores a kind or retryAfter of the wrong type', () => {
    deepStrictEqual(readErrorEnvelope({ error: { message: 'm', kind: 7, retryAfter: '60' } }, 429), { message: 'm' })
    deepStrictEqual(readErrorEnvelope({ error: { message: 'm', retryAfter: Number.NaN } }, 429), { message: 'm' })
  })
})

describe('timeoutFor', () => {
  it('gives find-sources twice the ordinary deadline', () => {
    strictEqual(timeoutFor('find-sources'), FIND_SOURCES_TIMEOUT_MS)
    strictEqual(FIND_SOURCES_TIMEOUT_MS, 120_000)
    for (const endpoint of ['detect-claims', 'critique', 'correction', 'grade', 'tracer']) {
      strictEqual(timeoutFor(endpoint), DEFAULT_TIMEOUT_MS)
    }
    strictEqual(DEFAULT_TIMEOUT_MS, 60_000)
  })
})

describe('isTimeout', () => {
  it('recognises the deadline firing', () => {
    strictEqual(isTimeout(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), true)
    strictEqual(isTimeout(new DOMException('This operation was aborted', 'AbortError')), true)
  })

  it('does not mistake a network failure for one', () => {
    strictEqual(isTimeout(new TypeError('fetch failed')), false)
    strictEqual(isTimeout(new SyntaxError('Unexpected token')), false)
    strictEqual(isTimeout(null), false)
    strictEqual(isTimeout('TimeoutError'), false)
  })

  it('matches what AbortSignal.timeout actually throws', async () => {
    const signal = AbortSignal.timeout(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    strictEqual(isTimeout(signal.reason), true)
  })
})
