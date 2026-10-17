/* Citations Tracely flags are real ones. Owner, 2026-10-13: "why is tracely so
 * bad at citations right now? … it said that the National Education
 * Associated in the works cited page was not in the article, when it was".
 * On the owner's flawed AI paper (fixtures/ai-paper-flawed.txt) the free
 * citation rules said the NEA entry was cited nowhere — the paper cites it
 * "(NEA, 2024)" after "According to the National Education Association" —
 * and let through every study it never names. Measured on that paper and on
 * every essay in eval/ and the writing-type corpora (192): the paper's eight
 * flags are all real, and no other document gains or loses one. */
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
  ({ citationTips, referenceTips, referenceListIssues, citationHygieneTips, detectGenre, docCitationStyle })`, vm.createContext({ URL }));
const flags = (t) => {
  const g = X.detectGenre(t), st = X.docCitationStyle(t) ?? "mla";
  return [...X.citationTips(t, st, new Set(), g), ...X.referenceTips(t, new Set(), g, st)].map((f) => `${f.kind}: ${String(f.quote)}`);
};

test("the owner's paper: eight flags, every one of them real", () => {
  const got = flags(PAPER);
  const want = [
    "vague: Recent studies have demonstrated that students wh",
    "uncited: According to a 2023 study conducted by Harvard Un", // names its source: a citation issue (2026-10-14)
    "uncited: According to a 2024 Pew survey, 26% of U.S. teens",
    "vague: Furthermore, a survey of 25 students at a Califor",
    "vague: A study involving 12 college students found that ",
    "vague: Although some researchers have questioned the lon",
    "vague: Research from leading universities and educationa",
    "refuncited: UNESCO. (2024). Global artificial intelligen",
  ];
  assert.equal(got.length, want.length, got.join(" | "));
  want.forEach((w, i) => assert.ok(got[i].startsWith(w), `${i}: ${got[i]}`));
  assert.ok(!flags(PAPER).some((f) => /National Education Association/.test(f)), "cited as (NEA, 2024)");
});

test("an organisation's entry is cited by its initials, or by its name beside its year", () => {
  const refs = "\n\nReferences\nNational Education Association. (2024). The impact of AI on integrity.\nJohnson, R. (2023). Testing outcomes. Stanford.\n";
  const issues = (body) => Array.from(X.referenceListIssues(body + refs), (i) => i.kind + ": " + i.quote.slice(0, 30));
  assert.deepEqual(issues("Plagiarism fell 73% (NEA, 2024). Scores rose (Johnson, 2023)."), [], "(NEA, 2024)");
  assert.deepEqual(issues("The National Education Association reported in 2024 that plagiarism fell. Scores rose (Johnson, 2023)."), [], "named with its year");
  assert.deepEqual(issues("Plagiarism fell 73% (NEA, 2019). Scores rose (Johnson, 2023)."), ["refuncited: National Education Association"], "the wrong year is another work");
  assert.deepEqual(issues("The National Education Association has long opposed it. Scores rose (Johnson, 2023)."), ["refuncited: National Education Association"], "named without its year: not a citation of the 2024 entry");
  assert.deepEqual(issues("Plagiarism fell (NE, 2024). Scores rose (Johnson, 2023)."), ["refuncited: National Education Association"], "initials must match whole");
});

test("a study the sentence never names: flagged only where the study does the reporting, in writing that cites sources", () => {
  // The cited sentence is a paragraph of its own: a study the NEXT sentence cites is left alone, by design.
  const cited = (s) => `${s}\n\nScores rose afterwards (Lee, 2021).\n\nReferences\nLee, A. (2021). Scores. Journal of Things.\nKim, B. (2020). Other. Press.\n`;
  // A source note of either kind: "vague" (nobody named, Needs evidence) or "uncited" (named, not cited).
  const vague = (s) => Array.from(X.citationHygieneTips(cited(s))).filter((t) => t.kind === "vague" || t.kind === "uncited").map((t) => t.quote);
  assert.equal(vague("A study involving 12 college students found that 10 liked it.").length, 1);
  assert.equal(vague("According to a 2024 Pew survey, 26% of teens used it.").length, 1);
  assert.equal(vague("Agencies should make it central rather than an experiment on the margins, the evidence suggests.").length, 0, "a word, not a study");
  assert.equal(vague("We surveyed 25 students and found that 22 preferred it.").length, 0, "the writer's own");
  assert.equal(vague("A 2021 study found that scores rose (Lee, 2021).").length, 0, "cited");
  assert.equal(vague("A study by Kim found that attention fell.").length, 0, "who did it is in the reference list");
  assert.equal(vague("Some researchers have questioned the long-term effects.").length, 1, "an unnamed source, more verbs");
  assert.equal(vague("Recent studies have demonstrated that it works.").length, 1);
  // Writing that cites nothing: the check's own "Missing citation" asks there, not this rule.
  assert.equal(Array.from(X.citationHygieneTips("In May 2020 a study of ninety-six thousand patients reported higher mortality. The paper was retracted.")).length, 0);
});

test("a quote is the whole sentence: \"U.S.\" does not end it", () => {
  const t = "According to a 2024 Pew survey, 26% of U.S. teens had used ChatGPT for schoolwork.\n\nReferences\nLee, A. (2021). Scores. Press.\nKim, B. (2020). Other. Press.\n";
  assert.deepEqual(Array.from(X.citationHygieneTips(t), (f) => f.quote), ["According to a 2024 Pew survey, 26% of U.S. teens had used ChatGPT for schoolwork."]);
});
