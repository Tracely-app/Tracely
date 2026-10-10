import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { critiqueIssues } from './critiqueIssues'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import type {
  CitationStyle,
  ClaimType,
  CritiqueVerdict,
  ParagraphRole,
  SourceProvider,
  StructureComponents
} from '@shared/types'
import type { StructureWeaknessKind } from '@shared/types'
import { needsWork } from '@shared/weaknessSeverity'
import type {
  ScreenWatchClaimCitation,
  ScreenWatchClaimEvidence,
  ScreenWatchClaimSummary,
  ScreenWatchEvidenceArticle,
  ScreenWatchHoverEvent,
  ScreenWatchOverlayUpdateEvent,
  ScreenWatchProblemKind,
  ScreenWatchSourceCandidate,
  ScreenWatchStructure,
  ScreenWatchWidget
} from '@shared/ipc-contract'
import type { ResolvedCitedWork, ScreenWatchFindCitedWorkResponse } from '@shared/ipc-contract'
import { CITED_HEADING, describeCitedWork } from '@shared/citedComparison'
import { hasRelevantSource, isRetrievalMiss } from '@shared/problemKind'
import { REFERENCE_LEVEL, isGradeLevel } from '@shared/gradeLevel'
// The mark's look and motion. Shared with the document editor's marks
// (DocumentMarkLayer.tsx), which draw the same thing over Tracely's own
// contentEditable — the values live in one place so the two surfaces cannot
// drift into showing the same problem differently.
import {
  BAND_INSET_BOTTOM,
  BAND_INSET_TOP,
  BAND_RADIUS,
  BAND_SCALE_RESTING,
  BAND_TRANSITION,
  DESCENDER_ROOM,
  LINE_HEIGHT,
  LINE_HEIGHT_HOVERED,
  LINE_RADIUS,
  LINE_TRANSITION,
  MOVE_TRANSITION,
  bandBackground,
  hasJumped,
  withAlpha
} from '@shared/markMotion'
import { useDrawIn, useMarkArrivals, useMarkDepartures, type MarkItem } from './components/markArrivals'
import figmaLogo from './assets/figma-logo.png'
import MarkdownText from './components/MarkdownText'
// The Essay Grade report and the pieces the frame builds it from. It used to
// live in this file; it is shared with the document editor now, so Tracely's
// own drafts get the same breakdown Screen Watch shows. Inline styles, so it
// works in this window too — see the note at the top of that file.
import {
  COMPONENT_ROWS,
  DIM,
  EssayGradeReportPanel,
  GRADE_GREEN,
  GRADE_RING_TRACK,
  GradeButtonRow,
  GradeDivider,
  GradeHeader,
  GradeScoreSection,
  MiniBar,
  OVERLAY_READING_WPM,
  ROLE_LABEL,
  StatChip,
  W_BODY,
  gradeRingColor,
  miniBarColor
} from './components/EssayGradeReport'
// Shared with the document editor, which draws the same marks over Tracely's
// own writing surface. See components/problemCopy.ts for why the two surfaces
// share the wording and the colours but not the markup.
import {
  DESIGN_AMBER,
  DESIGN_ORANGE,
  DESIGN_RED,
  LEGEND,
  MARK_PATTERN_BY_COLOR,
  PROBLEM_COLOR,
  PROBLEM_LABEL,
  bucketFor,
  popoverCopyFor
} from './components/problemCopy'
import type { MarkPattern } from './components/problemCopy'
// The one icon set, as 16px SVG strings for this file's inline markup.
import { ICON_SVG } from './components/icons'
import { aboutTheCitation, popoverRoute } from '@shared/citationAction'
// The fix card's wording, shared with the editor's DocumentMarkLayer for the
// same reason citationFlowCopy.ts is.
import {
  CITATION_FIX_LABEL,
  NO_REVISION_BODY,
  OVERLAY_APPLY_NOTE,
  REVISION_LABEL,
  REVISION_RULE,
  fixTitle
} from './components/fixFlowCopy'
import type { Bucket } from './components/problemCopy'
// Same band, same score, both surfaces — see the note in essayGrade.ts.
import { gradeFor } from './components/essayGrade'
import { CLAIM_TYPE_LABEL } from './components/claimTypeLabel'
// Position-first paragraph naming, shared with the in-app report.
import { paragraphNames } from './components/paragraphNames'
// The citation flow's wording, shared with the document editor's popover — see
// the note at the top of that file.
import {
  CHECKING_TITLE,
  OPEN_SOURCE,
  RECEIPTS_UNAVAILABLE,
  SOURCE_SAYS,
  checkingBody,
  contradictsGroupLabel,
  quoted,
  readFromLabel,
  receiptsBody,
  receiptsTitle,
  topicGroupLabel,
  unreadGroupLabel,
  CITATION_STYLE_LABEL,
  CITED_WORK_EMPTY_TITLE,
  CITED_WORK_RESULTS_BODY_EXTERNAL,
  CITED_WORK_SEARCHING_TITLE,
  CITED_WORK_UNREACHABLE,
  FIND_DIFFERENT_SOURCE,
  PASTE_OVER_NOTE,
  citedWorkEmptyBody,
  citedWorkMeta,
  citedWorkNoTarget,
  citedWorkResultsTitle,
  citedWorkSearchingBody,
  emptyResultsBody,
  flagsLeft,
  insertedBodyExternal,
  EXTERNAL_REFERENCE_LABEL,
  pasteOverLabel,
  readOnlyTitle,
  resultsTitle,
  searchingBody
} from './components/citationFlowCopy'
import {
  firstInsertable,
  groupByReceipt,
  mayInsert,
  receiptsById,
  type ReceiptsState,
  type SourceReceipt
} from '@shared/sourceReceipts'

const FONT_STACK = "'Instrument Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif"

// Widget mark: just the Tracely "T" glyph, no background — `figma-logo.png`
// is transparent everywhere except the mark itself (unlike `logo.png`,
// which is the app-icon version with its own solid orange-square
// background baked in, wrong for sitting inside the widget's own black
// circle). `brightness(0) invert(1)` flattens the mark's orange gradient to
// solid white while leaving the transparent pixels transparent, since the
// black circle behind it is the widget's own background, not the logo's.
function LogoBg({ size }: { size: number }): JSX.Element {
  return (
    <img
      src={figmaLogo}
      alt=""
      draggable={false}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        // The image is a flex item in a fixed-size row. Without this, `width`
        // gets shrunk to fit while `height` does not, which squashes the mark.
        flexShrink: 0,
        userSelect: 'none',
        pointerEvents: 'none',
        filter: 'brightness(0) invert(1)'
      }}
    />
  )
}

// Per-claim-type color used for the type dot — matches the Figma "Overlay
// Mockup" frames' 4-color legend (factual/statistic/reasoning/other), not the
// prior pastel-badge palette. `Bucket` and `bucketFor` are imported from
// problemCopy.ts, which the document editor shares.

// -- Design tokens, taken from Figma ----------------------------------
//
// "Real Tracely UI" (file k7R5x1M9alKktaMLlZFSJn), the Overlay Mockup frames.
// These are read off the design rather than chosen here, because the previous
// values were chosen here — a near-miss palette (#17171b vs #1c1c1c, #f47b20
// vs #ff5900) and pill-shaped buttons where the design has 8px rounded rects,
// which together read as a different product rather than as a small drift.
//
// Anything that looks arbitrary below is arbitrary in Figma too. Change it
// there first.

/** Text, and the primary button's fill. */
const INK = '#1c1c1c'
/** Body copy and secondary labels. */
const MUTED = '#737373'
/** Metadata: venue, year, timing hints — the quietest text on a card. */
const LABEL = '#8a8b90'
/** Card and panel fill, and the text on an ink fill. */
const PAPER = '#fff'
/** Agreement: match percentages, confirmations. */
const POSITIVE = '#16a34a'
/** Button and divider hairlines. */
const HAIRLINE = '#d9d9d9'
/** Fill behind a selected row. */
const SELECTED_BG = '#f8f8f8'
/** Fill behind a neutral pill (the citation-style chip). */
const CHIP_BG = '#f2f2f2'

// A 2px BLACK border, not a hairline in the ink colour. The overlay floats
// over someone else's application, where a soft 1px edge dissolves into
// whatever is behind it; the design commits to a hard outline for that reason.
const CARD_BORDER = '2px solid #000000'
const PANEL_BORDER = '1px solid #000000'
// 16, the same radius as the popover card: one rounded-corner size for every
// transient surface in the product (cards, popovers, panels, modals).
const PANEL_RADIUS = 16
const PANEL_SHADOW = '0px 8px 12px 0px rgba(0, 0, 0, 0.18)'
const CARD_SHADOW = '0px 8px 24px 0px rgba(0, 0, 0, 0.18)'
const CARD_RADIUS = 16

/** Hover and press washes on an outlined control, and the ink hover. */
const HOVER_WASH = 'rgba(0, 0, 0, 0.04)'
const PRESSED_WASH = 'rgba(0, 0, 0, 0.08)'
/** The outlined button's edge: the editor's .docmark-btn-secondary border. */
const SECONDARY_EDGE = 'rgba(0, 0, 0, 0.26)'
/** Hover and colour transitions, product-wide. */
const EASE = 'cubic-bezier(.2, .8, .2, 1)'

// 8px rounded rectangles, not pills, 32px tall on a finding surface — the
// editor's .docmark-btn recipe. The FILL lives on the .tracely-btn-* classes
// in the <style> block below rather than here, because an inline background
// would beat the hover and pressed rules; everything that does not change
// with state stays inline.
const PRIMARY_BTN_STYLE: CSSProperties = {
  border: '1px solid transparent',
  borderRadius: 8,
  height: 32,
  padding: '0 12px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  // Never squeezed: in the popover's scrolling column a 32px button with no
  // padding would otherwise shrink to its 13px label.
  flexShrink: 0,
  whiteSpace: 'nowrap',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1,
  color: PAPER,
  cursor: 'pointer'
}

const SECONDARY_BTN_STYLE: CSSProperties = {
  border: `1px solid ${SECONDARY_EDGE}`,
  borderRadius: 8,
  height: 32,
  padding: '0 12px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  flexShrink: 0,
  whiteSpace: 'nowrap',
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1,
  color: INK,
  cursor: 'pointer'
}

/**
 * A neutral chip — count, style name, credibility — the app's `.count`/`.chip`
 * recipe: 20px tall, 11/600, tabular figures, on the chip wash.
 */
const CHIP_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 20,
  padding: '0 8px',
  borderRadius: 999,
  background: CHIP_BG,
  color: MUTED,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums'
}

/**
 * A citation-style choice (MLA / APA / Chicago): the chip recipe at 26px and
 * 12px, the editor's .docmark-style-pill. A pill because it is a chip you can
 * press, not an action. Its colours live on .tracely-style-pill, keyed off
 * aria-pressed, so hover can change them.
 */
const STYLE_PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 26,
  padding: '0 10px',
  border: 'none',
  borderRadius: 999,
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  cursor: 'pointer'
}

/**
 * An icon-only control: 28×28, radius 8, a 16px icon from ICON_SVG, and the
 * chip wash on hover (the .tracely-icon-btn rule). Always with an aria-label.
 */
const ICON_BTN_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  border: 'none',
  borderRadius: 8,
  // No inline fill: .tracely-icon-btn draws it, so the hover wash can show.
  color: INK,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flexShrink: 0
}

/**
 * One of the shared ICON_SVG strings (16px, 1.75 stroke, currentColor) as an
 * inline element, for a control's leading or trailing icon. Decorative: the
 * control's own label or aria-label names it.
 */
function InlineIcon({ svg, flip }: { svg: string; flip?: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{ display: 'inline-flex', flexShrink: 0, transform: flip ? 'scaleX(-1)' : undefined }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

const BUCKET_COLOR: Record<Bucket, string> = {
  // The design's orange, the factual bucket's colour since the first mockup.
  factual: '#ff5900',
  statistic: '#7c3aed',
  causal: '#2f6fed',
  other: '#d6301a'
}

type Underlines = ScreenWatchOverlayUpdateEvent['underlines']

// How long a still-tracked claim keeps its last known rects after an update
// arrives without them. Comfortably under one POLL_INTERVAL_MS (1200ms), so
// a claim that has genuinely scrolled away still clears on the next tick.
const RECT_GRACE_MS = 900

// How long the cursor must rest on a claim before its evidence search
// starts. Long enough that crossing a paragraph doesn't fire a search per
// claim; short enough that the search is already running by the time
// someone has read the popover's first line.
const HOVER_SEARCH_DWELL_MS = 220

/**
 * Smooths the one-frame gaps in the underline stream.
 *
 * `FindText`/`GetBoundingRectangles` in uia-watch.ps1 intermittently returns
 * nothing for a claim that is still perfectly visible — mid-reflow, mid-
 * scroll, or while the target app is repainting. Rendering that literally
 * makes the underline blink out and back, which reads as the UI being
 * broken rather than as a missed measurement.
 *
 * A claim's previous rects are therefore held for RECT_GRACE_MS, but ONLY
 * while it is still in `trackedIds` (i.e. the service still considers it a
 * live claim). A claim that was dismissed, cited or re-detected away
 * disappears immediately, because for those the empty payload is the truth
 * rather than a measurement gap.
 */
function useStableUnderlines(underlines: Underlines, trackedIds: Set<string>): Underlines {
  const held = useRef<Map<string, { entry: Underlines[number]; since: number }>>(new Map())
  const [stable, setStable] = useState<Underlines>(underlines)
  const sweep = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The previous *payload* (not the merged output). Comparing against the
  // last real measurement is what makes the hold self-limiting: a claim
  // missing from two payloads in a row has nothing left to re-hold from, so
  // it can only ever be held once rather than indefinitely renewed.
  const lastPayload = useRef<Underlines>(underlines)
  // Read inside the sweep timer without making it a dependency — the set is
  // rebuilt every render and would otherwise restart the timer constantly.
  const trackedRef = useRef(trackedIds)
  trackedRef.current = trackedIds

  useEffect(() => {
    const present = new Set(underlines.map((u) => u.id))
    for (const id of present) held.current.delete(id)

    // Anything in the previous payload that this one dropped, while the
    // service still tracks it, is treated as a measurement gap and held.
    // Note this runs directly rather than inside a setState updater: React
    // defers updaters until render, so doing it there left `held` empty at
    // the point `recompute` read it, and nothing was ever actually held.
    const now = Date.now()
    for (const p of lastPayload.current) {
      if (present.has(p.id) || held.current.has(p.id)) continue
      if (trackedRef.current.has(p.id)) held.current.set(p.id, { entry: p, since: now })
    }

    const recompute = (): void => {
      const at = Date.now()
      for (const [id, v] of held.current) {
        if (!trackedRef.current.has(id) || at - v.since >= RECT_GRACE_MS) held.current.delete(id)
      }
      setStable([...underlines, ...[...held.current.values()].map((v) => v.entry)])

      if (sweep.current) clearTimeout(sweep.current)
      // Re-run exactly when the oldest hold expires, so a held underline
      // actually clears instead of lingering until the next payload.
      if (held.current.size > 0) {
        const oldest = Math.min(...[...held.current.values()].map((v) => v.since))
        sweep.current = setTimeout(recompute, Math.max(50, RECT_GRACE_MS - (Date.now() - oldest)))
      }
    }

    recompute()
    lastPayload.current = underlines

    return () => {
      if (sweep.current) clearTimeout(sweep.current)
    }
  }, [underlines])

  return stable
}

/**
 * How the line under a mark is drawn — by pattern as well as colour, so the
 * three finding groups read apart in greyscale (MARK_PATTERN_BY_COLOR in
 * problemCopy.ts, the editor's rule): red solid 2px, orange dashed 2px, amber
 * double 3px (1+1+1), and the grey checking state dotted. Hovered adds 1px.
 * The dashed, double and dotted lines are a border on a zero-height box,
 * because a filled box can only be solid.
 */
function markLineStyle(color: string, hovered: boolean): CSSProperties {
  const pattern: MarkPattern = MARK_PATTERN_BY_COLOR[color] ?? 'dotted'
  const weight = hovered ? LINE_HEIGHT_HOVERED : LINE_HEIGHT
  if (pattern === 'solid') {
    return { height: weight, borderRadius: LINE_RADIUS, background: color }
  }
  const width = pattern === 'double' ? weight + 1 : weight
  return { height: 0, borderBottom: `${width}px ${pattern} ${color}` }
}

/**
 * One flagged span: a highlighter band plus the line beneath it.
 *
 * Movement is a transform rather than left/top so it composites on the GPU
 * — these sit over another app's window and repaint on every poll, so a
 * layout-triggering animation here is felt, not just measured.
 *
 * The transition is suppressed for large jumps. Rects shift by a few pixels
 * constantly (typing, reflow) and gliding those looks intentional; but when
 * the document scrolls, the same rect can move hundreds of pixels, and
 * animating that sends the underline swooping across unrelated text. Small
 * delta => glide, large delta => cut.
 */
function UnderlineMark({
  claimId,
  x,
  y,
  width,
  height,
  color,
  hovered,
  title,
  enterDelay
}: {
  claimId: string
  x: number
  y: number
  width: number
  height: number
  color: string
  hovered: boolean
  /** Plain-language name of the problem, so the mark is legible on its own. */
  title: string
  /** Set when this mark is new on the screen (useMarkArrivals): the line draws
   *  itself in after this many ms. Read once, at mount. */
  enterDelay?: number
}): JSX.Element {
  const prev = useRef<{ x: number; y: number } | null>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  useDrawIn(lineRef, enterDelay)

  const jumped = hasJumped(prev.current, { x, y })

  useEffect(() => {
    prev.current = { x, y }
  })

  return (
    <div
      className="tracely-underline"
      // Identifies which claim this mark belongs to and whether it is
      // currently hovered — the overlay has no text content, so without
      // these its DOM is unreadable when inspecting or preview-testing it.
      data-claim-id={claimId}
      data-hovered={hovered ? 'true' : 'false'}
      // Also the DOM handle the preview harness asserts on, so a mark's kind is
      // checkable without reading a colour out of a screenshot.
      data-problem={title}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width,
        // The band covers the text itself; the extra room below leaves space
        // for the line to sit clear of descenders (g, y, p).
        height: height + DESCENDER_ROOM,
        transform: `translate3d(${x}px, ${y}px, 0)`,
        transition: jumped ? 'none' : MOVE_TRANSITION,
        willChange: 'transform',
        pointerEvents: 'none'
      }}
    >
      <div
        style={{
          position: 'absolute',
          // Extends 2px above the text's own bounding box. A band clipped
          // exactly to the glyph box reads as a background colour change;
          // a little air above it reads as a highlighter stroke.
          inset: `${-BAND_INSET_TOP}px 0 ${BAND_INSET_BOTTOM}px 0`,
          // Translucent, not opaque: the overlay window sits ON TOP of the
          // watched app, so anything solid here would hide the very text it
          // is meant to be highlighting. This is a highlighter pen, and the
          // words have to stay readable through it.
          //
          // 0.30, not the 0.16 this started at — that composited to about
          // rgb(253,236,222) over white, which is invisible in practice
          // next to black body text. Anything past ~0.35 starts fighting
          // the text for contrast.
          background: bandBackground(color, true),
          borderRadius: BAND_RADIUS,
          opacity: hovered ? 1 : 0,
          transform: hovered ? 'scaleY(1)' : `scaleY(${BAND_SCALE_RESTING})`,
          transformOrigin: 'bottom',
          transition: BAND_TRANSITION
        }}
      />
      <div
        ref={lineRef}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          // 2px tall with a 1px radius, at full strength — the design's
          // `rounded-[1px]` marks. It was a 2px radius at 0.85 opacity, which
          // on a 2px bar rounds it into a capsule and washes the colour.
          ...markLineStyle(color, hovered),
          opacity: 1,
          transition: `${LINE_TRANSITION}, border-bottom-width 110ms ease`
        }}
      />
    </div>
  )
}

/** A drawn mark, as the arrival and departure hooks see it. */
interface DrawnUnderline extends MarkItem {
  x: number
  y: number
  width: number
  height: number
  color: string
}

/**
 * A mark that just left — dismissed, cited, re-detected away — fading where it
 * was (`.tracely-underline-out`) instead of blinking off. Never one that is
 * only out of view: useMarkDepartures is told which claims are still tracked.
 */
function GhostUnderline({ mark }: { mark: DrawnUnderline }): JSX.Element {
  return (
    <div
      className="tracely-underline-out"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: mark.width,
        height: mark.height + DESCENDER_ROOM,
        transform: `translate3d(${mark.x}px, ${mark.y}px, 0)`,
        pointerEvents: 'none'
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          ...markLineStyle(mark.color, false)
        }}
      />
    </div>
  )
}

// >=70/40 thresholds match the main app's score-good/mid/low bands
// (ClaimCard/EvidenceScoreCard) so a score reads the same wherever it shows
// up in Tracely.
function evidenceScoreColor(score: number): string {
  if (score >= 70) return POSITIVE
  if (score >= 40) return '#b3690a'
  return '#d6301a'
}

// A plain filled dot — the Figma mockups mark claim type with a simple
// colored circle next to the label, not a pastel letter badge.
function TypeDot({ claimType, size = 9 }: { claimType: ClaimType; size?: number }): JSX.Element {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: BUCKET_COLOR[bucketFor(claimType)],
        flexShrink: 0,
        display: 'inline-block'
      }}
    />
  )
}

// Sized to comfortably fit the full action card (claim text, evidence row,
// Check Claim/Find Evidence buttons, and — once run — the critique
// result), not just a couple of lines like the original glance-only popup.
// How long a paragraph highlight stays lit after clicking its ¶ chip. Long
// enough to look up from the panel and find the underline, short enough that a
// forgotten highlight clears itself.
/**
 * Same detection main runs, for the brief window where a claim has a hover
 * target but its payload has not arrived yet.
 *
 * Duplicated rather than shared because the real one lives in
 * services/screenWatch/inlineCitation.ts — main-process code the renderer must
 * not import. Kept deliberately to the two shapes that carry the copy
 * difference; main's fuller set decides what is actually flagged.
 */
// DESIGN_ORANGE/AMBER/RED and PROBLEM_COLOR are imported from
// components/problemCopy.ts — the document editor draws the same marks and the
// two surfaces must not diverge on which colour means what.

/**
 * The popover's two text styles, shared by every card in it.
 *
 * Identical across all eight Figma popover frames — 14px SemiBold ink for the
 * title (20px line), 13px Regular at 1.5 for the body — so they are defined once rather
 * than repeated at each call site and allowed to drift apart.
 */
const POPOVER_TITLE: CSSProperties = { fontSize: 14, fontWeight: 600, lineHeight: '20px', color: INK }
const POPOVER_BODY: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: MUTED }

/**
 * The 16x10 arrow every "Hover Popover" frame draws, pointing at the sentence.
 *
 * The overlay had no tail at all: a card simply appeared near the text with
 * nothing tying it to the words it was about, which on a document with three
 * flagged sentences within a few lines of each other is genuinely ambiguous.
 *
 * The path is Figma's own (node 288:545), stroked 2px black to match the card's
 * outline, and the tail overlaps the card edge by TAIL_OVERLAP so the two
 * strokes meet instead of leaving a hairline of white between them — the same
 * 2px the design uses (tail at y=103 h=10, card top at y=111).
 */
const TAIL_WIDTH = 16
const TAIL_HEIGHT = 10
const TAIL_OVERLAP = 2

function PopoverTail({ left, pointing }: { left: number; pointing: 'up' | 'down' }): JSX.Element {
  return (
    <svg
      width={TAIL_WIDTH}
      height={TAIL_HEIGHT}
      viewBox="0 0 13.8564 7.5"
      fill="none"
      aria-hidden="true"
      style={{
        position: 'relative',
        left,
        flexShrink: 0,
        display: 'block',
        transform: pointing === 'down' ? 'scaleY(-1)' : undefined,
        ...(pointing === 'up' ? { marginBottom: -TAIL_OVERLAP } : { marginTop: -TAIL_OVERLAP })
      }}
    >
      <path d="M11.5708 6.5H2.28562L6.9282 1.47363L11.5708 6.5Z" fill="white" stroke="black" strokeWidth="2" />
    </svg>
  )
}

const HIGHLIGHT_HOLD_MS = 2500

// Two widths, because the design uses two. The inline-detection popovers are
// 320 — a glance over someone's document, sized to be read without moving your
// eyes far. The citation flow is 380, because a list of candidate sources with
// titles, venues and match percentages does not fit in 320. Using one width for
// both made every glance card a third wider than designed.
const POPOVER_WIDTH_GLANCE = 320
const POPOVER_WIDTH_FLOW = 380
// Used only to decide above-vs-below before anything has rendered. It is NOT
// used to position anything — see the note on `popoverPosition`.
const POPOVER_EST_HEIGHT = 320
const POPOVER_GAP = 10
const POPOVER_PADDING = 8

/**
 * Places the popover so it can never be clipped, without measuring it.
 *
 * The previous version clamped `top` against POPOVER_EST_HEIGHT (320) while
 * setting `maxHeight` to nearly the whole viewport, so anything taller than the
 * estimate — a citation flow with a candidate list and a works-cited block
 * comfortably is — rendered past the bottom of the overlay window and was cut
 * off by the OS, with no way to scroll to the rest.
 *
 * Two changes remove the estimate from the maths entirely:
 *
 *   - `maxHeight` is the space actually available on the chosen side, so the
 *     popover scrolls internally instead of overflowing. It already had
 *     `overflow-y: auto`; it was just never given a reason to use it.
 *   - Placing above anchors `bottom` rather than `top`. The box then grows
 *     upward from the anchor on its own, so its real height never has to be
 *     known in advance. Guessing it was the whole problem.
 */
function popoverPosition(
  anchor: { x: number; y: number; width: number; height: number },
  preferredWidth: number
): {
  left: number
  top?: number
  bottom?: number
  width: number
  maxHeight: number
} {
  const width = Math.min(preferredWidth, Math.max(1, window.innerWidth - POPOVER_PADDING * 2))
  const left = Math.min(
    Math.max(POPOVER_PADDING, anchor.x),
    Math.max(POPOVER_PADDING, window.innerWidth - width - POPOVER_PADDING)
  )

  const spaceBelow = window.innerHeight - (anchor.y + anchor.height) - POPOVER_GAP - POPOVER_PADDING
  const spaceAbove = anchor.y - POPOVER_GAP - POPOVER_PADDING
  const placeAbove = spaceBelow < POPOVER_EST_HEIGHT && spaceAbove > spaceBelow

  if (placeAbove) {
    return {
      left,
      bottom: Math.max(POPOVER_PADDING, window.innerHeight - (anchor.y - POPOVER_GAP)),
      width,
      maxHeight: Math.max(1, spaceAbove)
    }
  }
  return {
    left,
    top: Math.max(POPOVER_PADDING, anchor.y + anchor.height + POPOVER_GAP),
    width,
    maxHeight: Math.max(1, spaceBelow)
  }
}

// Mirrors computeAllPanelSize/GRID_* in screenWatchService.ts — "Show all"
// is a single vertical column (not a grid), so the panel's actual on-screen
// size is computed server-side (so hoverTracking.ts's click-through
// hit-test region matches what's drawn) and has to reproduce the exact same
// size math here or the list wouldn't fit the panel sized for it.
const GRID_CARD_WIDTH = 432
const GRID_CARD_HEIGHT = 62
const GRID_GAP = 10
const GRID_PADDING = 24
const PANEL_PADDING_Y = 22
const PANEL_HEADER_HEIGHT = 30
const PANEL_GAP = 16

// Card/panel visual tokens — near-black outline + soft neutral shadow, no
// glow/colored strip, matching the Figma "Overlay Mockup" frames. This is
// also just the main app's own light-mode border/text tokens
// (rgba(0,0,0,0.18-0.26) / #000000 in styles/index.css) at full opacity, so
// it reads as consistent with the rest of the UI rather than a one-off.
// A plain text link, no border/background — the least visually heavy
// action on a card, used for anything that closes/skips/reverts rather
// than does something.
//
// Padded 6x8 so the hit target is a real one and the .tracely-btn-text hover
// wash has room to show; callers that sit flush with a column edge pull it
// back with a negative margin so the label, not the wash, lines up.
// Its colour and (transparent) fill live on .tracely-btn-text, so the hover
// can change them; an inline value would always win.
const TEXT_BTN_STYLE: CSSProperties = {
  border: 'none',
  padding: '6px 8px',
  borderRadius: 6,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontFamily: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1,
  cursor: 'pointer'
}

// The evidence-row content shared by both the widget panel's action card
// and the citation-flow candidate list — a spinner while the background
// search (kicked off the moment the claim was detected, see
// triggerEvidenceSearch in screenWatchService.ts) hasn't resolved yet,
// otherwise a colored score + source count.
function EvidenceRow({ claim, compact }: { claim: ScreenWatchClaimSummary; compact?: boolean }): JSX.Element {
  if (!claim.evidence) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: compact ? 11 : 12, color: DIM }}>
        <span className="tracely-spinner" />
        Searching evidence…
      </div>
    )
  }
  const color = evidenceScoreColor(claim.evidence.score)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: compact ? 11 : 12, fontVariantNumeric: 'tabular-nums' }}>
      <span style={{ fontWeight: 600, color }}>{claim.evidence.score}/100</span>
      <span style={{ color: DIM }}>
        · {claim.evidence.count} source{claim.evidence.count === 1 ? '' : 's'}
      </span>
    </div>
  )
}

// A monogram badge per search provider, in place of a real favicon — there
// is no source "site" to fetch a favicon from (these are academic search
// APIs, not the underlying publisher sites), and fetching one from a
// third-party favicon service would mean sending claim-related domains to
// an external host and loosening this window's CSP (img-src is locked to
// 'self'/data: — see overlay.html). Since the provider set is small and
// fixed, a distinct colored monogram per provider is a safe stand-in that
// still gives each source a recognizable identity at a glance.
const PROVIDER_LABEL: Record<SourceProvider, string> = {
  openalex: 'OA',
  crossref: 'CR',
  semanticscholar: 'S2',
  pubmed: 'PM',
  wikipedia: 'W',
  worldbank: 'WB',
  // A web source is a page rather than an index entry, and unlike the others it
  // has a real site behind it — the favicon path in the editor shows that site.
  // Here the badge stands in, so it says "the web" rather than naming a
  // provider that did not exist.
  web: '↗',
  manual: '•'
}

const PROVIDER_COLOR: Record<SourceProvider, string> = {
  openalex: '#1a56db',
  crossref: '#0f766e',
  semanticscholar: '#6d28d9',
  pubmed: '#15803d',
  // Deliberately the same grey as 'manual' rather than a brand colour. An
  // encyclopedia entry is orientation, not evidence, and its badge should not
  // compete for attention with the peer-reviewed sources beside it.
  wikipedia: MUTED,
  worldbank: '#0071bc',
  // The design's orange. A web source is the only kind here whose page the
  // writer can actually open and read in full, which is worth showing.
  web: '#ff5900',
  manual: MUTED
}

function ProviderBadge({ provider }: { provider: SourceProvider }): JSX.Element {
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        background: PROVIDER_COLOR[provider],
        color: PAPER,
        fontSize: 11,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0
      }}
    >
      {PROVIDER_LABEL[provider]}
    </div>
  )
}

// Real favicon for the source's own site when one was fetched (see
// main/services/search/favicon.ts — a data: URI, so it satisfies this
// window's img-src 'self' data: CSP with no changes needed) — falls back to
// the plain provider monogram while it's still loading or unavailable, so a
// source row is never left with a broken/empty icon.
function SourceIcon({ provider, faviconDataUrl }: { provider: SourceProvider; faviconDataUrl: string | null }): JSX.Element {
  if (!faviconDataUrl) return <ProviderBadge provider={provider} />
  return (
    <div
      style={{
        // Figma draws a solid provider tile with two letters here. Per the
        // design review we keep the real favicon instead — it identifies the
        // actual publication rather than which API returned it — but in the
        // design's 28px / 8px-radius box, so a row of favicons and a row of
        // monogram fallbacks line up to the same grid.
        width: 28,
        height: 28,
        borderRadius: 8,
        overflow: 'hidden',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: PAPER,
        border: '1px solid #ededed'
      }}
    >
      <img src={faviconDataUrl} alt="" width={18} height={18} style={{ objectFit: 'contain' }} />
    </div>
  )
}

function openUrl(url: string | null): void {
  if (!url) return
  void window.tracely.shell.openExternal({ url })
}

// Same verdict vocabulary/colors as EvidenceScoreCard.tsx in the main app —
// this card is meant to read as the same feature, not a stripped-down
// lookalike, just rendered with inline styles since this window has no
// shared stylesheet to pull CSS classes/variables from.
const VERDICT_LABEL: Record<CritiqueVerdict, string> = {
  'well-supported': 'Well Supported',
  'partially-supported': 'Partially Supported',
  weak: 'Weak',
  unsupported: 'Unsupported',
  contradicted: 'Contradicted — False',
  fabricated: 'Source Not Found — May Be Fabricated',
  overstated: 'Overstated — Narrow the Claim'
}

// Drives the score row's copy: findings listed here read as "N issues found",
// everything else as "Reviewed · <verdict>". `fabricated` and `overstated`
// belong with the findings — "Reviewed · Source Not Found" reads as a clean
// bill of health for the most serious thing this product can say.
const WEAK_VERDICTS: CritiqueVerdict[] = [
  'weak',
  'unsupported',
  'contradicted',
  'fabricated',
  'overstated'
]

// -- The widget panel: Figma "Overlay Mockup - Widget over Document" ---------
//
// What the black launcher circle opens. The hover popover is a glance over
// someone's document and stays the lighter ProblemCard/CitationFlowCard below;
// this is the workspace you deliberately opened, and it follows the design's
// three "Widget over Document" frames rather than the "Argument Score Card"
// frame it used to draw.

/**
 * Widget-surface tokens. The panel runs a slightly different palette from the
 * hover popover in Figma — darker ink, warmer body grey, its own divider. Its
 * buttons are the popover's: one 32px, 8px-radius recipe on every finding
 * surface, so the panel no longer draws pills where the popover draws
 * rectangles.
 */
const W_INK = '#1a1a1f'
const W_DIVIDER = '#e7e7e7'
const W_TRACK = '#f0f0f0'

// The three button states the "Widget over Document" frames draw: filled for
// the action the panel is offering, outlined for the one it isn't, and a flat
// grey for an action already spent ("✓ Evidence Refreshed"). All three build
// on PRIMARY/SECONDARY_BTN_STYLE, so the fill comes from the matching
// .tracely-btn-* class and hover, press, focus and disabled come with it.
const WIDGET_PRIMARY_BTN: CSSProperties = { ...PRIMARY_BTN_STYLE }

const WIDGET_SECONDARY_BTN: CSSProperties = {
  ...SECONDARY_BTN_STYLE,
  border: `1px solid ${INK}`,
  color: W_INK
}

const WIDGET_SPENT_BTN: CSSProperties = {
  ...SECONDARY_BTN_STYLE,
  border: '1px solid transparent',
  color: LABEL,
  // Inline on purpose: a spent action does not light up under the pointer.
  background: W_TRACK,
  cursor: 'default'
}

/** Full-width, hairline-outlined — the design's "Show all (4)" row. */
const WIDGET_SHOW_ALL_BTN: CSSProperties = {
  ...SECONDARY_BTN_STYLE,
  width: '100%',
  border: `1px solid ${HAIRLINE}`,
  color: W_INK
}

/**
 * How long "Updated just now" stays true. A chip that says "just now" twenty
 * minutes later is a small lie the panel has no reason to tell.
 */
const FRESH_EVIDENCE_MS = 60_000

/** The critique rows' amber "!" tile, and the "Updated just now" chip. */
const AMBER_BG = '#fef3c7'
const AMBER_FG = '#d97706'
const FRESH_BG = '#dcfce7'

/** A source row at the panel's scale — the popover's ArticleRow is smaller. */
/** Stable enough to diff two searches: title + year, which is what a source
 *  row shows. DOIs are not carried on ScreenWatchEvidenceArticle. */
function articleKey(article: ScreenWatchEvidenceArticle): string {
  return `${article.title}::${article.year ?? ''}`
}

function PanelSourceRow({
  article,
  isNew
}: {
  article: ScreenWatchEvidenceArticle
  isNew: boolean
}): JSX.Element {
  const meta = [article.venue, article.year ? String(article.year) : null].filter(Boolean).join(' · ')
  const content = (
    <>
      <SourceIcon provider={article.provider} faviconDataUrl={article.faviconDataUrl} />
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div
          title={article.title}
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: W_INK,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {article.title}
        </div>
        {meta ? <div style={{ fontSize: 12, color: DIM }}>{meta}</div> : null}
        {/* Only after an explicit refresh, and only on rows the previous
            search did not return — otherwise "New" is decoration. */}
        {isNew ? <div style={{ fontSize: 11, fontWeight: 600, color: POSITIVE }}>New</div> : null}
      </div>
    </>
  )
  const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }
  if (!article.url) return <div style={rowStyle}>{content}</div>
  const url = article.url
  return (
    // eslint-disable-next-line jsx-a11y/anchor-is-valid
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault()
        openUrl(url)
      }}
      style={{ ...rowStyle, cursor: 'pointer' }}
    >
      {content}
    </a>
  )
}

/**
 * A proposed replacement — the narrowed sentence, or the corrected reference.
 *
 * Deliberately NOT a CritiqueIssueRow. Those rows say what is wrong; this one
 * carries text the writer is meant to put in their document, and the two should
 * not look alike. The amber "!" tile is dropped, the text sits in a bordered
 * block so it reads as a quotation of something proposed rather than as more
 * commentary, and Copy is the only action.
 *
 * Copy rather than "Apply": the overlay watches an arbitrary window over UIA
 * and has no write access to the document underneath it, so a button that
 * appeared to edit the sentence would be lying about what it can reach. It also
 * keeps the last word with the writer, which is the point — Tracer's prompt
 * refuses to compose sentences for students, and the only reason this is
 * allowed to exist at all is that narrowing a quantifier corrects accuracy
 * rather than writing prose.
 */
function CritiqueFixRow({
  label,
  text,
  monospace
}: {
  label: string
  text: string
  /** Citations only: a reference is read character by character. */
  monospace?: boolean
}): JSX.Element {
  const [copied, setCopied] = useState(false)

  // Cleared on a timer, so the button does not sit on "Copied" forever if the
  // panel stays open — and cleaned up on unmount, because the panel is
  // remounted every time the hovered claim changes.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        {/* The inset label: 11/600 uppercase, +0.04em, in the label grey. */}
        <div style={{ fontSize: 11, fontWeight: 600, color: LABEL, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {label}
        </div>
        <button
          className="tracely-btn-secondary"
          onClick={() => {
            // No catch that surfaces anything: a clipboard write can be refused
            // and there is nothing useful to tell the user about it here. The
            // text is selectable, which is the fallback.
            void navigator.clipboard?.writeText(text).then(
              () => setCopied(true),
              () => undefined
            )
          }}
          // The small (28px) outlined button: same recipe, one step down.
          style={{ ...SECONDARY_BTN_STYLE, height: 28, padding: '0 10px', fontSize: 12, color: W_BODY, flexShrink: 0 }}
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <div
        style={{
          fontSize: monospace ? 12 : 13,
          fontFamily: monospace ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
          lineHeight: 1.45,
          color: W_INK,
          background: W_TRACK,
          border: `1px solid ${W_DIVIDER}`,
          borderRadius: 8,
          padding: '8px 10px',
          // Selectable, so Copy failing is inconvenient rather than a dead end.
          userSelect: 'text',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {text}
      </div>
    </div>
  )
}

function CritiqueIssueRow({ title, detail }: { title: string; detail: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: AMBER_BG,
          color: AMBER_FG,
          fontSize: 11,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0
        }}
      >
        !
      </div>
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {title ? (
          <div
            title={title}
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: W_INK,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {title}
          </div>
        ) : null}
        {detail ? (
          <MarkdownText style={{ fontSize: 12, lineHeight: 1.35, color: DIM }}>{detail}</MarkdownText>
        ) : null}
      </div>
    </div>
  )
}

/**
 * What the three line patterns mean, at the panel's foot: a 24px sample of
 * each (LEGEND, problemCopy.ts — drawn by markLineStyle, so it is the line the
 * document actually carries) and its label, 11px. The editor's footer and the
 * extension's sticky strip draw the same row.
 */
function PanelLegend(): JSX.Element {
  return (
    <div
      aria-label="What the underlines mean"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', fontSize: 11, lineHeight: '16px', color: MUTED }}
    >
      {LEGEND.map((entry) => (
        <span key={entry.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
          <span aria-hidden style={{ display: 'block', width: 24, flexShrink: 0, ...markLineStyle(entry.color, false) }} />
          {entry.label}
        </span>
      ))}
    </div>
  )
}

/**
 * The panel's single-claim card — Figma "Overlay Mockup - Widget over Document"
 * and its two result variants.
 *
 * One component, three states, because the frames differ only in their middle
 * block and which pill is filled:
 *  - base (282:70)         sources, Refresh Evidence filled
 *  - refreshed (291:144)   sources + "Updated just now" + "New", refresh spent
 *  - critique (291:251)    the critique as issue rows, Critique filled
 *
 * What this deliberately no longer shows is the 0–100 evidence score and its
 * four-factor breakdown. That is a different frame — "Argument Score Card" —
 * and this is the one the launcher opens.
 */
function WidgetClaimCard({
  claim,
  body,
  evidenceBusy,
  critiqueBusy,
  freshlyRefreshed,
  newArticleKeys,
  showAllCount,
  onRefreshEvidence,
  onCritique,
  onShowAll
}: {
  claim: ScreenWatchClaimSummary
  /** Which of the two result blocks is showing — set by the last action taken. */
  body: 'sources' | 'critique'
  evidenceBusy: boolean
  critiqueBusy: boolean
  freshlyRefreshed: boolean
  /** Article keys the search returned that the previous one did not. */
  newArticleKeys: Set<string> | null
  showAllCount: number
  onRefreshEvidence: () => void
  onCritique: () => void
  onShowAll: () => void
}): JSX.Element {
  const evidence = claim.evidence
  const issues = claim.critique ? critiqueIssues(claim.critique) : []
  const showCritique = body === 'critique' && issues.length > 0
  // An `unsupported` verdict reached with nothing on topic in front of the
  // critique is a report on the SEARCH, and must not be printed over the
  // writer's sentence as a judgement of it — see isRetrievalMiss. It stays
  // visible ("Reviewed · No Evidence Found"), it just stops being an accusation
  // and stops counting toward "N issues found".
  const retrievalMiss = isRetrievalMiss(
    claim.critiqueVerdict,
    hasRelevantSource(claim.evidence?.breakdown ?? null)
  )
  const verdictLabel = retrievalMiss
    ? 'No Evidence Found'
    : claim.critiqueVerdict
      ? VERDICT_LABEL[claim.critiqueVerdict]
      : 'Critique'
  const weakVerdict =
    claim.critiqueVerdict !== null && !retrievalMiss && WEAK_VERDICTS.includes(claim.critiqueVerdict)

  const refreshLabel = evidenceBusy
    ? 'Searching…'
    : freshlyRefreshed && !showCritique
      ? '✓ Evidence Refreshed'
      : evidence
        ? 'Refresh Evidence'
        : 'Find Evidence'
  const refreshStyle = showCritique
    ? WIDGET_SECONDARY_BTN
    : freshlyRefreshed && !evidenceBusy
      ? WIDGET_SPENT_BTN
      : WIDGET_PRIMARY_BTN
  const critiqueStyle = showCritique ? WIDGET_PRIMARY_BTN : WIDGET_SECONDARY_BTN

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <TypeDot claimType={claim.claimType} />
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: '20px', color: W_INK, fontVariantNumeric: 'tabular-nums' }}>
          {CLAIM_TYPE_LABEL[claim.claimType]} · {Math.round(claim.confidence * 100)}% confidence
        </div>
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.4,
          color: W_BODY,
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}
      >
        &ldquo;{claim.text}&rdquo;
      </div>

      {/* The design's one-line "score row": what the block below it is a list
          OF, rather than a rating of the claim. */}
      {showCritique ? (
        <div style={{ fontSize: 14, fontWeight: 500, color: W_INK }}>
          {weakVerdict
            ? `${issues.length} issue${issues.length === 1 ? '' : 's'} found`
            : `Reviewed · ${verdictLabel}`}
        </div>
      ) : evidence ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: LABEL, fontVariantNumeric: 'tabular-nums' }}>
            {evidence.count} source{evidence.count === 1 ? '' : 's'}
          </span>
          {freshlyRefreshed ? (
            <span
              style={{
                background: FRESH_BG,
                color: POSITIVE,
                fontSize: 12,
                fontWeight: 500,
                borderRadius: 999,
                padding: '3px 10px'
              }}
            >
              Updated just now
            </span>
          ) : null}
        </div>
      ) : (
        <EvidenceRow claim={claim} />
      )}

      {showCritique ? (
        // Deliberately NOT its own scroll region. A critique carrying issue
        // rows plus a revision plus a citation fix is the tallest thing this
        // card renders, and the first instinct is to make this block scroll —
        // but the panel that wraps it already does, for exactly this reason
        // (see the `overflowY` on the 'single' container near the end of this
        // file). Adding one here nests a second scrollbar inside the first.
        // Long source lists have always overflowed the same way; the critique
        // should behave like them.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
          {issues.map((issue, i) => (
            <CritiqueIssueRow
              key={`${issue.title}-${i}`}
              // The verdict stands in for a missing title on the FIRST row
              // only. Prose that never splits into a heading is common, and
              // using the verdict every time printed "Weak" down the whole
              // list as if it were three separate findings.
              title={issue.title || (i === 0 ? verdictLabel : '')}
              detail={issue.detail}
            />
          ))}
          {/* After the issues, never instead of them. The critique explains WHY
              the sentence overreaches; this is the sentence to replace it with,
              and showing the replacement without the reasoning would train the
              writer to accept edits they do not understand. */}
          {claim.suggestedRevision ? (
            <CritiqueFixRow label="Suggested revision" text={claim.suggestedRevision} />
          ) : null}
          {claim.citationFix ? (
            <CritiqueFixRow label="Citation, corrected" text={claim.citationFix} monospace />
          ) : null}
        </div>
      ) : evidence && evidence.articles.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
          {evidence.articles.map((article, i) => (
            <PanelSourceRow
              key={`${article.title}-${i}`}
              article={article}
              isNew={newArticleKeys !== null && !newArticleKeys.has(articleKey(article))}
            />
          ))}
        </div>
      ) : null}

      {/* Pushes the two action rows to the bottom edge of the card. The panel
          is a fixed height (SINGLE_PANEL_HEIGHT, sized for the tallest of the
          three frames), so a claim with fewer sources than the mockup would
          otherwise leave its buttons floating mid-card. */}
      <div style={{ flex: 1, minHeight: 0 }} />

      {/* 8px above the footer buttons: the stack's 16px gap, less 8. */}
      <div style={{ marginBottom: -8 }}>
        <PanelLegend />
      </div>

      <div style={{ display: 'flex', gap: 8, width: '100%' }}>
        <button
          className={refreshStyle === WIDGET_PRIMARY_BTN ? 'tracely-btn-primary' : 'tracely-btn-secondary'}
          onClick={onRefreshEvidence}
          disabled={evidenceBusy}
          style={{
            ...refreshStyle,
            flex: '1 0 0',
            minWidth: 0,
            whiteSpace: 'nowrap'
          }}
        >
          {refreshLabel}
        </button>
        <button
          className={critiqueStyle === WIDGET_PRIMARY_BTN ? 'tracely-btn-primary' : 'tracely-btn-secondary'}
          onClick={onCritique}
          disabled={critiqueBusy}
          style={{
            ...critiqueStyle,
            flex: '1 0 0',
            minWidth: 0,
            whiteSpace: 'nowrap'
          }}
        >
          {critiqueBusy ? 'Checking…' : claim.critique ? 'Re-check Argument' : 'Critique Argument'}
        </button>
      </div>

      {showAllCount > 1 ? (
        <button className="tracely-btn-secondary" onClick={onShowAll} style={WIDGET_SHOW_ALL_BTN}>
          Show all ({showAllCount})
        </button>
      ) : null}
    </>
  )
}

// Clicking a card switches to the single-claim view focused on it (see
// selectedClaimId in OverlayApp) — that's where Check Claim/Find Evidence
// actions live. Simplified to dot + header + quote (no inline evidence
// preview) to match the "All Claims List" mockup's plain row style.
function ClaimListItem({ claim, onClick }: { claim: ScreenWatchClaimSummary; onClick: () => void }): JSX.Element {
  return (
    <button
      className="tracely-list-row"
      onClick={onClick}
      title="View this claim"
      style={{
        boxSizing: 'border-box',
        width: '100%',
        height: GRID_CARD_HEIGHT,
        // Width and style only: the colour and the fill are on
        // .tracely-list-row, so its hover and press can change them.
        borderWidth: 1,
        borderStyle: 'solid',
        borderRadius: 12,
        // 12 + 16 + 6 + 16 + 12 = 62 = GRID_CARD_HEIGHT: two 16px lines fit
        // the row main sizes the panel from, descenders included.
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        overflow: 'hidden',
        textAlign: 'left',
        cursor: 'pointer',
        font: 'inherit',
        color: 'inherit',
        flexShrink: 0
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <TypeDot claimType={claim.claimType} size={8} />
        {/* One line, reading as a sentence: "Factual claim · 90% confidence".
            It used to be an uppercase micro-label with the percentage pushed to
            the far right, which turned a description of the claim into two
            unrelated pieces of metadata. */}
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: '16px', color: W_INK, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {CLAIM_TYPE_LABEL[claim.claimType]} · {Math.round(claim.confidence * 100)}% confidence
        </div>
      </div>
      {/* A single ellipsised line, not a two-line clamp — every row is then the
          same height, which is what lets the panel be sized from a row count. */}
      <div
        style={{
          fontSize: 13,
          lineHeight: '16px',
          color: MUTED,
          width: '100%',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        &ldquo;{claim.text}&rdquo;
      </div>
    </button>
  )
}

// -- Structure: the draft's argument, not its sentences ---------------
//
// The same reading the in-app report (ArgumentScoreModal) shows, computed over
// whatever document Screen Watch is watching. Everything behind it is local —
// paragraph splitting, the role heuristics, the rubric, the weakness rules — so
// unlike critique it costs nothing to keep current, which is what makes an
// always-there passive score defensible at all.
//
// It used to be deliberately NOT a port of the in-app report: that one is class
// names resolved from styles/index.css, which this window does not load, so the
// vocabulary, the role labels and the rubric were duplicated here rather than
// imported. That ended on 2026-08-19 — the owner asked for THIS report on
// Tracely's own documents too, so it moved to components/EssayGradeReport.tsx
// and both surfaces render it. Inline styles are what let it: they need no
// stylesheet, so the shared component works in this window as well.


/**
 * The always-visible score, shown in the panel header in every view mode.
 *
 * Rendered as a sibling BEFORE the drag region rather than inside it: that div
 * owns onMouseDown for startWidgetDrag, and a real button nested in it has its
 * click swallowed by the drag-threshold path.
 */
function ScoreChip({
  structure,
  active,
  onOpen
}: {
  /**
   * Null when there is no trustworthy reading yet — the chip still renders.
   *
   * It used to be hidden in that case, which read as tidy and was the actual
   * bug: a draft that never produced a reading left the panel with no entry
   * point, so there was nothing to click and no way to find out why. An empty
   * chip that opens an explanation beats a control that isn't there.
   */
  structure: ScreenWatchStructure | null
  active: boolean
  onOpen: () => void
}): JSX.Element {
  const color = structure ? evidenceScoreColor(structure.score) : DIM
  return (
    <button
      className="tracely-pill"
      onClick={onOpen}
      title={
        structure
          ? `Argument score ${structure.score} of 100` +
            (structure.complete ? '' : ' — provisional, some paragraphs could not be labelled')
          : 'No structural reading of this draft yet — open for why'
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        flexShrink: 0,
        border: `1px solid ${active ? color : '#e4e4e8'}`,
        // Transparent at rest (the panel is paper) so the hover wash shows.
        background: active ? `${color}14` : 'transparent',
        // A button, so the control radius rather than a chip's pill; 28px,
        // the header tally size.
        borderRadius: 8,
        height: 28,
        boxSizing: 'border-box',
        padding: '0 10px',
        cursor: 'pointer',
        font: 'inherit'
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {structure ? structure.score : '—'}
      </span>
      <span style={{ fontSize: 11, color: DIM, lineHeight: 1 }}>argument</span>
      {/* A dot rather than the word "provisional" — the header has room for one
          of them, and the tooltip carries the sentence. */}
      {structure && !structure.complete ? (
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#b3690a', flexShrink: 0 }} />
      ) : null}
    </button>
  )
}


function EssayGradePanel({
  structure,
  gradingLevel,
  onClose,
  onFullReport
}: {
  /** Settings > Preferences — bands the letter, never the score. */
  gradingLevel?: number
  structure: ScreenWatchStructure | null
  onClose: () => void
  onFullReport: () => void
}): JSX.Element {
  return (
    <>
      <GradeHeader title="Writing Grade" onClose={onClose} />
      <GradeDivider />
      <GradeScoreSection structure={structure} gradingLevel={gradingLevel} />
      <GradeDivider />
      <GradeButtonRow primaryLabel="View Full Report" onPrimary={onFullReport} />
    </>
  )
}

/**
 * 'grade' before the first reading exists — Figma "Overlay Mockup - Essay Grade
 * (Analyzing)" (391:342), whose card (391:540) is 340x204 at a 24px radius with
 * 32px padding and a 16px stack, centred.
 *
 * Shown only while `widget.analyzing` is true, which main sets only when a
 * detection is actually in flight or queued and no structure has landed yet —
 * see ScreenWatchWidget.analyzing. A draft that was read and refused (too
 * short, or structureFit rejected the paragraph split) falls through to the
 * grade card's own "No reading of this draft yet", because a spinner there
 * would promise a score that is never coming.
 *
 * The ring is an SVG arc rather than the frame's exported spinner SVG, for the
 * two reasons GradeScoreSection gives for its own ring plus a third: this
 * window's CSP is `img-src 'self' data:`, so a remote asset URL cannot load at
 * all, and a rotating arc has to be drawn in a coordinate space we control to
 * spin around its own centre. Geometry (56px box, 5px stroke) and colours are
 * the frame's.
 */
function AnalyzingCard({ onClose }: { onClose: () => void }): JSX.Element {
  const R = 25.5
  const CIRC = 2 * Math.PI * R
  return (
    <>
      {/* The frame draws no close button, and every other panel in this flow
          has one. Kept, because the collapsed launcher is hidden while the
          panel is expanded and the overlay is click-through everywhere else:
          without it, a pass that hangs (a slow relay call — `detecting` has no
          timeout of its own) leaves a card the user cannot put away sitting
          over the document they are writing in. */}
      <button
        className="tracely-icon-btn"
        onClick={onClose}
        title="Close"
        aria-label="Close"
        // The shared 28px icon button, keeping this card's green wash.
        style={{ ...ICON_BTN_STYLE, position: 'absolute', top: 12, right: 12, background: '#eaf2ec', color: '#376049' }}
        dangerouslySetInnerHTML={{ __html: ICON_SVG.close }}
      />
      <div style={{ width: 56, height: 56, flexShrink: 0 }}>
        <svg
          className="tracely-ring"
          width={56}
          height={56}
          viewBox="0 0 56 56"
          aria-hidden="true"
          style={{ display: 'block' }}
        >
          <circle cx={28} cy={28} r={R} fill="none" stroke={GRADE_RING_TRACK} strokeWidth={5} />
          {/* A quarter turn of arc, which is what the frame draws — enough to
              read as motion without reading as a progress figure, since
              nothing here knows how far along the pass is. */}
          <circle
            cx={28}
            cy={28}
            r={R}
            fill="none"
            stroke={GRADE_GREEN}
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={`${CIRC * 0.28} ${CIRC}`}
            transform="rotate(-90 28 28)"
          />
        </svg>
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: W_INK, whiteSpace: 'nowrap' }}>
        Grading your writing...
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.4, color: MUTED, textAlign: 'center' }}>
        Checking thesis strength, evidence, and citations across each paragraph
      </div>
    </>
  )
}



/** Stable enough to dedupe one paragraph's sources: title + year. */
function articleRowKey(a: ScreenWatchEvidenceArticle): string {
  return `${a.title}::${a.year ?? ''}`
}

/**
 * The Screen Watch panel in 'paragraph' mode — Figma "Paragraph Detail — P2"
 * (407:359).
 *
 * 520x930 at a 24px radius with a 25px gutter, which is narrower and rounder
 * than the grade card (560/28) — the frame's own values, not a simplification.
 *
 * Reached from a paragraph card in the full report, and Back returns to the
 * report rather than to the summary, because that is where you came from. The
 * frame's link says "Back to summary" and is kept as drawn.
 *
 * Three places the frame has content Tracely does not hold:
 *
 *  - "58 words" — main sends `previews`, one line per paragraph, deliberately
 *    (shipping whole paragraphs would put the entire UIA read in every payload).
 *    There is no per-paragraph word count to print, so the slot carries the
 *    claim count, which is the figure this panel is actually about.
 *  - The quote box holds the whole paragraph in the frame; here it holds that
 *    same preview line, for the same reason.
 *  - Each article in the frame carries a two-line abstract.
 *    ScreenWatchEvidenceArticle has no abstract — the search returns title,
 *    venue, year and url — so the row stops at the venue rather than
 *    paraphrasing a paper nobody read.
 */
function ParagraphDetailPanel({
  structure,
  claims,
  index,
  onClose,
  onBack,
  onFindForClaim
}: {
  structure: ScreenWatchStructure | null
  claims: ScreenWatchClaimSummary[]
  index: number
  onClose: () => void
  onBack: () => void
  onFindForClaim: (claimId: string) => void
}): JSX.Element {
  const paragraph = structure?.paragraphs.find((p) => p.index === index) ?? null
  const issues = (structure?.weaknesses ?? []).filter((w) => w.paragraphIndex === index)
  // Same rule the editor's report uses — one definition of "needs work" across
  // both surfaces. See shared/weaknessSeverity.ts.
  const strong = !needsWork(issues.map((w) => w.kind as StructureWeaknessKind))
  const claimById = new Map(claims.map((c) => [c.id, c] as const))
  const paragraphClaims = (paragraph?.claimIds ?? []).map((id) => claimById.get(id)).filter(Boolean) as ScreenWatchClaimSummary[]
  const uncited = paragraphClaims.filter((c) => !c.hasInlineCitation)

  const articles: ScreenWatchEvidenceArticle[] = []
  const seen = new Set<string>()
  for (const claim of paragraphClaims) {
    for (const article of claim.evidence?.articles ?? []) {
      const key = articleRowKey(article)
      if (seen.has(key)) continue
      seen.add(key)
      articles.push(article)
    }
  }


  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
        <button className="tracely-btn-text" onClick={onBack} style={{ ...TEXT_BTN_STYLE, marginLeft: -8 }}>
          <InlineIcon svg={ICON_SVG.chevronRight} flip />
          Back to summary
        </button>
        <button
          className="tracely-icon-btn"
          onClick={onClose}
          title="Close"
          aria-label="Close"
          style={ICON_BTN_STYLE}
          dangerouslySetInnerHTML={{ __html: ICON_SVG.close }}
        />
      </div>

      <div style={{ fontSize: 18, fontWeight: 600, color: W_INK }}>
        {paragraphNames(structure?.paragraphs ?? [], structure?.titleParagraph)[index - 1] ??
          `Paragraph ${index}`}
        {paragraph ? ` — ${ROLE_LABEL[paragraph.role]}` : ''}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            background: strong ? '#e0f2e5' : '#fff1e5',
            color: strong ? GRADE_GREEN : '#cb5c19',
            borderRadius: 999,
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 600
          }}
        >
          {strong ? 'Strong' : 'Needs Work'}
        </span>
        <span style={{ fontSize: 13, fontWeight: 500, color: MUTED, fontVariantNumeric: 'tabular-nums' }}>
          {/* The ordinal that followed this counted the raw array, while the
              heading above numbers the body — "12th paragraph" under
              "Paragraph 11". One name per paragraph; the heading has it. */}
          {paragraphClaims.length} claim{paragraphClaims.length === 1 ? '' : 's'}
        </span>
      </div>

      <div
        style={{
          background: '#f8f9f8',
          borderRadius: 8,
          padding: 12,
          width: '100%',
          boxSizing: 'border-box',
          fontSize: 13,
          lineHeight: 1.5,
          color: W_INK
        }}
      >
        {structure?.previews[index - 1] || 'No text captured for this paragraph.'}
      </div>

      {/* Only when there IS something to explain. The frame draws the
          needs-work variant; a paragraph with no weakness has no "why", and a
          heading over an empty block reads as a failure to load. */}
      {issues.length > 0 ? (
        <div style={{ width: '100%' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: DIM, letterSpacing: '0.04em' }}>WHY THIS NEEDS WORK</div>
          <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: '#35363c' }}>
            {issues.map((w) => w.message).join(' ')}
          </div>
        </div>
      ) : null}

      {uncited.map((claim) => (
        <div
          key={claim.id}
          style={{
            background: '#fef5e9',
            border: '1px solid #ecbd7b',
            borderRadius: 12,
            padding: '11px 13px',
            width: '100%',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            gap: 12
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#cb5c19', letterSpacing: '0.04em' }}>UNCITED CLAIM</div>
            <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.5, color: '#524026' }}>
              &ldquo;{claim.text}&rdquo; — this figure has no source attached.
            </div>
          </div>
          <button
            className="tracely-btn-primary"
            onClick={() => onFindForClaim(claim.id)}
            // The finding-surface primary: solid ink, never a gradient.
            style={{ ...PRIMARY_BTN_STYLE, width: 150, flexShrink: 0 }}
          >
            Find evidence
            <InlineIcon svg={ICON_SVG.chevronRight} />
          </button>
        </div>
      ))}

      {articles.length > 0 ? (
        <div style={{ width: '100%' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: DIM, letterSpacing: '0.04em' }}>
            EVIDENCE CITED IN THIS PARAGRAPH ({articles.length})
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {articles.map((article, i) => (
              <div key={`${article.title}-${i}`} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                {/* The frame's 32px/9px-radius tile, at the frame's size — the
                    28px SourceIcon used elsewhere is a different row. */}
                <div style={{ width: 32, height: 32, flexShrink: 0 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      overflow: 'hidden',
                      background: article.faviconDataUrl ? PAPER : PROVIDER_COLOR[article.provider],
                      border: article.faviconDataUrl ? '1px solid #ededed' : 'none',
                      color: PAPER,
                      fontSize: 11,
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    {article.faviconDataUrl ? (
                      <img src={article.faviconDataUrl} alt="" width={20} height={20} style={{ objectFit: 'contain' }} />
                    ) : (
                      PROVIDER_LABEL[article.provider]
                    )}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div
                    title={article.title}
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: W_INK,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      cursor: article.url ? 'pointer' : 'default'
                    }}
                    onClick={() => openUrl(article.url)}
                  >
                    {article.title}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: DIM }}>
                    {[article.venue, article.year ? String(article.year) : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

// -- Argument Score: the Figma "Essay Grade" frames, labelled honestly -------
//
// Layout from "Real Tracely UI" (k7R5x1M9alKktaMLlZFSJn) frames 370:135 (widget),
// 391:342 (analyzing) and 404:129 (full report): ring, stats row, then a card per
// paragraph. The layout is the design's. The words are not, and that is the whole
// point of this block.
//
// Those frames grade an essay — Thesis Clarity, Grammar & Mechanics, Vocabulary &
// Word Choice, a B+ chip, "above average for this assignment type". Tracely
// measures none of that. It scores how an argument is built, on a different
// six-part rubric. Shipping the design's labels over this data would print
// numbers next to words they do not measure, so the labels here are the rubric's
// own (Merrick's call, 2026-08-14: score the argument, rewrite the labels).
//
// Two things from the design are deliberately absent rather than forgotten:
// the letter grade, because there is no grade band and inventing one implies a
// marking scheme; and "above average for this assignment type", because there is
// no cohort to be above the average of.

/**
 * One rubric component. Percent on the right because the design reads in
 * percentages, `x/20` in the tooltip because the rubric is out of its own maxima
 * and the raw number is what `scoreDraft.ts` actually produced.
 */
function ComponentBar({ value, max, label }: { value: number; max: number; label: string }): JSX.Element {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    // Wraps: label and percentage on the first line, the bar (flex-basis
    // 100%) on its own below. Without the wrap the bar squeezed the label to
    // nothing and it painted underneath the percentage.
    <div
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 }}
      title={`${label}: ${Math.round(value)} of ${max}`}
    >
      <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>
        {Math.round(pct)}%
      </span>
      <span
        style={{
          width: '100%',
          flexBasis: '100%',
          height: 4,
          borderRadius: 999,
          background: '#eeeef1',
          overflow: 'hidden'
        }}
      >
        <span
          style={{
            display: 'block',
            width: `${pct}%`,
            height: '100%',
            borderRadius: 999,
            background: evidenceScoreColor(pct)
          }}
        />
      </span>
    </div>
  )
}

/**
 * The design's score ring. Drawn rather than approximated with a rounded box,
 * because the ring is the one piece of this panel a user recognises at a glance.
 *
 * `strokeDasharray` on a circle rotated -90° fills clockwise from twelve o'clock,
 * which is the direction the frames draw.
 */
function ScoreRing({ score }: { score: number }): JSX.Element {
  const color = evidenceScoreColor(score)
  const radius = 29
  const circumference = 2 * Math.PI * radius
  const filled = (Math.max(0, Math.min(100, score)) / 100) * circumference
  return (
    <svg width={74} height={74} viewBox="0 0 74 74" role="img" aria-label={`Argument score ${score} of 100`}>
      <circle cx="37" cy="37" r={radius} fill="none" stroke="#eeeef1" strokeWidth="6" />
      <circle
        cx="37"
        cy="37"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`}
        transform="rotate(-90 37 37)"
      />
      <text x="37" y="34" textAnchor="middle" dominantBaseline="middle" fontSize="20" fontWeight="600" fill={color} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {score}
      </text>
      <text x="37" y="53" textAnchor="middle" fontSize="11" fill={DIM}>
        / 100
      </text>
    </svg>
  )
}

function StatCell({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: INK, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: DIM, letterSpacing: '0.04em', marginTop: 2, textTransform: 'uppercase' }}>
        {label}
      </div>
    </div>
  )
}

/**
 * 238 words per minute — Brysbaert's 2019 meta-analysis of silent reading of
 * English prose. Named rather than inlined so the number is arguable instead of
 * looking like it fell out of the sky.
 */
const READING_WPM = 238

/**
 * Which rubric components belong beside which paragraph role.
 *
 * The design puts one or two metric bars inside each paragraph card, and this is
 * what fills that slot honestly. A component appears beside the role it is a
 * reading of — thesis with the thesis paragraph, counterargument with the
 * counterargument — so the number sits next to the prose it was computed from.
 *
 * IMPORTANT: these are DOCUMENT-level components. `scoreDraft.ts` scores the
 * draft, not each paragraph. Showing one inside a card is context, and nothing in
 * the copy may suggest that paragraph was scored on its own — which is why each
 * component renders exactly once, against the FIRST paragraph carrying its role,
 * rather than repeating down every evidence paragraph as if each had earned its
 * own reading.
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

const COMPONENT_LABEL = new Map(COMPONENT_ROWS.map(([key, label, max]) => [key, { label, max }]))

/** Strong / Developing / Needs work, on the same 70/40 bands as every other score. */
function verdictFor(pct: number): { text: string; color: string } {
  if (pct >= 70) return { text: 'Strong', color: POSITIVE }
  if (pct >= 40) return { text: 'Developing', color: '#b3690a' }
  return { text: 'Needs work', color: '#c2410c' }
}

function ArgumentScoreView({
  structure,
  liveClaimIds,
  onHighlightParagraph
}: {
  structure: ScreenWatchStructure
  /** Claims still on screen — a weakness pointing at anything else cannot jump. */
  liveClaimIds: Set<string>
  onHighlightParagraph: (index: number, claimId: string | null) => void
}): JSX.Element {
  const { detected, withRelevantSource, withOwnCitation, meanStrength, unchecked } = structure.coverage
  const { words, sentences, uniqueWords } = structure.stats

  // Assigned as the list is built, so a component shown against ¶2 is not shown
  // again against ¶5. What is left over at the end is the genuinely useful
  // signal: a rubric component whose role never appears in the draft at all.
  const claimed = new Set<keyof StructureComponents>()
  // Same naming as every other breakdown of this draft — see paragraphNames.
  // The title is filtered out AFTER the names are computed, because the
  // numbering is a function of the whole list.
  const names = paragraphNames(structure.paragraphs, structure.titleParagraph)
  const rows = structure.paragraphs.map((paragraph, i) => {
    const keys = (ROLE_COMPONENTS[paragraph.role] ?? []).filter((key) => !claimed.has(key))
    keys.forEach((key) => claimed.add(key))
    const pcts = keys.map((key) => {
      const meta = COMPONENT_LABEL.get(key)!
      return (structure.components[key] / meta.max) * 100
    })
    return {
      paragraph,
      name: names[i],
      keys,
      verdict: pcts.length > 0 ? verdictFor(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
      weaknesses: structure.weaknesses.filter((w) => w.paragraphIndex === paragraph.index)
    }
  }).filter((row) => row.name !== null)
  const missing = COMPONENT_ROWS.filter(([key]) => !claimed.has(key))
  const draftWeaknesses = structure.weaknesses.filter((w) => w.paragraphIndex === null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ScoreRing score={structure.score} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: DIM, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Argument score
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginTop: 2 }}>
            How this draft is built
            {/* Not decoration. A draft with unlabelled paragraphs was scored on an
                incomplete reading, and the components it could not assess were
                counted as absent rather than skipped — presenting that as settled
                is the failure this prevents. */}
            {!structure.complete ? (
              <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: '#b3690a' }}>Provisional</span>
            ) : null}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 3, lineHeight: 1.4 }}>
            {/* Three facts, never merged — the same rule as the main app's
                panel. The ratio here used to be withRelevantSource, read out as
                "N of M claims have sources", which says Tracely's search
                results are the only citations that exist and reports "0 of 7"
                over a draft citing something on every line. What the writer
                cited leads, because it is a fact about their document and needs
                no search to know. */}
            {detected === 0 ? (
              'No checkable claims in this draft.'
            ) : (
              <>
                <b>
                  {withOwnCitation} of {detected}
                </b>{' '}
                {detected === 1 ? 'claim carries' : 'claims carry'} your citation
                {/* What retrieval found, said as retrieval and never as "has a
                    source" — and only once something has actually been
                    searched, since an unchecked claim is not an unsupported one
                    and the number must not imply a search has run when it has
                    not. */}
                {detected > unchecked ? (
                  <>
                    {' · '}
                    <span style={{ color: MUTED }}>
                      Tracely backs {withRelevantSource} of {detected - unchecked}
                      {meanStrength !== null ? <> (mean {meanStrength})</> : null}
                    </span>
                  </>
                ) : null}
                {unchecked > 0 ? <span style={{ color: DIM }}> · {unchecked} unchecked</span> : null}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Reading figures, not quality judgements — they describe the draft
          without claiming anything about it, which is why they survived the
          relabel when the design's grade chip did not. */}
      <div style={{ display: 'flex', gap: 10, paddingBottom: 12, borderBottom: '1px solid #ececf0' }}>
        <StatCell value={words.toLocaleString()} label="Words" />
        <StatCell value={`~${Math.max(1, Math.round(words / READING_WPM))} min`} label="Read time" />
        <StatCell value={(words / sentences).toFixed(1)} label="Words / sentence" />
        <StatCell
          value={`${Math.round((uniqueWords / Math.max(1, words)) * 100)}%`}
          label="Vocab diversity"
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: DIM, letterSpacing: '0.04em' }}>
          BREAKDOWN BY PARAGRAPH
        </div>
        {rows.map(({ paragraph, name, keys, verdict, weaknesses }) => (
          <div
            key={paragraph.index}
            data-paragraph={paragraph.index}
            data-role={paragraph.role}
            style={{
              border: '1px solid #ececf0',
              borderRadius: 12,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  fontWeight: 600,
                  color: INK
                }}
              >
                {name}
              </span>
              {/* The role stays, quieter. It is not decoration: scoreDraft
                  computes the whole /100 from the role vector, so showing it is
                  what makes a wrong label visibly wrong rather than
                  mysteriously costly. */}
              <span
                style={{
                  fontSize: 11,
                  color: DIM,
                  flexShrink: 0,
                  fontStyle: paragraph.role === 'unknown' ? 'italic' : 'normal'
                }}
              >
                {ROLE_LABEL[paragraph.role]}
              </span>
              {verdict ? (
                <span style={{ ...CHIP_STYLE, flexShrink: 0, color: verdict.color, background: `${verdict.color}14` }}>
                  {verdict.text}
                </span>
              ) : null}
            </div>

            <div
              style={{
                fontSize: 11,
                color: DIM,
                lineHeight: 1.4,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden'
              }}
            >
              {structure.previews[paragraph.index - 1] ?? ''}
            </div>

            {keys.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
                {keys.map((key) => {
                  const meta = COMPONENT_LABEL.get(key)!
                  return (
                    <div key={key} style={{ flex: '1 1 44%', minWidth: 120 }}>
                      <ComponentBar value={structure.components[key]} max={meta.max} label={meta.label} />
                    </div>
                  )
                })}
              </div>
            ) : null}

            {weaknesses.map((weakness, i) => {
              // Only some weaknesses can point at anything on screen — warrant
              // gaps usually fire on paragraphs with no detected claim in them,
              // so a chip that always looked like a button would mostly do
              // nothing.
              const jumpable = (paragraph.claimIds ?? []).some((id) => liveClaimIds.has(id))
              return (
                <div
                  key={`${weakness.kind}-${i}`}
                  style={{
                    display: 'flex',
                    gap: 7,
                    alignItems: 'flex-start',
                    background: '#fff7ed',
                    border: '1px solid #fed7aa',
                    borderRadius: 8,
                    padding: '6px 8px'
                  }}
                >
                  <span style={{ flexShrink: 0, fontSize: 11, color: '#b3690a' }}>!</span>
                  <span style={{ flex: 1, fontSize: 11, lineHeight: 1.45, color: MUTED }}>{weakness.message}</span>
                  {jumpable ? (
                    <button
                      className="tracely-btn-text"
                      onClick={() => onHighlightParagraph(paragraph.index, weakness.claimId)}
                      title="Show this paragraph's claims on screen"
                      style={{ ...TEXT_BTN_STYLE, flexShrink: 0, padding: '2px 6px', margin: '-2px -6px', fontSize: 11 }}
                    >
                      Show
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {/* The most useful thing on the panel, and it only exists because
          components are assigned to roles above: a component with no paragraph
          to sit beside is one the draft never attempts. */}
      {missing.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: DIM, letterSpacing: '0.04em' }}>
            NOT FOUND IN THIS DRAFT
          </div>
          <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.45 }}>
            {missing.map(([, label]) => label).join(' · ')}
          </div>
        </div>
      ) : null}

      {draftWeaknesses.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: DIM, letterSpacing: '0.04em' }}>SUMMARY</div>
          {/* The design writes a paragraph of prose here. These are the rubric's
              own sentences instead: nothing on this path generates text, and a
              summary invented to fill a slot would be the one part of the panel
              that was not a reading of the draft. */}
          {draftWeaknesses.map((weakness, i) => (
            <div key={`${weakness.kind}-${i}`} style={{ fontSize: 12, lineHeight: 1.45, color: MUTED }}>
              {weakness.message}
            </div>
          ))}
        </div>
      ) : null}

      {/* Hardcoded rather than driven by a `rolesFrom` field, because this path
          has no model classifier wired to it — the sentence has one value. It
          matters more here than in the app: there is no "re-analyze" button to
          ask for a better reading with. */}
      <div style={{ fontSize: 11, color: DIM, lineHeight: 1.4 }}>
        Labelled by local rules, which leave anything they cannot justify unlabelled.
      </div>
    </div>
  )
}

/**
 * What the panel shows when there is no trustworthy structural read.
 *
 * The score chip is now always present, so this state is reachable in a way it
 * never used to be — previously the chip was hidden whenever `structure` was
 * null, which meant a user whose draft never produced a reading had no way in at
 * all and nothing to click. That was the original complaint.
 *
 * It says why rather than spinning. `computeWatchOutline` returns null when
 * `structureFit` judges the text unfit — too short, or no real paragraph
 * boundaries — and that is a fact about the draft the user can act on, not a
 * loading state that will resolve on its own.
 */
function NoReadingView(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, padding: '26px 16px' }}>
      <ScoreRing score={0} />
      <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>No reading yet</div>
      <div style={{ fontSize: 12, color: MUTED, textAlign: 'center', lineHeight: 1.45, maxWidth: 260 }}>
        The rubric needs a few paragraphs of prose before it has an opinion worth showing. Keep writing and this
        fills in on its own.
      </div>
    </div>
  )
}

// -- Hover popup: ProblemCard -----------------------------------------
//
// The lightweight "Grammarly-style" glance card — a single problem
// statement and one primary action, distinct from the widget panel's
// heavier ClaimActionCard. Which of the three variants shows is derived
// entirely from the claim's own state (critique verdict, evidence
// resolution), not tracked separately.

// A renderer-local `problemKindFor(claim)` used to live here, deciding the
// popover's variant from the claim's verdict and evidence independently of
// main. It has had no call site since main became the single source of truth
// (services/screenWatch/problemKind.ts) and the payload started carrying
// `problemKinds` — and it was actively dangerous to leave lying around: it
// still folded the `contradicted` verdict into 'unsupported-by-evidence', so
// reintroducing one call to it would have quietly restored the bug of telling
// a writer their reasoning is weak when the model said a fact is wrong.
//
// The support bands below are still used, by problemCopyFor.
//
// The underline the user hovered is coloured by bucketFor(claimType) — four
// distinct colours (factual orange, statistic purple, causal blue, other red).
// The popup, however, collapsed every one of them that wasn't a statistic into
// the single title "Missing citation", with a description asserting the claim
// "isn't backed by a source anywhere in your document". So four visibly
// different underlines said the same thing, and they said it even when the
// background evidence search had already come back with well-scoring sources —
// the card had `claim.evidence.count` in hand and used it only to pick the
// button label.
//
// Two independent axes were being flattened into one:
//   - WHAT KIND of assertion this is        -> claimType, which is the colour
//   - HOW IT FARED against the evidence     -> evidence.count / evidence.score
// so the title now names the kind, and the description reports the finding.
// Thresholds are the same 70/40 bands as evidenceScoreColor and the main app's
// ClaimCard, so "weak" means the same number everywhere in the product.

// supportLevelFor, KIND_NOUN and problemCopyFor moved to
// components/problemCopy.ts so the document editor's popovers say exactly
// what these say. The wording above is the reasoning behind them and stays
// here with the card that shows it.

/**
 * "Suggest fix", answered inside the popover instead of by navigating.
 *
 * Pressing it used to select the claim, drop the hover card and expand the
 * widget panel in the corner — a jump to the other side of the screen, away
 * from the sentence the question was asked about, to read something the panel
 * was already able to show. The citation flow stopped doing that; this is the
 * same correction for the other button.
 *
 * There is no Figma frame for it (see components/fixFlowCopy.ts). It is
 * assembled from what this popover already draws: the header dot in the mark's
 * colour, POPOVER_BODY prose, and — for the two blocks of proposed text — the
 * widget panel's own CritiqueFixRow, unchanged, which is what has been showing
 * a suggested revision since before this card existed.
 *
 * Nothing is fetched. Every word here came off the claim, written by the
 * critique that raised the underline, so opening this cannot make the relay
 * call that Screen Watch deliberately never makes on its own.
 *
 * Copy, not Apply, and that is not taste: this window is drawn over another
 * application it reads through UI Automation. It can write a short citation at
 * a located offset, which is a different proposition from selecting a whole
 * sentence in someone else's editor and typing over it — a button that appeared
 * to rewrite the paragraph underneath would be claiming a reach this window
 * does not have. Tracely's own editor, which owns its text, does apply it.
 */
function FixCard({
  claim,
  kind,
  fallbackDetail,
  onBack
}: {
  claim: ScreenWatchClaimSummary
  kind: ScreenWatchProblemKind
  /**
   * What the problem card said, for a claim carrying no critique text.
   *
   * `popoverCopyFor` already keeps a sentence for that case, and this card
   * needs the same one: `critiqueIssues('')` returns an empty array, so without
   * a fallback "Suggest fix" opened onto a header and a Back button. Reached in
   * the preview harness against a claim flagged 'unsupported-by-evidence' with a null
   * critique.
   */
  fallbackDetail: string
  onBack: () => void
}): JSX.Element {
  const revision = claim.suggestedRevision
  const citationFix = claim.citationFix
  // Only when there is nothing to hand over. Where a revision exists the
  // critique prose was already read on the card behind this one, and repeating
  // it above the sentence it produced buries the one thing worth looking at.
  const issues = revision || citationFix ? [] : critiqueIssues(claim.critique || fallbackDetail)

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{ width: 8, height: 8, borderRadius: '50%', background: PROBLEM_COLOR[kind], flexShrink: 0 }}
        />
        <div style={POPOVER_TITLE}>{fixTitle(kind)}</div>
      </div>
      {revision ? (
        <>
          <div style={POPOVER_BODY}>{REVISION_RULE}</div>
          <CritiqueFixRow label={REVISION_LABEL} text={revision} />
          <div style={{ ...POPOVER_BODY, fontSize: 12 }}>{OVERLAY_APPLY_NOTE}</div>
        </>
      ) : null}
      {citationFix ? <CritiqueFixRow label={CITATION_FIX_LABEL} text={citationFix} monospace /> : null}
      {issues.length ? (
        <>
          <div style={POPOVER_BODY}>{NO_REVISION_BODY}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
            {issues.map((issue, i) => (
              <CritiqueIssueRow key={i} title={issue.title} detail={issue.detail} />
            ))}
          </div>
        </>
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="tracely-btn-secondary" onClick={onBack} style={SECONDARY_BTN_STYLE}>
          Back
        </button>
      </div>
    </>
  )
}

function ProblemCard({
  claim,
  activeKind,
  remaining,
  onSuggestFix,
  onStartCitationFlow,
  onFindCitedWork,
  onDismiss
}: {
  claim: ScreenWatchClaimSummary
  /** The first problem not yet dismissed — the only one this card shows. */
  activeKind: ScreenWatchProblemKind
  /** How many problems remain on this sentence, including the active one. */
  remaining: number
  onSuggestFix: () => void
  /** Opens the source list in the mode the card's action asks for. */
  onStartCitationFlow: (mode: FlowMode) => void
  onFindCitedWork: () => void
  onDismiss: () => void
}): JSX.Element {
  // Read, not re-derived. This card and the underline disagreeing about what
  // is wrong with the same sentence was the whole defect.
  const kind = activeKind

  if (kind === 'searching') {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="tracely-spinner" />
          <div style={POPOVER_TITLE}>Checking this claim</div>
        </div>
        <div style={POPOVER_BODY}>Searching open-access journals and databases for a source that supports it.</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tracely-btn-secondary" onClick={onDismiss} style={SECONDARY_BTN_STYLE}>
            Dismiss
          </button>
        </div>
      </>
    )
  }

  // The dot is the underline's own colour, which is the design's: amber for a
  // citation problem, orange for an unverified figure, red for reasoning.
  const dotColor = PROBLEM_COLOR[kind]
  // `kind` is only 'searching' when evidence is null, and that case returned
  // above — so evidence is non-null here.
  const { title, description, action: primaryLabel } = popoverCopyFor(
    claim,
    claim.evidence as ScreenWatchClaimEvidence,
    kind
  )
  // Routed by the ACTION, the editor's rule (shared/citationAction.ts). This
  // used to send every non-fix kind to the inserter: "Compare sources", "Review
  // the sources" and "Cite it yourself" each opened a picker whose primary
  // button typed a citation into the watched document — the opposite of what
  // the card above it had just said.
  //
  // And this window can only type at the caret, never replace: on a card about
  // a citation already in the sentence, an Insert would append a second one
  // beside it. So there the list offers Copy instead.
  const route = popoverRoute(primaryLabel)
  const own = claim.hasOwnCitation ?? claim.hasInlineCitation
  const onPrimary =
    route === 'fix'
      ? onSuggestFix
      : route === 'cited-work'
        ? onFindCitedWork
        : route === 'insert'
          ? () => onStartCitationFlow(aboutTheCitation(kind, own) ? 'copy' : 'insert')
          : // 'read-only', and 'tracer', which Screen Watch never raises (it
            // does not measure tangents) — a list to read is the safe default.
            () => onStartCitationFlow('read-only')

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
        <div style={POPOVER_TITLE}>{title}</div>
        {/* How many problems this sentence has in total, when it has more than
            one. Only the first is shown; fixing or dismissing it advances to
            the next, so the count is the writer's warning that the card is not
            finished with them yet. The one element here the design does not
            draw — it postdates the frames. */}
        {remaining > 1 ? (
          <span
            title={`${remaining} issues with this sentence — this is the first`}
            style={{ ...CHIP_STYLE, marginLeft: 'auto', flexShrink: 0, minWidth: 20, justifyContent: 'center' }}
          >
            {remaining}
          </span>
        ) : null}
      </div>
      <MarkdownText style={POPOVER_BODY}>{description}</MarkdownText>
      {/* The design's action row is exactly two buttons — fix it, or dismiss
          it — and at 320 wide that is all that fits on one line. */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="tracely-btn-primary" onClick={onPrimary} style={PRIMARY_BTN_STYLE}>
          {primaryLabel}
        </button>
        <button className="tracely-btn-secondary" onClick={onDismiss} style={SECONDARY_BTN_STYLE}>
          Dismiss
        </button>
      </div>
    </>
  )
}

// Skeleton bar widths, taken from the design rather than expressed as
// percentages — the uneven pair is what makes a loading row read as two lines
// of a real citation rather than as a progress widget.
const SKELETON_ROWS: Array<[number, number]> = [
  [214, 122],
  [186, 96]
]

// STYLE_LABEL and the flow's step copy live in components/citationFlowCopy.ts:
// the document editor now runs the same four-step flow over Tracely's own
// writing surface, and the two must not drift on what each step says.

// -- Hover popup: CitationFlowCard -------------------------------------
//
// searching -> picking -> inserted, entered from ProblemCard's "Add
// citation"/"Find a source" action. Tracked entirely client-side
// (citationFlowByClaimId in OverlayApp) — the server call itself is a
// single request/response per step, no persistent flow state on the main
// process side beyond the final insert.
//
// Drawn from three Figma frames, one per step: "Find a Source (Searching)"
// (294:343), "Find a Source (Results)" (295:349) and "Add Citation (Inserted)"
// (298:130). The style pills come from "Add Citation (Choose Source)"
// (296:355); the rest of that frame — a library list of sources already in the
// document, behind a text search field — is NOT built, and the reason is
// structural rather than an omission: Screen Watch persists nothing, so there
// is no per-document library to list, and `overlayWindow.ts` sets
// `focusable: false` so this window can never host a real text input.

type CitationFlowState =
  | { step: 'searching' }
  | {
      step: 'picking'
      candidates: ScreenWatchSourceCandidate[]
      /**
       * The work the sentence already cites, so this card can COMPARE rather
       * than merely list. Arrives with the candidates in one response — Screen
       * Watch claims are never persisted, so there is no id to look the
       * citation up by after the fact.
       */
      cited: ResolvedCitedWork | null
      selectedRef: string | null
      /**
       * What each source SAYS (shared/sourceReceipts.ts), asked for when this
       * list opens — the writer's click, never passive watching, because it
       * is a paid call. `checking` draws the checking step and allows no
       * insert; `checked` allows Insert, Copy citation and Copy entry only on
       * a source quoted backing the sentence; `unavailable` is the list from
       * before receipts, under a line saying nothing was checked.
       */
      receipts: ReceiptsState
      style: CitationStyle
      /**
       * What "Insert citation" would write, once Preview has been pressed.
       *
       * Cleared by every change to `selectedRef` or `style` rather than
       * refetched: both inputs feed the formatting, so a preview left standing
       * across a change is a citation for a source or a style the buttons no
       * longer say you are about to insert.
       */
      preview: ScreenWatchClaimCitation | null
    }
  | {
      step: 'inserted'
      citation: ScreenWatchClaimCitation
      /**
       * The style it was written in. Carried rather than re-read from the
       * picking step it came from, because that step is gone by now — and the
       * design's confirmation line names it ("MLA 9 in-text citation
       * inserted"), which is the one thing on this card that says WHAT was put
       * in the document rather than merely that something was.
       */
      style: CitationStyle
      /**
       * Whether the reference entry has been copied to the clipboard.
       *
       * Was `showWorksCited`, a toggle over a block this surface drew as
       * "ADDED TO WORKS CITED" — over a list it had added nothing to. The block
       * is now always visible and the button copies, so the flag records the
       * copy rather than the disclosure.
       */
      entryCopied: boolean
    }
  | { step: 'error'; message: string }

const CITATION_STYLES: CitationStyle[] = ['MLA', 'APA', 'Chicago']

/**
 * What the source list is FOR, decided by the card that opened it.
 *
 *  - `insert`: the card asked for a citation; Insert types the marker after
 *    the sentence through UI Automation.
 *  - `read-only`: "Compare sources", "Review the sources", "Cite it yourself" —
 *    a list to read. The editor has always drawn these without an Insert; this
 *    window offered one under all three until 2026-10-06.
 *  - `copy`: the card was about a citation ALREADY in the sentence. This window
 *    can only type at the caret, never replace, so an Insert would append a
 *    second citation beside the bad one. It hands the text over instead.
 */
type FlowMode = 'insert' | 'read-only' | 'copy'

/** Which half of a citation was last put on the clipboard. */
type Copied = 'marker' | 'entry' | null

/**
 * Puts text on the clipboard through main.
 *
 * Not `navigator.clipboard`: this window is `focusable: false`, and the async
 * clipboard API refuses a document without focus — the reason the older Copy
 * buttons here fall back to selectable text. Main's `clipboard.writeText` has
 * no such rule.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await window.tracely.clipboard.write({ text })
    return true
  } catch {
    return false
  }
}

/** 18px, filled ink with a 3px white centre — the design's selected radio. */
function Radio({ selected }: { selected: boolean }): JSX.Element {
  if (!selected) {
    return (
      <div
        style={{
          width: 18,
          height: 18,
          borderRadius: 999,
          border: '1.5px solid #d1d1d1',
          background: PAPER,
          flexShrink: 0
        }}
      />
    )
  }
  return (
    <div
      style={{
        width: 18,
        height: 18,
        borderRadius: 999,
        background: INK,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: PAPER }} />
    </div>
  )
}

/**
 * One source in the list, with its receipt — the overlay's DocSourceRow
 * (components/DocumentMarkLayer.tsx): the same two shapes, inline styles.
 *
 * `pickable` (shared/sourceReceipts.ts `mayInsert`) is the radio button it
 * always was. Anything else — topic, unread, says otherwise, or any row in a
 * read-only list — is not selectable and offers only Open, which opens the
 * page in the writer's browser (this window takes no focus and hosts no page).
 */
function CandidateRow({
  candidate,
  selected,
  onSelect,
  receipt = null,
  pickable = true,
  showMatch = true
}: {
  candidate: ScreenWatchSourceCandidate
  selected: boolean
  onSelect: () => void
  receipt?: SourceReceipt | null
  pickable?: boolean
  /** Off once the list has been read: a match percentage measured the topic, not support. */
  showMatch?: boolean
}): JSX.Element {
  const meta = [candidate.venue, candidate.year ? String(candidate.year) : null].filter(Boolean).join(' · ')
  const rowStyle: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    // Top-aligned once a receipt wraps under the title, so the icon stays
    // beside the title it names rather than drifting to the middle of a quote.
    alignItems: receipt?.quote ? 'flex-start' : 'center',
    gap: 8,
    padding: 8,
    // The control radius: a source row is the editor's .docmark-row.
    borderRadius: 8,
    // The unselected row keeps a transparent border of the same width, so
    // selecting one does not shift the row's contents by a pixel.
    border: `1px solid ${selected && pickable ? HAIRLINE : 'transparent'}`,
    // Unset when not selected, so the .tracely-row-btn hover wash can show.
    background: selected && pickable ? SELECTED_BG : undefined,
    textAlign: 'left',
    cursor: pickable ? 'pointer' : 'default',
    fontFamily: 'inherit',
    color: 'inherit'
  }
  const body = (
    <>
      <SourceIcon provider={candidate.provider} faviconDataUrl={candidate.faviconDataUrl} />
      {/* `overflow: hidden` as well as `minWidth: 0`. The min-width lets this
          shrink below its content; without the overflow it shrinks and its
          children paint straight out of it regardless, which pushed the row and
          the whole 380px card sideways. Measured: card scrollWidth 435 against
          clientWidth 361, on a real result from the fixture. */}
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: INK,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {candidate.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, minWidth: 0 }}>
          {/* The venue is what gives, and the match percentage is what does not.
              Ellipsising the line as a whole would cut the number the card is
              titled around — "Ranked by how directly each source supports…" is
              a promise that the ranking is legible on every row. */}
          {meta ? (
            <span
              style={{
                color: MUTED,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {meta}
            </span>
          ) : null}
          {showMatch ? (
            <span style={{ color: POSITIVE, fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {candidate.matchPercent}% match
            </span>
          ) : null}
        </div>
        {/* The receipt: the source's own words, verbatim, and where they were
            read. Wraps — the quote is why the row is here. */}
        {receipt?.quote ? (
          <div style={{ fontSize: 12, lineHeight: 1.4, color: INK, whiteSpace: 'normal', wordBreak: 'break-word', userSelect: 'text' }}>
            <span style={{ color: MUTED, fontWeight: 500 }}>{SOURCE_SAYS}</span> {quoted(receipt.quote)}{' '}
            <span style={{ color: DIM }}>· {readFromLabel(receipt.readFrom)}</span>
          </div>
        ) : null}
        {/* What a marker would make of the publisher — see
            shared/sourceCredibility.ts. Grey, never red, for `unvetted`: it
            means "Tracely does not recognise this publisher", which is a fact
            about our list rather than about the site. */}
        <span
          // The chip recipe, keeping the credibility colours.
          style={{
            ...CHIP_STYLE,
            alignSelf: 'flex-start',
            background: candidate.credibility.citable ? '#eef7f0' : CHIP_BG,
            color: candidate.credibility.citable ? POSITIVE : MUTED
          }}
        >
          {candidate.credibility.label}
        </span>
      </div>
    </>
  )
  if (pickable) {
    return (
      <button className="tracely-row-btn" onClick={onSelect} style={rowStyle}>
        {body}
        <Radio selected={selected} />
      </button>
    )
  }
  return (
    <div style={rowStyle}>
      {body}
      {candidate.url ? (
        <button
          className="tracely-btn-secondary"
          onClick={() => openUrl(candidate.url)}
          title={candidate.url}
          style={{ ...SECONDARY_BTN_STYLE, flexShrink: 0, height: 28, padding: '0 10px', fontSize: 12 }}
        >
          {OPEN_SOURCE}
        </button>
      ) : null}
    </div>
  )
}

/**
 * The source the writer already cited, drawn above the search results.
 *
 * The overlay's half of the same change the editor got — see
 * `CitedSourceBlock` in components/DocumentMarkLayer.tsx and the shared wording
 * in shared/citedComparison.ts. Inline styles rather than classes, because this
 * window loads no stylesheet; the DECISIONS are shared and the markup is not,
 * which is the rule every card on both surfaces follows.
 *
 * Renders nothing when the sentence cites nothing the lookup can check. On this
 * surface that is common — Screen Watch reads whatever is on screen, often
 * mid-paragraph — and an empty panel explaining itself would push the source
 * list below the fold of a card that is already tight for room.
 *
 * No link. This window is click-through and unfocusable by design; the editor's
 * copy offers "Open the source you cited" because it can.
 */
function CitedSourceBlock({ cited }: { cited: ResolvedCitedWork | null }): JSX.Element | null {
  const described = describeCitedWork(cited)
  if (!described) return null
  return (
    <div
      style={{
        width: '100%',
        boxSizing: 'border-box',
        background: CHIP_BG,
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, letterSpacing: '0.04em' }}>
        {CITED_HEADING}
      </div>
      <div style={{ fontSize: 12, fontWeight: 500, color: INK }}>{described.reference}</div>
      {described.title ? (
        <div style={{ fontSize: 12, lineHeight: 1.35, color: INK }}>{described.title}</div>
      ) : null}
      <div style={{ fontSize: 12, lineHeight: 1.4, color: MUTED }}>
        {/* Grey, never red, when nothing came back. Crossref and Open Library
            hold journal articles and books; a web page or a government report
            is in neither, and a warning colour would turn a limit of ours into
            an accusation about their source. */}
        <span style={{ color: described.found ? POSITIVE : MUTED, fontWeight: 600 }}>
          {described.found ? '✓' : '?'}
        </span>{' '}
        {described.detail}
      </div>
      {described.note ? (
        <div style={{ fontSize: 12, lineHeight: 1.4, color: MUTED }}>{described.note}</div>
      ) : null}
    </div>
  )
}

/**
 * "Copy citation" and "Copy entry" — what this window offers where the editor
 * offers Replace. It cannot replace text in another app (UI Automation types at
 * the caret, nothing more), so it hands both halves over and says so.
 */
function CopyButtons({
  disabled,
  copied,
  onCopy
}: {
  disabled: boolean
  copied: Copied
  onCopy: (which: 'marker' | 'entry') => void
}): JSX.Element {
  // Disabled looks come from the .tracely-btn-*:disabled rule.
  const style = (primary: boolean): CSSProperties => (primary ? PRIMARY_BTN_STYLE : SECONDARY_BTN_STYLE)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button className="tracely-btn-primary" onClick={() => onCopy('marker')} disabled={disabled} style={style(true)}>
        {copied === 'marker' ? '✓ Copied' : 'Copy citation'}
      </button>
      <button className="tracely-btn-secondary" onClick={() => onCopy('entry')} disabled={disabled} style={style(false)}>
        {copied === 'entry' ? '✓ Copied' : 'Copy entry'}
      </button>
    </div>
  )
}

/** The overlay's "Find the cited work" card. See OverlayCitedWorkState. */
type OverlayCitedWorkState =
  | { step: 'searching' }
  | {
      step: 'results'
      response: ScreenWatchFindCitedWorkResponse
      selectedRef: string | null
      style: CitationStyle
      copied: Copied
    }
  | { step: 'error'; message: string }

/**
 * "Find the cited work", over another application.
 *
 * The same records the editor's card lists (both read `findCitedWork`), drawn
 * in this window's inline styles. The difference is the last row: the editor
 * replaces the citation in place, and this window cannot — so it offers the
 * record's marker and entry to copy, with the line that says why. Every field
 * shown is the record's; the year line states the two years and nothing else.
 */
function CitedWorkCard({
  state,
  color,
  onSelect,
  onSetStyle,
  onCopy,
  onFindSource,
  onRetry,
  onCancel
}: {
  state: OverlayCitedWorkState
  color: string
  onSelect: (ref: string) => void
  onSetStyle: (style: CitationStyle) => void
  onCopy: (which: 'marker' | 'entry') => void
  onFindSource: () => void
  onRetry: () => void
  onCancel: () => void
}): JSX.Element {
  const head = (dot: string, title: string): JSX.Element => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
      <div style={POPOVER_TITLE}>{title}</div>
    </div>
  )

  if (state.step === 'searching') {
    return (
      <>
        {head(color, CITED_WORK_SEARCHING_TITLE)}
        <div style={POPOVER_BODY}>{citedWorkSearchingBody('your citation')}</div>
        <div className="tracely-progress-track">
          <div className="tracely-progress-fill" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="tracely-btn-secondary" onClick={onCancel} style={SECONDARY_BTN_STYLE}>
            Cancel
          </button>
          <span style={{ fontSize: 12, color: DIM }}>Usually 2–4 seconds</span>
        </div>
      </>
    )
  }

  if (state.step === 'error') {
    return (
      <>
        {head(DESIGN_RED, 'Lookup failed')}
        <div style={POPOVER_BODY}>{state.message}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tracely-btn-secondary" onClick={onCancel} style={SECONDARY_BTN_STYLE}>
            Back
          </button>
        </div>
      </>
    )
  }

  const { response, selectedRef, style, copied } = state

  // The sentence's citation could not be pinned down — none in brackets, or
  // two. Said, with the topical search offered, rather than an empty list.
  if (response.target !== 'one') {
    return (
      <>
        {head(DESIGN_AMBER, CITED_WORK_EMPTY_TITLE)}
        <div style={POPOVER_BODY}>{citedWorkNoTarget(response.target)}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tracely-btn-primary" onClick={onFindSource} style={PRIMARY_BTN_STYLE}>
            Find a source
          </button>
          <button className="tracely-btn-secondary" onClick={onCancel} style={SECONDARY_BTN_STYLE}>
            Back
          </button>
        </div>
      </>
    )
  }

  if (response.candidates.length === 0) {
    return (
      <>
        {head(DESIGN_AMBER, CITED_WORK_EMPTY_TITLE)}
        <div style={POPOVER_BODY}>
          {response.searched ? citedWorkEmptyBody(response.citation) : CITED_WORK_UNREACHABLE}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {response.searched ? (
            <button className="tracely-btn-primary" onClick={onFindSource} style={PRIMARY_BTN_STYLE}>
              Find a source
            </button>
          ) : (
            <button className="tracely-btn-primary" onClick={onRetry} style={PRIMARY_BTN_STYLE}>
              Try again
            </button>
          )}
          <button className="tracely-btn-secondary" onClick={onCancel} style={SECONDARY_BTN_STYLE}>
            Back
          </button>
        </div>
      </>
    )
  }

  const selected = response.candidates.find((c) => c.ref === selectedRef) ?? null
  const written = selected ? selected.citations[style] : null

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: POSITIVE, flexShrink: 0 }} />
        <div style={POPOVER_TITLE}>{citedWorkResultsTitle(response.candidates.length)}</div>
        <span style={{ ...CHIP_STYLE, flexShrink: 0 }}>{CITATION_STYLE_LABEL[style]}</span>
      </div>
      <div style={POPOVER_BODY}>{CITED_WORK_RESULTS_BODY_EXTERNAL}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
        {response.candidates.map((candidate) => {
          const on = candidate.ref === selectedRef
          return (
            <button
              key={candidate.ref}
              className="tracely-row-btn"
              data-cited-ref={candidate.ref}
              onClick={() => onSelect(candidate.ref)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: 8,
                borderRadius: 8,
                border: `1px solid ${on ? HAIRLINE : 'transparent'}`,
                background: on ? SELECTED_BG : undefined,
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: 'inherit',
                color: 'inherit'
              }}
            >
              <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: INK,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {candidate.title}
                </div>
                <div style={{ fontSize: 12, color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {citedWorkMeta(candidate)}
                </div>
                {/* Neutral, words doing the work — colour here means a finding. */}
                {candidate.yearNote ? (
                  <div style={{ fontSize: 12, lineHeight: 1.35, color: MUTED }}>{candidate.yearNote}</div>
                ) : null}
              </div>
              <Radio selected={on} />
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: MUTED }}>Style</span>
        {CITATION_STYLES.map((option) => {
          const active = option === style
          return (
            <button
              key={option}
              className="tracely-style-pill"
              aria-pressed={active}
              onClick={() => onSetStyle(option)}
              style={STYLE_PILL}
            >
              {CITATION_STYLE_LABEL[option]}
            </button>
          )
        })}
      </div>
      {written ? (
        <div
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: SELECTED_BG,
            borderRadius: 8,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: DIM, letterSpacing: '0.04em' }}>
            {pasteOverLabel(response.citation)}
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, color: INK, userSelect: 'text' }}>{written.inTextCitation}</div>
          <div style={{ fontSize: 12, lineHeight: 1.4, color: MUTED, userSelect: 'text', wordBreak: 'break-word' }}>
            {written.worksCitedEntry}
          </div>
        </div>
      ) : null}
      <CopyButtons disabled={!written} copied={copied} onCopy={onCopy} />
      <div style={{ ...POPOVER_BODY, fontSize: 12 }}>{PASTE_OVER_NOTE}</div>
      <button className="tracely-btn-secondary" onClick={onFindSource} style={{ ...SECONDARY_BTN_STYLE, width: '100%' }}>
        {FIND_DIFFERENT_SOURCE}
      </button>
    </>
  )
}

function CitationFlowCard({
  state,
  claimText,
  visibleClaimCount,
  onSelectCandidate,
  onSetStyle,
  onSearchAgain,
  onInsert,
  onPreview,
  onCancel,
  onDone,
  onEntryCopied,
  onUndo,
  inserting,
  previewing,
  undoing,
  showCancel,
  mode = 'insert',
  onCopy,
  copied = null
}: {
  state: CitationFlowState
  /** What the list is for — see FlowMode. Absent means insert. */
  mode?: FlowMode
  /** Copy mode's two buttons: the in-text marker, or the reference entry. */
  onCopy?: (which: 'marker' | 'entry') => void
  copied?: Copied
  /** The sentence being cited — the design quotes it back to the reader. */
  claimText: string
  visibleClaimCount: number
  onSelectCandidate: (ref: string) => void
  onSetStyle: (style: CitationStyle) => void
  onSearchAgain: () => void
  onInsert: () => void
  /** Formats what Insert would write, into the picking step's `preview` field. */
  onPreview: () => void
  onCancel: () => void
  onDone: () => void
  /** Records that the reference entry reached the clipboard. */
  onEntryCopied: () => void
  onUndo: () => void
  inserting: boolean
  previewing: boolean
  undoing: boolean
  /**
   * Whether to draw a Cancel row under the two actions the design names.
   *
   * The frames have none: the hover card closes when the cursor leaves the
   * sentence. The Source Finder Popover over the Essay Grade panel has no such
   * exit, so it is the one caller that asks for one.
   */
  showCancel: boolean
}): JSX.Element {
  // "Related, but they don't say this" starts folded. Declared before every
  // early return below, so the hook order never changes between steps.
  const [topicOpen, setTopicOpen] = useState(false)

  // "Find a Source (Searching)" — 294:343.
  if (state.step === 'searching') {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: DESIGN_ORANGE, flexShrink: 0 }} />
          <div style={POPOVER_TITLE}>Searching for a source</div>
        </div>
        <div style={POPOVER_BODY}>{searchingBody(claimText)}</div>
        <div className="tracely-progress-track">
          <div className="tracely-progress-fill" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {SKELETON_ROWS.map(([wide, narrow], i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="tracely-skeleton" style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="tracely-skeleton" style={{ width: wide, height: 9, borderRadius: 999 }} />
                <div className="tracely-skeleton-faint" style={{ width: narrow, height: 8, borderRadius: 999 }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="tracely-btn-secondary" onClick={onCancel} style={SECONDARY_BTN_STYLE}>
            Cancel
          </button>
          <span style={{ fontSize: 12, color: DIM }}>Usually 3–5 seconds</span>
        </div>
      </>
    )
  }

  if (state.step === 'error') {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: DESIGN_RED, flexShrink: 0 }} />
          <div style={POPOVER_TITLE}>Search failed</div>
        </div>
        <div style={POPOVER_BODY}>{state.message}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tracely-btn-primary" onClick={onSearchAgain} style={PRIMARY_BTN_STYLE}>
            Search again
          </button>
          <button className="tracely-btn-secondary" onClick={onCancel} style={SECONDARY_BTN_STYLE}>
            Cancel
          </button>
        </div>
      </>
    )
  }

  // "Add Citation (Inserted)" — 298:130.
  if (state.step === 'inserted') {
    const remaining = Math.max(0, visibleClaimCount)
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: POSITIVE, flexShrink: 0 }} />
          <div style={POPOVER_TITLE}>Citation added</div>
        </div>
        {/* Names the STYLE, not the marker: the marker is already visible in
            the sentence behind this card. The second half is what separates
            this surface from the editor — see insertedBodyExternal. */}
        <div style={POPOVER_BODY}>{insertedBodyExternal(state.style)}</div>
        {/* Always drawn, never behind a toggle. This entry is the one piece of
            work the card is handing back to the writer, and a task hidden
            behind a button labelled "View" is a task most people never see. */}
        <div
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: SELECTED_BG,
            borderRadius: 8,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: DIM, letterSpacing: '0.04em' }}>
            {EXTERNAL_REFERENCE_LABEL}
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.4,
              color: MUTED,
              // Selectable, so a refused clipboard write is inconvenient rather
              // than a dead end — the same fallback CritiqueFixRow relies on.
              userSelect: 'text',
              wordBreak: 'break-word'
            }}
          >
            {state.citation.worksCitedEntry}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap' }}>
          <span style={{ color: POSITIVE, fontWeight: 500 }}>Claim resolved</span>
          <span style={{ color: DIM }}>· {flagsLeft(remaining)}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tracely-btn-primary" onClick={onDone} style={PRIMARY_BTN_STYLE}>
            Done
          </button>
          {/* "Copy entry", not "View Works Cited". The frame's button opens a
              list this surface does not have; the useful action here is to put
              the reference somewhere the writer can paste it. */}
          <button
            className="tracely-btn-secondary"
            onClick={() => {
              // No error surfaced on failure: a clipboard write can be refused
              // and there is nothing useful to say about it here. The entry
              // above is selectable, which is the fallback.
              void navigator.clipboard?.writeText(state.citation.worksCitedEntry).then(
                () => onEntryCopied(),
                () => undefined
              )
            }}
            style={SECONDARY_BTN_STYLE}
          >
            {state.entryCopied ? '✓ Copied' : 'Copy entry'}
          </button>
          <button
            className="tracely-btn-secondary"
            onClick={onUndo}
            disabled={undoing}
            style={SECONDARY_BTN_STYLE}
          >
            {undoing ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      </>
    )
  }

  // "Find a Source (Results)" — 295:349.
  const { candidates, cited, selectedRef, style, preview, receipts } = state
  if (candidates.length === 0) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: DESIGN_AMBER, flexShrink: 0 }} />
          <div style={POPOVER_TITLE}>No sources found</div>
        </div>
        <div style={POPOVER_BODY}>{emptyResultsBody(claimText)}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tracely-btn-primary" onClick={onSearchAgain} style={PRIMARY_BTN_STYLE}>
            Search again
          </button>
          <button className="tracely-btn-secondary" onClick={onCancel} style={SECONDARY_BTN_STYLE}>
            Dismiss
          </button>
        </div>
      </>
    )
  }

  // "Checking what each source says…" — between the search and the list. The
  // rows are not drawn yet: a list on screen before it is read reads as
  // recommended, and nothing in it may be inserted yet.
  if (receipts.status === 'checking') {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Grey: the "still checking" colour, not a finding. */}
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: PROBLEM_COLOR.searching, flexShrink: 0 }} />
          <div style={POPOVER_TITLE}>{CHECKING_TITLE}</div>
        </div>
        <div style={POPOVER_BODY}>{checkingBody(candidates.length, claimText)}</div>
        <div className="tracely-progress-track">
          <div className="tracely-progress-fill" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {SKELETON_ROWS.map(([wide, narrow], i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="tracely-skeleton" style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="tracely-skeleton" style={{ width: wide, height: 9, borderRadius: 999 }} />
                <div className="tracely-skeleton-faint" style={{ width: narrow, height: 8, borderRadius: 999 }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tracely-btn-secondary" onClick={onCancel} style={SECONDARY_BTN_STYLE}>
            Cancel
          </button>
        </div>
      </>
    )
  }

  // Checked: grouped by what each source SAYS. Unavailable: the list from
  // before receipts, Insert and all, under a line saying nothing was checked.
  const checked = receipts.status === 'checked'
  const groups = checked ? groupByReceipt(candidates, (c) => c.sourceRef, receipts.byId) : null
  const backing = groups?.backs.length ?? 0
  // A row may be picked only where Insert / Copy may take it.
  const pickable = (ref: string): boolean => mode !== 'read-only' && mayInsert(receipts, ref)
  const anyPickable = candidates.some((c) => pickable(c.sourceRef))
  const canAct = pickable(selectedRef ?? '')
  const row = (candidate: ScreenWatchSourceCandidate): JSX.Element => (
    <CandidateRow
      key={candidate.sourceRef}
      candidate={candidate}
      selected={candidate.sourceRef === selectedRef}
      onSelect={() => onSelectCandidate(candidate.sourceRef)}
      receipt={checked ? receipts.byId[candidate.sourceRef] ?? null : null}
      pickable={pickable(candidate.sourceRef)}
      showMatch={!checked}
    />
  )
  const groupLabel: CSSProperties = { fontSize: 11, fontWeight: 600, color: DIM, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '6px 8px 2px' }
  const column: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }

  return (
    <>
      {/* Titled with what BACKS the sentence once the list has been read —
          green when something does, amber when nothing does — and with the
          count found when it could not be read (the frame's header). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: checked && backing === 0 ? DESIGN_AMBER : POSITIVE, flexShrink: 0 }} />
        <div style={POPOVER_TITLE}>
          {checked
            ? receiptsTitle(backing)
            : mode === 'read-only'
              ? readOnlyTitle(candidates.length)
              : resultsTitle(candidates.length)}
        </div>
        {/* No style chip on a list opened to be read, or one with nothing in
            it that may be cited: a citation style is a question about a
            citation nobody is about to write. */}
        {mode === 'read-only' || !anyPickable ? null : (
          <span style={{ ...CHIP_STYLE, flexShrink: 0 }}>{CITATION_STYLE_LABEL[style]}</span>
        )}
      </div>
      <div style={POPOVER_BODY}>{checked ? receiptsBody(claimText, backing) : RECEIPTS_UNAVAILABLE}</div>
      <CitedSourceBlock cited={cited} />
      {groups ? (
        <>
          {groups.backs.length ? <div style={column}>{groups.backs.map(row)}</div> : null}
          {groups.contradicts.length ? (
            <div style={column}>
              <div style={groupLabel}>{contradictsGroupLabel(groups.contradicts.length)}</div>
              {groups.contradicts.map(row)}
            </div>
          ) : null}
          {groups.topic.length ? (
            <div style={column}>
              <button
                className="tracely-btn-text"
                onClick={() => setTopicOpen((open) => !open)}
                aria-expanded={topicOpen}
                style={{
                  ...groupLabel,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  textAlign: 'left',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit'
                }}
              >
                <InlineIcon svg={topicOpen ? ICON_SVG.chevronDown : ICON_SVG.chevronRight} />
                {topicGroupLabel(groups.topic.length)}
              </button>
              {topicOpen ? groups.topic.map(row) : null}
            </div>
          ) : null}
          {groups.unread.length ? (
            <div style={column}>
              <div style={groupLabel}>{unreadGroupLabel(groups.unread.length)}</div>
              {groups.unread.map(row)}
            </div>
          ) : null}
        </>
      ) : (
        <div style={column}>{candidates.map(row)}</div>
      )}
      {/* The style row from the Choose Source frame. Three pills rather than
          the one cycling button this used to be: the design shows every option
          at once, and a button that had to be clicked twice to discover
          Chicago was hiding two thirds of the control. */}
      {mode === 'read-only' || !anyPickable ? null : (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: MUTED }}>Style</span>
        {CITATION_STYLES.map((option) => {
          const active = option === style
          return (
            <button
              key={option}
              className="tracely-style-pill"
              aria-pressed={active}
              onClick={() => onSetStyle(option)}
              style={STYLE_PILL}
            >
              {CITATION_STYLE_LABEL[option]}
            </button>
          )
        })}
      </div>
      )}
      {/* What Insert would write, in the style and for the source currently
          selected. Both inputs clear it (see selectCandidate/setCandidateStyle),
          so a block left standing can never describe something other than what
          the button beside it is about to do. */}
      {preview ? (
        <div
          style={{
            width: '100%',
            background: SELECTED_BG,
            borderRadius: 8,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: DIM, letterSpacing: '0.04em' }}>
            {mode === 'copy' ? pasteOverLabel('YOUR CITATION') : 'WILL BE INSERTED'}
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, color: INK }}>{preview.inTextCitation}</div>
          <div style={{ fontSize: 12, lineHeight: 1.4, color: MUTED }}>{preview.worksCitedEntry}</div>
        </div>
      ) : null}
      {/* Insert + Preview, as the frame draws them. Preview earns its place
          here in a way it would not in Tracely's own editor: this writes into
          someone else's document over UIA, where the only way to see what is
          about to land is to be shown it first. */}
      {mode === 'read-only' || !anyPickable ? (
        // Nothing here may be cited — read-only, or no source was quoted
        // backing the sentence. Insert or Copy that can never enable is a
        // button promising what the card has just said not to do.
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tracely-btn-primary" onClick={onDone} style={PRIMARY_BTN_STYLE}>
            Done
          </button>
        </div>
      ) : mode === 'copy' ? (
        <>
          <CopyButtons disabled={!canAct} copied={copied} onCopy={(which) => onCopy?.(which)} />
          <div style={{ ...POPOVER_BODY, fontSize: 12 }}>{PASTE_OVER_NOTE}</div>
        </>
      ) : (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="tracely-btn-primary"
          onClick={onInsert}
          disabled={inserting || !canAct}
          style={PRIMARY_BTN_STYLE}
        >
          {inserting ? 'Inserting…' : 'Insert citation'}
        </button>
        <button
          className="tracely-btn-secondary"
          onClick={onPreview}
          disabled={previewing || !canAct}
          style={SECONDARY_BTN_STYLE}
        >
          {previewing ? 'Formatting…' : 'Preview'}
        </button>
      </div>
      )}
      {/* Full-width, under the pair — the frame's own third row. It re-runs the
          same focused search rather than filtering what came back: this window
          is `focusable: false` (overlayWindow.ts) and can never host a real
          text input, so "search again" is the only honest way to change the
          list. The filter field that stood here could not be typed into. */}
      <button
        className="tracely-btn-secondary"
        onClick={onSearchAgain}
        style={{ ...SECONDARY_BTN_STYLE, width: '100%' }}
      >
        Search again
      </button>
      {showCancel ? (
        <button
          className="tracely-btn-secondary"
          onClick={onCancel}
          style={{ ...SECONDARY_BTN_STYLE, width: '100%' }}
        >
          Cancel
        </button>
      ) : null}
    </>
  )
}

// -- Grade flow: SourceFinderPopover -----------------------------------
//
// The same citation flow as the hover popover, floated over the Essay Grade
// cards — Figma "Overlay Mockup - Essay Grade (Find Evidence Result)"
// (409:141), whose Source Finder Popover (410:147) is 400 wide at a 16px radius
// with a heavier shadow than the hover card and no tail, because it is not
// pointing at a sentence: it belongs to the "Find evidence" button in the
// report/paragraph card behind it.
//
// It reuses CitationFlowCard rather than redrawing the results list, which is
// what the design does too — 410:147 and the hover popover's "Find a Source
// (Results)" (295:349) are the same popover, down to the header dot, the style
// pill and the full-width "Search again". Every step comes along for free:
// searching skeletons, the empty result, the failure, and the inserted
// confirmation.

const SOURCE_FINDER_WIDTH = 400
const SOURCE_FINDER_RADIUS = 16
const SOURCE_FINDER_SHADOW = '0px 12px 32px 0px rgba(0, 0, 0, 0.18)'

/**
 * Placed over the panel it was opened from, never outside it.
 *
 * Not cosmetic: hoverTracking.ts hit-tests clicks against the widget's own
 * rect, so a popover drawn past the panel's edge would be visible and
 * completely unclickable. Centred horizontally, then clamped into the rect with
 * an 8px margin, so a panel clamped small by a short watched window still gets
 * a popover that can be pressed.
 *
 * Pinned to the TOP of the panel rather than to the frame's own y (548 of 1080,
 * about halfway): the report card is 1210px tall and scrolls, so a popover
 * placed by proportion lands below the fold of any window shorter than the
 * frame — which is most of them.
 */
function sourceFinderRect(panel: { x: number; y: number; width: number; height: number }): {
  left: number
  top: number
  width: number
  maxHeight: number
} {
  const margin = 8
  const width = Math.min(SOURCE_FINDER_WIDTH, Math.max(1, panel.width - margin * 2))
  const maxHeight = Math.max(1, panel.height - margin * 2)
  return {
    left: panel.x + Math.max(margin, Math.round((panel.width - width) / 2)),
    top: panel.y + margin,
    width,
    maxHeight
  }
}

export default function OverlayApp(): JSX.Element {
  const [underlines, setUnderlines] = useState<ScreenWatchOverlayUpdateEvent['underlines']>([])
  const [widget, setWidget] = useState<ScreenWatchWidget | null>(null)
  const [hover, setHover] = useState<ScreenWatchHoverEvent | null>(null)
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  /**
   * Problems the user has waved away, keyed `claimId:kind`.
   *
   * Dismissal used to remove the whole claim, which meant a sentence with two
   * problems lost the second one the moment the first was waved away — and a
   * sentence whose citation gap was fixed kept its reasoning warning hidden
   * for the rest of the session. Per-problem, the card simply advances.
   */
  const [dismissedIssues, setDismissedIssues] = useState<Set<string>>(new Set())
  // Driven locally at full mouse speed during a drag rather than round-
  // tripping every mousemove through main — main only needs to know the
  // final position (see onGripMouseDown). Cleared once the drag ends so the
  // next server-confirmed rect (which will already match) takes back over.
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)
  // True only between passing the drag threshold and mouseup. A ref, not
  // state: the overlay-update listener is registered once and would close over
  // a stale value.
  const dragActive = useRef(false)
  // Which claim the widget's single-claim view is focused on — null means
  // "the top one by confidence." Purely client-side: unlike widgetViewMode,
  // WHICH claim is shown doesn't change the panel's size, so there's no
  // reason for main to need to know it.
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null)
  /** Which paragraph the 'paragraph' panel is showing. See showParagraph. */
  const [detailParagraph, setDetailParagraph] = useState(1)
  /**
   * Paragraph whose claim underlines are temporarily lit, from clicking a ¶
   * chip on a structural weakness. Cleared on a timer and on any view change:
   * the overlay is click-through everywhere except its own panel, so there is
   * no click-outside to dismiss it with, and a highlight nobody can turn off
   * would sit over the user's document indefinitely.
   */
  const [highlightedParagraph, setHighlightedParagraph] = useState<number | null>(null)
  const [busyEvidenceIds, setBusyEvidenceIds] = useState<Set<string>>(new Set())
  const [busyCritiqueIds, setBusyCritiqueIds] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)

  // Which of the card's two result blocks to show, per claim: whichever action
  // the user took last, exactly as the design's two result frames read. A claim
  // that already carries a critique opens on it, since that is the thing the
  // sources list cannot tell them.
  const [panelBodyByClaim, setPanelBodyByClaim] = useState<Map<string, 'sources' | 'critique'>>(new Map())
  // Set for FRESH_EVIDENCE_MS after an explicit refresh — the green chip says
  // "just now", so it has to stop being true at some point.
  const [freshEvidenceIds, setFreshEvidenceIds] = useState<Set<string>>(new Set())
  // The article keys a claim had BEFORE its last refresh. Rows outside this
  // set are the ones the new search actually turned up, which is what "New"
  // means; without a baseline no row is marked, rather than all of them.
  const [refreshBaselineByClaim, setRefreshBaselineByClaim] = useState<Map<string, Set<string>>>(new Map())

  function panelBodyFor(claim: ScreenWatchClaimSummary): 'sources' | 'critique' {
    return panelBodyByClaim.get(claim.id) ?? (claim.critique ? 'critique' : 'sources')
  }

  function setPanelBody(claimId: string, body: 'sources' | 'critique'): void {
    setPanelBodyByClaim((prev) => new Map(prev).set(claimId, body))
  }
  // The hover popup's citation flow (Find a source / Add citation), keyed
  // by claim id — absent means "just showing ProblemCard," not started.
  const [citationFlowByClaimId, setCitationFlowByClaimId] = useState<Map<string, CitationFlowState>>(new Map())
  /** What each running source list is for — see FlowMode. Absent means insert. */
  const [flowModeByClaimId, setFlowModeByClaimId] = useState<Map<string, FlowMode>>(new Map())
  /** Copy mode's last copy, per claim, so the button can say so. */
  const [flowCopiedByClaimId, setFlowCopiedByClaimId] = useState<Map<string, Copied>>(new Map())
  // For code that runs after an await (checkReceipts, and the search that
  // precedes it): which cards are open — kept in step by setFlow, the one
  // path that opens or closes one — and, as of the last render, what each is
  // for and the claim's text. A closure from before the await would read the
  // world as it was when the button was pressed.
  const openFlowIdsRef = useRef(new Set<string>())
  const flowModeRef = useRef(flowModeByClaimId)
  flowModeRef.current = flowModeByClaimId
  const widgetRef = useRef(widget)
  widgetRef.current = widget
  /**
   * "Find the cited work", per claim — the same per-claim keying as the source
   * list, for the same reason: nothing pins the hover here.
   */
  const [citedWorkByClaimId, setCitedWorkByClaimId] = useState<Map<string, OverlayCitedWorkState>>(new Map())
  /**
   * Claims whose hover popover is currently showing the fix card.
   *
   * A set of ids rather than a single id, to match citationFlowByClaimId: the
   * hover moves between sentences freely here (nothing pins it, unlike the
   * editor), and a single slot would silently retarget the open card at
   * whichever claim the pointer crossed last.
   */
  const [fixOpenIds, setFixOpenIds] = useState<Set<string>>(new Set())
  const [citationBusyIds, setCitationBusyIds] = useState<Set<string>>(new Set())
  const [previewBusyIds, setPreviewBusyIds] = useState<Set<string>>(new Set())
  const [undoBusyIds, setUndoBusyIds] = useState<Set<string>>(new Set())
  /**
   * The claim whose Source Finder Popover is open over an Essay Grade card.
   *
   * Separate from `selectedClaimId` (which claim the 'single' panel is focused
   * on) because this one is about a popover that floats over a DIFFERENT panel:
   * the grade flow's "Find evidence" used to set selectedClaimId and switch to
   * 'single', which threw the reader out of the report they were reading to
   * answer a question they asked from inside it. The flow state itself lives in
   * the same citationFlowByClaimId map the hover popover uses, so a claim
   * cannot end up mid-flow twice with two different answers.
   */
  const [gradeFlowClaimId, setGradeFlowClaimId] = useState<string | null>(null)
  const [defaultStyle, setDefaultStyle] = useState<CitationStyle>('APA')
  // Settings > Preferences, read the same way the citation style is. The
  // overlay mounts no React context of its own, so the grade panels take this
  // as a prop; REFERENCE_LEVEL until the read lands, which is what the app did
  // before the setting existed.
  const [gradingLevel, setGradingLevel] = useState<number>(REFERENCE_LEVEL)

  useEffect(() => {
    window.tracely.settings
      .get()
      .then((s) => {
        setDefaultStyle(s.defaultCitationStyle)
        setGradingLevel(isGradeLevel(s.gradingLevel) ? s.gradingLevel : REFERENCE_LEVEL)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    return window.tracely.onScreenWatchOverlayUpdate((event) => {
      setUnderlines(event.underlines)
      setWidget(event.widget)
      // The payload's rect is authoritative, so the drop position held over
      // from a finished drag can go. Skipped while a drag is still in flight:
      // a poll landing mid-drag would otherwise yank the widget back to the
      // pre-drag rect for one frame.
      if (!dragActive.current) setDragPos(null)
    })
  }, [])

  useEffect(() => {
    return window.tracely.onScreenWatchHover((event) => {
      setHover(event)
    })
  }, [])

  function toggleWidgetExpanded(): void {
    if (!widget) return
    void window.tracely.screenWatch.setWidgetExpanded({ expanded: !widget.expanded })
  }

  function showAll(): void {
    void window.tracely.screenWatch.setWidgetExpanded({ expanded: true })
    void window.tracely.screenWatch.setWidgetViewMode({ mode: 'all' })
    // Local feedback ahead of the next hover-tracking event, which won't
    // arrive until the cursor actually moves — without this the hover
    // popover and the widget's new "all" panel could both be on screen at
    // once for a moment.
    setHover(null)
  }

  function showSingle(): void {
    void window.tracely.screenWatch.setWidgetViewMode({ mode: 'single' })
  }

  /**
   * Back from a secondary view. Mirrors openWidgetPanel's rule rather than
   * always landing on 'single', so a document with several unresolved claims
   * returns to the list it came from instead of dead-ending on one card.
   */
  function leavePanelView(): void {
    const unresolved = (widget?.claims ?? []).filter((c) => !isResolved(c.id))
    void window.tracely.screenWatch.setWidgetViewMode({
      mode: unresolved.length > 1 ? 'all' : 'single'
    })
  }

  function showStructure(): void {
    void window.tracely.screenWatch.setWidgetExpanded({ expanded: true })
    void window.tracely.screenWatch.setWidgetViewMode({ mode: 'structure' })
    setHover(null)
  }

  /**
   * The score chip's target — Figma's "Essay Grade Widget" card.
   *
   * The chip used to open 'structure' directly, which is the design's FULL
   * report: the whole rubric, the weaknesses and a row per paragraph, all at
   * once. The frames put the summary card first and the breakdown behind "View
   * Full Report", so that is the order here too.
   */
  function showGrade(): void {
    void window.tracely.screenWatch.setWidgetExpanded({ expanded: true })
    void window.tracely.screenWatch.setWidgetViewMode({ mode: 'grade' })
    setHover(null)
  }

  /** "View Full Report" — Figma 404:185, the same card expanded. */
  function showReport(): void {
    void window.tracely.screenWatch.setWidgetExpanded({ expanded: true })
    void window.tracely.screenWatch.setWidgetViewMode({ mode: 'report' })
    setHover(null)
  }

  /**
   * One paragraph, from a card in the report — Figma 407:359.
   *
   * The index lives in renderer state rather than in the payload: `viewMode` is
   * a bare string on the wire, and main only needs to know WHICH panel to size
   * the click-through region for, not which paragraph is in it.
   */
  function showParagraph(index: number): void {
    setDetailParagraph(index)
    void window.tracely.screenWatch.setWidgetExpanded({ expanded: true })
    void window.tracely.screenWatch.setWidgetViewMode({ mode: 'paragraph' })
    setHover(null)
  }

  /**
   * Light up the claim underlines belonging to one paragraph, so a weakness in
   * the panel points at something on the actual screen.
   *
   * This is the only on-screen connection available from the expanded panel:
   * while expanded, hoverTracking.ts hit-tests the widget rect alone, so claim
   * hover is off and there is nothing to conflict with. It reuses
   * UnderlineMark's existing `hovered` prop rather than adding a highlight
   * state of its own.
   *
   * setSelectedClaimId directly, NOT selectClaim — that helper also calls
   * showSingle(), which would throw the user out of the view they clicked from.
   * Setting it here just means Back lands on the right claim.
   */
  function highlightParagraph(index: number, claimId: string | null): void {
    setHighlightedParagraph(index)
    if (claimId) setSelectedClaimId(claimId)
  }

  /**
   * Wave away ONE problem. The claim only disappears once nothing is left.
   *
   * `remaining` is passed rather than recomputed so this cannot disagree with
   * what the card was showing when the button was pressed.
   */
  function dismissIssue(claimId: string, kind: ScreenWatchProblemKind, remaining: number): void {
    setDismissedIssues((prev) => new Set(prev).add(`${claimId}:${kind}`))
    if (remaining <= 1) setDismissedIds((prev) => new Set(prev).add(claimId))
  }

  function selectClaim(claimId: string): void {
    setSelectedClaimId(claimId)
    showSingle()
  }

  async function findEvidenceFor(claimId: string): Promise<void> {
    setActionError(null)
    setBusyEvidenceIds((prev) => new Set(prev).add(claimId))
    setPanelBody(claimId, 'sources')
    // Snapshot BEFORE the call, not after it resolves. The new articles arrive
    // on the next SCREENWATCH_OVERLAY_UPDATE push rather than in the response,
    // so a baseline taken afterwards would race the push and mark either
    // everything or nothing as new.
    const before = new Set(
      (widget?.claims.find((c) => c.id === claimId)?.evidence?.articles ?? []).map(articleKey)
    )
    try {
      await window.tracely.screenWatch.refreshEvidence({ claimId })
      setRefreshBaselineByClaim((prev) => new Map(prev).set(claimId, before))
      setFreshEvidenceIds((prev) => new Set(prev).add(claimId))
      window.setTimeout(() => {
        setFreshEvidenceIds((prev) => {
          if (!prev.has(claimId)) return prev
          const next = new Set(prev)
          next.delete(claimId)
          return next
        })
      }, FRESH_EVIDENCE_MS)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyEvidenceIds((prev) => {
        const next = new Set(prev)
        next.delete(claimId)
        return next
      })
    }
  }

  async function critiqueFor(claimId: string): Promise<void> {
    setActionError(null)
    setBusyCritiqueIds((prev) => new Set(prev).add(claimId))
    setPanelBody(claimId, 'critique')
    try {
      await window.tracely.screenWatch.critiqueClaim({ claimId })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyCritiqueIds((prev) => {
        const next = new Set(prev)
        next.delete(claimId)
        return next
      })
    }
  }

  /**
   * "Find evidence →" on an uncited claim in the report or paragraph card.
   *
   * Opens the Source Finder Popover over the card the reader is already in
   * (Figma 409:141) rather than switching the panel to the single-claim view,
   * which is what this used to do: the question was asked about one line of a
   * report, and answering it by replacing the report loses the place they asked
   * it from and makes Back the only way home.
   */
  function openGradeSourceFinder(claimId: string): void {
    setGradeFlowClaimId(claimId)
    // Always insert: this is an UNCITED claim's "Find evidence" button, and a
    // mode left over from a hover card on the same claim must not carry in.
    void startCitationFlow(claimId, 'insert')
  }

  /** Puts the popover away AND drops the flow, so reopening starts clean. */
  function closeGradeSourceFinder(claimId: string): void {
    setGradeFlowClaimId(null)
    setFlow(claimId, null)
  }

  function openFix(claimId: string): void {
    setFixOpenIds((prev) => new Set(prev).add(claimId))
  }

  function closeFix(claimId: string): void {
    setFixOpenIds((prev) => {
      const next = new Set(prev)
      next.delete(claimId)
      return next
    })
  }

  function setFlow(claimId: string, state: CitationFlowState | null): void {
    // Synchronously, unlike the state below: a search that resolves before
    // React renders must still see that its card is open (or was closed).
    if (state === null) openFlowIdsRef.current.delete(claimId)
    else openFlowIdsRef.current.add(claimId)
    setCitationFlowByClaimId((prev) => {
      const next = new Map(prev)
      if (state === null) next.delete(claimId)
      else next.set(claimId, state)
      return next
    })
  }

  // Both "Find a source" (no evidence yet) and "Add citation" (evidence
  // already on hand) run the same focused search server-side — the overlay
  // window can never take OS keyboard focus (overlayWindow.ts sets
  // focusable: false, deliberately, so it never steals focus from the app
  // being watched), so there's no way to host a real free-text search box
  // here; "search again" always re-runs with the claim's own query rather
  // than a typed override.
  async function startCitationFlow(claimId: string, mode?: FlowMode): Promise<void> {
    // A new mode only when the card says so; "Search again" keeps the one the
    // list was opened with.
    if (mode) setFlowModeByClaimId((prev) => new Map(prev).set(claimId, mode))
    setFlowCopiedByClaimId((prev) => new Map(prev).set(claimId, null))
    setCitedWork(claimId, null)
    setFlow(claimId, { step: 'searching' })
    try {
      const { candidates, cited } = await window.tracely.screenWatch.findSource({ claimId })
      // The user may have cancelled (flow entry removed) while this was in
      // flight — a stale result landing after that shouldn't reopen it, and
      // nothing should be paid for on a card nobody is looking at.
      const stillOpen = openFlowIdsRef.current.has(claimId)
      setCitationFlowByClaimId((prev) => {
        if (!prev.has(claimId)) return prev
        const next = new Map(prev)
        next.set(claimId, {
          step: 'picking',
          candidates,
          cited,
          // Nothing is pre-selected until the receipts say what may be cited.
          selectedRef: null,
          receipts: candidates.length ? { status: 'checking' } : { status: 'checked', byId: {} },
          style: defaultStyle,
          preview: null
        })
        return next
      })
      // Reached only through this function, which only a click reaches ("Find
      // a source", "Add citation", "Search again", the grade panel's "Find
      // evidence") — so the paid read behind the receipts is one the writer
      // asked for. Nothing on Screen Watch's passive path calls it.
      if (stillOpen && candidates.length) void checkReceipts(claimId, candidates)
    } catch (err) {
      setCitationFlowByClaimId((prev) => {
        if (!prev.has(claimId)) return prev
        const next = new Map(prev)
        next.set(claimId, { step: 'error', message: err instanceof Error ? err.message : String(err) })
        return next
      })
    }
  }

  /**
   * Receipts for the list just drawn — what each source SAYS about the
   * sentence (shared/sourceReceipts.ts). Main caches them, so hovering back
   * onto this sentence and reopening costs nothing. Lands only on the list it
   * was asked about; a "Search again" in between replaced `candidates`.
   */
  async function checkReceipts(claimId: string, candidates: ScreenWatchSourceCandidate[]): Promise<void> {
    // Main answers `unavailable` for an empty sentence, which is the fallback —
    // never "nothing backs it".
    const claimText = widgetRef.current?.claims.find((c) => c.id === claimId)?.text ?? ''
    let receipts: ReceiptsState = { status: 'unavailable' }
    try {
      const res = await window.tracely.sources.verify({
        claimText,
        sources: candidates.map((c) => ({
          id: c.sourceRef,
          title: c.title,
          url: c.url,
          doi: c.doi ?? null,
          abstract: c.abstract ?? null,
          venue: c.venue,
          year: c.year,
          provider: c.provider
        }))
      })
      if (res.status === 'checked') receipts = { status: 'checked', byId: receiptsById(res.receipts) }
    } catch (err) {
      // The fallback, not an error card: the list as it was before receipts.
      console.warn('[receipts] verification failed', err)
    }
    setCitationFlowByClaimId((prev) => {
      const current = prev.get(claimId)
      if (current?.step !== 'picking' || current.candidates !== candidates) return prev
      const order =
        receipts.status === 'checked'
          ? Object.values(groupByReceipt(candidates, (c) => c.sourceRef, receipts.byId)).flat()
          : candidates
      const mode = flowModeRef.current.get(claimId) ?? 'insert'
      const next = new Map(prev)
      next.set(claimId, {
        ...current,
        receipts,
        selectedRef: mode === 'read-only' ? null : firstInsertable(order.map((c) => c.sourceRef), receipts),
        preview: null
      })
      return next
    })
  }

  // Both drop `preview`: it was formatted from the source and style being
  // replaced, so keeping it would show a citation for something other than what
  // "Insert citation" is now about to write.
  function selectCandidate(claimId: string, ref: string): void {
    const flow = citationFlowByClaimId.get(claimId)
    if (flow?.step === 'picking') setFlow(claimId, { ...flow, selectedRef: ref, preview: null })
  }

  function setCandidateStyle(claimId: string, style: CitationStyle): void {
    const flow = citationFlowByClaimId.get(claimId)
    if (flow?.step === 'picking') setFlow(claimId, { ...flow, style, preview: null })
  }

  /**
   * Formats the selected source in the selected style, without writing it.
   *
   * `previewCitation` touches neither the document nor the database — it is the
   * pure formatters in `citations/formatters/*` behind an IPC call, which is
   * why this is safe to offer as a plain button beside Insert.
   */
  async function previewCitation(claimId: string): Promise<ScreenWatchClaimCitation | null> {
    const flow = citationFlowByClaimId.get(claimId)
    if (flow?.step !== 'picking' || !flow.selectedRef) return null
    const sourceRef = flow.selectedRef
    const style = flow.style
    setPreviewBusyIds((prev) => new Set(prev).add(claimId))
    try {
      const { citation } = await window.tracely.screenWatch.previewCitation({ claimId, sourceRef, style })
      // Re-read rather than closing over `flow`: the selection or the style may
      // have moved on while this was in flight, and a preview of the previous
      // pair is exactly the stale block the `preview: null` resets exist to
      // prevent.
      setCitationFlowByClaimId((prev) => {
        const current = prev.get(claimId)
        if (current?.step !== 'picking' || current.selectedRef !== sourceRef || current.style !== style) {
          return prev
        }
        const next = new Map(prev)
        next.set(claimId, { ...current, preview: citation })
        return next
      })
      return citation
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setPreviewBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(claimId)
        return next
      })
    }
  }

  async function insertCitation(claimId: string): Promise<void> {
    const flow = citationFlowByClaimId.get(claimId)
    // The receipts rule, enforced here as well as on the button: only a source
    // quoted backing the sentence goes into someone's document.
    if (flow?.step !== 'picking' || !flow.selectedRef || !mayInsert(flow.receipts, flow.selectedRef)) return
    setCitationBusyIds((prev) => new Set(prev).add(claimId))
    try {
      const { citation } = await window.tracely.screenWatch.insertCitation({
        claimId,
        sourceRef: flow.selectedRef,
        style: flow.style
      })
      // Works Cited open from the start, as the frame draws it. The entry is
      // the half of the insert the writer cannot see — the in-text marker is
      // already visible in their sentence — so hiding it behind a button meant
      // the confirmation confirmed only the part that needed no confirming.
      setFlow(claimId, { step: 'inserted', citation, style: flow.style, entryCopied: false })
    } catch (err) {
      setFlow(claimId, { step: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setCitationBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(claimId)
        return next
      })
    }
  }

  function markEntryCopied(claimId: string): void {
    const flow = citationFlowByClaimId.get(claimId)
    if (flow?.step === 'inserted') setFlow(claimId, { ...flow, entryCopied: true })
  }

  /**
   * Copy mode's buttons on the source list. The formatted pair comes from the
   * same pure `previewCitation` the Preview button calls — nothing is written
   * to the watched document, which is the whole point of the mode.
   */
  async function copyFlowCitation(claimId: string, which: 'marker' | 'entry'): Promise<void> {
    const flow = citationFlowByClaimId.get(claimId)
    if (flow?.step !== 'picking' || !mayInsert(flow.receipts, flow.selectedRef)) return
    const citation = await previewCitation(claimId)
    if (!citation) return
    const ok = await copyToClipboard(which === 'marker' ? citation.inTextCitation : citation.worksCitedEntry)
    if (ok) setFlowCopiedByClaimId((prev) => new Map(prev).set(claimId, which))
  }

  function setCitedWork(claimId: string, state: OverlayCitedWorkState | null): void {
    setCitedWorkByClaimId((prev) => {
      if (state === null && !prev.has(claimId)) return prev
      const next = new Map(prev)
      if (state === null) next.delete(claimId)
      else next.set(claimId, state)
      return next
    })
  }

  /**
   * "Find the cited work" from the hover card. Crossref and Open Library via
   * main — free, and only ever on this button, which is the line Screen Watch
   * holds: nothing passive here spends anything or writes anything.
   */
  async function startCitedWork(claimId: string): Promise<void> {
    setFlow(claimId, null)
    setCitedWork(claimId, { step: 'searching' })
    try {
      const response = await window.tracely.screenWatch.findCitedWork({ claimId })
      setCitedWorkByClaimId((prev) => {
        // Cancelled while it was in flight — do not reopen it.
        if (!prev.has(claimId)) return prev
        return new Map(prev).set(claimId, {
          step: 'results',
          response,
          selectedRef: response.candidates[0]?.ref ?? null,
          style: defaultStyle,
          copied: null
        })
      })
    } catch (err) {
      setCitedWorkByClaimId((prev) =>
        prev.has(claimId)
          ? new Map(prev).set(claimId, { step: 'error', message: err instanceof Error ? err.message : String(err) })
          : prev
      )
    }
  }

  function updateCitedWork(
    claimId: string,
    change: (state: Extract<OverlayCitedWorkState, { step: 'results' }>) => OverlayCitedWorkState
  ): void {
    setCitedWorkByClaimId((prev) => {
      const current = prev.get(claimId)
      return current?.step === 'results' ? new Map(prev).set(claimId, change(current)) : prev
    })
  }

  async function copyCitedWork(claimId: string, which: 'marker' | 'entry'): Promise<void> {
    const state = citedWorkByClaimId.get(claimId)
    if (state?.step !== 'results') return
    const candidate = state.response.candidates.find((c) => c.ref === state.selectedRef)
    if (!candidate) return
    const pair = candidate.citations[state.style]
    const ok = await copyToClipboard(which === 'marker' ? pair.inTextCitation : pair.worksCitedEntry)
    if (ok) updateCitedWork(claimId, (s) => ({ ...s, copied: which }))
  }

  async function undoCitation(claimId: string): Promise<void> {
    setUndoBusyIds((prev) => new Set(prev).add(claimId))
    try {
      await window.tracely.screenWatch.undoCitation({ claimId })
      // The claim reappears in the flagged set once the next overlay-update
      // payload lands (citation cleared server-side) — closing the flow
      // here rather than trying to restore the prior candidate list, which
      // may be stale by now.
      setFlow(claimId, null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setUndoBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(claimId)
        return next
      })
    }
  }

  // Shared drag handler for both the collapsed circle and the expanded
  // panel's grip. The circle also needs to stay clickable (to open the
  // panel) without a drag — distinguished by a small movement threshold:
  // real dragging isn't reported to main (and doesn't move anything) until
  // the cursor has actually moved past it, and a mouseup before that
  // threshold is treated as a plain click instead.
  const DRAG_THRESHOLD = 4
  function startWidgetDrag(e: ReactMouseEvent, size: { width: number; height: number }, onClick?: () => void): void {
    if (!widget) return
    e.preventDefault()
    const startMouse = { x: e.clientX, y: e.clientY }
    const startRect = { x: widget.rect.x, y: widget.rect.y }
    let dragging = false

    function clamp(pos: { x: number; y: number }): { x: number; y: number } {
      return {
        x: Math.min(Math.max(0, pos.x), window.innerWidth - size.width),
        y: Math.min(Math.max(0, pos.y), window.innerHeight - size.height)
      }
    }
    function delta(ev: MouseEvent): { x: number; y: number } {
      return { x: startRect.x + (ev.clientX - startMouse.x), y: startRect.y + (ev.clientY - startMouse.y) }
    }
    function onMove(ev: MouseEvent): void {
      if (!dragging) {
        const dx = ev.clientX - startMouse.x
        const dy = ev.clientY - startMouse.y
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        dragging = true
        dragActive.current = true
        void window.tracely.screenWatch.widgetDragStart()
      }
      setDragPos(clamp(delta(ev)))
    }
    function onUp(ev: MouseEvent): void {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (dragging) {
        // Hold the drop position rather than clearing it. `setDragPos(null)`
        // was synchronous while the IPC that moves `widget.rect` was not, so
        // the very next render fell back to the PRE-drag rect and the widget
        // visibly snapped back to where the drag started before jumping to
        // where it was dropped, one payload later.
        //
        // The overlay-update handler clears it once main's rect has caught up.
        const dropped = clamp(delta(ev))
        setDragPos(dropped)
        dragActive.current = false
        void window.tracely.screenWatch.widgetDragEnd(dropped)
      } else {
        onClick?.()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Claims a citation has already been inserted for are treated as
  // resolved — dropped from underlines/hover the same way dismissedIds
  // drops a manually-dismissed one, so "fixed" claims stop flagging.
  const citedIds = new Set((widget?.claims ?? []).filter((c) => c.citation).map((c) => c.id))
  // Everything the service still considers a live claim. Used by
  // useStableUnderlines to tell "this measurement glitched" (hold the last
  // rects) apart from "this claim is gone" (drop it now).
  const trackedIds = new Set((widget?.claims ?? []).map((c) => c.id))
  // Claims in the paragraph currently lit from the Structure view. Empty in
  // every other state, so it costs nothing when the feature is unused.
  const highlightedClaimIds = new Set(
    (highlightedParagraph === null
      ? []
      : widget?.structure?.paragraphs.find((p) => p.index === highlightedParagraph)?.claimIds) ?? []
  )
  const stableUnderlines = useStableUnderlines(underlines, trackedIds)
  const isResolved = (id: string): boolean => dismissedIds.has(id) || citedIds.has(id)

  /** The problems still live on a claim, worst first. */
  const openKinds = (claimId: string, kinds: ScreenWatchProblemKind[]): ScreenWatchProblemKind[] =>
    kinds.filter((k) => !dismissedIssues.has(`${claimId}:${k}`))

  /**
   * What to show for a claim. Falls back to the worst dismissed kind rather
   * than to a default, so a mark whose problems are all dismissed keeps its own
   * colour for the moment before it disappears instead of flashing grey.
   */
  const visibleKindFor = (
    claimId: string,
    kinds: ScreenWatchProblemKind[]
  ): ScreenWatchProblemKind => openKinds(claimId, kinds)[0] ?? kinds[0] ?? 'searching'

  /**
   * Which marks are new on the screen (they draw in) and which just left (they
   * fade). Keyed on the claim's TEXT: Screen Watch mints a fresh id on every
   * detection, so by id every re-detection would look like every mark arriving
   * at once — the old entrance fade replayed exactly that way.
   */
  const claimTextById = new Map((widget?.claims ?? []).map((c) => [c.id, c.text]))
  const drawnList = useMemo<DrawnUnderline[]>(
    () =>
      stableUnderlines
        .filter((u) => !isResolved(u.id))
        .flatMap((u) => {
          const color = PROBLEM_COLOR[visibleKindFor(u.id, u.problemKinds)]
          return u.rects.map((r, i) => ({
            id: `${u.id}-${i}`,
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
            color,
            seen: { key: claimTextById.get(u.id) ?? u.id, color, x0: r.x, x1: r.x + r.width, y: r.y }
          }))
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stableUnderlines, dismissedIds, dismissedIssues, citedIds.size]
  )
  const drawnUnderlines = {
    arrivals: useMarkArrivals(drawnList),
    // A claim the service still tracks, and nobody dismissed or cited, is only
    // out of view or mid-measurement — not gone: no fade for it.
    ghosts: useMarkDepartures(drawnList, (id) => {
      const claimId = id.slice(0, id.lastIndexOf('-'))
      return trackedIds.has(claimId) && !isResolved(claimId)
    })
  }

  /**
   * Opens the widget's claims panel, in whichever mode is useful for what is
   * actually flagged. A single claim goes straight to its actions rather than
   * to a one-item list you then have to click into.
   */
  /**
   * The launcher's click: open the panel, and do NOT choose a view.
   *
   * It used to pick one — 'all' when more than one claim was flagged, 'single'
   * otherwise — and that call is why setting DEFAULT_VIEW_MODE to 'grade'
   * main-side did nothing visible. The service's default was correct on every
   * open and then overwritten by this line a moment later, so the panel always
   * landed on a claim card and the Essay Grade Widget (Figma 370:191) was
   * reachable only from the score chip.
   *
   * The mode belongs to `screenWatchService` because the panel's pixel size is
   * computed there too (hoverTracking hit-tests the same rect), and it resets
   * to the default whenever the panel collapses — so every open is a fresh one
   * and lands on the grade card, with the claims a click away behind it.
   */
  function openWidgetPanel(): void {
    void window.tracely.screenWatch.setWidgetExpanded({ expanded: true })
    // Local feedback ahead of the next hover-tracking event, which won't
    // arrive until the cursor moves — otherwise the hover popover and the
    // panel can both be on screen for a moment.
    setHover(null)
  }

  const widgetHovered = hover?.kind === 'widget'
  const claimHovered = hover?.kind === 'claim' && !isResolved(hover.claimId) ? hover : null
  // The hover event itself only carries the bare minimum needed to draw the
  // underline (id/type/text/anchor) — full detail (confidence, evidence
  // once it's resolved) lives in widget.claims, looked up by id. A fallback
  // covers the brief window where a claim was just detected and its hover
  // target exists before the next overlay-update payload has arrived.
  const claimHoveredSummary: ScreenWatchClaimSummary | null = claimHovered
    ? (widget?.claims.find((c) => c.id === claimHovered.claimId) ?? {
        id: claimHovered.claimId,
        text: claimHovered.text,
        claimType: claimHovered.claimType,
        confidence: 0,
        // Deliberately false, and unread: `problemKinds` is ['searching'] in
        // this placeholder, and no copy branch consults this field in that
        // state. It used to call a two-pattern COPY of main's citation
        // detector, which is the same duplicated-judgement mistake that had
        // the underline and the card disagreeing — and the copy had already
        // drifted, missing four of main's six patterns.
        hasInlineCitation: false,
        // Nothing is known about a claim whose payload has not arrived yet, and
        // 'searching' is the honest name for that.
        problemKinds: ['searching' as const],
        evidence: null,
        critique: null,
        critiqueVerdict: null,
        suggestedRevision: null,
        citationFix: null,
        citation: null
      })
    : null
  // Start the evidence search when the cursor settles on a claim, rather
  // than waiting for a click on "Find Evidence".
  //
  // Only the top MAX_AUTO_EVIDENCE_CLAIMS claims are pre-fetched after
  // detection (a full set costs four provider searches each, which is what
  // makes Semantic Scholar answer 429). Everything below that used to sit
  // at "no evidence yet" until the user clicked, and only then began a cold
  // four-provider search — so the wait for articles started when the user
  // asked for them instead of when they showed interest.
  //
  // The dwell delay is what keeps this honest about API cost: sweeping the
  // cursor across a paragraph must not fire a search per claim it crosses.
  // Attempts are recorded whether or not they succeed, so a failing claim
  // re-searches only via the explicit button.
  const autoSearchedIds = useRef<Set<string>>(new Set())
  const hoveredClaimId = claimHovered?.claimId ?? null
  const needsEvidence = claimHoveredSummary?.evidence == null
  useEffect(() => {
    if (!hoveredClaimId || !needsEvidence) return
    if (autoSearchedIds.current.has(hoveredClaimId)) return
    const id = window.setTimeout(() => {
      autoSearchedIds.current.add(hoveredClaimId)
      void findEvidenceFor(hoveredClaimId)
    }, HOVER_SEARCH_DWELL_MS)
    return () => window.clearTimeout(id)
    // findEvidenceFor is stable enough for this purpose — it only closes
    // over setState functions, which React guarantees are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredClaimId, needsEvidence])

  // Highlights expire. The overlay is click-through everywhere except its own
  // panel, so there is no click-outside to dismiss one with; left alone it
  // would sit over the user's document until the claim set changed.
  const panelViewMode = widget?.viewMode ?? null
  useEffect(() => {
    if (highlightedParagraph === null) return
    const id = window.setTimeout(() => setHighlightedParagraph(null), HIGHLIGHT_HOLD_MS)
    return () => window.clearTimeout(id)
  }, [highlightedParagraph])

  // Leaving the Structure view abandons the thing the highlight referred to.
  useEffect(() => {
    if (panelViewMode !== 'structure') setHighlightedParagraph(null)
  }, [panelViewMode])

  const hoveredOpenKinds = claimHoveredSummary
    ? openKinds(claimHoveredSummary.id, claimHoveredSummary.problemKinds)
    : []
  const hoveredActiveKind: ScreenWatchProblemKind =
    hoveredOpenKinds[0] ?? claimHoveredSummary?.problemKinds[0] ?? 'searching'
  const hoveredRemaining = hoveredOpenKinds.length

  // The lookup's list is the same kind of list, so it widens the same way.
  const hoveredFlowStep = claimHovered
    ? (citationFlowByClaimId.get(claimHovered.claimId)?.step ??
      citedWorkByClaimId.get(claimHovered.claimId)?.step ??
      null)
    : null
  // 320 for a glance, 380 once the card is showing a list. Measured off the
  // frames rather than "the flow is wider": "Find a Source (Searching)" is 320
  // like the inline-detection cards, because it shows two skeleton rows and a
  // sentence; only "(Results)", "Add Citation (Choose Source)" and "(Inserted)"
  // widen to 380, where real titles and a works-cited entry have to fit.
  const hoveredPopoverWidth =
    hoveredFlowStep === null || hoveredFlowStep === 'searching' ? POPOVER_WIDTH_GLANCE : POPOVER_WIDTH_FLOW
  const claimHoveredPos = claimHovered
    ? popoverPosition(claimHovered.anchor, hoveredPopoverWidth)
    : null
  const popoverRef = useRef<HTMLDivElement>(null)
  const lastReportedPopoverKey = useRef<string | null>(null)

  // Reports the popover's REAL rendered rect (measured from the DOM, not
  // POPOVER_EST_HEIGHT's guess — that constant only exists to decide
  // above-vs-below placement before anything has rendered) to main so
  // hoverTracking.ts can hit-test against it directly. Runs after every
  // render (widget updates, and every citation-flow step change, re-render
  // this whole component too, since flow state can resize the popover),
  // but only actually sends when the reported rect would change.
  useLayoutEffect(() => {
    if (claimHovered && claimHoveredPos && popoverRef.current) {
      const rect = popoverRef.current.getBoundingClientRect()
      const key = `${claimHovered.claimId}:${rect.left}:${rect.top}:${rect.width}:${rect.height}`
      if (lastReportedPopoverKey.current === key) return
      lastReportedPopoverKey.current = key
      void window.tracely.screenWatch.setActivePopoverRect({
        claimId: claimHovered.claimId,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      })
    } else if (!claimHovered && lastReportedPopoverKey.current !== null) {
      lastReportedPopoverKey.current = null
      void window.tracely.screenWatch.setActivePopoverRect({ claimId: null, rect: null })
    }
  })

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        fontFamily: FONT_STACK,
        // Native hit-testing is toggled by hoverTracking.ts. Keep the DOM's
        // transparent remainder inert as a second boundary; visible controls
        // below opt themselves back in.
        pointerEvents: 'none'
      }}
    >
      {drawnUnderlines.ghosts.map((g) => (
        <GhostUnderline key={`ghost:${g.id}`} mark={g} />
      ))}
      {stableUnderlines
        .filter((u) => !isResolved(u.id))
        .flatMap((u) => {
          // Either the cursor is over it, or the Structure view lit its
          // paragraph. Same visual treatment on purpose — from the reader's
          // side both mean "this is the one being talked about".
          const isHovered = claimHovered?.claimId === u.id || highlightedClaimIds.has(u.id)
          // The point of the whole change: the mark is coloured by what is
          // WRONG, not by what kind of sentence it is. Every factual claim in a
          // document used to be the same orange whatever state it was in.
          // Worst first, so the mark shows the most serious of the sentence's
          // problems — the same one the card opens on.
          const color = PROBLEM_COLOR[visibleKindFor(u.id, u.problemKinds)]
          return u.rects.map((r, i) => (
            <UnderlineMark
              key={`${u.id}-${i}`}
              // Rounded to whole pixels (the underlying rect arrives
              // scale-converted from physical UIA coordinates, so it's
              // rarely already an integer) — a fractional position blurs a
              // 2px line across two rows of pixels instead of one crisp one.
              x={Math.round(r.x)}
              y={Math.round(r.y)}
              width={Math.round(r.width)}
              height={Math.round(r.height)}
              claimId={u.id}
              color={color}
              title={PROBLEM_LABEL[visibleKindFor(u.id, u.problemKinds)]}
              hovered={isHovered}
              enterDelay={drawnUnderlines.arrivals.get(`${u.id}-${i}`)}
            />
          ))
        })}

      {widget && !widget.expanded
        ? (() => {
            const circlePos = dragPos ?? widget.rect
            // The badge counts UNDERLINES, which is what the launcher points
            // at. It counted sources once, so it read 8 over two marks.
            const hasInfo = widget.underlineCount > 0
            // No count yet because the first read is still running: the same
            // puck in the grey every mark uses for "still checking", with a
            // dotted ring — the extension's `.launcher .count.off`.
            const checking = !hasInfo && widget.analyzing
            // A solid black circle with the plain Tracely mark, plus a
            // small ink count badge overlapping its top-right edge once
            // there's something to show — matches the Figma "Collapsed
            // Launcher" mockup (not a colored ring around the whole circle).
            return (
              <button
                className="tracely-launcher"
                // Opens the claims panel. Pointing this at `tracer.open`
                // instead (39d238b) left the panel with no entry point at all:
                // the only other way in required `claim.critiqueVerdict`, which
                // only `critiqueClaim` sets, which is only reachable from the
                // "Check Claim" button *inside* the panel. Circular — so the
                // panel, ClaimActionCard, ClaimListItem, "Show all", the
                // per-claim Find Evidence and Check Claim actions and the
                // panel's own close button were all unreachable code.
                //
                // Tracer is still one click away, from inside the panel, where
                // "Ask Tracer" already appears in three places.
                onMouseDown={(e) => startWidgetDrag(e, { width: 56, height: 56 }, () => openWidgetPanel())}
                title="Flagged claims — click to open, drag to move"
                aria-label={`${widget.underlineCount} flagged claims — open the panel`}
                style={{
                  position: 'absolute',
                  left: circlePos.x,
                  top: circlePos.y,
                  width: 56,
                  height: 56,
                  border: 'none',
                  borderRadius: '50%',
                  padding: 0,
                  cursor: 'pointer',
                  background: INK,
                  boxShadow: widgetHovered ? '0 6px 18px rgba(0, 0, 0, 0.25)' : '0 2px 10px rgba(0, 0, 0, 0.18)',
                  transition: `box-shadow 150ms ${EASE}, transform 150ms ${EASE}`,
                  // A 3% lift, not 6%: enough to say "this is live" under the
                  // pointer without the circle jumping out of its corner.
                  // The <style> block cancels it under reduced motion.
                  transform: widgetHovered ? 'scale(1.03)' : 'scale(1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  pointerEvents: 'auto'
                }}
              >
                {/*
                  46, not 30. The asset is 899×635 with ~45% of its width as
                  transparent padding, and `objectFit: contain` in a square box
                  is width-constrained — so `size={30}` drew a mark about
                  13.5px wide inside a 56px circle, roughly 24% of the
                  diameter against a 38-45% norm for a launcher glyph. 46
                  puts it near 21px (~37%) without touching the circle, so
                  WIDGET_SIZE in screenWatchService.ts and hoverTracking.ts's
                  hit-test region stay valid.
                */}
                {/* Nudged 1px up and left: the mark's visual centre sits
                    below and right of its box, so the box's centre is not
                    the circle's. */}
                <span style={{ display: 'flex', transform: 'translate(-1px, -1px)' }}>
                  <LogoBg size={46} />
                </span>
                {hasInfo || checking ? (
                  // 22px on the 56px launcher, 4px past its top and right
                  // edges: the product's one count badge (the extension's
                  // `.launcher .count` takes the same values). Ink, because a
                  // count is not a finding — the marks carry the colour.
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      top: -4,
                      right: -4,
                      boxSizing: 'border-box',
                      minWidth: 22,
                      height: 22,
                      padding: '0 6px',
                      borderRadius: 999,
                      background: checking ? PROBLEM_COLOR.searching : INK,
                      color: PAPER,
                      fontSize: 12,
                      fontWeight: 600,
                      lineHeight: 1,
                      fontVariantNumeric: 'tabular-nums',
                      border: `2px ${checking ? 'dotted' : 'solid'} ${PAPER}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}
                  >
                    {checking ? '…' : widget.underlineCount}
                  </span>
                ) : null}
              </button>
            )
          })()
        : null}

      {widget && widget.expanded
        ? (() => {
            const panelPos = dragPos ?? widget.rect
            const visibleClaims = widget.claims.filter((c) => !isResolved(c.id))
            // Claims still on screen. A weakness whose paragraph holds only
            // dismissed or already-cited claims has nothing left to point at,
            // and its ¶ chip renders as plain text rather than a dead button.
            const liveClaimIds = new Set(visibleClaims.map((c) => c.id))
            const topClaim = visibleClaims.find((c) => c.id === selectedClaimId) ?? visibleClaims[0] ?? null

            // 'grade' and 'report' bring their own box. The frames give them a
            // 28px radius, their own header with a close button and no drag
            // title, so wrapping them in the shared panel chrome below would
            // double the border and the header. Everything else shares it.
            if (widget.viewMode === 'grade' || widget.viewMode === 'report' || widget.viewMode === 'paragraph') {
              const isReport = widget.viewMode === 'report'
              const isParagraph = widget.viewMode === 'paragraph'
              // Only the summary card has an analyzing state to be in: 'report'
              // and 'paragraph' are both reached from a reading that exists.
              const isAnalyzing = widget.viewMode === 'grade' && widget.analyzing
              // 407:359 is a different box from the two grade cards: 24px
              // radius, 25px gutter, a heavier shadow. The frame's own values.
              const scrolls = isReport || isParagraph
              // The claim the Source Finder Popover is open for, if it is still
              // one of the claims this panel is about. A claim that was cited,
              // dismissed or re-detected away while the popover sat open takes
              // the popover with it rather than leaving a card floating over a
              // report that no longer mentions it.
              const gradeFlowClaim = gradeFlowClaimId
                ? (widget.claims.find((c) => c.id === gradeFlowClaimId) ?? null)
                : null
              const gradeFlow = gradeFlowClaim ? (citationFlowByClaimId.get(gradeFlowClaim.id) ?? null) : null
              const finderRect = sourceFinderRect(
                { x: panelPos.x, y: panelPos.y, width: widget.rect.width, height: widget.rect.height }
              )
              return (
                <>
                <div
                  style={{
                    position: 'absolute',
                    left: panelPos.x,
                    top: panelPos.y,
                    width: widget.rect.width,
                    height: widget.rect.height,
                    boxSizing: 'border-box',
                    background: PAPER,
                    // `outline`, not `border`. A Figma stroke does not consume
                    // the frame's own padding box, but a CSS border does: with
                    // `border: 1px` the 560px card offers 510px of content
                    // instead of 512, and the design's two 251px pills came out
                    // at 250. An outline pulled back over the edge draws the
                    // same hairline and costs no layout.
                    outline: '1px solid #000',
                    outlineOffset: -1,
                    // The analyzing card is its own frame (391:540): 24px like
                    // the paragraph detail, not the grade card's 28.
                    borderRadius: isParagraph || isAnalyzing ? 24 : 28,
                    boxShadow: isParagraph
                      ? '0px 12px 28px -4px rgba(15, 26, 20, 0.18)'
                      : '0px 10px 28px -4px rgba(15, 26, 20, 0.14)',
                    // The report asks for the frame's full 1210px; main clamps
                    // that to the watched window, so on anything shorter the
                    // card scrolls rather than losing its foot.
                    overflowX: 'hidden',
                    overflowY: scrolls ? 'auto' : 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    // The analyzing card centres its spinner and both lines;
                    // every other card here is a left-aligned stack.
                    alignItems: isAnalyzing ? 'center' : 'flex-start',
                    justifyContent: isAnalyzing ? 'center' : 'flex-start',
                    padding: isAnalyzing ? 32 : isParagraph ? '23px 25px' : '22px 24px',
                    gap: isAnalyzing ? 16 : isParagraph ? 17 : 22,
                    pointerEvents: 'auto'
                  }}
                >
                  {isAnalyzing ? (
                    <AnalyzingCard
                      onClose={() => void window.tracely.screenWatch.setWidgetExpanded({ expanded: false })}
                    />
                  ) : isParagraph ? (
                    <ParagraphDetailPanel
                      structure={widget.structure}
                      claims={widget.claims}
                      index={detailParagraph}
                      onClose={() => void window.tracely.screenWatch.setWidgetExpanded({ expanded: false })}
                      onBack={showReport}
                      onFindForClaim={openGradeSourceFinder}
                    />
                  ) : isReport ? (
                    <EssayGradeReportPanel
                      structure={widget.structure}
                      claims={widget.claims}
                      gradingLevel={gradingLevel}
                      onClose={() => void window.tracely.screenWatch.setWidgetExpanded({ expanded: false })}
                      onBackToSummary={showGrade}
                      onArgumentCheck={showAll}
                      onOpenParagraph={showParagraph}
                      onFindForClaim={openGradeSourceFinder}
                    />
                  ) : (
                    <EssayGradePanel
                      structure={widget.structure}
                      gradingLevel={gradingLevel}
                      onClose={() => void window.tracely.screenWatch.setWidgetExpanded({ expanded: false })}
                      onFullReport={showReport}
                    />
                  )}
                </div>

                {gradeFlowClaim && gradeFlow ? (
                  <div
                    style={{
                      position: 'absolute',
                      left: finderRect.left,
                      top: finderRect.top,
                      width: finderRect.width,
                      maxHeight: finderRect.maxHeight,
                      boxSizing: 'border-box',
                      background: PAPER,
                      // This card's own chrome, not the hover popover's: no
                      // border at all and a deeper shadow, which is what lifts
                      // it off the panel it is sitting on rather than off the
                      // user's document.
                      borderRadius: SOURCE_FINDER_RADIUS,
                      boxShadow: SOURCE_FINDER_SHADOW,
                      padding: 16,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 12,
                      color: INK,
                      overflowX: 'hidden',
                      overflowY: 'auto',
                      pointerEvents: 'auto'
                    }}
                  >
                    <CitationFlowCard
                      state={gradeFlow}
                      claimText={gradeFlowClaim.text}
                      visibleClaimCount={visibleClaims.filter((c) => c.id !== gradeFlowClaim.id).length}
                      onSelectCandidate={(ref) => selectCandidate(gradeFlowClaim.id, ref)}
                      onSetStyle={(style) => setCandidateStyle(gradeFlowClaim.id, style)}
                      onSearchAgain={() => void startCitationFlow(gradeFlowClaim.id)}
                      onInsert={() => void insertCitation(gradeFlowClaim.id)}
                      onPreview={() => void previewCitation(gradeFlowClaim.id)}
                      onCancel={() => closeGradeSourceFinder(gradeFlowClaim.id)}
                      onDone={() => closeGradeSourceFinder(gradeFlowClaim.id)}
                      onEntryCopied={() => markEntryCopied(gradeFlowClaim.id)}
                      onUndo={() => void undoCitation(gradeFlowClaim.id)}
                      inserting={citationBusyIds.has(gradeFlowClaim.id)}
                      previewing={previewBusyIds.has(gradeFlowClaim.id)}
                      undoing={undoBusyIds.has(gradeFlowClaim.id)}
                      // The one caller that needs it: this popover floats over
                      // the grade panel and the cursor leaving a sentence does
                      // not close it.
                      showCancel
                    />
                  </div>
                ) : null}
                </>
              )
            }

            return (
              <div
                className="tracely-panel"
                style={{
                  position: 'absolute',
                  left: panelPos.x,
                  top: panelPos.y,
                  width: widget.rect.width,
                  height: widget.rect.height,
                  background: PAPER,
                  // The panel's own chrome, which is not the popover's: 1px
                  // rather than 2px and a tighter shadow, at the same 16px
                  // radius. It is a window you opened, not a note pinned over
                  // your document, and the design distinguishes the two.
                  border: PANEL_BORDER,
                  borderRadius: PANEL_RADIUS,
                  boxShadow: PANEL_SHADOW,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  // The design is ONE padded box, not a header bar above a
                  // padded body: the title sits in the same gutter as the
                  // content and the rule between them is inset by that gutter
                  // rather than running edge to edge.
                  padding: `${PANEL_PADDING_Y}px ${GRID_PADDING}px`,
                  gap: PANEL_GAP,
                  pointerEvents: 'auto'
                }}
              >
                <div
                  style={{
                    boxSizing: 'border-box',
                    height: PANEL_HEADER_HEIGHT,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexShrink: 0
                  }}
                >
                  {widget.viewMode !== 'single' ? (
                    <button
                      className="tracely-btn-text"
                      onClick={leavePanelView}
                      style={{ ...TEXT_BTN_STYLE, flexShrink: 0, marginLeft: -8 }}
                    >
                      <InlineIcon svg={ICON_SVG.chevronRight} flip />
                      Back
                    </button>
                  ) : null}
                  {/* Sibling of the drag region, never a child of it — that div
                      owns onMouseDown for startWidgetDrag and would swallow
                      this click through the drag-threshold path. */}
                  <ScoreChip
                    structure={widget.structure}
                    // No 'grade' arm: that mode returns its own card above, so
                    // this chrome only ever renders for the other three.
                    active={widget.viewMode === 'structure'}
                    onOpen={showGrade}
                  />
                  <div
                    onMouseDown={(e) =>
                      startWidgetDrag(e, { width: widget.rect.width, height: widget.rect.height })
                    }
                    title="Drag to move"
                    style={{
                      alignSelf: 'stretch',
                      minWidth: 0,
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      paddingLeft: widget.viewMode === 'all' ? 2 : 4,
                      cursor: 'grab'
                    }}
                  >
                    {/* The same title in every mode, which is what the design
                        does: the base frame, the two result frames and the
                        "Show All Result" frame all say "4 claims flagged". It
                        used to read "Argument check" in single mode and render
                        nothing at all in the others. Counted from the visible
                        claims rather than widget.claimCount so it agrees with
                        the "Show all (N)" pill directly below it. */}
                    <div
                      style={{
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        // 16px semibold: the panel and dialog title size
                        // everywhere in the product. The header is the only
                        // place the panel names itself.
                        fontSize: 16,
                        fontWeight: 600,
                        letterSpacing: '-0.01em',
                        lineHeight: 1.3,
                        color: W_INK,
                        fontVariantNumeric: 'tabular-nums'
                      }}
                    >
                      {visibleClaims.length} claim{visibleClaims.length === 1 ? '' : 's'} flagged
                    </div>
                    {/* Neutral, so the number carries the meaning — the
                        app's own count chip, not a finding colour. */}
                    <div style={{ ...CHIP_STYLE, flexShrink: 0 }}>{widget.totalInfoCount} found</div>
                  </div>
                  <button
                    className="tracely-icon-btn"
                    onClick={toggleWidgetExpanded}
                    title="Close"
                    aria-label="Close"
                    style={{ ...ICON_BTN_STYLE, color: W_INK }}
                    dangerouslySetInnerHTML={{ __html: ICON_SVG.close }}
                  />
                </div>

                <div style={{ height: 1, background: W_DIVIDER, flexShrink: 0 }} />

                <div
                  style={{
                    boxSizing: 'border-box',
                    flex: 1,
                    minHeight: 0,
                    overflowX: 'hidden',
                    // 'structure' scrolls for the same reason 'single' does:
                    // its content length is not what the panel was sized from
                    // (paragraph count is unbounded and the height caps out).
                    overflowY: widget.viewMode === 'all' ? 'hidden' : 'auto'
                  }}
                >
                  {/* Checked before the empty state: a draft can have a
                      structural reading and no flagged claims at all (that is
                      what a well-sourced draft looks like), and opening the
                      score chip only to be told "no claims flagged" would be
                      answering a question nobody asked. */}
                  {widget.viewMode === 'structure' ? (
                    // No `&& widget.structure` guard any more. Falling through to
                    // the claims list when there was no reading is how opening the
                    // score chip could land you somewhere unrelated to what you
                    // clicked; the panel now answers the question you asked, even
                    // when the answer is "there isn't a reading yet".
                    widget.structure ? (
                      <ArgumentScoreView
                        structure={widget.structure}
                        liveClaimIds={liveClaimIds}
                        onHighlightParagraph={highlightParagraph}
                      />
                    ) : (
                      <NoReadingView />
                    )
                  ) : visibleClaims.length === 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginTop: 24 }}>
                      <div style={{ fontSize: 13, color: DIM, textAlign: 'center' }}>No claims flagged yet.</div>
                    </div>
                  ) : widget.viewMode === 'single' && topClaim ? (
                    // The design's card IS the panel body: the same 16px stack
                    // the panel itself uses, so the card contributes rows to it
                    // rather than nesting a second box inside it.
                    <div style={{ display: 'flex', flexDirection: 'column', gap: PANEL_GAP, minHeight: '100%' }}>
                      <WidgetClaimCard
                        claim={topClaim}
                        body={panelBodyFor(topClaim)}
                        evidenceBusy={busyEvidenceIds.has(topClaim.id)}
                        critiqueBusy={busyCritiqueIds.has(topClaim.id)}
                        freshlyRefreshed={freshEvidenceIds.has(topClaim.id)}
                        newArticleKeys={refreshBaselineByClaim.get(topClaim.id) ?? null}
                        showAllCount={visibleClaims.length}
                        onRefreshEvidence={() => void findEvidenceFor(topClaim.id)}
                        onCritique={() => void critiqueFor(topClaim.id)}
                        onShowAll={showAll}
                      />
                      {actionError ? <div style={{ fontSize: 12, color: '#d6301a' }}>{actionError}</div> : null}
                    </div>
                  ) : (
                    // A single vertical column, not a grid — sized per-claim-
                    // count server-side (computeAllPanelSize); overflowY is a
                    // safety fallback only for the rare case that caps out.
                    <div style={{ display: 'flex', flexDirection: 'column', gap: GRID_GAP, height: '100%', overflowY: 'auto' }}>
                      {visibleClaims.map((c) => (
                        <ClaimListItem key={c.id} claim={c} onClick={() => selectClaim(c.id)} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })()
        : null}

      {claimHovered && claimHoveredSummary
        ? (() => {
            const pos = popoverPosition(claimHovered.anchor, hoveredPopoverWidth)
            const flow = citationFlowByClaimId.get(claimHoveredSummary.id) ?? null
            const visibleCount = (widget?.claims ?? []).filter((c) => !isResolved(c.id) && c.id !== claimHoveredSummary.id).length
            const pointing = pos.top !== undefined ? 'up' : 'down'
            // Over the middle of the hovered rect, then clamped inside the
            // card's rounded corners. In the design the tail sits under the
            // flagged words, not centred on the card — two of the three inline
            // frames have it centred only because the sentence happens to be.
            const anchorCentre = claimHovered.anchor.x + claimHovered.anchor.width / 2
            const tailLeft = Math.max(
              CARD_RADIUS - TAIL_WIDTH / 2,
              Math.min(anchorCentre - pos.left - TAIL_WIDTH / 2, pos.width - CARD_RADIUS - TAIL_WIDTH / 2)
            )
            return (
              <div
                ref={popoverRef}
                className="tracely-popover"
                data-above={pointing === 'down' ? 'true' : undefined}
                style={{
                  position: 'absolute',
                  left: pos.left,
                  // One or the other, never both — placing above anchors the
                  // bottom edge so the card grows upward from the underline.
                  ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
                  width: pos.width,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  pointerEvents: 'auto'
                }}
              >
                {pointing === 'up' ? <PopoverTail left={tailLeft} pointing="up" /> : null}
                <div
                  style={{
                    width: '100%',
                    // The tail is drawn outside this box, so its own height
                    // comes out of the room the card has to grow into.
                    maxHeight: Math.max(1, pos.maxHeight - TAIL_HEIGHT),
                    background: PAPER,
                    border: CARD_BORDER,
                    borderRadius: CARD_RADIUS,
                    boxShadow: CARD_SHADOW,
                    padding: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    // 12, not 10 — the design's card rhythm. Small, but every
                    // stacked block in the card inherits it.
                    gap: 12,
                    color: INK,
                    overflowX: 'hidden',
                    overflowY: 'auto'
                  }}
                >
                {flow ? (
                  <CitationFlowCard
                    state={flow}
                    mode={flowModeByClaimId.get(claimHoveredSummary.id) ?? 'insert'}
                    copied={flowCopiedByClaimId.get(claimHoveredSummary.id) ?? null}
                    onCopy={(which) => void copyFlowCitation(claimHoveredSummary.id, which)}
                    claimText={claimHoveredSummary.text}
                    visibleClaimCount={visibleCount}
                    onSelectCandidate={(ref) => {
                      selectCandidate(claimHoveredSummary.id, ref)
                      setFlowCopiedByClaimId((prev) => new Map(prev).set(claimHoveredSummary.id, null))
                    }}
                    onSetStyle={(style) => {
                      setCandidateStyle(claimHoveredSummary.id, style)
                      setFlowCopiedByClaimId((prev) => new Map(prev).set(claimHoveredSummary.id, null))
                    }}
                    onSearchAgain={() => void startCitationFlow(claimHoveredSummary.id)}
                    onInsert={() => void insertCitation(claimHoveredSummary.id)}
                    onPreview={() => void previewCitation(claimHoveredSummary.id)}
                    onCancel={() => setFlow(claimHoveredSummary.id, null)}
                    onDone={() => setFlow(claimHoveredSummary.id, null)}
                    onEntryCopied={() => markEntryCopied(claimHoveredSummary.id)}
                    onUndo={() => void undoCitation(claimHoveredSummary.id)}
                    inserting={citationBusyIds.has(claimHoveredSummary.id)}
                    previewing={previewBusyIds.has(claimHoveredSummary.id)}
                    undoing={undoBusyIds.has(claimHoveredSummary.id)}
                    showCancel={false}
                  />
                ) : citedWorkByClaimId.has(claimHoveredSummary.id) ? (
                  <CitedWorkCard
                    state={citedWorkByClaimId.get(claimHoveredSummary.id) as OverlayCitedWorkState}
                    color={PROBLEM_COLOR[hoveredActiveKind]}
                    onSelect={(ref) =>
                      updateCitedWork(claimHoveredSummary.id, (s) => ({ ...s, selectedRef: ref, copied: null }))
                    }
                    onSetStyle={(style) =>
                      updateCitedWork(claimHoveredSummary.id, (s) => ({ ...s, style, copied: null }))
                    }
                    onCopy={(which) => void copyCitedWork(claimHoveredSummary.id, which)}
                    // The topical search — in copy mode, because the card was
                    // about the citation already in the sentence and this
                    // window cannot replace it.
                    onFindSource={() => void startCitationFlow(claimHoveredSummary.id, 'copy')}
                    onRetry={() => void startCitedWork(claimHoveredSummary.id)}
                    onCancel={() => setCitedWork(claimHoveredSummary.id, null)}
                  />
                ) : fixOpenIds.has(claimHoveredSummary.id) ? (
                  <FixCard
                    claim={claimHoveredSummary}
                    kind={hoveredActiveKind}
                    fallbackDetail={
                      popoverCopyFor(
                        claimHoveredSummary,
                        claimHoveredSummary.evidence as ScreenWatchClaimEvidence,
                        hoveredActiveKind as Exclude<ScreenWatchProblemKind, 'searching'>
                      ).description
                    }
                    onBack={() => closeFix(claimHoveredSummary.id)}
                  />
                ) : (
                  <ProblemCard
                    claim={claimHoveredSummary}
                    onSuggestFix={() => openFix(claimHoveredSummary.id)}
                    onStartCitationFlow={(mode) => void startCitationFlow(claimHoveredSummary.id, mode)}
                    onFindCitedWork={() => void startCitedWork(claimHoveredSummary.id)}
                    activeKind={hoveredActiveKind}
                    remaining={hoveredRemaining}
                    onDismiss={() =>
                      dismissIssue(claimHoveredSummary.id, hoveredActiveKind, hoveredRemaining)
                    }
                  />
                )}
                </div>
                {pointing === 'down' ? <PopoverTail left={tailLeft} pointing="down" /> : null}
              </div>
            )
          })()
        : null}

      {/* This window has no shared stylesheet (see overlay.html — kept
          minimal on purpose for a transparent always-on-top window), so
          hover/press states and the entrance animation live in a small
          scoped style block instead of index.css. */}
      <style>{`
        /* Every panel/card size in this file is computed to line up exactly
           with sizes computed server-side (computeAllPanelSize etc.), which
           assume border-box — content-box (the CSS default) silently adds
           padding/border on top of an explicit width/height and was the
           actual cause of content clipping against the panel edge. */
        *, *::before, *::after {
          box-sizing: border-box;
        }
        /* The card grows out of its sentence: down from it when it sits
           below, up from it when it sits above (shared/markMotion.ts
           popoverInKeyframes — the editor's card does the same). */
        @keyframes tracely-popover-in {
          from { opacity: 0; transform: translateY(-6px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes tracely-popover-in-above {
          from { opacity: 0; transform: translateY(6px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .tracely-popover {
          animation: tracely-popover-in 0.16s cubic-bezier(0.22, 1, 0.36, 1);
        }
        .tracely-popover[data-above='true'] {
          animation-name: tracely-popover-in-above;
        }
        /* A mark that just left (GhostUnderline). forwards is safe: if this
           never runs, the ghost is removed by its timer at full strength,
           which is what the old blink-off looked like. */
        @keyframes tracely-underline-out {
          to { opacity: 0; }
        }
        .tracely-underline-out {
          animation: tracely-underline-out 0.18s ease-out forwards;
        }
        /* .tracely-underline's entrance is the draw-in (useDrawIn), only
           for a mark new on the screen and cancelled by a timer: this window
           is never focused and always sits above another app, exactly where
           Chromium stops advancing animations, so the degraded case must be
           "appears instantly", never "never appears". */
        /* A <button> does not inherit the document font; every label around
           it draws in Instrument Sans, so the controls do too. */
        button { font-family: inherit; }
        /* The one button recipe. The fill lives here rather than inline so
           hover and press can change it; everything else is in the
           *_BTN_STYLE objects. Press darkens, never shrinks. */
        .tracely-btn-primary {
          background: ${INK};
          transition: background 150ms ${EASE}, opacity 150ms ${EASE};
        }
        .tracely-btn-primary:hover:not(:disabled),
        .tracely-btn-primary:active:not(:disabled) {
          background: #000;
        }
        .tracely-btn-secondary {
          background: ${PAPER};
          transition: background 150ms ${EASE}, border-color 150ms ${EASE}, opacity 150ms ${EASE};
        }
        .tracely-btn-secondary:hover:not(:disabled) {
          background: ${HOVER_WASH};
        }
        .tracely-btn-secondary:active:not(:disabled) {
          background: ${PRESSED_WASH};
        }
        .tracely-btn-primary:disabled,
        .tracely-btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .tracely-btn-text {
          background: transparent;
          color: ${MUTED};
          border-radius: 6px;
          transition: color 150ms ${EASE}, background 150ms ${EASE};
        }
        .tracely-btn-text:hover {
          color: ${INK};
          background: ${HOVER_WASH};
        }
        .tracely-btn-text:active {
          background: ${PRESSED_WASH};
        }
        .tracely-icon-btn {
          background: transparent;
          transition: background 150ms ${EASE}, color 150ms ${EASE};
        }
        .tracely-icon-btn:hover {
          background: ${CHIP_BG};
        }
        .tracely-icon-btn:active {
          background: ${PRESSED_WASH};
        }
        .tracely-icon-btn svg {
          display: block;
        }
        .tracely-pill {
          transition: background 150ms ${EASE}, color 150ms ${EASE}, border-color 150ms ${EASE};
        }
        .tracely-pill:hover {
          background: ${HOVER_WASH};
        }
        .tracely-list-row {
          border-color: ${W_DIVIDER};
          background: ${PAPER};
          transition: border-color 150ms ${EASE}, box-shadow 150ms ${EASE}, background 150ms ${EASE};
        }
        .tracely-list-row:hover {
          border-color: ${SECONDARY_EDGE};
          box-shadow: 0 2px 10px rgba(15, 15, 20, 0.06);
        }
        .tracely-list-row:active {
          background: ${HOVER_WASH};
        }
        .tracely-row-btn {
          background: transparent;
          transition: background 150ms ${EASE};
        }
        .tracely-style-pill {
          background: ${CHIP_BG};
          color: ${MUTED};
          transition: background 150ms ${EASE}, color 150ms ${EASE};
        }
        .tracely-style-pill:hover {
          color: ${INK};
        }
        .tracely-style-pill[aria-pressed='true'] {
          background: ${INK};
          color: ${PAPER};
        }
        .tracely-row-btn:hover {
          background: ${HOVER_WASH};
        }
        /* One focus ring per surface: 2px ink, offset 2 — the finding
           surfaces' ring (the editor's popover and the extension draw the
           same one). */
        .tracely-btn-primary:focus-visible,
        .tracely-btn-secondary:focus-visible,
        .tracely-btn-text:focus-visible,
        .tracely-icon-btn:focus-visible,
        .tracely-pill:focus-visible,
        .tracely-list-row:focus-visible,
        .tracely-row-btn:focus-visible,
        .tracely-style-pill:focus-visible,
        .tracely-launcher:focus-visible {
          outline: 2px solid ${INK};
          outline-offset: 2px;
        }
        .tracely-launcher {
          transition: box-shadow 150ms ${EASE}, transform 150ms ${EASE};
        }
        /* The panel grows out of its corner the way the popover grows out of
           its sentence: 160ms in. */
        @keyframes tracely-panel-in {
          from { opacity: 0; transform: translateY(6px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .tracely-panel {
          animation: tracely-panel-in 0.16s ${EASE};
        }
        @keyframes tracely-spin {
          to { transform: rotate(360deg); }
        }
        .tracely-spinner {
          display: inline-block;
          width: 10px;
          height: 10px;
          border: 1.5px solid ${HAIRLINE};
          /* Ink, not orange: progress is not a finding. */
          border-top-color: ${INK};
          border-radius: 50%;
          animation: tracely-spin 0.7s linear infinite;
        }
        /* The analyzing card's 56px ring. transform-only, so it composites
           rather than laying out — same reason UnderlineMark moves by
           transform, and the same caveat: this window is never focused, so if
           Chromium throttles the animation the degraded state is a ring that
           sits still, not one that disappears. */
        .tracely-ring {
          transform-origin: 50% 50%;
          animation: tracely-spin 1s linear infinite;
        }
        .tracely-progress-track {
          height: 6px;
          border-radius: 999px;
          background: ${HAIRLINE};
          overflow: hidden;
          width: 100%;
        }
        .tracely-progress-fill {
          height: 100%;
          width: 40%;
          border-radius: 999px;
          background: ${INK};
          animation: tracely-progress 1.1s ease-in-out infinite;
        }
        @keyframes tracely-progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
        @keyframes tracely-skeleton-pulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
        /* Two greys, not one at two opacities: the design's second bar is a
           genuinely lighter fill, which is what makes a skeleton row read as a
           title over a subtitle rather than as one block. */
        .tracely-skeleton {
          background: #ebebeb;
          animation: tracely-skeleton-pulse 1.1s ease-in-out infinite;
        }
        .tracely-skeleton-faint {
          background: #f4f4f4;
          animation: tracely-skeleton-pulse 1.1s ease-in-out infinite;
        }
        /* The one reduced-motion block for this surface: nothing moves.
           Entrances land at their end state, the ghost mark simply leaves,
           spinners and skeletons hold still, and the launcher does not grow
           under the pointer. (useDrawIn and useMarkDepartures check
           reducedMotion() themselves for the Web Animations they run.) */
        @media (prefers-reduced-motion: reduce) {
          .tracely-popover,
          .tracely-panel,
          .tracely-underline-out,
          .tracely-progress-fill,
          .tracely-skeleton,
          .tracely-skeleton-faint,
          .tracely-ring,
          .tracely-spinner {
            animation: none !important;
          }
          .tracely-underline-out {
            opacity: 0;
          }
          .tracely-launcher,
          .tracely-launcher:hover {
            transform: none !important;
            transition: none !important;
          }
          .tracely-btn-primary,
          .tracely-btn-secondary,
          .tracely-btn-text,
          .tracely-icon-btn,
          .tracely-pill,
          .tracely-list-row,
          .tracely-row-btn,
          .tracely-style-pill {
            transition: none !important;
          }
        }
      `}</style>
    </div>
  )
}
