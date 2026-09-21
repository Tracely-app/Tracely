import type { ClaimType, CritiqueVerdict, ScoreBreakdown } from '@shared/types'
import type { OutOfScopeReason } from './retrievalScope'

/**
 * What is actually wrong with a claim — decided once, in main, and sent to the
 * overlay so the underline and the card cannot disagree.
 *
 * They used to. The underline was coloured by `BUCKET_COLOR[bucketFor(claimType)]`
 * — the KIND OF SENTENCE, not the problem — while the popover derived the
 * problem separately in the renderer from evidence and critique. So the mark
 * said "this is a factual claim" (and said it in orange for every factual claim
 * in the document, whatever its state), and only opening the card told you
 * whether the issue was a missing citation, thin evidence, or reasoning that
 * does not follow. Underlining is the part of Screen Watch people actually
 * read; it was carrying the least useful of the two signals.
 *
 * A pure function of state that main already has, so it is one source of truth
 * for the colour, the card's title, and the widget's ordering.
 */
export type ScreenWatchProblemKind =
  /** Evidence search has not come back yet. Nothing is known. */
  | 'searching'
  /**
   * The sentence names a source that does not appear to exist.
   *
   * Ranked above 'contradicted-claim' because it is the only kind here that is
   * a finding about the WRITER rather than about the literature. A contradicted
   * claim is a mistake; an invented citation is the failure mode that ends
   * academic careers, and it is what a chatbot produces by default — which is
   * precisely why a tool students point at chatbot-assisted drafts has to name
   * it rather than fold it into 'nothing found'.
   */
  | 'fabricated-citation'
  /**
   * The citation is visibly wrong on its face — no model involved.
   *
   * A placeholder where a name should be, a year that has not happened, a note
   * to self left in the draft, a bare URL standing in for a reference. All of
   * it is decidable from the SHAPE of what the writer typed (see
   * `shared/citationShape.ts`), which is what makes it different from every
   * other kind here: it costs nothing, it needs no search, and it is certain.
   *
   * Ranked directly under 'fabricated-citation' because it is the same class of
   * problem caught earlier and cheaper. Owner, 2026-08-19, on
   * "(Unknown Author, 2025)": *"this one says it is partially supported, when
   * it should call out faulty citation."* Correct — and the critique had in
   * fact said exactly that, in prose, after a paid call the writer had to wait
   * for. The shape was decidable the moment they typed it.
   */
  | 'citation-defect'
  /**
   * The critique read the evidence and it does not back the claim as phrased.
   *
   * NOT a finding about reasoning, and it was called `weak-reasoning` until
   * 2026-08-19. The verdicts behind it — `weak` and `unsupported` — come out of
   * CRITIQUE_SYSTEM_PROMPT's Pass 3, which asks "does the evidence actually
   * back the claim as phrased?" That is a question about SOURCES.
   *
   * Measured on the owner's draft, on a sentence that concedes a failed
   * replication and then bounds its own claim — some of the best reasoning in
   * the document. Its cited work turned out to be about a different subject, so
   * Pass 3 returned `unsupported`, and the app printed "Weak reasoning" in red
   * over it. The critique was right and the label was a category error.
   *
   * "Weak reasoning" now belongs to the classifier's named faults —
   * `circular-reasoning`, `sequence-as-cause`, `single-case-generalisation`,
   * `logical-leap` in `StructureWeaknessKind` — which are the only things in
   * this app that judge an argument rather than its sources. They are
   * paragraph-level and live in the report; a sentence-level reasoning fault
   * would need Pass 3 to name what it found, the same change the classifier
   * got. Until then this kind must not borrow the word.
   */
  | 'unsupported-by-evidence'
  /**
   * The critique's fact-check said a specific assertion in the sentence is
   * wrong — a different finding from weak reasoning, and a worse one.
   *
   * CRITIQUE_SYSTEM_PROMPT reserves the `contradicted` verdict for "the claim
   * asserts a specific fact you're confident is factually wrong", and instructs
   * the model to fall through to the rigor pass whenever it is merely unsure.
   * Folding it in with 'unsupported-by-evidence' printed an evidence-fit label
   * over the one verdict that is not about evidence at all, and ranked the most serious
   * thing this product can say below a citation problem.
   */
  | 'contradicted-claim'
  /**
   * The claim is defensible; the quantifier is not.
   *
   * Ranked below the two truth findings and above every support finding,
   * because it is not a question of evidence at all — no amount of retrieval
   * fixes "100%", and telling the writer their sources are thin points them at
   * the wrong repair entirely.
   */
  | 'overstated-claim'
  /** A number nothing in the literature carries. */
  | 'unverified-statistic'
  /** Searched, and nothing relevant came back at all. */
  | 'no-sources'
  /**
   * Nothing came back, and nothing was ever going to: the sentence is about a
   * primary text, a statute, one institution's own records, the writer's own
   * observation, or something that has not happened yet.
   *
   * A different sentence from 'no-sources', not a softer one. "No supporting
   * sources" is a report on the literature, and over a claim four scholarly
   * indexes structurally cannot hold, it is a report on nothing — the app
   * describing the shape of its own corpus in the grammar of a fault in the
   * writing. The claim still needs a citation; Tracely just stops saying it
   * looked for one where it could not have been. See retrievalScope.ts.
   */
  | 'outside-index'
  /** Sources exist but score poorly for supporting this specific claim. */
  | 'weak-evidence'
  /** Sources qualify the claim rather than confirming it. */
  | 'partial-evidence'
  /**
   * True or false, this sentence is not about the essay.
   *
   * The one finding here that is not about the claim at all — every other kind
   * asks whether a sentence is true or supported, and this asks whether it
   * BELONGS. A tangent can be perfectly true, well-cited and still wrong to
   * include, which is why it needs its own kind rather than a share of one:
   * "no supporting sources" over a correct sentence about a footballer names
   * the wrong problem entirely.
   *
   * Owner, 2026-08-22, on pasting an unrelated sentence onto an essay: it
   * should be flagged both "for being false" and "for being completely
   * irrelevant to the topic". Two findings, because they are two problems and
   * fixing one does not fix the other.
   *
   * Ranked just under the truth findings and above every support finding.
   * Deleting a paragraph makes its citations moot, so telling someone their
   * tangent is under-sourced before telling them it is a tangent is advice in
   * the wrong order.
   */
  | 'off-topic'
  /** Well supported, but the sentence is unattributed. */
  | 'missing-citation'
  /**
   * The writer attributed it, and the literature does not back what they
   * attributed. The most alarming state a claim can be in — a wrong citation
   * is worse than a missing one, because the reader has no reason to check it.
   */
  | 'cited-unverified'

export interface ProblemKindInput {
  claimType: ClaimType
  /** The writer's own citation in this sentence — see inlineCitation.ts. */
  hasInlineCitation: boolean
  /**
   * Does THIS sentence carry a citation, rather than merely being covered by
   * one in its paragraph?
   *
   * Optional, and falls back to `hasInlineCitation` — Screen Watch reads a
   * claim with no surrounding document, so the two questions collapse there.
   */
  hasOwnCitation?: boolean
  /**
   * A defect visible in the SHAPE of the citation, from `citationShape.ts`.
   *
   * Its own sentence, or null. Present means the citation is wrong on its face
   * — a placeholder author, a year that has not happened, a note to self — and
   * no search or model call was needed to know it.
   */
  citationDefect?: string | null
  /**
   * Which citation shape this sentence used — `inlineCitationKind`'s answer.
   *
   * Needed because `cited-unverified` asserts something about the work the
   * WRITER named, and `referenceCheck` can only resolve an author-and-year
   * reference. A web citation like `("Audrey" Wikipedia)` is a perfectly good
   * MLA citation that Crossref will never find, so a critique reaching
   * `unsupported` over it is reporting on the retrieved evidence, not on that
   * source. Null means unknown, which is treated as checkable — Screen Watch
   * has no document to read the shape from.
   */
  citationKind?: string | null
  /**
   * Did the critique actually have the writer's cited work in front of it?
   *
   * The one fact that separates "your source does not support this" from "the
   * papers a topical search returned do not support this", and until 2026-08-19
   * nothing carried it. `search/referenceCheck.ts` goes and resolves the work a
   * sentence names; `shared/citedEvidence.ts` puts it in slot 1 when it
   * resolves and leaves it out when it does not. Either way the critique
   * returns the same four verdicts, so `weak` over a resolved source and `weak`
   * over an unresolved one were indistinguishable downstream — and only the
   * first is a statement about the citation.
   *
   * Owner, 2026-08-19, reading a card over a correctly cited sentence: *"It
   * doesn't matter what the other five sources found; as long as that specific
   * source backs up their evidence, don't flag it."*
   *
   * `false` means the lookup ran and came back with nothing to read — a limit
   * of ours. `null` means nobody recorded it: claims critiqued before the field
   * existed, and any surface that does not track it. **Both suppress the
   * finding**, because the assertion needs the source to have been read and
   * "probably" is not read. The direction is the one this whole file argues
   * for: a tool that accuses a correct citation to avoid missing an incorrect
   * one teaches students to ignore it.
   */
  citedWorkRead?: boolean | null
  /** Null until the background search resolves. */
  evidence: {
    score: number
    /**
     * How many results came back AT ALL. Retained because callers already have
     * it and it reads naturally next to `score`; it no longer decides anything
     * here — see `hasRelevantSource`, which is the question this file was
     * actually asking all along.
     */
    count: number
    /**
     * Did any of those results actually speak to this claim?
     *
     * This is a different question from `count > 0`, and conflating them was a
     * real bug in the overlay. Retrieval merges four providers down to eight
     * results and returns eight of them whatever the claim is, so `count` was
     * ~8 for every claim in the app and `count === 0` — the test this file used
     * for "nothing found" — was effectively unreachable there. The document
     * editor's call site had quietly been passing `scoreBreakdown.sourceCount`
     * (the fraction that DID apply the relevance floor) into the same field,
     * so the two surfaces were answering different questions from one input.
     *
     * Derive it with `hasRelevantSource(breakdown)` rather than by hand.
     */
    hasRelevantSource: boolean
  } | null
  critiqueVerdict: CritiqueVerdict | null
  /**
   * Why the academic indexes were never going to hold this sentence, or null.
   *
   * Read off the claim's own text with `retrievalScopeFor`. It changes nothing
   * when evidence WAS found — a close reading that turns out to have criticism
   * written about it is scored on that criticism like anything else. It only
   * decides what an empty result set is allowed to be called.
   */
  outOfIndexScope?: OutOfScopeReason | null
  /**
   * Is this sentence about the rest of the draft? See shared/claimRelevance.ts.
   *
   * `false` is a measured finding; `null` is "not measured" — the ML worker
   * unavailable, the draft too short, or a surface that does not compute it —
   * and must stay silent. Underlining a sentence as a tangent because an
   * embedding model failed to load is the same class of error as reporting a
   * retrieval miss as an unsupported claim.
   */
  onTopic?: boolean | null
}

/**
 * Did retrieval find anything that speaks to this claim?
 *
 * `sourceCount` is the share of the six-source cap that cleared the relevance
 * floor (MIN_COUNTABLE_RELEVANCE in services/search/scoring.ts), so zero means
 * every result that came back was about something else — not that the providers
 * returned nothing.
 */
export function hasRelevantSource(breakdown: ScoreBreakdown | null): boolean {
  return (breakdown?.sourceCount ?? 0) > 0
}

/**
 * Is this `unsupported` verdict a statement about the CLAIM, or about the
 * SEARCH?
 *
 * The relay's critique reaches `unsupported` two ways, and they are not the
 * same finding:
 *
 *   1. it read the retrieved evidence and that evidence does not carry the
 *      claim — a judgement about the sentence; and
 *   2. it was handed nothing on topic and had nothing to read — a report on
 *      retrieval, which happens to be phrased as a verdict on the sentence.
 *
 * Only (1) is something Tracely knows about the writing. Measured on
 * 2026-08-16 (eval/critique/FINDINGS.md), two of the five `unsupported`
 * verdicts in the run were case (2), and both were on sentences that are true
 * and properly hedged — "Some researchers argue the effect is small" retrieved
 * nothing relevant, scored 0, came back `unsupported`, and was then printed
 * over the writer's correct sentence as **"Weak reasoning"**. Three layers each
 * behaving reasonably, combining into an accusation.
 *
 * The discriminator is local, deterministic and already computed: did anything
 * clear the relevance floor. The model is not asked, because the model cannot
 * tell the difference — from inside the critique call, "no good evidence
 * exists" and "no good evidence was handed to me" look identical.
 */
export function isRetrievalMiss(
  verdict: CritiqueVerdict | null,
  evidenceHasRelevantSource: boolean
): boolean {
  return verdict === 'unsupported' && !evidenceHasRelevantSource
}

/**
 * Reasoning that does not follow. 'contradicted' is deliberately NOT here.
 *
 * `unsupported` IS here, but only survives `isRetrievalMiss` — see above. A
 * verdict reached over real, on-topic evidence that fails to carry the claim is
 * a finding about the reasoning; the same word reached over an empty table is
 * a finding about the search.
 */
const WEAK_VERDICTS: CritiqueVerdict[] = ['weak', 'unsupported']

/**
 * Verdicts that constitute having read the writer's own source and doubted it.
 *
 * `well-supported` and `partially-supported` are deliberately absent: those are
 * the critique saying the citation holds, and the whole point of the gate they
 * feed is that retrieval must not then contradict them.
 *
 * `overstated` is absent too, and that one is worth stating. It is a finding
 * about the sentence's QUANTIFIER, not about its source — the citation can be
 * impeccable and the sentence still say "always". It raises its own kind, which
 * is where that belongs; adding "your citation may not support this" underneath
 * would send the writer looking for a better source for a wording problem.
 */
/**
 * Citation shapes `search/referenceCheck.ts` can actually resolve.
 *
 * It searches Crossref for an author and a year. The other shapes name a work
 * without either — a quoted title, a bare URL, a numeric marker, a footnote —
 * and every one of them is a correct citation in some style. Not being able to
 * check one is a limit of ours, and must not be reported as a doubt about it.
 */
const CHECKABLE_CITATION_SHAPES = new Set(['parenthetical', 'narrative', 'author-page'])

export function isCheckableCitationShape(kind: string | null | undefined): boolean {
  // Null is "not known" — Screen Watch reads a claim with no document behind
  // it — and the pre-existing behaviour there is to allow the finding.
  return kind == null || CHECKABLE_CITATION_SHAPES.has(kind)
}

const DOUBTING_VERDICTS: CritiqueVerdict[] = ['weak', 'unsupported', 'contradicted', 'fabricated']

/** The 70/40 bands used everywhere else in the product. */
const STRONG = 70
const MIXED = 40

/**
 * EVERY problem this claim has, worst first.
 *
 * A sentence can be in more than one kind of trouble at once, and the two most
 * common pairs are the two most worth knowing about: reasoning that does not
 * follow from evidence that is also thin, and a cited statistic that nothing
 * carries. Returning a single kind meant fixing the one shown revealed a second
 * problem the writer had no idea was there.
 *
 * The predicates below are deliberately independent — each answers one question
 * about the claim — and the ordering is applied afterwards, so adding a kind
 * cannot silently mask an existing one the way an if/else chain does.
 */
export function problemKindsFor({
  claimType,
  hasInlineCitation,
  hasOwnCitation = hasInlineCitation,
  citationDefect = null,
  citationKind = null,
  citedWorkRead = null,
  evidence,
  critiqueVerdict,
  outOfIndexScope = null,
  onTopic = null
}: ProblemKindInput): ScreenWatchProblemKind[] {
  // Nothing is known yet, so nothing else can be asserted. Sole kind.
  if (!evidence) return ['searching']

  const kinds: ScreenWatchProblemKind[] = []
  // "Nothing that speaks to this claim came back", not "no rows returned".
  const nothingFound = !evidence.hasRelevantSource

  // Has anything actually READ the writer's source and doubted it?
  //
  // The rule this gates is the one users have raised twice: a sentence that
  // cites a credible source which does bear the claim out must not be flagged
  // because a topical search of the academic databases turned up other papers
  // that score low. A student cited Wikipedia, Wikipedia agrees with them,
  // Tracely searched OpenAlex and Crossref instead, found eight journal
  // articles about something adjacent, scored them 22/100 and printed
  // "Citation may not support this" over a correctly-sourced sentence.
  //
  // The retrieval score is a fact about the LITERATURE. It is not a fact about
  // the writer's citation, and nothing in the retrieval path ever opens the
  // work they named. The critique does — referenceCheck.ts resolves the cited
  // work and citedEvidence.ts puts it in slot 1 with the relay instructed to
  // check it FIRST — so a doubting verdict is the only signal here that was
  // reached having looked at the right source.
  //
  // This is the same argument problemKindsFor already makes for `nothingFound`
  // ("absence of evidence in a corpus that was never going to hold it is not
  // evidence of absence"), applied where it equally holds: a LOW score over
  // eight unrelated papers is no more informative than a zero one.
  //
  // The cost, stated plainly: a genuinely miscited claim now says nothing until
  // the reasoning check runs on it. That is the right way round. Tracely cannot
  // read a source without that call, and a tool that accuses a correct citation
  // to avoid missing an incorrect one teaches students to ignore it.
  const citationDoubted =
    critiqueVerdict !== null && DOUBTING_VERDICTS.includes(critiqueVerdict)

  // Did the critique actually open the work the writer named? See
  // `citedWorkRead` above — null and false both mean no.
  const readTheirSource = citedWorkRead === true

  /**
   * May an EVIDENCE-FIT verdict be reported over this sentence at all?
   *
   * `weak` and `unsupported` are Pass 3's answer to "does the evidence back the
   * claim as phrased", and for a sentence with its own citation the evidence
   * that matters is the one the writer pointed at. If that source was never
   * resolved, the verdict was reached over a topical search the writer never
   * claimed as support — so it says nothing about their sentence, and printing
   * it is the complaint this change exists to answer.
   *
   * An UNCITED sentence is untouched: there the searched sources are not a
   * fallback, they are the evidence, and a verdict over them is exactly what
   * the card should say.
   */
  const evidenceFitApplies = !hasOwnCitation || readTheirSource

  // An `unsupported` verdict the critique reached with no on-topic evidence in
  // front of it. It says nothing about the sentence, so it decides nothing
  // here — the retrieval kinds below report the same state honestly, as
  // "No supporting sources" rather than "Weak reasoning".
  const retrievalMiss = isRetrievalMiss(critiqueVerdict, evidence.hasRelevantSource)

  // Checked before 'contradicted' and outside the cited/uncited branches below,
  // because a fabricated reference is a fact about the citation itself: the
  // evidence bands have nothing to say about a source that was never written.
  // Before every verdict-driven kind, because it needed no verdict: a
  // placeholder author is wrong the moment it is typed, and waiting for a paid
  // critique to say so in prose is a worse version of the same finding. Not
  // `else`-chained with them either — a fabricated reference and a malformed
  // one are different facts and a sentence can have both.
  if (citationDefect) kinds.push('citation-defect')

  if (critiqueVerdict === 'fabricated') kinds.push('fabricated-citation')
  else if (critiqueVerdict === 'contradicted') kinds.push('contradicted-claim')
  else if (critiqueVerdict === 'overstated') kinds.push('overstated-claim')
  else if (
    critiqueVerdict &&
    !retrievalMiss &&
    evidenceFitApplies &&
    WEAK_VERDICTS.includes(critiqueVerdict)
  ) {
    kinds.push('unsupported-by-evidence')
  }

  // Not about the essay — and independent of everything above and below it. A
  // tangent can be true AND well-sourced, so this is never an else-branch:
  // both findings can be worth making about one sentence, which is exactly
  // what the owner asked for on 2026-08-22 ("flag it for being false" AND
  // "flag it for being completely irrelevant to the topic").
  //
  // Above every attribution and support finding, because deleting a paragraph
  // makes its citations moot — telling someone their tangent is under-sourced
  // before telling them it is a tangent is advice in the wrong order.
  if (onTopic === false) kinds.push('off-topic')

  // Cited, and the literature we DID find does not back what was attributed.
  // Subsumes the plain evidence bands for a cited claim: "thin support" is the
  // wrong advice when the writer has already named a source.
  //
  // `!nothingFound` is the load-bearing half. This used to fire on zero results
  // too, which turns silence from four ACADEMIC search APIs into an accusation
  // about a sentence the writer has already attributed — and those APIs index
  // journal articles, not UN treaty pages, government programmes, national
  // statistics offices or newspapers, which is what a policy paper actually
  // cites. On an essay that cited an institution on nearly every line, every
  // line came back "Citation may not support this". Absence of evidence in a
  // corpus that was never going to hold it is not evidence of absence.
  //
  // That argument was always about RELEVANT evidence, and `nothingFound` only
  // started meaning that on 2026-08-16. In the overlay it had meant "the
  // providers returned literally nothing", which they essentially never do, so
  // eight results about other subjects cleared this guard and the accusation
  // went out anyway — the exact case the paragraph above says it must not fire
  // on.
  // ── No score gate, and removing it is the fix ──────────────────────────────
  // This required `evidence.score < MIXED` (40) until 2026-08-19. Measured on
  // the owner's own draft, on a sentence whose reasoning is the best in its
  // paragraph:
  //
  //   "The study has since had a rough time — Morehead, Dunlosky and Rawson
  //    failed to replicate the headline effect in 2019, and anyone citing the
  //    original as settled science is overreaching (Shelly J. Schmidt, 2019)."
  //
  // The critique read the cited work and reported, correctly, that it "is a
  // reflective piece on classroom management and note-taking practices, not a
  // research article reporting on replication studies". A citation finding, and
  // a true one. The retrieval score was 47. Seven points over the gate, so this
  // did not fire, `weak-reasoning` did, and a sentence that concedes a failed
  // replication and bounds its own claim was underlined in red as bad thinking.
  //
  // The gate was never defensible: `evidence.score` measures a TOPICAL SEARCH
  // of four indexes, and this kind is about the source the WRITER named. Those
  // are different questions about different documents. The same argument is
  // already made twice in the comment above for `nothingFound`, and it applies
  // to the band as much as to the floor — a low score and a middling score are
  // equally silent about a citation nothing in the retrieval path ever opened.
  //
  // What licenses the finding is `citationDoubted`: a verdict reached by the
  // one call that resolves the cited work and reads its abstract.
  //
  // `hasOwnCitation`, not `hasInlineCitation`. The latter is PARAGRAPH-scoped
  // (see shared/citationScope.ts) — a sentence with no citation of its own is
  // "covered" by one nearby, which is right for deciding whether to ask for a
  // citation and wrong for saying something about one. Owner, 2026-08-19:
  // *"this one said citation may not support it, yet there is no citation"* —
  // a sentence about Hepburn's malnutrition, covered by the ("Audrey" UNICEF)
  // at the end of the sentence AFTER it. You cannot doubt a citation that is
  // not there.
  //
  // And only for a citation the lookup could actually have checked. Measured on
  // the owner's draft, 2026-08-19: two sentences, identical `sourceCount` of
  // 0.167, both `unsupported`. On one the critique had the writer's cited work
  // in front of it and said it was about a different subject — a real finding.
  // On the other it said *"The cited source is Wikipedia, which is not included
  // in the evidence list"*, which is a fact about our own retrieval. Nothing in
  // the verdict or the score separates them; the citation's SHAPE does.
  // Owner: *"this one also says citation may not support it, even though it
  // does."*
  //
  // ── `!nothingFound` is gone, and `readTheirSource` is what replaced it ─────
  // That guard was a PROXY for this question, written when nothing carried the
  // answer: "did anything relevant come back" stood in for "do we have any
  // basis to judge this citation". It was always the wrong instrument — the
  // topical search is about other documents — and it was the same category
  // error the score gate above was deleted for, one line down.
  //
  // With `citedWorkRead` there is a real answer, and it is strictly stronger:
  // the critique either had the writer's resolved work in slot 1 or it did not.
  // Net, this is a large tightening — a doubting verdict alone used to be
  // enough for any cited claim with one relevant hit — and one narrow case
  // becomes reachable that the proxy was wrongly suppressing: the critique read
  // their source, found it does not carry the claim, and the topical search
  // happened to return nothing. That is the single most valuable finding in the
  // product, and it was being thrown away because of what OTHER papers said.
  if (hasOwnCitation && readTheirSource && citationDoubted && isCheckableCitationShape(citationKind)) {
    kinds.push('cited-unverified')
  }

  // A number nothing carries, in a sentence with no citation to check it
  // against. Cited figures are excluded for the reason above: we have not
  // read the source the writer named, so "unverified" would be our word for
  // "not indexed by OpenAlex", which is not what the reader will hear.
  // Nothing came back, and nothing was going to. The two retrieval findings
  // below are both statements about the literature, and there is no literature
  // to make a statement about — so this replaces them rather than joining them.
  // Emitting both would print "No supporting sources" underneath "these
  // databases do not hold this kind of claim", which is the accusation the
  // second line exists to withdraw.
  if (nothingFound && !hasInlineCitation && outOfIndexScope) kinds.push('outside-index')
  else if (nothingFound && !hasInlineCitation && claimType === 'statistic') kinds.push('unverified-statistic')
  else if (nothingFound && !hasInlineCitation) kinds.push('no-sources')

  if (!nothingFound && !hasInlineCitation) {
    if (evidence.score < MIXED) kinds.push('weak-evidence')
    else if (evidence.score < STRONG) kinds.push('partial-evidence')
    else kinds.push('missing-citation')
  }
  // The middle-band `partial-evidence` branch for a CITED claim was here, and
  // it is gone with the score gate above. Its condition was a strict subset of
  // the one `cited-unverified` now has, so it could only ever add a second,
  // weaker way of saying the same thing about the same sentence.

  // An empty list is a real answer, and the caller treats it as "say nothing
  // about this sentence": a cited claim that is well supported, and a cited
  // claim the databases simply have no opinion on, both land here.
  return kinds.sort((a, b) => problemSeverity(a) - problemSeverity(b))
}

/** The worst of them — what the underline is coloured by and the card shows. */
export function problemKindFor(input: ProblemKindInput): ScreenWatchProblemKind {
  return problemKindsFor(input)[0] ?? 'searching'
}

/**
 * Display order, worst first.
 *
 * The widget lists claims by detection confidence, which says how sure Tracely
 * is that a sentence IS a claim — not how much trouble it is in. Sorting the
 * panel by this instead puts the reasoning failure above the tidy claim that
 * merely wants a citation.
 */
const SEVERITY = [
  // Above everything, including a wrong fact: a wrong fact is an error, an
  // invented source is a fabrication, and the reader of the finished essay has
  // no way at all to catch the second.
  'fabricated-citation',
  // Directly under an invented source: a malformed reference is also a fact
  // about the citation, decidable the moment it is typed.
  'citation-defect',
  // Nothing else outranks "a fact in this sentence is wrong". Every other kind
  // here is a statement about support; this one is a statement about truth.
  'contradicted-claim',
  // Just under the truth findings and above every support finding: deleting a
  // tangent makes its citations moot, so it is said first.
  'off-topic',
  // Above weak reasoning: a claim whose own citation does not support it is
  // the one error a reader has no prompt to go and check.
  'cited-unverified',
  'unsupported-by-evidence',
  // Above the evidence findings on purpose. An overstated claim looks exactly
  // like a badly-sourced one from the retrieval side — the sources will not
  // support "100%" — and ranking it below them means the writer is told to go
  // and find evidence that cannot exist for a sentence one word away from being
  // fine.
  'overstated-claim',
  'unverified-statistic',
  'no-sources',
  'weak-evidence',
  'partial-evidence',
  'missing-citation',
  // Last of the real findings. Everything above it is something Tracely
  // established about the sentence; this is the one that reports what it could
  // not establish, so it must never outrank a claim there IS something to say
  // about — it would push a contradicted fact down the widget's list.
  'outside-index',
  'searching'
] as const satisfies readonly ScreenWatchProblemKind[]

/* Every kind must be ranked, and that is now a COMPILE error rather than a
 * silent -1.
 *
 * `citation-defect` and `off-topic` were added to the union with comments
 * saying exactly where they rank — and never added here. `indexOf` returned -1
 * for both, the sort put -1 first, and a malformed reference or a tangent
 * outranked an invented source and a wrong fact in every sentence that had
 * both: the widget coloured a fabricated citation amber. Nothing failed,
 * because a missing entry is not an error to indexOf. If this line stops
 * compiling, the kind it names is missing from SEVERITY above. */
type Unranked = Exclude<ScreenWatchProblemKind, (typeof SEVERITY)[number]>
const everyKindRanked: [Unranked] extends [never] ? true : { missingFromSeverity: Unranked } = true
void everyKindRanked

export function problemSeverity(kind: ScreenWatchProblemKind): number {
  return (SEVERITY as readonly ScreenWatchProblemKind[]).indexOf(kind)
}
