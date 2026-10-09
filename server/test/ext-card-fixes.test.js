/* Every card ends in a fix (extension 2.21.26). Owner, 2026-10-08: "The
 * extension is still bad in the fact that it is not actionable. for example,
 * when there is an unamed source, there is only a dismiss button when there
 * should be one to fix it." Pinned here:
 *   - nameTheSource: "Some researchers have argued" becomes "Lee (2021) has
 *     argued" with the source that backs it — the name and year are the
 *     style's own marker, the verb agrees, and nothing is named where a name
 *     would change the claim ("people believe", "it is widely believed") or
 *     where the sentence already cites something;
 *   - deleteEditFor: a Delete is a replace of the passage AND the sentence
 *     beside it by that sentence alone (the engine never deletes outright),
 *     and that replace — run through docs-hook.js's own planner — leaves the
 *     document without the passage and Undo puts it back;
 *   - pageEditFor: the writer's page goes into the quote's own citation;
 *   - the wiring: Delete asks again before it edits, each fix is one edit
 *     with Undo, and a refused one says so instead of copying nothing.
 * The panel buttons are pinned in ext-cited-work.test.js (decorateCard). */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const HOOK = readFileSync(path.join(ROOT, "extension", "docs-hook.js"), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));
const ORIGIN = "https://docs.google.com";

const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false };
  function hashText(s) { return "h" + s.length + s.slice(0, 24); }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ nameTheSource, narrativeCitation, deleteEditFor, pageEditFor, tipDeletes, DELETE_LABEL, PAGE_INPUT })`, vm.createContext({}));

const LEE = { title: "Literacy in the Mongol Empire", authors: ["Ann Lee"], year: 2021, url: "https://example.org/lee", kind: "journal", container: "Journal of World History" };
const TWO = { ...LEE, authors: ["Ann Lee", "Bo Kim"] };
const MANY = { ...LEE, authors: ["Ann Lee", "Bo Kim", "Cy Day"] };
const NOBODY = { title: "Literacy in the Mongol Empire", authors: [], year: 2021, url: "https://example.org/x", kind: "other" };
const OWNER = "Some researchers have argued that literacy expanded in parts of the empire.";

/* ── naming the source ──────────────────────────────────────────────────── */

test("an unnamed source is named in its place, in each style, with the verb agreeing", () => {
  assert.equal(X.nameTheSource(OWNER, LEE, "apa"), "Lee (2021) has argued that literacy expanded in parts of the empire.");
  assert.equal(X.nameTheSource(OWNER, TWO, "apa"), "Lee and Kim (2021) have argued that literacy expanded in parts of the empire.", "APA's & is 'and' in a sentence");
  assert.equal(X.nameTheSource(OWNER, MANY, "apa"), "Lee et al. (2021) have argued that literacy expanded in parts of the empire.");
  assert.equal(X.nameTheSource(OWNER, LEE, "chicago"), "Lee (2021) has argued that literacy expanded in parts of the empire.");
  assert.equal(X.nameTheSource(OWNER, LEE, "mla"), "Lee has argued that literacy expanded in parts of the empire.", "MLA: the name, no parenthesis — a page is the writer's to give");
  assert.equal(X.nameTheSource("Research shows that trade grew.", LEE, "apa"), "Lee (2021) shows that trade grew.");
  assert.equal(X.nameTheSource("Research shows that trade grew.", TWO, "mla"), "Lee and Kim show that trade grew.");
  assert.equal(X.nameTheSource("As some historians argue, trade grew.", LEE, "apa"), "As Lee (2021) argues, trade grew.");
  assert.equal(X.nameTheSource("In fact, some scholars suggest trade grew.", TWO, "apa"), "In fact, Lee and Kim (2021) suggest trade grew.");
  assert.equal(X.nameTheSource("Several studies found that trade grew.", LEE, "apa"), "Lee (2021) found that trade grew.", "a past tense stays as written");
});

test("nothing is named where a name would change the claim, or where there is no one to name", () => {
  assert.equal(X.nameTheSource(OWNER, NOBODY, "apa"), null, "a source whose marker leads with its title names no one");
  assert.equal(X.nameTheSource(OWNER, NOBODY, "mla"), null);
  assert.equal(X.nameTheSource("Many people believe trade grew.", LEE, "apa"), null, "how many think so is not one author");
  assert.equal(X.nameTheSource("Most experts agree that trade grew.", LEE, "apa"), null);
  assert.equal(X.nameTheSource("It is widely believed that trade grew.", LEE, "apa"), null);
  assert.equal(X.nameTheSource("The studies show that trade grew.", LEE, "apa"), null, "a determiner owns the words");
  assert.equal(X.nameTheSource("Studies show trade grew (Smith, 2019).", LEE, "apa"), null, "already cited");
  assert.equal(X.nameTheSource("Studies show trade grew [3].", LEE, "apa"), null, "already cited, numbered");
  assert.equal(X.nameTheSource("Trade grew across the empire.", LEE, "apa"), null, "no unnamed source");
  assert.equal(X.nameTheSource(OWNER, null, "apa"), null);
});

test("the name comes from the style's own marker, never from anywhere else", () => {
  assert.deepEqual(plain(X.narrativeCitation(LEE, "apa")), { name: "Lee (2021)", plural: false });
  assert.deepEqual(plain(X.narrativeCitation({ ...LEE, year: null }, "apa")), { name: "Lee (n.d.)", plural: false });
  assert.deepEqual(plain(X.narrativeCitation(MANY, "chicago")), { name: "Lee et al. (2021)", plural: true });
  assert.deepEqual(plain(X.narrativeCitation(TWO, "mla")), { name: "Lee and Kim", plural: true });
  assert.equal(X.narrativeCitation(NOBODY, "apa"), null);
});

/* ── the Delete edit, through the engine's own planner ──────────────────── */

function hookInternals() {
  const document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, elementsFromPoint: () => [] };
  const ctx = {
    console, setTimeout, clearTimeout, performance, Promise, document,
    navigator: { platform: "MacIntel", userAgent: "test" },
    location: { origin: ORIGIN, href: `${ORIGIN}/document/d/doc/edit` },
    innerWidth: 1280, innerHeight: 900,
    MouseEvent: class {}, addEventListener: () => {}, postMessage: () => {},
    CanvasRenderingContext2D: class { fillText() {} strokeText() {} clearRect() {} fillRect() {} drawImage() {} putImageData() {} },
    HTMLCanvasElement: class { get width() { return 0; } set width(v) {} get height() { return 0; } set height(v) {} },
    __tracelyEditExpose: true,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(HOOK, ctx, { filename: "docs-hook.js" });
  return ctx.__tracelyEditInternals;
}
const I = hookInternals();
const docPaste = (s) => s.replace(/^ +| +$/g, ""); // Docs drops a plain paste's edge spaces

// The export's text → Docs' model text, the delete planned by content.js,
// applied the way the engine applies it, then undone the way it undoes.
function deleteRoundTrip(body, quote, last = false) {
  const plan = X.deleteEditFor(body, quote, last);
  assert.ok(plan, `a delete is planned for ${JSON.stringify(quote)}`);
  const T = "\u0003" + body + "\n\u0003\n";
  const mt = I.matchText(T, plan.find, { sentence: true });
  assert.equal(mt.hits.length, plan.occurrences, "the engine counts the copies the card does");
  const m = mt.hits[plan.occurrence];
  const p = I.planEdit(T, { map: mt.map, m, needle: mt.needle }, plan.replacement);
  assert.ok(!p.noop && p.insert, "every edit selects something and pastes something");
  assert.ok(!/^\s|\s$/.test(p.insert) && !/^\s|\s$/.test(p.removedRaw), "no edge space for Docs to drop, either way");
  const T2 = T.slice(0, p.s) + docPaste(p.insert) + T.slice(p.e);
  const T3 = T2.slice(0, p.s) + docPaste(p.removedRaw) + T2.slice(p.s + docPaste(p.insert).length);
  assert.equal(T3, T, "Undo puts it back exactly");
  return T2.slice(1, -3);
}

test("Delete takes the passage out — mid-line, line end, a whole paragraph — and Undo restores it", () => {
  const essay = "Trade grew under the Mongols. Pizza is delicious. Merchants used paper money.\nThe Silk Road carried ideas.";
  assert.equal(deleteRoundTrip(essay, "Pizza is delicious."), "Trade grew under the Mongols. Merchants used paper money.\nThe Silk Road carried ideas.");
  assert.equal(deleteRoundTrip(essay, "Merchants used paper money."), "Trade grew under the Mongols. Pizza is delicious.\nThe Silk Road carried ideas.");
  assert.equal(deleteRoundTrip(essay, "Trade grew under the Mongols."), "Pizza is delicious. Merchants used paper money.\nThe Silk Road carried ideas.");
  const stray = "Trade grew under the Mongols.\nThis does not prove anything.\nThe Silk Road carried ideas.";
  assert.equal(deleteRoundTrip(stray, "This does not prove anything."), "Trade grew under the Mongols.\nThe Silk Road carried ideas.", "its own paragraph: the line break goes with it");
  assert.equal(deleteRoundTrip("Pizza is delicious.\nTrade grew under the Mongols.", "Pizza is delicious."), "Trade grew under the Mongols.", "the first paragraph anchors on the one below");
});

test("Listed twice: the later copy is the one deleted, and the list keeps its order", () => {
  const entry = "Weatherford, Jack. Genghis Khan and the Making of the Modern World. Crown, 2004.";
  const doc = `Trade grew (Weatherford).\n\nWorks Cited\n${entry}\nOrd, J. Youth Work. Local Economy, 2022.\n${entry}`;
  assert.equal(deleteRoundTrip(doc, entry, true), `Trade grew (Weatherford).\n\nWorks Cited\n${entry}\nOrd, J. Youth Work. Local Economy, 2022.`);
  const adjacent = `Works Cited\n${entry}\n${entry}\nOrd, J. Youth Work. Local Economy, 2022.`;
  assert.equal(deleteRoundTrip(adjacent, entry, true), `Works Cited\n${entry}\nOrd, J. Youth Work. Local Economy, 2022.`);
});

test("no Delete where the note quotes part of a sentence, or the passage is gone or alone", () => {
  assert.equal(X.deleteEditFor("Trade grew under the Mongols, and pizza is delicious.", "pizza is delicious."), null, "never more than the note quotes");
  assert.equal(X.deleteEditFor("Trade grew.", "Pizza is delicious."), null);
  assert.equal(X.deleteEditFor("Pizza is delicious.", "Pizza is delicious."), null, "nothing beside it to anchor the edit");
  assert.equal(X.deleteEditFor("A thing.", ""), null);
  assert.ok(X.tipDeletes({ kind: "offtopic", quote: "x" }) && X.tipDeletes({ kind: "thesis", action: "delete", quote: "x" }));
  assert.ok(!X.tipDeletes({ kind: "thesis", action: "rewrite", quote: "x" }) && !X.tipDeletes({ kind: "refdup", quote: "" }));
});

/* ── the page number ────────────────────────────────────────────────────── */

test("the writer's page goes into the quote's own citation, in the style's form", () => {
  const s = 'Gatsby believed in "the orgastic future that year by year recedes before us" (Fitzgerald).';
  const q = '"the orgastic future that year by year recedes before us" (Fitzgerald)';
  assert.equal(X.pageEditFor(s, q, "180", "mla"), 'Gatsby believed in "the orgastic future that year by year recedes before us" (Fitzgerald 180).');
  assert.equal(X.pageEditFor(s.replace("(Fitzgerald)", "(Fitzgerald, 1925)"), q.replace("(Fitzgerald)", "(Fitzgerald, 1925)"), "180-81", "apa"),
    'Gatsby believed in "the orgastic future that year by year recedes before us" (Fitzgerald, 1925, pp. 180–81).');
  assert.equal(X.pageEditFor(s.replace("(Fitzgerald)", "(Fitzgerald 1925)"), q.replace("(Fitzgerald)", "(Fitzgerald 1925)"), "xiv", "chicago"),
    'Gatsby believed in "the orgastic future that year by year recedes before us" (Fitzgerald 1925, xiv).');
  for (const bad of ["", "page 5", "12a", "1925?", "-3"]) assert.equal(X.pageEditFor(s, q, bad, "mla"), null, `refused: ${JSON.stringify(bad)}`);
  assert.equal(X.pageEditFor("Something else entirely.", q, "180", "mla"), null, "the quote is gone");
});

/* ── the wiring: one edit each, with Undo; Delete asks first ───────────── */

function loadEdits({ respond, body, segments = [], tips = [], features = "{}" }) {
  const listeners = [];
  const sent = [];
  const win = {
    addEventListener: (t, fn) => { if (t === "message") listeners.push(fn); },
    removeEventListener: (t, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    postMessage(data) {
      sent.push(plain(data));
      const r = respond(plain(data));
      if (r === undefined) return;
      setTimeout(() => { for (const fn of [...listeners]) fn({ source: win, origin: ORIGIN, data: { source: "tracely-hook", type: "tracely-docs-edit-result", id: data.id, op: data.op, ...r } }); }, 1);
    },
  };
  const ctx = vm.createContext({
    window: win, location: { origin: ORIGIN }, document: { hidden: false }, innerWidth: 1280, innerHeight: 900, console, URL,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, ms >= 15_000 ? 1000 : 40)), clearTimeout,
    navigator: { clipboard: { writeText: async () => {} } },
    api: async () => ({}),
    // A clock the test can move: the ask to delete lapses after 4 s.
    Date: class extends Date { static now() { return Date.now() + (ctx.skew ?? 0); } },
  });
  const code = `
    const harness = null, IS_DOCS = true, DOC_ID = "doc123", CHECK_INTERVAL_MS = 10000;
    const FEATURES = ${features};
    let orphaned = false, bridgeReady = false, docBusy = false;
    let inDoc = { api: false, editable: false };
    let lastPingAt = 0;
    const docEditState = new Map();
    let lastDocEdit = null;
    const editedHashes = new Map(), popEditSyncs = new Set(), popSteps = new Map();
    const stepOf = (h) => popSteps.get(h) ?? { step: "problem" };
    function editState(k) { return docEditState.get(k)?.state ?? null; }
    let docText = ${JSON.stringify(body)};
    let segments = ${JSON.stringify(segments)}, docsBars = [];
    const cache = new Map(), sourcesMap = new Map(), citedMap = new Map();
    const settings = { citationStyle: "mla" };
    const dismissed = new Set(), review = { kind: "essay", findings: [] };
    let docGenre = "prose";
    let statusKind = "idle", statusMsg = "", lastCheckEnd = 0;
    let flowDismissed = new Set(), flowSig = "sig";
    let renders = 0;
    const render = () => { renders++; };
    const requestDocsMarks = () => {}, persistCaches = () => {}, persistFlow = () => {};
    const TIPS = ${JSON.stringify(tips)};
    function tipById(id) { return TIPS.find((t) => t.id === id) ?? null; }
    ${sliceBetween(SRC, "  function hashText(s) {", "  /* A Doc opened from a second")}
    ${sliceBetween(SRC, "  // Bibliography block", "  function segmentText(")}
    ${sliceBetween(SRC, "  /* A fix that only negates its sentence is no fix.", "  /* Citations that cannot lead a reader")}
    ${sliceBetween(SRC, '  /* ── "Find the cited work" (2.21.24)', "  function esc(s) {")}
    ${sliceBetween(SRC, "  function esc(s) {", "  /* ── transport")}
    ${sliceBetween(SRC, "    /* A note's own fix (Delete, the page box, Rewrite in doc)", "    // What a card's lookup is about:")}
    ${sliceBetween(SRC, "    /* ── editing the document ──", "    // (the bridge \"highlight in doc\" feature was removed")}
    ({ probeInDoc, armOrDelete, docDeleteTip, docAddPage, docRewriteTip, docCite, undoLastDocEdit, deleteLabel, canDeleteTip, popSteps, sourcesMap,
       state: () => ({ lastDocEdit, statusMsg, docEditState: [...docEditState].map(([k, v]) => [k, v.state, v.note ?? null]) }) })`;
  const w = vm.runInContext(code, ctx, { filename: "content-slice.js" });
  const edits = () => sent.filter((d) => d.type === "tracely-docs-edit" && d.op !== "ping");
  return { w, edits, ctx };
}
const okPing = (m) => (m.op === "ping" ? { ok: true, api: true, editor: true, editable: true } : undefined);
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const STRAY = "Trade grew under the Mongols. Pizza is delicious. Merchants used paper money.";
const OFF = { id: "tip:off", kind: "offtopic", quote: "Pizza is delicious.", message: "", suggestion: "" };

test("Delete asks again before it edits, then makes ONE replace with an Undo", async () => {
  let n = 0;
  const { w, edits } = loadEdits({ body: STRAY, tips: [OFF], respond: (m) => okPing(m) ?? (m.op === "undo" ? { ok: true } : { ok: true, undoToken: `t${++n}` }) });
  await w.probeInDoc();
  assert.equal(w.deleteLabel(OFF), "Delete this line");
  w.armOrDelete(OFF.id);
  assert.equal(edits().length, 0, "the first click only asks");
  assert.equal(w.deleteLabel(OFF), "Click again to delete");
  w.armOrDelete(OFF.id);
  await wait();
  assert.deepEqual(edits().map((e) => [e.op, e.find, e.replacement]), [["replace", "Pizza is delicious. Merchants used paper money.", "Merchants used paper money."]]);
  assert.equal(w.state().lastDocEdit.key, "del:tip:off", "Undo is offered for it");
  assert.equal(w.popSteps.get(OFF.id).step, "tipdone", "the card says it is done");
  await w.undoLastDocEdit();
  assert.equal(edits().at(-1).op, "undo");
  assert.equal(w.popSteps.has(OFF.id), false, "undone: the card is the note again");
});

test("Delete: the ask lapses, and with the type preview on the preview is the ask", async () => {
  const { w, edits, ctx } = loadEdits({ body: STRAY, tips: [OFF], respond: (m) => okPing(m) ?? { ok: true, undoToken: "t1" } });
  await w.probeInDoc();
  w.armOrDelete(OFF.id);
  ctx.skew = 5000;
  assert.equal(w.deleteLabel(OFF), "Delete this line");
  w.armOrDelete(OFF.id);
  assert.equal(edits().length, 0, "a lapsed ask asks again");
  const p = loadEdits({ body: STRAY, tips: [OFF], features: "{ typePreview: true }", respond: (m) => okPing(m) ?? { ok: true, undoToken: "t1" } });
  await p.w.probeInDoc();
  p.w.armOrDelete(OFF.id);
  await wait();
  assert.equal(p.edits().length, 1, "one click, and the preview's Accept confirms it");
});

test("a refused Delete says why and copies nothing", async () => {
  const { w } = loadEdits({ body: STRAY, tips: [OFF], respond: (m) => okPing(m) ?? { ok: false, reason: "not-found" } });
  await w.probeInDoc();
  assert.equal(await w.docDeleteTip(OFF.id), false);
  const [, state, note] = w.state().docEditState.find(([k]) => k === "del:tip:off");
  assert.equal(state, "failed");
  assert.match(note, /changed since the last read/);
  assert.match(w.state().statusMsg, /^Couldn't apply \(/, "not 'copied instead': there is nothing to copy");
});

test("Add page: the citation in the sentence takes the page; a bad page sends nothing", async () => {
  const S = 'Gatsby believed in "the orgastic future that year by year recedes before us" (Fitzgerald).';
  const body = `${S} It never arrived.`;
  const tip = { id: "tip:page", kind: "page", quote: '"the orgastic future that year by year recedes before us" (Fitzgerald)', message: "", suggestion: "" };
  const { w, edits } = loadEdits({ body, tips: [tip], segments: [{ text: S, start: 0, end: S.length }, { text: "It never arrived.", start: S.length + 1, end: body.length }], respond: (m) => okPing(m) ?? { ok: true, undoToken: "t1" } });
  await w.probeInDoc();
  assert.equal(await w.docAddPage(tip.id, "page five"), false);
  assert.equal(edits().length, 0);
  assert.equal(await w.docAddPage(tip.id, "180"), true);
  assert.deepEqual(edits().map((e) => [e.find, e.replacement]), [[S, S.replace("(Fitzgerald)", "(Fitzgerald 180)")]]);
});

test("Rewrite in doc: the review's rewrite replaces its sentence; a bare negation is never offered", async () => {
  const quote = "The Mongols invented the American dollar.";
  const body = `Trade grew. ${quote} Ideas spread.`;
  const good = { id: "tip:rw", kind: "evidence", action: "rewrite", quote, message: "", suggestion: "The Mongols spread paper money across Eurasia." };
  const negation = { id: "tip:neg", kind: "evidence", action: "rewrite", quote, message: "", suggestion: "Furthermore, the Mongols did not invent the American dollar." };
  const { w, edits } = loadEdits({ body, tips: [good, negation], respond: (m) => okPing(m) ?? { ok: true, undoToken: "t1" } });
  await w.probeInDoc();
  assert.equal(await w.docRewriteTip(negation.id), false);
  assert.equal(edits().length, 0);
  assert.equal(await w.docRewriteTip(good.id), true);
  assert.deepEqual(edits().map((e) => [e.find, e.replacement]), [[quote, good.suggestion]]);
});

test("Cite in doc on an unnamed source names it: the sentence says who, and its entry goes in the list", async () => {
  const body = `${OWNER} Trade grew.`;
  const { w, edits } = loadEdits({ body, segments: [{ text: OWNER, start: 0, end: OWNER.length, hash: "hS" }], respond: (m) => okPing(m) ?? (m.dryRun ? { ok: true, dryRun: true } : { ok: true, undoToken: `t${m.id}` }) });
  await w.probeInDoc();
  w.sourcesMap.set("hS", { loading: false, list: [LEE], citedUrl: null });
  assert.equal(await w.docCite("hS", 0), true);
  const sent = edits().filter((e) => !e.dryRun);
  assert.deepEqual(sent.map((e) => e.op), ["replace", "appendLine", "appendLine"], "the sentence, then the heading and the entry — one group");
  assert.equal(sent[0].replacement, "Lee has argued that literacy expanded in parts of the empire.", "named in place of 'some researchers', no marker beside it");
  assert.equal(w.sourcesMap.get("hS").named, "Lee");
  assert.match(w.state().statusMsg, /^named Lee as the source in doc/);
});
