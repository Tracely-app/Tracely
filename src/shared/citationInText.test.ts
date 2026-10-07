import { describe, it } from 'node:test'
import { strictEqual } from 'node:assert/strict'
import { formatInTextCitation, shortTitle } from './citationInText.ts'
import type { Source } from './types.ts'

const src = (over: Partial<Source>): Source =>
  ({
    id: 's1',
    doi: null,
    title: 'A Title',
    authors: [],
    year: 2025,
    venue: null,
    venueType: null,
    url: null,
    pdfUrl: null,
    abstract: null,
    provider: 'crossref',
    providerId: null,
    citationCount: null,
    oaStatus: null,
    createdAt: '',
    ...over
  }) as Source

describe('formatInTextCitation — never a placeholder name', () => {
  it('uses the surname when there is a real author', () => {
    const s = src({ authors: [{ given: 'Kyla', family: 'Wahlstrom' }] })
    strictEqual(formatInTextCitation(s, 'APA'), '(Wahlstrom, 2025)')
    strictEqual(formatInTextCitation(s, 'MLA'), '(Wahlstrom)')
    strictEqual(formatInTextCitation(s, 'Chicago'), '(Wahlstrom, 2025)')
  })

  /**
   * The reported bug, verbatim. This produced "(Unknown Author, 2025)" over a
   * reference entry that correctly began with its title — the two halves of one
   * citation naming different things, and the half the reader follows naming
   * something that appears nowhere in the list.
   */
  it('falls back to the TITLE, never to a placeholder, when there is no author', () => {
    const s = src({
      title: 'Robert Hepburn and Adam Smith to [unknown], Thursday, 6 August 1789',
      authors: []
    })
    strictEqual(formatInTextCitation(s, 'APA'), '(“Robert Hepburn and Adam”, 2025)')
    strictEqual(formatInTextCitation(s, 'MLA'), '(“Robert Hepburn and Adam”)')
  })

  /**
   * Providers send placeholders as DATA, not as an empty list — measured on the
   * owner's own database. An empty list is only one of the shapes.
   */
  it('treats a placeholder author as no author', () => {
    for (const authors of [
      [{ family: 'Unknown' }],
      [{ given: 'Unknown', family: 'Author' }],
      [{ family: 'N/A' }]
    ]) {
      const out = formatInTextCitation(src({ authors, title: 'The Big Report' }), 'APA')
      strictEqual(out, '(“The Big Report”, 2025)', JSON.stringify(authors))
      strictEqual(out.includes('Unknown'), false)
    }
  })

  // "Anonymous" is a real attribution, not a placeholder — the same call
  // shared/placeholderAuthor.ts makes for the reference list.
  it('keeps Anonymous, which is an attribution', () => {
    strictEqual(formatInTextCitation(src({ authors: [{ family: 'Anonymous' }] }), 'MLA'), '(Anonymous)')
  })

  it('drops the year when there is none', () => {
    strictEqual(formatInTextCitation(src({ year: null, authors: [{ family: 'Shoup' }] }), 'APA'), '(Shoup)')
    strictEqual(formatInTextCitation(src({ year: null, title: 'Some Page' }), 'APA'), '(“Some Page”)')
  })

  // An institutional page with no title still files under its publisher.
  it('falls back to the venue when there is no title either', () => {
    strictEqual(formatInTextCitation(src({ title: '', venue: 'UNICEF' }), 'APA'), '(“UNICEF”, 2025)')
  })

  /**
   * Below the venue there is nothing to point a reader at. The year alone is a
   * poor marker and an honest one; inventing a word is the failure this file
   * exists to remove.
   */
  it('says the year rather than inventing a name', () => {
    strictEqual(formatInTextCitation(src({ title: '', venue: null }), 'APA'), '(2025)')
    strictEqual(formatInTextCitation(src({ title: '', venue: null, year: null }), 'APA'), '')
  })

  it('never emits the string this was reported for', () => {
    const shapes: Partial<Source>[] = [
      { authors: [] },
      { authors: [{ family: 'Unknown' }] },
      { authors: [{ given: 'Unknown', family: 'Author' }] },
      { title: '', authors: [] },
      { title: '', venue: null, authors: [], year: null }
    ]
    for (const over of shapes) {
      for (const style of ['APA', 'MLA', 'Chicago'] as const) {
        const out = formatInTextCitation(src(over), style)
        strictEqual(/unknown\s+author/i.test(out), false, `${style} ${JSON.stringify(over)} -> ${out}`)
      }
    }
  })
})

describe('shortTitle', () => {
  it('keeps a short title whole', () => {
    strictEqual(shortTitle('The Big Report'), 'The Big Report')
  })

  it('cuts a long one to the first few words', () => {
    strictEqual(
      shortTitle('Robert Hepburn and Adam Smith to [unknown], Thursday, 6 August 1789'),
      'Robert Hepburn and Adam'
    )
  })

  // The cut can land on punctuation, which would then sit inside the quotes.
  //
  // This pinned 'Screen time, sleep, and' until 2026-10-06 — a marker ending on
  // "and". That is the same shape as the "(Genghis Khan and the, 2022)" a
  // student pasted into a draft: a short title cut on a function word reads as
  // a typo and identifies nothing, so the cut now reaches on to the next word
  // that carries meaning, and the comma that lands there still comes off.
  it('drops punctuation left at the cut', () => {
    strictEqual(shortTitle('Screen time, sleep, and mood, in adolescents'), 'Screen time, sleep, and mood')
    strictEqual(shortTitle('A Title.'), 'A Title')
  })

  it('never ends on a function word — reaches forward to the next real word', () => {
    strictEqual(
      shortTitle('Genghis Khan and the Making of the Modern World'),
      'Genghis Khan and the Making'
    )
    strictEqual(shortTitle('A History of the World in 100 Objects'), 'A History of the World')
    strictEqual(shortTitle('Reading Lolita in Tehran: A Memoir in Books'), 'Reading Lolita in Tehran')
  })

  it('cuts back instead when nothing within reach carries meaning', () => {
    // Four function words after the cut — reaching for a fifth would drag the
    // marker halfway through the title, so it cuts back to the last real word.
    strictEqual(shortTitle('Sleep Loss and the of the of the Teenage Brain'), 'Sleep Loss')
  })

  it('treats a capitalised "A" as part of the title, not a dangling article', () => {
    strictEqual(shortTitle('Coverage of Plan A in Rural Districts'), 'Coverage of Plan A')
    strictEqual(shortTitle('Deficiency of Vitamin A among Young Children'), 'Deficiency of Vitamin A')
  })

  it('normalises whitespace and handles nothing', () => {
    strictEqual(shortTitle('  The   Big \n Report '), 'The Big Report')
    strictEqual(shortTitle(''), '')
    strictEqual(shortTitle('   '), '')
  })
})
