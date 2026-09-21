import type { ParagraphRole } from '@shared/types'
import type { ParagraphSpan } from '@shared/paragraphSplit'

/**
 * Local, zero-cost role labelling. This is the fallback the panel runs on
 * before (and whenever) the relay classifier is unavailable.
 *
 * The governing rule: **label only what a marker or a detected claim
 * justifies, and return 'unknown' for everything else.** A heuristic that
 * guesses produces a confident-looking score computed from nothing, which is
 * strictly worse than admitting the paragraph wasn't read — `complete: false`
 * and a "provisional" badge are the honest output, and the score rubric is
 * built to degrade that way on purpose.
 */

// Openers that reliably signal the writer is entertaining an objection. Matched
// only at the START of a paragraph: "however" mid-paragraph is an ordinary
// contrast between two of the writer's own points, not a counterargument, and
// matching it anywhere labelled roughly every paragraph in a real essay.
const COUNTERARGUMENT_MARKERS = [
  'however',
  'critics of',
  'skeptics',
  'opponents',
  'detractors',
  'on the other hand',
  'admittedly',
  'granted',
  'to be fair',
  'conversely',
  'that said'
]

/**
 * "<someone> argue/contend/object that …" with a noun allowed in between.
 *
 * A literal list ('some argue', 'critics argue', 'one might argue') misses the
 * way people actually write the move: "Some INSTRUCTORS argue", "Critics of the
 * POLICY contend", "Many RESEARCHERS have objected". Tested against a draft
 * whose one well-executed counterargument opened "Some instructors argue that
 * …" and was silently missed — which then made the panel assert the draft had
 * no counterargument at all. A false negative here becomes a false accusation,
 * so it is worth more than a substring match.
 *
 * `[^.]{0,30}` cannot cross a sentence boundary, keeping this inside the same
 * clause as the subject.
 */
// Anchored at the sentence opening for the same reason the literal markers
// are: "The data, some argue, is thin" is the writer conceding a detail in
// passing, not a paragraph that turns to face an objection.
const COUNTERARGUMENT_PATTERN =
  /^["'‘“(\[]?\s*(?:and|but|so|yet)?\s*(some|many|others|critics|opponents|skeptics|sceptics|detractors|one)\b[^.]{0,30}?\b(argue|argued|contend|contends|object|objected|maintain|counter|claim)\b/

/**
 * The other way writers open the move: by NAMING the objection rather than
 * attributing it to anyone.
 *
 * "There is a serious objection to all of this", "The obvious counterargument
 * is", "One objection deserves an answer". None of these give
 * COUNTERARGUMENT_PATTERN a subject to match, and none contain a literal
 * marker — so a paragraph whose entire job was to state the strongest case
 * against the essay was labelled an ordinary claim, and the draft was told it
 * had no counterargument at all. Measured on a deliberately well-structured
 * essay: the paragraph opening "There is a serious objection to all of this,
 * and it deserves better than the dismissal it usually gets" scored 0/15.
 *
 * The opener must be a determiner or an existential — "There is a serious
 * objection", "The obvious counterargument", "One objection". A PRONOUN
 * subject is refused, because "I answered an objection three sentences ago"
 * and "We raised the objection ourselves" are the writer looking back at one,
 * not turning to face it, and an earlier version of this pattern matched both.
 * Bounded to the first sentence for the same reason: writers announce this
 * move at the top of the paragraph or not at all.
 */
const COUNTERARGUMENT_NOUN =
  /^["'‘“(\[]?\s*(?:there\s+(?:is|are|remains|exists)|the|one|a|an|another|its|his|her|their)\b[^.!?]{0,40}?\b(objection|objections|counterargument|counter-argument|counterpoint)\b/i

const CONCLUSION_MARKERS = [
  'in conclusion',
  'to conclude',
  'in summary',
  'in sum',
  'to sum up',
  'ultimately',
  'overall',
  'taken together',
  'in the end',
  'all told'
]

/**
 * Phrases that answer "so what?" rather than restating. Exported because
 * scoreDraft awards partial significance credit when one of these appears in a
 * conclusion that has no dedicated significance paragraph.
 */
export const SIGNIFICANCE_MARKERS = [
  'matters because',
  'why this matters',
  'the implication',
  'the implications',
  'implications of',
  'at stake',
  'the stakes',
  'the significance',
  'significant because',
  'what this means for',
  'the consequence',
  'the consequences',
  'this suggests that policy',
  'going forward',
  'the broader'
]

// Connectives that introduce a warrant — the sentence explaining how the
// evidence just given bears on the claim. This is a MARKER heuristic, and the
// component it feeds is labelled "reasoning markers" for exactly that reason:
// it detects that the writer reached for an explanatory connective, not that
// the explanation is any good. "Sales rose. Therefore the moon is cheese."
// passes. The relay classifier's `hasWarrant` replaces this.
const WARRANT_MARKERS = [
  'because',
  'therefore',
  'thus',
  'hence',
  'consequently',
  'as a result',
  'which suggests',
  'this suggests',
  'which shows',
  'this shows',
  'which means',
  'this means',
  'which indicates',
  'this indicates',
  'demonstrates that',
  'implies that',
  'in other words',
  'the reason',
  'this is why',
  'follows that',
  // Causal connectives that carry a warrant without announcing it in the
  // register a rubric expects. The list above is the vocabulary of an essay
  // that has been taught to signpost; these are how the same move is made in
  // formal expository prose, which is what a position paper is written in.
  //
  // Added after a nine-sentence MUN paragraph that reasons causally in almost
  // every sentence — "fear speaking out ... DUE TO risks to their livelihood",
  // "quality of life has decreased AS approximately 20% avoid travelling" —
  // scored 0 of 20 for warrant, because it never once wrote "therefore".
  //
  // 'due to' and 'owing to' are safe where a bare 'as' or 'since' would not be:
  // both are unambiguously causal, while "as" is more often temporal or
  // comparative ("as migration rose", "as many as 20%") and would fire on
  // nearly every paragraph ever written.
  'due to',
  'owing to',
  'leads to',
  'leading to',
  'results in',
  'resulting in',
  'gives rise to',
  'stems from',
  'driven by',
  'contributes to',
  'accounts for',
  'so that'
]

/** The paragraph's first sentence, or the whole text if it has only one. */
function firstSentence(text: string): string {
  const match = /[.!?]+["'’”)\]]*\s/.exec(text)
  return match ? text.slice(0, match.index + match[0].length) : text
}

/**
 * The paragraph's final sentence, for the thesis shape test.
 *
 * Same three-lines-of-duplication trade as `firstSentence` — see the note on
 * `afterFirstSentence` for why these do not import the better splitter.
 * Trailing whitespace and a trailing terminator are both tolerated, because a
 * paragraph that ends without punctuation is a draft mid-sentence rather than
 * an error worth refusing.
 */
function lastSentence(text: string): string {
  const parts = splitIntoSentences(text)
  return parts[parts.length - 1] ?? text
}

/**
 * The paragraph's sentences.
 *
 * The same split `lastSentence` always used, lifted out so the thesis scan can
 * read all of them — see paragraphStatesThesis. Deliberately duplicated from
 * `splitSentences` rather than imported: a module with a relative VALUE import
 * cannot be loaded by `npm test`, and this file's tests are the whole reason
 * its rules are checkable at all. CLAUDE.md records the constraint.
 */
function splitIntoSentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?]["'’”)\]]*)\s+/)
}

function startsWithMarker(text: string, markers: string[]): boolean {
  // Anchored at the OPENING of the first sentence, which is what the name says
  // and what the markers are: sentence-openers announcing a turn in the
  // argument. It used to be `includes` over the first 60 characters, and the
  // difference is not academic — "The results were positive overall, and the
  // trend held" was labelled a conclusion, and "The evidence, however, is not
  // decisive" a counterargument. Both are the writer carrying on, not
  // signposting.
  //
  // Two things still have to be allowed through, because both are ordinary
  // prose rather than edge cases: an opening quotation mark or bracket, and a
  // short coordinating conjunction ("But in conclusion, ...").
  const opening = firstSentence(text).slice(0, 60).toLowerCase()
  // Built on demand rather than read out of a prebuilt map with `!`. The map
  // was populated from two of the four marker lists, so passing a third to
  // this function threw a TypeError from inside the structure engine — a
  // latent crash gated only on nobody adding a call site.
  return markers.some((marker) => {
    let re = OPENER.get(marker)
    if (!re) {
      re = openerFor(marker)
      OPENER.set(marker, re)
    }
    return re.test(opening)
  })
}

/**
 * One anchored matcher per marker, memoised on first use.
 *
 * No escaping: every marker is plain lowercase words and spaces. If one ever
 * needs a regex metacharacter, escape it here rather than at the call site.
 *
 * The trailing word boundary matters — without it "in sum" also matches "in
 * summary" and "granted" matches "grantedly", so the label would depend on
 * whichever list entry happened to be reached first.
 */
const OPENER = new Map<string, RegExp>()
function openerFor(marker: string): RegExp {
  return new RegExp(String.raw`^["'‘“(\[]?\s*(?:and|but|so|yet)?\s*${marker}\b`)
}

/**
 * Word-bounded, not a substring match.
 *
 * `lower.includes(marker)` was finding "thus" inside "enthusiasm",
 * "enthusiastic" and "enthusiast" — ordinary essay words. Any paragraph
 * containing one scored full marks for a reasoning connective it never used
 * (warrant is 20 of the 100 points) and had its `warrant-gap` weakness
 * suppressed, so the draft was told its reasoning was fine on the strength of
 * the word "enthusiasm".
 *
 * The plural/singular pairs already in these lists ("the implication" and
 * "the implications") stay correct: `\b` after the singular fails against the
 * "s", and the plural entry matches it instead.
 */
const CONTAINS = new Map<string, RegExp>()
function containsMarker(text: string, markers: string[]): boolean {
  const lower = text.toLowerCase()
  return markers.some((marker) => {
    let re = CONTAINS.get(marker)
    if (!re) {
      re = new RegExp(String.raw`\b${marker}\b`)
      CONTAINS.set(marker, re)
    }
    return re.test(lower)
  })
}

/** Same anchored opening as startsWithMarker, for the pattern form. */
function startsWithCounterargument(text: string): boolean {
  const opening = firstSentence(text).slice(0, 60).toLowerCase()
  return (
    startsWithMarker(text, COUNTERARGUMENT_MARKERS) ||
    COUNTERARGUMENT_PATTERN.test(opening) ||
    COUNTERARGUMENT_NOUN.test(opening)
  )
}

/**
 * Attributed-source markers: "Mueller and Oppenheimer (2014)", "Ravizza et al.".
 *
 * Two or more in one paragraph is the signal, not one. A body paragraph that
 * makes a claim and cites a paper for it is a `claim` paragraph and should stay
 * one; a paragraph that is a RUN of attributions is presenting evidence, which
 * is the thing `evidence-stacking` looks for two of in a row.
 */
/**
 * The FALLBACK only. `heuristicRoles` takes a `hasCitation` predicate and the
 * real caller passes `hasInlineCitation` from `@shared/inlineCitation`, which
 * knows APA, MLA author-page, MLA title, Chicago, numeric, DOI and URL forms.
 *
 * This pattern was the sole detector until it was traced on a real MUN position
 * paper and found **0 of 5** citations in it: it requires the year to sit alone
 * inside the bracket, so `(Tyche Hendricks, 2024)` fails, and it needs a year at
 * all, so the three MLA title citations — `("Background to the Convention")` —
 * fail too. With the count stuck at 0 the `evidence` role below could never be
 * returned, which in turn made `warrant` unearnable and left `evidence-stacking`
 * in weaknesses.ts unreachable.
 *
 * It survives only because this module must stay a leaf `npm test` can load
 * (see afterFirstSentence), so it cannot value-import the shared detector
 * itself. Injection keeps the good one in production and the tests running.
 */
const FALLBACK_CITATION_PATTERN = /\((?:[12]\d{3}[a-z]?)\)|\bet al\b/g

export type CitationPredicate = (sentence: string) => boolean

function fallbackHasCitation(sentence: string): boolean {
  FALLBACK_CITATION_PATTERN.lastIndex = 0
  return FALLBACK_CITATION_PATTERN.test(sentence)
}

/**
 * How many of the paragraph's sentences carry a citation.
 *
 * Per SENTENCE, not per regex match. The old count matched patterns anywhere in
 * the paragraph, so one sentence citing two papers looked like two pieces of
 * evidence; what `evidence-stacking` is actually looking for is a RUN of
 * attributed sentences.
 */
function citationCount(text: string, hasCitation: CitationPredicate): number {
  return text
    .split(/(?<=[.!?]["'’”)\]]*)\s+/)
    .filter((sentence) => sentence.trim().length > 0 && hasCitation(sentence)).length
}

const MIN_CITATIONS_FOR_EVIDENCE = 2

export function hasSignificanceMarker(text: string): boolean {
  return containsMarker(text, SIGNIFICANCE_MARKERS)
}

/**
 * "So what?", asked the way a humanities essay asks it.
 *
 * SIGNIFICANCE_MARKERS is social-science register — "the implications", "at
 * stake", "going forward". A literature or history essay answers the same
 * question in the vocabulary of legacy and consequence: what someone left
 * behind, what endures, what they are remembered for. Judged by the first list
 * alone, an essay closing on "the legacy she left behind tends to reside in the
 * film industry, but she was more than just a pretty face" scores zero for
 * significance, which is not a reading of that sentence anybody would defend.
 *
 * Deliberately a SECOND list rather than an extension of the first, and
 * consulted only for the closing paragraph. These phrases are ordinary
 * narration in the middle of an essay — a body paragraph mentioning a legacy is
 * telling the story, not stepping back from it — and `roleFor` consults
 * SIGNIFICANCE_MARKERS before it considers position, so widening that list
 * would relabel body paragraphs as 'significance' and take their claim credit
 * away. Same words, different meaning depending on where they sit.
 */
export const CLOSING_SIGNIFICANCE_MARKERS = [
  'legacy',
  'lives on',
  'live on',
  'remembered',
  'endures',
  'continues to',
  'more than just',
  'set apart',
  'reminds us',
  'left behind',
  'for generations',
  'to this day'
]

export function hasClosingSignificance(text: string): boolean {
  return hasSignificanceMarker(text) || containsMarker(text, CLOSING_SIGNIFICANCE_MARKERS)
}

/**
 * Whether a FINAL paragraph is actually concluding, rather than the draft
 * simply stopping.
 *
 * `roleFor` deliberately refuses to call the last paragraph a conclusion on
 * position alone — a draft abandoned mid-argument would collect ten free points
 * for a conclusion it does not have, and that reasoning still holds. But the
 * rule it shipped with was stricter than the reason required: it demanded the
 * paragraph OPEN with "In conclusion" or "Ultimately", and a great many essays
 * close on a quotation, a return to the opening image, or a date. This essay's
 * final paragraph opens with a quote and then restates the thesis in so many
 * words; it was labelled `unknown`, and the writer lost the ten points for the
 * one component they had unambiguously satisfied.
 *
 * So position is necessary and still not sufficient: the paragraph must also
 * look retrospective. That keeps the abandoned draft at zero — an argument that
 * stops mid-flight contains none of this vocabulary — while letting a real
 * conclusion be recognised without announcing itself in rubric language.
 */
// Retrospective PHRASES only. 'still', 'today', 'died' and 'no longer' were in
// this list for one draft and are not worth the reach: they are ordinary words
// in ordinary prose, and a final body paragraph reading "critics still argue"
// would have been relabelled a conclusion by one of them. The rubric's own
// standard is that a wrong label should be visibly wrong rather than
// mysteriously costly, and a single common adverb silently buying ten points
// fails it. Everything below names the act of looking back.
const CLOSING_MARKERS = [
  ...CLOSING_SIGNIFICANCE_MARKERS,
  'in the years since',
  'in her final',
  'in his final',
  'in their final',
  'came to an end',
  'in the end'
]

export function looksLikeClosing(text: string): boolean {
  return startsWithMarker(text, CONCLUSION_MARKERS) || containsMarker(text, CLOSING_MARKERS)
}

/**
 * Whether a sentence has the SHAPE of a thesis.
 *
 * Used only for the last sentence of the opening paragraph, and only when claim
 * detection found nothing there. The intro is the paragraph most likely to be
 * dense with checkable facts — dates, places, names — so it is the paragraph
 * where detection is most likely to fire on biography rather than on argument,
 * and, when the relay is unavailable or returns nothing, where its silence
 * costs the most: twenty points, the single largest component.
 *
 * The pattern is a concessive or contrastive frame ("Whilst X, Y"; "Although
 * X, Y"; "not only X but Y") or an explicit differentiating verb — the
 * constructions a thesis uses to say "here is the position I am taking against
 * the obvious one". It is a shape test, not a quality test: it cannot tell a
 * good thesis from a bad one, only a sentence making an argumentative move from
 * a sentence continuing a narrative.
 */
// The "set X apart" arm takes any object, not the four pronouns it started
// with. Written against one essay's "set her apart", it then failed on "sets
// this decade apart" — the same construction with a noun in it, which is how
// the move is written whenever the subject is not a person.
/**
 * The shapes a thesis sentence actually takes.
 *
 * This was ONE regex — a concessive clause followed by a contrastive verb —
 * and it was written to rescue one specific draft. Measured against a
 * deliberately well-structured essay it returned false on every sentence in
 * the piece, including the thesis, so the whole 20-point component was
 * unreachable for anything that did not open "Although X, …". A detector that
 * only recognises the essay it was built from is not a detector.
 *
 * Six shapes now, each a construction writers reach for when stating a
 * contestable claim rather than reporting a fact:
 *
 *   (a) concessive contrast   "Although the reforms raised turnout, they did
 *                              not change who was elected."
 *   (b) scope contrast        "Almost every tool … and almost none of them …"
 *   (c) correction            "The struggle was not an obstacle; it was the
 *                              instrument that …"
 *   (d) signposting           "I argue that …", "This essay contends …"
 *   (e) the real X is …       "The real question is not whether it worked but
 *                              who it worked for."
 *
 * What they have in common is CONTRAST or COMMITMENT — the two things a
 * reportable fact does not have. That is also the limit: this cannot tell a
 * contestable claim from a confidently-worded description, and it never will.
 * It is a floor. The model's own reading of each paragraph arrives with the
 * graded read (`ai/gradeDraft.ts`), which is what replaced the structure
 * classifier this comment used to point at — deleted once nothing called it.
 *
 * Checked against a set of real theses and real non-theses (roles.test.ts) so
 * widening it stays honest: every addition has to leave the negatives negative.
 */
const THESIS_SHAPES = [
  /\b(?:whilst|while|although|though|despite|rather than|not only)\b[^]{0,200}?\b(?:but|yet|however|sparked|distinguish\w*|argues?|demonstrates?|reveals?|proves?|did not|does not|do not|failed to|set\w*\b[^.]{0,30}?\bapart)\b/i,
  /\b(?:every|all|most|almost every|nearly every|virtually every)\b[^]{0,220}?\b(?:none|almost none|nearly none|hardly any|few of|not one|neither)\b/i,
  /\b(?:is|was|were|are)\s+not\b[^]{0,140}?[;,]?\s*\b(?:but|it is|it was|they are|they were|rather)\b/i,
  /\bnot\b[^]{0,80}?\bbut\b[^]{0,80}?\b(?:is|are|was|were)\b/i,
  /\b(?:i|we|this essay|this paper|this article)\s+(?:will\s+)?(?:argue|argues|contend|contends|claim|claims|show|shows)\b/i,
  /\bthe\s+(?:real|actual|central|deeper|underlying|important|only)\s+(?:question|problem|issue|point|difference|distinction|danger)\b[^]{0,80}?\bis\b/i
]

export function looksLikeThesis(sentence: string): boolean {
  return THESIS_SHAPES.some((shape) => shape.test(sentence))
}

/**
 * Whether the opening "paragraph" is really the essay's title.
 *
 * `splitParagraphs` treats any newline run as a boundary, so a titled essay
 * arrives with its title as paragraph 1 and its introduction as paragraph 2.
 * Every position rule downstream then reads one paragraph too early — and the
 * thesis rule only ever looks at paragraph 1, so the whole 20-point component
 * became unreachable for any student who titled their work. A four-paragraph
 * essay scored 78 hand-split without its title and 48 as actually written,
 * which is a thirty-point penalty for a heading.
 *
 * Two conditions together, because either alone is wrong. Short: a title is a
 * noun phrase, not a paragraph. Unterminated: an opening line ending in a full
 * stop is a first sentence, however brief. "In conclusion." would satisfy the
 * length test on its own and is plainly not a title.
 */
const TITLE_MAX_WORDS = 12

export function looksLikeTitle(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (/[.!?]["'’”)\]]*$/.test(trimmed)) return false
  return trimmed.split(/\s+/).length <= TITLE_MAX_WORDS
}

/**
 * Whether a body paragraph OPENS by asserting something about its subject.
 *
 * The rubric's `governingClaims` asks whether body paragraphs are governed by
 * claims, and `roleFor` answered it entirely from claim detection: a paragraph
 * counted only if the relay happened to flag a checkable assertion inside it.
 * Those are different questions, and the gap between them is where a real essay
 * loses its marks. The paragraph that opens "Audrey Hepburn was always
 * naturally inclined to help others" is governed by a claim in the only sense
 * the rubric means; it is also unverifiable, so claim detection — which looks
 * for statements that could be checked against a source — has every reason to
 * pass over it. An evaluative topic sentence is precisely the kind of assertion
 * that CANNOT be fact-checked, so keying the component to fact-detection scored
 * the strongest paragraph openings lowest.
 *
 * A citation in the first sentence disqualifies it: a paragraph opening with an
 * attribution is presenting evidence, and `roleFor` should keep reaching its
 * evidence branch for those.
 */
const TOPIC_CLAIM_SHAPE = /\b(?:was|were|is|are|remains?|remained|became|stood out|proved|represents?)\b/i

export function looksLikeTopicClaim(firstSentenceText: string, hasCitationIn: CitationPredicate): boolean {
  if (hasCitationIn(firstSentenceText)) return false
  if (firstSentenceText.trim().split(/\s+/).length < 5) return false
  return TOPIC_CLAIM_SHAPE.test(firstSentenceText)
}

/**
 * Everything after the paragraph's first sentence, or '' if it has only one.
 *
 * `firstSentence`/`afterFirstSentence` are deliberately NOT `splitSentences`
 * from `ai/sentenceSplit`, even though that is the better splitter. `npm test` runs these files through Node's type
 * stripping, whose ESM resolver rejects the extensionless relative imports this
 * codebase uses everywhere — so a module with a relative VALUE import cannot be
 * unit tested, which is why every existing tested module (`markdown.ts`,
 * `clipRects.ts`, `insertPoint.ts`) is a self-contained leaf. Keeping this one
 * a leaf is worth three lines of duplication; the alternative is that the role
 * heuristics ship untested. Do not "tidy" this into an import without checking
 * `npm test` still runs.
 *
 * The precision `splitSentences` adds — curly quotes, newline boundaries — buys
 * nothing here: paragraphs contain no newlines by construction, and this only
 * needs to know where to start looking for a lowercase connective, not to
 * produce exact spans.
 */
function afterFirstSentence(text: string): string {
  const rest = text.slice(firstSentence(text).length)
  // firstSentence() returns the whole text when there is no boundary, which
  // correctly yields '' here — a one-sentence paragraph has no warrant.
  return rest
}

/**
 * Whether a paragraph appears to explain its own evidence.
 *
 * The connective may appear ANYWHERE in the paragraph, provided the paragraph
 * has more than one sentence.
 *
 * It used to have to fall outside the first sentence, on the reasoning that a
 * warrant follows the thing it warrants — "Because turnout fell, the result was
 * close." is a claim, not an explanation. That reasoning holds for a paragraph
 * that IS that sentence, and fails for everything longer. Measured on a
 * deliberately well-reasoned essay, two of its most heavily argued paragraphs
 * were flagged `warrant-gap`: one opened "This is the fact I want to sit with,
 * because it is genuinely strange" and then spent four sentences explaining
 * why, and the rule threw away the connective and read the rest as unreasoned.
 *
 * The sentence-count floor keeps the case the original was written for: a
 * one-sentence paragraph whose only connective is in that sentence has stated
 * something, not explained it.
 */
export function hasWarrantMarker(paragraphText: string): boolean {
  if (afterFirstSentence(paragraphText).trim().length === 0) return false
  return containsMarker(paragraphText, WARRANT_MARKERS)
}

export interface HeuristicRoleInput {
  paragraphs: ParagraphSpan[]
  /** Detected claim ids per 1-based paragraph index. */
  claimsByParagraph: Map<number, string[]>
  /**
   * How to tell whether a sentence carries a citation. `analyzeStructure`
   * passes the shared detector; omitting it falls back to the weak local
   * pattern, which is why the fallback is documented as a liability.
   */
  hasCitation?: CitationPredicate
}

export interface HeuristicRoles {
  /**
   * Which paragraph the local reader puts the thesis in, 1-based, or 0 when it
   * found none. Exported so `analyzeStructure` can hand it to `scoreDraft` as a
   * FALLBACK when the classifier's role vector names no thesis — see
   * ScoreSignals.thesisFallbackIndex. It never overwrites a role.
   */
  thesisIndex: number
  roles: ParagraphRole[]
  warranted: boolean[]
  /**
   * Whether the paragraph asserts a sub-point of its own — a separate axis from
   * `role`, see ReconciledRoles.statesClaim in ai/structureRoles.ts for the
   * whole argument and the essay that made it visible.
   *
   * Both signals `roleFor` would use to return 'claim', asked WITHOUT the
   * precedence that stops it getting there. A paragraph carrying two
   * attributions reaches the evidence branch and never reaches the claim one,
   * so its topic sentence went unread; here it is read regardless.
   */
  statesClaim: boolean[]
}

/**
 * Precedence is deliberate and worth reading in order. Explicit markers beat
 * position, because a writer who wrote "In conclusion" in paragraph 4 meant it,
 * and position beats claim presence, because the opening claim of an essay is
 * its thesis rather than one body claim among many.
 */
export function heuristicRoles({
  paragraphs,
  claimsByParagraph,
  hasCitation = fallbackHasCitation
}: HeuristicRoleInput): HeuristicRoles {
  const roles: ParagraphRole[] = []
  const warranted: boolean[] = []
  const statesClaim: boolean[] = []
  const lastIndex = paragraphs.length

  // Where the argument actually starts. A titled essay puts its title in
  // paragraph 1 and its introduction in paragraph 2, and every position rule
  // below would otherwise read one paragraph too early — see looksLikeTitle.
  const openingIndex = paragraphs.length > 1 && looksLikeTitle(paragraphs[0].text) ? 2 : 1
  const thesisIndex = thesisParagraphIndex(paragraphs, openingIndex)

  for (const paragraph of paragraphs) {
    const hasClaim = (claimsByParagraph.get(paragraph.index) ?? []).length > 0
    roles.push(roleFor(paragraph, hasClaim, lastIndex, hasCitation, thesisIndex, openingIndex))
    warranted.push(hasWarrantMarker(paragraph.text))
    statesClaim.push(hasClaim || looksLikeTopicClaim(firstSentence(paragraph.text), hasCitation))
  }

  return { thesisIndex, roles, warranted, statesClaim }
}

/**
 * Which paragraph carries the thesis — not necessarily the first one.
 *
 * The rule was purely positional: the thesis is in paragraph 1, or 2 behind a
 * title, and nowhere else. That is one essay shape, and a common and often
 * better one puts two or three paragraphs of setup first and states the claim
 * once the reader can see why it matters. Measured on a deliberately
 * well-structured essay whose thesis opened paragraph 5 ("Almost every tool
 * built for writers … has been built to remove friction, and almost none of
 * them distinguish between the friction that is the work and the friction that
 * is merely in the way"): thesis scored 0/20, and every paragraph before it was
 * 'unknown', so the reading was also "provisional".
 *
 * So the opening position is tried first and, failing that, the scan continues
 * to the HALFWAY point of the draft and takes the first paragraph whose last
 * sentence has the shape of a thesis.
 *
 * Two bounds keep this from swallowing body claims. It stops at the halfway
 * point, because a claim stated for the first time in the second half is a
 * body claim however thesis-shaped it reads. And it never considers the final
 * paragraph, where a thesis-shaped sentence is the conclusion restating it.
 *
 * Lateness is priced rather than ignored: `scoreDraft` already awards half
 * credit for a thesis found past position 1, so being generous here cannot
 * hand a delayed thesis the same marks as an up-front one.
 */
function thesisParagraphIndex(paragraphs: ParagraphSpan[], openingIndex: number): number {
  const opening = paragraphs.find((p) => p.index === openingIndex)
  if (opening && paragraphStatesThesis(opening.text)) return openingIndex

  const limit = Math.min(Math.max(openingIndex, Math.ceil(paragraphs.length / 2)), paragraphs.length - 1)
  for (const paragraph of paragraphs) {
    if (paragraph.index <= openingIndex || paragraph.index > limit) continue
    if (paragraphStatesThesis(paragraph.text)) return paragraph.index
  }
  return openingIndex
}

/**
 * Does ANY sentence in this paragraph state the thesis?
 *
 * Not just the last one. "Thesis-last" is a convention taught in schools, not a
 * rule writers follow — and the previous code read only the final sentence, so
 * a paragraph that stated its claim and then spent three sentences unpacking it
 * came back with nothing. Measured: an essay whose thesis was the SECOND of
 * four sentences in its paragraph scored 0/20 for a thesis it had.
 *
 * The scan is bounded elsewhere — `thesisParagraphIndex` stops at the halfway
 * point and takes the first match — so widening from one sentence to all of
 * them cannot reach into the body.
 */
function paragraphStatesThesis(text: string): boolean {
  return splitIntoSentences(text).some((sentence) => looksLikeThesis(sentence))
}

function roleFor(
  paragraph: ParagraphSpan,
  hasClaim: boolean,
  lastIndex: number,
  hasCitation: CitationPredicate,
  /** The paragraph the thesis was found in — see thesisParagraphIndex. */
  thesisIndex: number,
  /** Where the argument starts — 2 when paragraph 1 is a title. Paragraphs
   *  before this are the title; between this and the thesis they are setup. */
  openingIndex: number
): ParagraphRole {
  const { text, index } = paragraph

  if (startsWithMarker(text, CONCLUSION_MARKERS)) return 'conclusion'
  if (startsWithCounterargument(text)) return 'counterargument'
  // The LAST paragraph is judged as a conclusion before it is judged as
  // significance, because the two are routinely the same paragraph and only one
  // role can be carried. A closing paragraph that says why the argument matters
  // used to be labelled 'significance' and score 0/10 for a conclusion it
  // plainly was. Significance is no longer lost by this: scoreDraft credits it
  // from the marker itself, wherever the marker is — see `significanceAnywhere`.
  // `hasClosingSignificance` as well as `looksLikeClosing`: a final paragraph
  // that says why the argument mattered is a conclusion, and it was being
  // labelled 'significance' and scoring 0/10 for the close it plainly was.
  // Still not position alone — the original worry, that a draft stopping
  // mid-argument would collect a free 10 points, is answered by requiring a
  // retrospective or stakes marker. A draft that stops does not say "the stakes
  // here are".
  if (index === lastIndex && (looksLikeClosing(text) || hasClosingSignificance(text))) {
    return 'conclusion'
  }
  if (hasSignificanceMarker(text)) return 'significance'

  // An opening paragraph that asserts something is stating the essay's thesis.
  // An opening paragraph that asserts nothing is a hook or scene-setting, and
  // this heuristic cannot tell those apart from a missing thesis — so it says
  // 'unknown' rather than inventing either answer.
  //
  // The shape test is the second way in, for the case that turns out to be
  // common: an intro whose thesis is its LAST sentence, after a paragraph of
  // biography. Claim detection fires on the biography — dates and places are
  // checkable — and, when it returns nothing at all for the paragraph, the
  // thesis went unrecognised entirely. See looksLikeThesis.
  if (index === thesisIndex) {
    if (hasClaim) return 'thesis'
    // paragraphStatesThesis, not looksLikeThesis(lastSentence(...)): the scan
    // that CHOSE this paragraph reads every sentence, and this read only the
    // last one — so a paragraph selected on its second sentence came straight
    // back as 'unknown' and the component scored 0 anyway. Two functions
    // answering the same question differently is how that survived a rebuild.
    return paragraphStatesThesis(text) ? 'thesis' : 'unknown'
  }

  // The title itself. Not 'unknown' by accident but by fact: it is not a
  // paragraph of the argument, and labelling it anything else would let it
  // collect credit for a component it cannot satisfy.
  if (index < openingIndex) return 'unknown'

  // Setup before a delayed thesis. It falls through to the branches below
  // rather than being forced to 'unknown', because a paragraph of context that
  // cites three studies IS evidence and should be able to say so — the old
  // rule blanked everything ahead of the thesis, which is why an essay that
  // opened with two paragraphs of literature came back mostly unlabelled.

  // Deliberately NOT "the last paragraph is the conclusion" — a draft that
  // stops mid-argument would score a free 10 points for a conclusion it does
  // not have. But position plus retrospective vocabulary is not position
  // alone, and requiring the paragraph to OPEN with "In conclusion" missed
  // every essay that closes on a quotation or an image. See looksLikeClosing.
  if (index === lastIndex) {
    if (looksLikeClosing(text)) return 'conclusion'
    // Unchanged from before otherwise: no claim and nothing retrospective is
    // 'unknown', and a final paragraph carrying a claim falls through to the
    // branches below exactly as it always did.
    if (!hasClaim) return 'unknown'
  }

  // Before the claim branch, because a run of attributions is evidence even
  // when claim detection flags the findings inside it as assertions — which it
  // does, since "X found that Y" is a checkable statement.
  //
  // Without this branch `roleFor` could never return 'evidence' at all, and
  // `evidence-stacking` in weaknesses.ts was unreachable dead code on the
  // heuristic path. Found by tracing a draft written to trigger it.
  if (citationCount(text, hasCitation) >= MIN_CITATIONS_FOR_EVIDENCE) return 'evidence'

  if (hasClaim) return 'claim'

  // A topic sentence the relay had no reason to flag. Last, so every stronger
  // signal — markers, citations, detected claims — still decides first, and
  // this only ever turns an 'unknown' into a 'claim'. See looksLikeTopicClaim.
  return looksLikeTopicClaim(firstSentence(text), hasCitation) ? 'claim' : 'unknown'
}
