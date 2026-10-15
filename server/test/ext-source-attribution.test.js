/* What a sentence says about its own source decides its kind. Owner,
 * 2026-10-14, on the flawed AI paper (fixtures/ai-paper-flawed.txt):
 *   "This should be a citation issue not needs evidence issue: According to a
 *   2023 study conducted by Harvard University, approximately 87% …"
 *   "This should be needs evidence instead of citation issue as the survey
 *   hasnt been verified, so you cant classify the claim as correct but
 *   improperly cited: … a survey of 25 students at a California high school"
 * So: a source the sentence NAMES but doesn't cite is a citation issue
 * ("Source not cited", amber); a source nobody could find leaves the claim
 * with no evidence ("Needs evidence", blue). The model's own verdict on the
 * sentence gives way to that, unless it says the claim is wrong. */
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
const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false }; function hashText(s) { return s; }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ flagShown, citationTips, citationMarks, citationHygieneTips, attributionBySentence, withoutCarriedNotes, citationTipsHtml, sourceNamedIn, tallyOf, segmentText, detectGenre, docCitationStyle, TIP_LABEL })`, vm.createContext({ URL }));

const notes = (t) => {
  const g = X.detectGenre(t), st = X.docCitationStyle(t) ?? "mla";
  return Array.from(X.citationTips(t, st, new Set(), g)).filter((f) => f.kind === "vague" || f.kind === "uncited");
};
const sentence = (start) => PAPER.split("\n").join(" ").match(new RegExp(`${start}[^.]*\\.`))[0];

test("the owner's paper: named sources are citation issues, the rest need evidence", () => {
  const got = notes(PAPER).map((f) => `${X.TIP_LABEL[f.kind]}: ${f.quote.slice(0, 30)}`);
  assert.deepEqual(got, [
    "Needs evidence: Recent studies have demonstrat",
    "Source not cited: According to a 2023 study cond",
    "Source not cited: According to a 2024 Pew survey",
    "Needs evidence: Furthermore, a survey of 25 st",
    "Needs evidence: A study involving 12 college s",
    "Needs evidence: Although some researchers have",
    "Needs evidence: Research from leading universi",
  ]);
  const harvard = notes(PAPER).find((f) => f.kind === "uncited");
  assert.equal(harvard.source, "Harvard University");
  assert.match(harvard.message, /^This names its source \(Harvard University\) but doesn't cite it/);
  assert.match(notes(PAPER)[3].message, /^This doesn't say who found it, so no one can check it/);
});

test("they count, colour and group as their kind", () => {
  const all = notes(PAPER);
  assert.deepEqual({ ...X.tallyOf([], all) }, { wrong: 0, check: 5, cite: 2, writing: 0 });
  const marks = Array.from(X.citationMarks(PAPER, "apa", new Set(), "research")).filter((m) => m.kind === "vague" || m.kind === "uncited");
  assert.ok(marks.every((m) => (m.kind === "vague") === (m.markKind === "questionable")), "a source nobody could find is drawn blue, a named one amber");
  const html = X.citationTipsHtml(all, null);
  assert.ok(html.indexOf("Unnamed sources (5)") >= 0 && html.indexOf("Unnamed sources (5)") < html.indexOf("Citations (2)"), "its own group, before the citations");
  assert.equal((html.match(/class="dot d-quest"/g) || []).length, 5);
  assert.equal((html.match(/class="dot d-cite"/g) || []).length, 2);
});

test("the model's verdict gives way to the sentence's source, never when it says wrong", () => {
  const S = "Furthermore, a survey of 25 students at a California high school found that 22 students preferred using ChatGPT.";
  const show = (verdict, attribution) => X.flagShown({ verdict }, {}, "research", S, false, attribution);
  // Named, not cited: the amber note is the flag.
  assert.equal(show("questionable", "named"), false, "Harvard 2023: a citation issue, not needs evidence");
  assert.equal(show("needs_citation", "named"), false);
  assert.equal(show("false", "named"), true, "a wrong claim stays wrong");
  // Nobody named: needs evidence, never "accurate but uncited".
  assert.equal(show("needs_citation", "unnamed"), false, "the California survey: not a citation issue");
  assert.equal(show("questionable", "unnamed"), true, "the model's own Needs evidence card carries it");
  assert.equal(show("incoherent", "unnamed"), true);
  assert.equal(show("questionable", ""), true, "no source note: as before");
});

test("each sentence gets its note's kind", () => {
  const segs = X.segmentText(PAPER);
  const attr = X.attributionBySentence(PAPER, segs);
  const kindOf = (start) => attr.get(segs.find((s) => s.text.startsWith(start))?.hash);
  assert.equal(kindOf("According to a 2023 study conducted by Harvard"), "named");
  assert.equal(kindOf("According to a 2024 Pew survey"), "named");
  assert.equal(kindOf("Furthermore, a survey of 25 students"), "unnamed");
  assert.equal(kindOf("Research conducted by Stanford University found"), undefined, "cited (Johnson, 2023): no note");
  assert.equal(kindOf("According to the National Education Association"), undefined, "cited (NEA, 2024)");
});

test("one card, not two: the model's Needs evidence carries an unnamed source's note", () => {
  const s = sentence("Furthermore, a survey of 25 students");
  const tips = notes(PAPER);
  const issues = [{ seg: { text: s }, f: { verdict: "questionable" } }];
  const kept = Array.from(X.withoutCarriedNotes(tips, issues));
  assert.equal(kept.length, tips.length - 1);
  assert.ok(!kept.some((t) => t.quote === s));
  const harvard = sentence("According to a 2023 study conducted by Harvard");
  assert.equal(Array.from(X.withoutCarriedNotes(tips, [{ seg: { text: harvard }, f: { verdict: "false" } }])).length, tips.length, "a named source's note rides beside a wrong verdict");
});

test("who a sentence names: the study's own by or from, never a place or a kind of body", () => {
  const cases = {
    "According to a 2023 study conducted by Harvard University, scores rose.": "Harvard University",
    "According to a 2024 Pew survey, 26% of teens used it.": "Pew",
    "A study by Kim found that attention fell.": "Kim",
    "Data from the CDC shows obesity rose.": "CDC",
    "Research from Stanford shows sleep helps.": "Stanford",
    "A report published by the World Health Organization found rates rose.": "World Health Organization",
    "According to the National Education Association, plagiarism fell.": "National Education Association",
    "A survey of 25 students at a California high school found that 22 preferred it.": "",
    "Research from leading universities shows it.": "",
    "Studies show that people from Japan live longer.": "",
    "Studies show kids who read at Christmas do better.": "",
    "Some researchers have argued that the war was caused by Germany.": "",
  };
  for (const [s, who] of Object.entries(cases)) assert.equal(X.sourceNamedIn(s), who, s);
});
