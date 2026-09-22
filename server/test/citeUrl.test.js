/**
 * /api/cite-url's page reading (lib/citeMeta.js), against saved real pages.
 *
 * The fixtures in fixtures/cite-url/ are trimmed copies of public pages
 * fetched 2026-09-21 — <title>, the citation-relevant <meta> tags, JSON-LD
 * (contact fields removed), the first <time> and, where a test needs it, the
 * one visible element it reads. Trimming was checked to leave
 * extractCitationMeta's answer on each page unchanged.
 *
 * What these pin, from a tester's reference list: a 403 "Access Denied" page
 * was cited by its title; IOM's World Migration Report 2024 was "(n.d.)",
 * with the hostname as author; numeric entities reached the document raw.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  contradictsTitle,
  decodeEntities,
  extractCitationMeta,
  fetchUrlMetadata,
  looksBlocked,
  MAX_HTML_CHARS,
  parseDate,
  scanHtml,
} from "../lib/citeMeta.js";

const NOW = new Date("2026-09-21T12:00:00Z");
const page = (name) => readFileSync(new URL(`./fixtures/cite-url/${name}`, import.meta.url), "utf8");
const URLS = {
  iom: "https://publications.iom.int/books/world-migration-report-2024-chapter-2",
  nature: "https://www.nature.com/articles/s41586-020-2649-2",
  cdc: "https://www.cdc.gov/physical-activity-basics/benefits/index.html",
  npr: "https://www.npr.org/2020/04/07/828918397/how-to-compost-at-home",
  pew: "https://www.pewresearch.org/internet/2026/04/15/teens-experiences-on-tiktok-instagram-and-snapchat/",
  wiki: "https://en.wikipedia.org/wiki/Great_Wall_of_China",
};

/* fetchUrlMetadata calls the global fetch; each test answers it with a real
 * Response so status, headers and body behave as they do live. */
const realFetch = globalThis.fetch;
function serve(body, { status = 200, type = "text/html; charset=utf-8" } = {}) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(body, { status, headers: type ? { "Content-Type": type } : {} });
  };
  return seen;
}
test.afterEach(() => { globalThis.fetch = realFetch; });
const failure = (p) => p.then(() => null, (e) => ({ kind: e.kind, status: e.status, message: e.message }));

// ── entities and dates ─────────────────────────────────────────────────

test("decodeEntities decodes hex, decimal and named entities, &amp; last", () => {
  assert.equal(decodeEntities("Teens&#x2019; lives &#8212; a &quot;study&quot; &amp; more"), "Teens’ lives — a \"study\" & more");
  assert.equal(decodeEntities("http&#58;&#47;&#47;x&#46;org"), "http://x.org");
  assert.equal(decodeEntities("&amp;#39; stays literal"), "&#39; stays literal", "a double-escaped entity is the text the page meant");
  assert.equal(decodeEntities("bad&#xD800;&#0;&#x110000;end"), "badend", "surrogates, NUL and out-of-range code points are dropped");
});

test("parseDate keeps the calendar day the page wrote, in every format seen live", () => {
  // BBC's datePublished is 23:13 UTC; through new Date() in a US timezone it
  // would become the 20th's evening or the 21st depending on the server.
  assert.deepEqual(parseDate("2026-09-20T23:13:42.924Z", NOW), { year: 2026, month: 9, day: 20 });
  assert.deepEqual(parseDate("2020-04-09T00:03:28-04:00", NOW), { year: 2020, month: 4, day: 9 });
  assert.deepEqual(parseDate("2025-12-04 05:00:00", NOW), { year: 2025, month: 12, day: 4 });
  assert.deepEqual(parseDate("Thu, 05/21/2020 - 20:41", NOW), { year: 2020, month: 5, day: 21 }, "Drupal's citation_publication_date");
  assert.deepEqual(parseDate("21/05/2020", NOW), { year: 2020, month: 5, day: 21 }, "day-first when month-first is impossible");
  assert.deepEqual(parseDate("May 7, 2024", NOW), { year: 2024, month: 5, day: 7 });
  assert.deepEqual(parseDate("Sept. 4, 2025", NOW), { year: 2025, month: 9, day: 4 });
  assert.deepEqual(parseDate("7 May 2024", NOW), { year: 2024, month: 5, day: 7 });
  assert.deepEqual(parseDate("2024", NOW), { year: 2024, month: null, day: null });
  assert.deepEqual(parseDate("2024-03", NOW), { year: 2024, month: 3, day: null });
});

test("parseDate refuses what is not a real, past date", () => {
  assert.equal(parseDate("2023-02-29", NOW), null, "no 29 February in 2023");
  assert.equal(parseDate("2024-13-01", NOW), null);
  assert.equal(parseDate("1499-01-01", NOW), null);
  assert.equal(parseDate("2026-10-01", NOW), null, "the future");
  assert.equal(parseDate("2027", NOW), null);
  assert.deepEqual(parseDate("2026-09-22", NOW), { year: 2026, month: 9, day: 22 }, "tomorrow somewhere east is fine");
  assert.equal(parseDate("P17M,58S", NOW), null, "an audio duration in a <time>");
  assert.equal(parseDate("", NOW), null);
});

test("contradictsTitle: a past year the title is about, never a future target", () => {
  assert.equal(contradictsTitle(2020, "World Migration Report 2024: Chapter 2", NOW), true);
  assert.equal(contradictsTitle(2023, "World Migration Report 2024", NOW), false, "published the year before is normal");
  assert.equal(contradictsTitle(2021, "Saudi Vision 2030", NOW), false);
  assert.equal(contradictsTitle(2019, "No year here", NOW), false);
});

// ── the bot wall ───────────────────────────────────────────────────────

test("looksBlocked: auth and rate-limit statuses, challenge titles, Cloudflare's challenge page", () => {
  for (const s of [401, 403, 429, 503]) assert.equal(looksBlocked(s, "<html></html>", "Some Title"), true, `HTTP ${s}`);
  for (const t of ["Access Denied", "Client Challenge", "Just a moment...", "Attention Required! | Cloudflare", "Pardon Our Interruption", "Verifying you are human", "403 Forbidden"]) {
    assert.equal(looksBlocked(200, "", t), true, t);
  }
  assert.equal(looksBlocked(200, '<script>window._cf_chl_opt={cvId:"3"}</script>', ""), true);
});

test("looksBlocked does not fire on real pages that merely resemble a block", () => {
  assert.equal(looksBlocked(200, "", "Forbidden Planet - Wikipedia"), false, "the whole title must be the block's");
  assert.equal(looksBlocked(200, "", "Access Denied: How Paywalls Shape Science | Nature"), false);
  // Cloudflare injects this into ordinary pages behind Bot Fight Mode.
  const jsd = `<title>A normal page</title><script>a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script>`;
  assert.equal(looksBlocked(200, jsd, "A normal page"), false);
});

// ── extraction, page by page ───────────────────────────────────────────

test("IOM: the year printed on the page, not the CMS date its citation tag carries", () => {
  // citation_publication_date is "Thu, 05/21/2020 - 20:41" on a report titled
  // 2024; the page's visible "Year of Publication" says 2024.
  const m = extractCitationMeta(page("iom-wmr2024-ch2.html"), URLS.iom, NOW);
  assert.deepEqual(m, {
    title: "World Migration Report 2024: Chapter 2 – Migration and migrants: A global overview",
    publisher: "publications.iom.int",
    kind: "institutional",
    year: 2024,
  });
});

test("a journal article: citation_* authors in order, DOI, container, volume, issue, pages", () => {
  const m = extractCitationMeta(page("nature-numpy.html"), URLS.nature, NOW);
  assert.equal(m.kind, "journal");
  assert.equal(m.title, "Array programming with NumPy");
  assert.equal(m.publisher, "Nature");
  assert.equal(m.authors.length, 26);
  assert.deepEqual(m.authors.slice(0, 3), ["Harris, Charles R.", "Millman, K. Jarrod", "van der Walt, Stéfan J."]);
  assert.equal(m.authors.at(-1), "Oliphant, Travis E.");
  assert.equal(m.groupAuthor, undefined, "people, so no group author");
  assert.equal(m.year, 2020);
  assert.equal(m.doi, "10.1038/s41586-020-2649-2");
  assert.equal(m.container, "Nature");
  assert.deepEqual([m.volume, m.issue, m.pages], ["585", "7825", "357–362"]);
});

test("CDC: the organisation as group author, the site not the section, the published date not DC.date", () => {
  // og:site_name is the SECTION ("Physical Activity Basics"); DC.date equals
  // og:updated_time, i.e. it is the modified stamp.
  const m = extractCitationMeta(page("cdc-physical-activity.html"), URLS.cdc, NOW);
  assert.deepEqual(m, { title: "Benefits of Physical Activity", publisher: "CDC", kind: "institutional", groupAuthor: "CDC", year: 2025, date: "2025-12-04" });
});

test("NPR: the byline from JSON-LD, the published date, never the 2024 update", () => {
  const m = extractCitationMeta(page("npr-compost.html"), URLS.npr, NOW);
  assert.deepEqual(m, {
    title: "Composting can help fight climate change. Get started in 5 easy steps",
    publisher: "NPR",
    kind: "news",
    authors: ["Julia Simon"],
    year: 2020,
    date: "2020-04-09",
  });
});

test("Pew: several people from article:author, the explicit published time", () => {
  const m = extractCitationMeta(page("pew-teens.html"), URLS.pew, NOW);
  assert.deepEqual(m.authors, ["Michelle Faverio", "Eugenie Park", "Jeffrey Gottfried"]);
  assert.equal(m.publisher, "Pew Research Center");
  assert.equal(m.title, "Teens’ Experiences on TikTok, Instagram and Snapchat");
  assert.equal(m.date, "2026-04-15");
  assert.equal(m.kind, "institutional");
});

test("Wikipedia: no author, the revision read as a permalink and its date", () => {
  const m = extractCitationMeta(page("wikipedia-great-wall.html"), URLS.wiki, NOW);
  assert.deepEqual(m, {
    title: "Great Wall of China",
    publisher: "Wikipedia",
    kind: "reference",
    year: 2026,
    date: "2026-09-12",
    permalink: "https://en.wikipedia.org/w/index.php?title=Great_Wall_of_China&oldid=1374512030",
  });
});

test("an explicit published date is kept when it equals the modified date", () => {
  const html = `<title>Story</title><meta property="article:published_time" content="2024-05-01T10:00:00Z"><meta property="article:modified_time" content="2024-05-01T10:00:00Z">`;
  assert.equal(extractCitationMeta(html, "https://example.com/story", NOW).date, "2024-05-01");
  const generic = `<title>Story</title><meta name="date" content="2024-05-01"><meta property="article:modified_time" content="2024-05-01T10:00:00Z">`;
  assert.equal(extractCitationMeta(generic, "https://example.com/story", NOW).date, undefined, "a generic date equal to the modified stamp is the modified stamp");
});

test("bylines that are not people: placeholders, handles and hostnames are dropped", () => {
  for (const by of ["Staff", "admin", "@someone", "example.com", "https://example.com/about"]) {
    const m = extractCitationMeta(`<title>T</title><meta name="author" content="${by}">`, "https://example.com/a", NOW);
    assert.equal(m.authors, undefined, by);
    assert.equal(m.groupAuthor, undefined, by);
  }
  const org = extractCitationMeta(`<title>T</title><meta name="author" content="World Health Organization">`, "https://example.com/a", NOW);
  assert.equal(org.groupAuthor, "World Health Organization");
});

// ── the route's function ───────────────────────────────────────────────

test("fetchUrlMetadata: the IOM page cites with its year, old fields first and unchanged in kind", async () => {
  const seen = serve(page("iom-wmr2024-ch2.html"));
  const src = await fetchUrlMetadata(URLS.iom, { now: NOW });
  assert.deepEqual(Object.keys(src).slice(0, 5), ["title", "url", "publisher", "snippet", "stance"], "the five fields every client reads");
  assert.equal(src.title, "World Migration Report 2024: Chapter 2 – Migration and migrants: A global overview");
  assert.equal(src.url, URLS.iom);
  assert.equal(src.publisher, "publications.iom.int");
  assert.match(src.snippet, /^This chapter provides an overview of global data/);
  assert.ok(src.snippet.length <= 300);
  assert.equal(src.stance, "manual");
  assert.equal(src.year, 2024);
  assert.equal(src.kind, "institutional");
  assert.equal(src.date, undefined);
  assert.equal(seen[0].init.redirect, "follow");
});

test("fetchUrlMetadata refuses a 403 Access Denied page instead of citing it", async () => {
  serve(page("akamai-access-denied.html"), { status: 403 });
  const e = await failure(fetchUrlMetadata(URLS.iom, { now: NOW }));
  assert.equal(e.kind, "server");
  assert.equal(e.status, 502);
  assert.match(e.message, /won't let Tracely read the page \(HTTP 403\)/);
  assert.doesNotMatch(e.message, /Access Denied/);
});

test("fetchUrlMetadata refuses a challenge page served as 200", async () => {
  for (const title of ["Access Denied", "Client Challenge", "Just a moment..."]) {
    serve(`<html><head><title>${title}</title></head><body>checking your browser</body></html>`);
    const e = await failure(fetchUrlMetadata("https://example.com/report", { now: NOW }));
    assert.equal(e?.kind, "server", title);
    assert.match(e.message, /bot check/, title);
  }
  for (const status of [401, 429, 503]) {
    serve("<title>Welcome</title>", { status });
    assert.match((await failure(fetchUrlMetadata("https://example.com/r", { now: NOW }))).message, new RegExp(`HTTP ${status}`));
  }
});

test("fetchUrlMetadata: 404/410 keep their message; any other HTTP error is not a citation", async () => {
  serve("<title>Not Found</title>", { status: 404 });
  assert.deepEqual(await failure(fetchUrlMetadata("https://example.com/gone", { now: NOW })),
    { kind: "bad_request", status: 400, message: "That page returns 404 — it doesn't seem to exist" });
  serve("<title>Internal Server Error</title>", { status: 500 });
  const e = await failure(fetchUrlMetadata("https://example.com/broken", { now: NOW }));
  assert.equal(e.kind, "server");
  assert.match(e.message, /returns 500/);
});

test("fetchUrlMetadata: bad and private URLs are refused before any fetch, as before", async () => {
  const seen = serve("<title>x</title>");
  assert.deepEqual(await failure(fetchUrlMetadata("not a url")), { kind: "bad_request", status: 400, message: "That doesn't look like a URL" });
  assert.deepEqual(await failure(fetchUrlMetadata("ftp://example.com/x")), { kind: "bad_request", status: 400, message: "Only http(s) URLs can be cited" });
  assert.deepEqual(await failure(fetchUrlMetadata("http://192.168.1.4/admin")), { kind: "bad_request", status: 400, message: "Local and private addresses can't be cited" });
  assert.equal(seen.length, 0);
});

test("fetchUrlMetadata: a page with only the old tags answers exactly the old fields, entities decoded", async () => {
  serve(`<html><head><title>ignored</title><meta property="og:title" content="Teens&#x2019; sleep &#8212; a review"><meta property="og:site_name" content="Sleep Journal"><meta name="description" content="What we know &amp; don&#39;t."></head></html>`);
  const src = await fetchUrlMetadata("https://sleep.example.com/review", { now: NOW });
  assert.deepEqual(src, {
    title: "Teens’ sleep — a review",
    url: "https://sleep.example.com/review",
    publisher: "Sleep Journal",
    snippet: "What we know & don't.",
    stance: "manual",
    kind: "other",
  });
});

test("fetchUrlMetadata: a PDF is cited by its URL and host, never by its bytes", async () => {
  serve("%PDF-1.7 <title>garbage</title> <meta name=\"citation_author\" content=\"Nobody\">", { type: "application/pdf" });
  const src = await fetchUrlMetadata("https://www.who.int/docs/report.pdf", { now: NOW });
  assert.equal(src.title, "https://www.who.int/docs/report.pdf");
  assert.equal(src.publisher, "who.int");
  assert.equal(src.authors, undefined);
});

// ── hostile pages ──────────────────────────────────────────────────────

/* The regexes the scanner replaced restarted at every "<" and ran to the end
 * of the page when nothing closed: 40 KB of "<" took over a second, so the
 * 500 KB a fetch reads would have held the server's one thread for minutes.
 * Every page here is the full read size. The bound is generous for a slow CI
 * box; the scanner takes a few milliseconds on each. */
test("hostile markup is read in linear time, never quadratic", () => {
  const N = MAX_HTML_CHARS;
  const fill = (unit) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const pages = {
    "unclosed <": fill("<"),
    "< then one > at the end": fill("< ") + ">",
    "<a <a ... >": fill("<a ") + ">",
    "closed tags": fill("<a>"),
    "unclosed <meta": fill("<meta "),
    "closed metas": fill('<meta name="author" content="Jane Doe">'),
    "attribute soup in one tag": "<meta " + fill('a="b=') + ">",
    "one huge attribute": '<meta name="author" content="' + fill("x") + '">',
    "unclosed <time": fill("<time "),
    "closed times": fill('<time datetime="2020-01-01">'),
    "unclosed <script": fill("<script "),
    "unclosed <title": fill("<title>"),
    "unclosed comments": fill("<!-- "),
    "many JSON-LD blocks": fill('<script type="application/ld+json">{"@type":"Article","author":{"name":"A B"}}</script>'),
    "JSON-LD nested past the stack": '<script type="application/ld+json">' + "[".repeat(N / 2) + "</script>",
    "published, over and over": fill("published "),
    "entities": fill("&amp;&#x41;&#65;&eacute;"),
  };
  for (const [name, html] of Object.entries(pages)) {
    const t0 = performance.now();
    const m = extractCitationMeta(html, "https://example.org/x", NOW);
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${name}: ${Math.round(ms)} ms`);
    assert.equal(typeof m.title, "string", name);
    assert.equal(m.publisher, "example.org", name);
  }
});

test("only the first MAX_HTML_CHARS of a page are read", () => {
  const late = `<title>T</title>${" ".repeat(MAX_HTML_CHARS)}<meta name="citation_author" content="Doe, Jane">`;
  assert.equal(extractCitationMeta(late, "https://example.org/x", NOW).authors, undefined);
  const early = `<title>T</title><meta name="citation_author" content="Doe, Jane">${" ".repeat(MAX_HTML_CHARS)}`;
  assert.deepEqual(extractCitationMeta(early, "https://example.org/x", NOW).authors, ["Doe, Jane"]);
});

test("scanHtml: markup inside comments and scripts is not markup; 'a < b' is text", () => {
  const page = scanHtml(`<!-- <meta name="author" content="Ghost"> --><title>Real &amp; true</title>
    <script>var s = "<meta name='author' content='Script'>"; var t = "<title>no</title>";</script>
    <META NAME="Author" CONTENT="Jane Doe"><meta content=unquoted name=keywords>
    <p>3 < 4 and published: May 7, 2024</p><time datetime="2024-05-07">May 7</time>`);
  assert.equal(page.title, "Real &amp; true");
  assert.deepEqual(page.metas.map((a) => [a.name, a.content]), [["Author", "Jane Doe"], ["keywords", "unquoted"]]);
  assert.deepEqual(page.times, ["2024-05-07"]);
  assert.match(page.text.replace(/\s+/g, " "), /3 < 4 and published: May 7, 2024/);
  assert.doesNotMatch(page.text, /var s/);
});

test("fetchUrlMetadata reads a bounded prefix of the body, even one that never ends", async () => {
  let pulled = 0;
  const endless = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('<title>Endless</title><meta name="citation_author" content="Doe, Jane">')); },
    pull(c) { pulled++; c.enqueue(new TextEncoder().encode("x".repeat(64 * 1024))); },
  });
  globalThis.fetch = async () => new Response(endless, { status: 200, headers: { "Content-Type": "text/html" } });
  const t0 = performance.now();
  const src = await fetchUrlMetadata("https://example.org/endless", { now: NOW });
  assert.ok(performance.now() - t0 < 3000);
  assert.equal(src.title, "Endless");
  assert.deepEqual(src.authors, ["Doe, Jane"]);
  assert.ok(pulled * 64 * 1024 <= MAX_HTML_CHARS * 2 + 3 * 64 * 1024, `read ${pulled} chunks`);
});
