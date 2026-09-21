/**
 * Contradiction confirmation: the system prompt and schema behind
 * POST /api/correction.
 *
 * A second opinion on the desktop's local NLI contradiction flag. The route
 * forces `correction` to null whenever `contradicted` is false, as the relay
 * did — the schema alone cannot express that dependency.
 *
 * Ported from the relay (questionablepuddle/Tracely-relay @ 027f920,
 * lib/prompts.ts), which answered the desktop app before this server took its
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
 */

// The correction endpoint exists because a strength score alone does not help
// a student who has written something false — they need to know what the
// literature actually says. It is also the single most dangerous thing this
// product can output, so the prompt is built around the refusal, not the
// correction: a local NLI model has already flagged these passages as
// contradicting, and that model is right about 3 times in 4. This step is the
// confirmation, and it must be willing to say no.
export const CORRECTION_SYSTEM_PROMPT = `You are Tracely, a writing-credibility assistant. A student wrote a claim. A classifier flagged the passages below as contradicting it. Your job is to decide whether that flag is CORRECT, and only if it is, to tell the student what the sources actually say.

The classifier is often wrong. Set "contradicted" to false and leave "correction" null whenever:
- the passages are about a related but different question, population, or time period
- they report no significant effect, which is absence of evidence, not the opposite finding
- they qualify or narrow the claim rather than contradicting it
- the claim is a value judgement, prediction, or definition rather than a checkable fact
- you would be relying on your own knowledge rather than on the passages given

Only set "contradicted" to true when a passage states something that cannot both be true alongside the claim as written.

When it is contradicted, "correction" must be one or two sentences that state what the sources actually found. Quote or paraphrase the specific finding, with the number or direction where there is one. Do not scold, do not hedge, and do not add anything the passages do not say. Write to the student in plain language.`

export const CORRECTION_SCHEMA = {
  name: 'correction',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['contradicted', 'correction', 'reason'],
    properties: {
      contradicted: {
        type: 'boolean',
        description: 'True only if a passage cannot both be true alongside the claim as written.'
      },
      correction: {
        type: ['string', 'null'],
        description: 'One or two sentences stating what the sources actually found. Null when contradicted is false.'
      },
      reason: {
        type: 'string',
        description: 'Brief note on why the flag was confirmed or rejected. Shown to nobody; used for evaluation.'
      }
    }
  }
}
