import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  hasRelevantSource,
  isRetrievalMiss,
  problemKindFor,
  problemKindsFor,
  problemSeverity
} from './problemKind.ts'

/**
 * A resolved search that returned `count` results, `count > 0` of which were
 * on topic.
 *
 * The two are separate inputs because retrieval separates them: it returns its
 * top eight for every claim whether or not any of them speak to it. Every case
 * below that used to write `count: 0` meant "nothing relevant came back", and
 * that is what it still means; `retrieved` covers the case the old shape could
 * not express at all — results came back, and none of them were about this.
 */
const found = (score: number, count: number): { score: number; count: number; hasRelevantSource: boolean } => ({
  score,
  count,
  hasRelevantSource: count > 0
})

/** Results came back and NONE of them cleared the relevance floor. */
const retrieved = (count: number): { score: number; count: number; hasRelevantSource: boolean } => ({
  score: 0,
  count,
  hasRelevantSource: false
})

const base = {
  claimType: 'factual' as const,
  hasInlineCitation: false,
  evidence: found(80, 5),
  critiqueVerdict: null
}

describe('problemKindFor', () => {
  it('says nothing is known until the search resolves', () => {
    strictEqual(problemKindFor({ ...base, evidence: null }), 'searching')
  })

  it('separates a factual contradiction from weak reasoning', () => {
    // CRITIQUE_SYSTEM_PROMPT reserves 'contradicted' for "a specific fact you
    // are confident is wrong". It used to fold into 'unsupported-by-evidence', which
    // printed "Weak reasoning" over the one verdict that is not about
    // reasoning — and ranked it below a citation problem.
    strictEqual(
      problemKindFor({ ...base, critiqueVerdict: 'contradicted' }),
      'contradicted-claim'
    )
    strictEqual(problemKindFor({ ...base, critiqueVerdict: 'weak' }), 'unsupported-by-evidence')
    strictEqual(problemKindFor({ ...base, critiqueVerdict: 'unsupported' }), 'unsupported-by-evidence')
  })

  it('ranks a contradicted fact above everything else, including a bad citation', () => {
    ok(problemSeverity('contradicted-claim') < problemSeverity('cited-unverified'))
    ok(problemSeverity('contradicted-claim') < problemSeverity('unsupported-by-evidence'))
    deepStrictEqual(
      problemKindsFor({ ...base, hasInlineCitation: true, evidence: found(0, 0), critiqueVerdict: 'contradicted' })[0],
      'contradicted-claim'
    )
  })

  // Both kinds were in the union and missing from SEVERITY, so indexOf gave
  // -1 and the sort put them FIRST — a placeholder author outranked an invented
  // source, a tangent outranked a wrong fact. These pin the positions the kinds'
  // own doc comments state. (Leaving one out of SEVERITY is now a type error.)
  it('ranks a malformed reference directly under an invented one, not above it', () => {
    deepStrictEqual(
      problemKindsFor({ ...base, hasInlineCitation: true, citationDefect: 'placeholder author', critiqueVerdict: 'fabricated' }).slice(0, 2),
      ['fabricated-citation', 'citation-defect']
    )
    strictEqual(problemSeverity('citation-defect'), problemSeverity('fabricated-citation') + 1)
  })

  it('ranks a tangent under a wrong fact and above every support finding', () => {
    deepStrictEqual(
      problemKindsFor({ ...base, onTopic: false, critiqueVerdict: 'contradicted' }).slice(0, 2),
      ['contradicted-claim', 'off-topic']
    )
    ok(problemSeverity('off-topic') < problemSeverity('cited-unverified'))
    ok(problemSeverity('off-topic') < problemSeverity('unsupported-by-evidence'))
  })

  it('gives every kind a real rank', () => {
    for (const kind of ['citation-defect', 'off-topic', 'fabricated-citation', 'contradicted-claim', 'searching'] as const) {
      ok(problemSeverity(kind) >= 0, `${kind} is unranked and would sort first`)
    }
  })

  it('puts reasoning above evidence, however well sourced', () => {
    // The point of the ordering: a claim can be perfectly well sourced and
    // still not follow from what those sources say.
    strictEqual(
      problemKindFor({ ...base, evidence: found(95, 8), critiqueVerdict: 'weak' }),
      'unsupported-by-evidence'
    )
  })

  it('does not treat a sound verdict as a problem', () => {
    strictEqual(problemKindFor({ ...base, critiqueVerdict: 'sound' }), 'missing-citation')
  })

  it('separates an unfindable number from an unfindable assertion', () => {
    strictEqual(
      problemKindFor({ ...base, claimType: 'statistic', evidence: found(0, 0) }),
      'unverified-statistic'
    )
    strictEqual(problemKindFor({ ...base, evidence: found(0, 0) }), 'no-sources')
  })

  it('bands evidence on the same 70/40 thresholds as the rest of the app', () => {
    strictEqual(problemKindFor({ ...base, evidence: found(39, 4) }), 'weak-evidence')
    strictEqual(problemKindFor({ ...base, evidence: found(40, 4) }), 'partial-evidence')
    strictEqual(problemKindFor({ ...base, evidence: found(69, 4) }), 'partial-evidence')
    strictEqual(problemKindFor({ ...base, evidence: found(70, 4) }), 'missing-citation')
  })

  it('never says "missing citation" about a sentence that has one', () => {
    // The complaint that started all of this. A cited claim that IS supported
    // is filtered out upstream as settled and never reaches this function.
    strictEqual(problemKindFor({ ...base, hasInlineCitation: false }), 'missing-citation')
  })

  it('separates a wrong citation from thin evidence', () => {
    // The alarming case: the writer attributed it, the critique read the work
    // they named, and it does not carry what they attributed. It used to fall
    // into weak-evidence, whose copy never mentions the citation at all.
    strictEqual(
      problemKindFor({
        ...base,
        hasInlineCitation: true,
        evidence: found(22, 5),
        critiqueVerdict: 'weak',
        // The critique had the work they named in front of it. Without this the
        // verdict is about the topical search — see citedWorkRead.
        citedWorkRead: true
      }),
      'cited-unverified'
    )
    // Uncited at the same score is a different problem with different advice,
    // and needs no critique to raise: with no citation there is no source of
    // the writer's for retrieval to be talking past.
    strictEqual(
      problemKindFor({ ...base, hasInlineCitation: false, evidence: found(22, 5) }),
      'weak-evidence'
    )
  })

  it('says nothing about a cited claim the databases had no opinion on', () => {
    // Zero results is not a finding about a sentence that is already
    // attributed. The search corpus is four ACADEMIC APIs; a policy paper
    // cites UN pages, government programmes and newspapers, none of which they
    // index. Reporting that as "Citation may not support this" is asserting
    // something nobody checked — and on a well-cited essay it fired on nearly
    // every line.
    deepStrictEqual(
      problemKindsFor({ ...base, hasInlineCitation: true, evidence: found(0, 0) }),
      []
    )
    deepStrictEqual(
      problemKindsFor({
        ...base,
        claimType: 'statistic',
        hasInlineCitation: true,
        evidence: found(0, 0)
      }),
      []
    )
    // Uncited and unfindable is still a real finding: nothing was attributed,
    // and nothing was found.
    deepStrictEqual(
      problemKindsFor({ ...base, hasInlineCitation: false, evidence: found(0, 0) }),
      ['no-sources']
    )
  })

  it('ranks a wrong citation above every other problem', () => {
    ok(problemSeverity('cited-unverified') < problemSeverity('unsupported-by-evidence'))
  })
})

describe('problemKindsFor — a sentence can be in more than one kind of trouble', () => {
  it('reports reasoning AND the citation gap together', () => {
    deepStrictEqual(problemKindsFor({ ...base, critiqueVerdict: 'weak' }), [
      'unsupported-by-evidence',
      'missing-citation'
    ])
  })

  it('reports a cited statistic whose sources do not carry it as both', () => {
    // Sources came back and they score badly for this figure — that is two
    // facts, and the second is what tells the writer which part to check.
    // Zero results is deliberately NOT this case; see the test above.
    deepStrictEqual(
      problemKindsFor({
        ...base,
        claimType: 'statistic',
        hasInlineCitation: true,
        evidence: found(12, 4),
        // Needed now: retrieval alone says nothing about a citation nothing has
        // read. The critique is what opens the work the writer named — and must
        // be recorded as having done so.
        critiqueVerdict: 'unsupported',
        citedWorkRead: true
      }),
      // Both, in severity order: the citation finding leads, and the verdict
      // that produced it is reported too. `unsupported` over evidence that IS
      // on topic is a finding about the reasoning — see isRetrievalMiss.
      ['cited-unverified', 'unsupported-by-evidence']
    )
  })

  it('does not double-report thin evidence for a cited claim', () => {
    // cited-unverified already says it, with the right advice.
    deepStrictEqual(
      problemKindsFor({
        ...base,
        hasInlineCitation: true,
        evidence: found(20, 5),
        critiqueVerdict: 'weak',
        citedWorkRead: true
      }),
      ['unsupported-by-evidence', 'cited-unverified'].sort(
        (a, b) => problemSeverity(a as never) - problemSeverity(b as never)
      )
    )
  })

  it('returns nothing at all for a cited, well-supported claim', () => {
    // Filtered out upstream as settled; this is the same judgement from here.
    deepStrictEqual(problemKindsFor({ ...base, hasInlineCitation: true }), [])
  })

  it('makes searching the sole kind, since nothing else is known', () => {
    deepStrictEqual(problemKindsFor({ ...base, evidence: null }), ['searching'])
  })

  it('always orders worst first, so the card shows the right one', () => {
    const kinds = problemKindsFor({ ...base, critiqueVerdict: 'contradicted' })
    strictEqual(kinds[0], 'contradicted-claim')
    strictEqual(problemKindFor({ ...base, critiqueVerdict: 'contradicted' }), kinds[0])
  })
})

describe('problemSeverity', () => {
  it('ranks reasoning and unfindable numbers above a tidy claim wanting a citation', () => {
    ok(problemSeverity('unsupported-by-evidence') < problemSeverity('missing-citation'))
    ok(problemSeverity('unverified-statistic') < problemSeverity('partial-evidence'))
  })

  it('puts an unresolved search last, since nothing is known about it yet', () => {
    ok(problemSeverity('searching') > problemSeverity('missing-citation'))
  })

  it('gives every kind a place, so nothing sorts to -1 and jumps to the top', () => {
    const kinds = [
      'searching',
      'contradicted-claim',
      'unsupported-by-evidence',
      'unverified-statistic',
      'no-sources',
      'weak-evidence',
      'partial-evidence',
      'missing-citation',
      'cited-unverified'
    ] as const
    for (const kind of kinds) ok(problemSeverity(kind) >= 0, `${kind} is unranked`)
  })
})

describe('fabricated-citation — a source that does not exist', () => {
  it('outranks a contradicted fact, the previous worst', () => {
    ok(
      problemSeverity('fabricated-citation') < problemSeverity('contradicted-claim'),
      'an invented source must sort above a wrong fact'
    )
  })

  it('is the sole reasoning kind, never doubled with weak-reasoning', () => {
    const kinds = problemKindsFor({ ...base, critiqueVerdict: 'fabricated' })
    strictEqual(kinds.filter((k) => k === 'unsupported-by-evidence').length, 0)
    strictEqual(kinds[0], 'fabricated-citation')
  })

  it('fires for a cited sentence, which is the only way it can happen', () => {
    // The writer attributed it. That is what makes the verdict possible and
    // what makes it serious — before this verdict existed the sentence landed
    // in 'unsupported', which reads back as "may still be true".
    strictEqual(
      problemKindFor({
        ...base,
        hasInlineCitation: true,
        evidence: found(0, 0),
        critiqueVerdict: 'fabricated'
      }),
      'fabricated-citation'
    )
  })

  it('is not suppressed by a strong evidence score elsewhere in the sentence', () => {
    strictEqual(
      problemKindFor({
        ...base,
        hasInlineCitation: true,
        evidence: found(95, 8),
        critiqueVerdict: 'fabricated'
      }),
      'fabricated-citation'
    )
  })
})

describe('overstated-claim — defensible substance, indefensible quantifier', () => {
  it('is not folded in with weak reasoning', () => {
    const kinds = problemKindsFor({ ...base, critiqueVerdict: 'overstated' })
    strictEqual(kinds.includes('unsupported-by-evidence'), false)
    strictEqual(kinds[0], 'overstated-claim')
  })

  it('outranks every evidence finding, since no source can fix a quantifier', () => {
    for (const kind of ['unverified-statistic', 'no-sources', 'weak-evidence', 'partial-evidence'] as const) {
      ok(
        problemSeverity('overstated-claim') < problemSeverity(kind),
        `overstated-claim should outrank ${kind}`
      )
    }
  })

  it('still ranks below the two findings about truth', () => {
    ok(problemSeverity('overstated-claim') > problemSeverity('contradicted-claim'))
    ok(problemSeverity('overstated-claim') > problemSeverity('fabricated-citation'))
  })

  it('survives a zero evidence score — the problem is the wording, not the sourcing', () => {
    strictEqual(
      problemKindFor({ ...base, evidence: found(0, 0), critiqueVerdict: 'overstated' }),
      'overstated-claim'
    )
  })
})

describe('unsupported — a verdict about the claim, or about the search?', () => {
  // eval/critique/FINDINGS.md, 2026-08-16. Two of the five `unsupported`
  // verdicts in that run were reached with nothing on topic retrieved, and both
  // were on sentences that are true and properly hedged. The product printed
  // "Weak reasoning" over them.
  it('does not call a sentence weak because the search came back empty', () => {
    const kinds = problemKindsFor({ ...base, evidence: found(0, 0), critiqueVerdict: 'unsupported' })
    strictEqual(kinds.includes('unsupported-by-evidence'), false, 'a retrieval miss is not a reasoning finding')
    // Reported honestly instead — same state, and the copy for this one says
    // "It may still be true — but you have nothing to cite for it yet."
    deepStrictEqual(kinds, ['no-sources'])
  })

  it('still calls it weak when there WAS on-topic evidence to read', () => {
    // The half of `unsupported` that is a real finding: the critique had
    // relevant sources in front of it and they do not carry the claim.
    deepStrictEqual(
      problemKindsFor({ ...base, evidence: found(30, 6), critiqueVerdict: 'unsupported' }),
      ['unsupported-by-evidence', 'weak-evidence']
    )
  })

  it('says nothing at all about a cited sentence nothing was found for', () => {
    // Already attributed, and the academic corpus has no opinion. Neither half
    // of that is a finding about the writing.
    deepStrictEqual(
      problemKindsFor({
        ...base,
        hasInlineCitation: true,
        evidence: found(0, 0),
        critiqueVerdict: 'unsupported'
      }),
      []
    )
  })

  it('gates only `unsupported`, never `weak`', () => {
    // `weak` is a judgement about how the argument is made, which is readable
    // from the sentence itself. Only `unsupported` is the word doing two jobs.
    deepStrictEqual(
      problemKindsFor({ ...base, evidence: found(0, 0), critiqueVerdict: 'weak' }),
      ['unsupported-by-evidence', 'no-sources']
    )
  })

  it('leaves the three truth verdicts alone, however empty the search', () => {
    for (const verdict of ['fabricated', 'contradicted', 'overstated'] as const) {
      strictEqual(
        problemKindsFor({ ...base, evidence: found(0, 0), critiqueVerdict: verdict }).length > 0,
        true,
        `${verdict} asserts something about the claim and must survive an empty search`
      )
    }
  })
})

describe('results returned vs results that are about the claim', () => {
  // The bug this separation exists for. The aggregator merges four providers
  // down to its top eight and returns eight for every claim in the app, so the
  // overlay's `count === 0` test for "nothing found" was unreachable — eight
  // papers about other subjects read as eight sources.
  it('reports eight off-topic results as no sources, not as weak evidence', () => {
    deepStrictEqual(problemKindsFor({ ...base, evidence: retrieved(8) }), ['no-sources'])
  })

  it('does not accuse a cited sentence over eight off-topic results', () => {
    // 'cited-unverified' says "your citation may not support this". Saying it
    // because a search of the wrong corpus came back empty is the accusation
    // problemKind's own comments say it must not make.
    deepStrictEqual(problemKindsFor({ ...base, hasInlineCitation: true, evidence: retrieved(8) }), [])
  })

  it('reads the relevance floor off the breakdown, not the result count', () => {
    strictEqual(hasRelevantSource(null), false)
    strictEqual(hasRelevantSource({ sourceCount: 0, quality: 1, recency: 1, relevance: 0, support: 0 }), false)
    strictEqual(hasRelevantSource({ sourceCount: 0.167, quality: 0, recency: 0, relevance: 0, support: 0 }), true)
  })

  it('names a retrieval miss only for the one verdict that is ambiguous', () => {
    strictEqual(isRetrievalMiss('unsupported', false), true)
    strictEqual(isRetrievalMiss('unsupported', true), false)
    strictEqual(isRetrievalMiss('weak', false), false)
    strictEqual(isRetrievalMiss('contradicted', false), false)
    strictEqual(isRetrievalMiss(null, false), false)
  })
})

describe('outside-index — what four academic indexes were never going to hold', () => {
  const empty = { ...base, evidence: retrieved(8) }

  it('replaces "no sources" rather than joining it', () => {
    // Both together would print "No supporting sources" underneath the line
    // that exists to withdraw exactly that accusation.
    deepStrictEqual(problemKindsFor({ ...empty, outOfIndexScope: 'primary-text' }), [
      'outside-index'
    ])
  })

  it('replaces "unverified statistic" too', () => {
    deepStrictEqual(
      problemKindsFor({ ...empty, claimType: 'statistic', outOfIndexScope: 'local-fact' }),
      ['outside-index']
    )
  })

  it('leaves the old wording alone when the claim was in scope', () => {
    deepStrictEqual(problemKindsFor({ ...empty, outOfIndexScope: null }), ['no-sources'])
    deepStrictEqual(problemKindsFor(empty), ['no-sources'])
  })

  /**
   * Scope only ever decides what an EMPTY result set is called. A close reading
   * of a novel that turns out to have criticism written about it is scored on
   * that criticism like anything else — the sentence is reachable after all,
   * and saying otherwise over sources we are holding would be its own lie.
   */
  it('changes nothing when evidence was actually found', () => {
    deepStrictEqual(
      problemKindsFor({ ...base, evidence: found(85, 6), outOfIndexScope: 'primary-text' }),
      ['missing-citation']
    )
    deepStrictEqual(
      problemKindsFor({ ...base, evidence: found(20, 4), outOfIndexScope: 'legal-text' }),
      ['weak-evidence']
    )
  })

  it('says nothing at all about a cited claim, as it already did', () => {
    deepStrictEqual(
      problemKindsFor({ ...empty, hasInlineCitation: true, outOfIndexScope: 'legal-text' }),
      []
    )
  })

  it('never outranks a finding there is something to say about', () => {
    // A contradicted fact in a sentence the databases cannot check is still a
    // contradicted fact, and it must lead the card and the widget's ordering.
    const kinds = problemKindsFor({
      ...empty,
      critiqueVerdict: 'contradicted',
      outOfIndexScope: 'prediction'
    })
    strictEqual(kinds[0], 'contradicted-claim')
    ok(kinds.includes('outside-index'))
    ok(problemSeverity('outside-index') > problemSeverity('missing-citation'))
  })
})

/**
 * The rule the owner has asked for twice: if the source the writer cited is
 * credible and matches, do not flag the sentence because OTHER sources do not.
 */
describe('a cited claim is not flagged by what other papers say', () => {
  /**
   * The reported case, exactly. A student cites Wikipedia; Wikipedia bears the
   * claim out. Tracely searches four ACADEMIC indexes, finds eight journal
   * articles about something adjacent, scores them 22/100, and prints
   * "Citation may not support this" over a correctly-sourced sentence.
   *
   * The retrieval score is a fact about the literature. Nothing in the
   * retrieval path ever opens the work the writer named.
   */
  it('says nothing when the search disagrees but nothing read the citation', () => {
    deepStrictEqual(
      problemKindsFor({ ...base, hasInlineCitation: true, evidence: found(22, 8) }),
      []
    )
  })

  it('says nothing in the middle band either', () => {
    deepStrictEqual(
      problemKindsFor({ ...base, hasInlineCitation: true, evidence: found(55, 8) }),
      []
    )
  })

  it('stays silent when the critique read the citation and agreed', () => {
    for (const verdict of ['well-supported', 'partially-supported'] as const) {
      deepStrictEqual(
        problemKindsFor({
          ...base,
          hasInlineCitation: true,
          evidence: found(22, 8),
          critiqueVerdict: verdict
        }),
        [],
        `${verdict} should not be overruled by a retrieval score`
      )
    }
  })

  it('still speaks when the critique read the citation and doubted it', () => {
    ok(
      problemKindsFor({
        ...base,
        hasInlineCitation: true,
        evidence: found(22, 8),
        critiqueVerdict: 'weak',
        citedWorkRead: true
      }).includes('cited-unverified')
    )
  })

  /**
   * The same verdict, with the one fact that licenses it removed.
   *
   * Owner, 2026-08-19: *"It doesn't matter what the other five sources found;
   * as long as that specific source backs up their evidence, don't flag it."*
   * A `weak` reached without the writer's source in hand IS a verdict about
   * those other sources, whatever word came back — so neither the citation
   * finding nor the evidence-fit one may be raised over their sentence.
   */
  it('says nothing when the critique never opened the cited work', () => {
    for (const read of [false, null] as const) {
      deepStrictEqual(
        problemKindsFor({
          ...base,
          hasInlineCitation: true,
          evidence: found(22, 8),
          critiqueVerdict: 'weak',
          citedWorkRead: read
        }),
        [],
        `citedWorkRead: ${read}`
      )
    }
  })

  /**
   * An UNCITED sentence is untouched by all of this. There the searched
   * sources are not a fallback for a citation, they ARE the evidence, and a
   * verdict over them is exactly what the card should report.
   */
  it('leaves an uncited claim on the evidence path regardless', () => {
    ok(
      problemKindsFor({
        ...base,
        hasInlineCitation: false,
        evidence: found(22, 8),
        critiqueVerdict: 'weak',
        citedWorkRead: null
      }).includes('unsupported-by-evidence')
    )
  })

  /**
   * `overstated` is deliberately not a doubting verdict. It is a finding about
   * the sentence's quantifier, not about its source — the citation can be
   * impeccable and the sentence still say "always" — so adding "your citation
   * may not support this" underneath would send the writer looking for a better
   * source for a wording problem.
   */
  it('does not treat an overstatement as doubt about the citation', () => {
    deepStrictEqual(
      problemKindsFor({
        ...base,
        hasInlineCitation: true,
        evidence: found(22, 8),
        critiqueVerdict: 'overstated'
      }),
      ['overstated-claim']
    )
  })

  it('leaves UNCITED claims exactly as they were', () => {
    // The gate is about talking past a citation. With no citation there is
    // none to talk past, and the retrieval bands are the only thing there is.
    deepStrictEqual(problemKindsFor({ ...base, evidence: found(22, 8) }), ['weak-evidence'])
    deepStrictEqual(problemKindsFor({ ...base, evidence: found(55, 8) }), ['partial-evidence'])
    deepStrictEqual(problemKindsFor({ ...base, evidence: found(85, 8) }), ['missing-citation'])
  })
})

/**
 * The owner's own sentence, 2026-08-19:
 *
 *   "The study has since had a rough time — Morehead, Dunlosky and Rawson
 *    failed to replicate the headline effect in 2019, and anyone citing the
 *    original as settled science is overreaching (Shelly J. Schmidt, 2019)."
 *
 * Some of the best reasoning in the draft: it concedes a failed replication and
 * then bounds the claim. The critique read the cited work and reported —
 * correctly — that it "is a reflective piece on classroom management and
 * note-taking practices, not a research article reporting on replication
 * studies". A true finding, and one about the CITATION.
 *
 * Retrieval scored 47. The old `evidence.score < MIXED` gate on
 * `cited-unverified` is 40, so it missed by seven points, `weak-reasoning`
 * fired instead, and the sentence was underlined in red as bad thinking.
 */
describe('a doubted citation is a citation finding at any retrieval score', () => {
  const sentence = {
    claimType: 'factual' as const,
    hasInlineCitation: true,
    evidence: { score: 47, count: 6, hasRelevantSource: true },
    critiqueVerdict: 'unsupported' as const,
    // The critique resolved the Schmidt reference and read its abstract — that
    // is how it could report the work is about classroom management.
    citedWorkRead: true
  }

  it('names the citation, not the reasoning', () => {
    strictEqual(problemKindFor(sentence), 'cited-unverified')
  })

  it('does the same across the whole middle band the gate used to split', () => {
    // 39 and 47 are the same finding about the same sentence. A seven-point
    // difference in a TOPICAL search score cannot change what is wrong with a
    // citation nothing in the retrieval path ever opened.
    for (const score of [0.1, 20, 39, 40, 47, 55, 69]) {
      strictEqual(
        problemKindFor({ ...sentence, evidence: { ...sentence.evidence, score } }),
        'cited-unverified',
        `score ${score}`
      )
    }
  })

  it('does not also raise the weaker way of saying it', () => {
    const kinds = problemKindsFor(sentence)
    strictEqual(kinds.includes('partial-evidence'), false, kinds.join(','))
  })

  /**
   * What the topical search returned stopped mattering here on 2026-08-19.
   *
   * `!nothingFound` used to gate this kind, as a PROXY for "do we have any
   * basis to judge the citation" — written when nothing carried the real
   * answer. `citedWorkRead` is that answer, and it is strictly stronger: the
   * critique either had the writer's resolved work in slot 1 or it did not.
   *
   * So this case flips. The critique opened their source, found it does not
   * carry the claim, and four indexes happened to return nothing else on the
   * topic. That is the most valuable finding in the product, and it was being
   * discarded because of what OTHER papers did not say.
   */
  it('speaks even when retrieval found nothing relevant, if the source was read', () => {
    const kinds = problemKindsFor({
      ...sentence,
      evidence: { score: 0, count: 8, hasRelevantSource: false }
    })
    strictEqual(kinds.includes('cited-unverified'), true, kinds.join(','))
  })

  it('but not when the source was never opened', () => {
    const kinds = problemKindsFor({
      ...sentence,
      citedWorkRead: false,
      evidence: { score: 0, count: 8, hasRelevantSource: false }
    })
    strictEqual(kinds.includes('cited-unverified'), false, kinds.join(','))
  })

  it('still says nothing when no critique has doubted the citation', () => {
    const kinds = problemKindsFor({ ...sentence, critiqueVerdict: null })
    strictEqual(kinds.includes('cited-unverified'), false, kinds.join(','))
  })

  it('leaves an UNCITED claim on the evidence path', () => {
    strictEqual(
      problemKindFor({ ...sentence, hasInlineCitation: false }),
      'unsupported-by-evidence'
    )
  })
})

/**
 * The three findings the owner reported on 2026-08-19, each pinned to the
 * sentence that produced it.
 */
describe('problemKindsFor — the three wrong cards', () => {
  const base = {
    claimType: 'factual' as const,
    evidence: { score: 33, count: 4, hasRelevantSource: true },
    critiqueVerdict: null,
    suggestedRevision: null,
    claimText: 'x'
  }

  // "This one said citation may not support it, yet there is no citation."
  // The sentence is COVERED by a citation later in its paragraph, which is the
  // right rule for "does this need a citation" and the wrong one for saying
  // anything about one.
  it('will not doubt a citation the sentence does not have', () => {
    const kinds = problemKindsFor({
      ...base,
      hasInlineCitation: true,
      hasOwnCitation: false,
      critiqueVerdict: 'unsupported',
      citationKind: null
    })
    strictEqual(kinds.includes('cited-unverified'), false, kinds.join(','))
  })

  // "This one also says citation may not support it, even though it does."
  // ("Audrey" Wikipedia) is a correct MLA citation that Crossref will never
  // resolve, so an `unsupported` verdict over it is about our retrieval.
  it('will not doubt a citation the lookup could never have checked', () => {
    const shaped = {
      ...base,
      hasInlineCitation: true,
      hasOwnCitation: true,
      critiqueVerdict: 'unsupported' as const,
      citedWorkRead: true
    }
    strictEqual(
      problemKindsFor({ ...shaped, citationKind: 'titled' }).includes('cited-unverified'),
      false
    )
    // The #155 case — an author-and-year reference the critique DID resolve —
    // must still be reported.
    strictEqual(
      problemKindsFor({ ...shaped, citationKind: 'parenthetical' }).includes('cited-unverified'),
      true
    )
  })

  // "This one says it is partially supported, when it should call out faulty
  // citation." (Unknown Author, 2025) is wrong on its face.
  it('names a defective citation with no verdict and no search', () => {
    const kinds = problemKindsFor({
      ...base,
      hasInlineCitation: true,
      hasOwnCitation: true,
      citationKind: 'parenthetical',
      citationDefect: 'The author is a placeholder rather than a name.'
    })
    strictEqual(kinds[0], 'citation-defect', kinds.join(','))
  })

  // A fabricated reference and a malformed one are different facts, and a
  // sentence can have both.
  it('reports a defect alongside a fabricated verdict rather than instead of it', () => {
    const kinds = problemKindsFor({
      ...base,
      hasInlineCitation: true,
      hasOwnCitation: true,
      citationKind: 'parenthetical',
      citationDefect: 'The year has not happened yet.',
      critiqueVerdict: 'fabricated'
    })
    strictEqual(kinds.includes('citation-defect'), true, kinds.join(','))
    strictEqual(kinds.includes('fabricated-citation'), true, kinds.join(','))
  })
})
