// The two tasks, each calling the SAME server function production calls, with
// only { model, effort } replaced.
//
//   check    -> lib/factcheck.js runFactCheck({ text, sentences, model, effort })
//               exactly what server.js does for POST /api/check (validation
//               limits re-applied here: text <= 30,000 chars, 1..40 sentences,
//               id <= 40, text <= 2000). The extension sends the whole field /
//               doc text (sliced to 30,000) plus up to 40 unchecked sentences
//               keyed by hashText(); runFactCheck itself trims context > 6000
//               chars to the first 2000.
//   critique -> lib/reasoning.js critique({ claimText, strengthScore,
//               evidenceSummary, referenceCheck?, model, effort }), i.e. the
//               desktop branch of POST /api/critique (body.claimText present).
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MODELS_DIR, REPO, hashText } from './core.mjs'

const serverModule = (rel) => import(pathToFileURL(join(REPO, 'server', rel)).href)
const { runFactCheck } = await serverModule('lib/factcheck.js')
const { critique } = await serverModule('lib/reasoning.js')

/* ── CHECK ─────────────────────────────────────────────────────────────── */

/** The document text the extension would send for this essay. */
export function essayText(essay) {
  if (typeof essay.text === 'string' && essay.text.trim()) return essay.text
  // Reconstructed: paragraphs (when the set marks them) joined by a blank
  // line, sentences within a paragraph by a space.
  const pk = ['paragraph', 'para', 'p'].find((k) => essay.sentences.some((s) => s[k] != null))
  if (!pk) return essay.sentences.map((s) => s.text).join(' ')
  const paras = []
  for (const s of essay.sentences) {
    const last = paras[paras.length - 1]
    if (last && last.key === s[pk]) last.parts.push(s.text)
    else paras.push({ key: s[pk], parts: [s.text] })
  }
  return paras.map((p) => p.parts.join(' ')).join('\n\n')
}

/** Items for one essay: batches of <= batchSize sentences in document order
 * (the extension's MAX_SENTENCES_PER_CHECK is 40). */
export function checkItems(checkset, { batchSize = 40, essayFilter = null, sentenceLimit = null } = {}) {
  const items = []
  for (const essay of checkset.essays) {
    if (essayFilter && !essayFilter.includes(essay.id)) continue
    let sents = essay.sentences.filter((s) => typeof s.text === 'string' && s.text.trim())
    if (sentenceLimit) sents = sents.slice(0, sentenceLimit)
    for (let i = 0, b = 0; i < sents.length; i += batchSize, b++) {
      items.push({ task: 'check', item: `${essay.id}#${b}`, essay, batch: sents.slice(i, i + batchSize) })
    }
  }
  return items
}

export async function runCheck(it, cfg) {
  const text = essayText(it.essay).slice(0, 30_000) // content.js MAX_INPUT_CHARS
  // One id per distinct sentence text, as the extension dedupes by hash.
  const byHash = new Map()
  for (const s of it.batch) {
    const h = hashText(s.text.trim())
    if (!byHash.has(h)) byHash.set(h, { id: h, text: s.text.trim(), checksetIds: [] })
    byHash.get(h).checksetIds.push(s.id)
  }
  const sentences = [...byHash.values()].map(({ id, text }) => ({ id, text }))
  if (sentences.length > 40 || sentences.some((s) => s.text.length > 2000)) throw new Error('batch violates /api/check limits')
  const result = await runFactCheck({ text, sentences, model: cfg.model, effort: cfg.effortParam, mock: false })
  const found = new Map(result.findings.map((f) => [f.id, f]))
  const perSentence = []
  for (const { id, checksetIds } of byHash.values()) {
    const f = found.get(id)
    for (const cid of checksetIds) {
      perSentence.push(f ? { id: cid, hash: id, verdict: f.verdict, confidence: f.confidence, explanation: f.explanation, revision: f.revision }
        : { id: cid, hash: id, verdict: null, missing: true })
    }
  }
  return {
    output: { findings: perSentence, missing: perSentence.filter((p) => p.missing).length, sentCount: sentences.length, contextChars: text.length },
    modelEcho: result.model
  }
}

/* ── CRITIQUE ──────────────────────────────────────────────────────────── */

export function critiqueItems({ claimFilter = null } = {}) {
  const inputsPath = join(MODELS_DIR, 'critique-inputs.json')
  if (!existsSync(inputsPath)) throw new Error(`missing ${inputsPath}`)
  const inputs = JSON.parse(readFileSync(inputsPath, 'utf8'))
  const expected = JSON.parse(readFileSync(join(REPO, 'eval/critique/expected.json'), 'utf8')).claims.filter((c) => c.claim)
  const items = []
  expected.forEach((spec, i) => {
    const input = inputs[spec.claim]
    if (!input) throw new Error(`no captured input for "${spec.claim}"`)
    const item = `C${String(i + 1).padStart(2, '0')}`
    if (claimFilter && !claimFilter.some((f) => item === f || spec.claim.startsWith(f))) return
    items.push({ task: 'critique', item, spec, input })
  })
  return items
}

export async function runCritique(it, cfg) {
  const r = await critique({ ...it.input.request, model: cfg.model, effort: cfg.effortParam })
  const { model, usage, ...rest } = r
  return { output: { claim: it.spec.claim, ...rest }, modelEcho: model }
}
