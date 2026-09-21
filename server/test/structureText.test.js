/*
 * Ported from the desktop app's src/shared/structureText.test.ts: the same cases with the same
 * expectations, so the server's copy is held to the behaviour the desktop's
 * is. Only the import lines changed, plus the TypeScript annotations a .js
 * file cannot carry. The desktop imported
 * `node:assert`; this imports `node:assert/strict`, whose deepStrictEqual and
 * strictEqual are the same functions.
 */
import { describe, it } from 'node:test'
import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { argumentParagraphs } from '../shared/structureText.js'

/**
 * The bug this function exists to make unrepeatable: the classifier was sent
 * the reference list and the scorer was not, under a comment asserting they
 * were given the same thing.
 */
const ESSAY = [
  'More Than a Pretty Face: Audrey Hepburn',
  'Hepburn is remembered as a film star, but her humanitarian work reshaped celebrity advocacy.',
  'She delivered underground newspapers for the resistance (Walker, 2004). That involvement is what makes her later field visits read as continuity.',
  'Taken together, the records describe relief work that was continuous rather than a second act.'
].join('\n')

const REFERENCES = [
  'References',
  'Walker, A. (2004). Hepburn, Audrey. Oxford Dictionary of National Biography. https://doi.org/10.1093/ref:odnb/52107',
  'Paris, B. (1996). Audrey Hepburn. Putnam.',
  'Spoto, D. (2006). Enchantment: The Life of Audrey Hepburn. Harmony Books.'
].join('\n')

describe('argumentParagraphs', () => {
  it('drops the reference list', () => {
    const withRefs = argumentParagraphs(`${ESSAY}\n${REFERENCES}`)
    const without = argumentParagraphs(ESSAY)
    strictEqual(withRefs.length, without.length)
    deepStrictEqual(
      withRefs.map((p) => p.text),
      without.map((p) => p.text)
    )
  })

  it('leaves a draft with no reference list untouched', () => {
    strictEqual(argumentParagraphs(ESSAY).length, 4)
  })

  // The reason the misalignment never corrupted a role: works-cited is trimmed
  // as a SUFFIX, so the surviving paragraphs keep their indices. Pinned because
  // the scorer indexes the classifier's vector positionally.
  it('renumbers nothing — the surviving paragraphs keep their indices', () => {
    const spans = argumentParagraphs(`${ESSAY}\n${REFERENCES}`)
    deepStrictEqual(spans.map((s) => s.index), [1, 2, 3, 4])
  })

  it('returns nothing for an empty draft', () => {
    deepStrictEqual(argumentParagraphs(''), [])
    deepStrictEqual(argumentParagraphs('   \n  '), [])
  })
})
