import { useEffect, useState } from 'react'
import type {
  CitationStyle,
  Claim,
  DocumentOutline,
  EvidenceItem,
  CohesionFinding,
  CohesionFindingKind,
  DraftCohesion,
  ParagraphRole,
  Source,
  StructureComponents,
  StructureWeakness,
  StructureWeaknessKind
} from '@shared/types'
// What to DO about each named weakness. A local template, never model output —
// see the header of revisionGuidance.ts for why the report may prescribe the
// move and never the sentence.
import { cohesionGuidanceFor, guidanceFor } from '@shared/revisionGuidance'
import { searchableClaims } from '@shared/coverageCounts'
import { roleBlurbFor } from './roleBlurb'
import SourceIconBox from './SourceIconBox'
import { iconUrlFor } from '@shared/sourceIcon'
import { useFavicons } from '../lib/useFavicons'
import { summariseDraft } from '@shared/draftSummary'
import { tracelyApi } from '../lib/api'
import MarkdownText from './MarkdownText'
import Spinner from './Spinner'
import { ArrowRightIcon, BackIcon, ChevronRightIcon, CloseIcon } from './icons'
import { gradeFor } from './essayGrade'
import { adjustedScore } from '@shared/gradeLevel'
import { useGradeLevel } from '../lib/gradeLevel'
import {
  EssayGradeReportPanel,
  GRADE_DARK,
  GRADE_LIGHT,
  GradePaletteProvider,
  type GradeClaim,
  type GradeInput
} from './EssayGradeReport'
import { useEffectiveDark } from '../lib/theme'
import { hasRelevantSource, problemKindsFor } from '@shared/problemKind'
import { hasInlineCitation } from '@shared/inlineCitation'
import { retrievalScopeFor } from '@shared/retrievalScope'
import { paragraphPreviews } from '@shared/paragraphPreview'
import { CLAIM_TYPE_LABEL } from './claimTypeLabel'
import { sourceInitials } from './citationFlowCopy'
import { paragraphNames, paragraphTag } from './paragraphNames'
import { needsWork } from '@shared/weaknessSeverity'

/**
 * What the document editor's "AI Insights" button opens.
 *
 * Figma "Real Tracely UI" (k7R5x1M9alKktaMLlZFSJn), four frames and the routing
 * between them — Merrick's spec, 2026-08-15:
 *
 *   353:129  Argument check ("SA Grid")   — WHAT AI INSIGHTS OPENS
 *   370:135  Essay Grade Widget           — the compact card, via Back
 *   404:129  Full Report — Expanded       — via "View Full Report"
 *   407:143  Paragraph Detail             — clicking any paragraph
 *   409:141  Find Evidence Result         — via "Find evidence" on a claim
 *
 * The landing view has moved three times and the history is the point: #46
 * opened the compact widget, #47 opened the full report on his instruction,
 * #48 went back to compact when he sent the frame, and on 2026-08-15 he asked
 * for "the OverlayMockup SAGrid widget". No frame carries that name — 353:129
 * is the only one in the file with a BREAKDOWN metrics grid (Support /
 * Relevance / Quality / Recency), and it was previously reachable ONLY via
 * "Open Argument Check", which matches "it's not doing that right now".
 *
 * Back from there lands on the Essay Grade widget rather than the full report,
 * because there is no screen you came from any more; the widget is the hub the
 * other views hang off.
 *
 * THE LABELS ARE THE DESIGN'S. This is the correction to the mistake that ran
 * through PRs #46-#50 and is worth writing down, because it was invisible from
 * inside every one of them.
 *
 * This file used to say the opposite: that the frames grade an essay and Tracely
 * measures how an argument is built, so it would keep the rubric's own words and
 * drop the design's — no "Essay Grade" title, no letter chip, no cohort line.
 * Defensible in isolation. What it meant in practice is that four PRs in a row
 * "fixed" which frame the buttons ROUTED to while the card those routes led to
 * never looked like the frame at all. Merrick kept saying "make it this frame"
 * and screenshotting 370:135; the routing kept getting fixed; the screen kept
 * not changing. Asked why, the honest answer was this paragraph.
 *
 * So: the title is "Essay Grade", the chip is a letter, the buttons read "View
 * Full Report" / "Back to Summary" / "Re-grade Essay". A letter grade is a
 * presentation of `outline.score`, which is a real number the rubric computes —
 * see GRADE_BANDS, whose bands are set so 82 reads B+ exactly as the frame does.
 *
 * ONE line in these frames is not a presentation of anything Tracely has:
 * "Above average for this assignment type" asserts a comparison against other
 * students' work, and there is no cohort and no assignment type to compare
 * against. That slot keeps the design's position, size and weight and says what
 * the score band means instead. Everything else on 370:135 and 404:129 is the
 * design's, verbatim.
 */

const ROLE_LABEL: Record<ParagraphRole, string> = {
  thesis: 'Thesis',
  claim: 'Claim',
  evidence: 'Evidence',
  reasoning: 'Reasoning',
  significance: 'Significance',
  counterargument: 'Counterargument',
  conclusion: 'Conclusion',
  transition: 'Transition',
  unknown: 'Unlabelled'
}

/**
 * The headline on a paragraph's problem card.
 *
 * A short NAME for the finding, above the rubric's own full sentence — the
 * card in the frame leads with one ("Overreaching claim") and explains
 * underneath. These name the same seven kinds `weaknesses.ts` produces and add
 * no judgement of their own; the sentence under each one is still that module's.
 */
const WEAKNESS_LABEL: Record<Exclude<StructureWeaknessKind, 'model-finding'>, string> = {
  'no-thesis': 'No thesis',
  'unsupported-claim': 'Unsupported claim',
  'warrant-gap': 'Evidence left unexplained',
  'new-claim-in-conclusion': 'New claim in the conclusion',
  'evidence-stacking': 'Stacked evidence',
  'no-significance': 'No significance',
  // The prose findings. Named for what the writing DOES, not for what is
  // absent, because each of these quotes the sentence it is about.
  'dropped-evidence': 'Evidence left hanging',
  'overreaching-claim': 'Overreaching claim',
  'unsupported-emphasis': 'Emphasis without argument',
  'unclear-reference': 'Unclear reference',
  'restated-conclusion': 'Conclusion restates the thesis',
  'undeveloped-repetition': 'Point repeated, not developed',
  'generic-opening': 'Generic opening',
  'topic-not-thesis': 'A topic, not a thesis',
  'summary-without-point': 'Summary without a point',
  'malformed-citation': 'Citation problem',
  'circular-reasoning': 'Circular reasoning',
  'sequence-as-cause': 'Sequence treated as cause',
  'single-case-generalisation': 'One case, general conclusion',
  'logical-leap': 'The conclusion does not follow',
  'vague-significance': 'Vague claim',
  'off-thesis-paragraph': 'Does not support the thesis'
}

const COMPONENT_LABEL: Array<[keyof StructureComponents, string, number]> = [
  ['thesis', 'Thesis', 20],
  ['governingClaims', 'Governing claims', 20],
  ['warrant', 'Reasoning markers', 20],
  ['counterargument', 'Counterargument', 15],
  ['significance', 'Significance', 15],
  ['conclusion', 'Conclusion', 10]
]

/**
 * Which rubric components belong beside which paragraph role.
 *
 * These are DOCUMENT-level components — scoreDraft.ts scores the draft, not
 * each paragraph — so each renders exactly ONCE, against the first paragraph
 * carrying its role. Repeating a bar down every evidence paragraph would imply
 * each was scored alone, which this rubric does not do.
 */
const ROLE_COMPONENTS: Partial<Record<ParagraphRole, Array<keyof StructureComponents>>> = {
  thesis: ['thesis'],
  claim: ['governingClaims'],
  evidence: ['governingClaims', 'warrant'],
  reasoning: ['warrant'],
  counterargument: ['counterargument'],
  significance: ['significance'],
  conclusion: ['conclusion', 'significance']
}

function toneFor(score: number): 'good' | 'mid' | 'low' {
  return score >= 70 ? 'good' : score >= 40 ? 'mid' : 'low'
}

function verdictFor(pct: number): string {
  return pct >= 70 ? 'Strong' : pct >= 40 ? 'Developing' : 'Needs work'
}

/**
 * The letter on the chip, and the line under it.
 *
 * Both are presentations of `outline.score` — the rubric number scoreDraft.ts
 * already computes — and nothing else. The bands are set so 82 reads B+, which
 * is what the design's own frame shows for 82.
 *
 * The design's line there is "Above average for this assignment type". That one
 * is not a presentation of anything: it asserts a comparison against other
 * students' work on the same assignment, and Tracely has no cohort, no
 * assignment type, and no way to acquire either. It is the single sentence in
 * these frames that cannot be made true by rendering it, so the slot keeps the
 * design's position, size and weight and says what the band actually means.
 */
// Moved to ./essayGrade so the Screen Watch overlay's 'grade' panel can draw
// the same band against the same score. That window loads no stylesheet and so
// cannot import this component; a pure module is the only thing both can share.


/** 238 wpm — Brysbaert 2019, silent reading of English prose. */
const READING_WPM = 238


function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length
}

function readingStats(paragraphTexts: string[]): { words: number; sentences: number; uniqueWords: number } {
  const text = paragraphTexts.join('\n\n')
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []
  return {
    words: words.length,
    // Floors at 1 so words-per-sentence cannot divide by zero.
    sentences: Math.max(1, (text.match(/[.!?]+(?=\s|$)/g) ?? []).length),
    uniqueWords: new Set(words.map((w) => w.toLocaleLowerCase())).size
  }
}

/**
 * What "AI Insights" shows while the rubric runs — Figma 391:540, the
 * "Analyzing Card" on frame 391:342.
 *
 * The spinner is an SVG arc rather than a bordered div, for the same reason
 * ScoreRing below is: the design's arc has round caps, which a `border-top-color`
 * spinner cannot draw. Same 56px box and same green as the score ring, so the
 * thing that spins here is recognisably the thing that fills in a moment later.
 *
 * Only the arc rotates, via `transform` on the <svg>, so the animation is
 * composited rather than re-laying out the card 60 times a second. And the arc
 * is drawn at full opacity with the rotation as the *only* animated property —
 * if the compositor never runs the animation, this degrades to a static
 * three-quarter ring, which still reads as "working". That is the lesson from
 * the overlay's entrance fade, which gated visibility on a frame callback and
 * could end up invisible.
 */
const SPINNER_SIZE = 56
const SPINNER_STROKE = 5

function GradingCard(): JSX.Element {
  const radius = SPINNER_SIZE / 2 - SPINNER_STROKE
  const circumference = 2 * Math.PI * radius
  // 28% of the ring, read off the design's arc.
  const arc = circumference * 0.28

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Grading your writing">
      {/* aria-live, so a screen reader hears that work started rather than
          silence until the grade lands. */}
      <div className="gradeload-card" role="status" aria-live="polite">
        <svg
          className="gradeload-spinner"
          width={SPINNER_SIZE}
          height={SPINNER_SIZE}
          viewBox={`0 0 ${SPINNER_SIZE} ${SPINNER_SIZE}`}
          aria-hidden="true"
        >
          <circle
            className="gradeload-spinner-track"
            cx={SPINNER_SIZE / 2}
            cy={SPINNER_SIZE / 2}
            r={radius}
            strokeWidth={SPINNER_STROKE}
          />
          <circle
            className="gradeload-spinner-arc"
            cx={SPINNER_SIZE / 2}
            cy={SPINNER_SIZE / 2}
            r={radius}
            strokeWidth={SPINNER_STROKE}
            strokeDasharray={`${arc} ${circumference - arc}`}
          />
        </svg>
        <p className="gradeload-title">Grading your writing…</p>
        <p className="gradeload-sub">
          Checking thesis strength, evidence, and citations across each paragraph
        </p>
      </div>
    </div>
  )
}

function ScoreRing({ score, size }: { score: number; size: number }): JSX.Element {
  const stroke = size >= 120 ? 9 : 7
  const radius = size / 2 - stroke
  const circumference = 2 * Math.PI * radius
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference
  return (
    <svg
      className={`argscore-ring tone-${toneFor(score)}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Argument score ${score} of 100`}
    >
      <circle className="argscore-ring-track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} />
      <circle
        className="argscore-ring-fill"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={stroke}
        strokeDasharray={`${filled} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text className="argscore-ring-score" x="50%" y="47%" textAnchor="middle" dominantBaseline="middle">
        {score}
      </text>
      <text className="argscore-ring-max" x="50%" y="68%" textAnchor="middle">
        / 100
      </text>
    </svg>
  )
}

function ComponentBar({ value, max, label }: { value: number; max: number; label: string }): JSX.Element {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div className="argscore-bar" title={`${label}: ${Math.round(value)} of ${max}`}>
      <span className="argscore-bar-label">{label}</span>
      <span className="argscore-bar-pct">{Math.round(pct)}%</span>
      <span className="argscore-bar-track">
        <span className={`argscore-bar-fill tone-${toneFor(pct)}`} style={{ width: `${pct}%` }} />
      </span>
    </div>
  )
}

/**
 * The editor's claims, in the shape the shared report reads.
 *
 * `problemKindsFor` is the same function the underlines go through
 * (components/documentMarks.ts), so a sentence the report calls an
 * overreaching claim is the sentence the editor has underlined orange. It is
 * run here rather than reused from the marks because marks only exist for text
 * currently on screen — a report is about the whole draft.
 */
function gradeClaims(claims: Claim[]): GradeClaim[] {
  return claims.map((claim) => ({
    id: claim.id,
    confidence: claim.confidence,
    hasInlineCitation: hasInlineCitation(claim.text),
    problemKinds:
      claim.strengthScore === null
        ? []
        : problemKindsFor({
            claimType: claim.claimType,
            claimText: claim.text,
            hasInlineCitation: hasInlineCitation(claim.text),
            evidence: {
              score: claim.strengthScore,
              count: claim.scoreBreakdown?.sourceCount ?? 0,
              hasRelevantSource: hasRelevantSource(claim.scoreBreakdown)
            },
            critiqueVerdict: claim.critiqueVerdict,
            citedWorkRead: claim.citedWorkRead,
            outOfIndexScope: retrievalScopeFor(claim.text)
          })
  }))
}

/**
 * A `DocumentOutline` in the shape the shared Essay Grade report reads.
 *
 * The two fields the outline does not carry are the two it deliberately does
 * not: `DocumentOutline` holds no prose (see its note in shared/types.ts), so
 * the paragraph previews and the reading statistics are computed here from the
 * editor's own text, which the overlay's main process has to send instead.
 */
function gradeInput(outline: DocumentOutline, paragraphTexts: string[]): GradeInput {
  const stats = readingStats(paragraphTexts)
  return {
    score: outline.score,
    complete: outline.complete,
    components: outline.components,
    weaknesses: outline.weaknesses,
    paragraphs: outline.paragraphs,
    titleParagraph: outline.titleParagraph,
    // The SAME truncation main applies before sending Screen Watch a payload,
    // not a second rule of this view's own. The first version of this passed
    // the paragraphs through whole, which put an entire essay inside the first
    // card and pushed every card below it off the report — the overlay never
    // hit that because `DocumentOutline` carries no prose and main had to
    // truncate to send any at all.
    previews: paragraphPreviews(paragraphTexts),
    stats
  }
}

/**
 * Which view is showing. `paragraph` carries the 1-based index it is showing;
 * `evidence` the claim whose sources it is listing, and the view to go back to
 * — Find Evidence is reachable from a paragraph detail and from the argument
 * check, so Back has to return to whichever one opened it rather than to a
 * fixed screen.
 */
type View =
  | { name: 'summary' }
  | { name: 'full' }
  | { name: 'paragraph'; index: number }
  | { name: 'argument' }
  // The flow list, and one boundary opened out of it. `boundary` carries the
  // index INTO cohesion.findings rather than the paragraph pair, because two
  // findings can share a boundary — a topic jump and an unanswered
  // counterargument are both about ¶4 → ¶5 and are different pieces of work.
  | { name: 'cohesion' }
  | { name: 'boundary'; findingIndex: number }
  | { name: 'evidence'; claimId: string; from: { name: 'paragraph'; index: number } | { name: 'argument' } }

/**
 * Where in the document a finding is, for "Show me".
 *
 * A claim id when the finding is about a sentence, a paragraph index when it is
 * about a paragraph, and neither when it is about the whole draft — "this essay
 * has no counterargument" is about a paragraph that was never written, so there
 * is nothing to scroll to and the button is not offered.
 */
export interface RevealTarget {
  claimId: string | null
  paragraphIndex: number | null
}

export default function ArgumentScoreModal({
  outline,
  claims,
  paragraphTexts,
  loading,
  error,
  citationStyle,
  onInsertCitation,
  onReanalyze,
  onEvidenceSearched,
  onCheckClaims,
  onCritiqueClaims,
  checking,
  critiquing,
  onReveal,
  onClose
}: {
  outline: DocumentOutline | null
  claims: Claim[]
  paragraphTexts: string[]
  loading: boolean
  error: string | null
  /** The user's configured style — shown on the pill and used to format. */
  citationStyle: CitationStyle
  /**
   * Writes a citation into the document at the end of the claim's sentence.
   *
   * Passed in rather than done here because only the editor owns the
   * contentEditable. Nullable for a surface with no document to write to —
   * where the button is not offered at all rather than offered and inert. The
   * one such surface was the paste-text flow, which is gone, so every current
   * caller passes a real function; the null branch stays because "score a
   * claim list nobody can edit" is a shape this modal should keep handling.
   */
  // Resolves with a report of what the insert did (see CitationInsert in
  // AnalyzeView) — unused here, so typed as unknown rather than dragging the
  // editor's type into the modal. Not Promise<void>: TypeScript does not accept
  // a Promise<T> where Promise<void> is declared.
  onInsertCitation: ((claim: Claim, source: Source, style: CitationStyle) => Promise<unknown>) | null
  onReanalyze: () => void
  /**
   * A claim's evidence search finished and wrote a strength score to the
   * database. The surface that owns the claim list has to re-read it, because
   * nothing else will tell it.
   *
   * Without this the document editor's underlines were unreachable in a single
   * session, and the loop was closed: detection writes `strengthScore: null`,
   * `measureMarks` will not mark an unscored claim, and the only in-editor way
   * to score one is the popover on a mark that therefore never exists. This
   * view could break the cycle — it is the one place a search can be started
   * without an underline — but it kept the result to itself, so the editor went
   * on holding the unscored copy until the document was closed and reopened.
   */
  onEvidenceSearched: () => void
  /**
   * Runs the evidence search over the given claims, in order.
   *
   * The bulk entry point. Every other route into a search here is one claim at
   * a time — the paragraph detail's Find Evidence, the editor's mark popover —
   * and the popover route additionally needs an underline that only a scored
   * claim gets, so a freshly detected draft had no way to check itself at all
   * without clicking through its claims individually. This is the button that
   * used to live on the Structure rail, which is no longer mounted anywhere.
   *
   * Owned by the surface holding the claim list because it is serial with a
   * visible count and has to survive this modal closing mid-sweep.
   */
  onCheckClaims: (ids: string[]) => void
  /**
   * Runs the critique over claims that already have evidence.
   *
   * The only route by which a REASONING problem can be underlined at all:
   * problemKind.ts returns 'unsupported-by-evidence', 'contradicted-claim',
   * 'overstated-claim' and 'fabricated-citation' only when critiqueVerdict is
   * set, and nothing in the editor was setting it.
   */
  onCritiqueClaims: (ids: string[]) => void
  /** Progress of a running sweep, or null when idle. */
  checking: { done: number; total: number } | null
  /** Progress of a running reasoning pass. Separate because it is the paid one. */
  critiquing: { done: number; total: number } | null
  /**
   * Closes the report and takes the writer to the text a finding is about.
   *
   * Owned by the editor, because only the editor can scroll its own
   * contentEditable — and it closes this modal on the way, since at 898px wide
   * there is no showing someone their document with a full-screen report over
   * it.
   */
  onReveal: (target: RevealTarget) => void
  onClose: () => void
}): JSX.Element {
  // Opens on the Essay Grade widget — 370:135, the compact card with the ring
  // and the band.
  //
  // The history matters, because this has moved: #46 opened this card, #47 the
  // full report, #48 back to this card, then on 2026-08-15 it went to the
  // Argument check (353:129) reading "the OverlayMockup SAGrid widget" as the
  // only frame in the file with a metrics grid. That reading was wrong — later
  // the same day: "when I click AI insights it starts with argument check. No.
  // I want it to start with essay grade."
  //
  // So it is named now, and this is settled: Essay Grade first, everything else
  // reached from it. Argument check is one click away under "Open Argument
  // Check", which is where the design puts it.
  const [view, setView] = useState<View>({ name: 'summary' })
  // Settings > Preferences. The report shows the same /100 at every level and
  // bands the LETTER against this — see shared/gradeLevel.ts.
  const gradingLevel = useGradeLevel()
  // The shared Essay Grade report is inline styles (it also renders in the
  // overlay window, which loads no stylesheet), so CSS variables cannot theme
  // it. In THIS window it follows the app theme via the palette provider; the
  // overlay mounts no provider and keeps the frame's light colours verbatim.
  const dark = useEffectiveDark()

  // Its own card, not a state inside the report's card — Figma 391:540
  // ("Analyzing Card") is 340 wide against the report's full width, with its own
  // 24px radius and 32px padding. Rendering it inside `.argscore-card` would
  // draw the design's small card at the report's size, which is the drift that
  // made four earlier PRs "fix" this modal without the screen changing.
  if (loading) return <GradingCard />

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="argscore-title"
      aria-label="Argument score"
    >
      <div className="modal-card argscore-card">
        {error ? (
          <div className="argscore-state">
            <p className="error-text">{error}</p>
            <button className="argscore-btn secondary" onClick={onReanalyze}>
              Try again
            </button>
          </div>
        ) : !outline ? (
          <div className="argscore-state">
            <p>No reading yet.</p>
            <p className="muted">
              The rubric needs a few paragraphs of prose before it has an opinion worth showing.
            </p>
            <button className="argscore-btn secondary" onClick={onReanalyze}>
              Check again
            </button>
          </div>
        ) : view.name === 'evidence' ? (
          <FindEvidenceResult
            claim={claims.find((c) => c.id === view.claimId) ?? null}
            citationStyle={citationStyle}
            onInsertCitation={onInsertCitation}
            onEvidenceSearched={onEvidenceSearched}
            onBack={() => setView(view.from)}
            onClose={onClose}
          />
        ) : view.name === 'paragraph' ? (
          <ParagraphDetail
            outline={outline}
            claims={claims}
            paragraphTexts={paragraphTexts}
            index={view.index}
            onReveal={onReveal}
            onFindEvidence={(claimId) =>
              setView({ name: 'evidence', claimId, from: { name: 'paragraph', index: view.index } })
            }
            onBack={() => setView({ name: 'summary' })}
            onClose={onClose}
          />
        ) : view.name === 'boundary' ? (
          <BoundaryDetail
            finding={outline.cohesion?.findings[view.findingIndex] ?? null}
            paragraphTexts={paragraphTexts}
            tag={(index) => paragraphTag(outline.paragraphs, outline.titleParagraph, index)}
            onReveal={onReveal}
            onBack={() => setView({ name: 'cohesion' })}
            onClose={onClose}
          />
        ) : view.name === 'cohesion' ? (
          <CohesionCheck
            cohesion={outline.cohesion}
            paragraphTexts={paragraphTexts}
            tag={(index) => paragraphTag(outline.paragraphs, outline.titleParagraph, index)}
            onOpen={(findingIndex) => setView({ name: 'boundary', findingIndex })}
            onBack={() => setView({ name: 'full' })}
            onClose={onClose}
          />
        ) : view.name === 'argument' ? (
          <ArgumentCheck
            claims={claims}
            onFindEvidence={(claimId) =>
              setView({ name: 'evidence', claimId, from: { name: 'argument' } })
            }
            onRecheck={(claimId) => onCheckClaims([claimId])}
            checking={checking}
            onClose={onClose}
          />
        ) : view.name === 'full' ? (
          /*
            The SAME report Screen Watch draws over another application, not a
            second reading of the same rubric in this window's own CSS. There
            were two — this one built from index.css classes, the overlay's
            built verbatim from the Figma frame — and they drifted apart at the
            pace of whichever was edited last. Owner's call: the widget's
            breakdown is the one to keep.

            It brings its own header, divider and button row, so this wrapper
            supplies only what the overlay's card supplies around it: the
            modal head's 20/24 padding, a 24px rhythm, and the scroll.
          */
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 24,
              padding: '20px 24px 24px',
              overflowY: 'auto',
              minHeight: 0
            }}
          >
            <GradePaletteProvider palette={dark ? GRADE_DARK : GRADE_LIGHT}>
              <EssayGradeReportPanel
                structure={gradeInput(outline, paragraphTexts)}
                claims={gradeClaims(claims)}
                gradingLevel={gradingLevel}
                onClose={onClose}
                onBackToSummary={() => setView({ name: 'summary' })}
                onArgumentCheck={() => setView({ name: 'argument' })}
                onOpenParagraph={(index) => setView({ name: 'paragraph', index })}
                onFindForClaim={(claimId) =>
                  setView({ name: 'evidence', claimId, from: { name: 'argument' } })
                }
              />
            </GradePaletteProvider>
          </div>
        ) : (
          <ScoreReport
            outline={outline}
            claims={claims}
            paragraphTexts={paragraphTexts}
            compact={view.name === 'summary'}
            onView={setView}
            onReveal={onReveal}
            onCritiqueClaims={onCritiqueClaims}
            critiquing={critiquing}
            onReanalyze={onReanalyze}
            onCheckClaims={onCheckClaims}
            checking={checking}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  )
}

function ModalHead({
  title,
  onBack,
  backLabel = 'Back to summary',
  onClose
}: {
  title: string
  onBack?: () => void
  /**
   * Where Back actually goes. It was hardcoded "Back to summary", which was
   * true of every view that existed when it was written and stopped being true
   * the moment one view opened out of another: the Flow Check returns to the
   * report and a boundary returns to the Flow Check, and a button that names a
   * destination it does not go to is worse than an unlabelled arrow.
   */
  backLabel?: string
  onClose: () => void
}): JSX.Element {
  return (
    <header className="argscore-head">
      {onBack ? (
        <button className="argscore-back" onClick={onBack}>
          <BackIcon size={14} />
          {backLabel}
        </button>
      ) : (
        <h2 className="argscore-title" id="argscore-title">{title}</h2>
      )}
      <button className="argscore-close" onClick={onClose} aria-label="Close">
        <CloseIcon size={16} />
      </button>
    </header>
  )
}

/** 370:135 when compact, 404:129 when not. Same header, the report body appears. */
function ScoreReport({
  outline,
  claims,
  paragraphTexts,
  compact,
  onView,
  onReveal,
  onCritiqueClaims,
  onReanalyze,
  onCheckClaims,
  checking,
  critiquing,
  onClose
}: {
  outline: DocumentOutline
  claims: Claim[]
  paragraphTexts: string[]
  compact: boolean
  onView: (view: View) => void
  onReveal: (target: RevealTarget) => void
  onReanalyze: () => void
  onCheckClaims: (ids: string[]) => void
  onCritiqueClaims: (ids: string[]) => void
  checking: { done: number; total: number } | null
  critiquing: { done: number; total: number } | null
  onClose: () => void
}): JSX.Element {
  const { detected, withRelevantSource, withOwnCitation, unchecked } = outline.coverage
  // Undefined on an outline stored before the field existed — zero disclosure,
  // not zero out-of-scope claims. See EvidenceCoverage.outsideIndexes.
  const outsideIndexes = outline.coverage.outsideIndexes ?? 0
  const checked = detected - unchecked
  // The denominator is claims Tracely could MEANINGFULLY search — the rule and
  // the reason it is floored live in shared/coverageCounts.ts, where the test
  // runner can reach them.
  const searchable = searchableClaims(checked, outsideIndexes, withRelevantSource)
  const { words, sentences, uniqueWords } = readingStats(paragraphTexts)
  const gradingLevel = useGradeLevel()
  const grade = gradeFor(outline.score, gradingLevel)

  const claimed = new Set<keyof StructureComponents>()
  // Named by position, and the title dropped entirely — see paragraphNames.
  // Computed over the FULL list so the names stay aligned with the outline's
  // own indices, then filtered, rather than naming a pre-filtered list and
  // having every index off by one.
  const names = paragraphNames(outline.paragraphs, outline.titleParagraph)
  const rows = outline.paragraphs.map((paragraph) => {
    const keys = (ROLE_COMPONENTS[paragraph.role] ?? []).filter((key) => !claimed.has(key))
    keys.forEach((key) => claimed.add(key))
    const weaknesses = outline.weaknesses.filter((w) => w.paragraphIndex === paragraph.index)
    return {
      paragraph,
      name: names[paragraph.index - 1] ?? null,
      keys,
      // This paragraph's own findings, which is what the badge claims to be
      // about. It was the average of `outline.components` for this paragraph's
      // ROLE — draft-level numbers, identical for every paragraph sharing a
      // role — so a paragraph carrying an overreaching claim printed "Strong"
      // beside the finding, and the same paragraph printed "Needs Work" in the
      // full report, which asks the paragraph's own findings. Owner,
      // 2026-08-19: the two disagreed on the same screen.
      strong: !needsWork(weaknesses.map((w) => w.kind)),
      weaknesses
    }
  }).filter((row) => row.name !== null)
  const missing = COMPONENT_LABEL.filter(([key]) => !claimed.has(key))
  const draftWeaknesses = outline.weaknesses.filter((w) => w.paragraphIndex === null)
  // Unchecked claims, in draft order. `strengthScore === null` is the same test
  // `outline.coverage.unchecked` counts with, so the button's number and the
  // "N not checked yet" line above it can never disagree.
  const pending = claims.filter((claim) => claim.strengthScore === null).map((claim) => claim.id)
  // Evidence has resolved and no verdict has been reached. Excludes unsearched
  // claims on purpose: a critique handed an empty evidence list returns a
  // verdict about the search rather than about the sentence.
  const uncritiqued = claims
    .filter((claim) => claim.strengthScore !== null && claim.critiqueVerdict === null)
    .map((claim) => claim.id)

  // Which paragraph row is expanded. One at a time, and the first row carrying
  // a finding opens by default — the report is read top-down and an all-collapsed
  // list makes the reader hunt for the paragraph that needs them.
  const firstProblem = rows.find((row) => row.weaknesses.length > 0)?.paragraph.index ?? null
  const [expanded, setExpanded] = useState<number | null>(firstProblem)

  return (
    <>
      <ModalHead title={compact ? 'Writing Grade' : 'Writing Grade — Full Report'} onClose={onClose} />

      <div className="argscore-summary">
        {/*
          Always a ring, a letter and a number. There is no "not enough draft to
          grade" state any more — see `applicable` in scoreDraft.ts for what it
          used to suppress and why that was dropped. A short draft now scores
          low rather than going ungraded.
        */}
        {/* The adjusted number, matching the letter beside it and the ring in
            the full report. See GradeScoreSection for why the two must agree. */}
        <ScoreRing score={adjustedScore(outline.score, gradingLevel)} size={compact ? 132 : 116} />
        <div className="argscore-summary-text">
          <span className="argscore-eyebrow">Overall score</span>
          <span className={`argscore-grade tone-${toneFor(outline.score)}`}>{grade.letter}</span>
          <p className="argscore-grade-line">{grade.line}</p>
          {!outline.complete ? <span className="argscore-provisional">Provisional</span> : null}
          {/* Which reader produced the labels this score is computed from.
              Roles normally come from the model now; 'heuristic' here means the
              relay call failed or is not configured and the local patterns
              answered instead. That is a real difference in how much the number
              is worth — the patterns leave anything they cannot justify
              unlabelled — and a score that silently changed its basis would be
              the least honest thing this panel could do. Shown only in the
              degraded case: a badge on every normal run is noise. */}
          {outline.rolesFrom === 'heuristic' ? (
            <span
              className="argscore-provisional"
              title="The paragraph roles behind this score came from local pattern rules rather than the model — they leave anything they cannot justify unlabelled."
            >
              Local rules
            </span>
          ) : null}
          {/*
            THREE different facts, never one number. This line said "0 of 7
            claims have a source" about drafts that were fully cited, which is
            an accusation, and the least believable thing the panel can print
            over an essay whose every paragraph carries a reference.

            - `withOwnCitation` — citations the WRITER wrote, from
              hasInlineCitation. A fact about the draft, knowable with no
              search at all, so it leads.
            - `withRelevantSource` — what TRACELY'S search turned up. A fact
              about retrieval. It stays on its own line and is never phrased as
              "has a source", because Tracely failing to find a paper is not
              the same as the claim being unsourced.
            - `unchecked` — claims no search has run on. Stated separately and
              never folded into a ratio, so the number cannot imply a search
              has run when it has not.

            Collapsing any two of these is how the bug happened. Keep them apart.
          */}
        </div>
      </div>

      {/*
        Also on the widget, not only in the full report.
        370:135 is a ring, an eyebrow, a grade and one line, and the claim
        counts were pulled out of it for exactly that reason — but this is a
        button, not another statistic, and the widget is the screen the writer
        actually lands on. Leaving the only whole-draft sweep two clicks in
        behind "View Full Report" is how it went missing in the first place.

        The compact form is the button alone. The sentence explaining what a
        sweep does is what would not fit, and it is the droppable half.
      */}
      {/* Not wrapped in a padded container: CheckAllRow renders nothing when
          every claim is already checked, and a wrapper would leave its padding
          behind as a gap under the ring. The compact variant carries its own. */}
      {compact ? (
        <CheckAllRow pending={pending} checking={checking} onCheckClaims={onCheckClaims} compact />
      ) : null}

      {!compact ? (
        <div className="argscore-scroll">
          <div className="argscore-stats">
            <div>
              <b>{words.toLocaleString()}</b>
              <span>Words</span>
            </div>
            <div>
              <b>~{Math.max(1, Math.round(words / READING_WPM))} min</b>
              <span>Read time</span>
            </div>
            <div>
              <b>{(words / sentences).toFixed(1)}</b>
              <span>Words / sentence</span>
            </div>
            <div>
              <b>{Math.round((uniqueWords / Math.max(1, words)) * 100)}%</b>
              <span>Vocab diversity</span>
            </div>
          </div>

          <CohesionRow
            cohesion={outline.cohesion}
            tag={(index) => paragraphTag(outline.paragraphs, outline.titleParagraph, index)}
            onOpen={() => onView({ name: 'cohesion' })}
          />

          <div className="argscore-section-row">
            <h3 className="argscore-section">Breakdown by paragraph</h3>
            {/* The ONLY route to the argument check, per the spec. It is a
                per-claim surface and does not belong in the paragraph flow. */}
            {claims.length > 0 ? (
              <button className="argscore-link" onClick={() => onView({ name: 'argument' })}>
                Open Argument Check <ArrowRightIcon size={12} />
              </button>
            ) : null}
          </div>

          {/*
            One row per paragraph, collapsed to a header until opened. The row
            used to be a single button that jumped straight to the paragraph
            detail, which meant the report could not be READ — every component
            bar and every finding for every paragraph was stacked in the list at
            once, and the only way to see one paragraph's was to leave the
            report. Expanding in place keeps the reader on the page they are
            reading; the detail view is still one click further in.

            A div wrapping a header button, not a button: the open body holds
            buttons of its own, and a button inside a button is invalid HTML
            that Chromium silently un-nests.
          */}
          {rows.map(({ paragraph, name, keys, strong, weaknesses }) => {
            const open = expanded === paragraph.index
            return (
              <div
                className="argscore-para"
                key={paragraph.index}
                data-role={paragraph.role}
                data-open={open ? 'true' : undefined}
              >
                <button
                  type="button"
                  className="argscore-para-head"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : paragraph.index)}
                >
                  <span className="argscore-para-chevron" aria-hidden="true">
                    <ChevronRightIcon size={12} />
                  </span>
                  {/* The raw array index used to lead the row as "P12". The
                      name beside it is numbered across the BODY, so on a titled
                      essay the row read "P12  Paragraph 11" — two numbers for
                      one paragraph, and the reader has no way to know which one
                      the findings underneath are using. The name carries the
                      number now; "Show me in the document" carries the rest. */}
                  <span className="argscore-para-name">{name}</span>
                  {/* The role stays, demoted to the chip the index used to
                      occupy. It is what the whole /100 is computed from, so
                      showing it is what makes a wrong label visibly wrong
                      rather than mysteriously costly — but the writer's own
                      way of referring to the paragraph leads.

                      Dropped when it would only repeat the name: the closing
                      paragraph rendered "Conclusion  Conclusion", which reads
                      as a rendering fault rather than as two facts. */}
                  {ROLE_LABEL[paragraph.role] === name ? null : (
                    <span className="argscore-para-role">{ROLE_LABEL[paragraph.role]}</span>
                  )}
                  {/* Collapsed only: one dot per finding, so a closed row still
                      says it has something in it. Open, the findings themselves
                      are right there and the dots would be a second count of the
                      same thing. */}
                  {!open && weaknesses.length > 0 ? (
                    <span
                      className="argscore-para-dots"
                      aria-label={`${weaknesses.length} ${weaknesses.length === 1 ? 'finding' : 'findings'}`}
                    >
                      {weaknesses.map((weakness, i) => (
                        <span className="argscore-para-dot" key={`${weakness.kind}-${i}`} />
                      ))}
                    </span>
                  ) : null}
                  <span className={`argscore-verdict-pill tone-${strong ? 'good' : 'low'}`}>
                    {strong ? 'Strong' : 'Needs Work'}
                  </span>
                </button>

                {open ? (
                  <div className="argscore-para-body">
                    {/* What the paragraph is doing, not the paragraph. See
                        roleBlurb.ts — the text itself is the one thing on this
                        screen the writer already has. */}
                    <p className="argscore-para-blurb">{roleBlurbFor(paragraph.role)}</p>
                    {/* Shown unconditionally now that the grade always is. On a
                        short draft these are the explanation for the low number —
                        which components were reachable at all — so hiding them
                        would leave the letter unaccounted for. */}
                    {keys.map((key) => {
                      const meta = COMPONENT_LABEL.find(([k]) => k === key)!
                      return (
                        <ComponentBar
                          key={key}
                          value={outline.components[key]}
                          max={meta[2]}
                          label={meta[1]}
                        />
                      )
                    })}
                    {weaknesses.map((weakness, i) => (
                      <ParagraphProblem
                        key={`${weakness.kind}-${i}`}
                        weakness={weakness}
                        claim={claims.find((claim) => claim.id === weakness.claimId) ?? null}
                        onView={onView}
                        onReveal={onReveal}
                        paragraphIndex={paragraph.index}
                      />
                    ))}
                    <button
                      className="argscore-link argscore-para-open"
                      onClick={() => onView({ name: 'paragraph', index: paragraph.index })}
                    >
                      Open paragraph {paragraph.index} <ArrowRightIcon size={12} />
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}

          {missing.length > 0 ? (
            <>
              <h3 className="argscore-section">Not found in this draft</h3>
              <p className="argscore-missing">{missing.map(([, label]) => label).join(' · ')}</p>
            </>
          ) : null}

          {/*
            The closing paragraph — which of everything above to act on first.
            Composed deterministically from the same components the score is
            (see shared/draftSummary.ts); never model prose, so it cannot praise
            a strength the draft does not have and cannot move between two runs
            on unchanged text. Shown whether or not there are draft-level
            findings, because "what do I do first" is a question every report
            raises and only this line answers.
          */}
          <h3 className="argscore-section argscore-section-dot">Summary</h3>
          <p className="argscore-summary-prose">
            {summariseDraft({
              score: outline.score,
              components: outline.components,
              complete: outline.complete,
              withOwnCitation,
              detected
            })}
          </p>

          {/*
            The retrieval facts, under the summary rather than beside the ring.
            The frame's score block (404:192) is a ring, an eyebrow, a grade
            pill and ONE line — these two pushed it three rows taller than the
            frame and made the first thing on the report a paragraph of
            caveats. They are still here, and still three separate facts, for
            the reason written where they used to live: collapsing any two of
            them is what produced "0 of 7 claims have a source" over a fully
            cited draft.
          */}
          {/* Not on the compact widget. 370:135 is a ring, an eyebrow, a grade
              and one line — nothing else — and the claim counts pushed it two
              rows taller than the frame. They live in the full report, which
              has the room the design gave it. */}
          {!compact ? (
            <p className="argscore-verdict">
              {detected === 0 ? (
                'No checkable claims in this draft yet.'
              ) : (
                <>
                  <b>
                    {withOwnCitation} of {detected}
                  </b>{' '}
                  {detected === 1 ? 'claim carries' : 'claims carry'} a citation you wrote
                </>
              )}
            </p>
          ) : null}
          {!compact && detected > 0 ? (
            <p className="argscore-verdict-sub">
              {checked === 0 ? (
                'Not checked against the literature yet.'
              ) : searchable === 0 ? (
                'None of these claims are the kind academic databases hold.'
              ) : (
                <>
                  Tracely found supporting evidence for {withRelevantSource} of the {searchable} it
                  could search
                  {/*
                    Stated, never silently subtracted. The whole point of
                    holding these out of the ratio is honesty about what the
                    search covers, and a denominator that quietly shrank would
                    be the same concealment pointing the other way.
                  */}
                  {outsideIndexes > 0 ? (
                    <span className="argscore-unchecked">
                      {' '}
                      · {outsideIndexes} these databases don’t cover
                    </span>
                  ) : null}
                  {unchecked > 0 ? (
                    <span className="argscore-unchecked"> · {unchecked} not checked yet</span>
                  ) : null}
                </>
              )}
            </p>
          ) : null}

          {/*
            The two whole-draft sweeps, below the summary rather than above the
            paragraph list. The frame's breakdown section is a header, a link
            and the cards — nothing between them — and these two rows sat in
            that gap, which put a paragraph of explanation about per-claim cost
            in the middle of the reading order. Both still render only when
            there is something left to check, so a fully checked draft is the
            frame exactly.
          */}
          <CheckAllRow pending={pending} checking={checking} onCheckClaims={onCheckClaims} />
          <CheckReasoningRow
            pending={uncritiqued}
            critiquing={critiquing}
            onCritiqueClaims={onCritiqueClaims}
          />

          {draftWeaknesses.length > 0 ? (
            <>
              {/* The same card the per-paragraph findings use, not a bare
                  sentence. These are the most actionable findings in the whole
                  report — "no thesis", "no counterargument", "no significance"
                  — and they were the only ones with no route onward at all. */}
              {draftWeaknesses.map((weakness, i) => (
                <ParagraphProblem
                  key={`${weakness.kind}-${i}`}
                  weakness={weakness}
                  claim={claims.find((claim) => claim.id === weakness.claimId) ?? null}
                  onView={onView}
                  onReveal={onReveal}
                  paragraphIndex={weakness.paragraphIndex}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}

      {/* The frames' own labels and shapes: a filled orange-gradient pill beside
          an outlined white one, both full-height, splitting the width. */}
      <footer className="argscore-foot">
        {compact ? (
          <button className="argscore-btn primary" onClick={() => onView({ name: 'full' })}>
            View Full Report
          </button>
        ) : (
          <button className="argscore-btn primary" onClick={() => onView({ name: 'summary' })}>
            Back to Summary
          </button>
        )}
        <button className="argscore-btn secondary" onClick={onReanalyze}>
          Re-grade Writing
        </button>
      </footer>
    </>
  )
}

/**
 * Cohesion & flow — the lavender block above the paragraph breakdown.
 *
 * Deliberately NOT part of the /100. The rubric's six components ask whether
 * the argument's parts exist; this asks whether they are joined, and folding a
 * seventh number into a score whose breakdown is shown would silently re-weight
 * every component beside it. Same call `evidenceCoverage.ts` makes, for the
 * same reason.
 *
 * Renders nothing for a one-paragraph draft: there is no boundary to measure,
 * and `measureCohesion` returns 100 there so that an absent boundary cannot
 * read as a failed one — printing "100%, strong flow" over a single paragraph
 * would turn that safe default into a compliment nothing earned.
 */
/**
 * How many broken joins are named in the report before it stops listing and
 * starts counting. Three: enough that a normal draft's flow problems are all
 * visible, few enough that a badly-joined one does not turn the middle of the
 * report into a wall of red.
 */
const FLOW_PREVIEW = 3

function CohesionRow({
  cohesion,
  tag,
  onOpen
}: {
  cohesion: DraftCohesion | null
  /** Names a paragraph the way every heading in this report does. */
  tag: (index: number) => string
  onOpen: () => void
}): JSX.Element | null {
  if (!cohesion || cohesion.boundaries === 0) return null
  const verdict = verdictFor(cohesion.score)
  const tone = toneFor(cohesion.score)
  const n = cohesion.findings.length

  return (
    <section className="argscore-flow">
      <div className="argscore-flow-head">
        <h3 className="argscore-section">Cohesion &amp; flow</h3>
        <span className={`argscore-verdict-pill tone-${tone}`}>{verdict}</span>
      </div>
      <ComponentBar value={cohesion.score} max={100} label="Flow score" />
      {/* The same shape "Open Argument Check →" has, and for the same reason:
          this is a per-boundary surface with its own work in it, and a list of
          nine red bullets sitting in the middle of the report was nine things
          named and none of them openable. */}
      {/*
        The broken joins themselves, named, capped at FLOW_PREVIEW.

        A count alone ("3 boundaries need work") is a number with nowhere to go:
        it tells the writer something is wrong at a join without saying which
        join, so the only move available is to open another screen and start
        reading. Naming them costs three lines and answers the question the
        count raises.

        Capped, and every row opens the flow check, because the original
        objection to printing them inline stands where there are nine of them:
        nine red bullets in the middle of the report is nine things named and
        none of them openable. Two or three that click through is not that.
      */}
      {n > 0 ? (
        <ul className="argscore-flow-list">
          {cohesion.findings.slice(0, FLOW_PREVIEW).map((finding, i) => (
            <li key={`${finding.kind}-${i}`}>
              <button className="argscore-flow-item" onClick={onOpen}>
                <span className="argscore-flow-where">
                  {tag(finding.fromIndex)} → {tag(finding.toIndex)}
                </span>
                <span className="argscore-flow-what">{finding.message}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="argscore-section-row">
        <p className="argscore-flow-clear">
          {n === 0
            ? 'Every paragraph picks up where the last one left off.'
            : n > FLOW_PREVIEW
              ? `${n - FLOW_PREVIEW} more across ${cohesion.boundaries} ${
                  cohesion.boundaries === 1 ? 'join' : 'joins'
                }.`
              : `${n} of ${cohesion.boundaries} ${cohesion.boundaries === 1 ? 'join' : 'joins'} need work.`}
        </p>
        {n > 0 ? (
          <button className="argscore-link" onClick={onOpen}>
            Open Flow Check <ArrowRightIcon size={12} />
          </button>
        ) : null}
      </div>
    </section>
  )
}

/**
 * Every broken boundary, as a list you can open one at a time.
 *
 * The findings used to be printed inline in the report, which made them the
 * only category of finding in the whole product with nothing behind it: a
 * paragraph weakness opens a detail, a claim opens Find Evidence, and a
 * transition gap opened the paragraph it pointed at — which is not where the
 * problem is. The problem is the JOIN, and a join needs both sides on screen.
 */
function CohesionCheck({
  cohesion,
  paragraphTexts,
  tag,
  onOpen,
  onBack,
  onClose
}: {
  cohesion: DraftCohesion | null
  paragraphTexts: string[]
  tag: (index: number) => string
  onOpen: (findingIndex: number) => void
  onBack: () => void
  onClose: () => void
}): JSX.Element {
  const findings = cohesion?.findings ?? []

  return (
    <>
      <ModalHead title="Flow Check" onBack={onBack} backLabel="Back to report" onClose={onClose} />
      <div className="argscore-scroll argscore-detail">
        <h2 className="argscore-detail-title">Cohesion &amp; flow</h2>
        <div className="argscore-detail-meta">
          {cohesion ? (
            <span className={`argscore-verdict-pill tone-${toneFor(cohesion.score)}`}>
              {verdictFor(cohesion.score)}
            </span>
          ) : null}
          <span>
            {cohesion?.score ?? 0}% flow · {findings.length} of {cohesion?.boundaries ?? 0}{' '}
            {(cohesion?.boundaries ?? 0) === 1 ? 'join' : 'joins'} flagged
          </span>
        </div>

        {findings.length === 0 ? (
          <p className="argscore-flow-clear">Every paragraph picks up where the last one left off.</p>
        ) : (
          <div className="argscore-rows">
            {findings.map((finding, i) => (
              <button
                type="button"
                key={`${finding.kind}-${finding.fromIndex}-${finding.toIndex}-${i}`}
                className="argscore-boundary-row"
                data-kind={finding.kind}
                onClick={() => onOpen(i)}
              >
                <span className="argscore-boundary-pair">
                  {tag(finding.fromIndex)} → {tag(finding.toIndex)}
                </span>
                <span className="argscore-boundary-body">
                  <span className="argscore-boundary-label">{COHESION_LABEL[finding.kind]}</span>
                  {/* The last words of one paragraph and the first of the next
                      — the actual seam, which is the thing being judged. */}
                  <span className="argscore-boundary-seam">
                    …{tailOf(paragraphTexts[finding.fromIndex - 1])} ⁄{' '}
                    {headOf(paragraphTexts[finding.toIndex - 1])}…
                  </span>
                </span>
                <span className="argscore-boundary-go" aria-hidden="true">
                  <ArrowRightIcon size={14} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

const COHESION_LABEL: Record<CohesionFindingKind, string> = {
  'no-transition': 'Starts cold',
  'topic-jump': 'Topic jump',
  'unanswered-counterargument': 'Objection left unanswered'
}

/** Last / first few words, for the seam preview. Whole words only — a preview
 *  cut mid-word reads as a different kind of text than the student wrote. */
function tailOf(text: string | undefined, words = 9): string {
  const parts = (text ?? '').trim().split(/\s+/).filter(Boolean)
  return parts.slice(-words).join(' ')
}
function headOf(text: string | undefined, words = 9): string {
  const parts = (text ?? '').trim().split(/\s+/).filter(Boolean)
  return parts.slice(0, words).join(' ')
}

/**
 * One boundary, opened — both sides of the seam and the move that repairs it.
 *
 * Deliberately shows the END of the first paragraph and the START of the
 * second rather than either paragraph whole. The finding is about the join,
 * and a full paragraph of prose above the guidance buries the two sentences
 * that are actually adjacent.
 */
function BoundaryDetail({
  finding,
  paragraphTexts,
  tag,
  onReveal,
  onBack,
  onClose
}: {
  finding: CohesionFinding | null
  paragraphTexts: string[]
  tag: (index: number) => string
  onReveal: (target: RevealTarget) => void
  onBack: () => void
  onClose: () => void
}): JSX.Element {
  if (!finding) {
    return (
      <>
        <ModalHead title="" onBack={onBack} backLabel="Back to Flow Check" onClose={onClose} />
        <div className="argscore-state">
          <p className="muted">That boundary is no longer in the draft.</p>
        </div>
      </>
    )
  }

  const guidance = cohesionGuidanceFor(finding.kind)
  const before = paragraphTexts[finding.fromIndex - 1] ?? ''
  const after = paragraphTexts[finding.toIndex - 1] ?? ''

  return (
    <>
      <ModalHead title="" onBack={onBack} backLabel="Back to Flow Check" onClose={onClose} />
      <div className="argscore-scroll argscore-detail">
        <h2 className="argscore-detail-title">
          {tag(finding.fromIndex)} → {tag(finding.toIndex)} — {COHESION_LABEL[finding.kind]}
        </h2>
        <p className="argscore-problem-body">{finding.message}</p>

        {/* The seam itself, in reading order, with the gap drawn between the
            two halves. This is the whole evidence for the finding. */}
        <div className="argscore-seam">
          <div className="argscore-seam-side">
            <span className="argscore-seam-label">End of {tag(finding.fromIndex)}</span>
            <p className="argscore-quote">…{tailOf(before, 34)}</p>
          </div>
          <div className="argscore-seam-gap" aria-hidden="true" />
          <div className="argscore-seam-side">
            <span className="argscore-seam-label">Start of {tag(finding.toIndex)}</span>
            <p className="argscore-quote">{headOf(after, 34)}…</p>
          </div>
        </div>

        <div className="argscore-section-row">
          <button
            className="argscore-link"
            onClick={() => onReveal({ claimId: null, paragraphIndex: finding.toIndex })}
          >
            Show me in the document <ArrowRightIcon size={12} />
          </button>
        </div>

        <h3 className="argscore-section">How to fix this</h3>
        <dl className="argscore-guidance-body">
          <dt>Do this</dt>
          <dd>{guidance.move}</dd>
          <dt>Why it works</dt>
          <dd>{guidance.why}</dd>
          <dt>You will know it worked when</dt>
          <dd>{guidance.done}</dd>
        </dl>
      </div>
    </>
  )
}

/**
 * One finding inside an expanded paragraph — the card the frame draws with a
 * coloured dot, a name, and a quote.
 *
 * The quote is the CLAIM the finding is about, when it has one, and nothing
 * else: no suggested rewrite. Every message here is a local template
 * (weaknesses.ts) precisely so that Tracely names what is missing and the
 * student writes what goes there — a proposed sentence in someone's own essay
 * is the line this app does not cross.
 *
 * "Fix →" routes by what the finding actually needs: a claim with no source
 * needs a search, so it opens Find Evidence on that claim; anything structural
 * opens the paragraph detail, which is where the rubric's reasoning is.
 */
function ParagraphProblem({
  weakness,
  claim,
  paragraphIndex,
  onView,
  onReveal
}: {
  weakness: StructureWeakness
  claim: Claim | null
  paragraphIndex: number | null
  onView: (view: View) => void
  onReveal: (target: RevealTarget) => void
}): JSX.Element {
  const searchable = weakness.kind === 'unsupported-claim' && claim !== null
  // A finding with neither a claim nor a paragraph is about the whole draft —
  // "no counterargument" is about a paragraph that does not exist, and there is
  // nowhere to send anyone.
  const locatable = claim !== null || paragraphIndex !== null

  return (
    <div className="argscore-problem" data-kind={weakness.kind}>
      <div className="argscore-problem-head">
        <span className="argscore-problem-dot" aria-hidden="true" />
        <span className="argscore-problem-title">
          {/* A graded-read finding names itself; the local kinds have a fixed
              label. Falling back to the kind rather than to a generic string
              so a finding that somehow arrives without one is visibly odd
              instead of silently anonymous. */}
          {weakness.kind === 'model-finding'
            ? weakness.label || 'Finding'
            : WEAKNESS_LABEL[weakness.kind]}
          {/* Only when something was actually weighed.
              `hasRelevantSource` is the same gate the Argument Check card got
              on 2026-08-19, applied here a day late: every factor of the
              breakdown is computed over the sources that cleared the relevance
              floor, so "0/100 evidence" beside a claim nothing came back for
              is a report on the search wearing the grammar of a verdict.
              Reported over a correctly cited sentence, twice in one panel. */}
          {claim?.strengthScore !== null &&
          claim?.strengthScore !== undefined &&
          hasRelevantSource(claim.scoreBreakdown) ? (
            <span className="argscore-problem-score"> · {claim.strengthScore}/100 evidence</span>
          ) : null}
        </span>
        {/* Two different things, and they were one before: "Show me" leaves the
            report and puts the cursor on the text, "Find evidence" starts a
            search. The old single "Fix →" did neither — it opened the paragraph
            detail, another screen inside the same modal, which is how a report
            could name a problem in the fourth paragraph and never once show
            anyone the fourth paragraph. */}
        {locatable ? (
          <button
            className="argscore-link"
            onClick={() =>
              onReveal({ claimId: claim?.id ?? null, paragraphIndex })
            }
          >
            Show me <ArrowRightIcon size={12} />
          </button>
        ) : null}
        {searchable ? (
          <button
            className="argscore-link"
            onClick={() =>
              onView({
                name: 'evidence',
                claimId: claim.id,
                from: { name: 'paragraph', index: paragraphIndex ?? 1 }
              })
            }
          >
            Find evidence <ArrowRightIcon size={12} />
          </button>
        ) : null}
      </div>
      {/* The claim when there is one, otherwise the words the prose rule
          matched. A reasoning finding has no claim behind it — nothing detected
          "always" as an assertion about the world — so without this the report
          would say "the fourth paragraph states something absolutely" over a
          90-word paragraph and leave the writer hunting for the adverb. */}
      {claim ? (
        <p className="argscore-problem-quote">“{claim.text}”</p>
      ) : weakness.quote ? (
        <p className="argscore-problem-quote">“{weakness.quote}”</p>
      ) : null}
      <p className="argscore-problem-body">{weakness.message}</p>
      {/*
        The narrowed sentence, when the critique produced one.

        `suggestedRevision` is set for `overstated` and for nothing else — the
        one verdict that arrives WITH its fix attached — and it was persisted on
        the claim precisely so a surface reading a stored claim could show it.
        This one never did: the report named an overreaching sentence and sent
        the writer off to think about it while the rewritten version sat unread
        on the same object. A finding that is holding the answer and prints only
        the complaint is the most annoying shape a report can take.
      */}
      {claim?.suggestedRevision ? (
        <div className="argscore-problem-rewrite">
          <span className="argscore-problem-rewrite-label">Suggested rewrite</span>
          <p className="argscore-problem-rewrite-text">{claim.suggestedRevision}</p>
        </div>
      ) : null}
      <GuidanceBlock kind={weakness.kind} fix={weakness.fix} />
    </div>
  )
}

/**
 * How to fix it — the half of the report that was missing.
 *
 * `weaknesses.ts` names what is wrong and stops, because the route onward used
 * to be `tracerPrompt` and Tracer was removed. Nothing replaced it, so for
 * several releases this report could tell a student their fourth paragraph had
 * a warrant gap and offer them no way to find out what a warrant gap is, let
 * alone what to do about one.
 *
 * Collapsed by default and opened per finding. A reader scanning six findings
 * wants the six names; a reader who has stopped on one wants all three fields
 * at once, which is why opening it shows move, why and done together rather
 * than revealing them in turn.
 *
 * The guidance never contains a sentence to paste — see revisionGuidance.ts.
 */
function GuidanceBlock({
  kind,
  fix
}: {
  kind: StructureWeaknessKind
  /** The graded read's own one-sentence move, when the finding carried one. */
  fix?: string
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const guidance = guidanceFor(kind)

  // A model finding has no local template — it carries its own `fix`, which is
  // specific to the sentence rather than generic to a kind. Shown plainly
  // rather than folded into move/why/done: inventing the other two fields would
  // be writing guidance nobody produced.
  if (!guidance) {
    if (!fix) return null
    return (
      <div className="argscore-guidance" data-open={open ? 'true' : 'false'}>
        <button className="argscore-guidance-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? '− How to fix this' : '+ How to fix this'}
        </button>
        {open ? (
          <dl className="argscore-guidance-body">
            <dt>Do this</dt>
            <dd>{fix}</dd>
          </dl>
        ) : null}
      </div>
    )
  }

  return (
    <div className="argscore-guidance" data-open={open ? 'true' : 'false'}>
      <button className="argscore-guidance-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '− How to fix this' : '+ How to fix this'}
      </button>
      {open ? (
        <dl className="argscore-guidance-body">
          <dt>Do this</dt>
          <dd>{guidance.move}</dd>
          <dt>Why it works</dt>
          <dd>{guidance.why}</dd>
          {/* The field that makes the other two checkable. Without it the
              guidance is advice, and a student cannot tell whether they have
              taken it. */}
          <dt>You will know it worked when</dt>
          <dd>{guidance.done}</dd>
        </dl>
      ) : null}
    </div>
  )
}

/**
 * The whole-draft evidence sweep.
 *
 * Free — the four public academic APIs, not the paid relay — which is what
 * makes a button that fires N searches at once offerable at all.
 *
 * While a sweep runs the button is REPLACED by the count rather than disabled
 * beside it: `checkClaims` is serial, and a second press would queue a
 * duplicate pass over claims the first one is still working through.
 *
 * One component for both the widget and the report so the two cannot drift into
 * disagreeing about when a sweep is offered — the widget's copy of this went
 * missing once already, when the Structure rail was deleted.
 */
function CheckAllRow({
  pending,
  checking,
  onCheckClaims,
  compact = false
}: {
  pending: string[]
  checking: { done: number; total: number } | null
  onCheckClaims: (ids: string[]) => void
  /** Drops the explanatory line; the widget frame has no room for it. */
  compact?: boolean
}): JSX.Element | null {
  if (pending.length === 0 && !checking) return null

  return (
    <div className="argscore-checkall-row" data-compact={compact ? 'true' : undefined}>
      {checking ? (
        <p className="argscore-checkall-progress">
          <Spinner />
          <span>
            Searching {Math.min(checking.done + 1, checking.total)} of {checking.total}…
          </span>
        </p>
      ) : (
        <>
          <button className="argscore-checkall" onClick={() => onCheckClaims(pending)}>
            Check all {pending.length}
          </button>
          {!compact ? (
            <span className="argscore-checkall-note">
              Searches the academic databases for{' '}
              {pending.length === 1 ? 'the claim' : `all ${pending.length} claims`} that{' '}
              {pending.length === 1 ? 'has' : 'have'} not been checked yet.
            </span>
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * The reasoning pass — the paid sibling of CheckAllRow.
 *
 * Its own row, and its own wording, because it costs about fifty times what
 * the evidence sweep does: that one hits four free academic APIs, this one is
 * the reasoning model at roughly a cent a claim. A writer pressing a button on
 * their own draft is entitled to know which of those they just pressed, so the
 * note says so rather than leaving "check" to mean two different prices.
 *
 * Offered only for claims whose evidence has already resolved. The critique
 * reasons over an evidence list; handing it an empty one produces a verdict
 * about the search rather than about the sentence.
 */
function CheckReasoningRow({
  pending,
  critiquing,
  onCritiqueClaims
}: {
  pending: string[]
  critiquing: { done: number; total: number } | null
  onCritiqueClaims: (ids: string[]) => void
}): JSX.Element | null {
  if (pending.length === 0 && !critiquing) return null

  return (
    <div className="argscore-checkall-row" data-paid="true">
      {critiquing ? (
        <p className="argscore-checkall-progress">
          <Spinner />
          <span>
            Reading {Math.min(critiquing.done + 1, critiquing.total)} of {critiquing.total}…
          </span>
        </p>
      ) : (
        <>
          <button className="argscore-checkall" onClick={() => onCritiqueClaims(pending)}>
            Check reasoning on {pending.length}
          </button>
          <span className="argscore-checkall-note">
            Reads {pending.length === 1 ? 'the claim' : `all ${pending.length} claims`} against{' '}
            {pending.length === 1 ? 'its' : 'their'} evidence to find reasoning that does not follow,
            overstatement, and claims the sources contradict. Unlike the source search, this one
            costs — about a cent per claim.
          </span>
        </>
      )}
    </div>
  )
}

/** 407:143. */
function ParagraphDetail({
  outline,
  claims,
  paragraphTexts,
  index,
  onFindEvidence,
  onReveal,
  onBack,
  onClose
}: {
  outline: DocumentOutline
  claims: Claim[]
  paragraphTexts: string[]
  index: number
  onFindEvidence: (claimId: string) => void
  onReveal: (target: RevealTarget) => void
  onBack: () => void
  onClose: () => void
}): JSX.Element {
  const paragraph = outline.paragraphs.find((p) => p.index === index)
  const text = paragraphTexts[index - 1] ?? ''
  const weaknesses = outline.weaknesses.filter((w) => w.paragraphIndex === index)
  const paragraphClaims = claims.filter((claim) => paragraph?.claimIds.includes(claim.id))
  // "Uncited" is a null strengthScore — searched-and-found-nothing is a
  // different state and says so on the claim itself.
  const uncited = paragraphClaims.filter((claim) => claim.strengthScore === null)
  const cited = paragraphClaims.filter((claim) => claim.strengthScore !== null)

  const keys = paragraph ? ROLE_COMPONENTS[paragraph.role] ?? [] : []
  // The same question the row this was opened from asks, and the same one the
  // full report asks — see shared/weaknessSeverity.ts. Derived from the
  // draft's role components before, which is why a row could say NEEDS WORK
  // and the card behind it say STRONG about one paragraph.
  const strong = !needsWork(weaknesses.map((w) => w.kind))

  return (
    <>
      <ModalHead title="" onBack={onBack} onClose={onClose} />
      <div className="argscore-scroll argscore-detail">
        {/* Same naming as the list it was opened from — see paragraphNames.
            "Paragraph 4 — Evidence" and "Paragraph 2" for the same paragraph
            would be two names for one thing. */}
        <h2 className="argscore-detail-title">
          {paragraphNames(outline.paragraphs, outline.titleParagraph)[index - 1] ?? `Paragraph ${index}`}
          {paragraph ? ` — ${ROLE_LABEL[paragraph.role]}` : ''}
        </h2>
        <div className="argscore-detail-meta">
          <span className={`argscore-verdict-pill tone-${strong ? 'good' : 'low'}`}>
            {strong ? 'Strong' : 'Needs Work'}
          </span>
          {/* The ordinal that used to sit here counted the raw array — "118
              words · 12th paragraph" under a heading reading "Paragraph 11".
              The heading names the paragraph; a second name in a second scheme
              only ever told the reader the two disagreed. */}
          <span>{countWords(text)} words</span>
        </div>

        <blockquote className="argscore-quote">{text}</blockquote>

        {/* Leaves the report and puts this paragraph on screen. The detail view
            quotes the paragraph above, which is not the same as showing the
            writer where it is — the quote cannot be edited, and editing it is
            the entire reason anyone opened this. */}
        <button className="argscore-link" onClick={() => onReveal({ claimId: null, paragraphIndex: index })}>
          Show me in the document <ArrowRightIcon size={12} />
        </button>

        {weaknesses.length > 0 ? (
          <>
            <h3 className="argscore-section">Why this needs work</h3>
            {/* The rubric's own sentences, and beneath each the revision move
                it implies. Nothing on this path generates prose — both halves
                are local templates, so an invented paragraph cannot appear in
                the one view that is supposed to be a reading of the draft. */}
            {weaknesses.map((weakness, i) => (
              <ParagraphProblem
                key={`${weakness.kind}-${i}`}
                weakness={weakness}
                claim={claims.find((claim) => claim.id === weakness.claimId) ?? null}
                paragraphIndex={index}
                onView={() => onFindEvidence(weakness.claimId ?? '')}
                onReveal={onReveal}
              />
            ))}
          </>
        ) : null}

        {uncited.map((claim) => (
          <div className="argscore-uncited" key={claim.id}>
            <span className="argscore-uncited-label">Uncited claim</span>
            <p className="argscore-uncited-text">“{claim.text}”</p>
            <button className="argscore-link" onClick={() => onFindEvidence(claim.id)}>
              Find evidence <ArrowRightIcon size={12} />
            </button>
          </div>
        ))}

        {cited.length > 0 ? (
          <>
            <h3 className="argscore-section">Claims checked in this paragraph ({cited.length})</h3>
            {cited.map((claim) => (
              <div className="argscore-claim" key={claim.id}>
                <span className={`argscore-claim-score tone-${toneFor(claim.strengthScore ?? 0)}`}>
                  {claim.strengthScore}
                </span>
                <p>{claim.text}</p>
                {/* On the checked claims too, not just the uncited ones: the
                    view lists the sources already found, so this is "show me
                    what that score is made of" as much as it is a search. */}
                <button className="argscore-link" onClick={() => onFindEvidence(claim.id)}>
                  Find evidence <ArrowRightIcon size={12} />
                </button>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </>
  )
}

/**
 * 409:141 — the sources found for one claim, reached by "Find evidence" on a
 * claim in the paragraph detail.
 *
 * Ranked by relevance, which is what the design's "% match" is: `relevanceScore`
 * as a percentage, the same number the strength breakdown is built from. It is
 * NOT a probability the source proves the claim, and the copy says "supports"
 * rather than "proves" for that reason.
 */
function FindEvidenceResult({
  claim,
  citationStyle,
  onInsertCitation,
  onEvidenceSearched,
  onBack,
  onClose
}: {
  claim: Claim | null
  citationStyle: CitationStyle
  // Resolves with a report of what the insert did (see CitationInsert in
  // AnalyzeView) — unused here, so typed as unknown rather than dragging the
  // editor's type into the modal. Not Promise<void>: TypeScript does not accept
  // a Promise<T> where Promise<void> is declared.
  onInsertCitation: ((claim: Claim, source: Source, style: CitationStyle) => Promise<unknown>) | null
  /** See ArgumentScoreModal — this is the only place a first search can start. */
  onEvidenceSearched: () => void
  onBack: () => void
  onClose: () => void
}): JSX.Element {
  const [evidence, setEvidence] = useState<EvidenceItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // Real publisher icons, resolving in the background — the rows render with
  // their monogram immediately and swap when one arrives. See useFavicons.
  const favicons = useFavicons((evidence ?? []).map((item) => iconUrlFor(item.source)))
  const [inserted, setInserted] = useState(false)

  // Read what is already stored before searching anything. A claim reached from
  // the report has usually been checked already, and re-running the four
  // academic APIs to redraw a list we hold would make opening this view cost a
  // 15-45 second wait for nothing.
  useEffect(() => {
    if (!claim) return
    let cancelled = false
    void tracelyApi
      .getEvidenceForClaim(claim.id)
      .then((res) => {
        if (cancelled) return
        setEvidence(res.evidence)
        setSelected(res.evidence[0]?.source.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setEvidence([])
      })
    return () => {
      cancelled = true
    }
  }, [claim])

  async function search(): Promise<void> {
    if (!claim) return
    setSearching(true)
    setFailure(null)
    try {
      const res = await tracelyApi.findEvidence(claim.id)
      setEvidence(res.evidence)
      setSelected(res.evidence[0]?.source.id ?? null)
      // The claim now has a strength score in the database. Tell the surface
      // that owns the claim list, or its copy stays unscored and its underlines
      // never appear — see onEvidenceSearched.
      onEvidenceSearched()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }

  async function insert(): Promise<void> {
    const source = evidence?.find((item) => item.source.id === selected)?.source
    if (!claim || !source || !onInsertCitation) return
    setFailure(null)
    try {
      await onInsertCitation(claim, source, citationStyle)
      setInserted(true)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    }
  }

  const found = evidence?.length ?? 0
  const previewUrl = evidence?.find((item) => item.source.id === selected)?.source.url ?? null

  return (
    <>
      <ModalHead title="" onBack={onBack} onClose={onClose} />
      <div className="argscore-scroll argscore-detail">
        {!claim ? (
          <p className="muted">That claim is no longer part of this analysis.</p>
        ) : (
          <>
            <div className="argev-head">
              <span className={`argev-dot${found > 0 ? ' found' : ''}`} />
              <h2 className="argev-title">
                {evidence === null ? 'Looking…' : `${found} source${found === 1 ? '' : 's'} found`}
              </h2>
              <span className="argev-style">{citationStyle}</span>
            </div>
            <p className="argev-sub">
              Ranked by how directly each source supports “{claim.text}”
            </p>

            {failure ? <p className="error-text">{failure}</p> : null}

            {evidence !== null && found === 0 ? (
              <p className="muted argev-empty">
                Nothing in the open-access databases came back for this claim. They index journal
                articles — not news, government pages or statistics offices — so this is often a gap
                in the corpus rather than a problem with the sentence.
              </p>
            ) : null}

            {(evidence ?? []).map((item) => (
              <button
                type="button"
                key={item.source.id}
                className={`argev-row${selected === item.source.id ? ' selected' : ''}`}
                onClick={() => setSelected(item.source.id)}
              >
                <SourceIconBox
                  className="argev-badge"
                  initials={initialsFor(item.source)}
                  faviconDataUrl={favicons.get(iconUrlFor(item.source) ?? '')}
                />
                <span className="argev-meta">
                  <span className="argev-source-title">{item.source.title}</span>
                  <span className="argev-source-sub">
                    {item.source.venue ?? 'Unknown venue'}
                    {item.source.year ? ` · ${item.source.year}` : ''}
                    <span className="argev-match"> {Math.round(item.relevanceScore * 100)}% match</span>
                  </span>
                </span>
                <span className={`argev-radio${selected === item.source.id ? ' on' : ''}`} aria-hidden="true" />
              </button>
            ))}

            <div className="argev-actions">
              {onInsertCitation ? (
                <button
                  className="argscore-btn primary argev-insert"
                  onClick={() => void insert()}
                  disabled={!selected || inserted}
                >
                  {inserted ? 'Citation inserted' : 'Insert citation'}
                </button>
              ) : null}
              <button
                className="argscore-btn secondary"
                onClick={() => previewUrl && window.open(previewUrl, '_blank', 'noopener')}
                disabled={!previewUrl}
              >
                Preview
              </button>
            </div>
            <button className="argscore-btn secondary argev-again" onClick={() => void search()} disabled={searching}>
              {searching ? 'Searching…' : 'Search again'}
            </button>
          </>
        )}
      </div>
    </>
  )
}

/** The badge monogram: an acronym for a multi-word venue, else its first two
 *  letters. The rule itself lives in citationFlowCopy.ts, because the hover
 *  popover's results list draws the same tile from the same sources. */
function initialsFor(source: Source): string {
  return sourceInitials(source.venue ?? source.title)
}

/** The band beside the score, in the design's own word for 34/100. */
function strengthLabel(score: number): string {
  return score >= 70 ? 'Strong' : score >= 40 ? 'Moderate' : 'Weak'
}

/**
 * 353:129 — per-CLAIM, which is why it is only reachable from the explicit
 * link and never from the paragraph flow.
 *
 * The design draws one claim. This shows the weakest checked claim, since that
 * is the one worth opening the view for, and says how many others there are
 * rather than silently picking one out of several.
 *
 * Built from the frame, top to bottom: title + round close on one row over a
 * divider, the claim-type line with its dot, the quote, a divider, the score
 * block (eyebrow + band pill on the left, 26px number and /100 on the right,
 * a 6px track under both), BREAKDOWN, the four metrics as a 2x2 grid, the
 * sources line, a divider, the critique behind its own dot, and the two
 * buttons. It had none of that: an 18px title, the quote, one strength number
 * with no band and no bar, four full-width stacked bars, and no actions at all.
 *
 * TWO DEPARTURES, both because a frame is a picture of one state:
 *
 *   - No "← Essay Grade" in the header. The frame draws a single dismissal and
 *     nothing else on that row, so back went with the redraw. Reopening AI
 *     Insights lands on Essay Grade, which is one click from here.
 *   - The metric percentages are the four `scoreBreakdown` factors, not the
 *     design's numbers. `sourceCount` is the fifth and is not a percentage of
 *     anything, so it stays the sources line the frame already gives it.
 */
function ArgumentCheck({
  claims,
  onFindEvidence,
  onRecheck,
  checking,
  onClose
}: {
  claims: Claim[]
  onFindEvidence: (claimId: string) => void
  /** Re-runs the evidence search for this one claim, through the shared sweep. */
  onRecheck: (claimId: string) => void
  checking: { done: number; total: number } | null
  onClose: () => void
}): JSX.Element {
  const checked = claims.filter((claim) => claim.strengthScore !== null)
  const weakest = checked.slice().sort((a, b) => (a.strengthScore ?? 0) - (b.strengthScore ?? 0))[0] ?? null
  const score = weakest?.strengthScore ?? 0
  const tone = toneFor(score)

  /**
   * Did anything actually speak to this claim?
   *
   * When nothing cleared the relevance floor, every factor in the breakdown is
   * 0 by construction — support, relevance, quality and recency are all
   * computed over the sources that passed it, and there were none. The card
   * then drew "Argument strength · 0/100" over four empty bars, which reads as
   * a verdict on the sentence and is instead a report on the search.
   *
   * The two zeroes are not the same finding and must not render the same way. A
   * biographical fact, a claim about one organisation's own history, anything
   * these four scholarly indexes were never going to hold — all score 0 here
   * beside a sentence that is true, properly hedged and correctly cited.
   * `problemKindsFor` has drawn this distinction since 2026-08-16 (`nothingFound`
   * gates `cited-unverified` for exactly this reason); the score display never
   * got the same treatment, so the accusation the problem kinds refuse to make
   * was being made by the number underneath them.
   */
  const measured = hasRelevantSource(weakest?.scoreBreakdown ?? null)

  /**
   * How many sources this claim actually has, read from the stored evidence.
   *
   * NOT `scoreBreakdown.sourceCount`, which is the 0..1 fraction of the
   * six-source cap that cleared the relevance floor — printing that as a count
   * renders "0.5 sources cited for this claim". `shared/claimEvidence.ts` was
   * written because that same field was mistaken for a count once already, and
   * multiplying it back out cannot recover a number above the cap anyway.
   *
   * Null until it resolves, and the line is simply not drawn then: an unread
   * list is not zero sources.
   */
  const [sourceCount, setSourceCount] = useState<number | null>(null)
  useEffect(() => {
    if (!weakest) return
    let cancelled = false
    setSourceCount(null)
    void tracelyApi
      .getEvidenceForClaim(weakest.id)
      .then((res) => {
        if (!cancelled) setSourceCount(res.evidence.length)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [weakest?.id])

  return (
    <>
      <header className="argscore-head">
        <h2 className="argscore-title" id="argscore-title">Argument check</h2>
        <button className="argscore-close" onClick={onClose} aria-label="Close">
          <CloseIcon size={16} />
        </button>
      </header>
      <div className="argscore-scroll argscore-check">
        {!weakest ? (
          <p className="muted">
            No claim has been checked yet. Run an evidence search on a claim and its strength appears here.
          </p>
        ) : (
          <>
            <p className="argscore-check-claim">
              <span className="argscore-check-dot" />
              {CLAIM_TYPE_LABEL[weakest.claimType]} · {Math.round(weakest.confidence * 100)}% confidence
            </p>
            <p className="argscore-check-quote">“{weakest.text}”</p>

            <div className="argscore-check-rule" />

            {measured ? (
              <>
                <div className="argscore-check-score">
                  <span className="argscore-eyebrow">Argument strength</span>
                  <span className={`argscore-check-band tone-${tone}`}>{strengthLabel(score)}</span>
                  <span className="argscore-check-number">
                    {score}
                    <small>/100</small>
                  </span>
                </div>
                <span className="argscore-check-track">
                  <span className={`argscore-check-fill tone-${tone}`} style={{ width: `${score}%` }} />
                </span>
              </>
            ) : (
              // No number at all, rather than a grey zero. A score is a claim
              // about the literature, and nothing was read — see `measured`.
              // The sentence still owes the reader a citation; Tracely just
              // stops pretending it looked somewhere the answer could have been.
              <div className="argscore-check-unmeasured">
                <span className="argscore-eyebrow">Argument strength</span>
                <p className="argscore-check-unmeasured-body">
                  Not scored. Nothing in OpenAlex, Crossref, Semantic Scholar or PubMed spoke to this
                  sentence, so there is no evidence here to weigh — which is a fact about those four
                  indexes, not about your claim. They hold scholarly articles; biography, institutional
                  records, news and primary texts largely sit outside them.
                </p>
              </div>
            )}

            {weakest.scoreBreakdown && measured ? (
              <>
                <span className="argscore-eyebrow argscore-check-eyebrow">Breakdown</span>
                {/* The same ComponentBar the report uses — it already draws a
                    label/percent row over a full-width track, which is the
                    frame's metric cell. `.argscore-check-metrics` is what makes
                    it a 2x2 grid and paints the fills one ink colour: these four
                    are parts of the number above them, not four verdicts, and
                    the frame colours only the score bar. */}
                <div className="argscore-check-metrics">
                  <ComponentBar value={weakest.scoreBreakdown.support * 100} max={100} label="Support" />
                  <ComponentBar value={weakest.scoreBreakdown.relevance * 100} max={100} label="Relevance" />
                  <ComponentBar value={weakest.scoreBreakdown.quality * 100} max={100} label="Quality" />
                  <ComponentBar value={weakest.scoreBreakdown.recency * 100} max={100} label="Recency" />
                </div>
                {sourceCount !== null ? (
                  <p className="argscore-check-sources">
                    <span className="argscore-check-bullet" />
                    {sourceCount} source{sourceCount === 1 ? '' : 's'} cited for this claim
                  </p>
                ) : null}
              </>
            ) : null}

            {weakest.critique ? (
              <>
                <div className="argscore-check-rule" />
                <h3 className="argscore-check-heading">
                  <span className="argscore-check-dot" />
                  Critique
                </h3>
                {/* Through MarkdownText, like every other surface that shows a
                    critique. The relay's prompts neither request nor forbid
                    markdown and the model emits it freely, so rendering the raw
                    string printed literal ** around the emphasis. */}
                <div className="argscore-check-critique">
                  <MarkdownText>{weakest.critique}</MarkdownText>
                </div>
              </>
            ) : null}

            {checked.length > 1 ? (
              <p className="argscore-footnote">
                Showing the weakest of {checked.length} checked claims. The rest are under the document.
              </p>
            ) : null}
          </>
        )}
      </div>
      {weakest ? (
        <div className="argscore-foot">
          <button className="argscore-btn ink" onClick={() => onFindEvidence(weakest.id)}>
            Find Evidence
          </button>
          {/* Disabled only while a sweep is actually running, since that sweep
              is owned by the view behind this modal and can outlive it. */}
          <button
            className="argscore-btn outline"
            onClick={() => onRecheck(weakest.id)}
            disabled={checking !== null}
          >
            {checking ? `Checking ${checking.done}/${checking.total}…` : 'Re-check Argument'}
          </button>
        </div>
      ) : null}
    </>
  )
}
