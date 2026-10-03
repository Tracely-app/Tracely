/* When the extension sends a sentence to /api/check (content.js), and which
 * sentences it sends at all.
 *
 * A tester's friend, 2026-10-03: underlines "take like 20 seconds sometimes",
 * and "Lamine Yamal is 24 years old" is "flagged sometimes and other times it
 * won't". The first was the timer (a check started 10 s after the previous one
 * ENDED); the second was the heading rule (a six-word line with no period was
 * never sent). The constraint was the same both times: no more expensive. The
 * simulation at the bottom replays one writing session through the old timer
 * and the new one and counts what each sends. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(HERE, "..", "..", "extension", f), "utf8");

function load() {
  const src = read("content.js");
  const a = src.indexOf("  // Bibliography block");
  const b = src.indexOf("  function esc(", a);
  assert.ok(a > 0 && b > a, "content.js: the segmenter slice moved");
  const code = `
    const CHECK_INTERVAL_MS = 10000;
    function hashText(s) { const norm = s.toLowerCase().replace(/\\s+/g, " ").trim(); let h = 5381; for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0; return "s" + h.toString(36); }
    ${src.slice(a, b)}
    ({ segmentText, readyToSend, nextReadGap, holdOmitted, isHeld, READ_INTERVAL_MS, ACTIVE_WINDOW_MS, OMITTED_HOLD_MS })`;
  return vm.runInContext(code, vm.createContext({}));
}
const X = load();
const checkable = (t) => Array.from(X.segmentText(t)).filter((s) => s.checkable).map((s) => s.text);

test("a short sentence with no period is checked; a short title-cased line is still a heading", () => {
  // The friend's sentence, on a line of its own with more text after it.
  assert.deepEqual(checkable("Lamine Yamal is 24 years old\nHe plays for Barcelona."), ["Lamine Yamal is 24 years old", "He plays for Barcelona."]);
  for (const heading of ["Early Life", "The Rise of Barcelona", "INTRODUCTION TO THE WAR", "The Road from Rome", "Chapter 3 Results"]) {
    assert.deepEqual(checkable(`${heading}\nHe was born in 2007.`), ["He was born in 2007."], heading);
  }
  // Unchanged: the LAST line with no period and nothing after it is still
  // treated as mid-typing, at any length.
  assert.deepEqual(checkable("He plays for Barcelona.\nLamine Yamal is 24 years old"), ["He plays for Barcelona."]);
});

test("a finished sentence goes at first sight; a fragment only once it reads the same twice", () => {
  const [done] = X.segmentText("He was born in 2007.");
  const [frag] = X.segmentText("He was born in\nMore text.");
  assert.equal(X.readyToSend(done, new Set()), true);
  assert.equal(X.readyToSend(frag, new Set()), false, "first sighting of an unpunctuated fragment waits");
  assert.equal(X.readyToSend(frag, new Set([frag.hash])), true, "unchanged since the last read: the writer has paused on it");
});

test("reads every 3 s while the text is changing, 10 s once idle or after a failed check", () => {
  const now = 1_000_000;
  assert.equal(X.READ_INTERVAL_MS, 3000);
  assert.equal(X.nextReadGap(now, now - 1000, false), 3000);
  assert.equal(X.nextReadGap(now, now - X.ACTIVE_WINDOW_MS - 1, false), 10000, "idle: the old cadence, so an open, untouched doc is read no more than before");
  assert.equal(X.nextReadGap(now, now, true), 10000, "an outage is not retried every 3 s");
});

test("an id the server leaves out is held, not re-sent on every read", () => {
  const held = new Map();
  const sent = [{ hash: "a" }, { hash: "b" }];
  X.holdOmitted(held, sent, [{ id: "a" }], 0);
  assert.equal(X.isHeld(held, "a", 1), false);
  assert.equal(X.isHeld(held, "b", 1), true);
  assert.equal(X.isHeld(held, "b", X.OMITTED_HOLD_MS), false, "and released after the hold");
  assert.equal(held.has("b"), false);
});

/* ── simulation: the old timer against the new one ─────────────────────────
 * Sessions, second by second: an essay typed at CPS characters a second with
 * a PAUSE after each sentence, then a sentence inserted mid-document, either
 * at the end of the text or above a Works Cited list (where a half-typed
 * sentence has text after it, so the old rule sent fragments every 10 s). A
 * check takes CHECK_S seconds. Measured: requests, sentences sent (what costs
 * money), and seconds from a sentence's period to its verdict. 1.7 cps is
 * ~20 wpm, essay composing speed; 5 cps is a fast typist who never stops. */
const ESSAY = [
  "Lamine Yamal was born in 2007 in Esplugues de Llobregat.",
  "He joined La Masia at the age of seven.",
  "He made his first-team debut for Barcelona in April 2023.",
  "At Euro 2024 he became the youngest scorer in the tournament's history.",
  "Spain won that tournament by beating England in the final.",
  "Many pundits now rank him among the best wingers in Europe.",
];
const INSERT = "Lamine Yamal is 24 years old.";
const CHECK_S = 4;

function timeline(below, cps, pause) {
  const frames = []; // frames[t] = document text at second t
  let doc = "";
  const push = (text, secs) => { for (let i = 0; i < secs; i++) frames.push(text + below); };
  for (const sentence of ESSAY) {
    for (let i = cps; i < sentence.length; i += cps) push(doc + sentence.slice(0, Math.floor(i)), 1);
    doc = doc + sentence + "\n";
    push(doc, pause);
  }
  // Insert a sentence after the first paragraph, typed in place.
  const [first, ...rest] = doc.split("\n");
  const tail = "\n" + rest.join("\n");
  for (let i = cps; i < INSERT.length; i += cps) push(first + "\n" + INSERT.slice(0, Math.floor(i)) + tail, 1);
  doc = first + "\n" + INSERT + tail;
  push(doc, 60);
  return frames;
}
// A Works Cited list below the essay: the sentence being typed has text after
// it, so the segmenter calls it checkable before its period.
const WORKS_CITED = "\nWorks Cited\nBalague, Guillem. Lamine Yamal. Simon & Schuster, 2025.\n";

/* Per-call cost, cents, from eval/models/FINDINGS.md "Production-shaped cost"
 * (luna@medium, midpoints): 1 sentence 0.0535, 3 sentences 0.089 — a fixed
 * part per call and a part per sentence. */
const PER_CALL = 0.0358, PER_SENTENCE = 0.01775;
const cents = (r) => r.requests * PER_CALL + r.sent * PER_SENTENCE;

// The rule the old build used: any unpunctuated line of six words or fewer was a heading.
const oldHeading = (s) => !/[.!?]["')\]]*$/.test(s.text) && s.text.split(/\s+/).length <= 6;

function simulate(frames, scheduler) {
  const cache = new Map();
  let inflightUntil = -1, lastEnd = 0, lastChange = 0, prev = new Set(), lastText = "";
  let requests = 0, sent = 0;
  const firstDone = new Map(), verdictAt = new Map();
  let pending = null;
  for (let t = 0; t < frames.length; t++) {
    for (const s of X.segmentText(frames[t])) if (/[.!?]$/.test(s.text) && !firstDone.has(s.text)) firstDone.set(s.text, t);
    if (pending && t >= inflightUntil) {
      for (const s of pending) { cache.set(s.hash, true); if (!verdictAt.has(s.text)) verdictAt.set(s.text, t); }
      pending = null; lastEnd = t;
    }
    if (pending) continue;
    const gap = scheduler === "old" ? 10 : X.nextReadGap(t * 1000, lastChange * 1000, false) / 1000;
    if (t - lastEnd < gap) continue;
    const text = frames[t];
    if (text !== lastText) lastChange = t;
    lastText = text;
    const segs = Array.from(X.segmentText(text));
    const todo = segs.filter((s) => s.checkable && !cache.has(s.hash) && (scheduler === "old" ? !oldHeading(s) : X.readyToSend(s, prev)));
    prev = new Set(segs.map((s) => s.hash));
    if (todo.length) { requests++; sent += todo.length; pending = todo; inflightUntil = t + CHECK_S; } else lastEnd = t;
  }
  const waits = [...ESSAY, INSERT].map((s) => verdictAt.get(s) - firstDone.get(s));
  return { requests, sent, maxWait: Math.max(...waits), meanWait: waits.reduce((x, y) => x + y, 0) / waits.length };
}

/* Measured with this grid on 2026-10-03: every session's worst wait fell to
 * 6 s (from 11-17 s); 17 of 18 cost the same or less, writing above other text
 * 5-53% less (the old timer sent ~2 half-typed fragments per sentence there at
 * essay speed); the one dearer session (+11%) is a 60 wpm typist who never
 * stops, where the old timer's slowness happened to batch two sentences into
 * one request. All 18 together: -23%. Holding sentences back to batch them
 * was tried and gave the latency straight back (a 9 s cap: mean wait 12 s). */
test("simulation: underlines arrive sooner in every session, and the sessions together cost less", () => {
  let totalOld = 0, totalNew = 0;
  for (const cps of [1.7, 3, 5]) for (const pause of [3, 8, 15]) {
    for (const [where, below] of [["at the end", ""], ["above a Works Cited list", WORKS_CITED]]) {
      const name = `${cps} cps, ${pause} s pauses, ${where}`;
      const frames = timeline(below, cps, pause);
      const old = simulate(frames, "old");
      const now = simulate(frames, "new");
      totalOld += cents(old);
      totalNew += cents(now);
      assert.ok(Number.isFinite(old.maxWait) && Number.isFinite(now.maxWait), `${name}: every sentence got a verdict under both`);
      assert.ok(now.maxWait < old.maxWait && now.meanWait < old.meanWait, `${name}: waits ${now.meanWait}/${now.maxWait}s, were ${old.meanWait}/${old.maxWait}s`);
      assert.ok(now.maxWait <= 6, `${name}: worst wait ${now.maxWait}s`);
      assert.ok(now.sent <= old.sent, `${name}: sentences sent ${now.sent}, was ${old.sent}`);
      assert.ok(cents(now) <= cents(old) * 1.12, `${name}: ~${cents(now).toFixed(3)}¢, was ~${cents(old).toFixed(3)}¢`);
    }
  }
  console.log(`[timing sim] 18 sessions: old ~${totalOld.toFixed(3)}¢, new ~${totalNew.toFixed(3)}¢`);
  assert.ok(totalNew <= totalOld * 0.85, `all sessions: ~${totalNew.toFixed(3)}¢, was ~${totalOld.toFixed(3)}¢`);
});
