/* Research paper vs. literary essay vs. essay (content.js essayKind), and the
 * page-number check for direct quotes (quoteCitationTips). Owner, 2026-10-04:
 * "does it have types of writing detection like research paper vs english
 * essay with page number and stuff detection". Every document is invented. */
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
  const code = `
    const CHECK_INTERVAL_MS = 10000;
    function hashText(s) { return "h" + s.length + s.slice(0, 12); }
    ${SRC.slice(a, c)}
    ({ detectGenre, quoteCitationTips, citationTips, citationTipsHtml, genreLineHtml, isArgumentGenre })`;
  return vm.runInContext(code, vm.createContext({}));
}
const X = load();

const RESEARCH = "Screen Time and Sleep in Adolescents\n\nAbstract\nThis study examines screen time and sleep in 1,200 students.\n\nMethods\nWe surveyed students aged 13 to 17 across four schools.\n\nResults\nHeavy users slept 47 minutes less (Hale & Guan, 2015).";
const RESEARCH_SHORT = "Abstract\n\nThis study examines the relationship between screen time and sleep quality in adolescents.";
const LITERARY = [
  "The Great Gatsby: Hope and Illusion",
  "",
  "In the novel, the green light symbolizes Gatsby's hope. The narrator tells us he \"stretched out his arms toward the dark water in a curious way\" (Fitzgerald 21). Later the imagery changes when Nick says \"Gatsby believed in the green light, the orgastic future\" (Fitzgerald). The author uses this motif to show hope becoming illusion. One critic calls Gatsby \"a man of tragic and enduring innocence\" (Bloom).",
  "",
  "Works Cited",
  "Bloom, Harold. \"Gatsby's Dream.\" The Critic, www.thecritic.com/gatsby.",
  "Fitzgerald, F. Scott. The Great Gatsby. Scribner, 1925.",
].join("\n");
const ESSAY_WITH_HEADINGS = "Why Uniforms Matter\nIntroduction\nSchool uniforms reduce bullying, according to several studies.\nThey also save families money over a school year.\nConclusion\nUniforms are worth it.\nWorks Cited\nSmith, J. Uniforms. 2019.";

test("a research paper, a literary essay, and an essay are told apart", () => {
  assert.equal(X.detectGenre(RESEARCH), "research");
  assert.equal(X.detectGenre(RESEARCH_SHORT), "research", "an Abstract heading is enough, however short the text");
  assert.equal(X.detectGenre(LITERARY), "literary");
  assert.equal(X.detectGenre(ESSAY_WITH_HEADINGS), "prose", "Introduction / Conclusion / Works Cited is an essay's shape, not a paper's");
  assert.equal(X.detectGenre("Sleep matters. It helps memory and mood every day."), "prose");
  for (const g of ["prose", "research", "literary"]) assert.equal(X.isArgumentGenre(g), true, g);
  for (const g of ["resume", "letter"]) assert.equal(X.isArgumentGenre(g), false, g);
});

test("the panel says what it is reading the document as — and nothing for a plain essay", () => {
  assert.match(X.genreLineHtml("research"), /Reading this as a research paper/);
  assert.match(X.genreLineHtml("literary"), /Reading this as a literary essay/);
  assert.match(X.genreLineHtml("resume"), /Reading this as a resume/);
  assert.equal(X.genreLineHtml("prose"), "");
});

test("a quote cited without its page is flagged; with a page, or from a web page, it is not", () => {
  const tips = Array.from(X.quoteCitationTips(LITERARY, "mla"));
  assert.deepEqual(tips.map((t) => t.quote), ["\"Gatsby believed in the green light, the orgastic future\" (Fitzgerald)"]);
  assert.equal(tips[0].kind, "page");
  assert.match(tips[0].message, /in MLA, like \(Fitzgerald 23\)/);
  assert.match(tips[0].message, /If the source has no page numbers, leave it/, "never insists: some sources have none");
});

test("every common way of giving a page counts as a page", () => {
  for (const inner of ["Fitzgerald 21", "21", "Tolstoy 1204", "Fitzgerald 21-22", "Fitzgerald 21–22", "Smith, 2019, p. 4", "Smith, 2019, pp. 4-6", "Smith 2019, 23", "Hamlet 3.1.56", "Owen, lines 3-5", "Smith, para. 4", "Smith, n. pag."]) {
    const text = `She writes "sleep is the best medicine for memory" (${inner}).`;
    assert.deepEqual(Array.from(X.quoteCitationTips(text, "mla")), [], inner);
  }
  for (const inner of ["Smith", "Smith, 2019", "Smith 2019", "Smith and Jones"]) {
    const text = `She writes "sleep is the best medicine for memory" (${inner}).`;
    assert.equal(X.quoteCitationTips(text, "mla").length, 1, `${inner} has no page`);
  }
});

test("the advice is written in the writer's citation style", () => {
  const text = "She writes \"sleep is the best medicine for memory\" (Smith, 2019).";
  assert.match(X.quoteCitationTips(text, "apa")[0].message, /in APA, like \(Smith, 2019, p\. 23\)/);
  assert.match(X.quoteCitationTips(text, "chicago")[0].message, /in Chicago, like \(Smith 2019, 23\)/);
  assert.match(X.quoteCitationTips(text, "mla")[0].message, /in MLA, like \(Smith 23\)/);
});

test("not a citation, not a quote: left alone", () => {
  assert.deepEqual(Array.from(X.quoteCitationTips("He said \"I will be there by noon tomorrow\" (laughing).", "mla")), [], "a stage direction is not a citation");
  assert.deepEqual(Array.from(X.quoteCitationTips("The study (Smith, 2019) found that sleep helps memory.", "mla")), [], "no quotation, no page needed");
  assert.deepEqual(Array.from(X.quoteCitationTips("She called it \"great\" (Smith).", "mla")), [], "a one-word scare quote is too short to be a quotation");
});

test("citation tips: one section only when there is something to say, dismissable", () => {
  const tips = X.citationTips(LITERARY, "mla", new Set());
  assert.equal(tips.length, 1);
  assert.match(X.citationTipsHtml(tips, null), /Citation tips \(1\)/);
  assert.match(X.citationTipsHtml(tips, null), /Add the page number/);
  assert.ok(!X.citationTipsHtml(tips, null).includes("“\"Gatsby"), "the quote keeps its own marks, not doubled ones");
  assert.equal(X.citationTipsHtml([], null), "", "no tips, no section");
  assert.equal(X.citationTips(LITERARY, "mla", new Set([tips[0].id])).length, 0, "dismissed");
});

test("wired into both panels, beside Resume tips", () => {
  assert.match(SRC, /quoteTips: true,/);
  assert.equal((SRC.match(/\(FEATURES\.offTopic \|\| FEATURES\.quoteTips\) && isArgumentGenre\(docGenre\)\n\s+\? \(offTopic\.length \? offTopicHtml\(offTopic, copiedTipId\) : ""\) \+ \(FEATURES\.quoteTips \? citationTipsHtml\(citationTips\((?:docText|fieldText), settings\.citationStyle, dismissed\), copiedTipId\) : ""\)/g) || []).length, 2);
  assert.equal((SRC.match(/const genreHtml = FEATURES\.resumeTips \|\| FEATURES\.quoteTips \? genreLineHtml\(docGenre\) : "";/g) || []).length, 2);
});
