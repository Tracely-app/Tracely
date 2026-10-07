import { findWorksCitedSection, planWorksCited, withoutWorksCited } from './worksCited.ts'
import type { CitationDefectKind } from './citationShape.ts'
import type { CitationStyle } from './types.ts'

/**
 * "Find the cited work" — the decidable half, as a leaf.
 *
 * Why this exists
 * ---------------
 * Owner, 2026-10-06, on a sentence ending "(Genghis Khan and the, 2022)": the
 * card said the citation was wrong *"but it doesnt find citation for me"*. It
 * could not. `citedReference.parseReferences` reads that as one surname and a
 * year, `isCheckable` refuses a single surname (on purpose — see
 * MIN_CHECKABLE_SURNAMES), so `referenceCheck` made no request at all and
 * nothing on the desktop could look a work up from a partial title.
 *
 * The fabrication check and this are different questions. That one asks "does
 * the work these authors and this year name EXIST?", and must refuse to answer
 * on thin input because its answer can become an accusation. This one asks
 * "which real records look like what the writer typed?", and its answer is
 * never a verdict — it is a short list the writer picks from, every field of it
 * read off an index. So it can run on a partial title, a single surname, or the
 * matching Works Cited line, and the worst it can do is show three records
 * that are not the one they meant.
 *
 * The algorithm is the server's `compareSource` (server/lib/evidence.js):
 * Crossref's reference-matching `query.bibliographic` plus Open Library's
 * free-text search, scored lexically with YEARS STRIPPED from the scoring copy,
 * floor 0.5. Ported rather than called: it is two free, unmetered requests the
 * desktop is already allowed to make (`referenceCheck.ts`), and a server round
 * trip would add a paid route's quota to a lookup that costs nothing.
 *
 * What this module never does: write metadata. It scores records, matches a
 * citation to an entry the WRITER typed, and plans where text goes. Every
 * title, author, year and DOI that reaches a card comes from a record.
 *
 * A leaf — one value import, of another leaf, with an explicit extension — so
 * `npm test` can load it.
 */

// ── the citation as typed ──────────────────────────────────────────────────

const YEAR = /\b(?:1[5-9]|20)\d{2}[a-z]?\b/g

/** The year the writer wrote in the citation, or null. */
export function citedYearOf(citation: string): number | null {
  const match = /\b((?:1[5-9]|20)\d{2})[a-z]?\b/.exec(citation)
  return match ? Number(match[1]) : null
}

/**
 * Words that carry no identifying signal in a citation or a title. The server's
 * STOPWORDS list, trimmed to what can appear in a reference.
 */
const STOPWORDS = new Set(
  (
    'a an the and or but if then than that this these those of in on at to from by with for as is are ' +
    'was were be been being it its he she they them his her their we our you your i my me not no do does ' +
    'did have has had will would can could should may might must about into over under between also such ' +
    'more most some any each which who whom whose what when where how why all both per vs via during ' +
    'after before while there here out up down only very just so because et al nd pp ed eds vol'
  ).split(' ')
)

function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => (t.length > 1 || /\d/.test(t)) && !STOPWORDS.has(t))
}

/**
 * The query text with every year removed — the SCORING copy.
 *
 * Why years come out: the server measured it. A year is a number, numbers carry
 * the heaviest token weight, and a coincidental year match lets an unrelated
 * record clear the floor. Worse here than there: the reason someone presses
 * this button is often that the year they wrote is WRONG ("Genghis Khan…" is a
 * 2004 book cited as 2022), and scoring on it would push the right record down.
 */
export function withoutYears(text: string): string {
  return text.replace(YEAR, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The citation as search text: brackets, quotes, page locators and "n.d."
 * gone, the words and the year kept. "(Genghis Khan and the, 2022)" becomes
 * "Genghis Khan and the 2022".
 */
export function citationQueryText(citation: string): string {
  return citation
    .replace(/[()[\]“”"‘’]/g, ' ')
    .replace(/\bpp?\.\s*\d+(?:\s*[–—-]\s*\d+)?/gi, ' ')
    .replace(/\bn\.\s?d\./gi, ' ')
    .replace(/[,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── which Works Cited line the citation points at ──────────────────────────

/**
 * The reference-list entry this in-text citation points at, or null.
 *
 * Exactly one, or nothing — the rule bibliography.ts holds for MLA markers, for
 * the same reason: picking between two plausible entries attaches the lookup to
 * a work the sentence did not cite. Two passes:
 *
 *  - a numbered marker "[3]" matches the entry numbered 3, and only that;
 *  - anything else matches an entry carrying EVERY identifying word of the
 *    citation (its surnames, or the words of its short title). When several
 *    do, the cited year breaks the tie; when it cannot, the answer is null.
 *
 * The entry is the better query whenever there is one: it carries the full
 * title and every author, where "(Genghis Khan and the, 2022)" carries half a
 * title. That is the whole reason to look for it.
 */
export function matchWorksCitedEntry(citation: string, documentText: string): string | null {
  const section = findWorksCitedSection(documentText)
  if (!section || section.entries.length === 0) return null

  const numbered = /^\s*\[\s*(\d{1,3})\s*\]\s*$/.exec(citation)
  if (numbered) {
    const n = numbered[1]
    const hits = section.entries.filter((entry) =>
      new RegExp(`^\\s*(?:\\[\\s*${n}\\s*\\]|${n}[.)])\\s`).test(entry)
    )
    return hits.length === 1 ? hits[0] : null
  }

  const wanted = tokenize(withoutYears(citationQueryText(citation))).filter((t) => !/^\d+$/.test(t))
  if (wanted.length === 0) return null

  const hits = section.entries.filter((entry) => {
    const have = new Set(tokenize(entry))
    return wanted.every((t) => have.has(t))
  })
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) return null

  const year = citedYearOf(citation)
  if (year === null) return null
  const sameYear = hits.filter((entry) => citedYearOf(entry) === year)
  return sameYear.length === 1 ? sameYear[0] : null
}

// ── the queries ───────────────────────────────────────────────────────────

export interface CitedWorkQueries {
  /** Crossref `query.bibliographic` strings, best first. */
  crossref: string[]
  /** Open Library `q` — no year: its free-text search ANDs terms. */
  openLibrary: string | null
  /** What candidates are SCORED against. Years stripped. */
  scoring: string
}

/** Long enough for a full reference, short enough to ride in a URL. */
const MAX_QUERY_CHARS = 300

/**
 * What to search with.
 *
 * The matched Works Cited entry when there is one, else the citation itself.
 * The `hint` is the critique's `citationFix` — the model's MEMORY of the
 * corrected reference, never index-verified — and it is used only as one more
 * Crossref query string. It never decides a score and nothing it says is
 * shown: a record it surfaces still has to clear the floor against what the
 * writer actually typed, and the card prints the record's fields.
 */
export function citedWorkQueries({
  citation,
  entry = null,
  hint = null
}: {
  citation: string
  entry?: string | null
  hint?: string | null
}): CitedWorkQueries {
  const primary = (entry ? entry.replace(/\s+/g, ' ').trim() : citationQueryText(citation)).slice(0, MAX_QUERY_CHARS)
  const crossref = [primary]
  const cleanHint = hint?.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS) ?? ''
  if (cleanHint && cleanHint.toLowerCase() !== primary.toLowerCase()) crossref.push(cleanHint)
  const scoring = withoutYears(primary)
  const words = tokenize(scoring)
  return {
    crossref: primary ? crossref : cleanHint ? [cleanHint] : [],
    // Open Library ANDs every term, so a whole reference returns nothing; the
    // identifying words are what it can match. The first six, because an entry
    // leads with its authors and title, and a publisher or a place further on
    // is a term the work index may not hold.
    openLibrary: words.length > 0 ? words.slice(0, 6).join(' ') : null,
    scoring
  }
}

// ── scoring ───────────────────────────────────────────────────────────────

/** Numbers weigh most, longer words more than short ones — server/lib/evidence.js. */
function tokenWeight(t: string): number {
  if (/\d/.test(t)) return 2.5
  return Math.min(t.length, 12) / 4
}

/**
 * How much of the query's weight the record carries, 0..1 — the server's
 * `lexicalRelevance`, query-side containment. Years are stripped from the query
 * before it gets here (`withoutYears`), never from the record.
 */
export function lexicalMatch(query: string, recordText: string): number {
  const wanted = [...new Set(tokenize(query))]
  if (wanted.length === 0) return 0
  const have = new Set(tokenize(recordText))
  if (have.size === 0) return 0
  let matched = 0
  let total = 0
  for (const t of wanted) {
    const w = tokenWeight(t)
    total += w
    if (have.has(t)) matched += w
  }
  return total === 0 ? 0 : Math.round((matched / total) * 10_000) / 10_000
}

/**
 * The server's COMPARE_RESOLVE_FLOOR. A genuine hit for the writer's own
 * reference repeats most of its identifying words; Crossref returns SOMETHING
 * for nearly any string, and unrelated records score well below this once
 * years are out of the scoring copy.
 */
export const CITED_WORK_FLOOR = 0.5

/** Three, because this is "which of these is the one you meant", not a reading list. */
export const MAX_CITED_WORK_CANDIDATES = 3

/** A record as an index returned it. Every field is the index's. */
export interface CitedWorkRecord {
  title: string
  /** Full names, in the record's order. */
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  url: string | null
  index: 'crossref' | 'openlibrary'
}

const normTitle = (title: string): string => tokenize(title).join(' ')

/**
 * Dedupe, score against the year-stripped query, keep what clears the floor,
 * best first, at most three. Crossref first on a tie — it carries the DOI.
 */
export function rankCitedWorkRecords<R extends CitedWorkRecord>(
  records: R[],
  scoring: string
): Array<{ record: R; score: number }> {
  const seen = new Set<string>()
  const unique: R[] = []
  for (const record of records) {
    if (!record.title.trim()) continue
    const key = record.doi ? `doi:${record.doi.toLowerCase()}` : `t:${normTitle(record.title)}|${record.year ?? ''}`
    const titleKey = `t:${normTitle(record.title)}|${record.year ?? ''}`
    if (seen.has(key) || seen.has(titleKey)) continue
    seen.add(key)
    seen.add(titleKey)
    unique.push(record)
  }
  return unique
    .map((record) => ({ record, score: lexicalMatch(scoring, `${record.title} ${record.authors.join(' ')}`) }))
    .filter((r) => r.score >= CITED_WORK_FLOOR)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.record.index === b.record.index ? 0 : a.record.index === 'crossref' ? -1 : 1) ||
        a.record.title.localeCompare(b.record.title)
    )
    .slice(0, MAX_CITED_WORK_CANDIDATES)
}

/**
 * The line under a candidate when its year is not the one the writer wrote.
 *
 * Owner's case: the record is a 2004 book and the citation says 2022. Said
 * plainly, because a card that silently printed 2004 over the writer's 2022
 * would look like it had found a different work — and because a wrong year IS
 * the repair, half the time. A one-year gap gets the reassurance
 * citedComparison.ts gives it: an online-first article and its print issue are
 * routinely a year apart.
 */
export function yearMismatchLabel(recordYear: number | null, citedYear: number | null): string | null {
  if (recordYear === null || citedYear === null || recordYear === citedYear) return null
  const base = `This record is from ${recordYear}; your citation says ${citedYear}`
  return Math.abs(recordYear - citedYear) <= 1 ? `${base}. A year either way is normal.` : base
}

// ── reading a record ──────────────────────────────────────────────────────

const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?$/i

/**
 * A full name as Open Library gives it ("Jack Weatherford", "William Strunk,
 * Jr.", "Weatherford, Jack") split into the family/given pair the formatters
 * need. The record's own words, reordered — nothing added: a suffix rides with
 * the given names rather than being dropped or invented.
 */
export function personFromFullName(name: string): { given?: string; family: string } {
  const clean = name.replace(/\s+/g, ' ').trim()
  const comma = clean.indexOf(',')
  if (comma !== -1) {
    const before = clean.slice(0, comma).trim()
    const after = clean.slice(comma + 1).trim()
    // "Strunk, Jr." style is a suffix after the full name, not "Family, Given".
    if (NAME_SUFFIX.test(after)) {
      const inner = personFromFullName(before)
      return { family: inner.family, given: [inner.given, after].filter(Boolean).join(' ') || undefined }
    }
    return after ? { family: before, given: after } : { family: before }
  }
  const words = clean.split(' ')
  let familyAt = words.length - 1
  if (familyAt > 0 && NAME_SUFFIX.test(words[familyAt])) familyAt--
  const family = words[familyAt]
  const given = [...words.slice(0, familyAt), ...words.slice(familyAt + 1)].join(' ')
  return given ? { family, given } : { family }
}

/**
 * The year to show for a BOOK record.
 *
 * Open Library lists every edition's year. A book is cited by the edition in
 * the writer's hands, so when one of the record's editions IS the cited year,
 * that is the year to print — it is in the record, and calling it a mismatch
 * would send the writer to change a year that was right. Otherwise the first
 * publication year, which is what the record leads with.
 */
export function bookYear(
  firstPublished: number | null,
  editionYears: number[],
  citedYear: number | null
): number | null {
  if (citedYear !== null && editionYears.includes(citedYear)) return citedYear
  return firstPublished ?? (editionYears.length > 0 ? Math.min(...editionYears) : null)
}

// ── which citation in the sentence to replace ─────────────────────────────

export type CitationTarget =
  | { status: 'one'; text: string }
  /** No bracketed citation in the sentence — nothing to replace in place. */
  | { status: 'none' }
  /** Two or more. Which one the card means cannot be told from here. */
  | { status: 'several' }

/** A bracketed reference: a year, "n.d.", a quoted title, or MLA author-page. */
const BRACKETED = /\([^()]{2,160}\)/g
function isReferenceParenthetical(inner: string): boolean {
  return (
    /\b(?:1[5-9]|20)\d{2}[a-z]?\b/.test(inner) ||
    /\bn\.\s?d\./i.test(inner) ||
    /^\s*["“][^"”]{4,}["”]/.test(inner) ||
    /^\s*\p{Lu}[\p{L}'’-]+(?:\s+(?:and|&)\s+\p{Lu}[\p{L}'’-]+)?\s+(?:pp?\.\s*)?\d{1,4}(?:\s*[–—-]\s*\d{1,4})?\s*$/u.test(inner)
  )
}

/** How many works one parenthetical names: "(Paris, 1996; Walker, 2010)" is two. */
function worksIn(inner: string): number {
  return inner.split(';').filter((part) => /\S/.test(part)).length
}

/**
 * The one citation in this sentence a replacement may land on.
 *
 * Refuses rather than guesses. A sentence carrying two citations — two
 * brackets, or one bracket naming two works — gives no way to tell which one
 * the card is about, and replacing the wrong one rewrites the half of the
 * sentence the writer was not looking at. When the card already knows the
 * exact text (a citation-shape defect hands it over), that text decides, and
 * it is refused only if the sentence carries it twice.
 *
 * Narrative citations ("Smith (2020) found…") are left alone on purpose: the
 * name is part of the sentence's grammar, and writing "(Weatherford, 2004)
 * found…" over it would be Tracely rewriting prose rather than a reference.
 */
export function citationTarget(sentence: string, known: string | null = null): CitationTarget {
  if (known) {
    const first = sentence.indexOf(known)
    if (first === -1) return { status: 'none' }
    return first === sentence.lastIndexOf(known) ? { status: 'one', text: known } : { status: 'several' }
  }
  const found: string[] = []
  let works = 0
  for (const match of sentence.matchAll(BRACKETED)) {
    const inner = match[0].slice(1, -1)
    if (!isReferenceParenthetical(inner)) continue
    // A narrative citation's year in brackets: "Smith (2020)". The name is
    // outside the bracket and part of the sentence.
    if (/^\s*(?:1[5-9]|20)\d{2}[a-z]?\s*$/.test(inner)) continue
    found.push(match[0])
    works += worksIn(inner)
  }
  if (found.length === 0) return { status: 'none' }
  if (found.length > 1 || works > 1) return { status: 'several' }
  return { status: 'one', text: found[0] }
}

// ── the edits ─────────────────────────────────────────────────────────────

export interface TextEdit {
  start: number
  end: number
  replacement: string
}

/**
 * Where to write `marker` over `target`, inside [from, to) of `text` — the
 * sentence the card was opened on — and nowhere else.
 *
 * Null when the target is not in that sentence or is in it twice. The same
 * rule `replaceCitationText` has held since 2026-08-20; extracted here so it
 * can be tested without a contentEditable.
 */
export function planCitationReplacement(
  text: string,
  range: { from: number; to: number },
  target: string,
  marker: string
): TextEdit | null {
  if (!target || !marker) return null
  const sentence = text.slice(range.from, range.to)
  const rel = sentence.indexOf(target)
  if (rel === -1 || rel !== sentence.lastIndexOf(target)) return null
  const start = range.from + rel
  return { start, end: start + target.length, replacement: marker }
}

/**
 * Is this citation also used in another sentence of the draft?
 *
 * Then its reference-list entry still has a sentence pointing at it, and
 * replacing that entry would orphan the other one — so the caller adds the
 * record's entry and leaves the old line alone. One bad reference pasted after
 * several sentences is the ordinary way a draft gets one (see
 * replaceCitationText's note), so this is the common case, not an edge.
 */
export function citationUsedElsewhere(text: string, citation: string): boolean {
  if (!citation) return false
  const body = withoutWorksCited(text)
  let count = 0
  for (let at = body.indexOf(citation); at !== -1; at = body.indexOf(citation, at + citation.length)) {
    if (++count > 1) return true
  }
  return false
}

export type EntryOutcome = 'replaced' | 'added' | 'already-listed'

/**
 * The reference-list half of a replacement: the record's entry IN, the entry
 * the bad citation pointed at OUT, in one edit.
 *
 * One span over the whole section, so the DOM side is one `insertText` and one
 * Ctrl+Z — the same contract `planWorksCited` gives an ordinary insert, and the
 * dedupe and alphabetical order come from it rather than from a second copy.
 *
 * `oldEntry` is removed only when it is literally a line of the section. When
 * there is no section, or the old entry is not in it, this is an ordinary add.
 * And when the record's entry is already listed, the old line still goes:
 * leaving "Genghis Khan and the (2022)" under a list that now also carries
 * Weatherford is the orphan this exists to prevent.
 */
export function planEntryReplacement({
  text,
  oldEntry,
  entry,
  sourceTitle,
  style
}: {
  text: string
  oldEntry: string | null
  entry: string
  sourceTitle: string | null
  style: CitationStyle
}): { edit: TextEdit | null; outcome: EntryOutcome } {
  const section = findWorksCitedSection(text)
  const old = oldEntry?.trim() ?? ''
  const position = section && old ? section.entries.indexOf(old) : -1

  if (!section || position === -1) {
    const { edit } = planWorksCited({ text, entry, sourceTitle, style })
    return edit
      ? { edit: { start: edit.start, end: edit.end, replacement: edit.replacement }, outcome: 'added' }
      : { edit: null, outcome: 'already-listed' }
  }

  const remaining = section.entries.filter((_, i) => i !== position)
  const rest = `${section.heading}\n${remaining.join('\n')}`
  // Planned against the section alone, so the edit's own offsets are
  // irrelevant: whatever comes back IS the rewritten section.
  const { edit } = planWorksCited({ text: rest, entry, sourceTitle, style })
  return {
    edit: { start: section.start, end: section.end, replacement: edit ? edit.replacement : rest },
    outcome: edit ? 'replaced' : 'already-listed'
  }
}

// ── when the button belongs on the card at all ────────────────────────────

/**
 * Defects with no work behind them to look up.
 *
 * "(Unknown Author, 2025)" searched as text finds titles containing "unknown";
 * "[citation needed]" and a bare link name nothing. For these the card's action
 * stays "Fix the citation" — a topical search whose pick replaces the bad text.
 * A cut-off title and an impossible year both name a real work imperfectly,
 * which is exactly what the lookup is for.
 */
const NOTHING_TO_LOOK_UP: ReadonlySet<CitationDefectKind> = new Set<CitationDefectKind>([
  'placeholder-author',
  'placeholder-citation',
  'bare-url'
])

export function canLookUpDefect(kind: CitationDefectKind | null | undefined): boolean {
  return kind == null || !NOTHING_TO_LOOK_UP.has(kind)
}
