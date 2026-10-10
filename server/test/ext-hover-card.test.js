/* The hover card keeps its size and its place (extension 2.21.34). Owner,
 * 2026-10-09: "its glitchy in the fact that the underline overlay compacts
 * when it is under the screen … when I hover over underline and go to click
 * the action button such as delete this, it jumps around."
 *
 * The card was measured AFTER its own height cap: near the bottom of the
 * screen it was squeezed to the room below its line, then judged by the
 * squeezed size — so it stayed squeezed, or flipped above and back as its
 * content changed, moving away from a pointer on its way to a button. Run
 * here: Docs mode's own placement, over a card whose list shrinks when the
 * card is capped (as .docmark-scroll does). */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");

function load() {
  const card = {
    natural: 300, style: {},
    get offsetHeight() { const cap = parseFloat(this.style.maxHeight); return Math.min(this.natural, Number.isFinite(cap) ? cap : Infinity); },
    get clientHeight() { return this.offsetHeight - 4; },
    get scrollHeight() { return this.clientHeight; }, // the list shrinks; the card itself never overflows
    querySelectorAll: () => [list],
  };
  // The list that scrolls: whatever the cap hides is in it.
  const list = { style: { overflowY: "auto" }, get clientHeight() { return 100; }, get scrollHeight() { return 100 + (card.natural - card.offsetHeight); } };
  const tail = { style: {}, remove() {} };
  const pop = { style: {}, querySelector: () => tail, appendChild() {}, insertBefore() {}, addEventListener() {} };
  const ctx = vm.createContext({ innerWidth: 1200, innerHeight: 800 });
  const X = vm.runInContext(`
    ${sliceBetween(SRC, "    const POP_WIDTH = 320", "\n")}
    ${sliceBetween(SRC, "    const MIN_CARD =", "\n")}
    let popEl = null, popCard = null, popAbove = false, popWidth = POP_WIDTH;
    const dmTail = () => ({ style: {}, remove() {} });
    ${sliceBetween(SRC, "    let popSide = null;", "    /* Follow loop")}
    ({ place: (r) => placeDocsPopover(r), open: (el, c) => { popEl = el; popCard = c; popSide = null; popHeld = false; popAbove = false; popPlanned = false; },
       repaint: () => { popPlanned = false; }, // what paintPop does when the card's content changes
       side: () => popSide, hold: (v) => { popHeld = v; } })`, ctx);
  return { X, card, pop };
}
const line = (top) => ({ left: 300, top, bottom: top + 4, centerX: 400 });
const topOf = (pop) => parseFloat(pop.style.top);

test("near the bottom of the screen the card goes above at its full size — never squeezed below", () => {
  const { X, card, pop } = load();
  card.natural = 400;
  X.open(pop, card);
  X.place(line(600)); // 178px below the line, 582 above
  assert.equal(X.side(), "above");
  assert.equal(card.style.maxHeight, "", "not capped: it fits");
  assert.equal(card.offsetHeight, 400);
  assert.equal(topOf(pop), 600 - 10 - 400 - 8, "its bottom (with the tail) just above the line");
  // The owner's bug, measured on main before this change: a tall card (a list of
  // sources) near the bottom first drew squeezed to 180px BELOW the line
  // (top 614px), then jumped above (top 8px) on the next frame.
  const t = load();
  t.card.natural = 600;
  t.X.open(t.pop, t.card);
  const frames = [];
  for (let i = 0; i < 4; i++) { t.X.place(line(600)); frames.push(`${topOf(t.pop)}:${t.card.offsetHeight}`); }
  assert.deepEqual(frames, ["8:574", "8:574", "8:574", "8:574"], "above, at all the room there is, from the first frame");
});

test("it keeps its place frame after frame, and while the pointer is on it — whatever its content does", () => {
  const { X, card, pop } = load();
  card.natural = 400;
  X.open(pop, card);
  const tops = [];
  for (let i = 0; i < 6; i++) { X.place(line(600)); tops.push(topOf(pop)); }
  assert.equal(new Set(tops).size, 1, `no jump: ${tops}`);
  // The pointer reaches the card; its content grows past the room above (a button's note, a list).
  X.hold(true);
  card.natural = 700;
  X.repaint();
  X.place(line(600));
  assert.equal(X.side(), "above", "it does not flip out from under the pointer");
  assert.equal(card.style.maxHeight, `${582 - 8}px`, "it is capped where it is; its list scrolls");
  // Back to its size: uncapped again, still above.
  card.natural = 400;
  X.repaint();
  X.place(line(600));
  assert.equal(card.style.maxHeight, "");
  assert.equal(X.side(), "above");
});

test("below when it fits there; the roomier side, capped, when it fits on neither", () => {
  const { X, card, pop } = load();
  card.natural = 300;
  X.open(pop, card);
  X.place(line(100));
  assert.equal(X.side(), "below");
  assert.equal(topOf(pop), 100 + 4 + 10);
  const b = load();
  b.card.natural = 900; // taller than either side of a line mid-screen
  b.X.open(b.pop, b.card);
  b.X.place(line(420)); // 358 below, 402 above
  assert.equal(b.X.side(), "above");
  assert.equal(b.card.style.maxHeight, `${402 - 8}px`);
  // Repainted (new content) and no longer fitting where it is, it changes side then — never on a scroll.
  const c = load();
  c.card.natural = 300;
  c.X.open(c.pop, c.card);
  c.X.place(line(100));
  c.X.place(line(560)); // scrolled: 222 below now
  assert.equal(c.X.side(), "below", "a scroll carries it; it does not flip");
  c.X.repaint();
  c.X.place(line(560));
  assert.equal(c.X.side(), "above", "its content changed and it does not fit below: now it moves");
});

test("one piece: a scroll carries the card with its line, half out of view included — no flip, no squeeze, no pinning", () => {
  // Owner, 2026-10-09: "make the whole overlay move as one piece … so when I scroll it to be half out of frame it moves accordingly".
  const { X, card, pop } = load();
  card.natural = 300;
  X.open(pop, card);
  const at = [];
  for (const y of [400, 300, 150, 40, -60]) { X.place(line(y)); at.push(`${topOf(pop)}:${card.offsetHeight}:${card.style.maxHeight || "-"}`); }
  assert.deepEqual(at, ["414:300:-", "314:300:-", "164:300:-", "54:300:-", "-46:300:-"], "it follows the line up and off the top, its size unchanged");
  assert.equal(X.side(), "below");
  const d = load();
  d.card.natural = 300;
  d.X.open(d.pop, d.card);
  for (const y of [300, 500, 700, 780]) d.X.place(line(y));
  assert.equal(topOf(d.pop), 780 + 4 + 10, "and down past the bottom");
  assert.equal(d.card.style.maxHeight, "", "never squeezed on the way");
});

test("a row of buttons wraps instead of being cut off at the card's edge", () => {
  // Owner, 2026-10-09: "Apply revision · Back · Explain in depth PRO" was clipped on both sides.
  const made = [];
  const X = vm.runInContext(`
    ${sliceBetween(SRC, "    function dmActions(...kids) {", "    function dmBtn(")}
    ({ dmActions })`, vm.createContext({ el: (tag, style) => { const n = { tag, style: { ...style }, kids: [], appendChild(k) { this.kids.push(k); } }; made.push(n); return n; } }));
  const row = X.dmActions({ id: "apply" }, { id: "back" }, null, { id: "deep" });
  assert.equal(row.style.flexWrap, "wrap");
  assert.equal(row.style.display, "flex");
  assert.deepEqual(row.kids.map((k) => k.id), ["apply", "back", "deep"], "an absent control leaves no gap");
});

test("wired: a new card starts with no side; the pointer on the card holds it", () => {
  assert.match(SRC, /popAbove = false;\n\s+popSide = null;\n\s+popHeld = false;/);
  assert.match(SRC, /popEl\.addEventListener\("pointerenter", \(\) => \{ popHeld = true; \}\);/);
  assert.match(SRC, /popEl\.addEventListener\("pointerleave", \(e\) => \{ popHeld = false; hoverPt = \{ x: e\.clientX, y: e\.clientY \}; hoverHit\(\); \}\);/);
  assert.ok(!/const cardH = popCard\.offsetHeight;/.test(SRC), "never the capped height");
  assert.match(SRC, /popPlanned = false; \/\/ new content: its side and size are decided again/, "a repaint plans it again; a scroll never does");
  assert.ok(!/topPx = `\$\{Math\.max\(4, top\)\}px`/.test(SRC), "never pinned to the screen's edge");
  const follow = sliceBetween(SRC, "    function popFollowFrame() {", "    /* ── open / paint");
  assert.match(follow, /popLastTop = r\.top;\n\s+placeDocsPopover\(/, "placed with its line even when the line is out of view");
  assert.match(follow, /if \(!clip \|\| \(pb\.bottom > clip\.top \+ 8 && pb\.top < clip\.bottom - 8\)\) \{/, "lost only once the card itself has left the view");
});

test("motion: calm — a fade and a 4px rise on open, a cross-fade between cards, fades while a close waits, nothing bounces", () => {
  // Owner, 2026-10-09: "Also add animations for the overlay popups" — then "still keep jumping around":
  // 2.21.36's spring (an overshoot), 8px slide, scale and drift added motion to every open and swap.
  assert.match(SRC, /const POP_SPRING = POP_EASE;/, "no overshoot anywhere");
  assert.match(SRC, /\? \[\{ opacity: 0 \}, \{ opacity: 1 \}\]\n\s+: \[\{ opacity: 0, transform: `translateY\(\$\{popAbove \? 4 : -4\}px\)` \}, \{ opacity: 1, transform: "none" \}\],\n\s+\{ duration: switching \? 100 : 150, easing: POP_EASE \},/);
  const motion = SRC.slice(SRC.indexOf("    function animatePopoverIn(el, switching) {"), SRC.indexOf("    function hideDocsPopover({ instant = false } = {}) {"));
  assert.ok(motion.length > 500 && !/scale\(/.test(motion), "no scaling in or out");
  assert.match(SRC, /if \(!switching\) stepIn\(popCard, 40\);/, "its rows fade in after it");
  assert.match(SRC, /const a = row\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\]/, "a fade, no slide");
  assert.match(SRC, /if \(popStepShown !== null && popStepShown !== stepNow\) Promise\.resolve\(\)\.then\(\(\) => stepIn\(popCard\)\);/, "and again when what it shows changes — never on a repaint of the same");
  // Leaving: opacity only — it does not move while it waits.
  assert.match(SRC, /popEl\.style\.transition = on \? `opacity \$\{ms\}ms cubic-bezier\(0\.4, 0, 1, 1\)` : "opacity 150ms ease-out";\n\s+popEl\.style\.opacity = on \? "0\.35" : "";\n/);
  assert.ok(!/popEl\.style\.translate/.test(SRC));
  assert.match(SRC, /\[\{ opacity: from \}, \{ opacity: 0 \}\],/, "and goes with a fade");
  assert.match(SRC, /const from = Math\.min\(1, Number\(getComputedStyle\(el\)\.opacity\) \|\| 1\);/, "it leaves from where the fade got to, not from full");
  // Reduced motion: no movement at all, only the dimming that says it is leaving.
  assert.match(SRC, /if \(reducedMotion\(\)\) \{ popEl\.style\.opacity = on \? "0\.6" : ""; return; \}/);
  assert.match(SRC, /function stepIn\(card, delay = 0\) \{\n\s+if \(!card \|\| reducedMotion\(\)\) return;/);
  // The suggestions in the margin slide in once each; the notes above the launcher rise in once.
  assert.match(SRC, /if \(!fixCardsShown\.has\(it\.key\)\) \{\n\s+fixCardsShown\.add\(it\.key\);\n\s+if \(!reducedMotion\(\) && typeof card\.animate === "function"\) card\.animate\(\[\{ opacity: 0, translate: "10px 0" \}/);
  assert.match(SRC, /\.ready-ping\.enter \{ animation: tracely-ping-in 200ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
  assert.match(SRC, /@media \(prefers-reduced-motion: reduce\) \{ \.ready-ping\.enter \{ animation: none; \} \}/);
});
