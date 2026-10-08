/* Does the source actually SAY it? The receipt a source search shows before a
 * student is told to cite something.
 *
 * Owner, 2026-10-04: "Find sources" offered Ord & Davies (2022) — a paper on
 * youth work and austerity cuts — for "general support for youth leadership
 * has increased … little to no action", which it never says. "From now on
 * dont recommend me sources that do not align." Then, 2026-10-07: three
 * independent judges labelled 120 recorded sentence→source pairs, and of the
 * 51 sources the pipeline ranked relevant only 16 (31%) back the sentence —
 * mostly sources on the topic that state something different.
 *
 * The rule now: NO SOURCE IS SHOWN AS BACKING A SENTENCE UNLESS TRACELY READ
 * IT AND CAN SHOW THE WORDS FROM IT THAT BACK THE SENTENCE. For every source:
 *   1. read what the source itself says — for a DOI, the abstract from
 *      OpenAlex (free, no key), and its open-access copy when the abstract
 *      alone does not settle it (abstractSettles); otherwise the page. From
 *      the WHOLE text, the best few passages by overlap with the claim's
 *      words and figures are kept (selectExcerpts, ~3 × 600 characters);
 *   2. ONE structured call on the search's own model judges all of them
 *      against the claim, from those excerpts only: backs / contradicts /
 *      topic, with a verbatim `quote` for the first two;
 *   3. the quote is checked against the excerpts (matchQuote: whitespace,
 *      quote marks, dashes and case folded, word boundaries kept). Found:
 *      "supports"/"refutes", `verified: true`, `quote` (the source's own
 *      characters), `readFrom` ("abstract" | "page"), and the snippet becomes
 *      the quote. Not found: the verdict falls to "topic" ("context").
 *   4. a source that could not be read (paywall, bot wall, PDF, no abstract,
 *      the deadline, the judge failing or skipping it) is "context" with
 *      `verified: false`. It used to keep the search's label; now nothing
 *      unread is ever backing — and because shipped extensions offer only
 *      "supports" (and "refutes" for a sentence flagged false), every build
 *      already installed stops showing unread sources as backing the day the
 *      server deploys.
 * OpenAlex's `is_retracted`, on the same response as the abstract, marks a
 * source the caller drops (`retracted`).
 *
 * Cost: still ONE call, on the fast model — now over every source rather than
 * only the ones the search called "supports"/"refutes", ~3-5k input tokens
 * and ~0.5-1k out: about 0.1-0.2 cent against the search's ~1.3
 * (WORST_CALL["/api/sources"] covers it: 3,000 + 2,000 output tokens under its
 * 6,000). Latency: the reads share one VERIFY_DEADLINE_MS (4 s, from 3 s), so
 * the worst case adds one second plus the judge's larger input. Nothing here
 * throws. */
import { safeFetch, decodeEntities, looksBlocked } from "./citeMeta.js";
import { doiOf } from "./sourceEnrich.js";
import { structuredCall } from "./llm.js";

export const OPENALEX_WORK = "https://api.openalex.org/works/doi:";
export const VERIFY_DEADLINE_MS = 4_000;
export const EXCERPT_WINDOWS = 3;
export const EXCERPT_CHARS = 600;
export const MAX_QUOTE_CHARS = 300;
const MIN_QUOTE_CHARS = 15;
const MIN_TEXT_CHARS = 80;   // an abstract shorter than this is not one
const MIN_PAGE_CHARS = 200;  // a page with less visible text is a shell, an app or a wall
const MAX_PAGE_BYTES = 1_500_000;
const API_UA = "Tracely/1.0 (mailto:hello@jointracely.com)";
const PAGE_UA = "Mozilla/5.0 (compatible; Tracely/1.0; local fact-checker)";

/* OpenAlex stores an abstract as {word: [positions]}. */
export function abstractFromIndex(index) {
  if (!index || typeof index !== "object") return "";
  const words = [];
  for (const [w, at] of Object.entries(index)) for (const i of Array.isArray(at) ? at : []) if (Number.isInteger(i) && i >= 0 && i < 5_000) words[i] = w;
  return words.filter(Boolean).join(" ").trim();
}

/* The readable text of an HTML page: no scripts, styles, navigation chrome
 * or tags; entities decoded; whitespace collapsed; a block's end read as a
 * sentence end. ONE linear pass (the citeMeta.js scanHtml rule): the regexes
 * this replaced — /<(script|…)\b[\s\S]*?<\/\1>/ and /<[^>]+>/ — rescanned to
 * the end of the page from every unclosed "<", and the receipt check now
 * reads more pages, so a hostile one must not hold the server's one thread. */
const SKIP_TAGS = new Set(["script", "style", "noscript", "svg", "nav", "header", "footer", "form", "template"]);
const BLOCK_TAGS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "br", "td", "th", "blockquote", "figcaption", "dd", "dt", "caption", "ul", "ol", "table"]);
export function pageText(html) {
  const s = String(html ?? "");
  // ASCII-only lowercasing keeps every index aligned with `s`.
  const lower = s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const out = [];
  const n = s.length;
  let pos = 0;
  while (pos < n) {
    const lt = s.indexOf("<", pos);
    if (lt < 0) { out.push(s.slice(pos)); break; }
    out.push(s.slice(pos, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end < 0) break;
      pos = end + 3;
      continue;
    }
    const next = lower[lt + 1] ?? "";
    if (!((next >= "a" && next <= "z") || next === "/" || next === "!" || next === "?")) { out.push("<"); pos = lt + 1; continue; }
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) break;
    pos = gt + 1;
    const m = /^<(\/?)([a-z][a-z0-9-]*)/.exec(lower.slice(lt, Math.min(gt + 1, lt + 40)));
    if (!m) { out.push(" "); continue; }
    const [, close, name] = m;
    if (!close && SKIP_TAGS.has(name) && s[gt - 1] !== "/") {
      const end = lower.indexOf(`</${name}`, pos);
      if (end < 0) break; // everything after is this element's
      const after = s.indexOf(">", end);
      pos = after < 0 ? n : after + 1;
      out.push(" ");
      continue;
    }
    out.push(BLOCK_TAGS.has(name) && (close || name === "br") ? ". " : " ");
  }
  return decodeEntities(out.join(""))
    .replace(/\s+/g, " ")
    .replace(/(\.\s*){2,}/g, ". ")
    .trim();
}

function htmlTitle(html) {
  const head = String(html ?? "").slice(0, 50_000);
  const lower = head.toLowerCase();
  const a = lower.indexOf("<title");
  if (a < 0) return "";
  const gt = head.indexOf(">", a);
  const end = gt < 0 ? -1 : lower.indexOf("</title", gt);
  return end < 0 ? "" : decodeEntities(head.slice(gt + 1, end)).trim();
}

/* ── the claim's words and figures ───────────────────────────────────────
 * Accents and case folded; words of three letters or more that are not
 * function words, with a plural "s" taken off; numbers with their thousands
 * commas and a percent sign removed ("1,200" and "1200", "73%" and "73" are
 * the same figure). */
const STOP = new Set("the and for from with that this these those into over under about have has had was were are is be been being its their our your his her a an of in on to by at as or not but than then also more most less such which who whom what when where while".split(" "));
const stem = (w) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
export function claimTerms(text) {
  const t = String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const numbers = new Set((t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, "").replace(/\.0+$/, "")).filter(Boolean));
  const words = new Set((t.match(/\p{L}+/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem));
  return { numbers, words };
}

/* Does the abstract alone carry the claim? Every figure the claim states, and
 * at least 60% of its words. When it does not, the abstract is what the
 * paper is ABOUT and the specific figure is usually in its results — so the
 * open-access copy is read too, when there is one. A heuristic, deliberately:
 * deciding with a model would be a second call. */
export function abstractSettles(abstract, claim) {
  const want = claimTerms(claim);
  const have = claimTerms(abstract);
  for (const x of want.numbers) if (!have.numbers.has(x)) return false;
  if (!want.words.size) return true;
  let hit = 0;
  for (const w of want.words) if (have.words.has(w)) hit++;
  return hit / want.words.size >= 0.6;
}

/* ── which passages the judge reads ──────────────────────────────────────
 * texts: [{ from: "abstract" | "page", text }]. Everything, when it all fits
 * in `windows` × `size` characters (most abstracts); otherwise the best
 * `windows` passages of up to `size` characters from ANYWHERE in the texts —
 * runs of whole sentences, scored by how many of the claim's distinct words
 * (1 point) and figures (3 points) they contain, a term already covered by a
 * chosen passage counting half, so the passages cover different parts of the
 * claim. Returned in document order, each tagged with where it came from.
 * When nothing overlaps the claim at all, the opening of each text: the judge
 * can still say "topic", which is the truth about such a source.
 * (The one 1,400-character selection this replaced picked single sentences
 * out of context and joined them with "…", so a quote across two of them was
 * words the source never wrote in that order.) */
function chunk(sentence, size) {
  if (sentence.length <= size) return [sentence];
  const out = [];
  let cur = "";
  for (const w of sentence.split(" ")) {
    if (cur && cur.length + 1 + w.length > size) { out.push(cur); cur = ""; }
    cur = cur ? `${cur} ${w}` : w.slice(0, size);
  }
  if (cur) out.push(cur);
  return out;
}
export function selectExcerpts(texts, claim, { windows = EXCERPT_WINDOWS, size = EXCERPT_CHARS } = {}) {
  const docs = (Array.isArray(texts) ? texts : [])
    .map((t) => ({ from: t?.from === "abstract" ? "abstract" : "page", text: String(t?.text ?? "").replace(/\s+/g, " ").trim() }))
    .filter((t) => t.text);
  if (!docs.length) return [];
  if (docs.reduce((n, d) => n + d.text.length, 0) <= windows * size) return docs;
  const want = claimTerms(claim);
  const units = docs.map((d) => {
    const list = [];
    for (const sentence of d.text.split(/(?<=[.!?])\s+/)) {
      for (const piece of chunk(sentence, size)) {
        const tt = claimTerms(piece);
        const keys = new Set();
        for (const x of tt.numbers) if (want.numbers.has(x)) keys.add(`n:${x}`);
        for (const w of tt.words) if (want.words.has(w)) keys.add(`w:${w}`);
        list.push({ text: piece, keys });
      }
    }
    return list;
  });
  // The sentence at `at`, grown a sentence at a time — the next one first,
  // then the one before — while the passage still fits in `size`.
  const windowAt = (di, at) => {
    const list = units[di];
    let start = at, end = at + 1, len = list[at].text.length;
    for (let grew = true; grew;) {
      grew = false;
      if (end < list.length && len + 1 + list[end].text.length <= size) { len += 1 + list[end].text.length; end++; grew = true; }
      if (start > 0 && len + 1 + list[start - 1].text.length <= size) { len += 1 + list[start - 1].text.length; start--; grew = true; }
    }
    const keys = new Set();
    for (let k = start; k < end; k++) for (const key of list[k].keys) keys.add(key);
    return { di, start, end, keys };
  };
  const cands = [];
  units.forEach((list, di) => list.forEach((u, k) => { if (u.keys.size) cands.push(windowAt(di, k)); }));
  const picked = [];
  const covered = new Set();
  while (picked.length < windows) {
    let best = null, bestScore = 0;
    for (const w of cands) {
      if (picked.some((p) => p.di === w.di && p.start < w.end && w.start < p.end)) continue;
      let score = 0;
      for (const key of w.keys) score += (key[0] === "n" ? 3 : 1) * (covered.has(key) ? 0.5 : 1);
      if (score > bestScore) { best = w; bestScore = score; }
    }
    if (!best) break;
    picked.push(best);
    for (const key of best.keys) covered.add(key);
  }
  if (!picked.length) for (let di = 0; di < docs.length && picked.length < windows; di++) picked.push(windowAt(di, 0));
  return picked
    .sort((a, b) => a.di - b.di || a.start - b.start)
    .map((w) => ({ from: docs[w.di].from, text: units[w.di].slice(w.start, w.end).map((u) => u.text).join(" ") }));
}

/* ── is the quote really in the text? ────────────────────────────────────
 * Two copies of the same words differ in whitespace, in curly against
 * straight quote marks, in which dash, in case, in a ligature or a soft
 * hyphen. Those are folded; nothing else is. Every folded character keeps the
 * index of the character it came from, so the receipt shown is the SOURCE's
 * characters, not the judge's copy of them. */
const QUOTE_MARKS = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "`": "'", "´": "'", "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"', "«": '"', "»": '"' };
const DASH = /^[‐-―−﹘﹣－]$/;
const INVISIBLE = /^[­​-‍⁠﻿]$/;
function foldChar(ch) {
  if (/^\s$/.test(ch)) return " ";
  if (INVISIBLE.test(ch)) return "";
  if (QUOTE_MARKS[ch]) return QUOTE_MARKS[ch];
  if (DASH.test(ch)) return "-";
  if (ch === "…") return "...";
  return ch.normalize("NFKC").toLowerCase();
}
/** `text` folded for matching, and `map[i]` = the index in the original of folded character i. */
export function foldForMatch(text) {
  const s = String(text ?? "");
  let out = "";
  const map = [];
  let space = true; // leading whitespace dropped
  for (let i = 0; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i));
    const f = foldChar(ch);
    if (f === " ") {
      if (!space) { out += " "; map.push(i); space = true; }
    } else if (f) {
      out += f;
      for (let k = 0; k < f.length; k++) map.push(i);
      space = false;
    }
    i += ch.length;
  }
  if (out.endsWith(" ")) { out = out.slice(0, -1); map.pop(); }
  return { text: out, map };
}
/* The judge's quote without what may wrap it: quote marks, brackets, a
 * leading or trailing ellipsis (a quote that starts mid-sentence is still one
 * contiguous span), closing punctuation. */
function quoteCore(quote) {
  let t = foldForMatch(quote).text;
  for (let prev = ""; prev !== t;) {
    prev = t;
    t = t.replace(/^(?:["'([\s]|\.\.\.)+/, "").replace(/(?:["')\].,;:!?\s]|\.\.\.)+$/, "");
  }
  return t;
}
const clipQuote = (q) => {
  const t = String(q).trim();
  if (t.length <= MAX_QUOTE_CHARS) return t;
  const cut = t.slice(0, MAX_QUOTE_CHARS);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > MAX_QUOTE_CHARS * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:]$/, "")}…`;
};
/**
 * Where the quote is, verbatim (after folding), in ONE of the passages — on
 * word boundaries, so "fell by 73" is not found in "fell by 735" or "73.5%".
 * Returns { index, from, text } with `text` the passage's own characters, or
 * null. At least MIN_QUOTE_CHARS and three words: a receipt has to say
 * something.
 */
export function matchQuote(quote, passages) {
  const q = quoteCore(quote);
  if (q.length < MIN_QUOTE_CHARS || q.split(" ").length < 3) return null;
  const list = Array.isArray(passages) ? passages : [];
  for (let p = 0; p < list.length; p++) {
    const orig = String(list[p]?.text ?? "");
    const { text, map } = foldForMatch(orig);
    for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + 1)) {
      const before = at > 0 ? text[at - 1] : "";
      const after = text.slice(at + q.length, at + q.length + 2);
      if (/[\p{L}\p{N}]/u.test(before) || /^[\p{L}\p{N}]|^[.,]\d/u.test(after)) continue;
      const last = map[at + q.length - 1];
      return { index: p, from: list[p].from, text: orig.slice(map[at], last + String.fromCodePoint(orig.codePointAt(last)).length) };
    }
  }
  return null;
}

/* ── reading ─────────────────────────────────────────────────────────────── */

/* At most `cap` bytes of a body, then the stream is cancelled. */
async function readCapped(res, cap) {
  if (!res.body?.getReader) {
    const t = await res.text();
    return t.length > cap ? t.slice(0, cap) : t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(size, cap));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.length - at);
    buf.set(c.subarray(0, take), at);
    at += take;
    if (at >= buf.length) break;
  }
  return new TextDecoder().decode(buf);
}

/* A PDF is out of scope here: a zero-dependency server has no parser for one,
 * so an open-access copy that is only a PDF leaves the abstract as the text,
 * and a source that is only a PDF is unread. */
const looksLikePdf = (u) => /\.pdf(?:$|[?#])|\/pdf(?:\/|$|[?#])/i.test(String(u ?? ""));

/* A page's visible text, or "" when it cannot be read: not HTML, a bot wall
 * (citeMeta.js looksBlocked), an HTTP error, or almost no text. */
async function readPage(url, { signal, fetchImpl }) {
  if (!/^https?:\/\//i.test(String(url ?? "")) || looksLikePdf(url)) return "";
  try {
    const res = await safeFetch(new URL(url), { signal, headers: { "User-Agent": PAGE_UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" } }, { fetchImpl });
    const type = String(res.headers?.get?.("content-type") ?? "");
    if (!res.ok || (type && !/html|xml|text/i.test(type))) return "";
    const html = await readCapped(res, MAX_PAGE_BYTES);
    if (looksBlocked(res.status, html, htmlTitle(html))) return "";
    const text = pageText(html);
    return text.length >= MIN_PAGE_CHARS ? text : "";
  } catch {
    return "";
  }
}

/** The open-access copy OpenAlex lists for a work, as a web page (never a PDF), or "". */
export function openAccessPage(work) {
  const best = work?.best_oa_location;
  const urls = [
    best && best.is_oa !== false ? best.landing_page_url : null,
    work?.open_access?.oa_url,
    ...(Array.isArray(work?.locations) ? work.locations : []).filter((l) => l?.is_oa).map((l) => l.landing_page_url),
  ];
  return urls.find((u) => typeof u === "string" && /^https?:\/\//i.test(u) && !looksLikePdf(u)) ?? "";
}

/* What each source says: { evidence: [{ i, passages }], retracted: [source] }.
 * Every source is read — the search's own label is not trusted either way.
 * For a DOI: OpenAlex (abstract, is_retracted, open-access copy), then the
 * open-access copy when the abstract does not settle it, or the source's page
 * when there is no abstract. Otherwise the page. All under one deadline. */
export async function gatherEvidence(sources, claim, { fetchImpl = globalThis.fetch, deadlineMs = VERIFY_DEADLINE_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadlineMs);
  const evidence = [];
  const retracted = [];
  const signal = ctrl.signal;
  try {
    await Promise.allSettled((Array.isArray(sources) ? sources : []).map(async (s, i) => {
      if (!s || typeof s !== "object") return;
      const texts = [];
      const doi = doiOf(s);
      let oa = "";
      if (doi) {
        try {
          const res = await fetchImpl(OPENALEX_WORK + encodeURIComponent(doi), { signal, headers: { "User-Agent": API_UA, Accept: "application/json" } });
          const work = res.ok ? await res.json() : null;
          if (work?.is_retracted === true) { retracted.push(s); return; }
          const abstract = abstractFromIndex(work?.abstract_inverted_index);
          if (abstract.length >= MIN_TEXT_CHARS) texts.push({ from: "abstract", text: abstract });
          oa = openAccessPage(work);
        } catch { /* fall through to the page */ }
      }
      if (!texts.length || !abstractSettles(texts[0].text, claim)) {
        // The open-access copy first; the source's own page only when there is
        // no abstract (a publisher's page for a paywalled article is usually
        // the abstract again, behind a wall).
        const tries = [...new Set([oa, texts.length ? "" : s.url].filter(Boolean))];
        for (const url of tries) {
          const text = await readPage(url, { signal, fetchImpl });
          if (text) { texts.push({ from: "page", text }); break; }
        }
      }
      const passages = selectExcerpts(texts, claim);
      if (passages.reduce((n, p) => n + p.text.length, 0) >= MIN_TEXT_CHARS) evidence.push({ i, passages });
    }));
  } finally {
    clearTimeout(timer);
  }
  return { evidence: evidence.sort((a, b) => a.i - b.i), retracted };
}

export const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "quote"],
        properties: {
          id: { type: "integer" },
          verdict: { type: "string", enum: ["backs", "contradicts", "topic"] },
          quote: { type: "string", description: "For backs/contradicts: the words from ONE excerpt that decide it, copied character for character as one contiguous span, at most 300 characters. \"\" for topic." },
        },
      },
    },
  },
};

export const VERIFY_SYSTEM = `You check whether sources actually say what a student's sentence claims, before the student is told to cite them. You are given the CLAIM and, for each source, excerpts of its own text, each excerpt in its own """ block. Judge from that text ONLY — never from what you know about the source, its title or its reputation.

For each source, one verdict:
- "backs": an excerpt states the claim's specific proposition — the same subject, the same direction, and the same figures where the claim gives any. A different word for the same measure is fine ("spending" or "investment", "facilities" or "services" when the text means the same figure). Backing part of a two-part claim is "backs" only if the part it backs is the claim's main point.
- "contradicts": an excerpt states something that cannot be true alongside the claim (a different figure, the opposite direction, a different date or person).
- "topic": anything else. A source about the same subject that does not state this sentence's specific proposition is "topic" — however relevant, however reputable: one that makes a different point, a broader or weaker one, a related finding, or only mentions the subject. This is the answer whenever you are unsure. A paper about youth services cut by austerity does NOT back a claim that support for youth leadership has grown.

If a PROPOSED CORRECTION is given, judge against the ORIGINAL claim: a source that backs the correction "contradicts" the claim.

"quote" is the receipt the student is shown under the source. For "backs" and "contradicts", copy the words that decide it from ONE excerpt, character for character, as one contiguous span: no ellipses, nothing added, changed or reordered, at most 300 characters — a whole sentence or clause, enough to read on its own. The quote is checked against the excerpt, and a verdict whose quote is not there is discarded as "topic". Use "" for "topic".`;

/* What a source becomes when it could not be read or judged: never backing. */
export function markUnverified(s) {
  if (!s || typeof s !== "object") return;
  if (s.stance === "supports" || s.stance === "refutes") s.stance = "context";
  s.verified = false;
  delete s.readFrom;
  delete s.quote;
}

/* The verdicts, applied: stance, `verified`, `readFrom`, and for backing or
 * contradicting the `quote` found in the source's own text, which also
 * becomes the snippet. A quote that is not there drops the verdict to
 * "topic". A source the judge skipped is unverified. Pure, so it is tested
 * without a model. Returns { changed, quoted, unquoted, unjudged }. */
export function applyVerdicts(sources, evidence, verdicts) {
  const byId = new Map((Array.isArray(verdicts) ? verdicts : []).map((v) => [v?.id, v]));
  const tally = { changed: 0, quoted: 0, unquoted: 0, unjudged: 0 };
  for (const e of evidence) {
    const s = sources[e.i];
    if (!s) continue;
    const before = s.stance;
    const v = byId.get(e.i);
    const readFrom = e.passages.some((p) => p.from === "page") ? "page" : "abstract";
    if (!v || !["backs", "contradicts", "topic"].includes(v.verdict)) {
      markUnverified(s);
      tally.unjudged++;
    } else {
      const m = v.verdict === "topic" ? null : matchQuote(v.quote, e.passages);
      if (v.verdict !== "topic" && !m) tally.unquoted++;
      s.stance = !m ? "context" : v.verdict === "backs" ? "supports" : "refutes";
      s.verified = true;
      s.readFrom = m ? m.from : readFrom;
      if (m) {
        s.quote = clipQuote(m.text);
        s.snippet = `“${s.quote}”`;
        tally.quoted++;
      } else {
        delete s.quote;
      }
    }
    if (s.stance !== before) tally.changed++;
  }
  return tally;
}

export async function verifySources({ claim, correction, sources, model, call = structuredCall, fetchImpl = globalThis.fetch, deadlineMs = VERIFY_DEADLINE_MS }) {
  const list = Array.isArray(sources) ? sources : [];
  // quoted: backs/contradicts whose quote was found; unquoted: whose quote was
  // not (fell to topic) — the number that says whether the rule is too strict.
  const out = { checked: 0, changed: 0, quoted: 0, unquoted: 0, unread: 0, retracted: [], usage: null };
  const unverify = (s) => {
    if (!s || typeof s !== "object") return;
    const before = s.stance;
    markUnverified(s);
    if (s.stance !== before) out.changed++;
    out.unread++;
  };
  let evidence = [];
  try {
    ({ evidence, retracted: out.retracted } = await gatherEvidence(list, claim, { fetchImpl, deadlineMs }));
  } catch { /* nothing read */ }
  const read = new Set(evidence.map((e) => e.i));
  const gone = new Set(out.retracted);
  list.forEach((s, i) => { if (!read.has(i) && !gone.has(s)) unverify(s); });
  if (!evidence.length) return out;
  try {
    const user = `CLAIM:\n${claim}\n` + (correction ? `\nPROPOSED CORRECTION:\n${correction}\n` : "") +
      evidence.map((e) => `\nSOURCE ${e.i}: ${list[e.i].title}\n` + e.passages.map((p) => `"""\n${p.text}\n"""`).join("\n")).join("\n") +
      `\n\nReturn one verdict per source id (${evidence.map((e) => e.i).join(", ")}).`;
    const raw = await call({ model, system: VERIFY_SYSTEM, user, schema: VERIFY_SCHEMA, maxTokens: 2_000, what: "source check", name: "verdicts", effort: "low" });
    const t = applyVerdicts(list, evidence, raw?.parsed?.verdicts);
    out.checked = evidence.length;
    out.changed += t.changed;
    out.quoted = t.quoted;
    out.unquoted = t.unquoted;
    out.unread += t.unjudged;
    out.usage = raw?.usage ?? null;
    return out;
  } catch (err) {
    // Read but never judged: unverified, like a source that could not be read.
    for (const e of evidence) unverify(list[e.i]);
    // Billed if it answered; the caller adds what the error carries.
    return { ...out, usage: err?.llm?.usage ?? null, error: String(err?.message ?? err) };
  }
}
