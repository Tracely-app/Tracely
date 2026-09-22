/**
 * The boundary between the two products, tested over real HTTP.
 *
 * The desktop app's AI routes and the extension's routes live in one server.
 * The extension build is under Chrome Web Store review, so nothing the desktop
 * does may change what the extension sees. These tests spawn the real server
 * (mock model, enforcement ON via a fake Supabase URL — no token is ever sent,
 * so nothing calls it) and drive desktop-shaped traffic at it, then ask the
 * extension's routes whether anything moved.
 *
 * Written before the relay prompts were ported, because the completeness
 * review of the unification plan named this as the riskiest step: shared
 * spend, shared rate limiting and a shared model switch would each have let a
 * busy desktop degrade the extension, silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* A port the OS just handed out, so it is free and ephemeral. A fixed random
 * range was not safe: Node's fetch refuses the Fetch standard's "bad ports"
 * (5060, 5061, 6000, 6566, 6665-6669, 6697 — "bad port", forever), and local
 * services hold others (AirPlay on 5000, Postgres on 5432, Discord on 6463).
 * Any of those made a test server look like it never started. */
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

let PORT;
let BASE;
let child;

async function boot() {
  for (let attempt = 0; attempt < 5; attempt++) {
    PORT = await freePort();
    BASE = `http://127.0.0.1:${PORT}`;
    let exited = false;
    child = spawn(process.execPath, [path.join(HERE, "..", "server.js")], {
      env: {
        ...process.env,
        TRACELY_MOCK: "1",
        PORT: String(PORT),
        TRACELY_DATA_DIR: mkdtempSync(path.join(tmpdir(), "tracely-boundary-")),
        SUPABASE_URL: "https://boundary-test.invalid",
        SUPABASE_ANON_KEY: "anon",
        TRACELY_LLM_PROVIDER: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("exit", () => { exited = true; });
    for (let i = 0; i < 100 && !exited; i++) {
      try { if ((await fetch(`${BASE}/api/status`)).ok && !exited) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();
    if (!exited) break; // it never came up: not a port problem
    // It exited before answering: the port was taken after the probe. Again.
  }
  throw new Error("server did not start");
}

const post = (p, body, install = "desktop-install-1") =>
  fetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tracely-Install": install }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const DRAFT = "Social media harms teenagers.\n\nStudies since 2012 show a rise in anxiety among heavy users.\n\nSchools should therefore limit phone use during the day.";
// The extension sends sentences as {id, text}, exactly like extension/content.js.
const CHECK = { text: "Water boils at 100 degrees at sea level.", sentences: [{ id: "s1", text: "Water boils at 100 degrees at sea level." }] };

test.before(boot);
test.after(() => child?.kill());

test("a burst of desktop calls does not rate-limit the same user's extension", async () => {
  const baseline = await post("/api/check", CHECK, "shared-user");
  assert.equal(baseline.status, 200);

  // 25 app calls: over the extension's 20/min, under the app's 30/min. They
  // used to share one limiter, so the 21st would 429 here AND lock out /api/check.
  for (let i = 0; i < 25; i++) {
    const r = await post("/api/structure", { text: DRAFT + " ".repeat(i) }, "shared-user");
    assert.equal(r.status, 200, `app call ${i + 1} was refused: ${JSON.stringify(r.body)}`);
  }

  const after = await post("/api/check", CHECK, "shared-user");
  assert.equal(after.status, 200, `the extension was rate-limited by desktop traffic: ${JSON.stringify(after.body)}`);
  assert.equal(after.body.modelUsed, baseline.body.modelUsed, "the extension's model moved");
  assert.deepEqual(Object.keys(after.body).sort(), Object.keys(baseline.body).sort(), "the extension's response shape moved");
});

test("the app routes have a limiter of their own", async () => {
  let refused = null;
  for (let i = 0; i < 40 && !refused; i++) {
    const r = await post("/api/structure", { text: DRAFT + "\n".repeat(i) }, "app-limit-user");
    if (r.status === 429) refused = r;
  }
  assert.ok(refused, "40 app calls in a minute were all admitted");
  assert.equal(refused.body.error.kind, "rate_limit");
  // …and the extension is still open to that same caller.
  assert.equal((await post("/api/check", CHECK, "app-limit-user")).status, 200);
});

test("a hosted app route cannot be steered to the top model through the global prefs row", async () => {
  // PUT /api/prefs has no authentication. Before appModelFor, this made every
  // app route run the thorough model for everyone. It is now refused outright
  // on a hosted server; the model check below stands either way.
  const put = await fetch(`${BASE}/api/prefs`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelStrategy: "uniform", model: "gpt-6-astra" }) });
  assert.equal(put.status, 403);
  const r = await post("/api/structure", { text: DRAFT + "prefs" }, "prefs-user");
  assert.equal(r.status, 200);
  assert.match(r.body.model, /^gpt-5.6-luna/, `an anonymous free caller ran ${r.body.model}`);
});

test("a free caller asking for the top model is clamped to the free one", async () => {
  const r = await post("/api/structure", { text: DRAFT + "ask", model: "gpt-6-astra" }, "greedy-user");
  assert.equal(r.status, 200);
  assert.match(r.body.model, /^gpt-5.6-luna/);
});

test("the extension's routes still answer exactly as before", async () => {
  const status = await fetch(`${BASE}/api/status`).then((r) => r.json());
  assert.ok("docsBridge" in status, "/api/status lost docsBridge");
  const ent = await fetch(`${BASE}/api/entitlement`, { headers: { Authorization: "Bearer not-a-real-token" } });
  assert.equal(ent.status, 200, "a bad token must still degrade to anonymous, never 401");
  const e = await ent.json();
  assert.equal(e.plan, "free");
  assert.equal(e.enforced, true);
});

// ── the desktop's reasoning, over the relay's contract ──────────────────

test("/api/grade honours a pasted rubric, and grades with the owner's rubric otherwise", async () => {
  // The web app sent `rubric` for weeks and the handler never read it, so a
  // teacher's rubric was silently replaced by Tracely's.
  const custom = await post("/api/grade", { draft: DRAFT, level: 10, rubric: "Thesis (20 points): arguable\nEvidence (30 points): cited" }, "grader");
  assert.equal(custom.status, 200, JSON.stringify(custom.body));
  assert.equal(custom.body.custom, true);
  assert.deepEqual(custom.body.components.map((c) => c.title), ["Thesis", "Evidence"]);

  const builtin = await post("/api/grade", { draft: DRAFT, level: 10 }, "grader");
  assert.equal(builtin.status, 200, JSON.stringify(builtin.body));
  assert.equal(builtin.body.custom, undefined);
  for (const key of ["thesis", "governingClaims", "warrant", "counterargument", "significance", "conclusion"]) {
    assert.ok(builtin.body.components[key], `missing component ${key}`);
    assert.equal(typeof builtin.body.components[key].reason, "string");
  }
  assert.equal(typeof builtin.body.counterargumentApplicable, "boolean");
  assert.ok(Array.isArray(builtin.body.findings));
  assert.equal(builtin.body.paragraphTexts.length, 3, "the draft's three paragraphs, split by the desktop's splitter");
});

test("the desktop's numbered grade prompt is accepted exactly as buildGradePrompt makes it", async () => {
  const prompt = "[1] Social media harms teenagers.\n\n[2] Studies since 2012 show a rise in anxiety.\n\n[3] Schools should limit phones.";
  const r = await post("/api/grade", { text: prompt }, "desktop-grader");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paragraphs.length, 3);
  assert.equal(r.body.paragraphTexts, undefined, "the desktop path returns the relay's shape, nothing added");
});

test("detect-claims: numbered sentences in, sentence indices out (the relay contract)", async () => {
  const r = await post("/api/detect-claims", { text: "[1] The sky is blue. [2] Anxiety rose 40% since 2012. [3] I like tea." }, "detector");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const idx = r.body.claims.flatMap((c) => c.sentenceIndices);
  assert.ok(idx.includes(2), JSON.stringify(r.body.claims));
  for (const c of r.body.claims) {
    assert.ok(["statistic", "causal", "factual", "prediction", "opinion"].includes(c.claimType));
    assert.equal(typeof c.searchQuery, "string");
  }
});

test("detect-claims: a raw draft is split here and each claim carries its sentence and offsets", async () => {
  const draft = "The sky is blue. Anxiety rose 40% since 2012. I like tea.";
  const r = await post("/api/detect-claims", { draft }, "detector-web");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const stat = r.body.claims.find((c) => c.claimType === "statistic");
  assert.ok(stat, JSON.stringify(r.body.claims));
  assert.equal(draft.slice(stat.start, stat.end).trim(), stat.text);
  assert.equal(stat.text, "Anxiety rose 40% since 2012.");
});

test("detect-claims: un-numbered `text` from an older caller is treated as a draft, not dropped", async () => {
  const r = await post("/api/detect-claims", { text: "Anxiety rose 40% since 2012. I like tea." }, "detector-old");
  assert.equal(r.status, 200);
  assert.ok(r.body.claims.length > 0, "a raw draft read as numbered input would come back empty");
});

test("critique: the relay request, normalised, in the relay vocabulary", async () => {
  const r = await post("/api/critique", {
    claimText: "Screens always ruin teenagers' sleep.",
    strengthScore: 55,
    evidenceSummary: "1. Screen use and adolescent sleep (2019) — heavy evening use was associated with shorter sleep.",
  }, "critic");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(["contradicted", "fabricated", "overstated", "well-supported", "partially-supported", "weak", "unsupported"].includes(r.body.verdict));
  for (const k of ["critique", "suggestedRevision", "citationFix"]) assert.ok(k in r.body, `missing ${k}`);
});

test("critique: strengthScore is required, as it was on the relay", async () => {
  const r = await post("/api/critique", { claimText: "x", evidenceSummary: "" }, "critic");
  assert.equal(r.status, 400);
});

test("critique: a reference lookup over 1200 characters is refused, as it was on the relay", async () => {
  const r = await post("/api/critique", { claimText: "x", strengthScore: null, evidenceSummary: "", referenceCheck: "y".repeat(1201) }, "critic");
  assert.equal(r.status, 400);
});

test("critique: the web app's claim + sources form gets the same reasoning", async () => {
  const r = await post("/api/critique", { claim: "Anxiety rose 40% since 2012.", sources: [{ title: "Teen anxiety trends", year: 2021, abstract: "Rates rose." }] }, "critic-web");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok("critique" in r.body && "verdict" in r.body);
});

test("correction: the relay contract, and no correction unless contradicted", async () => {
  const r = await post("/api/correction", { claimText: "The Eiffel Tower is 90 metres tall.", contradictingPassages: ["The tower is 330 metres tall."] }, "corrector");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(typeof r.body.contradicted, "boolean");
  if (!r.body.contradicted) assert.equal(r.body.correction, null);
  const bad = await post("/api/correction", { claimText: "x", contradictingPassages: [] }, "corrector");
  assert.equal(bad.status, 400);
});

test("tracer: stateless (desktop) and stored (web app) forms both answer", async () => {
  const stateless = await post("/api/tracer", { message: "Is my thesis arguable?", history: [{ role: "user", content: "hi" }, { role: "tracer", content: "hello" }], context: "Draft text" }, "tracer-desk");
  assert.equal(stateless.status, 200, JSON.stringify(stateless.body));
  assert.equal(typeof stateless.body.reply, "string");
  assert.equal(stateless.body.conversationId, undefined);

  const stored = await post("/api/tracer", { message: "Is my thesis arguable?", draft: "Draft text" }, "tracer-web");
  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  assert.equal(typeof stored.body.conversationId, "string");
});

test("find-sources: the relay's found_sources shape", async () => {
  const r = await post("/api/find-sources", { claim: "Anxiety rose 40% among teenagers since 2012." }, "finder");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const k of ["searchesRun", "assertions", "sources", "claimProblem", "revisedClaim", "disputed", "note"]) assert.ok(k in r.body, `missing ${k}`);
});

test("find-sources draws on the free source allowance, not the AI one", async () => {
  // Five a day on the free plan, shared with the extension's /api/sources.
  let refused = null;
  for (let i = 0; i < 8 && !refused; i++) {
    const r = await post("/api/find-sources", { claim: `Claim number ${i} about teenagers and phones.` }, "finder-quota");
    if (r.status === 429) refused = r;
  }
  assert.ok(refused, "the free source allowance never ran out");
  assert.equal(refused.body.error.kind, "plan_limit");
  // The §7 copy of the 2026-09-21 plan policy.
  assert.match(refused.body.error.message, /You've used today's 5 source searches\. They reset at midnight\./);
});
