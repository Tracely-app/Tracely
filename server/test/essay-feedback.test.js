/* Writing feedback on an essay (/api/review kind "essay"; content.js
 * essayFeedbackTips / essayFeedbackMarks). Owner, 2026-10-05, on an AP World
 * DBQ whose facts were all right (production check: 29 of 30 sentences
 * accurate): "it flags things too little … It should of flagged these
 * important parts of the DBQ: limited document evidence … broad claims …
 * limited complexity." The model is not exercised here; everything around
 * it is — the document count it is handed, what of its answer survives, and
 * how the extension shows it. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { citedDocuments, validateEssayReview, runReview, ESSAY_REVIEW_KINDS } from "../lib/factcheck.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const SERVER = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
const FACTCHECK = readFileSync(path.join(HERE, "..", "lib", "factcheck.js"), "utf8");

const DBQ = [
  "Before the Mongol Empire, Eurasia was divided into many kingdoms. The Mongol Empire greatly changed Eurasia by increasing trade and spreading ideas.",
  "Document 2 explains that travelers could move safely through Mongol territory. This shows that the Mongols made the Silk Roads safer.",
  "Document 6 says that merchants brought goods and ideas. Chinese technologies such as gunpowder and printing spread to other parts of Eurasia during this period.",
  "Document 3 explains that Mongol rulers allowed many religions. Document 1 describes how Mongol armies destroyed cities.",
].join("\n");

test("the documents an essay cites are counted, not guessed", () => {
  assert.deepEqual(citedDocuments(DBQ), [1, 2, 3, 6]);
  assert.deepEqual(citedDocuments("As Doc. 4 shows, and (Doc 7) and Documents 1 and 5 agree."), [1, 4, 5, 7]);
  assert.deepEqual(citedDocuments("A document-based essay with no numbers."), []);
});

test("only findings the writer can act on survive", () => {
  const out = validateEssayReview(DBQ, {
    genre: "dbq",
    findings: [
      { quote: "", kind: "documents", message: "You use four documents; each must support the argument." },
      { quote: "Chinese technologies such as gunpowder and printing spread to other parts of Eurasia during this period.", kind: "evidence", message: "Name the route or the evidence for this spread." },
      { quote: "A sentence that is not in the essay at all.", kind: "analysis", message: "Invented." },
      { quote: "", kind: "evidence", message: "An evidence note must point at a sentence." },
      { quote: "", kind: "praise", message: "Unknown kind." },
      { quote: "", kind: "complexity", message: "Explain how the destruction relates to the trade it later enabled." },
    ],
  });
  assert.equal(out.genre, "dbq");
  assert.deepEqual(out.findings.map((f) => f.kind), ["documents", "evidence", "complexity"]);
});

test("the AP rubric notes belong to a DBQ only; 'other' gets nothing", () => {
  const essay = validateEssayReview(DBQ, { genre: "essay", findings: [{ quote: "", kind: "sourcing", message: "x" }, { quote: "", kind: "thesis", message: "State a claim." }] });
  assert.deepEqual(essay.findings.map((f) => f.kind), ["thesis"]);
  assert.deepEqual(validateEssayReview(DBQ, { genre: "other", findings: [{ quote: "", kind: "thesis", message: "x" }] }).findings, []);
});

test("the prompt carries the 2023 DBQ rubric and is handed the counted documents", () => {
  assert.match(FACTCHECK, /1 point for using three documents to address the topic, 2 for using four to SUPPORT an argument\. Use the DOCUMENTS CITED count given; never count yourself\./);
  assert.match(FACTCHECK, /never describe a document's author, purpose, audience or contents — say what sourcing is missing and ask for the document packet/);
  assert.match(FACTCHECK, /never a topic sentence the next sentences support/);
  assert.match(FACTCHECK, /DOCUMENTS CITED: \$\{docs\.length \? `\$\{docs\.join\(", "\)\} \(\$\{docs\.length\} distinct\)` : "none"\}/);
});

test("the route: kind 'essay' gets essay feedback, anything else the resume review (every older build)", async () => {
  assert.match(SERVER, /const kind = rawKind === "essay" \? "essay" : "resume";/);
  assert.match(SERVER, /runReview\(\{ text, model: modelUsed, effort: level, mock: MOCK, kind \}\)/);
  const r = await runReview({ text: DBQ, mock: true, kind: "essay" });
  assert.equal(r.genre, "dbq");
  assert.deepEqual(r.documents, [1, 2, 3, 6]);
  assert.ok(r.findings.some((f) => f.kind === "documents"));
  const resume = await runReview({ text: "Jordan Rivera\nEXPERIENCE\nBarista", mock: true });
  assert.ok(!resume.findings.some((f) => ESSAY_REVIEW_KINDS.includes(f.kind) && f.kind !== "structure"));
});

function loadExt() {
  const a = SRC.indexOf("  // Bibliography block");
  const c = SRC.indexOf("  function wireChrome(", a);
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = { resumeTips: true, essayFeedback: true }; function hashText(s) { return "h" + s.length + s.slice(0, 20); }
    ${SRC.slice(a, c)}
    ({ essayFeedbackTips, essayFeedbackHtml, essayFeedbackMarks, reviewKindFor })`, vm.createContext({}));
}
const X = loadExt();
const FINDINGS = [
  { quote: "", kind: "documents", message: "You use four documents (1, 2, 3, 6)." },
  { quote: "Chinese technologies such as gunpowder and printing spread to other parts of Eurasia during this period.", kind: "evidence", message: "Name the evidence." },
  { quote: "A sentence the writer has since deleted.", kind: "analysis", message: "Gone." },
];

test("extension: essays and papers get essay feedback, resumes resume tips, the rest nothing", () => {
  for (const g of ["prose", "research", "literary"]) assert.equal(X.reviewKindFor(g), "essay", g);
  assert.equal(X.reviewKindFor("resume"), "resume");
  for (const g of ["letter", "homework"]) assert.equal(X.reviewKindFor(g), null, g);
});

test("extension: notes on the text on screen, a sentence note as a mark, an essay note in the panel", () => {
  const tips = Array.from(X.essayFeedbackTips(DBQ, FINDINGS, new Set()));
  assert.deepEqual(tips.map((t) => t.kind), ["documents", "evidence"], "a note on a deleted sentence drops out");
  assert.equal(X.essayFeedbackTips(DBQ, FINDINGS, new Set([tips[1].id])).length, 1, "dismissed");
  const marks = Array.from(X.essayFeedbackMarks(DBQ, tips));
  assert.equal(marks.length, 1, "only the sentence note is drawn");
  assert.equal(marks[0].markKind, "note_tip");
  assert.equal(DBQ.slice(marks[0].start, marks[0].end), FINDINGS[1].quote);
  const html = X.essayFeedbackHtml(tips, false, null);
  assert.match(html, /Writing feedback \(2\)/);
  assert.match(html, /Document evidence \(DBQ\)/);
  assert.match(X.essayFeedbackHtml([], true, null), /Reading your essay…/);
  assert.equal(X.essayFeedbackHtml([], false, null), "");
});

test("extension wiring: the request names its kind, notes count on the launcher, sentence notes are orange dashed", () => {
  assert.equal((SRC.match(/api\("\/api\/review", \{ text: text\.slice\(0, REVIEW_MAX_CHARS\), model: CHECK_MODEL, kind \}\)/g) || []).length, 2);
  assert.equal((SRC.match(/const flagged = issues\.length \+ offTopic\.length \+ refTips\.length \+ essayNotes\.length;/g) || []).length, 2);
  assert.match(SRC, /cite_tip: "#ffb800", note_tip: "#ff5900" \};/);
  assert.match(SRC, /cite_tip: "double", note_tip: "dashed" \};/);
  assert.match(SRC, /\.filter\(\(t\) => !flaggedText\.has\(t\.mark\)\)/, "never on top of a fact mark");
});
