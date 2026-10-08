/**
 * Receipts: what a source in a list the writer opened actually SAYS about the
 * sentence it was found for.
 *
 * The rule, both surfaces: NO SOURCE IS PRESENTED AS BACKING A SENTENCE UNLESS
 * TRACELY READ IT AND CAN SHOW THE EXACT WORDS FROM IT THAT BACK THE SENTENCE.
 *
 * Measured 2026-10-07: three independent judges graded the 145 sources the
 * desktop's search showed across 36 claims. 15 (10%) backed their sentence, 71
 * were on the topic without backing it, 56 were off-topic, and only 11 of the
 * 36 claims got even one backing source. The list was ranked by topical
 * relevance, and a "92% match" beside a paper that says something else is the
 * product vouching for a citation it never read.
 *
 * So when the writer opens a list (a click — never passive Screen Watch
 * reading), main sends it to the server's `/api/verify-sources`, which reads
 * each source (its abstract, its open-access copy or its page) and judges it
 * with the same verifier the extension's source search runs
 * (`server/lib/sourceVerify.js`). A verdict of `backs` or `contradicts` always
 * comes with a verbatim quote that was checked to be in the source's text.
 *
 * Everything here is the decidable half — what is sent, what is trusted back,
 * how long it is kept, how a list is grouped and which rows may be inserted —
 * so `npm test` can load it. A leaf with no imports.
 */

export type ReceiptVerdict = 'backs' | 'contradicts' | 'topic' | 'unread'

/** Where the quote (or the reading) came from. */
export type ReceiptReadFrom = 'abstract' | 'page'

export interface SourceReceipt {
  /** The id the caller sent: a `Source.id` in the editor, a `sourceRef` over Screen Watch. */
  id: string
  verdict: ReceiptVerdict
  /** The source's own words, verbatim — present exactly when the verdict is backs or contradicts. */
  quote: string | null
  readFrom: ReceiptReadFrom | null
  /** A retracted work. Never shown, on either surface. */
  retracted: boolean
}

/**
 * One list's verification, as a surface holds it.
 *
 * `unavailable` is the server unreachable, an older server that 404s the
 * route, a refusal or a judge that failed. It is NOT a verdict about any
 * source, so the list falls back to what it was before receipts existed —
 * Insert allowed, under a line saying nothing was checked — rather than
 * regressing the day the server is down.
 */
export type ReceiptsState =
  | { status: 'checking' }
  | { status: 'checked'; byId: Record<string, SourceReceipt> }
  | { status: 'unavailable' }

/**
 * Bump when what a verdict MEANS changes — the server's verifier prompt, its
 * quote rule, or what is sent. It is in the cache key, so a bump retires every
 * stored receipt at once; a TTL change only reaches the future.
 */
export const RECEIPTS_VERIFIER_VERSION = 1

/** The server's own limits (`server/lib/reasoning.js` VERIFY_LIMITS). It refuses more than 8. */
export const MAX_VERIFY_SOURCES = 8
const LIMITS = { id: 200, title: 400, url: 2000, doi: 200, abstract: 4000, venue: 300, claim: 2000 }

/** One source in the list, as either surface holds it. */
export interface VerifySourceInput {
  id: string
  title: string
  url: string | null
  doi: string | null
  abstract: string | null
  venue: string | null
  year: number | null
  /** `SourceProvider` — decides whether `abstract` is the work's own words. */
  provider: string
}

/**
 * Providers whose `abstract` is the WORK'S OWN abstract, as a scholarly index
 * returned it — the only text the server may read in place of fetching.
 *
 * Deliberately not `web`: `webSources.ts` stores the search MODEL's summary of
 * what a page supports in that field, and a quote "from the abstract" lifted
 * out of a model's paraphrase is exactly the receipt this exists to refuse.
 * Not `wikipedia` or `worldbank` either: their text is the page's, so the
 * server reads the page and the receipt says "from the page", which is true.
 */
const OWN_ABSTRACT = new Set(['openalex', 'crossref', 'semanticscholar', 'pubmed'])

export function abstractToSend(provider: string, abstract: string | null): string | null {
  if (!OWN_ABSTRACT.has(provider)) return null
  const text = (abstract ?? '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, LIMITS.abstract) : null
}

const clip = (value: string | null | undefined, max: number): string | undefined => {
  const t = (value ?? '').trim()
  return t ? t.slice(0, max) : undefined
}

export interface VerifyRequestBody {
  claim: string
  sources: Array<{
    id: string
    title: string
    url?: string
    doi?: string
    abstract?: string
    venue?: string
    year?: number
  }>
}

/**
 * The body `/api/verify-sources` takes: the claim and at most
 * MAX_VERIFY_SOURCES sources, every field clamped to the server's own limits
 * (it clamps too; this keeps the request what it will read). Ids are unique —
 * the server refuses a duplicate, because the answer is keyed by them. No
 * `context`: the server's judge reads the claim alone, so the rest of the
 * draft has no reason to leave the machine.
 */
export function verifyRequestBody(claimText: string, sources: VerifySourceInput[]): VerifyRequestBody {
  const seen = new Set<string>()
  const out: VerifyRequestBody['sources'] = []
  for (const s of sources) {
    const id = (s.id ?? '').slice(0, LIMITS.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const url = clip(s.url, LIMITS.url)
    out.push({
      id,
      title: (s.title ?? '').trim().slice(0, LIMITS.title),
      ...(url && /^https?:\/\//i.test(url) ? { url } : {}),
      ...(clip(s.doi, LIMITS.doi) ? { doi: clip(s.doi, LIMITS.doi) } : {}),
      ...(abstractToSend(s.provider, s.abstract) ? { abstract: abstractToSend(s.provider, s.abstract) as string } : {}),
      ...(clip(s.venue, LIMITS.venue) ? { venue: clip(s.venue, LIMITS.venue) } : {}),
      ...(Number.isInteger(s.year) && (s.year as number) > 0 ? { year: s.year as number } : {})
    })
    if (out.length === MAX_VERIFY_SOURCES) break
  }
  return { claim: claimText.replace(/\s+/g, ' ').trim().slice(0, LIMITS.claim), sources: out }
}

const VERDICTS: ReadonlySet<string> = new Set(['backs', 'contradicts', 'topic', 'unread'])

/**
 * The server's answer, re-checked rather than trusted: one receipt per id
 * SENT, in the order sent.
 *
 *  - an id the server did not answer for is `unread` — it was not checked, and
 *    "not checked" can never be backing;
 *  - an id the server answered that was never sent is ignored;
 *  - `backs` or `contradicts` without a non-empty quote is `topic`. The server
 *    guarantees the quote; this is the rule restated where it is enforced on
 *    screen, so no future server, mock or bug can put a source in the backing
 *    group without words to show for it.
 *
 * Null when the body is not an answer at all — the caller falls back exactly
 * as for a failed call.
 */
export function parseReceipts(raw: unknown, sentIds: string[]): SourceReceipt[] | null {
  const list = (raw as { receipts?: unknown } | null)?.receipts
  if (!Array.isArray(list)) return null
  const byId = new Map<string, Record<string, unknown>>()
  for (const r of list) {
    if (r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string') {
      byId.set((r as { id: string }).id, r as Record<string, unknown>)
    }
  }
  return sentIds.map((id) => {
    const r = byId.get(id)
    const retracted = r?.retracted === true
    let verdict: ReceiptVerdict = typeof r?.verdict === 'string' && VERDICTS.has(r.verdict) ? (r.verdict as ReceiptVerdict) : 'unread'
    const quote = typeof r?.quote === 'string' && r.quote.trim() ? r.quote.trim() : null
    if ((verdict === 'backs' || verdict === 'contradicts') && !quote) verdict = 'topic'
    if (retracted) verdict = 'unread'
    const readFrom = r?.readFrom === 'page' ? 'page' : r?.readFrom === 'abstract' ? 'abstract' : null
    return {
      id,
      verdict,
      quote: verdict === 'backs' || verdict === 'contradicts' ? quote : null,
      readFrom: verdict === 'unread' ? null : readFrom,
      retracted
    }
  })
}

/**
 * What the cache key is made of: the verifier version, the claim, and the SET
 * of source ids (sorted — the same five sources in another order are the same
 * question). Hashed by the caller, which has `crypto`.
 */
export function receiptsCacheKeyMaterial(claimText: string, ids: string[]): string {
  const claim = claimText.replace(/\s+/g, ' ').trim()
  return `ai:verify-sources::v${RECEIPTS_VERIFIER_VERSION}::${claim}::${[...new Set(ids)].sort().join('|')}`
}

/** A call that failed: kept just long enough that re-opening the card in an outage does not stack calls. */
export const RECEIPTS_FAILURE_TTL_MS = 60 * 1000
/** Nothing in the list could be read — most likely transient (the server's 4-second deadline, a provider down). */
export const RECEIPTS_EMPTY_TTL_MS = 10 * 60 * 1000
/** Some could not be read. A paywall is permanent, a slow page is not: an hour is the compromise. */
export const RECEIPTS_PARTIAL_TTL_MS = 60 * 60 * 1000
/** Every source read and judged. What a paper says does not move between Tuesday and Friday. */
export const RECEIPTS_FULL_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How long one answer is kept — the EMPTY_TTL lesson (docs/desktop-architecture.md,
 * "An EMPTY evidence answer is cached for MINUTES"): an answer that read
 * nothing looks the same whether nothing could be read or every read timed
 * out, so it must expire in minutes, not sit on the card for a week.
 */
export function receiptsTtlMs(receipts: SourceReceipt[]): number {
  const live = receipts.filter((r) => !r.retracted)
  const unread = live.filter((r) => r.verdict === 'unread').length
  if (live.length === 0 || unread === live.length) return RECEIPTS_EMPTY_TTL_MS
  return unread > 0 ? RECEIPTS_PARTIAL_TTL_MS : RECEIPTS_FULL_TTL_MS
}

/** What main keeps in its request cache for one list. */
export type CachedReceipts =
  | { status: 'checked'; receipts: SourceReceipt[] }
  | { status: 'failed'; reason: string }

/** What a surface is told: one receipt per source it sent, or the fallback. */
export type ReceiptsAnswer =
  | { status: 'checked'; receipts: SourceReceipt[] }
  | { status: 'unavailable'; reason: string }

/**
 * One server round trip, settled: what the surface is told, what is cached,
 * and for how long. Every way it can go wrong — no answer, an error, a body
 * that is not receipts — is `unavailable` with a failure cached for a minute:
 * the fallback list (Insert allowed, "Tracely couldn't check these") rather
 * than an error card or, worse, a list of "unread" that would tell the writer
 * every source was unreadable when it was the server that failed.
 */
export function settleReceipts(
  answer: { ok: true; body: unknown } | { ok: false; reason: string },
  sentIds: string[]
): { answer: ReceiptsAnswer; cache: CachedReceipts; ttlMs: number } {
  const receipts = answer.ok ? parseReceipts(answer.body, sentIds) : null
  if (!receipts) {
    const reason = answer.ok ? 'The Tracely server sent receipts that could not be read.' : answer.reason
    return { answer: { status: 'unavailable', reason }, cache: { status: 'failed', reason }, ttlMs: RECEIPTS_FAILURE_TTL_MS }
  }
  return { answer: { status: 'checked', receipts }, cache: { status: 'checked', receipts }, ttlMs: receiptsTtlMs(receipts) }
}

/** A cached entry, as a surface is told it. */
export function answerFromCache(cached: CachedReceipts): ReceiptsAnswer {
  return cached.status === 'checked'
    ? { status: 'checked', receipts: cached.receipts }
    : { status: 'unavailable', reason: cached.reason }
}

/**
 * Receipts in the order the surface sent its sources, one each. A source the
 * server was never asked about (past MAX_VERIFY_SOURCES, or a duplicate id) is
 * `unread` — not checked is never backing.
 */
export function receiptsInOrder(ids: string[], receipts: SourceReceipt[]): SourceReceipt[] {
  const byId = new Map(receipts.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id) ?? { id, verdict: 'unread', quote: null, readFrom: null, retracted: false })
}

export interface ReceiptGroups<T> {
  /** Read, and quoted saying the sentence. The only rows that may be cited. */
  backs: T[]
  /** Read, and quoted saying something that cannot be true alongside it. Never offered for insert. */
  contradicts: T[]
  /** Read, and about the subject without saying this. */
  topic: T[]
  /** Not read: paywall, PDF, bot wall, the deadline — or not answered for. */
  unread: T[]
}

/**
 * The list in receipt order: backs, then contradicts, then topic, then
 * unread. Each group keeps the caller's own order (most citable first), and a
 * retracted work is dropped from all of them.
 */
export function groupByReceipt<T>(
  items: T[],
  idOf: (item: T) => string,
  byId: Record<string, SourceReceipt>
): ReceiptGroups<T> {
  const groups: ReceiptGroups<T> = { backs: [], contradicts: [], topic: [], unread: [] }
  for (const item of items) {
    const r = byId[idOf(item)]
    if (r?.retracted) continue
    groups[r ? r.verdict : 'unread'].push(item)
  }
  return groups
}

/** The receipts keyed by id, as `ReceiptsState` holds them. */
export function receiptsById(receipts: SourceReceipt[]): Record<string, SourceReceipt> {
  return Object.fromEntries(receipts.map((r) => [r.id, r]))
}

/**
 * May this row be inserted (the editor's Insert / Replace, the overlay's
 * Insert, Copy citation and Copy entry)?
 *
 *  - while checking: no — the answer is seconds away;
 *  - checked: only a source whose receipt is `backs`;
 *  - unavailable: yes, as before receipts, under a line saying nothing was
 *    checked — the fallback that keeps a server outage from taking the
 *    citation flow down with it;
 *  - no state at all: no.
 */
export function mayInsert(state: ReceiptsState | null, id: string | null): boolean {
  if (!state || !id) return false
  if (state.status === 'unavailable') return true
  if (state.status === 'checking') return false
  const r = state.byId[id]
  return Boolean(r && !r.retracted && r.verdict === 'backs')
}

/**
 * The row pre-selected when a list arrives or its receipts land: the first
 * one that may be inserted, in the caller's order, or none. Never a row the
 * Insert button would refuse — a pre-selected topic source is the card
 * recommending what it has just said not to cite.
 */
export function firstInsertable(ids: string[], state: ReceiptsState | null): string | null {
  return ids.find((id) => mayInsert(state, id)) ?? null
}
