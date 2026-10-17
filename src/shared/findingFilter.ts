// Settings → Checking (2026-10-16, the extension's Checking mirrored on the
// desktop): which kinds of finding are shown, and how sure a finding must be.
// A leaf, free of imports but types, so problemKind.ts can use it and the test
// runner can load it.
//
// The switches follow the colour vocabulary (problemCopy.ts PROBLEM_COLOR,
// docs/design-file.md): blue is "Needs evidence", amber is "Citation issues",
// and red — a claim the evidence contradicts, a citation that names a work
// that does not exist — is a factual error, never switched off. The extension
// draws the same line: its "Needs evidence" and "Citation issues" switches,
// and a "false" verdict always shown.
import type { ScreenWatchProblemKind } from './problemKind'
import { neverFlagList, neverFlagSet } from './neverFlag.ts'

export type Strictness = 'clear' | 'balanced' | 'thorough'

export interface FindingFilter {
  /** The blue kinds ("Needs evidence"). */
  evidence: boolean
  /** The amber kinds ("Citation issues"). */
  citations: boolean
  strictness: Strictness
  /** "Never flag this": sentences by neverFlagKey, never flagged at all, a factual error included (neverFlag.ts). */
  never?: ReadonlySet<string>
}

/** As the app was before these settings: everything shown, balanced. */
export const ALL_FINDINGS: FindingFilter = { evidence: true, citations: true, strictness: 'balanced' }

export const EVIDENCE_KINDS: readonly ScreenWatchProblemKind[] = [
  'unsupported-by-evidence',
  'unverified-statistic',
  'no-sources',
  'weak-evidence',
  'partial-evidence'
]
export const CITATION_KINDS: readonly ScreenWatchProblemKind[] = [
  'citation-defect',
  'missing-citation',
  'cited-unverified',
  'outside-index',
  'overstated-claim',
  'off-topic'
]

/**
 * "Only clear errors". Desktop verdicts carry no confidence (unlike the
 * extension's high/medium/low), so it keeps the kinds that are certain by
 * nature: the evidence contradicts the claim, the cited work does not exist,
 * or the citation is malformed on its face. What it drops are statements about
 * a search ("nothing found", "weak", "partial"), which can miss a real source.
 */
export const CLEAR_KINDS: readonly ScreenWatchProblemKind[] = ['contradicted-claim', 'fabricated-citation', 'citation-defect']

/** One sentence's kinds as Settings → Checking wants them shown. "searching" is never a finding, and stays. */
export function filterKinds(kinds: ScreenWatchProblemKind[], filter: FindingFilter): ScreenWatchProblemKind[] {
  return kinds.filter((k) => {
    if (k === 'searching') return true
    if (filter.strictness === 'clear' && !CLEAR_KINDS.includes(k)) return false
    if (!filter.evidence && EVIDENCE_KINDS.includes(k)) return false
    if (!filter.citations && CITATION_KINDS.includes(k)) return false
    return true
  })
}

/** The stored settings strings (settingsRepo), read safely: anything unknown is the default. */
export function findingFilterFrom(raw: {
  showEvidenceKinds?: string
  showCitationKinds?: string
  checkingStrictness?: string
  neverFlagSentences?: string
}): FindingFilter {
  const s = raw.checkingStrictness
  const never = neverFlagList(raw.neverFlagSentences)
  return {
    evidence: raw.showEvidenceKinds !== 'false',
    citations: raw.showCitationKinds !== 'false',
    strictness: s === 'clear' || s === 'thorough' ? s : 'balanced',
    ...(never.length > 0 ? { never: neverFlagSet(never) } : {})
  }
}
