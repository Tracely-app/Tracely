// Shared plumbing for the model eval: per-call HTTP capture, pricing, the
// global spend ledger, config parsing, atomic result files.
//
// Runs against THIS checkout's server/ code, unpatched (see ../README.md).
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// eval/models/ — the checkset, the critique inputs and (gitignored) results/.
export const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// The repository root, whose server/ is what gets measured.
export const REPO = join(MODELS_DIR, '..', '..')
export const RESULTS = join(MODELS_DIR, 'results')
export const LEDGER = process.env.EVALQ_LEDGER ?? join(RESULTS, 'spend-ledger.jsonl')
export const SPEND_CAP_USD = 12

// Prices per 1M tokens, 2026-09-21, for every candidate the eval measured.
// Kept apart from server/shared/prices.js on purpose: that table holds only
// the three tiers the server serves, and the eval prices candidates too.
export const PRICES = {
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.40 },
  'gpt-5.4-nano': { input: 0.20, cached: 0.02, output: 1.25 },
  'gpt-5.6-luna': { input: 0.20, cached: 0.02, output: 1.20, cacheWrite: 0.25 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.00 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.50 },
  'gpt-5.6-terra': { input: 2.00, cached: 0.20, output: 12.00, cacheWrite: 2.50 },
  'gpt-5.4': { input: 2.50, cached: 0.25, output: 15.00 },
  'gpt-6-astra': { input: 10.00, cached: 1.00, output: 50.00, cacheWrite: 12.50 },
  'gpt-4.1': { input: 2.00, cached: 0.50, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, cached: 0.10, output: 1.60 }
}
export const NO_EFFORT_MODELS = /^gpt-4\.1/

export function parseConfig(s) {
  const [model, effort = 'low'] = String(s).split('@')
  if (!PRICES[model]) throw new Error(`unknown model "${model}" (known: ${Object.keys(PRICES).join(', ')})`)
  if (NO_EFFORT_MODELS.test(model) && effort !== 'none') throw new Error(`${model} rejects reasoning.effort — use ${model}@none`)
  if (!NO_EFFORT_MODELS.test(model) && !['minimal', 'low', 'medium', 'high'].includes(effort)) {
    throw new Error(`effort "${effort}" is not valid for ${model}`)
  }
  return { id: `${model}@${effort}`, model, effort, effortParam: effort === 'none' ? undefined : effort }
}

const priceOf = (model) => PRICES[model] ?? PRICES[String(model).replace(/-\d{4}-\d{2}-\d{2}$/, '')] ?? null

/** Normalised usage from a raw Responses API `usage` block. */
export function usageFromRaw(u = {}) {
  const inD = u.input_tokens_details ?? {}
  // Cache-write tokens: input_tokens_details.cache_write_tokens (verified on
  // real luna / terra / astra answers, 2026-09-21), a subset of input_tokens.
  // The other names are defensive; the raw block is stored with every call.
  const cacheWrite = Number(inD.cache_write_tokens ?? inD.cache_creation_tokens ?? inD.cache_creation_input_tokens ?? u.cache_creation_input_tokens ?? 0) || 0
  return {
    input: u.input_tokens ?? 0,
    cached: inD.cached_tokens ?? 0,
    cacheWrite,
    output: u.output_tokens ?? 0,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? 0
  }
}

export function costUSD(model, usage) {
  const p = priceOf(model)
  if (!p) return null
  const cached = Math.max(0, usage.cached || 0)
  const write = Math.max(0, usage.cacheWrite || 0)
  const fresh = Math.max(0, (usage.input || 0) - cached - write)
  return (fresh * p.input + cached * p.cached + write * (p.cacheWrite ?? p.input) + (usage.output || 0) * p.output) / 1e6
}

export function addUsage(a, b) {
  const out = {}
  for (const k of ['input', 'cached', 'cacheWrite', 'output', 'reasoning']) out[k] = (a?.[k] ?? 0) + (b?.[k] ?? 0)
  return out
}

/* ── per-call HTTP capture ────────────────────────────────────────────────
 * Wraps globalThis.fetch ONCE. Every request to api.openai.com made inside an
 * `als.run(ctx, …)` is appended to ctx.http with its status, latency, the
 * effort actually sent and the raw usage block. The provider reads the global
 * fetch at call time (providers/openai.js), so production code is untouched. */
export const als = new AsyncLocalStorage()
let installed = false
export function installFetchCapture() {
  if (installed) return
  installed = true
  const real = globalThis.fetch
  globalThis.fetch = async function capturingFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    const ctx = als.getStore()
    if (!ctx || !url.startsWith('https://api.openai.com/')) return real(input, init)
    let sent = {}
    try { sent = JSON.parse(init.body) } catch {}
    const rec = {
      model: sent.model, effortSent: sent.reasoning?.effort ?? null,
      maxOutputTokens: sent.max_output_tokens ?? null, startedAt: Date.now()
    }
    ctx.http.push(rec)
    try {
      const res = await real(input, init)
      const text = await res.text()
      rec.status = res.status
      rec.latencyMs = Date.now() - rec.startedAt
      let json = {}
      try { json = JSON.parse(text) } catch {}
      rec.responseStatus = json.status ?? null
      rec.incomplete = json.incomplete_details ?? null
      rec.modelEcho = json.model ?? null
      rec.usageRaw = json.usage ?? null
      rec.usage = usageFromRaw(json.usage ?? {})
      rec.costUSD = costUSD(sent.model, rec.usage) ?? 0
      if (!res.ok) rec.error = json.error ? { code: json.error.code ?? null, type: json.error.type ?? null, message: String(json.error.message ?? '').slice(0, 300) } : { message: text.slice(0, 300) }
      // Raw model text (pre-parse), so a verdict changed by post-processing can be audited.
      if (res.ok) rec.outputText = extractText(json)
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers })
    } catch (err) {
      rec.status = 0
      rec.latencyMs = Date.now() - rec.startedAt
      rec.error = { name: err?.name ?? 'Error', message: String(err?.message ?? err).slice(0, 300) }
      rec.usage = usageFromRaw({})
      rec.costUSD = 0
      throw err
    }
  }
}

function extractText(json) {
  if (typeof json.output_text === 'string' && json.output_text) return json.output_text
  let t = ''
  for (const item of json.output ?? []) for (const part of item.content ?? []) if (part.type === 'output_text') t += part.text ?? ''
  return t
}

/* ── global spend ledger ──────────────────────────────────────────────────
 * Append-only JSONL shared by every run.mjs process:
 *   {k:"r", id, usd, pid}   a reservation taken BEFORE a call starts
 *   {k:"s", id, usd}        the settled actual cost of that call
 * spent = Σ settled + Σ open reservations whose owning process is alive.
 * A call is refused when spent + its own reservation would reach the cap,
 * so the cap holds with any number of calls in flight across processes. */
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
export function ledgerSpent() {
  if (!existsSync(LEDGER)) return { settled: 0, reserved: 0 }
  const open = new Map()
  let settled = 0
  for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.k === 'r') open.set(e.id, e)
    else if (e.k === 's') { settled += e.usd; open.delete(e.id) }
  }
  let reserved = 0
  for (const e of open.values()) if (e.pid === process.pid || alive(e.pid)) reserved += e.usd
  return { settled, reserved }
}
let seq = 0
export function reserve(usd, cap = SPEND_CAP_USD) {
  const { settled, reserved } = ledgerSpent()
  if (settled + reserved + usd >= cap) return null
  const id = `${process.pid}-${Date.now()}-${seq++}`
  appendFileSync(LEDGER, JSON.stringify({ k: 'r', id, usd, pid: process.pid, t: new Date().toISOString() }) + '\n')
  return id
}
export function settle(id, usd, meta = {}) {
  appendFileSync(LEDGER, JSON.stringify({ k: 's', id, usd, ...meta, t: new Date().toISOString() }) + '\n')
}

export function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(obj, null, 1))
  renameSync(tmp, path)
}

/* The extension's sentence id: content.js hashText(), verbatim. */
export function hashText(s) {
  const norm = s.toLowerCase().replace(/\s+/g, ' ').trim()
  let h = 5381
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0
  return 's' + h.toString(36)
}
