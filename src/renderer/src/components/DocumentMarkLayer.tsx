import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { maxCardHeight, placePopover } from '@shared/popoverPlacement'
// The mark's own look and motion, shared with the Screen Watch overlay so the
// two surfaces cannot drift into drawing the same problem differently.
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
  hasJumped
} from '@shared/markMotion'
import type { ProseIssue } from '@shared/proseIssues'
import { useDrawIn, useMarkArrivals, useMarkDepartures, usePopoverEntrance, type MarkItem } from './markArrivals'
import type { CitationStyle } from '@shared/types'
import type { DocumentMark, MarkRect, PendingMark, ProseMark } from './documentMarks'
import MarkdownText from './MarkdownText'
import { PROBLEM_COLOR, PROBLEM_LABEL, popoverCopyFor } from './problemCopy'
import { popoverRoute } from '@shared/citationAction'
import type { EntryOutcome } from '@shared/citedWork'
import SourceIconBox from './SourceIconBox'
import { useFavicons } from '../lib/useFavicons'
import { critiqueIssues } from '../critiqueIssues'
// Shared with the overlay, which draws the same card over other applications.
import {
  APPLIED_BODY,
  APPLIED_TITLE,
  CITATION_FIX_LABEL,
  NO_REVISION_BODY,
  REVISION_LABEL,
  REVISION_RULE,
  fixTitle
} from './fixFlowCopy'
// The flow's wording is shared with the Screen Watch overlay, which draws the
// same four frames over other applications — see citationFlowCopy.ts.
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
  CITATION_REPLACED_TITLE,
  CITATION_STYLE_LABEL,
  CITED_WORK_EMPTY_TITLE,
  CITED_WORK_RESULTS_BODY,
  CITED_WORK_SEARCHING_TITLE,
  CITED_WORK_UNREACHABLE,
  FIND_DIFFERENT_SOURCE,
  WORKS_CITED_FAILED_NOTE,
  citationReplacedBody,
  citedWorkEmptyBody,
  citedWorkMeta,
  citedWorkResultsTitle,
  citedWorkSearchingBody,
  emptyResultsBody,
  entryOutcomeLabel,
  willReplaceLabel,
  flagsLeft,
  insertedBody,
  resultsTitle,
  readOnlyTitle,
  searchingBody,
  worksCitedLabel
} from './citationFlowCopy'
import { CITED_HEADING, UNCHECKABLE_SHAPE_NOTE, describeCitedWork } from '@shared/citedComparison'
import type {
  CitationFindCitedWorkResponse,
  CitedWorkCandidate,
  ResolvedCitedWork
} from '@shared/ipc-contract'
import type { Credibility } from '@shared/sourceCredibility'
import { groupByReceipt, mayInsert, type ReceiptsState, type SourceReceipt } from '@shared/sourceReceipts'
import type { WorksCitedResult } from './documentMarks'

/**
 * The underlines drawn over the document editor, and the popover that opens on
 * hover.
 *
 * Matches the Figma "Overlay Mockup — Inline Detection" frames: a 2px mark
 * under the sentence in the colour of what is wrong with it, and on hover a
 * bordered white card with a matching dot, one sentence of diagnosis, and a
 * primary action beside Dismiss.
 *
 * Nothing in here is focusable or clickable except the popover itself. The
 * layer sits over a contentEditable the user is typing in, so `pointer-events`
 * is off everywhere it would otherwise swallow a click into the text —
 * hovering is detected by hit-testing the measured rects against the mouse
 * position in the parent, not by putting elements under the cursor.
 */

// Two widths, because the design uses two. The inline-detection card is 320 — a
// glance over the sentence, sized to be read without moving your eyes far. The
// citation flow is 380, because a list of candidate sources with titles, venues
// and match percentages does not fit in 320. The same pair the overlay uses.
const POPOVER_WIDTH = 320
const POPOVER_WIDTH_FLOW = 380
const POPOVER_GAP = 10
const TAIL_WIDTH = 16
const TAIL_HEIGHT = 10
/**
 * What the tail actually adds to the popover's height.
 *
 * It overlaps the card's 2px border so the strokes meet (see CLAUDE.md), so it
 * is not TAIL_HEIGHT of extra box — and the card's cap has to know, because the
 * cap is measured from where the POPOVER starts while `maxHeight` bounds the
 * CARD below it. Eight pixels of card hanging past the editor is exactly what
 * this was, measured in the harness.
 */
const TAIL_NET_HEIGHT = TAIL_HEIGHT - 2

/** Skeleton bar widths, from the design — the uneven pair is what makes a
 *  loading row read as two lines of a citation rather than a progress widget. */
const SKELETON_ROWS: Array<[number, number]> = [
  [214, 122],
  [186, 96]
]

const CITATION_STYLES: CitationStyle[] = ['MLA', 'APA', 'Chicago']

/** Both halves of a formatted citation: the marker, and the bibliography line. */
export interface DocCitation {
  inTextCitation: string
  worksCitedEntry: string
}

/** One row of "Find a Source (Results)" — flattened from an `EvidenceItem`. */
export interface DocSourceCandidate {
  sourceId: string
  title: string
  venue: string | null
  year: number | null
  /** `relevanceScore` as a percentage — how directly it bears on the sentence. */
  matchPercent: number
  /** The monogram tile's letters, shown until a favicon resolves and for good
   *  on a publisher with no icon. */
  initials: string
  /**
   * The publisher's site, for the icon lookup.
   *
   * These rows drew the monogram forever — not because academic sources have no
   * site, which the comment here used to claim, but because nothing on the
   * persisted `Source` carried an icon and the renderer could not fetch one
   * without loosening index.html's CSP. Main fetches it now and hands over a
   * data: URI (see ipc/sourcesHandlers.ts), which that CSP already allows.
   */
  url: string | null
  /**
   * The source's OWN page, for a row's Open button — not `url`, which is the
   * publisher's site for the icon (a doi.org link has the DOI logo).
   */
  pageUrl: string | null
  /**
   * Whether a marker would accept this, decided locally — see
   * shared/sourceCredibility.ts. Drives the chip on the row and the order.
   */
  credibility: Credibility
}

export type DocCitationFlowState =
  | { step: 'searching' }
  | {
      step: 'picking'
      candidates: DocSourceCandidate[]
      selectedId: string | null
      /**
       * What each source SAYS — shared/sourceReceipts.ts. Asked for the moment
       * the list arrives (opening it is the click that pays for it): while it
       * is `checking` the card says so and nothing can be inserted; once
       * `checked`, only a source quoted backing the sentence can be; when
       * `unavailable`, the list is the one from before receipts, under a line
       * saying nothing was checked.
       */
      receipts: ReceiptsState
      style: CitationStyle
      /**
       * What "Insert citation" would write, once Preview has been pressed.
       * Cleared by every change to the selection or the style, so a block left
       * standing can never describe something other than what Insert will do.
       */
      preview: DocCitation | null
    }
  | {
      step: 'inserted'
      citation: DocCitation
      style: CitationStyle
      /**
       * What actually happened to the document's works-cited list. Replaced the
       * old `showWorksCited` toggle, which was the whole bug: the card said
       * "ADDED TO WORKS CITED" and the button it offered only folded that grey
       * block away and back, so the one thing the label asserted was the one
       * thing nothing did.
       */
      worksCited: WorksCitedResult
    }
  | { step: 'error'; message: string }

/**
 * The citation flow for one claim, owned by AnalyzeView.
 *
 * State and handlers arrive together as one object rather than as a dozen
 * props, and the state lives above this component because the popover unmounts
 * the moment the pointer leaves the sentence — a flow that lived here would be
 * destroyed by the first mouse movement after pressing "Add citation".
 */
export interface DocCitationFlow {
  claimId: string
  state: DocCitationFlowState
  /**
   * Opened to LOOK at the sources rather than to cite one.
   *
   * Set when the popover's action was "Compare sources" or "Review the
   * sources" — see shared/citationAction.ts. The list renders identically; the
   * style pills, Preview and Insert do not, because the card that opened this
   * has either just said the writer already cited the claim or that these
   * sources do not confirm it.
   */
  readOnly: boolean
  /**
   * The work the sentence ALREADY cites — the left half of a comparison.
   *
   * Only fetched for a read-only flow, which is the one opened by "Compare
   * sources" and "Review the sources". An "Add citation" card is about a
   * sentence with nothing to compare against.
   */
  cited: ResolvedCitedWork | null
  citedLoading: boolean
  inserting: boolean
  previewing: boolean
  undoing: boolean
  /** Flags left on OTHER sentences — the confirmation's "N flags left" line. */
  flagsRemaining: number
  onSelect: (sourceId: string) => void
  onSetStyle: (style: CitationStyle) => void
  onSearchAgain: () => void
  onPreview: () => void
  /**
   * The defective citation this flow would REPLACE, exactly as typed.
   *
   * Null for an ordinary insert. When set, the primary button swaps that text
   * for the new citation rather than appending a second one beside it.
   */
  replaces: string | null
  /** Opens the selected source's page in the writer's browser. */
  onOpenArticle: () => void
  /** The same, for a URL the card holds rather than a selected candidate. */
  onOpenUrl: (url: string) => void
  onInsert: () => void
  onCancel: () => void
  onDone: () => void
  /** Scrolls the editor to the reference list. */
  onViewWorksCited: () => void
  onUndo: () => void
}

/**
 * The "Suggest fix" card's state, owned by AnalyzeView for the same reason
 * `DocCitationFlow` is: the popover unmounts the instant the pointer leaves the
 * sentence, so anything that survives a button press has to live above it.
 *
 * Two steps only. There is no searching step and no relay call — everything the
 * card shows was already written onto the claim by the critique that produced
 * the underline, so opening it costs nothing and cannot bill the user.
 */
export type DocFixState =
  | { step: 'open' }
  | { step: 'applied' }
  | { step: 'error'; message: string }

export interface DocFixFlow {
  claimId: string
  state: DocFixState
  applying: boolean
  undoing: boolean
  onApply: () => void
  onUndo: () => void
  onCancel: () => void
  onDone: () => void
}

/**
 * "Find the cited work", run in the popover. Owned by AnalyzeView for the
 * reason every flow here is: the card unmounts when the pointer leaves the
 * sentence, and this one has a Replace button on it.
 *
 * Free — Crossref and Open Library through `citation:findCitedWork` — and only
 * ever started by the button. Nothing it shows is a verdict: a record is "the
 * work you cited", an empty list is a fact about two indexes.
 */
export type DocCitedWorkState =
  | { step: 'searching' }
  | {
      step: 'results'
      response: CitationFindCitedWorkResponse
      selectedRef: string | null
      style: CitationStyle
    }
  | {
      step: 'replaced'
      candidate: CitedWorkCandidate
      style: CitationStyle
      /** The reference entry as written into the list. */
      entry: string
      /** What happened to the reference list — see entryOutcomeLabel. */
      outcome: EntryOutcome | 'failed'
    }
  | { step: 'error'; title: string; message: string }

export interface DocCitedWorkFlow {
  claimId: string
  /** The citation being looked up and replaced, exactly as the writer typed it. */
  citation: string
  state: DocCitedWorkState
  replacing: boolean
  undoing: boolean
  onSelect: (ref: string) => void
  onSetStyle: (style: CitationStyle) => void
  onReplace: () => void
  /** The record's own page, in the writer's browser. */
  onOpenRecord: (url: string) => void
  /** The topical search — whose pick REPLACES the citation, never sits beside it. */
  onFindSource: () => void
  onRetry: () => void
  onUndo: () => void
  onDone: () => void
  onCancel: () => void
  onViewWorksCited: () => void
}

export interface DocumentMarkLayerProps {
  marks: DocumentMark[]
  /** The claim the pointer is over, or the one whose popover is pinned open. */
  active: { mark: DocumentMark; rect: MarkRect } | null
  /** The claim under the pointer while its card is still waiting to open
   *  (shared/hoverIntent.ts): its mark lights up at once, the card follows. */
  preview?: string | null
  /** Width of the scroll container, so the popover can be kept inside it. */
  wrapWidth: number
  /**
   * Visible height of the scroll container, and how far it is scrolled, as of
   * the hover that opened the popover. Together they say where the visible box
   * sits in the content coordinates `rect` and the card are positioned in —
   * which is what decides whether the card fits below the sentence.
   */
  wrapHeight: number
  wrapScrollTop: number
  /**
   * The citation flow, when one is open for the active mark's claim. Null on
   * every other mark, so the card falls back to the problem statement.
   */
  flow: DocCitationFlow | null
  /** The fix card, when one is open for the active mark's claim. */
  fix: DocFixFlow | null
  /** "Find the cited work", when it is open for the active mark's claim. */
  citedWork: DocCitedWorkFlow | null
  /** `readOnly` when the card was opened to look rather than to cite. */
  onFindSource: (mark: DocumentMark, readOnly: boolean) => void
  onSuggestFix: (mark: DocumentMark) => void
  onFindCitedWork: (mark: DocumentMark) => void
  /** Opens Tracer with a question about this sentence's paragraph, unsent. */
  onAskTracer: (mark: DocumentMark) => void
  onDismiss: (mark: DocumentMark) => void
  /** Keeps the popover open while the pointer is inside it. */
  onPopoverEnter: () => void
  onPopoverLeave: () => void
}

/**
 * The prose layer — grammar, mechanics and wordiness.
 *
 * Drawn UNDER the claim marks and in its own colours, and the separation is the
 * point. This app's three underline colours say something specific about
 * credibility, and a repeated word is not a claim about whether a sentence is
 * true. A writer who sees the same orange under "70% of teenagers" and under
 * "the the" learns that the colours mean nothing.
 *
 * Two treatments, matching the two severities. An `error` has one right answer
 * and gets a solid line; a `style` note is a suggestion the writer may refuse
 * and gets a dotted one. Flattening them would make "very" as loud as "they
 * was", which is how people learn to switch a grammar checker off.
 *
 * The message is a native `title`. A hover card like the claim popover would be
 * better and is not built here: the claim card carries a whole citation flow,
 * and borrowing it to say "a/an" would be more machinery than the message
 * needs. The tooltip is honest about what it is.
 */
export const PROSE_ERROR = '#2563eb'
export const PROSE_STYLE = '#9aa1ad'

/**
 * The claims Tracely has found and is checking right now.
 *
 * No colour choice and no hover: this says "working on it", and the instant it
 * knows anything a real mark replaces it. `data-claim-id` is here for the same
 * reason every other mark carries one — these layers render no text, so this is
 * the only way to read them when inspecting or preview-testing.
 *
 * `MarkRect` is positioned in content coordinates, so the layer is sized to the
 * wrap exactly like the two above it.
 */
export function PendingMarkLayer({
  marks,
  wrapWidth,
  wrapHeight
}: {
  marks: PendingMark[]
  wrapWidth: number
  wrapHeight: number
}): JSX.Element {
  return (
    <div
      className="docmark-layer docpending-layer"
      style={{ width: wrapWidth, height: wrapHeight }}
    >
      {marks.map((mark) =>
        mark.rects.map((rect, i) => (
          <span
            key={`${mark.claimId}-${i}`}
            className="docpending"
            data-claim-id={mark.claimId}
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height
            }}
          />
        ))
      )}
    </div>
  )
}

export function ProseMarkLayer({
  marks,
  active,
  preview = null,
  fix,
  onApply,
  onDismiss,
  onPopoverEnter,
  onPopoverLeave,
  wrapWidth,
  wrapHeight,
  wrapScrollTop
}: {
  marks: ProseMark[]
  /** The issue the pointer is over, hit-tested in AnalyzeView. */
  active: { mark: ProseMark; rect: MarkRect } | null
  /** The issue under the pointer while its card is still waiting to open
   *  (shared/hoverIntent.ts): it lights up at once, the card follows. */
  preview?: ProseIssue | null
  fix: DocProseFix | null
  onApply: (mark: ProseMark) => void
  onDismiss: (mark: ProseMark) => void
  onPopoverEnter: () => void
  onPopoverLeave: () => void
  wrapWidth: number
  wrapHeight: number
  wrapScrollTop: number
}): JSX.Element {
  const drawn = useMemo<DrawnMark[]>(
    () =>
      marks.flatMap((mark) =>
        mark.rects.map((rect, i) => {
          const color = mark.issue.severity === 'error' ? PROSE_ERROR : PROSE_STYLE
          return {
            id: `${mark.issue.kind}-${mark.issue.start}-${i}`,
            rect,
            color,
            dotted: mark.issue.severity === 'style',
            // Offsets move with every keystroke before the issue; its words do not.
            seen: { key: `${mark.issue.kind}:${mark.issue.text}`, color, x0: rect.left, x1: rect.left + rect.width, y: rect.top }
          }
        })
      ),
    [marks]
  )
  const arrivals = useMarkArrivals(drawn)
  const ghosts = useMarkDepartures(drawn)
  return (
    <>
    <div className="docmark-layer docprose-layer">
      {marks.map((mark) =>
        mark.rects.map((rect, i) => (
          <SpanMark
            key={`${mark.issue.kind}-${mark.issue.start}-${i}`}
            rect={rect}
            color={mark.issue.severity === 'error' ? PROSE_ERROR : PROSE_STYLE}
            hovered={isSameIssue(active?.mark.issue, mark.issue) || isSameIssue(preview ?? undefined, mark.issue)}
            className={`docprose docprose-${mark.issue.severity}`}
            data={{ 'data-prose-kind': mark.issue.kind }}
            dotted={mark.issue.severity === 'style'}
            enterDelay={arrivals.get(`${mark.issue.kind}-${mark.issue.start}-${i}`)}
          />
        ))
      )}
      {ghosts.map((g) => (
        <GhostMark key={`ghost:${g.id}`} mark={g} />
      ))}
    </div>
    {/*
      A SIBLING layer, not a child of the one above — see
      `.docprose-popover-layer` in index.css. `.docprose-layer` is z-index 1 so
      that claim marks read above prose marks, and a positioned element with a
      z-index is a STACKING CONTEXT: the card's own z-index could only ever mean
      "within this layer", so the claim underlines at z-index 2 painted straight
      over an open prose card. Owner, 2026-08-20.
    */}
    {active ? (
      <div className="docmark-layer docprose-popover-layer">
        <ProsePopover
          mark={active.mark}
          rect={active.rect}
          fix={fix}
          wrapWidth={wrapWidth}
          wrapHeight={wrapHeight}
          wrapScrollTop={wrapScrollTop}
          onApply={() => onApply(active.mark)}
          onDismiss={() => onDismiss(active.mark)}
          onMouseEnter={onPopoverEnter}
          onMouseLeave={onPopoverLeave}
        />
      </div>
    ) : null}
    </>
  )
}

/** Offsets identify an issue: `ProseMark` objects are rebuilt on every measure,
 *  so comparing them by reference makes the hovered mark flicker off on each
 *  keystroke. */
function isSameIssue(a: ProseIssue | undefined, b: ProseIssue): boolean {
  return a !== undefined && a.start === b.start && a.end === b.end && a.kind === b.kind
}

/** Whether a prose fix is mid-flight, so Apply can say so. */
export interface DocProseFix {
  start: number
  end: number
  applying: boolean
}

/**
 * The grammar card — what the native `title` tooltip used to be.
 *
 * The tooltip was the reason `.docprose` carried `pointer-events: auto`, which
 * made every flagged word a place the caret could not be placed: the layer sits
 * over the contentEditable, so an element that accepts a pointer event is a
 * hole in the document. Hit-testing removes the need for the element to be
 * hoverable at all, and it buys a card that can hold the one thing a tooltip
 * never could — the button that applies the fix.
 *
 * Narrower than the claim popover (240 against 320) and visibly lighter: a 1px
 * border where the claim card has 2, no dot, no count. A remark about "the the"
 * should not arrive with the same weight as one about whether a statistic is
 * real, and the card is where a reader reads that difference.
 */
const PROSE_POPOVER_WIDTH = 240

function ProsePopover({
  mark,
  rect,
  fix,
  wrapWidth,
  wrapHeight,
  wrapScrollTop,
  onApply,
  onDismiss,
  onMouseEnter,
  onMouseLeave
}: {
  mark: ProseMark
  rect: MarkRect
  fix: DocProseFix | null
  wrapWidth: number
  wrapHeight: number
  wrapScrollTop: number
  onApply: () => void
  onDismiss: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    setHeight(cardRef.current?.offsetHeight ?? 0)
  }, [mark.issue.start, mark.issue.kind])

  const width = PROSE_POPOVER_WIDTH
  const idealLeft = rect.left + rect.width / 2 - width / 2
  const left = Math.max(8, Math.min(idealLeft, wrapWidth - width - 8))
  const { above, top } = placePopover({
    markTop: rect.top,
    markHeight: rect.height,
    cardHeight: height,
    gap: POPOVER_GAP,
    viewportHeight: wrapHeight,
    scrollTop: wrapScrollTop
  })

  const { suggestion, message, severity } = mark.issue
  const applying = fix !== null && fix.start === mark.issue.start && fix.applying
  const rootRef = useRef<HTMLDivElement>(null)
  usePopoverEntrance(rootRef, `${mark.issue.kind}:${mark.issue.start}`, height > 0, above)

  return (
    <div
      ref={rootRef}
      className="docmark-popover docprose-popover"
      style={{ left, top, width }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div ref={cardRef} className="docprose-card" data-above={above ? 'true' : undefined}>
        <div className="docprose-card-head">
          <span
            className="docprose-card-kind"
            style={{ color: severity === 'error' ? PROSE_ERROR : PROSE_STYLE }}
          >
            {severity === 'error' ? 'Grammar' : 'Style'}
          </span>
        </div>
        <p className="docprose-card-body">{message}</p>
        <div className="docmark-actions">
          {/* Offered only where there IS one right answer. `filler` and
              `long-sentence` carry no suggestion on purpose — whether a given
              "very" is doing work is the writer's call, and a button that
              deleted it would be this app writing their sentence. */}
          {suggestion ? (
            <button className="docmark-btn-primary" onClick={onApply} disabled={applying}>
              {applying ? 'Applying…' : `Change to “${suggestion}”`}
            </button>
          ) : null}
          <button className="docmark-btn-secondary" onClick={onDismiss}>
            {suggestion ? 'Ignore' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * One flagged span: the highlighter band and the line beneath it.
 *
 * The same mark the Screen Watch overlay draws, from the same constants
 * (`shared/markMotion.ts`). It used to be a flat 2px border with a 12%-alpha
 * box on hover and no motion at all, so the identical problem on the identical
 * sentence looked like two different products depending on which window it was
 * in.
 *
 * Movement is a transform rather than left/top so it composites rather than
 * laying out — this layer sits over a contentEditable that reflows on every
 * keystroke, so a layout-triggering animation here is felt while typing. Large
 * jumps cut instead of gliding, or inserting a paragraph sends every mark below
 * it swooping diagonally up the page.
 */
function SpanMark({
  rect,
  color,
  hovered,
  className,
  data,
  dotted = false,
  title,
  enterDelay
}: {
  rect: MarkRect
  color: string
  hovered: boolean
  className: string
  data?: Record<string, string>
  /** A style note's line is dotted — a suggestion the writer may refuse. */
  dotted?: boolean
  title?: string
  /** Set when this mark is new on the page (useMarkArrivals): its line draws
   *  itself in after this many ms. Read once, at mount. */
  enterDelay?: number
}): JSX.Element {
  const lineRef = useRef<HTMLSpanElement>(null)
  useDrawIn(lineRef, enterDelay)
  const prev = useRef<{ x: number; y: number } | null>(null)
  const jumped = hasJumped(prev.current, { x: rect.left, y: rect.top })
  useEffect(() => {
    prev.current = { x: rect.left, y: rect.top }
  })

  return (
    <span
      className={className}
      data-hovered={hovered ? 'true' : 'false'}
      title={title}
      {...data}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: rect.width,
        height: rect.height + DESCENDER_ROOM,
        transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`,
        transition: jumped ? 'none' : MOVE_TRANSITION,
        willChange: 'transform',
        pointerEvents: 'none'
      }}
    >
      <span
        className="docmark-band"
        style={{
          position: 'absolute',
          inset: `${-BAND_INSET_TOP}px 0 ${BAND_INSET_BOTTOM}px 0`,
          background: bandBackground(color, hovered),
          borderRadius: BAND_RADIUS,
          opacity: hovered ? 1 : 0,
          transform: hovered ? 'scaleY(1)' : `scaleY(${BAND_SCALE_RESTING})`,
          transformOrigin: 'bottom',
          transition: BAND_TRANSITION
        }}
      />
      <span
        ref={lineRef}
        className="docmark-line"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: LINE_RADIUS,
          transition: LINE_TRANSITION,
          // A dotted line cannot be drawn as a filled box — it is the bottom
          // border of a zero-height element instead. A style note does not
          // thicken on hover either: the dots would merge into a solid rule and
          // read as the error treatment.
          ...(dotted
            ? { height: 0, borderBottom: `${LINE_HEIGHT}px dotted ${color}` }
            : { height: hovered ? LINE_HEIGHT_HOVERED : LINE_HEIGHT, background: color })
        }}
      />
    </span>
  )
}

/** A drawn mark, as the arrival and departure hooks see it. */
interface DrawnMark extends MarkItem {
  rect: MarkRect
  color: string
  dotted?: boolean
}

/**
 * A mark that just left — dismissed, fixed, edited away — fading where it was
 * (`.docmark-ghost` in index.css) instead of blinking off. Line only: nothing
 * is hovered on a mark that is going.
 */
function GhostMark({ mark }: { mark: DrawnMark }): JSX.Element {
  const { rect, color, dotted } = mark
  return (
    <span
      className="docmark-ghost"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: rect.width,
        height: rect.height + DESCENDER_ROOM,
        transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`,
        pointerEvents: 'none'
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: LINE_RADIUS,
          ...(dotted
            ? { height: 0, borderBottom: `${LINE_HEIGHT}px dotted ${color}` }
            : { height: LINE_HEIGHT, background: color })
        }}
      />
    </span>
  )
}

export default function DocumentMarkLayer({
  marks,
  active,
  preview = null,
  wrapWidth,
  wrapHeight,
  wrapScrollTop,
  flow,
  fix,
  citedWork,
  onFindSource,
  onSuggestFix,
  onFindCitedWork,
  onAskTracer,
  onDismiss,
  onPopoverEnter,
  onPopoverLeave
}: DocumentMarkLayerProps): JSX.Element {
  const activeFlow = flow && active && flow.claimId === active.mark.claim.id ? flow : null
  const activeFix = fix && active && fix.claimId === active.mark.claim.id ? fix : null
  const activeCitedWork = citedWork && active && citedWork.claimId === active.mark.claim.id ? citedWork : null
  // Keyed on the claim's TEXT for the motion: claim ids change when the editor
  // re-analyses, and an unchanged sentence must not draw itself in again.
  const drawn = useMemo<DrawnMark[]>(
    () =>
      marks.flatMap((mark) =>
        mark.rects.map((rect, i) => ({
          id: `${mark.claim.id}:${i}`,
          rect,
          color: PROBLEM_COLOR[mark.problemKinds[0]],
          seen: {
            key: mark.claim.text,
            color: PROBLEM_COLOR[mark.problemKinds[0]],
            x0: rect.left,
            x1: rect.left + rect.width,
            y: rect.top
          }
        }))
      ),
    [marks]
  )
  const arrivals = useMarkArrivals(drawn)
  const ghosts = useMarkDepartures(drawn)
  return (
    <div className="docmark-layer" aria-hidden="true">
      {marks.map((mark) =>
        mark.rects.map((rect, i) => {
          const kind = mark.problemKinds[0]
          const isActive = active?.mark.claim.id === mark.claim.id
          return (
            <SpanMark
              key={`${mark.claim.id}:${i}`}
              rect={rect}
              color={PROBLEM_COLOR[kind]}
              hovered={isActive || preview === mark.claim.id}
              className={`docmark${isActive ? ' active' : ''}`}
              // Same attributes the overlay's marks carry, and for the same
              // reason: this layer renders no text, so without them its DOM is
              // unreadable when inspecting it or asserting on it from a test.
              data={{ 'data-claim-id': mark.claim.id, 'data-problem': kind }}
              title={PROBLEM_LABEL[kind]}
              enterDelay={arrivals.get(`${mark.claim.id}:${i}`)}
            />
          )
        })
      )}
      {ghosts.map((g) => (
        <GhostMark key={`ghost:${g.id}`} mark={g} />
      ))}
      {active ? (
        <MarkPopover
          mark={active.mark}
          rect={active.rect}
          wrapWidth={wrapWidth}
          wrapHeight={wrapHeight}
          wrapScrollTop={wrapScrollTop}
          flow={activeFlow}
          fix={activeFix}
          citedWork={activeCitedWork}
          onFindSource={(readOnly) => onFindSource(active.mark, readOnly)}
          onSuggestFix={() => onSuggestFix(active.mark)}
          onFindCitedWork={() => onFindCitedWork(active.mark)}
          onAskTracer={() => onAskTracer(active.mark)}
          onDismiss={() => onDismiss(active.mark)}
          onMouseEnter={onPopoverEnter}
          onMouseLeave={onPopoverLeave}
        />
      ) : null}
    </div>
  )
}

function MarkPopover({
  mark,
  rect,
  wrapWidth,
  wrapHeight,
  wrapScrollTop,
  flow,
  fix,
  citedWork,
  onFindSource,
  onSuggestFix,
  onFindCitedWork,
  onAskTracer,
  onDismiss,
  onMouseEnter,
  onMouseLeave
}: {
  mark: DocumentMark
  rect: MarkRect
  wrapWidth: number
  wrapHeight: number
  wrapScrollTop: number
  flow: DocCitationFlow | null
  fix: DocFixFlow | null
  citedWork: DocCitedWorkFlow | null
  onFindSource: (readOnly: boolean) => void
  onSuggestFix: () => void
  onFindCitedWork: () => void
  onAskTracer: () => void
  onDismiss: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  // Re-measured on the step as well as the claim: the flow's cards are three to
  // five times the height of the problem statement they replace, and a stale
  // measurement is what decides above-vs-below.
  const step = flow?.state.step ?? fix?.state.step ?? citedWork?.state.step ?? null
  useLayoutEffect(() => {
    setHeight(cardRef.current?.offsetHeight ?? 0)
  }, [mark.claim.id, step])

  const kind = mark.problemKinds[0]
  const rootRef = useRef<HTMLDivElement>(null)

  // The lookup's list is a list of titles, like the citation flow's, so it
  // takes the flow's width once there is something to list.
  const width =
    flow || (citedWork && citedWork.state.step !== 'searching') ? POPOVER_WIDTH_FLOW : POPOVER_WIDTH

  // Centred on the line it points at, then pulled back inside the editor. The
  // tail stays on the sentence when the card moves, which is the whole reason
  // it is offset separately rather than pinned to the card's centre.
  const idealLeft = rect.left + rect.width / 2 - width / 2
  const left = Math.max(8, Math.min(idealLeft, wrapWidth - width - 8))
  const tailLeft = Math.max(12, Math.min(rect.left + rect.width / 2 - left - TAIL_WIDTH / 2, width - 28))

  // Above the line only when there is genuinely no room below and there is room
  // above. Decided in `shared/popoverPlacement.ts`, which is where the tests for
  // it are — the version inlined here reduced to `height > 390` and had been
  // flipping on the card's own height rather than on any measurement.
  const { above: wantsAbove, top } = placePopover({
    markTop: rect.top,
    markHeight: rect.height,
    cardHeight: height,
    gap: POPOVER_GAP,
    viewportHeight: wrapHeight,
    scrollTop: wrapScrollTop
  })

  // How tall it may be where it was just placed. Applied with the scrolling
  // source list in index.css — see maxCardHeight, which owns the arithmetic and
  // its tests.
  const cardCap = wrapHeight > 0
    ? maxCardHeight({
        markTop: rect.top,
        markHeight: rect.height,
        gap: POPOVER_GAP,
        viewportHeight: wrapHeight,
        scrollTop: wrapScrollTop,
        above: wantsAbove
      }) - TAIL_NET_HEIGHT
    : 0

  const { title, description, action } = popoverCopyFor(
    {
      claimType: mark.claim.claimType,
      hasInlineCitation: mark.hasInlineCitation,
      // What citationShape.ts found wrong with the citation's SHAPE, so the
      // card can print that sentence rather than a generic one.
      citationDefect: mark.citationDefect,
      citationDefectKind: mark.citationDefectKind,
      // Whether this sentence's own citation can be looked up and replaced —
      // what decides "Find the cited work" against "Find a source".
      hasOwnCitation: mark.hasOwnCitation,
      citationTarget: mark.citationTarget.status,
      critique: mark.claim.critique,
      text: mark.claim.text
    },
    mark.evidence,
    kind
  )
  // Decided from the action WORDING, so the label and the click cannot
  // disagree — see popoverRoute. It was kind-based, and "Ask Tracer" on an
  // off-topic card opened the read-only source list.
  const route = popoverRoute(action)
  const onPrimary =
    route === 'fix'
      ? onSuggestFix
      : route === 'cited-work'
        ? onFindCitedWork
        : route === 'tracer'
          ? onAskTracer
          : () => onFindSource(route === 'read-only')
  const remaining = mark.problemKinds.length
  usePopoverEntrance(rootRef, mark.claim.id, height > 0, wantsAbove)

  return (
    <div
      ref={rootRef}
      className="docmark-popover"
      style={{ left, top, width }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {!wantsAbove ? <Tail left={tailLeft} pointing="up" above={false} /> : null}
      {/*
        Capped to the editor's own height, because a card taller than either
        side of the sentence STAYS BELOW and clips — see the note in
        shared/popoverPlacement.ts, which explains why flipping it would be
        worse. What clips is the bottom, and the bottom is where the buttons
        are. Owner, 2026-08-19: *"there is no dismiss button once I am in it."*
        There was; it was drawn past the end of the window.

        The cap alone is not the fix — `.docmark-rows` has to be the part that
        gives, or a capped card just clips its own buttons from the inside. See
        the flex rules in index.css.

        `wrapHeight - 24` leaves the gap the card already sits in. Zero before
        the first measuring pass, which reads as "no cap" rather than as a
        zero-height card.
      */}
      <div ref={cardRef} className="docmark-card" style={cardCap > 0 ? { maxHeight: cardCap } : undefined}>
        {flow ? (
          <CitationFlowCard flow={flow} claimText={mark.claim.text} />
        ) : citedWork ? (
          <CitedWorkCard citedWork={citedWork} color={PROBLEM_COLOR[kind]} />
        ) : fix ? (
          <FixCard
            fix={fix}
            claim={mark.claim}
            kind={kind}
            color={PROBLEM_COLOR[kind]}
            fallbackDetail={description}
          />
        ) : (
          <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: PROBLEM_COLOR[kind] }} />
          <span className="docmark-title">{title}</span>
          {/* Only the first problem is shown; the count is the writer's warning
              that fixing this one will reveal another. */}
          {remaining > 1 ? (
            <span className="docmark-count" title={`${remaining} issues with this sentence — this is the first`}>
              {remaining}
            </span>
          ) : null}
        </div>
        {/* Markdown, not plain text. Two of these descriptions are the
            critique verbatim (see popoverCopyFor), the relay's prompts neither
            request nor forbid markdown, and the model emits it freely — so this
            card was printing literal `**cross-sectional**` at the reader. The
            overlay's identical card has rendered it since MarkdownText existed;
            this one was simply missed. Renders React elements from a parsed
            tree, never HTML, so model output cannot inject markup. */}
        <MarkdownText className="docmark-body">{description}</MarkdownText>
        <div className="docmark-actions">
          <button
            className="docmark-btn-primary"
            // read-only is the NEGATION of inserting. Passing insertsCitation
            // straight through once inverted the whole feature: "Add citation"
            // opened the read-only card and "Compare sources" the inserter.
            // Caught in the harness, not by reading; popoverRoute keeps it so.
            onClick={onPrimary}
          >
            {action}
          </button>
          <button className="docmark-btn-secondary" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
          </>
        )}
      </div>
      {wantsAbove ? <Tail left={tailLeft} pointing="down" above /> : null}
    </div>
  )
}

/**
 * "Suggest fix", answered in the popover instead of by navigating away.
 *
 * There is no Figma frame for this card — the design has the button and nothing
 * behind it (see fixFlowCopy.ts). It is built out of the pieces the popover
 * already has: the header dot in the mark's colour, `.docmark-body` prose, a
 * `.docmark-block` for proposed text exactly as the citation flow's preview
 * uses one, and the same two-button action row.
 *
 * What it shows is what the critique already produced and nothing else. No
 * relay call is made when it opens — the critique that raised the underline is
 * where every word here came from — which is what keeps this button honest on a
 * paid endpoint the user cannot watch being called.
 *
 * The one thing this surface does that the overlay does not is APPLY. This
 * editor owns its text: `replaceClaimText` types the narrowed sentence over the
 * old one through `execCommand`, so it lands on the browser's undo stack and
 * Ctrl+Z — or the card's own Undo, which is that same stack — takes it back
 * out. The overlay is reading someone else's window over UI Automation and
 * offers Copy instead. Same asymmetry as `Preview` in the citation flow, and
 * the same reason: each surface does what it can actually reach.
 */
function FixCard({
  fix,
  claim,
  kind,
  color,
  fallbackDetail
}: {
  fix: DocFixFlow
  claim: DocumentMark['claim']
  kind: DocumentMark['problemKinds'][number]
  color: string
  /** The problem card's own sentence, for a claim with no critique text — see
   *  the overlay's FixCard, where this case was found. */
  fallbackDetail: string
}): JSX.Element {
  const { state } = fix

  if (state.step === 'applied') {
    return (
      <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: '#16a34a' }} />
          <span className="docmark-title">{APPLIED_TITLE}</span>
        </div>
        <p className="docmark-body">{APPLIED_BODY}</p>
        <div className="docmark-actions">
          <button className="docmark-btn-primary" onClick={fix.onDone}>
            Done
          </button>
          <button className="docmark-btn-secondary" onClick={fix.onUndo} disabled={fix.undoing}>
            {fix.undoing ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      </>
    )
  }

  if (state.step === 'error') {
    return (
      <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: '#d93636' }} />
          <span className="docmark-title">Could not apply</span>
        </div>
        <p className="docmark-body">{state.message}</p>
        <div className="docmark-actions">
          <button className="docmark-btn-primary" onClick={fix.onCancel}>
            Back
          </button>
        </div>
      </>
    )
  }

  const revision = claim.suggestedRevision
  const citationFix = claim.citationFix
  // Only when there is nothing to apply. Where a revision exists the critique
  // prose has already been read on the card behind this one, and repeating it
  // above the sentence it produced buries the one thing worth looking at.
  const issues = revision || citationFix ? [] : critiqueIssues(claim.critique || fallbackDetail)

  return (
    <>
      <div className="docmark-head">
        <span className="docmark-dot" style={{ background: color }} />
        <span className="docmark-title">{fixTitle(kind)}</span>
      </div>
      {revision ? (
        <>
          <p className="docmark-body">{REVISION_RULE}</p>
          <div className="docmark-block">
            <div className="docmark-block-label">{REVISION_LABEL.toUpperCase()}</div>
            <div className="docmark-fix-quote">{revision}</div>
          </div>
        </>
      ) : null}
      {citationFix ? (
        <div className="docmark-block">
          <div className="docmark-block-label">{CITATION_FIX_LABEL.toUpperCase()}</div>
          {/* Monospaced, unlike the revision: a reference is read character by
              character, and whether the year sits where a page number belongs
              is the entire point of showing it. */}
          <div className="docmark-fix-quote mono">{citationFix}</div>
        </div>
      ) : null}
      {issues.length ? (
        <>
          <p className="docmark-body">{NO_REVISION_BODY}</p>
          <div className="docmark-fix-issues">
            {issues.map((issue, i) => (
              <div className="docmark-fix-issue" key={i}>
                {issue.title ? <div className="docmark-fix-issue-title">{issue.title}</div> : null}
                <MarkdownText className="docmark-body">{issue.detail}</MarkdownText>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <div className="docmark-actions">
        {revision ? (
          <button className="docmark-btn-primary" onClick={fix.onApply} disabled={fix.applying}>
            {fix.applying ? 'Applying…' : 'Apply revision'}
          </button>
        ) : null}
        <button className="docmark-btn-secondary" onClick={fix.onCancel}>
          Back
        </button>
      </div>
    </>
  )
}

/**
 * "Find the cited work" — the records that look like what the sentence cites,
 * and a Replace that swaps the citation for the one the writer picks.
 *
 * No Figma frame; assembled from the citation flow's own parts so it reads as
 * the same card: header dot, `.docmark-row`s with a radio, the style pills, a
 * `.docmark-block` saying exactly what Replace will write, and the frame's
 * full-width third button — here "Find a different source", which runs the
 * topical search with Replace semantics.
 *
 * Every title, author, year and venue on it is the record's (see
 * citedWorkFinder.ts). The year line is the one sentence of ours, and it only
 * states the two years side by side.
 */
function CitedWorkCard({ citedWork, color }: { citedWork: DocCitedWorkFlow; color: string }): JSX.Element {
  const { state, citation } = citedWork

  if (state.step === 'searching') {
    return (
      <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: color }} />
          <span className="docmark-title">{CITED_WORK_SEARCHING_TITLE}</span>
        </div>
        <p className="docmark-body">{citedWorkSearchingBody(citation)}</p>
        <div className="docmark-progress">
          <div className="docmark-progress-fill" />
        </div>
        <div className="docmark-actions">
          <button className="docmark-btn-secondary" onClick={citedWork.onCancel}>
            Cancel
          </button>
          <span className="docmark-hint">Usually 2–4 seconds</span>
        </div>
      </>
    )
  }

  if (state.step === 'error') {
    return (
      <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: '#d93636' }} />
          <span className="docmark-title">{state.title}</span>
        </div>
        <p className="docmark-body">{state.message}</p>
        <div className="docmark-actions">
          <button className="docmark-btn-primary" onClick={citedWork.onCancel}>
            Back
          </button>
        </div>
      </>
    )
  }

  if (state.step === 'replaced') {
    return (
      <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: '#16a34a' }} />
          <span className="docmark-title">{CITATION_REPLACED_TITLE}</span>
        </div>
        <p className="docmark-body">{citationReplacedBody(state.style, citation)}</p>
        <div className="docmark-block">
          <div className="docmark-block-label">{entryOutcomeLabel(state.outcome)}</div>
          <div className="docmark-block-body">{state.entry}</div>
          {state.outcome === 'failed' ? <div className="docmark-block-body">{WORKS_CITED_FAILED_NOTE}</div> : null}
        </div>
        <div className="docmark-actions">
          <button className="docmark-btn-primary" onClick={citedWork.onDone}>
            Done
          </button>
          {state.outcome === 'failed' ? null : (
            <button className="docmark-btn-secondary" onClick={citedWork.onViewWorksCited}>
              View Works Cited
            </button>
          )}
          <button className="docmark-btn-secondary" onClick={citedWork.onUndo} disabled={citedWork.undoing}>
            {citedWork.undoing ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      </>
    )
  }

  const { response, selectedRef, style } = state
  const { candidates } = response

  if (candidates.length === 0) {
    // Two different empties, never one. "Could not ask" and "asked, and both
    // indexes came back with nothing" read the same as a blank list, and only
    // the second is even a fact — neither is a verdict on the citation.
    return (
      <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: '#ffb800' }} />
          <span className="docmark-title">{CITED_WORK_EMPTY_TITLE}</span>
        </div>
        <p className="docmark-body">{response.searched ? citedWorkEmptyBody(citation) : CITED_WORK_UNREACHABLE}</p>
        <div className="docmark-actions">
          {response.searched ? (
            <button className="docmark-btn-primary" onClick={citedWork.onFindSource}>
              Find a source
            </button>
          ) : (
            <button className="docmark-btn-primary" onClick={citedWork.onRetry}>
              Try again
            </button>
          )}
          <button className="docmark-btn-secondary" onClick={citedWork.onCancel}>
            Back
          </button>
        </div>
      </>
    )
  }

  const selected = candidates.find((c) => c.ref === selectedRef) ?? null
  const written = selected ? selected.citations[style] : null

  return (
    <>
      <div className="docmark-head">
        <span className="docmark-dot" style={{ background: '#16a34a' }} />
        <span className="docmark-title">{citedWorkResultsTitle(candidates.length)}</span>
        <span className="docmark-chip">{CITATION_STYLE_LABEL[style]}</span>
      </div>
      <div className="docmark-scroll">
        <p className="docmark-body">{CITED_WORK_RESULTS_BODY}</p>
        <div className="docmark-rows">
          {candidates.map((candidate) => (
            <button
              type="button"
              key={candidate.ref}
              className={`docmark-row${candidate.ref === selectedRef ? ' selected' : ''}`}
              data-cited-ref={candidate.ref}
              onClick={() => citedWork.onSelect(candidate.ref)}
            >
              <SourceIconBox
                className="docmark-row-badge"
                initials={candidate.index === 'crossref' ? 'CR' : 'OL'}
                faviconDataUrl={null}
              />
              <span className="docmark-row-meta">
                <span className="docmark-row-title">{candidate.title}</span>
                <span className="docmark-row-sub">
                  <span className="docmark-venue">{citedWorkMeta(candidate)}</span>
                  <span className="docmark-match">{candidate.matchPercent}% match</span>
                </span>
                {candidate.yearNote ? <span className="docmark-year-note">{candidate.yearNote}</span> : null}
              </span>
              <span className={`docmark-radio${candidate.ref === selectedRef ? ' on' : ''}`} aria-hidden="true" />
            </button>
          ))}
        </div>
        {/* Inside the scroller, not pinned beside the buttons. Measured in the
            harness: with the style row and this block pinned too, a card capped
            to 219px over a sentence near the bottom of the editor collapsed
            the list to nothing and still drew Replace past its own edge. The
            buttons are what must stay reachable; this is reading. */}
        <div className="docmark-styles">
          <span className="docmark-styles-label">Style</span>
          {CITATION_STYLES.map((option) => (
            <button
              type="button"
              key={option}
              className={`docmark-style-pill${option === style ? ' on' : ''}`}
              onClick={() => citedWork.onSetStyle(option)}
            >
              {CITATION_STYLE_LABEL[option]}
            </button>
          ))}
        </div>
        {written ? (
          <div className="docmark-block">
            <div className="docmark-block-label">{willReplaceLabel(citation)}</div>
            <div className="docmark-block-marker">{written.inTextCitation}</div>
            <div className="docmark-block-body">{written.worksCitedEntry}</div>
          </div>
        ) : null}
      </div>
      <div className="docmark-actions">
        <button
          className="docmark-btn-primary"
          onClick={citedWork.onReplace}
          disabled={citedWork.replacing || !selected}
          title={`Replaces ${citation}`}
        >
          {citedWork.replacing ? 'Replacing…' : 'Replace citation'}
        </button>
        <button
          className="docmark-btn-secondary"
          onClick={() => selected?.url && citedWork.onOpenRecord(selected.url)}
          disabled={!selected?.url}
          title={selected?.url ?? undefined}
        >
          Open record ↗
        </button>
      </div>
      <button className="docmark-btn-secondary docmark-btn-wide" onClick={citedWork.onFindSource}>
        {FIND_DIFFERENT_SOURCE}
      </button>
    </>
  )
}

/**
 * The citation flow, drawn inside the same bordered card the problem statement
 * uses — Figma "Find a Source (Searching)" (294:343), "Find a Source (Results)"
 * (295:349) and "Add Citation (Inserted)" (298:130).
 *
 * The same three frames the Screen Watch overlay draws, and deliberately not a
 * shared component with it: that surface is inline styles in a window with no
 * stylesheet of its own, this one is `.docmark-*` classes from index.css. What
 * they share is the wording (citationFlowCopy.ts) and the shape.
 *
 * The one real difference between the surfaces is Preview, and it is a
 * difference in what each surface CAN do rather than in taste. Over another
 * app's window the overlay writes through UIA and the writer cannot see the
 * result until it lands, so being shown it first is the safeguard. Here the
 * insert goes into Tracely's own editor, on the browser's undo stack — the
 * citation appears in the sentence a few pixels away, and Ctrl+Z takes it back
 * out. Preview is offered anyway, because the works-cited entry is the half
 * that does NOT appear in the sentence.
 */
/**
 * The source the writer already cited, drawn above the search results.
 *
 * The half "Compare sources" was missing. Owner, 2026-08-19: *"I want it to
 * pull up the source before and the source it recommends now, because that's
 * what comparing sources means."*
 *
 * Three states, all of them real and none of them an error:
 *  - looking it up (two unmetered Crossref/Open Library requests);
 *  - a work was found, which is the comparison;
 *  - nothing came back, which is a fact about two indexes and NOT about the
 *    citation — see shared/citedComparison.ts, which owns that wording.
 *
 * `onOpen` rather than an anchor: this window is Electron, and a bare href
 * would navigate the app away from the document being written.
 */
function CitedSourceBlock({
  cited,
  loading,
  onOpen
}: {
  cited: ResolvedCitedWork | null
  loading: boolean
  onOpen: (url: string) => void
}): JSX.Element {
  const described = describeCitedWork(cited)
  return (
    <div className="docmark-block">
      <div className="docmark-block-label">{CITED_HEADING}</div>
      {loading ? (
        <div className="docmark-block-body">Looking it up…</div>
      ) : !described ? (
        // The sentence cites something in a shape the lookup cannot resolve, or
        // cites nothing at all. Stated as our limit, which is what it is.
        <div className="docmark-block-body">{UNCHECKABLE_SHAPE_NOTE}</div>
      ) : (
        <>
          <div className="docmark-block-marker">{described.reference}</div>
          {described.title ? <div className="docmark-cited-title">{described.title}</div> : null}
          <div className="docmark-block-body">
            <span className={described.found ? 'docmark-cited-ok' : 'docmark-cited-miss'}>
              {described.found ? '✓' : '?'}
            </span>{' '}
            {described.detail}
          </div>
          {described.note ? <div className="docmark-block-body">{described.note}</div> : null}
          {described.url ? (
            <button
              type="button"
              className="docmark-cited-link"
              onClick={() => onOpen(described.url as string)}
              title={described.url}
            >
              Open the source you cited ↗
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * One source in the list, with its receipt.
 *
 * Two shapes, decided by whether Insert may take it (shared/sourceReceipts.ts
 * `mayInsert`): a pickable row is the radio button it always was; any other
 * row — topic, unread, says otherwise, or anything in a read-only list — is
 * not selectable at all and offers only Open, because selecting a row the
 * Insert button then refuses is a click that teaches the wrong thing.
 *
 * The receipt is the source's own words, verbatim, with where they were read.
 * It wraps: the quote is the reason the row is here, and an ellipsis that cut
 * it would cut the evidence.
 */
function DocSourceRow({
  candidate,
  receipt,
  pickable,
  selected,
  showMatch,
  faviconDataUrl,
  onSelect,
  onOpen
}: {
  candidate: DocSourceCandidate
  receipt: SourceReceipt | null
  pickable: boolean
  selected: boolean
  showMatch: boolean
  faviconDataUrl: string | null
  onSelect: () => void
  onOpen: (() => void) | null
}): JSX.Element {
  const meta = (
    <span className="docmark-row-meta">
      <span className="docmark-row-title">{candidate.title}</span>
      {/* The venue is what gives and the match percentage is what does
          not — see .docmark-venue / .docmark-match. */}
      <span className="docmark-row-sub">
        <span className="docmark-venue">
          {candidate.venue ?? 'Unknown venue'}
          {candidate.year ? ` · ${candidate.year}` : ''}
        </span>
        {showMatch ? <span className="docmark-match">{candidate.matchPercent}% match</span> : null}
      </span>
      {receipt?.quote ? (
        <span className="docmark-receipt">
          <span className="docmark-receipt-lead">{SOURCE_SAYS}</span> {quoted(receipt.quote)}{' '}
          <span className="docmark-receipt-from">· {readFromLabel(receipt.readFrom)}</span>
        </span>
      ) : null}
      {/* What a marker would make of the publisher. `title` carries the reason. */}
      <span
        className={`docmark-cred docmark-cred-${candidate.credibility.tier}`}
        title={candidate.credibility.why}
      >
        {candidate.credibility.label}
      </span>
    </span>
  )
  const badge = (
    <SourceIconBox className="docmark-row-badge" initials={candidate.initials} faviconDataUrl={faviconDataUrl} />
  )
  const receiptClass = receipt?.quote ? ' has-receipt' : ''
  if (pickable) {
    return (
      <button
        type="button"
        className={`docmark-row${selected ? ' selected' : ''}${receiptClass}`}
        onClick={onSelect}
      >
        {badge}
        {meta}
        <span className={`docmark-radio${selected ? ' on' : ''}`} aria-hidden="true" />
      </button>
    )
  }
  return (
    <div className={`docmark-row docmark-row-static${receiptClass}`}>
      {badge}
      {meta}
      {onOpen ? (
        <button type="button" className="docmark-open" onClick={onOpen} title={candidate.pageUrl ?? undefined}>
          {OPEN_SOURCE}
        </button>
      ) : null}
    </div>
  )
}

function CitationFlowCard({ flow, claimText }: { flow: DocCitationFlow; claimText: string }): JSX.Element {
  // Hooks run before any of the early returns below, which is why this is here
  // rather than beside the rows it feeds: the card returns a different tree per
  // step, and a hook inside one of those branches would change hook order
  // between renders. Reads an empty list on every step except 'picking', which
  // costs nothing — useFavicons asks for what it has not already got.
  const favicons = useFavicons(
    flow.state.step === 'picking' ? flow.state.candidates.map((c) => c.url) : []
  )
  // "Related, but they don't say this" starts folded: those rows are what the
  // writer is being told not to cite, and they should not be the first thing
  // read. Here with the other hook for the same early-return reason.
  const [topicOpen, setTopicOpen] = useState(false)

  const { state } = flow

  if (state.step === 'searching') {
    return (
      <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: '#ff5900' }} />
          <span className="docmark-title">Searching for a source</span>
        </div>
        <p className="docmark-body">{searchingBody(claimText)}</p>
        <div className="docmark-progress">
          <div className="docmark-progress-fill" />
        </div>
        <div className="docmark-skeletons">
          {SKELETON_ROWS.map(([wide, narrow], i) => (
            <div className="docmark-skeleton-row" key={i}>
              <span className="docmark-skeleton tile" />
              <span className="docmark-skeleton-lines">
                <span className="docmark-skeleton" style={{ width: wide }} />
                <span className="docmark-skeleton faint" style={{ width: narrow }} />
              </span>
            </div>
          ))}
        </div>
        <div className="docmark-actions">
          <button className="docmark-btn-secondary" onClick={flow.onCancel}>
            Cancel
          </button>
          <span className="docmark-hint">Usually 3–5 seconds</span>
        </div>
      </>
    )
  }

  if (state.step === 'error') {
    return (
      <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: '#d93636' }} />
          <span className="docmark-title">Search failed</span>
        </div>
        <p className="docmark-body">{state.message}</p>
        <div className="docmark-actions">
          <button className="docmark-btn-primary" onClick={flow.onSearchAgain}>
            Search again
          </button>
          <button className="docmark-btn-secondary" onClick={flow.onCancel}>
            Cancel
          </button>
        </div>
      </>
    )
  }

  if (state.step === 'inserted') {
    return (
      <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: '#16a34a' }} />
          <span className="docmark-title">Citation added</span>
        </div>
        <p className="docmark-body">{insertedBody(state.style)}</p>
        {/* Always shown, never a toggle. The entry is the half of the insert
            the writer cannot see from here — the marker is already sitting in
            their sentence — so folding it away hid the only part that needed
            confirming, and the button that folded it was the one claiming to
            take you to a list that did not exist. */}
        <div className="docmark-block">
          <div className="docmark-block-label">{worksCitedLabel(state.worksCited)}</div>
          <div className="docmark-block-body">{state.citation.worksCitedEntry}</div>
          {state.worksCited === 'failed' ? (
            <div className="docmark-block-body">{WORKS_CITED_FAILED_NOTE}</div>
          ) : null}
        </div>
        <div className="docmark-resolved">
          <span className="docmark-resolved-yes">Claim resolved</span>
          <span className="docmark-hint">· {flagsLeft(flow.flagsRemaining)}</span>
        </div>
        <div className="docmark-actions">
          <button className="docmark-btn-primary" onClick={flow.onDone}>
            Done
          </button>
          {/* Offered only when there is somewhere to go. On 'failed' the
              document has no entry to scroll to, and a button that scrolls
              nowhere is the same empty gesture this replaced. */}
          {state.worksCited === 'failed' ? null : (
            <button className="docmark-btn-secondary" onClick={flow.onViewWorksCited}>
              View Works Cited
            </button>
          )}
          <button className="docmark-btn-secondary" onClick={flow.onUndo} disabled={flow.undoing}>
            {flow.undoing ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      </>
    )
  }

  const { candidates, selectedId, style, preview, receipts } = state
  const selectedUrl = candidates.find((c) => c.sourceId === selectedId)?.pageUrl ?? null

  if (candidates.length === 0) {
    return (
      <>
        <div className="docmark-head">
          <span className="docmark-dot" style={{ background: '#ffb800' }} />
          <span className="docmark-title">No sources found</span>
        </div>
        <p className="docmark-body">{emptyResultsBody(claimText)}</p>
        <div className="docmark-actions">
          <button className="docmark-btn-primary" onClick={flow.onSearchAgain}>
            Search again
          </button>
          <button className="docmark-btn-secondary" onClick={flow.onCancel}>
            Dismiss
          </button>
        </div>
      </>
    )
  }

  // "Checking what each source says…" — between the search and the list. The
  // rows are not drawn yet on purpose: a list on screen before it is read is a
  // list that reads as recommended, and Insert has nothing it may offer.
  if (receipts.status === 'checking') {
    return (
      <>
        <div className="docmark-head">
          {/* Grey: the "still checking" colour, not a finding. */}
          <span className="docmark-dot" style={{ background: PROBLEM_COLOR.searching }} />
          <span className="docmark-title">{CHECKING_TITLE}</span>
        </div>
        <p className="docmark-body">{checkingBody(candidates.length, claimText)}</p>
        <div className="docmark-progress">
          <div className="docmark-progress-fill" />
        </div>
        <div className="docmark-skeletons">
          {SKELETON_ROWS.map(([wide, narrow], i) => (
            <div className="docmark-skeleton-row" key={i}>
              <span className="docmark-skeleton tile" />
              <span className="docmark-skeleton-lines">
                <span className="docmark-skeleton" style={{ width: wide }} />
                <span className="docmark-skeleton faint" style={{ width: narrow }} />
              </span>
            </div>
          ))}
        </div>
        <div className="docmark-actions">
          <button className="docmark-btn-secondary" onClick={flow.onCancel}>
            Cancel
          </button>
        </div>
      </>
    )
  }

  // Checked: grouped by what each source SAYS. Unavailable: the list as it was
  // before receipts, Insert and all, under a line saying nothing was checked.
  const checked = receipts.status === 'checked'
  const groups = checked ? groupByReceipt(candidates, (c) => c.sourceId, receipts.byId) : null
  const backing = groups?.backs.length ?? 0
  const receiptOf = (id: string): SourceReceipt | null => (checked ? receipts.byId[id] ?? null : null)
  // A row may be picked only where Insert may take it (shared/sourceReceipts.ts).
  const pickable = (id: string): boolean => !flow.readOnly && mayInsert(receipts, id)
  const anyPickable = candidates.some((c) => pickable(c.sourceId))
  const canInsert = pickable(selectedId ?? '')

  const row = (candidate: DocSourceCandidate): JSX.Element => (
    <DocSourceRow
      key={candidate.sourceId}
      candidate={candidate}
      receipt={receiptOf(candidate.sourceId)}
      pickable={pickable(candidate.sourceId)}
      selected={candidate.sourceId === selectedId}
      // A match percentage measured the TOPIC. Once a source has been read,
      // its receipt is the answer and the percentage would contradict it.
      showMatch={!checked}
      faviconDataUrl={candidate.url ? favicons.get(candidate.url) ?? null : null}
      onSelect={() => flow.onSelect(candidate.sourceId)}
      onOpen={candidate.pageUrl ? () => flow.onOpenUrl(candidate.pageUrl as string) : null}
    />
  )

  return (
    <>
      <div className="docmark-head">
        <span className="docmark-dot" style={{ background: checked && backing === 0 ? '#ffb800' : '#16a34a' }} />
        <span className="docmark-title">
          {checked
            ? receiptsTitle(backing)
            : flow.readOnly
              ? readOnlyTitle(candidates.length)
              : resultsTitle(candidates.length)}
        </span>
        {flow.readOnly || !anyPickable ? null : <span className="docmark-chip">{CITATION_STYLE_LABEL[style]}</span>}
      </div>
      {/* The header above and the buttons below stay put; this is the part that
          scrolls. See .docmark-scroll — the version that scrolled only the
          results list left the buttons off the bottom of the editor. */}
      <div className="docmark-scroll">
      <p className="docmark-body">{checked ? receiptsBody(claimText, backing) : RECEIPTS_UNAVAILABLE}</p>
      {/* Only in read-only. This card is titled "Compare sources" there; the
          insert card is about a sentence with nothing to compare against. */}
      {flow.readOnly ? (
        <CitedSourceBlock
          cited={flow.cited}
          loading={flow.citedLoading}
          onOpen={flow.onOpenUrl}
        />
      ) : null}
      {groups ? (
        <>
          {groups.backs.length ? <div className="docmark-rows">{groups.backs.map(row)}</div> : null}
          {groups.contradicts.length ? (
            <div className="docmark-rows">
              <div className="docmark-group-label">{contradictsGroupLabel(groups.contradicts.length)}</div>
              {groups.contradicts.map(row)}
            </div>
          ) : null}
          {groups.topic.length ? (
            <div className="docmark-rows">
              <button
                type="button"
                className="docmark-group-toggle"
                aria-expanded={topicOpen}
                onClick={() => setTopicOpen((open) => !open)}
              >
                <span aria-hidden="true">{topicOpen ? '▾' : '▸'}</span> {topicGroupLabel(groups.topic.length)}
              </button>
              {topicOpen ? groups.topic.map(row) : null}
            </div>
          ) : null}
          {groups.unread.length ? (
            <div className="docmark-rows">
              <div className="docmark-group-label">{unreadGroupLabel(groups.unread.length)}</div>
              {groups.unread.map(row)}
            </div>
          ) : null}
        </>
      ) : (
        <div className="docmark-rows">{candidates.map(row)}</div>
      )}
      </div>
      {/* Every option at once, as the frame draws them — not one cycling
          button, which hid two thirds of the control behind a second click.
          Absent in read-only: a citation style is a question about a citation
          nobody is inserting — and absent when no row may be inserted. */}
      {flow.readOnly || !anyPickable ? null : (
      <div className="docmark-styles">
        <span className="docmark-styles-label">Style</span>
        {CITATION_STYLES.map((option) => (
          <button
            type="button"
            key={option}
            className={`docmark-style-pill${option === style ? ' on' : ''}`}
            onClick={() => flow.onSetStyle(option)}
          >
            {CITATION_STYLE_LABEL[option]}
          </button>
        ))}
      </div>
      )}
      {preview ? (
        <div className="docmark-block">
          <div className="docmark-block-label">WILL BE INSERTED</div>
          <div className="docmark-block-marker">{preview.inTextCitation}</div>
          <div className="docmark-block-body">{preview.worksCitedEntry}</div>
        </div>
      ) : null}
      {flow.readOnly || !anyPickable ? (
        // Nothing here may be cited — read-only, or no source was quoted
        // backing the sentence. An Insert that can never enable is a button
        // promising something the card has just said not to do.
        <div className="docmark-actions">
          <button className="docmark-btn-primary" onClick={flow.onCancel}>
            Done
          </button>
        </div>
      ) : (
        <div className="docmark-actions">
          <button
            className="docmark-btn-primary"
            onClick={flow.onInsert}
            disabled={flow.inserting || !canInsert}
            title={flow.replaces ? `Replaces ${flow.replaces}` : undefined}
          >
            {flow.inserting
              ? flow.replaces
                ? 'Replacing…'
                : 'Inserting…'
              : flow.replaces
                ? 'Replace citation'
                : 'Insert citation'}
          </button>
          {/* Was "Preview", which formatted the citation — and the citation
              block is now generated the moment a source is selected, so the
              button was a second click for something already on screen. Owner,
              2026-08-19: *"when I click preview I want the article to pop up."*
              Reasonable: the one thing a writer cannot check from this card is
              whether the page actually says what they are about to attribute
              to it. */}
          <button
            className="docmark-btn-secondary"
            onClick={flow.onOpenArticle}
            disabled={!selectedId || !selectedUrl}
            title={selectedUrl ?? undefined}
          >
            Open article ↗
          </button>
        </div>
      )}
      {/* Full-width under the pair — the frame's own third row. Re-runs the
          four academic searches rather than filtering what came back. */}
      <button className="docmark-btn-secondary docmark-btn-wide" onClick={flow.onSearchAgain}>
        Search again
      </button>
    </>
  )
}

/** Figma's own tail path (node 288:545), stroked to meet the card's border. */
function Tail({ left, pointing, above }: { left: number; pointing: 'up' | 'down'; above: boolean }): JSX.Element {
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
        display: 'block',
        transform: pointing === 'down' ? 'scaleY(-1)' : undefined,
        ...(above ? { marginTop: -2 } : { marginBottom: -2 })
      }}
    >
      <path d="M11.5708 6.5H2.28562L6.9282 1.47363L11.5708 6.5Z" fill="white" stroke="black" strokeWidth="2" />
    </svg>
  )
}
