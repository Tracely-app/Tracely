/*
 * Ported from the desktop app's src/main/services/ai/sentenceSplit.test.ts: the same cases with the same
 * expectations, so the server's copy is held to the behaviour the desktop's
 * is. Only the import lines changed, plus the TypeScript annotations a .js
 * file cannot carry.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { splitSentences } from '../shared/sentenceSplit.js'

const texts = (input) => splitSentences(input).map((s) => s.text)

describe('splitSentences — a period is not always a sentence end', () => {
  it('keeps a citation whole when it contains an initial', () => {
    // The failure this was written for. Splitting inside the brackets severs
    // the source from the sentence that cites it: the half carrying the claim
    // then looks uncited, and gets told to add a citation it already has.
    deepStrictEqual(texts('Southeast Asia prioritizes Hokkien (Thomas R. Leinbach, 2026). Next one.'), [
      'Southeast Asia prioritizes Hokkien (Thomas R. Leinbach, 2026).',
      'Next one.'
    ])
    deepStrictEqual(texts('Governments use that gap (Gregory P. Margarian, 2022: 23). And then this.'), [
      'Governments use that gap (Gregory P. Margarian, 2022: 23).',
      'And then this.'
    ])
  })

  it('keeps a citation whole when it contains an abbreviated venue', () => {
    deepStrictEqual(texts('Athletes are not tested (J Sports Med., 2024). Another sentence.'), [
      'Athletes are not tested (J Sports Med., 2024).',
      'Another sentence.'
    ])
  })

  it('does not cut a sentence in half at a dotted abbreviation', () => {
    // "88% of international students in the U.S. have become less politically
    // involved" was split after "U.S.", so the relay was asked to find claims
    // in "have become less politically involved" on its own.
    deepStrictEqual(texts('88% of students in the U.S. have become less involved. Another.'), [
      '88% of students in the U.S. have become less involved.',
      'Another.'
    ])
    deepStrictEqual(texts('It was studied by Dr. Smith and confirmed later. Then this.'), [
      'It was studied by Dr. Smith and confirmed later.',
      'Then this.'
    ])
  })

  it('still splits ordinary sentences, quotes and headings', () => {
    deepStrictEqual(texts('First one. Second one.'), ['First one.', 'Second one.'])
    deepStrictEqual(texts('He said “it works.” Then he left.'), ['He said “it works.”', 'Then he left.'])
    deepStrictEqual(texts('First.\nSecond heading\nThird sentence.'), [
      'First.',
      'Second heading',
      'Third sentence.'
    ])
  })

  it('never emits a span that is not an exact substring of the input', () => {
    // claimSpans.ts computes underline offsets from these, so a span whose
    // text does not match its own start/end puts a mark over the wrong words.
    const input =
      'The U.S. rate rose (Smith, 2020). Dr. Chen disagreed (Chen et al., 2021: 14). Etc.\nA heading\nDone.'
    for (const span of splitSentences(input)) {
      strictEqual(input.slice(span.start, span.end).trim(), span.text)
    }
  })

  it('breaks after a footnote mark, which sits past the full stop', () => {
    // Found by `npm run eval:citations` on 05-chicago-notes.txt, where 13
    // sentences arrived as 10. `posted.²` put a non-space between the
    // terminator and the whitespace, so no boundary matched and every
    // footnoted sentence was returned glued to the one after it.
    //
    // Citations were how this surfaced, but detection is what it costs:
    // claimDetection.ts numbers these sentences and asks the model which
    // ones state a claim, so a merged pair shares one number and the
    // reconstructed span underlines both.
    deepStrictEqual(texts('Print spread fast.¹ Manuscripts did not.'), [
      'Print spread fast.¹',
      'Manuscripts did not.'
    ])
    deepStrictEqual(texts('He was the most published author.⁴ The gap was not close.'), [
      'He was the most published author.⁴',
      'The gap was not close.'
    ])
    // Mark before the terminator already worked; keep it working.
    deepStrictEqual(texts('Print spread fast².  Manuscripts did not.'), [
      'Print spread fast².',
      'Manuscripts did not.'
    ])
  })

  it('does not run the whole document together when brackets are unbalanced', () => {
    // Bracket depth is counted from the start of the current span, not the
    // document, so one stray "(" cannot disable splitting for everything after
    // it — which would hand the relay the entire text as a single claim.
    const spans = texts('An unclosed ( bracket here. And another sentence. And a third one.')
    ok(spans.length >= 2, `expected more than one span, got ${spans.length}`)
  })
})
