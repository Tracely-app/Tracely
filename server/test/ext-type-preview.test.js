/* The Type preview and Tracely's cursor (extension/content.js, the "Type
 * preview" block in Docs mode). Owner, 2026-10-08: "tracely can be a cursor
 * that moves around and can type in there … then you confirm the changes and
 * other people can only see it once you click yes". With FEATURES.typePreview
 * on, runDocEdit awaits a private preview — Tracely's cursor glides to the
 * change and clicks, the old words are struck, the new ones typed in the line
 * with the rest of the paragraph re-flowed — and sends nothing to Docs until
 * the writer accepts. "Let Tracely fix these" drives the same cursor through
 * the flags, and every edit still waits for the writer.
 *
 *   - previewDiff / previewPlan / previewLineRows: what is struck, what is
 *     typed, and the reference-list lines (pure);
 *   - previewFlow (the re-flowed paragraph), tpTimeline, walkPlan and
 *     walkSource (which flags, which button, the top BACKING source) — pure;
 *   - the gate: runDocEdit waits; Reject sends nothing and leaves no
 *     "Applying…"; Accept runs the steps as before; the switch off, or the
 *     harness without its opt-in, never shows one; undo and the in-order
 *     retry never ask again;
 *   - the preview in a small fake DOM over a simulated SVG annotation layer
 *     and a recording canvas: typing in the line (font at zoom, baseline,
 *     mask, overflow), the strike, the bubble and pinned fallbacks, the
 *     cursor, Enter / Esc / a click elsewhere, skip, reduced motion, focus,
 *     and that nothing is left behind;
 *   - the walkthrough over a stand-in card: it clicks Tracely's own buttons
 *     and never answers a preview — only the writer does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const slice = (from, to) => sliceBetween(SRC, from, to);
const plain = (v) => JSON.parse(JSON.stringify(v)); // strip the vm realm's prototypes
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const quiet = { debug() {}, log() {}, warn() {}, error() {} };
const ORIGIN = "https://docs.google.com";

// The top-level helpers the block reads: REF_HEADINGS, worksCitedBlock, backingSources,
// deleteEditFor, claimSentenceIndex, flaggedCitationOf, CITED_COPY, esc.
const HELPERS = () => `const CHECK_INTERVAL_MS = 10000; function hashText(s) { return s; }
  ${slice("  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${slice("  // Bibliography block", "  function wireChrome(")}`;
const PURE = vm.runInContext(`
  ${HELPERS()}
  ${slice("    const TP_GLIDE_MS", "    function tpNotePress(")}
  ({ previewDiff, previewPlan, previewLineRows, previewFlow, tpTimeline, walkPlan, walkSource, deleteEditFor })`, vm.createContext({}));
const diff = (a, b) => plain(PURE.previewDiff(a, b));
const rebuilt = (d) => [d.keepBefore + d.removed + d.keepAfter, d.keepBefore + d.inserted + d.keepAfter];

/* ── previewDiff: whole words, kept at each end ─────────────────────────── */

test("previewDiff: a fix strikes whole words and types whole words", () => {
  const old = "Napoleon was famously short, standing well under five feet tall.";
  const neu = "Napoleon was of average height, standing well under five feet tall.";
  const d = diff(old, neu);
  assert.deepEqual(d, { keepBefore: "Napoleon was ", removed: "famously short", inserted: "of average height", keepAfter: ", standing well under five feet tall." });
  assert.deepEqual(rebuilt(d), [old, neu]);
  // Never half a word: the whole token goes, not its tail.
  const w = diff("which is why he later invented the lightbulb.", "which is why he later invented the light bulb.");
  assert.equal(w.removed, "lightbulb");
  assert.equal(w.inserted, "light bulb");
  const n = diff("Water boils at 100 degrees.", "Water boils at 212 degrees.");
  assert.deepEqual([n.keepBefore, n.removed, n.inserted, n.keepAfter], ["Water boils at ", "100", "212", " degrees."]);
});

test("previewDiff: a citation marker is a pure insertion — nothing struck", () => {
  const old = "Napoleon was famously short.";
  const neu = "Napoleon was famously short (Lee, 2021).";
  const d = diff(old, neu);
  assert.deepEqual(d, { keepBefore: "Napoleon was famously short", removed: "", inserted: " (Lee, 2021)", keepAfter: "." });
  assert.deepEqual(rebuilt(d), [old, neu]);
});

test("previewDiff: a deletion (a replace down to the neighbour it spans) is all strike, nothing typed", () => {
  const d = diff("Off-topic line. Next sentence.", "Next sentence.");
  assert.deepEqual(d, { keepBefore: "", removed: "Off-topic line. ", inserted: "", keepAfter: "Next sentence." });
  const e = diff("Prev entry.\nDuplicate entry.", "Prev entry.");
  assert.deepEqual(e, { keepBefore: "Prev entry.", removed: "\nDuplicate entry.", inserted: "", keepAfter: "" });
  for (const [a, b] of [["Off-topic line. Next sentence.", "Next sentence."], ["Prev entry.\nDuplicate entry.", "Prev entry."]]) {
    assert.deepEqual(rebuilt(diff(a, b)), [a, b]);
  }
});

test("previewDiff: every Delete a card makes (deleteEditFor) previews as a pure strike of exactly the doomed text", () => {
  const cases = [
    ["sentence with a neighbour after it", "Trade grew under the Mongols. Pizza is delicious. Silk moved west.", "Pizza is delicious.", false, "Pizza is delicious. "],
    ["last sentence of its line", "Trade grew under the Mongols. Pizza is delicious.\n\nSilk moved west.", "Pizza is delicious.", false, " Pizza is delicious."],
    ["a line of its own", "Trade grew under the Mongols.\n\nPizza is delicious.\n\nSilk moved west.", "Pizza is delicious.", false, "\n\nPizza is delicious."],
    ["the later of two copies", "Works Cited\nLee, Jordan. A Life. Penguin, 2021.\nLee, Jordan. A Life. Penguin, 2021.\nSmith, Ann. Wars. Knopf, 2020.", "Lee, Jordan. A Life. Penguin, 2021.", true, null],
  ];
  for (const [name, body, quote, last, removed] of cases) {
    const plan = plain(PURE.deleteEditFor(body, quote, last));
    assert.ok(plan, `${name}: deleteEditFor plans it`);
    const d = diff(plan.find, plan.replacement);
    assert.equal(d.inserted, "", `${name}: nothing typed`);
    assert.equal(d.removed.trim(), quote, `${name}: exactly the doomed text struck`);
    if (removed != null) assert.equal(d.removed, removed, name);
    assert.deepEqual(rebuilt(d), [plan.find, plan.replacement], name);
  }
});

test("previewDiff: identical text changes nothing", () => {
  const s = "The human body has 206 bones.";
  assert.deepEqual(diff(s, s), { keepBefore: s, removed: "", inserted: "", keepAfter: "" });
  assert.deepEqual(diff("", ""), { keepBefore: "", removed: "", inserted: "", keepAfter: "" });
});

test("previewPlan: insertAfter is find + text; reference lines and unknown steps are kept apart", () => {
  const p = plain(PURE.previewPlan({ steps: [
    { action: "insertAfter", find: "Napoleon was short. ", text: " (Lee, 2021)", hint: { occurrences: 1 } },
    { action: "appendLine", line: "Works Cited" },
    { action: "insertLineBefore", line: "Lee, J. A Life. 2021.", before: "Smith, A. Wars. 2020." },
    { action: "somethingNew", find: "x" },
  ] }));
  assert.deepEqual(p.edits, [{ find: "Napoleon was short. ", next: "Napoleon was short. (Lee, 2021)", hint: { occurrences: 1 } }]);
  assert.deepEqual(p.lines, [{ line: "Works Cited", before: null }, { line: "Lee, J. A Life. 2021.", before: "Smith, A. Wars. 2020." }]);
  assert.equal(p.other, 1, "a step it cannot draw is still counted, never hidden");
  assert.deepEqual(plain(PURE.previewPlan(null)), { edits: [], lines: [], other: 0 });
});

test("previewLineRows: the reference-list half reads as 'Also adds to Works Cited'", () => {
  assert.deepEqual(plain(PURE.previewLineRows([{ line: "Works Cited" }, { line: "Lee, J. A Life. 2021." }], "Body.")),
    [{ label: "Also starts Works Cited with", text: "Lee, J. A Life. 2021." }]);
  assert.deepEqual(plain(PURE.previewLineRows([{ line: "Lee, J. A Life. 2021.", before: "Smith, A. Wars. 2020." }], "Body.\n\nworks cited\nSmith, A. Wars. 2020.\n")),
    [{ label: "Also adds to Works Cited", text: "Lee, J. A Life. 2021." }]);
  assert.deepEqual(plain(PURE.previewLineRows([{ line: "Lee, J. A Life. 2021." }], "Body with no list.")),
    [{ label: "Also adds at the end", text: "Lee, J. A Life. 2021." }]);
});

/* ── previewFlow: the paragraph after the change, re-flowed ─────────────── */

const W10 = (s) => s.length * 10; // every character 10px wide
const flowOf = (runs, box) => plain(PURE.previewFlow(runs, W10, box));
const BOX = { startX: 150, left: 100, right: 300, top: 50, pitch: 20 };

test("previewFlow: the first line starts at the change, later lines at the paragraph's left, wrapped at its right edge", () => {
  const lines = flowOf([{ text: "of average height", ins: true }, { text: ", standing well under five feet tall.", ins: false }], BOX);
  assert.deepEqual(lines.map((l) => [l.x, l.top, l.text]), [
    [150, 50, "of average "],          // 15 characters fit after x=150; "height," does not
    [100, 70, "height, standing "],    // a word and the comma after it wrap together
    [100, 90, "well under five feet "], // 20 characters: exactly the line
    [100, 110, "tall."],
  ]);
  // The inserted and the kept words are told apart, at their own x.
  assert.deepEqual(lines[1].spans, [{ x: 100, text: "height", ins: true }, { x: 160, text: ", standing ", ins: false }]);
  assert.equal(lines[0].end, 150 + 10 * 10, "the line's ink ends before its hanging space");
});

test("previewFlow: a space hangs at the line's end; a start past the edge wraps at once; a word wider than a line breaks by characters", () => {
  const hang = flowOf([{ text: " (Lee, 2021).", ins: true }], { ...BOX, startX: 280 });
  assert.deepEqual(hang.map((l) => [l.x, l.text]), [[280, " "], [100, "(Lee, 2021)."]]);
  const long = flowOf([{ text: "x".repeat(45), ins: true }], { ...BOX, startX: 100 });
  assert.deepEqual(long.map((l) => l.text.length), [20, 20, 5]);
  assert.deepEqual(flowOf([{ text: "", ins: true }], BOX).map((l) => [l.x, l.text]), [[150, ""]], "nothing typed yet: one empty line at the change");
});

test("previewFlow: overflow — the re-flow may need more lines than the paragraph had", () => {
  const short = flowOf([{ text: "", ins: true }, { text: " and so on.", ins: false }], BOX);
  const long = flowOf([{ text: " but in a much longer way that needs many more words", ins: true }, { text: " and so on.", ins: false }], BOX);
  assert.equal(short.length, 1);
  assert.ok(long.length >= 4, `${long.length} lines`);
  long.forEach((l, i) => assert.equal(l.top, 50 + 20 * i, "one pitch apart"));
});

test("tpTimeline: glide, click, strike while it lands, then the typing — capped at 1.2 s however long", () => {
  const t = plain(PURE.tpTimeline({ inDoc: true, glide: true, strike: true, chars: 17 }));
  assert.deepEqual(t, { glideMs: 350, clickAt: 350, clickMs: 300, strikeAt: 450, strikeMs: 200, showAt: 650, typeAt: 710, perChar: 30, readyAt: 710 + 17 * 30 });
  const long = plain(PURE.tpTimeline({ inDoc: true, glide: false, strike: false, chars: 400 }));
  assert.equal(long.readyAt - long.typeAt, 1200);
  const pinned = plain(PURE.tpTimeline({ inDoc: false, glide: true, strike: true, chars: 10 }));
  assert.deepEqual([pinned.glideMs, pinned.clickMs, pinned.showAt, pinned.typeAt], [0, 0, 0, 120], "off screen: no cursor moves");
});

/* ── walkPlan / walkSource: what the walkthrough goes to and clicks ─────── */

test("walkPlan: in reading order — Apply revision, Find a source + cite, name the source, Delete; the rest left for the writer", () => {
  const flags = [
    { key: "s3", start: 300, verdict: "false", revision: true, citedHere: false },
    { key: "s1", start: 10, verdict: "needs_citation", revision: false, citedHere: false },
    { key: "s2", start: 200, verdict: "questionable", revision: false, citedHere: false }, // nothing it can make on its own
    { key: "s4", start: 400, verdict: "needs_citation", revision: false, citedHere: true }, // its citation is the problem: the writer's call
  ];
  const notes = [
    { key: "tip:vague", start: 150, kind: "vague", deletes: false, claim: true },
    { key: "tip:dup", start: 900, kind: "refdup", deletes: true, claim: false },
    { key: "tip:excuse", start: 50, kind: "excuse", deletes: false, claim: true },
    { key: "tip:vague2", start: 60, kind: "vague", deletes: false, claim: false }, // no sentence to search for
  ];
  const plan = plain(PURE.walkPlan(flags, notes));
  assert.deepEqual(plan.items.map((i) => [i.key, i.act]), [["s1", "cite"], ["tip:vague", "name"], ["s3", "fix"], ["tip:dup", "delete"]]);
  assert.equal(plan.left, 4);
  assert.deepEqual(plain(PURE.walkPlan([], [])), { items: [], left: 0 });
});

test("walkSource: the TOP source that backs the sentence — never one that only shares its topic, never one the server could not read", () => {
  const ctx = { url: "a", stance: "context" };
  const unread = { url: "b", stance: "supports", verified: false };
  const backs = { url: "c", stance: "supports" };
  const next = { url: "d", stance: "supports" };
  assert.equal(PURE.walkSource([ctx, unread, backs, next], "needs_citation").url, "c");
  assert.equal(PURE.walkSource([ctx, { url: "e", stance: "refutes" }], "needs_citation"), null, "refuting only backs a sentence flagged wrong");
  assert.equal(PURE.walkSource([{ url: "e", stance: "refutes" }], "false").url, "e");
  assert.equal(PURE.walkSource([ctx, { url: "m" }], "needs_citation"), null, "no stance at all is not a source that says so");
  assert.equal(PURE.walkSource(null, "needs_citation"), null);
});

/* ── the gate in runDocEdit ─────────────────────────────────────────────── */

/* The editing section with its real runDocEdit, plus the block's installer
 * (`if (FEATURES.typePreview) { … }`), over a scripted hook. The preview
 * itself is a stub here — `answer(true|false)` is the writer's click. */
function loadGate({ features = { typePreview: true }, harness = null, respond = () => undefined } = {}) {
  const listeners = [];
  const sent = [];
  const win = {
    addEventListener: (t, fn) => { if (t === "message") listeners.push(fn); },
    removeEventListener: (t, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    postMessage(data) {
      const d = plain(data);
      sent.push(d);
      const r = respond(d);
      if (r === undefined) return;
      setTimeout(() => {
        for (const fn of [...listeners]) fn({ source: win, origin: ORIGIN, data: { source: "tracely-hook", type: "tracely-docs-edit-result", id: d.id, op: d.op, ...r } });
      }, 1);
    },
  };
  const ctx = vm.createContext({
    window: win, location: { origin: ORIGIN }, document: { hidden: false }, innerWidth: 1280, innerHeight: 900, console: quiet,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 40)), clearTimeout,
    navigator: { clipboard: { writeText: async () => {} } },
  });
  const code = `
    const harness = ${harness === null ? "null" : JSON.stringify(harness)};
    const FEATURES = ${JSON.stringify(features)};
    const IS_DOCS = true, DOC_ID = "doc123", CHECK_INTERVAL_MS = 10000;
    let orphaned = false, bridgeReady = false, docBusy = false;
    let inDoc = { api: true, editable: true, editor: true, ok: true };
    let lastPingAt = 0;
    const docEditState = new Map();
    let lastDocEdit = null;
    const editedHashes = new Map(), popEditSyncs = new Set();
    let docText = "", segments = [], docsBars = [];
    const cache = new Map(), sourcesMap = new Map(), citedMap = new Map();
    const settings = { citationStyle: "mla" };
    let statusKind = "idle", statusMsg = "", lastCheckEnd = 0, lastTextChangeAt = 0;
    const render = () => {}, requestDocsMarks = () => {};
    const api = async () => ({});
    const shown = [];
    let answer = null;
    function showTypePreview(key, job) { shown.push({ key, steps: job.steps.map((s) => s.action) }); return new Promise((r) => { answer = r; }); }
    function tpNotePress() {}
    ${slice("    /* ── editing the document ──", "    // (the bridge \"highlight in doc\" feature was removed")}
    ${slice("    if (FEATURES.typePreview) {", "    // ── widget UI ──")}
    ({
      runDocEdit, undoLastDocEdit, shown, answer: (v) => answer(v), installed: () => previewDocEdit !== null,
      state: () => ({ docBusy, statusMsg, edit: Object.fromEntries(docEditState), undo: Boolean(lastDocEdit) }),
    })`;
  const w = vm.runInContext(code, ctx, { filename: "content-type-preview-gate.js" });
  const ops = () => sent.filter((d) => d.type === "tracely-docs-edit").map((d) => d.op);
  return { w, sent, ops };
}
const FIX = { steps: [{ action: "replace", find: "Napoleon was famously short.", replacement: "Napoleon was of average height." }], copy: "Napoleon was of average height.", doneMsg: "fixed in doc" };
const okHook = (m) => (m.op === "replace" || m.op === "appendLine" ? { ok: true, undoToken: `u-${m.id}` } : m.op === "undo" ? { ok: true } : undefined);

test("switch on: runDocEdit waits for the preview, and Reject sends nothing to Docs", async () => {
  const g = loadGate({ respond: okHook });
  assert.equal(g.w.installed(), true);
  const run = g.w.runDocEdit("fix:a", FIX);
  await tick(20);
  assert.deepEqual(plain(g.w.shown), [{ key: "fix:a", steps: ["replace"] }]);
  assert.deepEqual(g.ops(), [], "nothing reaches the hook while the preview is up");
  assert.equal(g.w.state().docBusy, true, "the preview holds the one-edit slot");
  assert.equal(g.w.state().edit["fix:a"], undefined, "no Applying… behind the preview");
  g.w.answer(false);
  assert.equal(await run, false);
  await tick(60);
  assert.deepEqual(g.ops(), [], "Reject: no edit, no undo, nothing at all");
  assert.deepEqual(plain(g.w.state()), { docBusy: false, statusMsg: "", edit: {}, undo: false });
});

test("switch on: Accept runs the steps exactly as before", async () => {
  const g = loadGate({ respond: okHook });
  const run = g.w.runDocEdit("fix:a", FIX);
  await tick(20);
  g.w.answer(true);
  assert.equal(await run, true);
  assert.deepEqual(g.ops(), ["replace"]);
  const req = g.sent.find((d) => d.op === "replace");
  assert.equal(req.find, FIX.steps[0].find);
  assert.equal(req.replacement, FIX.steps[0].replacement);
  const s = g.w.state();
  assert.equal(s.edit["fix:a"].state, "applied");
  assert.equal(s.undo, true);
  assert.equal(s.docBusy, false);
});

test("switch off: no preview at all — the edit is sent straight away, as today", async () => {
  const g = loadGate({ features: { typePreview: false }, respond: okHook });
  assert.equal(g.w.installed(), false);
  assert.equal(await g.w.runDocEdit("fix:a", FIX), true);
  assert.deepEqual(plain(g.w.shown), []);
  assert.deepEqual(g.ops(), ["replace"]);
});

test("the harness never waits on a click unless it opts in", async () => {
  const quietHarness = loadGate({ harness: {}, respond: okHook });
  await quietHarness.w.runDocEdit("fix:a", FIX); // the harness has no editor: it fails as it always has
  assert.deepEqual(plain(quietHarness.w.shown), [], "no preview on a harness that did not ask for one");
  assert.equal(quietHarness.w.state().edit["fix:a"].state, "failed");

  const optedIn = loadGate({ harness: { typePreview: true }, respond: okHook });
  const run = optedIn.w.runDocEdit("fix:a", FIX);
  await tick(10);
  assert.equal(optedIn.w.shown.length, 1, "window.__tracelyHarness.typePreview === true shows it");
  optedIn.w.answer(false);
  assert.equal(await run, false);
});

test("undo never shows a preview, and neither does the in-order retry of an accepted citation", async () => {
  const g = loadGate({ respond: (m) => (m.op === "insertLineBefore" ? { ok: false, reason: "not-applied" } : okHook(m)) });
  const run = g.w.runDocEdit("cite:a", {
    steps: [{ action: "replace", find: "Napoleon was short.", replacement: "Napoleon was short (Lee)." }, { action: "insertLineBefore", line: "Lee, J. A Life. 2021.", before: "Smith, A. Wars. 2020." }],
    retry: [{ action: "replace", find: "Napoleon was short.", replacement: "Napoleon was short (Lee)." }, { action: "appendLine", line: "Lee, J. A Life. 2021." }],
    copy: "Lee, J. A Life. 2021.", doneMsg: "cited (Lee) in doc",
  });
  await tick(10);
  g.w.answer(true);
  assert.equal(await run, true);
  assert.deepEqual(g.ops(), ["replace", "insertLineBefore", "undo", "replace", "appendLine"], "rolled back, then appended — on the one Accept");
  assert.equal(g.w.shown.length, 1, "the retry is the same accepted edit: not asked again");
  assert.equal(await g.w.undoLastDocEdit(), true);
  assert.equal(g.w.shown.length, 1, "Undo takes an edit back without a preview");
  assert.equal(g.ops().at(-1), "undo");
});

test("the gate sits before the steps loop, and the preview is installed only by the switch", () => {
  const run = slice("    async function runDocEdit(key, job) {", "    async function undoLastDocEdit() {");
  const gate = run.indexOf("if (previewDocEdit && !job.previewed) {");
  assert.ok(gate > 0 && gate < run.indexOf("setEditState(key, { state: \"applying\" });"), "asked before Applying…");
  assert.ok(gate < run.indexOf("for (const step of job.steps)"), "asked before any step is sent");
  assert.match(run, /return runDocEdit\(key, \{ \.\.\.job, steps: job\.retry, retry: null, previewed: true \}\);/);
  const undo = slice("    async function undoLastDocEdit() {", "    // A repeated sentence from the panel");
  assert.ok(!/previewDocEdit|showTypePreview/.test(undo), "undo never previews");
  assert.match(SRC, /\n {4}typePreview: true, {4}\/\/ Docs: every in-doc edit is typed as a private preview first/, "FEATURES carries the switch");
});

test("svgRangeRects groups the visible lines exactly as svgLocate does", () => {
  const locate = slice("    function svgLocate(issues) {", "    function svgRangeRects(");
  const range = slice("    function svgRangeRects(", "    /* Bars are carried by the COMPOSITOR");
  for (const line of ["if (r.width === 0) continue;", "const key = Math.round(r.top / 4) * 4;", "font: node.getAttribute(\"data-font-css\") || \"\""]) {
    assert.ok(locate.includes(line) && range.includes(line), `both group runs the same way: ${line}`);
  }
});

test("the walkthrough never answers a preview, and clicks only Tracely's own card buttons", () => {
  const walk = slice("    /* ── \"Let Tracely fix these\"", "    if (FEATURES.typePreview) {");
  for (const banned of ["data-tracely-type-accept", "data-tracely-type-reject", "finish(", "tpOpen.finish", "resolve(true"]) {
    assert.ok(!walk.includes(banned), `the walkthrough touches ${banned}`);
  }
  const clicks = [...walk.matchAll(/(\w+)\.click\(\)/g)].map((m) => m[1]);
  assert.deepEqual(clicks, ["btn"], "one .click(), in walkPress");
  assert.match(walk, /const btn = popCard \? \[\.\.\.popCard\.querySelectorAll\("button"\)\]/, "a button of the open Tracely card, nothing else");
  // The switch off: no walkthrough on offer, and the hover is untouched.
  assert.match(SRC, /const walkOffered = \(\) => Boolean\(FEATURES\.typePreview && previewDocEdit && canEditDoc\(\)/);
  assert.match(SRC, /function hoverHit\(\) \{\n\s+hoverRafBusy = false;\n\s+if \(tcWalk\) return;/);
});

/* ── the preview itself, in a fake DOM ──────────────────────────────────── */

class FakeEl {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.attrs = new Map();
    this.children = [];
    this.parentNode = null;
    this.own = "";
    this.listeners = {};
    this.id = "";
    this.rect = null;
  }
  get isConnected() { for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument.documentElement) return true; return false; }
  appendChild(c) { c.remove(); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  insertBefore(c, ref) { c.remove(); c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  remove() { const p = this.parentNode; if (!p) return; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  get firstChild() { return this.children[0] ?? null; }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this.own = String(v); }
  get textContent() { return this.own + this.children.map((c) => c.textContent).join(""); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  hasAttribute(k) { return this.attrs.has(k); }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  removeEventListener(t, fn) { const l = this.listeners[t] ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  click() { if (!this.disabled) for (const fn of [...(this.listeners.click ?? [])]) fn({ type: "click", target: this }); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  getBoundingClientRect() { const r = this.rect ?? { left: 0, top: 0, width: 0, height: 0 }; return { ...r, right: r.left + r.width, bottom: r.top + r.height }; }
  get offsetWidth() { return 260; }
  get offsetHeight() { return 120; }
  closest() { return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.tagName === sel.toUpperCase()) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  // A canvas: its 2d context records what is drawn; a character is half the font's px size wide.
  getContext() { return (this.ctx2d ??= recordingContext(this.drawn = [])); }
}
function recordingContext(log) {
  return {
    font: "16px Georgia", fillStyle: "#000", textBaseline: "alphabetic",
    measureText(s) {
      const size = parseFloat(String(this.font).match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "16");
      return { width: s.length * size * 0.5, fontBoundingBoxAscent: size * 0.8, fontBoundingBoxDescent: size * 0.2 };
    },
    setTransform() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    clearRect() { log.length = 0; },
    fillRect(x, y, w, h) { log.push({ op: "rect", fill: this.fillStyle, x, y, w, h }); },
    fillText(text, x, y) { log.push({ op: "text", fill: this.fillStyle, font: this.font, text, x, y }); },
  };
}
const CHAR_W = 8; // "16px Georgia": 8px a character at 100% zoom

/* The whole block, over the helpers it really uses (geometry, barTextRect,
 * the popover's element recipes, the reference-list reader) and stand-ins for
 * what the walkthrough reads (flags, bars, the card). `lines`: the simulated
 * annotation layer, one rect per visual line. Timers and frames run only on
 * pump(ms), which advances the clock and runs whatever is due. */
function loadPreview({ reduced = true, lines = [], harness = null, docText = "", zoom = 1, features = { typePreview: true }, env = {} } = {}) {
  let clock = 1000;
  const queue = new Map();
  let seq = 0;
  const doc = {
    activeElement: null, hidden: false,
    createElement: (t) => new FakeEl(doc, t),
    createElementNS: (ns, t) => new FakeEl(doc, t),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes("rect[aria-label]") ? svg.filter((n) => n.isConnected) : []),
    addEventListener() {}, removeEventListener() {},
  };
  doc.documentElement = new FakeEl(doc, "html");
  doc.body = doc.documentElement.appendChild(new FakeEl(doc, "body"));
  doc.activeElement = doc.body;
  const svg = [];
  const addLine = (text, left, top, font = "16px Georgia") => {
    const n = doc.body.appendChild(new FakeEl(doc, "rect"));
    n.setAttribute("aria-label", text);
    n.setAttribute("data-font-css", font);
    n.rect = { left, top, width: text.length * CHAR_W * zoom, height: 18 * zoom };
    svg.push(n);
    return n;
  };
  for (const l of lines) addLine(l.text, l.left ?? 100, l.top);
  const winListeners = [];
  const win = {
    addEventListener: (type, fn) => winListeners.push({ type, fn }),
    removeEventListener: (type, fn) => { const i = winListeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) winListeners.splice(i, 1); },
  };
  const fire = (type, init = {}) => {
    const ev = { type, stopped: false, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...init };
    for (const l of winListeners.filter((x) => x.type === type)) { l.fn(ev); if (ev.stopped) break; }
    return ev;
  };
  const ctx = vm.createContext({
    window: win, document: doc, location: { pathname: "/document/d/abc/edit" }, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    performance: { now: () => clock }, console: quiet, env,
    requestAnimationFrame: (fn) => { queue.set(++seq, { fn, due: 0 }); return seq; }, cancelAnimationFrame: (id) => { queue.delete(id); },
    setTimeout: (fn, ms = 0) => { queue.set(++seq, { fn, due: clock + ms }); return seq; }, clearTimeout: (id) => { queue.delete(id); },
    matchMedia: () => ({ matches: reduced }),
  });
  const code = `
    const harness = ${harness === null ? "null" : JSON.stringify(harness)};
    const FEATURES = ${JSON.stringify(features)};
    const APP = { font: "Test Sans" };
    let orphaned = false, popEl = null, previewDocEdit = null;
    let docText = ${JSON.stringify(docText)};
    const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
    // What the walkthrough reads, stood in for (env, from the test).
    let docBusy = false, popCard = null, popHash = null, popPinned = false, docsBars = [], segments = [];
    const docEditState = new Map(), sourcesMap = new Map(), cache = new Map(), popSteps = new Map(), tipMarkById = new Map();
    const stepOf = (h) => popSteps.get(h) ?? { step: "problem", selected: null };
    const setStep = (h, p) => { popSteps.set(h, { ...stepOf(h), ...p }); env.paint?.(h); };
    const canEditDoc = () => Boolean(env.canEdit);
    const currentIssues = () => env.issues?.() ?? [];
    const canDeleteTip = () => false, anyTipById = () => null, tipById = () => null, deleteLabel = () => "Delete this";
    let renders = 0;
    const render = () => { renders++; };
    function showDocsPopover(hash) { popHash = hash; popEl = popCard = env.card(hash); document.documentElement.appendChild(popEl); }
    function hideDocsPopover() { if (popEl) popEl.remove(); popEl = popCard = popHash = null; popPinned = false; }
    async function fakeRunDocEdit(key, job) { // runDocEdit's gate, as far as the walkthrough can see it
      if (docBusy) return false;
      docBusy = true;
      const ok = await previewDocEdit(key, job);
      if (ok) docEditState.set(key, { state: "applied" });
      docBusy = false;
      return ok;
    }
    ${HELPERS()}
    ${slice("    const nrm = (s) =>", "    /* Bars are carried by the COMPOSITOR")}
    ${slice("    function barTextRect(b) {", "    // A sentence we just rewrote")}
    ${slice("    const DM = { // index.css .docmark-*", "    /* A hint-styled control")}
    ${slice("    const TP_GLIDE_MS", "    // ── widget UI ──")}
    ({
      showTypePreview, previewDocEdit: (k, j) => previewDocEdit(k, j),
      setPop: (p) => { popEl = p; }, setOrphaned: (v) => { orphaned = v; },
      press: (r) => { tpPress = { rect: r, box: r, at: Date.now() }; },
      walk: () => tracelyWalk(), walkEnd: () => walkEnd(), strip: () => walkStripHtml(), offered: () => walkOffered(),
      walking: () => Boolean(tcWalk), walkDone: () => tcWalkDone, run: (k, j) => fakeRunDocEdit(k, j),
      setBars: (b) => { docsBars = b; }, sources: sourcesMap, edits: docEditState, steps: popSteps, busy: () => docBusy,
      setCard: (c) => { popEl = popCard = c; },
      POP_COPY,
    })`;
  const w = vm.runInContext(code, ctx, { filename: "content-type-preview.js" });
  // Advance the clock; run the frames, and every timer now due (those can schedule more).
  const pump = (ms = 16) => {
    clock += ms;
    for (let round = 0; round < 20; round++) {
      const due = [...queue.entries()].filter(([, q]) => q.due <= clock);
      if (!due.length) break;
      for (const [id, q] of due) {
        if (!queue.has(id)) continue; // cancelled by the one that ran first
        queue.delete(id);
        q.fn();
      }
      if (due.every(([, q]) => q.due === 0)) break; // frames run once a pump
    }
  };
  // Pump and let the walkthrough's awaits run between pumps.
  const settle = async (n = 1, ms = 16) => { for (let i = 0; i < n; i++) { pump(ms); await new Promise((r) => setImmediate(r)); } };
  const all = function* (n) { for (const c of n.children) { yield c; yield* all(c); } };
  const find = (pred) => { for (const n of all(doc.documentElement)) if (pred(n)) return n; return null; };
  const findAll = (pred) => [...all(doc.documentElement)].filter(pred);
  const layer = () => find((n) => n.hasAttribute("data-tracely-type-preview"));
  const bubble = () => find((n) => n.getAttribute("role") === "dialog");
  const byAttr = (a) => find((n) => n.hasAttribute(a));
  const px = (v) => Math.round(parseFloat(v) * 1000) / 1000; // fractions of a run: float noise only
  const outside = doc.body.appendChild(new FakeEl(doc, "div"));
  const clickOutside = () => fire("pointerdown", { target: outside, composedPath: () => [outside, doc.body, doc.documentElement] });
  const pressBubble = () => { const b = bubble(); return fire("pointerdown", { target: b.children[0], composedPath: () => [b.children[0], b, layer(), doc.documentElement] }); };
  const drawn = () => byAttr("data-tracely-type-flow")?.drawn ?? [];
  return { w, doc, svg, addLine, fire, pump, settle, find, findAll, layer, bubble, byAttr, px, outside, clickOutside, pressBubble, winListeners, drawn };
}

const SENTENCE = "Napoleon was famously short, standing well under five feet tall.";
const FIXED = "Napoleon was of average height, standing well under five feet tall.";
const TWO_LINES = [
  { text: "Napoleon was famously short, standing well", top: 100 },
  { text: "under five feet tall. The human body has 206 bones.", top: 130 },
];
const fixJob = (extra = {}) => ({ steps: [{ action: "replace", find: SENTENCE, replacement: FIXED, hint: { occurrence: 0, occurrences: 1 } }], ...extra });
const cursorOf = (t) => t.byAttr("data-tracely-cursor");
const at = (el) => el.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/).slice(1).map((v) => Math.round(Number(v) * 100) / 100);

test("bubble mode (the paragraph is not in the last read): struck over the exact run, the cursor parks by the change, the bubble under the line", async () => {
  const t = loadPreview({ lines: TWO_LINES });
  const p = t.w.showTypePreview("fix:a", fixJob());
  assert.equal(t.layer().getAttribute("data-tracely-type-mode"), "bubble");
  const strike = t.byAttr("data-tracely-type-strike");
  // "Napoleon was " is 13 characters: "famously short" starts at x = 100 + 13·8 and is 14 characters wide.
  assert.deepEqual([t.px(strike.style.left), t.px(strike.style.top), t.px(strike.style.width), t.px(strike.style.height)], [100 + 13 * CHAR_W, 100, 14 * CHAR_W, 18]);
  assert.equal(strike.children[0].style.transform, "scaleX(1)", "reduced motion: the strike is already drawn");
  const caret = t.byAttr("data-tracely-type-caret");
  assert.equal(caret.style.transform, `translate(${100 + 13 * CHAR_W}px, 100px)`);
  assert.equal(caret.style.display, "block");
  assert.equal(caret.style.background, "#1c1c1c", "ink: colour only ever means a finding");
  const cur = cursorOf(t);
  assert.ok(cur, "Tracely's cursor is on the page");
  assert.equal(cur.textContent, "Tracely", "its name pill");
  assert.deepEqual(at(cur), [100 + 13 * CHAR_W - 2, 100 + 18 + 3], "parked just below the caret");
  const b = t.bubble();
  assert.equal(t.px(b.style.top), 118 + 10, "directly below the struck line");
  assert.equal(t.px(b.style.left), 100 + 13 * CHAR_W - 14, "at the caret's x");
  assert.equal(t.byAttr("data-tracely-type-typed").textContent, "of average height", "the bubble types the new words");
  t.fire("keydown", { key: "Escape" });
  assert.equal(await p, false);
  assert.equal(cursorOf(t), null, "the cursor goes with a single edit's preview");
});

/* A paragraph mid-document, in the last read and on screen whole: typed in the line. */
const PARA = "The human body has 206 bones. Napoleon was famously short, standing well under five feet tall. Pizza is delicious and everyone agrees on that point here.";
const PARA_LINES = [
  { text: "The human body has 206 bones. Napoleon was", top: 100 },
  { text: "famously short, standing well under five", top: 130 },
  { text: "feet tall. Pizza is delicious and everyone", top: 160 },
  { text: "agrees on that point here.", top: 190 },
  { text: "Next paragraph.", top: 230 },
];
const PARA_DOC = `Title\n${PARA}\nNext paragraph.\n`;

test("inline: the new words are typed IN the line, in the document's font, and the rest of the paragraph re-flows after them", async () => {
  const t = loadPreview({ lines: PARA_LINES, docText: PARA_DOC });
  const p = t.w.showTypePreview("fix:a", fixJob());
  assert.equal(t.layer().getAttribute("data-tracely-type-mode"), "inline");
  const d = t.drawn();
  const texts = d.filter((x) => x.op === "text");
  // The strike ends after "short" (x = 100 + 14·8 = 212); a small gap (0.6 of a space), then the new words.
  const startX = 212 + 0.6 * CHAR_W;
  assert.deepEqual(texts[0], { op: "text", fill: "#1c1c1c", font: "16.000px Georgia", text: "of average height", x: startX, y: 130 + 13.8 },
    "same font and size as the run; baseline = (box − (ascent + descent)) / 2 + ascent");
  assert.deepEqual(texts.map((x) => [x.text, Math.round(x.x * 10) / 10, x.y - 13.8]), [
    ["of average height", 216.8, 130], [", standing ", 352.8, 130],
    ["well under five feet tall. Pizza is ", 100, 160],
    ["delicious and everyone agrees on that ", 100, 190],
    ["point here.", 100, 220], // one line more than the paragraph had: over what is below, on white
  ]);
  assert.equal(texts[1].fill, "#000", "the kept words in the page's ink");
  // Page white over every original run after the change — and a band under the overflow line.
  const white = d.filter((x) => x.op === "rect" && x.fill === "#fff");
  for (const top of [130, 160, 190]) assert.ok(white.some((r) => r.y <= top && r.y + r.h >= top + 18), `masked at ${top}`);
  assert.ok(white.some((r) => r.y <= 208 && r.y + r.h >= 238 && r.x <= 100), "the overflow line's own white band");
  assert.ok(d.some((x) => x.op === "rect" && x.fill === "rgba(28,28,28,0.07)" && x.x === startX), "the inserted words carry the ink wash, never a hue");
  // The text caret at the end of what was typed; the cursor parked beside where it began.
  assert.deepEqual(at(t.byAttr("data-tracely-type-caret")), [startX + 17 * CHAR_W, 130]);
  assert.deepEqual(at(cursorOf(t)), [210, 130 + 18 + 3]);
  // The compact bar under the paragraph's (re-flowed) last line, at its left.
  const bar = t.bubble();
  assert.deepEqual([t.px(bar.style.left), t.px(bar.style.top)], [100, 220 + 18 + 8]);
  assert.match(bar.textContent, /Only you can see this until you accept/);
  assert.equal(t.doc.activeElement, t.byAttr("data-tracely-type-accept"));
  t.fire("keydown", { key: "Enter" });
  assert.equal(await p, true);
  assert.equal(t.layer(), null);
});

test("inline: at another zoom the font is scaled by the run's drawn width over its measured width", async () => {
  const t = loadPreview({ lines: PARA_LINES.map((l) => ({ ...l, top: l.top * 1.25 })), docText: PARA_DOC, zoom: 1.25 });
  const p = t.w.showTypePreview("fix:a", fixJob());
  const first = t.drawn().find((x) => x.op === "text");
  assert.equal(first.font, "20.000px Georgia", "16px drawn 25% wider is 20px");
  assert.equal(Math.round(first.x * 10) / 10, 100 + 14 * 10 + 0.6 * 10, "after the strike, in the zoomed run's own units");
  assert.equal(first.y, 130 * 1.25 + ((22.5 - 20) / 2 + 16), "baseline from the zoomed box");
  t.fire("keydown", { key: "Escape" });
  await p;
});

test("inline with motion: the original line stays until the click lands, then letters appear one by one, re-flowing as they come", async () => {
  const t = loadPreview({ reduced: false, lines: PARA_LINES, docText: PARA_DOC });
  t.w.press({ left: 600, top: 400, width: 100, height: 30 });
  const p = t.w.showTypePreview("fix:a", fixJob());
  // t = 0: the cursor at the pressed button's centre.
  assert.deepEqual(at(cursorOf(t)), [650, 415]);
  t.pump(350); // arrived: at the change, mid-line, pressing
  assert.deepEqual(at(cursorOf(t)), [100, 130 + 18 * 0.55]);
  assert.equal(t.drawn().filter((x) => x.op === "text").length, 0, "nothing drawn over the page before the click lands");
  t.pump(100); // mid-click: the arrow pressed in, the ring spreading
  assert.match(cursorOf(t).children[1].style.transform, /scale\(0\.9/);
  assert.notEqual(cursorOf(t).children[0].style.opacity, "0");
  t.pump(200); // 650: the click has landed
  t.pump(90);  // 740: typing began at 710, 30 ms a letter
  assert.equal(t.drawn().find((x) => x.op === "text").text, "o");
  assert.equal(t.byAttr("data-tracely-type-accept").parentNode.style.display, "none", "no Accept before it has been seen whole");
  t.pressBubble(); // a click on the bar skips to the end
  assert.equal(t.drawn().find((x) => x.op === "text").text, "of average height");
  t.fire("keydown", { key: "Escape" });
  assert.equal(await p, false);
});

test("the line is drawn only where it can be drawn faithfully: long, table-like and right-to-left paragraphs fall back", async () => {
  const long = Array.from({ length: 16 }, (_, i) => `Line ${String(i).padStart(2, "0")} of a long paragraph that wraps.`);
  long[3] = SENTENCE;
  const t1 = loadPreview({ lines: long.map((text, i) => ({ text, top: 100 + 30 * i })), docText: long.join(" ") });
  const p1 = t1.w.showTypePreview("fix:a", fixJob());
  assert.equal(t1.layer().getAttribute("data-tracely-type-mode"), "bubble", "over 15 lines: the bubble under the line");
  t1.fire("keydown", { key: "Escape" }); await p1;
  // Two runs on one line, far apart: a table row.
  const t2 = loadPreview({ lines: [{ text: SENTENCE, top: 100 }, { text: "Cell two.", left: 1000, top: 100 }], docText: `${SENTENCE} Cell two.` });
  const p2 = t2.w.showTypePreview("fix:a", fixJob());
  assert.equal(t2.layer().getAttribute("data-tracely-type-mode"), "bubble", "a table: the bubble");
  t2.fire("keydown", { key: "Escape" }); await p2;
  const rtl = "הוא היה נמוך מאוד.";
  const t3 = loadPreview({ lines: [{ text: rtl, top: 100 }], docText: rtl });
  const p3 = t3.w.showTypePreview("fix:a", { steps: [{ action: "replace", find: rtl, replacement: "הוא היה גבוה." }] });
  assert.equal(t3.layer().getAttribute("data-tracely-type-mode"), "pinned", "right-to-left: nothing drawn over the line");
  assert.equal(cursorOf(t3), null);
  t3.fire("keydown", { key: "Escape" }); await p3;
});

test("Accept is focused when it appears; Enter accepts, and everything is removed", async () => {
  const t = loadPreview({ lines: TWO_LINES });
  const before = t.doc.body.appendChild(new FakeEl(t.doc, "button"));
  before.focus();
  const p = t.w.showTypePreview("fix:a", fixJob());
  const b = t.bubble();
  assert.equal(b.getAttribute("role"), "dialog");
  assert.match(b.getAttribute("aria-label"), /private preview, not in the document yet/);
  const desc = t.find((n) => n.id === b.getAttribute("aria-describedby"));
  assert.equal(desc.textContent, "Replaces “famously short” with “of average height”.");
  const accept = t.byAttr("data-tracely-type-accept");
  assert.equal(t.doc.activeElement, accept);
  const ev = t.fire("keydown", { key: "Enter" });
  assert.equal(ev.prevented && ev.stopped, true, "Docs never sees the Enter");
  assert.equal(await p, true);
  assert.equal(t.layer(), null, "nothing left behind");
  assert.equal(cursorOf(t), null);
  assert.equal(t.doc.activeElement, before, "focus goes back where it was");
  assert.deepEqual(t.winListeners.map((l) => l.fn.name), ["tpNotePress", "tpNotePress"], "no listener of the preview outlives it");
});

test("Esc, a click anywhere else, Reject, and leaving the page all reject", async () => {
  const cases = [
    (t) => t.fire("keydown", { key: "Escape" }),
    (t) => t.clickOutside(),
    (t) => t.byAttr("data-tracely-type-reject").click(),
    (t) => { t.byAttr("data-tracely-type-reject").focus(); t.fire("keydown", { key: "Enter" }); },
    (t) => t.fire("pagehide"),
    (t) => { t.w.setOrphaned(true); t.pump(); },
  ];
  for (const [i, act] of cases.entries()) {
    const t = loadPreview({ lines: PARA_LINES, docText: PARA_DOC });
    const p = t.w.showTypePreview("fix:a", fixJob());
    act(t);
    assert.equal(await p, false, `case ${i}`);
    assert.equal(t.layer(), null, `case ${i}: removed`);
  }
  // Clicking the bar itself, or Accept, is not a "no".
  const t = loadPreview({ lines: PARA_LINES, docText: PARA_DOC });
  const p = t.w.showTypePreview("fix:a", fixJob());
  t.pressBubble();
  assert.ok(t.layer(), "a click on the bar keeps it");
  t.byAttr("data-tracely-type-accept").click();
  assert.equal(await p, true);
});

test("typing is capped: a long insertion types faster, never longer than ~1.2 s", () => {
  const long = `Napoleon was ${"x".repeat(200)}, standing well under five feet tall.`;
  const t = loadPreview({ reduced: false, lines: TWO_LINES });
  // No press and no underline rect: no glide. The click (300 ms), 60 ms, then 200 characters at 6 ms.
  t.w.showTypePreview("fix:a", { steps: [{ action: "replace", find: SENTENCE, replacement: long }] });
  t.pump(300 + 60 + 1200 - 1);
  assert.equal(t.byAttr("data-tracely-type-accept").parentNode.style.display, "none");
  assert.equal(t.byAttr("data-tracely-type-typed").textContent.length, 199);
  t.pump(2);
  assert.equal(t.byAttr("data-tracely-type-accept").parentNode.style.display, "flex");
  assert.equal(t.byAttr("data-tracely-type-typed").textContent, "x".repeat(200));
});

test("a deletion: struck, nothing typed, the cursor stays beside the strike; a reference line reads 'Also adds to …' and marks where it goes", async () => {
  const t = loadPreview({
    lines: [{ text: "Off-topic line. Next sentence here.", top: 100 }, { text: "Works Cited", top: 300 }, { text: "Smith, A. Wars. 2020.", top: 330 }],
    docText: "Off-topic line. Next sentence here.\nWorks Cited\nSmith, A. Wars. 2020.\n",
  });
  const p = t.w.showTypePreview("x", { steps: [
    { action: "replace", find: "Off-topic line. Next sentence here.", replacement: "Next sentence here." },
    { action: "insertLineBefore", line: "Lee, J. A Life. 2021.", before: "Smith, A. Wars. 2020." },
  ] });
  assert.equal(t.layer().getAttribute("data-tracely-type-mode"), "strike");
  const b = t.bubble();
  assert.match(b.textContent, /Deletes the struck-out words\./);
  assert.match(b.textContent, /Also adds to Works Cited/);
  assert.match(b.textContent, /Lee, J\. A Life\. 2021\./);
  const strike = t.byAttr("data-tracely-type-strike");
  assert.deepEqual([t.px(strike.style.left), t.px(strike.style.width)], [100, 16 * CHAR_W], "\"Off-topic line. \" struck, up to where \"Next\" starts");
  assert.equal(t.byAttr("data-tracely-type-typed"), null, "nothing typed");
  assert.deepEqual(at(cursorOf(t)), [100 + 16 * CHAR_W + 6, 100 + 18 * 0.35], "the cursor stays, beside the strike's end");
  const mark = t.byAttr("data-tracely-type-mark");
  assert.deepEqual([mark.style.display, t.px(mark.style.top), t.px(mark.style.left)], ["block", 330 - 4, 100], "a thin line above the entry it goes before");
  assert.deepEqual([t.px(b.style.left), t.px(b.style.top)], [100, 118 + 8], "the bar under the struck line");
  t.fire("keydown", { key: "Escape" });
  assert.equal(await p, false);
});

test("a Delete across a paragraph break strikes only the doomed paragraph, on its own line", async () => {
  const body = "Trade grew under the Mongols.\n\nPizza is delicious.\n\nSilk moved west.";
  const plan = plain(PURE.deleteEditFor(body, "Pizza is delicious."));
  const t = loadPreview({ lines: [{ text: "Trade grew under the Mongols.", top: 100 }, { text: "Pizza is delicious.", top: 150 }, { text: "Silk moved west.", top: 200 }], docText: body });
  const p = t.w.showTypePreview("del:x", { steps: [{ action: "replace", find: plan.find, replacement: plan.replacement, hint: { occurrence: plan.occurrence, occurrences: plan.occurrences } }] });
  const strike = t.byAttr("data-tracely-type-strike");
  assert.deepEqual([t.px(strike.style.left), t.px(strike.style.top), t.px(strike.style.width)], [100, 150, 19 * CHAR_W]);
  assert.deepEqual(at(cursorOf(t)), [100 + 19 * CHAR_W + 6, 150 + 18 * 0.35], "beside the strike");
  assert.equal(t.find((n) => n.id === t.bubble().getAttribute("aria-describedby")).textContent, "Deletes “Pizza is delicious.”.");
  t.fire("keydown", { key: "Escape" });
  assert.equal(await p, false);
});

test("off screen (no annotation layer): never scrolls — the bubble pinned beside the card, the change written inline, no cursor", async () => {
  const t = loadPreview({ lines: [] });
  t.w.press({ left: 900, top: 500, width: 300, height: 200 });
  const p = t.w.showTypePreview("fix:a", fixJob());
  assert.equal(t.layer().getAttribute("data-tracely-type-mode"), "pinned");
  const b = t.bubble();
  assert.equal(t.px(b.style.left), 900 - 12 - 260, "left of the card (no room on its right)");
  assert.equal(t.px(b.style.top), 500);
  assert.match(b.textContent, /Not on screen, so it's shown here/);
  const struck = t.find((n) => n.style.textDecoration === "line-through");
  assert.equal(struck.textContent, "famously short");
  assert.match(b.textContent, /Napoleon was famously shortof average height, standing well under/);
  assert.equal(cursorOf(t), null, "no cursor over a document it is not drawn on");
  assert.equal(t.doc.activeElement, t.byAttr("data-tracely-type-accept"));
  t.fire("keydown", { key: "Enter" });
  assert.equal(await p, true);
});

test("a repeated sentence with nothing saying which copy is never guessed at: pinned instead", async () => {
  const t = loadPreview({ lines: [{ text: "The sky is green.", top: 100 }, { text: "The sky is green.", top: 200 }] });
  const job = { steps: [{ action: "replace", find: "The sky is green.", replacement: "The sky is blue.", hint: { occurrences: 2 } }] };
  const p = t.w.showTypePreview("fix:a", job);
  assert.match(t.bubble().textContent, /Not on screen/);
  t.fire("keydown", { key: "Escape" });
  await p;
  const t2 = loadPreview({ lines: [{ text: "The sky is green.", top: 100 }, { text: "The sky is green.", top: 200 }] });
  const p2 = t2.w.showTypePreview("fix:a", { steps: [{ ...job.steps[0], hint: { occurrences: 2, rects: [{ left: 110, top: 200, width: 100, height: 18 }] } }] });
  assert.equal(t2.px(t2.byAttr("data-tracely-type-strike").style.top), 200, "with the underline's rect, drawn on that copy");
  t2.fire("keydown", { key: "Escape" });
  await p2;
});

test("it follows the text as Docs scrolls, and finds it again when Docs recycles the tile", async () => {
  const t = loadPreview({ lines: PARA_LINES, docText: PARA_DOC });
  const p = t.w.showTypePreview("fix:a", fixJob());
  for (const n of t.svg) n.rect = { ...n.rect, top: n.rect.top - 40 };
  t.pump();
  const strike = () => t.byAttr("data-tracely-type-strike");
  assert.equal(t.px(strike().style.top), 90);
  assert.equal(t.drawn().find((x) => x.op === "text").y, 90 + 13.8, "the typed line follows");
  // Docs drops the tile's rects and paints new ones further down.
  for (const n of t.svg.splice(0)) n.remove();
  PARA_LINES.forEach((l) => t.addLine(l.text, 100, l.top + 300));
  t.pump(300);
  assert.equal(t.px(strike().style.top), 430);
  assert.equal(t.drawn().find((x) => x.op === "text").y, 430 + 13.8);
  t.fire("keydown", { key: "Escape" });
  assert.equal(await p, false);
});

test("the popover steps aside while the change is drawn in the document, and comes back after", async () => {
  const t = loadPreview({ lines: TWO_LINES });
  const pop = t.doc.body.appendChild(new FakeEl(t.doc, "div"));
  pop.style.visibility = "visible";
  t.w.setPop(pop);
  const p = t.w.showTypePreview("fix:a", fixJob());
  assert.equal(pop.style.visibility, "hidden");
  t.fire("keydown", { key: "Escape" });
  await p;
  assert.equal(pop.style.visibility, "visible");
});

test("one preview at a time: a second one closes the first as rejected", async () => {
  const t = loadPreview({ lines: TWO_LINES });
  const first = t.w.showTypePreview("fix:a", fixJob());
  const second = t.w.showTypePreview("fix:b", fixJob());
  assert.equal(await first, false);
  assert.equal(t.doc.documentElement.children.filter((n) => n.hasAttribute("data-tracely-type-preview")).length, 1);
  t.fire("keydown", { key: "Escape" });
  assert.equal(await second, false);
});

test("the harness's gate: no opt-in, no preview; opted in, the preview", async () => {
  const off = loadPreview({ harness: {}, lines: TWO_LINES });
  assert.equal(await off.w.previewDocEdit("fix:a", fixJob()), true, "goes straight on, as before");
  assert.equal(off.layer(), null);
  const on = loadPreview({ harness: { typePreview: true }, lines: TWO_LINES });
  const p = on.w.previewDocEdit("fix:a", fixJob());
  assert.ok(on.layer());
  on.fire("keydown", { key: "Escape" });
  assert.equal(await p, false);
});

/* ── the walkthrough, over a stand-in card ──────────────────────────────── */

/* A flagged sentence (s1, a fix) and a missing citation (s2), each with an
 * underline. The card is a stand-in with the real buttons' labels; its
 * buttons do what the real ones do: Suggest fix → the fix card; Apply
 * revision and Cite in doc → an edit through previewDocEdit. */
function walkSetup({ sources = null } = {}) {
  const log = [];
  let t = null;
  const env = {
    canEdit: true,
    issues: () => [
      { seg: { hash: "s1", start: 0, text: SENTENCE }, f: { verdict: "false", revision: FIXED } },
      { seg: { hash: "s2", start: 400, text: "The human body has 206 bones." }, f: { verdict: "needs_citation" } },
    ],
    card(hash) {
      const card = new FakeEl(t.doc, "div");
      card.rect = { left: 300, top: 300, width: 320, height: 200 };
      const button = (label, onClick, i = 0) => {
        const b = card.appendChild(new FakeEl(t.doc, "button"));
        b.textContent = label;
        b.rect = { left: 320 + i * 120, top: 440, width: 110, height: 34 };
        b.addEventListener("click", () => { log.push(`${hash}:${label}`); onClick(); });
      };
      const P = t.w.POP_COPY;
      const paint = () => {
        card.textContent = "";
        const st = t.w.steps.get(hash) ?? { step: "problem" };
        if (hash === "s1") {
          if (st.step === "fix") button(P.apply, () => { t.w.run("fix:s1", fixJob()); });
          else button(P.suggestFix, () => { t.w.steps.set("s1", { step: "fix" }); paint(); });
        } else if (st.step === "sources") {
          const s = t.w.sources.get("s2");
          if (s && !s.loading) button(P.insert, () => { log.push(`cite:${st.selected ?? s.list[0]?.url}`); t.w.run(`cite:s2:${st.selected ?? s.list[0]?.url}`, { steps: [{ action: "replace", find: "The human body has 206 bones.", replacement: "The human body has 206 bones (Lee, 2021)." }] }); });
        } else {
          button(P.findSource, () => {
            t.w.sources.set("s2", { loading: true });
            t.w.steps.set("s2", { step: "sources", selected: null });
            setTimeout(() => { t.w.sources.set("s2", { loading: false, list: sources ?? [] }); paint(); }, 0);
            paint();
          });
        }
      };
      env.paint = () => paint();
      paint();
      return card;
    },
  };
  t = loadPreview({ lines: [...TWO_LINES, { text: "The human body has 206 bones.", top: 400 }], env });
  t.w.setBars([
    { hash: "s1", size: 18, el: Object.assign(t.doc.body.appendChild(new FakeEl(t.doc, "div")), { rect: { left: 100, top: 118, width: 336, height: 3 } }) },
    { hash: "s2", size: 18, el: Object.assign(t.doc.body.appendChild(new FakeEl(t.doc, "div")), { rect: { left: 100, top: 418, width: 232, height: 3 } }) },
  ]);
  return { t, log };
}
const until = async (t, cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await t.settle(1, 50); return cond(); };

test("walkthrough: it opens each card, clicks Tracely's own buttons, and waits — only the writer accepts", async () => {
  const { t, log } = walkSetup({ sources: [{ url: "ctx", stance: "context" }, { url: "lee", stance: "supports" }] });
  assert.equal(t.w.offered(), true);
  assert.match(t.w.strip(), /Tracely can make 2 of these fixes.*data-walk-go="1">Let Tracely fix these</);
  t.w.walk();
  assert.ok(await until(t, () => Boolean(t.layer())), "the first fix reaches its preview");
  assert.deepEqual(log, ["s1:Suggest fix", "s1:Apply revision"], "the card's own buttons, in the writer's order");
  assert.ok(cursorOf(t), "the cursor drives");
  assert.match(t.w.strip(), /Tracely is on 1 of 2.*data-walk-stop/);
  // However long it waits, the walkthrough never answers the preview.
  await t.settle(80, 100);
  assert.ok(t.layer(), "still waiting for the writer");
  assert.equal(t.w.edits.size, 0, "nothing applied");
  t.fire("keydown", { key: "Enter" }); // the writer accepts
  assert.ok(await until(t, () => log.some((l) => l.startsWith("cite:"))), "on to the citation");
  assert.deepEqual(log.slice(2), ["s2:Find a source", "s2:Cite in doc", "cite:lee"], "the top BACKING source, not the first one listed");
  assert.ok(await until(t, () => Boolean(t.layer())));
  t.fire("keydown", { key: "Escape" }); // the writer rejects this one — Esc inside a preview is its Reject, not Stop
  assert.ok(await until(t, () => !t.w.walking()));
  assert.equal(t.w.walkDone(), "Done: 1 applied, 1 rejected.");
  assert.deepEqual([...t.w.edits.keys()], ["fix:s1"]);
  assert.equal(cursorOf(t), null, "the cursor leaves when it is done");
});

test("walkthrough: no source backs the sentence → skipped with a note, never cited; Esc outside a preview stops it", async () => {
  const { t, log } = walkSetup({ sources: [{ url: "ctx", stance: "context" }] });
  t.w.walk();
  assert.ok(await until(t, () => Boolean(t.layer())));
  t.fire("keydown", { key: "Enter" });
  assert.ok(await until(t, () => !t.w.walking()));
  assert.ok(!log.some((l) => l.startsWith("cite:")), "nothing cited");
  assert.equal(t.w.walkDone(), "Done: 1 applied, 0 rejected, 1 skipped (no source backs it).");

  const s = walkSetup();
  s.t.w.walk();
  await s.t.settle(3, 20);
  s.t.fire("keydown", { key: "Escape" }); // no preview open: Esc stops the walkthrough
  assert.ok(await until(s.t, () => !s.t.w.walking()));
  assert.match(s.t.w.walkDone(), /^Stopped/);
  assert.equal(s.t.w.edits.size, 0);
});

test("walkthrough: not offered with the switch off, without an editable Doc, or with nothing it can do", () => {
  const off = loadPreview({ features: { typePreview: false }, env: { canEdit: true, issues: () => [{ seg: { hash: "s1", start: 0, text: SENTENCE }, f: { verdict: "false", revision: FIXED } }] } });
  assert.equal(off.w.offered(), false);
  assert.equal(off.w.strip(), "");
  const ro = loadPreview({ env: { canEdit: false, issues: () => [{ seg: { hash: "s1", start: 0, text: SENTENCE }, f: { verdict: "false", revision: FIXED } }] } });
  assert.equal(ro.w.offered(), false);
  const none = loadPreview({ env: { canEdit: true, issues: () => [{ seg: { hash: "s1", start: 0, text: SENTENCE }, f: { verdict: "questionable" } }] } });
  assert.equal(none.w.offered(), false);
});
