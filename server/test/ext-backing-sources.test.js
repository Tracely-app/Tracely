/* Only sources that BACK the sentence are offered (content.js
 * backingSources), and the source search is told what "supports" means
 * (factcheck.js SOURCES_SYSTEM). Owner, 2026-10-04: "Find sources" offered
 * Ord & Davies (2022) — a paper on youth work and austerity cuts — for a
 * sentence about youth leadership it never discusses. "From now on dont
 * recommend me sources that do not align."
 *
 * Receipts (extension 2.21.25, server of 2026-10-07): a source is backing
 * only when the server READ it — `verified` — and a backing source shows the
 * words from it that back the sentence (`quote`) and where it read them
 * (`readFrom`). A source the server could not read (`verified: false`) is
 * never backing: it sits under a collapsed "Couldn't read these — check them
 * yourself" with Open only, never Cite in doc or Copy cite. An older server
 * (no `verified` field) behaves exactly as before. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";
import { findSources } from "../lib/factcheck.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const FACTCHECK = readFileSync(path.join(HERE, "..", "lib", "factcheck.js"), "utf8");

function load() {
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return s; }
    ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
    ({ backingSources, UNBACKED_NOTE, RECEIPT_COPY, sourceSaysHtml, unreadSourcesHtml })`, vm.createContext({}));
}
const X = load();
const urls = (list) => Array.from(list, (s) => s.url);

const ORD = { title: "Young people, youth work & the 'levelling up' policy agenda", url: "https://doi.org/10.1177/02690942221098971", stance: "context" };
const BACKS = { title: "A survey of youth participation", url: "https://example.org/a", stance: "supports" };
const AGAINST = { title: "The Great Wall is not visible from orbit", url: "https://example.org/b", stance: "refutes" };
const PASTED = { title: "A page the writer pasted", url: "https://example.org/c" };
const READ = { title: "GOV.UK", url: "https://example.org/r", stance: "supports", verified: true, readFrom: "page", quote: "spending on youth facilities fell by 73%" };
const UNREAD = { title: "Walled journal", url: "https://example.org/w", publisher: "Walled Press", stance: "context", verified: false };

// ── an older server: no `verified` on any source — today's behaviour ──────

test("a source only on the topic is not offered; one that backs the sentence is", () => {
  const r = X.backingSources([ORD, BACKS], "needs_citation");
  assert.deepEqual(urls(r.list), [BACKS.url]);
  assert.equal(r.unbacked, 1);
  assert.deepEqual(Array.from(r.unread), []);
});

test("a refuting source is offered only for a sentence flagged wrong (it backs the correction)", () => {
  assert.equal(X.backingSources([AGAINST], "false").list.length, 1);
  assert.equal(X.backingSources([AGAINST], "incoherent").list.length, 1);
  assert.equal(X.backingSources([AGAINST], "needs_citation").list.length, 0, "never offered to cite for the sentence it contradicts");
  assert.equal(X.backingSources([AGAINST], "accurate").list.length, 0, "an evidence suggestion only ever offers support");
});

test("a source the writer pasted is theirs (no stance, or /api/cite-url's 'manual'), and junk input is safe", () => {
  assert.equal(X.backingSources([PASTED], "needs_citation").list.length, 1);
  assert.equal(X.backingSources([{ ...PASTED, stance: "manual" }], "needs_citation").list.length, 1, "a reload no longer drops a pasted source");
  assert.deepEqual(Array.from(X.backingSources(undefined, "false").list), []);
  assert.equal(X.backingSources([null, ORD], "false").unbacked, 2);
});

test("nothing backs it: the card says so honestly, not 'no sources found'", () => {
  assert.match(X.UNBACKED_NOTE(1), /found 1 source on this topic, but none says what this sentence says/);
  assert.match(X.UNBACKED_NOTE(3), /found 3 sources/);
});

// ── a server with receipts ────────────────────────────────────────────────

test("an unverified source is NEVER backing, whatever stance it carries — it goes to `unread`", () => {
  for (const verdict of ["needs_citation", "false", "questionable", "incoherent"]) {
    for (const stance of ["supports", "refutes", "context", undefined, "manual"]) {
      const s = { title: "t", url: `https://example.org/${stance}`, stance, verified: false };
      const r = X.backingSources([s], verdict);
      assert.equal(r.list.length, 0, `${verdict}/${stance}: offered to cite unread`);
      assert.deepEqual(urls(r.unread), [s.url]);
      assert.equal(r.unbacked, 0, "unread is not 'on the topic but says something else' — nothing read it");
    }
  }
});

test("read and backing is offered; read and only on the topic is counted; unread is set apart", () => {
  const r = X.backingSources([READ, { ...ORD, verified: true, readFrom: "abstract" }, UNREAD], "needs_citation");
  assert.deepEqual(urls(r.list), [READ.url]);
  assert.equal(r.unbacked, 1);
  assert.deepEqual(urls(r.unread), [UNREAD.url]);
});

test("the mock server's answer (two read and quoted, one unread) for a sentence flagged false", async () => {
  const { sources } = await findSources({ claim: "The Great Wall is visible from space.", model: "gpt-5.6-luna", mock: true });
  const r = X.backingSources(sources, "false");
  assert.equal(r.list.length, 2);
  assert.ok(Array.from(r.list).every((s) => s.verified === true && s.quote));
  assert.equal(r.unread.length, 1);
  assert.equal(X.backingSources(sources, "needs_citation").list.length, 0, "refuting sources are never offered for a sentence that is only uncited");
});

test("the receipt: 'The source says: “…”' and where it was read; an older server's snippet otherwise", () => {
  const h = X.sourceSaysHtml(READ);
  assert.match(h, /<div class="src-says">The source says: “spending on youth facilities fell by 73%”<\/div>/);
  assert.match(h, /<div class="src-from">from the page<\/div>/);
  assert.match(X.sourceSaysHtml({ ...READ, readFrom: "abstract" }), /from the abstract/);
  assert.equal(X.sourceSaysHtml({ snippet: "the search's paraphrase" }), `<div class="src-snip">the search's paraphrase</div>`);
  assert.equal(X.sourceSaysHtml({}), "");
  assert.doesNotMatch(X.sourceSaysHtml({ quote: "<img src=x onerror=alert(1)> rose", readFrom: "page" }), /<img/, "escaped");
});

test("the unread sources: collapsed by default, Open only — no Cite in doc, no Copy cite", () => {
  const closed = X.unreadSourcesHtml("h1", [UNREAD], false);
  assert.match(closed, /data-unread-toggle="h1" aria-expanded="false">▸ Couldn't read these — check them yourself \(1\)<\/button>/);
  assert.doesNotMatch(closed, /Walled journal/, "collapsed");
  const open = X.unreadSourcesHtml("h1", [UNREAD], true);
  assert.match(open, /aria-expanded="true">▾/);
  assert.match(open, /Walled journal/);
  assert.match(open, /<a class="src-open" href="https:\/\/example\.org\/w" target="_blank" rel="noopener noreferrer">Open ↗<\/a>/);
  assert.doesNotMatch(open, /data-copy-src|data-doc-cite|data-src-replace|Cite|Copy/, "nothing offers to cite what nothing read");
  assert.equal(X.unreadSourcesHtml("h1", [], true), "");
  assert.match(X.RECEIPT_COPY.unreadOnly(2), /found 2 sources, but Tracely couldn't open them to check what they say/);
});

// ── wiring ────────────────────────────────────────────────────────────────

test("wired: every search result and every saved list goes through it, in both modes", () => {
  assert.equal((SRC.match(/const \{ list, unbacked, unread \} = backingSources\(data\.sources, f\?\.verdict\);\n\s+sourcesMap\.set\(hash, \{ loading: false, list, unbacked, unread, copiedUrl: null \}\);/g) || []).length, 2);
  assert.match(SRC, /list: backingSources\(st\.list, cache\.get\(h\)\?\.verdict\)\.list, unread: backingSources\(st\.unread, cache\.get\(h\)\?\.verdict\)\.unread/, "lists saved by an older build are filtered too");
  assert.match(SRC, /\.map\(\(\[h, st\]\) => \[h, \{ list: st\.list\.slice\(0, 5\), unread: \(st\.unread \?\? \[\]\)\.slice\(0, 5\), citedUrl/, "and the unread ones are saved beside them");
  assert.equal((SRC.match(/\} else if \(\(st\?\.unbacked \|\| st\?\.unread\?\.length\) && !st\.list\?\.length\) \{/g) || []).length, 2, "both panels");
  assert.match(SRC, /if \(s\.unbacked\) put\(dmHead\(DM\.amber, POP_COPY\.noBacking\), dmBody\(UNBACKED_NOTE\(s\.unbacked\)\)\);\n\s+else if \(unread\.length\) put\(dmHead\(DM\.amber, POP_COPY\.couldntRead\), dmBody\(RECEIPT_COPY\.unreadOnly\(unread\.length\)\)\);/, "the Docs card");
});

test("wired: both panels show the receipt on every listed source and the unread ones apart; the cite buttons are only on the list", () => {
  assert.equal((SRC.match(/\$\{sourceSaysHtml\(src\)\}/g) || []).length, 2, "both panels' source rows");
  assert.equal((SRC.match(/\.join\(""\) \+ unreadSourcesHtml\(seg\.hash, st\.unread, st\.unreadOpen\) \+ `<\/div>`;/g) || []).length, 2);
  assert.equal((SRC.match(/for \(const btn of shadow\.querySelectorAll\("\[data-unread-toggle\]"\)\)/g) || []).length, 2, "the toggle works in both modes");
  // The cite and copy handlers index st.list only — never the unread list.
  assert.equal((SRC.match(/const src = st\?\.list\?\.\[Number\(btn\.dataset\.i\)\];/g) || []).length, 2);
  assert.doesNotMatch(SRC, /st\.unread\?*\.\[/, "nothing indexes into the unread list to cite it");
});

test("wired: the Docs hover card puts the receipt in each source row and the unread ones behind a toggle with Open only", () => {
  const row = sliceBetween(SRC, "    function dmRow(src, selected, onSelect) {", "    function dmUnread(");
  assert.match(row, /if \(src\.quote\) \{/);
  assert.match(row, /`\$\{RECEIPT_COPY\.says\} “\$\{src\.quote\}”`/);
  assert.match(row, /RECEIPT_COPY\.from\[src\.readFrom\]/);
  const unread = sliceBetween(SRC, "    function dmUnread(", "    function dmStyles(");
  assert.match(unread, /dmBtn\(RECEIPT_COPY\.open, false/);
  assert.doesNotMatch(unread, /docCite|copyCite|formatCitation|clipboard/, "Open only");
  assert.match(SRC, /const unreadBlock = unreadEl\(\);\n\s+if \(unreadBlock\) scroll\.appendChild\(unreadBlock\);/, "under the results");
  assert.equal((SRC.match(/const unreadBlock = unreadEl\(\);/g) || []).length, 2, "and when nothing backs it, in a box that scrolls");
});

test("the search is told what 'supports' means", () => {
  assert.match(FACTCHECK, /"supports" only when the result itself states the claim's point — the same subject, direction and figures; a source on the same topic that makes a different point is "context", however relevant\. When unsure, "context"\./);
  assert.match(FACTCHECK, /"snippet": one sentence \(max 30 words\) saying what the source itself states — never the claim's words unless the source uses them\./);
});
