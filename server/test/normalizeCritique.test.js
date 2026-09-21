/*
 * Ported from the desktop app's src/main/services/ai/normalizeCritique.test.ts: the same cases with the same
 * expectations, so the server's copy is held to the behaviour the desktop's
 * is. Only the import lines changed, plus the TypeScript annotations a .js
 * file cannot carry. One server-only block is added at the end, and says why.
 */
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeCritique } from '../shared/normalizeCritique.js'

const base = {
  critique: 'The evidence supports a narrower version of this.',
  verdict: 'weak',
  suggestedRevision: null,
  citationFix: null
}

describe('normalizeCritique — tolerating a relay on a different deploy cadence', () => {
  it('fills fields an older relay cannot send', () => {
    const result = normalizeCritique({ critique: 'x', verdict: 'weak' })
    strictEqual(result.suggestedRevision, null)
    strictEqual(result.citationFix, null)
  })

  it('treats a blank revision as no revision', () => {
    strictEqual(normalizeCritique({ ...base, suggestedRevision: '   ' }).suggestedRevision, null)
  })

  it('trims a revision rather than passing whitespace into the document', () => {
    strictEqual(
      normalizeCritique({ ...base, suggestedRevision: '  People are generally harmful.  ' })
        .suggestedRevision,
      'People are generally harmful.'
    )
  })

  it('downgrades overstated with no revision, since the revision IS the finding', () => {
    const result = normalizeCritique({ ...base, verdict: 'overstated', suggestedRevision: null })
    strictEqual(result.verdict, 'weak')
  })

  it('keeps overstated when the revision is there', () => {
    const result = normalizeCritique({
      ...base,
      verdict: 'overstated',
      suggestedRevision: 'People are generally harmful to the environment.'
    })
    strictEqual(result.verdict, 'overstated')
  })

  it('never shows a citation fix beside a fabrication verdict', () => {
    // The two are mutually exclusive: one says the source does not exist, the
    // other corrects how it was written down. Showing both would have Tracely
    // reformat a reference it has just called invented.
    const result = normalizeCritique({
      ...base,
      verdict: 'fabricated',
      citationFix: 'Ramirez, A., & Doyle, B. (2024).'
    })
    strictEqual(result.citationFix, null)
    strictEqual(result.verdict, 'fabricated')
  })

  it('passes a citation fix through for any other verdict', () => {
    const result = normalizeCritique({
      ...base,
      verdict: 'partially-supported',
      citationFix: 'Shoup, Donald. The High Cost of Free Parking. APA Planners Press, 2005.'
    })
    strictEqual(result.citationFix, 'Shoup, Donald. The High Cost of Free Parking. APA Planners Press, 2005.')
  })
})

describe('a revision must narrow the claim, not replace it', () => {
  const claim =
    'GPT-5 class models now score above the median human rater on the AP English Language essay rubric, according to the vendor\'s own published evaluation.'

  it('drops a revision that swaps the subject, and the verdict falls to weak', () => {
    // Production, 2026-08-16. The evidence was about GPT-4, so the model
    // rewrote the sentence to be about GPT-4 — dropping the AP rubric and the
    // vendor citation with it. A student accepting that asserts something they
    // never claimed, about a different model, with the attribution removed.
    const result = normalizeCritique(
      {
        critique: 'x',
        verdict: 'overstated',
        suggestedRevision:
          'Recent large language models, such as GPT-4, have demonstrated scoring performance comparable to or sometimes exceeding the average human rater on academic English essay rubrics, according to published evaluations.',
        citationFix: null
      },
      claim
    )
    strictEqual(result.suggestedRevision, null)
    strictEqual(result.verdict, 'weak')
  })

  it('keeps a real hedge change, which introduces no new name', () => {
    const result = normalizeCritique(
      {
        critique: 'x',
        verdict: 'overstated',
        suggestedRevision: 'People are generally harmful to the environment.',
        citationFix: null
      },
      'People are 100% dangerous to the environment.'
    )
    strictEqual(result.suggestedRevision, 'People are generally harmful to the environment.')
    strictEqual(result.verdict, 'overstated')
  })

  it('allows a narrowing to DROP a named thing', () => {
    // One-directional on purpose: losing "three US states" for "some states" is
    // exactly what narrowing looks like. Only INTRODUCING a name is forbidden.
    const result = normalizeCritique(
      {
        critique: 'x',
        verdict: 'overstated',
        suggestedRevision: 'The policy reduced emissions in some states.',
        citationFix: null
      },
      'The policy reduced emissions in all 50 US states.'
    )
    strictEqual(result.suggestedRevision, 'The policy reduced emissions in some states.')
  })

  it('does not count the first word, which is capitalised by position', () => {
    const result = normalizeCritique(
      {
        critique: 'x',
        verdict: 'overstated',
        suggestedRevision: 'Many students report the effect.',
        citationFix: null
      },
      'Students always report the effect.'
    )
    strictEqual(result.suggestedRevision, 'Many students report the effect.')
  })

  it('keeps the pre-existing behaviour when no claim text is supplied', () => {
    const result = normalizeCritique(
      {
        critique: 'x',
        verdict: 'overstated',
        suggestedRevision: 'Something about GPT-4 entirely.',
        citationFix: null
      }
    )
    strictEqual(result.suggestedRevision, 'Something about GPT-4 entirely.')
  })
})

/**
 * The gate that stops Tracely calling a real source invented.
 *
 * Measured on the owner's own database, 2026-08-19: 15 of 89 stored verdicts
 * were `fabricated`, on an essay whose citations were real and merely missing
 * an author. `CRITIQUE_SYSTEM_PROMPT` already forbids this — "If the section is
 * absent, no lookup was possible … and (c) is unavailable" — and the model does
 * it anyway, which is why the rule is enforced here instead of asked for there.
 */
describe('fabricated requires a lookup to have run', () => {
  const fabricated = {
    critique: 'No work by these authors in this year could be found; the reference carries the marks of generation.',
    verdict: 'fabricated',
    suggestedRevision: null,
    citationFix: null
  }

  it('withdraws the verdict when nothing was searched', () => {
    const out = normalizeCritique(fabricated, 'A claim.', { referenceLookupRan: false })
    strictEqual(out.verdict, 'unsupported')
  })

  it('replaces the prose, because it describes a search that never happened', () => {
    const out = normalizeCritique(fabricated, 'A claim.', { referenceLookupRan: false })
    ok(!/fabricat|invent|could not be found/i.test(out.critique), out.critique)
    ok(out.critique.includes('could not check'))
  })

  it('keeps the verdict when a lookup really ran', () => {
    const out = normalizeCritique(fabricated, 'A claim.', { referenceLookupRan: true })
    strictEqual(out.verdict, 'fabricated')
    strictEqual(out.critique, fabricated.critique)
  })

  it('leaves every other verdict alone when no lookup ran', () => {
    for (const verdict of ['weak', 'unsupported', 'well-supported', 'partially-supported', 'contradicted']) {
      const out = normalizeCritique(
        { critique: 'Body.', verdict, suggestedRevision: null, citationFix: null },
        'A claim.',
        { referenceLookupRan: false }
      )
      strictEqual(out.verdict, verdict, verdict)
      strictEqual(out.critique, 'Body.', verdict)
    }
  })

  // Omitting the facts is the pre-2026-08-19 behaviour, retained so a caller
  // that has not been updated is not silently changed.
  it('assumes a lookup ran when no facts are given', () => {
    strictEqual(normalizeCritique(fabricated, 'A claim.').verdict, 'fabricated')
  })

  it('drops a revision along with the withdrawn verdict', () => {
    const out = normalizeCritique(
      { ...fabricated, suggestedRevision: 'A narrower claim.' },
      'A claim.',
      { referenceLookupRan: false }
    )
    strictEqual(out.suggestedRevision, null)
  })
})

/*
 * Server-only, and the one addition to the desktop's cases. The server now
 * normalizes a critique before it leaves, and the desktop normalizes it again
 * on arrival with the same claim and the same lookup fact. That is only safe
 * if a second pass changes nothing — a rule that fired twice (a revision
 * trimmed to a narrowing that then failed as one, a verdict downgraded a
 * second step) would make the desktop show something neither copy decided.
 */
describe('normalizing twice is the same as normalizing once', () => {
  const claim = 'The policy reduced emissions in all 50 US states.'
  const inputs = [
    { critique: 'x', verdict: 'overstated', suggestedRevision: '  The policy reduced emissions in some states.  ', citationFix: ' Fix. ' },
    { critique: 'x', verdict: 'overstated', suggestedRevision: 'The policy, per the EPA, reduced emissions.', citationFix: null },
    { critique: 'x', verdict: 'overstated', suggestedRevision: '   ', citationFix: null },
    { critique: 'x', verdict: 'fabricated', suggestedRevision: 'A narrower claim.', citationFix: 'Ramirez, A. (2024).' },
    { critique: 'x', verdict: 'partially-supported', suggestedRevision: null, citationFix: 'Shoup, D. (2005).' },
    { critique: 'x', verdict: 'weak' }
  ]
  for (const facts of [undefined, { referenceLookupRan: false }, { referenceLookupRan: true }]) {
    for (const input of inputs) {
      it(`${input.verdict}, lookup ${facts ? facts.referenceLookupRan : 'unstated'}`, () => {
        const once = normalizeCritique(input, claim, facts)
        deepStrictEqual(normalizeCritique(once, claim, facts), once)
      })
    }
  }
})
