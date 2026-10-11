/* The route-test harness for Tracer Voice (test/voice-routes.test.js): a
 * real server.js on a free port with its own data dir, a fake Supabase
 * ("tok-<plan>-<name>" → user "u-<plan>-<name>"), and a stub preloaded into
 * the server process that replaces BOTH network edges lib/voice.js uses:
 *
 *  - globalThis.fetch for POST https://api.openai.com/v1/live/sessions:
 *    logs {headers, body} and answers 201 {session:{id}, transport:{sdp}};
 *  - globalThis.WebSocket, the sideband: a scripted fake that logs every
 *    attach and every message the server sends.
 *
 * The test picks a script per call through the SDP offer: a line
 * "a=x-test:<mode>" becomes the session id "live_<mode>_<n>", which the fake
 * socket reads from its URL. Modes: ok (usage 61.5 s, closes on
 * session.close), ticks (one second every 30 ms), nows (the attach fails),
 * slow (ok, but OpenAI takes 300 ms to answer).
 * Nothing touches the network. */
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { usageDay } from "../../shared/plan.js";

const STUB_SOURCE = String.raw`
import { appendFileSync } from "node:fs";
const log = (o) => appendFileSync(process.env.TRACELY_TEST_VOICE_LOG, JSON.stringify(o) + "\n");
const realFetch = globalThis.fetch;
let n = 0;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith("https://api.openai.com/")) return realFetch(url, init);
  const body = JSON.parse(init.body);
  const mode = (/a=x-test:(\w+)/.exec(body?.transport?.sdp ?? "") || [])[1] || "ok";
  log({ kind: "create", url: String(url), headers: init.headers, body });
  if (mode === "slow") await new Promise((r) => setTimeout(r, 300));
  return new Response(JSON.stringify({ session: { id: "live_" + mode + "_" + ++n }, transport: { type: "webrtc", sdp: "v=0\r\no=openai answer\r\n" } }), { status: 201, headers: { "Content-Type": "application/json" } });
};
class FakeSideband extends EventTarget {
  constructor(url, opts = {}) {
    super();
    this.url = url;
    this.sessionId = (/sessions\/([^/]+)\/attach/.exec(url) || [])[1];
    this.mode = (/^live_(\w+?)_\d+$/.exec(this.sessionId) || [])[1];
    this.seconds = 0;
    this.closed = false;
    log({ kind: "attach", url, sessionId: this.sessionId, keyed: opts.headers?.Authorization === "Bearer " + process.env.OPENAI_API_KEY, safetyId: opts.headers?.["OpenAI-Safety-Identifier"] ?? null });
    setTimeout(() => {
      if (this.mode === "nows") { this.dispatchEvent(new Event("error")); return; }
      this.dispatchEvent(new Event("open"));
      this.emit({ type: "session.started", session: { id: this.sessionId } });
      if (this.mode === "ticks") this.timer = setInterval(() => { this.seconds += 1; this.emit({ type: "session.usage.updated", usage: { seconds: this.seconds } }); }, 30);
      else { this.seconds = 61.5; this.emit({ type: "session.usage.updated", usage: { seconds: 61.5 } }); }
    }, 5);
  }
  emit(ev) { if (!this.closed) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(ev) })); }
  send(data) {
    const message = JSON.parse(data);
    log({ kind: "send", sessionId: this.sessionId, atSeconds: this.seconds, message });
    if (message.type === "session.close") setTimeout(() => {
      clearInterval(this.timer);
      this.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: this.seconds } });
      this.close();
    }, 5);
  }
  close() { if (this.closed) return; this.closed = true; clearInterval(this.timer); this.dispatchEvent(new Event("close")); }
}
globalThis.WebSocket = FakeSideband;
`;

const SCRUB = ["TRACELY_BETA_TOKENS", "TRACELY_BETA_DAILY_BUDGET_USD", "TRACELY_DAILY_BUDGET_USD", "TRACELY_APP_DAILY_BUDGET_USD", "TRACELY_PAID_DAILY_BUDGET_USD",
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "OPENAI_API_KEY", "TRACELY_MOCK", "TRACELY_EXTENSION_ID", "TRACELY_TRUSTED_PROXY_HOPS", "TRACELY_LLM_PROVIDER",
  "TRACELY_VOICE_MAX_SECONDS", "TRACELY_VOICE_DAILY_SECONDS", "TRACELY_SAFETY_ID_SECRET"];

/** A scratch directory holding the stub and the stub's log. */
export function voiceHarness(tmp) {
  const stub = path.join(tmp, "voice-stub.mjs");
  writeFileSync(stub, STUB_SOURCE);
  return { stub, newLog: (name) => { const f = path.join(tmp, `${name}.jsonl`); writeFileSync(f, ""); return f; } };
}

export const readLog = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

export function fakeSupabase() {
  return http.createServer((req, res) => {
    const m = /^Bearer tok-(free|student|pro)-([\w-]+)$/.exec(req.headers.authorization ?? "");
    const user = req.url === "/auth/v1/user" && m ? { id: `u-${m[1]}-${m[2]}`, email: `${m[2]}@example.test`, app_metadata: m[1] === "free" ? {} : { plan: m[1] } } : undefined;
    res.writeHead(user ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(user ?? { msg: "invalid token" }));
  });
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/** Boot server.js with the stub preloaded; resolves once /api/status answers.
 *  `dataDir` reuses an earlier server's database (a restart). */
export async function bootServer({ tmp, stub, env, serverJs, dataDir: reuse = null }) {
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.includes(k)));
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await freePort();
    const dataDir = reuse ?? mkdtempSync(path.join(tmp, "data-"));
    const child = spawn(process.execPath, ["--import", pathToFileURL(stub).href, serverJs], {
      env: { ...baseEnv, PORT: String(port), TRACELY_DATA_DIR: dataDir, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let exited = false;
    child.on("exit", () => { exited = true; });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200 && !exited; i++) {
      try { if ((await fetch(`${base}/api/status`)).ok && !exited) return { base, child, dataDir, output: () => out }; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill();
    if (!exited) throw new Error(`server on ${port} did not start: ${out}`);
  }
  throw new Error("could not find a free port for a test server");
}

/** POST JSON; resolves { status, body }. */
export const post = (base, p, { body, token, headers = {} } = {}) =>
  fetch(`${base}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/** Today's entitlement_usage count for (account, kind) in a server's ledger. */
export function ledger(dataDir, account, kind) {
  const db = new DatabaseSync(path.join(dataDir, "tracely.db"));
  try {
    return db.prepare("SELECT count FROM entitlement_usage WHERE account_id = ? AND day = ? AND kind = ?").get(account, usageDay(Date.now()), kind)?.count ?? 0;
  } finally {
    db.close();
  }
}

/** How many Tracer Voice calls a server's database still lists as open. */
export function openVoiceRows(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "tracely.db"));
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM voice_open").get().n;
  } finally {
    db.close();
  }
}

/** Seed today's count for (account, kind), as earlier calls would have. */
export function seedLedger(dataDir, account, kind, count) {
  const db = new DatabaseSync(path.join(dataDir, "tracely.db"));
  try {
    db.prepare("INSERT INTO entitlement_usage (account_id, day, kind, count, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, day, kind) DO UPDATE SET count = excluded.count")
      .run(account, usageDay(Date.now()), kind, count, Date.now());
  } finally {
    db.close();
  }
}

/** Poll `fn` until it returns truthy (or fail after `ms`). */
export async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}
