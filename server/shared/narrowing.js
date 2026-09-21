/*
 * Ported from the desktop app's src/shared/narrowing.ts. The server applies
 * shared/normalizeCritique.js to every critique it returns to the desktop and
 * the web app, and that function's whole defence against a revision that
 * swaps the subject is this rule — so it is the SAME rule, not a second
 * implementation of it. test/mirror.test.js runs both copies on a shared
 * corpus whenever the desktop tree is present.
 *
 * The desktop's formatting is kept on purpose, so a diff against the original
 * shows only the TypeScript annotations that had to go. Its comments follow
 * unedited.
 */
/**
 * Is a proposed revision a NARROWING of the sentence, or a different sentence?
 *
 * This was a private function in `main/services/ai/normalizeCritique.ts`, which
 * is still where critique's `suggestedRevision` is filtered through it. It
 * moved here because Tracer can now propose a rewrite too, and that one is
 * offered in the renderer — the alternative was a second copy of a rule whose
 * whole value is being the same rule in both places.
 *
 * A leaf with no imports, so `npm test` can load it.
 */

/**
 * Named things: proper nouns, model numbers, figures, years.
 *
 * The first word is dropped because it is capitalised by sentence position
 * rather than by being a name — "Recent large language models…" must not count
 * "Recent" as an entity the claim failed to mention.
 */
export function namedEntities(sentence) {
  const words = sentence.trim().split(/\s+/).slice(1)
  const found = new Set()
  for (const word of words) {
    for (const token of word.match(/\b[A-Z][A-Za-z]*(?:[-–][A-Za-z0-9]+)*\d*\b|\b\d+(?:[.,]\d+)?\b/g) ?? []) {
      found.add(token.toLowerCase().replace(/[–]/g, '-'))
    }
  }
  return found
}

/**
 * The rule: a revision may DROP named things, never INTRODUCE one.
 *
 * Enforced in code as well as asked for in the prompt, because the model broke
 * it in production on 2026-08-16:
 *
 *   claim     GPT-5 class models now score above the median human rater on the
 *             AP English Language essay rubric, according to the vendor's own
 *             published evaluation.
 *   revision  Recent large language models, such as GPT-4, have demonstrated
 *             scoring performance comparable to or sometimes exceeding the
 *             average human rater on academic English essay rubrics…
 *
 * The evidence was about GPT-4, so the revision quietly rewrote the SUBJECT to
 * match the evidence — and dropped the AP rubric and the vendor citation with
 * it. A student who accepts that is asserting something they never claimed,
 * about a different model, with the attribution removed.
 *
 * One-directional on purpose. "In three US states" becoming "in some states" is
 * a narrowing; a name the original does not contain is a fact the student did
 * not assert. Hedges add words like "some" and "may", never entities.
 */
export function isNarrowing(revision, original) {
  const claimed = namedEntities(original)
  for (const entity of namedEntities(revision)) {
    if (!claimed.has(entity)) return false
  }
  return true
}
