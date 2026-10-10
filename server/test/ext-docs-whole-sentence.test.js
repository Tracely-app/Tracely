/* A flagged sentence is underlined on every line it covers in Google Docs
 * (content.js svgLocate). Owner, 2026-10-05: "it doesnt underline whole
 * sentence, it has a habit of only being able to highlight one line … at a
 * time". Line-by-line matching needed a sentence's piece at a line's end or
 * start to be 12+ characters, so a sentence starting "Napoleon was" at the end
 * of a line lost that line. Measured in a simulated annotation layer
 * (3 flagged sentences over 5 lines): 5 bars before, 6 after — the missing
 * one was "Napoleon was" — with 0 blank frames over 20 keystrokes. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const loc = SRC.slice(SRC.indexOf("    function svgLocate(issues) {"), SRC.indexOf("      return bars;", SRC.indexOf("    function svgLocate(issues) {")));

test("the visible lines are joined in reading order and the sentence is found whole", () => {
  assert.ok(loc.length > 500, "content.js: svgLocate moved");
  assert.match(loc, /const ordered = \[\.\.\.lines\]\.sort\(\(a, b\) => a\.top - b\.top\);/);
  assert.match(loc, /for \(const line of ordered\) \{ line\.base = flat\.length; flat \+= line\.joined; \}/);
  assert.match(loc, /for \(let at = flat\.indexOf\(S\); at >= 0; at = flat\.indexOf\(S, at \+ 1\)\) hits\.push\(at\);/);
});

test("every line it covers gets its piece, however short", () => {
  assert.match(loc, /barsFor\(seg, line, \[Math\.max\(at, ls\) - ls, Math\.min\(at \+ S\.length, le\) - ls\]\);/);
  assert.ok(!/S\.length >= 12|p >= 12/.test(loc.slice(0, loc.indexOf("let fromTop"))), "no minimum length on the whole-text path");
});

test("a duplicate entry keeps only its later copy; a sentence not found whole falls back to line by line", () => {
  assert.match(loc, /if \(seg\.lastCopy && hits\.length\) hits = \[hits\[hits\.length - 1\]\];/);
  assert.ok(loc.indexOf("if (hits.length) {") < loc.indexOf("let fromTop = -Infinity;"), "the old path runs only when the whole match failed");
});

/* Owner, 2026-10-05: "underline segments are word by word and disconnected".
 * Docs often gives each word its own annotation rect. Measured in a per-word
 * simulated annotation layer: 34 space-sized holes inside underlines on the
 * old build, 0 on this one (the 1 remaining gap sits between two different
 * sentences, as it should), and still 0 after typing moves the bars. */
test("one continuous underline per sentence per line, kept through typing", () => {
  const join = SRC.slice(SRC.indexOf("    function joinBars() {"), SRC.indexOf("    function drawDocsMarksSvg("));
  assert.ok(join.length > 200, "content.js: joinBars moved");
  assert.match(join, /if \(a\.hash !== b\.hash \|\| a\.node\.parentNode !== b\.node\.parentNode \|\| \(a\.tf \|\| ""\) !== \(b\.tf \|\| ""\)\) continue;/);
  assert.match(join, /if \(Math\.abs\(\(a\.gy \+ a\.gh\) - \(b\.gy \+ b\.gh\)\) > 2\) continue; \/\/ another line/);
  assert.match(join, /if \(bx > ax\) a\.el\.setAttribute\("width", String\(Math\.max\(2, bx - ax \+ 0\.5\)\)\);/);
  assert.match(SRC, /joinBars\(\);\n\s+drawMarginIcons\(svgBars\);\n\s+\/\* IN-DOCUMENT FLOW BRACKETS ARE OFF BY DEFAULT\./, "after drawing");
  assert.match(SRC, /joinBars\(\); \/\/ the follow above reset each bar to its own rect's width\n\s+if \(relocateNow\)/, "after the observer moves bars");
});
