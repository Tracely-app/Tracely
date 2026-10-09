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
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ citationTips, tipCitedTarget, citedLookupPlan, segmentText, panelHeadHtml, tipsSectionHtml, citationTipsHtml, cardListHtml, groupHtml, foldCards,
     focus: () => focusCard, setFocus: (k) => { focusCard = k; } })`, vm.createContext({}));

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

test("the header says what the list holds, never 'all clear' over open notes", () => {
  const head = (...a) => {
    const h = X.panelHeadHtml(...a);
    return [h.match(/<span class="name">([^<]*)</)[1], h.match(/<span class="status[^"]*">([^<]*)</)[1]];
  };
  assert.deepEqual(head(0, "all clear", false, "", 2), ["2 notes", "no claims flagged"], "the owner's screenshot");
  assert.deepEqual(head(0, "all clear", false, "", 1), ["1 note", "no claims flagged"]);
  assert.deepEqual(head(3, "3 issues found", false, "", 2), ["3 claims flagged", "+ 2 notes"]);
  assert.deepEqual(head(1, "1 issue found", false, "", 0), ["1 claim flagged", ""], "never '1 issue found' under '1 claim flagged'");
  assert.deepEqual(head(0, "all clear", false, "", 0), ["Tracely", "all clear"]);
  assert.deepEqual(head(0, "checking…", false, "", 2), ["2 notes", "checking…"], "only 'no claims flagged' once the check says so");
  assert.deepEqual(head(2, "Could not reach Tracely", true, "", 2), ["2 claims flagged", "Could not reach Tracely"], "an error always shows");
  // Both panels pass the notes the list shows: everything counted on the launcher but the claims.
  assert.equal((SRC.match(/panelHeadHtml\(issues\.length, statusMsg, statusKind === "error" \|\| statusKind === "offline", "", flagged - issues\.length\)/g) || []).length, 2);
});

test("one list, most serious first: Claims, Citations, Writing feedback, then evidence", () => {
  assert.equal(X.groupHtml("Claims", 2, "<i></i>"), `<div class="tips"><div class="tips-head">Claims (2)</div><i></i></div>`);
  assert.equal(X.cardListHtml([{ hash: "a", html: "<a>" }, { hash: "b", html: "<b>" }]), "<a><b>", "every card; foldCards keeps one open");
  assert.equal((SRC.match(/const claimsHtml = cardsHtml \? groupHtml\("Claims", cards\.length, cardsHtml\) : "";/g) || []).length, 2);
  assert.equal((SRC.match(/\$\{genreHtml\}\$\{claimsHtml\}\$\{tipsHtml\}/g) || []).length, 2, "claims above the notes, in both panels");
  assert.ok(!/showAllCards|id="showAll"/.test(SRC), "the one-card view and its Show all are gone: the fold replaces them");
  // A note's dot is its underline's colour; a note with no underline has none.
  const html = X.tipsSectionHtml("T", [
    { id: "tip:1", kind: "nameonly", quote: "q", message: "m", suggestion: "" },
    { id: "tip:2", kind: "evidence", quote: "q", message: "m", suggestion: "" },
    { id: "tip:3", kind: "offtopic", quote: "q", message: "m", suggestion: "" },
  ], "", null);
  assert.deepEqual(html.match(/class="dot [^"]*"/g), ['class="dot d-cite"', 'class="dot d-quest"']);
});

/* foldCards against the smallest DOM it reads. */
function fakeCard(key) {
  const handlers = {};
  const attrs = {};
  const cls = new Set(["card"]);
  return {
    dataset: { card: key }, handlers, attrs, tabIndex: -1,
    classList: { add: (c) => cls.add(c), has: (c) => cls.has(c) },
    setAttribute: (k, v) => { attrs[k] = v; },
    addEventListener: (t, f) => { handlers[t] = f; },
    shut: () => cls.has("shut"),
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
