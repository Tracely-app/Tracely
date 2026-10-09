/* The Type preview (extension/content.js, the "Type preview" block in Docs
 * mode). Owner, 2026-10-08: "tracely can be a cursor that moves around and
 * can type in there … then you confirm the changes and other people can only
 * see it once you click yes". With FEATURES.typePreview on, runDocEdit awaits
 * a private preview — a caret flagged "Tracely" glides to the change, strikes
 * the old words, types the new ones into a bubble — and sends nothing to Docs
 * until Accept.
 *
 *   - previewDiff / previewPlan / previewLineRows: what is struck, what is
 *     typed, and the reference-list lines (pure);
 *   - the gate: runDocEdit waits; Reject sends nothing and leaves no
 *     "Applying…"; Accept runs the steps as before; the switch off, or the
 *     harness without its opt-in, never shows one; undo and the in-order
 *     retry never ask again;
 *   - the preview itself, in a small fake DOM over a simulated SVG annotation
 *     layer: where the strike, the caret and the bubble go, Enter / Esc / a
 *     click elsewhere, skip, reduced motion, the off-screen bubble, focus,
 *     and that nothing is left behind.
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

const REF_SLICE = () => slice("  const REF_HEADINGS =", "  // ── citation formatting ──");
const PURE = vm.runInContext(`
  ${REF_SLICE()}
  ${slice("    const TP_TOKEN =", "    function tpNotePress(")}
  ({ previewDiff, previewPlan, previewLineRows })`, vm.createContext({}));
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
  // How deletions arrive: find = the doomed sentence + a neighbour,
  // replacement = the neighbour alone.
  const d = diff("Off-topic line. Next sentence.", "Next sentence.");
  assert.deepEqual(d, { keepBefore: "", removed: "Off-topic line. ", inserted: "", keepAfter: "Next sentence." });
  // Across a paragraph break (a duplicate reference entry).
  const e = diff("Prev entry.\nDuplicate entry.", "Prev entry.");
  assert.deepEqual(e, { keepBefore: "Prev entry.", removed: "\nDuplicate entry.", inserted: "", keepAfter: "" });
  for (const [a, b] of [["Off-topic line. Next sentence.", "Next sentence."], ["Prev entry.\nDuplicate entry.", "Prev entry."]]) {
    assert.deepEqual(rebuilt(diff(a, b)), [a, b]);
  }
});

/* The Delete buttons (#311) send exactly this shape: deleteEditFor's plan. */
const CARDS = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false };
  ${slice("  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${slice("  // Bibliography block", "  function wireChrome(")}
  ({ deleteEditFor })`, vm.createContext({}));

test("previewDiff: every Delete a card makes (deleteEditFor) previews as a pure strike of exactly the doomed text", () => {
  const cases = [
    ["sentence with a neighbour after it", "Trade grew under the Mongols. Pizza is delicious. Silk moved west.", "Pizza is delicious.", false, "Pizza is delicious. "],
    ["last sentence of its line", "Trade grew under the Mongols. Pizza is delicious.\n\nSilk moved west.", "Pizza is delicious.", false, " Pizza is delicious."],
    ["a line of its own", "Trade grew under the Mongols.\n\nPizza is delicious.\n\nSilk moved west.", "Pizza is delicious.", false, "\n\nPizza is delicious."],
    ["the later of two copies", "Works Cited\nLee, Jordan. A Life. Penguin, 2021.\nLee, Jordan. A Life. Penguin, 2021.\nSmith, Ann. Wars. Knopf, 2020.", "Lee, Jordan. A Life. Penguin, 2021.", true, null],
  ];
  for (const [name, body, quote, last, removed] of cases) {
    const plan = plain(CARDS.deleteEditFor(body, quote, last));
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
  assert.equal(p.other, 1, "a step it cannot draw is still counted in the bubble, never hidden");
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
}
const CHAR_W = 8; // the fake canvas measures every character 8px wide

/* The whole block, over the helpers it really uses (geometry, barTextRect,
 * the popover's element recipes, the reference-list reader). `lines`: the
 * simulated annotation layer, one rect per visual line. Frames and the 50 ms
 * fallback timer run only on pump(ms), which also advances the clock. */
function loadPreview({ reduced = true, lines = [], harness = null, docText = "" } = {}) {
  let clock = 1000;
  const queue = new Map();
  let seq = 0;
  const doc = {
    activeElement: null,
    createElement: (t) => (t === "canvas" ? { getContext: () => ({ font: "", measureText: (s) => ({ width: s.length * CHAR_W }) }) } : new FakeEl(doc, t)),
    createElementNS: (ns, t) => new FakeEl(doc, t),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes("rect[aria-label]") ? svg.filter((n) => n.isConnected) : []),
  };
  doc.documentElement = new FakeEl(doc, "html");
  doc.body = doc.documentElement.appendChild(new FakeEl(doc, "body"));
  doc.activeElement = doc.body;
  const svg = [];
  const addLine = (text, left, top, font = "16px Georgia") => {
    const n = doc.body.appendChild(new FakeEl(doc, "rect"));
    n.setAttribute("aria-label", text);
    n.setAttribute("data-font-css", font);
    n.rect = { left, top, width: text.length * CHAR_W, height: 18 };
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
    window: win, document: doc, location: { pathname: "/document/d/abc/edit" }, innerWidth: 1280, innerHeight: 800,
    performance: { now: () => clock }, console: quiet,
    requestAnimationFrame: (fn) => { queue.set(++seq, fn); return seq; }, cancelAnimationFrame: (id) => { queue.delete(id); },
    setTimeout: (fn) => { queue.set(++seq, fn); return seq; }, clearTimeout: (id) => { queue.delete(id); },
    matchMedia: () => ({ matches: reduced }),
  });
  const code = `
    const harness = ${harness === null ? "null" : JSON.stringify(harness)};
    const FEATURES = { typePreview: true };
    const APP = { font: "Test Sans" };
    let orphaned = false, popEl = null, previewDocEdit = null;
    let docText = ${JSON.stringify(docText)};
    const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
    ${REF_SLICE()}
    ${slice("    const nrm = (s) =>", "    /* Bars are carried by the COMPOSITOR")}
    ${slice("    function barTextRect(b) {", "    // A sentence we just rewrote")}
    ${slice("    const DM = { // index.css .docmark-*", "    /* A hint-styled control")}
    ${slice("    const TP_GLIDE_MS", "    // ── widget UI ──")}
    ({
      showTypePreview, previewDocEdit: (k, j) => previewDocEdit(k, j),
      setPop: (p) => { popEl = p; }, setOrphaned: (v) => { orphaned = v; },
      press: (r) => { tpPress = { rect: r, box: r, at: Date.now() }; },
    })`;
  const w = vm.runInContext(code, ctx, { filename: "content-type-preview.js" });
  const pump = (ms = 16) => {
    clock += ms;
    for (const id of [...queue.keys()]) {
      const fn = queue.get(id);
      if (!fn) continue; // cancelled by the frame that ran first
      queue.delete(id);
      fn();
    }
  };
  const all = function* (n) { for (const c of n.children) { yield c; yield* all(c); } };
  const find = (pred) => { for (const n of all(doc.documentElement)) if (pred(n)) return n; return null; };
  const layer = () => find((n) => n.hasAttribute("data-tracely-type-preview"));
  const bubble = () => find((n) => n.getAttribute("role") === "dialog");
  const byAttr = (a) => find((n) => n.hasAttribute(a));
  const px = (v) => Math.round(parseFloat(v) * 1000) / 1000; // fractions of a run: float noise only
  const outside = doc.body.appendChild(new FakeEl(doc, "div"));
  const clickOutside = () => fire("pointerdown", { target: outside, composedPath: () => [outside, doc.body, doc.documentElement] });
  const pressBubble = () => { const b = bubble(); return fire("pointerdown", { target: b.children[0], composedPath: () => [b.children[0], b, layer(), doc.documentElement] }); };
  return { w, doc, svg, addLine, fire, pump, find, layer, bubble, byAttr, px, outside, clickOutside, pressBubble, winListeners };
}

const SENTENCE = "Napoleon was famously short, standing well under five feet tall.";
const FIXED = "Napoleon was of average height, standing well under five feet tall.";
const TWO_LINES = [
  { text: "Napoleon was famously short, standing well", top: 100 },
  { text: "under five feet tall. The human body has 206 bones.", top: 130 },
];
const fixJob = (extra = {}) => ({ steps: [{ action: "replace", find: SENTENCE, replacement: FIXED, hint: { occurrence: 0, occurrences: 1 } }], ...extra });

test("on screen: the old words are struck over their exact run, the caret sits at the change, the bubble is right under that line", async () => {
  const t = loadPreview({ lines: TWO_LINES });
  const p = t.w.showTypePreview("fix:a", fixJob());
  const strike = t.byAttr("data-tracely-type-strike");
  // "Napoleon was " is 13 characters: "famously short" starts at x = 100 + 13·8 and is 14 characters wide.
  assert.deepEqual([t.px(strike.style.left), t.px(strike.style.top), t.px(strike.style.width), t.px(strike.style.height)], [100 + 13 * CHAR_W, 100, 14 * CHAR_W, 18]);
  assert.equal(strike.children[0].style.transform, "scaleX(1)", "reduced motion: the strike is already drawn");
  const caret = t.byAttr("data-tracely-type-caret");
  assert.equal(caret.style.transform, `translate(${100 + 13 * CHAR_W}px, 100px)`);
  assert.equal(caret.style.display, "block");
  assert.equal(caret.textContent, "Tracely", "the caret's name flag");
  assert.equal(caret.style.background, "#1c1c1c", "ink: colour only ever means a finding");
  const b = t.bubble();
  assert.equal(t.px(b.style.top), 118 + 10, "directly below the struck line");
  assert.equal(t.px(b.style.left), 100 + 13 * CHAR_W - 14, "at the caret's x");
  assert.equal(t.byAttr("data-tracely-type-typed").textContent, "of average height", "only the new words are typed; the old ones are struck in place");
  t.fire("keydown", { key: "Escape" });
  assert.equal(await p, false);
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
    const t = loadPreview({ lines: TWO_LINES });
    const p = t.w.showTypePreview("fix:a", fixJob());
    act(t);
    assert.equal(await p, false, `case ${i}`);
    assert.equal(t.layer(), null, `case ${i}: removed`);
  }
  // Clicking the bubble itself, or Accept, is not a "no".
  const t = loadPreview({ lines: TWO_LINES });
  const p = t.w.showTypePreview("fix:a", fixJob());
  t.pressBubble();
  assert.ok(t.layer(), "a click on the bubble keeps it");
  t.byAttr("data-tracely-type-accept").click();
  assert.equal(await p, true);
});

test("with motion: the caret glides from the pressed button, the strike draws, the words type in; a click on the bubble skips", async () => {
  const t = loadPreview({ reduced: false, lines: TWO_LINES });
  t.w.press({ left: 600, top: 400, width: 100, height: 30 });
  const p = t.w.showTypePreview("fix:a", fixJob());
  const caret = t.byAttr("data-tracely-type-caret");
  // t = 0: at the button's centre (the caret's middle on it).
  assert.equal(caret.style.transform, "translate(650px, 406px)");
  t.pump(175);
  assert.notEqual(caret.style.transform, "translate(650px, 406px)", "moving");
  t.pump(175); // 350 ms: arrived
  assert.equal(caret.style.transform, `translate(${100 + 13 * CHAR_W}px, 100px)`);
  t.pump(100); // halfway through the 200 ms strike
  const line = t.byAttr("data-tracely-type-strike").children[0];
  assert.equal(line.style.transform, "scaleX(0.5)");
  assert.equal(t.bubble().style.display, "none", "the bubble waits for the strike");
  t.pump(100); // 550 ms: the bubble appears
  assert.equal(t.bubble().style.display, "flex");
  t.pump(150); // 700 ms: typing began at 670 ms, 30 ms a character
  const typed = t.byAttr("data-tracely-type-typed");
  assert.equal(typed.textContent, "o");
  assert.equal(t.byAttr("data-tracely-type-accept").parentNode.style.display, "none", "no Accept before it has been seen whole");
  t.fire("keydown", { key: "Enter" }); // Enter while typing skips — it never accepts unseen text
  assert.equal(typed.textContent, "of average height");
  assert.equal(t.byAttr("data-tracely-type-accept").parentNode.style.display, "flex");
  t.fire("keydown", { key: "Escape" });
  assert.equal(await p, false);

  const t2 = loadPreview({ reduced: false, lines: TWO_LINES });
  const p2 = t2.w.showTypePreview("fix:a", fixJob());
  t2.pump(600);
  t2.pressBubble();
  assert.equal(t2.doc.activeElement, t2.byAttr("data-tracely-type-accept"), "skipped: Accept is up and focused");
  t2.fire("keydown", { key: "Enter" });
  assert.equal(await p2, true);
});

test("typing is capped: a long insertion types faster, never longer than ~1.2 s", () => {
  const long = `Napoleon was ${"x".repeat(200)}, standing well under five feet tall.`;
  const t = loadPreview({ reduced: false, lines: TWO_LINES });
  // No press and no underline rect: no glide. Strike 200 ms, fade 120 ms, then 200 characters at 6 ms.
  t.w.showTypePreview("fix:a", { steps: [{ action: "replace", find: SENTENCE, replacement: long }] });
  t.pump(200 + 120 + 1200 - 1);
  assert.equal(t.byAttr("data-tracely-type-accept").parentNode.style.display, "none");
  assert.equal(t.byAttr("data-tracely-type-typed").textContent.length, 199);
  t.pump(2);
  assert.equal(t.byAttr("data-tracely-type-accept").parentNode.style.display, "flex");
  assert.equal(t.byAttr("data-tracely-type-typed").textContent, "x".repeat(200));
});

test("a deletion: struck, nothing typed; a reference line reads 'Also adds to …' and marks where it goes", async () => {
  const t = loadPreview({
    lines: [{ text: "Off-topic line. Next sentence here.", top: 100 }, { text: "Works Cited", top: 300 }, { text: "Smith, A. Wars. 2020.", top: 330 }],
    docText: "Off-topic line. Next sentence here.\nWorks Cited\nSmith, A. Wars. 2020.\n",
  });
  const p = t.w.showTypePreview("x", { steps: [
    { action: "replace", find: "Off-topic line. Next sentence here.", replacement: "Next sentence here." },
    { action: "insertLineBefore", line: "Lee, J. A Life. 2021.", before: "Smith, A. Wars. 2020." },
  ] });
  const b = t.bubble();
  assert.match(b.textContent, /Deletes the struck-out words\./);
  assert.match(b.textContent, /Also adds to Works Cited/);
  assert.match(b.textContent, /Lee, J\. A Life\. 2021\./);
  const strike = t.byAttr("data-tracely-type-strike");
  assert.deepEqual([t.px(strike.style.left), t.px(strike.style.width)], [100, 16 * CHAR_W], "\"Off-topic line. \" struck, up to where \"Next\" starts");
  assert.equal(t.byAttr("data-tracely-type-typed"), null, "nothing typed");
  const mark = t.byAttr("data-tracely-type-mark");
  assert.deepEqual([mark.style.display, t.px(mark.style.top), t.px(mark.style.left)], ["block", 330 - 4, 100], "a thin line above the entry it goes before");
  t.fire("keydown", { key: "Escape" });
  assert.equal(await p, false);
});

test("a Delete across a paragraph break strikes only the doomed paragraph, on its own line", async () => {
  const body = "Trade grew under the Mongols.\n\nPizza is delicious.\n\nSilk moved west.";
  const plan = plain(CARDS.deleteEditFor(body, "Pizza is delicious."));
  const t = loadPreview({ lines: [{ text: "Trade grew under the Mongols.", top: 100 }, { text: "Pizza is delicious.", top: 150 }, { text: "Silk moved west.", top: 200 }] });
  const p = t.w.showTypePreview("del:x", { steps: [{ action: "replace", find: plan.find, replacement: plan.replacement, hint: { occurrence: plan.occurrence, occurrences: plan.occurrences } }] });
  const strike = t.byAttr("data-tracely-type-strike");
  assert.deepEqual([t.px(strike.style.left), t.px(strike.style.top), t.px(strike.style.width)], [100, 150, 19 * CHAR_W]);
  assert.equal(t.byAttr("data-tracely-type-caret").style.transform, "translate(100px, 150px)", "the caret at the start of what goes");
  assert.match(t.bubble().textContent, /Deletes the struck-out words\./);
  assert.equal(t.find((n) => n.id === t.bubble().getAttribute("aria-describedby")).textContent, "Deletes “Pizza is delicious.”.");
  t.fire("keydown", { key: "Escape" });
  assert.equal(await p, false);
});

test("off screen (no annotation layer): never scrolls — the same bubble, pinned beside the card, the change written inline", async () => {
  const t = loadPreview({ lines: [] });
  t.w.press({ left: 900, top: 500, width: 300, height: 200 });
  const p = t.w.showTypePreview("fix:a", fixJob());
  const b = t.bubble();
  assert.equal(t.px(b.style.left), 900 - 12 - 260, "left of the card (no room on its right)");
  assert.equal(t.px(b.style.top), 500);
  assert.match(b.textContent, /Not on screen, so it's shown here/);
  const struck = t.find((n) => n.style.textDecoration === "line-through");
  assert.equal(struck.textContent, "famously short");
  assert.match(b.textContent, /Napoleon was famously shortof average height, standing well under/);
  assert.equal(t.byAttr("data-tracely-type-caret").style.display, "none", "no caret in a document it is not drawn over");
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
  // With the underline's rect (the copy the popover hangs from), it is drawn on that copy.
  const t2 = loadPreview({ lines: [{ text: "The sky is green.", top: 100 }, { text: "The sky is green.", top: 200 }] });
  const p2 = t2.w.showTypePreview("fix:a", { steps: [{ ...job.steps[0], hint: { occurrences: 2, rects: [{ left: 110, top: 200, width: 100, height: 18 }] } }] });
  assert.equal(t2.px(t2.byAttr("data-tracely-type-strike").style.top), 200);
  t2.fire("keydown", { key: "Escape" });
  await p2;
});

test("it follows the text as Docs scrolls, and finds it again when Docs recycles the tile", async () => {
  const t = loadPreview({ lines: TWO_LINES });
  const p = t.w.showTypePreview("fix:a", fixJob());
  for (const n of t.svg) n.rect = { ...n.rect, top: n.rect.top - 40 };
  t.pump();
  const strike = () => t.byAttr("data-tracely-type-strike");
  assert.equal(t.px(strike().style.top), 60);
  assert.equal(t.px(t.bubble().style.top), 60 + 18 + 10);
  // Docs drops the tile's rects and paints new ones further down.
  for (const n of t.svg.splice(0)) n.remove();
  t.addLine(TWO_LINES[0].text, 100, 400);
  t.addLine(TWO_LINES[1].text, 100, 430);
  t.pump(300);
  assert.equal(t.px(strike().style.top), 400);
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
