/**
 * The works-cited list at the end of the writer's own document — where it is,
 * what is already in it, and what to write to add one more entry.
 *
 * Why this exists
 * ---------------
 * "Add Citation (Inserted)" (Figma 298:130) says **ADDED TO WORKS CITED** and
 * offers **View Works Cited**. Both sentences assert the document HAS such a
 * list. It did not: the button toggled a grey block inside the card, so the
 * only works-cited list in the product was a picture of one. A confirmation
 * that confirms something which did not happen is worse than no confirmation,
 * because the writer stops checking.
 *
 * Where the section lives, and why
 * --------------------------------
 * **In the document body, as ordinary text.** Not a React region rendered
 * beside the editor, which was the easier build: a reference list that is not
 * in `body_html` is not in the essay the student hands in — it does not copy,
 * does not print, and is gone when the document is reopened anywhere else — so
 * the card would still be claiming something untrue, just less visibly. It is
 * also the only form `parseBibliography` (bibliography.ts) can see, and that is
 * the module the fabrication check reads a reference list with; a sidebar list
 * would be invisible to the half of this product whose job is reading one.
 *
 * The cost of that choice is that every edit to it goes through `execCommand`
 * against a contentEditable nothing may otherwise touch (see the note at the
 * top of `renderer/src/components/documentMarks.ts`). That is the shape this
 * module is built for: it decides everything against a plain string and hands
 * back **one** replacement span, so the DOM side is a single `insertText` over
 * a single Range — one undo step, exactly like the in-text marker beside it.
 *
 * A leaf module (the one import below is type-only and erases), so `npm test`
 * can load it. Ordering and dedupe are the two decisions here with a wrong
 * answer available, and both are silent when wrong.
 */

import type { CitationStyle } from './types'

/**
 * What each style calls the list. Recognising all three matters more than
 * writing the right one: a draft that already carries "References" must not
 * grow a second list headed "Works Cited" underneath it because the writer's
 * default style setting says MLA.
 */
export const WORKS_CITED_HEADINGS: Record<CitationStyle, string> = {
  MLA: 'Works Cited',
  APA: 'References',
  Chicago: 'Bibliography'
}

/**
 * Any heading that means "the reference list starts here", including forms no
 * style of ours writes — the writer may have typed their own before Tracely
 * inserted anything, and appending a second list below theirs is the failure
 * this exists to prevent.
 *
 * Deliberately narrower than bibliography.ts's HEADING: that one is reading
 * someone else's document and can afford to be generous, this one decides
 * where to WRITE.
 */
const HEADING_LINE =
  /^\s*(works\s+cited|references|reference\s+list|bibliography|literature\s+cited)\s*:?\s*$/i

export interface WorksCitedSection {
  /** Offset of the first character of the heading line. */
  start: number
  /**
   * Offset just past the last entry — never past the trailing blank lines, so
   * replacing [start, end) cannot eat whitespace the writer left below it.
   */
  end: number
  /** The heading as the writer typed it, so a rewrite preserves their wording. */
  heading: string
  /** The non-empty lines under the heading, trimmed, in document order. */
  entries: string[]
}

interface Line {
  text: string
  start: number
  end: number
}

function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      lines.push({ text: text.slice(start, i), start, end: i })
      start = i + 1
    }
  }
  return lines
}

/**
 * The reference list, or null.
 *
 * Searched from the END of the document, for the reason bibliography.ts
 * searches from the end: an introduction that mentions "references" is prose,
 * and the list is the last thing in an essay. Everything from the heading to
 * the last non-empty line is the section — the same rule that lets the rewrite
 * replace it wholesale, and the reason a writer who keeps drafting *below*
 * their reference list would have that text rewritten. That is a shape no draft
 * has rather than one this refuses: the list is where the document ends.
 */
export function findWorksCitedSection(text: string): WorksCitedSection | null {
  const lines = splitLines(text)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!HEADING_LINE.test(lines[i].text)) continue
    const entries: string[] = []
    let end = lines[i].end
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j].text.trim()
      if (body.length === 0) continue
      entries.push(body)
      end = lines[j].end
    }
    return { start: lines[i].start, end, heading: lines[i].text.trim(), entries }
  }
  return null
}

/**
 * Case- and punctuation-insensitive form, used for every comparison below.
 *
 * Curly quotes and en-dashes are what the formatters emit and straight ones are
 * what a writer types; a comparison that kept them apart would report one entry
 * as two and list the same source twice.
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Short titles are not distinctive enough to identify a work by, and a false
 * match here silently drops a reference — the one direction that cannot be
 * spotted by looking at the finished list.
 */
const MIN_TITLE_MATCH_CHARS = 14

/**
 * Is this work already listed?
 *
 * Two tests, because neither is enough alone. Normalised equality catches the
 * ordinary case: the same source cited twice in the same style formats to the
 * same string. The title test catches the same source cited in two different
 * styles, where the two strings share almost nothing else.
 *
 * Keyed on the TITLE rather than on surname+year, which was the obvious
 * alternative and is wrong: two different papers by the same authors in the
 * same year share a surname and a year, and collapsing them would delete a real
 * reference from the list.
 */
function listsWork(entries: string[], entry: string, sourceTitle: string | null): boolean {
  const target = normalize(entry)
  const title = sourceTitle ? normalize(sourceTitle) : ''
  for (const existing of entries) {
    const candidate = normalize(existing)
    if (candidate === target) return true
    if (title.length >= MIN_TITLE_MATCH_CHARS && candidate.includes(title)) return true
  }
  return false
}

/**
 * Alphabetical by the entry's first element — what MLA, APA and Chicago all
 * ask for, which is why one rule covers the three. Every formatter in
 * `services/citations/formatters/` leads with the author's surname (or with the
 * title when there is no author), so ordering the printed strings IS ordering
 * by author.
 *
 * Leading quotes and brackets come off first, so a title-led entry files under
 * its own first letter instead of under a quote mark. Leading articles are NOT
 * stripped — MLA asks for that and this does not do it, the same class of known
 * simplification as the "et al." truncation in `citations/authorUtils.ts`.
 */
function sortKey(entry: string): string {
  return normalize(entry.replace(/^[\s"'“”‘’([{]+/, ''))
}

function byEntry(a: string, b: string): number {
  const ka = sortKey(a)
  const kb = sortKey(b)
  if (ka < kb) return -1
  if (ka > kb) return 1
  return 0
}

/** One replacement span, ready to be applied with a single `insertText`. */
export interface WorksCitedEdit {
  /** Start offset in the text this was planned against. */
  start: number
  /** End offset; equal to `start` when a new section is being appended. */
  end: number
  /** What to write over [start, end). */
  replacement: string
  /** True when the document had no reference list before this edit. */
  created: boolean
}

export interface WorksCitedPlan {
  /**
   * Null when the work is already listed — nothing to write, and the card must
   * then say "already in Works Cited" rather than claim an insert that did not
   * happen.
   */
  edit: WorksCitedEdit | null
}

export interface PlanWorksCitedInput {
  /** The editor's text, as `documentMarks`' buildTextMap reconstructs it. */
  text: string
  /** The formatted bibliography line, from `citation.generate`. */
  entry: string
  /** The cited source's title. Used only to recognise a cross-style duplicate. */
  sourceTitle: string | null
  /** Style being inserted — decides the heading, if a heading has to be written. */
  style: CitationStyle
  /** Settings → Citations: the heading a new list gets instead of the style's own. Empty or absent: the style's. */
  heading?: string | null
}

/**
 * What to write to add `entry` to the document's reference list.
 *
 * The whole section is rewritten rather than the new line spliced in, because
 * the list has to be re-sorted anyway: an entry added in insertion order is a
 * list in the wrong order, and all three styles ask for alphabetical. Rewriting
 * also repairs a list that was already out of order or already duplicated,
 * which a splice could not.
 */
export function planWorksCited({ text, entry, sourceTitle, style, heading = null }: PlanWorksCitedInput): WorksCitedPlan {
  const clean = entry.replace(/\s+/g, ' ').trim()
  if (clean.length === 0) return { edit: null }

  const section = findWorksCitedSection(text)

  if (!section) {
    // Appended after the last non-blank character rather than at `text.length`:
    // the editor's reconstructed text ends with the trailing newline every
    // block element contributes, and writing after that opens the section with
    // a run of empty paragraphs which grows by one on every citation.
    const at = text.replace(/\s+$/, '').length
    return {
      edit: {
        start: at,
        end: at,
        replacement: `\n\n${heading || WORKS_CITED_HEADINGS[style]}\n${clean}`,
        created: true
      }
    }
  }

  if (listsWork(section.entries, clean, sourceTitle)) return { edit: null }

  // Existing entries are deduped against each other too. They can repeat — the
  // writer may have pasted one, or an insert may predate this module — and a
  // rewrite that preserved the repeat would make the list worse every time it
  // was touched.
  const merged: string[] = []
  for (const candidate of [...section.entries, clean]) {
    if (!listsWork(merged, candidate, null)) merged.push(candidate)
  }
  merged.sort(byEntry)

  return {
    edit: {
      start: section.start,
      end: section.end,
      // The writer's own heading, not ours. They may have typed "REFERENCES" or
      // "Bibliography", and rewriting it to match the current style setting
      // would be editing their prose to settle an argument they did not start.
      replacement: `${section.heading}\n${merged.join('\n')}`,
      created: false
    }
  }
}

/**
 * The document with any trailing reference list removed.
 *
 * The structure analysis runs on the editor's `innerText`, and a reference list
 * is not an argument. Without this, adding a works-cited section would have
 * quietly broken the argument score: `heuristicRoles` labels those lines
 * `unknown`, which sets `complete: false`, which makes `findWeaknesses`
 * withhold every whole-draft finding — and the conclusion is found as the LAST
 * paragraph, which after this feature is a citation.
 *
 * A suffix trim, deliberately, so every offset before it is unchanged and claim
 * spans computed against the full text still line up with the paragraphs.
 */
export function withoutWorksCited(text: string): string {
  const section = findWorksCitedSection(text)
  return section ? text.slice(0, section.start) : text
}
