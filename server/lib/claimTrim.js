/* Removing one small detail from a sentence so that a source backs the rest.
 *
 * Owner, 2026-10-13: when no source backs a whole sentence but one backs all
 * of it except a small detail ("…the book's origin during a stay at the Villa
 * Diodati", with a source that never names the villa), offer to remove that
 * detail — only a small part or detail, never the claim itself.
 *
 * The model (sourceVerify.js COVER_SYSTEM) says which part is a detail; this
 * file decides, without a model, whether removing it is safe. Removing a
 * detail must make the sentence say LESS: an extra place, date, name or aside.
 * Removing a qualifier makes it say MORE ("some studies suggest" becomes
 * "studies show"), so those words are refused here whatever the model said.
 *
 * trimSentence(sentence, remove, { after }) → { ok: true, sentence, removed }
 *                                           | { ok: false, reason }
 *   remove — the detail, copied from the sentence (a leading ", " or " and "
 *            joins it and goes with it)
 *   after  — the rest of the paragraph after the sentence: a detail the essay
 *            goes on to use is not removed. */
import { figuresOf } from "./claimFigures.js";

// At most a quarter of the sentence, and never a long passage.
export const TRIM_MAX_SHARE = 0.25;
export const TRIM_MAX_WORDS = 12;
// What is left must still be a sentence.
export const TRIM_MIN_LEFT_WORDS = 6;

/* Words whose removal changes what is claimed rather than how much detail it
 * carries: negations, quantifiers, hedges, frequency, approximation and
 * scope. A detail containing one is not a detail. */
const CHANGES_THE_CLAIM = /\b(?:not|no|never|none|nor|neither|without|cannot|can't|won't|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|some|many|most|few|fewer|several|all|every|each|any|often|usually|sometimes|rarely|seldom|always|generally|typically|mostly|mainly|largely|partly|partially|primarily|may|might|could|can|would|should|must|likely|unlikely|probably|possibly|perhaps|appears?|seems?|suggests?|about|roughly|nearly|almost|approximately|around|only|just|least|most|more|less|over|under|among|except|unless|if|because|due|since|therefore|thus)\b/i;

/* A scope: who, where or among whom the claim holds. "Students in the US
 * rarely sleep enough" without "in the US" is a claim about every student.
 * A bare date ("in 1818", "in October 2008") is a detail, not a scope. */
const SCOPE = /^(?:in|among|across|within|throughout|for|outside|inside|of)\b/i;
const BARE_DATE = /^in\s+(?:(?:early|late|mid)[- ]?)?(?:(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+)?(?:1\d{3}|20\d{2})s?$/i;
/* An attribution names whose finding it is; removing it unnames the source,
 * the very thing Tracely's unnamed-source note asks the writer to fix. */
const ATTRIBUTION = /\bby\s+[A-Z]|\baccording to\b|\b(?:said|says|wrote|writes|argued|argues|reported|reports|found|finds|claimed|claims)\b/;

const STOP = new Set("the a an and or but of in on at to by for with from as into onto over under than that this these those its his her their our your was were is are be been being had has have during while after before about through which who whom whose what when where".split(" "));
const words = (s) => String(s ?? "").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const fold = (s) => String(s ?? "").normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/* The detail, found once in the sentence, case-insensitively; with its joining
 * ", " / " and " / " which " taken along so the rest reads on. */
function locate(sentence, remove) {
  const s = sentence.toLowerCase();
  const r = remove.toLowerCase().replace(/^[\s,;:]+|[\s,;:.]+$/g, "");
  if (!r) return null;
  const at = s.indexOf(r);
  if (at < 0 || s.indexOf(r, at + 1) >= 0) return null;
  let start = at;
  let end = at + r.length;
  // Take the joiner before it: ", " or " and " / " , and ".
  const before = s.slice(0, start);
  const join = before.match(/(?:,\s*(?:and\s+)?|\s+and\s+|\s+)$/);
  if (join) start -= join[0].length;
  return { start, end };
}

/* Spaces and punctuation after the cut: no space before a mark, no doubled
 * marks, a capital to start and a full stop to end. */
function tidy(text) {
  let t = text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,\s*([,.;:!?])/g, "$1")
    .replace(/^[\s,;:]+/, "")
    .replace(/\s+and\s*([.!?])$/i, "$1")
    .trim();
  if (t && /[a-z]/.test(t[0])) t = t[0].toUpperCase() + t.slice(1);
  if (t && !/[.!?]["'”’)]*$/.test(t)) t += ".";
  return t;
}

export function trimSentence(sentence, remove, { after = "" } = {}) {
  const S = fold(sentence);
  const R = fold(remove);
  if (!S || !R) return { ok: false, reason: "nothing to remove" };
  const at = locate(S, R);
  if (!at) return { ok: false, reason: "the detail is not in the sentence, once" };
  const cut = S.slice(at.start, at.end);
  const nWords = words(cut).length;
  const total = words(S).length;
  if (nWords > TRIM_MAX_WORDS || nWords > Math.max(3, Math.floor(TRIM_MAX_SHARE * total))) {
    return { ok: false, reason: "more than a small detail" };
  }
  if (CHANGES_THE_CLAIM.test(cut)) return { ok: false, reason: "it would change what the sentence claims" };
  const bare = cut.replace(/^[\s,;:]+|^and\s+/gi, "").trim();
  if (SCOPE.test(bare) && !BARE_DATE.test(bare)) return { ok: false, reason: "it limits who or where the claim holds" };
  if (ATTRIBUTION.test(bare)) return { ok: false, reason: "it names the source" };
  if (figuresOf(cut).length) return { ok: false, reason: "it carries a figure" };
  const left = tidy(S.slice(0, at.start) + S.slice(at.end));
  if (words(left).length < TRIM_MIN_LEFT_WORDS) return { ok: false, reason: "too little would be left" };
  // A detail the paragraph goes on to use stays: its distinctive words appear later.
  const later = new Set(words(fold(after).toLowerCase()).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, "")));
  const own = words(cut.toLowerCase()).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, "")).filter((w) => w.length >= 4 && !STOP.has(w));
  if (own.some((w) => later.has(w))) return { ok: false, reason: "the paragraph goes on to use it" };
  return { ok: true, sentence: left, removed: cut.replace(/^[\s,;:]+|^and\s+/gi, "").trim() };
}
