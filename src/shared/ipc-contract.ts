import type {
  AccentColor,
  Analysis,
  AppSettings,
  AuthUser,
  Citation,
  CitationStyle,
  Claim,
  ClaimType,
  CritiqueVerdict,
  Density,
  FontSize,
  EvidenceItem,
  DocumentOutline,
  DocumentListItem,
  DocumentRecord,
  EvidenceCoverage,
  LibraryItem,
  ParagraphOutline,
  ParagraphRole,
  ScoreBreakdown,
  StructureComponents,
  StructureWeakness,
  SourceProvider,
  Theme,
  TracerConversation,
  TracerMessage
} from './types'
import type { ModelTier, Plan } from './plan'
import type { ScreenWatchProblemKind } from './problemKind'
import type { Credibility } from './sourceCredibility'

// Note: CitationStyle is already 'APA' | 'MLA' | 'Chicago' — reused as-is for
// the Screen Watch citation flow below, same enum the main app's citation
// generation already uses.

export interface AnalyzeDetectClaimsRequest {
  text: string
  origin: 'main' | 'floating'
}
export interface AnalyzeDetectClaimsResponse {
  analysisId: string
  claims: Claim[]
}

export interface AnalyzeGetResultRequest {
  analysisId: string
}
export interface AnalyzeGetResultResponse {
  analysis: Analysis
  claims: Claim[]
}

export interface EvidenceFindRequest {
  claimId: string
}
export interface EvidenceFindResponse {
  evidence: EvidenceItem[]
  strengthScore: number
  scoreBreakdown: ScoreBreakdown
}

export interface EvidenceGetForClaimRequest {
  claimId: string
}
export interface EvidenceGetForClaimResponse {
  evidence: EvidenceItem[]
}

export interface CitationGenerateRequest {
  sourceId: string
  style: CitationStyle
}
export interface CitationGenerateResponse {
  citation: string
}

export interface CitationListRequest {
  sourceId: string
}
export interface CitationListResponse {
  citations: Citation[]
}

/**
 * The work a sentence CITES, looked up.
 *
 * "Compare sources" showed one list — what a topical search returned — with
 * nothing to compare it against. Owner, 2026-08-19: *"I want it to pull up the
 * source before and the source it recommends now, because that's what comparing
 * sources means."* Correct: a card headed "Compare sources" that never shows
 * the writer's own source is a list wearing the wrong title.
 *
 * `search/referenceCheck.ts` already resolves this — the critique needs it, and
 * has since #155. Nothing surfaced it.
 *
 * ── `found: false` is NOT "this source is fake" ────────────────────────────
 * Crossref registers DOIs for the scholarly record and Open Library holds
 * books; a UNICEF page, a newspaper, a museum catalogue and a government report
 * are in neither. Measured on eval/fabrication's labelled set the lookup
 * separated 10 invented author pairs from 16 real articles perfectly and then
 * missed 2 of 8 real BOOKS. So the card says what was searched and what came
 * back, and never draws the conclusion — the same rule
 * `describeReferenceChecks` writes under for the model.
 */
export interface ResolvedCitedWork {
  /** The reference as the writer typed it: "(Walker, 2010)", "[3]". */
  raw: string
  /** Parsed out of it — what the writer claimed to be citing. */
  surnames: string[]
  year: number | null
  /** The title named in the reference or its list entry, when there was one. */
  citedTitle: string | null
  /** Did an index return a work carrying every cited surname in that year? */
  found: boolean
  /** The work that matched. Null unless `found`. */
  title: string | null
  /**
   * The matched work's year, which is NOT always the cited one — they differ by
   * one routinely (see YEAR_TOLERANCE in shared/citedReference.ts), and showing
   * both is half the point of putting the two side by side.
   */
  matchedYear: number | null
  doi: string | null
  /** Where the reader can open it, when the match carries a locator. */
  url: string | null
  /** Which index carried it — a book match and a journal match differ. */
  index: 'crossref' | 'openlibrary' | null
}

export interface CitationResolveCitedRequest {
  claimId: string
}
export interface CitationResolveCitedResponse {
  /**
   * Null when the sentence names nothing the lookup can check — a quoted title,
   * a bare URL, an institution with no year. That is a limit of ours and the
   * card says so rather than reporting an absence.
   */
  cited: ResolvedCitedWork | null
}

export interface CritiqueGenerateRequest {
  claimId: string
}
export interface CritiqueGenerateResponse {
  critique: string
  verdict: CritiqueVerdict
  /** What the sources actually found, when the claim is contradicted and that
   *  contradiction was confirmed. Null in every other case, including when the
   *  local model flagged one and the relay declined to confirm it — a
   *  correction is only ever shown when two independent checks agree. */
  correction: string | null
}

export interface LibrarySaveRequest {
  sourceId: string
  claimId?: string
  notes?: string
  tags?: string[]
}
export interface LibrarySaveResponse {
  item: LibraryItem
}

export interface LibraryListRequest {
  search?: string
  tag?: string
}
export interface LibraryListResponse {
  items: LibraryItem[]
}

export interface LibraryGetRequest {
  id: string
}
export interface LibraryGetResponse {
  item: LibraryItem
  citations: Citation[]
}

export interface LibraryUpdateRequest {
  id: string
  notes?: string
  tags?: string[]
}
export interface LibraryUpdateResponse {
  item: LibraryItem
}

export interface LibraryRemoveRequest {
  id: string
}
export interface LibraryRemoveResponse {
  ok: true
}

export type SettingsGetRequest = Record<string, never>
export type SettingsGetResponse = AppSettings

export interface SettingsSetRequest {
  defaultCitationStyle?: CitationStyle
  hotkeyAccelerator?: string
  enableStrengthSummaries?: boolean
  theme?: Theme
  accentColor?: AccentColor
  density?: Density
  fontSize?: FontSize
  claimSensitivity?: number
  screenWatchHotkeyAccelerator?: string
  screenWatchAllowedApps?: string
  suppressSaveConfirm?: boolean
  /** School year, 3-12. Bands the letter; never touches the /100. */
  gradingLevel?: number
  /** Auto-critique claims the writer cited. The paid call — see AppSettings. */
  autoCritiqueCited?: boolean
  /** Requested model tier. Clamped to the plan on every call — see AppSettings. */
  modelTier?: ModelTier
}
export type SettingsSetResponse = AppSettings

export type SettingsScanInstalledAppsRequest = Record<string, never>
export interface ScannedApp {
  name: string
  exe: string
}
export interface SettingsScanInstalledAppsResponse {
  // Installed apps found via the Windows installed-programs registry data —
  // best-effort, not exhaustive (see scan-apps.ps1 for what gets dropped
  // and why). Empty means "couldn't tell," not "nothing is installed."
  found: ScannedApp[]
}

// Real, locally-persisted profile info — no account/server involved, this
// is just local display preferences (name shown in Settings, avatar image).
// Kept as its own get/set pair rather than folded into AppSettings so the
// avatar (a data URL round-trip on set, a file path at rest) never has to
// travel through the plain settings:get call every other feature also uses.
export type ProfileGetRequest = Record<string, never>
export interface ProfileInfo {
  firstName: string
  lastName: string
  bio: string
  // file:// URL to the locally-stored avatar image, or null if none set.
  avatarUrl: string | null
}
export type ProfileGetResponse = ProfileInfo

export interface ProfileSetRequest {
  firstName?: string
  lastName?: string
  bio?: string
  // Raw data URL (e.g. "data:image/png;base64,...") from a freshly-picked
  // file, written to disk server-side; pass null to remove the avatar.
  // Omit entirely to leave the existing avatar untouched.
  avatarDataUrl?: string | null
}
export type ProfileSetResponse = ProfileInfo

export interface HistoryClearRequest {
  includeLibrary: boolean
}
export interface HistoryClearResponse {
  ok: true
}

export type ClipboardReadRequest = Record<string, never>
export interface ClipboardReadResponse {
  text: string
}

export interface ClipboardWriteRequest {
  text: string
}
export interface ClipboardWriteResponse {
  ok: true
}

export interface WindowTargetRequest {
  target: 'main' | 'floating'
}
export interface WindowTargetResponse {
  ok: true
}

/**
 * Which grip is being dragged.
 *
 * The compass names are the corner or edge under the pointer, and each one
 * implies its OPPOSITE as the fixed anchor: dragging 'se' holds the top-left
 * still, 'nw' holds the bottom-right. Sent as a name rather than as a computed
 * geometry so every bit of that arithmetic lives main-side, where the window's
 * real bounds are — the renderer is inside a zoomed document and does not know
 * its own size in screen pixels.
 */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface WindowResizeStartRequest {
  handle: ResizeHandle
}
export interface WindowResizeStartResponse {
  ok: true
}

/**
 * Pointer movement since the drag began, in SCREEN pixels.
 *
 * Screen coordinates rather than client ones, deliberately. The document is
 * under a CSS `zoom` that changes *during* the drag — that is the whole point
 * of the feature — so a delta measured in client space would be denominated in
 * units that shift underneath it, and the window would accelerate away from the
 * cursor. `screenX`/`screenY` are unaffected by zoom.
 *
 * A delta from the START, not since the last event. Accumulating per-move
 * deltas drifts: every clamp at the size limits would be silently folded into
 * the running total, so a drag that hit the minimum and came back would no
 * longer track the pointer.
 */
export interface WindowResizeMoveRequest {
  dx: number
  dy: number
}
export interface WindowResizeMoveResponse {
  ok: true
}

export interface WindowMinimizeResponse {
  ok: true
}
export interface WindowToggleMaximizeResponse {
  /** Where the toggle left it, so the button's icon does not need its own
   *  round trip to find out. */
  maximized: boolean
}
export interface WindowIsMaximizedResponse {
  maximized: boolean
}

export interface ShellOpenExternalRequest {
  url: string
}
export interface ShellOpenExternalResponse {
  ok: true
}

export interface AppGetBuildInfoResponse {
  version: string
  /** True only in builds published by `npm run ship:preview` — never in a real release. */
  isPreview: boolean
}

export interface FloatingClipboardCapturedEvent {
  text: string
}

export interface ScreenWatchSetEnabledRequest {
  enabled: boolean
}
export interface ScreenWatchStatus {
  enabled: boolean
  active: boolean
  processName: string | null
  supportsUnderlines: boolean
  claimCount: number
  lastError: string | null
  blockedApp: string | null
  // The relay refused the call because it could not identify the user — an
  // expired session, or none at all. Separate from lastError because it is the
  // one failure the user can act on, and because nothing rendered lastError:
  // a signed-out app looked exactly like a slow one, right down to claims
  // simply never appearing.
  authRequired: boolean
}
export type ScreenWatchSetEnabledResponse = ScreenWatchStatus
export type ScreenWatchGetStatusRequest = Record<string, never>
export type ScreenWatchGetStatusResponse = ScreenWatchStatus

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}
// Evidence search now runs in the background per flagged claim (fire-and-
// forget, kicked off right after detection) — this is its result once it
// resolves. `articles` is trimmed to the top few by rank (not the full
// result set — see leanEvidence in screenWatchService.ts) since it travels
// in the overlay payload that gets re-sent on every change; the full list is
// only ever fetched from the main Tracely window via the existing
// EVIDENCE_FIND flow, not through Screen Watch.
/**
 * What is wrong with a claim. Re-exported from the one place it is declared.
 *
 * This used to be a hand-maintained copy of the union in
 * services/screenWatch/problemKind.ts, because the renderer needs it and must
 * not import main. problemKind.ts is a pure function of `@shared/types` and now
 * lives in shared/ itself, so both sides can import the real thing and the copy
 * can no longer drift from the logic that produces it.
 */
export type { ScreenWatchProblemKind }

export interface ScreenWatchEvidenceArticle {
  title: string
  venue: string | null
  year: number | null
  provider: SourceProvider
  url: string | null
  // Real favicon for the source's own site, fetched server-side (see
  // main/services/search/favicon.ts) as a data: URI so it satisfies the
  // overlay's img-src 'self' data: CSP with no loosening. Null while
  // unavailable/unfetchable — the renderer falls back to the provider
  // monogram badge in that case.
  faviconDataUrl: string | null
}
export interface ScreenWatchClaimEvidence {
  score: number
  count: number
  articles: ScreenWatchEvidenceArticle[]
  // The four factors the score is made of. The widget's single-claim card
  // ("Argument check" in Figma) shows them as a 2x2 breakdown, which is the
  // whole reason the score is a published formula rather than a model's
  // opinion — a student who disagrees with 34/100 can see which factor cost
  // them the points. `support` is omitted: it is weighted 0 on the no-stance
  // path, which ml/index.ts establishes is the only path a packaged build
  // takes, so showing it would report a factor that cannot vary.
  breakdown: ScoreBreakdown
}

// Set once the user has actually inserted a citation into the watched
// document for this claim (see insertCitationForClaim in
// screenWatchService.ts) — the renderer treats a cited claim as resolved
// (dropped from the flagged/underline set) rather than re-showing the
// "missing citation" popup for something already fixed.
export interface ScreenWatchClaimCitation {
  inTextCitation: string
  worksCitedEntry: string
}

export interface ScreenWatchClaimSummary {
  id: string
  text: string
  claimType: ClaimType
  confidence: number
  /**
   * The writer already put a citation in this sentence — (Smith, 2020),
   * "Smith (2020)", [3], a DOI.
   *
   * Screen Watch had no way to know this: `citation` below is set only when
   * TRACELY inserted one. So a properly cited sentence was told, in those
   * words, that it was "Missing citation" — and because a cited sentence tends
   * to be a searchable one, it also scored well, which is the band that copy
   * comes from. Both the card's wording and whether the claim is shown at all
   * turn on this now.
   */
  hasInlineCitation: boolean
  /**
   * Every problem this claim has, worst first — decided in main so the
   * underline and this card cannot disagree.
   *
   * A sentence can be in more than one kind of trouble at once. The card shows
   * only the first and badges the count; dismissing or fixing it advances to
   * the next, so fixing what is shown never reveals a second problem the
   * writer had no idea was there.
   */
  problemKinds: ScreenWatchProblemKind[]
  // null while the background search hasn't resolved yet (or failed) for
  // this claim — the renderer shows a loading state, not a zero score.
  evidence: ScreenWatchClaimEvidence | null
  // Both null until the user explicitly clicks "Critique Argument" — unlike
  // evidence search, critique hits the paid relay, so it never runs
  // automatically for passive background reading (see critiqueClaim in
  // screenWatchService.ts).
  critique: string | null
  critiqueVerdict: CritiqueVerdict | null
  /**
   * The claim's own sentence with only its quantifier or hedge narrowed, set
   * when the verdict is `overstated`. Null in every other case, and never
   * manufactured — see CritiqueResult and the relay's Pass 3.
   *
   * Its own field rather than a line inside `critique` so the card can offer it
   * as an edit the writer takes or leaves. Buried in the prose it is advice.
   */
  suggestedRevision: string | null
  /**
   * The corrected reference, when the writer cited a real source in a malformed
   * way. Always null alongside a `fabricated` verdict — normalizeCritique
   * enforces that, because reformatting a reference Tracely has just called
   * invented is incoherent.
   */
  citationFix: string | null
  citation: ScreenWatchClaimCitation | null
}

// "Find a source" — a focused, single-claim search distinct from
// refreshEvidence's broader multi-source list: ranked candidates with a
// per-item match % so the user can pick one specific source to cite,
// rather than browsing everything found. sourceRef is an opaque id (same
// derivation as synthesizeEvidenceItem's Source.id in screenWatchService.ts)
// the follow-up insertCitation call uses to find the same item server-side —
// results aren't persisted anywhere, same ephemeral rule as the rest of
// Screen Watch's evidence.
export interface ScreenWatchFindSourceRequest {
  claimId: string
  // Retained, unused. It described a "search again" box in the citation
  // picker that does not exist and architecturally cannot: the overlay window
  // is `focusable: false` by design, so it can never host a text input. Every
  // caller sends only { claimId }. Kept rather than deleted because
  // src/shared/* is additive per CLAUDE.md.
  query?: string
}
export interface ScreenWatchSourceCandidate {
  sourceRef: string
  title: string
  venue: string | null
  year: number | null
  provider: SourceProvider
  url: string | null
  matchPercent: number
  faviconDataUrl: string | null
  /**
   * What a marker would make of this publisher — see
   * shared/sourceCredibility.ts. Computed in main so the overlay and the editor
   * cannot reach different verdicts about one source.
   */
  credibility: Credibility
}
/**
 * Sources for a piece of text the user typed, with no document behind it.
 *
 * Home's source finder. Everything else in the app searches for sources FOR a
 * detected claim — which means a document, an analysis and a stored claim row
 * have to exist first. This is the same retrieval with none of that: paste a
 * sentence, get the sources that speak to it.
 *
 * The response reuses `ScreenWatchSourceCandidate` deliberately. It already
 * carries the favicon and the credibility verdict, and reusing it means Home's
 * rows can be the same rows the overlay and the editor draw — one source list
 * in the product, not three that drift.
 */
/**
 * Which of a draft's claims are not about the rest of it.
 *
 * Local and free — two MiniLM embeddings and a cosine distance, no relay — so
 * the editor may run it on the same automatic path the evidence sweep uses
 * rather than behind a button. See shared/claimRelevance.ts.
 */
export interface ClaimsOffTopicRequest {
  text: string
  claims: Claim[]
}
export interface ClaimsOffTopicResponse {
  /**
   * Null when nothing could be measured — the model unavailable, or the draft
   * too short to have a topic yet. The caller must be able to tell that from
   * "every claim belongs", because only the second is a finding.
   */
  offTopicClaimIds: string[] | null
}

export interface EvidenceForTextRequest {
  text: string
  style: CitationStyle
}
export interface EvidenceForTextResponse {
  candidates: ScreenWatchSourceCandidate[]
  /**
   * A formatted reference per candidate, keyed by sourceRef.
   *
   * Precomputed here because this surface has nothing else to do with a source
   * — there is no sentence to insert a marker into, so the citation IS the
   * deliverable and every row needs one. That is the opposite of the citation
   * flow's reasoning for NOT precomputing (three styles x N candidates, nearly
   * all discarded); here it is one style x N and all of it is shown.
   */
  citations: Record<string, string>
  /** Null when the text was too short or nothing came back. */
  note: string | null
}

export interface ScreenWatchFindSourceResponse {
  candidates: ScreenWatchSourceCandidate[]
  /**
   * The work the sentence already cites, so the overlay's card can compare
   * rather than merely list. Returned here rather than from its own channel
   * because Screen Watch claims are never persisted — there is no `claimId` to
   * look one up by later, only the in-memory claim this call already has.
   */
  cited: ResolvedCitedWork | null
}

/**
 * What "Insert citation" WOULD write, without writing it — the Preview button
 * in the design's Source Finder Popover (410:185).
 *
 * A separate call rather than a field on the candidate: the two formatted forms
 * depend on the chosen style as well as the chosen source, so precomputing them
 * would mean three styles x N candidates of formatting per search, nearly all
 * of it thrown away. Formatting is pure and local (`citations/formatters/*`),
 * so this costs no network call and touches neither the document nor the DB.
 */
export interface ScreenWatchPreviewCitationRequest {
  claimId: string
  sourceRef: string
  style: CitationStyle
}
export interface ScreenWatchPreviewCitationResponse {
  citation: ScreenWatchClaimCitation
}

export interface ScreenWatchInsertCitationRequest {
  claimId: string
  sourceRef: string
  style: CitationStyle
}
export interface ScreenWatchInsertCitationResponse {
  citation: ScreenWatchClaimCitation
}

export interface ScreenWatchUndoCitationRequest {
  claimId: string
}
export interface ScreenWatchUndoCitationResponse {
  ok: true
}

export interface ScreenWatchRefreshEvidenceRequest {
  claimId: string
}
export interface ScreenWatchRefreshEvidenceResponse {
  evidence: ScreenWatchClaimEvidence | null
}

export interface ScreenWatchCritiqueClaimRequest {
  claimId: string
}
export interface ScreenWatchCritiqueClaimResponse {
  critique: string
  verdict: CritiqueVerdict
  /**
   * The claim's sentence with only its quantifier or hedge changed, when the
   * verdict is `overstated`. Null otherwise — see CritiqueResult.
   *
   * Carried as its own field rather than left inside the critique prose so the
   * overlay can offer it as a replacement the writer accepts or ignores. Buried
   * in a paragraph it is advice; as a field it is an edit.
   */
  suggestedRevision: string | null
  /** The corrected reference when a real source is cited in a malformed way. */
  citationFix: string | null
}

/**
 * The structural read of the watched document, as the overlay needs it.
 *
 * A projection of `DocumentOutline` rather than the thing itself. Dropped:
 * `documentId`/`analysisId` (both null — Screen Watch persists nothing),
 * `sourceHash`/`schemaVersion` (no stored outline to compare against),
 * `analyzedAt` (a changing timestamp would defeat the payload dedupe in
 * updateOverlayAndWidget for no benefit — there is no stale banner here), and
 * `rolesFrom` (always 'heuristic' on this path, so the overlay states it
 * outright instead of branching on a field with one value).
 *
 * Null whenever `structureFit` judges the extracted text unfit to score. The
 * overlay hides the score chip entirely in that case rather than showing a
 * number nobody can act on.
 */
/**
 * What the Screen Watch panel opens on.
 *
 * Shared because THREE places have to agree and two of them silently did not:
 * `screenWatchService` holds the live value, `OverlayApp`'s launcher used to
 * set its own on every click (which is why changing the service default did
 * nothing visible), and `preview/mockApi.ts` hardcoded 'single' on collapse —
 * so the harness reproduced the old behaviour however main was configured, and
 * a review of this exact change would have passed while the app was wrong.
 *
 * 'grade' because the Figma flow opens on the Essay Grade Widget (370:191) and
 * puts the per-claim cards behind it. Safe before a reading exists: a detection
 * in flight draws the Analyzing card (391:342), and a draft that was read and
 * refused falls through to "No reading of this draft yet" rather than a spinner
 * that never resolves.
 */
export const DEFAULT_WIDGET_VIEW_MODE = 'grade'

export interface ScreenWatchStructure {
  score: number
  /** False when any paragraph is `unknown` — the score is then provisional. */
  complete: boolean
  components: StructureComponents
  coverage: EvidenceCoverage
  weaknesses: StructureWeakness[]
  paragraphs: ParagraphOutline[]
  /**
   * Whether `paragraphs[0]` is the document's title. Carried so the overlay
   * names paragraphs exactly as the in-app report does — see
   * `DocumentOutline.titleParagraph` and `components/paragraphNames.ts`.
   */
  titleParagraph?: boolean
  /**
   * First line of each paragraph, index-aligned so `previews[p.index - 1]`
   * belongs to `p`.
   *
   * `DocumentOutline` deliberately carries no prose, and the in-app panel joins
   * roles onto the live editor text instead. The overlay has no copy of the
   * watched document, and shipping one would mean the whole UIA read in every
   * payload — so main truncates here.
   *
   * This used to claim `ScreenWatchHoverEvent` already sends the whole document
   * to the overlay. It does not, and never did: that event's `text` is the
   * hovered CLAIM's text. The correction matters because the comment was read as
   * licence to compute document-wide figures renderer-side, which is exactly
   * what `stats` below exists to avoid.
   */
  previews: string[]
  /** Reading figures for the panel's stats row. See `DraftStats`. */
  stats: DraftStats
}

/**
 * Plain reading figures for the watched draft.
 *
 * Computed in main, where the document text already is. The overlay is never
 * sent that text — only `previews`, one truncated line per paragraph — so these
 * cannot be derived in the renderer, and a panel that tried would be counting
 * first lines and calling them a word count.
 *
 * Raw counts rather than finished numbers. Reading time depends on an assumed
 * words-per-minute and vocabulary diversity on how it is expressed as a
 * percentage; both are presentation, and presentation belongs to whichever view
 * is drawing them, not to main.
 */
export interface DraftStats {
  words: number
  /** At least 1, so words-per-sentence cannot divide by zero. */
  sentences: number
  /** Distinct case-folded words — the numerator of vocabulary diversity. */
  uniqueWords: number
}

export interface ScreenWatchWidget {
  rect: ScreenRect
  // Whether `rect` is the collapsed launcher circle or the expanded stats
  // panel — toggled via SCREENWATCH_SET_WIDGET_EXPANDED, recomputed here
  // (not client-side) so hoverTracking.ts's click-through hit-testing and
  // the renderer's draw position always agree on where the widget actually
  // is.
  expanded: boolean
  // Only meaningful while expanded — 'single' shows the top claim, 'all'
  // shows every currently-flagged claim in a grid. Determines `rect`'s
  // actual size (see computeAllPanelSize in screenWatchService.ts) since
  // "no scrolling" means the panel itself has to grow/shrink to fit.
  // 'structure' is the draft's structural read — same width as 'all' so the
  // bottom-right-anchored panel does not jump sideways when switching, and the
  // one mode whose body is allowed to scroll (paragraph count is unbounded).
  // 'grade' is the design's "Essay Grade Widget" (Figma 370:191) — the ring,
  // the band and the two actions. It is the one mode that is NOT the width of
  // the others (560 against 480) and NOT anchored bottom-right: the frame
  // centres it over the document, so the jump-sideways argument above does not
  // apply to it. See GRADE_PANEL_WIDTH in panelSize.ts.
  viewMode: 'single' | 'all' | 'structure' | 'grade' | 'report' | 'paragraph'
  claimCount: number
  // Ordered by confidence, highest first — the popup/panel picks which one
  // to show (hovered claim, or the top one by default) from this list
  // rather than needing a separate round-trip per claim.
  claims: ScreenWatchClaimSummary[]
  // The number of sources found across every currently-flagged claim — the
  // single "how much has been found" number the widget badge and panel header
  // show. Sources only: it once also added +1 per claim and was deliberately
  // deflated, and structural weaknesses are deliberately NOT folded in either
  // (they are heuristic, and they are exactly what goes noisy when paragraph
  // extraction misfires — see structureFit.ts).
  totalInfoCount: number
  /**
   * How many underlines are actually drawn on screen right now.
   *
   * What the collapsed launcher's badge counts. NOT `totalInfoCount`, which it
   * used to show — that is the number of SOURCES found across every flagged
   * claim, so the badge read 8 over a paragraph carrying two underlines and
   * there was no way to tell what the 8 referred to.
   *
   * And not `claimCount` either, which is every currently-flagged claim
   * including the ones whose rects came back off-screen or scrolled out and so
   * were filtered before drawing. The badge sits on a launcher pointing at the
   * document in front of the user; it should count the marks they can see.
   */
  underlineCount: number
  // Null when there is no trustworthy structural read; see ScreenWatchStructure.
  structure: ScreenWatchStructure | null
  /**
   * A reading is being worked on and there is not one yet — the Figma "Essay
   * Grade (Analyzing)" state (391:342).
   *
   * Distinct from `structure === null`, which covers two very different cases:
   * a detection in flight (say so, and show the spinner) and a draft that was
   * read and produced nothing trustworthy (structureFit refused, or it is too
   * short — say THAT, and leave the score dashes). The renderer cannot tell
   * them apart from the payload alone, and guessing means either a spinner that
   * never resolves on a document Screen Watch has already given up on, or a
   * flat "no reading yet" while the first pass is still running.
   *
   * Always false once `structure` is set: a re-detection of an already-graded
   * draft must not replace a live score with a spinner.
   */
  analyzing: boolean
}

export interface ScreenWatchOverlayUpdateEvent {
  /**
   * `problemKind` is what the mark is coloured by. `claimType` rides along for
   * the popover's type dot, but it must NOT drive the underline: colouring by
   * claim type meant every factual claim in a document was the same orange
   * whatever state it was in, and the underline — the part of Screen Watch
   * people actually read — carried no information about the problem at all.
   */
  underlines: {
    id: string
    rects: ScreenRect[]
    claimType: ClaimType
    /** Worst first. The mark is coloured by [0]; length > 1 shows a count. */
    problemKinds: ScreenWatchProblemKind[]
  }[]
  widget: ScreenWatchWidget | null
}

export interface ScreenWatchHoverEvent {
  claimId: string
  kind: 'claim' | 'widget'
  text: string
  claimType: ClaimType
  // Window-local (same coordinate space as ScreenWatchOverlayUpdateEvent
  // rects) — the specific rect the cursor was actually over, so a claim
  // that wraps multiple lines anchors under the right line rather than
  // always the first one.
  anchor: ScreenRect
}

export interface ScreenWatchSetWidgetExpandedRequest {
  expanded: boolean
}
export interface ScreenWatchSetWidgetExpandedResponse {
  ok: true
}

export interface ScreenWatchSetWidgetViewModeRequest {
  mode: 'single' | 'all' | 'structure' | 'grade' | 'report' | 'paragraph'
}
export interface ScreenWatchSetWidgetViewModeResponse {
  ok: true
}

export type ScreenWatchWidgetDragStartRequest = Record<string, never>
export interface ScreenWatchWidgetDragStartResponse {
  ok: true
}

export interface ScreenWatchWidgetDragEndRequest {
  // Window-local coordinates (same space as ScreenWatchWidget.rect) of the
  // widget's final top-left corner after the drag.
  x: number
  y: number
}
export interface ScreenWatchWidgetDragEndResponse {
  ok: true
}

// The renderer computes the popover's exact on-screen rect (position +
// size) when it opens for a given claim; reporting it back lets
// hoverTracking.ts hit-test against the popover's REAL bounds instead of a
// guessed fixed padding, so moving the mouse onto its buttons never breaks
// the hover and moving away from it (not just away from the underline)
// reliably closes it. Pass rect: null (claimId still set) when the popover
// is hidden/dismissed.
export interface ScreenWatchSetActivePopoverRectRequest {
  claimId: string | null
  // Window-local coordinates (same space as ScreenWatchOverlayUpdateEvent
  // rects).
  rect: ScreenRect | null
}
export interface ScreenWatchSetActivePopoverRectResponse {
  ok: true
}

// --- Tracer -----------------------------------------------------------
// The teaching assistant opened from the Screen Watch widget. It runs in
// its own focusable BrowserWindow (windows/tracerWindow.ts) rather than
// inside the overlay, because the overlay is deliberately unfocusable and
// so cannot host a text input — see the note in overlayWindow.ts.

// What Tracer can currently "see": the text of the document being watched
// and the claims flagged in it. Pushed to the Tracer window on open and
// whenever it changes, so the UI can show the user exactly what context
// their question will be answered against instead of leaving it implicit.
export interface TracerContext {
  // Null when Screen Watch is off or no allowed app is focused — Tracer
  // still answers, just without document context.
  processName: string | null
  documentText: string
  claims: { id: string; text: string; claimType: ClaimType; evidenceScore: number | null }[]
  // The Structure analysis of the draft, when the context came from Tracely's
  // own document editor. Absent for Screen Watch context, which reads an
  // external app that has no outline. Optional and additive.
  outline?: {
    title: string
    score: number
    complete: boolean
    roles: ParagraphRole[]
    weaknesses: string[]
  }
}

export interface TracerOpenRequest {
  // Set when opened from a specific claim ("Ask Tracer about this") so the
  // conversation starts anchored to it rather than the whole document.
  claimId?: string
  // A ready-made question to prefill, set when opened from a structural
  // weakness in the Structure rail. Separate from claimId because most
  // structural findings are not about a claim at all — a missing
  // counterargument is about the whole draft.
  prompt?: string
}
export interface TracerOpenResponse {
  ok: true
}

export type TracerCloseRequest = Record<string, never>
export interface TracerCloseResponse {
  ok: true
}

export interface TracerSendRequest {
  conversationId: string
  message: string
}
export interface TracerSendResponse {
  // Both the stored user message and Tracer's stored reply — the renderer
  // appends these rather than optimistically inventing ids that wouldn't
  // match what's in the database.
  userMessage: TracerMessage
  reply: TracerMessage
}

export interface TracerRetryRequest {
  conversationId: string
}
// Retry re-asks the last question rather than appending a second copy of it,
// so the stored conversation stays a clean transcript — the discarded pair is
// deleted before the new turn runs. Same response shape as send: the renderer
// drops its last two messages and appends these.
export type TracerRetryResponse = TracerSendResponse

export interface TracerGetConversationRequest {
  // Omit to get (or lazily create) the most recent conversation.
  conversationId?: string
}
export interface TracerGetConversationResponse {
  conversation: TracerConversation
  messages: TracerMessage[]
  context: TracerContext
  // False when this build has no Tracely server configured — the renderer
  // disables the composer and explains why instead of failing on send.
  serverConfigured: boolean
  // Set when the window was opened via "Ask Tracer about this claim" — the
  // renderer prefills a starter question about it.
  focusedClaimId: string | null
  // A question composed by the caller, taking precedence over focusedClaimId's
  // generic starter when both are present.
  focusedPrompt: string | null
}

export type TracerListConversationsRequest = Record<string, never>
export interface TracerListConversationsResponse {
  conversations: TracerConversation[]
}

export type TracerNewConversationRequest = Record<string, never>
export interface TracerNewConversationResponse {
  conversation: TracerConversation
}

export interface TracerDeleteConversationRequest {
  id: string
}
export interface TracerDeleteConversationResponse {
  ok: true
}

export type AuthGetUserRequest = Record<string, never>
export interface AuthGetUserResponse {
  user: AuthUser | null
  // False if this build has no Supabase project configured (no
  // SUPABASE_URL/SUPABASE_ANON_KEY at build time) — the renderer should
  // hide/disable the login UI rather than show sign-in attempts that will
  // always fail.
  configured: boolean
}

export interface AuthSignUpRequest {
  email: string
  password: string
  firstName: string
}
export interface AuthSignInRequest {
  email: string
  password: string
}
export interface AuthSignResponse {
  user: AuthUser | null
}

export type AuthSignOutRequest = Record<string, never>
export interface AuthSignOutResponse {
  ok: true
}

export type AuthSignInWithGoogleRequest = Record<string, never>
export interface AuthSignInWithGoogleResponse {
  // The system browser is opened with this URL; the actual signed-in user
  // arrives later via the AUTH_STATE_CHANGED event once the OAuth redirect
  // completes, not as this call's return value.
  ok: true
}

export interface AuthUpdateNameRequest {
  firstName: string
}
export type AuthUpdateNameResponse = AuthSignResponse

export interface AuthUpdateUsernameRequest {
  username: string
}
export type AuthUpdateUsernameResponse = AuthSignResponse

export type AuthDeleteAccountRequest = Record<string, never>
export interface AuthDeleteAccountResponse {
  ok: true
}

export type AuthGetPlanRequest = Record<string, never>
export interface AuthGetPlanResponse {
  /**
   * What the signed-in account has paid for. `free` for a signed-out user, an
   * unconfigured build, or anything that could not be read — the renderer is
   * never handed "unknown" to guess about, because every guess it could make
   * would either nag a paying user or unlock a paid control for nobody.
   */
  plan: Plan
}

export interface DocumentsListResponse {
  documents: DocumentListItem[]
}
export interface DocumentsGetRequest {
  id: string
}
export interface DocumentsGetResponse {
  document: DocumentRecord | null
}
export interface DocumentsLatestResponse {
  document: DocumentRecord | null
}
export interface DocumentsSaveRequest {
  /** Absent for a document that has never been saved. */
  id?: string | null
  title: string
  bodyHtml: string
}
export interface DocumentsSaveResponse {
  document: DocumentRecord
}
export interface DocumentsRemoveRequest {
  id: string
}
export interface DocumentsRemoveResponse {
  ok: true
}

export interface StructureAnalyzeRequest {
  /** Null for a document that has not autosaved yet — the outline still computes. */
  documentId?: string | null
  /**
   * The editor's `innerText`, NOT its `bodyHtml`. Paragraph and claim offsets
   * are computed against this string, and it has to be the same string claim
   * detection saw or every offset is wrong. Main deliberately never parses the
   * document's HTML.
   */
  text: string
  /** The analysis whose claims to map onto paragraphs. Null before Analyze has run. */
  analysisId?: string | null
}
export interface StructureAnalyzeResponse {
  outline: DocumentOutline
}
export interface StructureGetRequest {
  documentId: string
  /**
   * The text currently in the editor, so main can hash it and answer `stale`.
   *
   * The TEXT rather than a hash of it, deliberately. Hashing in the renderer
   * would mean a second implementation of the normalization
   * (`sourceHashFor`) living in another process, and the two drifting by a
   * single character class would make every stored outline look permanently
   * stale — a bug that presents as "the feature doesn't work" with nothing
   * obviously wrong. The document is already sent in full to analyze it.
   */
  text: string
}
export interface StructureGetResponse {
  outline: DocumentOutline | null
  stale: boolean
}

/**
 * Real site icons for a batch of source URLs.
 *
 * Batched rather than one call per row because a results list is six to eight
 * sources that routinely share a publisher domain, and the main-side cache is
 * keyed by hostname — asking once for the whole list lets the dedupe happen
 * before any request goes out rather than after eight of them have.
 *
 * A missing key and a `null` value mean the same thing and both must render the
 * monogram: null is "asked and got nothing", missing is "over the batch cap".
 */
export interface SourcesFaviconsRequest {
  urls: string[]
}

export interface SourcesFaviconsResponse {
  /** Keyed by the URL as passed in, so the caller needs no hostname parsing. */
  icons: Record<string, string | null>
}
