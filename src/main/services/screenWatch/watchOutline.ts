import type { Claim, DocumentOutline } from '@shared/types'
import type { ScreenWatchStructure } from '@shared/ipc-contract'
import { splitParagraphs } from '@shared/paragraphSplit'
import { draftStats } from './draftStats'
import { analyzeStructure } from '../structure/analyzeStructure'
import { claimsWithoutEvidence, computeEvidenceCoverage } from '../structure/evidenceCoverage'
import { describeFit, structureFit } from './structureFit'
import { logScreenWatch } from './debugLog'
import { paragraphPreviews } from '../../../shared/paragraphPreview.ts'

/**
 * The structural read of a document being watched in another application.
 *
 * The same engine the in-app Structure rail uses, pointed at UI Automation's
 * text instead of the editor's. Everything here is local — paragraph splitting,
 * role heuristics, the rubric, the weakness rules — so unlike critique this can
 * run automatically without spending anything, the same reasoning that lets
 * `triggerEvidenceSearch` auto-run against the free academic APIs.
 *
 * Nothing is persisted. `analyzeStructure` takes `documentId`/`analysisId` as
 * nullable precisely so an ephemeral caller like this one can use it, and
 * `saveOutline` is never involved.
 */

/**
 * Defensive ceiling mirroring MAX_TEXT_CHARS in ipc/structureHandlers.ts. That
 * path has a zod schema in front of it; this one has no gate at all, and UIA
 * returns the whole document rather than the visible part.
 */
const MAX_TEXT_CHARS = 400_000

// `paragraphPreviews` moved to shared/paragraphPreview.ts when the document
// editor started rendering the same report and needed the same truncation.
// Re-exported so this module's existing importers do not have to care, and the
// `.ts` extension is what lets Node's type-stripping test runner follow it.
export { PREVIEW_CHARS, paragraphPreviews } from '../../../shared/paragraphPreview.ts'

export interface WatchOutlineInput {
  /**
   * The text the claims were detected against — NOT the current UIA snapshot.
   *
   * Every paragraph index, role and weakness is a joint function of the text
   * and the claims found in it. Analyzing live text while bucketing claims
   * detected from older text lets a claim relocate into a different paragraph
   * and flips its role underneath the score. Using the analyzed text also damps
   * the whole feature for free: it changes at most once per detection, which is
   * already rate-limited to one per MIN_ANALYSIS_INTERVAL_MS past an 80-char
   * delta, so the score reads as a fresh reading rather than a live meter.
   */
  analyzedText: string
  /** Claims with their evidence scores already folded in — see withEvidenceScores. */
  claims: Claim[]
  analyzedAt: string
}

/**
 * Returns null when the extracted text cannot be trusted to have real paragraph
 * boundaries, or when the draft is too short for the rubric to have an opinion.
 * The overlay then shows nothing at all, which is the honest output — see
 * structureFit.ts for why silence is the right failure direction here.
 */
export function computeWatchOutline({
  analyzedText,
  claims,
  analyzedAt
}: WatchOutlineInput): ScreenWatchStructure | null {
  const text = analyzedText.length > MAX_TEXT_CHARS ? analyzedText.slice(0, MAX_TEXT_CHARS) : analyzedText
  const spans = splitParagraphs(text)

  const fit = structureFit({ paragraphs: spans.map((s) => s.text), textLength: text.length })
  if (fit !== 'ok') {
    logScreenWatch(`structure: no reading — ${describeFit(fit)} (${spans.length} paragraph(s))`)
    return null
  }

  const coverage = computeEvidenceCoverage(claims, text)
  /**
   * NO `classified` HERE, AND THAT IS THE POINT.
   *
   * `structureHandlers` passes model-assigned roles from the graded read
   * (/api/grade); this caller deliberately does not, so Screen Watch labels
   * paragraphs with the local heuristics and pays nothing.
   *
   * Screen Watch is passive and always-on: it runs on a 1200ms poll over
   * whatever window has focus, so a paid call on this path is a bill the user
   * did not ask for and cannot watch being run up. That is the same line
   * `screenWatchService.ts` holds for critique — evidence search gets to stay
   * automatic precisely because it only hits the four free public APIs — and
   * it is the line to hold when this comes up again.
   *
   * The cost is real and is not a bug: the draft score that follows the writer
   * into Word is computed from regex roles, so it can differ from the one the
   * editor shows for the same text. If that becomes the complaint, the answer
   * is an opt-in Settings toggle, not quietly adding the call here.
   */
  const outline: DocumentOutline = analyzeStructure({
    documentId: null,
    analysisId: null,
    text,
    claims,
    claimsWithoutEvidence: claimsWithoutEvidence(claims, text),
    coverage,
    analyzedAt
  })

  // The length gate that used to sit here is gone with `applicable` — a short
  // draft now gets a low score rather than no chip. `fit` above still refuses,
  // and for a different reason it is worth not conflating with this one: it
  // judges whether the EXTRACTED TEXT is trustworthy at all, which is a
  // question about UIA rather than about the writing.
  return {
    score: outline.score,
    complete: outline.complete,
    components: outline.components,
    coverage: outline.coverage,
    weaknesses: outline.weaknesses,
    paragraphs: outline.paragraphs,
    // Carried through so the overlay names paragraphs the way the in-app report
    // does. Recomputing it here from `spans` would be a second answer to a
    // question analyzeStructure has already answered, free to disagree.
    titleParagraph: outline.titleParagraph,
    previews: paragraphPreviews(spans.map((s) => s.text)),
    // Over `text`, not `analyzedText`: the truncated copy is what every other
    // figure here was computed from, and a word count that disagreed with the
    // paragraphs beside it would be the more confusing kind of wrong.
    stats: draftStats(text)
  }
}
