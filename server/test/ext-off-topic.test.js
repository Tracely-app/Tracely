/* A line that has nothing to do with the rest of the document is flagged
 * (content.js offTopicSentences / offTopicTips). Owner, 2026-10-04, on a
 * Model UN paper with "Lamine Yamal is 19 years old" typed above its
 * references: "if I type something that is completely irrelevant or
 * unrelated flag it." Free and local: a line none of whose meaningful words
 * appears anywhere else in the body. The documents below are invented, and
 * the eval essays are the false-alarm gate. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");

function load() {
  const a = SRC.indexOf("  // Bibliography block");
  const b = SRC.indexOf("  function esc(", a);
  const c = SRC.indexOf("  function wireChrome(", b);
  assert.ok(a > 0 && b > a && c > b, "content.js: the slices moved");
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return "h" + s.length + s.slice(0, 16); }
    ${SRC.slice(a, c)}
    ({ offTopicSentences, offTopicTips, offTopicHtml })`, vm.createContext({}));
}
const X = load();

const PAPER = [
  "Country: Canada",
  "Committee: SDG 6: Clean Water and Sanitation",
  "Delegate Name(s): A. Delegate",
  "",
  "Access to clean water remains one of the most urgent challenges facing developing nations, and Canada recognizes that safe sanitation is the foundation of public health.",
  "In 2022, over two billion people still lacked safely managed drinking water, and contaminated water sources continue to spread cholera and other preventable diseases (WHO, 2023).",
  "Canada has invested in water infrastructure partnerships across sub-Saharan Africa, funding wells, filtration systems and sanitation training for local water committees.",
  "However, funding alone has not closed the gap: rural communities still walk hours to reach a safe water source, and sanitation programs often collapse once outside funding ends.",
  "Therefore, Canada proposes a shared water stewardship fund that trains local technicians to maintain wells and filtration systems long after the first investment.",
  "Each participating nation would contribute to the fund in proportion to its means, and every community receiving a well would elect a water committee to report on its condition, so that broken pumps are repaired within weeks rather than abandoned for years.",
  "Lamine Yamal is 19 years old",
  "",
  "References",
  "World Health Organization. (2023). Drinking-water fact sheet. https://www.who.int/",
  "Samoa Country Profile. (2023). United Nations.",
].join("\n");

test("the stray line is flagged — and nothing else, headers and references included", () => {
  assert.deepEqual(Array.from(X.offTopicSentences(PAPER)), ["Lamine Yamal is 19 years old"]);
  assert.deepEqual(Array.from(X.offTopicSentences(PAPER.replace("Lamine Yamal is 19 years old\n", ""))), [], "the same paper without it: clean");
});

test("found wherever it sits, with or without a full stop", () => {
  const mid = PAPER.replace("Lamine Yamal is 19 years old\n", "").replace("However,", "My favourite pizza topping is pineapple with extra cheese.\nHowever,");
  assert.deepEqual(Array.from(X.offTopicSentences(mid)), ["My favourite pizza topping is pineapple with extra cheese."]);
});

test("never flagged: a title, a line that points back, a line sharing even one word, a short document", () => {
  const titled = "Why Our Wells Keep Failing\n" + PAPER.replace("Lamine Yamal is 19 years old\n", "");
  assert.deepEqual(Array.from(X.offTopicSentences(titled)), [], "a title before the first full sentence");
  const back = PAPER.replace("Lamine Yamal is 19 years old", "That is the part people point at.");
  assert.deepEqual(Array.from(X.offTopicSentences(back)), [], "\"That …\" refers to the paragraph before it");
  const shares = PAPER.replace("Lamine Yamal is 19 years old", "Lamine Yamal drinks bottled water before every match.");
  assert.deepEqual(Array.from(X.offTopicSentences(shares)), [], "\"water\" ties it to the essay: only a line sharing NOTHING is flagged");
  assert.deepEqual(Array.from(X.offTopicSentences("Clean water matters for health.\nLamine Yamal is 19 years old")), [], "too short to have a subject");
});

test("the tip: dismissable by id, in its own section, and only when there is one", () => {
  const tips = Array.from(X.offTopicTips(PAPER, new Set()));
  assert.equal(tips.length, 1);
  assert.equal(tips[0].kind, "offtopic");
  assert.match(tips[0].message, /Nothing in this line connects to the rest of your writing/);
  assert.equal(X.offTopicTips(PAPER, new Set([tips[0].id])).length, 0, "dismissed");
  assert.match(X.offTopicHtml(tips, null), /Off topic \(1\)/);
  assert.match(X.offTopicHtml(tips, null), /Doesn't seem to belong/);
  assert.equal(X.offTopicHtml([], null), "");
});

test("wired: essays and papers only, in both panels, and counted on the launcher", () => {
  assert.match(SRC, /offTopic: true,/);
  assert.equal((SRC.match(/const offTopic = FEATURES\.offTopic && isArgumentGenre\(docGenre\) \? offTopicTips\((?:docText|fieldText), dismissed\) : \[\];/g) || []).length, 2, "never on a resume or a letter");
  assert.equal((SRC.match(/const flagged = issues\.length \+ offTopic\.length \+ refTips\.length;/g) || []).length, 2, "a ✓ never sits over a stray line");
});

/* The gate: no false alarm on any real essay in eval/, and most stray lines
 * dropped into the middle of one are caught. Measured 2026-10-04: 0 false
 * flags; 58/75 caught (a stray line that happens to share one word with the
 * essay — "school" in an essay on school start times — is missed, on
 * purpose: allowing one shared word caught 70/75 but flagged five real
 * paragraphs). */
test("eval essays: no false alarms, and most stray lines caught", () => {
  const essays = readdirSync(path.join(ROOT, "eval", "essays")).filter((f) => f.endsWith(".txt"))
    .map((f) => readFileSync(path.join(ROOT, "eval", "essays", f), "utf8"));
  assert.ok(essays.length >= 10);
  for (const e of essays) assert.deepEqual(Array.from(X.offTopicSentences(e)), [], e.slice(0, 60));
  const strays = ["Lamine Yamal is 19 years old", "My favourite pizza topping is pineapple with extra cheese.", "The Eiffel Tower was completed in 1889 for the World Fair.", "I need to remember to buy milk and eggs after school", "Taylor Swift released a new album last Friday."];
  let caught = 0, total = 0;
  for (const e of essays) {
    const lines = e.split("\n");
    const mid = Math.floor(lines.length / 2);
    for (const s of strays) {
      const found = Array.from(X.offTopicSentences([...lines.slice(0, mid), s, ...lines.slice(mid)].join("\n")));
      assert.ok(found.every((x) => x === s), `only the stray line: ${found}`);
      total++;
      if (found.includes(s)) caught++;
    }
  }
  console.log(`[off-topic] caught ${caught}/${total} stray lines`);
  assert.ok(caught / total >= 0.7, `caught ${caught}/${total}`);
});
