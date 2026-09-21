/*
 * Ported from the desktop app's src/shared/paragraphSplit.test.ts: the same cases with the same
 * expectations, so the server's copy is held to the behaviour the desktop's
 * is. Only the import lines changed, plus the TypeScript annotations a .js
 * file cannot carry.
 */
import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bucketClaimsByParagraph,
  paragraphIndexAt,
  splitParagraphs
} from '../shared/paragraphSplit.js'

/** The invariant that makes spans safe to slice: no span is ever fabricated. */
function assertSpansAreRealSubstrings(text, spans) {
  for (const span of spans) {
    strictEqual(text.slice(span.start, span.end).trim(), span.text)
  }
}

describe('splitParagraphs — boundaries', () => {
  it('treats a single newline as a boundary', () => {
    // This is the contentEditable case: execCommand wraps each Enter in a
    // <div> and innerText renders that as one '\n'. If this test fails the
    // whole document collapses into one paragraph.
    const text = 'First paragraph.\nSecond paragraph.'
    deepStrictEqual(
      splitParagraphs(text).map((p) => p.text),
      ['First paragraph.', 'Second paragraph.']
    )
  })

  it('collapses a blank line into the same single boundary', () => {
    const text = 'First paragraph.\n\nSecond paragraph.'
    const spans = splitParagraphs(text)
    strictEqual(spans.length, 2)
    deepStrictEqual(
      spans.map((p) => p.text),
      ['First paragraph.', 'Second paragraph.']
    )
  })

  it('handles CRLF without leaving a carriage return in the span', () => {
    const text = 'One.\r\nTwo.\r\n\r\nThree.'
    const spans = splitParagraphs(text)
    deepStrictEqual(
      spans.map((p) => p.text),
      ['One.', 'Two.', 'Three.']
    )
    assertSpansAreRealSubstrings(text, spans)
  })

  it('drops whitespace-only lines rather than numbering them', () => {
    const text = 'One.\n   \n\t\nTwo.'
    const spans = splitParagraphs(text)
    deepStrictEqual(
      spans.map((p) => p.index),
      [1, 2]
    )
    deepStrictEqual(
      spans.map((p) => p.text),
      ['One.', 'Two.']
    )
  })
})

describe('splitParagraphs — degenerate input', () => {
  it('returns nothing for an empty string', () => {
    deepStrictEqual(splitParagraphs(''), [])
  })

  it('returns nothing for whitespace only', () => {
    deepStrictEqual(splitParagraphs('  \n\n \t \n'), [])
  })

  it('returns one span for a document with no newlines', () => {
    const spans = splitParagraphs('A single unbroken paragraph of prose.')
    strictEqual(spans.length, 1)
    strictEqual(spans[0].index, 1)
    strictEqual(spans[0].start, 0)
  })

  it('numbers spans from 1 with no gaps', () => {
    const spans = splitParagraphs('a\nb\nc\nd')
    deepStrictEqual(
      spans.map((p) => p.index),
      [1, 2, 3, 4]
    )
  })
})

describe('splitParagraphs — offsets', () => {
  it('every span is a real substring of the source', () => {
    const text = '  Leading space.\n\nMiddle one.\n\n\nTrailing.  '
    assertSpansAreRealSubstrings(text, splitParagraphs(text))
  })

  it('offsets are strictly increasing and non-overlapping', () => {
    const spans = splitParagraphs('One.\nTwo.\n\nThree.')
    for (let i = 1; i < spans.length; i++) {
      strictEqual(spans[i].start >= spans[i - 1].end, true)
    }
  })
})

describe('paragraphIndexAt', () => {
  const text = 'First paragraph here.\nSecond paragraph here.'
  const spans = splitParagraphs(text)

  it('finds the paragraph containing an offset', () => {
    strictEqual(paragraphIndexAt(spans, 0), 1)
    strictEqual(paragraphIndexAt(spans, 5), 1)
    strictEqual(paragraphIndexAt(spans, text.indexOf('Second')), 2)
  })

  it('returns null for an offset past the end', () => {
    strictEqual(paragraphIndexAt(spans, text.length + 10), null)
  })

  it('returns null rather than guessing for an offset in the gap', () => {
    // The '\n' itself belongs to no paragraph. Guessing here is how a claim
    // ends up attributed to the wrong paragraph.
    strictEqual(paragraphIndexAt(spans, text.indexOf('\n')), null)
  })
})

describe('bucketClaimsByParagraph', () => {
  const text = 'Intro claim here.\nBody claim here.\nFinal words here.'
  const spans = splitParagraphs(text)

  it('groups claims under the paragraph containing them', () => {
    const buckets = bucketClaimsByParagraph(spans, [
      { claimId: 'a', start: text.indexOf('Intro') },
      { claimId: 'b', start: text.indexOf('Body') },
      { claimId: 'c', start: text.indexOf('Final') }
    ])
    deepStrictEqual(buckets.get(1), ['a'])
    deepStrictEqual(buckets.get(2), ['b'])
    deepStrictEqual(buckets.get(3), ['c'])
  })

  it('keeps multiple claims in one paragraph, in order', () => {
    const buckets = bucketClaimsByParagraph(spans, [
      { claimId: 'first', start: text.indexOf('Body') },
      { claimId: 'second', start: text.indexOf('claim here.\nFinal') }
    ])
    deepStrictEqual(buckets.get(2), ['first', 'second'])
  })

  it('assigns a boundary-spanning claim to the paragraph it starts in', () => {
    // A sentence running across a break belongs to the paragraph it opens —
    // that is the one whose role it tells you something about.
    const buckets = bucketClaimsByParagraph(spans, [
      { claimId: 'spanning', start: text.indexOf('Body') }
    ])
    deepStrictEqual(buckets.get(2), ['spanning'])
    strictEqual(buckets.has(3), false)
  })

  it('drops a claim that lands in no paragraph rather than rounding it to 1', () => {
    // Rounding an unlocatable claim into paragraph 1 would inflate the thesis
    // component with a claim the student never put there.
    const buckets = bucketClaimsByParagraph(spans, [
      { claimId: 'nowhere', start: text.length + 50 },
      { claimId: 'in-the-gap', start: text.indexOf('\n') }
    ])
    strictEqual(buckets.size, 0)
  })

  it('returns an empty map for no claims', () => {
    strictEqual(bucketClaimsByParagraph(spans, []).size, 0)
  })
})
