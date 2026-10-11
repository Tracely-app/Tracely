/* The extension's Settings page (options.html), laid out like the desktop's
 * Settings, and one click from the widget. Owner, 2026-10-11, on a screenshot
 * of the old page — a column of cards, a bare checkbox, the server line on top:
 * "fix this page on the extension to look more like the rest of the app in
 * terms of UI and UX, and also make this easy to navigate to from the overlay
 * widget extension".
 *   - a sidebar of sections (Account, Checking, Google Docs, Sites, Privacy),
 *     one panel at a time, the section in the address;
 *   - the account as a "Signed in as …" row and a plan card whose list is the
 *     server's own limits;
 *   - a gear in the widget's header: the worker opens Settings (bringing an
 *     open tab forward), at the section asked for. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "..", "..", "extension");
const read = (f) => readFileSync(path.join(EXT, f), "utf8");
const HTML = read("options.html");
const OPTIONS = read("options.js");
const BG = read("background.js");
const SRC = read("content.js");
const tick = () => new Promise((r) => setTimeout(r, 0));
const plain = (v) => JSON.parse(JSON.stringify(v));

const SECTIONS = ["account", "checking", "docs", "sites", "privacy"];

test("one sidebar item and one panel per section, in the same order — and options.js and the worker name the same sections", () => {
  assert.deepEqual([...HTML.matchAll(/class="nav-item" data-nav="(\w+)"/g)].map((m) => m[1]), SECTIONS);
  assert.deepEqual([...HTML.matchAll(/data-panel="(\w+)"/g)].map((m) => m[1]), SECTIONS);
  for (const s of SECTIONS) assert.match(HTML, new RegExp(`data-nav="${s}" aria-controls="sec-${s}"`), s);
  const js = OPTIONS.match(/const SECTIONS = (\[[^\]]*\]);/);
  assert.deepEqual(JSON.parse(js[1]), SECTIONS);
  const bg = BG.match(/const SETTINGS_SECTIONS = new Set\((\[[^\]]*\])\);/);
  assert.deepEqual(JSON.parse(bg[1]), SECTIONS);
  // The desktop's pieces: the switch, the plan card's badge, the danger row.
  assert.match(HTML, /<input type="checkbox" class="switch" id="docsTgl" \/>/);
  assert.match(HTML, /<span class="badge">Current plan<\/span><span class="badge quiet" id="acctBeta" hidden>Beta<\/span>/);
  assert.match(HTML, /<button class="btn btn-danger" id="deleteAccount">/);
  assert.match(HTML, /<button class="btn btn-primary" id="signIn">[\s\S]*?Sign in with Google<\/button>/);
});

/* A page with the sidebar and panels, enough DOM for options.js to run. */
async function openPage(answer, { hash = "", stored = {} } = {}) {
  const els = new Map();
  const removed = [];
  const el = (id, extra = {}) => {
    if (!els.has(id)) {
      const attrs = {};
      const classes = new Set();
      els.set(id, {
        id, hidden: false, disabled: false, textContent: "", innerHTML: "", className: "", href: "", dataset: {},
        style: {}, listeners: {},
        classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
        setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, getAttribute: (k) => attrs[k] ?? null,
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
        click() { for (const fn of this.listeners.click ?? []) fn(); },
        ...extra,
      });
    }
    return els.get(id);
  };
  const panels = SECTIONS.map((s) => el(`sec-${s}`, { dataset: { panel: s } }));
  const navs = SECTIONS.map((s) => el(`nav-${s}`, { dataset: { nav: s } }));
  const storageListeners = [];
  const location = { hash };
  const history = { replaceState: (_s, _t, url) => { location.hash = url; } };
  const chrome = {
    runtime: {
      sendMessage: async (m) => (m.type === "tracely-entitlement" ? { ok: true, configured: true, ...answer } : { ok: true }),
      getManifest: () => ({ version: "2.21.99" }),
    },
    storage: {
      local: { get: (d, cb) => cb?.({ ...d, ...stored }), set() {}, remove: (k) => { removed.push(k); } },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
  };
  vm.runInContext(OPTIONS, vm.createContext({
    chrome, console, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, AbortSignal, encodeURIComponent, Date,
    fetch: async () => { throw new TypeError("offline"); },
    location, history, window: { addEventListener() {} },
    document: {
      getElementById: (id) => el(id),
      querySelectorAll: (sel) => (sel === "[data-panel]" ? panels : sel === "[data-nav]" ? navs : []),
    },
  }), { filename: "options.js" });
  await tick(); await tick();
  const shown = () => panels.filter((p) => !p.hidden).map((p) => p.dataset.panel);
  const active = () => navs.filter((n) => n.classList.contains("active")).map((n) => [n.dataset.nav, n.getAttribute("aria-current")]);
  return { $: el, shown, active, location, removed: removed.filter((k) => k === "settingsOpenAt"), nav: (s) => navs[SECTIONS.indexOf(s)], storageChange: (c) => storageListeners.forEach((fn) => fn(c, "local")) };
}

test("one section at a time: Account first, a sidebar click moves it, and the address carries it", async () => {
  const p = await openPage({ signedIn: false, plan: "free" });
  assert.deepEqual(p.shown(), ["account"]);
  assert.deepEqual(p.active(), [["account", "page"]]);
  assert.equal(p.location.hash, "#account");
  p.nav("sites").click();
  assert.deepEqual(p.shown(), ["sites"]);
  assert.deepEqual(p.active(), [["sites", "page"]], "one item marked, the one showing");
  assert.equal(p.location.hash, "#sites");
  assert.equal(p.$("buildVersion").textContent, "Version 2.21.99");

  const back = await openPage({ signedIn: false, plan: "free" }, { hash: "#docs" });
  assert.deepEqual(back.shown(), ["docs"], "a reload comes back to its section");
  const junk = await openPage({ signedIn: false, plan: "free" }, { hash: "#nope" });
  assert.deepEqual(junk.shown(), ["account"]);
});

test("the widget's gear opens the page at its section — once, and only while the ask is fresh", async () => {
  const fresh = await openPage({ signedIn: false, plan: "free" }, { stored: { settingsOpenAt: { section: "sites", at: Date.now() } } });
  assert.deepEqual(fresh.shown(), ["sites"]);
  assert.deepEqual(fresh.removed, ["settingsOpenAt"], "taken once");
  const stale = await openPage({ signedIn: false, plan: "free" }, { stored: { settingsOpenAt: { section: "sites", at: Date.now() - 5 * 60_000 } } });
  assert.deepEqual(stale.shown(), ["account"], "an old ask does not move a later visit");
  assert.deepEqual(stale.removed, ["settingsOpenAt"]);
  // Already open in a tab: the ask arrives as a storage change.
  fresh.storageChange({ settingsOpenAt: { newValue: { section: "privacy", at: Date.now() } } });
  assert.deepEqual(fresh.shown(), ["privacy"]);
});

test("the plan card: the plan's name in every state, one link, and the list is the server's own limits", async () => {
  const LIMITS = { checksPerDay: 400, aiActionsPerDay: 150, flowPerDay: 40, sources: { day: 5, month: 40 } };
  const out = await openPage({ signedIn: false, plan: "free", limits: LIMITS, usage: { sources: { today: 1, month: 3 } } });
  assert.equal(out.$("acctPlan").textContent, "Free");
  assert.equal(out.$("seePlans").hidden, false);
  assert.equal(out.$("manageLink").hidden, true);
  assert.equal(out.$("deleteRow").hidden, true, "nothing to delete signed out");
  assert.equal(out.$("planIncludes").hidden, false);
  assert.equal(out.$("planIncludes").innerHTML, "<li>400 checks a day</li><li>40 source searches a month, up to 5 a day</li>");

  const free = await openPage({ signedIn: true, email: "maya@example.com", userId: "u-9", plan: "free", limits: LIMITS });
  assert.equal(free.$("acctAvatar").textContent, "M");
  assert.equal(free.$("acctEmail").textContent, "maya@example.com");
  assert.equal(free.$("seePlans").hidden, true, "signed in, the card's one link is the account's own");
  assert.equal(free.$("manageLink").hidden, false);
  assert.equal(free.$("manageLink").className, "btn btn-primary");
  assert.equal(free.$("manageLink").textContent, "Upgrade");
  assert.equal(free.$("deleteRow").hidden, false);

  const pro = await openPage({ signedIn: true, email: "p@example.com", plan: "pro", limits: { checksPerDay: null, sources: { day: 40, month: 250 } } });
  assert.equal(pro.$("acctPlan").textContent, "Pro");
  assert.equal(pro.$("manageLink").className, "btn");
  assert.equal(pro.$("planIncludes").innerHTML,
    "<li>No daily check limit</li><li>250 source searches a month, up to 40 a day</li><li>Thorough explanations from our largest model</li>");

  const local = await openPage({ signedIn: false, plan: "free", unenforced: true, limits: LIMITS });
  assert.equal(local.$("planIncludes").hidden, true, "a server that meters nothing is not made to look as if it does");
});

test("the widget's header has a Settings gear, and it asks the worker", () => {
  const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = {};
    function hashText(s) { return "h" + s.length; }
    ${sliceBetween(SRC, "  const MARK_COLORS =", "\n")}
    ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
    ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
    ({ panelHeadHtml })`, vm.createContext({}));
  const head = X.panelHeadHtml({}, "checking 3…", false);
  assert.match(head, /<button class="hbtn" id="panelSettings" title="Settings" aria-label="Tracely settings"><svg[\s\S]*?<\/svg><\/button>\s*<button class="close" id="panelClose"/);
  assert.match(SRC, /shadow\.getElementById\("panelSettings"\)\?\.addEventListener\("click", \(\) => openSettings\(\)\);/);
  assert.match(SRC, /function openSettings\(section\) \{\n\s+return Promise\.resolve\(sendMsg\(\{ type: "tracely-openSettings", section: section \?\? null \}\)\)\.catch\(\(\) => null\);/);
  assert.match(SRC, /\.hbtn:focus-visible/, "the ink focus ring");
});

test("the worker opens Settings — an open tab comes forward — with a known section, or none", async () => {
  const data = {};
  let opened = 0;
  const listeners = [];
  const chrome = {
    runtime: { id: "x", getURL: (p) => `chrome-extension://x/${p}`, onMessage: { addListener: (fn) => listeners.push(fn) }, onInstalled: { addListener() {} }, openOptionsPage: async () => { opened++; } },
    storage: { local: { async get(d) { return { ...d, ...data }; }, async set(o) { Object.assign(data, o); }, async remove(k) { delete data[k]; } } },
    identity: {}, tabs: { async create() {} },
  };
  vm.runInContext(BG, vm.createContext({ chrome, fetch: async () => { throw new TypeError("offline"); }, console, URL, URLSearchParams, AbortSignal, crypto: globalThis.crypto, setInterval: () => 0, setTimeout, clearTimeout }), { filename: "background.js" });
  const ask = (msg) => new Promise((resolve) => { for (const fn of listeners) fn(msg, { id: "x", url: "https://docs.google.com/document/d/1/edit" }, resolve); });

  assert.deepEqual(plain(await ask({ type: "tracely-openSettings", section: "sites" })), { ok: true });
  assert.equal(opened, 1);
  assert.equal(data.settingsOpenAt.section, "sites");
  assert.ok(Date.now() - data.settingsOpenAt.at < 5000);

  delete data.settingsOpenAt;
  assert.deepEqual(plain(await ask({ type: "tracely-openSettings", section: "../../evil" })), { ok: true });
  assert.equal(opened, 2);
  assert.equal(data.settingsOpenAt, undefined, "an unknown section is not stored");
  assert.deepEqual(plain(await ask({ type: "tracely-openSettings" })), { ok: true }, "the gear names none");
  assert.equal(opened, 3);
});
