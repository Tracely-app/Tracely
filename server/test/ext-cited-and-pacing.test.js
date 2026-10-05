/* Two fixes from one report (owner, 2026-10-04):
 *  - "says this has no citation": "… modern education (Cambridge
 *    International, 2018)." got a Missing-citation card. A sentence that
 *    visibly carries a citation never shows needs_citation (flagShown,
 *    hasCitationMark), whatever the model answered.
 *  - the console showed Google's export answering 429 Too Many Requests:
 *    reads back off (exportBackoffMs) instead of retrying at full pace. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");

function load() {
  const f0 = SRC.indexOf("  const ISSUE_VERDICTS =");
  const f1 = SRC.indexOf("  /* Card titles", f0);
  const a = SRC.indexOf("  // Bibliography block");
  const b = SRC.indexOf("  function esc(", a);
  assert.ok(f0 > 0 && f1 > f0 && a > 0 && b > a, "content.js: the slices moved");
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false }; function hashText(s) { return s; }
    ${SRC.slice(f0, f1)}
    ${SRC.slice(a, b)}
    ({ flagShown, hasCitationMark, exportBackoffMs })`, vm.createContext({}));
}
const X = load();
const cite = { verdict: "needs_citation" };

test("the owner's sentence: cited, so never 'Missing citation'", () => {
  const s = "Smartphones are widely used by students around the world, making them an important part of modern education (Cambridge International, 2018).";
  assert.equal(X.hasCitationMark(s), true);
  assert.equal(X.flagShown(cite, {}, "prose", s), false);
  assert.equal(X.flagShown({ verdict: "false" }, {}, "prose", s), true, "a wrong fact in a cited sentence still shows");
});

test("every common citation shape counts", () => {
  for (const s of [
    "Sleep helps memory (Walker, 2017).", "Sleep helps memory (Walker & Stickgold, 2004).", "Sleep helps memory (Walker et al., 2019, p. 4).",
    "Sleep helps memory (Smith, n.d.).", "Sleep helps memory (“Why We Sleep”, 2017).", "Sleep helps memory (“Why We Sleep”).",
    "Sleep helps memory (Walker 45).", "Sleep helps memory (Manville and Shoup 279-281).", "Sleep helps memory [3].", "Sleep helps memory [3, 4].",
    "Sleep helps memory.²",
  ]) assert.equal(X.hasCitationMark(s), true, s);
});

test("not a citation: an uncited claim still gets its card", () => {
  for (const s of [
    "Most students sleep about seven hours a night.", "According to experts, sleep helps memory.",
    "The study (which was small) found an effect.", "Sleep helps memory (see below).", "It rose sharply (by 40%) last year.",
  ]) {
    assert.equal(X.hasCitationMark(s), false, s);
    assert.equal(X.flagShown(cite, {}, "prose", s), true, s);
  }
});

test("Google's 429: 30 s, doubling, at most 5 minutes, Retry-After honoured", () => {
  assert.equal(X.exportBackoffMs(0, null), 30_000);
  assert.equal(X.exportBackoffMs(30_000, null), 60_000);
  assert.equal(X.exportBackoffMs(240_000, null), 300_000);
  assert.equal(X.exportBackoffMs(300_000, null), 300_000);
  assert.equal(X.exportBackoffMs(0, "90"), 90_000, "Google asked for longer");
  assert.equal(X.exportBackoffMs(0, "9999"), 300_000);
});

test("wired: a 429 pauses reads and says so calmly; a good read resets the pause", () => {
  assert.match(SRC, /if \(res\.status === 429\) \{\n\s+exportBackoff = exportBackoffMs\(exportBackoff, res\.headers\.get\("retry-after"\)\);\n\s+exportPausedUntil = Date\.now\(\) \+ exportBackoff;/);
  assert.match(SRC, /if \(!res\.ok\) throw new Error\(`doc export failed \(\$\{res\.status\}\)`\);\n\s+exportBackoff = 0;/);
  assert.match(SRC, /!document\.hidden && Date\.now\(\) >= exportPausedUntil && Date\.now\(\) - lastCheckEnd >= nextReadGap/);
  assert.match(SRC, /if \(err\?\.kind === "rate_limited"\) \{\n\s+statusKind = "idle";/);
});
