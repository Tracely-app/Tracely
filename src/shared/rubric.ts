/**
 * The rubric, verbatim, and what every flag in this app traces back to it.
 *
 * Owner, 2026-08-19: *"from now on, ONLY flag stuff that come out of this
 * list."* This file is that instruction made structural rather than
 * remembered. `FLAG_RUBRIC_SOURCE` is total over every flag kind the product
 * can raise, so a new kind does not typecheck until someone names the clause it
 * comes from — and `rubric.test.ts` asserts each named clause appears VERBATIM
 * in `RUBRIC_TEXT` below, so the clause cannot be invented either.
 *
 * That pair is the whole point. A comment saying "keep flags on-rubric" is the
 * kind of thing this codebase has already watched go stale (the header of the
 * since-deleted `structureClassifier.ts` misdescribed its own deployment twice,
 * in opposite directions); a total record plus a substring assertion cannot.
 *
 * Three flag kinds were deleted when this landed, because no clause covered
 * them: `no-counterargument` ("Do not require counterarguments for every
 * essay"), `passive-voice`, and `spacing`. Two citation defects went the same
 * way. The audit is in the PR; what survives is this table.
 *
 * A leaf with type-only imports, so `npm test` can load it.
 */

import type { CohesionFindingKind, StructureWeaknessKind } from './types.ts'
import type { ProseIssueKind } from './proseIssues.ts'

/**
 * The rubric as the owner wrote it, unedited.
 *
 * Stored as data rather than paraphrased into prose, because the test greps it:
 * a clause cited by `FLAG_RUBRIC_SOURCE` has to be a substring of this. Reword
 * anything here and the mapping fails loudly instead of drifting.
 *
 * When the owner revises the rubric, replace this wholesale and let the test
 * tell you which flags no longer have a home. That failure IS the review.
 */
export const RUBRIC_TEXT = `When grading an essay, evaluate the quality of the THINKING and ARGUMENT, not just vocabulary, grammar, or how sophisticated the essay sounds.

CORE PRINCIPLE:
A strong essay consistently moves from CLAIM -> EVIDENCE -> REASONING -> SIGNIFICANCE. Flag places where one of these links is missing or weak.

THESIS / CENTRAL ARGUMENT
- Flag if there is no identifiable central argument.
- Flag if the thesis merely restates the prompt or topic.
- Flag if the thesis is technically a claim but is too obvious, broad, vague, or difficult to defend.
- Flag if the body paragraphs do not actually support the thesis.

CLAIMS
- Flag claims that are asserted without evidence or reasoning when evidence/reasoning is needed.
- Flag claims that are significantly broader than the evidence supporting them.
- Flag absolute language ("always," "never," "everyone," "completely") when the argument does not justify it.
- Flag claims that contradict earlier claims without explanation.

EVIDENCE
- Flag evidence that is interesting but irrelevant to the argument.
- Flag vague examples when a specific example is necessary.
- Flag unsupported factual claims when factual support is expected.
- Flag excessive quotation or evidence dumping.
- Flag evidence that is introduced but never analyzed.
- If evidence is misrepresented or interpreted incorrectly, flag it as a major issue.

ANALYSIS / REASONING
- Flag summary that replaces analysis.
- Flag when the writer expects the reader to make an important logical connection themselves.
- Flag logical leaps between evidence and conclusion.
- Flag conclusions that do not actually follow from the evidence.
- Flag circular reasoning.
- Flag false cause-and-effect reasoning.
- Flag correlation being treated as causation.
- Flag one example being used to establish an overly broad generalization.

DEPTH
- Flag when the essay repeatedly makes the same point without developing it.

COUNTERARGUMENTS / NUANCE
- Flag fake counterarguments that are obviously weak and only included to make the author's position look better.
- Do not require counterarguments for every essay; judge based on the prompt and genre.
- Do not confuse uncertainty with nuance: "it depends" without explaining what it depends on is weak reasoning.

PARAGRAPH QUALITY
- Flag paragraphs that contain several unrelated ideas.
- Flag paragraphs that repeat the same argumentative function as another paragraph.
- Flag paragraphs that contain evidence but no meaningful interpretation.
- Flag paragraphs that contain analysis unrelated to their topic sentence.

ORGANIZATION
- Flag ideas introduced before the reader has enough context to understand them.
- Flag sudden jumps between ideas.
- Flag conclusions that introduce major new arguments.
- Flag introductions that spend excessive space on background before establishing the actual argument.
- Transitions should communicate relationships between ideas, not merely fill space.

RELEVANCE
- Flag tangents.
- Flag interesting information that does not contribute to answering the prompt.
- Flag excessive historical/background information that never becomes relevant to the argument.

INTRODUCTIONS
- Flag excessive generic hooks ("Since the beginning of time...").
- Flag rhetorical questions that add no substantive value.
- Flag lengthy background sections that delay the thesis.

CONCLUSIONS
- A conclusion should synthesize the argument rather than simply repeat the thesis word-for-word.
- Flag conclusions that introduce important evidence or arguments that should have appeared earlier.
- Flag generic endings that could apply to almost any essay.

STYLE / CLARITY
- Flag unnecessarily complicated wording that makes the meaning harder to understand.
- Flag vague words when precision is possible.
- Flag repetitive sentence structures when they noticeably hurt readability.
- Flag excessive filler and redundant phrases.
- Flag sentences containing multiple ideas that are difficult to follow.

GRAMMAR / MECHANICS
- Distinguish between minor errors and errors that interfere with meaning.
- Do not heavily penalize an occasional typo or comma mistake.
- Flag repeated grammatical patterns that make the writing difficult to understand.
- Flag sentence fragments, run-ons, incorrect word usage, and unclear pronoun references when they materially affect readability.

COHESION
- Flag "this," "that," "it," or "they" when the reader cannot tell what they refer to.
- Flag paragraphs that feel disconnected from the preceding argument.
- Flag when the author changes terminology and accidentally creates ambiguity about whether they mean the same thing.

PRECISION
- Flag vague statements that sound meaningful but cannot be clearly interpreted.
- Flag unsupported adjectives such as "obviously," "clearly," "massive," "terrible," or "incredible" when they substitute for reasoning.

COMPARISONS
- When comparing two things, flag comparisons based on superficial similarities.
- Flag when the essay discusses A extensively and B extensively but never actually compares them.

CAUSE / EFFECT
- Flag "A happened, then B happened, therefore A caused B."

SOURCE USE
- Flag citations that appear attached to claims they do not support.
- Flag overreliance on one source when multiple perspectives are necessary.
- Do not assume a citation automatically makes a claim valid.

SYNTHESIS
- Flag "Source A says X. Source B says Y. Source C says Z." when the essay never explains the relationship between them.

PERSUASIVENESS
- Flag arguments that depend heavily on assumptions the essay never establishes.

EFFICIENCY
- Flag repetitive explanations.
- Flag sentences that restate the previous sentence without adding a new layer.

ASSIGNMENT ALIGNMENT
- Do not penalize an essay for failing to include elements the assignment never requires.
- Do not reward irrelevant sophistication.`

/** The heading a clause sits under, so the report can group by rubric section. */
export type RubricSection =
  | 'CORE PRINCIPLE'
  | 'THESIS / CENTRAL ARGUMENT'
  | 'CLAIMS'
  | 'EVIDENCE'
  | 'ANALYSIS / REASONING'
  | 'DEPTH'
  | 'PARAGRAPH QUALITY'
  | 'ORGANIZATION'
  | 'INTRODUCTIONS'
  | 'CONCLUSIONS'
  | 'STYLE / CLARITY'
  | 'GRAMMAR / MECHANICS'
  | 'COHESION'
  | 'PRECISION'
  | 'SOURCE USE'
  | 'SYNTHESIS'
  | 'EFFICIENCY'

export interface RubricClause {
  section: RubricSection
  /** Verbatim from RUBRIC_TEXT. Asserted as a substring by rubric.test.ts. */
  clause: string
}

/** Every kind of flag this product can raise at the writer. */
/**
 * Every kind of flag this product raises from a LOCAL rule.
 *
 * `'model-finding'` is excluded, and that is the honest answer rather than a
 * gap. A compile-time Record maps one kind to one clause; a graded read raises
 * findings across the whole rubric, so any clause chosen here would be an
 * arbitrary one standing in for twenty. Its attribution is per finding, in
 * `StructureWeakness.rubricSection`, enforced twice: the relay constrains it to
 * a schema enum of the section names, and `shared/gradedDraft.ts` discards any
 * finding whose section is not one of them.
 *
 * So the guarantee is unchanged — nothing reaches the writer that the rubric
 * does not name — but for that one kind it is checked when the finding arrives
 * instead of when the code compiles.
 */
export type FlagKind =
  | Exclude<StructureWeaknessKind, 'model-finding'>
  | CohesionFindingKind
  | ProseIssueKind

/**
 * Where each flag comes from in the rubric.
 *
 * TOTAL over `FlagKind` on purpose: adding a kind to any of the three unions
 * breaks the build here until it is given a clause, and the test then checks
 * that clause is really in the rubric. Between them there is no way to ship a
 * flag the owner's list does not ask for — which is the instruction, enforced
 * rather than promised.
 *
 * If a genuinely useful check has no clause, the answer is to ask for the
 * rubric to be extended, not to widen a neighbouring clause to cover it. A
 * mapping that stretches is the same failure as no mapping at all, one commit
 * later.
 */
export const FLAG_RUBRIC_SOURCE: Record<FlagKind, RubricClause> = {
  // --- structure: the argument -------------------------------------------
  'no-thesis': {
    section: 'THESIS / CENTRAL ARGUMENT',
    clause: 'Flag if there is no identifiable central argument.'
  },
  'topic-not-thesis': {
    section: 'THESIS / CENTRAL ARGUMENT',
    clause: 'Flag if the thesis merely restates the prompt or topic.'
  },
  // One measurement, and it could equally cite RELEVANCE's "Flag tangents." The
  // THESIS clause is the stronger statement of the two — a tangent is a
  // paragraph that goes nowhere, this is a paragraph that goes somewhere the
  // draft did not say it was going.
  'off-thesis-paragraph': {
    section: 'THESIS / CENTRAL ARGUMENT',
    clause: 'Flag if the body paragraphs do not actually support the thesis.'
  },
  'unsupported-claim': {
    section: 'CLAIMS',
    clause:
      'Flag claims that are asserted without evidence or reasoning when evidence/reasoning is needed.'
  },
  'overreaching-claim': {
    section: 'CLAIMS',
    clause:
      'Flag absolute language ("always," "never," "everyone," "completely") when the argument does not justify it.'
  },
  'dropped-evidence': {
    section: 'EVIDENCE',
    clause: 'Flag evidence that is introduced but never analyzed.'
  },
  // The surviving citation defects are here, not under SOURCE USE. A
  // placeholder author, a bracketed "[citation needed]" and a bare URL all mean
  // the same thing: there is no source a reader could follow, so the sentence
  // is factually unsupported. SOURCE USE asks whether a real source bears the
  // claim out, which only the critique can answer — see the note in
  // citationShape.ts.
  'malformed-citation': {
    section: 'EVIDENCE',
    clause: 'Flag unsupported factual claims when factual support is expected.'
  },
  'summary-without-point': {
    section: 'ANALYSIS / REASONING',
    clause: 'Flag summary that replaces analysis.'
  },
  // The four the classifier names. Each is its own rubric line, which is the
  // whole reason they are separate kinds: `warrant-gap` was carrying all of
  // them and could say none of them.
  'circular-reasoning': {
    section: 'ANALYSIS / REASONING',
    clause: 'Flag circular reasoning.'
  },
  'sequence-as-cause': {
    section: 'ANALYSIS / REASONING',
    clause: 'Flag correlation being treated as causation.'
  },
  'single-case-generalisation': {
    section: 'ANALYSIS / REASONING',
    clause: 'Flag one example being used to establish an overly broad generalization.'
  },
  'logical-leap': {
    section: 'ANALYSIS / REASONING',
    clause: 'Flag logical leaps between evidence and conclusion.'
  },
  'warrant-gap': {
    section: 'ANALYSIS / REASONING',
    clause:
      'Flag when the writer expects the reader to make an important logical connection themselves.'
  },
  'undeveloped-repetition': {
    section: 'EFFICIENCY',
    clause: 'Flag sentences that restate the previous sentence without adding a new layer.'
  },
  'evidence-stacking': {
    section: 'SYNTHESIS',
    clause:
      'Flag "Source A says X. Source B says Y. Source C says Z." when the essay never explains the relationship between them.'
  },
  'new-claim-in-conclusion': {
    section: 'ORGANIZATION',
    clause: 'Flag conclusions that introduce major new arguments.'
  },
  'restated-conclusion': {
    section: 'CONCLUSIONS',
    clause:
      'A conclusion should synthesize the argument rather than simply repeat the thesis word-for-word.'
  },
  'generic-opening': {
    section: 'INTRODUCTIONS',
    clause: 'Flag excessive generic hooks ("Since the beginning of time...").'
  },
  // The one flag whose clause is the core principle rather than a section: an
  // essay that never says what follows from it is missing the last link of
  // CLAIM -> EVIDENCE -> REASONING -> SIGNIFICANCE.
  'no-significance': {
    section: 'CORE PRINCIPLE',
    clause: 'Flag places where one of these links is missing or weak.'
  },

  // --- cohesion: the joins ------------------------------------------------
  'vague-significance': {
    section: 'PRECISION',
    clause: 'Flag vague statements that sound meaningful but cannot be clearly interpreted.'
  },
  'unsupported-emphasis': {
    section: 'PRECISION',
    clause:
      'Flag unsupported adjectives such as "obviously," "clearly," "massive," "terrible," or "incredible" when they substitute for reasoning.'
  },
  'unclear-reference': {
    section: 'COHESION',
    clause: 'Flag "this," "that," "it," or "they" when the reader cannot tell what they refer to.'
  },
  'no-transition': {
    section: 'ORGANIZATION',
    clause: 'Transitions should communicate relationships between ideas, not merely fill space.'
  },
  'topic-jump': {
    section: 'ORGANIZATION',
    clause: 'Flag sudden jumps between ideas.'
  },
  // Raising an objection and never answering it is not the same as not having
  // one — the writer chose to raise it. That is why this survives while
  // `no-counterargument` did not.
  'unanswered-counterargument': {
    section: 'COHESION',
    clause: 'Flag paragraphs that feel disconnected from the preceding argument.'
  },

  // --- prose: mechanics and clarity ---------------------------------------
  // All four grammar kinds cite the same clause, and the qualifier at its end
  // is the standard they are held to: "when they materially affect
  // readability". Anything failing that test does not belong in this file.
  'repeated-word': {
    section: 'GRAMMAR / MECHANICS',
    clause:
      'Flag sentence fragments, run-ons, incorrect word usage, and unclear pronoun references when they materially affect readability.'
  },
  'article-agreement': {
    section: 'GRAMMAR / MECHANICS',
    clause:
      'Flag sentence fragments, run-ons, incorrect word usage, and unclear pronoun references when they materially affect readability.'
  },
  'possessive-its': {
    section: 'GRAMMAR / MECHANICS',
    clause:
      'Flag sentence fragments, run-ons, incorrect word usage, and unclear pronoun references when they materially affect readability.'
  },
  'subject-verb': {
    section: 'GRAMMAR / MECHANICS',
    clause:
      'Flag sentence fragments, run-ons, incorrect word usage, and unclear pronoun references when they materially affect readability.'
  },
  'verb-of': {
    section: 'GRAMMAR / MECHANICS',
    clause:
      'Flag sentence fragments, run-ons, incorrect word usage, and unclear pronoun references when they materially affect readability.'
  },
  'run-together': {
    section: 'GRAMMAR / MECHANICS',
    clause:
      'Flag sentence fragments, run-ons, incorrect word usage, and unclear pronoun references when they materially affect readability.'
  },
  'capitalisation': {
    section: 'GRAMMAR / MECHANICS',
    clause:
      'Flag repeated grammatical patterns that make the writing difficult to understand.'
  },
  'wordiness': {
    section: 'STYLE / CLARITY',
    clause: 'Flag excessive filler and redundant phrases.'
  },
  'filler': {
    section: 'STYLE / CLARITY',
    clause: 'Flag excessive filler and redundant phrases.'
  },
  'long-sentence': {
    section: 'STYLE / CLARITY',
    clause: 'Flag sentences containing multiple ideas that are difficult to follow.'
  }
}

/** The rubric clause a flag comes from. Total, so this cannot return undefined. */
export function rubricSourceFor(kind: FlagKind): RubricClause {
  return FLAG_RUBRIC_SOURCE[kind]
}
