import { createHash } from 'crypto'
import type { Author, CitationStyle, Source, VenueType } from '@shared/types'
import type { CitationFindCitedWorkResponse, CitedWorkCandidate } from '@shared/ipc-contract'
import {
  bookYear,
  citedWorkQueries,
  citedYearOf,
  matchWorksCitedEntry,
  personFromFullName,
  rankCitedWorkRecords,
  yearMismatchLabel,
  type CitedWorkRecord
} from '@shared/citedWork'
import { formatInTextCitation } from '@shared/citationInText'
import { normalizeDoi } from '@shared/citationLocator'
import { formatCitation } from '../citations'
import { getCached, setCached } from '../storage/cacheRepo'
import { politePoolMailto } from '../storage/settingsRepo'
import { PROVIDER_MIN_INTERVAL_MS, throttle } from './rateLimiter'

/**
 * "Find the cited work": go and get the records that look like what a
 * sentence cites.
 *
 * The decidable half lives in `shared/citedWork.ts` (queries, scoring, the year
 * line); this is the network and the formatting. It is user-triggered only —
 * a button on a card — and costs nothing: Crossref and Open Library, the same
 * two indexes `referenceCheck.ts` already queries, no key, no server.
 *
 * Never a verdict. An empty list means two indexes had nothing above the
 * floor, which a UNICEF page, a newspaper or most government reports would
 * produce whatever their quality — the card says so with citedComparison's
 * NOT_INDEXED_NOTE, and nothing here decides the citation is bad.
 */

/** A record plus what the formatters need that the card does not show. */
interface FoundRecord extends CitedWorkRecord {
  people: Author[]
  venueType: VenueType | null
}

const TIMEOUT_MS = 5000
/** Crossref's top five is plenty: this ranks the writer's own reference string. */
const CROSSREF_ROWS = 5
const OPEN_LIBRARY_LIMIT = 5

/**
 * A day for an answer with something in it, minutes for an empty one — the
 * lesson cachedEvidence.ts learned the hard way. Every failure path arrives as
 * the same empty list as "the indexes have nothing", and freezing that for a
 * day is what hid three correct retrieval fixes behind a cached zero.
 */
const CACHE_TTL_MS = 1000 * 60 * 60 * 24
const EMPTY_TTL_MS = 1000 * 60 * 10

/** Crossref record types nobody means to cite — crossref.ts's list. */
const NON_WORK_TYPES = new Set([
  'journal-issue',
  'journal-volume',
  'journal',
  'book-series',
  'book-set',
  'component',
  'peer-review',
  'grant',
  'report-component'
])

function venueTypeOf(type: string | undefined): VenueType | null {
  if (!type) return null
  if (type.includes('journal')) return 'journal'
  if (type.includes('proceedings') || type.includes('conference')) return 'conference'
  if (type === 'book-chapter' || type === 'book-part' || type === 'book-section') return 'book-chapter'
  if (type.includes('book') || type === 'monograph') return 'book'
  if (type === 'posted-content') return 'preprint'
  return 'other'
}

interface CrossrefItem {
  DOI?: string
  title?: string[]
  author?: Array<{ given?: string; family?: string; name?: string }>
  'container-title'?: string[]
  publisher?: string
  type?: string
  issued?: { 'date-parts'?: number[][] }
}

async function fromCrossref(query: string): Promise<FoundRecord[] | null> {
  const mailto = politePoolMailto()
  const params = new URLSearchParams({
    'query.bibliographic': query,
    rows: String(CROSSREF_ROWS),
    select: 'DOI,title,author,container-title,publisher,type,issued',
    ...(mailto ? { mailto } : {})
  })
  await throttle('crossref', PROVIDER_MIN_INTERVAL_MS.crossref)
  try {
    const res = await fetch(`https://api.crossref.org/works?${params.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) {
      console.warn(`[citedWork] crossref ${res.status} ${res.statusText}`)
      return null
    }
    const data = (await res.json()) as { message?: { items?: CrossrefItem[] } }
    return (data.message?.items ?? [])
      .filter((item) => !NON_WORK_TYPES.has(item.type ?? '') && Boolean(item.title?.[0]?.trim()))
      .map((item): FoundRecord => {
        // A person is given + family; an organisation author is `name`. Both
        // straight off the record — and an author with neither is skipped
        // rather than written in as "Unknown", which crossref.ts once did.
        const people: Author[] = (item.author ?? []).flatMap((a): Author[] =>
          a.family ? [{ given: a.given, family: a.family }] : a.name ? [{ family: a.name }] : []
        )
        const doi = item.DOI ? normalizeDoi(item.DOI) : null
        const venueType = venueTypeOf(item.type)
        return {
          title: item.title?.[0]?.trim() ?? '',
          authors: people.map((p) => [p.given, p.family].filter(Boolean).join(' ')),
          people,
          year: item.issued?.['date-parts']?.[0]?.[0] ?? null,
          // A book's "venue" is its publisher; an article's is its journal.
          venue: (venueType === 'book' ? item.publisher : item['container-title']?.[0]) ?? null,
          venueType,
          doi,
          url: doi ? `https://doi.org/${doi}` : null,
          index: 'crossref'
        }
      })
  } catch (error) {
    console.warn(`[citedWork] crossref failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function fromOpenLibrary(query: string, citedYear: number | null): Promise<FoundRecord[] | null> {
  const params = new URLSearchParams({
    q: query,
    limit: String(OPEN_LIBRARY_LIMIT),
    fields: 'key,title,author_name,first_publish_year,publish_year'
  })
  try {
    const res = await fetch(`https://openlibrary.org/search.json?${params.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!res.ok) {
      console.warn(`[citedWork] openlibrary ${res.status} ${res.statusText}`)
      return null
    }
    const data = (await res.json()) as {
      docs?: Array<{
        key?: string
        title?: string
        author_name?: string[]
        first_publish_year?: number
        publish_year?: number[]
      }>
    }
    return (data.docs ?? [])
      .filter((doc) => Boolean(doc.title?.trim()))
      .map((doc): FoundRecord => {
        const authors = doc.author_name ?? []
        return {
          title: doc.title?.trim() ?? '',
          authors,
          people: authors.map(personFromFullName),
          year: bookYear(doc.first_publish_year ?? null, doc.publish_year ?? [], citedYear),
          // Not the publisher. Open Library lists every edition's publishers
          // on the work, and naming one would be guessing which edition the
          // writer read — a reference with a gap is better than a wrong one.
          venue: null,
          venueType: 'book',
          doi: null,
          // The WORK page, which is the record itself — not a search URL
          // dressed as a source (see resolveCitedWork in referenceCheck.ts).
          url: doc.key ? `https://openlibrary.org${doc.key}` : null,
          index: 'openlibrary'
        }
      })
  } catch (error) {
    console.warn(`[citedWork] openlibrary failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

const STYLES: CitationStyle[] = ['APA', 'MLA', 'Chicago']

/** The record as a `Source`, for the formatters only — never persisted. */
function asSource(record: FoundRecord, ref: string): Source {
  return {
    id: ref,
    doi: record.doi,
    title: record.title,
    authors: record.people,
    year: record.year,
    venue: record.venue,
    venueType: record.venueType,
    url: record.url,
    pdfUrl: null,
    abstract: null,
    // Open Library is not a provider this app persists sources from; the
    // formatters never read this field, and nothing here is saved.
    provider: record.index === 'crossref' ? 'crossref' : 'manual',
    providerId: record.doi,
    citationCount: null,
    oaStatus: null,
    createdAt: new Date(0).toISOString()
  }
}

function toCandidate(record: FoundRecord, score: number, i: number, citedYear: number | null): CitedWorkCandidate {
  const ref = `cited:${record.index}:${i}`
  const source = asSource(record, ref)
  return {
    ref,
    title: record.title,
    authors: record.authors,
    year: record.year,
    venue: record.venue,
    doi: record.doi,
    url: record.url,
    index: record.index,
    matchPercent: Math.round(score * 100),
    yearNote: yearMismatchLabel(record.year, citedYear),
    citations: Object.fromEntries(
      STYLES.map((style) => [
        style,
        { inTextCitation: formatInTextCitation(source, style), worksCitedEntry: formatCitation(source, style) }
      ])
    ) as CitedWorkCandidate['citations']
  }
}

interface Lookup {
  ranked: Array<{ record: FoundRecord; score: number }>
  searched: boolean
}

function cacheKey(queries: ReturnType<typeof citedWorkQueries>, citedYear: number | null): string {
  return createHash('sha256')
    .update(`cited-work::v1::${queries.crossref.join('||')}::${queries.openLibrary ?? ''}::${queries.scoring}::${citedYear ?? ''}`)
    .digest('hex')
}

/**
 * Both indexes, in parallel, every query; ranked once over the union.
 *
 * Unlike referenceCheck there is no "stop at the first corroboration": this is
 * a list for the writer to choose from, and a book the scholarly index happens
 * to carry a chapter of should sit beside the book itself.
 */
async function lookUp(queries: ReturnType<typeof citedWorkQueries>, citedYear: number | null): Promise<Lookup> {
  const key = cacheKey(queries, citedYear)
  const cached = getCached<Lookup>(key)
  if (cached) return cached

  const answers = await Promise.all([
    ...queries.crossref.map((q) => fromCrossref(q)),
    queries.openLibrary ? fromOpenLibrary(queries.openLibrary, citedYear) : Promise.resolve(null)
  ])
  const searched = answers.some((a) => a !== null)
  const records = answers.flatMap((a) => a ?? [])
  const lookup: Lookup = { ranked: rankCitedWorkRecords(records, queries.scoring), searched }

  // A lookup that could not reach either index is not cached at all: it is
  // not an answer, and the next press should try again.
  if (searched) {
    setCached(key, 'search:citedWork', lookup, lookup.ranked.length > 0 ? CACHE_TTL_MS : EMPTY_TTL_MS)
  }
  return lookup
}

export async function findCitedWork({
  citation,
  documentText = null,
  hint = null
}: {
  citation: string
  documentText?: string | null
  hint?: string | null
}): Promise<CitationFindCitedWorkResponse> {
  const typed = citation.trim()
  const citedYear = citedYearOf(typed)
  const entry = documentText ? matchWorksCitedEntry(typed, documentText) : null
  const queries = citedWorkQueries({ citation: typed, entry, hint })
  if (queries.crossref.length === 0 && !queries.openLibrary) {
    return { citation: typed, entry, citedYear, candidates: [], searched: false }
  }

  const { ranked, searched } = await lookUp(queries, citedYear)
  return {
    citation: typed,
    entry,
    citedYear,
    candidates: ranked.map(({ record, score }, i) => toCandidate(record, score, i, citedYear)),
    searched
  }
}
