import { createHash } from 'crypto'
import type { ServerModel } from '@shared/plan'
import { callServer } from '../ai/client'
import { modelForCall } from '../ai/modelTier'
import { getCached, setCached } from '../storage/cacheRepo'
import {
  isPlausibleSourceUrl,
  livenessFromStatus,
  shouldOffer,
  type Liveness
} from '@shared/urlLiveness'
import type { NormalizedSourceResult } from './types'
import type { Author, VenueType } from '@shared/types'

/**
 * Sources found by SEARCHING the web, for claims the academic indexes cannot
 * answer.
 *
 * OpenAlex, Crossref, Semantic Scholar and PubMed index scholarly articles. A
 * great many student essays are not about anything a journal publishes, and for
 * those the fan-out returns the closest thing in the wrong library — measured
 * on a biography essay, a psychopharmacology case report and *Paediatric Battle
 * Casualties* offered for a claim about the Dutch resistance, with the one
 * genuinely useful hit (an Oxford DNB entry) ranked below them. The sources
 * that essay needed were unicef.org, history.com and the ODNB. None of those is
 * in any of the four.
 *
 * ── Why this is not "asking a model for a citation" ────────────────────────
 * Asked from memory a model invents sources, which is why nothing else in this
 * app does it. The server call behind this runs a web search tool: the URLs
 * come from pages the model opened, not from its weights.
 *
 * The remaining failure — a stale or garbled URL — is caught HERE, by fetching
 * every one before it is offered. That check is the whole reason this is
 * allowed to exist, so it runs on every result and is never skipped for speed.
 */

/** Matches MAX_EVIDENCE_RESULTS; the writer asked for at most five options. */
const MAX_WEB_SOURCES = 5
const CHECK_TIMEOUT_MS = 8000
/**
 * A week, raised from a day.
 *
 * What the open web says about "Hepburn raised money for the Dutch resistance"
 * does not change between Tuesday and Friday, and this is the most expensive
 * single call in the product — OpenAI bills the `web_search_preview` tool per
 * call on top of tokens, and the prompt runs several site-restricted queries
 * inside each one. A 24-hour TTL meant re-opening the same draft the next
 * morning paid for the whole draft again.
 *
 * The risk a short TTL was buying — a stale answer — is small here and gets
 * smaller the more specific the claim. The risk it was creating, re-paying
 * daily for an unchanged document, is the one that showed up on the bill.
 */
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7
/**
 * An EMPTY answer is held for minutes, not a week.
 *
 * The same split `cachedEvidence.ts` had to learn: every failure path here —
 * the relay refusing, a timeout, every URL failing its liveness check — arrives
 * at the cache as the same empty list as "the web genuinely has nothing". They
 * are not the same, an empty result is far more likely transient, and it is the
 * one answer a writer retries. Freezing it for a week would make a fixed
 * retrieval bug invisible for a week, which is exactly how three consecutive
 * correct fixes went unnoticed in August.
 */
const EMPTY_TTL_MS = 1000 * 60 * 10

/**
 * How much of the claim a source actually carries — the relay's own honest
 * answer, not a similarity score.
 *
 * `context` replaced `background` on 2026-08-21 with the rewritten prompt. The
 * three levels are the writer's words: it says this specific thing, it
 * establishes the surrounding facts, or it is orientation.
 */
type Strength = 'direct' | 'partial' | 'context'
/**
 * `archive` and `book` arrived with the rewritten prompt. Both were previously
 * flattened into 'other', which is how a national archive and an enthusiast
 * blog ended up looking alike to `citationLocator`.
 */
type SourceKind =
  | 'institutional'
  | 'archive'
  | 'reference'
  | 'news'
  | 'journal'
  | 'book'
  | 'other'

interface FoundSource {
  title: string
  url: string
  publisher: string
  year: number | null
  kind: SourceKind
  authors: string[]
  supports: string
  strength: Strength
  /** The publisher this page is repeating, when it plainly is one. */
  echoes: string | null
}

interface FindSourcesResponse {
  /**
   * The separate factual assertions the relay found in the sentence, listed
   * before it searched.
   *
   * Carried back because a writer looking at three "partial" sources needs to
   * see WHICH part is still unsourced, and that cannot be derived from the
   * source list.
   */
  assertions: string[]
  sources: FoundSource[]
  /** What is wrong with the sentence as written, or null if nothing is. */
  claimProblem: string | null
  /** Wording the sources actually support. Null when the claim is fine. */
  revisedClaim: string | null
  /** True only when the underlying facts are genuinely contested. */
  disputed: boolean
  note: string
}

export interface WebSourceResult {
  sources: NormalizedSourceResult[]
  /** The model's one line for the writer, when it had one. */
  note: string
  /** Dropped URLs and why. Logged, never shown — see the note in `findWebSources`. */
  dropped: { url: string; reason: string }[]
}

/**
 * The kinds map onto the venue types citations already understand.
 *
 * `institutional` becomes 'other' rather than 'reference': a charity's page
 * about its own history is not a work of reference, and `citationLocator` gives
 * 'other' its URL — which is exactly right, since a web page's locator IS its
 * URL. A reference work gets 'reference', which suppresses a DOI it should
 * never carry.
 */
const VENUE_TYPE: Record<SourceKind, VenueType> = {
  institutional: 'other',
  // An archive or museum record is a work of record, which is what suppresses
  // the DOI `citationLocator` would otherwise hang off it.
  archive: 'reference',
  reference: 'reference',
  news: 'other',
  journal: 'journal',
  book: 'book',
  other: 'other'
}

/**
 * "Alexander Walker" → { given: 'Alexander', family: 'Walker' }.
 *
 * The relay returns display-order strings because that is how a page prints
 * them. Anything with no space becomes a family name alone, which is what the
 * formatters already do for a mononym.
 */
function parseAuthor(name: string): Author {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  const at = trimmed.lastIndexOf(' ')
  if (at === -1) return { family: trimmed }
  return { given: trimmed.slice(0, at), family: trimmed.slice(at + 1) }
}

/**
 * Does this page exist?
 *
 * GET rather than HEAD: enough sites answer HEAD with 405 or 404 while serving
 * the page perfectly well that HEAD would drop real sources. The body is
 * discarded — `redirect: 'follow'` plus the status is all this needs.
 */
async function checkUrl(url: string): Promise<Liveness> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      // Without a browser UA a good number of publishers answer 403 to
      // everything. They are kept anyway (see urlLiveness), but a check that
      // provokes fewer false walls is a check with less to explain.
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8'
      }
    })
    return livenessFromStatus(response.status)
  } catch {
    // DNS failure, refused connection, timeout. No evidence the host exists.
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}

function cacheKey(claim: string, context: string, model: ServerModel): string {
  // v3: find-sources moved from the relay to the Tracely server, and the model
  // is now in the key. Not strictly one of the "AI answers" the model-in-key
  // rule was written for — the URLs come from pages the model opened, not from
  // its judgement — but which pages it opens, how it ranks them and what it
  // says each one `supports` are all the model's, and the paid tiers run a
  // stronger one. A week-long entry written by the free model would otherwise
  // outlive the upgrade by a week. The bump retires every v2 entry, all
  // written by the relay.
  //
  // v2: the prompt and the response schema were both rewritten (2026-08-21) —
  // claim decomposition, honest Direct/Partial/Context strength, an `echoes`
  // field, and a judgement on the claim itself. A v1 hit serves the old
  // five-equal-options answer for a day.
  //
  // v1. Bump on any change to what the relay returns or to how it is filtered,
  // for the reason spelled out in cachedEvidence.ts — a stale hit serves the
  // pre-change list for a day, on exactly the drafts being used to judge it.
  return createHash('sha256').update(`search:web::v3::${model}::${claim}::${context}`).digest('hex')
}

/**
 * Search the web for sources supporting one claim.
 *
 * Returns an empty list rather than throwing when the server is unavailable:
 * this supplements the academic providers, and a claim with no web sources is
 * the same state as a claim with no academic ones.
 */
export async function findWebSources(
  claimText: string,
  /** The draft's subject, so "she volunteered in a hospital" is searchable. */
  context: string
): Promise<WebSourceResult> {
  const empty: WebSourceResult = { sources: [], note: '', dropped: [] }
  if (!claimText.trim()) return empty

  const model = await modelForCall()
  const key = cacheKey(claimText, context, model)
  const cached = getCached<WebSourceResult>(key)
  if (cached) return cached

  let response: FindSourcesResponse
  try {
    response = await callServer<FindSourcesResponse>(
      'find-sources',
      {
        claim: claimText,
        context
      },
      { model }
    )
  } catch (error) {
    console.warn('[websearch] failed', error)
    return empty
  }

  const dropped: { url: string; reason: string }[] = []
  const candidates = (response.sources ?? []).filter((source) => {
    if (!source?.url || !isPlausibleSourceUrl(source.url)) {
      dropped.push({ url: source?.url ?? '(none)', reason: 'not a usable URL' })
      return false
    }
    return true
  })

  // Every URL, in parallel, before any of them is offered. This is the guard,
  // and it is why a model is allowed to supply sources here at all.
  const liveness = await Promise.all(candidates.map((source) => checkUrl(source.url)))

  const sources: NormalizedSourceResult[] = []
  candidates.forEach((source, index) => {
    if (!shouldOffer(liveness[index])) {
      dropped.push({ url: source.url, reason: liveness[index] })
      return
    }
    if (sources.length >= MAX_WEB_SOURCES) return
    sources.push({
      doi: null,
      title: source.title,
      authors: (source.authors ?? []).filter((n) => n.trim()).map(parseAuthor),
      year: source.year,
      venue: source.publisher || null,
      venueType: VENUE_TYPE[source.kind] ?? 'other',
      url: source.url,
      pdfUrl: null,
      // What the model says this page establishes about this claim, which is
      // also what the relevance pass reads. It is an account of the page rather
      // than the page's own text, and the card presents it as such.
      abstract: source.supports || null,
      provider: 'web',
      providerId: source.url,
      citationCount: null,
      oaStatus: null,
      // Best first, as returned — the model ranked these by how directly they
      // bear on the claim, which is the judgement being bought.
      relevanceRank: sources.length,
      raw: source
    })
  })

  if (dropped.length > 0) {
    // Logged, not surfaced. A writer does not need to know a URL was checked
    // and failed; whoever is tuning the prompt does, and an invented URL is the
    // signal that it needs tuning.
    console.warn(
      `[websearch] dropped ${dropped.length}:`,
      dropped.map((d) => `${d.url} — ${d.reason}`).join('; ')
    )
  }

  const result: WebSourceResult = { sources, note: response.note ?? '', dropped }
  // Minutes for an empty answer, a week for a real one — see EMPTY_TTL_MS.
  setCached(key, 'search:web', result, sources.length === 0 ? EMPTY_TTL_MS : CACHE_TTL_MS)
  return result
}
