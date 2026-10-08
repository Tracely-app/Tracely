#!/usr/bin/env node
// Run 1 of the gold-set baseline: the extension's "Find a source"
// (POST /api/sources), run on the 36 labelled claims exactly as the hosted
// server runs it for a FREE caller today, with what the route throws away kept.
//
//   node eval/goldset/run-extension.mjs --dry                       # the plan and the estimate, no calls
//   node eval/goldset/run-extension.mjs --out eval/goldset/runs/2026-10-07-extension.json
//   node eval/goldset/run-extension.mjs --out /tmp/after.json --claims 01,05-c1   # a subset
//
// Options
//   --out PATH        result file (required unless --dry). Re-run the SAME script
//                     on a branch that changes server/lib/sourceVerify.js with a
//                     different --out and compare by claim id.
//   --claims SPEC     only these ids (01-c1) or id prefixes (01), comma-separated
//   --cap USD         hard spend stop for this run (default 3)
//   --concurrency N   claims in flight (default 3)
//   --resume          keep claims already recorded "ok" in --out and run the rest
//   --dry             list what would run and what it should cost; no network
//
// What it calls. `findSources` from server/lib/factcheck.js — the function the
// /api/sources route awaits, which runs the web search, `completeSources`
// (Crossref + page metadata, dead links dropped) and `verifySources`
// (server/lib/sourceVerify.js) — with the model and effort
// server/shared/plan.js `modelForRoute("sources", "free")` picks on a hosted
// server. Nothing on disk is patched. The one thing this process adds is a
// fetch wrapper (as eval/models/harness does) that records every HTTP call made
// for a claim, so the verify call's input and verdicts can be kept: the route
// strips `verified` and keeps no per-source record of what the verifier read.
//
// The key. OPENAI_API_KEY from the shell, as the model harness reads it; failing
// that, server/.env read with the server's own rule (server.js loadEnvFile: a
// shell-exported value wins). Nothing here prints, logs or writes a key.
import { AsyncLocalStorage } from 'node:async_hooks'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { REPO } from '../retrieval/load.mjs'
import { filterClaims, goldClaims } from './claims.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1] }
const flag = (k) => argv.includes(`--${k}`)
const dry = flag('dry')
const outArg = arg('out')
if (!dry && !outArg) { console.error('--out PATH is required (or --dry)'); process.exit(2) }
const outPath = outArg ? (isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg)) : null
const cap = Number(arg('cap', 3))
const concurrency = Math.max(1, Number(arg('concurrency', 3)))
const claims = filterClaims(goldClaims(), arg('claims'))
if (!claims.length) { console.error('no claims match --claims'); process.exit(2) }

// ── the key, the server's way ────────────────────────────────────────────
function loadServerEnv() {
  const envPath = join(REPO, 'server', '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
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

const { findSources } = await import('../../server/lib/factcheck.js')
const { costMicroCents } = await import('../../server/lib/llm.js')
const { doiOf } = await import('../../server/lib/sourceEnrich.js')
const { modelForRoute } = await import('../../server/shared/plan.js')
const { WEB_SEARCH_CALL_DOLLARS } = await import('../../server/shared/prices.js')

const PLAN = 'free'
const policy = modelForRoute('sources', PLAN)
const MODEL = policy.model
const EFFORT = policy.effort

const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: REPO, encoding: 'utf8' }).trim() } catch { return null } }

// About 1.3 cents a search (server/shared/plan.js SOURCE_LIMITS note, 2026-10-02)
// plus ~0.1 for the verify call; a claim is reserved at a worst case until one
// has been observed, then at 1.5x the dearest seen.
const TYPICAL_USD = 0.014
const PRIOR_USD = 0.03

if (dry) {
  console.log(`Would run ${claims.length} claim(s) through findSources on ${MODEL}@${EFFORT ?? 'vendor default'} (plan ${PLAN}), concurrency ${concurrency}.`)
  for (const c of claims) console.log(`  ${c.id}  context ${c.paragraph.length} chars  ${c.claim.slice(0, 90)}`)
  console.log(`Estimate: ~$${(claims.length * TYPICAL_USD).toFixed(2)} typical, ~$${(claims.length * PRIOR_USD).toFixed(2)} if every claim hits the worst case. Cap: $${cap.toFixed(2)}.`)
  console.log(`Key available: ${process.env.OPENAI_API_KEY ? 'yes' : 'NO — a real run would refuse'}`)
  process.exit(0)
}

// ── per-claim HTTP capture ───────────────────────────────────────────────
// Headers are never read or recorded. OpenAI calls keep their body's model,
// effort and (for the verify call) input, and the answer's text and usage;
// every other call keeps host, path and status only.
const als = new AsyncLocalStorage()
const realFetch = globalThis.fetch
globalThis.fetch = async function capturingFetch(input, init = {}) {
  const ctx = als.getStore()
  const url = typeof input === 'string' ? input : input?.url ?? String(input)
  if (!ctx) return realFetch(input, init)
  const started = Date.now()
  if (!url.startsWith('https://api.openai.com/')) {
    const rec = { url: url.slice(0, 300), started }
    ctx.other.push(rec)
    try {
      const res = await realFetch(input, init)
      rec.status = res.status
      rec.ms = Date.now() - started
      return res
    } catch (err) {
      rec.status = 0
      rec.error = String(err?.name ?? err).slice(0, 80)
      rec.ms = Date.now() - started
      throw err
    }
  }
  let body = {}
  try { body = JSON.parse(init.body) } catch {}
  const rec = {
    kind: Array.isArray(body.tools) && body.tools.some((t) => t?.type === 'web_search') ? 'search' : 'verify',
    model: body.model ?? null,
    effortSent: body.reasoning?.effort ?? null,
    input: typeof body.input === 'string' ? body.input : null,
    started
  }
  ctx.openai.push(rec)
  try {
    const res = await realFetch(input, init)
    const text = await res.text()
    rec.status = res.status
    rec.ms = Date.now() - started
    let json = {}
    try { json = JSON.parse(text) } catch {}
    rec.modelEcho = json.model ?? null
    const u = json.usage ?? {}
    rec.usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cached: u.input_tokens_details?.cached_tokens ?? 0,
      cacheWrite: u.input_tokens_details?.cache_write_tokens ?? 0,
      reasoning: u.output_tokens_details?.reasoning_tokens ?? 0
    }
    const calls = (json.output ?? []).filter((o) => o?.type === 'web_search_call')
    rec.webSearchCalls = calls.length
    rec.webSearchActions = calls.reduce((a, o) => { const k = String(o.action?.type ?? 'unknown'); a[k] = (a[k] ?? 0) + 1; return a }, {})
    rec.outputText = (json.output ?? []).flatMap((o) => o.content ?? []).filter((p) => p?.type === 'output_text').map((p) => p.text ?? '').join('')
    if (!res.ok) rec.error = String(json.error?.message ?? text).slice(0, 300)
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
  } catch (err) {
    rec.status = 0
    rec.ms = Date.now() - started
    rec.error = String(err?.message ?? err).slice(0, 300)
    throw err
  }
}

// ── what each call cost, priced by the server's own table ────────────────
const usd = (microCents) => microCents / 1e8
/* Two numbers, because what OpenAI bills for web_search is per call and not
 * in `usage`. `costUSD` is what the server's spend ledger records for this
 * route: tokens at server/shared/prices.js plus every web_search_call item,
 * never fewer than one (server.js searchFee). `costUSDSearchActionsOnly`
 * charges the fee for `search` actions only, which is what OpenAI's guide
 * attaches it to; the true bill is between the two. */
function costOf(openai) {
  let tokensMicro = 0
  let allCalls = 0
  let searchActions = 0
  let anySearchCall = false
  for (const r of openai) {
    if (!r.usage) continue
    tokensMicro += costMicroCents(r.modelEcho ?? r.model, r.usage)
    if (r.kind === 'search') {
      anySearchCall = true
      allCalls += r.webSearchCalls ?? 0
      searchActions += r.webSearchActions?.search ?? 0
    }
  }
  const routeCalls = anySearchCall ? Math.max(1, allCalls) : 0
  return {
    costUSD: usd(tokensMicro) + routeCalls * WEB_SEARCH_CALL_DOLLARS,
    costUSDSearchActionsOnly: usd(tokensMicro) + searchActions * WEB_SEARCH_CALL_DOLLARS,
    tokensUSD: usd(tokensMicro),
    webSearchCalls: allCalls,
    webSearchSearchActions: searchActions
  }
}

const sumUsage = (rs) => rs.reduce((a, r) => {
  for (const k of ['input', 'output', 'cached', 'cacheWrite', 'reasoning']) a[k] += r.usage?.[k] ?? 0
  return a
}, { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 })

// ── reading the verify call back ─────────────────────────────────────────
/* sourceVerify.js sends `SOURCE <i>: <title>\n"""\n<text>\n"""` per source it
 * could read, <i> being the index in the list findSources returns. Parsed
 * defensively: a branch that changes that format still gets its raw input and
 * output recorded, and any per-source `verified` the library itself sets wins
 * over the one derived here. */
function parseVerify(rec) {
  const read = new Map()
  if (rec?.input) {
    const re = /\nSOURCE (\d+): [^\n]*\n"""\n([\s\S]*?)\n"""/g
    let m
    while ((m = re.exec(rec.input))) read.set(Number(m[1]), m[2])
  }
  const verdicts = new Map()
  try {
    for (const v of JSON.parse(rec?.outputText || '{}').verdicts ?? []) verdicts.set(v?.id, v)
  } catch {}
  return { read, verdicts }
}

/* The search model's own answer, by URL: its stance and snippet before the
 * verifier rewrote either. A source absent from it was harvested from the
 * answer's url_citation annotations (stance "context"). */
function parseSearch(rec) {
  const byUrl = new Map()
  const text = rec?.outputText ?? ''
  const m = text.match(/\{[\s\S]*"sources"[\s\S]*\}/)
  if (!m) return byUrl
  try {
    for (const s of JSON.parse(m[0]).sources ?? []) {
      const url = String(s?.url ?? '').trim().slice(0, 600)
      if (url && !byUrl.has(url)) byUrl.set(url, s)
    }
  } catch {}
  return byUrl
}

const VERDICT_STANCE = { backs: 'supports', contradicts: 'refutes', topic: 'context' }

function sourceRecord(s, i, verify, search) {
  const fromSearch = search.get(s.url)
  const v = verify.verdicts.get(i)
  const derived = verify.read.has(i) && Boolean(v && VERDICT_STANCE[v.verdict])
  const authors = Array.isArray(s.authors) ? s.authors : []
  return {
    rank: i + 1,
    title: s.title ?? null,
    url: s.url ?? null,
    doi: s.doi || doiOf(s) || null,
    authors,
    groupAuthor: s.groupAuthor || null,
    year: s.year ?? null,
    date: s.date || null,
    venue: s.container || s.publisher || null,
    container: s.container || null,
    publisher: s.publisher || null,
    kind: s.kind ?? null,
    snippet: s.snippet ?? null,
    stance: s.stance ?? null,
    // extension/content.js backingSources, for a sentence NOT flagged false:
    // stance "supports" (or none at all) is offered; refutes and context are not.
    shownAsBacking: s.stance === undefined || s.stance === 'supports',
    searchStance: fromSearch ? (fromSearch.stance ?? null) : 'context',
    searchSnippet: fromSearch ? (fromSearch.snippet ?? null) : null,
    fromSearchAnswer: Boolean(fromSearch),
    verified: typeof s.verified === 'boolean' ? s.verified : derived,
    verifiedFrom: typeof s.verified === 'boolean' ? 'lib' : 'derived',
    verifyVerdict: v?.verdict ?? null,
    verifyQuote: v?.quote ?? null,
    verifierText: verify.read.get(i) ?? null
  }
}

const KNOWN_RESULT_KEYS = new Set(['sources', 'model', 'usage', 'webSearchCalls', 'webSearchActions', 'enriched', 'dropped', 'verified'])

async function runClaim(c) {
  const ctx = { openai: [], other: [] }
  const t0 = Date.now()
  let result
  let error = null
  try {
    // The route's call, as POST /api/sources makes it for a hosted free caller:
    // no correction (a plain claim), the extension's context, the server's
    // model and effort, enrichment and verification on.
    result = await als.run(ctx, () => findSources({ claim: c.claim, context: c.paragraph, model: MODEL, effort: EFFORT }))
  } catch (err) {
    error = { kind: err?.kind ?? null, message: String(err?.message ?? err).slice(0, 300) }
  }
  const searchRec = ctx.openai.find((r) => r.kind === 'search')
  const verifyRec = ctx.openai.find((r) => r.kind === 'verify')
  const verify = parseVerify(verifyRec)
  const search = parseSearch(searchRec)
  const sources = (result?.sources ?? []).map((s, i) => sourceRecord(s, i, verify, search))
  const extra = result ? Object.fromEntries(Object.entries(result).filter(([k]) => !KNOWN_RESULT_KEYS.has(k))) : {}
  return {
    id: c.id,
    essay: c.essay,
    labelPrefix: c.labelPrefix,
    claim: c.claim,
    claimType: c.claimType,
    context: c.paragraph,
    status: error ? 'error' : 'ok',
    ...(error ? { error } : {}),
    latencyMs: Date.now() - t0,
    modelEcho: result?.model ?? searchRec?.modelEcho ?? null,
    effortSent: { search: searchRec?.effortSent ?? null, verify: verifyRec?.effortSent ?? null },
    enriched: result?.enriched ?? null,
    droppedDeadLinks: result?.dropped ?? null,
    // The aggregate the route logs and strips: how many sources the verifier
    // read, and how many stances it changed.
    verify: result?.verified ?? null,
    verifyCall: verifyRec ? { input: verifyRec.input, output: verifyRec.outputText ?? null, status: verifyRec.status, error: verifyRec.error ?? null } : null,
    usage: { search: searchRec?.usage ?? null, verify: verifyRec?.usage ?? null, total: sumUsage(ctx.openai) },
    webSearchActions: searchRec?.webSearchActions ?? null,
    ...costOf(ctx.openai),
    sources,
    ...(Object.keys(extra).length ? { extra } : {}),
    http: ctx.other.map((r) => ({ url: r.url, status: r.status, ms: r.ms, ...(r.error ? { error: r.error } : {}) }))
  }
}

function summarize(records) {
  const ok = records.filter((r) => r.status === 'ok')
  const all = ok.flatMap((r) => r.sources)
  const stanceMix = {}
  const searchStanceMix = {}
  for (const s of all) {
    stanceMix[s.stance] = (stanceMix[s.stance] ?? 0) + 1
    searchStanceMix[s.searchStance] = (searchStanceMix[s.searchStance] ?? 0) + 1
  }
  return {
    claimsRun: records.length,
    claimsOk: ok.length,
    claimsErrored: records.length - ok.length,
    sourcesReturned: all.length,
    sourcesShownAsBacking: all.filter((s) => s.shownAsBacking).length,
    sourcesVerified: all.filter((s) => s.verified).length,
    stanceMix,
    searchStanceMix,
    stancesChangedByVerify: ok.reduce((a, r) => a + (r.verify?.changed ?? 0), 0),
    emptyResults: records.filter((r) => r.status !== 'ok' || r.sources.length === 0).map((r) => r.id),
    claimsWithNoBackingShown: ok.filter((r) => !r.sources.some((s) => s.shownAsBacking)).map((r) => r.id),
    costUSD: round(records.reduce((a, r) => a + (r.costUSD ?? 0), 0), 6),
    costUSDSearchActionsOnly: round(records.reduce((a, r) => a + (r.costUSDSearchActionsOnly ?? 0), 0), 6),
    tokensUSD: round(records.reduce((a, r) => a + (r.tokensUSD ?? 0), 0), 6),
    webSearchCalls: records.reduce((a, r) => a + (r.webSearchCalls ?? 0), 0),
    usage: records.reduce((a, r) => {
      for (const k of Object.keys(a)) a[k] += r.usage?.total?.[k] ?? 0
      return a
    }, { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 })
  }
}
const round = (x, p) => Math.round(x * 10 ** p) / 10 ** p

function writeAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n')
  renameSync(tmp, path)
}

// ── run ──────────────────────────────────────────────────────────────────
let prior = []
if (existsSync(outPath)) {
  if (!flag('resume')) { console.error(`${outPath} exists — pass --resume to keep its ok claims, or choose another --out`); process.exit(2) }
  prior = (JSON.parse(readFileSync(outPath, 'utf8')).claims ?? []).filter((r) => r.status === 'ok')
}
const done = new Map(prior.map((r) => [r.id, r]))
const todo = claims.filter((c) => !done.has(c.id))

const meta = {
  run: 'extension "Find a source" — POST /api/sources as findSources (server/lib/factcheck.js) + verifySources (server/lib/sourceVerify.js)',
  startedAt: new Date().toISOString(),
  gitCommit: git('rev-parse HEAD'),
  gitBranch: git('rev-parse --abbrev-ref HEAD'),
  serverLibDirty: git('status --porcelain -- server/lib server/shared') || null,
  node: process.version,
  plan: PLAN,
  model: MODEL,
  effort: EFFORT,
  modelPolicy: 'server/shared/plan.js modelForRoute("sources", "free") — what a hosted server runs for every free caller',
  context: "the claim's own paragraph from eval/essays/ (findSources then keeps ±1,200 characters around the claim, claimWindow)",
  backingRule: 'extension/content.js backingSources for a sentence not flagged false: shown = stance "supports" (or no stance)',
  verifiedRule: 'verified = the verifier read this source\'s own text (abstract from OpenAlex, or the page) and returned a verdict for it — derived from the verify call, since sourceVerify.js keeps no per-source flag; a per-source `verified` the library sets is used instead when present (verifiedFrom: "lib")',
  costRule: 'costUSD = tokens at server/shared/prices.js + $0.01 per web_search_call item (min 1 per search), as the route records it; costUSDSearchActionsOnly charges only action "search" items',
  capUSD: cap,
  concurrency
}

let spent = prior.reduce((a, r) => a + (r.costUSD ?? 0), 0)
let reserved = 0
let worstSeen = 0
let stopped = null
const records = new Map(done)
const save = () => {
  const ordered = claims.map((c) => records.get(c.id)).filter(Boolean)
  writeAtomic(outPath, { meta: { ...meta, finishedAt: new Date().toISOString(), stoppedBy: stopped }, summary: summarize(ordered), claims: ordered })
}

console.log(`${todo.length} claim(s) to run on ${MODEL}@${EFFORT} (${done.size} kept from --resume). Cap $${cap.toFixed(2)}.`)
const queue = [...todo]
async function worker() {
  for (;;) {
    if (stopped) return
    const c = queue.shift()
    if (!c) return
    const est = worstSeen ? worstSeen * 1.5 : PRIOR_USD
    if (spent + reserved + est > cap) {
      stopped = `cap: $${spent.toFixed(4)} spent + $${reserved.toFixed(4)} in flight + $${est.toFixed(4)} for ${c.id} would pass $${cap}`
      console.log(`STOP — ${stopped}`)
      return
    }
    reserved += est
    const rec = await runClaim(c)
    reserved -= est
    spent += rec.costUSD
    worstSeen = Math.max(worstSeen, rec.costUSD)
    records.set(c.id, rec)
    save()
    const shown = rec.sources.filter((s) => s.shownAsBacking).length
    console.log(`${c.id} ${rec.status}${rec.error ? ` (${rec.error.message.slice(0, 60)})` : ''}  sources=${rec.sources.length} shown=${shown} verified=${rec.sources.filter((s) => s.verified).length}  $${rec.costUSD.toFixed(4)}  ${(rec.latencyMs / 1000).toFixed(1)}s  [total $${spent.toFixed(4)}]`)
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))
save()
const s = summarize(claims.map((c) => records.get(c.id)).filter(Boolean))
console.log(JSON.stringify(s, null, 1))
console.log(`Wrote ${outPath}`)
