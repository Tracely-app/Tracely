/* The extension's sentence boundaries (content.js segmentText), after the
 * port of server/shared/sentenceSplit.js's rules.
 *
 * Before, the extension split at every ".", so "the U.S. Army" produced the
 * sentence "…the U." and "Harry S. Truman" ended at "S." — fragments the
 * checker then flagged "Doesn't make sense" (a tester's screenshots,
 * 2026-09-28). The desktop and the server never had that problem: their
 * splitter knows initials, abbreviations and brackets. The two copies must
 * now agree, line for line, on the corpus mirror.test.js already uses. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitSentences } from "../shared/sentenceSplit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(HERE, "..", "..", "extension", f), "utf8");

function loadSegmenter() {
  const src = read("content.js");
  const a = src.indexOf("  // Bibliography block");
  const b = src.indexOf("  function esc(", a);
  assert.ok(a > 0 && b > a, "content.js: the segmenter slice moved");
  const code = `
    function hashText(s) { const norm = s.toLowerCase().replace(/\\s+/g, " ").trim(); let h = 5381; for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0; return "s" + h.toString(36); }
    ${src.slice(a, b)}
    ({ segmentText, splitLineSentences })`;
  return vm.runInContext(code, vm.createContext({}));
}
const api = loadSegmenter();
// Arrays born inside the vm context carry its Array prototype, which strict
// deepEqual treats as a different type — so every result is copied out.
const segmentText = (t) => Array.from(api.segmentText(t), (s) => ({ text: s.text, start: s.start, end: s.end }));
const splitLineSentences = (l) => Array.from(api.splitLineSentences(l), (x) => [...x]);
const texts = (t) => segmentText(t).map((s) => s.text);

test("an abbreviation, an initial, a dotted acronym and a bracketed citation do not end a sentence", () => {
  assert.deepEqual(texts("88% of students in the U.S. have become less involved. Another."), ["88% of students in the U.S. have become less involved.", "Another."]);
  assert.deepEqual(texts("The General clashed with President Harry S. Truman over strategy. His dismissal in 1951 followed."), ["The General clashed with President Harry S. Truman over strategy.", "His dismissal in 1951 followed."]);
  assert.deepEqual(texts("It was studied by Dr. Smith and confirmed later. Then this."), ["It was studied by Dr. Smith and confirmed later.", "Then this."]);
  assert.deepEqual(texts("The rate rose (Smith, 2020). Dr. Chen disagreed (Chen et al., 2021: 14). Etc."), ["The rate rose (Smith, 2020).", "Dr. Chen disagreed (Chen et al., 2021: 14).", "Etc."]);
  assert.deepEqual(texts("Costs fell, e.g. in 2019, and rose again. Done."), ["Costs fell, e.g. in 2019, and rose again.", "Done."]);
});

test("a decimal, a closing quote and a footnote mark stay with their sentence", () => {
  assert.deepEqual(texts("It had 3.5 million people. Then it grew."), ["It had 3.5 million people.", "Then it grew."]);
  assert.deepEqual(texts("He said “it works.” Then he left."), ["He said “it works.”", "Then he left."]);
  assert.deepEqual(texts("It was posted.² Nobody read it."), ["It was posted.²", "Nobody read it."]);
  // A punctuation run is ONE terminator, and it does end the sentence — the
  // server splits "Wait... then go." the same way, and the server is the
  // authority (see the agreement test below).
  assert.deepEqual(texts("Wait... then go. Now."), ["Wait...", "then go.", "Now."], "a punctuation run is one terminator, not three");
});

test("offsets are exact substrings of the source, so the underlines land", () => {
  const t = "Intro line\nThe U.S. rate rose (Smith, 2020). Dr. Chen disagreed.\n  Indented sentence.  Another one. ";
  for (const s of segmentText(t)) assert.equal(t.slice(s.start, s.end), s.text, s.text);
  assert.deepEqual(texts(t), ["Intro line", "The U.S. rate rose (Smith, 2020).", "Dr. Chen disagreed.", "Indented sentence.", "Another one."]);
});

test("the extension and the server split the same lines the same way", () => {
  const corpus = [
    "88% of students in the U.S. have become less involved. Another.",
    "It was studied by Dr. Smith and confirmed later. Then this.",
    "The U.S. rate rose (Smith, 2020). Dr. Chen disagreed (Chen et al., 2021: 14). Etc.",
    "In the U.S. the WHO reported 40% in 2021.",
    "Gregory P. Margarian wrote it in 1998. It was read by E. B. White.",
    "See vol. 3, pp. 12-14, for the figure. It held.",
    "A sentence with no terminator",
    "He asked: why? Because. (It was late.) Fine!",
    "Numbers like 2.5 and 10.0 are fine. So is $3.50.",
    "Mr. and Mrs. Smith arrived at 10 a.m. sharp. They left at noon.",
  ];
  for (const line of corpus) {
    const ours = texts(line);
    const theirs = splitSentences(line).map((s) => s.text);
    assert.deepEqual(ours, theirs, line);
  }
});

test("a bare single-letter word before a period is never a boundary, even at a real sentence end", () => {
  // The server's rule, kept on purpose: "…plan B. Then…" stays one sentence.
  // Merging two sentences costs one long claim; splitting an initial costs a
  // fragment flagged as nonsense and a citation severed from its claim.
  assert.deepEqual(splitLineSentences("We chose plan B. Then we left.").length, 1);
  assert.deepEqual(splitSentences("We chose plan B. Then we left.").length, 1, "and the server agrees");
});
