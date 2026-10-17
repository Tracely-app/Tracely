/* The widget's dark theme (Settings → General → Appearance: light, dark or
 * match the system; owner, 2026-10-16, "yes to all, go ahead with phase 1",
 * on a plan with "Appearance: light, dark or match the system"). Light by
 * default. Dark: the panel (WIDGET_CSS's tokens under :host(.tracely-dark))
 * and the cards Tracely puts in the page (Docs mode's DM palette). The
 * finding colours, the brand orange and the launcher never change, and what
 * is drawn on the document's own text (the cursor, the Type preview) stays
 * as the page is: light. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const OPTIONS_HTML = readFileSync(path.join(HERE, "..", "..", "extension", "options.html"), "utf8");

function load() {
  const host = { classes: new Set() };
  host.classList = { toggle: (c, on) => (on ? host.classes.add(c) : host.classes.delete(c)), add: (c) => host.classes.add(c) };
  const query = { matches: false, listeners: [], addEventListener(_t, fn) { this.listeners.push(fn); } };
  const heard = [];
  const ctx = vm.createContext({
    query, heard, Date, setTimeout: () => 0, clearTimeout() {},
    window: { matchMedia: () => query }, document: { getElementById: (id) => (id === "tracely-host" ? host : null) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    storageGet() {}, storageSet() {}, storageOnChanged() {},
    extCall: (fn, fallback) => { try { return fn(); } catch { return fallback; } },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    ignoreKey: (t) => String(t ?? ""),
  });
  const X = vm.runInContext(`${sliceBetween(SRC, "  /* ── Settings → the widget", '  /* ── "Explain in depth" (2.20.0)')}
    themeListeners.add((dark) => heard.push(dark));
    ({ notePrefs, themeDark })`, ctx);
  return { X, host, query, heard };
}

test("light by default; dark when chosen; the system's choice when asked, as it changes — each change heard once", () => {
  const { X, host, query, heard } = load();
  X.notePrefs({});
  assert.equal(X.themeDark(), false);
  assert.equal(host.classes.has("tracely-dark"), false);
  X.notePrefs({ appearance: "dark" });
  assert.equal(host.classes.has("tracely-dark"), true);
  X.notePrefs({ appearance: "dark", panelOpen: true });
  assert.deepEqual(heard, [true], "a change to another setting is not a change of theme");
  X.notePrefs({ appearance: "system" });
  assert.equal(host.classes.has("tracely-dark"), false, "the system says light");
  query.matches = true;
  for (const fn of query.listeners) fn();
  assert.equal(host.classes.has("tracely-dark"), true, "the system turned dark, and the widget with it");
  X.notePrefs({ appearance: "light" });
  assert.equal(host.classes.has("tracely-dark"), false, "light stays light, whatever the system says");
  assert.deepEqual(heard, [true, false, true, false]);
  assert.match(SRC, /if \(themeDark\(\)\) host\.classList\.add\("tracely-dark"\);/, "a widget made after the answer starts in the theme");
});

// The stylesheet as the page gets it (as makeWidget does), from content.js itself.
const CSS = vm.runInContext(`
  const MARK_COLORS = { false: "#d93636", questionable: "#2563eb", incoherent: "#d93636", needs_citation: "#ffb800", wrong_source: "#ffb800", cite_tip: "#ffb800", note_tip: "#2563eb" };
  const FEATURES = { citeHintsToggle: false, autoSources: false, deepDive: false };
  ${sliceBetween(SRC, "  const TALLY = [", "  const verdictCat =")}
  ${sliceBetween(SRC, "  const APP = {", "  function makeWidget()")}
  WIDGET_CSS`, vm.createContext({}));

test("the panel: every neutral is a token with a dark value; only the finding colours, the brand and the launcher's own are fixed", () => {
  const light = CSS.slice(CSS.indexOf(":host {"), CSS.indexOf("}", CSS.indexOf(":host {")));
  const darkStart = CSS.indexOf(":host(.tracely-dark) {");
  const dark = CSS.slice(darkStart, CSS.indexOf("}", darkStart));
  const tokens = [...light.matchAll(/(--w-[a-z-]+):/g)].map((m) => m[1]);
  assert.ok(tokens.length >= 20);
  for (const t of tokens.filter((t) => t !== "--w-launcher")) assert.match(dark, new RegExp(`${t}:`), `${t} has a dark value`);
  assert.doesNotMatch(dark, /--w-launcher:/, "the launcher sits on the page, which stays light");
  assert.match(dark, /color-scheme: dark;/, "the list's scrollbar too");
  for (const t of ["--surface", "--text", "--ink", "--border", "--chip-wash"]) assert.match(dark, new RegExp(`${t}:`), t);
  // Outside the two token blocks, no neutral is written as a colour.
  const rest = CSS.slice(CSS.indexOf("}", darkStart));
  const fixed = new Set(["#fff", "#ff5900", "#9a9ba1", "#d93636", "#ffb800", "#7344f1", "#2563eb"]);
  const stray = [...new Set(rest.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])].filter((c) => !fixed.has(c.toLowerCase()));
  assert.deepEqual(stray, [], "every other colour is a token");
  assert.match(CSS, /\.launcher \{[^}]*background: var\(--w-launcher\);/);
  assert.match(CSS, /\.panel \{[^}]*border: 1px solid var\(--w-frame\);/);
  assert.match(CSS, /button\.act\.primary \{ background: var\(--w-primary\); border-color: var\(--w-primary\); color: var\(--w-on-primary\); \}/);
});

test("the cards in the page: the dark palette changes the neutrals only; the cursor and the Type preview keep the page's ink", () => {
  const P = vm.runInContext(`${sliceBetween(SRC, "    const DM = { // index.css .docmark-*", "    /* The app's copy")} ({ DM, DM_LIGHT, DM_DARK, DOC_INK })`, vm.createContext({}));
  assert.deepEqual(Object.keys(P.DM_DARK).sort(), Object.keys(P.DM_LIGHT).sort(), "one set of names");
  for (const k of ["red", "amber", "orange", "badge"]) assert.equal(P.DM_DARK[k], P.DM_LIGHT[k], `${k}: a finding's colour, or the brand's`);
  for (const k of ["ink", "surface", "onInk", "body", "frame"]) assert.notEqual(P.DM_DARK[k], P.DM_LIGHT[k], k);
  assert.equal(P.DM.ink, P.DM_LIGHT.ink, "light until Settings says otherwise");
  assert.equal(P.DOC_INK, "#1c1c1c");
  assert.match(SRC, /themeListeners\.add\(\(dark\) => \{ Object\.assign\(DM, dark \? DM_DARK : DM_LIGHT\); hideDocsPopover\(\{ instant: true \}\); \}\);/, "a change redraws an open card in the new palette");
  assert.match(SRC, /path\.setAttribute\("fill", DOC_INK\); path\.setAttribute\("stroke", "#fff"\);/, "the cursor");
  assert.match(SRC, /background: "#fff", border: `1\.5px dashed \$\{DOC_INK\}`,/, "the Type preview's card");
  assert.match(SRC, /ctx\.fillStyle = s\.ins \? DOC_INK : "#000";/, "the Type preview's words");
  assert.match(SRC, /background: primary \? DM\.ink : DM\.surface, border: `1px solid \$\{primary \? DM\.ink : DM\.ctl\}`,\n\s+color: primary \? DM\.onInk : DM\.ink,/, "the card's buttons");
  assert.match(SRC, /path\.setAttribute\("fill", DM\.surface\); path\.setAttribute\("stroke", DM\.frame\);/, "the card's pointer, its own fill and edge");
});

test("Settings: Appearance is Light, Dark or Match system, in General", () => {
  assert.match(OPTIONS_HTML, /<button class="seg-btn" data-appearance="light" aria-pressed="true">Light<\/button>\s*<button class="seg-btn" data-appearance="dark" aria-pressed="false">Dark<\/button>\s*<button class="seg-btn" data-appearance="system" aria-pressed="false">Match system<\/button>/);
  assert.match(SRC, /undismissedAt: 0, appearance: "light",/, "light by default");
});
