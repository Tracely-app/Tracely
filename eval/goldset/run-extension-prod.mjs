// Run 1, against production: the extension's "Find a source" exactly as a
// user gets it today — POST /api/sources on api.jointracely.com, which runs
// the deployed search, enrichment and verify step.
//
// Why production rather than run-extension.mjs: the OpenAI key lives only on
// the server (docs/environments.md), so a laptop cannot call the library
// directly. The calls go through the BETA pool (X-Tracely-Beta, Pro limits,
// its own daily budget), so they never draw on the pool free users share.
// The beta pool allows SPEND.betaWebSearchesPerHour (30) source searches an
// hour; this paces one call every PACE_MS and honours a 429's Retry-After.
//
// The token is read from the environment (TRACELY_BETA_TOKEN) and never
// printed or written anywhere. The response strips the server's internal
// `verified` flag, so this records what the extension is SHOWN: each source's
// stance after verification. Shown as backing = stance "supports" (the
// extension's backingSources, for a sentence not flagged false).
//
//   TRACELY_BETA_TOKEN=… node eval/goldset/run-extension-prod.mjs --out eval/goldset/runs/<date>-extension-prod.json [--only 01-c1,02-c3] [--pace 125]
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { goldClaims, filterClaims } from './claims.mjs'

const argv = process.argv.slice(2)
const arg = (name, dflt = null) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1] }
const OUT = arg('--out')
const BASE = arg('--base', 'https://api.jointracely.com')
const PACE_MS = Number(arg('--pace', '125')) * 1000
if (!OUT) { console.error('--out is required'); process.exit(2) }
const TOKEN = (process.env.TRACELY_BETA_TOKEN || '').trim()
if (!TOKEN) { console.error('TRACELY_BETA_TOKEN is not set'); process.exit(2) }

// Context as the extension sends it: the claim's paragraph, ±1,200 chars
// around the sentence (factcheck.js contextAround is the server's own cut).
function contextFor(c) {
  const p = c.paragraph
  const at = p.indexOf(c.claim.slice(0, 40))
  if (at === -1 || p.length <= 2400) return p
  return p.slice(Math.max(0, at - 1200), Math.min(p.length, at + c.claim.length + 1200))
}

const claims = filterClaims(goldClaims(), arg('--only'))
// Resume: keep what an earlier, interrupted run already recorded.
const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
const results = out?.results ?? {}
const install = out?.meta?.install ?? randomUUID()
let commit = null
try { commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch {}
const meta = {
  what: 'extension /api/sources on production, beta pool',
  base: BASE,
  startedAt: out?.meta?.startedAt ?? new Date().toISOString(),
  install,
  harnessCommit: commit,
  shownRule: 'stance === "supports" (sentence not flagged false)',
}
const save = () => writeFileSync(OUT, JSON.stringify({ meta, results }, null, 1))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let first = true
for (const c of claims) {
  if (results[c.id]?.ok) continue
  if (!first) await sleep(PACE_MS)
  first = false
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now()
    let res, body
    try {
      res = await fetch(`${BASE}/api/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tracely-Install': install, 'X-Tracely-Beta': TOKEN },
        body: JSON.stringify({ claim: c.claim, context: contextFor(c) }),
        signal: AbortSignal.timeout(90_000),
      })
      body = await res.json().catch(() => ({}))
    } catch (err) {
      results[c.id] = { ok: false, error: String(err?.message ?? err).slice(0, 200), ms: Date.now() - t0 }
      save()
      break
    }
    if (res.status === 429 && attempt < 3) {
      const wait = Math.max(60, Number(res.headers.get('retry-after')) || 60) * 1000
      console.log(`${c.id} 429, waiting ${Math.round(wait / 1000)}s`)
      await sleep(wait)
      continue
    }
    const sources = Array.isArray(body.sources) ? body.sources : []
    results[c.id] = {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      claim: c.claim,
      essay: c.essay,
      model: body.modelUsed ?? body.model ?? null,
      plan: body.plan ?? null,
      error: res.ok ? null : (body.error?.message ?? null),
      sources,
      shown: sources.filter((s) => s.stance === 'supports').length,
    }
    save()
    console.log(`${c.id} ${res.status} ${sources.length} sources, ${results[c.id].shown} shown as backing, ${Math.round((Date.now() - t0) / 1000)}s`)
    break
  }
}
meta.finishedAt = new Date().toISOString()
save()
const done = Object.values(results)
console.log(`done: ${done.filter((r) => r.ok).length}/${claims.length} ok, ${done.reduce((n, r) => n + (r.sources?.length ?? 0), 0)} sources, ${done.reduce((n, r) => n + (r.shown ?? 0), 0)} shown as backing`)
