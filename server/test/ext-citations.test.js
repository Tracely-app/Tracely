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
