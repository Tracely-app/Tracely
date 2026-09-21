/*
 * Ported from the desktop app's src/main/services/ai/sentenceSplit.ts.
 *
 * Claim detection selects claims by sentence INDEX: the model is sent
 * "[1] … [2] …" and answers with numbers. The desktop numbers its own text
 * with this splitter; when the web app sends a raw draft, the server numbers
 * it, and returns the spans so the client can map an index back to words. If
 * the two splitters disagreed, the same draft would carry different numbers on
 * the two surfaces, and every rule below — each written after a real document
 * was cut in the wrong place — would hold on one surface and not the other.
 * test/mirror.test.js runs both copies on a shared corpus whenever the desktop
 * tree is present.
 *
 * The desktop's formatting is kept on purpose, so a diff against the original
 * shows only the TypeScript annotations that had to go. Its comments follow
 * unedited.
 */

/**
 * @typedef {object} SentenceSpan
 * @property {number} start
 * @property {number} end
 * @property {string} text
 */

/**
 * Abbreviations whose trailing period is not a sentence end.
 *
 * Deliberately short. Every entry earns its place by appearing in real prose
 * this splitter has been run over; a long speculative list is a long list of
 * chances to merge two real sentences.
 */
const ABBREVIATIONS = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'st',
  'jr',
  'sr',
  'vs',
  'etc',
  'fig',
  'no',
  'pp',
  'al',
  'inc',
  'ltd',
  'co',
  'ed',
  'eds',
  'vol',
  'approx',
  'cf',
  'med'
])

/**
 * How far past a period a closing bracket may be and still count as enclosing
 * it. A citation parenthetical is short; anything longer is more likely an
 * unmatched bracket somewhere later in the text.
 */
const BRACKET_LOOKAHEAD = 120

/**
 * Whether this period sits inside a bracket that actually closes.
 *
 * BOTH halves are required, and the second is not decoration. Counting depth
 * alone means a single unmatched "(" — a smiley, a truncated UIA read, a
 * stray bracket in a list — suppresses every boundary after it, and the whole
 * document arrives at the relay as one enormous claim. That is a worse failure
 * than the one this rule exists to fix, and it is exactly what the first
 * version did; the test for it is in sentenceSplit.test.ts.
 */
function isInsideBrackets(text, dotIndex, spanStart) {
  let depth = 0
  for (let i = spanStart; i < dotIndex; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
  }
  if (depth === 0) return false

  const limit = Math.min(text.length, dotIndex + BRACKET_LOOKAHEAD)
  for (let i = dotIndex + 1; i < limit; i++) {
    const ch = text[i]
    if (ch === ')' || ch === ']') return true
    // A new bracket opening first means the earlier one was never closed.
    if (ch === '(' || ch === '[') return false
  }
  return false
}

/**
 * Whether the period ending at `dotIndex` is a real sentence boundary.
 *
 * Three ways it is not, all of them found in a single meticulously cited
 * position paper that Screen Watch mangled:
 *
 *  - **Inside brackets.** `(Thomas R. Leinbach, 2026)` was split in two, which
 *    severs the citation from the sentence that carries it — so the half with
 *    the claim in it looked uncited, and the half with the source in it looked
 *    like a sentence fragment. This is the structural rule and it is the one
 *    that matters: a period inside an unclosed `(` is never a sentence end.
 *  - **An initial.** `Gregory P. Margarian`, and equally `U.S.`, `e.g.`,
 *    `i.e.` — in every case the period follows a lone letter. "88% of
 *    international students in the U.S. have become less politically involved"
 *    was cut in half mid-clause, and the relay was then asked to find claims
 *    in each half.
 *  - **A known abbreviation.** `Dr.`, `etc.`, `vol.`
 *
 * The cost of a wrong answer here is asymmetric, which is why the rules lean
 * toward NOT splitting: two sentences merged is one over-long claim, while one
 * sentence split is a truncated claim, a truncated search query, and a
 * citation that has vanished from the text it belongs to.
 */
function isRealBoundary(text, dotIndex, spanStart) {
  if (isInsideBrackets(text, dotIndex, spanStart)) return false

  if (text[dotIndex] !== '.') return true

  // The run of letters immediately before the period.
  let i = dotIndex - 1
  while (i >= 0 && /[A-Za-z]/.test(text[i])) i--
  const word = text.slice(i + 1, dotIndex)

  // A single letter: an initial (`R.`) or one segment of a dotted abbreviation
  // (`U.S.`, `e.g.`). Both are mid-sentence.
  if (word.length === 1) return false
  return !ABBREVIATIONS.has(word.toLowerCase())
}

/**
 * Approximate sentence splitter. Every span is always a real, exact substring
 * of the source text by construction, never a generated approximation —
 * `claimSpans.ts` computes underline offsets from these, so that invariant is
 * load-bearing rather than a nicety.
 *
 * @param {string} text
 * @returns {SentenceSpan[]}
 */
export function splitSentences(text) {
  const spans = []
  // The closing group covers curly quotes (’ ”) as well as straight
  // ones. Word and Google Docs — Screen Watch's whole reason for existing —
  // emit curly by default, so `He said "it works."` used to end the sentence
  // at the period and orphan the closing quote onto the front of the next
  // span. Detection selects claims by sentence index, so every span after
  // the first quotation in a document was subtly wrong.
  //
  // The second alternative treats a newline as a boundary even with no
  // terminal punctuation, which is what headings, titles and bullet
  // fragments look like; without it a heading was glued onto the first
  // sentence of the paragraph below it and the pair got flagged as one claim.
  //
  // Superscripts are in the closing group for the same reason the quotes are:
  // a Word footnote renders as a bare mark AFTER the full stop, so `posted.²`
  // put a non-space between the terminator and the whitespace and no boundary
  // matched at all. Every footnoted sentence was returned glued to the one
  // following it — 13 sentences arriving as 10 on eval/citations'
  // 05-chicago-notes.txt. Detection selects claims by sentence INDEX, so a
  // merged pair shares one number and the model cannot pick one without the
  // other; the reconstructed span then underlines both sentences. Found by
  // `npm run eval:citations`, which is also what pins it.
  const boundary = /(?:[.!?]+["'’”)\]¹²³⁰-⁹]*(?:\s+|$))|(?:\n+)/g
  let start = 0
  let match

  while ((match = boundary.exec(text))) {
    // A newline always ends a span; only punctuation boundaries are checked,
    // and the check reads the FIRST character of the match, which is the
    // terminator itself.
    if (!match[0].startsWith('\n') && !isRealBoundary(text, match.index, start)) continue

    const end = match.index + match[0].length
    const raw = text.slice(start, end)
    if (raw.trim().length > 0) {
      spans.push({ start, end, text: raw.trim() })
    }
    start = end
  }

  if (start < text.length) {
    const raw = text.slice(start)
    if (raw.trim().length > 0) {
      spans.push({ start, end: text.length, text: raw.trim() })
    }
  }

  return spans
}
