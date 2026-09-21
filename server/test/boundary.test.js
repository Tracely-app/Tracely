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
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4800 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

async function boot() {
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
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/status`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
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
  // app route run the thorough model for everyone.
  const put = await fetch(`${BASE}/api/prefs`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelStrategy: "uniform", model: "gpt-6-astra" }) });
  assert.equal(put.status, 200);
  const r = await post("/api/structure", { text: DRAFT + "prefs" }, "prefs-user");
  assert.equal(r.status, 200);
  assert.match(r.body.model, /^gpt-5-nano/, `an anonymous free caller ran ${r.body.model}`);
});

test("a free caller asking for the top model is clamped to the free one", async () => {
  const r = await post("/api/structure", { text: DRAFT + "ask", model: "gpt-6-astra" }, "greedy-user");
  assert.equal(r.status, 200);
  assert.match(r.body.model, /^gpt-5-nano/);
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
