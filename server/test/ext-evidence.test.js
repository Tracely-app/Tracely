/* "Evidence you could add" (content.js evidenceCandidates /
 * evidenceSectionHtml). Owner, 2026-10-03: suggest evidence "depending on
 * what you are writing about … dont force this, as it isnt always necessary,
 * but for example if you are writing about why sleep is good for you it will
 * recommend some good pieces of evidence". Chosen shape: suggest, and search
 * only on a click — a source search costs ~1-6¢ (a check 0.09¢) and the free
 * plan has 5 a day. */
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
    function hashText(s) { const norm = s.toLowerCase().replace(/\\s+/g, " ").trim(); let h = 5381; for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0; return "s" + h.toString(36); }
    ${SRC.slice(a, c)}
    ({ segmentText, evidenceCandidates, evidenceSectionHtml, MAX_EVIDENCE_SUGGESTIONS })`;
  return vm.runInContext(code, vm.createContext({}));
}
const X = load();

const ESSAY = [
  ["Getting enough sleep improves memory and mood.", "accurate"],
  ["Water boils at 100 degrees Celsius at sea level.", "accurate"],          // common knowledge: no cue
  ["Sleep improves memory consolidation (Walker, 2017).", "accurate"],       // already sourced
  ["I think sleep is the best part of the day.", "no_claim"],                // opinion
  ["Pulling an all-nighter has no effect on test scores.", "false"],         // an issue, not a suggestion
  ["Teenagers who sleep less are more likely to feel anxious.", "accurate"],
  ["Regular sleep is good for your heart.", "accurate"],
  ["Lack of sleep weakens the immune system.", "accurate"],
];
function setup(dismissed = []) {
  const text = ESSAY.map(([t]) => t).join(" ");
  const segments = Array.from(X.segmentText(text));
  const cache = new Map();
  for (const seg of segments) cache.set(seg.hash, { verdict: ESSAY.find(([t]) => t === seg.text)[1] });
  const dis = new Set(dismissed.map((t) => segments.find((s) => s.text === t).hash));
  return { segments, cache, dismissed: dis };
}
const texts = (list) => Array.from(list, (s) => s.text);

test("suggests evidence for true, argumentative points — not common knowledge, opinions, sourced or flagged sentences", () => {
  const { segments, cache, dismissed } = setup();
  assert.deepEqual(texts(X.evidenceCandidates(segments, cache, dismissed)), [
    "Getting enough sleep improves memory and mood.",
    "Teenagers who sleep less are more likely to feel anxious.",
    "Regular sleep is good for your heart.",
  ]);
});

test("never more than three, and a dismissed one makes room for the next", () => {
  assert.equal(X.MAX_EVIDENCE_SUGGESTIONS, 3);
  const { segments, cache, dismissed } = setup(["Regular sleep is good for your heart."]);
  assert.deepEqual(texts(X.evidenceCandidates(segments, cache, dismissed)), [
    "Getting enough sleep improves memory and mood.",
    "Teenagers who sleep less are more likely to feel anxious.",
    "Lack of sleep weakens the immune system.",
  ]);
});

test("nothing to suggest, nothing shown; an unchecked sentence is never suggested", () => {
  const { segments } = setup();
  assert.equal(X.evidenceCandidates(segments, new Map(), new Set()).length, 0, "no verdict yet: no suggestion");
  assert.equal(X.evidenceSectionHtml([], true, () => "", () => false), "");
});

test("the section starts folded, and opens onto cards that search only when clicked", () => {
  const { segments, cache, dismissed } = setup();
  const list = X.evidenceCandidates(segments, cache, dismissed);
  const folded = X.evidenceSectionHtml(list, false, () => "", () => false);
  assert.match(folded, /id="evidenceToggle" aria-expanded="false">▸ Evidence you could add \(3\)/);
  assert.ok(!folded.includes("data-sources"), "folded: no cards");

  const open = X.evidenceSectionHtml(list, true, () => "", () => false);
  assert.equal((open.match(/data-sources="/g) || []).length, 3, "one Find evidence button per suggestion");
  assert.equal((open.match(/data-dismiss="/g) || []).length, 3, "and every one can be dismissed");
  assert.match(open, /Optional — only where evidence would help your argument\./);
  assert.ok(!/class="dot/.test(open), "no finding colour: a suggestion is not a finding");

  // Once searched, the button gives way to the mode's own source list.
  const searched = X.evidenceSectionHtml(list, true, (seg) => `<div class="sources" data-for="${seg.hash}"></div>`, () => true);
  assert.ok(!searched.includes("data-sources="), "no second search button once sources are there");
  assert.equal((searched.match(/class="sources"/g) || []).length, 3);
});

test("wired into both panels, searching only through the click handler", () => {
  assert.match(SRC, /evidenceHints: true/);
  assert.equal((SRC.match(/evidenceSectionHtml\(evidenceCandidates\(segments, cache, dismissed\), showEvidence, sourcesFor, \(seg\) => sourcesMap\.has\(seg\.hash\)\)/g) || []).length, 2);
  assert.equal((SRC.match(/getElementById\("evidenceToggle"\)\?\.addEventListener/g) || []).length, 2);
  // evidenceCandidates is read by the panels and nothing else: no automatic search path.
  assert.equal((SRC.match(/evidenceCandidates\(/g) || []).length, 3, "the definition and the two panels");
});
