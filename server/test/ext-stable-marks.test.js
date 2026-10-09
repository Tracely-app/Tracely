/* Underlines hold while the text holds (extension 2.21.32). Owner,
 * 2026-10-08: "I can use tracely at night have it underline things and wake
 * up and different things are underlined … I want it to be consistently
 * underlining the same thing yet maintaining efficiency and accuracy".
 *
 * The fact verdicts were already kept per sentence with the doc and never
 * asked again while a sentence stands. The review's notes (the orange dashed
 * underlines) lived only in the page: a reload — a tab Chrome put to sleep,
 * Docs reconnecting, an update — paid for a new review of the same text and
 * got different notes. Pinned here: the review is kept with the doc and the
 * same text reads it back without a call; after an edit, notes on paragraphs
 * the edit never touched stay; what an edit can settle is the new review's. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));

const SHARED = `const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false, essayFeedback: true, resumeTips: true };
  function hashText(s) { return "h" + s.length + s.slice(0, 24); }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}`;
const DOCS = SRC.slice(SRC.indexOf("function docsMode()"), SRC.indexOf("function fieldMode()"));
const FIELD = SRC.slice(SRC.indexOf("function fieldMode()"));
// Docs mode's own review state, restore, keep and requestReview, as written.
const DOCS_REVIEW = DOCS.slice(DOCS.indexOf("    const review = { lastText: null"), DOCS.indexOf("    let panelWasOpen"));

/* One page load of a Doc: the page's storage (shared across loads), the
 * server (counting calls), and Docs mode's review code. */
const clock = { t: 1_000_000 };
function pageLoad(storage, server) {
  const ctx = vm.createContext({ storage, server, clock, console });
  return vm.runInContext(`Date.now = () => clock.t;
    ${SHARED}
    const RCACHE_KEY = "tracely.widget.rcache2.doc1";
    const lsGet = (k) => storage.has(k) ? storage.get(k) : null;
    const lsSet = (k, v) => { storage.set(k, v); return true; };
    const CHECK_MODEL = "m";
    let docGenre = "prose", lastTextChangeAt = 0;
    const render = () => {};
    const api = async (p, body) => { server.calls.push(body.text); return { findings: server.answer(body.text) }; };
    ${DOCS_REVIEW}
    ({ review, requestReview, shown: (text) => essayFeedbackTips(text, review.findings, new Set()).map((t) => t.kind + ": " + t.quote) })`, ctx);
}

const P1 = "The Mongols spread ideas across Eurasia because merchants travelled safely.";
const P2 = "Marco Polo described paper money in Mongol China.";
const P3 = "Trade grew because roads were protected by the empire.";
const ESSAY = [P1, P2, P3].join("\n\n");

test("overnight: a reload reads back the same notes and pays for nothing", async () => {
  const storage = new Map();
  let run = 0;
  const server = { calls: [], answer: () => (++run === 1
    ? [{ kind: "evidence", quote: P1, message: "Which merchants? Name a source." }, { kind: "analysis", quote: P2, message: "Say why paper money matters here." }]
    : [{ kind: "thesis", quote: "", message: "A different model run says something else." }]) };

  const evening = pageLoad(storage, server);
  await evening.requestReview(ESSAY);
  assert.equal(server.calls.length, 1);
  const before = Array.from(evening.shown(ESSAY));
  assert.deepEqual(before, [`evidence: ${P1}`, `analysis: ${P2}`]);

  // The tab is reloaded overnight; nothing in the document changed.
  clock.t += 8 * 3600_000;
  const morning = pageLoad(storage, server);
  assert.deepEqual(Array.from(morning.shown(ESSAY)), before, "the same notes, on the same sentences, before any call");
  await morning.requestReview(ESSAY);
  assert.equal(server.calls.length, 1, "the same text is never reviewed again: no flip, and no cost");
  assert.deepEqual(Array.from(morning.shown(ESSAY)), before);
});

test("after an edit, notes on paragraphs the edit never touched stay; the changed paragraph gets the new word", async () => {
  const storage = new Map();
  const answers = [
    [{ kind: "evidence", quote: P1, message: "Which merchants?" }, { kind: "analysis", quote: P2, message: "Why does paper money matter?" }, { kind: "relevance", quote: P3, message: "How does this support the thesis?" }],
    // The second run, after P2 was rewritten: the model happens not to repeat P1's note.
    [{ kind: "evidence", quote: "Marco Polo described paper money in Mongol China, which made long trade possible.", message: "Cite Polo." }],
  ];
  const server = { calls: [], answer: () => answers.shift() };
  const page = pageLoad(storage, server);
  await page.requestReview(ESSAY);
  clock.t += 200_000; // past REVIEW_REPEAT_MS
  const edited = ESSAY.replace(P2, "Marco Polo described paper money in Mongol China, which made long trade possible.");
  await page.requestReview(edited);
  assert.equal(server.calls.length, 2, "a rewritten line is worth a review (reviewWorthwhile)");
  assert.deepEqual(Array.from(page.shown(edited)), [
    "evidence: Marco Polo described paper money in Mongol China, which made long trade possible.",
    `evidence: ${P1}`,
  ], "P1 untouched keeps its note; P2's old note went with its old words; relevance is the new review's to say");
});

const X = vm.runInContext(`${SHARED}
  ({ carryReviewNotes, reviewSnapshot, restoreReview, reviewWorthwhile, REVIEW_KEEP_CHARS })`, vm.createContext({}));
const fresh = () => ({ lastText: null, findings: [], at: 0, okAt: 0, inflight: false, unavailable: false, serving: null, kind: null, seen: new Map() });

test("carryReviewNotes: only one-sentence notes, only on untouched paragraphs, never two on one sentence", () => {
  const prev = [
    { kind: "evidence", quote: P1, message: "a" },
    { kind: "thesis", quote: "", message: "whole essay" },
    { kind: "contradiction", quote: P3, message: "c" },
    { kind: "analysis", quote: P3, message: "d" },
  ];
  const next = [{ kind: "reasoning", quote: P3, message: "new" }];
  assert.deepEqual(plain(X.carryReviewNotes(prev, ESSAY, next, ESSAY)).map((f) => `${f.kind}:${f.message}`),
    ["reasoning:new", "evidence:a"], "the new review's note on P3 wins; a whole-essay or a contradiction note is the new review's to say");
  const touched = ESSAY.replace(P1, `${P1} Ibn Battuta wrote about it.`);
  assert.deepEqual(plain(X.carryReviewNotes(prev, ESSAY, [], touched)).map((f) => f.kind), ["analysis"], "P1's paragraph changed: its note is not carried");
  assert.deepEqual(plain(X.carryReviewNotes(prev, ESSAY, [], ESSAY.replace(P1, "")).map((f) => f.kind)), ["analysis"], "a deleted sentence takes its note with it");
  const many = Array.from({ length: 14 }, (_, i) => ({ kind: "evidence", quote: `Sentence number ${i} stands alone here.`, message: "m" }));
  const text = many.map((f) => f.quote).join("\n");
  assert.equal(X.carryReviewNotes(many, text, [], text).length, 10, "a panel's worth");
  assert.equal(X.carryReviewNotes([], text, many, text).length, 14, "the new review's own notes are never cut");
});

test("the snapshot: round trip, malformed storage ignored, a very long document not kept", () => {
  const r = fresh();
  Object.assign(r, { kind: "essay", lastText: ESSAY, findings: [{ kind: "evidence", quote: P1, message: "m" }], okAt: 123, serving: false });
  r.seen.set("tip:1", { id: "tip:1", kind: "evidence" });
  const back = fresh();
  assert.equal(X.restoreReview(back, JSON.stringify(X.reviewSnapshot(r))), true);
  assert.deepEqual(plain({ ...back, seen: [...back.seen] }), plain({ ...r, at: 123, seen: [...r.seen] }));
  assert.equal(X.reviewWorthwhile(back.lastText, ESSAY), false, "so the gate holds the same text");
  for (const bad of [null, "", "{", "[]", '{"v":2,"kind":"essay","lastText":"x","findings":[]}', '{"v":1,"kind":"essay","lastText":5,"findings":[]}']) {
    const f = fresh();
    assert.equal(X.restoreReview(f, bad), false, String(bad));
    assert.equal(f.lastText, null);
  }
  assert.equal(X.reviewSnapshot({ ...r, lastText: "x".repeat(X.REVIEW_KEEP_CHARS + 1) }), null);
  assert.equal(X.reviewSnapshot(fresh()), null, "nothing reviewed, nothing kept");
});

test("wired: Docs keeps the review per doc and cleans it up with the doc's other caches; fields keep nothing", () => {
  assert.match(DOCS, /const RCACHE_KEY = `tracely\.widget\.rcache\$\{CACHE_GEN\}\.\$\{DOC_ID\}`;/);
  assert.match(DOCS, /restoreReview\(review, lsGet\(RCACHE_KEY\)\);/);
  assert.match(DOCS, /lsDel\(`tracely\.widget\.rcache\$\{CACHE_GEN\}\.\$\{old\}`\);/, "evicted with a doc that falls off the 20-doc registry");
  assert.match(DOCS, /\(vcache\\d\*\|scache\|rcache\\d\*\)/, "and freed under quota pressure, like the other docs' caches");
  assert.match(SRC, /const VERDICT_CACHE = \/\^tracely\\\.widget\\\.\(\?:vcache\|fcache\|rcache\)\(\\d\*\)\\\.\//, "and retired with a cache generation");
  assert.match(FIELD, /const persistReview = \(\) => \{\};/);
  assert.equal((SRC.match(/review\.findings = review\.lastText == null \? found : carryReviewNotes\(review\.findings, review\.lastText, found, text\);/g) || []).length, 2, "both panels carry");
  assert.equal((SRC.match(/\n        persistReview\(\);\n/g) || []).length, 2);
});
