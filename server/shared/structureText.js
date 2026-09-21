/*
 * Ported from the desktop app's src/shared/structureText.ts. Not on the
 * original list of modules to port, but it is the composition /api/grade's
 * `draft` path is specified in terms of — "argumentParagraphs =
 * splitParagraphs(withoutWorksCited(draft))" — and the comment below is the
 * reason that composition has to be ONE function rather than two calls a
 * route remembers to make in order. test/mirror.test.js runs this copy and the
 * desktop's on a shared corpus whenever the desktop tree is present.
 *
 * The desktop's formatting is kept on purpose, so a diff against the original
 * shows only the TypeScript that had to go. Its comments follow unedited.
 */

import { splitParagraphs } from './paragraphSplit.js'
import { withoutWorksCited } from './worksCited.js'

/**
 * The paragraphs of the ARGUMENT — the draft with its reference list removed.
 *
 * This exists because a comment could not hold the invariant. `analyzeStructure`
 * has always scored `splitParagraphs(withoutWorksCited(text))`, and
 * `ipc/structureHandlers.ts` sent the classifier `splitParagraphs(text)` — under
 * a comment reading "The paragraphs are split here with the SAME function
 * analyzeStructure uses. Splitting them differently would label paragraph 4 and
 * score paragraph 5." Same function; different input; the warning was accurate
 * and describing the code beneath it.
 *
 * Measured across the owner's five real documents, 2026-08-19:
 *
 *   paragraphs sent to the classifier   62 -> 36   (42% were reference lines)
 *   classifier input                  ~4090 -> ~3121 tokens   (24% cut)
 *
 * So a quarter of every structure call was spent asking a model what role
 * "Walker, A. (2004). Hepburn, Audrey … Oxford Dictionary of National
 * Biography" plays in the argument. It plays none, it comes back `unknown`, and
 * on the aggregate that noise was most of a 37% unknown rate that made the
 * classifier look far worse than it is.
 *
 * The alignment was saved only by luck: `withoutWorksCited` trims a SUFFIX, so
 * indices 0..n-1 of the untrimmed vector happen to name the same paragraphs.
 * The real exposure is the caps — `MAX_STRUCTURE_PARAGRAPHS` (24) and
 * `MAX_STRUCTURE_INPUT_CHARS` (8000) are applied to whatever is handed over, so
 * a long bibliography pushes real paragraphs out of the classification
 * entirely. One of these documents already sends 25 paragraphs, 11 of them
 * references, against a cap of 24.
 *
 * A leaf: both imports are leaves with tests of their own, so `npm test` can
 * load this.
 *
 * @param {string} text
 * @returns {import('./paragraphSplit.js').ParagraphSpan[]}
 */
export function argumentParagraphs(text) {
  return splitParagraphs(withoutWorksCited(text))
}
