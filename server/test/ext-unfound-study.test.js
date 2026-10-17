/* A study Tracely can't find (content.js unfoundStudy and what it offers).
 * Owner, 2026-10-15, on "A study involving 12 college students found that 10
 * participants reported positive experiences using AI": "something like this
 * should be flagged as should be deleted, as tracely cant find anything like
 * this. Furthermore, make it where pro and student plans has tracely find
 * evidence on the web to replace this with, that fits the text". The owner
 * chose the replacement that quotes the source over a reworded sentence:
 * every word in it is the source's or names it. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const PAPER = readFileSync(path.join(HERE, "fixtures", "ai-paper-flawed.txt"), "utf8");

const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = {};
  function hashText(s) { return "h" + s.length; }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ unfindableStudy, searchedEmpty, unfoundStudy, studyFinding, evidenceReplacement, pickReplacement, unfoundHtml, UNFOUND_COPY })`, vm.createContext({}));

const TWELVE = "A study involving 12 college students found that 10 participants reported positive experiences using AI.";
const SURVEY = "Furthermore, a survey of 25 students at a California high school found that 22 students preferred using ChatGPT rather than traditional textbooks.";
const HARVARD = "According to a 2023 study conducted by Harvard University, approximately 87% of students who used AI tools improved their grades by at least two letter grades within a semester.";
const PEW = "According to a 2024 Pew survey, 26% of U.S. teens have used ChatGPT for schoolwork.";
const EMPTY = { loading: false, list: [], unbacked: 3, unread: [], partial: null };

test("which sentences it is: a study nobody is named for, not a named or cited one", () => {
  for (const s of [TWELVE, SURVEY, "A recent study found that 80% of teachers believe AI saves them time.", "One experiment showed that students who used AI scored 30 percent higher on tests."]) {
    assert.equal(X.unfindableStudy(s), true, s);
  }
  for (const s of [HARVARD, PEW, "Smith (2020) found that students learn more with feedback.", "A study found that students learn more with feedback (Lee, 2021).", "Students learn more with feedback."]) {
    assert.equal(X.unfindableStudy(s), false, s);
  }
  assert.ok(PAPER.includes(SURVEY.slice(14)), "the owner's paper has the survey sentence");
});

test("only once its search came back with nothing: not while it runs, not with a source to trim or to open", () => {
  assert.equal(X.unfoundStudy(TWELVE, EMPTY), true);
  assert.equal(X.unfoundStudy(TWELVE, { ...EMPTY, unbacked: 0 }), true, "nothing on the topic at all");
  assert.equal(X.unfoundStudy(TWELVE, undefined), false, "never searched: no verdict on it");
  assert.equal(X.unfoundStudy(TWELVE, { loading: true }), false);
  assert.equal(X.unfoundStudy(TWELVE, { ...EMPTY, list: [{ url: "x" }] }), false, "a source backs it");
  assert.equal(X.unfoundStudy(TWELVE, { ...EMPTY, partial: { url: "x" } }), false, "a source backs all but a detail: trim it instead");
  assert.equal(X.unfoundStudy(TWELVE, { ...EMPTY, unread: [{ url: "x" }] }), false, "a source it couldn't open might be it: never 'can't find'");
  assert.equal(X.unfoundStudy(HARVARD, EMPTY), false, "a named source is a citation issue, never 'delete it'");
});

test("the point it is said to have found, without the study: what a real source could back", () => {
  assert.equal(X.studyFinding(TWELVE), "College students reported positive experiences using AI.", "the owner's sentence: no counts, and 'participants' are who the study was of");
  assert.equal(X.studyFinding(SURVEY), "Students preferred using ChatGPT rather than traditional textbooks.");
  assert.equal(X.studyFinding("A recent study found that 80% of teachers believe AI saves them time."), "Teachers believe AI saves them time.");
  assert.equal(X.studyFinding("One experiment showed that students who used AI scored 30 percent higher on tests."), "Students who used AI scored higher on tests.", "its figures go too");
  assert.equal(X.studyFinding("According to a recent survey, most teenagers use AI for homework."), "Most teenagers use AI for homework.");
  assert.equal(X.studyFinding("A study found that it works."), null, "too little left to search");
  assert.equal(X.studyFinding("Students learn more with feedback."), null, "not a study");
});

const PEW_SRC = { url: "https://www.pewresearch.org/short-reads/2025/01/15/about-a-quarter-of-us-teens-have-used-chatgpt-for-schoolwork/", title: "About a quarter of U.S. teens have used ChatGPT for schoolwork", publisher: "Pew Research Center", groupAuthor: "Pew Research Center", kind: "institutional", year: 2025, stance: "supports", verified: true, quote: "About a quarter of U.S. teens say they have used ChatGPT for schoolwork" };
const PAPER_SRC = { url: "https://doi.org/10.1/x", title: "AI and learning", authors: ["Jane Lee", "Sam Park"], year: 2023, kind: "article", container: "Computers & Education", stance: "supports", verified: true, quote: "students reported that AI feedback helped them revise" };

test("the replacement: the source's own words in quotation marks, and who said them, in the doc's style", () => {
  assert.equal(X.evidenceReplacement(PEW_SRC, "apa"), "According to Pew Research Center (2025), “About a quarter of U.S. teens say they have used ChatGPT for schoolwork.”");
  assert.equal(X.evidenceReplacement(PEW_SRC, "chicago"), "According to Pew Research Center (2025), “About a quarter of U.S. teens say they have used ChatGPT for schoolwork.”");
  assert.match(X.evidenceReplacement(PEW_SRC, "mla"), /^According to Pew Research Center, “About a quarter of U\.S\. teens say they have used ChatGPT for schoolwork” \(“About a Quarter.*”\)\.$|^According to Pew Research Center, “About a quarter of U\.S\. teens say they have used ChatGPT for schoolwork” \(“[^”]+”\)\.$/,
    "MLA cites a body that published its own work by title, so the title goes in the parenthesis and the body is still named");
  assert.equal(X.evidenceReplacement(PAPER_SRC, "apa"), "According to Lee and Park (2023), “students reported that AI feedback helped them revise.”");
  assert.equal(X.evidenceReplacement({ ...PEW_SRC, quote: "word ".repeat(50) }, "apa"), null, "never a long quote dropped into an essay");
  assert.equal(X.evidenceReplacement({ ...PEW_SRC, quote: "Teens use it. Many do so weekly." }, "apa"), null, "one sentence for one sentence (owner, 2026-10-13)");
  assert.equal(X.evidenceReplacement({ ...PEW_SRC, quote: "" }, "apa"), null, "no receipt, no replacement: nothing is written that the source doesn't say");
  // The first backing source that makes one.
  const pick = X.pickReplacement([{ ...PEW_SRC, quote: "" }, PAPER_SRC], "apa");
  assert.equal(pick.src.url, PAPER_SRC.url);
  assert.equal(X.pickReplacement([{ ...PEW_SRC, quote: "" }], "apa"), null);
});

test("the card: delete it — and on Student and Pro, evidence that can take its place", () => {
  const free = X.unfoundHtml(undefined, "<b>ACTS</b>", true);
  assert.match(free, /Tracely couldn't find this study/);
  assert.match(free, /found nothing like it, so a reader can't check it\. Delete the sentence\./);
  assert.match(free, /<b>ACTS<\/b>/);
  assert.match(free, /Student and Pro can replace it with evidence Tracely finds on the same point\.<\/span><button class="act" data-rec-plans="1">See plans<\/button>/, "free: one line on what the plans add");
  const paid = X.unfoundHtml(undefined, "", false);
  assert.match(paid, /Delete the sentence, or replace it with evidence Tracely finds on the same point\./);
  assert.doesNotMatch(paid, /data-rec-plans/);
  assert.match(X.unfoundHtml({ loading: true }, "", false), /Finding evidence on this point…/);
  assert.match(X.unfoundHtml({ none: true }, "", false), /couldn't find evidence on this point either\. Delete the sentence\./);
  const found = X.unfoundHtml({ text: "According to Lee and Park (2023), “students reported that AI feedback helped them revise.”", src: PAPER_SRC }, "", false);
  assert.match(found, /<div class="fix-label">Replace with<\/div><div class="fix-text">According to Lee and Park \(2023\), “students reported that AI feedback helped them revise\.”<\/div>/);
  assert.match(found, /AI and learning · /, "and which source it is");
});

test("wired: both panels, the hover card, the edits, and the plans", () => {
  // Panels: the block replaces the card's own fix row, so the card has one set of buttons.
  assert.equal((SRC.match(/\} else if \(unfoundStudy\(seg\.text, st\)\) \{/g) || []).length, 2, "Docs and field panels");
  assert.equal((SRC.match(/const unfound = unfoundStudy\(seg\.text, sourcesMap\.get\(seg\.hash\)\);/g) || []).length, 2);
  assert.equal((SRC.match(/\$\{unfound \? "" : `<div class="row">\$\{lead\}<button class="act" data-sources/g) || []).length, 2);
  // The hover card: the problem card and the sources step.
  assert.match(SRC, /if \(unfoundStudy\(seg\.text, sourcesMap\.get\(hash\)\)\) \{\n\s+put\(dmHead\(color, UNFOUND_COPY\.head\)\);\n\s+paintUnfound\(hash, put\);/);
  assert.match(SRC, /if \(unfoundStudy\(seg\.text, s\)\) \{\n\s+put\(dmHead\(MARK_COLORS\.questionable, UNFOUND_COPY\.head\), noteEl\(\)\);/);
  // Delete: the note's own one-replace delete, through runDocEdit (the preview, Undo).
  assert.match(SRC, /async function docDeleteSentence\(hash\) \{[\s\S]*?deleteEditFor\(docText, seg\.text\)[\s\S]*?return runDocEdit\(`del:\$\{hash\}`/);
  // Replace: the sentence and its reference entry, one group (citePlan), only what was found.
  assert.match(SRC, /async function docReplaceWithEvidence\(hash\) \{[\s\S]*?citePlan\(seg, styled, rep\.src, \{ swapped: rep\.text \}\)[\s\S]*?runDocEdit\(`rep:\$\{hash\}`/);
  // The search: Student and Pro only, the point not the study, sources that back it.
  assert.equal((SRC.match(/if \(!seg \|\| !canRecommend\(\) \|\| replaceMap\.get\(hash\)\?\.loading\) return false;\n\s+const claim = studyFinding\(seg\.text\);/g) || []).length, 2, "both modes");
  assert.equal((SRC.match(/pickReplacement\(backingSources\(data\.sources, "questionable"\)\.list, settings\.citationStyle \|\| "mla"\)/g) || []).length, 2);
});
