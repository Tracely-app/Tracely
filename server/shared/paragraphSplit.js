/*
 * Ported from the desktop app's src/shared/paragraphSplit.ts.
 *
 * lib/ai.js has its own splitter, which cuts on blank lines only
 * (`/\n\s*\n+/`). The desktop cuts on ANY newline run, for the reason the
 * comment on splitParagraphs gives, and numbers what it sends the model with
 * that split. When /api/grade and /api/structure number a raw draft
 * server-side, and verifyGrade checks the model's paragraph indices against
 * that numbering, the server has to cut a draft exactly where the desktop
 * would — or "paragraph 3" means two different things on the two surfaces.
 * test/mirror.test.js runs both copies on a shared corpus whenever the desktop
 * tree is present.
 *
 * The desktop's formatting is kept on purpose, so a diff against the original
 * shows only the TypeScript annotations that had to go. Its comments follow
 * unedited.
 */

/**
 * Paragraph geometry, shared because BOTH processes need the identical split.
 *
 * Main computes roles and the score against these spans; the renderer has to
 * re-derive the same paragraphs to render text beside those labels, because a
 * DocumentOutline deliberately carries no prose. Two implementations drifting
 * apart would misalign every row in the panel against the paragraph it claims
 * to describe, which is the same reason `claimSpans.ts` lives here.
 */

/**
 * @typedef {object} ParagraphSpan
 * @property {number} index  1-based, so it matches the numbering a classifier is shown.
 * @property {number} start
 * @property {number} end
 * @property {string} text
 */

/**
 * Splits text into paragraphs, the unit the structure analysis reasons about.
 *
 * ANY newline run is a boundary, not just a blank line. The text this runs on
 * is `editor.innerText` from the contentEditable document editor, where
 * execCommand wraps each Enter in its own `<div>` and Chromium renders that as
 * a SINGLE '\n'. Requiring '\n\n' would therefore see a normal essay — one
 * Enter between paragraphs — as one giant paragraph, and every role, every
 * score component and every weakness would be computed over the whole
 * document. Collapsing runs means a plain-text draft with blank lines between
 * paragraphs splits identically, so both shapes behave the same.
 *
 * Like `splitSentences`, every span's `text` is a real substring of the source
 * (trimmed), never a generated approximation: `text.slice(start, end).trim()`
 * always equals `span.text`.
 *
 * @param {string} text
 * @returns {ParagraphSpan[]}
 */
export function splitParagraphs(text) {
  const spans = []
  // \r is matched too so a CRLF document doesn't leave a stray carriage return
  // at the head of every paragraph, which would then be trimmed out of `text`
  // while still being counted inside the span offsets.
  const boundary = /[\r\n]+/g
  let start = 0
  let match

  const push = (from, to) => {
    const raw = text.slice(from, to)
    if (raw.trim().length === 0) return
    spans.push({ index: spans.length + 1, start: from, end: to, text: raw.trim() })
  }

  while ((match = boundary.exec(text))) {
    push(start, match.index)
    start = match.index + match[0].length
  }
  push(start, text.length)

  return spans
}

/**
 * Which paragraph an offset falls in, or null if it falls outside every span
 * (in the whitespace between paragraphs, or past the end).
 *
 * Returns the 1-based `index`, not an array position, because that is what
 * every consumer stores and displays.
 *
 * @param {ParagraphSpan[]} spans
 * @param {number} offset
 * @returns {number | null}
 */
export function paragraphIndexAt(spans, offset) {
  for (const span of spans) {
    if (offset >= span.start && offset < span.end) return span.index
  }
  return null
}

/**
 * A located claim: its id and where its text starts in the source.
 *
 * @typedef {object} LocatedClaim
 * @property {string} claimId
 * @property {number} start
 */

/**
 * Buckets located claims into the paragraphs that contain them.
 *
 * Two rules that exist because getting either wrong misattributes a student's
 * claim to a paragraph they didn't write it in:
 *
 * - A claim is assigned by where it STARTS. A sentence that runs across a
 *   paragraph break belongs to the paragraph it opens, which is the one whose
 *   role it tells you about.
 * - A claim whose start lands in no paragraph is DROPPED, not rounded to the
 *   nearest one. `computeClaimSpans` already drops claims it cannot locate, on
 *   the same reasoning; silently attributing them to paragraph 1 would inflate
 *   that paragraph's role and the thesis component with it.
 *
 * Kept here rather than in the orchestrator because this is the part with a
 * wrong answer available, and this module is a leaf that `npm test` can load.
 *
 * @param {ParagraphSpan[]} spans
 * @param {LocatedClaim[]} claims
 * @returns {Map<number, string[]>}
 */
export function bucketClaimsByParagraph(spans, claims) {
  const buckets = new Map()
  for (const claim of claims) {
    const index = paragraphIndexAt(spans, claim.start)
    if (index === null) continue
    const existing = buckets.get(index)
    if (existing) existing.push(claim.claimId)
    else buckets.set(index, [claim.claimId])
  }
  return buckets
}
