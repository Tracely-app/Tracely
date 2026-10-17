/* A sentence that cites its own source is never told it needs one. Owner,
 * 2026-10-13, on the sentence below: "it flagged this for needing a
 * verifiable source which it obviously gave". A "Needs evidence" verdict on
 * it reads "Source not confirmed": check the work you cited (Find the cited
 * work), and no search for other evidence is spent on it. A writing note that
 * asks for a source on it is dropped, unless the source is impossible on its
 * face. Writing notes are blue (owner, the same day). */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const LABELS = vm.runInContext(`${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  // The mark vocabulary")}
  ({ citedClaim, verdictLabel, VERDICT_LABEL })`, vm.createContext({}));
const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return s; }
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ essayFeedbackTips, EVIDENCE_COPY })`, vm.createContext({ URL }));

const CITED = "Research conducted by Stanford University found that students using AI-powered learning platforms scored approximately 65% higher on standardized examinations than students who did not use these technologies (Johnson, 2023).";
const UNCITED = "Students using AI-powered learning platforms scored approximately 65% higher on standardized examinations.";

test("the owner's sentence: 'Source not confirmed', not 'Needs evidence'", () => {
  assert.equal(LABELS.verdictLabel("questionable", CITED), "Source not confirmed");
  assert.equal(LABELS.verdictLabel("questionable", UNCITED), "Needs evidence");
  assert.equal(LABELS.verdictLabel("questionable", "A figure [3] from a list."), "Source not confirmed", "a numbered citation is one too");
  assert.equal(LABELS.verdictLabel("false", CITED), LABELS.VERDICT_LABEL.false, "a contradicted fact is still that");
  assert.equal(LABELS.citedClaim("questionable", CITED), true);
  assert.equal(LABELS.citedClaim("questionable", undefined), false);
  assert.match(X.EVIDENCE_COPY.cited, /^You cited a source, but Tracely couldn't confirm it says this\./);
});

test("a writing note asking for a source on a sentence that cites one is dropped; the rest stay", () => {
  const text = `${CITED} ${UNCITED}`;
  const notes = [
    { quote: CITED, kind: "source", status: "unverified", action: "cite", message: "Name a verifiable source for this statistic." },
    { quote: CITED, kind: "evidence", status: "unsupported", action: "cite", message: "Support this with a verifiable source." },
    { quote: CITED, kind: "citation", status: "unverified", action: "needs_info", message: "Add Johnson (2023) to the reference list." },
    { quote: UNCITED, kind: "source", status: "unverified", action: "cite", message: "Cite a source for this." },
  ];
  const kept = Array.from(X.essayFeedbackTips(text, notes, new Set()), (t) => `${t.kind}|${t.quote === CITED ? "cited" : "uncited"}`);
  assert.deepEqual(kept, ["citation|cited", "source|uncited"]);
  const impossible = [{ quote: CITED, kind: "source", status: "confirmed", action: "delete", message: "This source is impossible." }];
  assert.equal(X.essayFeedbackTips(text, impossible, new Set()).length, 1, "a source impossible on its face still shows");
});

test("wired: both panels' titles, the Docs card's title and hint, and no evidence search", () => {
  assert.equal((SRC.match(/<span class="ctitle">\$\{esc\(verdictLabel\(f\.verdict, seg\.text\)\)\}<\/span>/g) || []).length, 2);
  assert.match(SRC, /put\(dmHead\(color, verdictLabel\(f\.verdict, seg\.text\) \?\? f\.verdict\)\);/);
  assert.match(SRC, /else if \(citedClaim\(f\.verdict, seg\.text\)\) put\(dmHint\(EVIDENCE_COPY\.cited\)\);/);
  assert.equal((SRC.match(/\|\| citedClaim\(f\.verdict, segments\.find\(\(s\) => s\.hash === f\.id\)\?\.text\) \}\);/g) || []).length, 2);
});

test("writing notes are blue: the line, the chip, the dot", () => {
  assert.match(SRC, /note_tip: "#2563eb" \};/);
  assert.match(SRC, /\.d-note \{ background: \$\{MARK_COLORS\.note_tip\}; \}/);
  assert.match(SRC, /ESSAY_NOTE_KINDS\.includes\(t\.kind\) \? "d-note"/);
});
