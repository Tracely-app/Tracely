/* What Settings sets, as the widget reads it (content.js "Settings → the
 * widget"; options.js writes chrome.storage "prefs"). Owner, 2026-10-16:
 * "revamp settings to include more that typical settings has", then "yes to
 * all, go ahead with phase 1":
 *   - Pause for an hour, for today, or Off: nothing is read, sent or drawn,
 *     the launcher says so, and the checking comes back when a pause ends;
 *   - the launcher's corner, the panel open on a new Doc, a keyboard shortcut;
 *   - "Clear saved checks", which every page applies when it next looks;
 *   - a log of what the last edits answered, for Help → Copy diagnostics. */
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

function load({ ls = {} } = {}) {
  const log = { sets: [], timers: [], onMessage: null, storageCb: null, changed: null };
  const store = { ...ls };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; },
  };
  const ctx = vm.createContext({
    log, localStorage, Date,
    setTimeout: (fn, ms) => { log.timers.push(ms); return log.timers.length; }, clearTimeout() {},
    storageGet: (d, cb) => { log.storageCb = cb; },
    storageSet: (o) => log.sets.push(plain(o)),
    storageOnChanged: (fn) => { log.changed = fn; },
    extCall: (fn, fallback) => { try { return fn(); } catch { return fallback; } },
    chrome: { runtime: { onMessage: { addListener: (fn) => { log.onMessage = fn; } } } },
  });
  // Object.keys(localStorage) is what the clear walks: the keys, not the methods.
  vm.runInContext(`Object.keys = ((keys) => (o) => (o === localStorage ? Object.getOwnPropertyNames(${"store"}) : keys(o)))(Object.keys);`, Object.assign(ctx, { store }));
  const X = vm.runInContext(`${sliceBetween(SRC, "  /* ── Settings → the widget", '  /* ── "Explain in depth" (2.20.0)')}
    ({ notePrefs, prefs: () => prefs, prefsListeners, tracelyPaused, pausedLine, resumeTracely, placeRoot, clearTracelyStore, panelTogglers, noteDiag, PREF_DEFAULTS })`, ctx);
  return { X, log, store };
}

test("on, paused or off: a pause stops everything until its time, and comes back by itself", () => {
  const { X, log } = load();
  let heard = 0;
  X.prefsListeners.add(() => heard++);
  log.storageCb({ prefs: {} });
  assert.equal(X.tracelyPaused(), false, "running by default");
  assert.equal(heard, 1, "each mode hears the first answer");
  const later = Date.now() + 60 * 60 * 1000;
  log.changed({ prefs: { newValue: { pausedUntil: later } } }, "local");
  assert.equal(X.tracelyPaused(), true);
  assert.ok(Math.abs(log.timers.at(-1) - 60 * 60 * 1000) < 1000, "a wake-up when the pause ends");
  assert.match(X.pausedLine(), /^Tracely is paused until .+\.$/);
  const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
  X.notePrefs({ pausedUntil: midnight.getTime() });
  assert.equal(X.pausedLine(), "Tracely is paused until midnight.");
  X.notePrefs({ pausedUntil: Date.now() - 1 });
  assert.equal(X.tracelyPaused(), false, "a pause that ended runs");
  X.notePrefs({ pausedUntil: -1 });
  assert.equal(X.tracelyPaused(), true);
  assert.equal(X.pausedLine(), "Tracely is off until you turn it back on.");
  X.resumeTracely();
  assert.equal(log.sets.at(-1).prefs.pausedUntil, 0, "Resume writes where Settings reads");
  log.changed({ other: { newValue: 1 } }, "local");
  assert.equal(heard, 5, "only a change to prefs is heard");
});

test("the launcher's corner is a class on the widget's root", () => {
  const { X } = load();
  const classes = new Set();
  const root = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  X.notePrefs({ launcherSide: "left" });
  X.placeRoot(root);
  assert.ok(classes.has("left"));
  X.notePrefs({ launcherSide: "right" });
  X.placeRoot(root);
  assert.ok(!classes.has("left"));
  assert.match(SRC, /\.root\.left \{ right: auto; left: 22px; \}/);
  assert.match(SRC, /\.root\.left \.panel \{ right: auto; left: 0; \}/);
});

test("Clear saved checks: a page drops its saved checks, sources, dismissals and reviews once — never its settings", () => {
  const ls = {
    "tracely.widget.vcache3.doc1": "[]", "tracely.widget.scache.doc1": "[]", "tracely.widget.dismissed.doc1": "[]", "tracely.widget.rcache3.doc1": "{}",
    "tracely.widget.settings": '{"citationStyle":"apa"}', "tracely.widget.panelPos": '{"x":1}', "site.own.key": "kept",
  };
  const { X, store } = load({ ls });
  X.notePrefs({ clearedAt: 0 });
  assert.equal(X.clearTracelyStore(), false, "nothing asked");
  X.notePrefs({ clearedAt: 1000 });
  assert.equal(X.clearTracelyStore(), true);
  assert.deepEqual(Object.keys(store).sort(), ["site.own.key", "tracely.clearedAt", "tracely.widget.panelPos", "tracely.widget.settings"]);
  assert.equal(X.clearTracelyStore(), false, "the same clear is not done twice");
  X.notePrefs({ clearedAt: 2000 });
  store["tracely.widget.vcache3.doc2"] = "[]";
  assert.equal(X.clearTracelyStore(), true, "a newer one is");
  assert.ok(!("tracely.widget.vcache3.doc2" in store));
});

test("the keyboard shortcut reaches every mode's panel; nothing else does", () => {
  const { X, log } = load();
  let toggled = 0;
  X.panelTogglers.add(() => toggled++);
  log.onMessage({ type: "tracely-toggle-panel" });
  log.onMessage({ type: "something-else" });
  assert.equal(toggled, 1);
});

test("the edits' log keeps the last 20, and only what the hook answered", () => {
  const { X, log } = load();
  for (let i = 0; i < 25; i++) X.noteDiag({ edit: "fix", action: "replace", via: "hook", ok: i % 2 === 0, ...(i % 2 ? { reason: "selection-mismatch", check: "copy" } : {}) });
  const edits = log.sets.at(-1).diag.edits;
  assert.equal(edits.length, 20);
  assert.deepEqual(Object.keys(edits.at(-1)).sort(), ["action", "at", "edit", "ok", "via"]);
  assert.deepEqual(Object.keys(edits.at(-2)).sort(), ["action", "at", "check", "edit", "ok", "reason", "via"]);
  assert.match(SRC, /if \(typeof noteDiag === "function"\) noteDiag\(\{ edit: key\.split\(":"\)\[0\], action: payload\.action, via: r\.via \?\? path, ok: Boolean\(r\.ok\)/, "each step of an in-doc edit is logged — no document text");
});

test("paused: the launcher says so, and opened, one card with Resume (or Turn on) and Settings", () => {
  const X = vm.runInContext(`
    let prefs = { pausedUntil: -1 };
    const pausedLine = () => prefs.pausedUntil === -1 ? "Tracely is off until you turn it back on." : "Tracely is paused until 4:30 PM.";
    const resumeTracely = () => { log.push("resume"); }, openSettings = (s) => { log.push("settings:" + s); };
    const MARK_SOLID_SVG = "<svg/>", PILL_MARK = "<img/>";
    const esc = (s) => String(s);
    const log = [];
    ${sliceBetween(SRC, "  function pausedHtml(open) {", "  /* ── the app's design tokens")}
    ({ pausedHtml, pausedWire, log, set: (p) => { prefs = p; } })`, vm.createContext({}));
  assert.match(X.pausedHtml(false), /^\s*<div class="pill quiet" id="pill" title="Tracely is off until you turn it back on\."><img\/>Tracely is off<\/div>$/);
  const off = X.pausedHtml(true);
  assert.match(off, /<span class="ctitle">Tracely is off<\/span>/);
  assert.match(off, /<button class="act primary" id="tracelyResume">Turn on<\/button><button class="act" id="tracelyPausedSettings">Settings<\/button>/);
  X.set({ pausedUntil: Date.now() + 1000 });
  assert.match(X.pausedHtml(true), /Tracely is paused<\/span>[\s\S]*Tracely is paused until 4:30 PM\. Nothing is checked or sent until then\.[\s\S]*id="tracelyResume">Resume now</);
  assert.match(X.pausedHtml(false), />Paused<\/div>$/);
  const btns = {};
  X.pausedWire({ getElementById: (id) => (btns[id] ??= { addEventListener: (_t, fn) => { btns[id].fn = fn; } }) }, () => X.log.push("toggle"));
  btns.tracelyResume.fn(); btns.tracelyPausedSettings.fn(); btns.pill.fn();
  assert.deepEqual(plain(X.log), ["resume", "settings:general", "toggle"]);
});

test("wired in both modes: paused, nothing is read, sent or drawn, and the launcher says so", () => {
  const docs = SRC.slice(SRC.indexOf("  function docsMode()"), SRC.indexOf("  function fieldMode()"));
  const field = SRC.slice(SRC.indexOf("  function fieldMode()"));
  assert.match(docs, /if \(!docsOn \|\| tracelyPaused\(\)\) return; \/\/ nothing leaves the page/, "Docs: no export read, no check");
  assert.match(docs, /if \(!docsOn \|\| tracelyPaused\(\)\) \{ if \(docsBars\.length\) clearDocsMarks\(\); return; \}/, "Docs: no underline");
  assert.match(docs, /if \(tracelyPaused\(\)\) \{ root\.innerHTML = pausedHtml\(expanded\); pausedWire\(shadow, \(\) => \{ expanded = !expanded; render\(\); \}\); return; \}/);
  assert.match(docs, /if \(tracelyPaused\(\)\) \{ hideDocsPopover\(\); clearDocsMarks\(\); \}/, "a pause takes the open card and the underlines at once");
  assert.match(docs, /if \(!prefsSeen\) \{ prefsSeen = true; if \(prefs\.panelOpen && docsOn && !tracelyPaused\(\)\) expanded = true; \}/, "the panel open on a new Doc, once");
  assert.match(field, /async function cycle\(\) \{\n\s+if \(orphaned \|\| inflight \|\| document\.hidden \|\| tracelyPaused\(\)\) return;/, "field: nothing read or sent");
  assert.match(field, /function drawMarks\(\) \{\n\s+if \(orphaned \|\| tracelyPaused\(\)\) \{ if \(overlayEl\) overlayEl\.textContent = ""; markRects\.clear\(\); markParts\.clear\(\); return; \}/, "field: no underline");
  assert.match(field, /if \(tracelyPaused\(\)\) \{ \/\/ paused from Settings[\s\S]{0,200}root\.innerHTML = pausedHtml\(expanded\);/);
  // The first answer was read through a name Docs mode never declared (`widget`), so turning Docs on waited a tick.
  assert.doesNotMatch(docs, /if \(widget\) render\(\);/);
});
