import { describe, it } from 'node:test'
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { findCitationDefects, type CitationDefectKind } from './citationShape.ts'

/**
 * A wrong flag here tells a student their correct reference is broken, and a
 * student told that once stops reading citation warnings entirely. So the
 * negative cases carry the weight: real references in three styles, ordinary
 * parenthetical asides, and the two shapes that LOOK like defects and are not
 * ("Anonymous" is a real attribution; the same work cited twice in a paragraph
 * is normal).
 */

// Pinned rather than derived from the clock — a rule that changes answer on
// 1 January is a rule whose suite starts failing on 1 January.
const YEAR = 2026

const kinds = (text: string): CitationDefectKind[] =>
  findCitationDefects(text, YEAR).map((d) => d.kind)

describe('findCitationDefects — leaves real citations alone', () => {
  it('accepts the ordinary styles', () => {
    for (const text of [
      'Malnutrition produced lasting anaemia (Lähteenmäki, 2006).',
      'The ration fell to four hundred calories (Walker 2010).',
      'She described it in her own words (Spoto, 2006, p. 84).',
      'Two accounts agree on the figure (Paris, 1996; Walker, 2010).',
      'The revised edition carries a new preface (Shelley, 1831).',
      'Relief arrived in May (Hitchcock 2008, 112).'
    ]) {
      deepStrictEqual(findCitationDefects(text, YEAR), [], text)
    }
  })

  it('leaves ordinary parenthetical asides alone', () => {
    for (const text of [
      'She travelled to twenty countries in five years (an itinerary few would attempt).',
      'The tour raised more than the mailings had (see the figures below).',
      'Two biographers disagree (Walker and Paris).',
      'The claim rests on one account (Smith).'
    ]) {
      deepStrictEqual(findCitationDefects(text, YEAR), [], text)
    }
  })

  it('does not flag "Anonymous", which is a real attribution', () => {
    deepStrictEqual(findCitationDefects('The pamphlet circulated widely (Anonymous, 1789).', YEAR), [])
  })

  it('does not flag the same work cited twice in one paragraph', () => {
    const text =
      'The ration fell that winter (Walker, 2010). Relief convoys arrived only in May (Walker, 2010).'
    deepStrictEqual(findCitationDefects(text, YEAR), [])
  })
})

describe('findCitationDefects — placeholders', () => {
  it('flags an author that was never filled in', () => {
    for (const text of [
      'Hepburn raised money via silent dance performances (Unknown Author, 2025).',
      'The figure is disputed (Author Name, 2019).',
      'A later account says otherwise (TBD, 2020).'
    ]) {
      ok(kinds(text).includes('placeholder-author'), text)
    }
  })

  it('flags a note to self where a reference should be', () => {
    for (const text of [
      'The ration fell to four hundred calories [citation needed].',
      'Two accounts agree on this (citation).',
      'She said as much in an interview (add citation).'
    ]) {
      ok(kinds(text).includes('placeholder-citation'), text)
    }
  })

  it('flags a bare link standing in for a reference', () => {
    ok(kinds('The archive holds the letters (https://example.org/archive/1944).').includes('bare-url'))
  })
})

describe('findCitationDefects — a name cut off mid-phrase', () => {
  /**
   * The case that prompted it, verbatim from a student draft: a short title cut
   * at four words and pasted in as the citation. Owner, 2026-10-06: the card
   * said the sentence was not truthful and did nothing to find the work.
   */
  it('flags a citation whose name or title ends on a function word', () => {
    const text =
      'Some researchers have argued that literacy expanded in parts of the empire, but the extent remains uncertain (Genghis Khan and the, 2022).'
    const [defect] = findCitationDefects(text, YEAR)
    strictEqual(defect.kind, 'truncated')
    strictEqual(defect.text, '(Genghis Khan and the, 2022)')
    strictEqual(text.slice(defect.start, defect.end), defect.text)
    ok(/cut off/.test(defect.message))
  })

  it('catches the other dangling shapes, quoted titles included', () => {
    for (const text of [
      'The figure is contested (Smith and, 2020).',
      'The figure is contested (Smith &, 2020).',
      'The figure is contested ("The Effects of", 2020).',
      'The figure is contested (Okafor, 2019; History of the, 2021).',
      'The figure is contested (A Study of an, 2018, p. 4).'
    ]) {
      ok(kinds(text).includes('truncated'), text)
    }
  })

  it('leaves complete names and titles alone, however many function words they contain', () => {
    for (const text of [
      'Policy shifted after the review (Ministry of the Interior, 2020).',
      'Policy shifted after the review (Department of Health and Social Care, 2021).',
      'The trial was small (Smith and Jones, 2020).',
      'The trial was small (Smith et al., 2020).',
      'The trial was small (Paris, 1996; Walker, 2010).',
      // A capital A is part of the name, not an article left dangling.
      'Deficiency is common in the region (Vitamin A, 2019).',
      'The rollout followed the earlier scheme (Plan A, 2020).',
      // Prepositions are left out of the test on purpose: real titles end on them.
      'The essay borrows its title ("Something to Live For", 2015).'
    ]) {
      deepStrictEqual(findCitationDefects(text, YEAR), [], text)
    }
  })

  it('never reads a dated aside as a truncated citation', () => {
    for (const text of [
      'The rate rose sharply (in 2020).',
      'The rate rose sharply (Up from 2019).',
      'The rate rose sharply (The, 2020).',
      'The rate rose sharply (see the, 2020).'
    ]) {
      ok(!kinds(text).includes('truncated'), text)
    }
  })

  it('keeps the existing negatives clean: (Smith) and (Walker and Paris) carry no year', () => {
    deepStrictEqual(findCitationDefects('The claim rests on one account (Smith).', YEAR), [])
    deepStrictEqual(findCitationDefects('Two biographers disagree (Walker and Paris).', YEAR), [])
  })
})

describe('findCitationDefects — dates', () => {
  it('flags a year that has not happened yet', () => {
    const [defect] = findCitationDefects('A recent study confirms it (Walker, 2029).', YEAR)
    strictEqual(defect.kind, 'future-year')
    ok(defect.message.includes('2029'))
  })

  it('accepts the current year', () => {
    deepStrictEqual(findCitationDefects('A recent study confirms it (Walker, 2026).', YEAR), [])
  })

  // "n.d." is correct APA for a genuinely undated source, and the rubric has no
  // clause for citation FORMATTING — SOURCE USE asks only whether a source
  // supports the claim. Removed with the rubric scoping; see shared/rubric.ts.
  it('says nothing about an undated source', () => {
    deepStrictEqual(findCitationDefects('The page gives no date (Walker, n.d.).', YEAR), [])
  })
})

describe('findCitationDefects — duplicates, removed', () => {
  /**
   * This one was real and it was in the owner's own draft. It is gone anyway,
   * because a reference pasted twice is formatting and nothing in the rubric
   * asks for it — the honest cost of "ONLY flag stuff that comes out of this
   * list". If it should come back, the route is a new rubric clause, not a
   * widened EVIDENCE one.
   */
  it('says nothing about the same reference twice in a row', () => {
    const text =
      'She delivered newspapers and took messages to downed Allied flyers (Lähteenmäki, 2006) (Lähteenmäki, 2006).'
    deepStrictEqual(findCitationDefects(text, YEAR), [])
  })
})

describe('findCitationDefects — shape', () => {
  it('returns nothing for text with no citations', () => {
    deepStrictEqual(findCitationDefects('She delivered newspapers for the resistance.', YEAR), [])
    deepStrictEqual(findCitationDefects('', YEAR), [])
  })

  it('offsets slice back to the reference, and results are in document order', () => {
    const text = 'First (Unknown Author, 2025) and then (Walker, 2029) and finally [citation needed].'
    const defects = findCitationDefects(text, YEAR)
    strictEqual(defects.length, 3)
    for (const defect of defects) {
      strictEqual(text.slice(defect.start, defect.end), defect.text)
      ok(defect.message.trim().length > 0, defect.kind)
    }
    for (let i = 1; i < defects.length; i++) ok(defects[i].start >= defects[i - 1].start)
  })
})
