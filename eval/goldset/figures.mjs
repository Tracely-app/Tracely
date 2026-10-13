// The figure rule (server/lib/claimFigures.js figuresShown), measured on
// recorded runs: every source a run offered as backing, its quote, and the
// three judges' majority. Free — no model, no network; the rule is pure.
//
//   node eval/goldset/figures.mjs [--detail]
//
// Sets:
//   live  — runs/2026-10-10-verify-prod-on-*: production's verifier (the
//           one-verdict judge production runs again since #338) on the 310
//           judged sources, verdict "backs" + quote.
//   parts — runs/2026-10-13-verify-prod-on-*: the reverted parts judge (#327),
//           the same sources; a second sample of quotes.
//   search — runs/2026-10-09-extension-prod.json: what /api/sources showed as
//           backing (stance "supports", read), its receipt in `snippet`.
// For each: how many backs the rule would drop, split by the judges' majority.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { figuresShown } from "../../server/lib/claimFigures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(join(HERE, p), "utf8"));
const detail = process.argv.includes("--detail");
const judged = { 1007: load("judged/2026-10-07-extension-prod.json").items, 1009: load("judged/2026-10-09-extension-prod.json").items };

function fromVerifyRuns(date) {
  const rows = [];
  for (const set of ["1007", "1009"]) {
    const file = `runs/${date}-verify-prod-on-${set}.json`;
    if (!existsSync(join(HERE, file))) { console.log(`(no ${file}: skipped)`); return []; }
    const run = load(file).results;
    for (const it of judged[set]) {
      const r = run[it.id];
      if (r?.verdict === "backs" && r.quote) rows.push({ id: it.id, sentence: it.sentence, quote: r.quote, majority: it.majority ?? "split" });
    }
  }
  return rows;
}

function fromSearchRun() {
  const run = load("runs/2026-10-09-extension-prod.json").results;
  const rows = [];
  for (const it of judged[1009]) {
    const s = (run[it.claimId]?.sources ?? []).find((x) => x.url === it.url);
    if (s?.stance === "supports" && s.verified !== false && s.snippet) {
      rows.push({ id: it.id, sentence: it.sentence, quote: s.snippet.replace(/^“|”$/g, ""), majority: it.majority ?? "split" });
    }
  }
  return rows;
}

const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : "—");
const fmt = (f) => `${f.cmp === "gt" ? ">" : f.cmp === "lt" ? "<" : ""}${f.approx ? "~" : ""}${+f.value.toFixed(2)} ${f.kind}`;
for (const [name, rows] of [["live", fromVerifyRuns("2026-10-10")], ["parts", fromVerifyRuns("2026-10-13")], ["search", fromSearchRun()]]) {
  const good = rows.filter((r) => r.majority === "backs").length;
  const dropped = rows.map((r) => ({ ...r, check: figuresShown(r.sentence, r.quote) })).filter((r) => !r.check.ok);
  const droppedGood = dropped.filter((r) => r.majority === "backs").length;
  const after = rows.length - dropped.length;
  const goodAfter = good - droppedGood;
  console.log(`\n${name.padEnd(6)} backs ${rows.length}, judges agree ${good} (${pct(good, rows.length)})  →  rule drops ${dropped.length}: ${dropped.length - droppedGood} the judges call not-backs, ${droppedGood} they call backs`);
  console.log(`${"".padEnd(6)} after: backs ${after}, judges agree ${goodAfter} (${pct(goodAfter, after)})`);
  if (detail) for (const r of dropped) console.log(`   [${r.majority}] ${r.id}  missing ${r.check.missing.map(fmt).join(", ")}\n      S: ${r.sentence.slice(0, 150)}\n      Q: ${r.quote.slice(0, 150)}`);
}
