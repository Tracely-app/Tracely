/**
 * Does this sentence owe a source of its OWN — or is it the kind of sentence
 * an essay states and then supports?
 *
 * Owner, 2026-10-04: "I feel like sometimes it flags stuff just to flag
 * stuff … basic abstractions and generalizations followed by a piece of
 * evidence do not necessarily need a citation." A marker asks for a source
 * where a reader would want to check the writer's word: a NUMBER, a direct
 * QUOTATION, or a RESEARCH FINDING. A topic sentence, an abstraction, a
 * generalization the next sentences go on to evidence, the writer's own
 * argument — those are the essay talking, and a "missing citation" there
 * teaches the writer to ignore the tool.
 *
 * Mirrored by `citationWorthy` in extension/content.js;
 * server/test/citation-worthy-mirror.test.js runs both over the same cases.
 */

/** Opinions and predictions have nothing for a source to settle. */
const NEVER = new Set(['opinion', 'prediction'])

/** Any figure: digits, a spelled-out quantity, a percentage word. */
const QUANTITY =
  /\d|\b(?:percent|per cent|half|a third|a quarter|twice|double|triple|dozens?|hundreds?|thousands?|millions?|billions?|trillions?|majority|minority)\b/i

/** Someone's words in quotation marks — three words or more, not a scare quote. */
const QUOTATION = /["“][^"”]*\S+\s+\S+\s+\S+[^"”]*["”]/

/** What a study, survey or dataset found — never the writer's own "this shows that". */
const FINDING =
  /\b(?:stud(?:y|ies)|research(?:ers)?|survey(?:s|ed)?|experiments?|data|scientists|report(?:s|ed)?|according to)\b/i

export function citationWorthy(text: string, claimType?: string | null): boolean {
  if (claimType && NEVER.has(claimType)) return false
  if (claimType === 'statistic') return true
  const t = String(text ?? '')
  return QUANTITY.test(t) || QUOTATION.test(t) || FINDING.test(t)
}

/**
 * A general statement: owes no source of its own AND names nothing specific —
 * no proper noun after the first word. "Worth checking" (unverifiable) means
 * nothing on such a sentence: there is no specific thing to verify.
 */
export function isGeneralStatement(text: string): boolean {
  const t = String(text ?? '').trim()
  if (citationWorthy(t)) return false
  const words = t.replace(/^["“(]+/, '').split(/\s+/).slice(1)
  return !words.some((w) => /^["“(]?[A-Z][a-z]/.test(w))
}
