import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readVoiceAllowance, readVoiceRemaining, rememberVoiceAllowance, rememberVoiceRemaining } from './remaining.ts'

function memoryStore() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data
  }
}

const start = new Date('2026-10-10T20:30:00Z')
const RESET = '2026-10-11T00:00:00.000Z' // the server's next usage day

describe('voice minutes as last seen', () => {
  it('after a call: what was left less what the server metered, today and this month', () => {
    const store = memoryStore()
    rememberVoiceRemaining(1800, 300, { resetAt: RESET, remainingMonthSec: 6000 }, start, store)
    deepStrictEqual(readVoiceAllowance(start, store), { todaySec: 1500, monthSec: 5700, resetAt: RESET })
  })

  it('bills a short call at the minimum, and never goes below zero', () => {
    const store = memoryStore()
    rememberVoiceRemaining(600, 3, { resetAt: RESET, remainingMonthSec: 10 }, start, store)
    deepStrictEqual(readVoiceAllowance(start, store), { todaySec: 585, monthSec: 0, resetAt: RESET })
  })

  it("lapses today's figure at the server's resetAt — not at the student's midnight — and keeps the month's", () => {
    const store = memoryStore()
    rememberVoiceAllowance({ remainingSeconds: 900, remainingMonthSeconds: 4000, resetAt: RESET }, start, store)
    strictEqual(readVoiceRemaining(new Date('2026-10-10T23:59:00Z'), store), 900)
    deepStrictEqual(readVoiceAllowance(new Date('2026-10-11T00:00:01Z'), store), { todaySec: null, monthSec: 4000, resetAt: null })
  })

  it('lapses the month figure on the 1st (UTC)', () => {
    const store = memoryStore()
    rememberVoiceAllowance({ remainingSeconds: 900, remainingMonthSeconds: 4000, resetAt: RESET }, start, store)
    strictEqual(readVoiceAllowance(new Date('2026-10-31T23:59:00Z'), store).monthSec, 4000)
    strictEqual(readVoiceAllowance(new Date('2026-11-01T00:00:01Z'), store).monthSec, null)
  })

  it('without a resetAt (an older server) lasts until the local date changes, as before', () => {
    const store = memoryStore()
    const noon = new Date(2026, 9, 10, 12, 0)
    rememberVoiceRemaining(1800, 600, {}, noon, store)
    deepStrictEqual(readVoiceAllowance(new Date(2026, 9, 10, 23, 0), store), { todaySec: 1200, monthSec: null, resetAt: null })
    strictEqual(readVoiceRemaining(new Date(2026, 9, 11, 0, 1), store), null)
  })

  it('reads a figure saved by the previous build ({day, seconds})', () => {
    const store = memoryStore()
    const noon = new Date(2026, 9, 10, 12, 0)
    store.setItem('tracely.voice.remainingToday', JSON.stringify({ day: '2026-10-10', seconds: 420 }))
    strictEqual(readVoiceRemaining(noon, store), 420)
  })

  it('has nothing without storage, or with junk in it', () => {
    deepStrictEqual(readVoiceAllowance(start, null), { todaySec: null, monthSec: null, resetAt: null })
    const store = memoryStore()
    store.setItem('tracely.voice.remainingToday', '{not json')
    strictEqual(readVoiceRemaining(start, store), null)
    rememberVoiceAllowance({ remainingSeconds: Number.NaN }, start, store)
    strictEqual(store.data.get('tracely.voice.remainingToday'), '{not json')
  })
})
