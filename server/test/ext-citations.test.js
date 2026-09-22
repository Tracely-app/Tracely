/**
 * Three extension fixes reported together by one tester, pinned against the
 * real content.js (no build step, no runner of its own — slices of the source
 * run in a vm context, the way extension-beta.test.js drives it):
 *
 *   - a Doc opened at /document/u/<n>/d/<id>/ must be exported through the
 *     same account slot, or the default account answers for it;
 *   - a tab whose content script was orphaned by an extension reload must say
 *     so instead of showing a stale issue count;
 *   - citations. The old formatter hard-coded "(n.d.)" and a retrieval date,
 *     and put the publisher — or a bare hostname — in the author slot, so the
 *     tester's IOM World Migration Report chapter came out as
 *     "International Organization for Migration. (n.d.). ... Retrieved <today>".
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Same lookup as models.test.js: beside this tree in the app repo, one level
// further up otherwise. Not finding it is a failure, never a skip.
const EXT = [path.join(HERE, "..", "extension"), path.join(HERE, "..", "..", "extension")]
  .find((dir) => existsSync(path.join(dir, "background.js")));
const read = (f) => {
  assert.ok(EXT, "could not locate extension/ from " + HERE);
  return readFileSync(path.join(EXT, f), "utf8");
};
const plain = (v) => JSON.parse(JSON.stringify(v)); // strip the vm realm's prototypes

function contentSlice(from, to) {
  const src = read("content.js");
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `content.js: could not find ${from} .. ${to}`);
  return src.slice(a, b);
}

/* ── the Docs export keeps the signed-in account slot ──────────────────── */

function loadExportHelpers() {
  const code = contentSlice("function docAccountPrefix(", "// Bibliography block")
    + ";({ docAccountPrefix, docExportUrl })";
  return vm.runInContext(code, vm.createContext({ URL }));
}

test("the account prefix is read off /document/u/<n>/d/ URLs", () => {
  const { docAccountPrefix } = loadExportHelpers();
  const ID = "1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo";
  assert.equal(docAccountPrefix(`https://docs.google.com/document/u/1/d/${ID}/edit`), "/u/1");
  assert.equal(docAccountPrefix(`https://docs.google.com/document/u/12/d/${ID}/edit?tab=t.0#h`), "/u/12");
  assert.equal(docAccountPrefix(`/document/u/0/d/${ID}/edit`), "/u/0");
  assert.equal(docAccountPrefix(`https://docs.google.com/document/d/${ID}/edit`), "");
  assert.equal(docAccountPrefix("/document/u/0/"), "", "the docs list page names an account but no doc");
  assert.equal(docAccountPrefix(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit`), "");
  assert.equal(docAccountPrefix(undefined, "", null), "");
  assert.equal(docAccountPrefix("http://[bad"), "", "an unparseable URL is skipped, never thrown");
});

test("the committed navigation URL wins, location.pathname is the fallback", () => {
  const { docAccountPrefix } = loadExportHelpers();
  const ID = "abc123";
  // No Navigation Timing entry: the address bar decides.
  assert.equal(docAccountPrefix(undefined, `/document/u/2/d/${ID}/edit`), "/u/2");
  // Served as /u/1/ even though the address bar no longer shows it.
  assert.equal(docAccountPrefix(`https://docs.google.com/document/u/1/d/${ID}/edit`, `/document/d/${ID}/edit`), "/u/1");
  assert.equal(docAccountPrefix(`https://docs.google.com/document/u/1/d/${ID}/edit`, `/document/u/3/d/${ID}/edit`), "/u/1");
});

test("the export URL carries the prefix, and is unchanged without one", () => {
  const { docExportUrl } = loadExportHelpers();
  assert.equal(docExportUrl("abc123", "/u/1"), "https://docs.google.com/document/u/1/d/abc123/export?format=txt");
  assert.equal(docExportUrl("abc123", ""), "https://docs.google.com/document/d/abc123/export?format=txt");
});

test("getDocText exports through the account prefix docsMode derived", () => {
  const src = read("content.js");
  assert.match(src, /const ACCOUNT_PREFIX = harness \? "" : docAccountPrefix\(\s*\(\(\) => \{ try \{ return performance\.getEntriesByType\("navigation"\)\[0\]\?\.name; \}/);
  assert.match(contentSlice("async function getDocText()", "function uncheckedSegments"), /fetch\(docExportUrl\(DOC_ID, ACCOUNT_PREFIX\)/);
  assert.ok(!/document\/d\/\$\{DOC_ID\}\/export/.test(src), "an export URL without the account prefix is still built");
});

/* ── an orphaned tab says so instead of showing a stale count ──────────── */

const ORPHAN_HELPER = () => contentSlice("  const ORPHAN_PILL_TEXT", "// jointracely.com's own font");
const STALE_PILL = '<div class="pill" id="pill"><span class="plane"></span>Tracely<span class="count">2</span></div>';

test("the orphan pill names the update and the fix, and carries no count", () => {
  const { text, html } = vm.runInContext(`${ORPHAN_HELPER()};({ text: ORPHAN_PILL_TEXT, html: orphanPillHtml() })`,
    vm.createContext({ PLANE_SVG: "<svg></svg>" }));
  assert.equal(text, "Tracely was updated — reload this tab");
  assert.ok(html.includes(text), html);
  assert.match(html, /class="pill quiet orphan" id="pill"/, "quiet styling: nothing is wrong with the user's writing");
  assert.ok(!/class="count/.test(html), "a count on an orphaned tab is exactly the stale claim being fixed");
  assert.ok(!/error|failed|invalid/i.test(text), "not alarming");
});

test("docs mode: standing down replaces the counting pill, marks and all", () => {
  const log = [];
  const code = `
    let orphaned = false, expanded = true;
    let annoObs = { disconnect() { log.push("observer") } };
    const marksTimer = 7;
    const root = { innerHTML: ${JSON.stringify(STALE_PILL)} };
    ${ORPHAN_HELPER()}
    ${contentSlice("    function standDown(why) {", "    /* Only meaningful where there WAS")}
    ${contentSlice("    function render() {\n      if (orphaned)", "    function saveSettings() {")}
    ({ standDown, render, root, state: () => ({ orphaned, expanded }) })`;
  const ctx = vm.createContext({
    PLANE_SVG: "<svg></svg>", log, EXT_VERSION: "test",
    clearInterval: (t) => log.push(`clear:${t}`),
    window: { removeEventListener() {} },
    scheduleDocsMarks() {},
    hideDocsPopover: () => log.push("popover"),
    clearDocsMarks: () => log.push("marks"),
    console: { log: (m) => log.push(m) },
  });
  const d = vm.runInContext(code, ctx);
  d.standDown("extension reloaded");
  assert.deepEqual(plain(d.state()), { orphaned: true, expanded: false });
  assert.ok(log.includes("marks") && log.includes("clear:7") && log.includes("popover"), JSON.stringify(log));
  assert.ok(d.root.innerHTML.includes("Tracely was updated — reload this tab"), d.root.innerHTML);
  assert.ok(!d.root.innerHTML.includes('class="count'), "the stale count survived the stand-down");
  d.render(); // any later render (a check that was in flight, a tier change) keeps it
  assert.ok(d.root.innerHTML.includes("Tracely was updated — reload this tab"));
});

test("docs mode: an orphaned instance stops checking and stops drawing", () => {
  const src = read("content.js");
  const docs = src.slice(src.indexOf("function docsMode()"), src.indexOf("function fieldMode()"));
  assert.match(docs, /async function cycle\(\) \{\s*if \(orphaned \|\| inflight/);
  assert.match(docs, /function requestDocsMarks\(\) \{\s*if \(orphaned/);
  assert.match(docs, /async function fetchServerStatus\(\) \{\s*if \(orphaned\) return;/);
  assert.match(docs, /setInterval\(\(\) => \{\s*if \(orphaned\) return;/);
  assert.match(docs, /"tracely-docs-rects"\) return;\s*if \(orphaned\) return;/, "a rects reply in flight at stand-down must not redraw");
});

function loadFieldStandDown({ eligible = true } = {}) {
  const log = [];
  const code = `
    let orphaned = false, expanded = true, segments = [{ hash: "h" }];
    let tracked = { isConnected: true };
    let overlayEl = { textContent: "<bars>" };
    const markRects = new Map([["h", [{}]]]);
    const widget = { shadow: {}, root: { style: { display: "" }, innerHTML: ${JSON.stringify(STALE_PILL)} } };
    ${ORPHAN_HELPER()}
    ${contentSlice("    function drawMarks() {", "    function hitMark(")}
    ${contentSlice("    function render() {\n      scheduleMarks();", "    function saveSettings() {")}
    ${contentSlice("    function standDownField(why) {", "    setInterval(() => {")}
    ({ standDownField, render, widget, markRects, overlay: () => overlayEl.textContent, state: () => ({ orphaned, expanded, segments: segments.length }) })`;
  const ctx = vm.createContext({
    PLANE_SVG: "<svg></svg>", EXT_VERSION: "test",
    scheduleMarks() {},
    fieldEligible: () => eligible,
    console: { log: (m) => log.push(m) },
  });
  return { f: vm.runInContext(code, ctx), log };
}

test("field mode: standing down clears the underlines and replaces the counting pill", () => {
  const { f, log } = loadFieldStandDown();
  f.standDownField("extension reloaded");
  assert.deepEqual(plain(f.state()), { orphaned: true, expanded: false, segments: 0 });
  assert.equal(f.overlay(), "", "the underline bars were left on the page");
  assert.equal(f.markRects.size, 0, "stale hit-test rects would still open cards");
  assert.equal(f.widget.root.innerHTML, vm.runInContext(`${ORPHAN_HELPER()};orphanPillHtml()`, vm.createContext({ PLANE_SVG: "<svg></svg>" })));
  assert.equal(f.widget.root.style.display, "");
  assert.match(log[0], /stood down \(extension reloaded\)/);
});

test("field mode: the orphan pill shows only where the counting pill would have", () => {
  const { f } = loadFieldStandDown({ eligible: false });
  f.standDownField("extension reloaded");
  assert.equal(f.widget.root.style.display, "none", "a short field never showed a pill, so it must not grow one now");
});

test("field mode: the loop stands down on a lost context, and an orphan never checks", () => {
  const src = read("content.js");
  const field = src.slice(src.indexOf("function fieldMode()"));
  assert.match(field, /setInterval\(\(\) => \{[\s\S]{0,200}if \(useRelay && !orphaned && !extAlive\(\)\) standDownField\("extension reloaded"\);/);
  assert.match(field, /async function cycle\(\) \{\s*if \(orphaned \|\| inflight/);
});

/* ── citations ─────────────────────────────────────────────────────────── */

function loadCitations() {
  const code = contentSlice("  // Bibliography block", "  function segmentText(")
    + ";({ formatCitation, sourcesBlock, CITE_STYLES })";
  return vm.runInContext(code, vm.createContext({}));
}

const IOM_URL = "https://publications.iom.int/books/world-migration-report-2024-chapter-2";
const IOM_TITLE = "World Migration Report 2024: Chapter 2 – Migration and migrants: A global overview";
const IOM = "International Organization for Migration";
// The tester's source, as /api/sources returns it once the model is asked for
// the citation fields. The model may or may not name the group author; the
// organisation's own report cites the same either way.
const TESTER = {
  title: IOM_TITLE, url: IOM_URL, publisher: IOM, kind: "institutional",
  authors: [], groupAuthor: IOM, year: 2024,
  container: "World Migration Report 2024", editors: ["McAuliffe, M.", "Oucho, L. A."],
};

const FIXTURES = {
  "IOM chapter (the tester's source)": TESTER,
  "IOM chapter, group author left empty": { ...TESTER, groupAuthor: "" },
  "IOM from an older server (title/url/publisher only)": { title: IOM_TITLE, url: IOM_URL, publisher: IOM, snippet: "", stance: "supports" },
  "IOM via /api/cite-url (hostname publisher)": { url: IOM_URL, title: IOM_TITLE, publisher: "publications.iom.int", kind: "institutional", year: 2024 },
  "CDC page": { title: "Benefits of Physical Activity", url: "https://www.cdc.gov/physical-activity-basics/benefits/index.html", publisher: "Centers for Disease Control and Prevention", groupAuthor: "Centers for Disease Control and Prevention", authors: [], year: 2025, date: "2025-12-04", kind: "institutional" },
  "CDC via /api/cite-url": { url: "https://www.cdc.gov/physical-activity-basics/benefits/index.html", title: "Benefits of Physical Activity", publisher: "CDC", kind: "institutional", groupAuthor: "CDC", year: 2025, date: "2025-12-04" },
  "Wikipedia, undated": { title: "Great Wall of China", url: "https://en.wikipedia.org/wiki/Great_Wall_of_China", publisher: "Wikipedia", authors: [], groupAuthor: "", year: null, kind: "reference" },
  "Wikipedia revision": { url: "https://en.wikipedia.org/wiki/Great_Wall_of_China", title: "Great Wall of China", publisher: "Wikipedia", kind: "reference", year: 2026, date: "2026-09-12", permalink: "https://en.wikipedia.org/w/index.php?title=Great_Wall_of_China&oldid=1374512030" },
  "Nature article (26 authors, DOI)": {
    url: "https://www.nature.com/articles/s41586-020-2649-2", title: "Array programming with NumPy", publisher: "Nature", kind: "journal",
    authors: ["Harris, Charles R.", "Millman, K. Jarrod", "van der Walt, Stéfan J.", "Gommers, Ralf", "Virtanen, Pauli", "Cournapeau, David", "Wieser, Eric", "Taylor, Julian", "Berg, Sebastian", "Smith, Nathaniel J.", "Kern, Robert", "Picus, Matti", "Hoyer, Stephan", "van Kerkwijk, Marten H.", "Brett, Matthew", "Haldane, Allan", "del Río, Jaime Fernández", "Wiebe, Mark", "Peterson, Pearu", "Gérard-Marchant, Pierre", "Sheppard, Kevin", "Reddy, Tyler", "Weckesser, Warren", "Abbasi, Hameer", "Gohlke, Christoph", "Oliphant, Travis E."],
    year: 2020, doi: "10.1038/s41586-020-2649-2", container: "Nature", volume: "585", issue: "7825", pages: "357–362",
  },
  "Pew report (3 authors)": { url: "https://www.pewresearch.org/internet/2026/04/15/teens-experiences-on-tiktok-instagram-and-snapchat/", title: "Teens’ Experiences on TikTok, Instagram and Snapchat", publisher: "Pew Research Center", kind: "institutional", authors: ["Michelle Faverio", "Eugenie Park", "Jeffrey Gottfried"], year: 2026, date: "2026-04-15" },
  "NPR story": { url: "https://www.npr.org/2020/04/07/828918397/how-to-compost-at-home", title: "Composting can help fight climate change. Get started in 5 easy steps", publisher: "NPR", kind: "news", authors: ["Julia Simon"], year: 2020, date: "2020-04-09" },
  "BBC story": { url: "https://www.bbc.com/news/articles/c5j9x83yw19wo", title: "Brigitte Bardot's ballet flats and diamond rings to be sold at auction", publisher: "BBC News", kind: "news", authors: ["Hugh Schofield"], year: 2026, date: "2026-09-20" },
  "unbylined news story": { title: "Storm closes schools", url: "https://www.example-times.com/2026/09/20/storm", publisher: "The Example Times", authors: [], groupAuthor: "", year: 2026, date: "2026-09-20", kind: "news" },
  "harvested url_citation (hostname publisher, older shape)": { title: "Some page", url: "https://www.nasa.gov/x", publisher: "nasa.gov", snippet: "", stance: "context" },
  "no publisher at all (older shape)": { title: "Some page", url: "https://www.nasa.gov/x" },
};
const dated = (src) => Number.isInteger(src.year) || /^\d{4}-\d{2}-\d{2}$/.test(src.date ?? "");
const STYLES = ["apa", "mla", "chicago"];

test("the tester's IOM chapter cites with its real year, group author and editors — exact, all three styles", () => {
  const { formatCitation } = loadCitations();
  const want = {
    apa: {
      doc: `${IOM}. (2024). ${IOM_TITLE}. In M. McAuliffe & L. A. Oucho (Eds.), World Migration Report 2024.`,
      ref: `${IOM}. (2024). ${IOM_TITLE}. In M. McAuliffe & L. A. Oucho (Eds.), World Migration Report 2024. ${IOM_URL}`,
      marker: `(${IOM}, 2024)`,
    },
    mla: {
      // MLA 9: an organisation that is author and publisher is named once, as publisher.
      doc: `“${IOM_TITLE}.” World Migration Report 2024, edited by M. McAuliffe and L. A. Oucho, ${IOM}, 2024.`,
      ref: `“${IOM_TITLE}.” World Migration Report 2024, edited by M. McAuliffe and L. A. Oucho, ${IOM}, 2024, publications.iom.int/books/world-migration-report-2024-chapter-2.`,
      marker: "(“World Migration Report 2024”)",
    },
    chicago: {
      doc: `${IOM}. 2024. “${IOM_TITLE}.” In World Migration Report 2024, edited by M. McAuliffe and L. A. Oucho. ${IOM}.`,
      ref: `${IOM}. 2024. “${IOM_TITLE}.” In World Migration Report 2024, edited by M. McAuliffe and L. A. Oucho. ${IOM}. ${IOM_URL}.`,
      marker: `(${IOM} 2024)`,
    },
  };
  for (const style of STYLES) {
    assert.deepEqual(plain(formatCitation(FIXTURES["IOM chapter (the tester's source)"], style)), want[style], style);
    // Whether or not the model named the group author, the org's own report cites the same.
    assert.deepEqual(plain(formatCitation(FIXTURES["IOM chapter, group author left empty"], style)), want[style], `${style}, no groupAuthor`);
  }
});

test("a source from an older server still puts the publisher, never a hostname, in the author slot", () => {
  const { formatCitation } = loadCitations();
  const old = formatCitation(FIXTURES["IOM from an older server (title/url/publisher only)"], "apa");
  assert.equal(old.ref, `${IOM}. (n.d.). ${IOM_TITLE}. ${IOM_URL}`);
  assert.equal(old.marker, `(${IOM}, n.d.)`);
  for (const name of ["harvested url_citation (hostname publisher, older shape)", "no publisher at all (older shape)", "IOM via /api/cite-url (hostname publisher)"]) {
    const src = FIXTURES[name];
    const host = new URL(src.url).hostname;
    for (const style of STYLES) {
      const c = formatCitation(src, style);
      for (const h of [host, host.replace(/^www\./, ""), src.publisher].filter(Boolean)) {
        assert.ok(!c.doc.startsWith(h) && !c.marker.startsWith(`(${h}`), `${name} / ${style}: hostname in the author slot: ${c.ref}`);
      }
      assert.ok(c.doc.startsWith("“") || c.doc.startsWith(src.title), `${name} / ${style}: the title should lead: ${c.doc}`);
    }
  }
  assert.equal(formatCitation(FIXTURES["harvested url_citation (hostname publisher, older shape)"], "apa").ref, "Some page. (n.d.). https://www.nasa.gov/x");
});

test("no citation carries a retrieval or access date, and n.d. appears only when no year is known", () => {
  const { formatCitation } = loadCitations();
  for (const [name, src] of Object.entries(FIXTURES)) {
    for (const style of STYLES) {
      const c = formatCitation(src, style);
      for (const [k, v] of Object.entries(c)) {
        assert.ok(!/Retrieved|Accessed|Last accessed/i.test(v), `${name} / ${style} / ${k}: ${v}`);
        if (dated(src)) assert.ok(!v.includes("n.d."), `${name} / ${style} / ${k}: n.d. on a dated source: ${v}`);
      }
      if (!dated(src) && style !== "mla") assert.ok(c.marker.includes("n.d."), `${name} / ${style}: undated but no n.d.: ${c.marker}`);
      if (dated(src)) {
        const year = src.date ? src.date.slice(0, 4) : String(src.year);
        assert.ok(c.ref.includes(year), `${name} / ${style}: the real year is missing: ${c.ref}`);
      }
    }
  }
  // The formatter no longer reads the clock at all — a date in a citation is
  // the source's, never today's.
  const src = contentSlice("  // ── citation formatting ──", "  function segmentText(");
  assert.ok(!/new Date\(|Date\.now\(/.test(src), "formatCitation reads the clock again");
});

test("every doc line stays one line that sourcesBlock parses back to its url", () => {
  const { formatCitation, sourcesBlock } = loadCitations();
  const messy = { title: "A title\nsplit  across\tlines — with a dash", url: "https://example.test/a", publisher: "Example Org", authors: ["  Jane   Doe "], year: 2021 };
  for (const [name, src] of [...Object.entries(FIXTURES), ["messy whitespace", messy]]) {
    const lines = STYLES.map((style, i) => `${i + 1}. ${formatCitation(src, style).doc} — ${src.url}`);
    for (const l of lines) assert.ok(!l.includes("\n"), `${name}: doc spans lines: ${l}`);
    const text = `Essay body. [1]\n\nSources:\n${lines.join("\n")}\n`;
    const block = sourcesBlock(text);
    assert.equal(block.entries.length, 3, `${name}: sourcesBlock stopped early:\n${lines.join("\n")}`);
    block.entries.forEach((e, i) => {
      assert.equal(e.num, i + 1);
      assert.equal(e.url, src.url, `${name}: entry ${i + 1} parsed the wrong url`);
      assert.equal(e.title, formatCitation(src, STYLES[i]).doc);
    });
  }
});

test("the rest of the fixture table: real authors, real dates, DOI locators (APA)", () => {
  const { formatCitation } = loadCitations();
  const want = {
    "CDC page": ["Centers for Disease Control and Prevention. (2025, December 4). Benefits of Physical Activity. https://www.cdc.gov/physical-activity-basics/benefits/index.html", "(Centers for Disease Control and Prevention, 2025)"],
    "CDC via /api/cite-url": ["CDC. (2025, December 4). Benefits of Physical Activity. https://www.cdc.gov/physical-activity-basics/benefits/index.html", "(CDC, 2025)"],
    "Wikipedia, undated": ["Great Wall of China. (n.d.). In Wikipedia. https://en.wikipedia.org/wiki/Great_Wall_of_China", "(“Great Wall of China,” n.d.)"],
    "Wikipedia revision": ["Great Wall of China. (2026, September 12). In Wikipedia. https://en.wikipedia.org/w/index.php?title=Great_Wall_of_China&oldid=1374512030", "(“Great Wall of China,” 2026)"],
    "Nature article (26 authors, DOI)": ["Harris, C. R., Millman, K. J., van der Walt, S. J., Gommers, R., Virtanen, P., Cournapeau, D., Wieser, E., Taylor, J., Berg, S., Smith, N. J., Kern, R., Picus, M., Hoyer, S., van Kerkwijk, M. H., Brett, M., Haldane, A., del Río, J. F., Wiebe, M., Peterson, P., . . . Oliphant, T. E. (2020). Array programming with NumPy. Nature, 585(7825), 357–362. https://doi.org/10.1038/s41586-020-2649-2", "(Harris et al., 2020)"],
    "Pew report (3 authors)": ["Faverio, M., Park, E., & Gottfried, J. (2026, April 15). Teens’ Experiences on TikTok, Instagram and Snapchat. Pew Research Center. https://www.pewresearch.org/internet/2026/04/15/teens-experiences-on-tiktok-instagram-and-snapchat/", "(Faverio et al., 2026)"],
    "NPR story": ["Simon, J. (2020, April 9). Composting can help fight climate change. Get started in 5 easy steps. NPR. https://www.npr.org/2020/04/07/828918397/how-to-compost-at-home", "(Simon, 2020)"],
    "BBC story": ["Schofield, H. (2026, September 20). Brigitte Bardot's ballet flats and diamond rings to be sold at auction. BBC News. https://www.bbc.com/news/articles/c5j9x83yw19wo", "(Schofield, 2026)"],
    // APA: an unsigned news story leads with its title, the paper follows.
    "unbylined news story": ["Storm closes schools. (2026, September 20). The Example Times. https://www.example-times.com/2026/09/20/storm", "(“Storm closes schools,” 2026)"],
    "IOM via /api/cite-url (hostname publisher)": [`${IOM_TITLE}. (2024). ${IOM_URL}`, "(World Migration Report 2024, 2024)"],
  };
  for (const [name, [ref, marker]] of Object.entries(want)) {
    const c = formatCitation(FIXTURES[name], "apa");
    assert.equal(c.ref, ref, name);
    assert.equal(c.marker, marker, name);
  }
  // Spot checks in the other two styles.
  assert.equal(formatCitation(FIXTURES["NPR story"], "mla").ref, "Simon, Julia. “Composting can help fight climate change. Get started in 5 easy steps.” NPR, 9 Apr. 2020, www.npr.org/2020/04/07/828918397/how-to-compost-at-home.");
  assert.equal(formatCitation(FIXTURES["Nature article (26 authors, DOI)"], "mla").marker, "(Harris et al.)");
  assert.equal(formatCitation(FIXTURES["BBC story"], "chicago").ref, "Schofield, Hugh. 2026. “Brigitte Bardot's ballet flats and diamond rings to be sold at auction.” BBC News, September 20, 2026. https://www.bbc.com/news/articles/c5j9x83yw19wo.");
  assert.equal(formatCitation(FIXTURES["Wikipedia revision"], "chicago").doc, "Wikipedia. 2026. “Great Wall of China.” Last modified September 12, 2026.");
  // Chicago's marker has no comma between author and year (the old one did).
  assert.equal(formatCitation(FIXTURES["CDC page"], "chicago").marker, "(Centers for Disease Control and Prevention 2025)");
});

test("malformed optional fields degrade instead of printing undefined", () => {
  const { formatCitation, CITE_STYLES } = loadCitations();
  assert.deepEqual(plain(CITE_STYLES), [["apa", "APA"], ["mla", "MLA"], ["chicago", "Chicago"]]);
  const cases = [
    { title: "T", url: "https://x.test/", publisher: "Org", authors: "Jane Doe", editors: {}, year: "2024", date: "2024-13-40", kind: 7 },
    { title: "", url: "https://x.test/only-url" },
    { title: "T", url: "https://x.test/", authors: [null, "", "  "], groupAuthor: null, year: 2024.5 },
    { title: "T", url: "https://x.test/", container: "Book", editors: ["A. One", "B. Two", "C. Three"], kind: "book", year: 1999 },
  ];
  for (const src of cases) {
    for (const style of [...STYLES, "unknown-style"]) {
      const c = formatCitation(src, style);
      for (const v of Object.values(c)) {
        assert.equal(typeof v, "string");
        assert.ok(!/undefined|null|NaN|\[object/.test(v), `${style}: ${v}`);
      }
    }
  }
  // A 4-digit string year is still a year; an impossible date falls back to it.
  assert.equal(formatCitation(cases[0], "apa").marker, "(Org, 2024)");
  assert.equal(formatCitation(cases[1], "apa").ref, "https://x.test/only-url. (n.d.). https://x.test/only-url");
  // Three editors: APA's ampersand list, Chicago's serial "and", MLA's et al.
  assert.match(formatCitation(cases[3], "apa").ref, /In A\. One, B\. Two, & C\. Three \(Eds\.\), Book\./);
  assert.match(formatCitation(cases[3], "chicago").ref, /edited by A\. One, B\. Two, and C\. Three\./);
  assert.match(formatCitation(cases[3], "mla").ref, /edited by A\. One et al\./);
});

test("an organisation's report leads with the organisation even when no group author is named", () => {
  const { formatCitation } = loadCitations();
  const WMR_URL = "https://publications.iom.int/books/world-migration-report-2024";
  const report = { title: "World Migration Report 2024", url: WMR_URL, publisher: IOM, kind: "report", authors: [], groupAuthor: "", year: 2024, date: "2024-05-07" };
  // APA 7 gray literature: the organisation is the author, the publisher is
  // not repeated, the date is the year, the title stands alone.
  assert.deepEqual(plain(formatCitation(report, "apa")), {
    doc: `${IOM}. (2024). World Migration Report 2024.`,
    ref: `${IOM}. (2024). World Migration Report 2024. ${WMR_URL}`,
    marker: `(${IOM}, 2024)`,
  });
  // MLA 9: author and publisher the same organisation → named once, as publisher.
  assert.equal(formatCitation(report, "mla").ref, `World Migration Report 2024. ${IOM}, 2024, publications.iom.int/books/world-migration-report-2024.`);
  assert.equal(formatCitation(report, "chicago").ref, `${IOM}. 2024. World Migration Report 2024. ${WMR_URL}.`);
  // A chapter of a report is a chapter, as a chapter of a book is.
  const chapter = { ...TESTER, kind: "report", groupAuthor: "" };
  for (const style of STYLES) assert.deepEqual(plain(formatCitation(chapter, style)), plain(formatCitation(TESTER, style)), style);
  // "book" keeps its meaning: an authorless book leads with its title.
  assert.ok(formatCitation({ ...report, kind: "book" }, "apa").ref.startsWith("World Migration Report 2024. (2024)."));
  // A kind this build does not know reads as "other" — an organisation's own page.
  assert.ok(formatCitation({ ...report, kind: "dataset" }, "apa").ref.startsWith(`${IOM}. (2024, May 7).`));
});
