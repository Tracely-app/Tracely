#!/usr/bin/env node
// The check, measured on PRODUCTION: every essay of the checksets goes to
// POST /api/check on api.jointracely.com exactly as the extension's first
// check of an opened document sends it (the document text, its sentences
// keyed by hashText(), at most 40), so the deployed prompt, model, effort,
// sharding and guards are what is measured — not this checkout's.
//
// Why production rather than run.mjs: the OpenAI key lives only on the server
// (docs/environments.md), so a laptop cannot call runFactCheck. The calls go
// through the BETA pool (X-Tracely-Beta, Pro limits, its own $10 day), so they
// never draw on the pool free users share. The token is read from the
// environment and never printed or written anywhere.
//
//   TRACELY_BETA_TOKEN=… node eval/models/harness/run-prod.mjs              # all four sets, their usual reps
//   node eval/models/harness/run-prod.mjs --dry                             # the plan, no network
//   node eval/models/harness/run-prod.mjs --score [--dir eval/models/results/prod-<date>]
//
// Options
//   --sets a,b      checkset, checkset-hard, checkset-narrative, checkset-long (default all)
//   --reps N        every set N reps (default: each set's reps in FINDINGS.md — 2, 2, 3, 3)
//   --base URL      default https://api.jointracely.com (a local server: http://localhost:4477)
//   --dir PATH      results root (default eval/models/results/prod-<UTC date>; gitignored)
//   --pace S        seconds between calls (default 4: the extension's 20/min caller limit)
//   --cap USD       stop before a call once this run's spend would pass it (default 1)
//   --score         score what is in --dir and exit
//
// Two configs are written per set, both read by score.mjs:
//   prod-<commit>      the server's verdicts, as the 2026-10-01 rows measured them
//   prod-<commit>+ext  what the extension on THIS checkout shows of them —
//                      content.js flagShown (an essay, citation hints on) and
//                      coveredByLaterCitation; a flag it hides leaves the
//                      sentence unmarked, scored as the label's unmarked
//                      verdict ("accurate" or "no_claim" — the writer sees
//                      the same nothing).
// Resumable: an essay already recorded ok for a rep is skipped.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import { MODELS_DIR, REPO, RESULTS, costUSD, hashText, writeJsonAtomic } from './lib/core.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1] }
const flag = (k) => argv.includes(`--${k}`)

const SET_REPS = { checkset: 2, 'checkset-hard': 2, 'checkset-narrative': 3, 'checkset-long': 3 }
const sets = (arg('sets') ? arg('sets').split(',').map((s) => s.trim()) : Object.keys(SET_REPS))
for (const s of sets) if (!SET_REPS[s]) { console.error(`unknown set "${s}" (known: ${Object.keys(SET_REPS).join(', ')})`); process.exit(2) }
const BASE = arg('base', 'https://api.jointracely.com')
const DIR = arg('dir', join(RESULTS, `prod-${new Date().toISOString().slice(0, 10)}`))
const PACE_MS = Number(arg('pace', 4)) * 1000
const CAP = Number(arg('cap', 1))
const dry = flag('dry')
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function score() {
  for (const set of sets) {
    const dir = join(DIR, set)
    if (!existsSync(dir)) continue
    console.log(`\n══ ${set}`)
    execFileSync(process.execPath, [join(MODELS_DIR, 'harness', 'score.mjs'), '--results', dir, '--checkset', join(MODELS_DIR, `${set}.json`), '--detail'], { stdio: 'inherit' })
  }
}
if (flag('score')) { score(); process.exit(0) }

/* ── what the extension shows ──────────────────────────────────────────────
 * flagShown and its rules, and coveredByLaterCitation, sliced out of
 * content.js by their anchors the way server/test/ext-* load it. FEATURES is
 * the one global flagShown reads from further down the file. */
function loadShown() {
  const src = readFileSync(join(REPO, 'extension', 'content.js'), 'utf8')
  const ANCHOR = '  // TEST ANCHOR (server/test/ext-*) — do not rename or re-indent the next line.\n'
  const a = src.indexOf(ANCHOR + '  const ISSUE_VERDICTS')
  const b = src.indexOf(ANCHOR, a + ANCHOR.length)
  const c = src.indexOf('  function coveredByLaterCitation(')
  const d = src.indexOf('\n  }\n', c)
  if (a < 0 || b < a || c < 0 || d < c) throw new Error('content.js: the flagShown or coveredByLaterCitation slice moved')
  return vm.runInContext(`const FEATURES = { citeHintsToggle: false };
    ${src.slice(a, b)}
    ${src.slice(c, d + 4)}
    ({ flagShown, coveredByLaterCitation })`, vm.createContext({}))
}
const SHOWN = loadShown()

/** The document text, as harness/lib/tasks.mjs essayText builds it, and each
 * sentence's span in it for coveredByLaterCitation. */
function essayDoc(essay) {
  const sents = essay.sentences.filter((s) => typeof s.text === 'string' && s.text.trim())
  let text = essay.text
  if (!(typeof text === 'string' && text.trim())) {
    const paras = []
    for (const s of sents) {
      const last = paras[paras.length - 1]
      if (last && last.key === s.paragraph) last.parts.push(s.text)
      else paras.push({ key: s.paragraph, parts: [s.text] })
    }
    text = paras.map((p) => p.parts.join(' ')).join('\n\n')
  }
  text = text.slice(0, 30_000) // content.js MAX_INPUT_CHARS
  let at = 0
  const segs = sents.map((s) => {
    const t = s.text.trim()
    const start = text.indexOf(t, at)
    if (start < 0) throw new Error(`${s.id}: sentence not found in its essay's text`)
    at = start + t.length
    return { id: s.id, text: t, hash: hashText(t), start, end: at }
  })
  return { text, segs }
}

/* ── the plan ─────────────────────────────────────────────────────────── */
const plan = []
for (const set of sets) {
  const checkset = JSON.parse(readFileSync(join(MODELS_DIR, `${set}.json`), 'utf8'))
  const reps = Number(arg('reps', SET_REPS[set]))
  for (const essay of checkset.essays) {
    const doc = essayDoc(essay)
    const byHash = new Map()
    for (const s of doc.segs) byHash.has(s.hash) ? byHash.get(s.hash).ids.push(s.id) : byHash.set(s.hash, { id: s.hash, text: s.text, ids: [s.id] })
    if (byHash.size > 40 || [...byHash.values()].some((s) => s.text.length > 2000)) throw new Error(`${set}/${essay.id} breaks /api/check's limits`)
    for (let rep = 1; rep <= reps; rep++) plan.push({ set, essay, doc, byHash, rep })
  }
}
const perSet = sets.map((s) => `${s} ${plan.filter((p) => p.set === s).length}`).join(', ')
log(`${plan.length} /api/check calls (${perSet}) -> ${BASE}; results in ${DIR}`)
if (dry) process.exit(0)

const TOKEN = (process.env.TRACELY_BETA_TOKEN || '').trim()
if (!TOKEN) { console.error('TRACELY_BETA_TOKEN is not set'); process.exit(2) }

// The release the run measured: production reports its commit on /api/status.
const status = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => ({}))
const release = String(status.release?.commit ?? 'unknown').slice(0, 7)
const CONFIG = `prod-${release}`
log(`production release ${release}${status.release?.deployedAt ? ` (deployed ${status.release.deployedAt})` : ''}`)

/* One file per (set, config); both configs share an install id per set so a
 * resumed run stays one caller. */
const files = new Map()
function fileFor(set, config) {
  const key = `${set}|${config}`
  if (files.has(key)) return files.get(key)
  const dir = join(DIR, set)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${config.replace('@', '_')}.json`)
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { config, base: BASE, release: status.release ?? null, records: [] }
  const entry = { path, file }
  files.set(key, entry)
  return entry
}
const save = ({ path, file }) => { file.updatedAt = new Date().toISOString(); writeJsonAtomic(path, file) }
const install = fileFor(sets[0], CONFIG).file.install ?? randomUUID()

let spent = 0
let first = true
for (const p of plan) {
  const item = `${p.essay.id}#0`
  const server = fileFor(p.set, CONFIG)
  if (server.file.records.some((r) => r.item === item && r.rep === p.rep && r.status === 'ok')) continue
  const est = Math.max(0.01, ...server.file.records.map((r) => r.costUSD * 1.5))
  if (spent + est > CAP) { log(`cap $${CAP} reached ($${spent.toFixed(4)} spent) — stopping before ${p.set}/${item} r${p.rep}`); break }
  if (!first) await sleep(PACE_MS)
  first = false

  const sentences = [...p.byHash.values()].map(({ id, text }) => ({ id, text }))
  let rec
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now()
    let res, body
    try {
      res = await fetch(`${BASE}/api/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tracely-Install': install, 'X-Tracely-Beta': TOKEN },
        body: JSON.stringify({ text: p.doc.text, sentences }),
        signal: AbortSignal.timeout(120_000)
      })
      body = await res.json().catch(() => ({}))
    } catch (err) {
      res = { ok: false, status: 0 }
      body = { error: { kind: 'network', message: String(err?.message ?? err) } }
    }
    if ((res.status === 429 || res.status === 0 || res.status >= 500) && attempt < 3) {
      const wait = res.status === 429 ? Math.max(30, Number(res.headers?.get?.('retry-after')) || 60) * 1000 : 15_000
      log(`${p.set}/${item} r${p.rep} ${res.status} ${body?.error?.kind ?? ''} — retry in ${Math.round(wait / 1000)}s`)
      await sleep(wait)
      continue
    }
    const u = body.usage ?? {}
    const usage = { input: u.input ?? 0, cached: u.cached ?? 0, cacheWrite: u.cacheWrite ?? 0, output: u.output ?? 0, reasoning: u.reasoning ?? 0 }
    const model = String(body.modelUsed ?? body.model ?? 'gpt-5.6-luna').replace(/ \(mock\)$/, '')
    const cost = res.ok ? costUSD(model, usage) ?? 0 : 0
    const found = new Map((Array.isArray(body.findings) ? body.findings : []).map((f) => [f.id, f]))
    const findings = []
    for (const { id, ids } of p.byHash.values()) {
      const f = found.get(id)
      for (const cid of ids) findings.push(f ? { id: cid, hash: id, verdict: f.verdict, confidence: f.confidence, explanation: f.explanation, basis: f.basis, revision: f.revision } : { id: cid, hash: id, verdict: null, missing: true })
    }
    rec = {
      task: 'check', item, rep: p.rep, config: CONFIG, model, effort: 'server', latencyMs: Date.now() - t0,
      usage, costUSD: cost, status: res.ok ? 'ok' : 'error', attempts: attempt,
      ...(res.ok ? {} : { error: { kind: body?.error?.kind ?? 'http', message: String(body?.error?.message ?? '').slice(0, 300), status: res.status } }),
      output: res.ok ? { findings, missing: findings.filter((f) => f.missing).length, sentCount: sentences.length, contextChars: p.doc.text.length, plan: body.plan ?? null, serverMs: body.ms ?? null } : null,
      modelEcho: body.modelUsed ?? null, batchIds: p.doc.segs.map((s) => s.id),
      http: [{ status: res.status }], truncatedHttp: 0, effortMismatch: false
    }
    break
  }
  spent += rec.costUSD
  server.file.install = install
  server.file.records = server.file.records.filter((r) => !(r.item === item && r.rep === p.rep))
  server.file.records.push(rec)
  save(server)

  // The same answer, as the extension on this checkout would mark it.
  const ext = fileFor(p.set, `${CONFIG}+ext`)
  const covered = SHOWN.coveredByLaterCitation(p.doc.text, p.doc.segs)
  const textOf = new Map(p.doc.segs.map((s) => [s.id, s.text]))
  // A hidden flag leaves the sentence unmarked, and "accurate" and
  // "no_claim" are both unmarked to the writer: score it as whichever of the
  // two the label accepts.
  const unmarked = new Map(p.essay.sentences.map((s) => [s.id, (s.acceptable ?? []).includes('accurate') || !(s.acceptable ?? []).includes('no_claim') ? 'accurate' : 'no_claim']))
  ext.file.records = ext.file.records.filter((r) => !(r.item === item && r.rep === p.rep))
  ext.file.records.push({
    ...rec, config: `${CONFIG}+ext`,
    output: rec.output && {
      ...rec.output,
      findings: rec.output.findings.map((f) => {
        if (f.missing || !['false', 'questionable', 'incoherent', 'needs_citation'].includes(f.verdict)) return f
        return SHOWN.flagShown(f, {}, 'essay', textOf.get(f.id), covered.has(f.hash)) ? f : { ...f, verdict: unmarked.get(f.id), hiddenVerdict: f.verdict }
      })
    }
  })
  save(ext)

  const counts = rec.output ? rec.output.findings.reduce((a, f) => ((a[f.verdict ?? 'MISSING'] = (a[f.verdict ?? 'MISSING'] ?? 0) + 1), a), {}) : {}
  log(`${p.set}/${item} r${p.rep} ${rec.status}${rec.error ? ` ${rec.error.status} ${rec.error.kind}` : ''} ${rec.latencyMs}ms $${rec.costUSD.toFixed(5)} ${rec.model} ${JSON.stringify(counts)}`)
}
log(`done: $${spent.toFixed(4)} this run (token prices; the beta pool's ledger is the bill)`)
score()
