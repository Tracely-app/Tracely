import { describe, it } from 'node:test'
import { strictEqual } from 'node:assert/strict'
import {
  ASK_TRACER,
  FIND_CITED_WORK,
  SUGGEST_FIX,
  aboutTheCitation,
  insertsCitation,
  popoverRoute
} from './citationAction.ts'

/**
 * The four action strings `popoverCopyFor` can produce. Reword one there and it
 * must be reworded here — this test is what makes that a visible failure rather
 * than a silently disabled Insert button.
 */
describe('insertsCitation', () => {
  it('offers to insert only where the card is asking for a citation', () => {
    strictEqual(insertsCitation('Add citation'), true)
    strictEqual(insertsCitation('Find a source'), true)
  })

  // Fires on a claim the writer ALREADY cited. Offering to insert one
  // contradicts the sentence directly above the button.
  it('does not offer to insert when the card says to compare', () => {
    strictEqual(insertsCitation('Compare sources'), false)
  })

  // The card has just said these sources do not confirm the claim.
  it('does not offer to insert when the card says to review', () => {
    strictEqual(insertsCitation('Review the sources'), false)
  })

  it('defaults to not inserting for anything it does not recognise', () => {
    strictEqual(insertsCitation(''), false)
    strictEqual(insertsCitation('add citation'), false)
  })
})

describe('popoverRoute — one dispatch for both surfaces', () => {
  it('sends "Find the cited work" to the lookup', () => {
    strictEqual(popoverRoute(FIND_CITED_WORK), 'cited-work')
  })

  // The editor's off-topic card said "Ask Tracer" and opened the read-only
  // source list — a card about a tangent offering sources for it.
  it('sends "Ask Tracer" to Tracer, never to a source list', () => {
    strictEqual(popoverRoute(ASK_TRACER), 'tracer')
  })

  it('sends "Suggest fix" to the fix card', () => {
    strictEqual(popoverRoute(SUGGEST_FIX), 'fix')
  })

  it('inserts only where the card asks for a citation', () => {
    strictEqual(popoverRoute('Add citation'), 'insert')
    strictEqual(popoverRoute('Find a source'), 'insert')
    strictEqual(popoverRoute('Fix the citation'), 'insert')
  })

  // The overlay offered Insert under all three of these until 2026-10-06.
  it('opens the list read-only for compare, review and cite-it-yourself', () => {
    strictEqual(popoverRoute('Compare sources'), 'read-only')
    strictEqual(popoverRoute('Review the sources'), 'read-only')
    strictEqual(popoverRoute('Cite it yourself'), 'read-only')
  })
})

describe('aboutTheCitation — a pick must replace, never append', () => {
  it('covers the kinds about a citation already in the sentence', () => {
    strictEqual(aboutTheCitation('citation-defect', true), true)
    strictEqual(aboutTheCitation('fabricated-citation', true), true)
    strictEqual(aboutTheCitation('cited-unverified', true), true)
  })

  it('counts unsupported-by-evidence only when the sentence cites something', () => {
    strictEqual(aboutTheCitation('unsupported-by-evidence', true), true)
    strictEqual(aboutTheCitation('unsupported-by-evidence', false), false)
  })

  it('leaves the uncited kinds to insert', () => {
    strictEqual(aboutTheCitation('missing-citation', false), false)
    strictEqual(aboutTheCitation('no-sources', false), false)
  })
})
