/* "Needs evidence": a questionable sentence is searched before the writer is
 * asked to look. Owner, 2026-10-13: "instead of having it say six to double
 * check, please search for it first and say like look for evidence to back
 * it up". Up to three of a check's new flags, one at a time, never the
 * writer's last two searches of the day (content.js EVIDENCE_FIRST). Every
 * other flag's automatic search stays behind the opt-in Auto-src switch. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return s; }
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ EVIDENCE_FIRST, EVIDENCE_COPY, autoSearchPicks, unbackedNote, UNBACKED_NOTE, TALLY })`, vm.createContext({ URL }));
const USAGE = vm.runInContext(`${sliceBetween(SRC, "  let searchUsage = ", "\n\n  /* A widget's settings")}
  ({ noteSearchUsage, searchesLeft, bump: () => { autoSinceUsage++; } })`, vm.createContext({}));

const f = (id, verdict) => ({ id, verdict });
const ids = (list) => Array.from(list, (x) => x.id);

test("a check's 'Needs evidence' flags are searched by themselves, three at most, in order", () => {
  const six = ["a", "b", "c", "d", "e", "g"].map((id) => f(id, "questionable"));
  assert.deepEqual(ids(X.autoSearchPicks(six)), ["a", "b", "c"]);
  assert.deepEqual(ids(X.autoSearchPicks([f("x", "accurate"), f("y", "questionable")])), ["y"]);
  assert.deepEqual(ids(X.autoSearchPicks(undefined)), []);
});

test("every other flag only with Auto-src on, as before", () => {
  const mixed = [f("w", "false"), f("c", "needs_citation"), f("q", "questionable"), f("i", "incoherent")];
  assert.deepEqual(ids(X.autoSearchPicks(mixed)), ["q"], "off: the questionable one only");
  assert.deepEqual(ids(X.autoSearchPicks(mixed, { optIn: ["false", "questionable", "needs_citation"] })), ["w", "c", "q"]);
});

test("already searched, dismissed, not shown or gone: skipped, and the next one takes its place", () => {
  const four = ["a", "b", "c", "d"].map((id) => f(id, "questionable"));
  assert.deepEqual(ids(X.autoSearchPicks(four, { skip: (x) => x.id === "b" })), ["a", "c", "d"]);
});

test("never the writer's last two searches of the day", () => {
  const six = ["a", "b", "c", "d", "e", "g"].map((id) => f(id, "questionable"));
  assert.equal(X.autoSearchPicks(six, { left: 5 }).length, 3, "free, none used: 3, leaving 2");
  assert.equal(X.autoSearchPicks(six, { left: 4 }).length, 2);
  assert.equal(X.autoSearchPicks(six, { left: 3 }).length, 1);
  assert.equal(X.autoSearchPicks(six, { left: 2 }).length, 0);
  assert.equal(X.autoSearchPicks(six, { left: 0 }).length, 0);
  assert.equal(X.autoSearchPicks(six, { left: Infinity }).length, 3, "unmetered: the per-check cap only");
  assert.deepEqual({ ...X.EVIDENCE_FIRST, verdicts: [...X.EVIDENCE_FIRST.verdicts] }, { verdicts: ["questionable"], perCheck: 3, keep: 2 });
});

test("searches left: the server's limits less its usage, less the automatic ones since that answer", () => {
  assert.equal(USAGE.searchesLeft(), Infinity, "nothing heard yet");
  USAGE.noteSearchUsage({ limits: { sources: { day: 5, month: 40 } }, usage: { sources: { today: 1, month: 39 } } });
  assert.equal(USAGE.searchesLeft(), 1, "the month's last one");
  USAGE.noteSearchUsage({ limits: { sources: { day: 5, month: 40 } }, usage: { sources: { today: 1, month: 10 } } });
  assert.equal(USAGE.searchesLeft(), 4);
  USAGE.bump();
  assert.equal(USAGE.searchesLeft(), 3, "an automatic search started since");
  USAGE.noteSearchUsage({ limits: { sources: { day: 5, month: 40 } }, usage: { sources: { today: 1, month: 10 } } });
  assert.equal(USAGE.searchesLeft(), 3, "the same cached answer again does not forget it");
  USAGE.noteSearchUsage({ limits: { sources: { day: 5, month: 40 } }, usage: { sources: { today: 2, month: 11 } } });
  assert.equal(USAGE.searchesLeft(), 3, "a new answer counts it itself");
  USAGE.noteSearchUsage({ limits: null, usage: null });
  assert.equal(USAGE.searchesLeft(), Infinity, "a server that meters nothing");
  USAGE.noteSearchUsage({ limits: { sources: { day: 5, month: 40 } } });
  assert.equal(USAGE.searchesLeft(), 5, "no usage reported: none used");
});

test("the words: 'N need evidence', and what to do when nothing backs it", () => {
  const chip = Array.from(X.TALLY).find(([k]) => k === "check")[2];
  assert.equal(chip(1), "1 needs evidence");
  assert.equal(chip(6), "6 need evidence");
  assert.match(SRC, /questionable: "Needs evidence"/);
  assert.doesNotMatch(SRC, /to double-check/);
  assert.equal(X.EVIDENCE_COPY.none({ unbacked: 2 }), "Tracely found 2 sources on this topic, but none backs this sentence. Look for evidence to back it up, or narrow the claim.");
  assert.equal(X.EVIDENCE_COPY.none({ unread: [{}] }), "Tracely found 1 source but couldn't open it to check. Look for evidence to back it up, or narrow the claim.");
  assert.equal(X.EVIDENCE_COPY.none({ list: [] }), "Tracely couldn't find a source that backs this. Look for evidence to back it up, or narrow the claim.");
  assert.equal(X.EVIDENCE_COPY.found(1), "Tracely found 1 source that backs this.");
  assert.equal(X.EVIDENCE_COPY.found(3), "Tracely found 3 sources that back this.");
  assert.equal(X.unbackedNote({ unbacked: 2 }, "questionable"), X.EVIDENCE_COPY.none({ unbacked: 2 }));
  assert.equal(X.unbackedNote({ unbacked: 2 }, "needs_citation"), X.UNBACKED_NOTE(2), "every other flag keeps its words");
});

test("wired in both modes: the picker, the allowance, a quiet failure", () => {
  assert.equal((SRC.match(/const picks = autoSearchPicks\(findings, \{ optIn, left: searchesLeft\(\), skip: \(f\) => sourcesMap\.has\(f\.id\) \|\| !shown\.has\(f\.id\) \}\);/g) || []).length, 2);
  assert.equal((SRC.match(/const optIn = FEATURES\.autoSources && settings\.autoSources === true \? AUTO_SOURCE_VERDICTS : \[\];/g) || []).length, 2, "the rest stay opt-in");
  assert.equal((SRC.match(/const shown = new Set\(currentIssues\(\)\.map\(\(\{ seg \}\) => seg\.hash\)\);/g) || []).length, 2, "only flags the writer can see");
  assert.equal((SRC.match(/autoSinceUsage\+\+;/g) || []).length, 2);
  assert.equal((SRC.match(/if \(!sourcesMap\.has\(f\.id\)\) break; \/\/ failed/g) || []).length, 2, "a failed search stops the rest");
  assert.match(SRC, /if \(!batch && !auto\) statusMsg = err\?\.message \?\? "source search failed";/, "Docs: nobody asked, so no error line");
  assert.match(SRC, /if \(!auto\) statusMsg = err\?\.message \?\? "source search failed";/, "field");
  assert.match(SRC, /if \(!r\?\.ok\) return;\n\s+noteSearchUsage\(r\);/, "every entitlement answer, before the no-change return");
  assert.equal((SRC.match(/\$\{esc\(unbackedNote\(st, cache\.get\(seg\.hash\)\?\.verdict\)\)\}/g) || []).length, 2, "both panels");
  assert.equal((SRC.match(/\} else if \(st && !st\.list\?\.length && isEvidenceFirst\(cache\.get\(seg\.hash\)\?\.verdict\)\) \{/g) || []).length, 2, "a search that found nothing at all says so too");
});

test("the Docs card: what the search found, the way to it, and never a second search", () => {
  const card = sliceBetween(SRC, "      // \"Needs evidence\": what Tracely's own search", "      const dis = dmBtn(POP_COPY.dismiss, false);");
  assert.match(card, /ev\.loading \? EVIDENCE_COPY\.looking : evFound \? EVIDENCE_COPY\.found\(evFound\) : ev\.partial \? TRIM_COPY\.head : EVIDENCE_COPY\.none\(ev\)/);
  assert.match(card, /if \(ev\) \{ setStep\(hash, \{ step: "sources", searched: true \}\); return; \}/);
  assert.match(card, /if \(!hasRevision && !citedHere && !ev\) action\.addEventListener\("pointerdown"/);
  assert.match(SRC, /if \(hasRevision && evOpen\) \{\n\s+const see = dmBtn\(EVIDENCE_COPY\.see\(evFound \|\| 1\), false, \{ wide: true \}\);/);
  assert.match(SRC, /if \(isEvidenceFirst\(f\?\.verdict\)\) put\(dmHead\(DM\.amber, POP_COPY\.noBacking\), dmBody\(EVIDENCE_COPY\.none\(s\)\)\);\n\s+else if \(s\.unbacked\)/, "the sources step");
});
