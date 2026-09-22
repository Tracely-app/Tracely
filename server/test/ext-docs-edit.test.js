/**
 * "Fix in doc" — the in-editor edit engine in extension/docs-hook.js and its
 * wiring in content.js, pinned against the real extension files (no build
 * step: the hook runs whole in a vm realm with DOM stubs, content.js runs as
 * a slice, the way ext-citations.test.js and extension-beta.test.js drive it).
 *
 *   - the planner: normalisation and its index map, unique vs repeated
 *     matches and the hints that pick between copies, the minimal diff, and
 *     the paste edge rules Docs imposes (ported from the spike's unit.mjs —
 *     extension/dev/fix-in-doc/unit.mjs, which ran against the prototype);
 *   - the message protocol: only same-window, same-origin, correctly tagged
 *     requests are served; malformed ones get an error reply, never a throw;
 *   - the engine end to end against a fake Docs editor (model text, selection,
 *     paste/copy/undo), including a locked editor that silently ignores input;
 *   - content.js: when the in-doc buttons appear, the fallback to Copy on any
 *     refusal, and "Cite in doc" landing as one group that rolls back;
 *   - the manifest: 2.19.5, and not one new permission.
 *
 * The live-Doc proof (46/46, network severed) is extension/dev/fix-in-doc/.
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
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = "https://docs.google.com";

/* ── a fake Google Docs editor ─────────────────────────────────────────────
 * Just enough of kix for the engine: the annotated-text API over a model
 * string (U+0003 at 0, ending "\n\u0003\n", setSelection end-exclusive and
 * silently ignoring bad offsets), and the text-event iframe's contenteditable,
 * where a paste replaces the selection (minus leading/trailing ASCII spaces,
 * as measured), a synthetic copy fills the event's own DataTransfer, and
 * Backspace / Cmd+Z / Cmd+Shift+Z edit, undo and redo. locked = the editor
 * ignores input without a word, which is what a view-only, offline or
 * reconnecting Doc does. */
class FakeDT {
  constructor() { this.d = new Map(); }
  setData(t, v) { this.d.set(t, String(v)); }
  getData(t) { return this.d.get(t) ?? ""; }
}
class FakeClipboardEvent {
  constructor(type, init = {}) { this.type = type; this.clipboardData = init.clipboardData; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
}
class FakeKeyboardEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
}

class FakeDocs {
  constructor(body, { locked = false, mode = "Editing mode", ignoreSetSelection = false } = {}) {
    this.T = "\u0003" + body + "\n\u0003\n";
    this.sel = [{ start: 1, end: 1 }];
    this.locked = locked;
    this.modeLabel = mode;
    this.ignoreSetSelection = ignoreSetSelection;
    this.undoStack = [];
    this.redoStack = [];
    this.pastes = [];
    this.requesters = [];
    const self = this;
    this.at = {
      getText: () => self.T,
      getSelection: () => self.sel.map((r) => ({ start: r.start, end: r.end })),
      setSelection(s, e) {
        if (self.ignoreSetSelection) return;
        if (Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e >= s && e <= self.T.length) self.sel = [{ start: s, end: e }];
      },
    };
    const W = { DataTransfer: FakeDT, ClipboardEvent: FakeClipboardEvent, KeyboardEvent: FakeKeyboardEvent };
    this.ce = { ownerDocument: { defaultView: W }, dispatchEvent: (ev) => self.onEvent(ev) };
    this.iframe = { contentDocument: { querySelector: (s) => (s === "[contenteditable]" ? self.ce : null) } };
  }
  onEvent(ev) {
    if (ev.type === "copy") {
      const { start, end } = this.sel[0];
      ev.clipboardData.setData("text/plain", this.T.slice(start, end));
      ev.preventDefault();
      return false;
    }
    if (this.locked) return true;
    if (ev.type === "paste") {
      const text = ev.clipboardData.getData("text/plain");
      this.pastes.push({ text, html: ev.clipboardData.getData("text/html") });
      this.apply(text.replace(/^ +| +$/g, ""));
    } else if (ev.type === "keydown") {
      const mod = ev.metaKey || ev.ctrlKey;
      if (ev.key === "Backspace") this.apply("");
      else if (mod && ev.key === "z" && !ev.shiftKey) this.undo();
      else if (mod && ((ev.key === "z" && ev.shiftKey) || ev.key === "y")) this.redo();
    }
    return true;
  }
  apply(text) {
    const { start, end } = this.sel[0];
    this.undoStack.push({ T: this.T, sel: this.sel });
    this.redoStack = [];
    this.T = this.T.slice(0, start) + text + this.T.slice(end);
    this.sel = [{ start: start + text.length, end: start + text.length }];
  }
  undo() {
    const u = this.undoStack.pop();
    if (!u) return;
    this.redoStack.push({ T: this.T, sel: this.sel });
    this.T = u.T;
    this.sel = u.sel;
  }
  redo() {
    const r = this.redoStack.pop();
    if (!r) return;
    this.undoStack.push({ T: this.T, sel: this.sel });
    this.T = r.T;
    this.sel = r.sel;
  }
  body() { return this.T.slice(1, -3); }
}

/* ── the hook, in a vm realm ───────────────────────────────────────────── */

function loadHook({ docs = null, expose = true, canvas = true, pre } = {}) {
  const listeners = [];
  const posted = [];
  class CanvasCtx { fillText() {} strokeText() {} clearRect() {} fillRect() {} drawImage() {} putImageData() {} }
  class Canvas { get width() { return 0; } set width(v) {} get height() { return 0; } set height(v) {} }
  const document = {
    querySelector(sel) {
      if (sel === ".docs-texteventtarget-iframe") return docs ? docs.iframe : null;
      return null; // no .kix-appview-editor: the view lock has nothing to hold
    },
    querySelectorAll: () => [],
    getElementById: (id) => (id === "docs-toolbar-mode-switcher" && docs ? { getAttribute: () => docs.modeLabel } : null),
    elementsFromPoint: () => [],
  };
  const ctx = {
    console, setTimeout, clearTimeout, performance, Promise,
    navigator: { platform: "MacIntel", userAgent: "test" },
    location: { origin: ORIGIN, href: `${ORIGIN}/document/d/doc/edit` },
    innerWidth: 1280, innerHeight: 900,
    document,
    MouseEvent: class {},
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
    postMessage: (data, targetOrigin) => posted.push({ data, targetOrigin }),
  };
  if (canvas) { ctx.CanvasRenderingContext2D = CanvasCtx; ctx.HTMLCanvasElement = Canvas; }
  ctx.window = ctx;
  if (expose) ctx.__tracelyEditExpose = true;
  if (docs) ctx._docs_annotate_getAnnotatedText = (req) => { docs.requesters.push(req); return docs.at; };
  pre?.(ctx);
  vm.createContext(ctx);
  let loadError = null;
  try { vm.runInContext(read("docs-hook.js"), ctx, { filename: "docs-hook.js" }); } catch (e) { loadError = e; }

  // Inside the realm, `window` is the realm's global proxy, not `ctx` itself
  // — that proxy is what a real message's `source` would be.
  const win = vm.runInContext("window", ctx);
  let seq = 0;
  const dispatch = (ev) => { for (const fn of listeners) fn(ev); };
  // A request exactly as content.js sends one.
  const send = (op, args = {}) => {
    const id = `t${++seq}`;
    dispatch({ source: win, origin: ORIGIN, data: { ...args, source: "tracely", type: "tracely-docs-edit", id, op } });
    return id;
  };
  const replies = () => posted.map((p) => p.data).filter((d) => d && d.type === "tracely-docs-edit-result");
  async function reply(id, ms = 4000) {
    const t0 = Date.now();
    for (;;) {
      const r = replies().find((d) => d.id === id);
      if (r) return plain(r);
      if (Date.now() - t0 > ms) throw new Error(`no reply to ${id}`);
      await tick(5);
    }
  }
  const call = async (op, args) => reply(send(op, args));
  return { ctx, win, listeners, posted, send, dispatch, reply, replies, call, loadError, I: ctx.__tracelyEditInternals };
}

const DOC = "The film stars Tom Cruise. Maverick's return as coach is an order from his friend, Admiral Tom \"Iceman\" Kazansky. However, Rooster still holds a grudge and blames Maverick for his father's death. This film contains the values \u200b\u200bof friendship, competition, and courage. The story is really good. The music is really good which is recommended.";

/* ── the planner (ported from the spike's unit.mjs) ───────────────────── */

const I = loadHook().I;
const docPaste = (s) => s.replace(/^ +| +$/g, ""); // measured Docs behaviour for plain pastes

// Plans the edit, then simulates Docs applying it (and the reverse paste the
// semantic undo makes), and checks both round-trip.
function roundTrip(T, find, replacement, expectInsert) {
  const mt = I.matchText(T, find);
  assert.equal(mt.hits.length, 1, `hits for ${JSON.stringify(find)}`);
  const m = mt.hits[0];
  const p = I.planEdit(T, { map: mt.map, m, needle: mt.needle }, replacement);
  if (p.noop) {
    assert.equal(I.normMap(replacement).n, mt.needle);
    return p;
  }
  assert.ok(!/^\s|\s$/.test(p.insert), `insert has an edge space: ${JSON.stringify(p.insert)}`);
  assert.ok(!/^\s|\s$/.test(p.removedRaw), `removed has an edge space: ${JSON.stringify(p.removedRaw)}`);
  assert.equal(I.normMap(T.slice(p.s, p.e)).n.trim(), p.oldN.slice(p.oa, p.ob).trim(), "the selection verifies");
  const T2 = T.slice(0, p.s) + docPaste(p.insert) + T.slice(p.e);
  const rawS = mt.map[m], rawE = mt.map[m + mt.needle.length - 1] + 1;
  const expected = T.slice(0, rawS) + replacement + T.slice(rawE);
  assert.equal(I.normMap(T2).n, I.normMap(expected).n, "forward");
  if (expectInsert !== undefined) assert.equal(p.insert, expectInsert, "minimal diff");
  const ins = docPaste(p.insert);
  const T3 = T2.slice(0, p.s) + docPaste(p.removedRaw) + T2.slice(p.s + ins.length);
  assert.equal(I.normMap(T3).n, I.normMap(T).n, "reverse (semantic undo)");
  return p;
}
const T0 = "\u0003" + DOC + "\n\n\u0003\n";

test("planner: minimal diffs that survive Docs' paste rules, both ways", () => {
  roundTrip(T0, "The film stars Tom Cruise.", "The film stars Tom Cruise and Miles Teller.", "Cruise and Miles Teller");
  roundTrip(T0, "The film stars Tom Cruise.", "The film stars Tom Cruise [1].", "Cruise [1]");
  roundTrip(T0, "However, Rooster still holds a grudge and blames Maverick for his father's death.", "However, Rooster still blames Maverick for the death of his father, Goose.");
  roundTrip(T0, "However, Rooster still holds a grudge and blames Maverick for his father's death.", "However, Rooster blames Maverick for his father's death.");
  roundTrip(T0, "The story is really good.", "The story is good.");
  roundTrip(T0, "The story is really good.", "The story is really very good.");
  roundTrip(T0, "The film stars Tom Cruise.", "Tom Cruise leads the cast."); // whole rewrite
  roundTrip(T0, "However, Rooster still holds a grudge and blames Maverick for his father's death.", "However, Rooster still holds a grudge and blames Maverick for his father's death. (Top Gun: Maverick, 2022)", ". (Top Gun: Maverick, 2022)");
});

test("planner: smart quotes, dashes, ellipses and zero-width chars fold, and the doc's own characters are kept", () => {
  roundTrip(T0, "Maverick’s return as coach is an order from his friend, Admiral Tom “Iceman” Kazansky.", "Maverick’s return as coach is an order from his friend, Admiral Tom “Iceman” Kazansky — his old rival.");
  roundTrip(T0, "Maverick's return as coach is an order from his friend, Admiral Tom \"Iceman\" Kazansky.", "Maverick’s return as coach is a favour from his friend, Admiral Tom “Iceman” Kazansky.", "a favour");
  roundTrip(T0, "This film contains the values of friendship, competition, and courage.", "This film contains the values of friendship, rivalry, and courage.", "rivalry");
  roundTrip(T0, "This film contains the values of friendship, competition, and courage.", "This film celebrates friendship, competition, and courage.");
  roundTrip("\u0003He waited… then left — fast.\n\u0003\n", "He waited... then left - fast.", "He waited… then left — very fast.", "very fast");
  roundTrip("\u0003Wait.\n\u0003\n", "Wait.", "Wait…");
});

test("planner: no-ops, and the export's list markers", () => {
  assert.equal(roundTrip(T0, "The film stars Tom Cruise.", "The film stars Tom Cruise.").noop, true);
  roundTrip("\u0003Einstein was a basketball player.\n\u0003\n", "* Einstein was a basketball player.", "Einstein was a physicist.");
  const mt = I.matchText("\u0003Einstein was a basketball player.\n\u0003\n", "2. Einstein was a basketball player.");
  assert.equal(mt.hits.length, 1);
  assert.equal(mt.stripped, "2. ");
});

test("planner: matching rules — word boundaries, paragraphs, whitespace, case", () => {
  assert.equal(I.matchText(T0, "is really good").hits.length, 2, "repeated text is ambiguous, not first-wins");
  assert.equal(I.matchText(T0, "tars Tom Cruise.").hits.length, 0, "never mid-word");
  assert.equal(I.matchText("\u0003One two.\nThree four.\n\u0003\n", "two. Three").hits.length, 0, "never across a paragraph break");
  assert.equal(I.matchText("\u0003A\u00a0 b  c.\n\u0003\n", "A b c.").hits.length, 1, "NBSP and runs of spaces fold");
  assert.equal(I.matchText(T0, "the film stars tom cruise.").hits.length, 0, "case-sensitive");
  assert.equal(I.matchText("\u0003A\u0001B.\n\u0003\n", "A B.").hits.length, 0, "an object marker is a hard boundary");
});

test("planner: the index map points every normalised char back at its raw offset", () => {
  const nm = I.normMap("\u0003a…b");
  assert.equal(nm.n, "\na...b");
  assert.deepEqual([...nm.map], [0, 1, 2, 2, 2, 3]);
  const z = I.normMap("x\u200b\u200by  z");
  assert.equal(z.n, "xy z");
  assert.deepEqual([...z.map], [0, 3, 4, 6], "zero-width chars vanish; a space run maps to its first char");
  const q = I.normMap("“a” — b");
  assert.equal(q.n, "\"a\" - b");
});

test("planner: planDiff never leaves an edge space or an empty side", () => {
  for (const [a, b] of [
    ["The story is really good.", "The story is good."],
    ["The story is good.", "The story is really good."],
    ["one two three", "one three"],
    ["alpha beta", "alpha beta gamma"],
  ]) {
    const d = I.planDiff(a, b);
    const om = a.slice(d.oa, d.ob), nm = b.slice(d.na, d.nb);
    assert.ok(om.length && nm.length, `empty side for ${a} → ${b}`);
    assert.ok(!/^\s|\s$/.test(om) && !/^\s|\s$/.test(nm), `edge space for ${a} → ${b}: ${JSON.stringify([om, nm])}`);
    assert.equal(a.slice(0, d.oa) + nm + a.slice(d.ob), b);
  }
});

test("planner: repeated copies are picked by the caret a rect click reads, else by occurrence — only if the counts agree", () => {
  const T = "\u0003It is good. Then more. It is good.\n\u0003\n";
  const { hits, map, needle } = I.matchText(T, "It is good.");
  assert.equal(hits.length, 2);
  const none = { occurrence: null, occurrences: null, rects: [] };
  assert.equal(I.pickHit(hits, map, needle.length, none, null), null, "no hint → ambiguous");
  assert.equal(I.pickHit(hits, map, needle.length, { ...none, occurrence: 1, occurrences: 2 }, null).m, hits[1]);
  assert.equal(I.pickHit(hits, map, needle.length, { ...none, occurrence: 1, occurrences: 3 }, null), null, "the export and the live model disagree on the count");
  assert.equal(I.pickHit(hits, map, needle.length, { ...none, occurrence: 5 }, null), null, "out of range");
  const caretInSecond = map[hits[1]] + 3;
  const r = I.pickHit(hits, map, needle.length, { ...none, occurrence: 0, occurrences: 2 }, caretInSecond);
  assert.deepEqual([r.m, r.via], [hits[1], "rects"], "the caret wins over the occurrence index");
  assert.equal(I.pickHit([hits[0]], map, needle.length, none, null).via, "unique");
});

test("planner: hints are sanitised to numbers and at most 8 rects", () => {
  const h = I.hintOf({ hint: { occurrence: "1", occurrences: 2.5, rects: [{ left: 1, top: 2, width: "x" }, { left: "a", top: 1 }, null, ...Array(20).fill({ left: 0, top: 0, width: 5, height: 5 })] } });
  assert.equal(h.occurrence, null);
  assert.equal(h.occurrences, null);
  assert.ok(h.rects.length <= 8);
  assert.deepEqual(plain(h.rects[0]), { left: 1, top: 2, width: 0, height: 0 });
  assert.deepEqual(plain(I.hintOf({ hint: "junk" })), { occurrence: null, occurrences: null, rects: [] });
  assert.deepEqual(plain(I.hintOf({})), { occurrence: null, occurrences: null, rects: [] });
});

test("planner: a new line goes at the end of the last paragraph with text, as its own paragraph", () => {
  const T = "\u0003Body text.\n\n\u0003\n";
  const p = I.planAppend(T, "Sources:");
  assert.equal(p.text, "\nSources:");
  assert.equal(p.newParagraph, true);
  assert.equal(T.slice(0, p.c), "\u0003Body text.", "after the last text, not in the trailing empty paragraph (which carries default styling)");
  const empty = I.planAppend("\u0003\n\u0003\n", "Sources:");
  assert.equal(empty.text, "Sources:", "an empty doc needs no paragraph break");
  assert.equal(I.planAppend("no sentinel", "x"), null, "unknown document end → refuse");
});

/* ── the hook: load order and isolation ───────────────────────────────── */

test("docs-hook: the Docs flag is still set first, and the engine installs lazily", () => {
  const src = read("docs-hook.js");
  const flag = src.indexOf("window._docs_annotate_canvas_by_ext = ANNOTATION_REQUESTER");
  const install = src.indexOf("installEditEngine(ANNOTATION_REQUESTER);");
  const canvas = src.indexOf("CanvasRenderingContext2D.prototype");
  assert.ok(flag > 0 && install > flag && canvas > install, "flag → engine listener → canvas hook");
  const code = src.slice(src.indexOf("(() => {"), flag)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .split("\n").map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(code, [
    "(() => {", "\"use strict\";", "if (window.__tracelyDocsHook) return;", "window.__tracelyDocsHook = true;",
    "const ANNOTATION_REQUESTER = \"tracely\";", "try {",
  ], "nothing runs before the flag but the re-entry guard");
  const docs = new FakeDocs("Hello there, world.");
  const h = loadHook({ docs });
  assert.equal(h.loadError, null);
  assert.equal(h.ctx._docs_annotate_canvas_by_ext, "tracely");
  assert.equal(docs.requesters.length, 0, "installing the engine must not touch Docs' API");
});

test("docs-hook: a canvas-hook failure cannot take the edit engine down", async () => {
  const docs = new FakeDocs("Hello there, world.");
  const h = loadHook({ docs, canvas: false });
  assert.ok(h.loadError, "no CanvasRenderingContext2D → the canvas hook throws (as it would in a broken page)");
  assert.equal(h.ctx._docs_annotate_canvas_by_ext, "tracely");
  const r = await h.call("ping");
  assert.equal(r.ok, true);
  assert.equal(r.editable, true);
});

/* ── the message protocol ─────────────────────────────────────────────── */

test("protocol: ping reports the text API and whether the editor looks editable", async () => {
  const docs = new FakeDocs("Hello there, world.");
  const h = loadHook({ docs });
  const r = await h.call("ping");
  assert.equal(r.source, "tracely-hook");
  assert.equal(r.type, "tracely-docs-edit-result");
  assert.equal(r.op, "ping");
  assert.deepEqual([r.ok, r.api, r.editor, r.editable, r.mode, r.viewOnly], [true, true, true, true, "editing", false]);
  assert.deepEqual(docs.requesters, ["tracely"], "the requester is our own honest id — never a third party's");
  assert.ok(h.posted.every((p) => p.targetOrigin === ORIGIN), "replies go to this origin only, never '*'");

  const view = loadHook({ docs: new FakeDocs("Hello there.", { mode: "View only" }) });
  const v = await view.call("ping");
  assert.deepEqual([v.api, v.viewOnly, v.editable], [true, true, false]);

  const noApi = loadHook();
  const n = await noApi.call("ping");
  assert.deepEqual([n.ok, n.api, n.editor, n.editable], [true, false, false, false]);
});

test("protocol: wrong window, wrong origin or wrong tag is ignored — no reply, no edit", async () => {
  const docs = new FakeDocs("Hello there, world.");
  const h = loadHook({ docs });
  const req = { source: "tracely", type: "tracely-docs-edit", id: "x", op: "replace", find: "Hello there, world.", replacement: "Goodbye." };
  h.dispatch({ source: {}, origin: ORIGIN, data: req });                          // another window (an iframe)
  h.dispatch({ source: h.win, origin: "https://evil.example", data: req });       // another origin
  h.dispatch({ source: h.win, origin: "null", data: req });
  h.dispatch({ source: h.win, origin: ORIGIN, data: { ...req, source: "page" } });  // untagged page message
  h.dispatch({ source: h.win, origin: ORIGIN, data: { ...req, source: undefined } });
  h.dispatch({ source: h.win, origin: ORIGIN, data: { ...req, type: "tracely-docs-locate" } });
  await tick(60);
  assert.equal(h.replies().length, 0);
  assert.equal(docs.body(), "Hello there, world.");
  assert.equal(docs.pastes.length, 0);
});

test("protocol: malformed requests get an error reply, and the listener never throws", async () => {
  const docs = new FakeDocs("Hello there, world.");
  const h = loadHook({ docs });
  assert.equal((await h.call("frobnicate")).reason, "bad-request");
  assert.equal((await h.call("toString")).reason, "bad-request", "Object.prototype names are not ops");
  assert.equal((await h.call("__proto__")).reason, "bad-request");
  assert.equal((await h.call("replace", { find: 42, replacement: "x" })).reason, "bad-request");
  assert.equal((await h.call("replace", { find: "Hello there, world." })).reason, "bad-request");
  assert.equal((await h.call("replace", { find: "Hello there, world.", replacement: "   " })).reason, "bad-request", "never deletes a sentence outright");
  assert.equal((await h.call("replace", { find: "x".repeat(4001), replacement: "y" })).reason, "bad-request");
  assert.equal((await h.call("insertAfter", { find: "Hello there, world." })).reason, "bad-request");
  assert.equal((await h.call("insertAfter", { find: "Hello there, world.", text: " x", html: 7 })).reason, "bad-request");
  assert.equal((await h.call("appendLine", { line: { a: 1 } })).reason, "bad-request");
  assert.equal((await h.call("undo", {})).reason, "bad-request");
  assert.equal((await h.call("undo", { undoToken: ["ok", 5] })).reason, "bad-request");
  // No id: still answered (id null), so nothing hangs silently on a bad caller.
  h.dispatch({ source: h.win, origin: ORIGIN, data: { source: "tracely", type: "tracely-docs-edit", op: "ping" } });
  await tick(20);
  assert.ok(h.replies().some((r) => r.id === null && r.reason === "bad-request"));
  // Hostile shapes never escape the listener.
  const hostile = { source: "tracely", type: "tracely-docs-edit", id: "h", get op() { throw new Error("boom"); } };
  for (const data of [null, undefined, "tracely-docs-edit", 7, [], hostile]) {
    assert.doesNotThrow(() => h.dispatch({ source: h.win, origin: ORIGIN, data }));
  }
  assert.equal(docs.body(), "Hello there, world.", "nothing malformed ever edits");
});

/* ── the engine, end to end against the fake editor ───────────────────── */

test("engine: replace pastes only the changed words, verifies, and keeps the user's caret", async () => {
  const docs = new FakeDocs(DOC);
  const h = loadHook({ docs });
  const after = docs.T.indexOf("The music");
  docs.sel = [{ start: after, end: after }]; // the user's caret, after the edit site
  const r = await h.call("replace", { find: "The film stars Tom Cruise.", replacement: "The film stars Tom Cruise and Miles Teller." });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verified, "exact");
  assert.match(r.undoToken, /^e/);
  assert.equal(docs.pastes.length, 1);
  assert.equal(docs.pastes[0].text, "Cruise and Miles Teller", "the minimal diff: formatting outside it survives");
  assert.ok(docs.body().startsWith("The film stars Tom Cruise and Miles Teller. Maverick"));
  const grew = "Cruise and Miles Teller".length - "Cruise".length;
  assert.deepEqual(docs.sel, [{ start: after + grew, end: after + grew }], "caret restored, shifted by the edit");
  assert.equal(r.selectionRestored, true);
});

test("engine: insertAfter and appendLine land where a person would put them, and one undo takes a group back", async () => {
  const docs = new FakeDocs("Einstein was born in 1879. He was a physicist.");
  const before = docs.T;
  const h = loadHook({ docs });
  const a = await h.call("insertAfter", { find: "Einstein was born in 1879.", text: " [1]" });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(docs.body(), "Einstein was born in 1879. [1] He was a physicist.");
  const b = await h.call("appendLine", { line: "Sources:" });
  const c = await h.call("appendLine", { line: "1. Isaacson, W. (2007). Einstein. — https://example.com/e" });
  assert.equal(b.ok && c.ok, true, JSON.stringify([b, c]));
  assert.equal(docs.body(), "Einstein was born in 1879. [1] He was a physicist.\nSources:\n1. Isaacson, W. (2007). Einstein. — https://example.com/e");
  const u = await h.call("undo", { undoToken: [c.undoToken, b.undoToken, a.undoToken] });
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(docs.T, before, "exactly as it was");
  assert.equal((await h.call("undo", { undoToken: a.undoToken })).reason, "unknown-token", "a token is spent once");
});

test("engine: undo after someone else typed reverses only our words (semantic undo)", async () => {
  const MID = "The rest of this document is long enough to sit well clear of the edit's context.";
  const docs = new FakeDocs(`The story is really good. ${MID} The end.`);
  const h = loadHook({ docs });
  const r = await h.call("replace", { find: "The story is really good.", replacement: "The story is good." });
  assert.equal(r.ok, true);
  // A later edit by the user — Cmd+Z would now undo THEIR typing, not ours.
  const at = docs.T.indexOf("The end.") + 4;
  docs.sel = [{ start: at, end: at }];
  docs.apply("very ");
  const u = await h.call("undo", { undoToken: r.undoToken });
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(u.steps[0].method, "reverse-edit");
  assert.equal(docs.body(), `The story is really good. ${MID} The very end.`, "our edit gone, theirs kept");
});

test("engine: a locked editor ignores the paste, and that is reported — never assumed", async () => {
  const docs = new FakeDocs("The film stars Tom Cruise.", { locked: true });
  const h = loadHook({ docs });
  const r = await h.call("replace", { find: "The film stars Tom Cruise.", replacement: "The film stars Tom Cruise [1]." });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-applied");
  assert.equal(r.undoToken, undefined);
  assert.equal(docs.body(), "The film stars Tom Cruise.");
});

test("engine: refusals — not found, ambiguous, view-only, unverifiable selection, harness guard", async () => {
  const docs = new FakeDocs("It is good. Then more. It is good.");
  const h = loadHook({ docs });
  assert.equal((await h.call("replace", { find: "Not in the doc.", replacement: "x y." })).reason, "not-found");
  const amb = await h.call("replace", { find: "It is good.", replacement: "It is great." });
  assert.deepEqual([amb.reason, amb.matches], ["ambiguous", 2]);
  const wrongCount = await h.call("replace", { find: "It is good.", replacement: "It is great.", hint: { occurrence: 1, occurrences: 3 } });
  assert.equal(wrongCount.reason, "ambiguous", "the export's count disagrees with the live doc: refuse");
  const second = await h.call("replace", { find: "It is good.", replacement: "It is great.", hint: { occurrence: 1, occurrences: 2 } });
  assert.equal(second.ok, true);
  assert.equal(second.target.via, "occurrence");
  assert.equal(docs.body(), "It is good. Then more. It is great.", "the copy the hint named, and only it");

  const view = new FakeDocs("The film stars Tom Cruise.", { mode: "View only" });
  const hv = loadHook({ docs: view });
  assert.equal((await hv.call("replace", { find: "The film stars Tom Cruise.", replacement: "The film stars Tom Cruise [1]." })).reason, "view-only");
  assert.equal(view.pastes.length, 0);

  const stuck = new FakeDocs("The film stars Tom Cruise.", { ignoreSetSelection: true });
  const hs = loadHook({ docs: stuck });
  assert.equal((await hs.call("replace", { find: "The film stars Tom Cruise.", replacement: "The film stars Tom Cruise [1]." })).reason, "selection-failed");
  assert.equal(stuck.pastes.length, 0, "nothing is pasted over a selection that was not verified");

  const guarded = new FakeDocs("The film stars Tom Cruise.");
  const hg = loadHook({ docs: guarded, pre: (ctx) => { ctx.__tracelyEditConfig = { allowEdits: false }; } });
  assert.equal((await hg.call("replace", { find: "The film stars Tom Cruise.", replacement: "The film stars Tom Cruise [1]." })).reason, "edits-disabled");
  const dry = await hg.call("replace", { find: "The film stars Tom Cruise.", replacement: "The film stars Tom Cruise [1].", dryRun: true });
  assert.deepEqual([dry.ok, dry.dryRun, dry.edit.insert], [true, true, "Cruise [1]"]);
  assert.equal(guarded.pastes.length, 0);
  assert.equal((await hg.call("ping")).editable, false);
});

test("engine: no text API → replace refuses without rects, append refuses outright", async () => {
  const docs = new FakeDocs("The film stars Tom Cruise.");
  const h = loadHook({ docs, pre: (ctx) => { delete ctx._docs_annotate_getAnnotatedText; } });
  assert.equal((await h.call("replace", { find: "The film stars Tom Cruise.", replacement: "x y z." })).reason, "no-api");
  assert.equal((await h.call("appendLine", { line: "Sources:" })).reason, "no-api");
  assert.equal(docs.pastes.length, 0);
});

test("engine: edits run one at a time, in order", async () => {
  const docs = new FakeDocs("One two three. Four five six.");
  const h = loadHook({ docs });
  const a = h.send("replace", { find: "One two three.", replacement: "One two three four." });
  const b = h.send("replace", { find: "Four five six.", replacement: "Four five six seven." });
  const [ra, rb] = await Promise.all([h.reply(a), h.reply(b)]);
  assert.equal(ra.ok && rb.ok, true);
  assert.equal(docs.body(), "One two three four. Four five six seven.");
});

/* ── content.js wiring ────────────────────────────────────────────────── */

function contentSlice(from, to) {
  const src = read("content.js");
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `content.js: could not find ${from} .. ${to}`);
  return src.slice(a, b);
}

/* docsMode's editing section, run with its real helpers (esc, withMarkers,
 * hashText, formatCitation, sourcesBlock) and a scripted stand-in for the
 * hook: `respond(msg)` returns the reply for each request, or undefined for
 * "the hook never answers". */
function loadWiring({ harness = null, respond = () => undefined, clipboard = "ok", body = "" } = {}) {
  const listeners = [];
  const sent = [];
  const copied = [];
  const apiCalls = [];
  const win = {
    addEventListener: (t, fn) => { if (t === "message") listeners.push(fn); },
    removeEventListener: (t, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    postMessage(data, targetOrigin) {
      sent.push({ data: plain(data), targetOrigin });
      const r = respond(plain(data));
      if (r === undefined) return;
      setTimeout(() => {
        for (const fn of [...listeners]) fn({ source: win, origin: ORIGIN, data: { source: "tracely-hook", type: "tracely-docs-edit-result", id: data.id, op: data.op, ...r } });
      }, 1);
    },
  };
  const ctx = vm.createContext({
    window: win, location: { origin: ORIGIN }, document: { hidden: false },
    innerWidth: 1280, innerHeight: 900, console,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 40)), clearTimeout,
    navigator: { clipboard: { writeText: async (t) => { if (clipboard !== "ok") throw new Error("denied"); copied.push(t); } } },
    URL,
    api: async (p, b) => { apiCalls.push({ path: p, body: plain(b ?? null) }); if (ctx.__apiFails) throw new Error("bridge said no"); return {}; },
  });
  const code = `
    const harness = ${harness ? "{ getText: () => '' }" : "null"};
    const IS_DOCS = true;
    const DOC_ID = "doc123";
    const CHECK_INTERVAL_MS = 10000;
    let orphaned = false;
    let bridgeReady = false, docBusy = false;
    let inDoc = { api: false, editable: false };
    let lastPingAt = 0;
    const docEditState = new Map();
    let lastDocEdit = null;
    const editedHashes = new Map();
    const popEditSyncs = new Set();
    let docText = ${JSON.stringify(body)};
    let segments = [], docsBars = [];
    const cache = new Map(), sourcesMap = new Map();
    const settings = { citationStyle: "apa" };
    let statusKind = "idle", statusMsg = "", lastCheckEnd = 0;
    let flowDismissed = new Set(), flowSig = "sig";
    let renders = 0, marks = 0;
    const render = () => { renders++; };
    const requestDocsMarks = () => { marks++; };
    const persistCaches = () => {}, persistFlow = () => {};
    ${contentSlice("  function hashText(s) {", "  /* A Doc opened from a second")}
    ${contentSlice("  // Bibliography block", "  function segmentText(")}
    ${contentSlice("  function esc(s) {", "  /* ── transport")}
    ${contentSlice("    /* ── editing the document ──", "    // (the bridge \"highlight in doc\" feature was removed")}
    ({
      docsEdit, probeInDoc, canEditDoc, docApply, docFix, docCite, addTransition, undoLastDocEdit, editView, editBtnHtml, segHint, hashText,
      setBridge: (v) => { bridgeReady = v; },
      setDoc: (text, segs) => { docText = text; segments = segs; },
      cache, sourcesMap, flowDismissed, editedHashes, docEditState,
      state: () => ({ inDoc, lastDocEdit, statusMsg, statusKind, docBusy, flowSig, renders, marks, lastCheckEnd }),
    })`;
  const w = vm.runInContext(code, ctx, { filename: "content-slice.js" });
  const ops = () => sent.map((s) => s.data).filter((d) => d.type === "tracely-docs-edit");
  const deliver = (ev) => { for (const fn of [...listeners]) fn(ev); };
  return { w, ctx, win, sent, ops, copied, apiCalls, listeners, deliver };
}
function seg(text, start = 0) {
  return { text, start, end: start + text.length, checkable: true };
}
const okPing = (m) => (m.op === "ping" ? { ok: true, api: true, editor: true, editable: true } : undefined);

test("content.js: canEditDoc follows the hook's ping, the dev bridge, and never the harness", async () => {
  let reply = { ok: true, api: true, editor: true, editable: true };
  const { w, ops, sent } = loadWiring({ respond: (m) => (m.op === "ping" ? reply : undefined) });
  assert.equal(w.canEditDoc(), false, "nothing known yet → Copy only");
  await w.probeInDoc();
  assert.equal(w.canEditDoc(), true);
  const ping = ops()[0];
  assert.deepEqual([ping.source, ping.type, ping.op, typeof ping.id], ["tracely", "tracely-docs-edit", "ping", "string"]);
  assert.equal(sent[0].targetOrigin, ORIGIN, "requests go to this origin only, never '*'");
  reply = { ok: true, api: true, editor: true, editable: false }; // view-only Doc
  await w.probeInDoc();
  assert.equal(w.canEditDoc(), false);
  reply = { ok: true, api: false, editor: true, editable: true }; // no text API: can't verify, so no
  await w.probeInDoc();
  assert.equal(w.canEditDoc(), false);
  reply = undefined; // hook absent: the ping times out
  await w.probeInDoc();
  assert.equal(w.canEditDoc(), false);
  w.setBridge(true);
  assert.equal(w.canEditDoc(), true, "the local Apps Script bridge still counts (developer builds)");

  const hw = loadWiring({ harness: true, respond: okPing });
  await hw.w.probeInDoc();
  hw.w.setBridge(true);
  assert.equal(hw.w.canEditDoc(), false, "the harness page never edits");
  assert.equal(hw.ops().length, 0, "and never even pings");
});

test("content.js: docsEdit takes only its own reply — same window, same origin, our tag, our id — and hears a late one", async () => {
  const { w, win, ops, deliver } = loadWiring();
  const p = w.docsEdit("ping", {}, { timeoutMs: 1000 });
  const id = ops()[0].id;
  const good = { source: "tracely-hook", type: "tracely-docs-edit-result", id, ok: true, api: true };
  deliver({ source: {}, origin: ORIGIN, data: { ...good, forged: "window" } });
  deliver({ source: win, origin: "https://evil.example", data: { ...good, forged: "origin" } });
  deliver({ source: win, origin: ORIGIN, data: { ...good, source: "page", forged: "tag" } });
  deliver({ source: win, origin: ORIGIN, data: { ...good, id: "someone-else", forged: "id" } });
  deliver({ source: win, origin: ORIGIN, data: good });
  const r = await p;
  assert.deepEqual(plain(r), good);

  let late = null;
  const p2 = w.docsEdit("replace", { find: "a b c.", replacement: "a b d." }, { timeoutMs: 5, onLate: (d) => { late = plain(d); } });
  const id2 = ops()[1].id;
  assert.deepEqual(plain(await p2), { ok: false, reason: "timeout" });
  deliver({ source: win, origin: ORIGIN, data: { ...good, id: id2, undoToken: "late1" } });
  assert.equal(late?.undoToken, "late1", "an answer after the timeout still reaches the caller: the doc DID change");
  const sentReq = ops()[1];
  assert.deepEqual([sentReq.source, sentReq.type, sentReq.op, sentReq.find], ["tracely", "tracely-docs-edit", "replace", "a b c."]);
});

test("content.js: Fix in doc → Applied ✓ · Undo, the old sentence's underline drops, and Undo restores it", async () => {
  const S = "Einstein was a basketball player.";
  const { w, ops } = loadWiring({ respond: (m) => (m.op === "ping" ? okPing(m) : m.op === "replace" ? { ok: true, undoToken: "u1" } : m.op === "undo" ? { ok: true } : undefined), body: S });
  await w.probeInDoc();
  const h = w.hashText(S);
  w.setDoc(S, [{ ...seg(S), hash: h }]);
  const finding = { verdict: "false", revision: "Einstein was a physicist." };
  w.cache.set(h, finding);
  assert.equal(await w.docFix(h), true);
  const rep = ops().find((o) => o.op === "replace");
  assert.equal(rep.find, S);
  assert.equal(rep.replacement, "Einstein was a physicist.");
  assert.deepEqual(rep.hint, { occurrence: 0, occurrences: 1 });
  const st = w.state();
  assert.equal(st.statusMsg, "fixed in doc");
  assert.deepEqual(plain(st.lastDocEdit.tokens), ["u1"]);
  assert.equal(w.cache.has(h), false, "re-verified on the next read");
  assert.ok(w.editedHashes.has(h), "the old text is neither underlined nor re-checked while the export lags");
  assert.ok(st.marks > 0, "underlines re-requested right away");
  const html = w.editBtnHtml(`fix:${h}`, "Fix in doc", `data-doc-fix="${h}"`);
  assert.match(html, /disabled>Applied ✓<\/button>/);
  assert.match(html, /data-doc-undo="1"[^>]*>Undo<\/button>/);

  assert.equal(await w.undoLastDocEdit(), true);
  const u = ops().find((o) => o.op === "undo");
  assert.deepEqual(u.undoToken, ["u1"]);
  assert.equal(w.cache.get(h), finding, "the original is back, with its verdict — no re-check spent");
  assert.equal(w.editedHashes.has(h), false);
  assert.equal(w.state().lastDocEdit, null);
  assert.equal(w.state().statusMsg, "undone");
  assert.equal(w.editView(`fix:${h}`, "Fix in doc").label, "Fix in doc");
});

test("content.js: a refused edit copies the fix instead, with a short reason", async () => {
  const S = "Einstein was a basketball player.";
  for (const [reason, text] of [
    ["not-found", "that sentence changed since the last check"],
    ["ambiguous", "that sentence appears more than once"],
    ["not-applied", "this doc isn't editable right now"],
    ["view-only", "this doc isn't editable right now"],
    ["selection-mismatch", "the editor couldn't make that edit"],
  ]) {
    const { w, ops, copied } = loadWiring({ respond: (m) => (m.op === "ping" ? okPing(m) : m.op === "replace" ? { ok: false, reason } : undefined), body: S });
    await w.probeInDoc();
    const h = w.hashText(S);
    w.setDoc(S, [{ ...seg(S), hash: h }]);
    w.cache.set(h, { verdict: "false", revision: "Einstein was a physicist." });
    assert.equal(await w.docFix(h), false);
    assert.deepEqual(copied, ["Einstein was a physicist."], reason);
    const v = w.editView(`fix:${h}`, "Fix in doc");
    assert.equal(v.label, "Couldn't apply — copied instead");
    assert.equal(v.note, text, reason);
    assert.match(w.state().statusMsg, /^Couldn't apply — copied instead \(/);
    assert.ok(w.cache.has(h), "nothing changed, so the verdict stays");
    assert.equal(ops().filter((o) => o.op === "undo").length, 0, "nothing landed, nothing to take back");
    assert.equal(w.state().lastDocEdit, null);
  }
});

test("content.js: clipboard denied → 'Couldn't apply', and Copy fix stays the way out", async () => {
  const S = "Einstein was a basketball player.";
  const { w } = loadWiring({ clipboard: "denied", respond: (m) => (m.op === "ping" ? okPing(m) : m.op === "replace" ? { ok: false, reason: "not-found" } : undefined), body: S });
  await w.probeInDoc();
  const h = w.hashText(S);
  w.setDoc(S, [{ ...seg(S), hash: h }]);
  w.cache.set(h, { verdict: "false", revision: "Einstein was a physicist." });
  await w.docFix(h);
  assert.equal(w.editView(`fix:${h}`, "Fix in doc").label, "Couldn't apply");
});

test("content.js: an edit that landed wrong is taken back before copying", async () => {
  const S = "Einstein was a basketball player.";
  const { w, ops, copied } = loadWiring({ respond: (m) => (m.op === "ping" ? okPing(m) : m.op === "replace" ? { ok: false, reason: "mismatch", changed: true, undoToken: "bad1" } : m.op === "undo" ? { ok: true } : undefined), body: S });
  await w.probeInDoc();
  const h = w.hashText(S);
  w.setDoc(S, [{ ...seg(S), hash: h }]);
  w.cache.set(h, { verdict: "false", revision: "Einstein was a physicist." });
  assert.equal(await w.docFix(h), false);
  assert.deepEqual(ops().find((o) => o.op === "undo").undoToken, ["bad1"]);
  assert.deepEqual(copied, ["Einstein was a physicist."]);
});

function citeSetup(respond) {
  const S = "The Great Wall is visible from space.";
  const body = `${S} It is long.`;
  const env = loadWiring({ respond, body });
  const h = env.w.hashText(S);
  env.w.setDoc(body, [{ ...seg(S), hash: h }]);
  env.w.cache.set(h, { verdict: "needs_citation" });
  env.w.sourcesMap.set(h, { loading: false, list: [{ title: "Can you see the Great Wall?", url: "https://example.com/wall", publisher: "NASA" }], citedUrl: null });
  return { ...env, S, h };
}

test("content.js: Cite in doc is ONE group — marker, heading, entry — and a failure part-way rolls it all back", async () => {
  let n = 0;
  const { w, ops, copied, S, h } = citeSetup((m) => {
    if (m.op === "ping") return okPing(m);
    if (m.op === "undo") return { ok: true };
    n++;
    return n < 3 ? { ok: true, undoToken: `t${n}` } : { ok: false, reason: "not-applied" };
  });
  await w.probeInDoc();
  assert.equal(await w.docCite(h, 0), false);
  const edits = ops().filter((o) => o.op !== "ping");
  assert.deepEqual(edits.map((o) => o.op), ["replace", "appendLine", "appendLine", "undo"]);
  assert.equal(edits[0].find, S);
  assert.equal(edits[0].replacement, "The Great Wall is visible from space [1].", "the marker goes before the full stop");
  assert.equal(edits[1].line, "Sources:");
  assert.match(edits[2].line, /^1\. .+ — https:\/\/example\.com\/wall$/, "the entry keeps the ' — url' tail sourcesBlock parses");
  assert.deepEqual(edits[3].undoToken, ["t2", "t1"], "rolled back newest first");
  assert.equal(copied.length, 1, "then the citation is copied instead");
  assert.equal(w.sourcesMap.get(h).citedUrl, null, "not marked cited");
  assert.equal(w.state().lastDocEdit, null, "nothing to undo — it is already undone");
  assert.equal(w.editView(`cite:${h}:https://example.com/wall`, "Cite in doc").label, "Couldn't apply — copied instead");
});

test("content.js: a group whose rollback also fails says so, and points at ⌘Z", async () => {
  let n = 0;
  const { w, h } = citeSetup((m) => {
    if (m.op === "ping") return okPing(m);
    if (m.op === "undo") return { ok: false, reason: "not-found" };
    n++;
    return n < 2 ? { ok: true, undoToken: `t${n}` } : { ok: false, reason: "not-applied" };
  });
  await w.probeInDoc();
  await w.docCite(h, 0);
  assert.equal(w.state().statusKind, "error");
  assert.match(w.editView(`cite:${h}:https://example.com/wall`, "Cite in doc").note, /⌘Z \/ Ctrl\+Z/);
});

test("content.js: a cite that lands keeps its verdict on the marked sentence, and Undo takes all three back", async () => {
  let n = 0;
  const { w, ops, h } = citeSetup((m) => {
    if (m.op === "ping") return okPing(m);
    if (m.op === "undo") return { ok: true };
    return { ok: true, undoToken: `t${++n}` };
  });
  await w.probeInDoc();
  assert.equal(await w.docCite(h, 0), true);
  const newHash = w.hashText("The Great Wall is visible from space [1].");
  assert.ok(w.cache.has(newHash), "the marked sentence is not re-checked from scratch");
  assert.equal(w.sourcesMap.get(h).citedUrl, "https://example.com/wall");
  assert.match(w.state().statusMsg, /cited \[1\] in doc/);
  assert.deepEqual(plain(w.state().lastDocEdit.tokens), ["t3", "t2", "t1"]);
  await w.undoLastDocEdit();
  assert.deepEqual(ops().filter((o) => o.op === "undo").pop().undoToken, ["t3", "t2", "t1"]);
  assert.equal(w.sourcesMap.get(h).citedUrl, null);
});

test("content.js: an existing Sources entry is reused — only the marker is added", async () => {
  const { w, ops, S, h } = citeSetup((m) => (m.op === "ping" ? okPing(m) : { ok: true, undoToken: "t" }));
  const body = `${S} It is long.\nSources:\n1. Something else — https://other.example\n2. Wall — https://example.com/wall`;
  w.setDoc(body, [{ ...seg(S), hash: h }]);
  await w.probeInDoc();
  await w.docCite(h, 0);
  const edits = ops().filter((o) => o.op !== "ping");
  assert.deepEqual(edits.map((o) => o.op), ["replace"]);
  assert.equal(edits[0].replacement, "The Great Wall is visible from space [2].");
});

test("content.js: Add transition pastes the bridge ahead of the passage, and is dismissed only once it landed", async () => {
  const passage = "Rome fell in 476. Its fall reshaped Europe.";
  const { w, ops } = loadWiring({ respond: (m) => (m.op === "ping" ? okPing(m) : m.op === "replace" ? { ok: true, undoToken: "f1" } : { ok: true }), body: passage });
  await w.probeInDoc();
  assert.equal(await w.addTransition("flowX", { passage, transition: "  Meanwhile,   in the east. " }), true);
  const rep = ops().find((o) => o.op === "replace");
  assert.equal(rep.find, passage);
  assert.equal(rep.replacement, `Meanwhile, in the east. ${passage}`);
  assert.ok(w.flowDismissed.has("flowX"));
  assert.equal(w.state().flowSig, "", "structure changed: flow re-runs");
  await w.undoLastDocEdit();
  assert.equal(w.flowDismissed.has("flowX"), false);

  const refused = loadWiring({ respond: (m) => (m.op === "ping" ? okPing(m) : { ok: false, reason: "not-found" }), body: passage });
  await refused.w.probeInDoc();
  await refused.w.addTransition("flowY", { passage, transition: "Meanwhile." });
  assert.equal(refused.w.flowDismissed.has("flowY"), false);
  assert.deepEqual(refused.copied, ["Meanwhile."]);
});

test("content.js: with only the dev bridge, edits go to /api/docs/apply — no hint, no Undo", async () => {
  const S = "Einstein was a basketball player.";
  const { w, ops, apiCalls, ctx, copied } = loadWiring({ body: S });
  w.setBridge(true);
  const h = w.hashText(S);
  w.setDoc(S, [{ ...seg(S), hash: h }]);
  w.cache.set(h, { verdict: "false", revision: "Einstein was a physicist." });
  assert.equal(await w.docFix(h), true);
  assert.deepEqual(apiCalls[0], { path: "/api/docs/apply", body: { docId: "doc123", action: "replace", find: S, replacement: "Einstein was a physicist." } });
  assert.equal(ops().length, 0, "the hook was never asked");
  assert.equal(w.state().lastDocEdit, null, "the bridge can't take an edit back, so no Undo is offered");
  assert.ok(!/Undo/.test(w.editBtnHtml(`fix:${h}`, "Fix in doc", "")));

  const again = loadWiring({ body: S });
  again.w.setBridge(true);
  again.ctx.__apiFails = true;
  again.w.setDoc(S, [{ ...seg(S), hash: h }]);
  again.w.cache.set(h, { verdict: "false", revision: "Einstein was a physicist." });
  assert.equal(await again.w.docFix(h), false);
  assert.equal(again.w.editView(`fix:${h}`, "Fix in doc").note, "bridge said no");
  void ctx; void copied;
});

test("content.js: a repeated sentence carries which copy it is", () => {
  const S = "It is good.";
  const body = `${S} Then more. ${S}`;
  const { w } = loadWiring({ body });
  const second = body.lastIndexOf(S);
  assert.deepEqual(plain(w.segHint({ text: S, start: second, hash: "h" })), { occurrence: 1, occurrences: 2 });
  assert.deepEqual(plain(w.segHint({ text: S, start: 0, hash: "h" })), { occurrence: 0, occurrences: 2 });
});

test("content.js: one edit at a time — a second click while one is in flight does nothing", async () => {
  const S = "Einstein was a basketball player.";
  const T = "Rome fell in 476.";
  const body = `${S} ${T}`;
  const { w, ops } = loadWiring({ respond: (m) => (m.op === "ping" ? okPing(m) : { ok: true, undoToken: m.id }), body });
  await w.probeInDoc();
  const h1 = w.hashText(S), h2 = w.hashText(T);
  w.setDoc(body, [{ ...seg(S), hash: h1 }, { ...seg(T, S.length + 1), hash: h2 }]);
  w.cache.set(h1, { verdict: "false", revision: "Einstein was a physicist." });
  w.cache.set(h2, { verdict: "false", revision: "Rome fell in 476 AD." });
  const a = w.docFix(h1);
  const b = await w.docFix(h2);
  await a;
  assert.equal(b, false);
  assert.equal(ops().filter((o) => o.op === "replace").length, 1);
});

test("content.js: pings are the only thing that runs on a timer — edits happen only on a click", async () => {
  const { w, ops } = loadWiring({ respond: okPing });
  for (let i = 0; i < 3; i++) await w.probeInDoc();
  assert.deepEqual([...new Set(ops().map((o) => o.op))], ["ping"]);
  const src = read("content.js");
  const docs = src.slice(src.indexOf("function docsMode()"), src.indexOf("function fieldMode()"));
  const EDITS = /\b(docFix|docCite|addTransition|runDocEdit|docApply|undoLastDocEdit|citeUrlWidget)\(/;
  for (const m of docs.matchAll(/\bset(?:Interval|Timeout)\(/g)) {
    // The timer's callback: up to its matching close paren.
    let depth = 0, i = m.index + m[0].length - 1, end = i;
    for (; i < docs.length; i++) {
      if (docs[i] === "(") depth++;
      else if (docs[i] === ")" && --depth === 0) { end = i; break; }
    }
    const body = docs.slice(m.index, end + 1);
    assert.ok(!EDITS.test(body), `a timer can reach a document edit:\n${body.slice(0, 300)}`);
  }
  // Every caller of an edit is a click/keydown handler (or the pasted-URL
  // flow those start), never page load or a message from the page.
  const code = docs.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length)).replace(/\/\/.*$/gm, (c) => " ".repeat(c.length));
  for (const name of ["docFix", "docCite", "addTransition", "undoLastDocEdit", "citeUrlWidget"]) {
    const calls = [...code.matchAll(new RegExp(`(?<!function )\\b${name}\\(`, "g"))];
    assert.ok(calls.length > 0, name);
    for (const c of calls) {
      const before = code.slice(Math.max(0, c.index - 700), c.index);
      assert.ok(/addEventListener\("(click|keydown)"|popEditBtn\(|async function citeUrlWidget\(/.test(before),
        `${name}( is reachable from something other than a click:\n${before.slice(-200)}`);
    }
  }
});

/* ── the manifest ─────────────────────────────────────────────────────── */

test("manifest: 2.19.5, and fixing in the doc asks for no new permission", () => {
  const m = JSON.parse(read("manifest.json"));
  assert.equal(m.version, "2.19.5");
  assert.deepEqual(m.permissions, ["storage", "identity"], "no clipboardWrite, scripting, tabs or activeTab: the edit runs in the page's own editor");
  assert.deepEqual(m.host_permissions, [
    "http://localhost:4477/*",
    "https://api.jointracely.com/*",
    "https://sxifbtelrtbsgnnwnmdf.supabase.co/*",
  ]);
  assert.equal(m.optional_permissions, undefined);
  assert.equal(m.optional_host_permissions, undefined);
  const hook = m.content_scripts.find((c) => (c.js ?? []).includes("docs-hook.js"));
  assert.deepEqual(hook.js, ["docs-hook.js"], "the engine rides in the existing hook — no new injected script");
  assert.equal(m.content_scripts.length, 2);
  assert.ok(!JSON.stringify(m).includes("dev/"), "nothing under extension/dev/ is ever loaded");
});

test("pack-extension.sh leaves extension/dev/ out of every zip, and checks the zip itself", () => {
  const sh = readFileSync(path.join(HERE, "..", "scripts", "pack-extension.sh"), "utf8");
  const rsync = sh.split("\n").find((l) => l.startsWith("rsync "));
  assert.ok(rsync && rsync.includes("--exclude '/dev/'"), rsync);
  assert.match(sh, /HAS_DEV=\$\(unzip -Z1 "\$ZIP" \| grep -c "\^\$NAME\/dev\/"/);
  assert.match(sh, /if \[ "\$HAS_DEV" -gt 0 \]; then\s+rm -f "\$ZIP"/);
});

/* ── the dev drivers (never shipped, but committed to a public repo) ────── */

test("dev drivers that edit a real Doc prove the network is cut — canary, 0 upstream sockets, traffic proxied — before the first edit", () => {
  // [file, the first line that can put an edit event into the public Doc,
  //  where its public-Doc path starts (harness.mjs edits a Doc you own,
  //  TRACELY_EDIT_DOC_URL, without severing — that branch comes first)]
  for (const [file, firstEdit, from = ""] of [
    ["edit-trial.mjs", "const trialSrc = "],
    ["hook-trial.mjs", "window.__tracelyEditConfig.allowEdits = true"],
    ["harness.mjs", "window.__tracelyEditConfig.allowEdits = true", 'cur = "B-severed"'],
  ]) {
    const src = read(path.join("dev", "fix-in-doc", file));
    const edit = src.indexOf(firstEdit, Math.max(0, src.indexOf(from)));
    const cut = src.lastIndexOf("sever();", edit);
    assert.ok(cut > 0 && edit > cut, `${file}: sever() must come before the first edit`);
    const gate = src.slice(cut, edit);
    assert.match(gate, /"REACHED"|'REACHED'/, `${file}: a canary request to Google must be made and must fail`);
    assert.match(gate, /tunnels\.size === 0/, `${file}: no upstream socket may survive the cut`);
    assert.match(gate, /(?:tunnels|proxied) > 0/, `${file}: the page must have loaded through the proxy at all`);
    assert.match(gate, /throw new Error\(["']ABORT/, `${file}: a failed check aborts the run`);
  }
});
