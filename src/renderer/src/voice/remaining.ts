/* Voice minutes left, as last seen — a convenience for Settings, not a ledger.
 *
 * The server says what is left when a call starts and when the voice view
 * checks eligibility. The figure is kept in this renderer's storage with the
 * moment it stops being true: today's at the server's resetAt (its usage day,
 * which need not be the student's — a US student's minutes can come back in
 * the evening), the month's at the 1st (UTC). A figure saved without a resetAt
 * (an older server) lasts until the student's own date changes, as before.
 *
 * A leaf (voicePolicy and limits only) so node --test loads it.
 */
import { VOICE_MIN_BILLED_SECONDS } from '../../../shared/voicePolicy.ts'
import { nextUsageMonth } from './limits.ts'

const KEY = 'tracely.voice.remainingToday'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** What Settings can say: each figure, or null when unknown or expired. */
export interface VoiceAllowance {
  todaySec: number | null
  monthSec: number | null
  /** When today's figure lapses (ISO-8601), when the server said. */
  resetAt: string | null
}

interface Saved {
  /** The student's local date when saved; today's expiry when there is no resetAt. */
  day: string
  seconds: number
  resetAt?: string
  monthSeconds?: number
  monthResetAt?: string
}

function defaultStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

function readable(iso: unknown): iso is string {
  return typeof iso === 'string' && !Number.isNaN(Date.parse(iso))
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

function save(value: Saved, store: Store | null): void {
  try {
    store?.setItem(KEY, JSON.stringify(value))
  } catch {
    /* storage blocked: Settings just won't show the figure */
  }
}

/** What the server says is left right now (an eligibility answer), with when today's figure lapses. */
export interface AllowanceSeen {
  remainingSeconds: number
  remainingMonthSeconds?: number | null
  resetAt?: string | null
}

/** Keeps an exact figure: an allowed eligibility answer. */
export function rememberVoiceAllowance(seen: AllowanceSeen, at: Date = new Date(), store: Store | null = defaultStore()): void {
  if (!finite(seen.remainingSeconds)) return
  const value: Saved = { day: localDay(at), seconds: Math.round(seen.remainingSeconds) }
  if (readable(seen.resetAt)) value.resetAt = seen.resetAt
  if (finite(seen.remainingMonthSeconds)) {
    value.monthSeconds = Math.round(seen.remainingMonthSeconds)
    value.monthResetAt = nextUsageMonth(at)
  }
  save(value, store)
}

/**
 * After a call: what was left when it started, less what it used (the
 * server's metered seconds when it answered the hang-up, else the app's own
 * clock), never less than the minimum a call is billed. The month figure
 * goes down by the same amount.
 */
export function rememberVoiceRemaining(
  remainingAtStartSec: number,
  talkedSec: number,
  context: { resetAt?: string | null; remainingMonthSec?: number | null } = {},
  at: Date = new Date(),
  store: Store | null = defaultStore()
): void {
  const used = Math.max(talkedSec, VOICE_MIN_BILLED_SECONDS)
  const month = finite(context.remainingMonthSec) ? Math.max(0, context.remainingMonthSec - used) : null
  rememberVoiceAllowance(
    { remainingSeconds: Math.max(0, remainingAtStartSec - used), remainingMonthSeconds: month, resetAt: context.resetAt },
    at,
    store
  )
}

/** Each figure as last seen, or null once it has lapsed (or was never seen). */
export function readVoiceAllowance(at: Date = new Date(), store: Store | null = defaultStore()): VoiceAllowance {
  const none: VoiceAllowance = { todaySec: null, monthSec: null, resetAt: null }
  try {
    const raw = store?.getItem(KEY)
    if (!raw) return none
    const v = JSON.parse(raw) as Partial<Saved>
    const now = at.getTime()
    const todayLive = readable(v.resetAt) ? now < Date.parse(v.resetAt) : v.day === localDay(at)
    const monthLive = readable(v.monthResetAt) && now < Date.parse(v.monthResetAt)
    return {
      todaySec: todayLive && finite(v.seconds) ? v.seconds : null,
      monthSec: monthLive && finite(v.monthSeconds) ? v.monthSeconds : null,
      resetAt: todayLive && readable(v.resetAt) ? v.resetAt : null
    }
  } catch {
    return none
  }
}

/** Seconds of voice left today as last seen, or null when unknown (no figure since the reset). */
export function readVoiceRemaining(at: Date = new Date(), store: Store | null = defaultStore()): number | null {
  return readVoiceAllowance(at, store).todaySec
}
