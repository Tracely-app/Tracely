#!/usr/bin/env node
// The desktop's source search (POST /api/find-sources) on the 36 gold claims,
// one prompt VARIANT at a time, judged by the same referee for every variant
// (2026-10-17). PAID: about 3-5 cents a claim for the search, plus the
// referee's read of the pages it returns.
//
//   node eval/goldset/run-find-sources.mjs --variant current --dry
//   OPENAI_API_KEY=… node eval/goldset/run-find-sources.mjs --variant current --out eval/goldset/runs/<date>-find-sources-current.json
//   OPENAI_API_KEY=… node eval/goldset/run-find-sources.mjs --variant lean    --out eval/goldset/runs/<date>-find-sources-lean.json
//   node eval/goldset/score-find-sources.mjs <current.json> <lean.json>     # free
//
// Options
//   --variant NAME    current | lean (eval/goldset/find-sources-variants.mjs)
//   --out PATH        result file (required unless --dry)
//   --claims SPEC     only these ids (01-c1) or id prefixes (01), comma-separated
//   --cap USD         hard spend stop for this run (default 4)
//   --concurrency N   claims in flight (default 3)
//   --dry             the plan and the estimate; no network
//
// What one claim does, exactly as the desktop and server do it, with the prompt
// swapped for the variant's:
//   1. The search: lib/llm.js webSearchStructuredCall with the variant's prompt
//      and schema, the user message server/lib/reasoning.js findSources builds
//      (the claim, and the desktop detector's search query as its context, as
//      src/main/services/search/aggregator.ts sends), at the model and effort
//      shared/plan.js modelForRoute("findSources", "free") gives a hosted free
//      caller, with the same output ceiling and search cap.
//   2. The desktop's URL guard (src/shared/urlLiveness.ts): a source is offered
//      only if its URL is plausible and does not answer 404/410 or fail to
//      connect.
//   3. The referee: server/lib/sourceVerify.js verifySources — the receipts'
//      judge — reads every offered source's own text and says whether it backs
//      the claim, with a quote checked against that text. Its verdict is the
//      quality measure, and it is the same call for every variant, so a variant
//      cannot grade itself. Its cost is recorded apart from the search's.
//
// The key. OPENAI_API_KEY from the shell, else server/.env (the server's rule).
// Nothing here prints, logs or writes a key.
import { AsyncLocalStorage } from 'node:async_hooks'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { REPO } from '../retrieval/load.mjs'
import { filterClaims, goldClaims } from './claims.mjs'
import { VARIANTS } from './find-sources-variants.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1] }
const flag = (k) => argv.includes(`--${k}`)
const dry = flag('dry')
const variantName = arg('variant')
const variant = VARIANTS[variantName]
if (!variant) { console.error(`--variant must be one of: ${Object.keys(VARIANTS).join(', ')}`); process.exit(2) }
const outArg = arg('out')
if (!dry && !outArg) { console.error('--out PATH is required (or --dry)'); process.exit(2) }
const outPath = outArg ? (isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg)) : null
const cap = Number(arg('cap', 4))
const concurrency = Math.max(1, Number(arg('concurrency', 3)))
const claims = filterClaims(goldClaims(), arg('claims'))
if (!claims.length) { console.error('no claims match --claims'); process.exit(2) }

function loadServerEnv() {
  const file = join(REPO, 'server', '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const value = m[2].replace(/^["']|["']$/g, '')
    if (value && !process.env[m[1]]) process.env[m[1]] = value
  }
}
if (!process.env.OPENAI_API_KEY) loadServerEnv()
if (!dry && !process.env.OPENAI_API_KEY) {
  console.error('No OpenAI key: OPENAI_API_KEY is not in the shell and server/.env does not set it. Nothing was run.')
  process.exit(2)
}
delete process.env.TRACELY_MOCK

const { webSearchStructuredCall, costMicroCents } = await import('../../server/lib/llm.js')
const { verifySources } = await import('../../server/lib/sourceVerify.js')
const { modelForRoute } = await import('../../server/shared/plan.js')
const { FIND_SOURCES_MAX_SEARCHES } = await import('../../server/lib/reasoning.js')

const policy = modelForRoute('findSources', 'free')
const MODEL = policy.model
const EFFORT = policy.effort
const MAX_OUTPUT = 16_000 // server/lib/reasoning.js MAX_OUTPUT.sources
const TYPICAL_USD = variantName === 'lean' ? 0.025 : 0.045
const WORST_USD = 0.09

const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: REPO, encoding: 'utf8' }).trim() } catch { return null } }

if (dry) {
  console.log(`Would run ${claims.length} claim(s) through the "${variantName}" find-sources prompt on ${MODEL}@${EFFORT ?? 'vendor default'}, search cap ${FIND_SOURCES_MAX_SEARCHES}, concurrency ${concurrency}, then the referee (sourceVerify) on what it offers.`)
  console.log(`Estimate: ~$${(claims.length * TYPICAL_USD).toFixed(2)} typical (search + referee), ~$${(claims.length * WORST_USD).toFixed(2)} if every claim hits the worst case. Cap: $${cap.toFixed(2)} (the run stops before passing it).`)
  console.log(`Key available: ${process.env.OPENAI_API_KEY ? 'yes' : 'NO — a real run would refuse'}`)
  process.exit(0)
}

// ── per-claim capture of the search's tool actions ───────────────────────
// Headers are never read. For OpenAI answers, only the web_search_call items'
// action types are kept (search / open_page / find), to count what was billed.
const als = new AsyncLocalStorage()
const realFetch = globalThis.fetch
globalThis.fetch = async function capturingFetch(input, init = {}) {
  const ctx = als.getStore()
  const url = typeof input === 'string' ? input : input?.url ?? String(input)
  const res = await realFetch(input, init)
  if (ctx && url.startsWith('https://api.openai.com/') && ctx.capture) {
    try {
      const json = await res.clone().json()
      const items = Array.isArray(json?.output) ? json.output.filter((o) => o?.type === 'web_search_call') : []
      for (const it of items) {
        const t = String(it?.action?.type ?? 'search')
        ctx.actions[t] = (ctx.actions[t] ?? 0) + 1
      }
    } catch { /* not JSON: nothing to count */ }
  }
  return res
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
function plausible(raw) {
  try {
    const u = new URL(raw)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') && u.pathname.length > 1 && !/example\.(com|org)$/.test(u.hostname)
  } catch { return false }
}
async function liveness(url) {
  if (!plausible(url)) return 'implausible'
  try {
    const res = await realFetch(url, { method: 'GET', redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8_000) })
    try { await res.body?.cancel() } catch { /* drained */ }
    return res.status === 404 || res.status === 410 ? 'gone' : 'live'
  } catch { return 'unreachable' }
}

const usd = (micro) => micro / 1e8
let spent = 0

async function runClaim(c) {
  const ctx = { capture: true, actions: {} }
  return als.run(ctx, async () => {
    const user = c.searchQuery
      ? `CLAIM TO SOURCE:\n${c.claim}\n\nTHE DRAFT THIS IS FROM (for context — do not source these):\n${c.searchQuery}`
      : `CLAIM TO SOURCE:\n${c.claim}`
    const t0 = Date.now()
    let out
    try {
      out = await webSearchStructuredCall({
        model: MODEL, effort: EFFORT, maxTokens: MAX_OUTPUT, system: variant.system, user,
        schema: variant.schema, name: variant.name, what: 'source search', maxSearches: FIND_SOURCES_MAX_SEARCHES
      })
    } catch (err) {
      const billed = err?.llm?.usage ? costMicroCents(MODEL, err.llm.usage, { webSearchCalls: err.llm.webSearchCalls ?? 0 }) : 0
      spent += usd(billed)
      return { id: c.id, ok: false, error: String(err?.kind ?? err?.message ?? err).slice(0, 120), ms: Date.now() - t0, searchUSD: usd(billed) }
    }
    const ms = Date.now() - t0
    const searchActions = ctx.actions.search ?? 0
    const searchUSD = usd(costMicroCents(out.model ?? MODEL, out.usage, { webSearchCalls: Math.max(1, out.webSearchCalls ?? 0) }))
    const searchUSDSearchOnly = usd(costMicroCents(out.model ?? MODEL, out.usage, { webSearchCalls: Math.max(1, searchActions) }))
    ctx.capture = false
    const returned = Array.isArray(out.parsed?.sources) ? out.parsed.sources : []
    const lives = await Promise.all(returned.map((s) => liveness(s.url)))
    const offered = returned.filter((_, i) => lives[i] === 'live')
    // The referee reads each offered source's own text and judges it against the claim.
    const judged = offered.map((s) => ({ title: s.title, url: s.url, publisher: s.publisher, snippet: s.supports, stance: 'context', kind: s.kind, authors: s.authors ?? [], year: s.year, doi: '' }))
    let refereeUSD = 0
    try {
      const v = await verifySources({ claim: c.claim, sources: judged, model: MODEL })
      refereeUSD = v?.usage ? usd(costMicroCents(MODEL, v.usage)) : 0
    } catch { /* an unread list counts as nothing backed */ }
    spent += searchUSD + refereeUSD
    return {
      id: c.id, ok: true, ms,
      usage: out.usage, webSearchCalls: out.webSearchCalls ?? 0, actions: ctx.actions,
      searchUSD, searchUSDSearchOnly, refereeUSD,
      returned: returned.length,
      offered: offered.length,
      dropped: returned.map((s, i) => (lives[i] === 'live' ? null : { url: s.url, why: lives[i] })).filter(Boolean),
      backing: judged.filter((s) => s.verified === true && s.stance === 'supports').length,
      sources: judged.map((s) => ({ title: s.title, url: s.url, publisher: s.publisher, kind: s.kind, verified: s.verified === true, stance: s.stance, quote: s.quote ?? null })),
      searchesRun: out.parsed?.searchesRun ?? [],
      note: out.parsed?.note ?? ''
    }
  })
}

const results = []
let next = 0
async function worker() {
  while (next < claims.length) {
    if (spent + WORST_USD > cap) { console.error(`Stopping: $${spent.toFixed(3)} spent, the next claim could pass the $${cap} cap.`); return }
    const c = claims[next++]
    const r = await runClaim(c)
    results.push(r)
    console.log(`${r.id}  ${r.ok ? `${r.offered}/${r.returned} offered, ${r.backing} backing, ${(r.ms / 1000).toFixed(1)}s, $${(r.searchUSD ?? 0).toFixed(4)}` : `FAILED ${r.error}`}`)
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))

results.sort((a, b) => a.id.localeCompare(b.id))
const ok = results.filter((r) => r.ok)
const mean = (f) => (ok.length ? ok.reduce((s, r) => s + f(r), 0) / ok.length : 0)
const summary = {
  claims: results.length, ok: ok.length,
  meanSearchUSD: mean((r) => r.searchUSD), meanSearchUSDSearchOnly: mean((r) => r.searchUSDSearchOnly),
  meanRefereeUSD: mean((r) => r.refereeUSD), meanMs: mean((r) => r.ms),
  meanReturned: mean((r) => r.returned), meanOffered: mean((r) => r.offered), meanBacking: mean((r) => r.backing),
  claimsWithBacking: ok.filter((r) => r.backing > 0).length,
  spentUSD: spent
}
const doc = {
  meta: { variant: variantName, model: MODEL, effort: EFFORT ?? null, searchCap: FIND_SOURCES_MAX_SEARCHES, commit: git('rev-parse --short HEAD'), at: new Date().toISOString() },
  summary, results
}
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath + '.tmp', JSON.stringify(doc, null, 2))
renameSync(outPath + '.tmp', outPath)
console.log(JSON.stringify(summary, null, 2))
console.log(`Wrote ${outPath}`)
