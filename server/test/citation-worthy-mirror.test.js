/* `citationWorthy` and `isGeneralStatement` exist twice: the desktop's
 * src/shared/citationWorthy.ts and the extension's copy in content.js (a
 * content script has no modules). Both copies' comments named this test; it
 * did not exist until 2026-10-13. Both run over one corpus and must agree,
 * and the corpus pins what the rule says (owner, 2026-10-04: a sentence owes
 * a source of its own only for a number, a direct quotation or a research
 * finding; the check's rule: a date is not a quantity). */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const DESKTOP = path.join(HERE, "..", "..", "src", "shared", "citationWorthy.ts");

/* The extension's copy: from the TEST ANCHOR at ISSUE_VERDICTS to the next
 * one, the block flagShown and its rules live in. */
function loadExtension() {
  const ANCHOR = "  // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.\n";
  const a = SRC.indexOf(ANCHOR + "  const ISSUE_VERDICTS");
  const b = SRC.indexOf(ANCHOR, a + ANCHOR.length);
  assert.ok(a > 0 && b > a, "content.js: the flagShown block moved");
  return vm.runInContext(`const FEATURES = { citeHintsToggle: false };\n${SRC.slice(a, b)}\n({ citationWorthy, isGeneralStatement, flagShown })`, vm.createContext({}));
}
const ext = loadExtension();

let SKIP = false;
if (!existsSync(DESKTOP)) SKIP = "no desktop tree (a server-only checkout)";
else if (!process.features?.typescript) SKIP = `this Node (${process.version}) cannot strip TypeScript types`;
const desktop = SKIP ? null : await import(pathToFileURL(DESKTOP).href);

const WORTHY = [
  "Spending on youth facilities fell by 73% between 2010 and 2023.",
  "Nearly half of teenagers report sleeping under seven hours.",
  "Millions of students now own a smartphone.",
  'Malala said "one child, one teacher, one book and one pen can change the world."',
  "A 2019 study found that later start times improved attendance.",
  "Research shows that sleep consolidates memory.",
  "According to the World Bank, remittances exceed aid.",
  "In 2019 there were 1,274 measles cases in the United States.",
  "The war killed about 1500 soldiers in a single day.",
  "The city's population doubled between 1950 and 2000.",
  "MacArthur promised \"I shall return\" before leaving the islands.",
  "Unemployment reached 25 percent in 1933.",
  // spelled-out figures: a year beside them used to be what made these count
  "Uruguay hosted and won the first World Cup in 1930, and only four European teams made the trip.",
  "Around four in ten London residents were born outside the UK as of 2021.",
  "By 2023 thirty states had set their own minimum wages above the federal rate.",
  "By the 2010s, the average surface temperature was about one degree Celsius higher than in the late 1800s.",
];
const NOT_WORTHY = [
  "Smartphones have changed how students learn.",
  "This shows that schools must adapt to new tools.",
  // dates, spans, decades, ordinals, times, labels: not quantities
  "Truman became president in 1945.",
  "MacArthur died in 1964 at Walter Reed.",
  "The war lasted from 1939 to 1945.",
  "Printing spread across Europe in the 15th century.",
  "The movement grew through the 1960s.",
  "The 2010/11 season changed the league.",
  "Chapter 5 is where the creature first speaks.",
  "World War 2 reshaped the map of Europe.",
  "COVID-19 closed schools across the country.",
  "School starts at 8:30 in most districts.",
  // a quoted title is a name, not someone's words
  'Frost wrote "The Road Not Taken" while living in England.',
  'Austen published "Pride and Prejudice" anonymously.',
];

test("the rule: numbers, quotations and findings owe a source; dates, labels and quoted titles do not", () => {
  for (const s of WORTHY) assert.equal(ext.citationWorthy(s), true, `extension: ${s}`);
  for (const s of NOT_WORTHY) assert.equal(ext.citationWorthy(s), false, `extension: ${s}`);
});

test("the extension hides a citation flag on a dated sentence, keeps it on a figure", () => {
  const f = { verdict: "needs_citation" };
  assert.equal(ext.flagShown(f, {}, "prose", "MacArthur died in 1964 at Walter Reed.", false), false);
  assert.equal(ext.flagShown(f, {}, "prose", "In 2019 there were 1,274 measles cases in the United States.", false), true);
  assert.equal(ext.flagShown({ verdict: "false" }, {}, "prose", "MacArthur died in 1964 at Walter Reed.", false), true, "a wrong date is still wrong");
});

test("the desktop and the extension agree on every sentence", { skip: SKIP }, () => {
  for (const s of [...WORTHY, ...NOT_WORTHY]) {
    assert.equal(desktop.citationWorthy(s), ext.citationWorthy(s), `citationWorthy: ${s}`);
    assert.equal(desktop.isGeneralStatement(s), ext.isGeneralStatement(s), `isGeneralStatement: ${s}`);
  }
});
