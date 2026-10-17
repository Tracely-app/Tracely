// Scores a run of eval/kinds/run.mjs (free: no calls). For each set: the
// model alone, the model with the rules behind it (what the extension does
// when FEATURES.modelKind is on: the model's kind when it names one, else
// readKind's), and the rules alone — exact, in a group that changes the
// checks, a checked document read as quiet, and what the header shows.
//
//   node eval/kinds/score.mjs eval/kinds/runs/<date>-fresh.json [--misses]
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { corpus } from './run.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..')
const file = process.argv[2]
if (!file) { console.error('usage: node eval/kinds/score.mjs <run.json> [--misses]'); process.exit(2) }
const { meta, results } = JSON.parse(readFileSync(file, 'utf8'))
const SRC = readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8')
const { sliceBetween } = await import(pathToFileURL(path.join(ROOT, 'server', 'test', 'helpers', 'anchors.js')))
const X = vm.runInContext(`
  const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false };
  function hashText(s) { return s; }
  ${sliceBetween(SRC, '  const ISSUE_VERDICTS =', '  /* Card titles')}
  ${sliceBetween(SRC, '  // Bibliography block', '  function wireChrome(')}
  ({ readKind, WRITING_KINDS })`, vm.createContext({}))
const K = X.WRITING_KINDS
// What a genre changes: 1 checked with a list, 2 named in the sentence, 3 its own documents, 4 the writer's own account, 5 quiet.
const GROUP = (g) => ({ prose: 1, research: 1, literary: 1, lab: 1, speech: 2, news: 2, dbq: 3, homework: 5, poem: 5, story: 5, script: 5 }[g] ?? 4)

const docs = (await corpus(meta.set)).filter((d) => results[d.id]?.ok)
const sets = [...new Set(docs.map((d) => d.set))]
const misses = process.argv.includes('--misses')
for (const set of [...sets, ...(sets.length > 1 ? ['all'] : [])]) {
  const these = set === 'all' ? docs : docs.filter((d) => d.set === set)
  const tally = { model: blank(), combined: blank(), rules: blank() }
  for (const d of these) {
    const rules = X.readKind(d.text, d.place ?? '')
    const said = results[d.id].kind
    const model = K[said] ? { kind: said, shown: said } : null
    count(tally.model, d, model ?? { kind: null, shown: '' })
    count(tally.combined, d, model ?? rules)
    count(tally.rules, d, rules)
    if (misses && model && GROUP(K[model.kind].genre) !== GROUP(K[d.kind].genre)) console.log(`  ${d.set} ${d.kind} → model ${model.kind}: ${d.name}`)
  }
  console.log(`\n${set} (${these.length} documents):`)
  for (const [name, t] of Object.entries(tally)) {
    const p = (x) => `${(100 * x / these.length).toFixed(1)}%`
    console.log(`  ${name.padEnd(9)} exact ${p(t.exact)}, wrong group ${p(t.wrongGroup)} (checked read as quiet: ${t.toQuiet}), unsure ${p(t.unsure)}; header right ${p(t.shownRight)}, wrong ${p(t.shownWrong)}, none ${p(t.none)}`)
  }
}

function blank() { return { exact: 0, wrongGroup: 0, toQuiet: 0, unsure: 0, shownRight: 0, shownWrong: 0, none: 0 } }
function count(t, d, { kind, shown }) {
  if (!kind) { t.unsure++; t.none++; return }
  if (kind === d.kind) t.exact++
  else if (GROUP(K[kind].genre) !== GROUP(K[d.kind].genre)) {
    t.wrongGroup++
    if (GROUP(K[kind].genre) === 5) t.toQuiet++
  }
  if (!shown) t.none++
  else if (shown === d.kind || K[d.kind].parent === shown) t.shownRight++
  else t.shownWrong++
}
