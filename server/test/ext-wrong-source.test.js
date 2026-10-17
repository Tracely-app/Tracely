/* Owner, 2026-10-15, with an answer key for a twenty-sentence test sheet
 * (fixtures/citation-key.js) on which Tracely got 11 of 20:
 *   - "Correct fact, wrong citation" (Venus cited to the OECD and the CDC,
 *     PISA and neuroplasticity to NASA): the owner chose an amber "Wrong
 *     source" card. The server's wrong-source check (lib/citeFit.js,
 *     test/cite-fit.test.js) answers "wrong_source", only to a build that
 *     asks (FEATURES.citeFit, off until measured: eval/citefit/run.mjs).
 *   - "Correct fact, missing citation" where an organisation is named and
 *     not cited ("The Centers for Disease Control and Prevention
 *     recommends …"): "named sources only", the extension's "Source not
 *     cited" note (orgCredited), as for a study's source on 10-14.
 *   - Acronyms (UNESCO, NASA) are names: a sentence naming one is not a
 *     general statement, whose "Needs evidence" flagShown hides. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";
import { CITATION_KEY, CITATION_KEY_DOC } from "./fixtures/citation-key.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const X = vm.runInContext(`
  const CHECK_INTERVAL_MS = 10000;
  const FEATURES = { citeHintsToggle: false };
  function hashText(s) { return s; }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  const VERDICT_LABEL =", '  /* A "Needs evidence" sentence')}
  ${sliceBetween(SRC, "  // The mark vocabulary is the desktop app's", "  const MARK_PENDING")}
  ${sliceBetween(SRC, "  const MARK_PATTERN =", "  const MARK_ICON_RANK")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ flagShown, isGeneralStatement, citationHygieneTips, orgCredited, replacedCitationOf, flaggedCitationOf, verdictCat, ISSUE_VERDICTS, VERDICT_LABEL, MARK_COLORS, VERDICT_WASH, VERDICT_TEXT, MARK_PATTERN, MARK_ICON })`, vm.createContext({}));

const byN = (n) => CITATION_KEY.find((x) => x.n === n).text;

test("wrong_source: amber, a citation issue, titled \"Wrong source cited\", drawn in an essay and never in a quiet kind", () => {
  assert.ok(X.ISSUE_VERDICTS.includes("wrong_source"));
  assert.equal(X.VERDICT_LABEL.wrong_source, "Wrong source cited");
  assert.equal(X.MARK_COLORS.wrong_source, X.MARK_COLORS.needs_citation, "amber, the citation colour");
  assert.equal(X.VERDICT_WASH.wrong_source, X.VERDICT_WASH.needs_citation);
  assert.equal(X.VERDICT_TEXT.wrong_source, X.VERDICT_TEXT.needs_citation);
  assert.equal(X.MARK_PATTERN.wrong_source, "solid");
  assert.equal(X.MARK_ICON.wrong_source, "cite");
  assert.equal(X.verdictCat("wrong_source"), "cite", "under the Citations tab");
  assert.match(SRC, /function verdictKind\(v\) \{\s*return [^;]*v === "needs_citation" \|\| v === "wrong_source" \? "cite"/, "its dot is the citation dot");
  assert.match(SRC, /const STORED_VERDICTS = new Set\(\[[^\]]*"wrong_source"/, "kept with the doc like the rest");
  const f = { verdict: "wrong_source", explanation: "NASA does not publish PISA results; the OECD does." };
  assert.equal(X.flagShown(f, {}, "prose", byN(8)), true);
  assert.equal(X.flagShown(f, {}, "poem", byN(8)), false);
});

test("a source picked for a wrong-source sentence takes the wrong citation's place, and the wrong work is never looked up", () => {
  assert.equal(X.replacedCitationOf("wrong_source", byN(8))?.raw, "(NASA, 2023)");
  assert.equal(X.flaggedCitationOf("wrong_source", byN(8)), null, "no \"Find the cited work\": it is not the work the claim comes from");
  assert.equal(X.replacedCitationOf("questionable", byN(8))?.raw, "(NASA, 2023)", "the doubtful verdicts as before");
  assert.equal(X.replacedCitationOf("accurate", byN(8)), null);
});

test("the check asks for the wrong-source check only while FEATURES.citeFit is on, and it is off until measured", () => {
  assert.match(SRC, /citeFit: false, {7}\/\/ \/api\/check also asks/);
  const asks = SRC.match(/\.\.\.\(FEATURES\.citeFit \? \{ citeFit: true \} : \{\}\)/g) ?? [];
  assert.equal(asks.length, 2, "the Docs check and the field check");
});

test("an organisation credited by name with no citation is \"Source not cited\": the key's 3 and 16", () => {
  const notes = X.citationHygieneTips(CITATION_KEY_DOC).filter((t) => t.kind === "uncited");
  const flagged = new Set(notes.map((t) => CITATION_KEY.find((x) => x.text === t.quote)?.n));
  for (const n of [3, 16]) assert.ok(flagged.has(n), `sentence ${n}`);
  for (const n of [1, 6, 10, 13, 4, 8, 14, 19]) assert.ok(!flagged.has(n), `sentence ${n} carries a citation`);
  assert.deepEqual([...flagged].sort((a, b) => a - b), [3, 12, 16, 17], "12 and 17 name the OECD uncited too; their red card carries the note");
  assert.equal(notes.find((t) => t.quote === byN(3)).source, "Centers for Disease Control and Prevention");
  assert.match(notes.find((t) => t.quote === byN(3)).message, /names its source \(Centers for Disease Control and Prevention\) but doesn't cite it/);
});

test("who counts as an organisation: an acronym or a body's name — never a person, and not where it sits", () => {
  const cases = [
    ["The Centers for Disease Control and Prevention recommends that teens sleep more.", "Centers for Disease Control and Prevention"],
    ["In 2023, UNESCO published guidance on generative AI.", "UNESCO"],
    ["Because the OECD identified an association, schools acted.", "OECD"],
    ["In 2024 the regional director of the National Labor Relations Board in Boston found that the firing was illegal.", "National Labor Relations Board"],
    ["The World Health Organization has warned that loneliness harms health.", "World Health Organization"],
    ["Einstein found that light bends near the Sun.", ""],
    ["Shakespeare wrote Hamlet around 1600.", ""],
    ["The study found that sleep matters.", ""],
    ["Many experts recommend more sleep.", ""],
  ];
  for (const [s, want] of cases) assert.equal(X.orgCredited(s), want, s);
});

test("no note where the writing cites nothing, where the next sentence cites it, or where the reference list names the body", () => {
  const S = "The Centers for Disease Control and Prevention recommends that teenagers sleep 8 to 10 hours a night.";
  assert.equal(X.citationHygieneTips(`${S} Sleep matters for grades.`).filter((t) => t.kind === "uncited").length, 0, "writing that cites nothing: the check's own Missing citation asks there");
  const cited = "Phones distract students (Kim, 2021).";
  assert.equal(X.citationHygieneTips(`${cited}\n${S}`).filter((t) => t.kind === "uncited").length, 1);
  assert.equal(X.citationHygieneTips(`${cited}\n${S} This was confirmed again in 2024 (CDC, 2024).`).filter((t) => t.kind === "uncited").length, 0, "the next sentence cites it");
  const listed = `${cited}\n${S}\n\nWorks Cited\nCenters for Disease Control and Prevention. (2024). Sleep in teens. cdc.gov.\nKim, J. (2021). Phones. Journal.`;
  assert.equal(X.citationHygieneTips(listed).filter((t) => t.kind === "uncited").length, 0, "MLA: named in the sentence, listed in Works Cited, is cited");
  const byInitials = `${cited}\nThe CDC recommends that teenagers sleep 8 to 10 hours.\n\nReferences\nCenters for Disease Control and Prevention. (2024). Sleep in teens. cdc.gov.\nKim, J. (2021). Phones. Journal.`;
  assert.equal(X.citationHygieneTips(byInitials).filter((t) => t.kind === "uncited").length, 0, "the CDC is the entry spelled out");
});

test("an acronym is a name, so a sentence naming one is not a general statement; \"AI\" is still a word", () => {
  assert.equal(X.isGeneralStatement(byN(16)), false, "UNESCO");
  assert.equal(X.isGeneralStatement(byN(17)), false, "OECD");
  assert.equal(X.isGeneralStatement(byN(19)), false, "(NASA, 2023)");
  assert.equal(X.isGeneralStatement("Teachers should explain how AI tools can be wrong."), true);
  assert.equal(X.isGeneralStatement(byN(5).split(". ")[0] + "."), true, "the key's 5: a general claim");
});
