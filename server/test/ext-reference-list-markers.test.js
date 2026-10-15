/* A reference list made as a Google Docs list. Owner, 2026-10-14, on the
 * flawed AI paper (fixtures/ai-paper-flawed.txt), whose plain text gave the
 * right answer, so the doc differed: "tracely extension currently flags the national education association
 * in the references for not being cited in the text, when it obviously is.
 * Also, it cited the title for being not cited in the text."
 *   - With the References as a list, an entry arrives as "* National …" (the
 *     marker; the exact glyph Docs exports is unchecked) and did not match
 *     (NEA, 2024). A numbered list
 *     ("1. Johnson, R. …") hid every entry from the check, a page break
 *     before "References" hid the list itself ("No Works Cited").
 *   - The flagged quote, "* National …", is not on the page, so its underline
 *     fell back to line-by-line matching, and the title's first line, "The
 *     Impact of Artificial Intelligence on", sits inside the entry's own title.
 * The plain paper was right before this (ext-citation-accuracy.test.js). */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const PAPER = readFileSync(path.join(HERE, "fixtures", "ai-paper-flawed.txt"), "utf8").replace(/\r\n/g, "\n");
const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return s; }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ referenceTips, citationTips, citationMarks, worksCitedBlock, detectGenre, docCitationStyle })`, vm.createContext({ URL }));

const [BODY, REFS] = PAPER.split("\nReferences\n");
const ENTRIES = REFS.trim().split("\n");
const asList = (mark, { heading = "References", gap = "\n" } = {}) => `${BODY}${gap}${heading}\n${ENTRIES.map((e, i) => `${mark(i)}${e}`).join("\n")}\n`;
const refFlags = (t) => {
  const g = X.detectGenre(t), st = X.docCitationStyle(t) ?? "mla";
  return [...X.citationTips(t, st, new Set(), g), ...X.referenceTips(t, new Set(), g, st)]
    .filter((f) => /^ref|^nolist$/.test(f.kind)).map((f) => `${f.kind}: ${String(f.quote).slice(0, 24)}`);
};
const ONLY_UNESCO = ["refuncited: UNESCO. (2024). Global a"];

test("the paper as plain lines: only UNESCO, which nothing cites", () => {
  assert.deepEqual(refFlags(PAPER), ONLY_UNESCO);
});

test("a bulleted list: the same one flag, quoted as the page shows it, without the bullet", () => {
  for (const bullet of ["* ", "● ", "• ", "- ", "◦ ", "▪ "]) {
    assert.deepEqual(refFlags(asList(() => bullet)), ONLY_UNESCO, JSON.stringify(bullet));
  }
});

test("a numbered list under (Author, year) citations is checked; a numbered list cited by number is not", () => {
  for (const num of [(i) => `${i + 1}. `, (i) => `${i + 1}) `, (i) => `(${i + 1}) `]) {
    assert.deepEqual(refFlags(asList(num)), ONLY_UNESCO, num(0));
  }
  const vancouver = "Sleep matters for memory (1). Exercise helps too (2).\n\nReferences\n1. Walker M. Why we sleep. Scribner; 2017.\n2. Ratey J. Spark. Little, Brown; 2008.\n3. Lee A. Unused. Press; 2020.\n";
  assert.deepEqual(Array.from(X.referenceTips(vancouver, new Set(), "research", "apa"), (f) => f.kind), [], "cited by number: not traced by name");
  const ieee = "Sleep matters [1]. Exercise helps [2].\n\nReferences\n[1] M. Walker, Why We Sleep, 2017.\n[2] J. Ratey, Spark, 2008.\n";
  assert.deepEqual(Array.from(X.referenceTips(ieee, new Set(), "research", "apa"), (f) => f.kind), []);
});

test("a page break or a stray space by the heading is still the heading", () => {
  assert.deepEqual(refFlags(asList(() => "", { gap: "\n\f" })), ONLY_UNESCO, "page break");
  assert.deepEqual(refFlags(asList(() => "", { heading: "References " })), ONLY_UNESCO, "no-break space");
  assert.equal(X.worksCitedBlock(asList(() => "* ", { gap: "\n\f" })).entries[1], ENTRIES[1]);
});

test("MLA's \"---.\" for the same author is an entry, not a marker", () => {
  const t = "Gatsby is lonely (Fitzgerald 12). Tender is the Night is bleak (Fitzgerald 40).\n\nWorks Cited\nFitzgerald, F. Scott. The Great Gatsby. Scribner, 1925.\n---. Tender Is the Night. Scribner, 1934.\n";
  assert.deepEqual(Array.from(X.worksCitedBlock(t).entries), ["Fitzgerald, F. Scott. The Great Gatsby. Scribner, 1925.", "---. Tender Is the Night. Scribner, 1934."]);
});

test("the underline goes on the entry as the page shows it", () => {
  const t = asList(() => "* ");
  const m = X.citationMarks(t, "apa", new Set(), X.detectGenre(t)).filter((x) => x.kind === "refuncited");
  assert.equal(m.length, 1);
  assert.equal(m[0].mark, ENTRIES[3]);
  assert.equal(t.slice(m[0].start, m[0].end), ENTRIES[3]);
});

/* ── svgLocate on a simulated annotation layer ──────────────────────────── */

const LOCATE = `${sliceBetween(SRC, "    const nrm = (s) =>", "\n")}\n${fn("    function svgOverlapRange(L, S) {")}${sliceBetween(SRC, "    function svgLocate(issues) {", "\n    }\n")}\n    }\n`;
function fn(from) { return `${sliceBetween(SRC, from, "\n    }\n")}\n    }\n`; }
// One annotation rect per visible line, top to bottom; its aria-label is the line's text.
function locate(visible, quote) {
  const nodes = visible.map((text, i) => ({ text, getBoundingClientRect: () => ({ top: 100 + i * 24, left: 72, width: 600, height: 20 }), getAttribute: (k) => (k === "aria-label" ? text : null) }));
  const L = vm.runInContext(`${LOCATE} ({ svgLocate })`, vm.createContext({
    svgLineNodes: () => nodes, svgFrac: (node, raw, font, i) => i / raw.length, svgRawIndexAt: (raw, n) => n,
  }));
  return [...new Set(L.svgLocate([{ seg: { hash: "h", text: quote } }]).map((b) => b.raw))];
}
const TITLE = ["The Impact of Artificial Intelligence on", "Student Academic Performance"];
const NEA = ["National Education Association. (2024). The impact of artificial intelligence on", "academic integrity in American schools."];

test("the paper's title is never underlined as a reference entry", () => {
  // The quote as 2.21.51 sent it, bullet and all: not found whole, so line by line.
  assert.deepEqual(locate([...TITLE, "Abstract", ...NEA], `* ${ENTRIES[1]}`), NEA, "the entry's two lines, not the title");
  // The references scrolled out of Docs' rendered pages: nothing, rather than the title.
  assert.deepEqual(locate([...TITLE, "Abstract", "Artificial intelligence has become one of the most influential"], `* ${ENTRIES[1]}`), []);
});

test("a sentence whose first line is scrolled out keeps its middle and last lines", () => {
  const S = "Research conducted by Stanford University found that students using AI-powered learning platforms scored approximately 65% higher on standardized examinations than students who did not use these technologies (Johnson, 2023).";
  // Line 1 ("…Research conducted by Stanford University found that") is above the rendered pages.
  const mid = "students using AI-powered learning platforms scored approximately 65% higher on";
  const last = "standardized examinations than students who did not use these technologies (Johnson, 2023). These findings";
  assert.deepEqual(locate([mid, last], `${S}`.replace("Research", "Research")), [mid, last]);
});
