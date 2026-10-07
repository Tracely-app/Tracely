import { strictEqual, notStrictEqual, ok } from 'node:assert'
import { describe, it } from 'node:test'
import { NO_REVISION_BODY, OVERLAY_APPLY_NOTE, REVISION_RULE, fixTitle, tangentQuestion } from './fixFlowCopy.ts'

/*
 * Loadable by `npm test` only because every import in fixFlowCopy.ts is
 * type-only — the same constraint roles.ts and critiqueIssues.ts are written
 * under. Adding a value import there (a colour from problemCopy.ts, say) would
 * silently take this file out of the run.
 */

describe('the fix card names what to do, not what is wrong', () => {
  // The card replaces the problem statement inside the same popover, so a
  // header repeating the title the writer just read makes the button look like
  // it did nothing — which is the complaint the whole card exists to answer.
  it('does not repeat the problem label as its own header', () => {
    notStrictEqual(fixTitle('unsupported-by-evidence'), 'Weak reasoning')
    notStrictEqual(fixTitle('contradicted-claim'), 'Contradicted — check this fact')
    notStrictEqual(fixTitle('overstated-claim'), 'Overstated — narrow this')
  })

  // Overstatement is the only kind that arrives with a replacement sentence, so
  // it is the only one whose header can promise an edit. A shared header would
  // promise one for the two kinds that never have anything to apply.
  it('separates the kind that has a revision from the two that do not', () => {
    const overstated = fixTitle('overstated-claim')
    notStrictEqual(overstated, fixTitle('unsupported-by-evidence'))
    notStrictEqual(overstated, fixTitle('contradicted-claim'))
  })

  it('gives every kind a non-empty header, including ones that never open it', () => {
    for (const kind of ['unsupported-by-evidence', 'contradicted-claim', 'overstated-claim', 'missing-citation'] as const) {
      ok(fixTitle(kind).trim().length > 0, `empty title for ${kind}`)
    }
  })
})

describe('the card states its own limits', () => {
  // The one place Tracely puts words inside a student's sentence. A reader who
  // cannot see the constraint has no way to tell this from a ghostwriter, and
  // the product's whole position is that it is not one.
  it('says what a revision is allowed to change', () => {
    ok(/narrow/i.test(REVISION_RULE))
    ok(/quantifier/i.test(REVISION_RULE))
  })

  it('refuses to compose, rather than going quiet, when there is no revision', () => {
    ok(/will not write/i.test(NO_REVISION_BODY))
  })

  // Copy on the overlay is a limit of what that window can reach, not an
  // omission — it draws over another application read through UI Automation.
  it('tells the overlay reader why it cannot apply the revision for them', () => {
    ok(/does not edit other apps/i.test(OVERLAY_APPLY_NOTE))
  })
})

describe('the headers are stable strings', () => {
  it('returns the same header for the same kind', () => {
    strictEqual(fixTitle('overstated-claim'), fixTitle('overstated-claim'))
  })
})

describe('tangentQuestion — what "Ask Tracer" prefills for an off-topic paragraph', () => {
  it('quotes the paragraph and asks the cut-or-connect question', () => {
    const q = tangentQuestion('Lamine Yamal is 22 years old.')
    ok(q.includes('“Lamine Yamal is 22 years old.”'), q)
    ok(/cut it/.test(q) && /connect it/.test(q), q)
  })

  it('cuts a long paragraph on a word boundary', () => {
    const long = `${'word '.repeat(80)}end`
    const q = tangentQuestion(long, 50)
    ok(q.includes('…”'), q)
    ok(!q.includes('wor…'), 'never mid-word')
  })
})
