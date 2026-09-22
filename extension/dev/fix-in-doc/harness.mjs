// harness.mjs — drive engine.js inside a real Google Doc.
//
//   node harness.mjs [docUrl]            (default: $TRACELY_EDIT_DOC_URL, else the public test Doc)
//
// Two modes, chosen by whether the URL is the one YOU provided as editable:
//
//   EDITABLE  (url === $TRACELY_EDIT_DOC_URL): real edits on the live Doc, each
//             undone afterwards; also confirms the edits SAVED by reading the
//             Doc from a second, fresh browser.
//
//   PUBLIC    (anything else): the public test Doc is editable by anyone, so
//             NOTHING may be typed into it on a live connection.
//             A  live, engine guarded (allowEdits:false): probe, locate, select,
//                verify — every op as a dry run — plus the refusal paths.
//             B  network SEVERED first (in-process kill-switch proxy: upstream
//                sockets destroyed, new tunnels black-holed, canary fetch must
//                fail): real edits, verify, undo — they cannot leave the machine.
//             C  still severed + browser offline until Docs locks the editor:
//                the engine must report the edit refused, cleanly.
//             D  fresh browser, no proxy: the live Doc must be byte-identical
//                to what phase A first saw.
//
// Screenshots + results.json land in ./out/. Profiles are deleted on exit.
import { chromium, EXE } from "./pw.mjs";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(DIR, "out");
const SHOTS = path.join(OUT, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const PUBLIC_DOC = "https://docs.google.com/document/d/1J6UBuUcjzmmFmtMhmScUGc4iTRkKv-RFAXGy2U6tWfo/edit";
const EDIT_ENV = process.env.TRACELY_EDIT_DOC_URL || "";
const URL_ = process.argv[2] || EDIT_ENV || PUBLIC_DOC;
const EDITABLE = !!EDIT_ENV && URL_ === EDIT_ENV;
const ENGINE = fs.readFileSync(path.join(DIR, "engine.js"), "utf8");
const MARK = "Zq"; // every test string carries it; phase D asserts none survived

const results = { url: URL_, mode: EDITABLE ? "editable" : "public", started: new Date().toISOString(), phases: {}, checks: [] };
let cur = "setup";
function check(name, pass, detail) {
  results.checks.push({ phase: cur, name, pass: !!pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${cur}] ${name}${detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 300) : ""}`);
}
function info(name, detail) {
  results.checks.push({ phase: cur, name, info: true, detail });
  console.log(`info [${cur}] ${name}  ${JSON.stringify(detail).slice(0, 300)}`);
}

/* ── kill-switch proxy (public mode) ─────────────────────────────────── */
const proxyStats = { tunnels: 0, afterSever: 0, swallowedBytes: 0, severed: false };
let proxy = null, PPORT = 0;
const tunnels = new Set(), held = new Set();
async function startProxy() {
  PPORT = 9850 + Math.floor(Math.random() * 100);
  proxy = http.createServer((q, r) => { r.writeHead(502); r.end(); });
  proxy.on("connect", (req, cs, head) => {
    cs.on("error", () => {});
    if (proxyStats.severed) {
      // Black hole: pretend the tunnel is up, never connect upstream.
      proxyStats.afterSever++;
      cs.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      cs.on("data", (d) => { proxyStats.swallowedBytes += d.length; });
      held.add(cs);
      return;
    }
    proxyStats.tunnels++;
    const [h, p] = req.url.split(":");
    const us = net.connect(Number(p) || 443, h, () => {
      if (proxyStats.severed) return us.destroy();
      cs.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) us.write(head);
      us.pipe(cs); cs.pipe(us);
    });
    us.on("error", () => { if (!proxyStats.severed) cs.destroy(); });
    const t = { cs, us };
    tunnels.add(t);
    us.on("close", () => tunnels.delete(t));
  });
  await new Promise((r) => proxy.listen(PPORT, "127.0.0.1", r));
}
function sever() {
  // Freeze, don't slam: every upstream socket dies (nothing more can reach
  // Google), browser-side sockets stay open and silently swallow bytes, so
  // Docs sees a stalled connection and keeps its editor unlocked for a while.
  proxyStats.severed = true;
  for (const { cs, us } of tunnels) {
    try { us.unpipe(cs); cs.unpipe(us); } catch { /* ignore */ }
    us.destroy();
    cs.on("data", (d) => { proxyStats.swallowedBytes += d.length; });
    held.add(cs);
  }
  tunnels.clear();
}

/* ── page helpers ────────────────────────────────────────────────────── */
async function openDoc({ viaProxy, profileTag }) {
  const profile = path.join(OUT, `profile-${profileTag}-${process.pid}`);
  const args = ["--no-first-run", "--no-default-browser-check"];
  if (viaProxy) args.push(`--proxy-server=http://127.0.0.1:${PPORT}`, "--disable-quic", "--proxy-bypass-list=<-loopback>");
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: EXE, headless: true, viewport: { width: 1280, height: 900 }, args });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const logs = [];
  page.on("pageerror", (e) => logs.push(String(e).slice(0, 200)));
  // Same flag docs-hook.js sets at document_start.
  await page.addInitScript(() => { try { window._docs_annotate_canvas_by_ext = "tracely"; } catch { /* */ } });
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof window._docs_annotate_getAnnotatedText === "function" && document.querySelector(".docs-texteventtarget-iframe"), null, { timeout: 45000 });
  await page.waitForTimeout(3500);
  return { ctx, page, profile, logs };
}
async function closeDoc(d) {
  await d.ctx.close().catch(() => {});
  fs.rmSync(d.profile, { recursive: true, force: true });
  return !fs.existsSync(d.profile);
}
async function inject(page, { allowEdits }) {
  await page.evaluate((allowEdits) => { window.__tracelyEditConfig = { allowEdits }; window.__tracelyEditExpose = true; }, allowEdits);
  await page.evaluate(ENGINE); // via CDP: not subject to the page's CSP (the extension loads it as a MAIN-world content script)
  await page.evaluate(() => {
    window.__H = {
      at: null,
      async init() { this.at = await window._docs_annotate_getAnnotatedText("tracely"); return !!this.at; },
      text() { return this.at.getText(); },
      hash(t = this.text()) { let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0; return h; },
      sel() { return this.at.getSelection(); },
      setSel(s, e) { this.at.setSelection(s, e); return this.at.getSelection(); },
      async settledRects() {
        let prev = "", same = 0;
        for (let i = 0; i < 40 && same < 3; i++) {
          await new Promise((r) => setTimeout(r, 30));
          const k = JSON.stringify(this.overlayRects());
          same = k === prev ? same + 1 : 0; prev = k;
        }
        return JSON.parse(prev || "[]");
      },
      overlayRects() {
        return [...document.querySelectorAll(".kix-canvas-tile-selection svg rect, .kix-selection-overlay")]
          .map((r) => r.getBoundingClientRect()).filter((b) => b.width > 1 && b.height > 1)
          .map((b) => ({ left: b.left, top: b.top, width: b.width, height: b.height })).sort((a, b) => a.top - b.top || a.left - b.left);
      },
      matches(find) { return window.__tracelyEditInternals.matchText(this.text(), find).hits.length; },
      rawRange(find, k = 0) {
        const mt = window.__tracelyEditInternals.matchText(this.text(), find);
        const h = mt.hits[k];
        return h == null ? null : { start: mt.map[h], end: mt.map[h + mt.needle.length - 1] + 1 };
      },
    };
  });
  return page.evaluate(() => window.__H.init());
}
// The exact transport content.js will use.
async function call(page, msg, timeoutMs = 8000) {
  return page.evaluate(({ msg, timeoutMs }) => new Promise((res) => {
    const id = "h" + Math.random().toString(36).slice(2);
    const h = (ev) => {
      if (ev.source !== window || ev.data?.type !== "tracely-docs-edit-result" || ev.data.id !== id) return;
      removeEventListener("message", h);
      res(ev.data);
    };
    addEventListener("message", h);
    postMessage({ type: "tracely-docs-edit", id, ...msg }, "*");
    setTimeout(() => { removeEventListener("message", h); res({ ok: false, reason: "harness-timeout" }); }, timeoutMs);
  }), { msg, timeoutMs });
}
async function shot(page, name) {
  const p = path.join(SHOTS, name + ".png");
  try {
    const cdp = await page.context().newCDPSession(page);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(p, Buffer.from(data, "base64"));
    await cdp.detach().catch(() => {});
    return path.relative(DIR, p);
  } catch (e) { return "shot failed: " + String(e).slice(0, 80); }
}
const T = (page) => page.evaluate(() => window.__H.text());
const clean = (r) => { const o = { ...r }; delete o.type; delete o.id; return o; };

/* ── sample cases, derived from whatever Doc is loaded ────────────────── */
async function buildCases(page) {
  return page.evaluate(() => {
    const H = window.__H, t = H.text();
    const sents = [];
    for (const para of t.split(/[\n\u0003]/)) {
      const re = /[^.!?]+(?:[.!?]+["')\]]*|$)/g;
      let m;
      while ((m = re.exec(para))) { const s = m[0].trim(); if (s.split(/\s+/).length >= 5 && /[.!?]["')\]]*$/.test(s)) sents.push(s); }
    }
    const uniq = sents.filter((s) => H.matches(s) === 1);
    const used = new Set();
    const pick = (f) => { const s = uniq.find((x) => !used.has(x) && f(x)); if (s) used.add(s); return s || null; };
    const multi = [...uniq].sort((a, b) => b.length - a.length)[0] || null;
    if (multi) used.add(multi);
    const quote = pick((s) => /["']/.test(s)) ;
    const zw = pick((s) => /\u200b/.test(s));
    const cite = pick((s) => s.split(/\s+/).length <= 12);
    const after = pick(() => true);
    const extra = pick(() => true);
    // a 3-5 word phrase that occurs more than once
    let ambig = null;
    const words = t.replace(/[\n\u0003]/g, " ").split(/\s+/).filter(Boolean);
    outer: for (let n = 5; n >= 3; n--) for (let i = 0; i + n <= words.length; i++) {
      const ph = words.slice(i, i + n).join(" ").replace(/[.,;:!?]+$/, "");
      if (ph.length >= 10 && H.matches(ph) >= 2) { ambig = ph; break outer; }
    }
    return { multi, quote, zw, cite, after, extra, ambig, textLen: t.length };
  });
}
const smartify = (s) => s.replace(/"([^"]*)"/g, "“$1”").replace(/'/g, "’");
function midWordSwap(s) {
  const w = s.split(" ");
  let i = Math.floor(w.length / 2);
  while (i < w.length - 1 && !/^[A-Za-z]{4,}$/.test(w[i])) i++;
  w[i] = MARK + "edited";
  return w.join(" ");
}
const beforePunct = (s, add) => { const m = s.match(/[.!?]+["')\]]*$/); const at = m ? s.length - m[0].length : s.length; return s.slice(0, at) + add + s.slice(at); };

/* ── phases ──────────────────────────────────────────────────────────── */
async function phaseA(page, C) {
  cur = "A-live-dry";
  const probe = clean(await call(page, { op: "probe" }));
  check("probe: API + editor present", probe.api && probe.editor, probe);
  results.phases.A = { probe, cases: C };
  const T0 = await T(page);
  const H0 = await page.evaluate(() => window.__H.hash());
  results.baseline = { len: T0.length, hash: H0 };
  info("baseline", results.baseline);

  // user caret somewhere neutral; every op must put it back
  const caret = Math.min(5, T0.length - 4);
  await page.evaluate((c) => window.__H.setSel(c, c), caret);
  const caretBack = async (label) => {
    const s = await page.evaluate(() => window.__H.sel());
    check(`${label}: user caret restored`, s?.[0]?.start === caret && s?.[0]?.end === caret, s);
  };

  if (C.multi) {
    const r = clean(await call(page, { op: "replace", find: C.multi, replacement: midWordSwap(C.multi), dryRun: true, keepSelection: true }));
    const rects = await page.evaluate(() => window.__H.settledRects());
    const shotP = await shot(page, "A1-multiline-planned-selection");
    check("multi-line sentence: located, selection verified (dry run)", r.ok && r.dryRun && r.edit?.copyVerified, { r, shot: shotP });
    info("multi-line: selection overlay rects (≥2 means it wraps)", rects.length);
    // whole-sentence selection for the screenshot + rects for the no-API path
    const rr = await page.evaluate((f) => window.__H.rawRange(f), C.multi);
    await page.evaluate(({ start, end }) => window.__H.setSel(start, end), rr);
    results.multiRects = await page.evaluate(() => window.__H.settledRects());
    check("multi-line: whole sentence wraps onto ≥2 lines", results.multiRects.length >= 2, results.multiRects.length);
    await shot(page, "A2-multiline-whole-sentence");
    await page.evaluate((c) => window.__H.setSel(c, c), caret);
  }
  if (C.quote) {
    const find = smartify(C.quote);
    const r = clean(await call(page, { op: "replace", find, replacement: beforePunct(C.quote, ` — “${MARK}quoted”`), dryRun: true }));
    check("smart-quote find matches straight-quote doc text (dry run)", r.ok && r.dryRun, { find, r });
    await caretBack("smart-quote");
  }
  if (C.zw) {
    const find = C.zw.replace(/\u200b/g, "");
    const r = clean(await call(page, { op: "replace", find, replacement: find.replace(/\bvalues\b/, MARK + "values"), dryRun: true }));
    check("find without U+200B matches doc text that has them (dry run)", r.ok && r.dryRun, r);
  }
  if (C.cite) {
    const r = clean(await call(page, { op: "replace", find: C.cite, replacement: beforePunct(C.cite, " [1]"), dryRun: true }));
    check("citation marker plan is a one-token edit (dry run)", r.ok && r.edit && !/\s/.test(r.edit.remove), r.edit);
  }
  if (C.after) {
    const r = clean(await call(page, { op: "insertAfter", find: C.after, text: ` (${MARK}Source, 2022)`, dryRun: true }));
    check("insertAfter planned (dry run)", r.ok && r.dryRun, r.edit);
  }
  {
    const r = clean(await call(page, { op: "appendLine", line: "Sources:", dryRun: true, keepSelection: true }));
    await shot(page, "A3-append-caret-at-doc-end");
    check("appendLine: doc-end caret found and selected (dry run)", r.ok && r.dryRun, r);
    await page.evaluate((c) => window.__H.setSel(c, c), caret);
  }
  {
    const r = clean(await call(page, { op: "replace", find: `This sentence is not in the document ${MARK}.`, replacement: "x y z.", dryRun: true }));
    check("not-found reported", !r.ok && r.reason === "not-found", r);
  }
  if (C.ambig) {
    const n = await page.evaluate((f) => window.__H.matches(f), C.ambig);
    const r1 = clean(await call(page, { op: "replace", find: C.ambig, replacement: C.ambig + " " + MARK, dryRun: true }));
    check(`ambiguous phrase refused without a hint ("${C.ambig}" ×${n})`, !r1.ok && r1.reason === "ambiguous", r1);
    const second = await page.evaluate((f) => window.__H.rawRange(f, 1), C.ambig);
    const r2 = clean(await call(page, { op: "replace", find: C.ambig, replacement: C.ambig + " " + MARK, occurrence: 1, occurrences: n, dryRun: true }));
    check("occurrence hint picks the 2nd match", r2.ok && r2.target?.start === second.start && r2.target?.via === "occurrence", r2.target);
    const r3 = clean(await call(page, { op: "replace", find: C.ambig, replacement: C.ambig + " " + MARK, occurrence: 1, occurrences: n + 1, dryRun: true }));
    check("stale occurrence count refused", !r3.ok && r3.reason === "ambiguous", r3);
    await page.evaluate(({ start, end }) => window.__H.setSel(start, end), second);
    const rects = await page.evaluate(() => window.__H.settledRects());
    await page.evaluate((c) => window.__H.setSel(c, c), caret);
    const r4 = clean(await call(page, { op: "replace", find: C.ambig, replacement: C.ambig + " " + MARK, rects, dryRun: true }));
    check("rects hint picks the on-screen match", r4.ok && r4.target?.start === second.start && r4.target?.via === "rects", { target: r4.target, rects: rects.length });
    await caretBack("rects hint");
  }
  if (C.multi) {
    const r = clean(await call(page, { op: "replace", find: C.multi, replacement: midWordSwap(C.multi) }));
    check("guard: a real edit is refused while allowEdits=false", !r.ok && r.reason === "edits-disabled", r);
  }
  if (C.multi && results.multiRects?.length) {
    const r = clean(await call(page, { op: "replace", find: C.multi, replacement: midWordSwap(C.multi), rects: results.multiRects, dryRun: true, keepSelection: true, _test: { noApi: true } }));
    await shot(page, "A4-noapi-mouse-selection");
    check("no-API path: mouse selection proven by copy readback (dry run)", r.ok && r.path === "mouse", r);
    // again, now that the caret sits exactly on the end click point (kix draws
    // its caret div on top of the text there)
    const rb = clean(await call(page, { op: "replace", find: C.multi, replacement: midWordSwap(C.multi), rects: results.multiRects, dryRun: true, keepSelection: true, _test: { noApi: true } }));
    check("no-API path: works with the user's caret on the click point", rb.ok && rb.path === "mouse", rb);
    const off = results.multiRects.map((x, i) => (i === 0 ? { ...x, left: x.left + 40, width: x.width - 40 } : x));
    const r2 = clean(await call(page, { op: "replace", find: C.multi, replacement: "x", rects: off, dryRun: true, _test: { noApi: true } }));
    check("no-API path: a shifted selection is caught and refused", !r2.ok && r2.reason === "selection-mismatch", r2);
    const r3 = clean(await call(page, { op: "replace", find: C.multi, replacement: "x", rects: [{ left: 5, top: 5, width: 50, height: 12 }], dryRun: true, _test: { noApi: true } }));
    check("no-API path: rects off the page surface refused", !r3.ok && r3.reason === "offscreen", r3);
    await page.evaluate((c) => window.__H.setSel(c, c), caret);
  }
  {
    // dry runs move the selection too; the user's view must not move
    await page.setViewportSize({ width: 1280, height: 380 });
    await page.waitForTimeout(600);
    await page.evaluate((c) => { document.querySelector(".kix-appview-editor").scrollTop = 0; window.__H.setSel(c, c); }, caret);
    await page.waitForTimeout(500);
    const st0 = await page.evaluate(() => document.querySelector(".kix-appview-editor").scrollTop);
    const r = clean(await call(page, { op: "appendLine", line: "Sources:", dryRun: true }));
    await page.waitForTimeout(900);
    const st1 = await page.evaluate(() => document.querySelector(".kix-appview-editor").scrollTop);
    check("view lock: a dry run at the (off-screen) doc end leaves the user's scroll alone", r.ok && Math.abs(st1 - st0) <= 1, { st0, st1 });
    await shot(page, "A5-view-kept-small-viewport");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(500);
    await caretBack("view lock");
  }
  const H1 = await page.evaluate(() => window.__H.hash());
  check("doc text unchanged after phase A", H1 === H0, { H0, H1 });
  return T0;
}

// Real edits. In PUBLIC mode this only ever runs after sever() + canary.
async function phaseEdits(page, C, T0) {
  const tokens = [];
  const rec = (r) => { if (r.undo) tokens.unshift(r.undo); return r; };
  const len0 = T0.length;
  // user caret parked before the last sentence end: must move by the net growth
  const park = T0.lastIndexOf(".") > 0 ? T0.lastIndexOf(".") : 3;
  await page.evaluate((c) => window.__H.setSel(c, c), park);

  if (C.multi) {
    const repl = midWordSwap(C.multi);
    const r = rec(clean(await call(page, { op: "replace", find: C.multi, replacement: repl })));
    const t = await T(page);
    check("replace (minimal diff) applied + verified", r.ok && r.verified === "exact" && t.includes(repl), { ms: r.ms, edit: r.edit, verified: r.verified });
    const s = await page.evaluate(() => window.__H.sel());
    check("user caret after the edit moved by the edit's growth", s?.[0]?.start === park + (t.length - len0), { sel: s, want: park + (t.length - len0) });
    await shot(page, cur + "-1-replace");
  }
  if (C.quote) {
    const repl = beforePunct(C.quote, ` — “${MARK}quoted”`);
    const r = rec(clean(await call(page, { op: "replace", find: smartify(C.quote), replacement: repl })));
    const t = await T(page);
    check("replace with em dash + smart quotes pasted verbatim", r.ok && t.includes(`— “${MARK}quoted”`), { ms: r.ms, edit: r.edit });
  }
  if (C.cite) {
    const repl = beforePunct(C.cite, " [1]");
    const r = rec(clean(await call(page, { op: "replace", find: C.cite, replacement: repl })));
    check("citation marker [1] inserted before the period", r.ok && (await T(page)).includes(repl), { ms: r.ms, edit: r.edit });
  }
  if (C.after) {
    const r = rec(clean(await call(page, { op: "insertAfter", find: C.after, text: ` (${MARK}Source, 2022)` })));
    check("insertAfter applied", r.ok && (await T(page)).includes(C.after + ` (${MARK}Source, 2022)`), { ms: r.ms, edit: r.edit });
  }
  {
    const r1 = rec(clean(await call(page, { op: "appendLine", line: "Sources:" })));
    const r2 = rec(clean(await call(page, { op: "appendLine", line: `1. ${MARK}Source. Example Press, 2022. — https://example.com/${MARK}` })));
    const t = await T(page);
    check("appendLine ×2 (bibliography) applied", r1.ok && r2.ok && /\nSources:\n1\. Zq/.test(t), { r1: r1.edit, r2: r2.edit, tail: t.slice(-90) });
  }
  if (C.extra) {
    // user is focused in another input on the page (a Tracely card field)
    await page.evaluate(() => { const i = document.createElement("input"); i.id = "fake-card"; document.body.appendChild(i); i.focus(); });
    const r = rec(clean(await call(page, { op: "insertAfter", find: C.extra, text: ` ${MARK}focus.`, html: ` <a href="https://example.com/${MARK}">${MARK}focus.</a>` })));
    const ann = await page.evaluate(() => JSON.stringify(window.__H.at.getAnnotations?.() ?? {}));
    check("edit lands while page focus is on another input; html paste makes a link", r.ok && ann.includes("example.com/" + MARK), { ok: r.ok, reason: r.reason, ann: ann.slice(0, 200) });
  }
  await shot(page, cur + "-2-all-edits");
  const T1 = await T(page);
  info("text after edits (tail)", T1.slice(-260));

  // group undo, newest first
  const u = clean(await call(page, { op: "undo", tokens }, 20000));
  const T2 = await T(page);
  check("group undo restores the original text exactly", u.ok && T2 === T0, { steps: u.steps?.map((s) => s.method || s.reason), same: T2 === T0, lenDiff: T2.length - T0.length });
  await shot(page, cur + "-3-after-undo");

  // appended lines take the BODY paragraph's formatting (copy readback of the
  // new line vs. the last body word), not the trailing empty paragraph's
  {
    const r = clean(await call(page, { op: "appendLine", line: `${MARK}Fmt line` }));
    const fmt = await page.evaluate((mark) => {
      const at = window.__H.at, t = at.getText();
      const ce = document.querySelector(".docs-texteventtarget-iframe").contentDocument.querySelector("[contenteditable]");
      const W = ce.ownerDocument.defaultView;
      const copy = (s, e) => { at.setSelection(s, e); const dt = new W.DataTransfer(); ce.dispatchEvent(new W.ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: dt })); const h = dt.getData("text/html"); const m = h.match(/font-family:([^;"]+);?.*?font-size:([^;"]+)/) || h.match(/font-size:([^;"]+);.*?font-family:([^;"]+)/); return m ? m.slice(1, 3).join(" / ") : h.slice(0, 120); };
      const k = t.indexOf(mark + "Fmt");
      const b = t.lastIndexOf(" ", k - 3);
      const out = { newLine: copy(k, k + 5), body: copy(b + 1, b + 5) };
      at.setSelection(3, 3);
      return out;
    }, MARK);
    check("appended line matches the body formatting", r.ok && fmt.newLine === fmt.body, fmt);
    await shot(page, cur + "-4-append-format");
    const u = clean(await call(page, { op: "undo", tokens: [r.undo] }));
    check("cleanup undo (format line)", u.ok && (await T(page)) === T0, u.steps?.map((s) => s.method || s.reason));
  }

  // the user's own selection overlaps the words being replaced → it collapses
  // to the end of the edit (never left spanning half-replaced text)
  if (C.multi) {
    const d = clean(await call(page, { op: "replace", find: C.multi, replacement: midWordSwap(C.multi), dryRun: true }));
    await page.evaluate(({ start }) => window.__H.setSel(start + 1, start + 3), d.edit);
    const r = clean(await call(page, { op: "replace", find: C.multi, replacement: midWordSwap(C.multi) }));
    const s = await page.evaluate(() => window.__H.sel());
    const want = d.edit.start + d.edit.insert.length;
    check("user selection inside the edit collapses to the edit's end", r.ok && s?.[0]?.start === want && s?.[0]?.end === want, { sel: s, want });
    const u = clean(await call(page, { op: "undo", tokens: [r.undo] }));
    check("cleanup undo (overlap)", u.ok && (await T(page)) === T0);
  }

  // scroll: short viewport so the doc end is off-screen; appendLine moves the
  // selection there and back — the user's scroll position must not move
  {
    await page.setViewportSize({ width: 1280, height: 380 });
    await page.waitForTimeout(600);
    await page.evaluate(() => { document.querySelector(".kix-appview-editor").scrollTop = 0; window.__H.setSel(3, 3); });
    await page.waitForTimeout(400);
    const st0 = await page.evaluate(() => document.querySelector(".kix-appview-editor").scrollTop);
    const r = clean(await call(page, { op: "appendLine", line: `${MARK}scroll test` }));
    await page.waitForTimeout(900); // lock released by now; any late kix scroll would show
    const st1 = await page.evaluate(() => document.querySelector(".kix-appview-editor").scrollTop);
    await shot(page, cur + "-5-scroll-kept");
    check("user's scroll position unchanged by an edit off-screen", r.ok && Math.abs(st1 - st0) <= 1, { st0, st1, ok: r.ok });
    await page.mouse.move(700, 250);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(600);
    const st2 = await page.evaluate(() => document.querySelector(".kix-appview-editor").scrollTop);
    await shot(page, cur + "-6-after-user-wheel");
    check("after the lock lifts, a real wheel scroll still scrolls the doc", st2 > st1 + 50, { st1, st2 });
    const u = clean(await call(page, { op: "undo", tokens: [r.undo] }));
    check("cleanup undo (scroll)", u.ok && (await T(page)) === T0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(400);
  }

  // semantic-undo path: an unrelated edit lands after ours, so Cmd+Z would hit it
  if (C.cite) {
    const r = clean(await call(page, { op: "replace", find: C.cite, replacement: beforePunct(C.cite, " [2]") }));
    await page.evaluate((m) => { const t = window.__H.text(); const c = t.lastIndexOf("\u0003") - 1; window.__H.setSel(c, c); }, MARK);
    const r2 = clean(await call(page, { op: "appendLine", line: `${MARK}someone else typed this` }));
    const u2 = clean(await call(page, { op: "undo", tokens: [r.undo] }));
    const t = await T(page);
    check("undo after a later edit uses reverse-edit and keeps the later edit", r.ok && u2.ok && u2.steps?.[0]?.method === "reverse-edit" && !t.includes(" [2]") && t.includes(`${MARK}someone else`), u2.steps);
    const u3 = clean(await call(page, { op: "undo", tokens: [r2.undo] }));
    check("cleanup undo", u3.ok && (await T(page)) === T0, u3.steps);
  }
  // no-API path end to end (mouse select + copy readback, blind Cmd+Z undo)
  if (C.multi && results.multiRects?.length) {
    // rects must be current: recompute from a fresh selection
    const rr = await page.evaluate((f) => window.__H.rawRange(f), C.multi);
    await page.evaluate(({ start, end }) => window.__H.setSel(start, end), rr);
    const rects = await page.evaluate(() => window.__H.settledRects());
    await page.evaluate(() => window.__H.setSel(3, 3));
    const repl = midWordSwap(C.multi);
    const r = clean(await call(page, { op: "replace", find: C.multi, replacement: repl, rects, _test: { noApi: true } }));
    const t = await T(page);
    check("no-API path: replace applied, verified by copy readback", r.ok && r.verified === "copy-readback" && t.includes(repl), r);
    const u4 = clean(await call(page, { op: "undo", tokens: [r.undo], _test: { noApi: true } }));
    await page.waitForTimeout(300);
    check("no-API path: Cmd/Ctrl+Z undo restores text", u4.ok && (await T(page)) === T0, u4);
  }
}

async function phaseLocked(page, ctx, C) {
  cur = "C-locked";
  await ctx.setOffline(true);
  let status = "", locked = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    await page.waitForTimeout(3000);
    status = (await call(page, { op: "probe" })).status;
    locked = await page.evaluate(() => { return /connect|offline|unable/i.test(document.body.innerText.slice(0, 4000)) || /connect|offline/i.test(document.querySelector('[aria-label^="Document status"]')?.getAttribute("aria-label") || ""); });
    if (locked) break;
  }
  info("offline status", { status, locked, waitedMs: Date.now() - t0 });
  await shot(page, "C1-offline-state");
  if (!C.multi) return;
  const before = await T(page);
  await page.evaluate(() => window.__H.setSel(7, 7));
  const r = clean(await call(page, { op: "replace", find: C.multi, replacement: midWordSwap(C.multi) }));
  const after = await T(page);
  const sel = await page.evaluate(() => window.__H.sel());
  if (r.ok) {
    info("editor still accepted a local edit while offline (not locked) — undoing", r);
    await call(page, { op: "undo", tokens: [r.undo] });
  } else {
    check("locked editor: engine reports the edit refused, text unchanged, caret restored",
      r.reason === "not-applied" && before === after && sel?.[0]?.start === 7, { reason: r.reason, ms: r.ms, status: r.status, unchanged: before === after, sel });
  }
  await shot(page, "C2-after-refused-edit");
}

async function freshText() {
  const b = await chromium.launch({ executablePath: EXE, headless: true });
  try {
    const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
    await p.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.waitForFunction(() => typeof window._docs_annotate_getAnnotatedText === "function", null, { timeout: 45000 });
    await p.waitForTimeout(3000);
    return await p.evaluate(async () => { const at = await window._docs_annotate_getAnnotatedText("tracely"); const t = at.getText(); let h = 0; for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0; return { t, len: t.length, hash: h }; });
  } finally { await b.close(); }
}

/* ── main ────────────────────────────────────────────────────────────── */
let d = null;
try {
  if (EDITABLE) {
    cur = "live-edit";
    d = await openDoc({ viaProxy: false, profileTag: "edit" });
    check("engine injected + API (guarded until phase A is done)", await inject(d.page, { allowEdits: false }));
    const C = await buildCases(d.page);
    info("cases", C);
    const T0 = await phaseA(d.page, C); // dry-run checks are still valid here
    cur = "live-edit";
    await d.page.evaluate(() => { window.__tracelyEditConfig.allowEdits = true; });
    await phaseEdits(d.page, C, T0);
    // SAVE check: one edit, wait for "saved", read it back from a fresh browser.
    cur = "save-check";
    const repl = midWordSwap(C.multi);
    const r = clean(await call(d.page, { op: "replace", find: C.multi, replacement: repl }));
    let st = "";
    for (let i = 0; i < 20 && !/saved/i.test(st); i++) { await d.page.waitForTimeout(1000); st = (await call(d.page, { op: "probe" })).status; }
    const remote = await freshText();
    check("edit SAVED: a fresh browser sees it", r.ok && remote.t.includes(repl), { status: st });
    const u = clean(await call(d.page, { op: "undo", tokens: [r.undo] }));
    st = "";
    for (let i = 0; i < 20 && !/saved/i.test(st); i++) { await d.page.waitForTimeout(1000); st = (await call(d.page, { op: "probe" })).status; }
    const remote2 = await freshText();
    check("undo SAVED: a fresh browser sees the original", u.ok && remote2.t === T0, { status: st });
  } else {
    await startProxy();
    d = await openDoc({ viaProxy: true, profileTag: "pub" });
    check("engine injected + API (guarded: allowEdits=false)", await inject(d.page, { allowEdits: false }));
    await shot(d.page, "A0-loaded");
    const C = await buildCases(d.page);
    info("cases", C);
    const T0 = await phaseA(d.page, C);

    cur = "B-severed";
    sever();
    const canary = await d.page.evaluate(async () => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      try { await fetch("https://docs.google.com/favicon.ico?c=" + Math.random(), { mode: "no-cors", cache: "no-store", signal: ac.signal }); return "REACHED"; }
      catch (e) { return "blocked: " + String(e).slice(0, 60); } finally { clearTimeout(t); }
    });
    const safe = canary !== "REACHED" && tunnels.size === 0 && proxyStats.severed;
    check("network severed: canary fetch cannot reach Google, 0 upstream sockets", safe, { canary, upstreamOpen: tunnels.size });
    if (!safe) throw new Error("ABORT: network not provably severed — no edits attempted");
    await d.page.evaluate(() => { window.__tracelyEditConfig.allowEdits = true; });
    await phaseEdits(d.page, C, T0);
    await phaseLocked(d.page, d.ctx, C);
  }
} catch (e) {
  check("harness error", false, String(e && e.stack || e).slice(0, 600));
} finally {
  if (d) {
    results.pageErrors = d.logs.slice(0, 10);
    results.profileDeleted = await closeDoc(d);
  }
  for (const c of held) c.destroy();
  if (proxy) proxy.close();
  results.proxy = { ...proxyStats, upstreamOpenAtEnd: tunnels.size };
}
if (!EDITABLE) {
  cur = "D-verify-live";
  try {
    const f = await freshText();
    check("live Doc byte-identical to the phase-A baseline, no test strings", results.baseline && f.hash === results.baseline.hash && f.len === results.baseline.len && !f.t.includes(MARK), { len: f.len, hash: f.hash, baseline: results.baseline });
  } catch (e) { check("phase D load", false, String(e).slice(0, 200)); }
}
const passed = results.checks.filter((c) => !c.info && c.pass).length;
const failed = results.checks.filter((c) => !c.info && !c.pass).length;
results.summary = { passed, failed };
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
console.log(`\n${passed} passed, ${failed} failed — ${path.join(OUT, "results.json")}`);
process.exit(failed ? 1 : 0);
