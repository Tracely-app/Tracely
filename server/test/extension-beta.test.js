/**
 * The extension half of the test build's Pro grant, and the two extension
 * bugs fixed alongside it. The extension has no test runner of its own and no
 * build step, so these load its real source into a vm context with a stubbed
 * chrome.* and drive the functions that decide what reaches the server.
 *
 * What is pinned:
 *   - X-Tracely-Beta is sent only when beta.json is packaged AND Chrome says
 *     the copy was loaded unpacked. The manifest `key` gives the unpacked build
 *     the Web Store build's id, so installType is the only thing that tells
 *     them apart.
 *   - Signed out, the worker still reports free UNLESS the server said
 *     `beta: true`; signed in, it keeps userId (it used to drop it).
 *   - content.js's storage wrappers call chrome.storage, not themselves, and
 *     still latch on a genuinely dead context.
 *   - The options-page slider is the widgets' default stop, capped by plan.
 *   - The options page shows a beta tester their plan and nothing to buy,
 *     but keeps the way to manage a real subscription.
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

const EXT_ID = "dffmoeebkkghhgcklkbmaibfhgiegmdm";
const LOCAL = "http://localhost:4477";
const plain = (v) => JSON.parse(JSON.stringify(v)); // strip the vm realm's prototypes
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ── background.js in a stubbed worker ─────────────────────────────────── */

function loadWorker({
  installType = "development",
  betaFile = { token: "tok-123" }, // null = file absent
  getSelfThrows = false,
  noManagement = false,
  entitlement = { plan: "free", email: null, userId: null, enforced: true },
  store = {},
  down = false,             // every server fetch throws (offline / server gone)
  entitlementStatus = 200,  // what GET /api/entitlement answers
  rejectBearer = false,     // a bearer token draws a 401 (expired session)
} = {}) {
  const calls = [];
  const net = { down, entitlementStatus, entitlement };
  const opened = []; // chrome.tabs.create calls
  const data = { ...store };
  const messageListeners = [];
  const chrome = {
    runtime: {
      id: EXT_ID,
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onInstalled: { addListener: () => {} },
    },
    storage: {
      local: {
        async get(defaults) {
          if (typeof defaults === "string") return { [defaults]: data[defaults] };
          const out = {};
          for (const [k, v] of Object.entries(defaults)) out[k] = k in data ? data[k] : v;
          return out;
        },
        async set(obj) { Object.assign(data, obj); },
        async remove(k) { delete data[k]; },
      },
    },
    identity: {},
    tabs: { async create(o) { opened.push(o); return { id: 1 }; } },
  };
  if (!noManagement) {
    chrome.management = {
      async getSelf() {
        if (getSelfThrows) throw new Error("management unavailable");
        return { id: EXT_ID, installType };
      },
    };
  }
  async function fetch(url, init) {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("chrome-extension://")) {
      if (!betaFile) throw new TypeError("Failed to fetch"); // ERR_FILE_NOT_FOUND
      return { ok: true, status: 200, json: async () => betaFile };
    }
    if (net.down) throw new TypeError("Failed to fetch");
    const { pathname } = new URL(url);
    if (pathname === "/api/entitlement") {
      if (rejectBearer && init?.headers?.Authorization) return { ok: false, status: 401, json: async () => ({}) };
      const st = net.entitlementStatus;
      return { ok: st >= 200 && st < 300, status: st, json: async () => net.entitlement };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }
  const ctx = vm.createContext({
    chrome, fetch, console, URL, URLSearchParams, AbortSignal, crypto: globalThis.crypto,
    setInterval: () => 0, setTimeout, clearTimeout,
  });
  vm.runInContext(read("background.js"), ctx, { filename: "background.js" });
  const run = (expr) => vm.runInContext(expr, ctx);
  // The default sender is the options page; pass a content script's to see
  // what a host page's widget is told.
  const OPTIONS_PAGE = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/options.html` };
  function ask(msg, sender = OPTIONS_PAGE) {
    return new Promise((resolve) => {
      for (const fn of messageListeners) fn(msg, sender, resolve);
    });
  }
  return { run, calls, data, ask, net, opened };
}

const entitlementCalls = (w) => w.calls.filter((c) => c.url === `${LOCAL}/api/entitlement`);
const betaHeader = (init) => init?.headers?.["X-Tracely-Beta"];

test("betaToken: beta.json + Load unpacked sends the token", async () => {
  const w = loadWorker({ installType: "development", betaFile: { token: "tok-123" } });
  assert.equal(await w.run("betaToken()"), "tok-123");
});

test("betaToken: a Web Store install never sends it, even with the file", async () => {
  const w = loadWorker({ installType: "normal", betaFile: { token: "tok-123" } });
  assert.equal(await w.run("betaToken()"), "");
  // It never even looked for the file.
  assert.ok(!w.calls.some((c) => c.url.startsWith("chrome-extension://")));
});

test("betaToken: an unpacked build without beta.json sends nothing", async () => {
  const w = loadWorker({ installType: "development", betaFile: null });
  assert.equal(await w.run("betaToken()"), "");
});

test("betaToken: a throwing or missing management API means no beta, never a throw", async () => {
  assert.equal(await loadWorker({ getSelfThrows: true }).run("betaToken()"), "");
  assert.equal(await loadWorker({ noManagement: true }).run("betaToken()"), "");
});

test("betaToken: a token that is not a legal header value is dropped, not sent", async () => {
  // fetch() throws on an illegal header value, and the relay reads a throw as
  // "the server died" — a bad token must cost the beta, not every check.
  for (const token of ["", "  ", "two words", "line\nbreak", "caf\u00e9", 42, null]) {
    assert.equal(await loadWorker({ betaFile: { token } }).run("betaToken()"), "", JSON.stringify(token));
  }
  assert.equal(await loadWorker({ betaFile: { token: "  padded  " } }).run("betaToken()"), "padded");
});

test("betaToken is resolved once per worker", async () => {
  const w = loadWorker();
  await w.run("betaToken()");
  await w.run("betaToken()");
  await w.run("relay('/api/check', { sentences: [] })");
  assert.equal(w.calls.filter((c) => c.url.startsWith("chrome-extension://")).length, 1);
});

test("signed out + beta: the server's plan is honoured, the header was sent", async () => {
  const w = loadWorker({ entitlement: { plan: "pro", email: null, userId: null, enforced: true, beta: true } });
  const ent = plain(await w.run("fetchEntitlement({ force: true })"));
  assert.equal(ent.plan, "pro");
  assert.equal(ent.beta, true);
  assert.equal(betaHeader(entitlementCalls(w)[0].init), "tok-123");
  const r = await w.ask({ type: "tracely-entitlement" });
  assert.equal(r.plan, "pro");
  assert.equal(r.beta, true);
  assert.equal(r.signedIn, false);
});

test("signed out without beta: still free, whatever plan the body claims", async () => {
  for (const body of [
    { plan: "pro", enforced: true },
    { plan: "pro", enforced: true, beta: false },
    { plan: "pro", enforced: true, beta: "true" }, // only a real boolean counts
  ]) {
    const w = loadWorker({ entitlement: body });
    const ent = plain(await w.run("fetchEntitlement({ force: true })"));
    assert.equal(ent.plan, "free", JSON.stringify(body));
    assert.equal(ent.beta, false);
  }
});

test("test build, signed out: a failed entitlement is a guess — shown as provisional, never cached", async () => {
  // Cached, one 503 or one offline wake put a tester on free for the whole
  // TTL, and the widgets wrote that clamp into their saved stop.
  for (const opts of [{ entitlementStatus: 503 }, { down: true }]) {
    const w = loadWorker({ ...opts, entitlement: { plan: "pro", email: null, userId: null, enforced: true, beta: true } });
    const ent = plain(await w.run("fetchEntitlement({ force: true })"));
    assert.equal(ent.plan, "free", JSON.stringify(opts));
    assert.equal(ent.fetchedAt, 0, "not a real answer");
    assert.ok(!w.data.entitlement, `a guess was cached (${JSON.stringify(opts)})`);
    const r = await w.ask({ type: "tracely-entitlement" });
    assert.equal(r.provisional, true, "the widgets must not persist anything off this");
  }
  // ...and the next ask, once the server answers, is a real one.
  const w = loadWorker({ entitlementStatus: 503, entitlement: { plan: "pro", email: null, userId: null, enforced: true, beta: true } });
  await w.ask({ type: "tracely-entitlement" });
  w.net.entitlementStatus = 200;
  const r = await w.ask({ type: "tracely-entitlement" });
  assert.equal(r.plan, "pro");
  assert.equal(r.provisional, false);
});

test("a store build, signed out, still caches free on a failure — that IS its answer", async () => {
  const w = loadWorker({ installType: "normal", entitlementStatus: 503 });
  const ent = plain(await w.run("fetchEntitlement({ force: true })"));
  assert.equal(ent.plan, "free");
  assert.ok(ent.fetchedAt > 0);
  assert.equal(w.data.entitlement.plan, "free");
  assert.equal((await w.ask({ type: "tracely-entitlement" })).provisional, false);
});

test("test build: an expired session with no refresh falls through to the signed-out beta answer", async () => {
  const w = loadWorker({
    store: { authToken: "jwt-expired" },
    rejectBearer: true,
    entitlement: { plan: "pro", email: null, userId: null, enforced: true, beta: true },
  });
  const ent = plain(await w.run("fetchEntitlement({ force: true })"));
  assert.equal(w.data.authToken, "", "signed out locally");
  assert.equal(ent.plan, "pro", "not a cached free for the TTL");
  assert.equal(ent.beta, true);
  const store = loadWorker({ installType: "normal", store: { authToken: "jwt-expired" }, rejectBearer: true });
  assert.equal(plain(await store.run("fetchEntitlement({ force: true })")).plan, "free", "a store build: free, as before");
});

test("a store build sends no beta header to /api/entitlement", async () => {
  const w = loadWorker({ installType: "normal" });
  await w.run("fetchEntitlement({ force: true })");
  const [call] = entitlementCalls(w);
  assert.ok(call, "signed out still asks the server");
  assert.equal(betaHeader(call.init), undefined);
});

test("signed in: userId survives the cache, and beta rides along", async () => {
  const w = loadWorker({
    store: { authToken: "jwt-abc" },
    entitlement: { plan: "pro", email: "t@example.com", userId: "user-42", enforced: true, beta: true },
  });
  const r = await w.ask({ type: "tracely-entitlement", force: true });
  assert.equal(r.userId, "user-42", "tracely-entitlement dropped userId");
  assert.equal(r.plan, "pro");
  assert.equal(r.beta, true);
  assert.equal(w.data.entitlement.userId, "user-42", "storeEntitlement never persisted userId");
  const [call] = entitlementCalls(w);
  assert.equal(call.init.headers.Authorization, "Bearer jwt-abc");
  assert.equal(betaHeader(call.init), "tok-123");
});

test("the account id reaches the options page, never a content script on a host page", async () => {
  // The widget draws into an OPEN shadow root on the host page; a uid there
  // is a stable cross-site id any page's scripts can read.
  const w = loadWorker({
    store: { authToken: "jwt-abc" },
    entitlement: { plan: "free", email: "t@example.com", userId: "user-42", enforced: true },
  });
  const page = await w.ask({ type: "tracely-entitlement" }, { id: EXT_ID, url: "https://docs.google.com/document/d/x/edit", tab: { id: 7 } });
  assert.equal(page.userId, null, "a content script was handed the account id");
  assert.equal(page.plan, "free", "and nothing else about the answer changed");
  const options = await w.ask({ type: "tracely-entitlement" });
  assert.equal(options.userId, "user-42");
  const spoof = await w.ask({ type: "tracely-entitlement" }, { id: EXT_ID, url: `https://evil.test/chrome-extension://${EXT_ID}/` });
  assert.equal(spoof.userId, null, "a prefix match only");
});

test("the widgets' PRO link opens the order page with the id, from the worker", async () => {
  const w = loadWorker({
    store: { authToken: "jwt-abc" },
    entitlement: { plan: "free", email: "t@example.com", userId: "user-42", enforced: true },
  });
  const host = { id: EXT_ID, url: "https://example.test/", tab: { id: 3 } };
  const r = await w.ask({ type: "tracely-open-order" }, host);
  assert.equal(r.ok, true);
  assert.deepEqual(plain(w.opened), [{ url: "https://jointracely.com/order?uid=user-42" }]);
  assert.ok(!("userId" in r), "the id opens a tab; it is never sent back to the page");

  const out = loadWorker();
  await out.ask({ type: "tracely-open-order" }, host);
  assert.deepEqual(plain(out.opened), [{ url: "https://jointracely.com/order" }], "signed out: the bare page, never uid=null");
});

test("content.js never builds a uid into a link on the host page", () => {
  const src = read("content.js");
  assert.ok(!/uid=/.test(src), "content.js builds a ?uid= link");
  assert.ok(!/userId/.test(src), "content.js handles the account id at all");
  assert.match(src, /class="sb-pro" href="\$\{ORDER_URL\}"/, "the bare page is the no-worker fallback");
});

test("relay carries X-Tracely-Beta on POSTs and GETs; a store build's requests are unchanged", async () => {
  const beta = loadWorker();
  await beta.run("relay('/api/check', { sentences: [] }, { token: '' })");
  await beta.run("relay('/api/status', undefined, { token: '' })");
  const [post, get] = beta.calls.filter((c) => c.url === `${LOCAL}/api/check` || (c.url === `${LOCAL}/api/status` && c.init?.headers));
  assert.equal(betaHeader(post.init), "tok-123");
  assert.equal(post.init.method, "POST");
  assert.equal(betaHeader(get.init), "tok-123");

  const store = loadWorker({ installType: "normal" });
  await store.run("relay('/api/check', { sentences: [] }, { token: '' })");
  await store.run("relay('/api/status', undefined, { token: '' })");
  const check = store.calls.find((c) => c.url === `${LOCAL}/api/check`);
  assert.equal(betaHeader(check.init), undefined);
  assert.ok(check.init.headers["X-Tracely-Install"], "the install id still rides along");
  // An anonymous GET still goes out with no init at all, exactly as before.
  const gets = store.calls.filter((c) => c.url === `${LOCAL}/api/status`);
  assert.equal(gets.at(-1).init, undefined);
});

test("the header name is spelled exactly as the contract says", () => {
  const src = read("background.js");
  const names = [...src.matchAll(/["'](X-Tracely-[A-Za-z]+)["']/g)].map((m) => m[1]);
  assert.ok(names.includes("X-Tracely-Beta"));
  assert.deepEqual([...new Set(names)].sort(), ["X-Tracely-Beta", "X-Tracely-Install"]);
});

/* ── content.js: the storage wrappers ──────────────────────────────────── */

function contentSlice(from, to) {
  const src = read("content.js");
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `content.js: could not find ${from} .. ${to}`);
  return src.slice(a, b);
}

function loadWrappers(chrome) {
  const code = contentSlice("let extDead = false;", "/* Flow flags")
    + ";({ storageGet, storageSet, storageOnChanged, sendMsg, dead: () => extDead })";
  return vm.runInContext(code, vm.createContext({ chrome }));
}

test("content.js storage wrappers reach chrome.storage and run their callbacks", async () => {
  const seen = [];
  const chrome = {
    runtime: { id: EXT_ID, sendMessage: async () => ({ ok: true }) },
    storage: {
      local: {
        get: (defaults, cb) => { seen.push(["get", defaults]); setTimeout(() => cb({ enabledSites: ["https://a.test"] }), 0); },
        set: (obj) => { seen.push(["set", obj]); return Promise.resolve(); },
      },
      onChanged: { addListener: (fn) => seen.push(["listen", typeof fn]) },
    },
  };
  const w = loadWrappers(chrome);
  let got = null;
  w.storageGet({ enabledSites: [] }, (st) => { got = st; });
  w.storageSet({ enabledSites: [] });
  w.storageOnChanged(() => {});
  await tick();
  assert.deepEqual(plain(got), { enabledSites: ["https://a.test"] }, "the storageGet callback never ran");
  assert.deepEqual(seen.map((s) => s[0]), ["get", "set", "listen"]);
  assert.equal(w.dead(), false, "a live page must not be latched dead");
  assert.deepEqual(plain(await w.sendMsg({ type: "x" })), { ok: true }, "messaging still works after storage calls");
});

test("content.js wrappers still latch on a genuinely invalidated context", async () => {
  // chrome.runtime.id going undefined is the liveness signal...
  const chrome = { runtime: { id: EXT_ID }, storage: { local: { get: () => assert.fail("called a dead context") } } };
  const w = loadWrappers(chrome);
  chrome.runtime.id = undefined;
  assert.equal(w.storageGet({}, () => assert.fail("callback on a dead context")), undefined);
  assert.equal(w.dead(), true);
  chrome.runtime.id = EXT_ID; // an orphaned script never recovers
  assert.equal(await w.sendMsg({}), null);

  // ...and a synchronous "Extension context invalidated" throw is the other.
  const throwing = {
    runtime: { id: EXT_ID },
    storage: { local: { set: () => { throw new Error("Extension context invalidated."); } } },
  };
  const t = loadWrappers(throwing);
  assert.equal(t.storageSet({ a: 1 }), undefined);
  assert.equal(t.dead(), true);
});

/* ── content.js: the options-page slider as the default stop ───────────── */

function loadStops({ useRelay = true, stored = null, optionsModel = "" } = {}) {
  let reads = 0;
  const ls = { value: stored }; // the site's localStorage entry for the settings key
  const writes = [];
  const ctx = vm.createContext({
    useRelay,
    lsGet: () => ls.value,
    lsSet: (_key, value) => { ls.value = value; writes.push(JSON.parse(value)); return true; },
    jsonParse: (raw, fallback) => { try { return JSON.parse(raw); } catch { return fallback; } },
    storageGet: (defaults, cb) => { reads++; setTimeout(() => cb({ ...defaults, model: optionsModel }), 0); },
    encodeURIComponent,
  });
  const api = vm.runInContext(
    contentSlice("const SPEED_STOPS", "let tierTimer")
      + `;({ followDefaultStop, syncStopToTier, persistSettings, pinSiteStop, effModel, effEffort,
            setTier(plan, resolved, provisional = false) { tier = { ...tier, plan, provisional }; tierResolved = resolved; } })`,
    ctx,
  );
  return { api, reads: () => reads, ls, writes };
}

const KEY = "tracely.widget.settings";
const stopOf = (settings) => ({ model: settings.model, effort: settings.effort });

async function defaultFor(opts, plan, resolved) {
  const loaded = loadStops(opts);
  loaded.api.setTier(plan, resolved);
  const settings = { model: "gpt-5.6-luna", effort: "medium", citationStyle: "apa" };
  let applied = 0;
  loaded.api.followDefaultStop(settings, KEY, () => { applied++; });
  await tick();
  return { ...loaded, settings: stopOf(settings), live: settings, applied, reads: loaded.reads() };
}

test("the options-page stop is the default where a site has no setting of its own", async () => {
  const r = await defaultFor({ optionsModel: "gpt-6-astra" }, "pro", true);
  assert.deepEqual(r.settings, { model: "gpt-6-astra", effort: "low" });
  assert.equal(r.applied, 1);
});

test("the default is capped by plan: clamped once the tier is known, capped at send time before", async () => {
  const known = await defaultFor({ optionsModel: "gpt-6-astra" }, "free", true);
  assert.deepEqual(known.settings, { model: "gpt-5.6-luna", effort: "medium" });

  const early = await defaultFor({ optionsModel: "gpt-6-astra" }, "free", false);
  // Not clamped yet (the tier listener does that when it arrives)...
  assert.equal(early.settings.model, "gpt-6-astra");
  // ...but nothing above the plan can be requested meanwhile.
  assert.equal(early.api.effModel(early.live), "gpt-5.6-luna");
  assert.equal(early.api.effEffort(early.live), "medium");

  const student = await defaultFor({ optionsModel: "gpt-6-astra" }, "student", true);
  assert.deepEqual(student.settings, { model: "gpt-5.6-terra", effort: "low" });
});

test("a per-site choice wins, and junk or harness pages change nothing", async () => {
  const own = await defaultFor({ optionsModel: "gpt-6-astra", stored: JSON.stringify({ model: "gpt-5.6-luna", effort: "medium" }) }, "pro", true);
  assert.deepEqual(own.settings, { model: "gpt-5.6-luna", effort: "medium" });
  assert.equal(own.reads, 0, "must not even ask when the site has its own stop");

  for (const opts of [{ optionsModel: "junk" }, { optionsModel: "" }, { optionsModel: "gpt-6-astra", useRelay: false }]) {
    const r = await defaultFor(opts, "pro", true);
    assert.deepEqual(r.settings, { model: "gpt-5.6-luna", effort: "medium" }, JSON.stringify(opts));
    assert.equal(r.applied, 0);
  }
});

test("saving any other setting never pins a site to the default stop", async () => {
  // Toggling auto-sources or the citation style used to write the whole
  // settings object, default stop included, and the site stopped following
  // the options page for good.
  const r = await defaultFor({ optionsModel: "gpt-6-astra" }, "pro", true);
  r.live.autoSources = true;
  r.api.persistSettings(r.live, KEY);
  assert.deepEqual(r.writes.at(-1), { citationStyle: "apa", autoSources: true }, "the stop was saved with it");
  assert.deepEqual(stopOf(r.live), { model: "gpt-6-astra", effort: "low" }, "and it is still in effect");

  // Moving the widget's own slider is what gives the site a stop.
  r.live.model = "gpt-5.6-terra"; r.live.effort = "low";
  r.api.pinSiteStop(r.live);
  r.api.persistSettings(r.live, KEY);
  assert.deepEqual(r.writes.at(-1), { model: "gpt-5.6-terra", effort: "low", citationStyle: "apa", autoSources: true });
});

test("a transient free answer clamps the default in memory and the real plan restores it", async () => {
  const r = await defaultFor({ optionsModel: "gpt-6-astra" }, "pro", true);
  r.api.setTier("free", true, true); // provisional: the server did not answer
  r.api.syncStopToTier(r.live, KEY);
  assert.deepEqual(stopOf(r.live), { model: "gpt-5.6-luna", effort: "medium" });
  r.api.setTier("pro", true, false);
  r.api.syncStopToTier(r.live, KEY);
  assert.deepEqual(stopOf(r.live), { model: "gpt-6-astra", effort: "low" }, "stuck on Fast until reload");
  assert.equal(r.writes.length, 0, "the default is never written");
});

test("a site's own stop: a provisional clamp is not saved and is undone; a real one is saved", async () => {
  const own = JSON.stringify({ model: "gpt-6-astra", effort: "low", citationStyle: "mla" });
  const r = await defaultFor({ stored: own }, "pro", true);
  Object.assign(r.live, JSON.parse(own)); // what the widget loaded from the site

  r.api.setTier("free", true, true);
  r.api.syncStopToTier(r.live, KEY);
  assert.equal(r.live.model, "gpt-5.6-luna", "clamped in memory");
  assert.equal(r.ls.value, own, "an outage rewrote the saved stop");

  r.api.setTier("pro", true, false);
  r.api.syncStopToTier(r.live, KEY);
  assert.deepEqual(stopOf(r.live), { model: "gpt-6-astra", effort: "low" }, "the saved choice comes back with the plan");

  r.api.setTier("free", true, false); // a real downgrade
  r.api.syncStopToTier(r.live, KEY);
  assert.deepEqual(JSON.parse(r.ls.value), { model: "gpt-5.6-luna", effort: "medium", citationStyle: "mla" });
});

/* Earlier builds saved "gpt-5-nano" (Fast) and "gpt-5.4" (Balanced) as a
 * site's own stop and as the options-page default, with each stop's effort
 * beside it (Fast at low, Thorough at medium). After the remap those saves
 * must keep meaning their stop, and the effort sent is the CURRENT stop's. */
test("a stop saved by an earlier build still means that stop, at the current stop's effort", async () => {
  const saved = [
    [{ model: "gpt-5-nano", effort: "low" }, { model: "gpt-5.6-luna", effort: "medium" }],
    [{ model: "gpt-5.4", effort: "low" }, { model: "gpt-5.6-terra", effort: "low" }],
    [{ model: "gpt-6-astra", effort: "medium" }, { model: "gpt-6-astra", effort: "low" }],
  ];
  for (const [stored, sent] of saved) {
    const r = await defaultFor({ stored: JSON.stringify(stored) }, "pro", true);
    Object.assign(r.live, stored); // what the widget loaded from the site
    r.api.syncStopToTier(r.live, KEY);
    assert.deepEqual({ model: r.api.effModel(r.live), effort: r.api.effEffort(r.live) }, sent, `saved ${JSON.stringify(stored)}`);
    assert.equal(r.ls.value, JSON.stringify(stored), "a stop the plan allows is not rewritten");
  }

  // Above the plan, a saved retired id clamps like any other stop.
  const free = await defaultFor({ stored: JSON.stringify({ model: "gpt-5.4", effort: "low" }) }, "pro", true);
  Object.assign(free.live, { model: "gpt-5.4", effort: "low" });
  free.api.setTier("free", true, false);
  free.api.syncStopToTier(free.live, KEY);
  assert.deepEqual(stopOf(free.live), { model: "gpt-5.6-luna", effort: "medium" });
  assert.equal(free.api.effModel(free.live), "gpt-5.6-luna");
});

test("an options-page default saved as a retired id is followed as its stop", async () => {
  const pro = await defaultFor({ optionsModel: "gpt-5.4" }, "pro", true);
  assert.deepEqual(pro.settings, { model: "gpt-5.6-terra", effort: "low" });
  const fast = await defaultFor({ optionsModel: "gpt-5-nano" }, "pro", true);
  assert.deepEqual(fast.settings, { model: "gpt-5.6-luna", effort: "medium" });
  // Lookalikes and inherited names are not stops.
  for (const optionsModel of ["gpt-5.4-mini", "toString", "constructor"]) {
    const r = await defaultFor({ optionsModel }, "pro", true);
    assert.deepEqual(r.settings, { model: "gpt-5.6-luna", effort: "medium" }, optionsModel);
  }
});

test("every settings write in both widgets goes through persistSettings", () => {
  const src = read("content.js");
  assert.deepEqual([...src.matchAll(/lsSet\(SETTINGS_KEY/g)], [], "a raw settings write bypasses the default-stop rule");
  assert.equal([...src.matchAll(/persistSettings\(settings, SETTINGS_KEY\)/g)].length, 3, "two saveSettings + the citation pill");
  assert.equal([...src.matchAll(/syncStopToTier\(settings, SETTINGS_KEY\)/g)].length, 2, "the docs and field tier listeners");
  assert.equal([...src.matchAll(/followDefaultStop\(settings, SETTINGS_KEY/g)].length, 2, "both widgets use the default stop");
  assert.match(src, /pinSiteStop\(settings\);[^\n]*\n\s*saveSettings\(\);/, "the slider's snap pins the site's stop");
});

test("every model route carries the stop's model; only /api/check carries its effort", () => {
  // The stops' efforts are the ones the eval measured on the CHECK (Fast at
  // medium). Sent on /api/flow they ran a flow check at an effort nobody
  // measured (it had always run at the server's default, low), and on
  // /api/sources they replaced the vendor default every search has run at.
  const src = read("content.js");
  const sites = [...src.matchAll(/api\("\/api\/(check|flow|sources)"/g)];
  assert.equal(sites.length, 5, "docs + field /api/check, docs /api/flow, docs + field /api/sources");
  for (const m of sites) {
    const body = src.slice(m.index, src.indexOf("});", m.index));
    assert.match(body, /model: effModel\(settings\)/, `${m[1]} at ${m.index}`);
    if (m[1] === "check") assert.match(body, /effort: effEffort\(settings\)/, `check at ${m.index} sends no effort`);
    else assert.doesNotMatch(body, /^\s*effort\s*:/m, `${m[1]} at ${m.index} sends an effort`);
  }
});

/* ── content.js: verdicts saved before the remap are not served after it ── */

function loadSweep(store, { throws = false } = {}) {
  const deleted = [];
  const localStorage = new Proxy(store, {
    ownKeys: (t) => { if (throws) throw new Error("SecurityError"); return Reflect.ownKeys(t); },
  });
  const ctx = vm.createContext({
    localStorage,
    lsGet: (k) => (Object.hasOwn(store, k) ? store[k] : null),
    lsSet: (k, v) => { store[k] = v; return true; },
    lsDel: (k) => { deleted.push(k); delete store[k]; },
  });
  const api = vm.runInContext(contentSlice("const CACHE_GEN", "if (harness || IS_DOCS) docsMode();") + ";({ sweepRetiredCaches, CACHE_GEN })", ctx);
  return { ...api, deleted, store };
}

test("the Docs widget drops every verdict and flow cache saved before the remap, once, and keeps the rest", () => {
  // Those verdicts are gpt-5-nano's, and a cached sentence is never
  // re-checked — so without this, an unchanged sentence kept nano's verdict.
  const store = {
    "tracely.widget.vcache.docA": "[]", "tracely.widget.fcache.docA": "{}",
    "tracely.widget.vcache.docB": "[]",
    "tracely.widget.scache.docA": "[]", "tracely.widget.dismissed.docA": "[]",
    "tracely.widget.settings": "{}", "tracely.widget.docs": "[]", "unrelated.vcache.x": "1",
    "tracely.widget.vcache2.docA": "[]",
  };
  const s = loadSweep(store);
  assert.equal(s.CACHE_GEN, "2");
  s.sweepRetiredCaches();
  assert.deepEqual(s.deleted.sort(), ["tracely.widget.fcache.docA", "tracely.widget.vcache.docA", "tracely.widget.vcache.docB"]);
  assert.equal(store["tracely.widget.cacheGen"], "2");
  assert.ok("tracely.widget.vcache2.docA" in store, "the current generation is kept");
  assert.ok("tracely.widget.scache.docA" in store && "tracely.widget.dismissed.docA" in store, "sources and dismissals are kept");

  store["tracely.widget.vcache.docC"] = "[]"; // cannot happen after the update; proves the sweep runs once
  s.sweepRetiredCaches();
  assert.equal(s.deleted.length, 3, "the marker makes it a one-time pass");

  const blocked = loadSweep({ "tracely.widget.vcache.docA": "[]" }, { throws: true });
  blocked.sweepRetiredCaches();
  assert.equal(blocked.store["tracely.widget.cacheGen"], undefined, "unreadable storage: no marker, so the next load tries again");
});

test("the Docs widget reads and writes only the current cache generation", () => {
  const src = read("content.js");
  assert.match(src, /const VCACHE_KEY = `tracely\.widget\.vcache\$\{CACHE_GEN\}\.\$\{DOC_ID\}`;/);
  assert.match(src, /const FCACHE_KEY = `tracely\.widget\.fcache\$\{CACHE_GEN\}\.\$\{DOC_ID\}`;/);
  assert.ok(src.indexOf("sweepRetiredCaches(); // before anything reads a cache") < src.indexOf("lsGet(VCACHE_KEY)"), "swept before the first read");
  assert.deepEqual([...src.matchAll(/tracely\.widget\.(vcache|fcache)\.\$\{/g)].map((m) => m[0]), [], "a key without the generation");
});

/* ── options page ─────────────────────────────────────────────────────── */

async function renderOptions(answer, { stored = {} } = {}) {
  const els = new Map();
  const sets = [];
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, hidden: false, disabled: false, textContent: "", className: "", href: "", value: "0", dataset: {},
        style: { setProperty() {} },
        classList: { toggle() {} },
        addEventListener() {},
      });
    }
    return els.get(id);
  };
  // What options.html starts with: both account blocks and the beta badges hidden.
  for (const id of ["signedIn", "signedOut", "betaPlanOut", "acctBeta", "modelLocked"]) el(id).hidden = true;
  const chrome = {
    runtime: { sendMessage: async (m) => (m.type === "tracely-entitlement" ? answer : { ok: true }) },
    storage: {
      local: { get: (d, cb) => cb?.({ ...d, ...stored }), set: (o) => { sets.push(o); }, remove() {} },
      onChanged: { addListener() {} },
    },
  };
  const ctx = vm.createContext({
    chrome, console, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {}, AbortSignal, encodeURIComponent,
    fetch: async () => { throw new TypeError("offline"); },
    document: { getElementById: el, querySelectorAll: () => [] },
  });
  vm.runInContext(read("options.js"), ctx, { filename: "options.js" });
  await tick(); await tick();
  el.sets = sets;
  return el;
}

const BASE = { ok: true, configured: true, email: null, userId: null, unenforced: false };

test("options: a signed-out beta tester sees Pro (beta) and no way to pay", async () => {
  const $ = await renderOptions({ ...BASE, signedIn: false, plan: "pro", beta: true });
  assert.equal($("signedOut").hidden, false);
  assert.equal($("betaPlanOut").hidden, false);
  assert.equal($("betaPlanLabel").textContent, "Pro");
  assert.equal($("seePlans").hidden, true, "See plans is a pay link");
  assert.equal($("modelLocked").hidden, true, "every stop is open, so no upgrade note");
  assert.match($("acctHint").textContent, /test build/);
});

test("options: a signed-in beta tester sees Pro with a beta tag, no Upgrade — and can still manage a real subscription", async () => {
  // The server says Pro for every beta caller, so the page cannot tell a free
  // tester from one who pays; a payer must keep the way to the portal.
  const $ = await renderOptions({ ...BASE, signedIn: true, email: "t@example.com", plan: "pro", beta: true });
  assert.equal($("acctPlan").textContent, "Pro");
  assert.equal($("acctBeta").hidden, false);
  assert.equal($("manageLink").hidden, false);
  assert.notEqual($("manageLink").textContent, "Upgrade", "never offered a plan to buy");
  assert.ok(["Manage subscription", "Email us to cancel"].includes($("manageLink").textContent));
  assert.equal($("betaPlanOut").hidden, true);
  assert.match($("acctHint").textContent, /Manage subscription/);
});

test("options: nothing changes for a user who is not on the test build", async () => {
  const out = await renderOptions({ ...BASE, signedIn: false, plan: "free" });
  assert.equal(out("betaPlanOut").hidden, true);
  assert.equal(out("seePlans").hidden, false);
  assert.equal(out("modelLocked").hidden, false);

  const free = await renderOptions({ ...BASE, signedIn: true, email: "f@example.com", userId: "u-1", plan: "free" });
  assert.equal(free("manageLink").hidden, false);
  assert.equal(free("manageLink").textContent, "Upgrade");
  assert.equal(free("manageLink").href, "https://jointracely.com/order?uid=u-1");
  assert.equal(free("acctBeta").hidden, true);

  const pro = await renderOptions({ ...BASE, signedIn: true, email: "p@example.com", plan: "pro" });
  assert.equal(pro("manageLink").hidden, false);
  assert.equal(pro("manageLink").textContent, "Manage subscription");
});

test("options: a provisional free answer never overwrites the saved stop; a real one still clamps it", async () => {
  const guess = await renderOptions({ ...BASE, signedIn: false, plan: "free", provisional: true }, { stored: { model: "gpt-6-astra" } });
  assert.deepEqual(guess.sets.filter((o) => "model" in o), [], "an outage rewrote the tester's stop to Fast");
  const real = await renderOptions({ ...BASE, signedIn: false, plan: "free" }, { stored: { model: "gpt-6-astra" } });
  const writes = plain(real.sets.filter((o) => "model" in o));
  assert.ok(writes.length > 0 && writes.every((o) => o.model === "gpt-5.6-luna"), `a real downgrade still clamps: ${JSON.stringify(writes)}`);
});

test("options: a default saved as a retired id keeps its stop, and is rewritten to the current id", async () => {
  const pro = await renderOptions({ ...BASE, signedIn: true, email: "p@example.com", plan: "pro" }, { stored: { model: "gpt-5.4" } });
  assert.equal(pro("modelSlider").value, "1", "Balanced stays Balanced");
  // (The page renders the plan more than once and this stub storage never
  // applies a write, so the same migration may be written again.)
  const migrated = plain(pro.sets.filter((o) => "model" in o));
  assert.ok(migrated.length > 0 && migrated.every((o) => o.model === "gpt-5.6-terra"), JSON.stringify(migrated));

  const guess = await renderOptions({ ...BASE, signedIn: false, plan: "free", provisional: true }, { stored: { model: "gpt-5.4" } });
  assert.deepEqual(guess.sets.filter((o) => "model" in o), [], "a provisional answer rewrites nothing, retired id or not");

  const fast = await renderOptions({ ...BASE, signedIn: false, plan: "free" }, { stored: { model: "gpt-5-nano" } });
  assert.equal(fast("modelSlider").value, "0");
  const toFast = plain(fast.sets.filter((o) => "model" in o));
  assert.ok(toFast.length > 0 && toFast.every((o) => o.model === "gpt-5.6-luna"), JSON.stringify(toFast));
});

test("options: the stop notes claim only what the model eval measured", () => {
  // eval/models/FINDINGS.md: Balanced was not more accurate than Fast, so no
  // note may sell it as sharper, better on subtle claims, or more accurate.
  const src = read("options.js");
  const notes = src.match(/const MODEL_NOTES = \[([\s\S]*?)\];/)[1];
  for (const claim of [/subtle/i, /sharpest/i, /noticeably better/i, /more accurate than Fast(?!\.)/, /catches subtler/i]) {
    assert.ok(!claim.test(notes), `MODEL_NOTES claims ${claim}`);
  }
  assert.ok(!/catches subtler|smarter models/i.test(read("options.html") + src), "the hint copy still sells Smarter as catching more");
  assert.ok(!/smarter models?/i.test(read("content.js")), "the widget's locked-slider hint still sells a smarter model");
});

test("options.html lets `hidden` beat the link and badge display rules", () => {
  // .linkbtn and .acct set display, which beats the UA's [hidden] rule — the
  // Upgrade link would stay visible with hidden = true.
  const html = read("options.html");
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  for (const id of ["betaPlanOut", "betaPlanLabel", "acctBeta", "seePlans", "manageLink"]) {
    assert.match(html, new RegExp(`id="${id}"`), `options.html is missing #${id}`);
  }
});

test("the beta check needs no new permission", () => {
  // chrome.management.getSelf works without "management". Adding a permission
  // is a privilege increase: Chrome disables the extension for every existing
  // user until they re-accept it.
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(manifest.permissions, ["storage", "identity"]);
});
