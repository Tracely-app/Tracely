// Self-contained, network-severed edit trial.
//
//   node edit-trial.mjs <trial> --doc <url> [--severed]
//   (or TRACELY_EDIT_DOC_URL=<url>; there is no default Doc — see target.mjs.
//    The public test Doc is refused unless --severed is passed.)
//
// ALWAYS severed, whatever the Doc:
// 1) in-process CONNECT proxy carries all browser traffic while the Doc loads;
// 2) sever(): destroys every tunnel and refuses all new ones (irreversible);
// 3) the cut is PROVED before any trial code runs: canary fetches to Google
//    must fail, zero upstream sockets may remain open, and the page must have
//    loaded THROUGH the proxy (a browser that ignored --proxy-server, e.g.
//    under a managed ProxyMode policy, shows zero tunnels and would edit the
//    live Doc) — otherwise the run aborts before the trial source is loaded;
// 4) only THEN are edit events dispatched, so no mutation can leave the machine;
// 5) browser closed and profile deleted, so queued edits die with it.
import { requireEditTarget } from "./target.mjs";
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

// Decided before Playwright loads or a browser starts: no Doc, or the public
// Doc without --severed, exits here.
const TARGET = requireEditTarget('edit-trial.mjs');
const { chromium, EXE } = await import('./pw.mjs');
const DIR = path.dirname(new URL(import.meta.url).pathname);
const DOC = TARGET.url;
const TRIAL = TARGET.rest[0] || 'keys';
if (!/^[a-z0-9]+$/i.test(TRIAL) || !fs.existsSync(path.join(DIR, 'trials', TRIAL + '.js'))) {
  console.error(`edit-trial.mjs: no trial "${TRIAL}" in trials/`);
  process.exit(2);
}
const PPORT = 9800 + Math.floor(Math.random() * 150);

let blocked = false; let afterBlock = 0; let proxied = 0;
const proxy = http.createServer((q, r) => { r.writeHead(502); r.end(); });
const tunnels = new Set(); let swallowed = 0;
proxy.on('connect', (req, cs, head) => {
  if (blocked) {
    // black-hole: pretend the tunnel is up, never connect upstream, discard everything
    afterBlock++; cs.write('HTTP/1.1 200 Connection Established\r\n\r\n'); cs.on('data', d => { swallowed += d.length; }); cs.on('error', () => {}); held.add(cs); return;
  }
  proxied++;
  const [h, p] = req.url.split(':');
  const us = net.connect(Number(p) || 443, h, () => { if (blocked) return us.destroy(); cs.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) us.write(head); us.pipe(cs); cs.pipe(us); });
  const k = () => { if (!blocked) { cs.destroy(); us.destroy(); } }; us.on('error', k); cs.on('error', () => {});
  const tn = { cs, us }; tunnels.add(tn); us.on('close', () => tunnels.delete(tn));
});
const held = new Set();
await new Promise(r => proxy.listen(PPORT, '127.0.0.1', r));
function sever() {
  // FREEZE: cut every upstream socket (nothing more can reach Google) but keep the
  // browser-side sockets open and silently swallow their bytes, so Docs sees a
  // stalled connection instead of a dead one and does not lock the editor at once.
  blocked = true;
  for (const { cs, us } of tunnels) { try { us.unpipe(cs); cs.unpipe(us); } catch {} us.destroy(); cs.on('data', d => { swallowed += d.length; }); held.add(cs); }
  tunnels.clear();
}

const profile = path.join(DIR, 'profile-trial-' + TRIAL + '-' + process.pid);
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: EXE, headless: true, viewport: { width: 1280, height: 900 },
  args: ['--no-first-run', `--proxy-server=http://127.0.0.1:${PPORT}`, '--disable-quic', '--proxy-bypass-list=<-loopback>'],
});
const out = { trial: TRIAL };
try {
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(DOC, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  for (const f of ['lib.js', 'mouse.js', 'keys.js', 't.js']) await page.evaluate(fs.readFileSync(path.join(DIR, f), 'utf8'));
  await page.evaluate(async () => { window.__AT = await window._docs_annotate_getAnnotatedText('tracely'); });
  out.modeBefore = await page.evaluate(() => document.getElementById('docs-toolbar-mode-switcher')?.getAttribute('aria-label'));
  // ---- SEVER NETWORK. Nothing below can reach Google. ----
  sever();
  const canary = await page.evaluate(async () => {
    const probe = async (url) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      try { await fetch(url + '?c=' + Math.random(), { mode: 'no-cors', cache: 'no-store', signal: ac.signal }); return 'REACHED'; }
      catch (e) { return 'blocked: ' + String(e).slice(0, 40); } finally { clearTimeout(t); }
    };
    return [await probe('https://docs.google.com/favicon.ico'), await probe('https://www.google.com/generate_204')];
  });
  // proxied > 0: the page really loaded THROUGH the proxy, so severing it cut
  // the browser off; tunnels.size === 0: no upstream socket survived the cut.
  const safe = blocked && canary.every((c) => c !== 'REACHED') && tunnels.size === 0 && proxied > 0;
  out.severed = { safe, canary, upstreamOpen: tunnels.size, tunnelsBefore: proxied, blocked };
  if (!safe) throw new Error('ABORT: network not provably severed — no trial code was run');
  const trialSrc = fs.readFileSync(path.join(DIR, 'trials', TRIAL + '.js'), 'utf8');
  out.result = await page.evaluate(async (src) => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const T = () => window.__AT.getText();
    const before = T();
    const log = [];
    const snap = (label) => { const now = T(); log.push({ label, sel: __H.sel(), diff: __T.diff(before, now) }); };
    const fn = new (Object.getPrototypeOf(async function () {}).constructor)('wait', 'snap', 'T', src);
    try { await fn(wait, snap, T); } catch (e) { log.push({ err: String(e && e.stack || e).slice(0, 300) }); }
    return log;
  }, trialSrc);
  try { const cdp = await ctx.newCDPSession(page); const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, 'shots', 'trial-' + TRIAL + '.png'), Buffer.from(data, 'base64')); } catch (e) { out.shotErr = String(e).slice(0, 120); }
  out.statusAfter = await page.evaluate(() => document.querySelector('[aria-label^="Document status"]')?.getAttribute('aria-label'));
  out.afterBlockAttempts = afterBlock; out.swallowedBytes = swallowed;
} catch (e) { out.err = String(e && e.stack || e).slice(0, 500); }
finally {
  await ctx.close().catch(() => {});
  for (const c of held) c.destroy(); proxy.close();
  fs.rmSync(profile, { recursive: true, force: true });
  out.profileDeleted = !fs.existsSync(profile);
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.err ? 1 : 0);
