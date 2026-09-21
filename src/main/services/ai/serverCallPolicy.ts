/**
 * How a call to the Tracely server behaves when it goes wrong: which failures
 * earn one more attempt, how long to wait for an answer, and how to read the
 * server's error body.
 *
 * Split out of client.ts because client.ts value-imports identity, the model
 * tier and config, so `npm test` cannot load it — and these are the decisions
 * that cost money when they are wrong. A retry is a second request; for most
 * of these endpoints a second request is a second model call on the bill.
 *
 * A leaf: no imports at all.
 */

/**
 * Where a call failed, which is what decides whether repeating it can help.
 *
 *   local      — before anything was sent (no server compiled into this build).
 *   network    — fetch itself rejected: DNS, refused, reset. No answer came back.
 *   timeout    — no answer within the deadline. The server may still be working.
 *   http       — the server answered with a non-2xx status.
 *   unreadable — the server answered 2xx and the body could not be read.
 */
export type FailureStage = 'local' | 'network' | 'timeout' | 'http' | 'unreadable'

export interface CallFailure {
  stage: FailureStage
  /** The HTTP status, when the server answered at all. */
  status?: number
  /** The server's `error.kind` (`truncated`, `plan_limit`, …), when it sent one. */
  kind?: string
}

export const RETRY_DELAY_MS = 800

/**
 * Deadlines. There were none: a fetch to a server that accepted the connection
 * and never answered hung the analysis forever, with the spinner still going.
 *
 * A minute is generous for a single model call and already longer than anyone
 * will watch a spinner, so past it the honest answer is an error the caller
 * can fall back from. find-sources gets two: it runs several web searches
 * INSIDE one model call, which makes it the slowest thing the server does.
 * These numbers are a ceiling chosen, not a latency measured — if a healthy
 * call is ever seen near one, raise it rather than let it fail.
 */
export const DEFAULT_TIMEOUT_MS = 60_000
export const FIND_SOURCES_TIMEOUT_MS = 120_000

export function timeoutFor(endpoint: string): number {
  return endpoint === 'find-sources' ? FIND_SOURCES_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
}

// Gateway trouble: the server (or the proxy in front of it) could not produce
// an answer this time. 429 is deliberately NOT here — see shouldRetry.
const RETRYABLE_STATUS = new Set([502, 503, 504])

/**
 * Error kinds that arrive on a 502/503/504 but describe an answer, not an
 * outage. Asking again gets the same answer and, for the first three, pays for
 * it again:
 *
 *   truncated   — the model ran out of output room. The same input runs out of
 *                 room the same way, after the same spend.
 *   refusal     — the model declined. It will decline again.
 *   bad_request — OpenAI rejected the request itself (relayed as 502). Same
 *                 request, same rejection.
 *   no_key      — the server has no working API key. Configuration, not luck.
 *   plan_limit  — the account's daily allowance is used up. Midnight fixes it;
 *                 800ms does not.
 *   budget      — the server's own daily spend ceiling. Not in the list this
 *                 client was specified against, and added on purpose: it is a
 *                 503 that clears at midnight, so the retry was certain to fail
 *                 and spent one of the caller's per-minute rate-limit slots.
 */
export const FINAL_KINDS: ReadonlySet<string> = new Set([
  'truncated',
  'refusal',
  'bad_request',
  'no_key',
  'plan_limit',
  'budget'
])

/**
 * One more attempt, or give up now?
 *
 * The relay-era client retried anything without a status, plus 429/502/503/504.
 * Two of those paid twice. A 200 whose body failed to parse has no status, so
 * it was retried — after the model call it answered had already been billed.
 * And 429 meant something cheap on the relay (a soft window that cleared in
 * seconds) that it does not mean on the server, where it is the per-minute
 * limiter (retryAfter 60), the critique cap (600) or the daily quota: a retry
 * 800ms later is certain to fail and uses up another slot doing it.
 *
 * So: retry only where no answer was produced — the network dropped the
 * request, or a gateway status whose kind is not one of the FINAL_KINDS.
 *
 * A timeout is not retried either, and that is a choice about money as much as
 * patience: the server is most likely still running the model call it was
 * sent, which is billed whether or not anyone waits for it, and a second
 * request would pay again and hold the user for another full deadline.
 */
export function shouldRetry(failure: CallFailure): boolean {
  switch (failure.stage) {
    case 'network':
      return true
    case 'http':
      return (
        failure.status !== undefined &&
        RETRYABLE_STATUS.has(failure.status) &&
        !(failure.kind !== undefined && FINAL_KINDS.has(failure.kind))
      )
    default:
      return false
  }
}

/** Whether a rejection is the deadline firing rather than the network failing. */
export function isTimeout(cause: unknown): boolean {
  const name = (cause as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

export interface ErrorEnvelope {
  message: string
  kind?: string
  /** Seconds, when the server says how long to wait. */
  retryAfter?: number
}

/**
 * Reads the message out of an error body in either shape it can arrive in.
 *
 * The server sends `{ error: { kind, message, retryAfter } }`. The relay sent
 * `{ error: "message" }`, and so does the fallback below for a body that is
 * not JSON at all (an HTML 502 page from the proxy). The old client read only
 * the string form, and handed the object form straight to `new Error()` —
 * whose message is then "[object Object]", which is what the user would have
 * been shown for every server error.
 */
export function readErrorEnvelope(body: unknown, status: number): ErrorEnvelope {
  const error = isRecord(body) ? body.error : undefined
  const raw = typeof error === 'string' ? error : isRecord(error) ? error.message : undefined
  const envelope: ErrorEnvelope = {
    message: typeof raw === 'string' && raw.trim() ? raw : `Tracely server request failed (${status})`
  }
  if (isRecord(error)) {
    if (typeof error.kind === 'string' && error.kind) envelope.kind = error.kind
    if (typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter)) {
      envelope.retryAfter = error.retryAfter
    }
  }
  return envelope
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
