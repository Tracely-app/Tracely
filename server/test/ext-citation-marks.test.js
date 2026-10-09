/* A citation note is underlined on the CITATION, not the sentence
 * (content.js citationMarks, cite_tip marks). Owner, 2026-10-04: "what if it
 * needs to flag for two different things, say wrong information and wrong
 * citation". The fact mark keeps the sentence and stops before a citation
 * that carries its own note, so the two sit side by side. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");

function load() {
  const a = SRC.indexOf("  // Bibliography block");
  const b = SRC.indexOf("  function esc(", a);
  const c = SRC.indexOf("  function wireChrome(", b);
  assert.ok(a > 0 && b > a && c > b, "content.js: the slices moved");
  const colors = SRC.match(/const MARK_COLORS = (\{[^}]*\});/)[1];
  const p0 = SRC.indexOf("  const MARK_PATTERN =");
  const p1 = SRC.indexOf("  const MARK_LINE_RADIUS", p0);
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return "h" + s.length + s.slice(0, 16); }
    const MARK_COLORS = ${colors};
    const MARK_LINE_HEIGHT = 2, MARK_LINE_HEIGHT_HOVERED = 3;
    ${SRC.slice(p0, p1)}
    ${SRC.slice(a, c)}
    ({ citationMarks, MARK_COLORS, MARK_PATTERN, LEGEND })`, vm.createContext({}));
}
const X = load();

const ESSAY = `The Great Gatsby: Hope and Illusion

In the novel, the green light symbolizes Gatsby's hope. Nick says "Gatsby believed in the green light, the orgastic future" (Fitzgerald). The narrator tells us he "stretched out his arms toward the dark water" (Fitzgerald 21).

Works Cited
Fitzgerald, F. Scott. The Great Gatsby. Scribner, 1925.
Fitzgerald, F. Scott. The Great Gatsby. Scribner, 1925.
Bloom, Harold. Gatsby's Dream. The Critic, 2001.`;

test("each note is placed on its citation: the parenthetical, or the reference entry", () => {
  const marks = Array.from(X.citationMarks(ESSAY, "mla", new Set()));
  const by = (k) => marks.filter((m) => m.kind === k);
  assert.equal(by("page").length, 1);
  assert.equal(by("page")[0].mark, "(Fitzgerald)", "the citation, not the quote or the sentence");
  assert.equal(ESSAY.slice(by("page")[0].start, by("page")[0].end), "(Fitzgerald)", "exact offsets");
  const dup = by("refdup")[0];
  assert.ok(dup.lastCopy, "Docs underlines only the later copy");
  assert.equal(dup.start, ESSAY.lastIndexOf("Fitzgerald, F. Scott."), "field mode: the second entry");
  const unc = by("refuncited")[0];
  assert.equal(ESSAY.slice(unc.start, unc.end), "Bloom, Harold. Gatsby's Dream. The Critic, 2001.");
  assert.equal(unc.lastCopy, false);
});

test("a dismissed note has no mark", () => {
  const all = Array.from(X.citationMarks(ESSAY, "mla", new Set()));
  const left = X.citationMarks(ESSAY, "mla", new Set([all[0].id]));
  assert.equal(left.length, all.length - 1);
});

test("one line for the citation family: amber double, and the legend says so", () => {
  assert.equal(X.MARK_COLORS.cite_tip, X.MARK_COLORS.needs_citation);
  assert.equal(X.MARK_PATTERN.cite_tip, X.MARK_PATTERN.needs_citation);
  assert.ok(X.LEGEND.some(([v, label]) => v === "needs_citation" && label === "Missing or incomplete citation"));
});

test("wired in Docs: located beside the findings, the fact mark stops before a noted citation, its own card", () => {
  assert.match(SRC, /citeMarks: true,/);
  assert.match(SRC, /const allTips = \[\.\.\.\(FEATURES\.citeMarks && isArgumentGenre\(docGenre\) \? citationMarks\(docText, settings\.citationStyle, dismissed\) : \[\]\), \.\.\.notes\]/);
  // One underline per span (ext-card-fixes.test.js pins the rule itself).
  assert.match(SRC, /const host = issues\.find\(\(\{ seg \}\) => tipCoversSentence\(seg\.text, t\.mark\)\);/);
  assert.match(SRC, /for \(const t of tips\) lastVerdictByHash\.set\(t\.id, t\.markKind \?\? "cite_tip"\);/);
  assert.match(SRC, /const \{ start, end \} = factSpanOf\(seg\.text, tips\);\s+return seg\.text\.slice\(start, end\);/);
  assert.match(SRC, /seg: \{ hash: t\.id, text: t\.mark, lastCopy: t\.lastCopy \}/);
  assert.match(SRC, /if \(!cache\.get\(hash\) && !tipMarkById\.has\(hash\)\) return;/);
  assert.match(SRC, /if \(tip\) \{ paintCiteTip\(tip, put\); requestPlace\(\); return; \}/);
  assert.match(SRC, /if \(seg\.lastCopy\) \{/, "svgLocate keeps only the later of two identical entries");
});

test("wired in field mode: painted with the sentence marks' own code, and the sentence stops short", () => {
  assert.match(SRC, /const tips = \[\.\.\.\(FEATURES\.citeMarks && isArgumentGenre\(docGenre\) \? citationMarks\(liveText, settings\.citationStyle, dismissed\) : \[\]\), \.\.\.notes\];/);
  assert.match(SRC, /if \(rects\.length\) paintMark\(layer, tip\.id, rects, MARK_COLORS\[tip\.markKind \?\? "cite_tip"\], MARK_PATTERN\[tip\.markKind \?\? "cite_tip"\]\);/);
  assert.match(SRC, /const span = factSpanOf\(seg\.text, tips\.filter\(\(t\) => t\.start >= seg\.start && t\.end <= seg\.end\)\);/);
  assert.match(SRC, /if \(flaggedText\.some\(\(t\) => tipCoversSentence\(t, tip\.mark\)\)\) continue;/);
  assert.match(SRC, /if \(!pending\) \{ paintMark\(layer, seg\.hash, rects, color, pattern\); continue; \}/);
});
