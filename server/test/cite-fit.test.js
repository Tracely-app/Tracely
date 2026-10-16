/* The wrong-source check (lib/citeFit.js, lib/prompts/citeFit.js), run by
 * POST /api/check when the extension asks with `citeFit: true` (2.21.60).
 * Owner, 2026-10-15, from an answer key marking four sentences "Correct
 * fact, wrong citation" (Venus cited to the OECD and the CDC, PISA and
 * neuroplasticity to NASA): the fact check called all four accurate. */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { citedName, citeFitCandidates, validateCiteFit, applyCiteFit, runCiteFit, CITE_FIT_MAX } from "../lib/citeFit.js";
import { CITE_FIT_SYSTEM, CITE_FIT_SCHEMA } from "../lib/prompts/citeFit.js";
import { assertStrictSchema } from "../lib/llm.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(path.join(HERE, "..", "server.js"), "utf8");

test("the name a citation gives: author and year, MLA's author and page — never a number, a document or a title", () => {
  const cases = [
    ["Venus takes 243 Earth days to rotate once (OECD, 2023).", "OECD"],
    ["UNESCO set out safeguards for generative AI (Miao & Holmes, 2023).", "Miao & Holmes"],
    ["Sleep loss slows reaction time (Smith et al., 2019, p. 4).", "Smith et al."],
    ["The guidance was updated (CDC, n.d.).", "CDC"],
    ["Gatsby never escapes his past (Klein 45).", "Klein"],
    ["Teens need 8 to 10 hours (American Academy of Sleep Medicine, 2016).", "American Academy of Sleep Medicine"],
    ["The treaty ended the war [1].", ""],
    ["The march began in Selma (Doc 3).", ""],
    ["Funding rose (\"Youth Matters\", 2025).", ""],
    ["The vote was close (see above).", ""],
    ["It was signed in (1919).", ""],
  ];
  for (const [s, want] of cases) assert.equal(citedName(s), want, s);
});

test("only the cited sentences the check called accurate are asked about, at most CITE_FIT_MAX", () => {
  const sentences = [
    { id: "a", text: "Venus takes 243 Earth days to rotate (OECD, 2023)." },
    { id: "b", text: "The brain stops growing at 18 (NASA, 2023)." },
    { id: "c", text: "Venus is hotter than Mercury." },
    { id: "d", text: "PISA tests 15-year-olds (NASA, 2023)." },
  ];
  const findings = [{ id: "a", verdict: "accurate" }, { id: "b", verdict: "false" }, { id: "c", verdict: "accurate" }, { id: "d", verdict: "accurate" }];
  assert.deepEqual(citeFitCandidates(sentences, findings).map((x) => [x.id, x.cited]), [["a", "OECD"], ["d", "NASA"]]);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, text: `Fact number ${i} (OECD, 2023).` }));
  assert.equal(citeFitCandidates(many, many.map((s) => ({ id: s.id, verdict: "accurate" }))).length, CITE_FIT_MAX);
});

test("an answer is kept only for an item asked about, and a 'wrong' without a reason is 'unsure'", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const got = validateCiteFit({ items: [
    { id: "a", fit: "wrong", source: "NASA", explanation: "The OECD does not publish planetary science; NASA does." },
    { id: "b", fit: "wrong", source: "NASA", explanation: "" },
    { id: "a", fit: "fits", source: "", explanation: "" },
    { id: "z", fit: "wrong", source: "x", explanation: "Not asked about at all, so it is dropped." },
    { id: "c", fit: "maybe", source: "", explanation: "" },
  ] }, items);
  assert.deepEqual(got.map((v) => [v.id, v.fit]), [["a", "wrong"], ["b", "unsure"], ["c", "unsure"]]);
  assert.deepEqual(validateCiteFit(null, items), []);
});

test("only 'wrong' changes a finding, and only an accurate one, to wrong_source with its reason and no rewrite", () => {
  const findings = [
    { id: "a", verdict: "accurate", explanation: "", revision: "", confidence: "medium" },
    { id: "b", verdict: "false", explanation: "x", revision: "y", confidence: "high" },
    { id: "c", verdict: "accurate", explanation: "", revision: "", confidence: "medium" },
  ];
  const out = applyCiteFit(findings, [
    { id: "a", fit: "wrong", source: "NASA", explanation: "The OECD does not publish planetary science; NASA does." },
    { id: "b", fit: "wrong", source: "NASA", explanation: "Ignored: the check already flagged this sentence." },
    { id: "c", fit: "unsure", source: "", explanation: "" },
  ]);
  assert.deepEqual(out[0], { id: "a", verdict: "wrong_source", explanation: "The OECD does not publish planetary science; NASA does.", revision: "", confidence: "medium", source: "NASA" });
  assert.deepEqual(out[1], findings[1]);
  assert.deepEqual(out[2], findings[2]);
});

test("the prompt: judge who is cited, never the claim; 'unsure' when it can't know; a strict schema", () => {
  assert.match(CITE_FIT_SYSTEM, /Never judge whether the claim is true/);
  assert.match(CITE_FIT_SYSTEM, /When in doubt, "unsure"/);
  assert.match(CITE_FIT_SYSTEM, /a person you do not know/);
  assert.deepEqual(CITE_FIT_SCHEMA.schema.properties.items.items.properties.fit.enum, ["wrong", "fits", "unsure"]);
  assert.doesNotThrow(() => assertStrictSchema(CITE_FIT_SCHEMA.schema, "citeFit"));
});

test("the mock answers by keyword, so a test page shows the card", async () => {
  const r = await runCiteFit({ items: [{ id: "a", text: "PISA tests 15-year-olds (NASA, 2023).", cited: "NASA" }, { id: "b", text: "Venus rotates slowly (NASA, 2023).", cited: "NASA" }], model: "gpt-5.6-luna", mock: true });
  assert.deepEqual(r.verdicts.map((v) => [v.id, v.fit]), [["a", "wrong"], ["b", "fits"]]);
  assert.deepEqual(await runCiteFit({ items: [], model: "gpt-5.6-luna" }), { verdicts: [], model: "gpt-5.6-luna", usage: null });
});

test("the route asks only when the request does, never for Explain in depth or the try-out, and admits the call like a shard", () => {
  const route = SERVER.slice(SERVER.indexOf('if (req.method === "POST" && api === "/api/check")'), SERVER.indexOf('if (req.method === "POST" && (url.pathname === "/api/sources"'));
  assert.match(route, /citeFit === true && !deep && !gate\.demo/);
  assert.match(route, /admitExtraCalls\(gate, worstRoute, modelUsed, 1\)/);
  assert.match(route, /json\(res, 200, \{ \.\.\.result, findings,/);
});

// The real server, in mock mode, the way kind.test.js drives it.
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
test("over HTTP: a cited sentence outside its source's remit comes back wrong_source — only when asked", async (t) => {
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(HERE, "..", "server.js")], {
    env: { ...process.env, TRACELY_MOCK: "1", PORT: String(port), TRACELY_DATA_DIR: mkdtempSync(path.join(tmpdir(), "tracely-citefit-")), SUPABASE_URL: "https://citefit-test.invalid", SUPABASE_ANON_KEY: "anon", TRACELY_LLM_PROVIDER: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/status`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  // The mock check answers accurate, questionable, no_claim in turn: these sit where it says accurate.
  const sentences = [
    { id: "s0", text: "The 2022 PISA assessment measured the reading literacy of 15-year-olds (NASA, 2023)." },
    { id: "s1", text: "Filler one." },
    { id: "s2", text: "Filler two." },
    { id: "s3", text: "Venus rotates in the opposite direction from Earth (NASA, 2023)." },
  ];
  const post = (body) => fetch(`${BASE}/api/check`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tracely-Install": "citefit-test-install" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const asked = await post({ text: sentences.map((s) => s.text).join(" "), sentences, citeFit: true });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const v = Object.fromEntries(asked.body.findings.map((f) => [f.id, f]));
  assert.equal(v.s0.verdict, "wrong_source", "NASA is not who publishes PISA");
  assert.match(v.s0.explanation, /NASA/);
  assert.equal(v.s3.verdict, "accurate", "NASA does publish this");
  const old = await post({ text: sentences.map((s) => s.text).join(" "), sentences });
  assert.equal(old.status, 200);
  assert.ok(old.body.findings.every((f) => f.verdict !== "wrong_source"), "a build that doesn't ask never receives the new verdict");
});
