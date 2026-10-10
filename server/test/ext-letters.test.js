/* Extension 2.21.7: letters are a genre of their own, a citation request on
 * the AUTHOR'S OWN account is hidden in any document, and the state tip
 * quotes the writer's own styles. From the owner's ten-document genre demo,
 * 2026-10-04: a cover letter asked to source "I scored a 5 on AP Statistics",
 * a personal statement "we sold 500 boxes", a research paper the sample size
 * of its own survey, and a Texas resume's tip said "(CA) … (California)".
 * Every document below is invented. */
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
  const f0 = SRC.indexOf("  const ISSUE_VERDICTS =");
  const f1 = SRC.indexOf("  /* Card titles", f0);
  assert.ok(a > 0 && b > a && f0 > 0 && f1 > f0, "content.js: the slices moved");
  const code = `
    const CHECK_INTERVAL_MS = 10000;
    const FEATURES = { citeHintsToggle: false };
    function hashText(s) { return s; }
    ${SRC.slice(f0, f1)}
    ${SRC.slice(a, b)}
    ({ detectGenre, resumeFormatIssues, flagShown, segmentText })`;
  return vm.runInContext(code, vm.createContext({}));
}
const X = load();

const COVER_LETTER = "Dear Hiring Manager,\n\nI am applying for the summer intern position at Brightline Analytics. Last year I built a budgeting app that 2,000 students at my school now use.\n\nI taught myself SQL and Python, and I scored a 5 on AP Statistics.\n\nSincerely,\nPriya Shah";
const EMAIL = "Hi Ms. Lopez,\n\nThanks for the feedback on my lab report. I fixed the graph on page 3 and added the 2023 data you mentioned.\n\nBest,\nPriya";
const BLOG = ["Hi everyone, welcome back to the channel", "Today we are looking at why the ocean is salty.", "Rivers carry minerals from rocks into the sea every single day.", "Evaporation removes water but leaves the salt behind over time.", "Over millions of years the salt builds up to about 3.5 percent.", "That is why seawater tastes the way it does today."].join("\n");

test("a letter or email is its own genre; a longer post that only opens with 'Hi' is not", () => {
  // Since 2.21.35 a cover letter and an email are named as such (ext-writing-types.test.js); all three are the writer's own account.
  assert.equal(X.detectGenre(COVER_LETTER), "coverletter");
  assert.equal(X.detectGenre(EMAIL), "email");
  for (const g of ["letter", "email", "coverletter"]) assert.equal(X.flagShown({ verdict: "needs_citation" }, {}, g, "Last year I built a budgeting app that 2,000 students use."), false, g);
  assert.equal(X.detectGenre(BLOG), "prose", "no sign-off on a longer text: an opening 'Hi' is not a letter");
});

test("on a letter or resume, citation and 'questionable' flags are hidden; a wrong public fact still shows", () => {
  for (const verdict of ["needs_citation", "questionable"]) {
    assert.equal(X.flagShown({ verdict }, {}, "letter", "Last year I built a budgeting app that 2,000 students use."), false, `letter ${verdict}`);
    assert.equal(X.flagShown({ verdict }, {}, "resume", "priya.shah@gmail ● (555) 201-8890"), false, `resume ${verdict}`);
  }
  assert.equal(X.flagShown({ verdict: "false" }, {}, "letter", "I studied at the University of Cal Berkeley."), true);
  assert.equal(X.flagShown({ verdict: "questionable" }, {}, "prose", "Students slept 47 minutes less on average."), true, "prose keeps questionable");
});

test("in any document, a citation request on the author's own account is hidden — not one on the world", () => {
  const cite = { verdict: "needs_citation" };
  for (const own of [
    "I spent three summers learning her recipes, and we sold 500 boxes in four months.",
    "We surveyed 1,200 students aged 13 to 17 across four schools.",
    "My team cut costs by 30 percent.",
    "Our club grew from 8 members to 40.",
    "I've run 12 marathons since 2019.",
  ]) assert.equal(X.flagShown(cite, {}, "prose", own), false, own);
  for (const world of [
    "Studies show that students who sleep eight hours score 12 percent higher on tests.",
    "We know that 80 percent of teenagers sleep too little.",
    "As we all know, the ocean is 3.5 percent salt.",
    "We should remember that 40 percent of food is wasted.",
    "The project will cost $3.2 million.",
    "World War I ended in 1918.",
  ]) assert.equal(X.flagShown(cite, {}, "prose", world), true, world);
  assert.equal(X.flagShown(cite, {}, "prose"), true, "no sentence passed: unchanged");
});

test("the state tip quotes the writer's own styles, not a fixed example", () => {
  const resume = ["Sam Lee", "sam@lee.com", "EDUCATION", "North High", "Austin, TX", "EXPERIENCE", "Corner Shop", "Dallas, Texas", "June 2025 – August 2025", "SKILLS", "Excel"].join("\n");
  assert.equal(X.detectGenre(resume), "resume");
  const msgs = Array.from(X.resumeFormatIssues(resume), (i) => i.message);
  assert.ok(msgs.includes("Your locations mix abbreviated states (TX) and spelled-out ones (Texas); pick one style."), JSON.stringify(msgs));
  assert.ok(!msgs.some((m) => m.includes("(CA)")), "never the old hardcoded CA/California");
});

test("a time ending a sentence splits it, in the extension's copy of the splitter too", () => {
  const texts = (t) => Array.from(X.segmentText(t), (s) => s.text);
  assert.deepEqual(texts("Schools should start no earlier than 8:30 a.m. Studies show students sleep more."),
    ["Schools should start no earlier than 8:30 a.m.", "Studies show students sleep more."]);
  assert.deepEqual(texts("We met at 8 a.m. and left at noon."), ["We met at 8 a.m. and left at noon."]);
});
