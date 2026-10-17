// findingFilter.ts and problemKindsFor's `findings`: Settings → Checking on
// the desktop (2026-10-16, the extension's mirrored).
import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL_FINDINGS, CITATION_KINDS, CLEAR_KINDS, EVIDENCE_KINDS, filterKinds, findingFilterFrom } from './findingFilter.ts'
import { problemKindsFor } from './problemKind.ts'
import type { ScreenWatchProblemKind } from './problemKind.ts'

const EVERY: ScreenWatchProblemKind[] = [
  'fabricated-citation', 'citation-defect', 'unsupported-by-evidence', 'contradicted-claim', 'overstated-claim',
  'unverified-statistic', 'no-sources', 'outside-index', 'weak-evidence', 'partial-evidence', 'off-topic',
  'missing-citation', 'cited-unverified'
]

test('every finding kind is in exactly one group: errors, needs evidence, or citation issues', () => {
  const errors = EVERY.filter((k) => !EVIDENCE_KINDS.includes(k) && !CITATION_KINDS.includes(k))
  assert.deepEqual(errors.sort(), ['contradicted-claim', 'fabricated-citation'], 'red: never switched off')
  for (const k of EVIDENCE_KINDS) assert.ok(!CITATION_KINDS.includes(k), k)
})

test('the switches: Needs evidence and Citation issues can go; a factual error and "searching" never do', () => {
  assert.deepEqual(filterKinds(EVERY, ALL_FINDINGS), EVERY, 'the default changes nothing')
  const noEvidence = filterKinds(EVERY, { ...ALL_FINDINGS, evidence: false })
  for (const k of EVIDENCE_KINDS) assert.ok(!noEvidence.includes(k), k)
  assert.ok(noEvidence.includes('missing-citation') && noEvidence.includes('contradicted-claim'))
  const neither = filterKinds([...EVERY, 'searching'], { ...ALL_FINDINGS, evidence: false, citations: false })
  assert.deepEqual(neither.sort(), ['contradicted-claim', 'fabricated-citation', 'searching'])
})

test('Only clear errors keeps what is certain by nature; statements about a search go', () => {
  assert.deepEqual(filterKinds(EVERY, { ...ALL_FINDINGS, strictness: 'clear' }).sort(), [...CLEAR_KINDS].sort())
})

test('stored strings read safely', () => {
  assert.deepEqual(findingFilterFrom({}), ALL_FINDINGS)
  assert.deepEqual(findingFilterFrom({ showEvidenceKinds: 'false', showCitationKinds: 'true', checkingStrictness: 'thorough' }), {
    evidence: false, citations: true, strictness: 'thorough'
  })
  assert.equal(findingFilterFrom({ checkingStrictness: 'nonsense' }).strictness, 'balanced')
})

test('problemKindsFor: the filter applies to every surface, and Thorough asks a general statement for a source', () => {
  const general = 'Technology has changed the way people communicate with each other.'
  const base = {
    claimType: 'general' as const,
    claimText: general,
    hasInlineCitation: false,
    evidence: { score: 10, count: 0, hasRelevantSource: false },
    critiqueVerdict: null
  }
  assert.deepEqual(problemKindsFor(base), [], 'balanced: a general statement owes no source')
  assert.deepEqual(problemKindsFor({ ...base, findings: { ...ALL_FINDINGS, strictness: 'thorough' } }), ['no-sources'])
  const figure = { ...base, claimType: 'statistic' as const, claimText: 'In 2019, 64 percent of teenagers owned a smartphone.' }
  assert.deepEqual(problemKindsFor(figure), ['unverified-statistic'])
  assert.deepEqual(problemKindsFor({ ...figure, findings: { ...ALL_FINDINGS, evidence: false } }), [], 'Needs evidence off: nothing to say')
  assert.deepEqual(problemKindsFor({ ...figure, evidence: null }), ['searching'], 'not searched yet is not a finding')
  const contradicted = { ...figure, critiqueVerdict: 'contradicted' as const, evidence: { score: 80, count: 3, hasRelevantSource: true } }
  const shown = problemKindsFor({ ...contradicted, findings: { evidence: false, citations: false, strictness: 'clear' } })
  assert.ok(shown.includes('contradicted-claim'), `a factual error is always shown: ${shown.join(', ')}`)
})
