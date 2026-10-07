import { claimEvidenceFor } from '@shared/claimEvidence'
import { computeClaimSpans } from '@shared/claimSpans'
import { findCitationInsertPoint } from '@shared/citationInsertPoint'
import { findProseIssues, replacementRange, type ProseIssue } from '@shared/proseIssues'
import { isCitedInScope } from '@shared/citationScope'
import { findCitationDefects, type CitationDefectKind } from '@shared/citationShape'
import {
  citationTarget,
  planCitationReplacement,
  planEntryReplacement,
  type CitationTarget,
  type EntryOutcome
} from '@shared/citedWork'
import {
  hasInlineCitationNear,
  inlineCitationKind,
  sentenceAround,
  sentenceRangeAround
} from '@shared/inlineCitation'
import { hasRelevantSource, problemKindsFor } from '@shared/problemKind'
import { retrievalScopeFor } from '@shared/retrievalScope'
import { findWorksCitedSection, planWorksCited } from '@shared/worksCited'
// The app is scaled with CSS `zoom`, which puts measured rects and the
// coordinates marks are DRAWN in into two different spaces. See zoomLayout.ts.
import { clientToLayout, contentOffset, readZoom } from '@shared/zoomLayout'
import type { ScreenWatchClaimEvidence, ScreenWatchProblemKind } from '@shared/ipc-contract'
import type { CitationStyle, Claim } from '@shared/types'

// `buildTextMap`/`locate` live in their own file so `npm test` can load them:
// this module's five `@shared/*` imports are exactly what Node's type stripping
// refuses to resolve, and the boundary rule inside `locate` is the piece worth
// pinning (see textMap.test.ts).
import { buildTextMap, locate } from './textMap'

/**
 * Where to draw the underlines over the document editor, and what each one
 * means.
 *
 * The editor's body is an uncontrolled contentEditable — deliberately, because
 * a controlled one resets the caret on every keystroke. That rules out the
 * obvious implementation: wrapping flagged sentences in <mark> elements would
 * mean React rewriting the node the user is typing into, which is the same
 * problem in a worse disguise (the caret survives a re-render only by accident,
 * and execCommand's own formatting would fight the wrappers).
 *
 * So nothing here touches the DOM the user edits. Ranges are measured against
 * it and the marks are drawn in a separate absolutely-positioned layer, which
 * is also how Screen Watch draws them over other applications — same idea, and
 * there the source text isn't even ours to modify. The measurement is
 * throwaway: `Range` objects are created, read for rects, and dropped.
 */

export interface MarkRect {
  left: number
  top: number
  width: number
  height: number
}

/** Everything except 'searching', which never reaches a mark — see measureMarks. */
export type MarkProblemKind = Exclude<ScreenWatchProblemKind, 'searching'>

export interface DocumentMark {
  claim: Claim
  /** Worst first. The mark is coloured by [0]; length > 1 shows a count. */
  problemKinds: MarkProblemKind[]
  hasInlineCitation: boolean
  /** citationShape.ts's sentence for a defect in this sentence's citation. */
  citationDefect: string | null
  /** The defective citation exactly as typed, so it can be replaced in place. */
  citationDefectText: string | null
  /** Which defect — a placeholder names no work to look up. */
  citationDefectKind: CitationDefectKind | null
  /**
   * Does THIS sentence carry a citation, as opposed to `hasInlineCitation`,
   * which is paragraph-scoped? Decides "Find the cited work" vs "Find a source".
   */
  hasOwnCitation: boolean
  /**
   * The one bracketed citation in the sentence a lookup can be pointed at and a
   * replacement can land on — or why there is none (`shared/citedWork.ts`).
   * Two citations in one sentence is 'several', and nothing is guessed.
   */
  citationTarget: CitationTarget
  /**
   * Never null: a claim whose search has not resolved is not marked at all —
   * see the note in measureMarks. Typed non-null so the popover cannot be
   * written against a state that never reaches it.
   */
  evidence: ScreenWatchClaimEvidence
  /**
   * One rect per visual line the claim spans, so a sentence that wraps is
   * underlined on each line it occupies rather than boxed across all of them.
   */
  rects: MarkRect[]
}

/**
 * Measures every flagged claim in the editor and returns where to draw it.
 *
 * `wrap` is the scroll container the marks layer is positioned inside, so rects
 * come back in its coordinate space with scroll folded in — an absolutely
 * positioned child of a scroll container scrolls with the content, so this
 * stays correct without re-measuring on every scroll event.
 *
 * `articleCounts` maps a claim id to how many articles its evidence search
 * returned. It has to be passed in: a persisted `Claim` does not carry one, and
 * the number the popover prints ("5 sources came back…") cannot be derived from
 * anything on the row — see claimEvidenceFor. A claim missing from the map is
 * simply not marked, the same as one whose search has not resolved.
 */
export function measureMarks(
  body: HTMLElement,
  wrap: HTMLElement,
  claims: Claim[],
  articleCounts: ReadonlyMap<string, number>,
  /**
   * Claims measured as tangents — see shared/claimRelevance.ts.
   *
   * Null means NOT MEASURED (the model unavailable, or the draft too short),
   * which is different from an empty set and must stay silent. Passing the
   * distinction through rather than collapsing it to a Set is what stops a
   * failed embed from underlining half a document as off topic.
   */
  offTopicClaimIds: ReadonlySet<string> | null = null
): DocumentMark[] {
  if (claims.length === 0) return []

  const { text, nodes } = buildTextMap(body)
  if (nodes.length === 0) return []

  const wrapRect = wrap.getBoundingClientRect()
  const zoom = readZoom(wrap.ownerDocument.defaultView, wrap.ownerDocument.documentElement)
  const marks: DocumentMark[] = []

  for (const span of computeClaimSpans(text, claims)) {
    // Read in its sentence, not on its own. A detected claim is a sub-span —
    // the relay returns the assertion and stops before the "(Author, Year)"
    // that follows it — so testing `span.claim.text` reported a properly cited
    // sentence as uncited. `span` already carries offsets into `text`, so the
    // sentence is right there.
    // Paragraph scope, not sentence scope — a sentence carrying an earlier
    // citation forward does not need one of its own. See citationScope.ts.
    const cited = isCitedInScope(text, span.start, span.end)
    // Does THIS sentence carry a citation, as opposed to being covered by one
    // in its paragraph? Both answers are needed and they mean different things
    // — see the note on `hasOwnCitation` in shared/problemKind.ts.
    const ownCitation = hasInlineCitationNear(text, span.start, span.end)

    /**
     * A citation that is visibly wrong, decided from its SHAPE.
     *
     * Free, instant, certain, and — unlike everything else on this card — true
     * the moment the writer types it. `(Unknown Author, 2025)` needs no search
     * and no critique to be wrong: the author is a placeholder and the year has
     * not happened. Owner, 2026-08-19: *"this one says it is partially
     * supported, when it should call out faulty citation"*, and separately
     * *"I want you to implement another detection system that detects if a
     * citation is wrong at the end of a sentence."*
     *
     * Run over the sentence rather than the claim span, for the same reason
     * `cited` is: the citation sits after the assertion the relay returned.
     */
    const sentence = sentenceAround(text, span.start, span.end)
    const defect = findCitationDefects(sentence)[0] ?? null
    // Which SHAPE the writer used, so problemKindsFor knows whether the
    // reference lookup could have checked it at all.
    const citationKind = inlineCitationKind(sentence)
    const evidence = claimEvidenceFor(span.claim, articleCounts.get(span.claim.id))

    // A claim nothing has been searched for yet gets no mark at all.
    //
    // problemKindsFor answers `evidence: null` with 'searching', and this pass
    // still refuses to draw that — but the reason has changed, so read it
    // carefully before reusing the old one. It used to be "nothing searches
    // automatically in this editor", which has been false since AnalyzeView
    // started sweeping unsearched claims. The reason now is narrower: a mark
    // HERE is a finding, carrying a colour and a hover card written against a
    // claim that has an answer, and a claim being searched has neither.
    //
    // That in-flight state IS drawn, by `measurePendingMarks` below — a grey
    // line in its own layer with no card. So null still means "no finding to
    // report", and "checking this" is no longer the same thing as silence.
    //
    // Underlining an unchecked claim in any colour makes the same mistake the
    // coverage line used to: reporting a verdict Tracely has not reached.
    //
    // A claim whose article count has not loaded lands here too, and for the
    // same reason: the popover's copy quotes that number, so drawing the mark
    // before it arrives means opening a card that has to invent one.
    if (!evidence) continue

    // The cast is what the `if (!evidence) continue` above earns: 'searching'
    // is returned only for a null evidence input, which cannot reach here.
    const problemKinds = problemKindsFor({
      claimType: span.claim.claimType,
      claimText: span.claim.text,
      hasInlineCitation: cited,
      hasOwnCitation: ownCitation,
      citationDefect: defect?.message ?? null,
      citationKind,
      // Whether the critique that produced this verdict actually opened the
      // work the sentence cites. Null on a claim critiqued before the column
      // existed, which problemKind.ts reads as "not read".
      citedWorkRead: span.claim.citedWorkRead,
      evidence: {
        score: evidence.score,
        count: evidence.count,
        hasRelevantSource: hasRelevantSource(span.claim.scoreBreakdown)
      },
      critiqueVerdict: span.claim.critiqueVerdict,
      outOfIndexScope: retrievalScopeFor(span.claim.text),
      onTopic: offTopicClaimIds === null ? null : !offTopicClaimIds.has(span.claim.id)
    }) as MarkProblemKind[]
    // Nothing is wrong with this sentence. Not drawing it is the point: a
    // document where every claim is underlined tells the writer nothing.
    if (problemKinds.length === 0) continue

    const from = locate(nodes, span.start)
    const to = locate(nodes, span.end)
    if (!from || !to) continue

    const range = document.createRange()
    try {
      range.setStart(from.node, from.offset)
      range.setEnd(to.node, to.offset)
    } catch {
      // Offsets that no longer address live nodes — the text moved on between
      // detection and this measure. Skipping is right: a mis-placed underline
      // accuses the wrong sentence.
      continue
    }

    const rects = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        left: contentOffset(rect.left - wrapRect.left, wrap.scrollLeft, zoom),
        top: contentOffset(rect.top - wrapRect.top, wrap.scrollTop, zoom),
        width: clientToLayout(rect.width, zoom),
        height: clientToLayout(rect.height, zoom)
      }))
    if (rects.length === 0) continue

    marks.push({
      claim: span.claim,
      problemKinds,
      hasInlineCitation: cited,
      citationDefect: defect?.message ?? null,
      citationDefectText: defect?.text ?? null,
      citationDefectKind: defect?.kind ?? null,
      hasOwnCitation: ownCitation,
      // The defect's own text decides when there is one: it is exactly the
      // citation the card is about.
      citationTarget: citationTarget(sentence, defect?.text ?? null),
      evidence,
      rects
    })
  }

  return marks
}

/**
 * A grammar, mechanics or wordiness issue, measured for drawing.
 *
 * Its own type and its own pass rather than another `DocumentMark`, because a
 * DocumentMark IS a claim — it carries evidence, a citation state and a
 * problemKind ranking, none of which a repeated word has. Faking a Claim to
 * reuse the layer would put "unverified statistic" one field away from "a/an".
 *
 * The two layers are drawn separately and coloured differently on purpose. The
 * three underline colours in this app mean something specific about
 * CREDIBILITY — see PROBLEM_COLOR — and a grammar flag is not a claim about
 * whether a sentence is true. Sharing a colour would teach the writer that the
 * orange under "70% of teenagers" and the orange under "the the" are the same
 * kind of remark.
 */
export interface ProseMark {
  issue: ProseIssue
  rects: MarkRect[]
}

/**
 * Measures every prose issue in the editor.
 *
 * Reads the same text map the claim pass does, so the two agree about where
 * the document's characters are. `findProseIssues` is pure and cheap — a
 * thousand-word draft is a few milliseconds — so this runs in the same measure
 * pass as the marks rather than behind a debounce of its own.
 */
export function measureProseMarks(body: HTMLElement, wrap: HTMLElement): ProseMark[] {
  const { text, nodes } = buildTextMap(body)
  if (nodes.length === 0) return []

  const wrapRect = wrap.getBoundingClientRect()
  const zoom = readZoom(wrap.ownerDocument.defaultView, wrap.ownerDocument.documentElement)
  const marks: ProseMark[] = []

  for (const issue of findProseIssues(text)) {
    const from = locate(nodes, issue.start)
    const to = locate(nodes, issue.end)
    if (!from || !to) continue

    const range = document.createRange()
    try {
      range.setStart(from.node, from.offset)
      range.setEnd(to.node, to.offset)
    } catch {
      continue
    }

    const rects = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        left: contentOffset(rect.left - wrapRect.left, wrap.scrollLeft, zoom),
        top: contentOffset(rect.top - wrapRect.top, wrap.scrollTop, zoom),
        width: clientToLayout(rect.width, zoom),
        height: clientToLayout(rect.height, zoom)
      }))
    if (rects.length === 0) continue

    marks.push({ issue, rects })
  }

  return marks
}

/** A claim that has been found but not yet checked. Rects only — see below. */
export interface PendingMark {
  claimId: string
  rects: MarkRect[]
}

/**
 * Where the claims currently being searched sit on the page.
 *
 * ── Why this is separate from `measureMarks` ───────────────────────────────
 * `measureMarks` refuses to draw a claim with no evidence, and that rule is
 * right: underlining one in any of the problem colours reports a verdict
 * Tracely has not reached. But the note explaining it says *"Nothing searches
 * automatically in this editor"*, and that stopped being true — `AnalyzeView`
 * sweeps every unsearched claim as soon as one arrives. So there is now a real
 * interval, several seconds long, where the app has found a sentence worth
 * checking and is checking it, and the document shows nothing at all.
 *
 * Screen Watch has always drawn this state; `problemCopy.ts` already gives it a
 * colour (grey, `#9a9ba1`) and a label ("Checking…"). The editor is the only
 * surface that went blank instead.
 *
 * ── Rects only, and no popover ─────────────────────────────────────────────
 * A `DocumentMark` carries a non-null `evidence` and a `MarkProblemKind` that
 * deliberately excludes `searching`, because the hover card is written against
 * a claim that has an answer. Rather than widen both to admit a state with
 * nothing to say, this is its own list: a progress indicator, `pointer-events:
 * none`, no card. Hovering something that cannot explain itself is worse than
 * not being able to hover it.
 *
 * Caller passes only the claims it is ACTUALLY searching. A claim with no
 * evidence and no search running is "never looked", which is not this.
 */
export function measurePendingMarks(
  body: HTMLElement,
  wrap: HTMLElement,
  claims: Claim[]
): PendingMark[] {
  if (claims.length === 0) return []

  const { text, nodes } = buildTextMap(body)
  if (nodes.length === 0) return []

  const wrapRect = wrap.getBoundingClientRect()
  const zoom = readZoom(wrap.ownerDocument.defaultView, wrap.ownerDocument.documentElement)
  const marks: PendingMark[] = []

  for (const span of computeClaimSpans(text, claims)) {
    const from = locate(nodes, span.start)
    const to = locate(nodes, span.end)
    if (!from || !to) continue

    const range = document.createRange()
    try {
      range.setStart(from.node, from.offset)
      range.setEnd(to.node, to.offset)
    } catch {
      continue
    }

    const rects = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        left: contentOffset(rect.left - wrapRect.left, wrap.scrollLeft, zoom),
        top: contentOffset(rect.top - wrapRect.top, wrap.scrollTop, zoom),
        width: clientToLayout(rect.width, zoom),
        height: clientToLayout(rect.height, zoom)
      }))
    if (rects.length === 0) continue

    marks.push({ claimId: span.claim.id, rects })
  }

  return marks
}

/**
 * Writes an in-text citation into the sentence a claim occupies.
 *
 * Through `execCommand('insertText')` rather than by mutating text nodes, for
 * the same reason the rest of this editor is execCommand-based: it goes on the
 * browser's own undo stack, so Ctrl+Z takes the citation back out. A direct DOM
 * edit is invisible to undo and would silently break the one thing a writer
 * reaches for when an edit surprises them.
 *
 * Placement is `findCitationInsertPoint`'s, which moves back inside the
 * sentence's terminal punctuation — "(Smith, 2020)." rather than ".(Smith,
 * 2020)" — and refuses to move when it cannot tell where the sentence ends.
 *
 * Returns false when the claim can no longer be located, which happens when the
 * draft moved on after the search. Inserting at a guessed offset would drop a
 * citation into the middle of an unrelated sentence.
 */
export function insertCitationForClaim(body: HTMLElement, claim: Claim, inTextCitation: string): boolean {
  const { text, nodes } = buildTextMap(body)
  const span = computeClaimSpans(text, [claim])[0]
  if (!span) return false

  const { offset, prefix } = findCitationInsertPoint(text, span.end)
  const at = locate(nodes, offset)
  if (!at) return false

  const selection = window.getSelection()
  if (!selection) return false
  const range = document.createRange()
  try {
    range.setStart(at.node, at.offset)
    range.collapse(true)
  } catch {
    return false
  }
  selection.removeAllRanges()
  selection.addRange(range)
  body.focus()
  return document.execCommand('insertText', false, `${prefix}${inTextCitation}`)
}

/**
 * Selects [start, end) of the reconstructed text and writes `replacement` over
 * it with the browser's own insert.
 *
 * `execCommand('insertText')` for the same reason `insertCitationForClaim` uses
 * it, and it is the whole reason the works-cited section is written as text
 * rather than assembled as markup: it is ONE undo step over a collapsed or
 * spanning selection, so Ctrl+Z (and the card's Undo, which is that same stack)
 * takes the entry back out. Rebuilding the section by DOM surgery would be
 * invisible to undo, and would leave a reference behind after the citation that
 * created it had been undone.
 *
 * Measured rather than assumed (2026-08-17, Chromium, against a live
 * contentEditable holding two paragraphs): `insertText` over a NON-COLLAPSED
 * selection deletes the selection and inserts in a single undoable step, and
 * one `execCommand('undo')` restored the original text exactly while leaving
 * the following paragraph untouched. That is why the range is selected and
 * typed over rather than deleted and then filled, which would cost two presses
 * of Ctrl+Z and leave the sentence gone after the first.
 *
 * Newlines in `replacement` become real block breaks — this is the same path a
 * multi-line paste takes.
 */
function replaceRange(
  body: HTMLElement,
  start: number,
  end: number,
  replacement: string,
  /**
   * Refuse a collapsed range.
   *
   * The caller's choice because both answers are right somewhere here. Writing
   * a narrowed sentence over an overstated one MUST replace: an empty range
   * would make this an insertion and leave the original in place with the
   * replacement wedged in front of it. Adding a works-cited section to a draft
   * that has none is legitimately an insertion at the end of the document, and
   * a blanket guard would reject exactly that.
   */
  mustReplace = false
): boolean {
  const { nodes } = buildTextMap(body)
  const from = locate(nodes, start)
  const to = locate(nodes, end)
  if (!from || !to) return false

  const selection = window.getSelection()
  if (!selection) return false
  const range = document.createRange()
  try {
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
  } catch {
    return false
  }
  if (mustReplace && range.collapsed) return false

  selection.removeAllRanges()
  selection.addRange(range)
  body.focus()
  return document.execCommand('insertText', false, replacement)
}

/**
 * Replaces the sentence a claim occupies with the critique's narrowed version.
 *
 * A thin caller of `replaceRange` — the undo argument that makes this safe is
 * written out there, and the two paths that write into the writer's document
 * share it rather than each doing their own range surgery.
 *
 * Returns false when the claim can no longer be located, exactly as
 * `insertCitationForClaim` does and for the same reason: the draft has moved on
 * since the critique ran, and rewriting at a guessed offset would replace a
 * sentence the writer never asked about. The caller says so rather than
 * silently doing nothing.
 *
 * What it will and will not put in the document is not this function's
 * judgement — see `normalizeCritique.isNarrowing`, which drops any revision that
 * introduces a named thing the original sentence does not contain. This writes
 * whatever survived that.
 */
export function replaceClaimText(body: HTMLElement, claim: Claim, replacement: string): boolean {
  const { text } = buildTextMap(body)
  const span = computeClaimSpans(text, [claim])[0]
  if (!span) return false
  return replaceRange(body, span.start, span.end, replacement, true)
}

/**
 * Applies one grammar or mechanics fix, through the same `execCommand` path
 * every other edit here uses — so it lands on the browser's undo stack and one
 * Ctrl+Z takes it back out.
 *
 * The offsets are re-derived from the live document rather than trusted from
 * the `ProseIssue`, which was measured on an earlier innerText. A writer who
 * types anywhere above the flagged word between the card opening and the button
 * being pressed has moved it, and applying a stale offset would rewrite a
 * different part of the sentence.
 */
/**
 * Swaps a defective citation for a real one, in place.
 *
 * `insertCitationForClaim` APPENDS a marker to the sentence, which is right
 * when there was no citation and wrong when there was a broken one — it leaves
 * `(Unknown Author, 2025) (Walker, 2004)` sitting in the draft. Owner,
 * 2026-08-19: *"when it detects citations are incomplete, and I click fix the
 * citation there is no replace button to replace the citation."*
 *
 * Located by its TEXT rather than by a stored offset — same rule
 * `applyProseIssue` and Tracer's rewrite both live by: the card can be seconds
 * old and the writer has been typing, and replacing at a guessed offset
 * rewrites a part of the document nobody asked about.
 *
 * ── Scoped to THIS SENTENCE, and that is the whole fix ─────────────────────
 * It required the text to be unique in the WHOLE DOCUMENT, and refused
 * otherwise. A broken citation is not a typo a writer makes once: paste the
 * same malformed reference after four sentences — which is exactly what a
 * student does with one bad source — and every one of those four cards refuses,
 * forever, because of the other three. Owner, 2026-08-20: *"this keeps
 * appearing."*
 *
 * The uniqueness test was standing in for "am I replacing the right one", and
 * the card already knows the answer: it was opened from ONE claim. Its
 * sentence is the only place the replacement may land, which makes duplicates
 * elsewhere irrelevant rather than fatal — and is strictly more correct, since
 * a unique match in a different paragraph was never the right target either.
 *
 * Still refuses when the SENTENCE carries the same broken citation twice. That
 * is genuinely ambiguous and rare, and guessing there would rewrite the half
 * the writer was not looking at.
 */
export function replaceCitationText(
  body: HTMLElement,
  /** The claim whose card this is. Its sentence bounds the search. */
  claim: Claim,
  defective: string,
  replacement: string
): boolean {
  const { text } = buildTextMap(body)
  const span = computeClaimSpans(text, [claim])[0]
  // The claim itself is gone — the sentence really was edited away, which is
  // the one case the old error message described correctly.
  if (!span) return false

  // The search itself is `planCitationReplacement` (shared/citedWork.ts), so
  // the sentence bound and the refuse-a-duplicate rule are tested without a
  // contentEditable.
  const edit = planCitationReplacement(text, sentenceRangeAround(text, span.start, span.end), defective, replacement)
  if (!edit) return false
  return replaceRange(body, edit.start, edit.end, edit.replacement, true)
}

/**
 * The editor's text as the mark pass reads it — what "Find the cited work"
 * sends, so the Works Cited line it matches is one `applyEntryReplacement` can
 * find again character for character.
 */
export function editorText(body: HTMLElement): string {
  return buildTextMap(body).text
}

/**
 * The reference-list half of "Replace citation": the record's entry in, the
 * line the bad citation pointed at out, as ONE `insertText` over the section —
 * one undo step, like every other write here.
 *
 * Planned against the LIVE text (`planEntryReplacement`), never at an offset
 * remembered from when the card opened. `oldEntry` null means add only — the
 * caller passes null when another sentence still uses the old citation.
 */
export function applyEntryReplacement(
  body: HTMLElement,
  {
    oldEntry,
    entry,
    sourceTitle,
    style
  }: { oldEntry: string | null; entry: string; sourceTitle: string | null; style: CitationStyle }
): { outcome: EntryOutcome | 'failed'; wrote: boolean } {
  const { text } = buildTextMap(body)
  const { edit, outcome } = planEntryReplacement({ text, oldEntry, entry, sourceTitle, style })
  // `wrote` is what Undo counts. 'already-listed' can still be a write — the
  // old line coming out — so the outcome alone cannot say whether a step was
  // taken.
  if (!edit) return { outcome, wrote: false }
  return replaceRange(body, edit.start, edit.end, edit.replacement)
    ? { outcome, wrote: true }
    : { outcome: 'failed', wrote: false }
}

export function applyProseIssue(body: HTMLElement, issue: ProseIssue): boolean {
  if (!issue.suggestion) return false
  const { text } = buildTextMap(body)
  const { start, end, target, anchor, offsetInAnchor } = replacementRange(issue)

  // Still where it was measured: replace in place.
  if (text.slice(start, end) === target && text.slice(start, start + anchor.length) === anchor) {
    return replaceRange(body, start, end, issue.suggestion, true)
  }

  // Otherwise re-find it by the ANCHOR — the wider phrase — and replace the
  // prefix inside it. Anchoring on `target` alone would be hopeless: for an
  // article fix the target is the single letter "a".
  const at = text.indexOf(anchor)
  if (at === -1 || at !== text.lastIndexOf(anchor)) return false
  const from = at + offsetInAnchor
  return replaceRange(body, from, from + target.length, issue.suggestion, true)
}

/**
 * Applies a rewrite Tracer proposed, through the same `execCommand` path as
 * every other edit here — so one Ctrl+Z takes it back out.
 *
 * `find` is located in the LIVE document rather than trusted from the reply.
 * The conversation may be minutes old and the writer has been typing in the
 * meantime; an offset measured against the text the model saw would rewrite
 * whatever now sits at that position.
 *
 * Refuses two cases rather than guessing:
 *
 *  - **Not found.** The sentence has been edited or deleted since Tracer read
 *    it, so there is nothing to narrow. The caller says so.
 *  - **Found more than once.** Which copy did the student mean? A repeated
 *    sentence is rare in an essay and picking the first is a coin flip, so this
 *    declines. `applyProseIssue` takes the same position on its anchor for the
 *    same reason.
 *
 * Whether the replacement is ALLOWED is not decided here — `shared/
 * tracerRewrite.ts` runs `isNarrowing` before any of this is offered. This
 * writes what survived that.
 */
export function applyTracerRewrite(body: HTMLElement, find: string, replace: string): boolean {
  const { text } = buildTextMap(body)
  const at = text.indexOf(find)
  if (at === -1 || at !== text.lastIndexOf(find)) return false
  return replaceRange(body, at, at + find.length, replace, true)
}

export type WorksCitedResult = 'added' | 'already-listed' | 'failed'

/**
 * Adds one entry to the document's own works-cited list, creating the section
 * if the document has none.
 *
 * Called BEFORE the in-text marker is written, which is not an accident. The
 * list sits after every sentence in the draft, so writing it first leaves the
 * claim's offsets untouched for `insertCitationForClaim` to locate against; and
 * it puts the marker on top of the undo stack, so the first Ctrl+Z removes the
 * thing the writer is looking at rather than a list off the bottom of the
 * screen. The caller has to undo TWICE to unwind the pair — see
 * `undoFlowCitation`, which knows how many steps its insert took.
 *
 * 'already-listed' is a real answer, not a failure: citing one source for two
 * sentences is normal, and every style lists a work once. The card says so
 * rather than reporting an add that did not happen.
 */
export function addWorksCitedEntry(
  body: HTMLElement,
  { entry, sourceTitle, style }: { entry: string; sourceTitle: string | null; style: CitationStyle }
): WorksCitedResult {
  const { text } = buildTextMap(body)
  const { edit } = planWorksCited({ text, entry, sourceTitle, style })
  if (!edit) return 'already-listed'
  return replaceRange(body, edit.start, edit.end, edit.replacement) ? 'added' : 'failed'
}

/**
 * Scrolls the works-cited section into view — what "View Works Cited" on the
 * confirmation card does, now that there is one to view.
 *
 * `behavior: 'auto'`, never 'smooth', for the reason written out at
 * `selectParagraph` in AnalyzeView: smooth scrolling is compositor-driven and
 * silently does nothing when the window is not compositing frames.
 *
 * Returns false when the document has no section, which the caller should treat
 * as "say nothing" rather than as an error — it means the entry was never
 * written, and that has already been reported by `addWorksCitedEntry`.
 */
export function revealWorksCited(body: HTMLElement): boolean {
  const { text, nodes } = buildTextMap(body)
  const section = findWorksCitedSection(text)
  if (!section) return false
  const at = locate(nodes, section.start)
  if (!at) return false
  // The heading's own block element, not the text node — Text has no
  // scrollIntoView, and the block is what the reader is being shown.
  const target = at.node.parentElement
  if (!target) return false
  target.scrollIntoView({ block: 'center', behavior: 'auto' })
  return true
}

function within(rect: MarkRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height
}

/** The mark under a point in `wrap`'s coordinate space, if any. */
export function markAt(marks: DocumentMark[], x: number, y: number): { mark: DocumentMark; rect: MarkRect } | null {
  for (const mark of marks) {
    for (const rect of mark.rects) {
      if (within(rect, x, y)) return { mark, rect }
    }
  }
  return null
}

/**
 * The prose mark under a point, if any.
 *
 * Separate from `markAt` rather than generic over both, because the two layers
 * are hit-tested in a deliberate order: a claim mark wins over a prose mark on
 * the same words. The credibility colours carry this app's actual judgement,
 * and a sentence that is both unverified and clumsy should open the card about
 * whether it is true.
 *
 * This exists at all because the prose layer used to have `pointer-events:
 * auto` so that a native `title` tooltip would fire — which made every
 * grammar-flagged word a place the writer could not click to put their caret.
 * That is the same bug Screen Watch had over the whole overlay, reintroduced in
 * miniature. Hit-testing is how the claim layer avoided it from the start.
 */
export function proseMarkAt(
  marks: ProseMark[],
  x: number,
  y: number
): { mark: ProseMark; rect: MarkRect } | null {
  for (const mark of marks) {
    for (const rect of mark.rects) {
      if (within(rect, x, y)) return { mark, rect }
    }
  }
  return null
}

/**
 * Scrolls the editor to a claim's sentence and returns where it landed.
 *
 * The report's "Show me" — the answer to a reader clicking a named problem and
 * being shown the name again. Returns the rects so the caller can flash them;
 * null when the claim's text is no longer in the document, which happens
 * whenever a finding is acted on before it is clicked.
 */
export function revealClaim(body: HTMLElement, wrap: HTMLElement, claim: Claim): MarkRect[] | null {
  // `buildTextMap`'s text, NOT `innerText`. They are different strings — one
  // walks text nodes, the other inserts newlines for block boundaries — so
  // offsets computed against innerText resolve to the wrong place, or to
  // nothing at all, when `locate` looks them up in the node map. `measureMarks`
  // has always used this pairing; computing the span one way and locating it
  // the other is why the first version of "Show me" scrolled nowhere.
  const { text, nodes } = buildTextMap(body)
  const span = computeClaimSpans(text, [claim]).find((s) => s.claim.id === claim.id)
  if (!span) return null
  const start = locate(nodes, span.start)
  const end = locate(nodes, span.end)
  if (!start || !end) return null

  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)

  // The block element, not the range: Range has no scrollIntoView, and centring
  // the paragraph is what actually shows the sentence in context.
  const block = start.node.parentElement
  block?.scrollIntoView({ block: 'center', behavior: 'auto' })

  // Measured AFTER the scroll, so the rects are where the flash should be
  // drawn rather than where the sentence used to be.
  const wrapRect = wrap.getBoundingClientRect()
  const zoom = readZoom(wrap.ownerDocument.defaultView, wrap.ownerDocument.documentElement)
  const rects = Array.from(range.getClientRects())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      left: contentOffset(r.left - wrapRect.left, wrap.scrollLeft, zoom),
      top: contentOffset(r.top - wrapRect.top, wrap.scrollTop, zoom),
      width: clientToLayout(r.width, zoom),
      height: clientToLayout(r.height, zoom)
    }))
  range.detach?.()
  return rects.length > 0 ? rects : null
}
