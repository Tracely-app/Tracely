import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VOICE_KIND_COPY } from '../../../shared/ipc-contract.ts'
import { REFUSAL_TITLE, limitMessage, nextUsageMonth, refusalFor, settingsVoiceLine, whenBack } from './limits.ts'

// A student in Chicago (CDT, UTC-5 in October), on a server whose day turns at UTC midnight.
const CHI = { locale: 'en-US', timeZone: 'America/Chicago' }
const afternoon = new Date('2026-10-10T20:30:00Z') // 3:30 PM in Chicago
const lateNight = new Date('2026-10-11T03:30:00Z') // 10:30 PM in Chicago, already the 11th in UTC

describe('whenBack: the reset in the student’s own clock', () => {
  it('says the time when it is later today', () => {
    strictEqual(whenBack('2026-10-11T00:00:00Z', afternoon, CHI), 'at 7:00 PM')
  })

  it('says tomorrow when the day turns first', () => {
    strictEqual(whenBack('2026-10-12T00:00:00Z', lateNight, CHI), 'tomorrow at 7:00 PM')
  })

  it("says midnight for a reset at the student's own midnight", () => {
    strictEqual(whenBack('2026-10-11T05:00:00Z', afternoon, CHI), 'at midnight')
  })

  it('names the weekday within a week, the date beyond it', () => {
    strictEqual(whenBack('2026-10-14T00:00:00Z', afternoon, CHI), 'on Tuesday at 7:00 PM')
    strictEqual(whenBack('2026-11-01T00:00:00Z', afternoon, CHI), 'on October 31 at 7:00 PM')
    strictEqual(whenBack('2026-11-01T05:00:00Z', afternoon, { ...CHI, timeZone: 'UTC' }), 'on November 1 at 5:00 AM')
    strictEqual(whenBack('2026-11-01T00:00:00Z', afternoon, { ...CHI, timeZone: 'UTC' }), 'on November 1')
  })

  it('has nothing to say for a missing, unreadable or past reset', () => {
    strictEqual(whenBack(undefined, afternoon, CHI), null)
    strictEqual(whenBack('soon', afternoon, CHI), null)
    strictEqual(whenBack('2026-10-10T20:00:00Z', afternoon, CHI), null)
  })
})

describe('limitMessage', () => {
  it('says when the minutes come back, for today and for the month', () => {
    strictEqual(
      limitMessage('daily-limit', '2026-10-11T00:00:00Z', afternoon, CHI),
      "You've used today's voice minutes. They come back at 7:00 PM; until then, Tracer is here by text."
    )
    strictEqual(
      limitMessage('monthly-limit', '2026-11-01T00:00:00Z', afternoon, CHI),
      "You've used this month's voice minutes. They come back on October 31 at 7:00 PM; until then, Tracer is here by text."
    )
  })

  it('falls back to the shared words without a usable resetAt', () => {
    strictEqual(limitMessage('daily-limit', null, afternoon, CHI), VOICE_KIND_COPY['daily-limit'])
    strictEqual(limitMessage('monthly-limit', 'later', afternoon, CHI), VOICE_KIND_COPY['monthly-limit'])
  })
})

describe('refusalFor: what the voice view shows instead of the consent sheet', () => {
  it('plan: the Pro words, whatever the server wrote', () => {
    deepStrictEqual(refusalFor({ reason: 'plan', message: 'plan_limit for user:1' }, afternoon, CHI), {
      reason: 'plan',
      title: 'Voice is part of Pro',
      message: VOICE_KIND_COPY.plan
    })
  })

  it('the limits: their own headline and the reset time', () => {
    const daily = refusalFor({ reason: 'daily-limit', message: 'x', resetAt: '2026-10-11T00:00:00Z' }, afternoon, CHI)
    strictEqual(daily.title, "Today's voice minutes are used")
    ok(daily.message.includes('They come back at 7:00 PM'), daily.message)
    const monthly = refusalFor({ reason: 'monthly-limit', message: 'x', resetAt: '2026-11-01T00:00:00Z' }, afternoon, CHI)
    strictEqual(monthly.title, "This month's voice minutes are used")
    ok(monthly.message.includes('on October 31 at 7:00 PM'), monthly.message)
  })

  it("busy and off: plain words; off keeps the sentence that says why", () => {
    strictEqual(refusalFor({ reason: 'busy', message: 'voice_busy' }).message, VOICE_KIND_COPY.busy)
    strictEqual(refusalFor({ reason: 'off', message: "Voice isn't available in this build." }).message, "Voice isn't available in this build.")
    ok(refusalFor({ reason: 'off', message: '  ' }).message.startsWith("Voice isn't available right now."))
    strictEqual(REFUSAL_TITLE.off, "Voice isn't available")
  })
})

describe('nextUsageMonth', () => {
  it('is the 1st of next month at 00:00 UTC, across a year end', () => {
    strictEqual(nextUsageMonth(afternoon), '2026-11-01T00:00:00.000Z')
    strictEqual(nextUsageMonth(new Date('2026-12-31T23:59:00Z')), '2027-01-01T00:00:00.000Z')
  })
})

describe("settingsVoiceLine: Settings' word on the allowance", () => {
  const none = { todaySec: null, monthSec: null }
  it("an allowed answer's figures, today and this month", () => {
    const e = { allowed: true as const, maxSeconds: 900, remainingSeconds: 1800, remainingMonthSeconds: 7200 }
    strictEqual(settingsVoiceLine({ eligibility: e, seen: none, needsPro: true }), 'About 30 minutes of voice left today, 120 this month.')
  })

  it('why not, and when it lifts', () => {
    const daily = { allowed: false as const, reason: 'daily-limit' as const, message: 'x', resetAt: '2026-10-11T00:00:00Z' }
    strictEqual(settingsVoiceLine({ eligibility: daily, seen: none, needsPro: false }, afternoon, CHI), "Today's voice minutes are used; they come back at 7:00 PM.")
    const monthly = { allowed: false as const, reason: 'monthly-limit' as const, message: 'x' }
    strictEqual(settingsVoiceLine({ eligibility: monthly, seen: none, needsPro: false }), "This month's voice minutes are used; they come back next month.")
    strictEqual(settingsVoiceLine({ eligibility: { allowed: false, reason: 'plan', message: 'x' }, seen: none, needsPro: false }), 'Voice is part of Pro.')
  })

  it('without an answer: the figures last seen, and the plan this window knows', () => {
    strictEqual(settingsVoiceLine({ eligibility: null, seen: { todaySec: 61, monthSec: null }, needsPro: false }), 'About 1 minute of voice left today.')
    strictEqual(settingsVoiceLine({ eligibility: null, seen: { todaySec: null, monthSec: 3000 }, needsPro: true }), 'Voice is part of Pro. About 50 minutes of voice left this month.')
    strictEqual(settingsVoiceLine({ eligibility: null, seen: none, needsPro: false }), '')
  })
})
