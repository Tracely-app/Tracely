/* The panel, restructured (extension 2.21.31). Owner, 2026-10-08, on a
 * screenshot of the Docs panel — "Citation tips (2)" under a header that
 * read "all clear", every card open, a full-width black bar per button:
 * "make this more organized polished … restructure it".
 *   - one list, most serious first: Claims, Citations (the citation notes and
 *     the reference list's), Writing feedback (the review's notes and the
 *     stray lines), then the optional evidence;
 *   - one card open at a time (foldCards); the rest are a title and a line;
 *   - a header that says what the list holds: "2 notes · no claims flagged",
 *     never "all clear" over open notes;
 *   - the card on "… uncertain (Shiraishi)." says what is wrong with it — a
 *     citation that names a person, not a work — and looks the person's
 *     works up, instead of calling it an unnamed source;
 *   - the excuse card's text no longer names a button it may not show. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const ESSAY = readFileSync(path.join(ROOT, "eval", "revision", "flawed-mongols.txt"), "utf8").replace(/\r\n/g, "\n");
const plain = (v) => JSON.parse(JSON.stringify(v));

const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false };
  function hashText(s) { return "h" + s.length + s.slice(0, 24); }
  ${sliceBetween(SRC, "  const MARK_COLORS =", "\n")}
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ citationTips, tipCitedTarget, citedLookupPlan, segmentText, panelHeadHtml, tallyOf, tipsSectionHtml, citationTipsHtml, cardListHtml, groupHtml, foldCards, kindIcoHtml,
     focus: () => focusCard, setFocus: (k) => { focusCard = k; }, filter: () => panelFilter, setFilter: (k) => { panelFilter = k; } })`, vm.createContext({}));

const SENT = "Some researchers have argued that literacy expanded in parts of the empire, but the extent remains uncertain (Shiraishi).";
const DOC = ESSAY.replace(/Some researchers have argued that literacy expanded[^.]*\./, SENT);

test("(Shiraishi): a citation that names a person, not a work — and the card looks that person's works up", () => {
  assert.ok(DOC.includes(SENT));
  const tips = Array.from(X.citationTips(DOC, "mla", new Set()));
  const tip = tips.find((t) => t.quote === SENT);
  assert.equal(tip?.kind, "nameonly", "not 'Unnamed source': it names Shiraishi");
  assert.match(tip.message, /^\(Shiraishi\) names a person, not which of their works you mean\. Find the cited work lists what Shiraishi has published on this subject/);
  const segs = X.segmentText(DOC);
  const target = X.tipCitedTarget(tip, segs);
  assert.deepEqual(plain({ raw: target.raw, inner: target.inner, sentence: target.sentence }), { raw: "(Shiraishi)", inner: "Shiraishi", sentence: SENT });
  assert.ok(target.segHash, "the sentence is found, so a lookup that answers nothing searches for it");
  assert.equal(X.citedLookupPlan(target, DOC).author, "Shiraishi", "the #318 author lookup");
});

test("(Name) only where it is a citation the reader cannot follow", () => {
  const kinds = (text) => Array.from(X.citationTips(text, "mla", new Set())).map((t) => t.kind);
  const P = "The Mongol Empire grew quickly across Asia. ";
  assert.deepEqual(kinds(P + "Scholars have argued that trade grew along the routes (Weatherford and Allsen)."), ["nameonly"]);
  assert.deepEqual(kinds(P + "Many historians have found that trade grew (Allsen et al.)."), ["nameonly"]);
  assert.deepEqual(kinds(P + "The alliance stated its aims for the region (NATO)."), [], "an acronym is not a name");
  assert.deepEqual(kinds(P + "The capital moved to the steppe city (Karakorum)."), [], "nothing reported, so a place, not a citation");
  assert.deepEqual(kinds(P + "Weatherford argued that trade grew along the routes (Weatherford 45)."), [], "a page makes it a citation");
  const listed = P + "Scholars have argued that trade grew along the routes (Weatherford).\n\nWorks Cited\n\nWeatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004.";
  assert.ok(!kinds(listed).includes("nameonly"), "MLA's bare name for an unpaginated source, with its entry, is a citation");
  assert.ok(kinds(P + "Some researchers have argued that literacy expanded.").includes("vague"), "no citation at all is still an unnamed source");
});

test("the excuse card's text names no button the card may not show", () => {
  const tip = Array.from(X.citationTips("The source is useful. The study does not need a publication date because Harvard is a famous institution.", "mla", new Set())).find((t) => t.kind === "excuse");
  assert.ok(tip);
  assert.ok(!/Find the cited work|Find a source/.test(tip.message));
});

/* The header. Since 2.21.33 (owner, 2026-10-08: "it says how many of each
 * thing is wrong … 2 wrong citations with a little icon next to it, and 4
 * wrong factual pieces with another little red icon") one count per kind,
 * each with its own icon in its finding's colour. Since 2026-10-14 (owner:
 * the panel was "too cluttered, confusing, not well structured, wordy";
 * the Figma frame "Overlay Mockup - Widget (Clean)") the counts are one row
 * of tabs — the count, the filter and the legend at once — with the long
 * words as each tab's title, and the mark beside the name in one solid colour. */
const tabsOf = (h) => [...h.matchAll(/<button class="tab( on)?" data-filter="(\w+)" aria-pressed="(true|false)" title="([^"]*)">(?:<span class="kico k-(\w+)" aria-hidden="true"><svg[\s\S]*?<\/svg><\/span>)?<span>([^<]*)<\/span><span class="tab-n">(\d+)<\/span><\/button>/g)]
  .map((m) => `${m[2]}|${m[6]} ${m[7]}|${m[5] ?? ""}|${m[4]}${m[1] ? "|on" : ""}`);
test("the header: the mark, then one row of tabs that counts each kind with its icon — never 'all clear' over open notes", () => {
  const status = (h) => h.match(/<span class="status[^"]*">([^<]*)</)[1];
  const c = plain(X.tallyOf(["false", "incoherent", "false", "false", "questionable", "needs_citation"],
    [{ kind: "vague" }, { kind: "uncited" }, { kind: "refdup" }, { kind: "evidence" }, { kind: "offtopic" }, { kind: "bullet" }]));
  // Owner, 2026-10-14: a source nobody could find needs evidence; a named one not cited is a citation issue.
  assert.deepEqual(c, { wrong: 4, check: 2, cite: 3, writing: 3 }, "an unnamed source needs evidence; a missing citation counts with the citation notes; stray lines and resume tips are writing");
  X.setFilter(null);
  const h = X.panelHeadHtml(c, "6 issues found", false);
  assert.deepEqual(tabsOf(h), [
    "all|All 12||Show every finding|on",
    "wrong|Errors 4|wrong|4 factual errors", "check|Evidence 2|check|2 need evidence", "cite|Citations 3|cite|3 citation issues", "writing|Writing 3|writing|3 writing notes",
  ], "the owner's '4 wrong factual pieces' with a red icon, '2 wrong citations' with its own — the long words on hover");
  assert.match(h, /^<div class="head" id="dragHead"[^>]*>\s*<svg class="head-mark" viewBox="0 0 399\.44 405\.46" aria-hidden="true"><path fill="currentColor" d="M399/, "the mark first, in one colour");
  assert.match(h, /<button class="hbtn" id="panelSettings"[\s\S]*<button class="hbtn close" id="panelClose" title="Close" aria-label="Close"><svg/);
  assert.equal(status(h), "", "never '6 issues found' beside the counts");
  assert.deepEqual(tabsOf(X.panelHeadHtml({ cite: 2 }, "all clear", false)), ["all|All 2||Show every finding|on", "cite|Citations 2|cite|2 citation issues"], "the owner's screenshot: two citation notes, no 'all clear'");
  assert.ok(!/All clear/.test(X.panelHeadHtml({ cite: 2 }, "all clear", false)));
  assert.match(X.panelHeadHtml({}, "all clear", false), /<span class="tabs-clear">[\s\S]*All clear<\/span>/, "nothing open, check done");
  assert.ok(!/All clear|class="tabs"/.test(X.panelHeadHtml({}, "checking 3…", false)), "not before the check says so, and no empty row of tabs");
  assert.equal(status(X.panelHeadHtml({}, "checking 3…", false)), "checking 3…");
  assert.equal(status(X.panelHeadHtml({ wrong: 2 }, "Could not reach Tracely", true)), "Could not reach Tracely", "an error always shows");
  // The chosen tab is pressed; a kind with nothing left falls back to All.
  X.setFilter("cite");
  assert.deepEqual(tabsOf(X.panelHeadHtml(c, "", false)).filter((t) => t.endsWith("|on")), ["cite|Citations 3|cite|3 citation issues|on"]);
  assert.deepEqual(tabsOf(X.panelHeadHtml({ wrong: 1 }, "", false)).filter((t) => t.endsWith("|on")), ["all|All 1||Show every finding|on"]);
  X.setFilter(null);
  // The chip's hover says what the kind of writing means; the mode's off switch sits before Settings.
  const withOpts = X.panelHeadHtml({}, "", false, "Research paper", { note: "Reading this as a research paper — every finding needs an in-text citation", power: "<button id=\"turnOff\"></button>" });
  assert.match(withOpts, /<span class="kind" title="Reading this as a research paper — every finding needs an in-text citation">Research paper<\/span>/);
  assert.match(withOpts, /<button id="turnOff"><\/button>\s*<button class="hbtn" id="panelSettings"/);
  // Both panels count what their list shows; a tab filters it.
  assert.equal((SRC.match(/const tally = tallyOf\(issues\.map\(\(\{ f \}\) => f\.verdict\), \[\.\.\.citeTips, \.\.\.refTips, \.\.\.essayNotes, \.\.\.offTopic, \.\.\.resumeList\]\);/g) || []).length, 2);
  // The fourth argument is the kind of writing (ext-writing-kind.test.js), the fifth its note and the off switch.
  assert.equal((SRC.match(/\$\{panelHeadHtml\(tally, statusMsg, statusKind === "error" \|\| statusKind === "offline", kindTitle\(docShown, (docText|fieldText)\), \{ note: genreNote\(docGenre, \1, settings\.citationStyle, docShown\), power(?:: enabled \? siteSwitch : "")? \}\)\}/g) || []).length, 2);
  assert.equal((SRC.match(/<div class="card" data-card="\$\{seg\.hash\}" data-cat="\$\{verdictCat\(f\.verdict\)\}">/g) || []).length, 2);
  assert.match(SRC, /<div class="card tip-card" data-card="\$\{t\.id\}" data-cat="\$\{tipCat\(t\)\}">/);
  assert.match(SRC, /for \(const tab of shadow\.querySelectorAll\("\[data-filter\]"\)\) \{\n\s+tab\.addEventListener\("click", \(\) => \{\n\s+const k = tab\.dataset\.filter;\n\s+panelFilter = k === "all" \|\| k === panelFilter \? null : k;/, "All, or the chosen tab again, shows every kind");
});

test("no countdown in the panel; the header is the handle that moves it", () => {
  assert.ok(!/countdownTxt|next check in/.test(SRC), "owner: 'remove the next check timer thing'");
  assert.match(SRC, /function wireChrome\(shadow, close, rerender\) \{[\s\S]*?wireDrag\(shadow\);/);
  assert.match(SRC, /head\.addEventListener\("pointerdown", \(e\) => \{\n\s+if \(e\.button !== 0 \|\| e\.target\.closest\?\.\("button, a, input, label, select"\)\) return;/, "dragged by the header, never by its buttons");
  assert.match(SRC, /const PANEL_POS_KEY = "tracely\.widget\.panelPos";/, "remembered");
  assert.match(SRC, /head\.addEventListener\("dblclick"/, "and put back by a double-click");
  const X2 = vm.runInContext(`const innerWidth = 1000, innerHeight = 700; ${sliceBetween(SRC, "  const panelSpot =", "  function placePanel(")} ({ panelSpot })`, vm.createContext({}));
  assert.deepEqual(plain(X2.panelSpot(-50, -50, 480, 600)), { x: 8, y: 8 }, "never off the top or the left");
  assert.deepEqual(plain(X2.panelSpot(900, 600, 480, 600)), { x: 512, y: 92 }, "nor off the right or the bottom");
  assert.deepEqual(plain(X2.panelSpot(100.4, 50.6, 480, 600)), { x: 100, y: 51 });
});

test("one list, most serious first: Claims, Citations, Writing feedback, then evidence", () => {
  // The groups' names are for a screen reader since 2026-10-14: the tabs name the kinds.
  assert.equal(X.groupHtml("Claims", 2, "<i></i>"), `<div class="tips" role="group" aria-label="Claims (2)"><i></i></div>`);
  assert.equal(X.cardListHtml([{ hash: "a", html: "<a>" }, { hash: "b", html: "<b>" }]), "<a><b>", "every card; foldCards keeps one open");
  assert.equal((SRC.match(/const claimsHtml = cardsHtml \? groupHtml\("Claims", cards\.length, cardsHtml\) : "";/g) || []).length, 2);
  assert.equal((SRC.match(/\$\{GENRE_QUIET\.has\(docGenre\) \? genreHtml : ""\}\$\{claimsHtml\}\$\{tipsHtml\}/g) || []).length, 2, "claims above the notes, in both panels; the kind of writing's line only where it explains an empty panel");
  assert.equal((SRC.match(/\$\{claimsHtml\}/g) || []).length, 2, "and once each: the empty note only asks whether there is any");
  assert.equal((SRC.match(/\$\{claimsHtml \|\| (?:flowCards \|\| )?tipsHtml (?:\|\| GENRE_QUIET\.has\(docGenre\) )?\? "" : `<div class="empty">/g) || []).length, 2);
  assert.ok(!/showAllCards|id="showAll"/.test(SRC), "the one-card view and its Show all are gone: the fold replaces them");
  // A note's icon is its underline's kind and colour; a note with no underline has none.
  const html = X.tipsSectionHtml("T", [
    { id: "tip:1", kind: "nameonly", quote: "q", message: "m", suggestion: "" },
    { id: "tip:2", kind: "evidence", quote: "q", message: "m", suggestion: "" },
    { id: "tip:3", kind: "offtopic", quote: "q", message: "m", suggestion: "" },
  ], "", null);
  assert.deepEqual(html.match(/class="kico [^"]*"/g), ['class="kico k-cite"', 'class="kico k-writing"'], "a writing note's icon is the writing one (blue, owner, 2026-10-13)");
  assert.equal(X.kindIcoHtml("nope"), "", "no icon for a kind the header doesn't count");
});

/* foldCards against the smallest DOM it reads. */
function fakeCard(key, cat = "wrong") {
  const handlers = {};
  const attrs = {};
  const cls = new Set(["card"]);
  return {
    dataset: { card: key, cat }, handlers, attrs, tabIndex: -1,
    classList: { add: (c) => cls.add(c), has: (c) => cls.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; },
    addEventListener: (t, f) => { handlers[t] = f; },
    shut: () => cls.has("shut"),
    out: () => cls.has("out"),
  };
}
const fakeShadow = (cards) => ({ querySelectorAll: (sel) => { assert.equal(sel, ".list .card[data-card]:not(.ev-card)"); return cards; } });

test("one card open at a time: the clicked one, else the first — kept open while new cards land above it", () => {
  let renders = 0;
  const rerender = () => { renders++; };
  X.setFocus(null);
  let cards = ["tip:a", "tip:b", "h3"].map(fakeCard);
  X.foldCards(fakeShadow(cards), rerender);
  assert.deepEqual(cards.map((c) => c.shut()), [false, true, true], "the first is open");
  assert.equal(X.focus(), "tip:a", "and pinned");
  assert.deepEqual(cards.map((c) => c.attrs["aria-expanded"]), ["true", "false", "false"]);

  // A new claim lands above it: the card being worked in stays open.
  cards = ["h0", "tip:a", "tip:b"].map(fakeCard);
  X.foldCards(fakeShadow(cards), rerender);
  assert.deepEqual(cards.map((c) => c.shut()), [true, false, true]);

  // A click on a folded card opens it; a click on its ✕ does not.
  cards[2].handlers.click({ target: { closest: (s) => (s === "button, a, input" ? {} : null) } });
  assert.equal(renders, 0, "its ✕ dismisses, it does not open");
  cards[2].handlers.click({ target: { closest: () => null } });
  assert.equal(X.focus(), "tip:b");
  assert.equal(renders, 1);
  let prevented = false;
  cards[0].handlers.keydown({ key: "Enter", preventDefault: () => { prevented = true; }, target: { closest: () => null } });
  assert.ok(prevented && X.focus() === "h0" && renders === 2, "Enter opens it too");

  // The open card dismissed: the first one left opens.
  cards = ["tip:a", "tip:b"].map(fakeCard);
  X.foldCards(fakeShadow(cards), rerender);
  assert.equal(X.focus(), "tip:a");

  // A single card is simply open.
  cards = [fakeCard("solo")];
  X.foldCards(fakeShadow(cards), rerender);
  assert.equal(cards[0].shut(), false);
});

test("a tab leaves its kind only, its first card open; a kind with nothing left shows every card again", () => {
  const rerender = () => {};
  X.setFocus("h1");
  X.setFilter("cite");
  let cards = [fakeCard("h1", "wrong"), fakeCard("tip:a", "cite"), fakeCard("h2", "check"), fakeCard("tip:b", "cite")];
  X.foldCards(fakeShadow(cards), rerender);
  assert.deepEqual(cards.map((c) => c.out()), [true, false, true, false], "only the citations");
  assert.equal(X.focus(), "tip:a", "the open card was filtered out, so the first citation opens");
  assert.deepEqual(cards.map((c) => c.shut()), [false, false, false, true], "a hidden card is not folded, it is out");
  // The last citation dismissed: the filter lets go.
  cards = [fakeCard("h1", "wrong"), fakeCard("h2", "check")];
  X.foldCards(fakeShadow(cards), rerender);
  assert.equal(X.filter(), null);
  assert.deepEqual(cards.map((c) => c.out()), [false, false]);
  X.setFilter(null);
});

test("wired in both panels, after the cards are decorated; a folded card shows only its title and line", () => {
  const docs = SRC.slice(SRC.indexOf("function docsMode()"), SRC.indexOf("function fieldMode()"));
  const field = SRC.slice(SRC.indexOf("function fieldMode()"));
  for (const mode of [docs, field]) {
    const deco = mode.indexOf('for (const card of shadow.querySelectorAll(".card[data-card]")) decorateCard(card, cardSources);');
    const fold = mode.indexOf("foldCards(shadow, render);");
    assert.ok(deco > 0 && fold > deco, "fold after decorateCard, so a note's added buttons fold with it");
  }
  assert.match(SRC, /\.card\.shut > :not\(\.top\):not\(\.quote\) \{ display: none; \}/);
  assert.match(SRC, /\.card\.shut \.quote \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
  assert.match(SRC, /\.row > button\.act \{ flex: 0 0 auto; \}/, "a button is its own width, not a bar");
});
