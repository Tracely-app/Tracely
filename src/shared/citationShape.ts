/**
 * Defects visible in the SHAPE of an in-text citation, without reading anything.
 *
 * This is the free half of "is this citation any good?". The paid half is
 * `CRITIQUE_SYSTEM_PROMPT`'s Pass 2, which resolves the reference against
 * Crossref and Open Library and can tell a malformed reference from an invented
 * one. Nothing here can do that, and nothing here tries: every rule below is
 * about a reference that is visibly incomplete, contradictory or a placeholder
 * — the cases where the writer has not finished, rather than the cases where
 * the source does not exist.
 *
 * Why it earns its place beside the relay check: `claimsWithoutEvidence` now
 * declines to call a cited claim unsupported (2026-08-19), which is right, and
 * it means a broken citation is silent until the critique runs. The owner's own
 * draft carried "(Unknown Author, 2025)" one card below a real reference and
 * both went quiet together. These rules cost nothing and run on every analysis,
 * so the obviously-broken ones are named immediately.
 *
 * The bar, same as `proseIssues.ts`: a wrong flag here tells a student their
 * correct reference is broken, and a student who is told that once stops
 * reading citation warnings. So no rule fires on a reference that is merely
 * unusual — "(Smith)" with no year is incomplete in every style and is
 * deliberately NOT here, because "(see Smith)" and "(Smith and Jones)" are
 * ordinary prose parentheticals and nothing on the surface separates them.
 *
 * A leaf with no imports, so `npm test` can load it.
 */

export type CitationDefectKind =
  /** "(Unknown Author, 2025)", "(Author, 2020)" — the placeholder was never replaced. */
  | 'placeholder-author'
  /** "[citation needed]", "(source)", "(cite)" — a note to self left in the draft. */
  | 'placeholder-citation'
  /** A publication year later than the year the draft is being written in. */
  | 'future-year'
  /** A raw URL standing in for a reference. */
  | 'bare-url'
  /**
   * The name or title in the citation stops on a function word — "(Genghis
   * Khan and the, 2022)". A title cut off mid-phrase, usually by pasting a
   * short form that was itself cut at a word count. Nobody can look up "and
   * the", so like the three above it leaves no followable source.
   */
  | 'truncated'

export interface CitationDefect {
  kind: CitationDefectKind
  /** Offsets into the text passed in, so a caller can underline it. */
  start: number
  end: number
  /** The reference as written. */
  text: string
  /** What is wrong, in one line, addressed to the writer. */
  message: string
}

/**
 * Author names that are placeholders rather than people.
 *
 * "Anonymous" is deliberately absent. It is a real and correct attribution for
 * genuinely anonymous works — medieval texts, some government documents, survey
 * responses — and flagging it is the kind of confident wrongness that teaches a
 * writer to ignore the whole category.
 */
const PLACEHOLDER_AUTHORS =
  /\b(?:unknown(?: author)?|no author|author ?name|authorname|firstname|lastname|full ?name|your ?name|insert(?: author)?|tbd|todo|xxx+|n\/a|placeholder)\b/i

/** A parenthetical that is a note to self where a reference should be. */
const PLACEHOLDER_CITATION =
  /(?:\[\s*(?:citation needed|cite|ref|source|citation)\s*\]|\(\s*(?:citation needed|citation|insert citation|add citation|cite|cite this|ref|reference|source|sources)\s*\))/gi

/** A URL standing in for a reference, in text rather than in a reference list. */
const BARE_URL = /\(\s*(?:https?:\/\/|www\.)[^\s)]{4,}\s*\)/gi

/**
 * A parenthetical in-text citation, in the shapes real drafts use.
 *
 * Requires a year or a page number, which is what keeps ordinary parenthetical
 * asides out — see the header on why "(Smith)" is not a citation as far as this
 * module is concerned.
 */
const CITATION =
  /\((?:[^()]{0,90}?)\)/g

/** Does this parenthetical carry the marks of a reference at all? */
function looksLikeReference(inner: string): boolean {
  return /\b(?:1[5-9]|20)\d{2}[a-z]?\b/.test(inner) || /\bn\.?\s?d\.?\b/i.test(inner)
}

function yearsIn(inner: string): number[] {
  return [...inner.matchAll(/\b((?:1[5-9]|20)\d{2})[a-z]?\b/g)].map((m) => Number(m[1]))
}

/**
 * Words a name or title in a citation cannot END on.
 *
 * Deliberately short — articles, the three conjunctions and "of" — and
 * compared CASE-SENSITIVELY against the lowercase form. Title case leaves
 * exactly these lowercase, so "(Genghis Khan and the, 2022)" is caught while
 * "(Vitamin A, 2019)" and "(Plan A, 2020)" — where the capital "A" is part of
 * the name — are not. Prepositions are left out on purpose: a real title can
 * end on one ("Something to Live For"), and a wrong flag here costs more than
 * a missed one.
 */
const DANGLING_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'nor', 'of', '&'])

/**
 * One reference inside a parenthetical, split into the name part and the year.
 *
 * The COMMA before the year is required. "(Smith, 2020)" separates the two; a
 * parenthetical like "(Up from 2019)" has no comma and is prose about a date,
 * not a reference, so it never reaches the test below.
 */
const NAME_THEN_YEAR =
  /^\s*(.+?),\s*(?:1[5-9]|20)\d{2}[a-z]?(?:\s*[,:]\s*(?:pp?\.\s*)?\d+(?:\s*[–—-]\s*\d+)?)?\s*$/

/**
 * Does this parenthetical name a work in a way that stops mid-phrase?
 *
 * Each `;`-separated reference is tested on its own, so "(Paris, 1996; Walker,
 * 2010)" is two ordinary references. A name part has to START like a name — a
 * capital, or an opening quote before one — and run to at least two words, so
 * "(in 2020)" and a lone "(The, 2020)" are never read as a truncated citation.
 */
function truncatedReference(inner: string): boolean {
  return inner.split(';').some((part) => {
    const match = NAME_THEN_YEAR.exec(part)
    if (!match) return false
    const name = match[1].trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim()
    if (!/^\p{Lu}/u.test(name)) return false
    const words = name.split(/\s+/)
    if (words.length < 2) return false
    return DANGLING_WORDS.has(words[words.length - 1])
  })
}

/** The reference as written, normalised so two copies of it compare equal. */
function normalise(reference: string): string {
  return reference.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * `currentYear` is a parameter with a default rather than a `new Date()` call,
 * so the tests can pin it. A rule that changes answer on 1 January is a rule
 * whose test suite starts failing on 1 January.
 */
export function findCitationDefects(text: string, currentYear = new Date().getFullYear()): CitationDefect[] {
  const found: CitationDefect[] = []

  for (const match of text.matchAll(PLACEHOLDER_CITATION)) {
    found.push({
      kind: 'placeholder-citation',
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      message: 'This is a placeholder where a reference should be. It will read as a missing citation.'
    })
  }

  for (const match of text.matchAll(BARE_URL)) {
    found.push({
      kind: 'bare-url',
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      message:
        'A bare link is not a citation in any style. It needs an author, a year and a title, with the URL in the reference list.'
    })
  }

  // Kept in document order so `duplicated` can compare each reference with the
  // one before it.
  const references: Array<{ start: number; end: number; text: string; inner: string }> = []
  for (const match of text.matchAll(CITATION)) {
    const inner = match[0].slice(1, -1)
    if (!looksLikeReference(inner)) continue
    references.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      inner
    })
  }

  for (const [i, reference] of references.entries()) {
    if (PLACEHOLDER_AUTHORS.test(reference.inner)) {
      found.push({
        kind: 'placeholder-author',
        start: reference.start,
        end: reference.end,
        text: reference.text,
        message:
          'The author is a placeholder rather than a name. A reader cannot look this up, and a marker will read it as invented.'
      })
    }

    // A name or title cut off on a function word. Same class as a placeholder
    // author — there is no work a reader could look up from "and the" — which
    // is why it shares the EVIDENCE clause the others map to (see rubric.ts,
    // `malformed-citation`) rather than needing one of its own.
    if (truncatedReference(reference.inner)) {
      found.push({
        kind: 'truncated',
        start: reference.start,
        end: reference.end,
        text: reference.text,
        message: 'This citation looks cut off — the title or author is incomplete.'
      })
    }

    const later = yearsIn(reference.inner).filter((year) => year > currentYear)
    if (later.length > 0) {
      found.push({
        kind: 'future-year',
        start: reference.start,
        end: reference.end,
        text: reference.text,
        message: `This reference is dated ${later[0]}, which has not happened yet. Check the year against the source.`
      })
    }

    // The "n.d." and adjacent-duplicate rules were here. Removed 2026-08-19
    // with the rubric scoping, and they are the honest casualties of it — both
    // were real defects and I had just added them.
    //
    // Neither is on the list. SOURCE USE asks only whether a source SUPPORTS
    // the statement attributed to it, which no shape rule can answer; a
    // reference pasted twice and a correctly-formatted "n.d." are both
    // formatting, and GRAMMAR / MECHANICS says not to lean on typos. What
    // survives above is the subset that means there is no followable source at
    // ALL — a placeholder author, a bracketed note, a bare link, an impossible
    // year, a name cut off mid-phrase — which maps to EVIDENCE: "Flag
    // unsupported factual claims when factual support is expected."
    //
    // If duplicates should come back, the route is to add a clause to the
    // rubric, not to widen the EVIDENCE one to cover them.
  }

  return found.sort((a, b) => a.start - b.start)
}
