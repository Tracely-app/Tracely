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

/** Any figure: digits, a number word ("four in ten", "thirty states"), a percentage or size word. */
const QUANTITY =
  /\d|\b(?:percent|per cent|half|halved|a third|a quarter|twice|double|doubled|triple|tripled|quadrupled|dozens?|hundreds?|thousands?|millions?|billions?|trillions?|majority|minority|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one (?:in|out of|degree|percent|point)\b)\b/i

/**
 * Numbers that are not quantities, taken out before QUANTITY looks: a year, a
 * span of years, a decade, an ordinal or century, a clock time, a label
 * ("Chapter 5", "World War 2", "Doc 3") and a name with a number in it
 * ("COVID-19", "GPT-5"). The check's own rule is "a date is not a quantity":
 * "Truman became president in 1945" owes no source for its date, and a
 * tester's history essay came back with every dated sentence flagged. A
 * 4-digit number before a count noun ("1500 deaths") is a quantity.
 */
const NOT_A_QUANTITY: RegExp[] = [
  /\b\d{1,2}:\d{2}\b/g,
  /\b\d+(?:st|nd|rd|th)\b/gi,
  /\b\d{2,4}'?s\b/g,
  /\b(?:1\d{3}|20\d{2})\s*[/–-]\s*(?:\d{4}|\d{2})\b/g,
  /\b(?:chapters?|pages?|p\.|pp\.|vol\.|volume|no\.|sections?|figure|fig\.|table|doc\.?|documents?|grades?|world war|ww|level|part|step|phase|act|scene|lines?|issue|edition|article|title|round|season|book|verse|room|route|version)\s*\d+(?:[.:–-]\d+)*/gi,
  /\b[a-z]+-?\d+[a-z0-9]*\b/gi,
  /\b(?:1\d{3}|20\d{2})\b(?!\s*(?:%|percent|per cent)|\s+(?:[a-z-]+\s+)?(?:people|persons|cases|deaths|students|adults|children|soldiers|troops|men|women|workers|copies|words|pages|miles|dollars)\b)/gi,
]

/** Someone's words in quotation marks — three words or more, not a scare quote. */
const QUOTED = /["“]([^"”]*)["”]/g

/** Small words a title leaves lower case: "The Road Not Taken", "Pride and Prejudice". */
const TITLE_SMALL = /^(?:a|an|the|and|but|or|nor|for|of|in|on|at|to|by|with|from|as|vs\.?)$/i

/**
 * A quotation is someone's words — three or more of them. A quoted title
 * ("The Road Not Taken", "Pride and Prejudice") is a name, not words a source
 * said: every word but the small ones is capitalized.
 */
function hasQuotation(t: string): boolean {
  for (const m of t.matchAll(QUOTED)) {
    const words = m[1].trim().split(/\s+/).filter(Boolean)
    if (words.length < 3) continue
    const title = words.every((w, i) => (i > 0 && TITLE_SMALL.test(w)) || /^['‘(]?[A-Z0-9]/.test(w))
    if (!title) return true
  }
  return false
}

/** The text with every number that is not a quantity blanked out. */
function quantitiesOnly(t: string): string {
  return NOT_A_QUANTITY.reduce((s, re) => s.replace(re, ' '), t)
}

/** What a study, survey or dataset found — never the writer's own "this shows that". */
const FINDING =
  /\b(?:stud(?:y|ies)|research(?:ers)?|survey(?:s|ed)?|experiments?|data|scientists|report(?:s|ed)?|according to)\b/i

export function citationWorthy(text: string, claimType?: string | null): boolean {
  if (claimType && NEVER.has(claimType)) return false
  if (claimType === 'statistic') return true
  const t = String(text ?? '')
  return QUANTITY.test(quantitiesOnly(t)) || hasQuotation(t) || FINDING.test(t)
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
