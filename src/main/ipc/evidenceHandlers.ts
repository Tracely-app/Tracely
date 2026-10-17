import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import type {
  ClaimsOffTopicResponse,
  EvidenceForTextResponse,
  EvidenceFindResponse,
  EvidenceGetForClaimResponse,
  ScreenWatchSourceCandidate
} from '@shared/ipc-contract'
import type { EvidenceItem } from '@shared/types'
import { findEvidenceCached } from '../services/search/cachedEvidence'
import {
  clearEvidenceForClaim,
  getEvidenceForClaim,
  linkEvidence
} from '../services/storage/claimEvidenceRepo'
import { getClaim, updateClaimScore } from '../services/storage/claimsRepo'
import { transaction } from '../services/storage/db'
import { upsertSource } from '../services/storage/sourcesRepo'
import { byCredibility, credibilityOf } from '@shared/sourceCredibility'
import { offeredSourceFilter } from '../services/search/sourceFilter'
import { getFaviconDataUrl } from '../services/search/favicon'
import { formatCitation } from '../services/citations'
import { MIN_EVIDENCE_TEXT_CHARS, MAX_TEXT_SOURCE_CANDIDATES } from '@shared/evidenceLimits'
import { findOffTopicClaims } from '../services/structure/claimRelevance'

const claimIdSchema = z.object({ claimId: z.string() })
const offTopicSchema = z.object({
  text: z.string().max(200_000),
  // Only the two fields the check reads. Parsing the whole Claim here would
  // couple this handler to every future column on it for no gain.
  claims: z.array(z.object({ id: z.string(), text: z.string() })).max(64)
})
const forTextSchema = z.object({
  text: z.string().max(4000),
  style: z.enum(['APA', 'MLA', 'Chicago'])
})

export function registerEvidenceHandlers(): void {
  ipcMain.handle(IPC.EVIDENCE_FIND, async (_event, raw): Promise<EvidenceFindResponse> => {
    const { claimId } = claimIdSchema.parse(raw)
    const claim = getClaim(claimId)
    if (!claim) throw new Error('Claim not found')

    // The analysis id is what bounds the paid web search per document — see
    // search/webBudget.ts. The sweep runs in document order, so a bounded
    // budget is spent on the top of the draft rather than an arbitrary subset.
    const result = await findEvidenceCached(claim.searchQuery, claim.text, claim.analysisId)

    // One disk write for the whole set instead of one per statement — this
    // loop plus the score update was ~21 full-database serializations, each
    // proportional to total database size, on the main thread.
    const evidence: EvidenceItem[] = transaction(() => {
      // Replace, never merge. linkEvidence upserts per (claim, source), so
      // without this a search returning five sources leaves a previous
      // search's other eleven linked — and the picker reads stored rows.
      clearEvidenceForClaim(claimId)
      const items = result.evidence.map((item, index) => {
        const source = upsertSource({
          doi: item.doi,
          title: item.title,
          authors: item.authors,
          year: item.year,
          venue: item.venue,
          venueType: item.venueType,
          url: item.url,
          pdfUrl: item.pdfUrl,
          abstract: item.abstract,
          provider: item.provider,
          providerId: item.providerId,
          citationCount: item.citationCount,
          oaStatus: item.oaStatus,
          raw: item.raw
        })
        // The aggregator's own claim-coverage score, not a re-derivation
        // from provider rank. The old `1 - rank/length` disagreed with the
        // order results were actually sorted in, and with the threshold
        // critique.ts filters evidence on.
        const relevanceScore = item.textRelevance
        const stance = item.stance?.stance ?? null
        const stanceConfidence = item.stance?.confidence ?? null
        // Persisted with the evidence because the critique and correction
        // steps read evidence back out of the database and would otherwise
        // have no way to know which sources disagree.
        linkEvidence(claimId, source.id, relevanceScore, index, stance, stanceConfidence)
        return { source, relevanceScore, rank: index, stance, stanceConfidence }
      })
      updateClaimScore(claimId, result.score, result.breakdown)
      return items
    })

    // Settings → Citations → Sources: what may be offered (the score above still counts every source found).
    const offered = offeredSourceFilter()
    return { evidence: evidence.filter((e) => offered(e.source)), strengthScore: result.score, scoreBreakdown: result.breakdown }
  })

  ipcMain.handle(IPC.EVIDENCE_GET_FOR_CLAIM, (_event, raw): EvidenceGetForClaimResponse => {
    const { claimId } = claimIdSchema.parse(raw)
    // Rows stored before a Settings change are filtered again on the way out, as the extension's refilterSources does.
    const offered = offeredSourceFilter()
    return { evidence: getEvidenceForClaim(claimId).filter((e) => offered(e.source)) }
  })

  /**
   * Sources for a piece of text, with no document behind it — Home's finder.
   *
   * The same retrieval every other surface uses, reached without a document, an
   * analysis or a stored claim. `findEvidenceCached` only ever needed a query
   * and the text to rank against, so the whole storage layer the editor goes
   * through was never a requirement of SEARCHING; it is a requirement of
   * remembering, and this surface has nothing to remember.
   *
   * Nothing is written. No analysis row, no claim, no source row, no library
   * entry — a search from Home must not turn up in Analysis History, for the
   * same reason Screen Watch's detections do not: the user did not ask to save
   * anything, they asked a question.
   *
   * The text is passed as BOTH the query and the claim text. `queryVariants`
   * dedupes them to one variant, so this is a single keyword search, and the
   * ranking that decides the order is dense similarity against the same string
   * — which is what the user typed, and therefore exactly what they meant.
   */
  ipcMain.handle(IPC.EVIDENCE_FOR_TEXT, async (_event, raw): Promise<EvidenceForTextResponse> => {
    const { text, style } = forTextSchema.parse(raw)
    const trimmed = text.trim()
    if (trimmed.length < MIN_EVIDENCE_TEXT_CHARS) {
      return {
        candidates: [],
        citations: {},
        note: `Type a sentence or two — at least ${MIN_EVIDENCE_TEXT_CHARS} characters — and Tracely will look for sources that speak to it.`
      }
    }

    // No analysis id: the paid web-search fallback is bounded by its rolling
    // hourly cap here rather than a per-analysis one, which is the right shape
    // for a surface someone can press repeatedly. See search/webBudget.ts.
    const result = await findEvidenceCached(trimmed, trimmed, null)

    const offered = offeredSourceFilter() // Settings → Citations → Sources
    const ranked = result.evidence.filter(offered).slice(0, MAX_TEXT_SOURCE_CANDIDATES)
    const candidates: ScreenWatchSourceCandidate[] = await Promise.all(
      ranked.map(async (item, i) => ({
        sourceRef: `text:${i}`,
        title: item.title,
        venue: item.venue,
        year: item.year,
        provider: item.provider,
        url: item.url,
        // The aggregator's own relevance, not a re-derivation — the same figure
        // that chose and ordered these. Recomputing it here would show a match
        // percentage for a metric that had no part in the ranking.
        matchPercent: Math.round(100 * Math.min(1, Math.max(0, item.textRelevance))),
        faviconDataUrl: await getFaviconDataUrl(item.url),
        credibility: credibilityOf({
          url: item.url,
          venue: item.venue,
          venueType: item.venueType,
          doi: item.doi
        })
      }))
    )

    // Most citable first, stable — the same order the editor's picker uses, so
    // the match percentage still decides within a tier.
    const ordered = byCredibility(candidates, (c) => c.credibility.tier)

    // The citation IS the deliverable on this surface: there is no sentence to
    // insert a marker into, so every row carries its formatted reference.
    const citations: Record<string, string> = {}
    for (const [i, candidate] of ordered.entries()) {
      const item = ranked[Number(candidate.sourceRef.slice('text:'.length))] ?? ranked[i]
      if (!item) continue
      citations[candidate.sourceRef] = formatCitation(
        {
          id: candidate.sourceRef,
          doi: item.doi,
          title: item.title,
          authors: item.authors,
          year: item.year,
          venue: item.venue,
          venueType: item.venueType,
          url: item.url,
          pdfUrl: item.pdfUrl,
          abstract: item.abstract,
          provider: item.provider,
          providerId: item.providerId,
          citationCount: item.citationCount,
          oaStatus: item.oaStatus,
          createdAt: ''
        },
        style
      )
    }

    return {
      candidates: ordered,
      citations,
      note: ordered.length === 0 ? 'Nothing in the indexes came back for that. Try naming the subject more specifically.' : null
    }
  })

  /**
   * Which claims are tangents — local, free, and therefore safe to run unasked.
   *
   * Two batched embeddings and a cosine distance in-process. No relay, nothing
   * billed, which is the same rule that lets the evidence sweep run
   * automatically: paid judgement calls need a button, free ones do not.
   */
  ipcMain.handle(IPC.CLAIMS_OFF_TOPIC, async (_event, raw): Promise<ClaimsOffTopicResponse> => {
    const { text, claims } = offTopicSchema.parse(raw)
    const offTopicClaimIds = await findOffTopicClaims(
      text,
      claims as unknown as Parameters<typeof findOffTopicClaims>[1]
    )
    return { offTopicClaimIds }
  })
}
