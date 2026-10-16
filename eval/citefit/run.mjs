// The wrong-source check, measured: POST /api/check with `citeFit: true`
// (server/lib/citeFit.js) on cited sentences whose source fits, doesn't, or
// can't be judged — 90 written blind (server/test/fixtures/cite-fit-blind.js)
// and the owner's twenty-sentence answer key (fixtures/citation-key.js). Run
// it against production after the server is deployed: the OpenAI key lives
// only on the server (docs/environments.md).
//
// Paid, and small: about ten checks of twelve sentences on the fast model,
// each with one wrong-source call — a few cents in all. Say so before running
// it. With TRACELY_BETA_TOKEN in the environment the calls go through the
// beta pool; without it, as one anonymous install on the free plan (400
// checks a day). The token is read from the environment and never printed.
//
//   node eval/citefit/run.mjs --out eval/citefit/runs/<date>.json [--base URL] [--pace 4]
//   node eval/citefit/run.mjs --score eval/citefit/runs/<date>.json
//
// The bar for turning FEATURES.citeFit on (extension/content.js): at most one
// "Wrong source cited" on the 60 blind sentences whose source fits or can't
// be judged, none on the key's four correctly cited ones, and at least two in
// three of the wrong sources caught.
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, dflt = null) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1] }
const FIX = (f) => pathToFileURL(path.join(HERE, '..', '..', 'server', 'test', 'fixtures', f))
const BATCH = 12 // CITE_FIT_MAX: every cited sentence of a check is judged

export async function items() {
  const { CITE_FIT_BLIND } = await import(FIX('cite-fit-blind.js'))
  const { CITATION_KEY } = await import(FIX('citation-key.js'))
  const out = CITE_FIT_BLIND.map((x, i) => ({ id: `b${String(i).padStart(2, '0')}`, set: 'blind', text: x.text, expect: x.expect }))
  // The key: its wrong citations are "wrong", its correct and cited ones "fits"; the rest are not about who is cited.
  for (const x of CITATION_KEY) out.push({ id: `k${String(x.n).padStart(2, '0')}`, set: 'key', text: x.text, expect: x.key === 'wrong-citation' ? 'wrong' : x.key === 'correct' ? 'fits' : 'other' })
  return out
}

export function score(results, list) {
  const rows = list.map((x) => ({ ...x, got: results[x.id]?.verdict ?? null }))
  const tally = (set, expect) => {
    const r = rows.filter((x) => x.set === set && x.expect === expect)
    return { n: r.length, wrongSource: r.filter((x) => x.got === 'wrong_source').length, notAsked: r.filter((x) => x.got && x.got !== 'accurate' && x.got !== 'wrong_source').length, missing: r.filter((x) => !x.got).length }
  }
  return {
    blind: { wrong: tally('blind', 'wrong'), fits: tally('blind', 'fits'), either: tally('blind', 'either') },
    key: { wrong: tally('key', 'wrong'), fits: tally('key', 'fits'), other: tally('key', 'other') },
    misses: rows.filter((x) => (x.expect === 'wrong') !== (x.got === 'wrong_source') && x.expect !== 'other').map((x) => `${x.id} ${x.expect} → ${x.got}: ${x.text.slice(0, 90)}`),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const list = await items()
  if (arg('--score')) {
    const { results } = JSON.parse(readFileSync(arg('--score'), 'utf8'))
    console.log(JSON.stringify(score(results, list), null, 1))
    process.exit(0)
  }
  const OUT = arg('--out')
  if (!OUT) { console.error('--out or --score is required'); process.exit(2) }
  const BASE = arg('--base', 'https://api.jointracely.com')
  const PACE_MS = Number(arg('--pace', '4')) * 1000
  const TOKEN = (process.env.TRACELY_BETA_TOKEN || '').trim()
  mkdirSync(path.dirname(OUT), { recursive: true })
  const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
  const results = prior?.results ?? {}
  let commit = null
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch {}
  const meta = { what: '/api/check citeFit', base: BASE, pool: TOKEN ? 'beta' : 'anonymous free', install: prior?.meta?.install ?? randomUUID(), startedAt: prior?.meta?.startedAt ?? new Date().toISOString(), harnessCommit: commit }
  const save = () => writeFileSync(OUT, JSON.stringify({ meta, results }, null, 1))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const todo = list.filter((x) => !results[x.id])
  // One document per batch, a set at a time: the key is its own document, as it was written.
  const batches = []
  for (const set of ['blind', 'key']) {
    const s = todo.filter((x) => x.set === set)
    for (let i = 0; i < s.length; i += set === 'key' ? 20 : BATCH) batches.push(s.slice(i, i + (set === 'key' ? 20 : BATCH)))
  }
  console.log(`${todo.length} sentences in ${batches.length} checks, a few cents`)
  for (const [i, b] of batches.entries()) {
    if (i) await sleep(PACE_MS)
    const headers = { 'Content-Type': 'application/json', 'X-Tracely-Install': meta.install, ...(TOKEN ? { 'X-Tracely-Beta': TOKEN } : {}) }
    const body = { text: b.map((x) => x.text).join('\n'), sentences: b.map((x) => ({ id: x.id, text: x.text })), model: 'gpt-5.6-luna', citeFit: true }
    const res = await fetch(`${BASE}/api/check`, { method: 'POST', headers, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { console.error(`check ${i + 1}: ${res.status} ${data?.error?.kind ?? ''} — stopping; run again to resume`); save(); process.exit(1) }
    for (const f of data.findings ?? []) results[f.id] = { verdict: f.verdict, explanation: f.explanation ?? '' }
    save()
    console.log(`check ${i + 1}/${batches.length}: ${(data.findings ?? []).filter((f) => f.verdict === 'wrong_source').length} wrong_source`)
  }
  console.log(JSON.stringify(score(results, list), null, 1))
}
