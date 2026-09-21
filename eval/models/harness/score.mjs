#!/usr/bin/env node
// Scores run.mjs result files.
//
//   node eval/models/harness/score.mjs [--results DIR] [--checkset PATH] [--expected PATH]
//                  [--configs a@x,b@y] [--rep N] [--json OUT.json] [--detail]
//
// CHECK (checkset.json scoring block): strict accuracy = verdict in `acceptable`;
//   partial-credit score = acceptable 1 + `partial` 0.5; `critical` counted apart;
//   a missing finding scores 0 and is counted apart.
//   false-alarm rate  = any flag (flag_of_verdict != none) on cited /
//                       common_knowledge / opinion sentences
//   FALSE miss rate   = label "false" and verdict != "false"
//                       (split: softened to questionable / endorsed = critical)
//   needs_citation miss = label "true_uncited" and verdict != "needs_citation"
//   plus a per-label breakdown.
// CRITIQUE (mirrors eval/critique/score.mjs): within-acceptable count; firing of
//   fabricated / contradicted / overstated; unsupported split into "about the
//   evidence" vs retrieval miss (breakdown.sourceCount === 0, from
//   critique-inputs.json); correct sentences accused; fabrication caught / HARM.
// COST/LATENCY: mean cost per call, cost per 20 sentences of checking (linear in
//   sentences), p50/p90 latency of ok calls, error / truncation / timeout /
//   effort-mismatch counts. With --reps > 1 every rate is over all (item, rep).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODELS_DIR, REPO, RESULTS, PRICES } from './lib/core.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1] }
const resultsDir = arg('results', RESULTS)
const checksetPath = arg('checkset', join(MODELS_DIR, 'checkset.json'))
const expectedPath = arg('expected', join(REPO, 'eval/critique/expected.json'))
const inputsPath = join(MODELS_DIR, 'critique-inputs.json')
const only = arg('configs') ? arg('configs').split(',') : null
const detail = argv.includes('--detail')

const files = readdirSync(resultsDir).filter((f) => f.endsWith('.json'))
const runs = files.map((f) => JSON.parse(readFileSync(join(resultsDir, f), 'utf8'))).filter((r) => r.records && (!only || only.includes(r.config)))
// --rep N: score only that repetition (run-to-run variance).
const repOnly = arg('rep') ? Number(arg('rep')) : null
if (repOnly) for (const r of runs) r.records = r.records.filter((x) => x.rep === repOnly)

const checkset = existsSync(checksetPath) ? JSON.parse(readFileSync(checksetPath, 'utf8')) : null
const flagOf = checkset?.flag_of_verdict ?? { false: 'false', needs_citation: 'needs_citation', questionable: 'questionable', incoherent: 'incoherent', accurate: 'none', no_claim: 'none' }
const sentences = new Map()
for (const e of checkset?.essays ?? []) for (const s of e.sentences) sentences.set(s.id, { ...s, essay: e.id })
const expected = JSON.parse(readFileSync(expectedPath, 'utf8')).claims.filter((c) => c.claim)
const inputs = existsSync(inputsPath) ? JSON.parse(readFileSync(inputsPath, 'utf8')) : {}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : '—')
const quant = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] }
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const cents = (usd) => (usd == null ? '—' : `${(usd * 100).toFixed(3)}¢`)

function scoreCheck(recs) {
  const ok = recs.filter((r) => r.status === 'ok')
  const rows = [] // one per (sentence, rep) that was attempted
  for (const r of recs) {
    const bySentence = new Map((r.output?.findings ?? []).map((f) => [f.id, f]))
    // Every sentence of the batch, even when the call failed (scores 0).
    const essayId = r.item.split('#')[0]
    const inBatch = r.batchIds ? new Set(r.batchIds) : null
    for (const s of sentences.values()) {
      if (s.essay !== essayId) continue
      if (inBatch ? !inBatch.has(s.id) : r.output && !bySentence.has(s.id)) continue // not in this batch
      const f = bySentence.get(s.id)
      rows.push({ s, verdict: f?.verdict ?? null, missing: !f || f.missing, failed: r.status !== 'ok' })
    }
  }
  const n = rows.length
  const acc = rows.filter((x) => x.s.acceptable.includes(x.verdict)).length
  const part = rows.filter((x) => (x.s.partial ?? []).includes(x.verdict)).length
  const crit = rows.filter((x) => (x.s.critical ?? []).includes(x.verdict)).length
  const miss = rows.filter((x) => x.missing).length
  const flagged = (x) => x.verdict != null && flagOf[x.verdict] !== 'none'
  const noFlagLabels = ['cited', 'common_knowledge', 'opinion']
  const fa = rows.filter((x) => noFlagLabels.includes(x.s.label))
  const falses = rows.filter((x) => x.s.label === 'false')
  const nc = rows.filter((x) => x.s.label === 'true_uncited')
  const ncAny = rows.filter((x) => x.s.expected?.verdict === 'needs_citation')
  const byLabel = {}
  for (const x of rows) {
    const b = (byLabel[x.s.label] ??= { n: 0, acc: 0, crit: 0, verdicts: {} })
    b.n++
    if (x.s.acceptable.includes(x.verdict)) b.acc++
    if ((x.s.critical ?? []).includes(x.verdict)) b.crit++
    b.verdicts[x.verdict ?? 'MISSING'] = (b.verdicts[x.verdict ?? 'MISSING'] ?? 0) + 1
  }
  const sentPerCall = ok.map((r) => r.output.sentCount)
  const costPerSentence = ok.length ? ok.reduce((a, r) => a + r.costUSD, 0) / ok.reduce((a, r) => a + r.output.sentCount, 0) : null
  return {
    calls: recs.length, okCalls: ok.length, sentenceJudgements: n,
    strictAccuracy: n ? acc / n : null, partialScore: n ? (acc + 0.5 * part) / n : null,
    critical: crit, missingFindings: miss,
    falseAlarm: { n: fa.length, flagged: fa.filter(flagged).length, rate: fa.length ? fa.filter(flagged).length / fa.length : null },
    falseMiss: { n: falses.length, missed: falses.filter((x) => x.verdict !== 'false').length, softened: falses.filter((x) => x.verdict === 'questionable').length, endorsed: falses.filter((x) => ['accurate', 'no_claim', 'needs_citation'].includes(x.verdict)).length, rate: falses.length ? falses.filter((x) => x.verdict !== 'false').length / falses.length : null },
    needsCitationMiss: { n: nc.length, missed: nc.filter((x) => x.verdict !== 'needs_citation').length, rate: nc.length ? nc.filter((x) => x.verdict !== 'needs_citation').length / nc.length : null, nExpectedNC: ncAny.length, missedExpectedNC: ncAny.filter((x) => x.verdict !== 'needs_citation').length },
    byLabel,
    meanCostPerCallUSD: mean(recs.map((r) => r.costUSD)),
    meanSentencesPerCall: mean(sentPerCall),
    costPer20SentencesUSD: costPerSentence == null ? null : costPerSentence * 20,
    latencyP50: quant(ok.map((r) => r.latencyMs), 0.5), latencyP90: quant(ok.map((r) => r.latencyMs), 0.9),
    ...opsCounts(recs),
    wrong: detail ? rows.filter((x) => !x.s.acceptable.includes(x.verdict)).map((x) => `${x.s.id} [${x.s.label}] want ${x.s.acceptable.join('|')} got ${x.verdict}`) : undefined
  }
}

function opsCounts(recs) {
  return {
    status: recs.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {}),
    truncatedHttp: recs.reduce((a, r) => a + (r.truncatedHttp ?? 0), 0),
    httpErrors: recs.reduce((a, r) => a + (r.http ?? []).filter((h) => h.status !== 200).length, 0),
    retried: recs.filter((r) => (r.attempts ?? 1) > 1).length,
    effortMismatch: recs.filter((r) => r.effortMismatch).length,
    meanReasoningTokens: mean(recs.filter((r) => r.status === 'ok').map((r) => r.usage.reasoning)),
    meanOutputTokens: mean(recs.filter((r) => r.status === 'ok').map((r) => r.usage.output)),
    totalCostUSD: recs.reduce((a, r) => a + r.costUSD, 0),
    // Same calls priced as if no input token had been a cache hit: the
    // eval runs identical prefixes back to back, sporadic production traffic
    // will hit the prompt cache less often.
    // Models that bill cache writes (luna, terra, astra) pay the cacheWrite rate
    // on a first-seen prefix, so a cold call prices all input at that rate.
    meanCostNoCacheUSD: mean(recs.map((r) => { const p = PRICES[r.model]; return (r.usage.input * (p.cacheWrite ?? p.input) + r.usage.output * p.output) / 1e6 })),
    cachedInputShare: (() => { const i = recs.reduce((a, r) => a + r.usage.input, 0); return i ? recs.reduce((a, r) => a + r.usage.cached, 0) / i : null })()
  }
}

function scoreCritique(recs) {
  const ok = recs.filter((r) => r.status === 'ok')
  const specByClaim = new Map(expected.map((s) => [s.claim, s]))
  const judged = ok.map((r) => ({ r, spec: specByClaim.get(r.output.claim), verdict: r.output.verdict, input: inputs[r.output.claim] })).filter((x) => x.spec)
  const pass = judged.filter((x) => x.spec.acceptable.includes(x.verdict))
  const fired = {}
  for (const v of ['fabricated', 'contradicted', 'overstated']) {
    fired[v] = { fired: judged.filter((x) => x.verdict === v).length, acceptableOn: judged.filter((x) => x.spec.acceptable.includes(v)).length, correctFires: judged.filter((x) => x.verdict === v && x.spec.acceptable.includes(v)).length }
  }
  const isRetrievalMiss = (x) => x.verdict === 'unsupported' && x.input?.breakdown?.sourceCount === 0
  const unsupported = judged.filter((x) => x.verdict === 'unsupported')
  const controls = judged.filter((x) => ['well-supported', 'partially-supported'].includes(x.spec.expected))
  const accused = controls.filter((x) => !isRetrievalMiss(x) && !x.spec.acceptable.includes(x.verdict))
  const invented = judged.filter((x) => x.spec.expected === 'fabricated')
  const genuine = judged.filter((x) => !x.spec.acceptable.includes('fabricated'))
  const verdicts = judged.reduce((a, x) => ((a[x.verdict] = (a[x.verdict] ?? 0) + 1), a), {})
  return {
    calls: recs.length, okCalls: ok.length, judged: judged.length,
    withinAcceptable: pass.length, withinAcceptableRate: judged.length ? pass.length / judged.length : null,
    truthVerdicts: fired,
    unsupported: { total: unsupported.length, aboutEvidence: unsupported.filter((x) => !isRetrievalMiss(x)).length, retrievalMiss: unsupported.filter(isRetrievalMiss).length },
    accused: { n: controls.length, accused: accused.length },
    fabrication: { caught: invented.filter((x) => x.verdict === 'fabricated').length, of: invented.length, harm: genuine.filter((x) => x.verdict === 'fabricated').length, genuineSeen: genuine.length },
    verdicts,
    meanCostPerCallUSD: mean(recs.map((r) => r.costUSD)),
    latencyP50: quant(ok.map((r) => r.latencyMs), 0.5), latencyP90: quant(ok.map((r) => r.latencyMs), 0.9),
    ...opsCounts(recs),
    misses: detail ? judged.filter((x) => !x.spec.acceptable.includes(x.verdict)).map((x) => `${x.r.item} want ${x.spec.acceptable.join('|')} got ${x.verdict}: ${x.spec.claim.slice(0, 50)}`) : undefined
  }
}

const report = {}
for (const run of runs.sort((a, b) => a.config.localeCompare(b.config))) {
  const check = run.records.filter((r) => r.task === 'check')
  const crit = run.records.filter((r) => r.task === 'critique')
  report[run.config] = {
    check: check.length && checkset ? scoreCheck(check) : null,
    critique: crit.length ? scoreCritique(crit) : null
  }
}

// ── print ────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)
const ids = Object.keys(report)
if (ids.some((id) => report[id].check)) {
  console.log('\nCHECK  (strict = verdict in acceptable; score adds 0.5 per partial)')
  console.log(pad('config', 22) + ['n', 'strict', 'score', 'crit', 'FA', 'FALSEmiss', 'NCmiss', 'miss', '¢/call', '¢/20sent', 'p50s', 'p90s', 'err', 'trunc', 'rsn'].map((h) => lpad(h, 10)).join(''))
  for (const id of ids) {
    const c = report[id].check
    if (!c) continue
    console.log(pad(id, 22) + [c.sentenceJudgements, pct(c.strictAccuracy * c.sentenceJudgements, c.sentenceJudgements), (c.partialScore * 100).toFixed(0) + '%', c.critical,
      `${c.falseAlarm.flagged}/${c.falseAlarm.n}`, `${c.falseMiss.missed}/${c.falseMiss.n}`, `${c.needsCitationMiss.missed}/${c.needsCitationMiss.n}`, c.missingFindings,
      cents(c.meanCostPerCallUSD), cents(c.costPer20SentencesUSD), (c.latencyP50 / 1000).toFixed(1), (c.latencyP90 / 1000).toFixed(1),
      c.calls - c.okCalls, c.truncatedHttp, c.meanReasoningTokens?.toFixed(0) ?? '—'].map((v) => lpad(v, 10)).join(''))
  }
  if (detail) for (const id of ids) if (report[id].check) {
    console.log(`\n  ${id} per label:`)
    for (const [l, b] of Object.entries(report[id].check.byLabel)) console.log(`    ${pad(l, 17)} ${b.acc}/${b.n} ok, ${b.crit} critical  ${JSON.stringify(b.verdicts)}`)
    for (const w of report[id].check.wrong) console.log(`    · ${w}`)
  }
}
if (ids.some((id) => report[id].critique)) {
  console.log('\nCRITIQUE  (acceptable sets from eval/critique/expected.json)')
  console.log(pad('config', 22) + ['ok', 'accept', 'fab✓', 'HARM', 'contr', 'overst', 'accused', 'unsRM', '¢/call', 'p50s', 'p90s', 'err', 'trunc', 'rsn'].map((h) => lpad(h, 10)).join(''))
  for (const id of ids) {
    const c = report[id].critique
    if (!c) continue
    console.log(pad(id, 22) + [`${c.okCalls}/${c.calls}`, `${c.withinAcceptable}/${c.judged}`, `${c.fabrication.caught}/${c.fabrication.of}`, `${c.fabrication.harm}/${c.fabrication.genuineSeen}`,
      `${c.truthVerdicts.contradicted.fired}`, `${c.truthVerdicts.overstated.fired}`, `${c.accused.accused}/${c.accused.n}`, c.unsupported.retrievalMiss,
      cents(c.meanCostPerCallUSD), (c.latencyP50 / 1000).toFixed(1), (c.latencyP90 / 1000).toFixed(1), c.calls - c.okCalls, c.truncatedHttp, c.meanReasoningTokens?.toFixed(0) ?? '—'].map((v) => lpad(v, 10)).join(''))
  }
  if (detail) for (const id of ids) if (report[id].critique) {
    console.log(`\n  ${id}: verdicts ${JSON.stringify(report[id].critique.verdicts)}`)
    for (const m of report[id].critique.misses) console.log(`    · ${m}`)
  }
}
console.log('\nFA = flags on cited/common_knowledge/opinion; FALSEmiss = label false not called false; NCmiss = true_uncited not called needs_citation;')
console.log('crit = checkset "critical" verdicts; unsRM = unsupported with 0 relevant sources (retrieval miss); rsn = mean reasoning tokens/ok call.')
if (arg('json')) { writeFileSync(arg('json'), JSON.stringify(report, null, 1)); console.log(`json: ${arg('json')}`) }
