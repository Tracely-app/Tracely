/* The Docs card stops jumping between underlines (content.js hoverIntent,
 * inSafeTriangle). Owner, 2026-10-06: "right now it jumps too much when there
 * are underlines everywhere … maybe do the triangle method where it ignores
 * everything within a triangle of the mouse and the button on the overlay."
 * A card opened the instant the pointer crossed any underline, and the way
 * down to a card's buttons crossed other sentences' underlines, each of which
 * swapped the card. And the marks themselves: new ones draw in, removed ones
 * fade, the hovered sentence lights up — never on a redraw of marks already
 * on the page, which is the flicker fixed in 2.21.16. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const a = SRC.indexOf("  /* Hover intent for the Docs card.");
const b = SRC.indexOf("  function esc(s) {", a);
const X = vm.runInContext(`${SRC.slice(a, b)}
  ({ hoverIntent, inSafeTriangle, isFreshMark, HOVER_OPEN_MS, HOVER_SWAP_MS, HOVER_REST_MS, HOVER_HIDE_MS })`, vm.createContext({}));

const open = { open: true, popHash: "A", onCard: false, onOwn: false, inTri: false, under: null };

test("a pass across the page opens nothing: a card waits for the pointer to stay", () => {
  assert.ok(a > 0 && b > a, "content.js: the hover helpers moved");
  assert.deepEqual({ ...X.hoverIntent({ open: false, under: "A" }) }, { act: "open", hash: "A", ms: X.HOVER_OPEN_MS });
  assert.equal(X.hoverIntent({ open: false, under: null }).act, "none");
  assert.ok(X.HOVER_OPEN_MS >= 100 && X.HOVER_OPEN_MS <= 200, "long enough to skip a fly-over, short enough to feel immediate");
});

test("on the way to the card, other underlines are ignored — unless the pointer stops on one", () => {
  assert.equal(X.hoverIntent({ ...open, inTri: true }).act, "stay");
  const d = X.hoverIntent({ ...open, inTri: true, under: "B" });
  assert.equal(d.act, "swap");
  assert.equal(d.rest, true, "inside the triangle a swap needs the pointer to REST");
  assert.equal(d.ms, X.HOVER_REST_MS);
  assert.ok(X.HOVER_REST_MS > X.HOVER_SWAP_MS);
});

test("on the card or its own sentence the card stays; elsewhere another mark takes over, empty page closes it", () => {
  assert.equal(X.hoverIntent({ ...open, onCard: true, under: "B" }).act, "stay");
  assert.equal(X.hoverIntent({ ...open, onOwn: true, under: "B" }).act, "stay");
  assert.deepEqual({ ...X.hoverIntent({ ...open, under: "B" }) }, { act: "swap", hash: "B", ms: X.HOVER_SWAP_MS });
  assert.deepEqual({ ...X.hoverIntent(open) }, { act: "hide", ms: X.HOVER_HIDE_MS });
  assert.equal(X.hoverIntent({ ...open, under: "A" }).act, "hide", "its own hash is never a swap");
});

test("the safe zone runs from the pointer to the card, far corners included", () => {
  const card = { left: 100, right: 420, top: 300, bottom: 500 };
  const apex = { x: 150, y: 200 };
  // Card below: straight down, and diagonally toward the far corner.
  assert.equal(X.inSafeTriangle(apex, card, 150, 250), true);
  assert.equal(X.inSafeTriangle(apex, card, 280, 290), true);
  assert.equal(X.inSafeTriangle(apex, card, 152, 201), true, "the first pixel of a move is inside");
  // Away from the card: sideways, back up, or out past its edge.
  assert.equal(X.inSafeTriangle(apex, card, 60, 250), false);
  assert.equal(X.inSafeTriangle(apex, card, 150, 180), false);
  assert.equal(X.inSafeTriangle(apex, card, 470, 290), false);
  // From the end of a long line, the card sits just under it: heading for
  // the card's side is on the way; heading straight down past it is not.
  const near = { left: 13, right: 327, top: 74, bottom: 239 };
  const end = { x: 449, y: 63 };
  assert.equal(X.inSafeTriangle(end, near, 424, 79), true, "measured in the harness: this point swapped cards before");
  assert.equal(X.inSafeTriangle(end, near, 360, 140), true);
  assert.equal(X.inSafeTriangle(end, near, 449, 150), false);
  // Card above its sentence.
  const up = { left: 100, right: 420, top: 0, bottom: 150 };
  assert.equal(X.inSafeTriangle(apex, up, 200, 170), true);
  assert.equal(X.inSafeTriangle(apex, up, 200, 230), false);
  assert.equal(X.inSafeTriangle(null, card, 150, 250), false, "no apex, no zone");
});

test("only a mark new on the page animates — not a redraw, not a sentence being typed in", () => {
  const seen = [{ hash: "A", color: "#d93636", x0: 100, x1: 400, y: 1000 }];
  assert.equal(X.isFreshMark(seen, { hash: "A", color: "#d93636", x0: 100, x1: 400, y: 1600 }), false, "same sentence, scrolled");
  assert.equal(X.isFreshMark(seen, { hash: "A2", color: "#d93636", x0: 100, x1: 410, y: 1002 }), false, "re-hashed by an edit, same spot");
  assert.equal(X.isFreshMark(seen, { hash: "B", color: "#ffb800", x0: 100, x1: 400, y: 1000 }), true, "a new finding on that spot");
  assert.equal(X.isFreshMark(seen, { hash: "C", color: "#d93636", x0: 100, x1: 400, y: 1040 }), true, "another line");
  assert.equal(X.isFreshMark([], { hash: "A", color: "#d93636", x0: 0, x1: 1, y: 0 }), true);
});

test("wired: one hover path, through the intent; motion only via the helpers", () => {
  const hov = SRC.slice(SRC.indexOf("    function hoverHit() {"), SRC.indexOf("    // Scroll/wheel fire at frame rate"));
  assert.match(hov, /const d = hoverIntent\(st\);/);
  assert.match(hov, /if \(again\.act === d\.act && again\.hash === d\.hash\) runHoverDecision\(again, now\);/, "a decision runs only if it still holds when its timer fires");
  assert.ok(!/showDocsPopover|showFlowPopover/.test(hov.slice(0, hov.indexOf("window.addEventListener"))), "nothing opens a card except runHoverDecision");
  assert.match(SRC, /inTri = inSafeTriangle\(popApex, \(popCard \?\? popEl\)\.getBoundingClientRect\(\), x, y\);/);
  assert.match(SRC, /settleDocsMotion\(leaving, recentBefore\);\n\s+paintDocsActive\(\);/);
  assert.match(SRC, /document\.querySelectorAll\("\[data-tracely-bar\]:not\(\[data-tracely-leaving\]\)"\)/, "a fading bar is not swept mid-fade");
  // Reduced motion: nothing draws in, nothing fades out.
  assert.match(SRC, /function drawMarkIn\(el, delay\) \{\n\s+if \(typeof el\.animate !== "function" \|\| markReducedMotion\(\)\) return;/);
  assert.match(SRC, /if \(!r \|\| replaced \|\| markReducedMotion\(\)/);
});
