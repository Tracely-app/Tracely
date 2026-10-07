import { describe, it } from 'node:test'
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import {
  CITED_WORK_FLOOR,
  bookYear,
  canLookUpDefect,
  citationUsedElsewhere,
  personFromFullName,
  citationQueryText,
  citationTarget,
  citedWorkQueries,
  citedYearOf,
  lexicalMatch,
  matchWorksCitedEntry,
  planCitationReplacement,
  planEntryReplacement,
  rankCitedWorkRecords,
  withoutYears,
  yearMismatchLabel,
  type CitedWorkRecord
} from './citedWork.ts'

/** The sentence that prompted all of this, verbatim from a student draft. */
const GENGHIS =
  'Some researchers have argued that literacy expanded in parts of the empire, but the extent remains uncertain (Genghis Khan and the, 2022).'

const WEATHERFORD: CitedWorkRecord = {
  title: 'Genghis Khan and the Making of the Modern World',
  authors: ['Jack Weatherford'],
  year: 2004,
  venue: null,
  doi: null,
  url: 'https://openlibrary.org/works/OL1W',
  index: 'openlibrary'
}

describe('citation text', () => {
  it('reads the year the writer wrote', () => {
    strictEqual(citedYearOf('(Genghis Khan and the, 2022)'), 2022)
    strictEqual(citedYearOf('(Walker 2010a, p. 4)'), 2010)
    strictEqual(citedYearOf('(Shoup 45)'), null)
  })

  it('turns a citation into search text without its brackets, quotes or page', () => {
    strictEqual(citationQueryText('(Genghis Khan and the, 2022)'), 'Genghis Khan and the 2022')
    strictEqual(citationQueryText('("Later School Start Times", 2018, p. 12)'), 'Later School Start Times 2018')
  })

  it('strips every year from the scoring copy', () => {
    strictEqual(withoutYears('Genghis Khan and the 2022'), 'Genghis Khan and the')
    strictEqual(withoutYears('Weatherford 2004 Crown 1999b'), 'Weatherford Crown')
  })
})

describe('matchWorksCitedEntry — which reference-list line the citation points at', () => {
  const doc = [
    'Literacy spread unevenly (Genghis Khan and the, 2022). Trade routes mattered (Allsen, 2001).',
    '',
    'Works Cited',
    'Allsen, Thomas T. Culture and Conquest in Mongol Eurasia. Cambridge UP, 2001.',
    'Weatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004.'
  ].join('\n')

  it('finds the entry by the title words the citation carries', () => {
    strictEqual(
      matchWorksCitedEntry('(Genghis Khan and the, 2022)', doc),
      'Weatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004.'
    )
  })

  it('finds the entry by surname', () => {
    strictEqual(
      matchWorksCitedEntry('(Allsen, 2001)', doc),
      'Allsen, Thomas T. Culture and Conquest in Mongol Eurasia. Cambridge UP, 2001.'
    )
  })

  it('returns null when nothing in the list carries the citation', () => {
    strictEqual(matchWorksCitedEntry('(Morgan, 1986)', doc), null)
  })

  it('returns null when the document has no reference list', () => {
    strictEqual(matchWorksCitedEntry('(Allsen, 2001)', 'Just a paragraph (Allsen, 2001).'), null)
  })

  it('breaks a tie on the cited year, and refuses to guess when it cannot', () => {
    const two = [
      'Body text.',
      '',
      'References',
      'Smith, J. (2019). Rivers of the steppe. Steppe Press.',
      'Smith, J. (2021). Roads of the steppe. Steppe Press.'
    ].join('\n')
    strictEqual(matchWorksCitedEntry('(Smith, 2021)', two), 'Smith, J. (2021). Roads of the steppe. Steppe Press.')
    strictEqual(matchWorksCitedEntry('(Smith, 2015)', two), null)
    strictEqual(matchWorksCitedEntry('(Smith)', two), null)
  })

  it('matches a numbered marker to its numbered entry only', () => {
    const numbered = ['Body [2].', '', 'References', '[1] Allsen, T. Culture and Conquest. 2001.', '[2] Weatherford, J. Genghis Khan. 2004.'].join('\n')
    strictEqual(matchWorksCitedEntry('[2]', numbered), '[2] Weatherford, J. Genghis Khan. 2004.')
    strictEqual(matchWorksCitedEntry('[7]', numbered), null)
  })
})

describe('citedWorkQueries', () => {
  it('searches the matched entry when there is one, the citation otherwise', () => {
    const fromEntry = citedWorkQueries({
      citation: '(Genghis Khan and the, 2022)',
      entry: 'Weatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004.'
    })
    strictEqual(fromEntry.crossref[0], 'Weatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004.')
    const fromCitation = citedWorkQueries({ citation: '(Genghis Khan and the, 2022)' })
    deepStrictEqual(fromCitation.crossref, ['Genghis Khan and the 2022'])
    strictEqual(fromCitation.scoring, 'Genghis Khan and the')
    strictEqual(fromCitation.openLibrary, 'genghis khan')
  })

  it('uses the critique hint as one more query and nothing else', () => {
    const q = citedWorkQueries({
      citation: '(Genghis Khan and the, 2022)',
      hint: 'Weatherford, J. (2004). Genghis Khan and the Making of the Modern World. Crown.'
    })
    strictEqual(q.crossref.length, 2)
    // Scored against what the writer typed, never against the model's memory.
    strictEqual(q.scoring, 'Genghis Khan and the')
  })
})

describe('scoring — years excluded', () => {
  it('scores the record that carries the citation’s words', () => {
    const score = lexicalMatch('Genghis Khan and the', 'Genghis Khan and the Making of the Modern World Jack Weatherford')
    strictEqual(score, 1)
  })

  it('does not let a coincidental year lift an unrelated record over the floor', () => {
    // With the year in the scoring copy, "2022" would be the heaviest token and
    // a paper sharing only the year would score near half.
    const withYear = lexicalMatch('Morgan 2022', 'Grain prices in Lancashire 2022')
    const stripped = lexicalMatch(withoutYears('Morgan 2022'), 'Grain prices in Lancashire 2022')
    ok(withYear >= CITED_WORK_FLOOR, `with the year: ${withYear}`)
    ok(stripped < CITED_WORK_FLOOR, `stripped: ${stripped}`)
  })

  it('ranks records above the floor, best first, at most three, deduped', () => {
    const junk: CitedWorkRecord = { ...WEATHERFORD, title: 'Grain prices in Lancashire', authors: ['A. Brown'], index: 'crossref', doi: '10.1/x', url: null }
    const crossrefCopy: CitedWorkRecord = { ...WEATHERFORD, index: 'crossref', doi: null, url: null }
    const ranked = rankCitedWorkRecords([junk, WEATHERFORD, crossrefCopy], 'Genghis Khan and the')
    strictEqual(ranked.length, 1, 'the same title and year from both indexes is one record')
    strictEqual(ranked[0].record.title, WEATHERFORD.title)
    const many = Array.from({ length: 6 }, (_, i) => ({ ...WEATHERFORD, title: `Genghis Khan volume ${i + 1}`, year: 2000 + i }))
    strictEqual(rankCitedWorkRecords(many, 'Genghis Khan').length, 3)
  })
})

describe('yearMismatchLabel', () => {
  it('says both years when they differ', () => {
    strictEqual(yearMismatchLabel(2004, 2022), 'This record is from 2004; your citation says 2022')
  })

  it('reassures on a one-year gap, which is routine', () => {
    strictEqual(
      yearMismatchLabel(2021, 2022),
      'This record is from 2021; your citation says 2022. A year either way is normal.'
    )
  })

  it('says nothing when they agree or either is unknown', () => {
    strictEqual(yearMismatchLabel(2004, 2004), null)
    strictEqual(yearMismatchLabel(null, 2022), null)
    strictEqual(yearMismatchLabel(2004, null), null)
  })
})

describe('citationTarget — which citation a replacement may land on', () => {
  it('finds the one bracketed citation in the sentence', () => {
    deepStrictEqual(citationTarget(GENGHIS), { status: 'one', text: '(Genghis Khan and the, 2022)' })
  })

  it('refuses two citations in one sentence rather than guessing', () => {
    strictEqual(citationTarget('Trade grew (Allsen, 2001) and literacy spread (Genghis Khan and the, 2022).').status, 'several')
    strictEqual(citationTarget('Trade grew and literacy spread (Allsen, 2001; Morgan, 1986).').status, 'several')
  })

  it('uses the known defect text when the card has it, and refuses it twice', () => {
    deepStrictEqual(citationTarget(GENGHIS, '(Genghis Khan and the, 2022)'), {
      status: 'one',
      text: '(Genghis Khan and the, 2022)'
    })
    strictEqual(citationTarget('A (Unknown Author, 2025) and B (Unknown Author, 2025).', '(Unknown Author, 2025)').status, 'several')
  })

  it('leaves narrative citations and asides alone', () => {
    strictEqual(citationTarget('Weatherford (2004) argues literacy spread.').status, 'none')
    strictEqual(citationTarget('She travelled widely (an itinerary few would attempt).').status, 'none')
    deepStrictEqual(citationTarget('As MLA has it (Shoup 45).'), { status: 'one', text: '(Shoup 45)' })
  })
})

describe('planCitationReplacement — the marker half', () => {
  const text = `Intro sentence (Genghis Khan and the, 2022). ${GENGHIS}`
  const from = text.indexOf('Some researchers')
  const range = { from, to: text.length }

  it('writes the record’s marker over the citation, inside the card’s sentence only', () => {
    const edit = planCitationReplacement(text, range, '(Genghis Khan and the, 2022)', '(Weatherford, 2004)')
    ok(edit)
    strictEqual(edit.start, text.lastIndexOf('(Genghis Khan and the, 2022)'))
    const out = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
    ok(out.startsWith('Intro sentence (Genghis Khan and the, 2022).'), 'the other sentence is untouched')
    ok(out.endsWith('remains uncertain (Weatherford, 2004).'))
  })

  it('refuses when the citation is not in the sentence, or is in it twice', () => {
    strictEqual(planCitationReplacement(text, range, '(Allsen, 2001)', '(Weatherford, 2004)'), null)
    const twice = 'X (A, 2001) and (A, 2001).'
    strictEqual(planCitationReplacement(twice, { from: 0, to: twice.length }, '(A, 2001)', '(B, 2002)'), null)
  })
})

describe('planEntryReplacement — the reference-list half', () => {
  const NEW = 'Weatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004.'

  it('swaps the bad entry for the record’s, in one sorted section edit', () => {
    const text = [
      'Body (Genghis Khan and the, 2022).',
      '',
      'Works Cited',
      'Genghis Khan and the. 2022.',
      'Allsen, Thomas T. Culture and Conquest in Mongol Eurasia. Cambridge UP, 2001.'
    ].join('\n')
    const { edit, outcome } = planEntryReplacement({
      text,
      oldEntry: 'Genghis Khan and the. 2022.',
      entry: NEW,
      sourceTitle: 'Genghis Khan and the Making of the Modern World',
      style: 'MLA'
    })
    strictEqual(outcome, 'replaced')
    ok(edit)
    const out = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
    ok(!out.includes('Genghis Khan and the. 2022.'), 'the bad entry is gone')
    ok(out.endsWith(`Works Cited\nAllsen, Thomas T. Culture and Conquest in Mongol Eurasia. Cambridge UP, 2001.\n${NEW}`))
  })

  it('adds the entry when the document has no list, or the old one is not in it', () => {
    const plain = planEntryReplacement({ text: 'Body.', oldEntry: null, entry: NEW, sourceTitle: null, style: 'MLA' })
    strictEqual(plain.outcome, 'added')
    ok(plain.edit?.replacement.includes('Works Cited'))
  })

  it('still drops the old line when the record is already listed', () => {
    const text = ['Body.', '', 'Works Cited', 'Genghis Khan and the. 2022.', NEW].join('\n')
    const { edit, outcome } = planEntryReplacement({
      text,
      oldEntry: 'Genghis Khan and the. 2022.',
      entry: NEW,
      sourceTitle: 'Genghis Khan and the Making of the Modern World',
      style: 'MLA'
    })
    strictEqual(outcome, 'already-listed')
    ok(edit)
    const out = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
    strictEqual(out, ['Body.', '', 'Works Cited', NEW].join('\n'))
  })
})

describe('citationUsedElsewhere — keep an entry another sentence still points at', () => {
  const list = '\n\nWorks Cited\nGenghis Khan and the. 2022.'
  it('is true when the same citation sits in a second sentence', () => {
    ok(citationUsedElsewhere(`A (Genghis Khan and the, 2022). B (Genghis Khan and the, 2022).${list}`, '(Genghis Khan and the, 2022)'))
  })
  it('is false for the one sentence being fixed, and ignores the reference list', () => {
    ok(!citationUsedElsewhere(`A (Genghis Khan and the, 2022).${list}`, '(Genghis Khan and the, 2022)'))
    ok(!citationUsedElsewhere('A (X, 2001).', ''))
  })
})

describe('reading a record', () => {
  it('splits a full name into family and given, adding nothing', () => {
    deepStrictEqual(personFromFullName('Jack Weatherford'), { family: 'Weatherford', given: 'Jack' })
    deepStrictEqual(personFromFullName('Weatherford, Jack'), { family: 'Weatherford', given: 'Jack' })
    deepStrictEqual(personFromFullName('William Strunk, Jr.'), { family: 'Strunk', given: 'William Jr.' })
    deepStrictEqual(personFromFullName('Martin Luther King Jr'), { family: 'King', given: 'Martin Luther Jr' })
    deepStrictEqual(personFromFullName('Plato'), { family: 'Plato' })
  })

  it('prints the edition year the writer cited when the record has one', () => {
    strictEqual(bookYear(2004, [2004, 2005, 2022], 2022), 2022)
    strictEqual(bookYear(2004, [2004, 2005], 2022), 2004)
    strictEqual(bookYear(null, [2010, 2006], null), 2006)
    strictEqual(bookYear(null, [], 2022), null)
  })
})

describe('canLookUpDefect', () => {
  it('offers the lookup for a cut-off title or an impossible year, not for a placeholder', () => {
    ok(canLookUpDefect('truncated'))
    ok(canLookUpDefect('future-year'))
    ok(!canLookUpDefect('placeholder-author'))
    ok(!canLookUpDefect('placeholder-citation'))
    ok(!canLookUpDefect('bare-url'))
    ok(canLookUpDefect(null), 'no defect at all — a cited sentence the critique doubted')
  })
})
