// settingsHelp.ts: the Settings page's small decisions (2026-10-16, the
// extension's Settings mirrored on the desktop).
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPORT_SETTINGS_LEAVE_OUT,
  WHATS_NEW,
  buildDiagnostics,
  exportFileName,
  pauseForHour,
  pauseForToday,
  resumeLabel,
  usageFromEntitlement,
  usageRows
} from './settingsHelp.ts'

test('a pause ends an hour from now, or at the next midnight; a pause for today reads "midnight"', () => {
  const now = new Date(2026, 9, 16, 14, 25).getTime()
  assert.equal(pauseForHour(now) - now, 60 * 60 * 1000)
  const midnight = new Date(pauseForToday(now))
  assert.deepEqual([midnight.getDate(), midnight.getHours(), midnight.getMinutes()], [17, 0, 0])
  assert.equal(resumeLabel(pauseForToday(now)), 'midnight')
  assert.match(resumeLabel(pauseForHour(now)), /3:25/)
})

test("the server's usage answer: bars for each limit it names, nothing when it names none", () => {
  const free = usageFromEntitlement({
    limits: { checksPerDay: 5, aiActionsPerDay: 150, sources: { day: 5, month: 40 } },
    usage: { sources: { today: 2, month: 17 } }
  })
  assert.deepEqual(free, { sources: { today: 2, month: 17, day: 5, monthLimit: 40 }, aiActionsPerDay: 150 })
  assert.deepEqual(usageRows(free), [
    { label: 'Source searches today', used: 2, of: 5 },
    { label: 'Source searches this month', used: 17, of: 40 }
  ])
  // A paid plan with no daily allowance: only the month.
  const paid = usageFromEntitlement({ limits: { aiActionsPerDay: null, sources: { day: null, month: 100 } }, usage: { sources: { today: 3, month: 31 } } })
  assert.deepEqual(usageRows(paid), [{ label: 'Source searches this month', used: 31, of: 100 }])
  // A server that meters nothing, or one too old to say, or no answer at all.
  assert.equal(usageFromEntitlement({ plan: 'free', enforced: false }), null)
  assert.equal(usageFromEntitlement(null), null)
  assert.equal(usageFromEntitlement({ limits: { sources: { day: 5, month: 40 } }, usage: {} }), null, 'limits without counts is no bar')
  assert.deepEqual(usageRows(null), [])
})

test('an export is named for its day, and leaves out the bookkeeping', () => {
  assert.equal(exportFileName(new Date('2026-10-16T12:00:00Z')), 'tracely-data-2026-10-16.json')
  assert.ok(EXPORT_SETTINGS_LEAVE_OUT.includes('learnedNamesForCleanup'))
})

test('diagnostics say what a report needs, and never a word of the writing', () => {
  const d = buildDiagnostics({
    version: '0.3.100',
    isPreview: true,
    platform: 'Windows',
    plan: 'free',
    settings: { theme: 'dark', learnedNamesForCleanup: '["Okonkwo"]', crossrefMailto: 'x' },
    screenWatch: {
      enabled: true, active: true, processName: 'WINWORD.EXE', supportsUnderlines: true, claimCount: 3,
      lastError: null, blockedApp: null, authRequired: false, text: 'the whole essay'
    }
  })
  assert.equal(d.version, '0.3.100')
  assert.equal(d.build, 'preview')
  assert.deepEqual(d.settings, { theme: 'dark' }, 'no learned names')
  const sw = d.screenWatch as Record<string, unknown>
  assert.equal(sw.processName, 'WINWORD.EXE')
  assert.equal('text' in sw, false, 'what it is doing, not what it read')
  assert.equal(JSON.stringify(d).includes('the whole essay'), false)
  assert.equal(JSON.stringify(d).includes('Okonkwo'), false)
})

test("what's new is newest first, dated, with at least a few changes", () => {
  assert.ok(WHATS_NEW.length >= 3)
  for (let i = 1; i < WHATS_NEW.length; i++) assert.ok(WHATS_NEW[i - 1].date >= WHATS_NEW[i].date, WHATS_NEW[i].date)
  for (const c of WHATS_NEW) assert.match(c.date, /^\d{4}-\d{2}-\d{2}$/)
})
