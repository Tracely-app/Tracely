/**
 * Pure adapters between OUR local server's JSON (tracely/server.js) and THEIR
 * renderer contract (@shared/ipc-contract, @shared/types).
 *
 * Everything here is a mapping with no I/O, so httpApi.ts stays a thin fetch
 * layer. The citation formatters are ported from src/main/services/citations
 * (they are pure, but tsconfig.web.json is `composite`, so importing main-side
 * files into the renderer program would fail with TS6307 — the port imports
 * the same @shared modules, so behaviour matches the app's formatters).
 */
import type {
  Author,
  Citation,
  CitationStyle,
  ClaimType,
  CritiqueVerdict,
  DocumentListItem,
  DocumentRecord,
  EvidenceItem,
  ParagraphRole,
  ScoreBreakdown,
  Source,
  StructureComponents,
  StructureWeakness,
  VenueType
} from '@shared/types'
import type { ScreenWatchStatus } from '@shared/ipc-contract'
import { realAuthors } from '@shared/placeholderAuthor'
import { citationLocator } from '@shared/citationLocator'
import { containerPrefix, endTitle } from '@shared/citationTitle'

// ── our server's payload shapes ─────────────────────────────────────────────

/** One source as tracely/lib/evidence.js returns it (authors are plain names). */
export interface ServerSource {
  id?: string
  doi: string | null
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  venueType: string | null
  url: string | null
  abstract: string | null
  provider: string
  oaUrl: string | null
  relevance?: number
  metric?: string
  citable?: boolean
}

export interface ServerStrength {
  score: number
  metric: string
  breakdown: { sourceCount: number; venueQuality: number; recency: number; relevanceRank: number }
}

export interface ServerEvidenceResponse {
  sources: ServerSource[]
  strength: ServerStrength | null
  searched: {
    providers: string[]
    failed: string[]
    aboveFloor: number
    citableAboveFloor: number
    outsideIndex: boolean
  }
}

export interface ServerDetectedClaim {
  id: string
  text: string
  sentence: string
  start: number
  end: number
  claimType: string
  confidence: number
  query: string
}

/**
 * The server's critique, in the DESKTOP's vocabulary.
 *
 * The desktop's five-pass critique (the retired relay's) moved into the
 * server, so /api/critique now answers exactly what the desktop's own main
 * process receives. It used to answer the server's older six-verdict shape
 * ({verdict, explanation, revision, overstated, confidence}), and this bridge
 * translated — lossily: `partially-supported` could not be expressed at all.
 */
export interface ServerCritiqueResponse {
  critique: string
  verdict: string
  suggestedRevision: string | null
  citationFix: string | null
}

export interface ServerDocRow {
  id: string
  title: string
  body_html?: string
  created_at: number
  updated_at: number
  last_opened_at?: number
  grade_letter?: string | null
  grade_score?: number | null
}

export interface ServerLibraryRow {
  id: string
  note: string | null
  createdAt: number
  source: ServerSource
}

export interface ServerWatchState {
  enabled: boolean
  hasAccess: boolean | null
  app: string | null
  role: string | null
  textPreview: string
  updatedAt: number | null
  findings: unknown[]
  watchApps?: string[]
}

export interface ServerPrefs {
  citationStyle: string
  gradingLevel: number
  autoCritique: boolean
  autoSources: boolean
  model: string
  effort: string
  modelStrategy: string
  theme: string
  accent: string
  fontSize: number
  density: string
  firstName?: string
  lastName?: string
  watchEnabled?: boolean
  watchApps?: string[]
}

export interface ServerGradeComponent {
  score: number
  quote: string
  reason: string
}

/**
 * The desktop's rubric grader, as the server now runs it (the retired
 * relay's grade-draft, verified server-side). Paragraph roles, warrants and
 * reasoning faults come back in the SAME answer as the scores, which is why
 * the desktop makes one call for its report and this bridge now does too.
 * Paragraph indices are 1-based, matching the prompt's [1] [2] … numbering.
 */
export interface ServerGradeResponse {
  paragraphs: {
    index: number
    role: string
    statesClaim: boolean
    hasWarrant: boolean
    reasoningFailure: string
  }[]
  components: {
    thesis: ServerGradeComponent
    governingClaims: ServerGradeComponent
    warrant: ServerGradeComponent
    counterargument: ServerGradeComponent
    significance: ServerGradeComponent
    conclusion: ServerGradeComponent
  }
  counterargumentApplicable: boolean
  findings: {
    paragraphIndex: number | null
    rubricSection: string
    severity: 'major' | 'minor'
    label: string
    quote: string
    message: string
    fix: string
  }[]
  summary: string
}

export interface ServerCompareMatch extends ServerSource {
  relevance: number
}

export interface ServerCompareResponse {
  matches: ServerCompareMatch[]
  nearMisses: ServerCompareMatch[]
  resolved: boolean
  resolvedNote?: string
}

// ── small utilities ─────────────────────────────────────────────────────────

export function isoOf(ms: number | null | undefined): string {
  return new Date(typeof ms === 'number' ? ms : Date.now()).toISOString()
}

/** Deterministic content hash for outline staleness (FNV-1a, hex). */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** "Ada B. Lovelace" → { given: 'Ada B.', family: 'Lovelace' }. */
export function authorFromName(name: string): Author {
  const words = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return { family: '' }
  const family = words[words.length - 1]
  const given = words.slice(0, -1).join(' ')
  return given ? { given, family } : { family }
}

const CLAIM_TYPES: ReadonlySet<string> = new Set([
  'statistic',
  'causal',
  'factual',
  'prediction',
  'opinion'
])

export function claimTypeOf(raw: string): ClaimType {
  return (CLAIM_TYPES.has(raw) ? raw : 'factual') as ClaimType
}

/**
 * Our venue vocabulary (journal | book | chapter | web | report | news |
 * encyclopedia) onto theirs. 'report' from the World Bank is a primary
 * statistical series — their 'dataset'; anything else without a slot is
 * 'other', never a guess at a more specific type.
 */
export function venueTypeOf(raw: string | null, provider?: string): VenueType | null {
  switch (raw) {
    case 'journal':
      return 'journal'
    case 'book':
      return 'book'
    case 'chapter':
      return 'book-chapter'
    case 'encyclopedia':
      return 'reference'
    case 'report':
      return provider === 'worldbank' ? 'dataset' : 'other'
    case 'news':
    case 'web':
      return 'other'
    default:
      return raw ? 'other' : null
  }
}

const THEIR_PROVIDERS: ReadonlySet<string> = new Set([
  'web',
  'openalex',
  'crossref',
  'semanticscholar',
  'pubmed',
  'wikipedia',
  'worldbank',
  'manual'
])

export function sourceFromServer(s: ServerSource, fallbackId: string): Source {
  return {
    id: s.id ?? fallbackId,
    doi: s.doi ?? null,
    title: s.title,
    authors: (s.authors ?? []).map(authorFromName).filter((a) => a.family),
    year: s.year ?? null,
    venue: s.venue ?? null,
    venueType: venueTypeOf(s.venueType, s.provider),
    url: s.url ?? null,
    pdfUrl: s.oaUrl ?? null,
    abstract: s.abstract ?? null,
    provider: (THEIR_PROVIDERS.has(s.provider) ? s.provider : 'manual') as Source['provider'],
    providerId: null,
    citationCount: null,
    oaStatus: s.oaUrl ? 'open' : null,
    createdAt: isoOf(Date.now())
  }
}

/** The reverse trip, for POST /api/library — our server stores plain names. */
export function sourceToServer(s: Source): ServerSource {
  const reverseVenue: Record<string, string> = {
    journal: 'journal',
    dataset: 'report',
    conference: 'journal',
    preprint: 'journal',
    book: 'book',
    'book-chapter': 'chapter',
    reference: 'encyclopedia',
    other: 'web'
  }
  return {
    id: s.id,
    doi: s.doi,
    title: s.title,
    authors: realAuthors(s.authors).map((a) => [a.given, a.family].filter(Boolean).join(' ')),
    year: s.year,
    venue: s.venue,
    venueType: s.venueType ? (reverseVenue[s.venueType] ?? 'web') : null,
    url: s.url,
    abstract: s.abstract,
    provider: s.provider,
    oaUrl: s.pdfUrl
  }
}

export const ZERO_BREAKDOWN: ScoreBreakdown = {
  sourceCount: 0,
  quality: 0,
  recency: 0,
  relevance: 0,
  support: 0
}

/**
 * Our breakdown parts are 0-25; theirs are 0-1 fractions. `support` is 0 —
 * our pipeline runs no stance model, which their contract documents as the
 * common "no stance verdict" state.
 */
export function breakdownFromStrength(strength: ServerStrength | null): ScoreBreakdown {
  if (!strength) return { ...ZERO_BREAKDOWN }
  const b = strength.breakdown
  const frac = (n: number): number => Math.max(0, Math.min(1, n / 25))
  return {
    sourceCount: frac(b.sourceCount),
    quality: frac(b.venueQuality),
    recency: frac(b.recency),
    relevance: frac(b.relevanceRank),
    support: 0
  }
}

export function evidenceItemsFromServer(sources: ServerSource[], register: (s: Source) => void): EvidenceItem[] {
  return sources.map((s, i) => {
    const source = sourceFromServer(s, `src-${hashText(`${s.title}|${s.year ?? ''}|${s.provider}`)}`)
    register(source)
    return {
      source,
      relevanceScore: s.relevance ?? 0,
      rank: i + 1,
      stance: null,
      stanceConfidence: null
    }
  })
}

/**
 * Our critique verdicts onto theirs. `citationFix` has no slot in their union
 * — the source is real and the claim may hold, so 'partially-supported' is the
 * honest nearest state. `overstated` arrives as a flag on our side and is a
 * verdict on theirs; it wins only over the verdicts it refines (a contradicted
 * or fabricated finding is strictly worse news than an overstatement).
 */
const DESKTOP_VERDICTS: ReadonlySet<string> = new Set([
  'contradicted',
  'fabricated',
  'overstated',
  'well-supported',
  'partially-supported',
  'weak',
  'unsupported'
])

/** The server speaks the desktop's verdicts natively; anything else is unsupported. */
export function critiqueVerdictOf(server: Pick<ServerCritiqueResponse, 'verdict'>): CritiqueVerdict {
  return (DESKTOP_VERDICTS.has(server.verdict) ? server.verdict : 'unsupported') as CritiqueVerdict
}

/**
 * Paste hygiene: strip presentational text/background colors from document
 * HTML. Text pasted from a dark-mode Google Doc arrives wrapped in
 * `<font color="#ffffff">` (plus color/background-color inline styles), which
 * renders white-on-white on the editor sheet. Structure, bold/italic, and
 * alignment survive; only the color paint is removed. Runs on load AND save,
 * so already-stored documents heal the next time they are touched.
 */
export function sanitizeDocHtml(html: string): string {
  if (!html || (!html.includes('color') && !html.includes('<font'))) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const font of Array.from(doc.querySelectorAll('font'))) {
    font.removeAttribute('color')
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[style]'))) {
    el.style.removeProperty('color')
    el.style.removeProperty('background-color')
    el.style.removeProperty('background')
    el.style.removeProperty('-webkit-text-fill-color')
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style')
  }
  return doc.body.innerHTML
}

export function documentRecordFromRow(row: ServerDocRow): DocumentRecord {
  return {
    id: row.id,
    title: row.title,
    bodyHtml: sanitizeDocHtml(row.body_html ?? ''),
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at)
  }
}

export function documentListItemFromRow(row: ServerDocRow, gradedAt: string | null): DocumentListItem {
  return {
    ...documentRecordFromRow(row),
    score: typeof row.grade_score === 'number' ? row.grade_score : null,
    gradedAt:
      typeof row.grade_score === 'number' ? (gradedAt ?? isoOf(row.updated_at)) : null
  }
}

export function watchStatusFromServer(state: ServerWatchState): ScreenWatchStatus {
  return {
    enabled: Boolean(state.enabled),
    active: Boolean(state.enabled && state.app),
    processName: state.app ?? null,
    // The macOS watcher reads via Accessibility and offers no per-claim
    // rectangles, so the overlay never draws underlines from this bridge.
    supportsUnderlines: false,
    claimCount: Array.isArray(state.findings) ? state.findings.length : 0,
    lastError: state.hasAccess === false ? 'Accessibility access is not granted to Tracely.' : null,
    blockedApp: null,
    authRequired: false
  }
}

// ── settings mapping ────────────────────────────────────────────────────────

const ACCENT_HEX: Record<string, string> = {
  orange: '#f97316',
  blue: '#3b82f6',
  green: '#22c55e',
  purple: '#a855f7'
}

export function accentNameOf(hex: string): 'orange' | 'blue' | 'green' | 'purple' {
  const entry = Object.entries(ACCENT_HEX).find(([, h]) => h.toLowerCase() === String(hex ?? '').toLowerCase())
  return (entry?.[0] as 'orange' | 'blue' | 'green' | 'purple' | undefined) ?? 'orange'
}

export function accentHexOf(name: string): string {
  return ACCENT_HEX[name] ?? ACCENT_HEX.orange
}

export function fontSizeNameOf(px: number): 'small' | 'medium' | 'large' {
  if (px <= 12) return 'small'
  if (px >= 16) return 'large'
  return 'medium'
}

export function fontSizePxOf(name: string): number {
  if (name === 'small') return 12
  if (name === 'large') return 16
  return 14
}

export function citationStyleOf(raw: string): CitationStyle {
  const lower = String(raw ?? '').toLowerCase()
  if (lower === 'mla') return 'MLA'
  if (lower === 'chicago') return 'Chicago'
  return 'APA'
}

export function citationStyleToServer(style: CitationStyle): string {
  return style.toLowerCase()
}

// ── citation formatters (ported from src/main/services/citations) ───────────

const ET_AL_THRESHOLD = 3

function initials(given: string | undefined): string {
  if (!given) return ''
  return given
    .trim()
    .split(/\s+/)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(' ')
}

function apaSingle(author: Author): string {
  const init = initials(author.given)
  return init ? `${author.family}, ${init}` : author.family
}

function formatAuthorsAPA(authorsIn: Author[]): string | null {
  const authors = realAuthors(authorsIn)
  if (authors.length === 0) return null
  if (authors.length === 1) return apaSingle(authors[0])
  if (authors.length > ET_AL_THRESHOLD) return `${apaSingle(authors[0])}, et al.`
  const formatted = authors.map(apaSingle)
  const last = formatted.pop()
  return `${formatted.join(', ')}, & ${last}`
}

function mlaFull(author: Author, isFirst: boolean): string {
  if (!author.given) return author.family
  return isFirst ? `${author.family}, ${author.given}` : `${author.given} ${author.family}`
}

function formatAuthorsMLA(authorsIn: Author[]): string | null {
  const authors = realAuthors(authorsIn)
  if (authors.length === 0) return null
  if (authors.length === 1) return mlaFull(authors[0], true)
  if (authors.length === 2) return `${mlaFull(authors[0], true)}, and ${mlaFull(authors[1], false)}`
  return `${mlaFull(authors[0], true)}, et al.`
}

function formatAuthorsChicago(authorsIn: Author[]): string | null {
  const authors = realAuthors(authorsIn)
  if (authors.length === 0) return null
  if (authors.length === 1) return mlaFull(authors[0], true)
  if (authors.length > ET_AL_THRESHOLD) return `${mlaFull(authors[0], true)}, et al.`
  const formatted = authors.map((a, i) => mlaFull(a, i === 0))
  const last = formatted.pop()
  return `${formatted.join(', ')}, and ${last}`
}

function formatAPA(source: Source): string {
  const authors = formatAuthorsAPA(source.authors)
  const year = source.year ?? 'n.d.'
  const title = endTitle(source.title)
  const venue = source.venue ? ` ${containerPrefix(source.venueType)}${source.venue}.` : ''
  const locator = citationLocator(source)
  const url = locator ? ` ${locator}` : ''
  if (authors === null) return `${title} (${year}).${venue}${url}`.trim()
  return `${authors} (${year}). ${title}${venue}${url}`.trim()
}

function formatMLA(source: Source): string {
  const authors = formatAuthorsMLA(source.authors)
  const title = endTitle(source.title)
  const venue = source.venue ? `${source.venue}, ` : ''
  const year = source.year ?? 'n.d.'
  const url = citationLocator(source) ?? ''
  const tail = `${venue}${year}${url ? `, ${url}` : ''}.`
  if (authors === null) return `"${title}" ${tail}`.trim()
  const authorsClause = authors.endsWith('.') ? authors : `${authors}.`
  return `${authorsClause} "${title}" ${tail}`.trim()
}

function formatChicago(source: Source): string {
  const authors = formatAuthorsChicago(source.authors)
  const rawYear = source.year === null || source.year === undefined ? 'n.d.' : String(source.year)
  const year = rawYear.endsWith('.') ? rawYear.slice(0, -1) : rawYear
  const title = endTitle(source.title)
  const venue = source.venue ? ` ${containerPrefix(source.venueType)}${source.venue}.` : ''
  const locator = citationLocator(source)
  const url = locator ? ` ${locator}.` : ''
  if (authors === null) return `"${title}" ${year}.${venue}${url}`.trim()
  const authorsClause = authors.endsWith('.') ? authors : `${authors}.`
  return `${authorsClause} ${year}. "${title}"${venue}${url}`.trim()
}

const FORMATTERS: Record<CitationStyle, (source: Source) => string> = {
  APA: formatAPA,
  MLA: formatMLA,
  Chicago: formatChicago
}

export function formatCitation(source: Source, style: CitationStyle): string {
  return (FORMATTERS[style] ?? formatAPA)(source)
}

export const CITATION_STYLES: readonly CitationStyle[] = ['APA', 'MLA', 'Chicago']

export function citationsForSource(source: Source): Citation[] {
  const now = isoOf(Date.now())
  return CITATION_STYLES.map((style) => ({
    id: `${source.id}-${style}`,
    sourceId: source.id,
    style,
    formattedText: formatCitation(source, style),
    createdAt: now
  }))
}

// ── structure/grade mapping ─────────────────────────────────────────────────

const THEIR_ROLES: ReadonlySet<string> = new Set([
  'thesis',
  'claim',
  'evidence',
  'reasoning',
  'significance',
  'counterargument',
  'conclusion',
  'transition'
])

/** Our classifier's 'other' (and anything unrecognised) is their 'unknown'. */
export function paragraphRoleOf(raw: string): ParagraphRole {
  return (THEIR_ROLES.has(raw) ? raw : 'unknown') as ParagraphRole
}

export function componentsFromGrade(grade: ServerGradeResponse): StructureComponents {
  const c = grade.components
  return {
    thesis: c.thesis.score,
    governingClaims: c.governingClaims.score,
    warrant: c.warrant.score,
    counterargument: c.counterargument.score,
    significance: c.significance.score,
    conclusion: c.conclusion.score
  }
}

const COMPONENT_META: readonly {
  key: keyof ServerGradeResponse['components']
  label: string
  max: number
}[] = [
  { key: 'thesis', label: 'Thesis', max: 20 },
  { key: 'governingClaims', label: 'Governing claims', max: 20 },
  { key: 'warrant', label: 'Warrant', max: 20 },
  { key: 'counterargument', label: 'Counterargument', max: 15 },
  { key: 'significance', label: 'Significance', max: 15 },
  { key: 'conclusion', label: 'Conclusion', max: 10 }
]

/**
 * Grade notes become 'model-finding' weaknesses — one kind, named by `label`,
 * exactly how their graded read reports (see StructureWeaknessKind docs).
 * A component at or above 75% of its points is not a weakness; an absent
 * counterargument is skipped entirely (their rubric: do not require one).
 */
export function weaknessesFromGrade(grade: ServerGradeResponse): StructureWeakness[] {
  const out: StructureWeakness[] = []
  // The grader's findings first: each one quotes a sentence the server has
  // already located in the draft (verifyGrade), so they are the ones a writer
  // can act on.
  for (const f of grade.findings ?? []) {
    out.push({
      kind: 'model-finding',
      paragraphIndex: f.paragraphIndex,
      claimId: null,
      message: f.fix ? `${f.message} ${f.fix}` : f.message,
      tracerPrompt: `How do I fix this: ${f.label.toLowerCase()}?`,
      quote: f.quote || undefined,
      severity: f.severity,
      label: f.label
    })
  }
  for (const meta of COMPONENT_META) {
    const comp = grade.components[meta.key]
    if (!comp || !comp.reason) continue
    if (meta.key === 'counterargument' && grade.counterargumentApplicable === false) continue
    if (comp.score >= meta.max * 0.75) continue
    out.push({
      kind: 'model-finding',
      paragraphIndex: null,
      claimId: null,
      message: comp.reason,
      tracerPrompt: `How do I strengthen the ${meta.label.toLowerCase()} in my draft?`,
      quote: comp.quote || undefined,
      severity: comp.score < meta.max / 2 ? 'major' : 'minor',
      label: meta.label
    })
  }
  return out
}

/** The grader's reasoningFailure values, named as the desktop's weakness kinds. */
const FAULT_KINDS: Record<string, StructureWeakness['kind']> = {
  circular: 'circular-reasoning',
  'sequence-as-cause': 'sequence-as-cause',
  'single-case': 'single-case-generalisation',
  leap: 'logical-leap'
}

export function weaknessesFromFaults(paragraphs: ServerGradeResponse['paragraphs']): StructureWeakness[] {
  const out: StructureWeakness[] = []
  for (const p of paragraphs) {
    const kind = FAULT_KINDS[p.reasoningFailure]
    if (!kind) continue // 'none', or a value the grader does not use
    const human = p.reasoningFailure.replace(/-/g, ' ')
    out.push({
      kind,
      // Already 1-based: the grader reads the paragraphs as [1] [2] …
      paragraphIndex: p.index,
      claimId: null,
      message: `This paragraph's reasoning shows a ${human}.`,
      tracerPrompt: `My draft was flagged for ${human} — how do I fix that paragraph?`,
      severity: 'minor'
    })
  }
  return out
}
