/* "Find a source" always does what it says. Owner, 2026-10-13: "find a source
 * action button doesnt work properly". Three things made it look dead:
 *   - a press while Tracely's own "Needs evidence" search ran (EVIDENCE_FIRST)
 *     found the one search slot taken and was refused without a word: the
 *     card flipped back, the panel button did nothing;
 *   - a search that failed said so only in the panel's status line, never in
 *     the card that asked (production's OpenAI key was rejected that day, so
 *     every search failed);
 *   - on a "Needs evidence" sentence whose own search found nothing, the
 *     button opened that same empty answer instead of searching again.
 * Both modes' fetchSources run here as they are in content.js. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const fn = (from) => `${sliceBetween(SRC, from, "\n  }\n")}\n  }\n`;
const HELPERS = `${fn("  function offlineError(err) {")}${fn("  function searchFailureNote(err) {")}`;

// The search the page would make, held open until the test settles it.
const STUBS = `
  const sourceFailures = new Map(), sourcesMap = new Map(), cache = new Map();
  let sourcesInflight = 0, statusKind = "idle", statusMsg = "", searchesOut = false;
  const needsSignIn = () => false; // signed in (content.js tier): ext-search-gates.test.js has the signed-out half
  const segments = [{ hash: "a", text: "Sleep improves memory." }, { hash: "b", text: "Teenagers sleep less than adults." }];
  const docText = "doc", fieldText = "field", CHECK_MODEL = "m";
  const render = () => {}, renderPopSources = () => {}, persistCaches = () => {}, noteSourcesReady = () => {};
  const backingSources = (s) => ({ list: s ?? [], unbacked: 0, unread: [], partial: null });
  const calls = [];
  const searchSources = (body) => new Promise((resolve, reject) => calls.push({ body, resolve, reject }));
  const api = (p, body) => searchSources(body);
`;
const EXPORTS = `({ fetchSources, sourcesMap, sourceFailures, calls, state: () => ({ sourcesInflight, statusKind, statusMsg }) })`;

function docs() {
  const body = sliceBetween(SRC, "    async function fetchSources(hash, auto = false, { batch = false } = {}) {", '    /* "Keep writing": a search goes on with its card closed');
  return vm.runInContext(`${STUBS}${HELPERS}${body}${EXPORTS}`, vm.createContext({ setTimeout, requestAnimationFrame: setTimeout }));
}
function field() {
  const body = sliceBetween(SRC, "    async function fetchSources(hash, auto = false) {", "    // Auto-sources — same toggle and rolling-hour guard as docs mode.");
  return vm.runInContext(`${STUBS}${HELPERS}${body}${EXPORTS}`, vm.createContext({ setTimeout }));
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const NO_KEY = Object.assign(new Error("OpenAI rejected the API key."), { kind: "no_key", status: 503 });

for (const [mode, make] of [["Docs", docs], ["field", field]]) {
  test(`${mode}: a press while Tracely's own search runs starts its own search`, async () => {
    const X = make();
    X.fetchSources("a", true); // the automatic "Needs evidence" search
    assert.equal(X.calls.length, 1);
    const started = X.fetchSources("b"); // the writer's press on another sentence
    assert.equal(X.calls.length, 2, "the press was refused while the automatic search ran");
    assert.equal(X.sourcesMap.get("b")?.loading, true, "the card has nothing to show while it searches");
    assert.notEqual(await Promise.race([started, settle().then(() => "pending")]), false);
    X.calls[1].resolve({ sources: [{ url: "https://x.org", title: "X" }] });
    X.calls[0].resolve({ sources: [] });
    await settle();
    assert.equal(X.sourcesMap.get("b").list.length, 1);
    assert.equal(X.state().sourcesInflight, 0);
  });

  test(`${mode}: an automatic search waits for the writer's, never the other way round`, async () => {
    const X = make();
    X.fetchSources("a");
    const auto = await Promise.race([X.fetchSources("b", true), settle().then(() => "pending")]);
    assert.equal(X.calls.length, 1, "the automatic search ran beside the writer's");
    assert.notEqual(auto, "pending", "it gave way at once (autoFindSources waits and tries again)");
    X.fetchSources("b"); // a second press runs too
    assert.equal(X.calls.length, 2);
  });

  test(`${mode}: a failed search says why, in the card that asked, until the next search`, async () => {
    const X = make();
    X.fetchSources("a");
    X.calls[0].reject(NO_KEY);
    await settle();
    assert.equal(X.sourcesMap.has("a"), false);
    const f = X.sourceFailures.get("a");
    assert.equal(f?.auto, false);
    assert.match(f.note, /^Tracely's source search isn't working on our side right now, so nothing was searched\. It isn't your writing\./);
    assert.equal(X.state().sourcesInflight, 0, "a failure left the count up");
    X.fetchSources("a"); // Search again
    assert.equal(X.sourceFailures.has("a"), false, "the old reason is gone once the new search starts");
  });

  test(`${mode}: an automatic search's failure is kept, marked, and not reported in the status line`, async () => {
    const X = make();
    X.fetchSources("a", true);
    X.calls[0].reject(NO_KEY);
    await settle();
    assert.equal(X.sourceFailures.get("a")?.auto, true);
    assert.equal(X.state().statusKind, "idle");
  });
}

test("Docs: a found list is never searched twice", async () => {
  const X = docs();
  X.sourcesMap.set("a", { loading: false, list: [{ url: "https://x.org" }] });
  assert.equal(await X.fetchSources("a"), true);
  assert.equal(X.calls.length, 0);
});

test("field: a found list is never searched twice (it used to pay again)", async () => {
  const X = field();
  X.sourcesMap.set("a", { loading: false, list: [{ url: "https://x.org" }] });
  await X.fetchSources("a");
  assert.equal(X.calls.length, 0);
});

test("the reason is in the writer's words: limits as the server says them, Tracely's own failures as Tracely's", () => {
  const X = vm.runInContext(`${HELPERS} ({ searchFailureNote })`, vm.createContext({}));
  const note = (e) => X.searchFailureNote(e);
  assert.equal(note({ kind: "rate_limit", message: "Slow down a moment — too many requests in the last minute." }), "Slow down a moment — too many requests in the last minute.");
  assert.equal(note({ kind: "plan_limit", message: "You've used today's 5 source searches." }), "You've used today's 5 source searches.");
  assert.equal(note({ kind: "budget", message: "Source search is paused for today to keep fact-checking available. Checking still works." }),
    "Source search is paused for today to keep fact-checking available. Checking still works.");
  assert.match(note({ kind: "no_key", message: "OpenAI rejected the API key." }), /isn't working on our side/);
  assert.match(note({ kind: "server", message: "Docs bridge error" }), /isn't working on our side/);
  assert.match(note({ status: 502, message: "Bad gateway" }), /isn't working on our side/);
  assert.match(note(new TypeError("Failed to fetch")), /^Couldn't reach Tracely/);
  assert.equal(note({ kind: "bad_request", message: "claim is required" }), "The search didn't answer (claim is required). Try again.");
  assert.equal(note(null), "The search didn't answer. Try again.");
});

test("the cards say it: the hover card's failed state and both panels read the reason", () => {
  // (Between them since 2.21.65: signed out, or out of searches, says that instead — ext-search-gates.test.js.)
  assert.match(SRC, /const failed = !s && st\.searched \? sourceFailures\.get\(hash\) : null;\n\s+\/\/ Signed out, or out of searches:[\s\S]{0,1600}?\n\s+if \(failed \|\| \(!s && !sourcesInflight && st\.searched\)\) \{\n\s+put\(dmHead\(DM\.red, POP_COPY\.searchFailed\), dmBody\(failed\?\.note \|\| /);
  // The panels show the writer's own failures, not an automatic one nobody asked for.
  assert.equal((SRC.match(/const failed = st \? null : sourceFailures\.get\(seg\.hash\);\n\s+if \(failed && !failed\.auto\) \{/g) || []).length, 2);
});

test("a 'Needs evidence' card whose own search found nothing searches again on Find a source", () => {
  assert.match(SRC, /const evEmpty = evDone && !evOpen;/);
  assert.match(SRC, /if \(ev && !evEmpty\) \{ setStep\(hash, \{ step: "sources", searched: true \}\); return; \}\n\s+if \(evEmpty && sourcesMap\.get\(hash\) === ev\) sourcesMap\.delete\(hash\);\n\s+\/\/ The search marks itself in flight/);
});
