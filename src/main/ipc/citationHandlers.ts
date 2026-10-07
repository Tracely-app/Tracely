import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import { computeClaimSpans } from '@shared/claimSpans'
import { sentenceAround } from '@shared/inlineCitation'
import type {
  CitationGenerateResponse,
  CitationFindCitedWorkResponse,
  CitationListResponse,
  CitationResolveCitedResponse
} from '@shared/ipc-contract'
import { formatCitation } from '../services/citations'
import { checkReferences, resolveCitedWork } from '../services/search/referenceCheck'
import { findCitedWork } from '../services/search/citedWorkFinder'
import { getAnalysis } from '../services/storage/analysesRepo'
import { getClaim } from '../services/storage/claimsRepo'
import { listCitationsForSource, saveCitation } from '../services/storage/citationsRepo'
import { getSourceById } from '../services/storage/sourcesRepo'

const generateSchema = z.object({
  sourceId: z.string(),
  style: z.enum(['APA', 'MLA', 'Chicago'])
})
const listSchema = z.object({ sourceId: z.string() })
const resolveCitedSchema = z.object({ claimId: z.string() })
// Bounded: the citation is one bracket, the hint one reference, and the
// document is only read for its Works Cited lines.
const findCitedWorkSchema = z.object({
  citation: z.string().min(1).max(400),
  documentText: z.string().max(1_000_000).nullish(),
  hint: z.string().max(600).nullish()
})

export function registerCitationHandlers(): void {
  ipcMain.handle(IPC.CITATION_GENERATE, (_event, raw): CitationGenerateResponse => {
    const { sourceId, style } = generateSchema.parse(raw)

    // Formatted fresh every time, never read back from the table.
    //
    // This read the stored row first and returned it if present, which made
    // `citations` a cache of a pure function with no version on it. A source
    // cited once kept that text forever, so the formatter fix that stopped
    // putting DOIs on books reached no document that had already cited the
    // book. `formatCitation` is string concatenation — there is nothing here
    // worth the staleness.
    const source = getSourceById(sourceId)
    if (!source) throw new Error('Source not found')

    const citation = formatCitation(source, style)
    // Still written through, because the library lists these rows.
    saveCitation(sourceId, style, citation)
    return { citation }
  })

  ipcMain.handle(IPC.CITATION_LIST, (_event, raw): CitationListResponse => {
    const { sourceId } = listSchema.parse(raw)
    return { citations: listCitationsForSource(sourceId) }
  })

  /**
   * The work this claim's sentence already cites — the left-hand side of
   * "Compare sources".
   *
   * Crossref and Open Library only. No relay, no key, no cost, so it is safe to
   * run whenever the card opens rather than only after a critique — which
   * matters, because the card is pressed on sentences nobody has critiqued.
   *
   * The SENTENCE and the whole DOCUMENT, exactly as generateCritique passes
   * them, and for the same two reasons: a detected claim is a sub-span that
   * stops before its trailing "(Author, Year)", and a numbered or MLA marker
   * names its work in a list at the end of the draft.
   */
  ipcMain.handle(IPC.CITATION_RESOLVE_CITED, async (_event, raw): Promise<CitationResolveCitedResponse> => {
    const { claimId } = resolveCitedSchema.parse(raw)
    const claim = getClaim(claimId)
    if (!claim) throw new Error('Claim not found')

    const analysis = getAnalysis(claim.analysisId)
    const span = analysis ? computeClaimSpans(analysis.sourceText, [claim])[0] : undefined
    const sentence =
      analysis && span ? sentenceAround(analysis.sourceText, span.start, span.end) : claim.text

    const checks = await checkReferences(sentence, analysis?.sourceText)
    return { cited: resolveCitedWork(checks) }
  })

  /**
   * "Find the cited work" on a card in the editor. Crossref and Open Library
   * only — free, user-triggered, never a verdict. See citedWorkFinder.ts.
   */
  ipcMain.handle(IPC.CITATION_FIND_CITED_WORK, async (_event, raw): Promise<CitationFindCitedWorkResponse> => {
    const { citation, documentText, hint } = findCitedWorkSchema.parse(raw)
    return findCitedWork({ citation, documentText: documentText ?? null, hint: hint ?? null })
  })
}
