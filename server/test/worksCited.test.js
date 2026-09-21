/*
 * Ported from the desktop app's src/shared/worksCited.test.ts: the same cases with the same
 * expectations, so the server's copy is held to the behaviour the desktop's
 * is. Only the import lines changed, plus the TypeScript annotations a .js
 * file cannot carry.
 *
 * The planWorksCited cases (creating, deduping and ordering a list) are left
 * out with the function itself: shared/worksCited.js ports only the half
 * that FINDS a list, which is all withoutWorksCited needs. Every
 * findWorksCitedSection and withoutWorksCited case is here unchanged.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findWorksCitedSection,
  withoutWorksCited,
  WORKS_CITED_HEADINGS
} from '../shared/worksCited.js'

const MLA = 'Ionescu, Maria. “Grid-Scale Storage and Reliability.” Applied Energy, vol. 318, 2022, pp. 1–14.'
const APA = 'Ionescu, M. (2022). Grid-scale storage and reliability. Applied Energy, 318, 1–14.'
const OTHER = 'Bakker, Lena. “Curtailment in Northern Grids.” Renewable Energy, vol. 190, 2021, pp. 55–70.'

describe('findWorksCitedSection', () => {
  it('returns null for a draft with no reference list', () => {
    assert.equal(findWorksCitedSection('An essay about grids.\n\nIt ends here.'), null)
  })

  it('does not mistake prose that mentions references for a list', () => {
    // The heading test is anchored to a whole line for exactly this: a sentence
    // containing the word is prose, and treating it as a heading would put the
    // reference list in the middle of the essay.
    assert.equal(findWorksCitedSection('Prior references disagree about storage.'), null)
  })

  it('finds the heading and its entries', () => {
    const text = `Body paragraph.\n\nWorks Cited\n${MLA}\n${OTHER}`
    const section = findWorksCitedSection(text)
    assert.ok(section)
    assert.equal(section.heading, 'Works Cited')
    assert.deepEqual(section.entries, [MLA, OTHER])
    assert.equal(text.slice(section.start, section.start + 11), 'Works Cited')
  })

  it('accepts References and Bibliography, so a second list is never appended', () => {
    for (const heading of Object.values(WORKS_CITED_HEADINGS)) {
      const section = findWorksCitedSection(`Body.\n\n${heading}\n${APA}`)
      assert.ok(section, heading)
      assert.equal(section.heading, heading)
    }
  })

  it('ends at the last entry, not past the trailing blank lines', () => {
    const text = `Body.\n\nWorks Cited\n${MLA}\n\n\n`
    const section = findWorksCitedSection(text)
    assert.ok(section)
    assert.equal(text.slice(section.start, section.end), `Works Cited\n${MLA}`)
  })

  it('takes the LAST heading, so an essay about bibliographies still works', () => {
    const text = `A bibliography is a list.\n\nWorks Cited\n${MLA}`
    const section = findWorksCitedSection(text)
    assert.ok(section)
    assert.equal(section.heading, 'Works Cited')
  })
})

describe('withoutWorksCited', () => {
  it('trims the reference list so the argument score is not computed over it', () => {
    const text = `Intro.\n\nConclusion.\n\nWorks Cited\n${MLA}`
    assert.equal(withoutWorksCited(text), 'Intro.\n\nConclusion.\n\n')
  })

  it('is a suffix trim, so offsets before it are unchanged', () => {
    const text = `Intro.\n\nConclusion.\n\nWorks Cited\n${MLA}`
    const trimmed = withoutWorksCited(text)
    assert.equal(text.slice(0, trimmed.length), trimmed)
  })

  it('leaves a draft with no list alone', () => {
    assert.equal(withoutWorksCited('Intro.\n\nConclusion.'), 'Intro.\n\nConclusion.')
  })
})
