/**
 * "Paste a URL and cite it" (/api/cite-url): read a page's own citation
 * metadata. Free, no AI.
 *
 * What it replaced cited whatever came back. An Akamai or Cloudflare wall
 * answers 403 with a page titled "Access Denied" or "Client Challenge", and
 * that title went into a student's reference list. It read no author and no
 * date, so every citation was "(n.d.)" with the site's hostname in the author
 * slot, and it decoded no numeric entities ("&#8217;" reached the document).
 *
 * Now:
 *   - a bot wall or an HTTP error is a clear error, never a citation;
 *   - authors, dates, publisher, journal fields are read in a fixed order of
 *     trust: citation_* tags (what scholarly indexes read) > Open Graph and
 *     article:* > JSON-LD > the first trusted <time> > a visible "Published:"
 *     label;
 *   - a date is taken as the page WROTE it (never through new Date(), which
 *     shifts a timestamp's calendar day into the server's timezone), a
 *     modified date is never taken for a published one, and a date that
 *     contradicts a past year the title names is refused (IOM's "World
 *     Migration Report 2024" carries citation_publication_date 2020, a CMS
 *     node date).
 *
 * Every field beyond the original five is OPTIONAL and omitted when the page
 * does not state it — this route is frozen to additive changes while an
 * extension build is in review (CLAUDE.md), and the extension's formatter
 * reads their presence as "this came from a server that looks".
 */
import { CheckError } from "./errors.js";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/* HTML's Latin-1 entities (U+00A0..U+00FF, in code-point order), then the
 * punctuation and letters pages actually carry. Names are case-sensitive
 * (&Eacute; is not &eacute;), as in HTML. */
const LATIN1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const NAMED = Object.assign(Object.create(null),
  Object.fromEntries(LATIN1.map((name, i) => [name, String.fromCodePoint(0xa0 + i)])),
  {
    nbsp: " ", shy: "", amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: '"', QUOT: '"', apos: "'",
    ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
    hellip: "…", bull: "•", prime: "′", Prime: "″", lsaquo: "‹", rsaquo: "›", dagger: "†", Dagger: "‡",
    permil: "‰", trade: "™", euro: "€", ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", lrm: "", rlm: "",
    OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜",
    minus: "−", nbhy: "‑", hyphen: "‐", dash: "‐", period: ".", comma: ",", colon: ":", semi: ";",
    lpar: "(", rpar: ")", sol: "/", num: "#", excl: "!", quest: "?", ast: "*", commat: "@",
  });

/** Numeric (decimal and hex) and named entities, in ONE pass: what a
 *  replacement produces is never decoded again, so "&amp;lt;" is the text
 *  "&lt;" the page meant, not "<". An unknown name is left as written. */
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (whole, hex, dec, name) => {
    if (hex) return safeChar(parseInt(hex, 16));
    if (dec) return safeChar(Number(dec));
    return name in NAMED ? NAMED[name] : whole;
  });
}
function safeChar(n) {
  if (!(n > 0 && n < 0x110000) || (n >= 0xd800 && n <= 0xdfff)) return "";
  return String.fromCodePoint(n);
}
const clean = (s) => decodeEntities(s).replace(/\s+/g, " ").trim();
const loose = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ── dates ─────────────────────────────────────────────────────────────

/** A real calendar day (no 31 February), or a year/month on its own. */
function realDate(y, mo, d) {
  if (mo == null) return true;
  if (d == null) return mo >= 1 && mo <= 12;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Not in the future: the period's first moment is at most 36 hours ahead
 *  (a page dated "tomorrow" in a timezone east of ours is fine). */
function notFuture({ year, month, day }, now) {
  const first = Date.UTC(year, month == null ? 0 : month - 1, day == null ? 1 : day);
  return first <= now.getTime() + 36 * 3600_000;
}

/**
 * A date string as the page wrote it → { year, month, day } (month/day null
 * when not stated), or null. Accepts ISO dates and timestamps, Drupal's
 * "Thu, 05/21/2020 - 20:41", "May 7, 2024", "7 May 2024" and a bare year.
 */
export function parseDate(raw, now = new Date()) {
  const s = String(raw ?? "").trim().slice(0, 100);
  const ok = (y, mo, d) => {
    y = Number(y);
    mo = mo == null ? null : Number(mo);
    d = mo == null || d == null ? null : Number(d);
    if (!(y >= 1500) || !realDate(y, mo, d)) return null;
    const out = { year: y, month: mo, day: d };
    return notFuture(out, now) ? out : null;
  };
  let m;
  if ((m = s.match(/^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?(?:[T\s]|$)/))) return ok(m[1], m[2], m[3]);
  if ((m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/))) {
    // US order unless impossible ("21/05/2020" can only be day-first).
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a > 12 ? ok(m[3], b, a) : ok(m[3], a, b);
  }
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  if ((m = s.match(new RegExp(`\\b${mon}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i")))) return ok(m[3], monthIdx(m[1]), m[2]);
  if ((m = s.match(new RegExp(`\\b(\\d{1,2})\\s+${mon}\\s+(\\d{4})\\b`, "i")))) return ok(m[3], monthIdx(m[2]), m[1]);
  return null;
}
function monthIdx(name) {
  return MONTHS.findIndex((n) => n.startsWith(name.toLowerCase().slice(0, 3))) + 1;
}
export const isoOf = (d) => (d?.day ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null);

/** A work cannot have been published before a year its title is ABOUT, once
 *  that year has happened: "World Migration Report 2024" was not published in
 *  2020. A future target year ("Vision 2030") proves nothing. */
export function contradictsTitle(year, title, now = new Date()) {
  const thisYear = now.getUTCFullYear();
  return [...String(title ?? "").matchAll(/\b(1[6-9]\d\d|20\d\d)\b/g)].some(([, y]) => Number(y) > year + 1 && Number(y) <= thisYear);
}

// ── people vs organisations ─────────────────────────────────────────────

const ORG_WORDS = /\b(Center|Centre|Centers|Institute|Organi[sz]ation|Agency|Department|Ministry|University|College|Association|Society|Foundation|Council|Bureau|Office|Commission|Committee|Service|Administration|Board|Program(?:me)?|Fund|Bank|Nations|Staff|Team|Editors|Editorial|Newsroom|Press|News|Inc|LLC|Ltd|Corporation|Company|Group|Network|Authority|Clinic|Hospital|Museum|Library|Laboratory|Survey|Reuters|Associated)\b/i;
export const PLACEHOLDER_NAME = /^(unknown|unknown author|anonymous author|author|authors|admin|administrator|staff|staff writer|editor|editors|guest|n\/a|none|null|undefined|various|contributors?)$/i;
export const isHostname = (s) => /^[\w-]+(\.[\w-]+)+$/.test(String(s ?? "").trim());

/* In a list that names PEOPLE — citation_author, a JSON-LD Person, the
 * authors the model was told are people — an institutional word can be a
 * surname: "Eyal Press", "Joseph Bank", "Press, Eyal". There an organisation
 * needs a word no person's name carries, or more than a two-word name. */
const STRONG_ORG = /\b(Institute|Organi[sz]ation|Agency|Department|Ministry|University|Association|Foundation|Commission|Committee|Administration|Corporation|Laboratory|Nations|Inc|LLC|Ltd|Consortium|Collaboration|Initiative|Coalition|Federation|Authority|Hospital|Museum|Clinic|Company|Network)\b/i;
const SURNAME_ORG_WORD = /^(Press|Bank|Board|Service|Council|Fund|Office|News|Center|Centre|Survey|Library|College|Group|Society|Staff|Team|Program|Bureau)$/i;
// ...unless the word before it is one no given name is: "World Bank", "Associated Press".
const ORG_MODIFIER = /^(World|National|Federal|Central|Reserve|Development|Associated|United|International|European|African|Asian|American|Islamic|Investment|Export|Academic|University|State|City|County|Royal|Public|Research|Science|Policy|Health|Civil|Foreign|Security|Budget|Census|Geological)$/i;
const ACRONYM = /^[A-Z][A-Z&.]{1,7}$/;

/** An organisation's name, not a person's: an acronym ("CDC", "IOM") or a
 *  name carrying an institutional word ("Pew Research Center"). With
 *  `person`, the name came from a list of people, and a surname that is an
 *  institutional word stays a person. */
export function looksLikeOrg(s, { person = false } = {}) {
  const t = String(s ?? "").trim();
  if (!person) return ACRONYM.test(t) || ORG_WORDS.test(t);
  if (STRONG_ORG.test(t)) return true;
  if (t.includes(",")) return false; // "Press, Eyal" is Family, Given
  if (ACRONYM.test(t)) return true;
  if (!ORG_WORDS.test(t)) return false;
  const w = t.split(/\s+/);
  return !(w.length === 2 && SURNAME_ORG_WORD.test(w[1]) && !ORG_MODIFIER.test(w[0]) && !/^[A-Z]{2,}$/.test(w[0]));
}

/**
 * One byline naming several people → one name each: "Jane Doe and John Roe",
 * "Jane Doe, John Roe & Max Poe", "By Doe, Jane; Roe, John". A separator
 * splits only when every part it leaves is itself a full name (two words, or
 * "Family, Given"), so "Doe, Jane", "Jane Doe, Jr." and "Procter & Gamble"
 * stay whole, and an organisation's name ("Department of Health and Human
 * Services", "Office of Science and Technology Policy") is never cut up.
 *
 * A comma separates two people only when both halves read as "Given Family":
 * "van der Walt, Stéfan J." (a particle leads, an initial ends) is one
 * person. `commas: false` for tags whose every value is "Family, Given"
 * (citation_author).
 */
export function splitNames(raw, { commas = true } = {}) {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^by\s+/i, "");
  if (!t || STRONG_ORG.test(t) || /\b(of|for|the)\b/i.test(t)) return t ? [t] : [];
  const words = (p) => p.split(" ").length;
  const strong = t.split(/\s*(?:;|&|\band\b)\s*/i).map((p) => p.replace(/^,|,$/g, "").trim()).filter(Boolean);
  const groups = strong.length > 1 && strong.every((p) => p.includes(",") || words(p) >= 2) ? strong : [t];
  if (!commas) return groups;
  const fullName = (p) => words(p) >= 2 && !/^\p{Ll}/u.test(p) && !/(^|\s)\p{Lu}\.?$/u.test(p);
  return groups.flatMap((g) => {
    const parts = g.split(/\s*,\s*/).filter(Boolean);
    return parts.length > 1 && parts.every(fullName) ? parts : [g];
  });
}

/** A list of authors kept to 30 — but never by dropping the LAST one, whom
 *  APA 7 names after the ellipsis for 21 or more. */
export const capAuthors = (list, max = 30) => (list.length > max ? [...list.slice(0, max - 1), list.at(-1)] : list);

/** `raw` is already entity-decoded (meta values are decoded once, in
 *  collectMeta; JSON-LD names by the caller) — decoding again would turn a
 *  page's literal "&lt;" into "<". An organisation the page TYPED as one
 *  (`org`) still has to be a name: a hostname, a URL or "Staff" is not. */
function personOrOrg(raw, { person = false, org = false } = {}) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/^by\s+/i, "");
  if (!s || s.length > 150 || PLACEHOLDER_NAME.test(s) || isHostname(s) || /^(https?:|www\.|@)|@|\.(com|org|net)\b/i.test(s)) return null;
  if (org || looksLikeOrg(s, { person })) return { org: s };
  if (s.length > 120 || s.split(" ").length > 6) return null; // a sentence, not a name
  return { person: s };
}

// ── the bot wall ───────────────────────────────────────────────────────

/* Matched against the WHOLE title (trailing dots and a " | Cloudflare" tail
 * removed), so "Forbidden Planet – Wikipedia" is a film, not a block. */
const CHALLENGE_TITLE = /^(access denied|client challenge|just a moment|attention required!?|please wait|one moment,? please|are you a (robot|human)\??|security check|(403 )?forbidden|pardon our interruption|request rejected|bot verification|human verification|verify(ing)? you are (a )?human|access to this page has been denied|error: the request could not be satisfied|ddos-guard|captcha)$/i;
/* Cloudflare's challenge page itself. Not "challenge-platform" on its own:
 * Cloudflare injects /cdn-cgi/challenge-platform/scripts/jsd/main.js into
 * ordinary pages behind Bot Fight Mode. */
const CHALLENGE_BODY = /_cf_chl_opt|cf-browser-verification|challenge-platform\/h\/[a-z]\/orchestrate/;
const BLOCK_STATUS = new Set([401, 403, 429, 503]);

export function looksBlocked(status, html, rawTitle) {
  const t = String(rawTitle ?? "").replace(/\s*[|–—-]\s*cloudflare$/i, "").replace(/[.…\s]+$/, "").trim();
  return BLOCK_STATUS.has(status) || CHALLENGE_TITLE.test(t) || CHALLENGE_BODY.test(String(html ?? "").slice(0, 20_000));
}

// ── page parsing ───────────────────────────────────────────────────────
//
// One pass over the page, never a regex over all of it. What this replaced
// (/<[^>]+>/g for the visible text, /<meta\s[^>]*>/gi, /<time[^>]*…/gi, the
// lazy <script>…</script> and <title>…</title> scans) restarted at every "<"
// and ran to the end of the page whenever nothing closed, so a pasted URL
// serving half a megabyte of unclosed "<" held the server's one thread for
// minutes. Here every search starts where the previous one ended; a tag with
// no ">" after it, or a <script>/<style>/<title> that never closes, ends the
// scan, because nothing after it can be read as markup either.

/** At most this much of a page is read. <head> and the top of <body> are
 *  where every field lives; the rest is never looked at. */
export const MAX_HTML_CHARS = 500_000;
const MAX_TEXT_CHARS = 200_000; // visible text kept for the "Published:" label
const RAW_TEXT = new Set(["script", "style", "title"]);
const isSpace = (c) => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";

/** A tag's attributes by lowercased name, the first occurrence winning (as
 *  in a browser). Linear: a quoted value ends at its quote, found by indexOf. */
function tagAttrs(tag) {
  const out = Object.create(null);
  const n = tag.endsWith(">") ? tag.length - 1 : tag.length;
  let i = 1;
  while (i < n && !isSpace(tag[i]) && tag[i] !== "/") i++; // the tag's own name
  while (i < n) {
    while (i < n && (isSpace(tag[i]) || tag[i] === "/")) i++;
    if (i >= n) break;
    const s = i;
    while (i < n && !isSpace(tag[i]) && tag[i] !== "/" && tag[i] !== "=") i++;
    const name = tag.slice(s, i).toLowerCase();
    while (i < n && isSpace(tag[i])) i++;
    let value = "";
    if (tag[i] === "=") {
      i++;
      while (i < n && isSpace(tag[i])) i++;
      if (tag[i] === '"' || tag[i] === "'") {
        const end = tag.indexOf(tag[i], i + 1);
        const stop = end < 0 || end > n ? n : end;
        value = tag.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const v = i;
        while (i < n && !isSpace(tag[i])) i++;
        value = tag.slice(v, i);
      }
    }
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

/* A <time> is a publication date only when the page says so, or it sits
 * where a byline does. The first <time> anywhere was often a masthead's
 * "today" or a sidebar's date, which cited an undated page as published
 * today. Trusted: marked as published (itemprop, the old pubdate attribute,
 * a class or id naming it or the title bar), inside an <article>, or within
 * 2,000 characters after the first headline. Never one marked as an update. */
const TIME_MODIFIED = /modif|updat|edited|revis/i;
const TIME_PUBLISHED = /publish|pub-?date|posted|dateline|byline|title|entry-date|article-date|post-date|story-date/i;
function timeTrusted(a, inArticle, afterHeadline) {
  const marks = `${a.class ?? ""} ${a.id ?? ""}`;
  if (/dateModified/i.test(a.itemprop ?? "") || TIME_MODIFIED.test(marks)) return false;
  if (/datePublished|dateCreated/i.test(a.itemprop ?? "") || "pubdate" in a || TIME_PUBLISHED.test(marks)) return true;
  return inArticle || afterHeadline;
}

/**
 * The parts of a page citation fields come from, in one linear pass:
 * every <meta>'s attributes, the first <title>'s text, each JSON-LD block's
 * source, each <time datetime> in page order (with whether it can be trusted
 * as the publication date — timeTrusted), and the visible text (tags replaced
 * by spaces, script and style bodies dropped) for the "Published:" label.
 * Markup inside comments and scripts is not markup and is skipped.
 */
export function scanHtml(input) {
  const html = String(input ?? "").slice(0, MAX_HTML_CHARS);
  // ASCII-only lowercasing keeps every index aligned with `html`; full
  // Unicode lowercasing can change a string's length ("İ" becomes two units).
  const lower = html.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  const page = { html, metas: [], title: null, ld: [], times: [], text: "" };
  const text = [];
  let textLen = 0;
  const addText = (s) => {
    if (s && textLen < MAX_TEXT_CHARS) { text.push(s); textLen += s.length; }
  };
  const n = html.length;
  let pos = 0;
  let articleDepth = 0;
  let h1End = -1; // just past the first </h1>: a byline's date follows the headline
  while (pos < n) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) { addText(html.slice(pos)); break; }
    addText(html.slice(pos, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break;
      pos = end + 3;
      continue;
    }
    const next = lower[lt + 1] ?? "";
    if (!((next >= "a" && next <= "z") || next === "/" || next === "!" || next === "?")) {
      addText("<"); // "a < b" is text, and no ">" search is spent on it
      pos = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    pos = gt + 1;
    addText(" ");
    const m = /^<(\/?)([a-z][a-z0-9:-]*)/.exec(lower.slice(lt, Math.min(gt, lt + 64)));
    if (!m) continue; // <!doctype>, <?xml?>
    const name = m[2];
    if (m[1]) {
      if (name === "article" && articleDepth > 0) articleDepth--;
      else if (name === "h1" && h1End < 0) h1End = pos;
      continue;
    }
    if (name === "article") articleDepth++;
    else if (name === "meta") page.metas.push(tagAttrs(html.slice(lt, gt + 1)));
    else if (name === "time") {
      const a = tagAttrs(html.slice(lt, gt + 1));
      if (a.datetime) page.times.push({ value: a.datetime, trusted: timeTrusted(a, articleDepth > 0, h1End >= 0 && lt - h1End <= 2000) });
    } else if (RAW_TEXT.has(name)) {
      const end = lower.indexOf(`</${name}`, pos);
      if (end < 0) break; // everything after is this element's text
      const body = html.slice(pos, end);
      if (name === "title") {
        if (page.title == null) page.title = body;
        addText(body);
      } else if (name === "script" && lower.slice(lt, gt).includes("application/ld+json")) {
        page.ld.push(body);
      }
      const close = html.indexOf(">", end);
      pos = close < 0 ? n : close + 1;
      addText(" ");
    }
  }
  page.text = text.join("");
  return page;
}

/** Every <meta>, keyed by lowercased name/property/itemprop, values in page order. */
function collectMeta(page) {
  const map = new Map();
  for (const a of page.metas) {
    const key = (a.name || a.property || a.itemprop || "").toLowerCase();
    if (!key || a.content == null) continue;
    const v = clean(a.content.slice(0, 2000));
    if (!v) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  }
  return map;
}

function collectJsonLd(page) {
  const items = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x["@graph"])) walk(x["@graph"]);
    if (x["@type"]) items.push(x);
  };
  for (const block of page.ld) {
    try { walk(JSON.parse(block.trim())); } catch { /* malformed, or nested past the stack: ignore it */ }
  }
  return items;
}
const typesOf = (it) => [].concat(it?.["@type"] ?? []).map(String);
const ARTICLE_T = /^(Article|NewsArticle|ReportageNewsArticle|AnalysisNewsArticle|OpinionNewsArticle|BackgroundNewsArticle|BlogPosting|ScholarlyArticle|Report|TechArticle|MedicalScholarlyArticle|Chapter|Book)$/;
const NEWS_T = /NewsArticle$|^NewsMediaOrganization$/;

const hostLabel = (host) => host.replace(/^www\./, "").split(".").slice(-2, -1)[0] ?? "";

function stripSiteSuffix(title, names) {
  // " | Anything" at the end is a site or section suffix in practice.
  let t = title.replace(/\s+\|\s+[^|]+$/, "");
  const m = t.match(/^(.*\S)\s+[-–—:]\s+([^-–—:]+)$/);
  if (m && names.some((n) => n && loose(m[2]) === loose(n))) t = m[1];
  return t.trim();
}

/* Published-date signals in order of trust. An EXPLICIT one is taken even
 * when it equals the modified stamp (an article never updated has both); a
 * generic one ("date", DC.date, the first <time>) is skipped when it does,
 * because on CDC's pages DC.date IS the modified time. */
const EXPLICIT_DATE_KEYS = ["citation_publication_date", "citation_date", "citation_online_date", "prism.publicationdate", "article:published_time", "og:article:published_time", "parsely-pub-date", "dc.date.issued", "dcterms.issued"];
const GENERIC_DATE_KEYS = ["date", "pubdate", "publishdate", "publish-date", "sailthru.date"];
const LATE_GENERIC_DATE_KEYS = ["dc.date", "dcterms.date", "dcterms.created"];

/**
 * Pure: a page's HTML and URL in, citation fields out. `title` and
 * `publisher` are always present (the URL and hostname at worst — as before);
 * `kind` is always present; every other field only when the page states it.
 */
export function extractCitationMeta(html, pageUrl, now = new Date(), page = scanHtml(html)) {
  html = page.html;
  const u = new URL(pageUrl);
  const host = u.hostname.replace(/^www\./, "");
  const meta = collectMeta(page);
  const one = (...keys) => { for (const k of keys) { const v = meta.get(k)?.[0]; if (v) return v; } return ""; };
  const all = (...keys) => keys.flatMap((k) => meta.get(k) ?? []);
  const ld = collectJsonLd(page);
  const main = ld.find((it) => typesOf(it).some((t) => ARTICLE_T.test(t))) ?? ld.find((it) => typesOf(it).some((t) => /WebPage$/.test(t)));
  const ldName = (x) => (typeof x === "string" ? x : x?.name ? String(x.name) : "");
  const ldPublisher = clean(ldName(main?.publisher) || ldName(ld.find((it) => typesOf(it).includes("WebSite"))) || "");
  const isWiki = /(^|\.)wikipedia\.org$/.test(host);

  const rawTitle = clean((page.title ?? "").slice(0, 2000));
  let publisher = one("og:site_name") || one("citation_journal_title", "prism.publicationname") || ldPublisher || one("citation_publisher", "dc.publisher", "dcterms.publisher") || host;
  if (isWiki) publisher = "Wikipedia";
  // "Page | Section | CDC": og:site_name named the SECTION; the last segment is the site.
  const segs = rawTitle.split(/\s+\|\s+/);
  if (segs.length >= 3 && loose(segs.at(-2)) === loose(publisher)) publisher = segs.at(-1);

  const ogTitle = one("og:title", "twitter:title");
  const headline = clean(String(main?.headline ?? "").slice(0, 2000));
  const names = [publisher, one("og:site_name"), ldPublisher, hostLabel(host), host];
  const title = one("citation_title", "dc.title", "dcterms.title")
    || (headline && ogTitle && ogTitle !== headline && ogTitle.startsWith(headline) ? headline : "")
    || (ogTitle ? stripSiteSuffix(ogTitle, names) : "")
    || (rawTitle ? stripSiteSuffix(rawTitle, names) : "")
    || u.href;

  // Authors: scholarly tags first (already "Family, Given"), then JSON-LD, then bylines.
  const persons = [], orgs = [];
  const add = (raw, how = {}) => {
    for (const name of how.org ? [raw] : splitNames(raw, { commas: !how.scholarly })) {
      const r = personOrOrg(name, how);
      if (!r) continue;
      const list = r.person ? persons : orgs, v = r.person ?? r.org;
      if (v && !list.some((x) => loose(x) === loose(v))) list.push(v);
    }
  };
  // citation_author and dc.creator name people (Google Scholar's rule), so a
  // surname like Press or Bank is not read as an organisation there.
  const scholarly = all("citation_author", "dc.creator", "dcterms.creator");
  if (scholarly.length) scholarly.forEach((a) => add(a, { person: true, scholarly: true }));
  else if (main?.author && !isWiki) {
    for (const a of [].concat(main.author)) {
      const n = ldName(a);
      if (!n) continue;
      const t = typesOf(a);
      add(clean(n), { org: t.includes("Organization") || t.includes("NewsMediaOrganization"), person: t.includes("Person") });
    }
  }
  if (!persons.length && !orgs.length && !isWiki) all("article:author", "og:author", "author", "parsely-author", "byl", "sailthru.author").forEach((a) => add(a));

  // Dates. Never a modified stamp; never one the title contradicts.
  const modified = new Set([one("article:modified_time"), one("og:updated_time"), clean(String(main?.dateModified ?? ""))]
    .map((s) => isoOf(parseDate(s, now)) ?? "").filter(Boolean));
  const firstTime = page.times.filter((t) => t.trusted).slice(0, 1).map((t) => t.value);
  const candidates = [
    ...all(...EXPLICIT_DATE_KEYS).map((v) => [v, true]),
    ...all(...GENERIC_DATE_KEYS).map((v) => [v, false]),
    [clean(String(main?.datePublished ?? "")), true],
    ...all(...LATE_GENERIC_DATE_KEYS).map((v) => [v, false]),
    ...firstTime.map((v) => [v, false]),
  ].filter(([v]) => v);
  let pub = null;
  for (const [value, explicit] of candidates) {
    const d = parseDate(value, now);
    if (!d || contradictsTitle(d.year, title, now)) continue;
    if (!explicit && modified.has(isoOf(d))) continue;
    pub = d;
    break;
  }
  if (!pub) {
    // A visible label: "Year of Publication 2024", "Published: May 7, 2024".
    const text = decodeEntities(page.text).replace(/\s+/g, " ");
    const m = text.match(/\b(?:year of publication|publication year|publication date|date published|published(?: on)?)\s*:?\s*((?:[A-Z][a-z]+\.? \d{1,2}, \d{4})|(?:\d{1,2} [A-Z][a-z]+\.? \d{4})|(?:\d{4}(?:-\d{2}-\d{2})?))/i);
    const d = m && parseDate(m[1], now);
    if (d && !contradictsTitle(d.year, title, now)) pub = d;
  }

  let kind = "other";
  if (one("citation_journal_title", "prism.publicationname") && (one("citation_volume", "prism.volume") || one("citation_doi", "prism.doi"))) kind = "journal";
  else if (isWiki || /(^|\.)britannica\.com$/.test(host)) kind = "reference";
  else if (ld.some((it) => typesOf(it).some((t) => NEWS_T.test(t))) || typesOf(main?.publisher).some((t) => NEWS_T.test(t))) kind = "news";
  else if (typesOf(main).includes("Report")) kind = "report";
  else if (typesOf(main).includes("Book") || one("og:type") === "book") kind = "book";
  else if (orgs.length || /\.(gov|int|edu|mil)$|\.gov\.[a-z]{2}$|\.org$/.test(host)) kind = "institutional";

  const out = { title: title.slice(0, 200), publisher: publisher.slice(0, 100), kind };
  if (persons.length) out.authors = capAuthors(persons);
  else if (orgs.length) out.groupAuthor = orgs[0].slice(0, 150);
  if (pub) {
    out.year = pub.year;
    const iso = isoOf(pub);
    if (iso) out.date = iso;
  }
  if (kind === "journal") {
    const doi = (one("citation_doi", "prism.doi", "dc.identifier").match(/10\.\d{4,9}\/\S+/) ?? [])[0];
    if (doi) out.doi = doi;
    const vol = one("citation_volume", "prism.volume"), iss = one("citation_issue", "prism.number");
    const fp = one("citation_firstpage", "prism.startingpage"), lp = one("citation_lastpage", "prism.endingpage");
    out.container = one("citation_journal_title", "prism.publicationname").slice(0, 200);
    if (vol) out.volume = vol.slice(0, 20);
    if (iss) out.issue = iss.slice(0, 20);
    if (fp) out.pages = (lp && lp !== fp ? `${fp}–${lp}` : fp).slice(0, 40);
  }
  if (isWiki) {
    // The revision the student read: APA cites Wikipedia by permalink and revision date.
    const rev = html.match(/"wgRevisionId":(\d+)/)?.[1];
    const pageName = html.match(/"wgPageName":"([^"]+)"/)?.[1];
    const d = parseDate(main?.dateModified, now);
    if (rev && pageName && d?.day) {
      out.permalink = `https://${u.hostname}/w/index.php?title=${encodeURIComponent(pageName)}&oldid=${rev}`;
      out.year = d.year;
      out.date = isoOf(d);
    } else {
      delete out.year;
      delete out.date;
    }
  }
  return out;
}

// ── the route's fetch ──────────────────────────────────────────────────

const PRIVATE_HOST = /^(localhost$|.*\.local$|127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\]$|172\.(1[6-9]|2\d|3[01])\.)/i;

function descriptionOf(page) {
  const meta = collectMeta(page);
  return meta.get("description")?.[0] || meta.get("og:description")?.[0] || "";
}

/** The body's first `maxBytes` bytes as UTF-8 text (what res.text() decodes
 *  as), then the stream is cancelled: a page that never ends, or a 2 GB file
 *  behind an HTML content type, is never held in memory whole. */
async function readCapped(res, maxBytes) {
  if (!res.body?.getReader) return (await res.text()).slice(0, MAX_HTML_CHARS);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(size, maxBytes));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.length - at);
    buf.set(c.subarray(0, take), at);
    at += take;
    if (at >= buf.length) break;
  }
  return new TextDecoder().decode(buf).slice(0, MAX_HTML_CHARS);
}

/**
 * /api/cite-url's source: { title, url, publisher, snippet, stance: "manual" }
 * as always, plus the optional fields extractCitationMeta found. Throws a
 * CheckError (serialised verbatim to the client) for a bad URL, a missing
 * page, a bot wall or any other HTTP error — none of those is a citation.
 */
export async function fetchUrlMetadata(raw, { now = new Date() } = {}) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new CheckError("bad_request", "That doesn't look like a URL");
  }
  if (!/^https?:$/.test(u.protocol)) throw new CheckError("bad_request", "Only http(s) URLs can be cited");
  if (PRIVATE_HOST.test(u.hostname)) throw new CheckError("bad_request", "Local and private addresses can't be cited");

  let res;
  try {
    res = await fetch(u, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Tracely/1.0; local fact-checker)" },
    });
  } catch (e) {
    throw new CheckError("server", `Couldn't fetch that URL: ${e?.cause?.message ?? e?.message ?? e}`, { status: 502 });
  }
  if (res.status === 404 || res.status === 410) {
    throw new CheckError("bad_request", `That page returns ${res.status} — it doesn't seem to exist`);
  }
  let html = "";
  try {
    html = await readCapped(res, MAX_HTML_CHARS * 2);
  } catch { /* binary or unreadable body — fall through to URL-derived metadata */ }
  // A PDF or an image has no <title> or <meta> to read, only bytes that can
  // look like tags.
  const type = String(res.headers?.get?.("content-type") ?? "");
  if (type && !/html|xml/i.test(type)) html = "";

  const page = scanHtml(html);
  const rawTitle = clean((page.title ?? "").slice(0, 2000));
  if (looksBlocked(res.status, html, rawTitle)) {
    const why = BLOCK_STATUS.has(res.status) ? `HTTP ${res.status}` : "it answered with a bot check";
    throw new CheckError("server", `That site won't let Tracely read the page (${why}), so there is nothing reliable to cite from it — copy the details by hand, or pick another source.`, { status: 502 });
  }
  if (res.status >= 400) {
    throw new CheckError("server", `That page returns ${res.status} — Tracely couldn't read it. Try again later, or copy the details by hand.`, { status: 502 });
  }

  const { title, publisher, ...optional } = extractCitationMeta(html, u.href, now, page);
  return {
    title: title.trim().slice(0, 200),
    url: u.href.slice(0, 600),
    publisher: publisher.trim().slice(0, 100),
    snippet: descriptionOf(page).slice(0, 300),
    stance: "manual",
    ...optional,
  };
}
