/* /api/kind — the model names the kind of writing (lib/kind.js,
 * lib/prompts/kind.js). Owner, 2026-10-15, after the extension's rules alone
 * read 13.5% of new writing in the wrong group (#361): "sure-only chip now,
 * model next". The extension asks once per document and keeps its own
 * rules' answer when this one is "unsure", fails or is refused. */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runKind, validateKind, kindExcerpt, KIND_HEAD, KIND_TAIL, KIND_MAX_TOKENS, kindCacheKey, cachedKind, rememberKind, clearKindCache } from "../lib/kind.js";
import { KIND_SYSTEM_PROMPT, KIND_SCHEMA, WRITING_KIND_KEYS } from "../lib/prompts/kind.js";
import { assertStrictSchema } from "../lib/llm.js";
import { ROUTES, modelForRoute, DAILY_KIND, KIND_MIN_INTERVAL_MS } from "../shared/plan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
const CONTENT = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");

test("the prompt's kinds are the extension's 56, in the same order, and the answer is one of them or unsure", () => {
  const block = CONTENT.slice(CONTENT.indexOf("  const WRITING_KINDS = {"), CONTENT.indexOf("\n  };", CONTENT.indexOf("  const WRITING_KINDS = {")));
  const extension = [...block.matchAll(/^ {4}(\w+): WK\(/gm)].map((m) => m[1]);
  assert.equal(extension.length, 56);
  assert.deepEqual(WRITING_KIND_KEYS, extension, "lib/prompts/kind.js and content.js WRITING_KINDS name the same kinds in the same order");
  for (const k of WRITING_KIND_KEYS) assert.match(KIND_SYSTEM_PROMPT, new RegExp(`^${k}: `, "m"), `the prompt defines ${k}`);
  assert.deepEqual(KIND_SCHEMA.schema.properties.kind.enum, [...WRITING_KIND_KEYS, "unsure"]);
  assert.doesNotThrow(() => assertStrictSchema(KIND_SCHEMA.schema, "kind"));
  assert.ok(!KIND_SYSTEM_PROMPT.includes("${"), "no template left unfilled");
});

test("an answer that is not one of the kinds is unsure", () => {
  assert.equal(validateKind({ kind: "lab" }), "lab");
  assert.equal(validateKind({ kind: "unsure" }), "unsure");
  for (const bad of [{ kind: "Lab report" }, { kind: "essays" }, {}, null, { kind: 3 }]) assert.equal(validateKind(bad), "unsure", JSON.stringify(bad));
});

test("the model reads the start and the end: at most 4,000 characters", () => {
  assert.equal(KIND_HEAD + KIND_TAIL, 4_000, "PRIVACY.md says 4,000");
  const short = "Dear Ms. Lee,\n\nThank you for the reference.\n\nSincerely,\nAna";
  assert.equal(kindExcerpt(short), short);
  const long = `TITLE\n${"a".repeat(6_000)}\nSincerely,\nAna`;
  const cut = kindExcerpt(long);
  assert.ok(cut.startsWith("TITLE\n") && cut.endsWith("Sincerely,\nAna") && cut.includes("\n[…]\n"));
  assert.ok(cut.length <= 4_000 + 5);
});

test("an answer is remembered by its text: the same document again costs no call", () => {
  clearKindCache();
  const key = kindCacheKey(kindExcerpt("A memo."));
  assert.equal(cachedKind(key), null);
  rememberKind(key, "memo");
  assert.equal(cachedKind(key), "memo");
  assert.notEqual(kindCacheKey("a"), kindCacheKey("b"));
  clearKindCache();
});

test("the mock answers unsure, so a test page keeps the extension's rules", async () => {
  const r = await runKind({ text: "Anything at all.", model: "gpt-5.6-luna", effort: "low", mock: true });
  assert.equal(r.kind, "unsure");
  assert.match(r.model, /\(mock\)$/);
  assert.deepEqual(r.usage, { input: 0, output: 0, cached: 0 });
});

test("the route: an extension route, metered on its own, the fast model at low, a worst-case hold", () => {
  assert.ok(ROUTES.includes("kind"));
  assert.deepEqual(modelForRoute("kind", "free"), { model: "gpt-5.6-luna", effort: "low", maxTokens: undefined, thorough: false });
  assert.deepEqual(DAILY_KIND, { free: 60, student: 400, pro: 400 });
  assert.equal(KIND_MIN_INTERVAL_MS, 2_000);
  for (const set of ["EXTENSION_API", "PAID_ROUTES", "MODEL_ROUTES", "EXTENSION_MODEL_ROUTES"]) {
    const decl = SERVER.slice(SERVER.indexOf(`const ${set} = new Set([`), SERVER.indexOf("]);", SERVER.indexOf(`const ${set} = new Set([`)));
    assert.ok(decl.includes('"/api/kind"'), `${set} lists /api/kind`);
  }
  assert.match(SERVER, new RegExp(`"/api/kind": \\{ input: 3_000, output: ${KIND_MAX_TOKENS.toLocaleString("en-US").replace(",", "_")}, webSearchCalls: 0 \\}`), "the hold matches KIND_MAX_TOKENS");
  assert.ok(!SERVER.includes("kindPerDay"), "the entitlement response is unchanged");
});

// The real server, in mock mode, the way boundary.test.js drives it.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
let BASE;
let child;
test("over HTTP: a document in, one kind out; bad input is a 400", async (t) => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(HERE, "..", "server.js")], {
    env: { ...process.env, TRACELY_MOCK: "1", PORT: String(port), TRACELY_DATA_DIR: mkdtempSync(path.join(tmpdir(), "tracely-kind-")), SUPABASE_URL: "https://kind-test.invalid", SUPABASE_ANON_KEY: "anon", TRACELY_LLM_PROVIDER: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/status`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  const post = (body) => fetch(`${BASE}/api/kind`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tracely-Install": "kind-test-install" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const ok = await post({ text: "MEMORANDUM\nTo: All staff\nFrom: Dana\nRe: Closing\n\nPlease sign the checklist." });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.kind, "unsure", "the mock is unsure");
  assert.equal((await post({ text: "" })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ text: "x".repeat(30_001) })).status, 400, "too long");
});
