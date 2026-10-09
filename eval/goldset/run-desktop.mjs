#!/usr/bin/env node
// Run 2 of the gold-set baseline: the desktop's evidence search, as a writer
// sees it today — free, no model call anywhere.
//
//   node eval/goldset/run-desktop.mjs --out eval/goldset/runs/2026-10-07-desktop.json [--claims 01,05-c1]
//
// Bundles eval/goldset/desktop-entry.ts with esbuild the way scripts/evaluate.mjs
// bundles the eval harness (the @shared alias, the three compile-time
// constants, sql.js external, the ML worker as its own .cjs) into out/goldset/
// (gitignored), then runs each claim through src/main/services/search/
// aggregator.ts findEvidence with the claim text and the search query the
// desktop's detector produced for it (eval/reports/, joined by
// eval/retrieval/load.mjs). No detection: the claims are given.
//
// Differences from scripts/evaluate.mjs, all deliberate:
//   - __API_URL__ is "" — the app's kill switch — so the paid web fallback
//     (/api/find-sources) and every other server call refuse locally. Which
//     claims WOULD have called it is recorded (wouldCallWebFallback).
//   - No cassettes. evaluate.mjs replays August's recordings; this measures
//     today's providers.
//   - The ML worker loads the bundled MiniLM from resources/models, as a
//     packaged build does, instead of downloading. Stance is off in every
//     build (ml/index.ts STANCE_ENABLED), so nothing else differs.
//   - A fresh scratch data dir per run: no cached evidence, no config.json
//     keys (Semantic Scholar and NCBI keyless, as a default install).
//   - Claims run one at a time, as the harness does (PubMed's throttle is a
//     global gate; four public APIs in parallel across claims gets an IP
//     rate-limited).
//
// OpenAlex: a keyless search costs 10 credits of a $0.10/day budget (about 100
// searches a day; src/main/services/search/openalex.ts). A spent budget answers
// 429 and the provider returns nothing; every claim records the status its
// OpenAlex search got, and the summary counts the 429s.
import { AsyncLocalStorage } from 'node:async_hooks'
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { REPO } from '../retrieval/load.mjs'
import { filterClaims, goldClaims } from './claims.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1] }
const outArg = arg('out')
if (!outArg) { console.error('--out PATH is required'); process.exit(2) }
const outPath = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg)
const claims = filterClaims(goldClaims(), arg('claims'))
if (!claims.length) { console.error('no claims match --claims'); process.exit(2) }

const buildDir = join(REPO, 'out', 'goldset')
const bundlePath = join(buildDir, 'desktop.mjs')
const workerPath = join(buildDir, 'mlWorker.cjs')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dataDir = join(buildDir, 'data', stamp)
mkdirSync(dataDir, { recursive: true })

// The same build as scripts/evaluate.mjs, with the server URL compiled out.
await esbuild.build({
  entryPoints: [join(REPO, 'eval', 'goldset', 'desktop-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundlePath,
  alias: { '@shared': join(REPO, 'src', 'shared') },
  external: ['sql.js', 'dotenv'],
  banner: {
    js: "import{createRequire as __cr}from'module';import{fileURLToPath as __f}from'url';import{dirname as __d}from'path';const require=__cr(import.meta.url);const __filename=__f(import.meta.url);const __dirname=__d(__filename);"
  },
  define: { __API_URL__: '""', __SUPABASE_URL__: '""', __SUPABASE_ANON_KEY__: '""' },
  logLevel: 'warning'
})
await esbuild.build({
  entryPoints: [join(REPO, 'src', 'main', 'services', 'ml', 'worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: workerPath,
  external: ['@huggingface/transformers'],
  logLevel: 'warning'
})
process.env.TRACELY_ML_WORKER = workerPath

// A packaged build's resources dir, laid out as electron-builder lays it out:
// the bundled models (extraResources) and sql.js's wasm beside them. db.ts and
// the ML worker both read it when resourcesDir is set.
const resourcesDir = join(buildDir, 'resources')
if (!existsSync(join(resourcesDir, 'models'))) cpSync(join(REPO, 'resources', 'models'), join(resourcesDir, 'models'), { recursive: true })
if (!existsSync(join(resourcesDir, 'sql-wasm.wasm'))) cpSync(join(REPO, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'), join(resourcesDir, 'sql-wasm.wasm'))

// ── per-claim HTTP record, and the guard ────────────────────────────────
// Host, path and status only — never headers. Anything bound for the Tracely
// server or OpenAI is refused before it leaves the process (the bundle cannot
// reach them anyway; this is the second lock).
const PAID = /^https:\/\/(api\.jointracely\.com|api\.openai\.com)\//
const als = new AsyncLocalStorage()
const realFetch = globalThis.fetch
globalThis.fetch = async function guardedFetch(input, init) {
  const url = typeof input === 'string' ? input : input?.url ?? String(input)
  const ctx = als.getStore()
  if (PAID.test(url)) {
    ctx?.http.push({ url: url.slice(0, 200), status: 'blocked' })
    return new Response(JSON.stringify({ error: { kind: 'eval_blocked', message: 'goldset desktop run makes no paid calls' } }), { status: 403, headers: { 'content-type': 'application/json' } })
  }
  if (!ctx) return realFetch(input, init)
  const rec = { url: url.slice(0, 300), started: Date.now() }
  ctx.http.push(rec)
  try {
    const res = await realFetch(input, init)
    rec.status = res.status
    return res
  } catch (err) {
    rec.status = 0
    rec.error = String(err?.name ?? err).slice(0, 80)
    throw err
  } finally {
    rec.ms = Date.now() - rec.started
    delete rec.started
  }
}

const hostOf = (u) => { try { return new URL(u).host } catch { return '?' } }
function providerCalls(http) {
  const out = {}
  for (const r of http) {
    const k = hostOf(r.url)
    const e = (out[k] ??= { calls: 0, statuses: {} })
    e.calls++
    e.statuses[r.status] = (e.statuses[r.status] ?? 0) + 1
  }
  return out
}

const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: REPO, encoding: 'utf8' }).trim() } catch { return null } }

const desktop = await import(pathToFileURL(bundlePath).href)
const ready = await desktop.setup({ repoRoot: REPO, dataDir, resourcesDir })
console.log(`setup: ml=${ready.mlAvailable} worldBank=${ready.worldBankReady} api="${ready.apiUrl}" — ${claims.length} claim(s)`)

const meta = {
  run: 'desktop evidence search — src/main/services/search/aggregator.ts findEvidence, shown list as the editor picker orders it',
  startedAt: new Date().toISOString(),
  gitCommit: git('rev-parse HEAD'),
  gitBranch: git('rev-parse --abbrev-ref HEAD'),
  srcSearchDirty: git('status --porcelain -- src/main/services/search src/shared') || null,
  node: process.version,
  input: 'claim text + the searchQuery the desktop detector produced for it in the August report (no detection this run)',
  shownRule: 'findEvidence evidence (relevance >= MIN_COUNTABLE_RELEVANCE, at most MAX_EVIDENCE_RESULTS), then byCredibility(credibilityOf) — AnalyzeView picker order; aggregatorRank is the order before that sort',
  webFallback: 'disabled: bundle built with __API_URL__ = "" and paid hosts refused at fetch; wouldCallWebFallback = findEvidence took a web search from takeWebSearch for this claim (budget reset per claim)',
  mlModel: 'bundled resources/models (all-MiniLM-L6-v2) from a packaged-style resources dir (out/goldset/resources), no download; stance disabled in every build',
  worldBankReady: ready.worldBankReady,
  mlAvailableAtStart: ready.mlAvailable,
  semanticScholarKey: Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY), // a default install has none, so Semantic Scholar is not asked
  ncbiKey: Boolean(process.env.NCBI_API_KEY),
  costUSD: 0
}

const records = []
const save = (final = false) => {
  const all = records.flatMap((r) => r.shown)
  const tiers = {}
  const providers = {}
  for (const s of all) {
    tiers[s.credibility.tier] = (tiers[s.credibility.tier] ?? 0) + 1
    providers[s.provider] = (providers[s.provider] ?? 0) + 1
  }
  const summary = {
    claimsRun: records.length,
    claimsErrored: records.filter((r) => r.error).length,
    sourcesShown: all.length,
    emptyResults: records.filter((r) => !r.error && r.shown.length === 0).map((r) => r.id),
    shownByProvider: providers,
    shownByCredibilityTier: tiers,
    wouldCallWebFallback: records.filter((r) => r.wouldCallWebFallback).map((r) => r.id),
    openalexSearch429: records.filter((r) => r.openalexSearchStatus === 429).map((r) => r.id),
    openalexSearchNotOk: records.filter((r) => r.openalexSearchStatus !== 200).map((r) => `${r.id}:${r.openalexSearchStatus}`),
    lexicalFallback: records.filter((r) => r.mlAvailable === false).map((r) => r.id),
    domains: records.reduce((a, r) => { a[r.domain] = (a[r.domain] ?? 0) + 1; return a }, {})
  }
  const tmp = `${outPath}.tmp-${process.pid}`
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(tmp, JSON.stringify({ meta: { ...meta, ...(final ? { finishedAt: new Date().toISOString() } : {}) }, summary, claims: records }, null, 1) + '\n')
  renameSync(tmp, outPath)
  return summary
}

for (const c of claims) {
  const ctx = { http: [] }
  const t0 = Date.now()
  let res = null
  let error = null
  try {
    res = await als.run(ctx, () => desktop.runClaim(c.claim, c.searchQuery))
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 300)
  }
  const oaSearch = ctx.http.find((r) => /^https:\/\/api\.openalex\.org\/works\?search=/.test(r.url))
  const rec = {
    id: c.id,
    essay: c.essay,
    labelPrefix: c.labelPrefix,
    claim: c.claim,
    claimType: c.claimType,
    searchQuery: c.searchQuery,
    ...(error ? { error } : {}),
    latencyMs: Date.now() - t0,
    domain: res?.domain ?? null,
    wouldCallWebFallback: res?.wouldCallWebFallback ?? null,
    mlAvailable: res?.mlAvailable ?? null,
    openalexSearchStatus: oaSearch ? oaSearch.status : null,
    strengthScore: res?.strengthScore ?? null,
    breakdown: res?.breakdown ?? null,
    shown: res?.shown ?? [],
    providerCalls: providerCalls(ctx.http)
  }
  records.push(rec)
  save()
  console.log(`${c.id} ${error ? 'ERROR ' + error.slice(0, 60) : 'ok'}  domain=${rec.domain} shown=${rec.shown.length} web=${rec.wouldCallWebFallback ? 'WOULD' : 'no'} openalex=${rec.openalexSearchStatus}  ${(rec.latencyMs / 1000).toFixed(1)}s`)
}

const summary = save(true)
await desktop.teardown()
console.log(JSON.stringify(summary, null, 1))
console.log(`Wrote ${outPath}`)
process.exit(0)
