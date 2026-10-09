/* The live source search (server + extension 2.21.29). Owner, 2026-10-08:
 * "think of ways to make the search for articles faster or at least ways to
 * make it seem faster. Show animation of going through favicons". A search
 * takes 12.6 s typical, 16.6 s at the slow end (eval/goldset, production,
 * 36 claims). POST /api/sources/stream is the same search and the same final
 * answer as /api/sources, with what is happening sent as it happens. Pinned:
 *   - the server: refusals answer as plain JSON before anything streams; a
 *     search streams searching → found → done, done carrying /api/sources'
 *     own body; the route is on the extension's surface, metered as a source
 *     search, and never sends a stance before the receipts;
 *   - the verifier's progress: one "read" per source, then "judging" — and a
 *     watcher that throws changes nothing;
 *   - the event parser, copied in background.js and content.js, the same in
 *     both, whatever the chunking;
 *   - the relay and the content script: an older server (404, or 403 for a
 *     route it does not know) is asked the old way; a search the server took
 *     on and lost is an error, never asked twice (it would pay twice);
 *   - the card: the stage, real sites' icons, "Keep writing", the "Sources
 *     ready" note, and the search starting on the press. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";
import { setHostResolver } from "../lib/citeMeta.js";
import { gatherEvidence, verifySources, OPENALEX_WORK } from "../lib/sourceVerify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const BG = readFileSync(path.join(ROOT, "extension", "background.js"), "utf8");
const SERVER = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
const FACTCHECK = readFileSync(path.join(HERE, "..", "lib", "factcheck.js"), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ── the server, for real (mock mode: no model, no key) ─────────────────── */

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
let BASE, child;
async function boot() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    let exited = false;
    child = spawn(process.execPath, [path.join(HERE, "..", "server.js")], {
      env: { ...process.env, TRACELY_MOCK: "1", PORT: String(port), TRACELY_DATA_DIR: mkdtempSync(path.join(tmpdir(), "tracely-live-")), SUPABASE_URL: "https://live-test.invalid", SUPABASE_ANON_KEY: "anon", TRACELY_LLM_PROVIDER: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("exit", () => { exited = true; });
    for (let i = 0; i < 100 && !exited; i++) {
      try { if ((await fetch(`${BASE}/api/status`)).ok && !exited) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();
    if (!exited) break;
  }
  throw new Error("server did not start");
}
test.before(boot);
test.after(() => child?.kill());
const post = (p, body, install) => fetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tracely-Install": install }, body: JSON.stringify(body) });

// The parser under test, from content.js (and, below, checked against background.js's copy).
const C = vm.runInContext(`${sliceBetween(SRC, "  function sseEvents(buffer) {", "  async function apiStream(")} ({ sseEvents })`, vm.createContext({}));
const B = vm.runInContext(`${sliceBetween(BG, "function sseEvents(buffer) {", "async function relayStream(", { file: "background.js" })} ({ sseEvents })`, vm.createContext({}));

test("server: a search streams searching → found → done, and done is /api/sources' own body", async () => {
  const claim = "The Great Wall of China is visible from space with the naked eye.";
  const res = await post("/api/sources/stream", { claim, context: claim }, "live-install-1");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/event-stream/);
  assert.match(res.headers.get("cache-control"), /no-transform/, "compression must not hold the events back");
  const parsed = C.sseEvents(await res.text());
  const events = plain(parsed.events), rest = parsed.rest;
  assert.equal(rest, "");
  assert.deepEqual(events.map((e) => e.type), ["searching", "found", "done"]);
  const found = events[1].sources;
  assert.ok(found.length > 0);
  for (const s of found) assert.deepEqual(Object.keys(s).sort(), ["publisher", "title", "url"], "titles and links only — never a stance before the receipts");
  const done = events[2];
  const old = await (await post("/api/sources", { claim, context: claim }, "live-install-2")).json();
  const shape = (b) => ({ keys: Object.keys(b).filter((k) => k !== "ms" && k !== "type").sort(), urls: b.sources.map((s) => s.url) });
  assert.deepEqual(shape(done), shape(old), "the same answer, the same fields");
  assert.deepEqual(found.map((s) => s.url), done.sources.map((s) => s.url));
});

test("server: a refusal answers as plain JSON with its status — nothing streams", async () => {
  const res = await post("/api/sources/stream", { claim: "" }, "live-install-3");
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type"), /json/);
  assert.equal((await res.json()).error.kind, "bad_request");
});

test("server: the route is the extension's, metered and gated as a source search", () => {
  for (const set of ["EXTENSION_API", "PAID_ROUTES", "MODEL_ROUTES", "EXTENSION_MODEL_ROUTES", "SOURCE_ROUTES"]) {
    const line = SERVER.slice(SERVER.indexOf(`const ${set} = new Set([`), SERVER.indexOf("]);", SERVER.indexOf(`const ${set} = new Set([`)));
    assert.ok(line.includes('"/api/sources/stream"'), `${set} names it`);
    assert.ok(line.includes('"/api/sources"'), `${set} still names /api/sources`);
  }
  assert.match(SERVER, /"\/api\/sources\/stream": \{ input: 40_000, output: 6_000, webSearchCalls: 3 \}/, "its worst case is reserved like /api/sources'");
  assert.match(SERVER, /url\.pathname === "\/api\/sources" \|\| url\.pathname === "\/api\/sources\/stream"/, "one handler: one count, one window, one charge");
  assert.match(BG, /const API_PATHS = new Set\(\[[^\]]*"\/api\/sources\/stream"/);
  assert.match(SERVER, /if \(res\.headersSent\) \{ if \(!res\.writableEnded\) res\.destroy\(\); return; \}/, "a stream that sent its error and ended is not cut off");
});

/* ── the verifier's progress ────────────────────────────────────────────── */

test.before(() => setHostResolver(async () => [{ address: "93.184.216.34" }]));
test.after(() => setHostResolver(null));
const CLAIM = "Investment in youth facilities has fallen by 73% between 2010/11 and 2022/23.";
const PAGE = `<html><body><p>${"Filler about youth services in England and councils. ".repeat(20)}</p><p>Between 2010/11 and 2022/23, spending on youth facilities fell by 73%.</p></body></html>`;
function fakeFetch(routes) {
  return async (url) => {
    const u = String(url);
    for (const [k, v] of Object.entries(routes)) if (u.includes(k)) return { ok: (v.status ?? 200) < 400, status: v.status ?? 200, headers: { get: (h) => (h.toLowerCase() === "content-type" ? "text/html" : null) }, json: async () => v.json ?? {}, text: async () => v.text ?? "" };
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
  };
}

test("verifier: one read per source as each settles, then judging — and a throwing watcher changes nothing", async () => {
  const sources = [{ title: "GOV.UK", url: "https://www.gov.uk/youth", stance: "supports" }, { title: "Walled", url: "https://paywall.example/x", stance: "supports" }];
  const fetchImpl = fakeFetch({ "www.gov.uk/youth": { text: PAGE }, "paywall.example": { status: 403, text: "no" } });
  const reads = [];
  const { evidence } = await gatherEvidence(sources, CLAIM, { fetchImpl, deadlineMs: 2000, onRead: (i, r) => reads.push({ i, ...r }) });
  assert.deepEqual(evidence.map((e) => e.i), [0]);
  assert.deepEqual(reads.sort((a, b) => a.i - b.i), [{ i: 0, read: true, from: "page", retracted: false }, { i: 1, read: false, from: null, retracted: false }]);
  const angry = await gatherEvidence(sources, CLAIM, { fetchImpl, deadlineMs: 2000, onRead: () => { throw new Error("card trouble"); } });
  assert.deepEqual(angry.evidence.map((e) => e.i), [0], "the same reading");

  const seen = [];
  const call = async () => ({ parsed: { verdicts: [{ id: 0, verdict: "backs", quote: "spending on youth facilities fell by 73%" }] }, usage: { input: 1, output: 1 } });
  const list = sources.map((s) => ({ ...s }));
  const out = await verifySources({ claim: CLAIM, sources: list, model: "m", call, fetchImpl, deadlineMs: 2000, onProgress: (ev) => seen.push(ev.type === "read" ? `read:${ev.i}:${ev.read}` : `${ev.type}:${ev.count}`) });
  assert.deepEqual(seen.slice(0, 2).sort(), ["read:0:true", "read:1:false"]);
  assert.equal(seen[2], "judging:1", "the judge is announced after every reading");
  assert.equal(out.checked, 1);
  assert.equal(list[0].stance, "supports");
});

test("findSources reports titles and links, the links kept, each read by its url — never a stance", () => {
  assert.match(FACTCHECK, /tell\(\{ type: "found", sources: merged\.map\(\(s\) => \(\{ title: String\(s\.title \?\? ""\), url: String\(s\.url \?\? ""\), publisher: String\(s\.publisher \?\? ""\) \}\)\) \}\)/);
  assert.match(FACTCHECK, /tell\(\{ type: "links", urls: merged\.map/);
  assert.match(FACTCHECK, /type: "read", url: String\(merged\[ev\.i\]\?\.url \?\? ""\), read: ev\.read, from: ev\.from/);
});

/* ── the event parser, twice ────────────────────────────────────────────── */

test("the event parser: whole events out of any chunking, the same in background.js and content.js", () => {
  const wire = 'data: {"type":"searching"}\n\ndata: {"type":"found","sources":[{"title":"A","url":"https://a.org","publisher":"a.org"}]}\n\n: a comment\n\ndata: not json\n\ndata: {"type":"done","sources":[]}\n\n';
  for (const P of [C, B]) {
    for (const cut of [1, 7, 23, 40, wire.length]) {
      let buffer = "";
      const got = [];
      for (let i = 0; i < wire.length; i += cut) {
        const r = P.sseEvents(buffer + wire.slice(i, i + cut));
        buffer = r.rest;
        got.push(...r.events);
      }
      assert.deepEqual(plain(got).map((e) => e.type), ["searching", "found", "done"], `cut ${cut}`);
      assert.equal(buffer, "");
    }
  }
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  assert.equal(norm(sliceBetween(SRC, "  function sseEvents(buffer) {", "\n  }\n")), norm(sliceBetween(BG, "function sseEvents(buffer) {", "\n}\n", { file: "background.js" })), "one parser, two copies");
});

/* ── the content script: stream, fall back, never pay twice ─────────────── */

function streamBody(text) {
  const enc = new TextEncoder().encode(text);
  let sent = false;
  return { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: enc })) }) };
}
function loadTransport(fetchImpl) {
  const calls = [];
  const ctx = vm.createContext({
    SERVER: "http://localhost:4477", useRelay: false, chrome: undefined, TextDecoder, TextEncoder, console,
    fetch: async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }); return fetchImpl(String(url)); },
  });
  const X = vm.runInContext(`${sliceBetween(SRC, "  async function api(path, body) {", '  /* "Find the cited work": one /api/compare-source call')} ({ searchSources, apiStream })`, ctx);
  return { X, calls };
}
const jsonRes = (status, body) => ({ ok: status < 400, status, body: null, json: async () => body });

test("content: the live search's events reach the card in order, and its answer is done's body", async () => {
  const wire = 'data: {"type":"searching"}\n\ndata: {"type":"found","sources":[{"title":"A","url":"https://a.org","publisher":"a.org"}]}\n\ndata: {"type":"read","url":"https://a.org","read":true,"from":"page"}\n\ndata: {"type":"done","sources":[{"title":"A","url":"https://a.org","stance":"supports"}],"plan":"free"}\n\n';
  const { X, calls } = loadTransport(() => ({ ok: true, status: 200, body: streamBody(wire), json: async () => ({}) }));
  const seen = [];
  const data = await X.searchSources({ claim: "c" }, (ev) => seen.push(ev.type));
  assert.deepEqual(seen, ["searching", "found", "read"]);
  assert.deepEqual(plain(data), { sources: [{ title: "A", url: "https://a.org", stance: "supports" }], plan: "free" });
  assert.deepEqual(calls.map((c) => c.url), ["http://localhost:4477/api/sources/stream"]);
});

test("content: an older server (404, or 403 for a route it does not know) is asked the old way — once, then always", async () => {
  for (const refusal of [jsonRes(404, { error: { kind: "not_found", message: "Not found" } }), jsonRes(403, { error: { kind: "forbidden", message: "Origin not allowed for this endpoint" } })]) {
    const { X, calls } = loadTransport((url) => (url.endsWith("/stream") ? refusal : jsonRes(200, { sources: [] })));
    assert.deepEqual(plain(await X.searchSources({ claim: "c" })), { sources: [] });
    await X.searchSources({ claim: "d" });
    assert.deepEqual(calls.map((c) => c.url.replace("http://localhost:4477", "")), ["/api/sources/stream", "/api/sources", "/api/sources"], "the old route from then on");
    assert.deepEqual(calls[1].body, { claim: "c" }, "the same request");
  }
});

test("content: a search the server took on and lost is an error — never asked again (that would pay twice)", async () => {
  const quota = jsonRes(429, { error: { kind: "quota", message: "Daily source searches used up." } });
  const lost = { ok: true, status: 200, body: streamBody('data: {"type":"searching"}\n\ndata: {"type":"error","status":502,"error":{"kind":"server","message":"No usable sources came back — try again."}}\n\n'), json: async () => ({}) };
  const cut = { ok: true, status: 200, body: streamBody('data: {"type":"searching"}\n\n'), json: async () => ({}) };
  for (const [res, kind, msg] of [[quota, "quota", /used up/], [lost, "server", /No usable sources/], [cut, "server", /stopped before it finished/]]) {
    const { X, calls } = loadTransport(() => res);
    await assert.rejects(X.searchSources({ claim: "c" }), (err) => err.kind === kind && msg.test(err.message));
    assert.equal(calls.length, 1, `${kind}: one request, no fallback`);
  }
});

/* ── the card ───────────────────────────────────────────────────────────── */

const LIVE_UI = () => sliceBetween(SRC, '    /* "Keep writing": a search goes on with its card closed', "    // Auto-sources for flagged claims");
function loadLiveUi({ popOpen = false, expanded = false } = {}) {
  const ctx = vm.createContext({ setTimeout, clearTimeout, console, URL, innerHeight: 900, CSS: { escape: (s) => s } });
  return vm.runInContext(`
    const segments = [{ hash: "h1", text: "The Great Wall of China is visible from space with the naked eye." }];
    let expanded = ${expanded}, popEl = ${popOpen ? "{ isConnected: true }" : "null"}, popHash = "h1", popPinned = false;
    const popSteps = new Map(), docsBars = [];
    const stepOf = (h) => popSteps.get(h) ?? { step: "problem" };
    const POP_COPY = { searchHint: "Usually 10–15 seconds" };
    const DM = { ink: "#1c1c1c", hint: "#9a9ba1", body: "#737373" };
    const reducedMotion = () => true, initialsOf = () => "AB";
    let rendered = 0; const render = () => { rendered++; };
    const truncateClaim = (t, n = 70) => t.slice(0, n);
    ${sliceBetween(SRC, "  function esc(s) {", "\n  }\n")}
  }
    ${sliceBetween(SRC, "  function faviconUrl(url) {", "\n  }\n")}
  }
    ${LIVE_UI()}
    ({ noteSourcesReady, readyPingHtml, liveTitle, liveSourcesHtml, liveHint, get readyPing() { return readyPing; }, get rendered() { return rendered; } })`, ctx);
}

test("card: the stage says what is happening, and the icons are the real sites'", () => {
  const X = loadLiveUi();
  const live = { stage: "searching", t0: Date.now(), found: [], kept: null, read: {}, shown: new Set() };
  assert.equal(X.liveTitle(live), "Searching the web");
  assert.match(X.liveHint(live), /usually 10–15/);
  live.found = [{ title: "A", url: "https://www.nature.com/a", publisher: "" }, { title: "B", url: "https://cdc.gov/b", publisher: "" }, { title: "C", url: "https://dead.example/c", publisher: "" }];
  live.stage = "found";
  assert.equal(X.liveTitle(live), "Found 3 sites");
  live.kept = new Set(["https://www.nature.com/a", "https://cdc.gov/b"]);
  live.read = { "https://www.nature.com/a": "abstract", "https://cdc.gov/b": "unread" };
  live.stage = "reading";
  assert.equal(X.liveTitle(live), "Reading 2 sources");
  const html = X.liveSourcesHtml(live);
  assert.match(html, /domain=nature\.com/);
  assert.match(html, /class="read"[^>]*title="nature\.com — ✓ Read the abstract"/);
  assert.match(html, /class="faded"[^>]*title="cdc\.gov — Couldn't read"/);
  assert.match(html, /class="faded"[^>]*title="dead\.example — Link is dead"/);
  live.stage = "judging";
  assert.equal(X.liveTitle(live), "Checking which back your sentence");
});

test("card: a search finished with its card closed says so; one the writer is watching does not", () => {
  const away = loadLiveUi();
  away.noteSourcesReady("h1", 3, false);
  assert.match(away.readyPingHtml(), /3 sources ready · “The Great Wall/);
  assert.match(away.readyPingHtml(), /data-ready-show="1">Show</);
  const watching = loadLiveUi({ popOpen: true });
  watching.noteSourcesReady("h1", 3, false);
  assert.equal(watching.readyPingHtml(), "");
  const auto = loadLiveUi();
  auto.noteSourcesReady("h1", 3, true);
  assert.equal(auto.readyPingHtml(), "", "auto-sources: nobody asked");
  const none = loadLiveUi();
  none.noteSourcesReady("h1", 0, false);
  assert.match(none.readyPingHtml(), /Search finished/);
});

test("card: Keep writing closes it and never cancels; the press starts the search; a running search is not started twice", () => {
  const docs = SRC.slice(SRC.indexOf("function docsMode()"), SRC.indexOf("function fieldMode()"));
  assert.match(docs, /const keep = dmBtn\(POP_COPY\.keepWriting, false\);\s+keep\.addEventListener\("click", \(\) => \{ popPinned = false; hideDocsPopover\(\); \}\);/);
  assert.match(docs, /if \(sourcesMap\.get\(hash\)\?\.loading\) return true; \/\/ already running/);
  assert.match(docs, /src\.addEventListener\("pointerdown", \(\) => prestartClaim\(tip\.id\)\);/);
  assert.match(docs, /if \(!hasRevision && !citedHere\) action\.addEventListener\("pointerdown", \(\) => \{ fetchSources\(hash\)\.catch\(\(\) => \{\}\); \}\);/);
  assert.match(docs, /btn\.addEventListener\("pointerdown", \(\) => \{ fetchSources\(btn\.dataset\.sources\)\.catch\(\(\) => \{\}\); \}\);/);
  assert.match(docs, /btn\.addEventListener\("pointerdown", \(\) => prestartClaim\(btn\.dataset\.claimSrc\)\);/);
  assert.match(docs, /const data = await searchSources\(\{/, "the Docs search is the live one");
  assert.match(docs, /noteSourcesReady\(hash, list\.length, auto\);/);
});
