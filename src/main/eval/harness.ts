// Offline quality harness: runs real essays through the real pipeline
// (detect -> search -> score -> critique) with no Electron window, and
// writes a report you can read and label.
//
// This exists because nothing in Tracely measured whether a pipeline change
// helped. Retrieval and scoring were tuned by looking at one paragraph in
// the running app and forming an impression, which is how the relevance
// factor ended up mathematically incapable of exceeding ~0.1 without anyone
// noticing. Every change to detection, retrieval or scoring from here on
// should be run through this first.
//
// Invoked via `npm run evaluate` -> scripts/evaluate.mjs, which bundles this
// with esbuild (for the @shared alias and the __API_URL__ / Supabase constants) and
// runs it on plain node.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { Claim, EvidenceItem, ScoreBreakdown, Source } from '@shared/types'
import { sentenceAround } from '@shared/inlineCitation'
import { detectClaims, type DetectedClaim } from '../services/ai/claimDetection'
import { generateCritique } from '../services/ai/critique'
import { setAccessTokenProvider, setPlanProvider } from '../services/ai/identity'
import { appSessionPlanProvider, appSessionTokenProvider, noSessionMessage } from './identity'
import { findEvidence, type RankedSourceResult } from '../services/search/aggregator'
import { warmUp as warmUpMl } from '../services/ml'
import { isReady as worldBankReady, warmUp as warmUpWorldBank } from '../services/search/worldBank'
import { initDb } from '../services/storage/db'
import { setAppPaths } from '../services/storage/paths'

interface EvaluatedSource {
  title: string
  // Rendered by scripts/preview.mjs, which rebuilds the app's own evidence
  // card from this data — without authors and abstract the preview would be
  // a lookalike missing the two lines a user actually reads.
  authors: string[]
  abstract: string | null
  provider: string
  year: number | null
  venue: string | null
  venueType: string | null
  doi: string | null
  url: string | null
  citationCount: number | null
  hasAbstract: boolean
  abstractChars: number
  textRelevance: number
}

interface EvaluatedClaim {
  text: string
  claimType: string
  confidence: number
  searchQuery: string
  strengthScore: number
  breakdown: ScoreBreakdown
  sources: EvaluatedSource[]
  critique: string | null
  verdict: string | null
  /**
   * Recorded because they DECIDE the verdict, not merely decorate it.
   *
   * normalizeCritique downgrades `overstated` to `weak` whenever
   * suggestedRevision is null, and forces citationFix to null on `fabricated`.
   * Without these two fields a report cannot show why a verdict came out the
   * way it did, and eval/critique/score.mjs was reading verdicts whose
   * governing input was not written down.
   */
  suggestedRevision: string | null
  citationFix: string | null
  error: string | null
}

interface EvaluatedEssay {
  file: string
  chars: number
  claimCount: number
  claims: EvaluatedClaim[]
  elapsedMs: number
  /**
   * This run critiqued only a marked subset of claims.
   *
   * Stamped so that nothing downstream can mistake a cheap run for a full one.
   * eval/critique/score.mjs picks the NEWEST critique-bearing report when it is
   * not given one, and a five-claim smoke report would otherwise become "the"
   * report and score 5/5 — a clean bill of health from a run that never looked
   * at most of the set. That is the same shape of trap as the unnamespaced
   * eval cache, which reported one environment's verdicts as another's, so it
   * gets a marker in the data rather than a convention in someone's head.
   */
  smoke?: boolean
}

/**
 * Smoke mode: critique only the claims a change can plausibly move.
 *
 * `EVAL_ONLY_CLAIMS` is a JSON array of claim-text PREFIXES, set by
 * scripts/evaluate.mjs from the entries marked `"smoke": true` in
 * eval/critique/expected.json. Unset means every claim is critiqued, which is
 * the normal full run.
 *
 * Prefix matching, the same join eval/critique/score.mjs uses, because a
 * detected claim is a sub-span of its sentence and its exact text moves between
 * detection runs. A claim that matches nothing is simply not critiqued — it is
 * never an error, since the smoke set deliberately spans essays that a given
 * invocation may not include.
 */
const smokePrefixes: string[] | null = process.env.EVAL_ONLY_CLAIMS
  ? (JSON.parse(process.env.EVAL_ONLY_CLAIMS) as string[])
  : null

function inSmokeSet(claimText: string): boolean {
  if (!smokePrefixes) return true
  return smokePrefixes.some((prefix) => claimText.startsWith(prefix))
}

function round(value: number, places = 3): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

// generateCritique wants persisted Claim/EvidenceItem records. The harness
// deliberately doesn't write analyses to the database — it should be able to
// run repeatedly without leaving a trail of fake analyses in whatever
// profile it points at — so the shapes are synthesized here instead. Only
// the fields the critique path actually reads need to be real; `id` matters
// because it keys the critique cache, so it's derived from the claim text
// rather than random, letting a re-run hit cache instead of re-billing.
function asClaim(detected: DetectedClaim, strengthScore: number, id: string): Claim {
  return {
    id,
    analysisId: 'eval',
    text: detected.text,
    claimType: detected.claimType,
    confidence: detected.confidence,
    searchQuery: detected.searchQuery,
    strengthScore,
    scoreBreakdown: null,
    critique: null,
    critiqueVerdict: null,
    // The harness is the caller that PRODUCES these; nothing reads them off the
    // synthesized input.
    suggestedRevision: null,
    citationFix: null,
    citedWorkRead: null,
    retrievalGeneration: null,
    createdAt: new Date().toISOString()
  }
}

// Takes the aggregator's ranked results rather than raw provider ones, so the
// relevance in the report is the number that actually ordered the evidence.
// Recomputing it here meant the harness could report a metric the pipeline no
// longer uses — precisely the drift this eval exists to detect.
function asEvidence(results: RankedSourceResult[]): EvidenceItem[] {
  return results.map((result, index) => {
    const source: Source = {
      id: `eval-${index}`,
      doi: result.doi,
      title: result.title,
      authors: result.authors,
      year: result.year,
      venue: result.venue,
      venueType: result.venueType,
      url: result.url,
      pdfUrl: result.pdfUrl,
      abstract: result.abstract,
      provider: result.provider,
      providerId: result.providerId,
      citationCount: result.citationCount,
      oaStatus: result.oaStatus,
      createdAt: new Date().toISOString()
    }
    return {
      source,
      relevanceScore: result.textRelevance,
      rank: index,
      stance: result.stance?.stance ?? null,
      stanceConfidence: result.stance?.confidence ?? null
    }
  })
}

async function evaluateClaim(
  detected: DetectedClaim,
  index: number,
  sentence?: string,
  document?: string
): Promise<EvaluatedClaim> {
  const base = {
    text: detected.text,
    claimType: detected.claimType,
    confidence: round(detected.confidence),
    searchQuery: detected.searchQuery
  }

  try {
    const { evidence, score, breakdown } = await findEvidence(detected.searchQuery, detected.text)
    const evidenceItems = asEvidence(evidence)

    let critique: string | null = null
    let verdict: string | null = null
    let suggestedRevision: string | null = null
    let citationFix: string | null = null
    if (!process.env.EVAL_SKIP_CRITIQUE && inSmokeSet(detected.text)) {
      const claim = asClaim(detected, score, `eval-${index}-${detected.text.slice(0, 40)}`)
      // The whole sentence, for the reference check — see generateCritique.
      // The harness has the essay text, so this is the one path that never has
      // to fall back.
      const result = await generateCritique(claim, evidenceItems, sentence, document)
      critique = result.critique
      verdict = result.verdict
      suggestedRevision = result.suggestedRevision
      citationFix = result.citationFix
    }

    return {
      ...base,
      strengthScore: score,
      breakdown: {
        sourceCount: round(breakdown.sourceCount),
        quality: round(breakdown.quality),
        recency: round(breakdown.recency),
        relevance: round(breakdown.relevance),
        support: round(breakdown.support)
      },
      sources: evidenceItems.map((item) => ({
        title: item.source.title,
        authors: item.source.authors.map((a) => (a.given ? `${a.given} ${a.family}` : a.family)),
        abstract: item.source.abstract,
        provider: item.source.provider,
        year: item.source.year,
        venue: item.source.venue,
        venueType: item.source.venueType,
        doi: item.source.doi,
        url: item.source.url,
        citationCount: item.source.citationCount,
        hasAbstract: Boolean(item.source.abstract),
        abstractChars: item.source.abstract?.length ?? 0,
        textRelevance: round(item.relevanceScore)
      })),
      critique,
      verdict,
      suggestedRevision,
      citationFix,
      error: null
    }
  } catch (error) {
    // One claim failing (a provider 500, a relay hiccup) shouldn't lose the
    // whole run's results — record it and keep going.
    return {
      ...base,
      strengthScore: 0,
      breakdown: { sourceCount: 0, quality: 0, recency: 0, relevance: 0, support: 0 },
      sources: [],
      critique: null,
      verdict: null,
      suggestedRevision: null,
      citationFix: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function evaluateEssay(path: string): Promise<EvaluatedEssay> {
  const text = readFileSync(path, 'utf-8')
  const started = Date.now()

  const detected = await detectClaims(text)
  console.log(`  ${basename(path)}: ${detected.length} claims detected`)

  // Sequential, not Promise.all: PubMed's throttle is a global 350ms gate,
  // and hammering four public APIs in parallel across every claim is how a
  // harness gets an IP rate-limited mid-run.
  const claims: EvaluatedClaim[] = []
  for (const [index, claim] of detected.entries()) {
    process.stdout.write(`    [${index + 1}/${detected.length}] ${claim.searchQuery}\n`)
    // The claim's sentence in the essay, so the reference check sees a trailing
    // "(Author, Year)" the detected span stops before.
    const at = text.indexOf(claim.text)
    const sentence = at === -1 ? undefined : sentenceAround(text, at, at + claim.text.length)
    claims.push(await evaluateClaim(claim, index, sentence, text))
  }

  return {
    file: basename(path),
    chars: text.length,
    claimCount: detected.length,
    claims,
    elapsedMs: Date.now() - started,
    ...(smokePrefixes ? { smoke: true } : {})
  }
}

function summarize(essays: EvaluatedEssay[]): string[] {
  const allClaims = essays.flatMap((e) => e.claims)
  const allSources = allClaims.flatMap((c) => c.sources)
  if (allClaims.length === 0) return ['No claims detected across any essay.']

  const scores = allClaims.map((c) => c.strengthScore)
  const relevances = allSources.map((s) => s.textRelevance)
  const mean = (nums: number[]): number =>
    nums.length === 0 ? 0 : round(nums.reduce((a, b) => a + b, 0) / nums.length)

  const byProvider = new Map<string, number>()
  for (const source of allSources) {
    byProvider.set(source.provider, (byProvider.get(source.provider) ?? 0) + 1)
  }

  const verdicts = new Map<string, number>()
  for (const claim of allClaims) {
    if (claim.verdict) verdicts.set(claim.verdict, (verdicts.get(claim.verdict) ?? 0) + 1)
  }

  return [
    `- Essays: ${essays.length} · claims: ${allClaims.length} · sources retrieved: ${allSources.length}`,
    `- Strength score: min ${Math.min(...scores)} / mean ${mean(scores)} / max ${Math.max(...scores)}` +
      `  ← **a narrow spread here means the score isn't discriminating**`,
    `- Claim coverage (textRelevance): min ${Math.min(...relevances)} / mean ${mean(relevances)} / max ${Math.max(...relevances)}`,
    `- Sources with an abstract: ${allSources.filter((s) => s.hasAbstract).length}/${allSources.length}`,
    `- Sources per provider: ${[...byProvider.entries()].map(([p, n]) => `${p} ${n}`).join(' · ')}`,
    `- Verdicts: ${verdicts.size ? [...verdicts.entries()].map(([v, n]) => `${v} ${n}`).join(' · ') : 'n/a (critique skipped)'}`,
    `- Claims that errored: ${allClaims.filter((c) => c.error).length}`
  ]
}

// Markdown rather than a scoreboard because the first pass is a human
// reading it: the numbers say whether something changed, but only a person
// can say whether THIS source belongs under THAT claim. The checkboxes are
// there to be filled in — that hand-labelling is what turns this from a
// dump into a baseline worth comparing against.
function toMarkdown(essays: EvaluatedEssay[]): string {
  const lines: string[] = ['# Tracely pipeline evaluation', '']
  lines.push(`Generated ${new Date().toISOString()}`, '', '## Summary', '', ...summarize(essays), '')
  lines.push(
    '## How to label this',
    '',
    'For each claim: is it something a reader would expect a citation for? (detection precision)',
    'For each source: does it actually speak to the claim? (retrieval precision)',
    'Then note anything the essay asserts that was NOT flagged. (detection recall)',
    ''
  )

  for (const essay of essays) {
    lines.push(
      `## ${essay.file}`,
      '',
      `${essay.chars} chars · ${essay.claimCount} claims · ${(essay.elapsedMs / 1000).toFixed(1)}s`,
      ''
    )

    for (const claim of essay.claims) {
      lines.push(`### "${claim.text}"`, '')
      lines.push(
        `- **Type** ${claim.claimType} · **detector confidence** ${claim.confidence} · **strength** ${claim.strengthScore}/100`,
        `- **Query** \`${claim.searchQuery}\``,
        `- **Breakdown** support ${claim.breakdown.support} · relevance ${claim.breakdown.relevance} · count ${claim.breakdown.sourceCount} · quality ${claim.breakdown.quality} · recency ${claim.breakdown.recency}`,
        '- [ ] genuinely citation-worthy?',
        ''
      )

      if (claim.error) {
        lines.push(`> **Errored:** ${claim.error}`, '')
        continue
      }

      if (claim.sources.length === 0) {
        lines.push('> No sources found.', '')
      } else {
        lines.push('| ? | cov | source | provider | year | venue | cites |', '|---|---|---|---|---|---|---|')
        for (const source of claim.sources) {
          const title = source.title.replace(/\|/g, '\\|').slice(0, 110)
          const link = source.url ? `[${title}](${source.url})` : title
          const abstractFlag = source.hasAbstract ? '' : ' _(no abstract)_'
          lines.push(
            `| [ ] | ${source.textRelevance} | ${link}${abstractFlag} | ${source.provider} | ${source.year ?? '—'} | ${(source.venue ?? '—').slice(0, 40)} | ${source.citationCount ?? '—'} |`
          )
        }
        lines.push('')
      }

      if (claim.critique) {
        lines.push(`**Verdict: ${claim.verdict}**`, '', claim.critique, '')
      }
    }
  }

  return lines.join('\n')
}

// Measured at ~2.6s for the whole 1,498-name catalogue through the packaged
// worker, so this bound is slack rather than a real budget.
const WORLD_BANK_WARM_TIMEOUT_MS = 60_000

// Mirrors the app's boot sequence (main/index.ts), and the World Bank half is
// load-bearing rather than a speed optimisation.
//
// worldBank.search() returns [] outright while its index is cold and kicks the
// build off in the background. A 13-claim run finishes long before that lands,
// so without warming here the provider contributes nothing to any report no
// matter how well it works — it returned 0 of 104 sources on 2026-08-09 and
// the report read as though the provider had been measured and found useless.
async function warmProviders(): Promise<void> {
  warmUpMl()
  warmUpWorldBank()

  const deadline = Date.now() + WORLD_BANK_WARM_TIMEOUT_MS
  while (!worldBankReady() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  // Not fatal: the other five providers still answer, and a run that reports
  // slightly less is better than one that refuses to report at all. But say so,
  // because "no World Bank rows" otherwise looks like a quality result.
  if (!worldBankReady()) {
    console.warn(
      `World Bank index did not warm within ${WORLD_BANK_WARM_TIMEOUT_MS / 1000}s — ` +
        'statistical claims in this run cannot return a dataset.'
    )
  }
}

export async function main(): Promise<void> {
  const repoRoot = process.env.EVAL_REPO_ROOT
  const dataDir = process.env.EVAL_DATA_DIR
  const essayDir = process.env.EVAL_ESSAY_DIR
  const outDir = process.env.EVAL_OUT_DIR
  if (!repoRoot || !dataDir || !essayDir || !outDir) {
    throw new Error('Harness must be launched via scripts/evaluate.mjs (missing EVAL_* env)')
  }

  // The scratch data dir is what lets this run against a throwaway SQLite
  // file instead of the user's real profile — the cache tables get used
  // (so re-runs are cheap) but nothing touches real analyses.
  setAppPaths({ dataDir, appRoot: repoRoot, resourcesDir: null })
  mkdirSync(dataDir, { recursive: true })
  await initDb()

  // The relay now bills per account, so the harness authenticates as the user
  // signed into the desktop app rather than on a shared token. Warned about
  // rather than fatal: a cassette replay never reaches the network and so
  // never needs one, and that is the common case for a re-run.
  const tokenProvider = appSessionTokenProvider()
  if (!tokenProvider) console.warn(`\n${noSessionMessage()}\n`)
  setAccessTokenProvider(tokenProvider ?? (async () => null))
  // The same borrowed session decides the model tier these calls run at, so a
  // measured run reflects what that account is actually served.
  const planProvider = appSessionPlanProvider()
  if (planProvider) setPlanProvider(planProvider)

  const files = readdirSync(essayDir)
    .filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
    .sort()
  if (files.length === 0) {
    throw new Error(`No .txt or .md essays found in ${essayDir}`)
  }

  await warmProviders()

  console.log(`Evaluating ${files.length} essay(s) from ${essayDir}\n`)

  const essays: EvaluatedEssay[] = []
  for (const file of files) {
    essays.push(await evaluateEssay(join(essayDir, file)))
  }

  mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const mdPath = join(outDir, `report-${stamp}.md`)
  const jsonPath = join(outDir, `report-${stamp}.json`)
  writeFileSync(mdPath, toMarkdown(essays), 'utf-8')
  writeFileSync(jsonPath, JSON.stringify(essays, null, 2), 'utf-8')

  console.log(`\n${summarize(essays).join('\n')}`)
  console.log(`\nReport:  ${mdPath}`)
  console.log(`Raw:     ${jsonPath}`)
}
