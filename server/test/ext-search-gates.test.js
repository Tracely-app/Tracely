/* Two things a source search can't do, said as what they are (content.js,
 * owner 2026-10-16):
 *   1. "Right now when you're not logged into the Tracely extension, it just
 *      says it can't find sources and doesn't cite anything, without
 *      explaining why, so it sounds like Tracely is glitching. Please add a
 *      little pop-up beforehand that says you need to be logged in."
 *   2. "When you run out of credits, have it show an alert like 'Uh-oh, you
 *      ran out of free searches,' and prompt users to 'Get Pro for more' or
 *      'Get Student plan for more.'" */
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

// Who needs to sign in: the plan gate's tier, as the worker's entitlement answer fills it.
function gate(t, { relay = true, resolved = true } = {}) {
  return vm.runInContext(`const useRelay = ${relay};
    ${sliceBetween(SRC, "  let tier = {", "  const tierListeners")}
    tier = { ...tier, ...${JSON.stringify(t)} };
    const tierResolved = ${resolved};
    needsSignIn()`, vm.createContext({}));
}

test("signed out is asked to sign in; never where there are no accounts, for a test build, or before the worker has answered", () => {
  assert.equal(gate({ configured: true, signedIn: false }), true);
  assert.equal(gate({ configured: true, signedIn: true }), false);
  assert.equal(gate({ configured: false, signedIn: false }), false, "a build with no project can't sign in");
  assert.equal(gate({ configured: true, signedIn: false, unenforced: true }), false, "a server that meters nothing");
  assert.equal(gate({ configured: true, signedIn: false, beta: true }), false, "a test build's Pro grant needs no account");
  assert.equal(gate({ configured: true, signedIn: false }, { resolved: false }), false, "no answer yet: never a false prompt");
  assert.equal(gate({ configured: true, signedIn: false }, { relay: false }), false, "a test page or /try: no worker, no accounts");
  // The worker's answer carries both, and a sign-in elsewhere re-renders the widget.
  assert.match(SRC, /signedIn: r\.signedIn === true, configured: r\.configured === true \};/);
  assert.match(SRC, /next\.signedIn === tier\.signedIn && next\.configured === tier\.configured\) return;/);
});

// The card's block and the sign-in, with the tier and the worker stubbed.
function cards(t = {}, reply = { ok: true }) {
  const log = [];
  const X = vm.runInContext(`
    let tier = { plan: "free", beta: false, unenforced: false, signedIn: false, ...${JSON.stringify(t)} };
    const esc = (s) => String(s);
    const sendMsg = async (m) => { log.push(m.type); return ${JSON.stringify(reply)}; };
    const openSettings = (s) => log.push("settings:" + s), refreshTier = () => log.push("refreshTier");
    ${sliceBetween(SRC, "  const SIGNIN_COPY = {", "  function searchFailureNote(err) {")}
    ({ searchGateHtml, signInFromCard, SIGNIN_COPY, OUT_COPY, tier: () => tier })`, vm.createContext({ log }));
  return { X, log };
}

test("the card's block: sign in before a search; out of searches, the server's words and the plans that give more", () => {
  const { X } = cards();
  const signin = X.searchGateHtml({ kind: "signin", note: X.SIGNIN_COPY.body });
  assert.match(signin, /<div class="gate-head">Sign in to find sources<\/div>/);
  assert.match(signin, /Tracely finds sources with your free Tracely account\./);
  assert.match(signin, /<button class="act primary" data-signin="1">Sign in with Google<\/button>/);
  const out = X.searchGateHtml({ kind: "plan_limit", note: "You've used today's 5 source searches. They reset at midnight." });
  assert.match(out, /<div class="gate-head">Uh-oh, you ran out of free searches<\/div><div class="gate-body">You've used today's 5 source searches\. They reset at midnight\.<\/div>/);
  assert.match(out, /<button class="act primary" data-upgrade="pro">Get Pro for more<\/button><button class="act" data-upgrade="student">Get Student plan for more<\/button>/);
  assert.equal(X.searchGateHtml({ kind: "rate_limit", note: "Slow down" }), "", "any other failure is said as before");
  assert.equal(X.searchGateHtml(null), "");
  // Student: Pro only, and not "free". Pro, a test build, a server that sells nothing: no plans.
  const student = cards({ plan: "student" }).X.searchGateHtml({ kind: "plan_limit", note: "n" });
  assert.match(student, /Uh-oh, you ran out of searches<\/div>/);
  assert.match(student, /data-upgrade="pro">Get Pro for more<\/button><\/div>/);
  assert.doesNotMatch(student, /data-upgrade="student"/);
  for (const t of [{ plan: "pro" }, { beta: true }, { unenforced: true }]) assert.doesNotMatch(cards(t).X.searchGateHtml({ kind: "plan_limit", note: "n" }), /data-upgrade/, JSON.stringify(t));
  // Never a finding's colour.
  assert.match(SRC, /\.gate \{ margin-top: 8px; padding: 12px; border-radius: 10px; background: var\(--w-soft\);/, "a neutral grey (#f7f7f8, or its dark token)");
});

test("Sign in with Google runs the worker's sign-in; anything but a cancel finishes in Settings → Account", async () => {
  const ok = cards();
  assert.equal(await ok.X.signInFromCard(), true);
  assert.equal(ok.X.tier().signedIn, true, "at once: the search it was for can run");
  assert.deepEqual(plain(ok.log), ["tracely-signIn", "refreshTier"]);
  const cancelled = cards({}, { ok: false, message: "Sign-in was cancelled." });
  assert.equal(await cancelled.X.signInFromCard(), false);
  assert.deepEqual(plain(cancelled.log), ["tracely-signIn"], "a cancel is the writer's answer");
  const broken = cards({}, { ok: false, message: "This build has no Supabase project configured" });
  assert.equal(await broken.X.signInFromCard(), false);
  assert.deepEqual(plain(broken.log), ["tracely-signIn", "settings:account"]);
});

// fetchSources in both modes, with the search held open (as ext-find-source.test.js does).
const fn = (from) => `${sliceBetween(SRC, from, "\n  }\n")}\n  }\n`;
const HELPERS = `${fn("  function offlineError(err) {")}${fn("  function searchFailureNote(err) {")}`;
const stubs = (signedOut) => `
  const sourceFailures = new Map(), sourcesMap = new Map(), cache = new Map();
  let sourcesInflight = 0, statusKind = "idle", statusMsg = "", searchesOut = false;
  const needsSignIn = () => ${signedOut}, SIGNIN_COPY = { body: "Sign in first." };
  const segments = [{ hash: "a", text: "Sleep improves memory." }];
  const docText = "doc", fieldText = "field", CHECK_MODEL = "m";
  const render = () => {}, renderPopSources = () => {}, persistCaches = () => {}, noteSourcesReady = () => {};
  const backingSources = (s) => ({ list: s ?? [], unbacked: 0, unread: [], partial: null });
  const calls = [];
  const searchSources = (body) => new Promise((resolve, reject) => calls.push({ body, resolve, reject }));
  const api = (p, body) => searchSources(body);
`;
const EXPORTS = `({ fetchSources, sourceFailures, calls, state: () => ({ statusKind, statusMsg, searchesOut }) })`;
const MODES = {
  docs: (out) => vm.runInContext(`${stubs(out)}${HELPERS}${sliceBetween(SRC, "    async function fetchSources(hash, auto = false, { batch = false } = {}) {", '    /* "Keep writing": a search goes on with its card closed')}${EXPORTS}`, vm.createContext({ setTimeout, requestAnimationFrame: setTimeout })),
  field: (out) => vm.runInContext(`${stubs(out)}${HELPERS}${sliceBetween(SRC, "    async function fetchSources(hash, auto = false) {", "    // Auto-sources — same toggle and rolling-hour guard as docs mode.")}${EXPORTS}`, vm.createContext({ setTimeout })),
};
const tick = () => new Promise((r) => setImmediate(r));

for (const [mode, load] of Object.entries(MODES)) {
  test(`${mode}: signed out, nothing is searched — the card that asked says to sign in, and nothing automatic runs`, async () => {
    const X = load(true);
    await X.fetchSources("a", true);
    assert.equal(X.calls.length, 0);
    assert.equal(X.sourceFailures.size, 0, "nobody asked: nothing to say");
    await X.fetchSources("a");
    assert.equal(X.calls.length, 0, "nothing sent");
    assert.deepEqual(plain(X.sourceFailures.get("a")), { note: "Sign in first.", auto: false, kind: "signin" });
    assert.equal(X.state().statusKind, "idle", "not an error");
  });

  test(`${mode}: out of searches is its own card, not an error in the header; any other failure is as before`, async () => {
    const X = load(false);
    const p = X.fetchSources("a");
    await tick();
    X.calls[0].reject(Object.assign(new Error("You've used today's 5 source searches. They reset at midnight."), { kind: "plan_limit" }));
    await p; await tick();
    assert.deepEqual(plain(X.sourceFailures.get("a")), { note: "You've used today's 5 source searches. They reset at midnight.", auto: false, kind: "plan_limit" });
    assert.deepEqual(plain(X.state()), { statusKind: "idle", statusMsg: "", searchesOut: true });
    const q = X.fetchSources("a");
    await tick();
    X.calls[1].reject(Object.assign(new Error("Slow down a moment"), { kind: "rate_limit" }));
    await q; await tick();
    assert.equal(X.sourceFailures.get("a").kind, "rate_limit");
    assert.equal(X.state().statusKind, "error");
    assert.equal(X.state().searchesOut, false);
  });
}

test("wired: both panels show the block and its buttons; the hover card says it; Review all says why", () => {
  assert.equal((SRC.match(/sourcesHtml = searchGateHtml\(failed\) \|\| `<div class="sources"><div class="loading">\$\{esc\(failed\.note\)\}<\/div><\/div>`;/g) || []).length, 2);
  assert.equal((SRC.match(/for \(const btn of shadow\.querySelectorAll\("\[data-signin\]"\)\) btn\.addEventListener\("click", \(\) => signInThenSearch\(\)\);\n\s+for \(const btn of shadow\.querySelectorAll\("\[data-upgrade\]"\)\) btn\.addEventListener\("click", \(\) => openOrderPage\(\)\);/g) || []).length, 2);
  assert.equal((SRC.match(/async function signInThenSearch\(\) \{\n\s+if \(!\(await signInFromCard\(\)\)\) return;\n\s+for \(const \[h, f\] of \[\.\.\.sourceFailures\]\) if \(f\.kind === "signin"\) \{ sourceFailures\.delete\(h\); fetchSources\(h\); \}/g) || []).length, 2, "the searches it was for run once signed in");
  assert.match(SRC, /if \(failed\?\.kind === "signin" \|\| failed\?\.kind === "plan_limit"\) \{\n\s+const signin = failed\.kind === "signin";\n\s+put\(dmHead\(DM\.hint, signin \? SIGNIN_COPY\.head : OUT_COPY\.head\(tier\.plan\), null, \{ wrap: true \}\), dmBody\(failed\.note\), noteEl\(\)\);/, "the hover card: grey, the whole title, never 'Search failed'");
  assert.match(SRC, /upgradesFor\(\)\.map\(\(plan, i\) => \{ const b = dmBtn\(OUT_COPY\[plan\], i === 0\); b\.addEventListener\("click", \(\) => openOrderPage\(\)\); return b; \}\)/);
  assert.match(SRC, /fixSettle\(item, "none", needsSignIn\(\) \? "sign in to find sources" : searchesOut \? "you're out of source searches" : "the search didn't answer"\)/);
});
