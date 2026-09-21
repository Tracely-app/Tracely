/**
 * The owner's grading rubric, verbatim, and the sections a finding may cite.
 *
 * NOT the same thing as shared/rubric.js. That file is the server's own
 * seven-section weighted rubric, built for the web app's scorer before the
 * desktop and the relay existed on this server; the two share no clause text.
 * This file is the rubric the desktop's flags trace back to and the relay's
 * grader graded against — the one POST /api/grade now sends to the model — so
 * it has to be the same bytes as theirs, not a paraphrase of it.
 *
 * Ported from the desktop app:
 *  - RUBRIC_TEXT from src/shared/rubric.ts, BYTE-EQUAL. The relay's
 *    lib/prompts.ts held a third copy, also byte-equal; the relay's comment
 *    called src/shared/rubric.ts canonical and said the copies "must be
 *    changed together". test/mirror.test.js holds this one to the desktop and
 *    test/prompts.test.js holds the grade prompt built from it to the relay.
 *  - RUBRIC_SECTIONS from src/shared/gradedDraft.ts, DEEP-EQUAL (the relay's
 *    copy is the same 20 strings, in the same order).
 *
 * Only these two constants are ported. The desktop's FLAG_RUBRIC_SOURCE — the
 * table tying each local flag kind to a clause — describes flags the desktop
 * raises and the server does not, so a copy here would be a second list to
 * keep in step with nothing reading it.
 *
 * The desktop's formatting (single quotes, no semicolons) is kept on purpose,
 * so a diff against src/ shows only the type annotations that had to go.
 * A leaf: no imports.
 */

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

/**
 * The rubric sections a finding may be attributed to.
 *
 * Mirrors `RUBRIC_SECTIONS` in the relay's `lib/prompts.ts`, which is a schema
 * enum, so a well-behaved model cannot return anything else. Checked again here
 * because "the relay constrains it" is a statement about a deployment, and this
 * codebase has already been wrong once about what was deployed.
 */
export const RUBRIC_SECTIONS = [
  'THESIS / CENTRAL ARGUMENT',
  'CLAIMS',
  'EVIDENCE',
  'ANALYSIS / REASONING',
  'DEPTH',
  'COUNTERARGUMENTS / NUANCE',
  'PARAGRAPH QUALITY',
  'ORGANIZATION',
  'RELEVANCE',
  'INTRODUCTIONS',
  'CONCLUSIONS',
  'STYLE / CLARITY',
  'COHESION',
  'PRECISION',
  'COMPARISONS',
  'CAUSE / EFFECT',
  'SOURCE USE',
  'SYNTHESIS',
  'PERSUASIVENESS',
  'EFFICIENCY'
]
