/* The extension's Settings page (options.html), laid out like the desktop's
 * Settings, and one click from the widget. Owner, 2026-10-11, on a screenshot
 * of the old page — a column of cards, a bare checkbox, the server line on top:
 * "fix this page on the extension to look more like the rest of the app in
 * terms of UI and UX, and also make this easy to navigate to from the overlay
 * widget extension".
 *   - a sidebar of sections, one panel at a time, the section in the address.
 *     Since 2026-10-16 (owner: "revamp settings to include more that typical
 *     settings has"): General (on / paused / off, Google Docs, the sites, the
 *     button's corner, the shortcut), Checking, Account and billing (with
 *     what's been used), Privacy and data (export, clear), Help;
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

// Since 2026-10-16 (owner: "revamp settings"): Google Docs and Sites live in General, and Help is new.
const SECTIONS = ["general", "checking", "account", "privacy", "help"];

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
        appendChild() {}, append() {},
        click() { for (const fn of this.listeners.click ?? []) fn(); },
        ...extra,
      });
    }
    return els.get(id);
  };
  const panels = SECTIONS.map((s) => el(`sec-${s}`, { dataset: { panel: s } }));
  const navs = SECTIONS.map((s) => el(`nav-${s}`, { dataset: { nav: s } }));
  const sides = ["left", "right"].map((s) => el(`side-${s}`, { dataset: { side: s } }));
  const storageListeners = [];
  const sets = [];
  const copied = [];
  const location = { hash };
  const history = { replaceState: (_s, _t, url) => { location.hash = url; } };
  const chrome = {
    runtime: {
      sendMessage: async (m) => (m.type === "tracely-entitlement" ? { ok: true, configured: true, ...answer } : { ok: true }),
      getManifest: () => ({ version: "2.21.99" }),
    },
    storage: {
      local: { get: (d, cb) => cb?.({ ...d, ...stored }), set: (o) => { sets.push(plain(o)); Object.assign(stored, plain(o)); }, remove: (k) => { removed.push(k); } },
      onChanged: { addListener: (fn) => storageListeners.push(fn) },
    },
    commands: { getAll: (cb) => cb([{ name: "toggle-panel", shortcut: "Alt+Shift+K" }]) },
  };
  vm.runInContext(OPTIONS, vm.createContext({
    chrome, console, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, AbortSignal, encodeURIComponent, Date,
    fetch: async () => { throw new TypeError("offline"); },
    location, history, window: { addEventListener() {} },
    confirm: () => true,
    navigator: { userAgent: "test-browser", clipboard: { writeText: async (t) => { copied.push(t); } } },
    document: {
      getElementById: (id) => el(id),
      createElement: () => ({ textContent: "", className: "", append() {}, appendChild() {}, addEventListener() {} }),
      querySelectorAll: (sel) => (sel === "[data-panel]" ? panels : sel === "[data-nav]" ? navs : sel === "[data-side]" ? sides : []),
    },
  }), { filename: "options.js" });
  await tick(); await tick();
  const shown = () => panels.filter((p) => !p.hidden).map((p) => p.dataset.panel);
  const active = () => navs.filter((n) => n.classList.contains("active")).map((n) => [n.dataset.nav, n.getAttribute("aria-current")]);
  const change = (id, checked) => { const e = el(id); e.checked = checked; for (const fn of e.listeners.change ?? []) fn({ target: e }); };
  return {
    $: el, shown, active, location, removed: removed.filter((k) => k === "settingsOpenAt"), removedAll: removed, nav: (s) => navs[SECTIONS.indexOf(s)],
    storageChange: (c) => storageListeners.forEach((fn) => fn(c, "local")), sets, stored, copied, change, side: (s) => sides.find((b) => b.dataset.side === s),
  };
}

test("one section at a time: General first, a sidebar click moves it, and the address carries it", async () => {
  const p = await openPage({ signedIn: false, plan: "free" });
  assert.deepEqual(p.shown(), ["general"]);
  assert.deepEqual(p.active(), [["general", "page"]]);
  assert.equal(p.location.hash, "#general");
  p.nav("privacy").click();
  assert.deepEqual(p.shown(), ["privacy"]);
  assert.deepEqual(p.active(), [["privacy", "page"]], "one item marked, the one showing");
  assert.equal(p.location.hash, "#privacy");
  assert.equal(p.$("buildVersion").textContent, "Version 2.21.99");

  const back = await openPage({ signedIn: false, plan: "free" }, { hash: "#help" });
  assert.deepEqual(back.shown(), ["help"], "a reload comes back to its section");
  // A bookmark from before 2026-10-16: Google Docs and Sites are in General now.
  for (const old of ["#docs", "#sites"]) assert.deepEqual((await openPage({ signedIn: false, plan: "free" }, { hash: old })).shown(), ["general"], old);
  const junk = await openPage({ signedIn: false, plan: "free" }, { hash: "#nope" });
  assert.deepEqual(junk.shown(), ["general"]);
});

test("the widget's gear opens the page at its section — once, and only while the ask is fresh", async () => {
  const fresh = await openPage({ signedIn: false, plan: "free" }, { stored: { settingsOpenAt: { section: "help", at: Date.now() } } });
  assert.deepEqual(fresh.shown(), ["help"]);
  assert.deepEqual(fresh.removed, ["settingsOpenAt"], "taken once");
  const stale = await openPage({ signedIn: false, plan: "free" }, { stored: { settingsOpenAt: { section: "help", at: Date.now() - 5 * 60_000 } } });
  assert.deepEqual(stale.shown(), ["general"], "an old ask does not move a later visit");
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
    "<li>No daily check limit</li><li>250 source searches a month, up to 40 a day</li><li>Evidence recommendations</li>");

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
  assert.match(head, /<button class="hbtn" id="panelSettings" title="Settings" aria-label="Tracely settings"><svg[\s\S]*?<\/svg><\/button>\s*<button class="hbtn close" id="panelClose"/);
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

  assert.deepEqual(plain(await ask({ type: "tracely-openSettings", section: "help" })), { ok: true });
  assert.equal(opened, 1);
  assert.equal(data.settingsOpenAt.section, "help");
  assert.ok(Date.now() - data.settingsOpenAt.at < 5000);

  delete data.settingsOpenAt;
  assert.deepEqual(plain(await ask({ type: "tracely-openSettings", section: "../../evil" })), { ok: true });
  assert.equal(opened, 2);
  assert.equal(data.settingsOpenAt, undefined, "an unknown section is not stored");
  assert.deepEqual(plain(await ask({ type: "tracely-openSettings" })), { ok: true }, "the gear names none");
  assert.equal(opened, 3);
});

/* Owner, 2026-10-13, on the paper plane beside "Tracely" in the sidebar:
   "in settings right now this logo has not changed yet". The mark is the
   desktop's logo (src/renderer/src/assets/figma-logo.png, cut to 96px), the
   one the widget's launcher draws. */
test("the sidebar's brand is the Tracely mark, not the plane", () => {
  assert.match(HTML, /<span class="brand"><img class="brand-mark" src="icons\/mark\.png" alt="" width="24" height="24" draggable="false">Tracely<\/span>/);
  assert.doesNotMatch(HTML, /class="plane"/);
  const png = readFileSync(path.join(HERE, "..", "..", "extension", "icons", "mark.png"));
  assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 96], "sharp at 24px on a 2x screen");
});

/* ── General, Privacy and data, Help (owner, 2026-10-16: "yes to all, go
   ahead with phase 1") ─────────────────────────────────────────────────── */
const lastPrefs = (p) => p.sets.filter((o) => o.prefs).at(-1)?.prefs;

test("General: on, paused for an hour or for today, or off — saved where the widget reads it", async () => {
  const p = await openPage({ signedIn: false, plan: "free" });
  assert.equal(p.$("onTgl").checked, true);
  assert.equal(p.$("pauseLine").textContent, "Checking wherever you've turned it on.");
  assert.deepEqual([p.$("pauseHour").hidden, p.$("pauseToday").hidden, p.$("resumeNow").hidden], [false, false, true]);
  const t0 = Date.now();
  p.$("pauseHour").click();
  assert.ok(Math.abs(lastPrefs(p).pausedUntil - (t0 + 3_600_000)) < 2000, "an hour from now");
  assert.match(p.$("pauseLine").textContent, /^Paused until .+: nothing is checked or sent until then\.$/);
  assert.deepEqual([p.$("pauseHour").hidden, p.$("resumeNow").hidden], [true, false]);
  p.$("resumeNow").click();
  assert.equal(lastPrefs(p).pausedUntil, 0);
  p.$("pauseToday").click();
  const until = new Date(lastPrefs(p).pausedUntil);
  assert.deepEqual([until.getHours(), until.getMinutes(), until.getDate() !== new Date().getDate() || until > Date.now()], [0, 0, true], "midnight tonight");
  assert.equal(p.$("pauseLine").textContent, "Paused until midnight: nothing is checked or sent until then.");
  p.change("onTgl", false);
  assert.equal(lastPrefs(p).pausedUntil, -1, "off until turned back on");
  assert.equal(p.$("pauseLine").textContent, "Off: nothing is checked or sent until you turn it back on.");
  p.change("onTgl", true);
  assert.equal(lastPrefs(p).pausedUntil, 0);
  // Resumed from the widget's own card while this page is open.
  p.storageChange({ prefs: { newValue: { pausedUntil: -1 } } });
  assert.equal(p.$("onTgl").checked, false);
});

test("General: the button's corner, the panel on open, and the shortcut Chrome has set", async () => {
  const p = await openPage({ signedIn: false, plan: "free" }, { stored: { prefs: { launcherSide: "left" } } });
  assert.deepEqual([p.side("left").getAttribute("aria-pressed"), p.side("right").getAttribute("aria-pressed")], ["true", "false"]);
  p.side("right").click();
  assert.equal(lastPrefs(p).launcherSide, "right");
  assert.equal(p.side("right").getAttribute("aria-pressed"), "true");
  p.change("panelOpenTgl", true);
  assert.equal(lastPrefs(p).panelOpen, true);
  assert.equal(p.$("shortcutNow").textContent, "Alt+Shift+K");
  assert.equal(p.$("shortcutKey").textContent, "Alt+Shift+K", "and in Help's keys");
  // The defaults are the widget's own.
  const prefsOf = (src, re) => JSON.parse(src.match(re)[1].replace(/(\w+):/g, '"$1":'));
  assert.deepEqual(prefsOf(OPTIONS, /const PREF_DEFAULTS = (\{[^}]*\});/), prefsOf(SRC, /const PREF_DEFAULTS = (\{[^}]*\});/), "options.js and content.js: one set of names and defaults");
});

test("the shortcut is a manifest command that asks for no permission, and the worker hands it to the tab in front", async () => {
  const m = JSON.parse(read("manifest.json"));
  assert.deepEqual(m.commands, { "toggle-panel": { suggested_key: { default: "Alt+Shift+K" }, description: "Open or close the Tracely panel" } });
  assert.deepEqual(m.permissions, ["storage", "identity"]);
  let onCommand = null;
  const sent = [];
  const chrome = {
    runtime: { id: "x", getURL: (p) => `chrome-extension://x/${p}`, onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { async get(d) { return d; }, async set() {}, async remove() {} } },
    identity: {},
    commands: { onCommand: { addListener: (fn) => { onCommand = fn; } } },
    tabs: { query: (q, cb) => cb([{ id: 7 }]), sendMessage: async (id, msg) => { sent.push([id, msg]); } },
  };
  vm.runInContext(BG, vm.createContext({ chrome, fetch: async () => { throw new TypeError("offline"); }, console, URL, URLSearchParams, AbortSignal, crypto: globalThis.crypto, setInterval: () => 0, setTimeout, clearTimeout }), { filename: "background.js" });
  onCommand("toggle-panel");
  assert.deepEqual(plain(sent), [[7, { type: "tracely-toggle-panel" }]]);
});

test("Account and billing: a paid plan is told the subscription page holds receipts and cancelling", async () => {
  const pro = await openPage({ signedIn: true, email: "p@example.com", plan: "pro", limits: { checksPerDay: null, sources: { day: 40, month: 250 } }, usage: { sources: { today: 1, month: 9 } } });
  assert.match(pro.$("billingNote").textContent, /^Receipts, your payment method, changing plan and cancelling are all on the subscription page/);
  assert.equal(pro.$("usageTile").hidden, false);
  const free = await openPage({ signedIn: true, email: "f@example.com", plan: "free" });
  assert.equal(free.$("billingNote").textContent, "Plans are bought and cancelled on jointracely.com. Nothing on this page charges you.");
});

test("Privacy and data: export leaves the sign-in out, and Clear marks every page's saved checks to go", async () => {
  assert.match(OPTIONS, /const EXPORT_LEAVE_OUT = \["authToken", "refreshToken"\];/);
  const p = await openPage({ signedIn: false, plan: "free" });
  const t0 = Date.now();
  p.$("clearChecks").click();
  assert.ok(lastPrefs(p).clearedAt >= t0, "the mark content.js clears by");
  assert.ok(p.removedAll.includes("diag"), "and the edits' log with it");
  assert.match(p.$("dataStatus").textContent, /^Cleared\./);
});

test("Help: what's new, and diagnostics that carry the version, the settings and the last edits — never writing", async () => {
  const edits = [{ at: "2026-10-16T10:00:00.000Z", edit: "fix", action: "replace", via: "hook", ok: false, reason: "selection-mismatch", check: "copy" }];
  const p = await openPage({ signedIn: true, email: "m@example.com", plan: "pro" }, { stored: { docsEnabled: true, enabledSites: ["https://a.example"], diag: { edits }, prefs: { launcherSide: "left" } } });
  assert.match(p.$("whatsNew").innerHTML, /^<div class="change"><span class="change-v">2\.21\.62<\/span>/);
  p.$("copyDiag").click();
  await tick(); await tick();
  const d = JSON.parse(p.copied[0]);
  assert.deepEqual([d.version, d.plan, d.signedIn, d.docsEnabled, d.autoCheckSites, d.prefs.launcherSide, d.browser], ["2.21.99", "pro", true, true, 1, "left", "test-browser"]);
  assert.deepEqual(d.lastEdits, edits);
  assert.ok(!/@example|a\.example/.test(p.copied[0]), "no email address, no site names");
  assert.match(p.$("emailUs").href, /^mailto:hello@jointracely\.com\?subject=Tracely%20problem&body=/);
});
