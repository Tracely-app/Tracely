import type { ServerModel } from '@shared/plan'
import { getInstallId } from '../storage/config'
import { getAccessToken } from './identity'
import { modelForCall } from './modelTier'
import {
  RETRY_DELAY_MS,
  isTimeout,
  readErrorEnvelope,
  shouldRetry,
  timeoutFor,
  type CallFailure,
  type FailureStage
} from './serverCallPolicy'

// The Tracely server's origin, inlined at build time by electron.vite.config.ts
// from TRACELY_API_URL (scripts/env.mjs defaults it to
// https://api.jointracely.com). It is not read from user-editable config, so
// there is no runtime path for a user to see or change which API is used.
//
// This used to be RELAY_URL plus a RELAY_TOKEN sent as `x-tracely-token` on
// every call. The token is gone rather than renamed: it shipped inside every
// installer, so it was readable by anyone who unpacked one, and it said "this
// is a Tracely build" without saying who was calling. The server does not read
// it. Who is calling is the Supabase access token when there is a session and
// the install id when there is not — see requestHeaders below.
declare const __API_URL__: string

/**
 * Whether this build has a server compiled in at all. Lets a caller disable an
 * AI affordance up front (Tracer's composer does this) instead of letting the
 * user type a question and only then hit the "no server configured" error
 * thrown by callServer below.
 *
 * True for every ordinary build, since the URL has a default. Only a build
 * that blanks the define on purpose — the e2e config and the eval-bundle check,
 * which must never be able to spend — answers false.
 */
export function isServerConfigured(): boolean {
  return Boolean(__API_URL__)
}

/**
 * A failed server call, carrying what the retry policy and the callers need:
 * where it failed (`stage`), the HTTP `status` when there was one, and the
 * server's `kind` (`plan_limit`, `truncated`, …) when it sent one.
 *
 * `message` is always something a person can read. The server's envelope is
 * `{error:{kind,message}}`; passing that object to Error unread is how every
 * server error would have reached the user as "[object Object]".
 */
export class ServerCallError extends Error implements CallFailure {
  readonly stage: FailureStage
  readonly status?: number
  readonly kind?: string
  /** Seconds, when the server said how long to wait. */
  readonly retryAfter?: number

  constructor(message: string, failure: CallFailure & { retryAfter?: number }) {
    super(message)
    this.name = 'ServerCallError'
    this.stage = failure.stage
    this.status = failure.status
    this.kind = failure.kind
    this.retryAfter = failure.retryAfter
  }
}

/**
 * Is this failure "you are not signed in" rather than "something broke"?
 *
 * Worth distinguishing because it is the one failure the user can fix
 * themselves. Everything else (502, timeout, quota) is either transient or out
 * of their hands; this one needs them to do something, and silence makes it
 * look like the app is merely slow.
 */
export function isAuthError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  return status === 401 || status === 403
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Who is calling, and what they are asking for, for one call.
 *
 * Resolved once per call rather than once per attempt, so a retry 800ms later
 * sends the identical request — including the identical model, which a caller
 * may already have put in a cache key.
 */
async function requestHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // The server meters a signed-out caller by this id rather than by its
    // address, which carries no daily quota (a school's whole network shares
    // one). Sent even when signed in: the server prefers the user id when the
    // token verifies, and falls back to this when it does not.
    'X-Tracely-Install': getInstallId()
  }
  // Fetched per call rather than cached: access tokens expire hourly and the
  // provider hands back a refreshed one, so caching here would reintroduce the
  // expiry problem supabase-js already solves. Omitted entirely when signed
  // out, rather than sent as "Bearer null".
  const token = await getAccessToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

// Derived from callServer rather than repeated. The literal union has to stay
// spelled out in callServer's own signature because scripts/preflight.mjs reads
// it from the source to decide which routes to verify against production, and
// a second copy here could silently fall behind it.
type Endpoint = Parameters<typeof callServer>[0]

async function requestOnce<T>(endpoint: Endpoint, headers: Record<string, string>, payload: string): Promise<T> {
  const timeoutMs = timeoutFor(endpoint)

  let response: Response
  try {
    response = await fetch(`${__API_URL__}/api/${endpoint}`, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (cause) {
    if (isTimeout(cause)) {
      throw new ServerCallError(`The Tracely server did not answer within ${timeoutMs / 1000} seconds.`, {
        stage: 'timeout',
        kind: 'timeout'
      })
    }
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new ServerCallError(`Could not reach the Tracely server (${detail}).`, { stage: 'network', kind: 'network' })
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: response.statusText }))
    const { message, kind, retryAfter } = readErrorEnvelope(errorBody, response.status)
    throw new ServerCallError(message, { stage: 'http', status: response.status, kind, retryAfter })
  }

  // Past this line the server has done the work and been paid for it, so no
  // failure here is retried — see shouldRetry. The old client could not tell a
  // parse failure from a dropped connection and repeated the paid call.
  try {
    return (await response.json()) as T
  } catch (cause) {
    throw new ServerCallError('The Tracely server sent an answer that could not be read.', {
      stage: 'unreadable',
      status: response.status,
      kind: isTimeout(cause) ? 'timeout' : 'unreadable'
    })
  }
}

// Widening this union is what tells preflight there is a new endpoint to
// verify against production — scripts/preflight.mjs reads this type rather
// than a hardcoded list, so a release cannot ship a client calling a route the
// server has not deployed. That check exists because v0.3.73 shipped a
// headline feature whose endpoint 404'd.
//
// Renamed from callRelay when the desktop moved onto the Tracely server. Two
// endpoints changed on the way: the relay's grade-draft is the server's grade,
// and classify-structure is gone — nothing had called it since grading
// replaced it, yet preflight was still probing it before every release.
/**
 * POSTs `body` to `/api/<endpoint>` and returns the parsed JSON.
 *
 * The body gains `model`: the id the account's resolved tier maps to
 * (MODEL_FOR_TIER). The server treats it as a request and clamps it to the
 * plan it derives from the access token, so it can lower the model but never
 * raise it. Callers that cache pass the model they keyed on in `options`, so
 * the key and the request cannot disagree; anyone else lets it resolve here.
 *
 * It is a body field rather than the relay-era `x-tracely-model-tier` header
 * because the server's app routes were written to take it there, and because
 * a tier NAME is the one value the server's clamp cannot read.
 */
export async function callServer<T>(
  endpoint:
    | 'detect-claims'
    | 'critique'
    | 'correction'
    | 'grade'
    | 'tracer'
    | 'find-sources',
  body: Record<string, unknown>,
  options: { model?: ServerModel } = {}
): Promise<T> {
  if (!__API_URL__) {
    throw new ServerCallError('This build has no Tracely server configured. Set TRACELY_API_URL and rebuild.', {
      stage: 'local'
    })
  }

  const headers = await requestHeaders()
  const model = options.model ?? (await modelForCall())
  const payload = JSON.stringify({ ...body, model })

  try {
    return await requestOnce<T>(endpoint, headers, payload)
  } catch (error) {
    // One retry at most, and only for failures where no answer was produced.
    // Anything that is not a ServerCallError (a missing identity provider, say)
    // is a programming error and repeating it would only repeat it.
    if (!(error instanceof ServerCallError) || !shouldRetry(error)) throw error
    await delay(RETRY_DELAY_MS)
    return await requestOnce<T>(endpoint, headers, payload)
  }
}
