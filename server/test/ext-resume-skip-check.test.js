/* On a resume the review stands in for the fact check (content.js
 * reviewCoversCheck). Cost idea 5, owner 2026-10-04. On a resume the check's
 * only visible output is "false" (flagShown hides needs_citation and
 * questionable there), and /api/review now looks for that too — a school or
 * company named wrongly. Whenever the review cannot serve, the check runs as
 * before. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const FACTCHECK = readFileSync(path.join(HERE, "..", "lib", "factcheck.js"), "utf8");

function load() {
  const a = SRC.indexOf("  // Bibliography block");
  const b = SRC.indexOf("  function esc(", a);
  assert.ok(a > 0 && b > a, "content.js: the slice moved");
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return s; }
    ${SRC.slice(a, b)}
    ({ reviewCoversCheck })`, vm.createContext({}));
}
const { reviewCoversCheck } = load();
const R = (o) => ({ unavailable: false, serving: null, ...o });

test("a resume skips the check while the review serves it, and only then", () => {
  assert.equal(reviewCoversCheck("resume", R({ serving: null })), true, "first review not tried yet: the check waits seconds for it");
  assert.equal(reviewCoversCheck("resume", R({ serving: true })), true, "the review answered for a resume");
  assert.equal(reviewCoversCheck("resume", R({ serving: false })), false, "the last review failed: the check covers it");
  assert.equal(reviewCoversCheck("resume", R({ unavailable: true, serving: false })), false, "a server without /api/review (404): checked as before");
  for (const g of ["prose", "research", "literary", "letter"]) {
    assert.equal(reviewCoversCheck(g, R({ serving: true })), false, `${g} is always checked`);
  }
});

test("wired into both modes: no sentence is sent, and the review's answer decides", () => {
  assert.equal((SRC.match(/function uncheckedSegments\(\) \{\n\s+if \(FEATURES\.writingOnly && docGenre === "homework"\) return \[\];[^\n]*\n\s+if \(FEATURES\.resumeTips && reviewCoversCheck\(docGenre, review\)\) return \[\];/g) || []).length, 2);
  assert.equal((SRC.match(/review\.serving = data\?\.genre === "resume";/g) || []).length, 2, "the model saying it is not a resume sends it back to the check");
  assert.equal((SRC.match(/\} catch \(err\) \{\n\s+review\.serving = false;/g) || []).length, 2, "any failure, 404 included, falls back to the check");
  assert.equal((SRC.match(/unavailable: false, serving: null, kind: null \};/g) || []).length, 2);
});

test("the review looks for the one thing the check found on a resume: a public name stated wrongly", () => {
  assert.match(FACTCHECK, /a school, university, company or place named wrongly \(one that does not exist under that name, like "University of California, Boston"\)/);
  assert.match(FACTCHECK, /Do not fact-check the author: what they say they did, won or plan is theirs to state\. Only a public name stated wrongly \(above\) is yours to correct\./);
});
