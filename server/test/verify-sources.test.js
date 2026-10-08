/* The desktop's receipts: POST /api/verify-sources (lib/reasoning.js
 * verifySources, over the extension's verifier in lib/sourceVerify.js).
 *
 * 2026-10-07: three judges graded the 145 sources the desktop's search showed
 * across 36 claims, and 15 (10%) backed their sentence. The desktop now sends
 * a list the writer OPENS here, and a source is offered for citing only with
 * the words from it that back the sentence. What is tested:
 *   - the request is validated and clamped before anything is counted;
 *   - the receipt for every state (backs, contradicts, topic, unread,
 *     retracted) is built from what THE verifier decided — no second one;
 *   - the work's own abstract, when the desktop sends one, is read like
 *     OpenAlex's, and never instead of it;
 *   - a judge that fails is a 502 (the desktop's "couldn't check" fallback),
 *     never a list of "unread";
 *   - mock mode answers in the real shape;
 *   - over real HTTP on a hosted server: the fast model at low, the APP pool,
 *     one AI action and no source search, and the extension cannot call it.
 * The boundary with the extension's routes is in boundary.test.js. */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setHostResolver } from "../lib/citeMeta.js";
import { OPENALEX_WORK, VERIFY_SYSTEM } from "../lib/sourceVerify.js";
import { verifySourcesInput, verifySources, VERIFY_LIMITS } from "../lib/reasoning.js";
import { usageDay, modelForRoute, ROUTES } from "../shared/plan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(path.join(HERE, "..", "server.js"), "utf8");

test.before(() => setHostResolver(async () => [{ address: "93.184.216.34" }]));
test.after(() => setHostResolver(null));

const CLAIM = "Spending on youth facilities fell by 73% between 2010/11 and 2022/23.";
const BACKING = "Between 2010/11 and 2022/23, spending on youth facilities fell by 73%, leaving gaps in services across much of the country.";
const TOPICAL = "Youth work can be the best placed service for reinvestment after a decade of austerity cuts to youth services in England.";
const toIndex = (text) => { const idx = {}; text.split(" ").forEach((w, i) => { (idx[w] ??= []).push(i); }); return idx; };

function fakeFetch(routes) {
  const hits = [];
  const f = async (url) => {
    const u = String(url);
    hits.push(u);
    for (const [k, v] of Object.entries(routes)) if (u.includes(k)) {
      return { ok: v.status ? v.status < 400 : true, status: v.status ?? 200, headers: { get: (h) => (h.toLowerCase() === "content-type" ? v.type ?? "text/html" : null) }, json: async () => v.json, text: async () => v.text ?? "" };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
  };
  f.hits = hits;
  return f;
}
const OPENALEX = OPENALEX_WORK.replace("https://", "");

// ── the request ──────────────────────────────────────────────────────────

test("the request: a claim and 1-8 sources with unique ids, refused before anything is read", () => {
  const ok = { claim: CLAIM, sources: [{ id: "a", title: "T" }] };
  assert.equal(verifySourcesInput(ok).sources.length, 1);
  for (const [body, why] of [
    [{}, /claim required/],
    [{ claim: "  " , sources: [{ id: "a" }] }, /claim required/],
    [{ claim: CLAIM }, /sources required/],
    [{ claim: CLAIM, sources: [] }, /sources required/],
    [{ claim: CLAIM, sources: Array.from({ length: VERIFY_LIMITS.sources + 1 }, (_, i) => ({ id: `s${i}` })) }, /at most 8 sources/],
    [{ claim: CLAIM, sources: [{ title: "no id" }] }, /needs an id/],
    [{ claim: CLAIM, sources: [{ id: "a" }, { id: "a" }] }, /unique/],
  ]) {
    assert.throws(() => verifySourcesInput(body), (err) => err.kind === "bad_request" && err.status === 400 && why.test(err.message), JSON.stringify(body).slice(0, 80));
  }
});

test("the request: every string clamped (never refused for length), a non-web url and a junk year dropped", () => {
  const long = "x".repeat(20_000);
  const { claim, context, sources: [s] } = verifySourcesInput({
    claim: long,
    context: long,
    sources: [{ id: "i".repeat(500), title: long, url: "javascript:alert(1)", doi: long, abstract: long, venue: long, year: 2019.5 }],
  });
  assert.equal(claim.length, 2000);
  assert.equal(context.length, VERIFY_LIMITS.contextChars);
  assert.deepEqual(
    [s.id.length, s.title.length, s.url, s.doi.length, s.abstract.length, s.venue.length, s.year],
    [VERIFY_LIMITS.idChars, VERIFY_LIMITS.titleChars, "", VERIFY_LIMITS.doiChars, VERIFY_LIMITS.abstractChars, VERIFY_LIMITS.venueChars, null],
  );
  assert.equal(verifySourcesInput({ claim: "c", sources: [{ id: "a", url: "https://x.example/p", year: 2021 }] }).sources[0].url, "https://x.example/p");
});

// ── the receipts, from THE verifier ──────────────────────────────────────

test("receipts: backs and contradicts carry the source's own words and where they were read; topic and unread carry none", async () => {
  delete process.env.TRACELY_MOCK;
  const fetchImpl = fakeFetch({
    "10.1234%2Fbacks": { json: { abstract_inverted_index: toIndex(BACKING) } },
    "10.1234%2Fsays-other": { json: { abstract_inverted_index: toIndex("Spending on youth facilities fell by 12% between 2010/11 and 2022/23, according to the county survey.") } },
    "10.1234%2Ftopical": { json: { abstract_inverted_index: toIndex(TOPICAL) } },
    "paywall.example": { status: 403 },
  });
  let sent = null;
  const call = async (req) => {
    sent = req;
    return {
      parsed: { verdicts: [
        { id: 0, verdict: "backs", quote: "spending on youth facilities fell by 73%" },
        { id: 1, verdict: "contradicts", quote: "Spending on youth facilities fell by 12%" },
        { id: 2, verdict: "topic", quote: "" },
      ] },
      usage: { input: 1200, output: 90, cached: 0 },
    };
  };
  const r = await verifySources({
    claim: CLAIM,
    sources: [
      { id: "a", title: "Youth Matters", doi: "10.1234/backs" },
      { id: "b", title: "County survey", doi: "10.1234/says-other" },
      { id: "c", title: "Levelling up youth work", doi: "10.1234/topical" },
      { id: "d", title: "Walled", url: "https://paywall.example/x" },
    ],
    model: "gpt-5.6-luna",
    call,
    fetchImpl,
  });
  assert.equal(sent.system, VERIFY_SYSTEM, "THE verifier's own judge, not a second prompt");
  assert.equal(sent.effort, "low");
  assert.deepEqual(r.receipts, [
    { id: "a", verdict: "backs", quote: "spending on youth facilities fell by 73%", readFrom: "abstract" },
    { id: "b", verdict: "contradicts", quote: "Spending on youth facilities fell by 12%", readFrom: "abstract" },
    { id: "c", verdict: "topic", readFrom: "abstract" },
    { id: "d", verdict: "unread" },
  ]);
  assert.equal(r.usage.input, 1200);
  assert.deepEqual([r.tally.read, r.tally.backs, r.tally.contradicts, r.tally.topic, r.tally.unread], [3, 1, 1, 1, 1]);
});

test("receipts: a quote that is not in the source's text is topic, never backs", async () => {
  delete process.env.TRACELY_MOCK;
  const fetchImpl = fakeFetch({ "10.1234%2Ftopical": { json: { abstract_inverted_index: toIndex(TOPICAL) } } });
  const call = async () => ({ parsed: { verdicts: [{ id: 0, verdict: "backs", quote: "support for youth leadership has increased" }] }, usage: null });
  const r = await verifySources({ claim: CLAIM, sources: [{ id: "a", title: "Ord & Davies", doi: "10.1234/topical" }], model: "m", call, fetchImpl });
  assert.deepEqual(r.receipts, [{ id: "a", verdict: "topic", readFrom: "abstract" }]);
  assert.equal(r.tally.unquoted, 1);
});

test("the desktop's own abstract is read when OpenAlex has none — never instead of OpenAlex's, and never fetched for", async () => {
  delete process.env.TRACELY_MOCK;
  const fetchImpl = fakeFetch({
    "10.1234%2Fopenalex-has-it": { json: { abstract_inverted_index: toIndex(BACKING) } },
    "10.1234%2Fopenalex-has-none": { json: { abstract_inverted_index: null } },
  });
  let user = "";
  const call = async (req) => { user = req.user; return { parsed: { verdicts: [0, 1, 2].map((id) => ({ id, verdict: "backs", quote: "spending on youth facilities fell by 73%" })) }, usage: null }; };
  const r = await verifySources({
    claim: CLAIM,
    sources: [
      // OpenAlex answers: its abstract is what is read, whatever was sent.
      { id: "a", title: "A", doi: "10.1234/openalex-has-it", abstract: TOPICAL },
      // OpenAlex has none: the desktop's copy is read.
      { id: "b", title: "B", doi: "10.1234/openalex-has-none", abstract: BACKING },
      // No DOI, no url: only the desktop's copy, and nothing is fetched for it.
      { id: "c", title: "C", abstract: BACKING },
    ],
    model: "m",
    call,
    fetchImpl,
  });
  assert.deepEqual(r.receipts.map((x) => [x.id, x.verdict, x.readFrom]), [["a", "backs", "abstract"], ["b", "backs", "abstract"], ["c", "backs", "abstract"]]);
  assert.ok(!user.includes("best placed service"), "OpenAlex's abstract wins over the one sent");
  assert.equal(fetchImpl.hits.length, 2, "one OpenAlex lookup per DOI and nothing else");
});

test("a retracted work comes back retracted, for the desktop to drop; nothing read means no model call", async () => {
  delete process.env.TRACELY_MOCK;
  const fetchImpl = fakeFetch({ "10.1234%2Fwakefield": { json: { is_retracted: true, abstract_inverted_index: toIndex(BACKING) } } });
  const r = await verifySources({
    claim: CLAIM,
    sources: [{ id: "w", title: "Ileal-lymphoid-nodular hyperplasia", doi: "10.1234/wakefield" }, { id: "x", title: "Nothing to read" }],
    model: "m",
    call: async () => { throw new Error("not called: nothing was read"); },
    fetchImpl,
  });
  assert.deepEqual(r.receipts, [{ id: "w", verdict: "unread", retracted: true }, { id: "x", verdict: "unread" }]);
});

test("a judge that fails is a 502 carrying what it billed — never a list of 'unread'", async () => {
  delete process.env.TRACELY_MOCK;
  const call = async () => { throw Object.assign(new Error("model down"), { llm: { usage: { input: 7, output: 0 } } }); };
  await assert.rejects(
    verifySources({ claim: CLAIM, sources: [{ id: "c", title: "C", abstract: BACKING }], model: "gpt-5.6-luna", call, fetchImpl: fakeFetch({}) }),
    (err) => err.status === 502 && err.kind === "server" && err.llm?.usage?.input === 7 && err.llm.model === "gpt-5.6-luna",
  );
});

test("mock: the real shape, every state reachable, quotes taken verbatim from what was sent", async () => {
  process.env.TRACELY_MOCK = "1";
  try {
    const abs = (n) => `Finding number ${n} is stated plainly here. More text follows.`;
    const r = await verifySources({
      claim: CLAIM,
      model: "gpt-5.6-luna",
      sources: [
        { id: "1", title: "One", abstract: abs(1) },
        { id: "2", title: "Two", abstract: abs(2) },
        { id: "3", title: "Three", abstract: abs(3) },
        { id: "4", title: "No abstract", url: "https://x.example/" },
        { id: "5", title: "A retracted paper", abstract: abs(5) },
      ],
    });
    assert.deepEqual(r.receipts, [
      { id: "1", verdict: "backs", quote: "Finding number 1 is stated plainly here.", readFrom: "abstract" },
      { id: "2", verdict: "topic", readFrom: "abstract" },
      { id: "3", verdict: "contradicts", quote: "Finding number 3 is stated plainly here.", readFrom: "abstract" },
      { id: "4", verdict: "unread" },
      { id: "5", verdict: "unread", retracted: true },
    ]);
    assert.match(r.model, /\(mock\)$/);
  } finally {
    delete process.env.TRACELY_MOCK;
  }
});

// ── the route ────────────────────────────────────────────────────────────

test("wired: an APP route (appGate/appCall), never the extension's; the fast model at low", () => {
  assert.match(SERVER_SRC, /const APP_AI_ROUTES = new Set\(\[[^\]]*"\/api\/verify-sources"/);
  const ext = /const EXTENSION_API = new Set\(\[([^\]]*)\]\)/.exec(SERVER_SRC)[1];
  assert.ok(!ext.includes("/api/verify-sources"), "the extension can never reach it");
  const paid = /const PAID_ROUTES = new Set\(\[([^\]]*)\]\)/.exec(SERVER_SRC)[1];
  assert.ok(!paid.includes("/api/verify-sources"), "never spendGate's pools");
  assert.match(SERVER_SRC, /route: "verifySources",/);
  assert.ok(ROUTES.includes("verifySources"));
  for (const plan of ["free", "student", "pro"]) {
    assert.deepEqual(modelForRoute("verifySources", plan, { requested: "gpt-6-astra", thoroughAvailable: true }), { model: "gpt-5.6-luna", effort: "low", maxTokens: undefined, thorough: false }, plan);
  }
});

/* ── over HTTP, on a hosted server with OpenAI stubbed ───────────────────
 * The same harness as sources-quota.test.js: a fake Supabase (tokens
 * "tok-<plan>-<name>"), and an OpenAI stub preloaded into the server process
 * that logs what it was sent and answers the verifier's schema. */
const TMP = mkdtempSync(path.join(tmpdir(), "tracely-verify-"));
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });
const OPENAI_LOG = path.join(TMP, "openai.jsonl");
const STUB = path.join(TMP, "openai-stub.mjs");
writeFileSync(OPENAI_LOG, "");
writeFileSync(STUB, `
import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith("https://api.openai.com/")) return real(url, init);
  const body = JSON.parse(init.body);
  const input = JSON.stringify(body.input);
  const tag = (/TAG-([\\w-]+)/.exec(input) || [])[1] || null;
  appendFileSync(process.env.TRACELY_TEST_OPENAI_LOG, JSON.stringify({ tag, model: body.model, effort: body.reasoning?.effort ?? null, maxTokens: body.max_output_tokens ?? null, schema: body.text?.format?.name ?? null }) + "\\n");
  const verdicts = [{ id: 0, verdict: "backs", quote: "spending on youth facilities fell by 73%" }, { id: 1, verdict: "topic", quote: "" }];
  return new Response(JSON.stringify({ status: "completed", model: body.model, usage: { input_tokens: 4000, output_tokens: 600 }, output_text: JSON.stringify({ verdicts }) }), { status: 200, headers: { "Content-Type": "application/json" } });
};
`);
const openaiLog = (tag) => readFileSync(OPENAI_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.tag === tag);

const supabase = http.createServer((req, res) => {
  const m = /^Bearer tok-(free|student|pro)-([\w-]+)$/.exec(req.headers.authorization ?? "");
  const user = req.url === "/auth/v1/user" && m ? { id: `u-${m[1]}-${m[2]}`, email: `${m[2]}@example.test`, app_metadata: m[1] === "free" ? {} : { plan: m[1] } } : undefined;
  res.writeHead(user ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify(user ?? { msg: "invalid token" }));
});
const SCRUB = ["TRACELY_BETA_TOKENS", "TRACELY_BETA_DAILY_BUDGET_USD", "TRACELY_DAILY_BUDGET_USD", "TRACELY_APP_DAILY_BUDGET_USD", "TRACELY_PAID_DAILY_BUDGET_USD",
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "OPENAI_API_KEY", "TRACELY_MOCK", "TRACELY_EXTENSION_ID", "TRACELY_TRUSTED_PROXY_HOPS", "TRACELY_LLM_PROVIDER"];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.includes(k)));
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
let S;
async function boot(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = await freePort();
    const dataDir = mkdtempSync(path.join(TMP, "data-"));
    const child = spawn(process.execPath, ["--import", pathToFileURL(STUB).href, path.join(HERE, "..", "server.js")], {
      env: { ...baseEnv, PORT: String(p), TRACELY_DATA_DIR: dataDir, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let exited = false;
    child.on("exit", () => { exited = true; });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const base = `http://127.0.0.1:${p}`;
    for (let i = 0; i < 200 && !exited; i++) {
      try { if ((await fetch(`${base}/api/status`)).ok && !exited) return { base, child, dataDir, log: () => out }; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();
    if (!exited) throw new Error(`server on ${p} did not start: ${out}`);
  }
  throw new Error("could not find a free port for a test server");
}
const call = (p, { body, token, headers = {} } = {}) =>
  fetch(`${S.base}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
function usage(account, kind) {
  const db = new DatabaseSync(path.join(S.dataDir, "tracely.db"));
  try {
    return db.prepare("SELECT count FROM entitlement_usage WHERE account_id = ? AND day = ? AND kind = ?").get(account, usageDay(Date.now()), kind)?.count ?? 0;
  } finally {
    db.close();
  }
}

test.describe("over HTTP on a hosted server", () => {
  test.before(async () => {
    await new Promise((r) => supabase.listen(0, "127.0.0.1", r));
    S = await boot({
      SUPABASE_URL: `http://127.0.0.1:${supabase.address().port}`, SUPABASE_ANON_KEY: "anon",
      OPENAI_API_KEY: "sk-test-not-a-real-key", TRACELY_TEST_OPENAI_LOG: OPENAI_LOG,
      TRACELY_APP_DAILY_BUDGET_USD: "20", TRACELY_DAILY_BUDGET_USD: "20",
    });
  });
  test.after(() => { S?.child.kill(); supabase.close(); });

  const LIST = (tag) => ({
    claim: `${CLAIM} TAG-${tag}`,
    model: "gpt-6-astra", // asked for; never read on this route
    effort: "high",
    // Abstracts only, so nothing leaves the test machine but the stubbed model call.
    sources: [{ id: "src-a", title: "Youth Matters", abstract: BACKING }, { id: "src-b", title: "Levelling up", abstract: TOPICAL }],
  });

  test("the fast model at low under the verifier's ceiling; spend in the APP pool; one AI action and no source search", async () => {
    const appBefore = usage("__global_app__", "spend_ucents");
    const extBefore = usage("__global__", "spend_ucents");
    const r = await call("/api/verify-sources", { body: LIST("http-1"), token: "tok-free-verifier" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.receipts, [
      { id: "src-a", verdict: "backs", quote: "spending on youth facilities fell by 73%", readFrom: "abstract" },
      { id: "src-b", verdict: "topic", readFrom: "abstract" },
    ]);
    assert.equal(r.body.tally, undefined, "the tallies are the log line's, not the response's");
    assert.deepEqual(openaiLog("http-1").map((c) => [c.model, c.effort, c.maxTokens, c.schema]), [["gpt-5.6-luna", "low", 2000, "verdicts"]]);
    assert.ok(usage("__global_app__", "spend_ucents") > appBefore, "billed to the desktop's pool");
    assert.equal(usage("__global__", "spend_ucents"), extBefore, "never the extension's");
    assert.equal(usage("user:u-free-verifier", "ai"), 1, "one AI action per opened list");
    assert.equal(usage("user:u-free-verifier", "source_search"), 0, "nothing was searched, so no source search is spent");
    assert.match(S.log(), /\/api\/verify-sources gpt-5\.6-luna sources=2 read=2 backs=1 contradicts=0 topic=1 unread=0 retracted=0 unquoted=0 ms=\d+/);
    assert.doesNotMatch(S.log(), /youth facilities/, "the log line carries no text");
  });

  test("a bad body is a 400 before it is counted; preflight's empty POST is a 400, not a 404", async () => {
    const before = usage("user:u-free-badbody", "ai");
    for (const body of [{}, { claim: "x", sources: [] }, { claim: "x", sources: Array.from({ length: 9 }, (_, i) => ({ id: String(i) })) }]) {
      const r = await call("/api/verify-sources", { body, token: "tok-free-badbody" });
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(r.body.error.kind, "bad_request");
    }
    assert.equal(usage("user:u-free-badbody", "ai"), before);
  });

  test("the extension cannot call it: a chrome-extension origin is refused", async () => {
    const r = await call("/api/verify-sources", { body: LIST("ext"), headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
    assert.equal(r.status, 403);
    assert.equal(openaiLog("ext").length, 0);
  });
});
