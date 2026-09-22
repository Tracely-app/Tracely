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
 *     article:* > JSON-LD > the first <time> > a visible "Published:" label;
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
const NAMED = { quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", amp: "&" };

/** Numeric (decimal and hex) and the common named entities. `&amp;` last, so
 *  "&amp;#39;" stays the literal text "&#39;" the page meant. */
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => safeChar(Number(d)))
    .replace(/&(quot|apos|lt|gt|nbsp|ndash|mdash|rsquo|lsquo|ldquo|rdquo|hellip);/g, (_, n) => NAMED[n])
    .replace(/&amp;/g, "&");
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

/** An organisation's name, not a person's: an acronym ("CDC", "IOM") or a
 *  name carrying an institutional word ("Pew Research Center"). */
export function looksLikeOrg(s) {
  const t = String(s ?? "").trim();
  return /^[A-Z][A-Z&.]{1,7}$/.test(t) || ORG_WORDS.test(t);
}

function personOrOrg(raw) {
  const s = clean(String(raw ?? "")).replace(/^by\s+/i, "");
  if (!s || s.length > 120 || PLACEHOLDER_NAME.test(s) || /^(https?:|www\.|@)|@|\.(com|org|net)\b/i.test(s)) return null;
  if (looksLikeOrg(s)) return { org: s };
  if (s.split(/\s+/).length > 6) return null; // a sentence, not a name
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

function tagAttrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  return out;
}

/** Every <meta>, keyed by lowercased name/property/itemprop, values in page order. */
function collectMeta(html) {
  const map = new Map();
  for (const t of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const a = tagAttrs(t);
    const key = (a.name || a.property || a.itemprop || "").toLowerCase();
    if (!key || a.content == null) continue;
    const v = clean(a.content.slice(0, 2000));
    if (!v) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  }
  return map;
}

function collectJsonLd(html) {
  const items = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x["@graph"])) walk(x["@graph"]);
    if (x["@type"]) items.push(x);
  };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* a malformed block: ignore it */ }
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
export function extractCitationMeta(html, pageUrl, now = new Date()) {
  html = String(html ?? "");
  const u = new URL(pageUrl);
  const host = u.hostname.replace(/^www\./, "");
  const meta = collectMeta(html);
  const one = (...keys) => { for (const k of keys) { const v = meta.get(k)?.[0]; if (v) return v; } return ""; };
  const all = (...keys) => keys.flatMap((k) => meta.get(k) ?? []);
  const ld = collectJsonLd(html);
  const main = ld.find((it) => typesOf(it).some((t) => ARTICLE_T.test(t))) ?? ld.find((it) => typesOf(it).some((t) => /WebPage$/.test(t)));
  const ldName = (x) => (typeof x === "string" ? x : x?.name ? String(x.name) : "");
  const ldPublisher = clean(ldName(main?.publisher) || ldName(ld.find((it) => typesOf(it).includes("WebSite"))) || "");
  const isWiki = /(^|\.)wikipedia\.org$/.test(host);

  const rawTitle = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 2000));
  let publisher = one("og:site_name") || one("citation_journal_title", "prism.publicationname") || ldPublisher || one("citation_publisher", "dc.publisher", "dcterms.publisher") || host;
  if (isWiki) publisher = "Wikipedia";
  // "Page | Section | CDC": og:site_name named the SECTION; the last segment is the site.
  const segs = rawTitle.split(/\s+\|\s+/);
  if (segs.length >= 3 && loose(segs.at(-2)) === loose(publisher)) publisher = segs.at(-1);

  const ogTitle = one("og:title", "twitter:title");
  const headline = clean(String(main?.headline ?? ""));
  const names = [publisher, one("og:site_name"), ldPublisher, hostLabel(host), host];
  const title = one("citation_title", "dc.title", "dcterms.title")
    || (headline && ogTitle && ogTitle !== headline && ogTitle.startsWith(headline) ? headline : "")
    || (ogTitle ? stripSiteSuffix(ogTitle, names) : "")
    || (rawTitle ? stripSiteSuffix(rawTitle, names) : "")
    || u.href;

  // Authors: scholarly tags first (already "Family, Given"), then JSON-LD, then bylines.
  const persons = [], orgs = [];
  const add = (raw, forcedOrg) => {
    const r = forcedOrg ? { org: clean(raw) } : personOrOrg(raw);
    if (!r) return;
    const list = r.person ? persons : orgs, v = r.person ?? r.org;
    if (v && !list.some((x) => loose(x) === loose(v))) list.push(v);
  };
  const scholarly = all("citation_author", "dc.creator", "dcterms.creator");
  if (scholarly.length) scholarly.forEach((a) => add(a));
  else if (main?.author && !isWiki) {
    for (const a of [].concat(main.author)) {
      const n = ldName(a);
      if (!n) continue;
      add(n, typesOf(a).includes("Organization") || typesOf(a).includes("NewsMediaOrganization"));
    }
  }
  if (!persons.length && !orgs.length && !isWiki) all("article:author", "og:author", "author", "parsely-author", "byl", "sailthru.author").forEach((a) => add(a));

  // Dates. Never a modified stamp; never one the title contradicts.
  const modified = new Set([one("article:modified_time"), one("og:updated_time"), clean(String(main?.dateModified ?? ""))]
    .map((s) => isoOf(parseDate(s, now)) ?? "").filter(Boolean));
  const firstTime = [...html.matchAll(/<time[^>]*\bdatetime=["']([^"']+)["']/gi)].slice(0, 1).map((m) => m[1]);
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
    const text = decodeEntities(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    const m = text.match(/\b(?:year of publication|publication year|publication date|date published|published(?: on)?)\s*:?\s*((?:[A-Z][a-z]+\.? \d{1,2}, \d{4})|(?:\d{1,2} [A-Z][a-z]+\.? \d{4})|(?:\d{4}(?:-\d{2}-\d{2})?))/i);
    const d = m && parseDate(m[1], now);
    if (d && !contradictsTitle(d.year, title, now)) pub = d;
  }

  let kind = "other";
  if (one("citation_journal_title", "prism.publicationname") && (one("citation_volume", "prism.volume") || one("citation_doi", "prism.doi"))) kind = "journal";
  else if (isWiki || /(^|\.)britannica\.com$/.test(host)) kind = "reference";
  else if (ld.some((it) => typesOf(it).some((t) => NEWS_T.test(t))) || typesOf(main?.publisher).some((t) => NEWS_T.test(t))) kind = "news";
  else if (typesOf(main).includes("Book") || one("og:type") === "book") kind = "book";
  else if (orgs.length || /\.(gov|int|edu|mil)$|\.gov\.[a-z]{2}$|\.org$/.test(host)) kind = "institutional";

  const out = { title: title.slice(0, 200), publisher: publisher.slice(0, 100), kind };
  if (persons.length) out.authors = persons.slice(0, 30);
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
    const page = html.match(/"wgPageName":"([^"]+)"/)?.[1];
    const d = parseDate(main?.dateModified, now);
    if (rev && page && d?.day) {
      out.permalink = `https://${u.hostname}/w/index.php?title=${encodeURIComponent(page)}&oldid=${rev}`;
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

function descriptionOf(html) {
  const meta = collectMeta(html);
  return meta.get("description")?.[0] || meta.get("og:description")?.[0] || "";
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
    html = (await res.text()).slice(0, 500_000);
  } catch { /* binary or unreadable body — fall through to URL-derived metadata */ }
  // A PDF or an image has no <title> or <meta> to read, only bytes that can
  // look like tags.
  const type = String(res.headers?.get?.("content-type") ?? "");
  if (type && !/html|xml/i.test(type)) html = "";

  const rawTitle = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 2000));
  if (looksBlocked(res.status, html, rawTitle)) {
    const why = BLOCK_STATUS.has(res.status) ? `HTTP ${res.status}` : "it answered with a bot check";
    throw new CheckError("server", `That site won't let Tracely read the page (${why}), so there is nothing reliable to cite from it — copy the details by hand, or pick another source.`, { status: 502 });
  }
  if (res.status >= 400) {
    throw new CheckError("server", `That page returns ${res.status} — Tracely couldn't read it. Try again later, or copy the details by hand.`, { status: 502 });
  }

  const { title, publisher, ...optional } = extractCitationMeta(html, u.href, now);
  return {
    title: title.trim().slice(0, 200),
    url: u.href.slice(0, 600),
    publisher: publisher.trim().slice(0, 100),
    snippet: descriptionOf(html).slice(0, 300),
    stance: "manual",
    ...optional,
  };
}
