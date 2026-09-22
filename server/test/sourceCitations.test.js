/**
 * /api/sources' citation fields, end to end: what is sent to the model, what
 * survives validation, and what the extension's route answers.
 *
 * The route is frozen to ADDITIVE changes while an extension build is in
 * review (CLAUDE.md): the five fields every client reads keep their names,
 * types and meaning, and the citation fields ride alongside, optional.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSources } from "../lib/factcheck.js";
import { SOURCE_KINDS } from "../lib/citeFields.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD_FIELDS = ["title", "url", "publisher", "snippet", "stance"];
const CITE_FIELDS = ["kind", "authors", "groupAuthor", "year", "date", "container", "editors", "doi"];

function assertSourceShape(s, label) {
  assert.deepEqual(Object.keys(s).slice(0, 5), OLD_FIELDS, `${label}: the five old fields, first`);
  for (const k of ["title", "url", "publisher", "snippet"]) assert.equal(typeof s[k], "string", `${label}.${k}`);
  assert.ok(["supports", "refutes", "context"].includes(s.stance), `${label}.stance`);
  for (const k of Object.keys(s).slice(5)) assert.ok(CITE_FIELDS.includes(k), `${label}: unexpected field ${k}`);
  if ("kind" in s) assert.ok(SOURCE_KINDS.includes(s.kind), `${label}.kind`);
  if ("authors" in s) assert.ok(Array.isArray(s.authors) && s.authors.every((a) => typeof a === "string"), `${label}.authors`);
  if ("groupAuthor" in s) assert.equal(typeof s.groupAuthor, "string", `${label}.groupAuthor`);
  if ("year" in s) assert.ok(s.year === null || Number.isInteger(s.year), `${label}.year`);
  if ("date" in s) assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/, `${label}.date`);
  if ("editors" in s) assert.ok("container" in s, `${label}: editors without a container`);
}

// ── the model call ────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

function openai(reply) {
  const calls = [];
  process.env.OPENAI_API_KEY = "sk-test";
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ status: "completed", model: "gpt-5.6-luna", usage: { input_tokens: 10, output_tokens: 10 }, ...reply }), { status: 200 });
  };
  return calls;
}

test("findSources asks for the citation fields in a strict schema, and leaves the search optional", async () => {
  const calls = openai({ output_text: JSON.stringify({ sources: [] }), output: [{ type: "message", content: [{ type: "output_text", text: "{}", annotations: [{ type: "url_citation", url: "https://a.org/x", title: "A" }] }] }] });
  await findSources({ claim: "Migrants were 3.6 percent of the world's population in 2020.", model: "gpt-5.6-luna" });
  const body = calls[0];
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.equal(body.tool_choice, undefined, "the extension's search was never forced; that is not changed here");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.name, "sources");
  assert.equal(body.text.format.strict, true);
  const item = body.text.format.schema.properties.sources.items;
  assert.deepEqual(item.required, [...OLD_FIELDS, ...CITE_FIELDS]);
  assert.deepEqual(item.properties.kind.enum, SOURCE_KINDS);
  assert.deepEqual(item.properties.year.type, ["integer", "null"]);
  assert.match(body.instructions, /copy ONLY what the source itself states; never guess/);
  assert.match(body.instructions, /Empty is correct/);
});

test("findSources validates what the model wrote; harvested citations carry no citation fields", async () => {
  openai({
    output_text: JSON.stringify({ sources: [
      { title: "World Migration Report 2024: Chapter 2", url: "https://publications.iom.int/books/world-migration-report-2024-chapter-2", publisher: "International Organization for Migration", snippet: "About 281 million international migrants in 2020.", stance: "supports",
        kind: "book", authors: ["International Organization for Migration"], groupAuthor: "", year: 2020, date: "", container: "World Migration Report 2024", editors: ["Marie McAuliffe", "Linda Adhiambo Oucho"], doi: "" },
      { title: "Composting", url: "https://www.npr.org/2020/04/07/828918397/how-to-compost-at-home", publisher: "npr.org", snippet: "s", stance: "context",
        kind: "News", authors: ["Julia Simon", "Staff", "npr.org"], groupAuthor: "npr.org", year: 2021, date: "2020-04-09", container: "", editors: ["Somebody"], doi: "https://doi.org/10.1000/xyz123" },
    ] }),
    output: [{ type: "message", content: [{ type: "output_text", text: "x", annotations: [{ type: "url_citation", url: "https://www.un.org/en/global-issues/migration", title: "Migration | United Nations" }] }] }],
  });
  const r = await findSources({ claim: "Migrants were 3.6 percent of the world's population in 2020.", model: "gpt-5.6-luna" });
  assert.equal(r.sources.length, 3);
  r.sources.forEach((s, i) => assertSourceShape(s, `sources[${i}]`));
  const [iom, npr, harvested] = r.sources;
  // The organisation filed as a person became the group author; 2020 is the
  // CMS date the title contradicts.
  assert.deepEqual(iom, {
    title: "World Migration Report 2024: Chapter 2", url: "https://publications.iom.int/books/world-migration-report-2024-chapter-2", publisher: "International Organization for Migration", snippet: "About 281 million international migrants in 2020.", stance: "supports",
    kind: "book", authors: [], groupAuthor: "International Organization for Migration", year: null, container: "World Migration Report 2024", editors: ["Marie McAuliffe", "Linda Adhiambo Oucho"],
  });
  // A year and a date that disagree: neither. Editors of no container: none.
  assert.deepEqual(npr, {
    title: "Composting", url: "https://www.npr.org/2020/04/07/828918397/how-to-compost-at-home", publisher: "npr.org", snippet: "s", stance: "context",
    kind: "news", authors: ["Julia Simon"], groupAuthor: "", year: null, doi: "10.1000/xyz123",
  });
  assert.deepEqual(harvested, { title: "Migration | United Nations", url: "https://www.un.org/en/global-issues/migration", publisher: "un.org", snippet: "", stance: "context" });
});

test("findSources still reads an old-shaped answer (no citation fields) exactly as before", async () => {
  openai({ output_text: JSON.stringify({ sources: [{ title: "A", url: "https://a.example/", publisher: "a", snippet: "s", stance: "supports" }] }) });
  const r = await findSources({ claim: "Water boils at 100 degrees Celsius at sea level.", model: "gpt-5.6-luna" });
  assert.deepEqual(r.sources, [{ title: "A", url: "https://a.example/", publisher: "a", snippet: "s", stance: "supports" }]);
});

test("the mock answers in the real shape, through the same validation", async () => {
  const r = await findSources({ claim: "The Great Wall is visible from space.", model: "gpt-5.6-luna", mock: true });
  assert.equal(r.model, "gpt-5.6-luna (mock)");
  assert.equal(r.sources.length, 3);
  r.sources.forEach((s, i) => assertSourceShape(s, `mock[${i}]`));
  for (const s of r.sources) {
    assert.ok(s.snippet.startsWith("[mock] "));
    for (const k of ["kind", "authors", "groupAuthor", "year"]) assert.ok(k in s, `mock carries ${k}`);
  }
  assert.deepEqual(r.sources.map((s) => s.kind), ["reference", "institutional", "news"]);
  assert.equal(r.sources[1].groupAuthor, "NASA");
});

// ── the route, over HTTP, in TRACELY_MOCK ──────────────────────────────

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
      env: { ...process.env, TRACELY_MOCK: "1", PORT: String(port), TRACELY_DATA_DIR: mkdtempSync(path.join(tmpdir(), "tracely-sources-")), OPENAI_API_KEY: "", SUPABASE_URL: "", SUPABASE_ANON_KEY: "", TRACELY_LLM_PROVIDER: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("exit", () => { exited = true; });
    for (let i = 0; i < 100 && !exited; i++) {
      try { if ((await realFetch(`${BASE}/api/status`)).ok && !exited) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();
    if (!exited) break;
  }
  throw new Error("server did not start");
}
const post = (p, body) => realFetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tracely-Install": "sources-test" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test("TRACELY_MOCK /api/sources answers the citation fields alongside the old ones", { concurrency: false }, async (t) => {
  await boot();
  t.after(() => child?.kill());
  const r = await post("/api/sources", { claim: "The Great Wall of China is visible from space." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const k of ["sources", "model", "usage", "modelUsed", "plan", "ms"]) assert.ok(k in r.body, `missing ${k}`);
  r.body.sources.forEach((s, i) => assertSourceShape(s, `route[${i}]`));
  assert.ok(r.body.sources.every((s) => "kind" in s && "year" in s));

  // /api/cite-url is wired to the moved function, with its messages unchanged.
  const bad = await post("/api/cite-url", { url: "http://127.0.0.1:1/private" });
  assert.deepEqual(bad, { status: 400, body: { error: { kind: "bad_request", message: "Local and private addresses can't be cited" } } });
});
