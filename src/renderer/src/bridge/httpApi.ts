/**
 * The REAL bridge: an HTTP implementation of the full TracelyApi, backed by
 * our local Node server (tracely/server.js on 127.0.0.1:4477) instead of the
 * Electron main process.
 *
 * Shaped exactly like src/renderer/src/preview/mockApi.ts — typed as
 * `Window['tracely']` so `npm run typecheck` fails the moment the preload
 * contract moves — but every answer comes from real endpoints. All URLs are
 * RELATIVE ('/api/…'): the UI is served from the same origin as the server,
 * which is also what lets us through its same-origin gate on any port.
 *
 * What the server has no table for lives bridge-side:
 *  - detected claims/analyses (in memory, mirrored to localStorage) — their
 *    contract addresses evidence/critique by claimId alone, so the bridge must
 *    remember what each id means;
 *  - structure outlines, tracer transcripts, profile extras, and the settings
 *    fields our prefs store does not know (round-tripped via localStorage so
 *    nothing breaks).
 */
import type {
  Analysis,
  AppSettings,
  AuthUser,
  Claim,
  DocumentOutline,
  EvidenceCoverage,
  EvidenceItem,
  Source,
  TracerConversation,
  TracerMessage
} from '@shared/types'
import type {
  CitationResolveCitedResponse,
  ProfileInfo,
  ResolvedCitedWork,
  ScreenWatchSourceCandidate,
  ScreenWatchStatus,
  SettingsSetRequest
} from '@shared/ipc-contract'
import { RETRIEVAL_GENERATION } from '@shared/retrievalGeneration'
import { hasInlineCitation } from '@shared/inlineCitation'
import { parseReferences } from '@shared/citedReference'
import { formatInTextCitation } from '@shared/citationInText'
import { bibliographyReferences } from '@shared/bibliography'
import { splitParagraphs, bucketClaimsByParagraph } from '@shared/paragraphSplit'
import { argumentParagraphs } from '@shared/structureText'
import { buildGradePrompt } from '@shared/gradedDraft'
import { computeClaimSpans } from '@shared/claimSpans'
import type { ModelTier, Plan } from '@shared/plan'
import { credibilityOf } from '@shared/sourceCredibility'
import { gradeFor } from '@shared/gradeLevel'
import {
  accentHexOf,
  accentNameOf,
  breakdownFromStrength,
  citationStyleOf,
  citationStyleToServer,
  citationsForSource,
  claimTypeOf,
  componentsFromGrade,
  critiqueVerdictOf,
  documentListItemFromRow,
  documentRecordFromRow,
  evidenceItemsFromServer,
  fontSizeNameOf,
  fontSizePxOf,
  formatCitation,
  hashText,
  isoOf,
  paragraphRoleOf,
  sourceFromServer,
  sourceToServer,
  sanitizeDocHtml,
  watchStatusFromServer,
  weaknessesFromFaults,
  weaknessesFromGrade,
  ZERO_BREAKDOWN
} from './adapters'
import type {
  ServerCompareResponse,
  ServerCritiqueResponse,
  ServerDetectedClaim,
  ServerDocRow,
  ServerEvidenceResponse,
  ServerGradeResponse,
  ServerLibraryRow,
  ServerPrefs,
  ServerWatchState
} from './adapters'

type TracelyApi = Window['tracely']

const APP_VERSION = '0.3.96-web'
const OK = { ok: true as const }

// ── HTTP plumbing ───────────────────────────────────────────────────────────

interface ServerError {
  error?: { kind?: string; message?: string }
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = (data as ServerError | null)?.error?.message ?? `Request failed (${res.status})`
    throw new Error(message)
  }
  return data as T
}

const get = <T>(path: string): Promise<T> => request<T>(path, 'GET')
const post = <T>(path: string, body: unknown): Promise<T> => request<T>(path, 'POST', body)
const put = <T>(path: string, body: unknown): Promise<T> => request<T>(path, 'PUT', body)
const del = <T>(path: string): Promise<T> => request<T>(path, 'DELETE')

// ── localStorage plumbing ───────────────────────────────────────────────────

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as T) }
  } catch {
    return fallback
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota or private mode — bridge state degrades to in-memory only.
  }
}

interface SettingsExtras {
  hotkeyAccelerator: string
  enableStrengthSummaries: boolean
  claimSensitivity: number
  screenWatchHotkeyAccelerator: string
  suppressSaveConfirm: boolean
  username: string
  modelTier: ModelTier
}

interface ProfileExtras {
  bio: string
  avatarUrl: string | null
}

interface TracerStore {
  conversation: TracerConversation | null
  messages: TracerMessage[]
  /** bridge conversation id → server conversation id (the server mints its own). */
  serverIds: Record<string, string>
}

const KEYS = {
  extras: 'tracely.web.settingsExtras',
  profile: 'tracely.web.profileExtras',
  tracer: 'tracely.web.tracer',
  outlines: 'tracely.web.outlines',
  gradedAt: 'tracely.web.gradedAt',
  analyses: 'tracely.web.analyses'
}

const DEFAULT_EXTRAS: SettingsExtras = {
  hotkeyAccelerator: 'CommandOrControl+Shift+T',
  enableStrengthSummaries: true,
  claimSensitivity: 0.5,
  screenWatchHotkeyAccelerator: '',
  suppressSaveConfirm: false,
  username: 'local',
  // Matches settingsRepo's default. It is a request either way — the relay
  // clamps it to the plan, and this build has no paid plan behind it.
  modelTier: 'thorough'
}

// ── bridge state ────────────────────────────────────────────────────────────

interface ClaimRecord {
  claim: Claim
  sentence: string
  start: number
  end: number
  evidence: EvidenceItem[] | null
  outsideIndex: boolean
}

interface AnalysisRecord {
  analysis: Analysis
  claimIds: string[]
}

interface PersistedAnalyses {
  analyses: { analysis: Analysis; records: { claim: Claim; sentence: string; start: number; end: number }[] }[]
}

export function createHttpApi(): TracelyApi {
  const claimsById = new Map<string, ClaimRecord>()
  const analysesById = new Map<string, AnalysisRecord>()
  const sourcesById = new Map<string, Source>()
  let maximized = false

  // Restore the last few analyses so a reloaded page can still resolve the
  // claim ids inside a stored outline.
  {
    const stored = loadJson<PersistedAnalyses>(KEYS.analyses, { analyses: [] })
    for (const a of stored.analyses) {
      analysesById.set(a.analysis.id, { analysis: a.analysis, claimIds: a.records.map((r) => r.claim.id) })
      for (const r of a.records) {
        claimsById.set(r.claim.id, {
          claim: r.claim,
          sentence: r.sentence,
          start: r.start,
          end: r.end,
          evidence: null,
          outsideIndex: false
        })
      }
    }
  }

  function persistAnalyses(): void {
    const all = [...analysesById.values()].slice(-5)
    saveJson(KEYS.analyses, {
      analyses: all.map((a) => ({
        analysis: a.analysis,
        records: a.claimIds
          .map((id) => claimsById.get(id))
          .filter((r): r is ClaimRecord => Boolean(r))
          .map((r) => ({ claim: r.claim, sentence: r.sentence, start: r.start, end: r.end }))
      }))
    } satisfies PersistedAnalyses)
  }

  function registerSource(source: Source): void {
    sourcesById.set(source.id, source)
  }

  function mustClaim(claimId: string): ClaimRecord {
    const rec = claimsById.get(claimId)
    if (!rec) throw new Error('Unknown claim — re-run the analysis and try again.')
    return rec
  }

  async function resolveSource(sourceId: string): Promise<Source> {
    const known = sourcesById.get(sourceId)
    if (known) return known
    // Not seen this session — it may be a library row's source.
    const rows = await get<{ items: ServerLibraryRow[] }>('/api/library')
    for (const row of rows.items) {
      const source = sourceFromServer(row.source, `src-${row.id}`)
      registerSource(source)
    }
    const found = sourcesById.get(sourceId)
    if (!found) throw new Error('Unknown source — it may have been removed.')
    return found
  }

  /** The writer's own citation for a claim, when the sentence carries one. */
  function citedRefFor(rec: ClaimRecord): { raw: string; surnames: string[]; year: number | null; title: string | null } | null {
    const refs = parseReferences(rec.sentence)
    if (refs.length > 0) {
      const r = refs[0]
      return { raw: r.entry ?? r.raw, surnames: r.surnames, year: r.year, title: r.title }
    }
    const doc = analysesById.get(rec.claim.analysisId)?.analysis.sourceText ?? ''
    if (doc) {
      const resolved = bibliographyReferences(rec.sentence, doc)
      if (resolved.length > 0) {
        const r = resolved[0]
        return { raw: r.entry ?? r.raw, surnames: r.surnames, year: r.year, title: r.title }
      }
    }
    return null
  }

  function coverageForAnalysis(analysisId: string | null): EvidenceCoverage {
    const ids = analysisId ? (analysesById.get(analysisId)?.claimIds ?? []) : []
    const recs = ids.map((id) => claimsById.get(id)).filter((r): r is ClaimRecord => Boolean(r))
    const resolved = recs.filter((r) => r.claim.strengthScore !== null)
    return {
      detected: recs.length,
      withRelevantSource: recs.filter((r) => (r.claim.scoreBreakdown?.sourceCount ?? 0) > 0).length,
      withOwnCitation: recs.filter((r) => hasInlineCitation(r.sentence || r.claim.text)).length,
      meanStrength: resolved.length
        ? Math.round(resolved.reduce((sum, r) => sum + (r.claim.strengthScore ?? 0), 0) / resolved.length)
        : null,
      unchecked: recs.length - resolved.length,
      outsideIndexes: recs.filter((r) => r.outsideIndex).length
    }
  }

  function outlineStore(): Record<string, DocumentOutline> {
    return loadJson<Record<string, DocumentOutline>>(KEYS.outlines, {})
  }

  function gradedAtStore(): Record<string, string> {
    return loadJson<Record<string, string>>(KEYS.gradedAt, {})
  }

  async function prefs(): Promise<ServerPrefs> {
    return get<ServerPrefs>('/api/prefs')
  }

  // The single local identity this build has. There is no sign-in and nothing
  // to sign out of, so unlike the Electron build's anonymous Supabase session
  // this one is not even an account — it exists because the contract's
  // `getUser` has to answer something, and "a session exists" is the only
  // thing anything still reads from it.
  function currentUser(): AuthUser {
    return { id: 'local-user', email: null, firstName: null, username: null }
  }

  function settingsFromServer(p: ServerPrefs): AppSettings {
    const extras = loadJson<SettingsExtras>(KEYS.extras, DEFAULT_EXTRAS)
    return {
      defaultCitationStyle: citationStyleOf(p.citationStyle),
      hotkeyAccelerator: extras.hotkeyAccelerator,
      enableStrengthSummaries: extras.enableStrengthSummaries,
      theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system',
      accentColor: accentNameOf(p.accent),
      density: p.density === 'compact' ? 'compact' : 'comfortable',
      fontSize: fontSizeNameOf(p.fontSize),
      claimSensitivity: extras.claimSensitivity,
      screenWatchHotkeyAccelerator: extras.screenWatchHotkeyAccelerator,
      screenWatchAllowedApps: (p.watchApps ?? []).join(','),
      suppressSaveConfirm: extras.suppressSaveConfirm,
      modelTier: extras.modelTier,
      gradingLevel: p.gradingLevel ?? 12,
      autoCritiqueCited: p.autoCritique !== false
    }
  }

  async function tracerContextText(): Promise<string> {
    try {
      const rows = await get<{ documents: ServerDocRow[] }>('/api/documents?sort=opened')
      const first = rows.documents[0]
      if (!first) return ''
      const doc = await get<ServerDocRow>(`/api/documents/${first.id}`)
      const div = document.createElement('div')
      div.innerHTML = doc.body_html ?? ''
      return div.innerText
    } catch {
      return ''
    }
  }

  function tracerStore(): TracerStore {
    return loadJson<TracerStore>(KEYS.tracer, { conversation: null, messages: [], serverIds: {} })
  }

  function mapCompareToResolved(
    ref: { raw: string; surnames: string[]; year: number | null; title: string | null },
    compared: ServerCompareResponse
  ): ResolvedCitedWork {
    const top = compared.matches[0] ?? null
    return {
      raw: ref.raw,
      surnames: ref.surnames,
      year: ref.year,
      citedTitle: ref.title,
      found: compared.resolved,
      title: top?.title ?? null,
      matchedYear: top?.year ?? null,
      doi: top?.doi ?? null,
      url: top?.url ?? null,
      index: top ? (top.provider === 'openlibrary' ? 'openlibrary' : 'crossref') : null
    }
  }

  return {
    analyze: {
      detectClaims: async (req) => {
        // `draft`: a raw document for the server to split. The desktop's main
        // process sends numbered sentences in `text` instead; this bridge has
        // no sentence splitter of its own, and each claim comes back carrying
        // its sentence and offsets.
        const result = await post<{ claims: ServerDetectedClaim[] }>('/api/detect-claims', {
          draft: req.text
        })
        const analysisId = crypto.randomUUID()
        const now = isoOf(Date.now())
        const analysis: Analysis = { id: analysisId, sourceText: req.text, origin: req.origin, createdAt: now }
        const claims: Claim[] = []
        for (const c of result.claims ?? []) {
          const claim: Claim = {
            id: c.id,
            analysisId,
            text: c.text,
            claimType: claimTypeOf(c.claimType),
            confidence: c.confidence,
            searchQuery: c.query,
            strengthScore: null,
            scoreBreakdown: null,
            critique: null,
            critiqueVerdict: null,
            suggestedRevision: null,
            citationFix: null,
            citedWorkRead: null,
            retrievalGeneration: null,
            createdAt: now
          }
          claims.push(claim)
          claimsById.set(claim.id, {
            claim,
            sentence: c.sentence || c.text,
            start: c.start,
            end: c.end,
            evidence: null,
            outsideIndex: false
          })
        }
        analysesById.set(analysisId, { analysis, claimIds: claims.map((c) => c.id) })
        persistAnalyses()
        return { analysisId, claims }
      },
      getResult: async (req) => {
        const rec = analysesById.get(req.analysisId)
        if (!rec) throw new Error('Unknown analysis — run the analysis again.')
        const claims = rec.claimIds
          .map((id) => claimsById.get(id)?.claim)
          .filter((c): c is Claim => Boolean(c))
        return { analysis: rec.analysis, claims }
      }
    },
    evidence: {
      find: async (req) => {
        const rec = mustClaim(req.claimId)
        const result = await post<ServerEvidenceResponse>('/api/evidence', {
          claim: rec.claim.text,
          query: rec.claim.searchQuery || undefined,
          claimType: rec.claim.claimType
        })
        const evidence = evidenceItemsFromServer(result.sources ?? [], registerSource)
        const strengthScore = result.strength?.score ?? 0
        const scoreBreakdown = result.strength ? breakdownFromStrength(result.strength) : { ...ZERO_BREAKDOWN }
        rec.evidence = evidence
        rec.outsideIndex = Boolean(result.searched?.outsideIndex)
        rec.claim = {
          ...rec.claim,
          strengthScore,
          scoreBreakdown,
          retrievalGeneration: RETRIEVAL_GENERATION
        }
        claimsById.set(rec.claim.id, rec)
        persistAnalyses()
        return { evidence, strengthScore, scoreBreakdown }
      },
      getForClaim: async (req) => {
        const rec = claimsById.get(req.claimId)
        return { evidence: rec?.evidence ?? [] }
      },
      // Home's source finder: the same retrieval as evidence.find, but for a
      // sentence the user typed rather than a stored claim, so nothing is
      // persisted and the citation is precomputed per row.
      forText: async (req) => {
        const text = req.text.trim()
        if (!text) return { candidates: [], citations: {}, note: null }
        const result = await post<ServerEvidenceResponse>('/api/evidence', { claim: text })
        const rows = result.sources ?? []
        const candidates: ScreenWatchSourceCandidate[] = []
        const citations: Record<string, string> = {}
        rows.forEach((row, i) => {
          const source = sourceFromServer(row, `txt-${hashText(text)}-${i}`)
          registerSource(source)
          candidates.push({
            sourceRef: source.id,
            title: source.title,
            venue: source.venue ?? null,
            year: source.year ?? null,
            provider: source.provider,
            url: source.url ?? null,
            // The server ranks best-first and does not score a row against the
            // text, so position is the only honest signal of fit we have.
            matchPercent: Math.max(1, Math.round(((rows.length - i) / rows.length) * 100)),
            faviconDataUrl: null,
            credibility: credibilityOf(source)
          })
          citations[source.id] = formatCitation(source, req.style)
        })
        return {
          candidates,
          citations,
          note: candidates.length ? null : 'No sources came back for that text.'
        }
      },
      // Off-topic detection runs on local MiniLM embeddings in the desktop
      // build; a browser tab has no model to ask. Null is the contract's
      // "could not be measured", which reads differently from "nothing was
      // off topic" — the caller must not draw a finding from silence.
      offTopic: async () => ({ offTopicClaimIds: null })
    },
    sources: {
      // Google's public favicon service, keyed by the URL exactly as asked —
      // the one deliberate third-party dependency, same trade the Electron
      // app's favicon service makes (it reveals source domains to the service).
      favicons: async (req) => {
        const icons: Record<string, string | null> = {}
        for (const url of req.urls) {
          try {
            const host = new URL(url).hostname
            icons[url] = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`
          } catch {
            icons[url] = null
          }
        }
        return { icons }
      }
    },
    citation: {
      generate: async (req) => {
        const source = await resolveSource(req.sourceId)
        return { citation: formatCitation(source, req.style) }
      },
      list: async (req) => {
        const source = await resolveSource(req.sourceId)
        return { citations: citationsForSource(source) }
      },
      resolveCited: async (req): Promise<CitationResolveCitedResponse> => {
        const rec = mustClaim(req.claimId)
        const ref = citedRefFor(rec)
        if (!ref) return { cited: null }
        const compared = await post<ServerCompareResponse>('/api/compare-source', { citedRef: ref.raw })
        return { cited: mapCompareToResolved(ref, compared) }
      }
    },
    critique: {
      generate: async (req) => {
        const rec = mustClaim(req.claimId)
        const ref = citedRefFor(rec)
        const result = await post<ServerCritiqueResponse>('/api/critique', {
          claim: rec.claim.text,
          sentence: rec.sentence,
          citedRef: ref?.raw ?? undefined,
          sources: (rec.evidence ?? []).slice(0, 4).map((e) => ({
            title: e.source.title,
            venue: e.source.venue ?? '',
            year: e.source.year,
            url: e.source.url ?? '',
            abstract: e.source.abstract ?? ''
          }))
        })
        const verdict = critiqueVerdictOf(result)
        const correction = verdict === 'contradicted' ? result.suggestedRevision : null
        rec.claim = {
          ...rec.claim,
          critique: result.critique,
          critiqueVerdict: verdict,
          suggestedRevision: verdict === 'overstated' ? result.suggestedRevision : null,
          citationFix: result.citationFix,
          // True only when the writer's own reference was in front of the
          // judge (we pass it verbatim); null — "not read" — otherwise, which
          // problemKind.ts treats as "stay quiet about the citation".
          citedWorkRead: ref ? true : null
        }
        claimsById.set(rec.claim.id, rec)
        persistAnalyses()
        return { critique: result.critique, verdict, correction }
      }
    },
    library: {
      save: async (req) => {
        const source = await resolveSource(req.sourceId)
        const saved = await post<{ id: string; duplicate: boolean }>('/api/library', {
          source: sourceToServer(source),
          note: req.notes ?? ''
        })
        return {
          item: {
            id: saved.id,
            sourceId: source.id,
            claimId: req.claimId ?? null,
            notes: req.notes ?? null,
            tags: req.tags ?? [],
            savedAt: isoOf(Date.now()),
            source
          }
        }
      },
      list: async (req) => {
        const q = req.search ? `?q=${encodeURIComponent(req.search)}` : ''
        const rows = await get<{ items: ServerLibraryRow[] }>(`/api/library${q}`)
        const items = rows.items.map((row) => {
          const source = sourceFromServer(row.source, `src-${row.id}`)
          registerSource(source)
          return {
            id: row.id,
            sourceId: source.id,
            claimId: null,
            notes: row.note ?? null,
            // Our library rows have no tags — every item round-trips as [].
            tags: [] as string[],
            savedAt: isoOf(row.createdAt),
            source
          }
        })
        return { items: req.tag ? [] : items }
      },
      get: async (req) => {
        const rows = await get<{ items: ServerLibraryRow[] }>('/api/library')
        const row = rows.items.find((r) => r.id === req.id)
        if (!row) throw new Error('Library item not found.')
        const source = sourceFromServer(row.source, `src-${row.id}`)
        registerSource(source)
        return {
          item: {
            id: row.id,
            sourceId: source.id,
            claimId: null,
            notes: row.note ?? null,
            tags: [] as string[],
            savedAt: isoOf(row.createdAt),
            source
          },
          citations: citationsForSource(source)
        }
      },
      update: async (req) => {
        if (typeof req.notes === 'string') {
          await put<{ ok: true }>(`/api/library/${req.id}`, { note: req.notes })
        }
        const rows = await get<{ items: ServerLibraryRow[] }>('/api/library')
        const row = rows.items.find((r) => r.id === req.id)
        if (!row) throw new Error('Library item not found.')
        const source = sourceFromServer(row.source, `src-${row.id}`)
        registerSource(source)
        return {
          item: {
            id: row.id,
            sourceId: source.id,
            claimId: null,
            notes: row.note ?? null,
            tags: req.tags ?? [],
            savedAt: isoOf(row.createdAt),
            source
          }
        }
      },
      remove: async (req) => {
        await del<{ ok: true }>(`/api/library/${req.id}`)
        return OK
      }
    },
    documents: {
      list: async () => {
        const rows = await get<{ documents: ServerDocRow[] }>('/api/documents')
        const gradedAt = gradedAtStore()
        // bodyHtml is '' on list items: the list endpoint returns no body and
        // the Documents/Home views render title + grade only.
        return { documents: rows.documents.map((row) => documentListItemFromRow(row, gradedAt[row.id] ?? null)) }
      },
      get: async (req) => {
        try {
          const row = await get<ServerDocRow>(`/api/documents/${req.id}`)
          return { document: documentRecordFromRow(row) }
        } catch {
          return { document: null }
        }
      },
      latest: async () => {
        const rows = await get<{ documents: ServerDocRow[] }>('/api/documents?sort=opened')
        const first = rows.documents[0]
        if (!first) return { document: null }
        const row = await get<ServerDocRow>(`/api/documents/${first.id}`)
        return { document: documentRecordFromRow(row) }
      },
      save: async (req) => {
        const clean = sanitizeDocHtml(req.bodyHtml)
        const row = req.id
          ? await put<ServerDocRow>(`/api/documents/${req.id}`, { title: req.title, bodyHtml: clean })
          : await post<ServerDocRow>('/api/documents', { title: req.title, bodyHtml: clean })
        return { document: documentRecordFromRow(row) }
      },
      remove: async (req) => {
        await del<{ ok: true }>(`/api/documents/${req.id}`)
        return OK
      }
    },
    structure: {
      analyze: async (req) => {
        const spans = splitParagraphs(req.text)
        const titleParagraph =
          spans.length >= 2 && spans[0].text.length <= 120 && !/[.!?]$/.test(spans[0].text.trim())

        // ONE call, built exactly as the desktop's main process builds it
        // (ipc/structureHandlers.ts): the argument's paragraphs, works cited
        // removed, numbered by buildGradePrompt. The grader returns each
        // paragraph's role, warrant and reasoning fault alongside the scores,
        // so the separate /api/structure call this used to make is gone.
        // 40 / 16000 are MAX_GRADE_PARAGRAPHS / MAX_GRADE_INPUT_CHARS in
        // services/ai/costGuard.ts, which the renderer cannot import.
        const gradePrompt = buildGradePrompt(
          argumentParagraphs(req.text).map((para) => para.text),
          { maxParagraphs: 40, maxInputChars: 16000 }
        )
        // The level applies client-side (gradeFor below), exactly as on the
        // desktop; the grader itself scores against the rubric alone.
        const [p, grade] = await Promise.all([prefs(), post<ServerGradeResponse>('/api/grade', { text: gradePrompt })])

        const graded = new Map(grade.paragraphs.map((para) => [para.index, para]))

        // Bucket this analysis's claims into paragraphs by locating their text
        // in the CURRENT editor string — same move their main process makes.
        const analysisId = req.analysisId ?? null
        const claimList = analysisId
          ? (analysesById.get(analysisId)?.claimIds ?? [])
              .map((id) => claimsById.get(id)?.claim)
              .filter((c): c is Claim => Boolean(c))
          : []
        const located = computeClaimSpans(req.text, claimList).map((s) => ({
          claimId: s.claim.id,
          start: s.start
        }))
        const buckets = bucketClaimsByParagraph(spans, located)

        const components = componentsFromGrade(grade)
        const score = Math.max(
          0,
          Math.min(
            100,
            components.thesis +
              components.governingClaims +
              components.warrant +
              components.counterargument +
              components.significance +
              components.conclusion
          )
        )

        // Works cited is a suffix, so argument paragraph n is document
        // paragraph n; anything the grader did not read is 'unknown'.
        const paragraphs = spans.map((span) => {
          const g = graded.get(span.index)
          return {
            index: span.index,
            role: paragraphRoleOf(g?.role ?? 'unknown'),
            hasWarrant: g?.hasWarrant === true,
            statesClaim: g?.statesClaim === true,
            claimIds: buckets.get(span.index) ?? []
          }
        })

        const outline: DocumentOutline = {
          documentId: req.documentId ?? null,
          analysisId,
          sourceHash: hashText(req.text),
          schemaVersion: 9,
          paragraphs,
          score,
          components,
          complete: paragraphs.every((para) => para.role !== 'unknown'),
          applicable: true,
          rolesFrom: 'model',
          coverage: coverageForAnalysis(analysisId),
          weaknesses: [...weaknessesFromGrade(grade), ...weaknessesFromFaults(grade.paragraphs)],
          cohesion: null,
          titleParagraph,
          analyzedAt: isoOf(Date.now())
        }

        if (req.documentId) {
          const outlines = outlineStore()
          outlines[req.documentId] = outline
          saveJson(KEYS.outlines, outlines)
          const graded = gradedAtStore()
          graded[req.documentId] = outline.analyzedAt
          saveJson(KEYS.gradedAt, graded)
          // Write the grade back so the Documents page's chips are real rows.
          await put<ServerDocRow>(`/api/documents/${req.documentId}`, {
            gradeScore: score,
            gradeLetter: gradeFor(score, p.gradingLevel ?? 12).letter
          }).catch(() => undefined)
        }
        return { outline }
      },
      get: async (req) => {
        const outline = outlineStore()[req.documentId] ?? null
        if (!outline) return { outline: null, stale: false }
        return { outline, stale: outline.sourceHash !== hashText(req.text) }
      }
    },
    tracer: {
      getConversation: async (req) => {
        let store = tracerStore()
        if (!store.conversation || (req.conversationId && store.conversation.id !== req.conversationId)) {
          const now = isoOf(Date.now())
          store = {
            conversation: { id: crypto.randomUUID(), title: 'New conversation', createdAt: now, updatedAt: now },
            messages: [],
            serverIds: store.serverIds
          }
          saveJson(KEYS.tracer, store)
        }
        const [documentText, status] = await Promise.all([
          tracerContextText(),
          get<{ hasKey: boolean }>('/api/status').catch(() => ({ hasKey: false }))
        ])
        return {
          conversation: store.conversation as TracerConversation,
          messages: store.messages,
          context: { processName: null, documentText, claims: [] },
          serverConfigured: Boolean(status.hasKey),
          focusedClaimId: null,
          focusedPrompt: null
        }
      },
      send: async (req) => {
        const store = tracerStore()
        const draft = await tracerContextText()
        const serverConvId = store.serverIds[req.conversationId]
        const result = await post<{ conversationId: string; reply: string }>('/api/tracer', {
          conversationId: serverConvId ?? undefined,
          message: req.message,
          draft
        })
        const now = isoOf(Date.now())
        const userMessage: TracerMessage = {
          id: crypto.randomUUID(),
          conversationId: req.conversationId,
          role: 'user',
          content: req.message,
          createdAt: now
        }
        const reply: TracerMessage = {
          id: crypto.randomUUID(),
          conversationId: req.conversationId,
          role: 'tracer',
          content: result.reply,
          createdAt: now
        }
        const conversation: TracerConversation = store.conversation ?? {
          id: req.conversationId,
          title: req.message.slice(0, 60),
          createdAt: now,
          updatedAt: now
        }
        saveJson(KEYS.tracer, {
          conversation: {
            ...conversation,
            title: store.messages.length === 0 ? req.message.slice(0, 60) : conversation.title,
            updatedAt: now
          },
          messages: [...store.messages, userMessage, reply],
          serverIds: { ...store.serverIds, [req.conversationId]: result.conversationId }
        } satisfies TracerStore)
        return { userMessage, reply }
      },
      newConversation: async () => {
        const store = tracerStore()
        const now = isoOf(Date.now())
        const conversation: TracerConversation = {
          id: crypto.randomUUID(),
          title: 'New conversation',
          createdAt: now,
          updatedAt: now
        }
        saveJson(KEYS.tracer, { conversation, messages: [], serverIds: store.serverIds } satisfies TracerStore)
        return { conversation }
      }
    },
    settings: {
      get: async () => settingsFromServer(await prefs()),
      set: async (req: SettingsSetRequest) => {
        const serverPatch: Record<string, unknown> = {}
        if (req.defaultCitationStyle) serverPatch.citationStyle = citationStyleToServer(req.defaultCitationStyle)
        if (req.theme) serverPatch.theme = req.theme
        if (req.accentColor) serverPatch.accent = accentHexOf(req.accentColor)
        if (req.density) serverPatch.density = req.density
        if (req.fontSize) serverPatch.fontSize = fontSizePxOf(req.fontSize)
        if (typeof req.gradingLevel === 'number') serverPatch.gradingLevel = req.gradingLevel
        if (typeof req.autoCritiqueCited === 'boolean') serverPatch.autoCritique = req.autoCritiqueCited
        if (typeof req.screenWatchAllowedApps === 'string') {
          serverPatch.watchApps = req.screenWatchAllowedApps.split(',').map((s) => s.trim()).filter(Boolean)
        }
        const extras = loadJson<SettingsExtras>(KEYS.extras, DEFAULT_EXTRAS)
        if (typeof req.hotkeyAccelerator === 'string') extras.hotkeyAccelerator = req.hotkeyAccelerator
        if (typeof req.enableStrengthSummaries === 'boolean') extras.enableStrengthSummaries = req.enableStrengthSummaries
        if (typeof req.claimSensitivity === 'number') extras.claimSensitivity = req.claimSensitivity
        if (typeof req.screenWatchHotkeyAccelerator === 'string') {
          extras.screenWatchHotkeyAccelerator = req.screenWatchHotkeyAccelerator
        }
        if (typeof req.suppressSaveConfirm === 'boolean') extras.suppressSaveConfirm = req.suppressSaveConfirm
        if (req.modelTier) extras.modelTier = req.modelTier
        saveJson(KEYS.extras, extras)
        const updated = Object.keys(serverPatch).length
          ? await put<ServerPrefs>('/api/prefs', serverPatch)
          : await prefs()
        return settingsFromServer(updated)
      },
      // The Windows installed-programs registry scan has no macOS/browser
      // equivalent; empty means "couldn't tell", which the contract allows.
      scanInstalledApps: async () => ({ found: [] })
    },
    profile: {
      get: async () => {
        const p = await prefs()
        const extras = loadJson<ProfileExtras>(KEYS.profile, { bio: '', avatarUrl: null })
        return {
          firstName: p.firstName ?? '',
          lastName: p.lastName ?? '',
          bio: extras.bio,
          avatarUrl: extras.avatarUrl
        } satisfies ProfileInfo
      },
      set: async (req) => {
        const serverPatch: Record<string, unknown> = {}
        if (typeof req.firstName === 'string') serverPatch.firstName = req.firstName
        if (typeof req.lastName === 'string') serverPatch.lastName = req.lastName
        const extras = loadJson<ProfileExtras>(KEYS.profile, { bio: '', avatarUrl: null })
        if (typeof req.bio === 'string') extras.bio = req.bio
        if (req.avatarDataUrl !== undefined) {
          // Stored as the data URL itself — <img> renders it the same way a
          // file:// URL would in the Electron build.
          extras.avatarUrl = req.avatarDataUrl
        }
        saveJson(KEYS.profile, extras)
        const p = Object.keys(serverPatch).length ? await put<ServerPrefs>('/api/prefs', serverPatch) : await prefs()
        return {
          firstName: p.firstName ?? '',
          lastName: p.lastName ?? '',
          bio: extras.bio,
          avatarUrl: extras.avatarUrl
        } satisfies ProfileInfo
      }
    },
    auth: {
      // Local single-user stub — there is no Supabase behind this build.
      // `configured: true` keeps the app on its normal signed-in path.
      getUser: async () => ({ user: currentUser(), configured: true }),
      // No Supabase account behind this build, so there is no subscription to
      // read. `free` is the contract's answer for anything unreadable, and it
      // is the honest one here: the local stub has not paid for anything.
      getPlan: async () => ({ plan: 'free' as Plan }),
    },
    history: {
      clear: async (req) => {
        await post<{ ok: true }>('/api/clear-history', { alsoLibrary: req.includeLibrary })
        claimsById.clear()
        analysesById.clear()
        window.localStorage.removeItem(KEYS.analyses)
        window.localStorage.removeItem(KEYS.outlines)
        window.localStorage.removeItem(KEYS.gradedAt)
        window.localStorage.removeItem(KEYS.tracer)
        return OK
      }
    },
    clipboard: {
      write: async (req) => {
        try {
          await navigator.clipboard.writeText(req.text)
        } catch {
          // Clipboard permission denied — the button still resolves; the
          // Electron build cannot fail here and the UI has no error path.
        }
        return OK
      }
    },
    window: {
      // No BrowserWindow behind a browser tab; sizing calls resolve inert.
      hide: async () => OK,
      show: async () => OK,
      resizeStart: async () => OK,
      resizeMove: async () => OK,
      minimize: async () => OK,
      toggleMaximize: async () => {
        maximized = !maximized
        return { maximized }
      },
      isMaximized: async () => ({ maximized })
    },
    shell: {
      openExternal: async (req) => {
        window.open(req.url, '_blank', 'noopener,noreferrer')
        return OK
      }
    },
    app: {
      getBuildInfo: async () => ({ version: APP_VERSION, isPreview: false })
    },
    screenWatch: {
      setEnabled: async (req) => {
        const state = await post<ServerWatchState>('/api/watch/toggle', { enabled: req.enabled })
        return watchStatusFromServer(state)
      },
      getStatus: async () => {
        const state = await get<ServerWatchState>('/api/watch/state')
        return watchStatusFromServer(state)
      },
      // The macOS watcher has no overlay window, so widget geometry, hover
      // popovers and in-place citation writes have nothing to drive. Each call
      // resolves to its contract's inert shape rather than rejecting.
      setWidgetExpanded: async () => OK,
      setWidgetViewMode: async () => OK,
      widgetDragStart: async () => OK,
      widgetDragEnd: async () => OK,
      setActivePopoverRect: async () => OK,
      refreshEvidence: async () => ({ evidence: null }),
      critiqueClaim: async (req) => {
        try {
          const f = await post<{ explanation?: string; revision?: string | null; verdict?: string }>(
            '/api/watch/critique',
            { key: req.claimId }
          )
          return {
            critique: f.explanation ?? '',
            verdict: critiqueVerdictOf({ verdict: f.verdict ?? 'unsupported' }),
            suggestedRevision: f.revision ?? null,
            citationFix: null
          }
        } catch {
          return {
            critique: 'Critique is not available for this claim in the browser build.',
            verdict: 'unsupported',
            suggestedRevision: null,
            citationFix: null
          }
        }
      },
      findSource: async () => ({ candidates: [], cited: null }),
      previewCitation: async (req) => {
        const source = sourcesById.get(req.sourceRef)
        return {
          citation: source
            ? {
                inTextCitation: formatInTextCitation(source, req.style),
                worksCitedEntry: formatCitation(source, req.style)
              }
            : { inTextCitation: '', worksCitedEntry: '' }
        }
      },
      // Formats the pair like the real handler would, but writes into no
      // document: there is no UIA writer behind this bridge.
      insertCitation: async (req) => {
        const source = sourcesById.get(req.sourceRef)
        return {
          citation: source
            ? {
                inTextCitation: formatInTextCitation(source, req.style),
                worksCitedEntry: formatCitation(source, req.style)
              }
            : { inTextCitation: '', worksCitedEntry: '' }
        }
      },
      undoCitation: async () => OK
    },
    // No global hotkey in a browser tab — nothing captures the clipboard.
    onClipboardCaptured: () => () => undefined,
    onScreenWatchStatus: (callback: (status: ScreenWatchStatus) => void) => {
      let cancelled = false
      const push = async (): Promise<void> => {
        try {
          const state = await get<ServerWatchState>('/api/watch/state')
          if (!cancelled) callback(watchStatusFromServer(state))
        } catch {
          // Server unreachable — keep the last status on screen.
        }
      }
      void push()
      const timer = window.setInterval(() => void push(), 5000)
      return () => {
        cancelled = true
        window.clearInterval(timer)
      }
    },
    // The overlay's push events have no source here (no overlay window, no
    // UIA hover tracking) — subscriptions succeed and never fire.
    onScreenWatchOverlayUpdate: () => () => undefined,
    onScreenWatchHover: (callback) => {
      callback(null)
      return () => undefined
    },
    onAuthStateChanged: (callback: (user: AuthUser | null) => void) => {
      const id = window.setTimeout(() => callback(currentUser()), 0)
      return () => window.clearTimeout(id)
    }
  }
}
