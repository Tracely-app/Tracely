/* The reference list checked against itself and the text (content.js
 * referenceListIssues / referenceTips). Owner, 2026-10-04, after a position
 * paper listed one source twice and another nothing in it cited. The clean
 * lists below are written for the eval/citations essays' own in-text
 * citations, in each style those essays use; every one must come back with
 * nothing to say. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const essay = (f) => readFileSync(path.join(ROOT, "eval", "citations", "essays", f), "utf8");

function load() {
  const a = SRC.indexOf("  // Bibliography block");
  const b = SRC.indexOf("  function esc(", a);
  const c = SRC.indexOf("  function wireChrome(", b);
  assert.ok(a > 0 && b > a && c > b, "content.js: the slices moved");
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return "h" + s.length + s.slice(0, 16); }
    ${SRC.slice(a, c)}
    ({ referenceListIssues, referenceTips, referenceTipsHtml })`, vm.createContext({}));
}
const X = load();
const issues = (t) => Array.from(X.referenceListIssues(t)).map((i) => `${i.kind}: ${i.quote.slice(0, 40)}`);

const PAPER = `Access to clean water remains one of the most urgent challenges facing developing nations (Ord & Davies, 2022). Youth councils have pressed for action ("UK Youth Parliament"). Investment has fallen ("Water Matters: State of the Nation", 2025), and Ghosh (2025) calls for youth leadership.

References
Ord, J., & Davies, B. (2022). Young people, youth work and the levelling up agenda. Local Economy, 37(1-2), 104-117. https://doi.org/10.1177/02690942221098971
Ord, J., & Davies, B. (2022). Young people, youth work and the levelling up agenda. Local Economy, 37(1-2), 104-117. https://doi.org/10.1177/02690942221098971
United Nations. (2023). SDG Country Profile Samoa. https://country-profiles.unstatshub.org/wsm
UK Youth Parliament. (2022, March 12). Wikipedia. https://en.wikipedia.org/wiki/UK_Youth_Parliament
Ghosh, A. K. (2025, August 13). Youth in Power: The Missing Link in Representative Governance. ORF.
Department for Culture, Media and Sport. (2025). Water Matters: State of the Nation. GOV.UK.`;

test("a source listed twice, and a source nothing cites, are named — and nothing else", () => {
  const got = issues(PAPER);
  assert.equal(got.length, 2, got.join(" / "));
  assert.ok(got[0].startsWith("refdup: Ord, J., & Davies, B. (2022)"), "the second Ord & Davies");
  assert.ok(got[1].startsWith("refuncited: United Nations. (2023)"), "the Samoa profile");
});

test("the same DOI on two differently written entries is still the same source", () => {
  const t = PAPER.replace(/^Ord, J\., & Davies, B\. \(2022\)\. Young people.*\n(?=Ord)/m, "Ord, J. & Davies, B. 2022. Young People, Youth Work. Local Economy. doi:10.1177/02690942221098971\n");
  assert.ok(issues(t).some((i) => i.startsWith("refdup:")), issues(t).join(" / "));
});

test("a year must agree: an organisation's 2025 page does not cite its 2023 profile", () => {
  const t = PAPER.replace("(Ord & Davies, 2022).", '(Ord & Davies, 2022). The UN urged action ("United Nations: UN Meetings Coverage and Press Releases", 2025).');
  assert.ok(issues(t).some((i) => i.startsWith("refuncited: United Nations. (2023)")));
  const cited = PAPER.replace("(Ord & Davies, 2022).", "(Ord & Davies, 2022; United Nations, 2023).");
  assert.ok(!issues(cited).some((i) => i.includes("Samoa") || i.includes("United Nations")), "cited by name and year: fine");
});

test("clean APA: every eval/citations APA citation shape is recognised", () => {
  const t = essay("01-apa-parenthetical.txt") + `

References
Carskadon, M. A. (2011). Sleep in adolescents: The perfect storm. Pediatric Clinics of North America, 58(3), 637-647.
Dunster, G. P., de la Iglesia, L., Ben-Hamo, M., et al. (2018). Sleepmore in Seattle. Science Advances, 4(12).
Jacob, B. A., & Rockoff, J. E. (2011). Organizing schools to improve student achievement. The Hamilton Project.
Later School Start Times and Adolescent Crash Rates. (2018). Journal of Clinical Sleep Medicine, 14(4).
Minges, K. E., & Redeker, N. S. (2016). Delayed school start times and adolescent sleep. Sleep Medicine Reviews, 28, 86-95.
Wheaton, A. G., & Ferro, G. A. (2016). School start times, sleep, behavioral, health, and academic outcomes. Journal of School Health, 86(5), 363-381.`;
  assert.deepEqual(issues(t), []);
});

test("clean MLA: author-page citations, and a source named only in prose", () => {
  const t = essay("02-mla-author-page.txt") + `
Fitzgerald writes that parking shaped the American city (88).

Works Cited
Fitzgerald, F. Scott. The Parking Lot. Scribner, 1925.
Gabbe, C. J., and Gregory Pierce. "The Hidden Cost of Bundled Parking." Housing Policy Debate, vol. 27, no. 2, 2017.
Manville, Michael, and Donald Shoup. "Parking, People, and Cities." Journal of Urban Planning, vol. 131, 2005.
Shoup, Donald. The High Cost of Free Parking. Planners Press, 2005.
Willson, Richard. Parking Reform Made Easy. Island Press, 2013.`;
  assert.deepEqual(issues(t), []);
});

test("clean institutional MLA: quoted titles, an organisation, a full personal name", () => {
  const t = essay("03-mla-institutional.txt") + `

Works Cited
"Background to the Convention." United Nations Human Rights Office, www.ohchr.org.
Hendricks, Tyche. "Fear Keeps Migrants Silent." KQED, 2024.
"IOM Libya Migrant Report Round 44." International Organization for Migration, 2022.
"Report of the Independent Fact-Finding Mission on Libya." United Nations Human Rights Council, 2023.
"Status of Ratification Interactive Dashboard." United Nations Human Rights Office.
World Bank. Migration and Development Brief 40. 2024.`;
  assert.deepEqual(issues(t), []);
});

test("numbered and footnoted work: only duplicates are checked", () => {
  const ieee = "Solar costs fell sharply [1]. Storage followed [2].\n\nReferences\n1. A. Smith, Solar, 2020.\n2. B. Jones, Storage, 2021.\n3. C. Lee, Unused, 2019.";
  assert.deepEqual(issues(ieee), [], "a [n] list: the number is the link, and it is not traced");
  assert.deepEqual(issues(ieee.replace("3. C. Lee, Unused, 2019.", "1. A. Smith, Solar, 2020.")), ["refdup: 1. A. Smith, Solar, 2020."], "a duplicate is still a duplicate");
  const notes = essay("05-chicago-notes.txt") + "\n\nBibliography\nEisenstein, Elizabeth. The Printing Press as an Agent of Change. 1979.\nJohns, Adrian. The Nature of the Book. 1998.\nUnread, Somebody. Never Cited. 2001.";
  assert.deepEqual(issues(notes), [], "footnote markers: not traced");
});

test("no list, or a one-line list: nothing to check", () => {
  assert.deepEqual(issues(essay("01-apa-parenthetical.txt")), []);
  assert.deepEqual(issues("Some text (Smith, 2020).\n\nReferences\nJones, A. (2019). Other."), []);
});

test("the tips: own section, dismissable, the duplicate's note says which copy to delete", () => {
  const tips = Array.from(X.referenceTips(PAPER, new Set()));
  assert.deepEqual(tips.map((t) => t.kind), ["refdup", "refuncited"]);
  assert.match(tips[0].message, /listed twice/i);
  assert.match(tips[1].message, /Nothing in your text cites this source/);
  assert.equal(X.referenceTips(PAPER, new Set([tips[0].id])).length, 1, "dismissed");
  assert.match(X.referenceTipsHtml(tips, null), /Reference list \(2\)/);
  assert.equal(X.referenceTipsHtml([], null), "");
});

test("wired: essays and papers, both panels, counted on the launcher", () => {
  assert.match(SRC, /refList: true,/);
  assert.equal((SRC.match(/const refTips = FEATURES\.refList && isArgumentGenre\(docGenre\) \? referenceTips\((?:docText|fieldText), dismissed\) : \[\];/g) || []).length, 2);
  assert.equal((SRC.match(/const flagged = issues\.length \+ offTopic\.length \+ refTips\.length \+ essayNotes\.length;/g) || []).length, 2);
  assert.equal((SRC.match(/\(refTips\.length \? referenceTipsHtml\(refTips, copiedTipId\) : ""\)/g) || []).length, 2);
});
