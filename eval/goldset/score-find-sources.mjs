#!/usr/bin/env node
// Compares two run-find-sources.mjs results claim by claim. Free: reads files.
//
//   node eval/goldset/score-find-sources.mjs <current.json> <lean.json>
//
// The bar a variant must clear to replace the current prompt (2026-10-17,
// the owner's "same accuracy, speed … just cheaper"):
//   - claims with at least one backing source: no fewer than current's;
//   - backing sources per claim: no lower than current's minus 0.2;
//   - median wait: no slower than current's;
//   - and cheaper per search.
// "Backing" is the referee's verdict (server/lib/sourceVerify.js, a quote
// found in the source's own text), the same for both runs.
import { readFileSync } from 'node:fs'

const [aPath, bPath] = process.argv.slice(2)
if (!aPath || !bPath) { console.error('usage: score-find-sources.mjs <current.json> <variant.json>'); process.exit(2) }
const A = JSON.parse(readFileSync(aPath, 'utf8'))
const B = JSON.parse(readFileSync(bPath, 'utf8'))
const byId = (doc) => new Map(doc.results.filter((r) => r.ok).map((r) => [r.id, r]))
const a = byId(A), b = byId(B)
const ids = [...a.keys()].filter((id) => b.has(id)).sort()
if (!ids.length) { console.error('no claim answered in both runs'); process.exit(2) }

const median = (xs) => { const s = [...xs].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const stats = (m, name) => {
  const rs = ids.map((id) => m.get(id))
  const avg = (f) => rs.reduce((s, r) => s + f(r), 0) / rs.length
  return {
    name,
    searchCents: 100 * avg((r) => r.searchUSD),
    searchCentsSearchOnly: 100 * avg((r) => r.searchUSDSearchOnly),
    medianSeconds: median(rs.map((r) => r.ms)) / 1000,
    offered: avg((r) => r.offered),
    backing: avg((r) => r.backing),
    claimsWithBacking: rs.filter((r) => r.backing > 0).length,
    opens: avg((r) => r.actions?.open_page ?? 0),
    searches: avg((r) => r.actions?.search ?? 0),
  }
}
const sa = stats(a, A.meta.variant), sb = stats(b, B.meta.variant)
const row = (s) => `${s.name.padEnd(8)} ${s.searchCents.toFixed(2).padStart(6)}¢ (${s.searchCentsSearchOnly.toFixed(2)}¢ search-only)  ${s.medianSeconds.toFixed(1).padStart(5)}s  searches ${s.searches.toFixed(1)} opens ${s.opens.toFixed(1)}  offered ${s.offered.toFixed(2)}  backing ${s.backing.toFixed(2)}  claims backed ${s.claimsWithBacking}/${ids.length}`
console.log(`${ids.length} claims answered in both runs\n`)
console.log(row(sa))
console.log(row(sb))

const lost = ids.filter((id) => a.get(id).backing > 0 && b.get(id).backing === 0)
const gained = ids.filter((id) => a.get(id).backing === 0 && b.get(id).backing > 0)
console.log(`\nbacked by ${sa.name} only: ${lost.join(', ') || 'none'}`)
console.log(`backed by ${sb.name} only: ${gained.join(', ') || 'none'}`)

const checks = [
  ['claims with a backing source', sb.claimsWithBacking >= sa.claimsWithBacking],
  ['backing sources per claim', sb.backing >= sa.backing - 0.2],
  ['median wait', sb.medianSeconds <= sa.medianSeconds],
  ['cost per search', sb.searchCents < sa.searchCents],
]
console.log('')
for (const [what, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${what}`)
console.log(checks.every(([, p]) => p) ? `\n${sb.name} clears the bar.` : `\n${sb.name} does not clear the bar: keep ${sa.name}.`)
