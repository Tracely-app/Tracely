/* Owner, 2026-10-04: "add a turn off feature on tracely and remove the check
 * now feature. Also it keeps trying to help me with other things such as my
 * physics homework … only make it help on literature."
 *  - Docs: "Check now" became "Turn off" (docsEnabled false, marks cleared).
 *  - Field mode: "Check now"/"Check once" became "Turn off on this site" /
 *    "Turn on for this site".
 *  - detectGenre "homework": nothing sent, nothing flagged, and the panel
 *    says why. Every essay in eval/ must stay writing. */
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
  const f0 = SRC.indexOf("  const ISSUE_VERDICTS =");
  const f1 = SRC.indexOf("  /* Card titles", f0);
  const a = SRC.indexOf("  // Bibliography block");
  const b = SRC.indexOf("  function esc(", a);
  const c = SRC.indexOf("  function wireChrome(", b);
  assert.ok(f0 > 0 && f1 > f0 && a > 0 && b > a && c > b, "content.js: the slices moved");
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false }; function hashText(s) { return s; }
    ${SRC.slice(f0, f1)}
    ${SRC.slice(a, c)}
    ({ detectGenre, looksLikeHomework, flagShown, genreLineHtml, isArgumentGenre })`, vm.createContext({}));
}
const X = load();

const PHYSICS = "3. Determine the net area under the velocity vs time curve (be mindful of positive and negative portions when calculating area).  How does the area under the curve compare to the difference between starting and ending positions on the Position graph?";
const WORKSHEET = [
  "Lab 4: Motion graphs",
  "1. Calculate the slope of the position vs time graph between 0 s and 4 s.",
  "2. What is the velocity of the cart at t = 3 s?",
  "3. Determine the net area under the velocity vs time curve.",
  "4. How does the area under the curve compare to the displacement?",
  "The slope is 2 m/s.",
].join("\n");

test("the owner's physics question, and a worksheet with an answer in it, are homework", () => {
  assert.equal(X.detectGenre(PHYSICS), "homework");
  assert.equal(X.detectGenre(PHYSICS + "\nThe net area is 12 m, which equals the displacement on the position graph."), "homework");
  assert.equal(X.detectGenre(WORKSHEET), "homework");
});

test("writing is never homework: every essay in eval/, a science essay, an essay with a rhetorical question", () => {
  const dir = (d) => readdirSync(path.join(ROOT, "eval", d)).filter((f) => f.endsWith(".txt")).map((f) => readFileSync(path.join(ROOT, "eval", d, f), "utf8"));
  const docs = [...dir("essays"), ...dir("citations/essays")];
  assert.ok(docs.length >= 15);
  for (const d of docs) assert.notEqual(X.detectGenre(d), "homework", d.slice(0, 60));
  const science = "Isaac Newton changed how people understood motion. His laws explained why a cart speeds up when it is pushed and why the Moon stays in orbit. Before him, most scholars followed Aristotle, who thought objects slowed down naturally. Newton showed that friction, not nature, slows a rolling ball. This idea made modern engineering possible.";
  assert.notEqual(X.detectGenre(science), "homework", "a physics topic, but claims, not tasks");
  const rhetorical = "Why do schools still start so early? The evidence says teenagers need more sleep. Districts that moved their start times saw better attendance. Parents and teachers support the change. It is time for every school to follow.";
  assert.notEqual(X.detectGenre(rhetorical), "homework", "one question among claims");
});

test("on homework nothing is flagged, nothing essay-only runs, and the panel says why", () => {
  assert.equal(X.flagShown({ verdict: "false" }, {}, "homework", PHYSICS), false, "even a cached verdict stays hidden");
  assert.equal(X.isArgumentGenre("homework"), false, "no off-topic, reference, citation or evidence notes");
  assert.match(X.genreLineHtml("homework"), /This looks like homework questions\. Tracely checks essays and other writing, so it is staying quiet here\./);
});

test("wired: no sentence is sent on homework, in either mode", () => {
  assert.match(SRC, /writingOnly: true,/);
  assert.equal((SRC.match(/if \(FEATURES\.writingOnly && GENRE_QUIET\.has\(docGenre\)\) return \[\]; \/\/ homework, a poem, a story, a script: nothing to check/g) || []).length, 2);
  assert.match(SRC, /const GENRE_QUIET = new Set\(\["homework", "poem", "story", "script"\]\);/);
});

test("Check now is gone; Docs has Turn off, other sites Turn off / Turn on for this site", () => {
  assert.ok(!/id="checkNow"/.test(SRC) && !/Check once/.test(SRC) && !/getElementById\("checkNow"\)/.test(SRC), "no Check now anywhere");
  assert.match(SRC, /<button class="act" id="turnOff"[^>]*>Turn off<\/button>/);
  assert.match(SRC, /shadow\.getElementById\("turnOff"\)\.addEventListener\("click", turnDocsOff\);/);
  assert.match(SRC, /function turnDocsOff\(\) \{\n\s+docsOn = false;\n\s+expanded = false;\n\s+storageSet\(\{ docsEnabled: false \}\);\n\s+hideDocsPopover\(\);\n\s+clearDocsMarks\(\);/);
  assert.match(SRC, /if \(!docsOn\) \{ if \(docsBars\.length\) clearDocsMarks\(\); return; \}/, "no underline is redrawn while off");
  assert.match(SRC, /id="siteSwitch">\$\{enabled \? "Turn off on this site" : "Turn on for this site"\}<\/button>/);
  assert.match(SRC, /shadow\.getElementById\("siteSwitch"\)\.addEventListener\("click", \(\) => setSiteEnabled\(!enabled\)\);/);
});
