// hook-trial.mjs — drive the SHIPPED extension/docs-hook.js inside a real Doc,
// over the exact postMessage protocol content.js uses.
//
//   node hook-trial.mjs --doc <url> [--severed]   (or TRACELY_EDIT_DOC_URL; no default —
//   see target.mjs. The public test Doc is refused unless --severed is passed.)
//
// ALWAYS network-severed before anything but a ping, whatever the URL:
//   1. docs-hook.js is injected at document_start (as the MAIN-world content
//      script is), behind the harness guard __tracelyEditConfig.allowEdits =
//      false, and the Doc loads through an in-process CONNECT proxy;
//   2. live, only `ping` is sent (read-only: getText/getSelection);
//   3. sever(): every upstream socket destroyed, new tunnels black-holed; a
//      canary fetch to Google must fail and zero upstream sockets may remain,
//      or the run aborts before any selection or edit;
//   4. only then is the guard lifted and edits/undos are sent;
//   5. the browser is closed and its profile deleted, so queued edits die.
// Afterwards run `node verify.mjs`: the live Doc must be unchanged.
import { requireEditTarget } from "./target.mjs";

// Decided before Playwright loads or a browser starts.
const TARGET = requireEditTarget("hook-trial.mjs");
const { chromium, EXE } = await import("./pw.mjs");
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const URL_ = TARGET.url;
const HOOK = fs.readFileSync(path.join(DIR, "..", "..", "docs-hook.js"), "utf8");
const MARK = "Zq"; // every test string carries it

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? "  " + JSON.stringify(detail).slice(0, 260) : ""}`);
}

/* ── kill-switch proxy (same mechanism as harness.mjs / edit-trial.mjs) ── */
const tunnels = new Set(), held = new Set();
const stats = { tunnels: 0, afterSever: 0, swallowedBytes: 0, severed: false };
const PPORT = 9700 + Math.floor(Math.random() * 90);
const proxy = http.createServer((q, r) => { r.writeHead(502); r.end(); });
proxy.on("connect", (req, cs, head) => {
  cs.on("error", () => {});
  if (stats.severed) {
    stats.afterSever++;
    cs.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    cs.on("data", (d) => { stats.swallowedBytes += d.length; });
    held.add(cs);
    return;
  }
  stats.tunnels++;
  const [h, p] = req.url.split(":");
  const us = net.connect(Number(p) || 443, h, () => {
    if (stats.severed) return us.destroy();
    cs.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) us.write(head);
    us.pipe(cs); cs.pipe(us);
  });
  us.on("error", () => { if (!stats.severed) cs.destroy(); });
  const t = { cs, us };
  tunnels.add(t);
  us.on("close", () => tunnels.delete(t));
});
await new Promise((r) => proxy.listen(PPORT, "127.0.0.1", r));
function sever() {
  stats.severed = true;
  for (const { cs, us } of tunnels) {
    try { us.unpipe(cs); cs.unpipe(us); } catch { /* ignore */ }
    us.destroy();
    cs.on("data", (d) => { stats.swallowedBytes += d.length; });
    held.add(cs);
  }
  tunnels.clear();
}

// content.js's transport, verbatim in shape.
async function send(page, op, args = {}, timeoutMs = 8000) {
  return page.evaluate(({ op, args, timeoutMs }) => new Promise((res) => {
    const id = "ht" + Math.random().toString(36).slice(2);
    const h = (ev) => {
      const d = ev.data;
      if (ev.source !== window || ev.origin !== location.origin || !d || d.source !== "tracely-hook" || d.type !== "tracely-docs-edit-result" || d.id !== id) return;
      removeEventListener("message", h);
      res(d);
    };
    addEventListener("message", h);
    postMessage({ ...args, source: "tracely", type: "tracely-docs-edit", id, op }, location.origin);
    setTimeout(() => { removeEventListener("message", h); res({ ok: false, reason: "trial-timeout" }); }, timeoutMs);
  }), { op, args, timeoutMs });
}
const text = (page) => page.evaluate(async () => (await window._docs_annotate_getAnnotatedText("tracely")).getText());

const profile = path.join(DIR, `profile-hook-${process.pid}`);
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: EXE, headless: true, viewport: { width: 1280, height: 900 },
  args: ["--no-first-run", "--no-default-browser-check", `--proxy-server=http://127.0.0.1:${PPORT}`, "--disable-quic", "--proxy-bypass-list=<-loopback>"],
});
let aborted = false;
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  // The guard FIRST, then the hook exactly as the extension injects it.
  await page.addInitScript(() => { window.__tracelyEditConfig = { allowEdits: false }; });
  await page.addInitScript(HOOK);
  await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof window._docs_annotate_getAnnotatedText === "function" && document.querySelector(".docs-texteventtarget-iframe"), null, { timeout: 45000 });
  await page.waitForTimeout(3500);

  // ── live: ping only ──
  const flag = await page.evaluate(() => window._docs_annotate_canvas_by_ext);
  check("the hook set the Docs flag", flag === "tracely", flag);
  const ping = await send(page, "ping");
  check("ping (live, read-only): text API + editor present, guarded → not editable", ping.ok && ping.api && ping.editor && ping.editable === false, ping);
  const T0 = await text(page);
  let h0 = 0; for (const c of T0) h0 = (h0 * 31 + c.charCodeAt(0)) | 0;
  console.log(`baseline: ${T0.length} chars, hash ${h0}`);

  // ── sever, and prove it ──
  sever();
  const canary = await page.evaluate(async () => {
    const probe = async (url) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      try { await fetch(url + "?c=" + Math.random(), { mode: "no-cors", cache: "no-store", signal: ac.signal }); return "REACHED"; }
      catch (e) { return "blocked: " + String(e).slice(0, 40); } finally { clearTimeout(t); }
    };
    return [await probe("https://docs.google.com/favicon.ico"), await probe("https://www.google.com/generate_204")];
  });
  // stats.tunnels > 0: the page really loaded THROUGH the proxy (a browser that
  // ignored --proxy-server would show zero tunnels, and must not be trusted).
  const safe = canary.every((c) => c !== "REACHED") && tunnels.size === 0 && stats.severed && stats.tunnels > 0;
  check("network severed: canaries cannot reach Google, 0 upstream sockets, traffic was proxied", safe, { canary, upstreamOpen: tunnels.size, tunnelsBefore: stats.tunnels });
  if (!safe) { aborted = true; throw new Error("ABORT: network not provably severed — nothing but a ping was sent"); }

  // Still guarded: a real edit must refuse, a dry run must plan.
  const sents = [];
  for (const para of T0.split(/[\n\u0003]/)) {
    const re = /[^.!?]+(?:[.!?]+["')\]]*|$)/g;
    let m;
    while ((m = re.exec(para))) { const s = m[0].trim(); if (s.split(/\s+/).length >= 5 && /[.!?]["')\]]*$/.test(s) && T0.split(s).length === 2) sents.push(s); }
  }
  const [A, B] = sents;
  check("two unique sentences to work on", A && B, { A, B });
  const g = await send(page, "replace", { find: A, replacement: A.replace(/([.!?]+["')\]]*)$/, ` ${MARK}1$1`) });
  check("guarded: a real edit refuses (edits-disabled)", g.reason === "edits-disabled", g);
  const dry = await send(page, "replace", { find: A, replacement: A.replace(/([.!?]+["')\]]*)$/, ` ${MARK}1$1`), dryRun: true });
  check("guarded: a dry run locates, selects and verifies", dry.ok && dry.dryRun && dry.edit?.copyVerified === true, dry);
  check("dry run changed nothing", (await text(page)) === T0);

  await page.evaluate(() => { window.__tracelyEditConfig.allowEdits = true; });
  const r1 = await send(page, "replace", { find: A, replacement: A.replace(/([.!?]+["')\]]*)$/, ` ${MARK}1$1`), hint: { occurrence: 0, occurrences: 1 } });
  const t1 = await text(page);
  check("replace applied + verified (minimal paste)", r1.ok && r1.verified === "exact" && t1.includes(`${MARK}1`), { ms: r1.ms, insert: r1.edit?.insert, reason: r1.reason });
  const r2 = await send(page, "insertAfter", { find: B, text: ` [${MARK}2]` });
  check("insertAfter applied", r2.ok && (await text(page)).includes(`${B} [${MARK}2]`), { ms: r2.ms, reason: r2.reason });
  const r3 = await send(page, "appendLine", { line: `Sources${MARK}:` });
  const r4 = await send(page, "appendLine", { line: `1. ${MARK} Source. Example Press, 2022. — https://example.com/${MARK}` });
  const t4 = await text(page);
  check("appendLine ×2 applied as new paragraphs", r3.ok && r4.ok && t4.includes(`\nSources${MARK}:\n1. ${MARK} Source`), { r3: r3.reason, r4: r4.reason });
  const bad = await send(page, "replace", { find: 42, replacement: "x" });
  check("malformed request → bad-request reply", bad.ok === false && bad.reason === "bad-request", bad);
  const untagged = await page.evaluate(() => new Promise((res) => {
    let got = false;
    // (the request itself also reaches this listener — only a REPLY counts)
    const h = (ev) => { if (ev.data?.id === "untagged" && ev.data?.type === "tracely-docs-edit-result") got = true; };
    addEventListener("message", h);
    postMessage({ type: "tracely-docs-edit", id: "untagged", op: "ping" }, location.origin);
    setTimeout(() => { removeEventListener("message", h); res(got); }, 600);
  }));
  check("an untagged request is ignored", untagged === false);
  const u = await send(page, "undo", { undoToken: [r4.undoToken, r3.undoToken, r2.undoToken, r1.undoToken] });
  const tU = await text(page);
  check("undo (group, newest first) restores the exact baseline", u.ok && tU === T0, { reason: u.reason, steps: u.steps?.map((s) => s.method || s.reason) });
  const nf = await send(page, "replace", { find: `Not in this document ${MARK}.`, replacement: "x y z." });
  check("not-found refuses", nf.reason === "not-found", nf.reason);
  check("text still exactly the baseline", (await text(page)) === T0);
} catch (e) {
  check("trial error", false, String(e && e.stack || e).slice(0, 400));
} finally {
  await ctx.close().catch(() => {});
  for (const c of held) c.destroy();
  proxy.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(JSON.stringify({ profileDeleted: !fs.existsSync(profile), aborted, proxy: { ...stats, upstreamOpenAtEnd: tunnels.size } }));
}
const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed} passed, ${failed} failed — now run: node verify.mjs`);
process.exit(failed ? 1 : 0);
