/* Only sources that BACK the sentence are offered (content.js
 * backingSources), and the source search is told what "supports" means
 * (factcheck.js SOURCES_SYSTEM). Owner, 2026-10-04: "Find sources" offered
 * Ord & Davies (2022) — a paper on youth work and austerity cuts — for a
 * sentence about youth leadership it never discusses. "From now on dont
 * recommend me sources that do not align." */
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
    ({ backingSources, UNBACKED_NOTE })`, vm.createContext({}));
}
const X = load();

const ORD = { title: "Young people, youth work & the 'levelling up' policy agenda", url: "https://doi.org/10.1177/02690942221098971", stance: "context" };
const BACKS = { title: "A survey of youth participation", url: "https://example.org/a", stance: "supports" };
const AGAINST = { title: "The Great Wall is not visible from orbit", url: "https://example.org/b", stance: "refutes" };
const PASTED = { title: "A page the writer pasted", url: "https://example.org/c" };

test("a source only on the topic is not offered; one that backs the sentence is", () => {
  const r = X.backingSources([ORD, BACKS], "needs_citation");
  assert.deepEqual(Array.from(r.list, (s) => s.url), [BACKS.url]);
  assert.equal(r.unbacked, 1);
});

test("a refuting source is offered only for a sentence flagged wrong (it backs the correction)", () => {
  assert.equal(X.backingSources([AGAINST], "false").list.length, 1);
  assert.equal(X.backingSources([AGAINST], "incoherent").list.length, 1);
  assert.equal(X.backingSources([AGAINST], "needs_citation").list.length, 0, "never offered to cite for the sentence it contradicts");
  assert.equal(X.backingSources([AGAINST], "accurate").list.length, 0, "an evidence suggestion only ever offers support");
});

test("a source the writer pasted is theirs, and junk input is safe", () => {
  assert.equal(X.backingSources([PASTED], "needs_citation").list.length, 1);
  assert.deepEqual(Array.from(X.backingSources(undefined, "false").list), []);
  assert.equal(X.backingSources([null, ORD], "false").unbacked, 2);
});

test("nothing backs it: the card says so honestly, not 'no sources found'", () => {
  assert.match(X.UNBACKED_NOTE(1), /found 1 source on this topic, but none says what this sentence says/);
  assert.match(X.UNBACKED_NOTE(3), /found 3 sources/);
});

test("wired: every search result and every saved list goes through it, in both modes", () => {
  assert.equal((SRC.match(/const \{ list, unbacked \} = backingSources\(data\.sources, f\?\.verdict\);\n\s+sourcesMap\.set\(hash, \{ loading: false, list, unbacked, copiedUrl: null \}\);/g) || []).length, 2);
  assert.match(SRC, /list: backingSources\(st\.list, cache\.get\(h\)\?\.verdict\)\.list/, "lists saved by an older build are filtered too");
  assert.equal((SRC.match(/\} else if \(st\?\.unbacked && !st\.list\?\.length\) \{/g) || []).length, 2, "both panels");
  assert.match(SRC, /if \(s\.unbacked\) put\(dmHead\(DM\.amber, POP_COPY\.noBacking\), dmBody\(UNBACKED_NOTE\(s\.unbacked\)\)\);/, "the Docs card");
});

test("the search is told what 'supports' means", () => {
  assert.match(FACTCHECK, /"supports" only when the result itself states the claim's point — the same subject, direction and figures; a source on the same topic that makes a different point is "context", however relevant\. When unsure, "context"\./);
  assert.match(FACTCHECK, /"snippet": one sentence \(max 30 words\) saying what the source itself states — never the claim's words unless the source uses them\./);
});
