/**
 * Three extension fixes reported together by one tester, pinned against the
 * real content.js (no build step, no runner of its own — slices of the source
 * run in a vm context, the way extension-beta.test.js drives it):
 *
 *   - a Doc opened at /document/u/<n>/d/<id>/ must be exported through the
 *     same account slot, or the default account answers for it;
 *   - a tab whose content script was orphaned by an extension reload must say
 *     so instead of showing a stale issue count;
 *   - citations. The old formatter hard-coded "(n.d.)" and a retrieval date,
 *     and put the publisher — or a bare hostname — in the author slot, so the
 *     tester's IOM World Migration Report chapter came out as
 *     "International Organization for Migration. (n.d.). ... Retrieved <today>".
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Same lookup as models.test.js: beside this tree in the app repo, one level
// further up otherwise. Not finding it is a failure, never a skip.
const EXT = [path.join(HERE, "..", "extension"), path.join(HERE, "..", "..", "extension")]
  .find((dir) => existsSync(path.join(dir, "background.js")));
const read = (f) => {
  assert.ok(EXT, "could not locate extension/ from " + HERE);
  return readFileSync(path.join(EXT, f), "utf8");
};
const plain = (v) => JSON.parse(JSON.stringify(v)); // strip the vm realm's prototypes

function contentSlice(from, to) {
  const src = read("content.js");
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `content.js: could not find ${from} .. ${to}`);
  return src.slice(a, b);
}

/* ── the Docs export keeps the signed-in account slot ──────────────────── */

function loadExportHelpers() {
  const code = contentSlice("function docAccountPrefix(", "// Bibliography block")
    + ";({ docAccountPrefix, docExportUrl })";
  return vm.runInContext(code, vm.createContext({ URL }));
}

test("the account prefix is read off /document/u/<n>/d/ URLs", () => {
  const { docAccountPrefix } = loadExportHelpers();
  const ID = "1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo";
  assert.equal(docAccountPrefix(`https://docs.google.com/document/u/1/d/${ID}/edit`), "/u/1");
  assert.equal(docAccountPrefix(`https://docs.google.com/document/u/12/d/${ID}/edit?tab=t.0#h`), "/u/12");
  assert.equal(docAccountPrefix(`/document/u/0/d/${ID}/edit`), "/u/0");
  assert.equal(docAccountPrefix(`https://docs.google.com/document/d/${ID}/edit`), "");
  assert.equal(docAccountPrefix("/document/u/0/"), "", "the docs list page names an account but no doc");
  assert.equal(docAccountPrefix(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit`), "");
  assert.equal(docAccountPrefix(undefined, "", null), "");
  assert.equal(docAccountPrefix("http://[bad"), "", "an unparseable URL is skipped, never thrown");
});

test("the committed navigation URL wins, location.pathname is the fallback", () => {
  const { docAccountPrefix } = loadExportHelpers();
  const ID = "abc123";
  // No Navigation Timing entry: the address bar decides.
  assert.equal(docAccountPrefix(undefined, `/document/u/2/d/${ID}/edit`), "/u/2");
  // Served as /u/1/ even though the address bar no longer shows it.
  assert.equal(docAccountPrefix(`https://docs.google.com/document/u/1/d/${ID}/edit`, `/document/d/${ID}/edit`), "/u/1");
  assert.equal(docAccountPrefix(`https://docs.google.com/document/u/1/d/${ID}/edit`, `/document/u/3/d/${ID}/edit`), "/u/1");
});

test("the export URL carries the prefix, and is unchanged without one", () => {
  const { docExportUrl } = loadExportHelpers();
  assert.equal(docExportUrl("abc123", "/u/1"), "https://docs.google.com/document/u/1/d/abc123/export?format=txt");
  assert.equal(docExportUrl("abc123", ""), "https://docs.google.com/document/d/abc123/export?format=txt");
});

test("getDocText exports through the account prefix docsMode derived", () => {
  const src = read("content.js");
  assert.match(src, /const ACCOUNT_PREFIX = harness \? "" : docAccountPrefix\(\s*\(\(\) => \{ try \{ return performance\.getEntriesByType\("navigation"\)\[0\]\?\.name; \}/);
  assert.match(contentSlice("async function getDocText()", "function uncheckedSegments"), /fetch\(docExportUrl\(DOC_ID, ACCOUNT_PREFIX\)/);
  assert.ok(!/document\/d\/\$\{DOC_ID\}\/export/.test(src), "an export URL without the account prefix is still built");
});
