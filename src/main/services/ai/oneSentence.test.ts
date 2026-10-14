import { test } from 'node:test'
import assert from 'node:assert/strict'
import { oneSentenceRevision, sentenceCount } from './oneSentence.ts'

// Owner, 2026-10-13: "it shouldnt replace more than one sentence at once".

test('one sentence for one sentence passes', () => {
  assert.equal(
    oneSentenceRevision('Social media causes depression in teenagers.', 'Some studies link heavy social media use to depression in teenagers.'),
    'Some studies link heavy social media use to depression in teenagers.'
  )
})

test('a revision of two sentences is dropped', () => {
  assert.equal(
    oneSentenceRevision('Social media causes depression.', 'Some studies link social media to depression. The link is debated.'),
    null
  )
})

test('a claim that spans two sentences gets no revision, however short the revision', () => {
  assert.equal(oneSentenceRevision('Prices rose. Wages fell.', 'Prices rose while wages fell.'), null)
})

test('an abbreviation is not a second sentence', () => {
  assert.equal(sentenceCount('Dr. Smith of the U.S. Army led it.'), 1)
  assert.equal(oneSentenceRevision('Dr. Smith won.', 'Dr. Smith of the U.S. Army won in 1944.'), 'Dr. Smith of the U.S. Army won in 1944.')
})

test('nothing in, nothing out', () => {
  assert.equal(oneSentenceRevision('A claim.', null), null)
  assert.equal(oneSentenceRevision('A claim.', undefined), null)
  assert.equal(oneSentenceRevision('A claim.', '   '), null)
})
