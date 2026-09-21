#!/usr/bin/env node
// Model eval driver: runs candidate {model, effort} configs through Tracely's
// production check + critique code paths and records every call.
//
//   OPENAI_API_KEY=... node eval/models/harness/run.mjs --configs gpt-5.6-luna@medium,gpt-6-astra@low \
//       --tasks check,critique --reps 2   # results land in eval/models/results/ (gitignored)
//
// Options
//   --configs a,b | all       model@effort list ("none" = no reasoning param)
//   --tasks check,critique    default both
//   --reps N                  repetitions per item (default 1)
//   --out PATH                result file; "<config>" / "{config}" is replaced by
//                             the config id with @ -> _ (default eval/models/results/<config>.json)
//   --checkset PATH           default eval/models/checkset.json
//   --essays id1,id2          only these checkset essays
//   --sentences N             only the first N sentences of each essay
//   --batch N                 sentences per /api/check call (default 40 = extension max)
//   --claims C01,C05|prefix   only these critique items
//   --config-concurrency N    configs in flight (default 4)
//   --per-config N            calls in flight per config (default 2)
//   --cap USD                 global spend stop (default 12, ledger-wide)
//   --retry-errors            re-run items whose recorded status is not ok
//   --dry                     list what would run, make no calls
//
// Resumable: an item already recorded with status "ok" for a rep is skipped.
// Spend: every call reserves an estimate in eval/models/results/spend-ledger.jsonl before it
// starts and settles its real cost after; a call is refused when settled +
// open reservations + its own reservation would reach --cap.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  LEDGER, MODELS_DIR, REPO, RESULTS, PRICES, SPEND_CAP_USD, addUsage, als, installFetchCapture, ledgerSpent,
  parseConfig, reserve, settle, writeJsonAtomic
} from './lib/core.mjs'

const ALL = ['gpt-5-nano@low', 'gpt-5-nano@medium', 'gpt-5.4-nano@low', 'gpt-5.6-luna@low', 'gpt-5.6-luna@medium',
  'gpt-5-mini@low', 'gpt-5.4-mini@low', 'gpt-5.4-mini@medium', 'gpt-5.6-terra@low', 'gpt-5.4@low', 'gpt-6-astra@low',
  'gpt-4.1@none', 'gpt-4.1-mini@none']

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1] }
const flag = (k) => argv.includes(`--${k}`)
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null)

const configs = (arg('configs') === 'all' ? ALL : list(arg('configs')) ?? []).map(parseConfig)
if (!configs.length) { console.error('--configs required'); process.exit(2) }
const tasks = list(arg('tasks', 'check,critique'))
const reps = Number(arg('reps', 1))
const cap = Number(arg('cap', SPEND_CAP_USD))
const outTpl = arg('out', join(RESULTS, '<config>.json'))
const cfgConc = Number(arg('config-concurrency', 4))
const perCfg = Number(arg('per-config', 2))
const dry = flag('dry')
const retryErrors = flag('retry-errors')
const outFor = (cfg) => {
  const p = outTpl.replace(/<config>|\{config\}/g, cfg.id.replace('@', '_'))
  return isAbsolute(p) ? p : join(process.cwd(), p)
}
if (configs.length > 1 && !/<config>|\{config\}/.test(outTpl)) { console.error('--out must contain <config> when running several configs'); process.exit(2) }
if (!dry && !process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set'); process.exit(2) }
if (!dry) mkdirSync(dirname(LEDGER), { recursive: true })

/* A candidate that is not one of the server's tiers would be coerced to the
 * fast tier by chooseModel (lib/llm.js) and silently measured as something
 * else. So such a model is admitted IN THIS PROCESS ONLY by adding it to the
 * server's exported ALLOWED_MODELS set — the same module instance factcheck.js
 * and reasoning.js read — and nothing on disk changes. The three tier models
 * need nothing. */
const { ALLOWED_MODELS } = await import(pathToFileURL(join(REPO, 'server/lib/llm.js')).href)
for (const cfg of configs) {
  if (!ALLOWED_MODELS.has(cfg.model)) {
    ALLOWED_MODELS.add(cfg.model)
    console.log(`note: ${cfg.model} is not a server tier; admitted for this run only`)
  }
}

const { checkItems, critiqueItems, runCheck, runCritique } = await import('./lib/tasks.mjs')
let items = []
if (tasks.includes('check')) {
  const csPath = arg('checkset', join(MODELS_DIR, 'checkset.json'))
  if (!existsSync(csPath)) { console.error(`no checkset at ${csPath}`); process.exit(2) }
  const checkset = JSON.parse(readFileSync(csPath, 'utf8'))
  items.push(...checkItems(checkset, { batchSize: Number(arg('batch', 40)), essayFilter: list(arg('essays')), sentenceLimit: arg('sentences') ? Number(arg('sentences')) : null }))
}
if (tasks.includes('critique')) items.push(...critiqueItems({ claimFilter: list(arg('claims')) }))

installFetchCapture()
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
let budgetHit = false

// Prior reservation per call (USD) before anything is observed: generous token
// guesses at list price. Replaced by 1.5x the largest cost seen for the same
// config+task once one call has settled.
const PRIOR_TOKENS = { check: { input: 4000, output: 6000 }, critique: { input: 3000, output: 5000 } }
const priorUSD = (cfg, task) => { const p = PRICES[cfg.model]; const t = PRIOR_TOKENS[task]; return (t.input * p.input + t.output * p.output) / 1e6 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runOne(cfg, it, rep, state) {
  const key = `${it.task}|${it.item}|${rep}`
  const observed = state.maxCost[it.task]
  const est = observed ? observed * 1.5 : priorUSD(cfg, it.task)
  const started = Date.now()
  const allHttp = []
  let attempt = 0
  let rec
  while (true) {
    attempt++
    const rid = reserve(est, cap)
    if (!rid) { budgetHit = true; return null }
    const ctx = { http: [] }
    const t0 = Date.now()
    let res, err
    try {
      res = await als.run(ctx, () => (it.task === 'check' ? runCheck(it, cfg) : runCritique(it, cfg)))
    } catch (e) { err = e }
    const usage = ctx.http.reduce((a, h) => addUsage(a, h.usage), {})
    const cost = ctx.http.reduce((a, h) => a + (h.costUSD ?? 0), 0)
    settle(rid, cost, { config: cfg.id, task: it.task, item: it.item })
    allHttp.push(...ctx.http.map((h) => ({ ...h, attempt })))
    const kind = err?.kind ?? (err ? 'exception' : null)
    rec = {
      task: it.task, item: it.item, rep, config: cfg.id, model: cfg.model, effort: cfg.effort,
      latencyMs: Date.now() - t0, usage, costUSD: cost,
      status: !err ? 'ok' : kind === 'truncated' ? 'truncated' : kind === 'timeout' ? 'timeout' : 'error',
      ...(err ? { error: { kind, message: String(err?.message ?? err).slice(0, 400), status: err?.status ?? null } } : {}),
      output: res?.output ?? null,
      modelEcho: res?.modelEcho ?? ctx.http.find((h) => h.modelEcho)?.modelEcho ?? null,
      httpCalls: ctx.http.length,
      ...(it.task === 'check' ? { batchIds: it.batch.map((s) => s.id) } : {})
    }
    // Transport-level failures only (429 / 5xx / network): not model quality.
    const lastStatus = ctx.http.at(-1)?.status
    const retryable = err && (kind === 'rate_limit' || kind === 'network' || (kind === 'server' && (lastStatus === 0 || lastStatus >= 500)))
    if (retryable && attempt < 4) {
      log(`${cfg.id} ${key} ${kind} (${rec.error.message.slice(0, 80)}) — retry ${attempt}`)
      await sleep([5000, 15000, 30000][attempt - 1])
      continue
    }
    break
  }
  // Totals across harness retries (failed attempts can still be billed).
  rec.attempts = attempt
  rec.totalMs = Date.now() - started
  rec.costUSD = allHttp.reduce((a, h) => a + (h.costUSD ?? 0), 0)
  rec.usage = allHttp.reduce((a, h) => addUsage(a, h.usage), {})
  // Effort actually sent vs asked for (structuredCall silently drops effort for
  // a model after a 400 that blames it — that must not pass unnoticed).
  const sent = [...new Set(allHttp.map((h) => h.effortSent))]
  rec.effortSent = sent
  rec.effortMismatch = allHttp.some((h) => h.effortSent !== (cfg.effortParam ?? null))
  rec.truncatedHttp = allHttp.filter((h) => h.responseStatus === 'incomplete').length
  rec.http = allHttp.map(({ outputText, ...h }) => h)
  rec.rawOutputs = allHttp.map((h) => h.outputText ?? null)
  if (rec.costUSD > (state.maxCost[it.task] ?? 0)) state.maxCost[it.task] = rec.costUSD
  return rec
}

async function runConfig(cfg) {
  const out = outFor(cfg)
  if (!dry) mkdirSync(dirname(out), { recursive: true })
  const file = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : { config: cfg.id, model: cfg.model, effort: cfg.effort, records: [] }
  const state = { maxCost: {} }
  for (const r of file.records) if (r.costUSD > (state.maxCost[r.task] ?? 0)) state.maxCost[r.task] = r.costUSD
  const done = new Set(file.records.filter((r) => r.status === 'ok' || !retryErrors).map((r) => `${r.task}|${r.item}|${r.rep}`))
  const queue = []
  for (let rep = 1; rep <= reps; rep++) for (const it of items) if (!done.has(`${it.task}|${it.item}|${rep}`)) queue.push({ it, rep })
  log(`${cfg.id}: ${queue.length} call(s) to run -> ${out}`)
  if (dry) return
  const save = () => { file.updatedAt = new Date().toISOString(); writeJsonAtomic(out, file) }
  async function worker() {
    while (queue.length && !budgetHit) {
      const { it, rep } = queue.shift()
      const rec = await runOne(cfg, it, rep, state)
      if (!rec) { log(`${cfg.id}: SPEND CAP $${cap} reached — not starting ${it.task}|${it.item}`); return }
      file.records = file.records.filter((r) => !(r.task === rec.task && r.item === rec.item && r.rep === rec.rep))
      file.records.push(rec)
      save()
      log(`${cfg.id} ${rec.task} ${rec.item} r${rep} ${rec.status} ${rec.latencyMs}ms $${rec.costUSD.toFixed(5)} in=${rec.usage.input} out=${rec.usage.output} rsn=${rec.usage.reasoning}${rec.error ? ' ' + rec.error.message.slice(0, 100) : ''}`)
    }
  }
  await Promise.all(Array.from({ length: perCfg }, worker))
}

const before = ledgerSpent()
log(`items/config: ${items.length} × ${reps} rep(s); configs: ${configs.map((c) => c.id).join(', ')}; ledger spent $${before.settled.toFixed(4)} (+$${before.reserved.toFixed(4)} reserved), cap $${cap}`)
const cq = [...configs]
await Promise.all(Array.from({ length: Math.min(cfgConc, cq.length) }, async () => { while (cq.length) await runConfig(cq.shift()) }))
const after = ledgerSpent()
log(`done. this run $${(after.settled - before.settled).toFixed(4)}; ledger total $${after.settled.toFixed(4)}${budgetHit ? ' — STOPPED AT SPEND CAP' : ''}`)
process.exit(budgetHit ? 3 : 0)
