/* The owner's twelve acceptance tests for essay revision (2026-10-05), on a
 * deliberately flawed Mongol essay whose sentence-by-sentence fixes negated
 * false claims instead of removing them, kept a fabricated Einstein quotation
 * and invented bibliography entries, kept unusable citations, and hedged
 * unsupported claims.
 *
 * What is tested here is everything that does not depend on a model's
 * judgement: the rules the server enforces on the essay review's answer
 * (validateEssayReview), the extension's free local checks, and the prompts'
 * instructions. Whether the model raises each finding in the first place is
 * measured by eval/revision/run.mjs against eval/revision/flawed-mongols.txt,
 * which needs an OpenAI key. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEssayReview, isBareNegation, addsNothingNew } from "../lib/factcheck.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const FACTCHECK = readFileSync(path.join(HERE, "..", "lib", "factcheck.js"), "utf8");
const ESSAY = readFileSync(path.join(ROOT, "eval", "revision", "flawed-mongols.txt"), "utf8").replace(/\r\n/g, "\n"); // a Windows checkout has CRLF

function loadExt() {
  const f0 = SRC.indexOf("  const ISSUE_VERDICTS =");
  const f1 = SRC.indexOf("  /* Card titles", f0);
  const a = SRC.indexOf("  // Bibliography block");
  const c = SRC.indexOf("  function wireChrome(", a);
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false }; function hashText(s) { return "h" + s.length + s.slice(0, 24); }
    ${SRC.slice(f0, f1)}
    ${SRC.slice(a, c)}
    ({ citationHygieneTips, referenceListIssues, quoteCitationTips, hasCitationMark, correctionResidue, smallEdit, usableRevision, flagShown, resolvedNotes, essayFeedbackHtml, essayFeedbackTips, UNBACKED_NOTE })`, vm.createContext({}));
}
const X = loadExt();
const review = (findings, genre = "essay") => validateEssayReview(ESSAY, { genre, findings }).findings;
const DOLLAR = "The Mongols invented the American dollar.";

test("1. the American-dollar claim is removed, not merely negated", () => {
  assert.ok(ESSAY.includes(DOLLAR));
  const [f] = review([{ quote: DOLLAR, kind: "reasoning", status: "confirmed", action: "rewrite", message: "False.", suggestion: "Furthermore, the Mongols did not invent the American dollar." }]);
  assert.equal(f.action, "delete", "a negating rewrite becomes a deletion");
  assert.equal(f.suggestion, "");
  assert.equal(X.usableRevision(DOLLAR, "Furthermore, the Mongols did not invent the American dollar."), "", "the extension offers no negated fix to paste");
  assert.equal(X.usableRevision("Genghis Khan died in 1300.", "Genghis Khan died in 1227."), "Genghis Khan died in 1227.", "a real correction is kept");
  assert.match(FACTCHECK, /never a bare negation: if the corrected sentence would not serve the essay, "" \(delete it\)\./, "the check is told so");
});

test("2. irrelevant anecdotes and analogies are deleted, never reworded", () => {
  for (const quote of [
    "Buying shoes through online shopping is fast and convenient today.",
    "Basketball requires teamwork, just like an empire does.",
    "My friend visited a Buddhist temple and said it was very peaceful.",
    "Pizza originated in Italy.",
  ]) {
    assert.ok(ESSAY.includes(quote), quote);
    const [f] = review([{ quote, kind: "relevance", status: "confirmed", action: "rewrite", message: "Off the argument.", suggestion: "Pizza is not evidence of Mongol influence." }]);
    assert.equal(f.action, "delete", quote);
    assert.equal(f.suggestion, "", quote);
  }
  assert.match(FACTCHECK, /"relevance": a sentence that does not support the argument — an anecdote, an analogy, an aside/);
});

test("3. the fabricated Einstein quotation and the invented Harvard/Einstein entries do not survive", () => {
  const einstein = "As Albert Einstein wrote in his book about Genghis Khan, “The Mongols invented everything we use today” (Einstein 1206: 45).";
  const entries = ["Einstein, Albert. Genghis Khan and Everything. 1206.", "Harvard. Why Mongols Were Always Right."];
  for (const q of [einstein, ...entries]) assert.ok(ESSAY.includes(q), q);
  const out = review([
    { quote: einstein, kind: "quotation", status: "confirmed", action: "rewrite", message: "Einstein was born in 1879.", suggestion: "As Albert Einstein wrote, the Mongols invented many things." },
    { quote: entries[0], kind: "bibliography", status: "confirmed", action: "rewrite", message: "Impossible date.", suggestion: "Einstein, Albert. Genghis Khan. 1950." },
    { quote: entries[1], kind: "source", status: "unverified", action: "needs_info", message: "No author, title or date can be found.", suggestion: "" },
  ]);
  assert.deepEqual(out.map((f) => f.action), ["delete", "delete", "needs_info"]);
  assert.ok(out.every((f) => f.suggestion === ""), "no rewrite can carry a fabricated source forward");
  assert.match(FACTCHECK, /an author who could not have written it \(Einstein in 1206\)/);
});

test("4. incomplete citations are flagged, and missing metadata is never invented", () => {
  const bracket = X.citationHygieneTips(ESSAY).find((t) => t.kind === "badcite");
  assert.equal(bracket.quote, "[History.com / Gutenberg / accessed yesterday]");
  const polo = X.referenceListIssues(ESSAY).find((r) => r.quote.startsWith("Polo, Marco."));
  assert.equal(polo.kind, "refincomplete");
  assert.deepEqual(Array.from(polo.missing), ["the page as a number", "the source's actual title"]);
  for (const t of X.citationHygieneTips(ESSAY)) assert.ok(!/\b(?:19|20)\d\d\b/.test(t.message), "no date supplied for the writer");
  const [c] = review([{ quote: "[History.com / Gutenberg / accessed yesterday]", kind: "citation", status: "confirmed", action: "rewrite", message: "Unusable.", suggestion: "(History.com, 2021)" }]);
  assert.equal(c.suggestion, "", "a citation is never 'fixed' with a made-up year");
});

test("5. 'some researchers' plus 'requires verification' is not support", () => {
  const tips = X.citationHygieneTips(ESSAY);
  assert.ok(tips.some((t) => t.kind === "placeholder" && /requires verification/.test(t.quote)));
  assert.ok(tips.some((t) => t.kind === "vague" && /^Some historians say/.test(t.quote)));
  const s = "Some researchers have argued that literacy expanded across parts of the empire.";
  assert.equal(X.hasCitationMark(s), false);
  assert.equal(X.flagShown({ verdict: "needs_citation" }, {}, "prose", s), true, "an unnamed source does not hide Missing citation");
  assert.match(FACTCHECK, /an unnamed one \("some researchers", "studies show"\) does not\./);
  const [h] = review([{ quote: "The movement of ideas may have contributed to increased literacy in some parts of the empire.", kind: "evidence", status: "unsupported", action: "rewrite", message: "Hedged, still unsupported.", suggestion: "Ideas may have spread literacy, according to some scholars." }]);
  assert.equal(h.suggestion, "", "a hedge is not a fix");
});

test("6. institutional prestige is not a reason to omit citation details", () => {
  const t = X.citationHygieneTips(ESSAY).find((x) => x.kind === "excuse");
  assert.equal(t.quote, "The study does not need a publication date because Harvard is a famous institution.");
  assert.match(t.message, /reputation never excuses missing citation details/);
});

test("7. a DBQ's document-number citation is not flagged for failing MLA", () => {
  assert.deepEqual(Array.from(X.quoteCitationTips("Document 2 says “travelers could cross the empire in safety” (Doc 2).", "mla")), []);
  assert.equal(X.hasCitationMark("Document 2 explains that travelers could move safely through Mongol territory."), true);
  assert.equal(X.hasCitationMark("Travelers moved safely through Mongol territory (Doc 2)."), true);
  assert.equal(X.flagShown({ verdict: "needs_citation" }, {}, "prose", "Travelers moved safely through Mongol territory (Doc 2)."), false);
  assert.match(FACTCHECK, /Do NOT apply MLA or APA to a DBQ's document-number citations/);
});

test("8. missing document metadata never produces invented sourcing analysis", () => {
  const [s] = review([{ quote: "", kind: "sourcing", status: "possible", action: "rewrite", message: "No document gets sourcing.", suggestion: "Document 2 was written by a Persian official to flatter the Khan." }], "dbq");
  assert.equal(s.suggestion, "");
  assert.equal(s.action, "needs_info");
  assert.match(FACTCHECK, /never describe a document's author, purpose, audience or contents — say what sourcing is missing and ask for the document packet/);
});

test("9. a corrected draft keeps no chain of 'does not prove' statements", () => {
  const draft = "The Mongols linked Eurasia through trade. This does not prove anything about Mongol influence. Pizza is not evidence of Mongol power. However, the tolerance did not mean they abandoned their own beliefs.";
  assert.deepEqual(Array.from(X.correctionResidue(draft)), ["This does not prove anything about Mongol influence.", "Pizza is not evidence of Mongol power."], "a contrast ('However … did not mean') is argument, not residue");
  assert.ok(isBareNegation("The Mongols invented the American dollar.", "The Mongols did not invent the American dollar."));
  assert.ok(!isBareNegation("Genghis Khan died in 1300.", "Genghis Khan died in 1227 during a campaign."));
});

test("10. a new factual assertion added while revising is checked like the original", () => {
  assert.equal(X.smallEdit("The Mongols invented the American dollar.", "The Mongols introduced paper money across their empire."), false, "a new claim gets a fresh check, not the old verdict");
  assert.equal(X.smallEdit("Genghis Khan died in 1300.", "Genghis Khan died in 1227."), false, "a changed figure is re-checked");
  assert.equal(addsNothingNew("The Mongols linked Eurasia through trade.", ESSAY), true);
  assert.equal(addsNothingNew("Marco Polo reached Beijing in 1275 with 40 merchants.", ESSAY), false, "a review rewrite may not bring in a new figure or name");
});

test("11. an unsuccessful source search is 'unverified', never 'fabricated'", () => {
  assert.ok(!/fabricat|fake|invented/i.test(X.UNBACKED_NOTE(3)));
  assert.match(SRC, /That does not make the claim wrong — it means there is nothing here to cite for it yet\./);
  assert.match(FACTCHECK, /A source or quotation you cannot confirm is "questionable", never "false", unless impossible on its face/);
  assert.match(FACTCHECK, /a source you merely cannot place is "unverified", never "fabricated"/);
});

test("12. the output separates what was fixed from what is still open", () => {
  const first = Array.from(X.essayFeedbackTips(ESSAY, [
    { quote: "Pizza originated in Italy.", kind: "relevance", status: "confirmed", action: "delete", message: "Delete." },
    { quote: "", kind: "thesis", status: "possible", action: "needs_info", message: "State a claim." },
  ], new Set()));
  const seen = new Map(first.map((t) => [t.id, t]));
  const revised = ESSAY.replace("Pizza originated in Italy.", "");
  const open = Array.from(X.essayFeedbackTips(revised, [{ quote: "", kind: "thesis", status: "possible", action: "needs_info", message: "State a claim." }], new Set()));
  const fixed = Array.from(X.resolvedNotes(seen, open, revised));
  assert.deepEqual(fixed.map((t) => t.kind), ["relevance"]);
  const html = X.essayFeedbackHtml(open, false, null, fixed);
  assert.match(html, /Writing feedback \(1\)/, "still open");
  assert.match(html, /Fixed since an earlier review \(1\): Doesn't support the argument/);
  assert.match(html, /Needs more information · possible/, "how sure, and what to do");
  assert.match(X.essayFeedbackHtml([], false, null, fixed), /Nothing open from the last review\./, "never 'flawless' — only that nothing from the last review is open");
});
