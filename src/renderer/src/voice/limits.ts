/* Tracer Voice's limits in words: when the minutes come back, in the
 * student's own clock, and what each eligibility refusal says.
 *
 * The server counts days and months on its own clock (its usage day; the
 * month in UTC) and says when they turn over as `resetAt`. A student west of
 * the server can be told "tomorrow" when the minutes are back this evening,
 * so the copy names the time instead: "They come back at 7:00 PM".
 *
 * A leaf (shared/ipc-contract only, imported with `.ts`) so node --test loads it.
 */
import {
  VOICE_KIND_COPY,
  type VoiceEligibilityReason,
  type VoiceEligibilityResponse
} from '../../../shared/ipc-contract.ts'

/** Locale and time zone, for tests; the student's own when left out. */
export interface ClockOptions {
  locale?: string
  timeZone?: string
}

const DAY_MS = 86_400_000

/** The calendar day `at` falls on in the given zone, as a UTC midnight timestamp. */
function dayNumber(at: Date, o: ClockOptions): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: o.timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  }).formatToParts(at)
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(n('year'), n('month') - 1, n('day')) / DAY_MS
}

function clockTime(at: Date, o: ClockOptions): string {
  return new Intl.DateTimeFormat(o.locale, { hour: 'numeric', minute: '2-digit', timeZone: o.timeZone }).format(at)
}

/** Whether `at` is exactly midnight on the zone's clock. */
function isMidnight(at: Date, o: ClockOptions): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: o.timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(at)
  return Number(parts.find((p) => p.type === 'hour')?.value) === 0 && Number(parts.find((p) => p.type === 'minute')?.value) === 0
}

/**
 * When `resetAt` comes, said from `now`: "at 7:00 PM", "tomorrow at 7:00 AM",
 * "at midnight", "on Friday at 7:00 PM", "on November 1". null when resetAt
 * is missing, unreadable or already past (the caller says it without a time).
 */
export function whenBack(resetAt: string | null | undefined, now: Date = new Date(), o: ClockOptions = {}): string | null {
  if (!resetAt) return null
  const at = new Date(resetAt)
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) return null
  const days = dayNumber(at, o) - dayNumber(now, o)
  const midnight = isMidnight(at, o)
  const time = clockTime(at, o)
  if (days <= 0) return `at ${time}`
  if (days === 1) return midnight ? 'at midnight' : `tomorrow at ${time}`
  const day =
    days < 7
      ? new Intl.DateTimeFormat(o.locale, { weekday: 'long', timeZone: o.timeZone }).format(at)
      : new Intl.DateTimeFormat(o.locale, { month: 'long', day: 'numeric', timeZone: o.timeZone }).format(at)
  return midnight ? `on ${day}` : `on ${day} at ${time}`
}

export type VoiceLimitKind = 'daily-limit' | 'monthly-limit'

/** A refused start or check for a used-up allowance, with when it comes back when the server said. */
export function limitMessage(kind: VoiceLimitKind, resetAt: string | null | undefined, now: Date = new Date(), o: ClockOptions = {}): string {
  const when = whenBack(resetAt, now, o)
  if (!when) return VOICE_KIND_COPY[kind]
  const which = kind === 'daily-limit' ? "today's" : "this month's"
  return `You've used ${which} voice minutes. They come back ${when}; until then, Tracer is here by text.`
}

/**
 * The start of the server's next usage month (the 1st, 00:00 UTC — the
 * contract's voice_monthly resetAt), for a call cut by the month's allowance:
 * the start answer carries only today's resetAt.
 */
export function nextUsageMonth(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
}

/** Each refusal's headline; the error states share them (session.ts errorTitle). */
export const REFUSAL_TITLE: Readonly<Record<VoiceEligibilityReason, string>> = {
  plan: 'Voice is part of Pro',
  'daily-limit': "Today's voice minutes are used",
  'monthly-limit': "This month's voice minutes are used",
  busy: 'Another call is open',
  off: "Voice isn't available"
}

export interface VoiceRefusal {
  reason: VoiceEligibilityReason
  title: string
  /** The next step, in the app's own words (the server's for `off`, which names why). */
  message: string
}

/** An eligibility refusal as the voice view shows it, before any consent sheet or microphone prompt. */
export function refusalFor(
  e: { reason: VoiceEligibilityReason; message?: string; resetAt?: string },
  now: Date = new Date(),
  o: ClockOptions = {}
): VoiceRefusal {
  const title = REFUSAL_TITLE[e.reason]
  switch (e.reason) {
    case 'plan':
      return { reason: e.reason, title, message: VOICE_KIND_COPY.plan }
    case 'daily-limit':
    case 'monthly-limit':
      return { reason: e.reason, title, message: limitMessage(e.reason, e.resetAt, now, o) }
    case 'busy':
      return { reason: e.reason, title, message: VOICE_KIND_COPY.busy }
    case 'off':
      return {
        reason: e.reason,
        title,
        message: e.message?.trim() || "Voice isn't available right now. You can keep chatting with Tracer by text."
      }
  }
}

const minutes = (n: number): string => `${n} ${n === 1 ? 'minute' : 'minutes'}`

/**
 * Settings → Voice's line about the allowance: the server's answer when it
 * gave one (an allowed check's figures, or why not and when that lifts),
 * else the figures last seen, and the plan this window knows. '' when there
 * is nothing to say.
 */
export function settingsVoiceLine(
  input: {
    eligibility: VoiceEligibilityResponse | null
    seen: { todaySec: number | null; monthSec: number | null }
    /** The window's own plan read is below Pro (used only without an answer). */
    needsPro: boolean
  },
  now: Date = new Date(),
  o: ClockOptions = {}
): string {
  const e = input.eligibility
  if (e && !e.allowed) {
    switch (e.reason) {
      case 'plan':
        return 'Voice is part of Pro.'
      case 'daily-limit':
        return `Today's voice minutes are used; they come back ${whenBack(e.resetAt, now, o) ?? 'tomorrow'}.`
      case 'monthly-limit':
        return `This month's voice minutes are used; they come back ${whenBack(e.resetAt, now, o) ?? 'next month'}.`
      case 'off':
        return e.message
      case 'busy':
        break
    }
  }
  const today = e?.allowed ? e.remainingSeconds : input.seen.todaySec
  const month = e?.allowed ? (e.remainingMonthSeconds ?? null) : input.seen.monthSec
  const parts: string[] = []
  if (!e && input.needsPro) parts.push('Voice is part of Pro.')
  const t = today === null ? null : Math.floor(today / 60)
  const m = month === null ? null : Math.floor(month / 60)
  if (t !== null && m !== null) parts.push(`About ${minutes(t)} of voice left today, ${m} this month.`)
  else if (t !== null) parts.push(`About ${minutes(t)} of voice left today.`)
  else if (m !== null) parts.push(`About ${minutes(m)} of voice left this month.`)
  return parts.join(' ')
}
