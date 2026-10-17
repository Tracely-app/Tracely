// neverFlag.ts and problemKindsFor's `findings.never`: "Never flag this" on
// the desktop (2026-10-17, the extension's mirrored).
import test from 'node:test'
import assert from 'node:assert/strict'
import { NEVER_FLAG_MAX, neverFlagKey, neverFlagList, neverFlagSet, withNeverFlag, withoutNeverFlag } from './neverFlag.ts'
import { ALL_FINDINGS, findingFilterFrom } from './findingFilter.ts'
import { problemKindsFor } from './problemKind.ts'

test('a sentence is one entry whatever its case, spacing, quote marks or end stop (the extension\'s ignoreKey)', () => {
  assert.equal(neverFlagKey('  My grandmother was born in 1890 in "Lagos".  '), 'my grandmother was born in 1890 in lagos')
  assert.equal(neverFlagKey('Our team WON   the final!'), neverFlagKey('our team won the final'))
  assert.equal(neverFlagKey(null), '')
  const once = withNeverFlag([], 'Our team won the final.')
  assert.deepEqual(withNeverFlag(once, 'our team won the final'), once, 'already there')
  assert.deepEqual(withoutNeverFlag(once, 'OUR TEAM WON THE FINAL!'), [])
  const full = Array.from({ length: NEVER_FLAG_MAX }, (_, i) => `Sentence ${i}.`)
  const next = withNeverFlag(full, 'One more.')
  assert.equal(next.length, NEVER_FLAG_MAX)
  assert.equal(next.at(-1), 'One more.', 'the newest are kept')
})

test('the stored list reads safely', () => {
  assert.deepEqual(neverFlagList(''), [])
  assert.deepEqual(neverFlagList('not json'), [])
  assert.deepEqual(neverFlagList('{"a":1}'), [])
  assert.deepEqual(neverFlagList('["A sentence.", 3, "", "  "]'), ['A sentence.'])
  assert.deepEqual(findingFilterFrom({ neverFlagSentences: '[]' }), ALL_FINDINGS, 'an empty list changes nothing')
  assert.ok(findingFilterFrom({ neverFlagSentences: '["Our team won the final."]' }).never?.has('our team won the final'))
})

test('problemKindsFor: a never-flagged sentence has nothing, a factual error and "searching" included', () => {
  const text = 'In 2019, 64 percent of teenagers owned a smartphone.'
  const findings = { ...ALL_FINDINGS, never: neverFlagSet(['in 2019, 64 percent of teenagers owned a smartphone']) }
  const base = {
    claimType: 'statistic' as const,
    claimText: text,
    hasInlineCitation: false,
    evidence: { score: 80, count: 3, hasRelevantSource: true },
    critiqueVerdict: 'contradicted' as const
  }
  assert.ok(problemKindsFor(base).includes('contradicted-claim'))
  assert.deepEqual(problemKindsFor({ ...base, findings }), [])
  assert.deepEqual(problemKindsFor({ ...base, evidence: null, findings }), [])
  assert.ok(problemKindsFor({ ...base, claimText: 'In 2020, 70 percent did.', findings }).length > 0, 'only that sentence')
})
