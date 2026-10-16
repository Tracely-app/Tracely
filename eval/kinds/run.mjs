// The model's kind of writing, measured: POST /api/kind (server/lib/kind.js)
// on the three corpora the extension's rules were measured on
// (server/test/fixtures/writing-kinds-{tuned,blind,fresh}.js, 937 invented
// documents). Run it against production after the route is deployed: the
// OpenAI key lives only on the server (docs/environments.md).
//
// Paid. Each document is one call on the fast model, about 0.1¢ (≈3,000
// input tokens with the prompt, a few hundred out): ≈ $0.31 for the fresh set
// (312), ≈ $0.94 for all three. Say so before running it. The calls go
// through the BETA pool (X-Tracely-Beta: Pro limits, 400 a day on this route,
// its own daily budget), never the pool free users share, one every PACE_MS
// (the route's floor is 2 s), honouring a 429's Retry-After. An answer the
// server already has for the same text is free and comes back `cached`.
//
// The token is read from the environment and never printed or written.
//
//   TRACELY_BETA_TOKEN=… node eval/kinds/run.mjs --out eval/kinds/runs/<date>-fresh.json [--set fresh|blind|tuned|all] [--base URL] [--pace 2.2] [--limit N]
//   node eval/kinds/score.mjs eval/kinds/runs/<date>-fresh.json
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { kindExcerpt } from '../../server/lib/kind.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, dflt = null) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1] }
const OUT = arg('--out')
const BASE = arg('--base', 'https://api.jointracely.com')
const SET = arg('--set', 'fresh')
const PACE_MS = Number(arg('--pace', '2.2')) * 1000
const TOKEN = (process.env.TRACELY_BETA_TOKEN || '').trim()

export async function corpus(set) {
  const sets = set === 'all' ? ['tuned', 'blind', 'fresh'] : [set]
  const docs = []
  for (const s of sets) {
    const mod = await import(pathToFileURL(path.join(HERE, '..', '..', 'server', 'test', 'fixtures', `writing-kinds-${s}.js`)))
    Object.values(mod)[0].forEach((d, i) => docs.push({ id: `${s}-${String(i).padStart(3, '0')}`, set: s, ...d }))
  }
  return docs
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!OUT) { console.error('--out is required'); process.exit(2) }
  if (!TOKEN && !/localhost|127\.0\.0\.1/.test(BASE)) { console.error('TRACELY_BETA_TOKEN is not set'); process.exit(2) }
  const docs = (await corpus(SET)).slice(0, Number(arg('--limit', '100000')))
  mkdirSync(path.dirname(OUT), { recursive: true })
  const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
  const results = out?.results ?? {}
  const install = out?.meta?.install ?? randomUUID()
  let commit = null
  try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch {}
  const meta = { what: 'extension /api/kind, beta pool', base: BASE, set: SET, startedAt: out?.meta?.startedAt ?? new Date().toISOString(), install, harnessCommit: commit }
  const save = () => writeFileSync(OUT, JSON.stringify({ meta, results }, null, 1))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const todo = docs.filter((d) => !results[d.id]?.ok)
  console.log(`${todo.length} of ${docs.length} documents to read, about $${(todo.length * 0.001).toFixed(2)}`)
  let first = true
  for (const d of todo) {
    if (!first) await sleep(PACE_MS)
    first = false
    for (let attempt = 1; attempt <= 3; attempt++) {
      const t0 = Date.now()
      let res, body
      try {
        res = await fetch(`${BASE}/api/kind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tracely-Install': install, ...(TOKEN ? { 'X-Tracely-Beta': TOKEN } : {}) },
          body: JSON.stringify({ text: kindExcerpt(d.text) }),
          signal: AbortSignal.timeout(60_000),
        })
        body = await res.json().catch(() => ({}))
      } catch (err) {
        results[d.id] = { ok: false, error: String(err?.message ?? err).slice(0, 200), ms: Date.now() - t0 }
        save()
        break
      }
      if (res.status === 429 && attempt < 3) {
        const wait = Math.max(3, Number(res.headers.get('retry-after')) || 3) * 1000
        await sleep(wait)
        continue
      }
      results[d.id] = { ok: res.ok, status: res.status, ms: Date.now() - t0, want: d.kind, kind: body.kind ?? null, cached: Boolean(body.cached), model: body.modelUsed ?? null, error: res.ok ? null : (body.error?.message ?? null) }
      save()
      console.log(`${d.id} ${res.status} want ${d.kind}, model ${body.kind}${body.cached ? ' (cached)' : ''}`)
      break
    }
  }
  meta.finishedAt = new Date().toISOString()
  save()
  console.log(`done: ${Object.values(results).filter((r) => r.ok).length}/${docs.length} answered. Score: node eval/kinds/score.mjs ${OUT}`)
}
