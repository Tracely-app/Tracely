/* Figures in a sentence, and whether a source's receipt shows them.
 *
 * A source is offered as backing a sentence only with a verbatim quote from
 * its own text (sourceVerify.js). This is the one check on that quote that
 * needs no model: when the sentence states a figure, the quote has to show
 * it. The judge passed "teenagers 13 to 18 years of age should sleep 8 to 10
 * hours" as backing "roughly 70 percent of them get less than seven", and
 * "Around 1450, Gutenberg introduced…" as backing "within fifty years presses
 * were operating in more than two hundred cities". Neither receipt shows the
 * sentence's figure; the judges said neither backs it.
 *
 * The rule (figuresShown):
 *   - every figure written in DIGITS ("70 percent", "1.27 million", "$2,400")
 *     must be matched by a figure in the quote;
 *   - a sentence whose figures are all WORDS ("more than two hundred",
 *     "roughly half") needs at least one matched: words are as often a
 *     manner of speaking ("fell by half") as a statistic.
 * Not figures: years ("in 2014", "(2019)", "1990s"), clock times, ordinals,
 * labels ("Chapter 5", "World War 2", "GPT-5", "COVID-19"), hyphenated
 * descriptors ("two-bedroom", "fourteen-year-old") and vague sizes ("tens of
 * thousands", "hundreds of"). A figure matches when it is the same kind
 * (a percentage — "1 out of every 3" is 33% —, money, or a count) and close
 * enough: 2% apart, 15% (or 5 points) when either side says "roughly",
 * "about", "at least"…, and "more than 200" is met by 250.
 *
 * Measured on the 310 judged sources (eval/goldset/figures.mjs). Pure and
 * dependency-free; the extension never needs it (the server applies it). */

const WORD_UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const WORD_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, mn: 1e6, billion: 1e9, bn: 1e9, b: 1e9, trillion: 1e12 };
const FRACTION_WORDS = [
  [/\b(?:a|one)[- ]half\b|\bhalf\b|\bhalved\b/g, 50],
  [/\btwo[- ]thirds\b/g, 66.7],
  [/\b(?:a|one)[- ]third\b/g, 33.3],
  [/\bthree[- ]quarters\b/g, 75],
  [/\b(?:a|one)[- ]quarter\b/g, 25],
  [/\b(?:a|one)[- ]fifth\b/g, 20],
  [/\b(?:a|one)[- ]tenth\b/g, 10],
];
const UNIT_WORDS = Object.keys(WORD_UNITS).filter((w) => w !== "zero" && w !== "one");
const NUMBER_WORD = `(?:(?:${Object.keys(WORD_TENS).join("|")})(?:[- ](?:${Object.keys(WORD_UNITS).slice(1, 10).join("|")}))?|${[...UNIT_WORDS, "one"].join("|")})`;
// "a" is a number only before a scale word: "a hundred dollars", never "a study".
const NUMBER_WORD_A = `(?:${NUMBER_WORD}|a)`;
// What a 4-digit number in 1000-2099 counts when it is not a year.
const COUNT_NOUN = /^\s+(?:[a-z-]+\s+)?(?:people|persons|cases|deaths|students|adults|children|kids|teens|teenagers|adolescents|patients|participants|respondents|subjects|schools|cities|towns|villages|copies|words|pages|employees|workers|users|members|households|families|homes|units|apartments|beds|miles|kilometers|km|feet|meters|dollars|calls|shifts|hours|papers|studies|books|titles|presses|printers)\b/;
const YEAR_CUE = /(?:\b(?:in|since|by|from|to|until|till|after|before|around|circa|c\.|during|of|between|and|year|early|late|mid|the|until|through|as of)\s*|[-–(])$/;
const APPROX = /\b(?:roughly|about|around|approximately|approx\.?|nearly|almost|some|close to|an estimated|estimated|on the order of|just over|just under)\s*$|~\s*$/;
const MORE = /\b(?:more than|over|above|at least|upwards? of|exceeding|exceeds?|in excess of|no fewer than|greater than)\s*$/;
const LESS = /\b(?:less than|under|below|fewer than|at most|up to|no more than|lower than)\s*$/;

/* Lower case, decimals and thousands written one way, dashes and spaces folded. */
function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[   ]/g, " ")
    .replace(/(\d)[·•](\d)/g, "$1.$2")
    .replace(/[‐-―−]/g, "-")
    .replace(/(\d),(?=\d{3}\b)/g, "$1");
}

const blank = (s) => " ".repeat(s.length);

/* Everything that looks like a number and is not a figure, blanked out (the
 * same length, so what remains keeps its place). */
function maskNonFigures(t) {
  return t
    .replace(/\[\d+(?:[,–-]\s?\d+)*\]/g, blank)                                            // [8], [3-5]: footnote marks
    .replace(/\((?:[^()]*?\b(?:1\d{3}|20\d{2})[a-z]?\b[^()]*|[a-z][^()\d]*\s\d{1,4}(?:-\d{1,4})?)\)/g, blank) // (Smith, 2019), (Shoup 45)
    .replace(/\b\d{1,2}:\d{2}(?:\s*[ap]\.?\s?m\.?)?/g, blank)                                // 8:30 a.m.
    .replace(/\b\d+(?:st|nd|rd|th)\b/g, blank)                                              // 19th
    .replace(/\b\d{2,4}'?s\b/g, blank)                                                      // 1990s, 70's
    .replace(/\b(?:chapters?|ch\.|pages?|p\.|pp\.|vol\.|volume|no\.|section|sections|figure|fig\.|table|doc\.?|document|documents|grades?|world war|ww|level|part|step|phase|act|scene|lines?|issue|edition|ed\.|article|title|round|season|book|verse|room|route|highway|interstate|version|v\.)\s*\d+(?:[.-]\d+)*/g, blank)
    .replace(/\b[a-z]+-?\d+[a-z0-9]*\b/g, blank)                                            // gpt-5, covid-19, h1n1, k-12
    .replace(new RegExp(`\\b(?:\\d+|${NUMBER_WORD})-(?!thirds?\\b|quarters?\\b|halves?\\b|half\\b)[a-z]+(?:-[a-z]+)*`, "g"), blank) // two-bedroom, 14-year-old
    .replace(/\b(?:tens|hundreds|thousands|millions|billions|dozens|scores)\s+of(?:\s+(?:thousands|millions|billions))?\b/g, blank) // vague sizes
    .replace(/\b(?:1\d{3}|20\d{2})\s*[/-]\s*(?:\d{4}|\d{2})\b/g, blank)                    // 2010/11, 2022-23, 1939-1945
    .replace(/\b(?:1\d{3}|20\d{2})\b(?!\s*(?:%|percent\b|per cent\b))/g, (m, at, s) => {
      const before = s.slice(Math.max(0, at - 12), at);
      if (s[at - 1] === "$") return m;
      if (!YEAR_CUE.test(before) && COUNT_NOUN.test(s.slice(at + m.length, at + m.length + 40))) return m; // 1274 measles cases
      return blank(m);                                                                      // a year
    });
}

function wordValue(w) {
  const parts = w.split(/[- ]/);
  if (parts.length === 2 && WORD_TENS[parts[0]] != null) return WORD_TENS[parts[0]] + (WORD_UNITS[parts[1]] ?? 0);
  if (w === "a") return 1;
  return WORD_TENS[w] ?? WORD_UNITS[w] ?? null;
}

/* The figures in a text: [{ value, kind: "percent"|"money"|"count", digits,
 * cmp: "gt"|"lt"|null, approx }]. */
export function figuresOf(text) {
  let t = maskNonFigures(normalize(text));
  const out = [];
  const take = (re, make) => {
    t = t.replace(re, (...m) => {
      const at = m[m.length - 2];
      const before = t.slice(Math.max(0, at - 30), at);
      const f = make(m);
      if (f && Number.isFinite(f.value)) {
        out.push({ ...f, cmp: MORE.test(before) ? "gt" : LESS.test(before) ? "lt" : null, approx: APPROX.test(before) });
      }
      return blank(m[0]);
    });
  };
  const num = (s) => (/^\d/.test(s) ? Number(s) : wordValue(s));
  // "1 in 4", "one out of every three"
  take(new RegExp(`\\b(\\d+(?:\\.\\d+)?|${NUMBER_WORD})\\s+(?:in|out of(?: every)?)\\s+(\\d+(?:\\.\\d+)?|${NUMBER_WORD})\\b`, "g"),
    (m) => { const a = num(m[1]); const b = num(m[2]); return a != null && b ? { value: (100 * a) / b, kind: "percent", digits: /\d/.test(m[1]) } : null; });
  // 13%, 13 percent, 13 percentage points; seventy percent
  take(new RegExp(`\\b(\\d+(?:\\.\\d+)?|${NUMBER_WORD})\\s*(?:%|percent\\b|per cent\\b|percentage points?\\b)`, "g"),
    (m) => ({ value: num(m[1]), kind: "percent", digits: /\d/.test(m[1]) }));
  // $2,400; $1.5 million; 100 dollars; a hundred dollars
  take(/\$\s?(\d+(?:\.\d+)?)(?:\s*(thousand|million|billion|trillion|k|m|mn|bn|b)\b)?/g,
    (m) => ({ value: Number(m[1]) * (SCALE[m[2]] ?? 1), kind: "money", digits: true }));
  take(new RegExp(`\\b(\\d+(?:\\.\\d+)?|${NUMBER_WORD_A})(?:\\s+(hundred|thousand|million|billion|trillion))?\\s+dollars\\b`, "g"),
    (m) => ({ value: num(m[1]) * (m[2] === "hundred" ? 100 : SCALE[m[2]] ?? 1), kind: "money", digits: /\d/.test(m[1]) }));
  // half, a third, two-thirds …
  for (const [re, value] of FRACTION_WORDS) take(re, () => ({ value, kind: "percent", digits: false }));
  // 1.27 million; 350000; two hundred; fifty thousand
  take(/(?<![\d.])(\d+(?:\.\d+)?)(?:\s*(thousand|million|billion|trillion)\b)?(?![\d.])/g,
    (m) => ({ value: Number(m[1]) * (SCALE[m[2]] ?? 1), kind: "count", digits: true }));
  take(new RegExp(`\\b(${NUMBER_WORD_A})(?:\\s+(hundred|thousand|million|billion|trillion))?(?:\\s+(thousand|million|billion))?\\b`, "g"), (m) => {
    // "a" and "one" only with a scale word: "a hundred", not "a study"; "one hundred", not "one of".
    if ((m[1] === "a" || m[1] === "one") && !m[2]) return null;
    let v = wordValue(m[1]);
    if (m[2]) v *= m[2] === "hundred" ? 100 : SCALE[m[2]];
    if (m[3]) v *= SCALE[m[3]];
    return { value: v, kind: "count", digits: false };
  });
  return out;
}

/* Does a figure from the quote show the sentence's figure? */
export function figureMatches(c, q) {
  if (c.kind !== q.kind) return false;
  if (c.cmp === "gt") return q.value >= c.value * 0.98;
  if (c.cmp === "lt") return q.value <= c.value * 1.02;
  const loose = c.approx || q.approx || q.cmp != null;
  const tol = c.kind === "percent"
    ? (loose ? Math.max(5, 0.15 * c.value) : Math.max(0.6, 0.02 * c.value))
    : (loose ? 0.15 : 0.02) * Math.abs(c.value);
  return Math.abs(c.value - q.value) <= tol;
}

/* { ok, missing }: whether `quote` shows the figures `claim` states. A claim
 * with no figures is always ok. */
export function figuresShown(claim, quote) {
  const C = figuresOf(claim);
  if (!C.length) return { ok: true, missing: [] };
  const Q = figuresOf(quote);
  const shown = (c) => Q.some((q) => figureMatches(c, q));
  const digits = C.filter((c) => c.digits);
  if (digits.length) {
    const missing = digits.filter((c) => !shown(c));
    return { ok: missing.length === 0, missing };
  }
  return C.some(shown) ? { ok: true, missing: [] } : { ok: false, missing: C };
}
