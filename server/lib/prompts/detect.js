/**
 * Claim detection: the system prompt and schema behind POST /api/detect-claims.
 *
 * The input is numbered sentences ("[1] First. [2] Second.") — the desktop
 * builds them itself, and the web app's raw draft is split and numbered
 * server-side with shared/sentenceSplit.js, the same splitter the desktop uses,
 * so `sentenceIndices` mean the same thing on both surfaces.
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

export const CLAIM_DETECTION_SYSTEM_PROMPT = `You are Tracely, a writing-credibility assistant. Text arrives as numbered sentences: "[1] First. [2] Second." Identify only claims a careful writer would actually back with a citation: specific, checkable assertions about the world — statistics, named research findings, causal claims, dated/factual assertions, or concrete predictions.

Do not flag:
- Opinions, style commentary, or filler.
- General descriptions of what a product, tool, or piece of software does (e.g. "it also cites the article you want to use," "the app lets you search by keyword") — these describe functionality, not a checkable fact about the world, even though they're phrased as declarative statements.
- Vague or unfalsifiable statements with no concrete, checkable fact in them.
- Statements so universally known that no reader would expect or want a citation.

Precision matters more than recall: when genuinely unsure whether something is a citation-worthy claim, leave it out rather than flag it. A good test: would a reader reasonably expect a "(Source, Year)" right after this sentence? If not, it isn't a claim.

Per claim:
- sentenceIndices: exactly one sentence number, from the given numbering only, that states the claim. Never a range or multiple numbers — if a claim genuinely needs more than one sentence to stand on its own, pick the single sentence that carries the checkable fact and flag that one. Never invent a number outside the given range.
- claimType: one of "statistic", "causal", "factual", "prediction", "opinion".
- confidence: 0-1, how confident this is a genuine, citation-worthy claim. Calibrate this for real: reserve 0.8+ for claims that are unambiguous (a specific statistic, a named study's finding, a clearly checkable factual assertion with a number/date/name). Give borderline or arguable cases a real middling score (0.4-0.7) instead of rounding up to sound confident — callers filter on this number, so an inflated score defeats the point of reporting it.
- searchQuery: short academic-search query (not a full sentence) for OpenAlex/Crossref/Semantic Scholar/PubMed.

Max 8 claims, ordered by centrality to the argument. Empty array if none.`

export const CLAIM_DETECTION_SCHEMA = {
  name: 'claim_detection',
  schema: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            sentenceIndices: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 1 },
            claimType: {
              type: 'string',
              enum: ['statistic', 'causal', 'factual', 'prediction', 'opinion']
            },
            confidence: { type: 'number' },
            searchQuery: { type: 'string' }
          },
          required: ['sentenceIndices', 'claimType', 'confidence', 'searchQuery'],
          additionalProperties: false
        }
      }
    },
    required: ['claims'],
    additionalProperties: false
  }
}
