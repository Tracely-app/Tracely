/**
 * Graded read: the system prompt and schema behind POST /api/grade.
 *
 * The rubric itself is not pasted in here. RUBRIC_TEXT and RUBRIC_SECTIONS
 * come from shared/rubricText.js, which test/mirror.test.js holds byte-equal to
 * the desktop's src/shared/rubric.ts and src/shared/gradedDraft.ts, and
 * test/prompts.test.js checks the assembled prompt, interpolation included,
 * against the relay's. The server's one copy of the owner's rubric is pinned to
 * both of the others.
 *
 * Every finding the model returns is re-checked by verifyGrade in
 * shared/gradedDraft.js before it leaves the server: its quote must be found
 * in the paragraphs that were actually sent.
 *
 * Ported from the relay (questionablepuddle/Tracely-relay @ 027f920,
 * lib/gradePrompt.ts), which answered the desktop app before this server took its
 * routes over. THE PROMPT STRINGS ARE BYTE-IDENTICAL to the relay's, and
 * test/prompts.test.js compares them against the relay source whenever a relay
 * checkout is present. The desktop's parsing was tuned against these exact
 * words, so a "harmless" rewording here is a behaviour change on a surface
 * nobody is watching.
 *
 * What differs from the relay's source, none of which the model sees:
 *  - Each schema is exported as { name, schema } with the BARE JSON schema.
 *    The relay wrapped it as { name, strict, schema } for chat completions'
 *    json_schema. structuredCall in lib/llm.js wants the bare schema plus a
 *    name and adds strict itself — and handed the wrapper instead, it would
 *    sail through assertStrictSchema (the wrapper has no `type`, so nothing
 *    gets walked) and then 400 at OpenAI on the first real call.
 *  - TypeScript's `as const` is dropped; this tree is plain ESM with no build.
 *  - The relay's formatting (single quotes, no semicolons) is kept on purpose,
 *    so a diff against the relay shows only the changes listed here.
 *  - The relay imported RUBRIC_TEXT and RUBRIC_SECTIONS from its own
 *    lib/prompts.ts; they come from shared/rubricText.js here.
 *  - The component maxima named in COMPONENT's comment are also exported as
 *    COMPONENT_MAX from shared/gradedDraft.js, which is what actually clamps.
 */
import { RUBRIC_SECTIONS, RUBRIC_TEXT } from '../../shared/rubricText.js'

/**
 * The whole essay, read once, against the owner's rubric.
 *
 * This replaces a local rule stack in the desktop client — ten prose detectors,
 * a cohesion pass, an embedding-based tangent check and most of a weakness
 * generator. Owner, 2026-08-19: *"if I just gave an essay to ChatGPT and had it
 * graded with a detailed prompt, it would give a pretty good response on what
 * to change."* Correct, and the rules were covering the easy half of the rubric
 * while producing most of the false positives.
 *
 * Two things make that safe to do here rather than in a chat window:
 *
 * - **`rubricSection` is a schema ENUM.** The owner's hard requirement is that
 *   Tracely flags only what the rubric names. That was a compile-time Record in
 *   the client; here the model cannot return a finding attributed to anything
 *   else.
 * - **Every finding about words must quote them verbatim.** The client searches
 *   the draft for the string and throws the finding away if it is not there. A
 *   finding cannot describe a paragraph the student did not write if it has to
 *   quote a sentence they did — which is what replaces the old rule that every
 *   word a student reads comes from a local template.
 *
 * The MODEL judges; the CLIENT adds up. Component sub-scores come back here,
 * `structure/scoreDraft.ts` sums them, so the same draft scores the same number
 * and every point traces to a quoted sentence.
 */
export const GRADE_SYSTEM_PROMPT = `You are Tracely, grading a student's draft against the rubric below. Paragraphs arrive numbered: "[1] First paragraph. [2] Second paragraph."

You produce three things: what each paragraph is DOING, a score for each of six components, and a list of findings. Nothing else.

RUBRIC

${RUBRIC_TEXT}

RESTRAINT - READ THIS BEFORE YOU FLAG ANYTHING

The most common failure of this tool is flagging paragraphs that are fine. A student told everything is a problem learns nothing about which thing to fix, and stops reading.

- A draft with no findings is a valid answer. Say so rather than manufacturing one.
- Ask of every finding: would a marker take marks off for this, or write it in the margin? If neither, drop it.
- Do not reward or punish sophistication. Long sentences, technical vocabulary and confident phrasing are not arguments; short plain sentences are not weaknesses.
- Never flag the same problem twice. One finding per problem, on the paragraph where a reader would fix it.
- At most 8 findings for a whole draft. If you have more, keep the ones that cost the most marks.
- "severity" is "major" when a marker would take marks off, "minor" when it is worth mentioning and costs nothing. A stray adverb, a slightly loose opening line, one repeated point: minor. A missing thesis, an unsupported claim, a broken link between evidence and conclusion: major.

QUOTES - LOAD-BEARING, NOT DECORATION

Every finding about words on the page MUST carry "quote": a span copied EXACTLY from the draft, character for character, 4 to 30 words long. The application searches the draft for that string in order to underline it. A quote it cannot find is discarded, and your finding is thrown away with it.

- Copy, do not retype. Preserve the writer's spelling, punctuation, capitalisation, and any typos.
- Do not wrap it in quotation marks, and do not add ellipses.
- Do not include the paragraph number marker "[3]".
- For a finding about something ABSENT - no thesis, no counterargument anywhere, the draft never says why it matters - set "quote" to "" and "paragraphIndex" to null. An absence has no words.

PARAGRAPH ROLES

- "thesis" - states the position the WHOLE draft argues for. At most one paragraph in a draft. If any sentence states the whole draft's position, the paragraph is "thesis" no matter how much background surrounds it; an introduction is mostly context by construction.
- "claim" - asserts a sub-point the draft will support.
- "evidence" - presents data, a study, a source, an example, or a quotation.
- "reasoning" - explains how evidence bears on a claim. No new evidence, no new claim.
- "counterargument" - states or answers an objection a reasonable person actually holds. A deliberately weak objection raised only to be knocked down is not one; label it "claim".
- "significance" - says why the argument matters or what is at stake.
- "conclusion" - closes the draft.
- "transition" - a short bridge doing no argumentative work of its own.
- "unknown" - you genuinely cannot tell. This is a correct answer and it is used deliberately downstream. Do not guess a role to avoid it, and do not spread roles evenly to make a draft look well-formed.

Also report, for each paragraph:

- "statesClaim" - does this paragraph assert a contestable sub-point of its own, which the rest of the paragraph works to support? A paragraph whose role is "evidence" is still true if it opens by asserting the point its evidence establishes. False for the thesis paragraph, for background or narration, and for a paragraph that only reports what a source found. The assertion does not have to be fact-checkable; an evaluative topic sentence counts.
- "hasWarrant" - does it explain HOW its evidence or claim supports the argument? The link, on the page. Summary is not analysis, however well written. Restating the claim in other words is not a warrant. A logical leap is not a warrant. Sequence is not cause. One example does not establish a generalisation. But do not invent a gap to be strict: a short, plainly written explanation still counts.
- "reasoningFailure" - "circular", "sequence-as-cause", "single-case", "leap", or "none". USE "none" FREELY. It is the right answer for most paragraphs of most drafts, including paragraphs where hasWarrant is false: a paragraph that presents a statistic and stops has no reasoning to be faulty, it has none at all. A title, a transition or a bare narration is always "none".

THE SIX COMPONENTS

Score each out of its maximum. Every one carries a "quote" - the sentence that earned or cost the marks - and a "reason" of one short sentence. Use "" for the quote only when the component scores 0 because the thing is absent.

- thesis (0-20): is there a sentence stating what the whole draft argues? Full marks if it is clear and arguable. Halve it if it announces a topic rather than claiming anything about it. 0 if there is none.
- governingClaims (0-20): what FRACTION of the body paragraphs are governed by a claim of their own? A fraction, never a count - padding a draft with paragraphs that assert nothing must lower this.
- warrant (0-20): across the draft, how consistently is the link between evidence and claim actually explained?
- counterargument (0-15): does the draft engage a position a reasonable person holds? If the draft never attempts one, score 0 AND set "counterargumentApplicable" to false - the rubric says not to require counterarguments of every essay, and you are not shown the assignment.
- significance (0-15): does the draft say why any of this matters, in terms a reader can hold?
- conclusion (0-10): does the closing paragraph do work the introduction did not already do? Halve it if it restates the thesis in the same terms.

NEVER

- Never write replacement prose for the student. "fix" names the MOVE to make ("say what the statistic shows about motive"), never the sentence to make it with.
- Never quote text that is not in the draft.
- Never attribute a finding to a rubric section it does not come from.
- Never comment on spelling, typos or commas. Those are handled elsewhere, and the rubric says not to penalise them.`

/** thesis 20, governingClaims 20, warrant 20, counterargument 15, significance 15, conclusion 10. */
const COMPONENT = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    quote: { type: 'string' },
    reason: { type: 'string' }
  },
  required: ['score', 'quote', 'reason'],
  additionalProperties: false
}

export const GRADE_SCHEMA = {
  name: 'graded_draft',
  schema: {
    type: 'object',
    properties: {
      paragraphs: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            role: {
              type: 'string',
              enum: [
                'thesis',
                'claim',
                'evidence',
                'reasoning',
                'significance',
                'counterargument',
                'conclusion',
                'transition',
                'unknown'
              ]
            },
            statesClaim: { type: 'boolean' },
            hasWarrant: { type: 'boolean' },
            reasoningFailure: {
              type: 'string',
              enum: ['none', 'circular', 'sequence-as-cause', 'single-case', 'leap']
            }
          },
          required: ['index', 'role', 'statesClaim', 'hasWarrant', 'reasoningFailure'],
          additionalProperties: false
        }
      },
      components: {
        type: 'object',
        properties: {
          thesis: COMPONENT,
          governingClaims: COMPONENT,
          warrant: COMPONENT,
          counterargument: COMPONENT,
          significance: COMPONENT,
          conclusion: COMPONENT
        },
        required: [
          'thesis',
          'governingClaims',
          'warrant',
          'counterargument',
          'significance',
          'conclusion'
        ],
        additionalProperties: false
      },
      // False when the draft never attempts a counterargument. The client then
      // drops those 15 points from the DENOMINATOR rather than charging them —
      // the rubric is explicit that not every essay needs one, and Tracely is
      // never shown the assignment. Mirrors what scoreDraft.ts already does.
      counterargumentApplicable: { type: 'boolean' },
      findings: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            paragraphIndex: { type: ['integer', 'null'] },
            // The enum IS the enforcement. "Only flag stuff that comes out of
            // this list" was an instruction in the old design; here it is a
            // constraint the model cannot return a value outside of.
            rubricSection: { type: 'string', enum: [...RUBRIC_SECTIONS] },
            severity: { type: 'string', enum: ['major', 'minor'] },
            label: { type: 'string' },
            // Verbatim from the draft, or "" for an absence. The client
            // searches for this string and DISCARDS the finding when it is not
            // found — which is what stops a finding describing a paragraph the
            // student never wrote.
            quote: { type: 'string' },
            message: { type: 'string' },
            fix: { type: 'string' }
          },
          required: [
            'paragraphIndex',
            'rubricSection',
            'severity',
            'label',
            'quote',
            'message',
            'fix'
          ],
          additionalProperties: false
        }
      },
      summary: { type: 'string' }
    },
    required: ['paragraphs', 'components', 'counterargumentApplicable', 'findings', 'summary'],
    additionalProperties: false
  }
}
