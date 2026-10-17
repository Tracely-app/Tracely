/* Settings → Documents and Memory, as the widget reads them (content.js
 * "Settings → the widget"; options.js writes chrome.storage "docPrefs",
 * "ignoreList" and prefs.undismissedAt, and reads each Doc's "doc.<id>").
 * Owner, 2026-10-16: "yes to all, go ahead with phase 1", on a plan that
 * listed, for Documents: every doc Tracely has checked, with its open issues
 * and when; for each, reset its saved checks, bring back dismissed notes, its
 * own style and kind of writing, or never check it; and for Memory: what is
 * kept and clearing each part, and "Never flag this again, in any doc". */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));

function between(from, to) {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a);
  assert.ok(a > 0 && b > a, `content.js: could not find ${from} .. ${to}`);
  return SRC.slice(a, b);
}

function load() {
  const log = { sets: [], storageCb: null, changed: null };
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const ctx = vm.createContext({
    log, store, localStorage, URL, Date, setTimeout: () => 0, clearTimeout() {},
    storageGet: (_d, cb) => { log.storageCb = cb; },
    storageSet: (o) => log.sets.push(plain(o)),
    storageOnChanged: (fn) => { log.changed = fn; },
    extCall: () => null,
  });
  vm.runInContext("Object.keys = ((keys) => (o) => (o === localStorage ? Object.getOwnPropertyNames(store) : keys(o)))(Object.keys);", ctx);
  const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false, refList: false, essayFeedback: false, quoteTips: true }; function hashText(s) { return String(s); }
    ${between("  const ISSUE_VERDICTS =", "  /* Card titles")}
    ${between("  /* ── Settings → the widget", '  /* ── "Explain in depth" (2.20.0)')}
    ${between("  // Bibliography block", "  function wireChrome(")}
    ({ flagShown, tipKindShown, tipKindsOn, ignoreKey, neverFlag, neverFlagged, docPref, setDocPref, citeStyleFor, kindForDoc, newMark, clearTracelyStore, notePrefs,
       prefs: () => prefs, ignore: () => [...ignoreTexts] })`, ctx);
  return { X, log, store };
}

test("each Doc's own settings: checked as they are stored, a style or kind this build doesn't know read as none", () => {
  const { X, log } = load();
  log.storageCb({ prefs: {}, docPrefs: { abc: { style: "apa", kind: "lab", never: true, resetAt: 5 }, odd: { style: "harvard", kind: "sonnet", never: "yes" } }, ignoreList: [] });
  assert.deepEqual(plain(X.docPref("abc")), { style: "apa", kind: "lab", never: true, resetAt: 5, undismissAt: 0 });
  assert.deepEqual(plain(X.docPref("odd")), { style: "", kind: "", never: false, resetAt: 0, undismissAt: 0 });
  assert.deepEqual(plain(X.docPref("missing")), { style: "", kind: "", never: false, resetAt: 0, undismissAt: 0 });
  // "Check this document" on the quiet card: written where Settings reads it, the rest kept.
  X.setDocPref("abc", { never: false });
  assert.deepEqual(log.sets.at(-1).docPrefs.abc, { style: "apa", kind: "lab", never: false, resetAt: 5 });
  assert.deepEqual(log.sets.at(-1).docPrefs.odd, { style: "harvard", kind: "sonnet", never: "yes" }, "another Doc's line untouched");
  // A change from the Settings page reaches the page that is open.
  log.changed({ docPrefs: { newValue: { abc: { never: true } } } }, "local");
  assert.equal(X.docPref("abc").never, true);
});

test("a Doc's own style and kind come first; then Settings'; then the document's own", () => {
  const { X } = load();
  const apaDoc = "Sleep falls with screen time (Hale & Guan, 2015).\nReferences\nHale, L. (2015). Screen time.";
  X.notePrefs({ citeStyle: "chicago" });
  assert.equal(X.citeStyleFor(apaDoc, "mla"), "mla");
  assert.equal(X.citeStyleFor(apaDoc, ""), "chicago");
  X.notePrefs({});
  assert.equal(X.citeStyleFor(apaDoc, ""), "apa");
  const read = { kind: "letter", shown: "letter" };
  assert.deepEqual(plain(X.kindForDoc(read, "research")), { kind: "research", shown: "research" }, "named for this Doc: read as that, sure or not");
  assert.deepEqual(plain(X.kindForDoc(read, "")), read);
  assert.deepEqual(plain(X.kindForDoc(read, "sonnet")), read);
});

test("Never flag this: that sentence, however it is typed again, in every document — and only that sentence", () => {
  const { X, log } = load();
  log.storageCb({ prefs: {}, docPrefs: {}, ignoreList: [] });
  const S = "My grandmother was born in 1890 in Lagos.";
  const f = { verdict: "questionable", confidence: "high" };
  assert.equal(X.flagShown(f, {}, "prose", S), true);
  const gen = X.tipKindsOn().never;
  X.neverFlag(`  My grandmother  was born in 1890 in Lagos  `);
  assert.deepEqual(log.sets.at(-1).ignoreList, ["My grandmother was born in 1890 in Lagos"], "kept as written, for Settings to list");
  assert.notEqual(X.tipKindsOn().never, gen, "the notes are listed again");
  for (const again of [S, "my grandmother was born in 1890 in lagos", "“My grandmother was born in 1890 in Lagos!”"]) assert.equal(X.flagShown(f, {}, "prose", again), false, again);
  assert.equal(X.flagShown({ verdict: "false", confidence: "high" }, {}, "prose", S), false, "whatever it is flagged as");
  assert.equal(X.flagShown(f, {}, "prose", "My grandmother was born in 1890 in Lagos, Nigeria, and moved to London."), true, "a longer sentence is another sentence");
  assert.equal(X.tipKindShown({ kind: "uncited", quote: S }), false, "a note on it too");
  assert.equal(X.tipKindShown({ kind: "uncited", quote: "Another sentence entirely." }), true);
  const n = log.sets.length;
  X.neverFlag(S);
  assert.equal(log.sets.length, n, "once");
  X.neverFlag("");
  assert.equal(log.sets.length, n, "nothing to add");
  // The Settings page removes one: flagged again.
  log.changed({ ignoreList: { newValue: [] } }, "local");
  assert.equal(X.flagShown(f, {}, "prose", S), true);
});

test("a mark from Settings is taken once per new time, and Clear saved checks keeps the marks", () => {
  const { X, store } = load();
  assert.equal(X.newMark("tracely.resetAt.abc", 0), false, "nothing asked");
  assert.equal(X.newMark("tracely.resetAt.abc", 100), true);
  assert.equal(X.newMark("tracely.resetAt.abc", 100), false, "the same reset is not done twice");
  assert.equal(X.newMark("tracely.resetAt.abc", 200), true);
  store["tracely.undismissAt.abc"] = "50";
  store["tracely.undismissedAt"] = "60";
  store["tracely.widget.vcache3.abc"] = "[]";
  X.notePrefs({ clearedAt: 1000 });
  assert.equal(X.clearTracelyStore(), true);
  assert.deepEqual(Object.keys(store).sort(), ["tracely.clearedAt", "tracely.resetAt.abc", "tracely.undismissAt.abc", "tracely.undismissedAt"],
    "a clear would otherwise forget a reset already done, and do it again over newer checks");
});

test("the Doc's line in the list: its title, its address, what is open — written when it changes, never on a test page or a quiet Doc", () => {
  const sets = [];
  const run = (over = {}) => vm.runInContext(`
    const harness = ${over.harness ? "{}" : "null"}, docsStorage = true, DOC_ID = "1AbCdEfGhIjKlMnOp", ACCOUNT_PREFIX = "/u/1";
    let docsOn = true, docText = "An essay.";
    const docQuiet = () => ${over.quiet ? "true" : "false"};
    const VCACHE_KEY = "v", SCACHE_KEY = "s", RCACHE_KEY = "r", FCACHE_KEY = "f", DISMISS_KEY = "d";
    const lsGet = (k) => ({ v: "12345", s: "678", d: "9" })[k] ?? null;
    const storageSet = (o) => sets.push(JSON.parse(JSON.stringify(o)));
    ${between("    let indexLine = \"\", indexAt = 0;", "    /* ── flow coaching state")}
    noteDocIndex`, vm.createContext({ sets, Date, JSON, document: { title: over.title ?? "My Essay - Google Docs" } }));
  const note = run();
  note({ wrong: 2, check: 1, cite: 0, writing: 0 });
  const line = sets.at(-1)["doc.1AbCdEfGhIjKlMnOp"];
  assert.equal(line.title, "My Essay");
  assert.equal(line.url, "https://docs.google.com/document/u/1/d/1AbCdEfGhIjKlMnOp/edit");
  assert.deepEqual(line.counts, { wrong: 2, check: 1, cite: 0 });
  assert.equal(line.bytes, 9, "what it keeps in the page, for Memory");
  assert.ok(Math.abs(line.checkedAt - Date.now()) < 5000);
  note({ wrong: 2, check: 1, cite: 0 });
  assert.equal(sets.length, 1, "nothing changed: not written again");
  note({ wrong: 1, check: 1, cite: 0 });
  assert.equal(sets.length, 2);
  run({ harness: true })({ wrong: 1 });
  run({ quiet: true })({ wrong: 1 });
  assert.equal(sets.length, 2, "a test page and a quiet Doc write nothing");
  run({ title: "Google Docs" })({});
  assert.equal(sets.at(-1)["doc.1AbCdEfGhIjKlMnOp"].title, "Google Docs");
});

test("wired: the Doc takes its marks, its style and kind, and stays quiet when never checked; cards in both modes offer Never flag this", () => {
  const docs = SRC.slice(SRC.indexOf("  function docsMode()"), SRC.indexOf("  function fieldMode()"));
  const field = SRC.slice(SRC.indexOf("  function fieldMode()"));
  assert.match(docs, /const docOff = \(\) => docPref\(DOC_ID\)\.never;\n\s+const docQuiet = \(\) => tracelyPaused\(\) \|\| docOff\(\);/);
  assert.match(docs, /if \(newMark\(`tracely\.resetAt\.\$\{DOC_ID\}`, own\.resetAt\)\) \{\n\s+cache\.clear\(\); sourcesMap\.clear\(\); review\.lastText = null; review\.findings = \[\];\n\s+for \(const k of \[VCACHE_KEY, SCACHE_KEY, RCACHE_KEY, FCACHE_KEY\]\) lsDel\(k\);/);
  assert.match(docs, /if \(\[newMark\(`tracely\.undismissAt\.\$\{DOC_ID\}`, own\.undismissAt\), newMark\("tracely\.undismissedAt", prefs\.undismissedAt\)\]\.some\(Boolean\)\) \{ dismissed\.clear\(\); lsDel\(DISMISS_KEY\); \}/, "both marks are taken, never one hiding the other");
  assert.match(field, /if \(newMark\("tracely\.undismissedAt", prefs\.undismissedAt\)\) \{ dismissed\.clear\(\); lsDel\(DISMISS_KEY\); \}/);
  assert.match(docs, /kindForDoc\(kindWithUsual\(kindWithModel\(readKind\(docText\), docText\)\), docPref\(DOC_ID\)\.kind\)/);
  assert.match(docs, /settings\.citationStyle = citeStyleFor\(docText, docPref\(DOC_ID\)\.style\);/);
  assert.match(docs, /const tally = tallyOf\([^\n]+\n\s+if \(statusKind === "idle" && !inflight\) noteDocIndex\(tally\);/);
  assert.doesNotMatch(field, /noteDocIndex\(/, "a field is not a document");
  assert.equal((SRC.match(/\$\{neverBtnHtml\("data-never", seg\.hash\)\}<button class="x" data-dismiss="\$\{seg\.hash\}"/g) || []).length, 2, "both modes' cards");
  assert.match(SRC, /\$\{t\.quote \? neverBtnHtml\("data-never-tip", t\.id\) : ""\}<button class="x" data-tip-x=/, "a note with words of its own");
  assert.equal((SRC.match(/for \(const btn of shadow\.querySelectorAll\("\[data-never\]"\)\) btn\.addEventListener\("click", \(\) => neverFlag\(segments\.find\(\(s\) => s\.hash === btn\.dataset\.never\)\?\.text\)\);\n\s+for \(const btn of shadow\.querySelectorAll\("\[data-never-tip\]"\)\) btn\.addEventListener\("click", \(\) => neverFlag\(tipById\(btn\.dataset\.neverTip\)\?\.quote\)\);/g) || []).length, 2);
  assert.match(SRC, /\.x\.never \+ \.x \{ margin-left: 0; \}/, "the eye takes the free space, Dismiss sits beside it");
});
