// Bundled by run-desktop.mjs (esbuild, the same alias and the same three
// compile-time constants scripts/evaluate.mjs uses) so plain node can run the
// desktop's REAL retrieval: src/main/services/search/aggregator.ts findEvidence
// — the fan-out, OpenAlex enrichment, MiniLM relevance, the relevance floor and
// the cap of five — then the credibility order the editor's picker draws
// (AnalyzeView: byCredibility over credibilityOf). Nothing under src/ is
// modified; this file only imports it.
//
// __API_URL__ is compiled in as "" (the app's own kill switch, scripts/env.mjs
// AI_OFF), so callServer refuses locally and the paid web fallback
// (/api/find-sources) can never be called from this bundle. Whether a claim
// WOULD have reached it is read off the web budget: findEvidence takes one
// search from takeWebSearch immediately before calling findWebSources, and only
// when the claim routes `general` and nothing free was citable.

import { byCredibility, credibilityOf } from '@shared/sourceCredibility'
import { MAX_EVIDENCE_RESULTS } from '@shared/evidenceLimits'
import { findEvidence } from '../../src/main/services/search/aggregator'
import { classifyClaim } from '../../src/main/services/search/domainRouter'
import { MIN_COUNTABLE_RELEVANCE } from '../../src/main/services/search/scoring'
import { __resetWebBudget, webSearchesThisHour } from '../../src/main/services/search/webBudget'
import { isMlAvailable, shutdownMl, warmUp as warmUpMl } from '../../src/main/services/ml'
import { isReady as worldBankReady, warmUp as warmUpWorldBank } from '../../src/main/services/search/worldBank'
import { initDb } from '../../src/main/services/storage/db'
import { setAppPaths } from '../../src/main/services/storage/paths'

declare const __API_URL__: string

export interface DesktopSetup {
  repoRoot: string
  dataDir: string
  /** A packaged-style resources dir (models + sql-wasm.wasm), so the worker loads the bundled MiniLM as a packaged build does. */
  resourcesDir: string
}

export async function setup(opts: DesktopSetup): Promise<{ apiUrl: string; worldBankReady: boolean; mlAvailable: boolean }> {
  if (__API_URL__) throw new Error('refusing: this bundle must be built with __API_URL__ = "" so no paid call is possible')
  setAppPaths({ dataDir: opts.dataDir, appRoot: opts.repoRoot, resourcesDir: opts.resourcesDir })
  await initDb()
  // main/index.ts warms both at boot; without the World Bank index a
  // statistical claim cannot return a dataset (eval/README, harness.ts).
  warmUpMl()
  warmUpWorldBank()
  const deadline = Date.now() + 60_000
  while (!worldBankReady() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
  return { apiUrl: __API_URL__, worldBankReady: worldBankReady(), mlAvailable: isMlAvailable() }
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000

export async function runClaim(claimText: string, searchQuery: string) {
  // A fresh budget per claim, so a cap reached by an earlier claim can never
  // hide whether THIS one would have gone to the web.
  __resetWebBudget()
  const domain = await classifyClaim(claimText, searchQuery)
  const { evidence, score, breakdown, cacheable } = await findEvidence(searchQuery, claimText)
  const wouldCallWebFallback = webSearchesThisHour(Date.now()) > 0

  // What the editor's picker shows: the aggregator's list (floor applied,
  // at most MAX_EVIDENCE_RESULTS), re-ordered most-citable first, stable.
  const rows = evidence.map((item, i) => ({
    item,
    aggregatorRank: i + 1,
    credibility: credibilityOf({ url: item.url, venue: item.venue, venueType: item.venueType, doi: item.doi })
  }))
  const shown = byCredibility(rows, (r) => r.credibility.tier)

  return {
    domain,
    strengthScore: score,
    breakdown,
    cacheable,
    wouldCallWebFallback,
    // False once the worker has failed: relevance then fell back to word overlap
    // (the lexical floor), which is a different measurement.
    mlAvailable: isMlAvailable(),
    maxShown: MAX_EVIDENCE_RESULTS,
    floor: MIN_COUNTABLE_RELEVANCE,
    shown: shown.map((r, i) => ({
      rank: i + 1,
      aggregatorRank: r.aggregatorRank,
      title: r.item.title,
      url: r.item.url,
      doi: r.item.doi,
      authors: r.item.authors.map((a) => (a.given ? `${a.given} ${a.family}` : a.family)),
      year: r.item.year,
      venue: r.item.venue,
      venueType: r.item.venueType,
      provider: r.item.provider,
      abstract: r.item.abstract,
      relevance: r3(r.item.textRelevance),
      credibility: { tier: r.credibility.tier, label: r.credibility.label, citable: r.credibility.citable },
      citationCount: r.item.citationCount,
      oaStatus: r.item.oaStatus,
      pdfUrl: r.item.pdfUrl
    }))
  }
}

/** Lets the process exit: the ML worker thread keeps the event loop alive. */
export async function teardown(): Promise<void> {
  await shutdownMl()
}
