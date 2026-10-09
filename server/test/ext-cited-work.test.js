/* "Find the cited work" (extension 2.21.24). Owner, 2026-10-06: "it says if
 * a citation is invalid, but it doesnt find citation for me … it doesnt go
 * find the publication date for me", on
 *   "… but the extent remains uncertain (Genghis Khan and the, 2022)."
 * A card whose citation is the problem now looks the cited work up
 * (/api/compare-source: Crossref and Open Library, no model) and offers the
 * record's own marker in place of the broken one. Pinned here:
 *   - the pure helpers in content.js: which citation a sentence or a note
 *     is about, what is sent, which reference entry it points at, the year
 *     said plainly when it disagrees, the sentence with the citation
 *     swapped — and nothing swapped when which citation is meant is a guess;
 *   - that every field shown or inserted is the record's own;
 *   - the lookup itself: at most three records, an old server's refusal read
 *     as "not checked", a citation too thin to look up never sent;
 *   - the server: the route is on the extension's surface, gated as a lookup
 *     (its own per-caller window, no model spend reserved, never shed for the
 *     budget), and the background worker relays it.
 * The Docs edits it drives (Replace citation, Complete entry, Cite in doc in
 * place of the faulty citation) are pinned in ext-docs-edit.test.js. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const BG = readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
const SERVER = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
const ESSAY = readFileSync(path.join(ROOT, "eval", "revision", "flawed-mongols.txt"), "utf8").replace(/\r\n/g, "\n");
const plain = (v) => JSON.parse(JSON.stringify(v));

function slice(from, to) {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a);
  assert.ok(a > 0 && b > a, `content.js: could not find ${from} .. ${to}`);
  return SRC.slice(a, b);
}
const HELPERS = (features = "{ citeHintsToggle: false }") => `const CHECK_INTERVAL_MS = 10000; const FEATURES = ${features};
  function hashText(s) { return "h" + s.length + s.slice(0, 24); }
  ${slice("  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${slice("  // Bibliography block", "  function wireChrome(")}`;
const X = vm.runInContext(`${HELPERS()}
  ({ inTextCitationsOf, lookupableCitation, flaggedCitationOf, citedRefQuery, citedYearOf, referenceEntryFor, citationUses,
     citedLookupPlan, citedYearNote, citedWorkSource, citedWorkEntry, citationPage, markerWithPage, swapCitation,
     claimSentenceIndex, tipCitedTarget, citedFailureNote, CITED_COPY, citedWorkHtml, citationTips, referenceTips, segmentText, formatCitation })`,
vm.createContext({}));

// The owner's sentence, and the note after it.
const CITED = "Some researchers have argued that literacy expanded in parts of the empire, but the extent remains uncertain (Genghis Khan and the, 2022).";
const OWNER = `The movement of ideas may have contributed to increased literacy in some parts of the empire. ${CITED} 'The study does not need a publication date because Harvard is a famous institution.'`;
const WORKS = "\n\nWorks Cited\nWeatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004.\nOrd, J., & Davies, B. (2022). Young people, youth work and the levelling up agenda. Local Economy, 37(1-2), 104-117.";
// What /api/compare-source answers for it (evidence.js compareSource's shape).
const OL_MATCH = { doi: null, title: "Genghis Khan and the Making of the Modern World", authors: ["Jack Weatherford"], year: 2004, venue: null, venueType: "book", url: "https://openlibrary.org/works/OL3974405W", provider: "openlibrary", relevance: 1, citable: true };

/* ── which citation a card is about ─────────────────────────────────────── */

test("the citation is extracted from the sentence: the owner's, and the shapes essays use", () => {
  const [c] = X.inTextCitationsOf(CITED);
  assert.equal(c.raw, "(Genghis Khan and the, 2022)");
  assert.equal(c.inner, "Genghis Khan and the, 2022");
  assert.equal(CITED.slice(c.start, c.end), c.raw);
  for (const [s, inner] of [
    ["Parking shapes cities (Shoup 45).", "Shoup 45"],
    ['Youth councils pressed for action ("Youth Matters", 2025).', '"Youth Matters", 2025'],
    ["Water access lags (UNICEF, 2021, p. 4).", "UNICEF, 2021, p. 4"],
    ["Teen sleep is short (Carskadon et al., 2011).", "Carskadon et al., 2011"],
    ["Sources vary (Smith, n.d.).", "Smith, n.d."],
  ]) assert.equal(X.lookupableCitation(s)?.inner, inner, s);
  for (const s of [
    "Travelers moved safely (Doc 2).", "See the chart (Figure 3).", "Solar costs fell [3].", "It ended (in 1990).",
    "It rose. (1990)", "No citation here at all.",
  ]) assert.equal(X.lookupableCitation(s), null, `${s} names no work to look up`);
});

test("two citations: nothing is looked up or replaced, because which one the card means would be a guess", () => {
  for (const s of [
    "Trade grew (Smith, 2019) and ideas spread (Jones, 2020).",
    "Trade grew and ideas spread (Smith, 2019; Jones, 2020).",
  ]) {
    assert.equal(X.lookupableCitation(s), null, s);
    assert.equal(X.flaggedCitationOf("questionable", s), null, s);
  }
  assert.equal(X.inTextCitationsOf("Trade grew and ideas spread (Smith, 2019; Jones, 2020).").every((c) => c.shared), true, "one parenthetical holding two works is never swapped whole");
});

test("a verdict that doubts a cited sentence doubts its citation; a sound one does not", () => {
  for (const v of ["false", "questionable", "incoherent"]) assert.equal(X.flaggedCitationOf(v, CITED)?.raw, "(Genghis Khan and the, 2022)", v);
  for (const v of ["needs_citation", "accurate", "no_claim", undefined]) assert.equal(X.flaggedCitationOf(v, CITED), null, String(v));
});

/* ── what is sent ───────────────────────────────────────────────────────── */

test("what is sent: the citation's words, without links, DOIs, access notes, site names or page numbers", () => {
  assert.deepEqual(plain(X.citedRefQuery("Genghis Khan and the, 2022")), { query: "Genghis Khan and the, 2022", thin: false });
  const apa = X.citedRefQuery("Ord, J., & Davies, B. (2022). Young people, youth work and the levelling up agenda. Local Economy, 37(1-2), 104-117. https://doi.org/10.1177/02690942221098971");
  assert.equal(apa.thin, false);
  assert.ok(!/https|doi|10\.1177|104|117|37/.test(apa.query), apa.query);
  assert.match(apa.query, /Ord, J\. & Davies, B\. 2022\. Young people, youth work and the levelling up agenda/, "names, year and title words survive");
  // Too little to name a work: an author and a year match any work by anyone of that name.
  for (const thin of ["Khan, 2022", "Smith, n.d.", "Shoup 45", "History.com / Gutenberg / accessed yesterday", "Einstein 1206: 45"]) {
    assert.equal(X.citedRefQuery(thin).thin, true, thin);
  }
});

test("matching an in-text citation to its reference-list entry: the entry is sent instead, being richer", () => {
  const doc = CITED + WORKS;
  assert.equal(X.referenceEntryFor("Genghis Khan and the, 2022", doc), "Weatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004.", "a wrong year does not rule the entry out — it is what the lookup is for");
  assert.equal(X.referenceEntryFor("Ord & Davies, 2022", doc), "Ord, J., & Davies, B. (2022). Young people, youth work and the levelling up agenda. Local Economy, 37(1-2), 104-117.");
  assert.equal(X.referenceEntryFor("Shoup 45", doc), null, "nothing in the list");
  assert.equal(X.referenceEntryFor("Genghis Khan and the, 2022", CITED), null, "no list at all");
  // Two entries by one name: the year that agrees picks; a tie picks nothing.
  const two = `${CITED}\n\nWorks Cited\nKhan, Genghis. Laws. 1910.\nKhan, Genghis. Letters. 2022.\nKhan, Genghis. Letters. 2019.`;
  assert.equal(X.referenceEntryFor("Khan, 2022", two), "Khan, Genghis. Letters. 2022.");
  assert.equal(X.referenceEntryFor("Khan, 2001", two), null, "three equally good entries: sending one would look up a guess");

  const plan = X.citedLookupPlan({ kind: "sentence", raw: "(Genghis Khan and the, 2022)", inner: "Genghis Khan and the, 2022" }, doc);
  assert.equal(plan.citedRef, "Weatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004.");
  assert.equal(plan.citedYear, "2022", "the year the writer wrote, from the citation itself");
  const bare = X.citedLookupPlan({ kind: "sentence", raw: "(Genghis Khan and the, 2022)", inner: "Genghis Khan and the, 2022" }, CITED);
  assert.deepEqual([bare.citedRef, bare.entry, bare.noEntry], ["Genghis Khan and the, 2022", null, false]);
  const missing = X.citedLookupPlan({ kind: "sentence", raw: "(Shoup 45)", inner: "Shoup 45" }, doc);
  assert.equal(missing.noEntry, true, "a list with no entry for it is said");
  assert.equal(missing.thin, true);
});

/* ── what is shown ──────────────────────────────────────────────────────── */

test("the year is said plainly when the record and the citation disagree, and not otherwise", () => {
  assert.equal(X.citedYearNote(2004, "2022"), "This record is from 2004; your citation says 2022.");
  assert.equal(X.citedYearNote(2004, "2004"), "");
  assert.equal(X.citedYearNote(2004, null), "", "an MLA marker gives no year: nothing to compare");
  assert.equal(X.citedYearNote(2004, "n.d."), "This record is from 2004; your citation gives no date.");
  assert.equal(X.citedYearNote(null, "2022"), "This record gives no year; your citation says 2022.", "never a year the record did not give");
  assert.equal(X.citedYearOf("Genghis Khan and the, 2022"), "2022");
  assert.equal(X.citedYearOf("Smith, n.d."), "n.d.");
});

test("every field comes from the record: nothing guessed, nothing filled in", () => {
  const src = X.citedWorkSource(OL_MATCH);
  assert.deepEqual(plain(src), {
    title: "Genghis Khan and the Making of the Modern World", authors: ["Jack Weatherford"], year: 2004, doi: "",
    url: "https://openlibrary.org/works/OL3974405W", kind: "book", container: "", publisher: "", provider: "Open Library",
  });
  assert.deepEqual(plain(X.citedWorkEntry(src, "mla")), { marker: "(Weatherford)", entry: "Weatherford, Jack. Genghis Khan and the Making of the Modern World. 2004." }, "no publisher the record did not give, no Open Library address");
  assert.equal(X.citedWorkEntry(src, "apa").marker, "(Weatherford, 2004)");
  assert.equal(X.citedWorkEntry(src, "chicago").marker, "(Weatherford 2004)");
  // No year in the record: n.d. in the marker, never the year the writer typed.
  const noYear = X.citedWorkSource({ ...OL_MATCH, year: null });
  assert.equal(noYear.year, null);
  assert.equal(X.citedWorkEntry(noYear, "apa").marker, "(Weatherford, n.d.)");
  // A book's Crossref "venue" may be its publisher or its series: left out rather than guessed.
  assert.equal(X.citedWorkSource({ ...OL_MATCH, provider: "crossref", venue: "Crown Publishers", venueType: "book" }).container, "");
  const article = X.citedWorkSource({ doi: "10.1177/02690942221098971", title: "Young people, youth work and the levelling up agenda", authors: ["Jon Ord", "Bernard Davies"], year: 2022, venue: "Local Economy", venueType: "journal", url: "http://dx.doi.org/10.1177/02690942221098971", provider: "crossref" });
  assert.equal(article.container, "Local Economy", "a journal article's venue is its journal");
  assert.equal(X.citedWorkEntry(article, "apa").entry, "Ord, J., & Davies, B. (2022). Young people, youth work and the levelling up agenda. Local Economy. https://doi.org/10.1177/02690942221098971");
  // Junk is dropped, not passed on.
  assert.deepEqual(plain(X.citedWorkSource({ title: 7, authors: [null, "A B", 3], year: "2004" })).authors, ["A B"]);
  assert.equal(X.citedWorkSource({ title: "T", year: "2004" }).year, null, "a year that is not a number is not a year");
});

test("the panel card shows the record's own lines, the year note, and a resolved work as the work CITED", () => {
  const c = { loading: false, resolved: true, matches: [X.citedWorkSource(OL_MATCH)], plan: { display: "Genghis Khan and the, 2022", citedYear: "2022" } };
  const html = X.citedWorkHtml(c, () => "<button>act</button>");
  assert.match(html, /The work you cited/);
  assert.match(html, /Jack Weatherford · 2004 · Open Library/);
  assert.match(html, /This record is from 2004; your citation says 2022\./);
  assert.match(html, /this is where your citation points, not proof the sentence is true/);
  const miss = X.citedWorkHtml({ loading: false, resolved: false, note: "Not found in Crossref or Open Library.", target: { segHash: "h" }, plan: {} }, () => "");
  assert.match(miss, /Not found in Crossref or Open Library\./);
  assert.match(miss, /Sources for the sentence instead/);
  assert.match(X.citedWorkHtml({ loading: true }, () => ""), /Looking up the work you cited/);
});

/* ── the sentence with the citation swapped ─────────────────────────────── */

test("building the replacement sentence: the record's marker in place of the faulty citation, the writer's page kept", () => {
  assert.equal(X.swapCitation(CITED, "(Genghis Khan and the, 2022)", "(Weatherford)", "mla"),
    "Some researchers have argued that literacy expanded in parts of the empire, but the extent remains uncertain (Weatherford).");
  assert.equal(X.swapCitation("A claim (Smith, 2019, p. 12).", "(Smith, 2019, p. 12)", "(Weatherford, 2004)", "apa"), "A claim (Weatherford, 2004, p. 12).");
  assert.equal(X.swapCitation("A claim (Smith, 2019, pp. 12-14).", "(Smith, 2019, pp. 12-14)", "(Weatherford, 2004)", "apa"), "A claim (Weatherford, 2004, pp. 12-14).");
  assert.equal(X.swapCitation("A claim (Shoup 45).", "(Shoup 45)", "(Weatherford)", "mla"), "A claim (Weatherford 45).");
  assert.equal(X.swapCitation("A claim (Shoup 2005, 45).", "(Shoup 2005, 45)", "(Weatherford 2004)", "chicago"), "A claim (Weatherford 2004, 45).");
  assert.equal(X.swapCitation("Trade grew [History.com / Gutenberg / accessed yesterday].", "[History.com / Gutenberg / accessed yesterday]", "(Weatherford)", "mla"), "Trade grew (Weatherford).", "an unusable bracket is replaced whole");
  assert.equal(X.citationPage("Genghis Khan and the, 2022"), null, "a year is not a page");
});

test("not replacing anything when the citation is not in the sentence exactly once", () => {
  assert.equal(X.swapCitation("Trade (Smith, 2019) and ideas (Smith, 2019).", "(Smith, 2019)", "(Weatherford)", "mla"), null, "twice: which copy is meant is a guess");
  assert.equal(X.swapCitation("Trade grew.", "(Smith, 2019)", "(Weatherford)", "mla"), null, "gone");
  assert.equal(X.swapCitation("Trade (Weatherford).", "(Weatherford)", "(Weatherford)", "mla"), null, "nothing would change");
  assert.equal(X.swapCitation(CITED, "", "(Weatherford)", "mla"), null);
});

test("counting a citation's uses: the body only, never the reference list", () => {
  const doc = `${CITED} More (Genghis Khan and the, 2022).\n\nWorks Cited\nX. (Genghis Khan and the, 2022).`;
  assert.equal(X.citationUses(doc, "(Genghis Khan and the, 2022)"), 2);
  assert.equal(X.citationUses(CITED + WORKS, "(Genghis Khan and the, 2022)"), 1);
});

/* ── which sentence a note is about ─────────────────────────────────────── */

test("a note's claim: an excuse is about the sentence before it, a hedge or an unnamed source about its own", () => {
  const segs = Array.from(X.segmentText(ESSAY));
  const tips = Array.from(X.citationTips(ESSAY, "mla", new Set()));
  const claimOf = (kind) => { const t = tips.find((x) => x.kind === kind); const i = X.claimSentenceIndex(kind, t.quote, segs); return i >= 0 ? segs[i].text : null; };
  assert.equal(claimOf("excuse"), "According to a Harvard study, the Mongols were always right about everything.");
  assert.equal(claimOf("placeholder"), "Some researchers have argued that literacy expanded across parts of the empire, but the evidence requires verification.");
  assert.equal(claimOf("vague"), "Some historians say the Mongols spread ideas everywhere.");
  // A note that is ALL its sentence is about the one before.
  const notes = Array.from(X.segmentText("The empire grew literate. This requires further verification."));
  assert.equal(X.claimSentenceIndex("placeholder", "This requires further verification.", notes), 0);
  assert.equal(X.claimSentenceIndex("excuse", notes[0].text, notes), -1, "an excuse with nothing before it has no claim");
});

test("tip targets: the bracket itself, the entry itself, and the owner's excuse points at the citation before it", () => {
  const segs = Array.from(X.segmentText(ESSAY));
  const tips = Array.from(X.citationTips(ESSAY, "mla", new Set()));
  const bad = X.tipCitedTarget(tips.find((t) => t.kind === "badcite"), segs);
  assert.equal(bad.raw, "[History.com / Gutenberg / accessed yesterday]");
  assert.match(bad.sentence, /^Trade grew under the Mongols/);
  assert.ok(bad.segHash);
  const polo = Array.from(X.referenceTips(ESSAY, new Set())).find((t) => t.kind === "refincomplete");
  assert.deepEqual(plain(X.tipCitedTarget(polo, segs)), { kind: "entry", entry: "Polo, Marco. Website about Mongolia. 2024. Page twelve.", inner: "Polo, Marco. Website about Mongolia. 2024. Page twelve.", raw: null, segHash: null, sentence: "" });
  assert.equal(X.tipCitedTarget(tips.find((t) => t.kind === "excuse"), segs), null, "the Harvard sentence cites nothing to look up");
  assert.equal(X.tipCitedTarget(tips.find((t) => t.kind === "vague"), segs), null);

  const ownerSegs = Array.from(X.segmentText(OWNER));
  const excuse = Array.from(X.citationTips(OWNER, "mla", new Set())).find((t) => t.kind === "excuse");
  assert.ok(excuse, "the owner's excuse is a tip");
  const t = X.tipCitedTarget(excuse, ownerSegs);
  assert.equal(t.raw, "(Genghis Khan and the, 2022)", "the excuse is about the date this citation is missing");
  assert.equal(t.sentence, CITED);
  // An essay-review note is looked up only when its quote carries a citation.
  assert.equal(X.tipCitedTarget({ kind: "citation", quote: CITED }, ownerSegs)?.raw, "(Genghis Khan and the, 2022)");
  assert.equal(X.tipCitedTarget({ kind: "source", quote: "The movement of ideas may have contributed to increased literacy in some parts of the empire." }, ownerSegs), null);
  assert.equal(X.tipCitedTarget({ kind: "refuncited", quote: "X" }, ownerSegs), null);
});

test("revision-quality still holds: no note supplies a date, and the lookup's own words never say 'fake'", () => {
  for (const t of X.citationTips(ESSAY, "mla", new Set())) assert.ok(!/\b(?:19|20)\d\d\b/.test(t.message), t.kind);
  for (const msg of [X.CITED_COPY.notFound, X.CITED_COPY.thin("Khan, 2022"), X.citedFailureNote({ kind: "forbidden" }), X.citedFailureNote({ offline: true }), X.citedFailureNote({ kind: "server", message: "boom" })]) {
    assert.ok(!/\bfake\b|fabricat|invented/i.test(msg), msg);
  }
});

/* ── the lookup ─────────────────────────────────────────────────────────── */

function loadLookup(api) {
  return vm.runInContext(`${HELPERS()}
    ${slice("  function offlineError(err) {", "  /* ── widget chrome (shared shadow-DOM shell)")}
    ({ lookupCitedWork })`, vm.createContext({ api }));
}

test("lookup: one call with the plan's citedRef, at most three records, each carrying only its own fields", async () => {
  const calls = [];
  const { lookupCitedWork } = loadLookup(async (p, b) => {
    calls.push({ p, b: plain(b) });
    return { resolved: true, matches: [OL_MATCH, { ...OL_MATCH, title: "Two" }, { ...OL_MATCH, title: "Three" }, { ...OL_MATCH, title: "Four" }, { title: "" }], nearMisses: [] };
  });
  const r = await lookupCitedWork({ citedRef: "Genghis Khan and the, 2022", thin: false, display: "Genghis Khan and the, 2022" });
  assert.deepEqual(calls, [{ p: "/api/compare-source", b: { citedRef: "Genghis Khan and the, 2022" } }], "the citation's words and nothing else");
  assert.equal(r.resolved, true);
  assert.deepEqual(r.matches.map((m) => m.title), ["Genghis Khan and the Making of the Modern World", "Two", "Three"]);
  assert.ok(!("relevance" in r.matches[0]) && !("citable" in r.matches[0]), "only what a citation is made of");
});

test("lookup: no confident match is said in the server's own words; a refusal or a failure is 'not checked'", async () => {
  const NOTE = "No confident match in Crossref or Open Library — only loosely related items were found. These indexes hold journal articles and books — government reports, news pages, and many web sources are in neither, so no match does NOT mean the source is fake. Verify it by hand instead.";
  const miss = await loadLookup(async () => ({ resolved: false, matches: [], nearMisses: [OL_MATCH], resolvedNote: NOTE })).lookupCitedWork({ citedRef: "x y", thin: false });
  assert.deepEqual(plain(miss), { resolved: false, matches: [], note: NOTE }, "near misses are never offered as the work cited");
  // A server from before 2.21.24 refuses the route by origin.
  const old = await loadLookup(async () => { throw Object.assign(new Error("Origin not allowed for this endpoint"), { kind: "forbidden" }); }).lookupCitedWork({ citedRef: "x y", thin: false });
  assert.equal(old.resolved, false);
  assert.match(old.note, /can't look up cited works yet, so this citation wasn't checked/);
  const down = await loadLookup(async () => { throw Object.assign(new Error("offline"), { kind: "no_engine", offline: true }); }).lookupCitedWork({ citedRef: "x y", thin: false });
  assert.match(down.note, /Couldn't reach Tracely/);
});

test("lookup: a citation too thin to name a work is never sent", async () => {
  let called = false;
  const r = await loadLookup(async () => { called = true; return {}; }).lookupCitedWork({ citedRef: "Khan, 2022", thin: true, display: "Khan, 2022" });
  assert.equal(called, false);
  assert.match(r.note, /doesn't name enough of a work/);
});

/* ── wired: both surfaces, every card that says a citation is the problem ── */

test("wired: the Docs card and panel, and the field panel, offer it; Cite replaces; the block says what it quotes", () => {
  const docs = SRC.slice(SRC.indexOf("function docsMode()"), SRC.indexOf("function fieldMode()"));
  const field = SRC.slice(SRC.indexOf("function fieldMode()"));
  for (const [name, mode] of [["docs", docs], ["field", field]]) {
    assert.match(mode, /for \(const card of shadow\.querySelectorAll\("\.card\[data-card\]"\)\) decorateCard\(card, cardSources\);/, name);
    assert.match(mode, /shadow\.querySelectorAll\("\[data-cited\]"\)\) btn\.addEventListener\("click", \(\) => findCitedWork\(btn\.dataset\.cited\)\)/, name);
    // (Docs also starts the search on the press: ext-live-search.test.js.)
    assert.match(mode, /shadow\.querySelectorAll\("\[data-claim-src\]"\)\)(?: \{\s+btn\.addEventListener\("pointerdown", \(\) => prestartClaim\(btn\.dataset\.claimSrc\)\);\s+| )btn\.addEventListener\("click", \(\) => findClaimSource\(btn\.dataset\.claimSrc\)\)/, name);
    assert.match(mode, /if \(!r\.resolved && target\.segHash\) startClaimSources\(key, target\.segHash, target\.sentence\);/, `${name}: an unresolved lookup falls into the sentence's search`);
  }
  assert.match(docs, /docCite\(btn\.dataset\.docCite, btn\.dataset\.i, null, replaceFor\(btn\.dataset\.docCite\)\)/, "the panel's Cite in doc replaces the faulty citation");
  assert.match(docs, /docCite\(hash, i, popAnchor, replaceFor\(hash\)\)/, "and the hover card's");
  assert.match(field, /data-src-replace="\$\{seg\.hash\}"/, "the field panel's twin of Cite in doc");
  assert.match(docs, /if \(pst\.step === "cited" && citedMap\.has\(hash\)\) \{ paintCited\(hash, put\); requestPlace\(\); return; \}/);
  assert.match(docs, /const citedHere = Boolean\(flaggedCitationOf\(f\.verdict, seg\.text\)\);/);
  // The hover card's block names what it quotes (it said REFERENCE over sentences).
  const label = vm.runInContext(`${slice("  // Bibliography block", "  function esc(s) {")}
    ${slice("    function citeTipBlockLabel(tip) {", "    function paintCiteTip(tip, put) {")}
    citeTipBlockLabel`, vm.createContext({ hashText: () => "h", CHECK_INTERVAL_MS: 1 }));
  assert.deepEqual(["excuse", "placeholder", "vague", "badcite", "page", "refincomplete", "refdup"].map((kind) => label({ kind })),
    ["SENTENCE", "SENTENCE", "SENTENCE", "CITATION", "QUOTED", "REFERENCE", "REFERENCE"]);
  assert.equal(label({ kind: "citation", markKind: "note_tip" }), "SENTENCE");
});

/* ── the modes' own halves, run with stubs ──────────────────────────────── */

// A rendered panel card: what decorateCard adds lands in `inserted`.
function fakeCard(key, { tip = false } = {}) {
  const inserted = [];
  const at = (name) => ({ insertAdjacentHTML: (where, html) => inserted.push({ at: name, where, html }) });
  return {
    inserted, html: () => inserted.map((x) => x.html).join(""), dataset: { card: key },
    classList: { contains: (c) => c === "tip-card" && tip },
    insertAdjacentHTML: (where, html) => inserted.push({ at: "card", where, html }),
    querySelector: (sel) => (!tip && (sel === ".row" || sel === ".cite-url") ? at(sel) : null),
  };
}
const RESOLVED = { resolved: true, matches: [OL_MATCH], nearMisses: [] };
const NOT_FOUND = { resolved: false, matches: [], nearMisses: [], resolvedNote: "Not found in Crossref or Open Library. These indexes hold journal articles and books — government reports, news pages, and many web sources are in neither, so no match does NOT mean the source is fake. Verify it by hand instead." };

function loadDocsCited(text, verdicts, answer) {
  const fetched = [];
  const ctx = vm.createContext({ api: async (p, b) => { ctx.calls.push({ p, b: plain(b) }); return answer; }, calls: [], fetched });
  const w = vm.runInContext(`${HELPERS("{ citeHintsToggle: false, refList: true, essayFeedback: true }")}
    ${slice("  function offlineError(err) {", "  /* ── widget chrome (shared shadow-DOM shell)")}
    let docText = ${JSON.stringify(text)};
    let segments = segmentText(docText);
    const VERDICTS = ${JSON.stringify(verdicts)};
    const cache = new Map(segments.filter((s) => VERDICTS[s.text]).map((s) => [s.hash, { verdict: VERDICTS[s.text] }]));
    const settings = { citationStyle: "mla" }, dismissed = new Set(), review = { kind: null, findings: [] };
    let docGenre = "prose";
    const tipMarkById = new Map(), sourcesMap = new Map(), docEditState = new Map(), popSteps = new Map();
    const stepOf = (h) => popSteps.get(h) ?? { step: "problem" };
    function setStep(h, patch) { popSteps.set(h, { ...stepOf(h), ...patch }); }
    let popEl = null, popHash = null, renders = 0;
    function paintPop() {}
    function render() { renders++; }
    async function fetchSources(h) { fetched.push(h); return true; }
    const canEditDoc = () => true;
    function editState(k) { return docEditState.get(k)?.state ?? null; }
    function editBtnHtml(key, idle, attrs) { return "<button " + attrs + ">" + idle + "</button>"; }
    function editNoteHtml() { return ""; }
    const POP_COPY = { findSource: "Find a source" };
    const citedMap = new Map(), citedFallback = new Map(); // docsMode's state
    let copiedCitedKey = null;
    ${slice('    /* ── "Find the cited work" ─', "    /* ── editing the document")}
    ({ decorateCard, findCitedWork, findClaimSource, replaceFor, citedMap, popSteps, segments, allTips })`, ctx);
  return { w, ctx, fetched };
}

test("Docs panel: a cited card offers it, shows the record with Replace citation and Copy reference, and Cite then replaces", async () => {
  const doc = OWNER + WORKS;
  const { w, ctx } = loadDocsCited(doc, { [CITED]: "questionable" }, RESOLVED);
  const h = w.segments.find((s) => s.text === CITED).hash;
  const card = fakeCard(h);
  w.decorateCard(card, () => "");
  assert.match(card.html(), /data-cited="[^"]+">Find the cited work</);
  await w.findCitedWork(h);
  assert.deepEqual(ctx.calls, [{ p: "/api/compare-source", b: { citedRef: "Weatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004." } }], "the Works Cited entry, being richer");
  const after = fakeCard(h);
  w.decorateCard(after, () => "");
  const html = after.html();
  assert.match(html, /The work you cited/);
  assert.match(html, /Genghis Khan and the Making of the Modern World/);
  assert.match(html, /This record is from 2004; your citation says 2022\./);
  assert.match(html, /data-cited-replace="[^"]+" data-i="0">Replace citation</);
  assert.match(html, /data-cited-copy="[^"]+" data-i="0">Copy reference</);
  assert.match(html, /data-cited-more="[^"]+">Find a different source</);
  assert.equal(w.replaceFor(h), "(Genghis Khan and the, 2022)", "a source cited from here takes the faulty citation's place");
  assert.equal(w.popSteps.get(h).step, "cited");
});

test("Docs panel: nothing resolves — the server's note, then the sentence's own search, which a Cite then replaces into", async () => {
  const { w, fetched } = loadDocsCited(OWNER, { [CITED]: "questionable" }, NOT_FOUND);
  const h = w.segments.find((s) => s.text === CITED).hash;
  await w.findCitedWork(h);
  assert.deepEqual(fetched, [h], "fell straight into Find a source for the sentence");
  assert.equal(w.popSteps.get(h).step, "sources");
  const card = fakeCard(h);
  w.decorateCard(card, () => "");
  assert.match(card.html(), /no match does NOT mean the source is fake/, "the server's own words");
  assert.match(card.html(), /Sources for the sentence instead/);
  assert.equal(w.replaceFor(h), "(Genghis Khan and the, 2022)");
});

test("Docs panel: the owner's excuse is deleted, and the citation it excuses looked up — never a search to cite the excuse", async () => {
  // Owner, 2026-10-08: "tracely is trying to cite this instead of remove it".
  // Find the cited work still falls into the claim's search when nothing
  // resolves (below), so no separate Find a source sits beside it.
  const { w, fetched } = loadDocsCited(OWNER, {}, RESOLVED);
  const excuse = w.allTips().find((t) => t.kind === "excuse");
  const card = fakeCard(excuse.id, { tip: true });
  w.decorateCard(card, () => "");
  assert.match(card.html(), /<button data-tip-del="[^"]+">Delete this sentence<\/button><button class="act" data-cited="[^"]+">Find the cited work<\/button>/);
  assert.ok(!/data-claim-src=/.test(card.html()), "no search to cite the excuse");
  w.findClaimSource(excuse.id);
  const claim = w.segments.find((s) => s.text === CITED).hash;
  assert.deepEqual(fetched, [claim], "the claim the note excuses, not the note");
  assert.equal(w.replaceFor(claim), "(Genghis Khan and the, 2022)", "and citing a source there replaces the dateless citation");
  const next = fakeCard(excuse.id, { tip: true });
  w.decorateCard(next, (seg) => `[sources for ${seg.text.slice(0, 24)}]`);
  assert.match(next.html(), /\[sources for Some researchers have ar\]/, "the claim's sources, under the note's card");
  // A vague attribution: a source for its own sentence, nothing to look up.
  const essay = loadDocsCited(ESSAY, {}, RESOLVED);
  const vague = essay.w.allTips().find((t) => t.kind === "vague");
  const v = fakeCard(vague.id, { tip: true });
  essay.w.decorateCard(v, () => "");
  assert.match(v.html(), /class="act primary" data-claim-src="[^"]+">Find a source</);
  assert.ok(!/data-cited=/.test(v.html()));
});

test("Docs panel: a note whose fix is taking words out gets Delete; a quote missing its page gets the page box", () => {
  // Owner, 2026-10-08: "when there is an unamed source, there is only a
  // dismiss button when there should be one to fix it" (ext-card-fixes.test.js).
  const { w } = loadDocsCited(ESSAY, {}, RESOLVED);
  const uncited = w.allTips().find((t) => t.kind === "refuncited");
  const card = fakeCard(uncited.id, { tip: true });
  w.decorateCard(card, () => "");
  assert.match(card.html(), /^<div class="row"><button data-tip-del="[^"]+">Remove from list<\/button>/, "the note's own fix comes first");
  const stray = "Trade grew under the Mongols across Eurasia. This does not prove anything about trade.\nMerchants carried paper money along the Silk Road.";
  const s = loadDocsCited(stray, {}, RESOLVED);
  const key = "This does not prove anything about trade.|residue"; // offTopicTips' id, under HELPERS' hashText
  const residue = fakeCard(`tip:h${key.length}${key.slice(0, 24)}`, { tip: true });
  s.w.decorateCard(residue, () => "");
  assert.match(residue.html(), /data-tip-del="[^"]+">Delete it</, "a panel-only note (no underline) is found too");
  const quoted = 'Gatsby believed in "the orgastic future that year by year recedes before us" (Fitzgerald).';
  const g = loadDocsCited(quoted, {}, RESOLVED);
  const page = g.w.allTips().find((t) => t.kind === "page");
  const pc = fakeCard(page.id, { tip: true });
  g.w.decorateCard(pc, () => "");
  assert.match(pc.html(), /<input type="text" inputmode="numeric" placeholder="Page number, e\.g\. 45" aria-label="Page number" data-page-input="[^"]+" value="" \/><button data-tip-page="[^"]+">Add page<\/button>/);
  assert.ok(!/data-tip-del=/.test(pc.html()), "a missing page is added, never deleted");
});

test("Docs panel: an incomplete entry is looked up by its own text and offers Complete entry", async () => {
  const { w, ctx } = loadDocsCited(ESSAY, {}, { resolved: true, matches: [{ ...OL_MATCH, title: "The Travels of Marco Polo", authors: ["Marco Polo"], year: 1958 }] });
  const polo = w.allTips().find((t) => t.kind === "refincomplete");
  await w.findCitedWork(polo.id);
  assert.equal(ctx.calls[0].b.citedRef, "Polo, Marco. Website about Mongolia. 2024. Page twelve.");
  const card = fakeCard(polo.id, { tip: true });
  w.decorateCard(card, () => "");
  assert.match(card.html(), /data-cited-entry="[^"]+" data-i="0">Complete entry</);
  assert.match(card.html(), /This record is from 1958; your citation says 2024\./);
  assert.ok(!/Find a different source/.test(card.html()), "an entry has no sentence to search for");
});

test("field mode: Replace citation rewrites the sentence and the writer's own entry in the field, and reads it back", async () => {
  const OLD = "Khan, G. Genghis Khan and the. History.com, 2022.";
  const text = `${OWNER}\n\nWorks Cited\n${OLD}`;
  class HTMLTextAreaElement {
    constructor(v) { this.value = v; this.isConnected = true; }
    focus() {}
    dispatchEvent() { return true; }
    setRangeText(r, s, e) { this.value = this.value.slice(0, s) + r + this.value.slice(e); }
  }
  const el = new HTMLTextAreaElement(text);
  const copied = [];
  const ctx = vm.createContext({ HTMLTextAreaElement, Event: class { constructor(t) { this.type = t; } }, el, api: async () => RESOLVED, navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } } });
  const f = vm.runInContext(`${HELPERS("{ citeHintsToggle: false, refList: true, essayFeedback: true }")}
    ${slice("  function offlineError(err) {", "  /* ── widget chrome (shared shadow-DOM shell)")}
    let fieldText = el.value;
    let segments = segmentText(fieldText);
    const cache = new Map([[segments.find((s) => s.text === ${JSON.stringify(CITED)}).hash, { verdict: "questionable" }]]);
    const settings = { citationStyle: "mla" }, dismissed = new Set(), review = { kind: null, findings: [] };
    let docGenre = "prose", statusKind = "idle", statusMsg = "", lastCheckEnd = 0, lastTextChangeAt = 0;
    const sourcesMap = new Map();
    let tracked = el;
    function render() {}
    function fetchSources() {}
    function copyText() {}
    function readField(x) { return x.value; }
    function nativeValueSetter() { return null; }
    function buildTextIndex() { throw new Error("a textarea never builds one"); }
    function rangeForOffsets() { return null; }
    const citedMap = new Map(), citedFallback = new Map(), claimSearch = new Map();
    let copiedCitedKey = null;
    ${slice('    /* ── "Find the cited work" (docs mode\'s, on a field)', "    /* ── in-place fix — the point of field mode")}
    ({ findCitedWork, fieldReplaceCitation, citedMap, segments, state: () => ({ statusMsg }) })`, ctx);
  const h = f.segments.find((s) => s.text === CITED).hash;
  await f.findCitedWork(h);
  f.fieldReplaceCitation(h, "0");
  assert.equal(el.value, `${OWNER.replace("(Genghis Khan and the, 2022)", "(Weatherford)")}\n\nWorks Cited\nWeatherford, Jack. Genghis Khan and the Making of the Modern World. 2004.`);
  assert.equal(f.state().statusMsg, "citation replaced and its reference entry");
  assert.equal(f.citedMap.get(h).done.i, 0);
  assert.deepEqual(copied, [], "nothing to paste: both halves went in");
});

/* ── the server and the relay ───────────────────────────────────────────── */

test("the route is on the extension's surface, gated as a lookup, and relayed by the background worker", () => {
  const set = (name) => SERVER.slice(SERVER.indexOf(`const ${name} = new Set([`), SERVER.indexOf("]);", SERVER.indexOf(`const ${name} = new Set([`)));
  for (const name of ["EXTENSION_API", "PAID_ROUTES", "LOOKUP_ROUTES"]) assert.ok(set(name).includes('"/api/compare-source"'), `${name} lists /api/compare-source`);
  for (const name of ["MODEL_ROUTES", "EXTENSION_MODEL_ROUTES", "SOURCE_ROUTES", "APP_AI_ROUTES"]) assert.ok(!set(name).includes('"/api/compare-source"'), `${name} must not: it reaches no model and runs no web search`);
  assert.match(SERVER, /kind: LOOKUP_ROUTES\.has\(url\.pathname\) \? "lookup" : SOURCE_ROUTES\.has\(url\.pathname\) \? "sources" : "check",/);
  // A lookup reserves nothing and is never refused for the day's model budget: it spends none.
  const gate = SERVER.slice(SERVER.indexOf("async function spendGate("), SERVER.indexOf("let pick = null;", SERVER.indexOf("async function spendGate(")));
  // The only refusals before the early return are the two rate windows: the
  // shared one (checked first, stamped last) and the caller's own.
  assert.match(gate, /if \(kind === "lookup"\) \{\s*if \(ent\.enforced && !lookupGlobalRate\.ok\("all"\)\) \{\s*throw new CheckError\("rate_limit", [^\n]*\);\s*\}\s*stampCallerRate\(ent, id, kind\);\s*if \(ent\.enforced\) lookupGlobalRate\.stamp\("all"\);\s*return \{ ent, holder: ent, callerId: id, budget: null, pool: null, reservation: null, modelCeiling: null \};/);
  assert.ok(!/"\/api\/compare-source":/.test(SERVER.slice(SERVER.indexOf("const WORST_CALL = {"), SERVER.indexOf("};", SERVER.indexOf("const WORST_CALL = {")))), "no worst-case hold");
  assert.match(SERVER, /const rate = kind === "sources" \? sourceRate : kind === "lookup" \? lookupRate : checkRate;/);
  assert.match(BG, /const API_PATHS = new Set\(\[[^\]]*"\/api\/compare-source"/, "or api() fails with 'No reply from the Tracely background worker'");
  // Appended at the end: the frozen routes keep their place and their meaning.
  assert.match(SERVER, /"\/api\/entitlement", "\/api\/account", "\/api\/compare-source"(?:, "\/api\/sources\/stream")?\]\);/); // append-only: later routes follow it
});

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
let BASE, child;
test.before(async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    let exited = false;
    child = spawn(process.execPath, [path.join(HERE, "..", "server.js")], {
      env: {
        ...process.env, TRACELY_MOCK: "1", PORT: String(port),
        TRACELY_DATA_DIR: mkdtempSync(path.join(tmpdir(), "tracely-cited-")),
        SUPABASE_URL: "https://cited-work-test.invalid", SUPABASE_ANON_KEY: "anon",
        TRACELY_LLM_PROVIDER: "", TRACELY_EXTENSION_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("exit", () => { exited = true; });
    for (let i = 0; i < 100 && !exited; i++) {
      try { if ((await fetch(`${BASE}/api/status`)).ok && !exited) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();
    if (!exited) break;
  }
  throw new Error("server did not start");
});
test.after(() => child?.kill());

const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const call = (p, body, install) => fetch(`${BASE}${p}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: EXT_ORIGIN, "X-Tracely-Install": install },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, acao: r.headers.get("access-control-allow-origin"), body: await r.json().catch(() => ({})) }));

test("over HTTP: the extension's origin is admitted, a burst is limited per caller, and lookups leave the source-search window alone", async () => {
  // An empty citedRef is refused AFTER the gate — no network leaves the test.
  const first = await call("/api/compare-source", {}, "lookup-user");
  assert.equal(first.status, 400, JSON.stringify(first.body));
  assert.equal(first.body.error.kind, "bad_request", "admitted: not 403 'Origin not allowed for this endpoint'");
  assert.equal(first.acao, EXT_ORIGIN, "and readable by the extension");
  const pre = await fetch(`${BASE}/api/compare-source`, { method: "OPTIONS", headers: { Origin: EXT_ORIGIN, "Access-Control-Request-Method": "POST" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /X-Tracely-Install/);

  let refused = null;
  for (let i = 0; i < 15 && !refused; i++) {
    const r = await call("/api/compare-source", {}, "lookup-burst");
    if (r.status === 429) refused = { n: i + 1, ...r };
  }
  assert.ok(refused, "fifteen lookups in a minute were all admitted");
  assert.equal(refused.n, 11, "ten a minute (SPEND.callerLookupsPerMinute)");
  assert.equal(refused.body.error.kind, "rate_limit");
  // Ten lookups did not spend /api/sources' four-a-minute window: the same
  // caller's source search is still admitted (refused only for its empty claim).
  const sources = await call("/api/sources", { claim: "" }, "lookup-burst");
  assert.equal(sources.status, 400, JSON.stringify(sources.body));
  // And another caller is untouched by this one's burst.
  assert.equal((await call("/api/compare-source", {}, "someone-else")).status, 400);
});

test("over HTTP: every caller together is held to SPEND.globalLookupsPerMinute, so rotating install ids cannot flood Crossref", async () => {
  // Fresh install ids, each kept under its own ten-a-minute window, until the
  // shared window refuses. The earlier test already spent some of it, so the
  // refusal must come at or before the sixty-first admitted lookup.
  let admitted = 0;
  let refused = null;
  for (let caller = 0; caller < 10 && !refused; caller++) {
    for (let i = 0; i < 9 && !refused; i++) {
      const r = await call("/api/compare-source", {}, `rotating-${caller}`);
      if (r.status === 429) refused = r;
      else admitted++;
    }
  }
  assert.ok(refused, "ninety lookups from rotating ids were all admitted");
  assert.ok(admitted <= 60, `refused only after ${admitted} admitted lookups`);
  assert.equal(refused.body.error.kind, "rate_limit");
  assert.match(refused.body.error.message, /busy right now/);
  // The shared window, not a caller's: an id never seen before is refused too.
  const fresh = await call("/api/compare-source", {}, "never-seen-before");
  assert.equal(fresh.status, 429);
  assert.match(fresh.body.error.message, /busy right now/);
});
