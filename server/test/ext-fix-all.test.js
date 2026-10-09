/* "Let Tracely fix these", prepared all at once (extension 2.21.33). Owner,
 * 2026-10-08: "when you click let tracely fix these it waits a while when it
 * clicks find citations. It also waits after each fix for you to confirm. I
 * want to have it finish everything and theres like multiple things waiting
 * for you to choose."
 *
 * Run here: Docs mode's own batch block, over the REAL head of runDocEdit
 * (the gate that records, previews or sends), with the card functions it
 * calls (docFix, docCite, docDeleteTip) stood in for and a clock that jumps
 * instead of waiting. Pinned: one press prepares everything — the searches
 * at once (3 at a time, 3 a minute), nothing reaching the doc, no preview —
 * each change listed for the writer; an accepted one goes in without a second
 * preview, one at a time, each after a fresh read; a source is only ever one
 * that backs its sentence. */
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

const S1 = "The Mongols invented the American dollar.";
const REV = "The Mongols used paper money.";
const CITES = ["Trade grew by 40 percent under the Mongols.", "Merchants paid 3 percent tax.", "Exactly 98% of trade passed through Mongol cities.", "Paper money circulated in 1260."];
const STRAY = "Pizza originated in Italy.";

function load() {
  const clock = { t: 1_000_000 };
  const log = { sent: [], previews: [], starts: [], active: 0, maxActive: 0, cycles: 0 };
  const ctx = vm.createContext({
    clock, log, console,
    Date: { now: () => clock.t },
    // A timer jumps the clock and fires on the next turn: nothing here really waits.
    setTimeout: (fn, ms = 0) => { clock.t += ms; setImmediate(fn); return 0; },
  });
  const head = sliceBetween(SRC, "    async function runDocEdit(key, job) {", '      setEditState(key, { state: "applying" });');
  const X = vm.runInContext(`
    const harness = null;
    const FEATURES = { typePreview: true };
    ${sliceBetween(SRC, "  const MARK_COLORS =", "\n")}
    ${sliceBetween(SRC, "  const VERDICT_LABEL =", "\n")}
    function hashText(s) { return "h" + s.length; }
    const CHECK_INTERVAL_MS = 10000;
    ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
    ${sliceBetween(SRC, "    const TP_TOKEN =", "\n")}
    ${sliceBetween(SRC, "    function previewDiff(", "    function previewLineRows(")}
    ${sliceBetween(SRC, "    function walkPlan(", "    /* Where the cursor starts")}
    ${sliceBetween(SRC, "    const tpClip =", "\n")}
    ${sliceBetween(SRC, "    const editGate =", "\n")}

    // The doc, and what the batch reads of it.
    let docText = ${JSON.stringify([S1, ...CITES, STRAY + " Next."].join(" "))};
    let segments = [];
    const reseg = () => { let at = 0; segments = docText.split(/(?<=\\.)\\s+/).map((text) => { const start = docText.indexOf(text, at); at = start + text.length; return { text, start, hash: text === "${S1}" ? "s1" : text.startsWith("${STRAY}") ? "x" : "c" + ${JSON.stringify(CITES)}.indexOf(text) }; }); };
    reseg();
    const cache = new Map([["s1", { verdict: "false", revision: "${REV}" }], ["c0", { verdict: "needs_citation" }], ["c1", { verdict: "needs_citation" }], ["c2", { verdict: "needs_citation" }], ["c3", { verdict: "needs_citation" }]]);
    const tip = { id: "tip:x", kind: "offtopic", quote: "${STRAY}" };
    const tipMarkById = new Map([[tip.id, tip]]);
    const currentIssues = () => segments.filter((s) => cache.has(s.hash)).map((seg) => ({ seg, f: cache.get(seg.hash) }));
    const canDeleteTip = (t) => t.kind === "offtopic";
    const tipById = (id) => tipMarkById.get(id) ?? null;
    const canEditDoc = () => true;
    const replaceFor = () => null;
    let docBusy = false, inflight = false;
    const docEditState = new Map();
    const setEditState = () => {};
    let renders = 0;
    const render = () => { renders++; };
    let previewDocEdit = async (key) => { log.previews.push(key); return false; };

    // Searches: c2 finds nothing that backs it.
    const sourcesMap = new Map();
    async function fetchSources(hash, auto, opts) {
      if (!opts?.batch) throw new Error("not a batch search");
      log.starts.push({ hash, at: clock.t });
      log.active++; log.maxActive = Math.max(log.maxActive, log.active);
      sourcesMap.set(hash, { loading: true });
      await new Promise((r) => setTimeout(r, 4000));
      log.active--;
      sourcesMap.set(hash, { loading: false, list: hash === "c2" ? [{ url: "ctx", stance: "context" }] : [{ url: "ctx", stance: "context", title: "Topic only" }, { url: "src-" + hash, stance: "supports", title: "Backs " + hash, verified: true }] });
      return true;
    }
    // The card functions, as far as the batch can see them: each plans an edit and hands it to runDocEdit.
    const segOf = (h) => segments.find((s) => s.hash === h);
    function docFix(hash) { const seg = segOf(hash); if (!seg || docBusy) return Promise.resolve(false); return runDocEdit("fix:" + hash, { steps: [{ action: "replace", find: seg.text, replacement: "${REV}" }] }); }
    function docCite(hash, i) {
      const seg = segOf(hash), src = sourcesMap.get(hash)?.list?.[i];
      if (!seg || !src || docBusy) return Promise.resolve(false);
      return runDocEdit("cite:" + hash + ":" + src.url, { steps: [{ action: "replace", find: seg.text, replacement: seg.text.replace(/\\.$/, " (Lee 2021).") }, { action: "appendLine", line: "Lee, Ann. " + src.title + ". 2021." }] });
    }
    function docDeleteTip(id) { if (!docText.includes(tip.quote) || docBusy) return Promise.resolve(false); return runDocEdit("del:" + id, { steps: [{ action: "replace", find: "${STRAY} Next.", replacement: "Next." }] }); }
    // runDocEdit: its REAL head (record / preview / approve), then "sent" in place of the engine.
    ${head}
      log.sent.push({ key, job });
      docBusy = false;
      return true;
    }
    // A read of the doc: the export shows what was sent.
    async function cycle() {
      log.cycles++;
      for (const { job } of log.sent.splice(0)) for (const st of job.steps) if (st.action === "replace") docText = docText.replace(st.find, st.replacement);
      reseg();
    }
    ${sliceBetween(SRC, '    /* ── "Let Tracely fix these": everything prepared', "    if (FEATURES.typePreview) {")}
    ({ prepareFixes, stopFixes, closeFixes, acceptFix, acceptAllFixes, skipFix, walkStripHtml, runDocEdit,
       batch: () => fixBatch, gate: editGate, doc: () => docText, setBusy: (v) => { docBusy = v; } })`, ctx);
  return { X, log, clock };
}
// Let every chain of jumps run out.
const drain = async (cond = () => false, n = 4000) => { for (let i = 0; i < n && !cond(); i++) await new Promise((r) => setImmediate(r)); };
const statuses = (X) => plain(X.batch().items).map((it) => `${it.key}:${it.status}${it.why ? ` (${it.why})` : ""}`);

test("one press prepares every change: searches at once, nothing reaches the doc, no preview — then they wait for the writer", async () => {
  const { X, log } = load();
  assert.match(X.walkStripHtml(), /Tracely can prepare 6 of these fixes at once — then you choose what goes in.*data-walk-go="1">Let Tracely fix these</s);
  X.prepareFixes();
  assert.match(X.walkStripHtml(), /Preparing 6 fixes · 0 ready/);
  await drain(() => !X.batch().preparing);
  assert.deepEqual(statuses(X), ["s1:ready", "c0:ready", "c1:ready", "c2:none (no source backs it)", "c3:ready", "tip:x:ready"]);
  assert.equal(log.sent.length, 0, "nothing reached the doc");
  assert.equal(log.previews.length, 0, "and nothing waited on a preview");
  assert.equal(log.maxActive, 3, "three searches at a time");
  const gaps = log.starts.map((s) => s.at - log.starts[0].at);
  assert.ok(gaps[3] >= 60_000, `the fourth waits for the minute (the server allows a caller 4): ${gaps}`);
  assert.deepEqual(plain(X.batch().items.filter((it) => it.src).map((it) => it.src.url)), ["src-c0", "src-c1", "src-c3"], "the source that BACKS each sentence, never the first one listed");
  const html = X.walkStripHtml();
  assert.match(html, /5 fixes ready — accept what you want/);
  assert.match(html, /data-fx-all="1">Accept all 5</);
  assert.match(html, /The Mongols <del>invented the American dollar<\/del><ins>used paper money<\/ins>\./, "what changes, before → after");
  assert.match(html, /\+<\/span> Lee, Ann\. Backs c0\. 2021\./, "and the line a citation adds");
  assert.match(html, /1 couldn't be prepared \(no source backs it\) — its card is still there/);
  assert.equal((html.match(/data-fx-accept=/g) || []).length, 5);
});

test("Accept goes in without a second preview; Accept all goes one at a time, each after a fresh read", async () => {
  const { X, log } = load();
  X.prepareFixes();
  await drain(() => !X.batch().preparing);
  X.skipFix(4); // c3: the writer skips it
  assert.equal(await X.acceptFix(0), true);
  assert.deepEqual(log.sent.map((s) => s.key), ["fix:s1"]);
  assert.equal(log.previews.length, 0, "the list was the preview");
  assert.equal(X.gate.approved.size, 0, "approval lasts one edit");
  await X.acceptAllFixes();
  assert.deepEqual(statuses(X), ["s1:applied", "c0:applied", "c1:applied", "c2:none (no source backs it)", "c3:skipped", "tip:x:applied"]);
  assert.equal(log.previews.length, 0);
  assert.ok(log.cycles >= 3, "a read of the doc after each one");
  const doc = X.doc();
  assert.ok(doc.startsWith(REV) && doc.includes("Trade grew by 40 percent under the Mongols (Lee 2021).") && doc.includes("Merchants paid 3 percent tax (Lee 2021).")
    && !doc.includes("Paper money circulated in 1260 (Lee") && !doc.includes(STRAY), doc);
  assert.match(X.walkStripHtml(), /4 changes in your doc/);
  X.closeFixes();
  assert.equal(X.batch(), null);
});

test("a card's own edit is never swallowed while preparing, and waits its turn", async () => {
  const { X, log } = load();
  const took = [];
  X.gate.collect = { prefix: "fix:s1", take: (k) => took.push(k) };
  assert.equal(await X.runDocEdit("cite:c9:u", { steps: [] }), false);
  assert.deepEqual(log.previews, ["cite:c9:u"], "another key goes to its preview as always");
  assert.deepEqual(took, []);
  X.gate.collect = null;
  // A card's edit in progress: the batch waits for it before it plans its own.
  X.setBusy(true);
  X.prepareFixes(); // refused while an edit runs
  assert.equal(X.batch(), null);
  X.setBusy(false);
  X.prepareFixes();
  X.setBusy(true);
  await drain(() => X.batch().items.some((it) => it.status === "working"), 400);
  await drain(() => false, 300);
  assert.ok(!X.batch().items.some((it) => it.status === "ready"), "nothing planned while the writer's edit holds the doc");
  X.setBusy(false);
  await drain(() => !X.batch().preparing);
  assert.equal(X.batch().items.filter((it) => it.status === "ready").length, 5);
});

test("Stop leaves what is ready and prepares nothing more; a change whose sentence moved on is not forced", async () => {
  const { X, log } = load();
  X.prepareFixes();
  await drain(() => X.batch().items[0].status === "ready");
  X.stopFixes();
  await drain(() => false, 2000);
  const st = statuses(X);
  assert.equal(st[0], "s1:ready");
  assert.ok(st.slice(1).every((x) => /:none \(/.test(x) || /:ready$/.test(x)), String(st));
  assert.ok(st.some((x) => /:none \(stopped\)$/.test(x)), `what was still on its way stops: ${st}`);
  assert.match(X.walkStripHtml(), /data-fx-close="1">Done</);
  assert.equal(log.sent.length, 0);

  const b = load();
  b.X.prepareFixes();
  await drain(() => !b.X.batch().preparing);
  // The writer rewrote the first sentence by hand in the meantime.
  b.X.batch().items[0].key = "gone";
  assert.equal(await b.X.acceptFix(0), false);
  assert.match(statuses(b.X)[0], /^gone:failed \(the doc changed — use its card\)$/);
  assert.equal(b.log.sent.length, 0);
});
