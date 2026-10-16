/* Tracely does not overreach. Owner, 2026-10-13: "make tracely extension and
 * app both not overpower stuff. Like for example right now it shouldnt replace
 * more than one sentence at once which it currently does. It shouldnt help with
 * general writing tips either, so please remove writing tips in general. That
 * said, from now on needs evidence should be blue instead of orange."
 *   - A fix is one sentence for one sentence (oneSentenceFix), fresh or saved.
 *   - "Let Tracely fix these" has no Accept all (ext-fix-all.test.js).
 *   - No writing tips: no essay review, no resume tips, no off-topic or
 *     leftover-correction notes. What kind of writing it is still decides what
 *     is checked.
 *   - "Needs evidence" is blue. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const FEATURES_SRC = sliceBetween(SRC, "  const FEATURES = {", "\n  };") + "\n  };";
const X = vm.runInContext(`
  const CHECK_INTERVAL_MS = 10000;
  ${FEATURES_SRC}
  function hashText(s) { return s; }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ FEATURES, usableRevision, oneSentenceFix, sentenceCount, reviewKindFor, detectGenre })`, vm.createContext({}));
const COLORS = vm.runInContext(`${sliceBetween(SRC, "  const MARK_COLORS =", "  const MARK_PENDING")} ({ MARK_COLORS, VERDICT_WASH, VERDICT_TEXT })`, vm.createContext({}));

test("a fix is one sentence: two are dropped, and an abbreviation is not a second", () => {
  const S = "The Mongols invented the American dollar.";
  assert.equal(X.usableRevision(S, "The Mongols used paper money."), "The Mongols used paper money.");
  assert.equal(X.usableRevision(S, "The Mongols used paper money. It was called chao."), "", "two sentences for one");
  assert.equal(X.usableRevision(S, "The Mongols used paper money! Later, Europe copied it."), "");
  assert.equal(X.oneSentenceFix("Dr. Smith of the U.S. Army led it in 1944."), "Dr. Smith of the U.S. Army led it in 1944.", "abbreviations are one sentence");
  assert.equal(X.oneSentenceFix("Harry S. Truman ordered it at 8:30 a.m. on the 6th."), "Harry S. Truman ordered it at 8:30 a.m. on the 6th.");
  assert.equal(X.oneSentenceFix(""), "");
  assert.equal(X.oneSentenceFix(undefined), "");
  assert.equal(X.sentenceCount("One. Two. Three."), 3);
  assert.equal(X.usableRevision("The Mongols invented the dollar.", "The Mongols did not invent the dollar."), "", "a bare negation is still no fix");
});

test("a fix saved by an earlier build is held to one sentence too, in both modes", () => {
  assert.match(SRC, /const cache = new Map\(jsonParse\(lsGet\(VCACHE_KEY\) \?\? "\[\]", \[\]\)\n\s+\/\/ A fix saved by an earlier build[^\n]*\n\s+\.map\(\(e\) => \(Array\.isArray\(e\) && e\[1\] && typeof e\[1\] === "object" && e\[1\]\.revision \? \[e\[0\], \{ \.\.\.e\[1\], revision: oneSentenceFix\(e\[1\]\.revision\) \}\] : e\)\)\);/);
  assert.match(SRC, /\.map\(\(\[h, v\]\) => \[h, v\.revision \? \{ \.\.\.v, revision: oneSentenceFix\(v\.revision\) \} : v\]\)\);/);
});

test("no writing tips: no review is asked for, no tip is shown", () => {
  assert.equal(X.FEATURES.essayFeedback, false);
  assert.equal(X.FEATURES.resumeTips, false);
  assert.equal(X.FEATURES.offTopic, false);
  for (const g of ["prose", "research", "literary", "dbq", "resume", "email", "lab"]) assert.equal(X.reviewKindFor(g), null, `${g}: no /api/review call`);
  // What is about sources and citations stays.
  assert.equal(X.FEATURES.quoteTips, true);
  assert.equal(X.FEATURES.refList, true);
  assert.equal(X.FEATURES.evidenceHints, true);
});

test("the kind of writing is still read, whatever tips are on: it decides what is checked", () => {
  // Since 2.21.57 the kind (readKind) decides the genre, and the header names what it is sure of.
  assert.equal((SRC.match(/read(?:Doc|Field)Kind\(\); \/\/ (?:always, tips or none|the site counts too \(placeKind\))/g) || []).length, 2);
  assert.equal((SRC.match(/\(\{ kind: docKind, shown: docShown \} = kindWithModel\(readKind\((?:docText|fieldText, location\.hostname \+ location\.pathname)\), (?:docText|fieldText)\)\);\n\s+docGenre = WRITING_KINDS\[docKind\]\.genre;/g) || []).length, 2);
  assert.doesNotMatch(SRC, /docGenre = FEATURES\.resumeTips \?/);
  assert.equal(X.detectGenre("Hi Ms. Carter,\n\nI was absent on Friday and wanted to ask about the essay due tomorrow. Please let me know.\n\nBest,\nMaya"), "email");
});

test("Needs evidence is blue; the launcher's count keeps the brand orange", () => {
  assert.equal(COLORS.MARK_COLORS.questionable, "#2563eb");
  assert.equal(COLORS.VERDICT_TEXT.questionable, "#1d4ed8");
  assert.equal(COLORS.VERDICT_WASH.questionable, "#e9effd");
  assert.match(SRC, /\.d-quest \{ background: \$\{MARK_COLORS\.questionable\}; \}/);
  assert.match(SRC, /border-radius: 999px; border: 2px solid #fff; background: #ff5900; color: #fff;/, "the count is no finding");
});
