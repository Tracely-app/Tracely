// The receipts' verifier ALONE, on a fixed, judged list: every source of a judged
// run goes to production POST /api/verify-sources (the same lib/sourceVerify.js
// verifySources the extension's search runs, fast model at low), grouped by
// claim, and each verdict is set beside the judges' majority. No search runs,
// so a change to the verifier is measured on identical inputs, before and after
// a deploy. App route: the desktop's pool and limiter, metered on an install id
// (no token; one fast-model call per claim, about 0.15 cent — 36 claims ≈ 5¢).
//
//   node eval/goldset/run-verify-prod.mjs eval/goldset/judged/2026-10-09-extension-prod.json eval/goldset/runs/<date>-verify-prod-on-1009.json [--base URL]
//
// Recorded, 2026-10-10, production 6974306 (the one-verdict judge), on the 310
// sources of judged/2026-10-07 and 2026-10-09: of its 48 "backs" the judges'
// majority agrees with 34; of the judges' 84 "backs" it says backs 34, topic
// 24, unread 24, contradicts 2 (runs/2026-10-10-verify-prod-on-*.json).
// Most disagreements are two-part sentences, decided both ways.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const [JUDGED, OUT] = process.argv.slice(2);
const argv = process.argv.slice(2);
const BASE = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "https://api.jointracely.com";
if (!JUDGED || !OUT) { console.error("usage: run-verify-prod.mjs <judged.json> <out.json>"); process.exit(2); }
const items = JSON.parse(readFileSync(JUDGED, "utf8")).items;
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
const results = prev?.results ?? {};
const meta = { what: "production /api/verify-sources on a judged run's sources", base: BASE, judged: JUDGED.split(/[\\/]/).pop(), install: prev?.meta?.install ?? randomUUID(), startedAt: prev?.meta?.startedAt ?? new Date().toISOString() };
const save = () => writeFileSync(OUT, JSON.stringify({ meta, results }, null, 1));

const byClaim = new Map();
for (const it of items) { if (!byClaim.has(it.claimId)) byClaim.set(it.claimId, []); byClaim.get(it.claimId).push(it); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [cid, list] of byClaim) {
  if (list.every((it) => results[it.id])) continue;
  const body = { claim: list[0].sentence, sources: list.map((it) => ({ id: it.id, title: it.title ?? "", url: it.url ?? "", doi: it.doi ?? "", venue: it.venue ?? "", year: Number.isInteger(it.year) ? it.year : undefined })) };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/verify-sources`, { method: "POST", headers: { "Content-Type": "application/json", "X-Tracely-Install": meta.install }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: String(e) }) }));
    const j = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt < 3) { await sleep(60_000); continue; }
    if (!res.ok) { console.log(`${cid} ${res.status} ${JSON.stringify(j).slice(0, 200)}`); break; }
    for (const r of j.receipts ?? []) results[r.id] = { verdict: r.verdict, quote: r.quote ?? null, readFrom: r.readFrom ?? null, model: j.model };
    save();
    console.log(`${cid} ${res.status} ${(j.receipts ?? []).map((r) => r.verdict[0]).join("")} ${Date.now() - t0}ms`);
    break;
  }
  await sleep(2_500);
}
meta.finishedAt = new Date().toISOString();
save();

// Beside the judges.
const rows = items.filter((it) => results[it.id]).map((it) => ({ id: it.id, maj: it.majority ?? "split", v: results[it.id].verdict }));
const M = {};
for (const r of rows) { M[r.v] ??= {}; M[r.v][r.maj] = (M[r.v][r.maj] ?? 0) + 1; }
console.log("\nverifier verdict → judges' majority", JSON.stringify(M));
const backs = rows.filter((r) => r.v === "backs");
console.log(`verifier backs: ${backs.length}; judges agree ${backs.filter((r) => r.maj === "backs").length}`);
console.log(`judges' backs: ${rows.filter((r) => r.maj === "backs").length}; verifier backs ${rows.filter((r) => r.maj === "backs" && r.v === "backs").length}, topic ${rows.filter((r) => r.maj === "backs" && r.v === "topic").length}, unread ${rows.filter((r) => r.maj === "backs" && r.v === "unread").length}`);
