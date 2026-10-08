import { randomUUID } from 'crypto'
import { BrowserWindow, screen } from 'electron'
import { IPC_EVENTS } from '@shared/ipc-channels'
import { DEFAULT_WIDGET_VIEW_MODE } from '@shared/ipc-contract'
import type {
  ScreenWatchClaimCitation,
  ScreenWatchClaimEvidence,
  ScreenWatchClaimSummary,
  ScreenWatchFindCitedWorkResponse,
  ScreenWatchOverlayUpdateEvent,
  ScreenWatchSourceCandidate,
  ResolvedCitedWork,
  ScreenWatchStatus,
  ScreenWatchStructure
} from '@shared/ipc-contract'
import { findCitationDefects, type CitationDefect } from '@shared/citationShape'
import { citationTarget, type CitationTarget } from '@shared/citedWork'
import { findCitedWork } from '../search/citedWorkFinder'
import type {
  CitationStyle,
  Claim,
  CritiqueVerdict,
  EvidenceItem,
  ScoreBreakdown,
  Source
} from '@shared/types'
import { computeClaimSpans } from '@shared/claimSpans'
import { detectClaims } from '../ai/claimDetection'
import { isAuthError } from '../ai/client'
import { generateCritique, type CritiqueResult } from '../ai/critique'
import { formatCitation } from '../citations'
import { formatInTextCitation } from '@shared/citationInText'
import { findCitationInsertPoint } from '@shared/citationInsertPoint'
import { findEvidenceCached } from '../search/cachedEvidence'
import { getFaviconDataUrl } from '../search/favicon'
import { checkReferences, resolveCitedWork } from '../search/referenceCheck'
import { byCredibility, credibilityOf } from '@shared/sourceCredibility'
import { computeTextRelevance } from '../search/scoring'
import type { NormalizedSourceResult } from '../search/types'
import { getSetting, setSetting } from '../storage/settingsRepo'
import { sourceHashFor } from '../structure/analyzeStructure'
import { focusedShieldableWindow } from '../../windows/overlayShield'
import {
  getOverlayWindow,
  hideOverlay,
  positionOverlayWindow,
  presentOverlay,
  sendToOverlay
} from '../../windows/overlayWindow'
import { getMainWindow } from '../../windows/mainWindow'
import {
  ANALYZING_PANEL_HEIGHT,
  ANALYZING_PANEL_WIDTH,
  computeAllPanelSize,
  computeStructurePanelSize,
  GRADE_PANEL_HEIGHT,
  GRADE_PANEL_WIDTH,
  PARAGRAPH_PANEL_HEIGHT,
  PARAGRAPH_PANEL_WIDTH,
  REPORT_PANEL_HEIGHT,
  REPORT_PANEL_WIDTH,
  SINGLE_PANEL_HEIGHT,
  SINGLE_PANEL_WIDTH,
  WIDGET_SIZE
} from './panelSize'
import {
  hasInlineCitation,
  hasInlineCitationNear,
  inlineCitationKind,
  sentenceAround
} from '@shared/inlineCitation'
import { isCitedInScope } from '@shared/citationScope'
import { hasRelevantSource, problemKindsFor, problemSeverity } from '@shared/problemKind'
import { retrievalScopeFor } from '@shared/retrievalScope'
import { computeWatchOutline } from './watchOutline'
// Whether a snapshot pre-dates us, and so skips the typing debounce. A leaf, so
// the rule is testable — see the note at the top of that file.
import { isPreexistingText } from './firstSight'
import { clipUnderline, resolveClip } from './clipRects'
// Whether a poll result that arrived after an await may still be drawn — see
// tickGuard.ts for the bug this exists to stop.
import { tickDecision } from './tickGuard'
import { logScreenWatch, resetScreenWatchLog } from './debugLog'
import { clearHoverState, setDragActive, startHoverTracking, stopHoverTracking } from './hoverTracking'
import {
  insertCitationText,
  takeUiaSnapshot,
  undoLastInsert,
  type ClaimSpanRequest,
  type ScreenRect
} from './uiaSnapshot'

const POLL_INTERVAL_MS = 1200
// How long the text has to stop changing before it's analyzed. This was
// 1200ms, which is not "the user finished a thought" — it's the pause
// between words. Someone drafting an essay clears a 1.2s bar dozens of
// times per paragraph, and because the cache is keyed on the whole
// document, every one of those was a guaranteed miss (the text differs by
// whatever was just typed) and so a full relay call re-analyzing the entire
// document. 4s is still responsive for someone who has genuinely stopped
// to think, and removes most of that.
const STABLE_MS = 4000
// Floor on time between two analyses regardless of stability. STABLE_MS
// alone doesn't bound anything: alternating type-pause-type-pause can clear
// it indefinitely. This is the actual ceiling on Screen Watch's spend —
// at most one detection per 20s per user while actively writing.
const MIN_ANALYSIS_INTERVAL_MS = 20_000
// Re-analyzing after a handful of characters changed re-reads the whole
// document to discover the same claims plus a partial sentence. Requiring a
// sentence-sized delta means a detection is triggered by new content, not
// by a typo fix. (Deletions count: Math.abs.)
const MIN_TEXT_DELTA_CHARS = 80
// How many of a detection's claims get their evidence fetched automatically
// (see triggerEvidenceSearch). The rest search when the user opens them.
const MAX_AUTO_EVIDENCE_CLAIMS = 3
const MIN_TEXT_LENGTH = 20
// User-configurable now (Settings > General > sensitivity) rather than a
// value we keep re-tuning in code — Screen Watch underlines passively,
// without the user asking about any one sentence, so a borderline call
// here is far more annoying (flagging ordinary descriptive sentences) than
// it would be in Analyze, where the user asked for a full pass and can
// just ignore a weak one. Default (0.55) sits below the relay prompt's own
// confidence calibration for unambiguous claims (0.8+) since the two
// compound — a high threshold on top of deliberately deflated scores for
// borderline claims suppressed real claims entirely in testing.
function getMinClaimConfidence(): number {
  const raw = Number(getSetting('claimSensitivity'))
  return Number.isFinite(raw) ? raw : 0.55
}

let enabled = false
let timer: ReturnType<typeof setTimeout> | null = null
let ticking = false
let detecting = false

/**
 * Is the next text we see the first since a reset?
 *
 * True on start and whenever tracking resets, false from the first snapshot
 * onward. Only used to decide whether that snapshot pre-dates us — see tick().
 */
let awaitingFirstSight = true
let pendingText = ''
let pendingSince = 0
let lastAnalyzedText = ''
let lastAnalysisAt = 0

// Cheap stand-in for an edit distance: the length change, plus whether one
// text is still a prefix of the other. Rewriting a sentence in place keeps
// the length nearly identical, so length alone would miss it — but such an
// edit also breaks the common prefix, which this catches. Good enough to
// separate "typed a new sentence" from "fixed a typo", which is all the
// gate below needs to decide.
function hasMeaningfulDelta(next: string, previous: string): boolean {
  if (!previous) return true
  if (Math.abs(next.length - previous.length) >= MIN_TEXT_DELTA_CHARS) return true
  const shared = next.length < previous.length ? next.length : previous.length
  let i = 0
  while (i < shared && next[i] === previous[i]) i++
  // Everything after the first difference is rewritten text on both sides.
  return previous.length - i + (next.length - i) >= MIN_TEXT_DELTA_CHARS
}

/**
 * Is there a pass in flight, or one queued behind the debounce?
 *
 * Deliberately the *gating* half of the poll loop's trigger condition and not
 * the timing half: STABLE_MS, MIN_ANALYSIS_INTERVAL_MS and the retry cooldown
 * decide WHEN a pass runs, not WHETHER one is coming, and folding them in would
 * make the overlay's "Analyzing" card blink off and on between poll ticks while
 * the same pending text sat there waiting its turn.
 *
 * `lastError` is a state of its own: a detection that failed is not still
 * running, and the spinner is the wrong thing to leave on screen for it.
 */
function analysisPending(): boolean {
  if (detecting) return true
  if (lastError) return false
  return (
    pendingText.trim().length >= MIN_TEXT_LENGTH &&
    pendingText !== lastAnalyzedText &&
    hasMeaningfulDelta(pendingText, lastAnalyzedText)
  )
}

let currentClaims: Claim[] = []
// Background evidence search result per currently-flagged claim — kicked
// off right after detection (see triggerEvidenceSearch) rather than waiting
// for the user to ask, so the widget/popup can show a real "X sources
// found" number instead of only the claim-detection confidence. Full
// results are kept here (not just the lean score/count sent to the
// renderer, see leanEvidence) so critiqueClaim below has real titles/
// abstracts to work with without a second search round-trip. Kept separate
// from `currentClaims` (rather than mutating strengthScore on the Claim
// objects directly) since results arrive asynchronously, one claim at a
// time, well after currentClaims was already set.
// `breakdown` is carried, not just `score`, because structure's evidence
// coverage reads `scoreBreakdown.sourceCount` rather than `strengthScore` (see
// structure/evidenceCoverage.ts). Folding only the score onto a synthesized
// claim makes it read as SEARCHED BUT UNSOURCED, so findWeaknesses would emit
// "no supporting source yet" for every claim that in fact has sources — with
// those sources visible one view-mode away in the same panel.
// findEvidenceCached has always returned it; this used to discard it.
let evidenceResultByClaimId = new Map<
  string,
  { evidence: NormalizedSourceResult[]; score: number; breakdown: ScoreBreakdown }
>()
/**
 * The structural read of the watched document, memoised.
 *
 * Recomputed only when its inputs actually change, for two reasons. The cheap
 * one is that tick() runs every POLL_INTERVAL_MS and redrawOverlay() fires
 * again on every resolved favicon. The load-bearing one is that
 * updateOverlayAndWidget dedupes its IPC push by JSON.stringify of the whole
 * payload — a structure object rebuilt each tick would differ by object
 * identity only, defeat that dedupe, and re-render the overlay on top of
 * another app at 1.2s intervals forever.
 */
let watchStructure: { key: string; structure: ScreenWatchStructure | null } | null = null

// Critique is never run automatically here (unlike evidence search) — it's
// the paid relay, so it only runs when the user explicitly clicks "Critique
// Argument" in the overlay (see critiqueClaim).
// The whole CritiqueResult, not the two fields the card used to need. It now
// also carries `suggestedRevision` and `citationFix`, and narrowing the stored
// shape by hand is how those silently stopped reaching the overlay.
let critiqueByClaimId = new Map<string, CritiqueResult>()
// Results of the focused "Find a source" search (findSourceForClaim) — kept
// separate from evidenceResultByClaimId (the broader background auto-search)
// since it's a distinct, user-triggered search that can use a different
// query than the claim's own searchQuery (the picker's "search again" box).
let findSourceResultByClaimId = new Map<string, NormalizedSourceResult[]>()
// Set once insertCitationForClaim has actually typed a citation into the
// watched document for a claim — insertOffset is kept only so a future
// insert on the same claim (unlikely, since cited claims are hidden from
// the flagged set) wouldn't need to re-derive it; nothing reads it back out
// today beyond the map value itself.
let citationByClaimId = new Map<string, { inTextCitation: string; worksCitedEntry: string; insertOffset: number }>()
let currentSpans: ClaimSpanRequest[] = []
let retryAfter = 0
let lastError: string | null = null
// Tracked separately from lastError because it is the one failure the user can
// fix, and because it must survive being shown: a signed-out app previously
// looked identical to a slow one.
let authRequired = false
const RETRY_COOLDOWN_MS = 5000
let lastSkipReason: string | null = null

// Consecutive `ok:false` snapshots. A closing or repainting window produces
// these routinely, so one is not evidence of anything.
let snapshotFailures = 0
// Hiding is free and one good tick undoes it — but doing it at the first
// failure would reintroduce the blink useStableUnderlines exists to suppress.
const HIDE_AFTER_FAILURES = 2
// Resetting costs STABLE_MS + MIN_ANALYSIS_INTERVAL_MS (24s), a relay call and
// three four-provider searches, so it waits for more evidence than hiding does.
const RESET_AFTER_FAILURES = 3

// Identifies which *document* is being watched, so claims from one do not
// linger over another. Not the text itself — see isDifferentDocument.
let lastDocumentKey: string | null = null

export interface HoverTarget {
  claimId: string
  kind: 'claim' | 'widget'
  text: string
  claimType: Claim['claimType']
  // Absolute logical (DIP) screen coordinates — same space as
  // screen.getCursorScreenPoint() — for hit-testing in hoverTracking.ts.
  rectsAbsolute: ScreenRect[]
  // Window-local coordinates — same space sent in
  // SCREENWATCH_OVERLAY_UPDATE — for positioning the tooltip in the overlay
  // renderer without any unit conversion there.
  rectsWindowLocal: ScreenRect[]
  // Only the collapsed launcher's badge/shadow extends beyond its base rect.
  // The expanded panel uses zero so transparent pixels around it never gain
  // native mouse capture.
  capturePadding?: number
}

let hoverTargets: HoverTarget[] = []

export function getHoverTargets(): HoverTarget[] {
  return hoverTargets
}

let widgetExpanded = false
// Cached so toggling expanded/collapsed can redraw immediately instead of
// waiting up to POLL_INTERVAL_MS for the next scheduled snapshot.
let lastUpdateInputs: {
  windowRect: ScreenRect
  // Carried so redrawOverlay() reproduces the same clip the tick that computed
  // it used. Without it a redraw would clip against the window alone and the
  // underlines would visibly shift onto the app's toolbar.
  controlRect: ScreenRect | null
  claimRects: { id: string; rects: ScreenRect[] }[]
  claims: Claim[]
  fullText: string
} | null = null

// Window-local top-left corner the user last dragged the widget/panel to —
// overrides the fixed corner anchor while set. Cleared whenever the widget
// collapses or a new control/app comes into focus, so the next expand
// starts fresh at the anchor rather than wherever it happened to be left.
let widgetManualPos: { x: number; y: number } | null = null

// 'single' shows just one claim at a time (the highest-confidence one);
// 'all' shows every currently-flagged claim in a grid sized to fit with no
// scrolling — the panel's actual pixel size (see updateOverlayAndWidget)
// depends on this, so it has to be known server-side rather than left as a
// renderer-only toggle the way the hover popover's own single/all switch is.
export type WidgetViewMode = 'single' | 'all' | 'structure' | 'grade' | 'report' | 'paragraph'

// What opening the launcher lands on.
//
// 'grade', because the Figma flow opens on the Essay Grade Widget (370:191) and
// puts the per-claim cards behind it — and because the score is the one thing
// that is about the DRAFT rather than about one sentence. Opening on 'single'
// answered a question nobody had asked yet: it led with whichever claim
// happened to score highest, out of any context, before saying anything about
// the piece of writing as a whole.
//
// Safe before a reading exists, which is the thing to check before changing
// this: 'grade' has a designed state for every case. A detection in flight
// draws the Analyzing card (391:342), and a draft that was read and refused —
// too short, or structureFit rejected the split — falls through to the grade
// card's own "No reading of this draft yet" rather than a spinner that never
// resolves. See ScreenWatchWidget.analyzing.
const DEFAULT_VIEW_MODE: WidgetViewMode = DEFAULT_WIDGET_VIEW_MODE
let widgetViewMode: WidgetViewMode = DEFAULT_VIEW_MODE

export function setWidgetExpanded(expanded: boolean): void {
  widgetExpanded = expanded
  if (!expanded) {
    widgetManualPos = null
    widgetViewMode = DEFAULT_VIEW_MODE
  }
  redrawOverlay()
}

export function setWidgetViewMode(mode: WidgetViewMode): void {
  widgetViewMode = mode
  redrawOverlay()
}

export function setWidgetDragStart(): void {
  setDragActive(true)
}

export function setWidgetDragEnd(local: { x: number; y: number }): void {
  widgetManualPos = local
  setDragActive(false)
  redrawOverlay()
}

// The overlay's own logical top-left (the focused app window's origin, not
// the display's) the last time it was drawn — needed to convert the
// renderer-reported popover rect (window-local) into absolute screen
// coordinates for hoverTracking.ts, the same way widget drag positions are
// converted.
let lastOverlayOrigin: { x: number; y: number } | null = null
let activePopoverClaimId: string | null = null
let activePopoverRectAbsolute: ScreenRect | null = null

export function setActivePopoverRect(claimId: string | null, rectLocal: ScreenRect | null): void {
  activePopoverClaimId = claimId
  activePopoverRectAbsolute =
    rectLocal && lastOverlayOrigin
      ? {
          x: rectLocal.x + lastOverlayOrigin.x,
          y: rectLocal.y + lastOverlayOrigin.y,
          width: rectLocal.width,
          height: rectLocal.height
        }
      : null
}

export function getActivePopoverRect(): { claimId: string | null; rectAbsolute: ScreenRect | null } {
  return { claimId: activePopoverClaimId, rectAbsolute: activePopoverRectAbsolute }
}

function synthesizeClaim(detected: {
  text: string
  claimType: Claim['claimType']
  confidence: number
  searchQuery: string
}): Claim {
  return {
    id: randomUUID(),
    analysisId: '',
    text: detected.text,
    claimType: detected.claimType,
    confidence: detected.confidence,
    searchQuery: detected.searchQuery,
    strengthScore: null,
    scoreBreakdown: null,
    // Filled by critiqueClaim when the user asks for one — never by detection,
    // and never automatically here. See the note on the paid relay.
    suggestedRevision: null,
    citationFix: null,
    critique: null,
    critiqueVerdict: null,
    citedWorkRead: null,
    retrievalGeneration: null,
    createdAt: new Date().toISOString()
  }
}

let lastStatus: ScreenWatchStatus = {
  enabled: false,
  active: false,
  processName: null,
  supportsUnderlines: false,
  claimCount: 0,
  lastError: null,
  authRequired,
  blockedApp: null
}

function getAllowedApps(): string[] {
  return getSetting('screenWatchAllowedApps')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Opt-in allowlist — Screen Watch reads nothing anywhere until the user
// explicitly picks which apps it's allowed to work in (Settings >
// Preferences), rather than working everywhere by default with an opt-out
// blocklist. Nothing is enabled out of the box.
function isProcessAllowed(processName: string): boolean {
  const allowed = getAllowedApps()
  return allowed.some((name) => name.toLowerCase() === processName.toLowerCase())
}

function emitStatus(status: ScreenWatchStatus): void {
  lastStatus = status
  const win = getMainWindow()
  win?.webContents.send(IPC_EVENTS.SCREENWATCH_STATUS_CHANGED, status)
}

export function getScreenWatchStatus(): ScreenWatchStatus {
  return lastStatus
}

/**
 * Bumped by every reset, and captured before any asynchronous work that will
 * write back into the tracking state.
 *
 * `detecting` stops a second detection starting while one is in flight, but it
 * does nothing about a RESET arriving in the middle — focus moving to another
 * app, a document switch, repeated snapshot failures. The relay call then
 * resolves into a world it no longer describes and repopulates currentClaims,
 * currentSpans and the evidence searches for a document that is no longer on
 * screen. Comparing generations is how a late result learns it is stale.
 */
let trackingGeneration = 0

function resetTrackingState(): void {
  trackingGeneration++
  // The next text seen is text we have not looked at before. If it arrives
  // already long, it pre-dates us and skips the typing debounce — see the note
  // at the pendingText bookkeeping in tick().
  awaitingFirstSight = true
  pendingText = ''
  pendingSince = 0
  lastAnalyzedText = ''
  currentClaims = []
  watchStructure = null
  evidenceResultByClaimId = new Map()
  critiqueByClaimId = new Map()
  findSourceResultByClaimId = new Map()
  citationByClaimId = new Map()
  faviconByUrl = new Map()
  faviconFetchInFlight = new Set()
  currentSpans = []
  hoverTargets = []
  widgetExpanded = false
  widgetViewMode = DEFAULT_VIEW_MODE
  widgetManualPos = null
  lastUpdateInputs = null
  activePopoverClaimId = null
  activePopoverRectAbsolute = null
  lastSentPayloadKey = null
  lastDocumentKey = null
}

const EMPTY_OVERLAY_PAYLOAD: ScreenWatchOverlayUpdateEvent = { underlines: [], widget: null }

/**
 * Clears what the overlay is showing, then hides it.
 *
 * `hideOverlay()` alone was not enough and this is the main reason underlines
 * lingered: it hides the native window, but the React tree inside keeps its
 * `underlines` and `widget` state forever, so the previous document's marks
 * were repainted the moment the window was shown again — against whatever
 * window it had since been moved to.
 *
 * Three details are load-bearing:
 *
 *   - `widget: null`, not merely `underlines: []`. `useStableUnderlines` keys
 *     its 900ms grace hold off `widget.claims`, so an empty-underlines payload
 *     that kept the widget would HOLD every rect for another 900ms rather than
 *     clearing them.
 *   - It writes `lastSentPayloadKey`. Without that, a later payload that
 *     happened to match the pre-clear one would be swallowed by the dedupe in
 *     `updateOverlayAndWidget` and the overlay would stay blank permanently.
 *   - It clears hover too. `OverlayApp` synthesizes a popover from the hover
 *     event when `widget.claims` has no match, so an empty payload on its own
 *     leaves the card floating over a cleared overlay.
 */
function clearOverlay(): void {
  const key = JSON.stringify(EMPTY_OVERLAY_PAYLOAD)
  if (lastSentPayloadKey !== key) {
    lastSentPayloadKey = key
    sendToOverlay(IPC_EVENTS.SCREENWATCH_OVERLAY_UPDATE, EMPTY_OVERLAY_PAYLOAD)
  }
  hoverTargets = []
  clearHoverState()
  hideOverlay()
}

// How much of the shorter document's vocabulary must appear in the other for
// them to be treated as the same document, and how many distinct words are
// needed before the comparison is trusted at all. Below that floor a heading
// and a first sentence could differ entirely while both being the same file
// mid-load, so it declines to judge instead.
const SAME_DOCUMENT_CONTAINMENT = 0.35
const MIN_TOKENS_TO_JUDGE = 12

/**
 * Distinct words of five characters or more.
 *
 * The length filter is a cheap stopword filter. Nearly every English function
 * word — "the", "and", "that", "with", "this", "from", "have", "been" — is four
 * characters or fewer, and leaving them in makes any two English documents look
 * alike, which is the opposite of what this measure is for.
 */
function contentTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 5) out.add(word)
  }
  return out
}

/**
 * Fraction of the shorter text's vocabulary that also occurs in the longer one.
 *
 * Containment rather than Jaccard on purpose: typing, appending a paragraph and
 * deleting one all change the size of one side without changing how much of the
 * smaller side the larger one contains, so every editing operation scores near
 * 1. Two genuinely different documents score low no matter how their lengths
 * compare — which is exactly the case the previous length-delta test could not
 * see.
 */
function contentContainment(a: string, b: string): number {
  const setA = contentTokens(a)
  const setB = contentTokens(b)
  const smaller = setA.size <= setB.size ? setA : setB
  const larger = smaller === setA ? setB : setA
  // Too little to judge — report "same", since a false negative is the cheap
  // direction (see below).
  if (smaller.size < MIN_TOKENS_TO_JUDGE) return 1
  let shared = 0
  for (const word of smaller) if (larger.has(word)) shared++
  return shared / smaller.size
}

/**
 * Whether the watched *document* changed, or null if it looks like the same one.
 *
 * NOT "the text changed". The text-changed branch below is the typing path — it
 * is true on essentially every poll while someone writes, and claims are
 * designed to survive that and be re-located each tick. Clearing there would
 * wipe every underline on every keystroke.
 *
 * Two signals, both deliberately conservative. A false negative costs nothing:
 * the normal STABLE_MS/MIN_ANALYSIS_INTERVAL_MS path corrects it within ~24s.
 * A false positive collapses an open panel, kills an in-flight citation flow
 * (the renderer keys it by claim id, and re-detection mints new UUIDs) and
 * re-fires three four-provider searches.
 */
function documentChangeReason(processName: string, text: string): string | null {
  // The common real trigger, and free: Word -> Chrome with both allowlisted
  // previously kept Word's claims alive over the browser.
  if (lastDocumentKey !== null && lastDocumentKey !== processName) {
    return `process ${lastDocumentKey} -> ${processName}`
  }
  if (!pendingText) return null

  // Backstop for switching documents inside one app — Word to Word, or tab to
  // tab in one browser, where the process name is identical and cannot help.
  //
  // This used to require a shared prefix under 20% AND a length change of 200+
  // characters. The second condition is what made it miss: two documents of
  // similar length are the ordinary case, not the exotic one — two drafts of
  // the same essay, two tabs of the same site, page 2 and page 3 of anything —
  // and switching between them cleared neither test. The old claims and the
  // widget stayed live for the ~24s the slow path takes, and because
  // underlines are re-located each tick by FindText, any phrase the two
  // documents happened to share got underlined in the new one on the strength
  // of the old one's analysis.
  //
  // Vocabulary containment replaces both conditions and is independent of
  // length, so same-length switches are caught while in-place rewriting (which
  // keeps almost all of its vocabulary) is not.
  const shorter = Math.min(text.length, pendingText.length)
  if (shorter < 40) return null
  const containment = contentContainment(text, pendingText)
  if (containment >= SAME_DOCUMENT_CONTAINMENT) return null
  return `content diverged (${Math.round(containment * 100)}% shared vocabulary, ${pendingText.length} -> ${text.length} chars)`
}

async function tick(): Promise<void> {
  if (!enabled || ticking) return
  ticking = true
  // Sampled BEFORE the await, so the result can be checked against the world
  // it was requested in rather than the one it arrives in.
  const generationAtTickStart = trackingGeneration
  try {
    const snapshot = await takeUiaSnapshot(currentSpans)

    // PowerShell takes hundreds of milliseconds, and the user can turn Screen
    // Watch off inside that window. `stopScreenWatch` clears the timer, but it
    // cannot stop a tick that is already awaiting — and because `enabled` is
    // then false, the `finally` below does not reschedule, so nothing would
    // ever run again to take these underlines down. They would stay drawn over
    // every application, at screen-saver level, until the feature was switched
    // back on. See tickGuard.ts.
    const decision = tickDecision({
      enabled,
      generationAtStart: generationAtTickStart,
      generationNow: trackingGeneration
    })
    if (decision === 'clear') {
      clearOverlay()
      return
    }
    if (decision === 'discard') return

    if (!snapshot.ok) {
      lastError = snapshot.error

      // This branch used to return without hiding or resetting anything, with
      // no counter — and a closing window is exactly what produces it, since
      // FocusedElement keeps handing back a dying element until focus settles.
      // So the previous document's underlines stayed on screen unbounded while
      // the status UI simultaneously reported "not active".
      //
      // Asymmetric on purpose. Hiding is free and one tick undoes it. Resetting
      // costs STABLE_MS + MIN_ANALYSIS_INTERVAL_MS (24s), a relay call and
      // three four-provider searches, so it waits for more evidence. And
      // hiding at the first failure would reintroduce the blink that
      // useStableUnderlines exists to suppress.
      snapshotFailures++
      logScreenWatch(`snapshot failed (${snapshotFailures} in a row): ${snapshot.error}`)
      if (snapshotFailures >= HIDE_AFTER_FAILURES) clearOverlay()
      // `===` not `>=`: fire the expensive half exactly once.
      if (snapshotFailures === RESET_AFTER_FAILURES) resetTrackingState()

      emitStatus({
        enabled,
        active: false,
        processName: null,
        supportsUnderlines: false,
        claimCount: 0,
        lastError,
        authRequired,
        blockedApp: null
      })
      return
    }
    // Any ok:true snapshot counts as a recovery, including a skip — a skip is
    // a successful read of a target we don't want, not a failed read.
    snapshotFailures = 0

    if (snapshot.skip) {
      // Logged only on change, not every tick — "not-editable-control-type"
      // in particular would otherwise spam the log constantly while just
      // browsing a normal webpage.
      if (snapshot.reason !== lastSkipReason) {
        lastSkipReason = snapshot.reason
        logScreenWatch(
          `skipping (${snapshot.reason}) on ${'processName' in snapshot ? (snapshot.processName ?? 'unknown') : 'unknown'}`
        )
      }
      clearOverlay()
      resetTrackingState()
      emitStatus({
        enabled,
        active: false,
        processName: 'processName' in snapshot ? (snapshot.processName ?? null) : null,
        supportsUnderlines: false,
        claimCount: 0,
        lastError,
        authRequired,
        blockedApp: null
      })
      return
    }
    lastSkipReason = null

    if (!isProcessAllowed(snapshot.processName)) {
      // Not an error — the user just hasn't allowed this app. Bail out
      // before any text ever reaches detectClaims: this is the actual
      // token-usage and privacy boundary, not just a UI filter.
      clearOverlay()
      resetTrackingState()
      logScreenWatch(`focused app ${snapshot.processName} is not on the allowed list, skipping`)
      emitStatus({
        enabled,
        active: false,
        processName: null,
        supportsUnderlines: false,
        claimCount: 0,
        lastError,
        authRequired,
        blockedApp: snapshot.processName
      })
      return
    }

    // Claims from one document must not stay live over another. Placed after
    // the allowlist gate and before the pendingText bookkeeping below, which
    // also makes it automatically Tracer-safe: the `skip: "self"` freeze
    // returns long before this, so none of it runs while Tracer has focus.
    const documentChange = documentChangeReason(snapshot.processName, snapshot.text)
    if (documentChange) {
      logScreenWatch(
        `different document (${documentChange}) — dropping ${currentClaims.length} claim(s)`
      )
      clearOverlay()
      resetTrackingState()
    }
    lastDocumentKey = snapshot.processName

    if (snapshot.text !== pendingText) {
      // Text that was ALREADY THERE when we arrived is not being typed, so it
      // does not need the typing debounce.
      //
      // STABLE_MS exists because 1200ms is the pause between words, and someone
      // drafting clears that bar dozens of times a paragraph. None of that
      // applies to the first thing seen after a tracking reset: a document
      // switched to with a page of text in it was written before Screen Watch
      // looked at it, and waiting four seconds for it to "settle" is waiting for
      // something that already finished. Owner, 2026-08-20: underlines *"should
      // appear right as I enter the document."*
      //
      // The length test is what separates the two cases, and it has to be on
      // the FIRST snapshot specifically. Typing into an empty control arrives
      // one keystroke at a time, so its first snapshot is short and falls
      // through to the normal debounce — which is what must happen, because
      // firing there would analyse half a sentence and then take the 20s floor,
      // locking out the real one.
      const preexisting = isPreexistingText(awaitingFirstSight, snapshot.text)
      awaitingFirstSight = false
      pendingText = snapshot.text
      // Backdated, not zero: every other guard below (the delta test, the
      // analysis-interval floor, the retry cooldown) still applies unchanged.
      // This says "already stable", not "analyse regardless".
      //
      // It still costs one more tick — the analysis branch is the `else` of
      // this one, so it fires on the NEXT poll once the text reads the same
      // twice. That is worth keeping rather than routing around: two matching
      // reads is also what rules out a torn snapshot mid-repaint. So this turns
      // a ~5.2s wait into a ~1.2s one, not into zero.
      pendingSince = preexisting ? Date.now() - STABLE_MS : Date.now()
      logScreenWatch(
        `text changed on ${snapshot.processName} (len ${pendingText.length}, ` +
          `preexisting=${preexisting}, supportsTextPattern=${snapshot.supportsTextPattern})`
      )
    } else if (
      pendingText.trim().length >= MIN_TEXT_LENGTH &&
      pendingText !== lastAnalyzedText &&
      hasMeaningfulDelta(pendingText, lastAnalyzedText) &&
      Date.now() - pendingSince >= STABLE_MS &&
      Date.now() - lastAnalysisAt >= MIN_ANALYSIS_INTERVAL_MS &&
      Date.now() >= retryAfter &&
      !detecting
    ) {
      detecting = true
      lastAnalysisAt = Date.now()
      const textAtRequestTime = pendingText
      const generationAtRequestTime = trackingGeneration
      logScreenWatch(`text stable, triggering detectClaims (len ${textAtRequestTime.length})`)
      detectClaims(textAtRequestTime)
        .then((detected) => {
          if (trackingGeneration !== generationAtRequestTime) {
            logScreenWatch(
              `discarding detectClaims result: tracking reset while it was in flight ` +
                `(gen ${generationAtRequestTime} -> ${trackingGeneration})`
            )
            return
          }
          // Only mark this text "done" on success — a failure must stay
          // retryable rather than being silently marked as already-tried.
          lastAnalyzedText = textAtRequestTime
          const confident = detected.filter((c) => c.confidence >= getMinClaimConfidence())
          currentClaims = confident.map(synthesizeClaim)
          lastError = null
          authRequired = false
          logScreenWatch(
            `detected ${detected.length} claim(s), ${confident.length} above confidence threshold: ` +
              `${currentClaims.map((c) => JSON.stringify(c.text)).join(', ')}`
          )
          // Compute spans against the text we just analyzed *now*, rather
          // than leaving currentSpans at whatever they were before this
          // detection (usually empty). Without this, the immediate redraw
          // below asks the OS for bounding rects using stale/empty offsets,
          // draws nothing, and only catches up a full poll cycle later.
          const freshSpans = computeClaimSpans(textAtRequestTime, currentClaims)
          currentSpans = freshSpans.map((s) => ({ id: s.claim.id, start: s.start, length: s.end - s.start }))
          // Fresh claim set → any evidence/critique/citation from the
          // previous one no longer applies to anything currently shown.
          evidenceResultByClaimId = new Map()
          critiqueByClaimId = new Map()
          findSourceResultByClaimId = new Map()
          citationByClaimId = new Map()
          // Free and local, so it runs on the same automatic footing as the
          // evidence search above rather than waiting to be asked.
          refreshWatchOutline()
          triggerEvidenceSearch(currentClaims)
          // Don't wait for the next scheduled poll tick to show results —
          // that adds up to POLL_INTERVAL_MS of dead time on top of the
          // relay round-trip for no reason.
          void tick()
        })
        .catch((err) => {
          // A failure from a discarded generation must not put a cooldown on
          // the document now being watched, nor report its error as current.
          if (trackingGeneration !== generationAtRequestTime) return
          retryAfter = Date.now() + RETRY_COOLDOWN_MS
          lastError = err instanceof Error ? err.message : String(err)
          // A 401 is not a transient fault to retry past — it will keep failing
          // until the user signs in, and it is the failure they can actually
          // do something about. Flagged so the UI can say so rather than
          // silently underlining nothing, which is indistinguishable from the
          // app being slow.
          authRequired = isAuthError(err)
          logScreenWatch(`detectClaims failed${authRequired ? ' (auth)' : ''}: ${lastError}`)
        })
        .finally(() => {
          detecting = false
        })
    }

    // Locate claims within THIS tick's text ourselves — via the same fuzzy
    // matching the Live tab uses — rather than asking UIA's FindText to
    // search for the AI's claim text, which is frequently not an exact
    // substring (see the note atop resources/uia-watch.ps1). The resulting
    // offsets are sent up on the *next* tick's snapshot request.
    const claimSpans = computeClaimSpans(snapshot.text, currentClaims)
    currentSpans = claimSpans.map((s) => ({ id: s.claim.id, start: s.start, length: s.end - s.start }))

    if (currentClaims.length > 0) {
      logScreenWatch(
        `provider layout check: wholeDocRects=${snapshot.wholeDocRectCount ?? '?'} ` +
          `visibleRanges=${snapshot.visibleRangeCount ?? '?'} visibleRangeRects=${snapshot.visibleRangeRectCount ?? '?'}`
      )
      logScreenWatch(
        `located ${claimSpans.length}/${currentClaims.length} claim(s) in text this tick; ` +
          `claimRects from snapshot: ${snapshot.claimRects
            .map(
              (r) =>
                `${r.id.slice(0, 8)}=${r.rects.length}/${r.rawRectCount ?? '?'}rect(s) ` +
                `rangeText=${JSON.stringify(r.rangeTextPreview ?? null)} ` +
                `moveError=${r.moveError ?? 'none'} scrollError=${r.scrollError ?? 'none'} rectError=${r.rectError ?? 'none'}`
            )
            .join(' | ')}`
      )
    }

    updateOverlayAndWidget(
      snapshot.windowRect,
      snapshot.controlRect ?? null,
      snapshot.claimRects,
      currentClaims,
      snapshot.text
    )

    emitStatus({
      enabled,
      active: true,
      processName: snapshot.processName,
      supportsUnderlines: snapshot.supportsTextPattern,
      claimCount: currentClaims.length,
      lastError,
      authRequired,
      blockedApp: null
    })
  } finally {
    ticking = false
    if (enabled) timer = setTimeout(tick, POLL_INTERVAL_MS)
  }
}

// Fixed distance from the focused window's bottom-right corner — matches
// where the Figma mockups place it, and (deliberately) has nothing to do
// with where the focused control or text cursor currently is.
const EDGE_MARGIN = 24
let lastSentPayloadKey: string | null = null

function redrawOverlay(): void {
  if (!lastUpdateInputs) return
  updateOverlayAndWidget(
    lastUpdateInputs.windowRect,
    lastUpdateInputs.controlRect,
    lastUpdateInputs.claimRects,
    lastUpdateInputs.claims,
    lastUpdateInputs.fullText
  )
}

// Top 3 by rank, not the full result set — enough for the overlay to show
// real article titles instead of just a count, without ballooning the
// payload that gets re-sent on every overlay-update.
const MAX_ARTICLES_IN_OVERLAY = 3

// Favicon lookups are async (a real network call, see search/favicon.ts)
// but leanEvidence itself has to stay synchronous — it's read on every
// redrawOverlay(), which nothing downstream awaits. So this is a
// fire-and-forget-then-redraw cache: the first time a URL is seen its
// favicon returns null immediately (fetch kicked off in the background),
// and once that resolves a fresh redraw picks up the real image. Reset
// per-session like every other per-run map (favicons are cheap enough to
// just refetch next run rather than persist across restarts).
let faviconByUrl = new Map<string, string | null>()
let faviconFetchInFlight = new Set<string>()

function ensureFaviconsFor(urls: (string | null)[]): void {
  for (const url of urls) {
    if (!url || faviconByUrl.has(url) || faviconFetchInFlight.has(url)) continue
    faviconFetchInFlight.add(url)
    getFaviconDataUrl(url)
      .then((dataUrl) => {
        faviconByUrl.set(url, dataUrl)
        redrawOverlay()
      })
      .finally(() => {
        faviconFetchInFlight.delete(url)
      })
  }
}

function leanEvidence(claimId: string): ScreenWatchClaimEvidence | null {
  const result = evidenceResultByClaimId.get(claimId)
  if (!result) return null
  ensureFaviconsFor(result.evidence.slice(0, MAX_ARTICLES_IN_OVERLAY).map((item) => item.url))
  return {
    score: result.score,
    count: result.evidence.length,
    breakdown: result.breakdown,
    articles: result.evidence.slice(0, MAX_ARTICLES_IN_OVERLAY).map((item) => ({
      title: item.title,
      venue: item.venue,
      year: item.year,
      faviconDataUrl: item.url ? (faviconByUrl.get(item.url) ?? null) : null,
      provider: item.provider,
      url: item.url
    }))
  }
}

// Stable id for a search result within one claim's result set — same
// derivation synthesizeEvidenceItem always used, now also doubling as the
// "sourceRef" the citation flow's IPC responses hand back to the renderer
// and expect returned on insertCitationForClaim, since these results are
// never persisted through sourcesRepo (no real database id exists to use).
function sourceRefFor(item: NormalizedSourceResult, rank: number): string {
  return item.doi ?? item.providerId ?? `${item.provider}:${rank}`
}

// generateCritique and formatCitation/formatInTextCitation only ever read
// plain fields off a Source (title/abstract/authors/year/venue) — building
// one here (rather than persisting these ephemeral, never-saved search
// results through sourcesRepo just to get a real id) is safe precisely
// because nothing downstream needs a real database-backed id for a claim's
// evidence to be critiqued or cited correctly.
function synthesizeSourceFromResult(item: NormalizedSourceResult, rank: number): Source {
  return {
    id: sourceRefFor(item, rank),
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
    createdAt: new Date().toISOString()
  }
}

function synthesizeEvidenceItem(item: NormalizedSourceResult, rank: number): EvidenceItem {
  const source = synthesizeSourceFromResult(item, rank)
  // Stance is null rather than carried across: this synthesises an
  // EvidenceItem from a raw provider result that was never scored against a
  // specific claim, so there is no verdict to report and asserting one would
  // be inventing it.
  return {
    source,
    relevanceScore: 1 - rank / Math.max(1, item.relevanceRank + 1),
    rank,
    stance: null,
    stanceConfidence: null
  }
}

// Looks a citation-flow sourceRef back up across both places a result could
// have come from: the focused "Find a source" search, or the background
// auto-search's broader result set (when the user clicked "Add citation"
// straight from evidence that was already on hand).
function resolveSourceRef(claimId: string, sourceRef: string): NormalizedSourceResult | null {
  const pools = [findSourceResultByClaimId.get(claimId) ?? [], evidenceResultByClaimId.get(claimId)?.evidence ?? []]
  for (const pool of pools) {
    const idx = pool.findIndex((item, i) => sourceRefFor(item, i) === sourceRef)
    if (idx !== -1) return pool[idx]
  }
  return null
}

// Fired once per fresh claim set, right after detection — free public APIs
// (OpenAlex/Crossref/Semantic Scholar/PubMed, already rate-limited per
// provider in rateLimiter.ts), not the paid relay, so running this
// automatically for passive background reading doesn't add API cost the way
// auto-running claim detection/critique would. Each claim's result lands in
// evidenceResultByClaimId independently and triggers its own redraw as soon
// as it's ready, rather than waiting for every claim's search to finish.
function triggerEvidenceSearch(claims: Claim[]): void {
  // Every claim here costs four provider searches, so a full set of 8 fired
  // 32 HTTP requests per detection, unprompted, for claims the user may
  // never look at. That is the main reason Semantic Scholar answers 429 —
  // its unauthenticated tier is a shared global pool. Claims arrive sorted
  // by confidence, so the top few are the ones most likely to be opened;
  // the rest search on demand via refreshEvidenceForClaim when the user
  // actually hovers one.
  for (const claim of claims.slice(0, MAX_AUTO_EVIDENCE_CLAIMS)) {
    findEvidenceCached(claim.searchQuery, claim.text)
      .then((result) => {
        // The claim set may have moved on (text changed again, focus moved
        // to a different app) by the time this resolves — a result for a
        // claim that's no longer current would only show stale data.
        if (!currentClaims.some((c) => c.id === claim.id)) return
        evidenceResultByClaimId.set(claim.id, {
          evidence: result.evidence,
          score: result.score,
          breakdown: result.breakdown
        })
        // Coverage and the unsupported-claim weakness both turn on whether a
        // claim has a relevant source, so evidence landing changes the reading.
        refreshWatchOutline()
        redrawOverlay()
      })
      .catch((err) => {
        logScreenWatch(`background evidence search failed for claim ${claim.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
      })
  }
}

/*
 * There is deliberately no automatic critique here.
 *
 * A bounded one — a single relay call per detection, spent on the first of the
 * top claims whose evidence resolved — was built and shipped to the beta
 * channel, then pulled before the first stable release that would have carried
 * it. Screen Watch is passive and always-on, so it is the one surface where an
 * unprompted call to the *paid* relay is a bill the user did not ask for and
 * cannot see being run up. Evidence search stays automatic because it only hits
 * the four free public APIs; critique does not, and that is the whole line.
 *
 * The known cost, which is real and should not be rediscovered as a bug:
 * `problemKindFor` reports "Weak reasoning" only when `critiqueVerdict` is set,
 * and critique now only ever runs from an explicit click on "Critique Argument"
 * (see `critiqueClaim`). So passive watching can report on citations and
 * evidence, but never on reasoning, until the user asks. Everything needed to
 * change that is still here — `synthesizeEvidenceItem`, `withEvidenceScores`
 * and the evidence map all remain — so putting it back behind an opt-in
 * Settings toggle is a small change, and is the shape it should return in.
 *
 * `git log` has the implementation.
 */

// User-initiated re-run of evidence search for one claim (the overlay's
// "Find Evidence"/"Refresh Evidence" button) — same search as
// triggerEvidenceSearch, just for a single claim on demand instead of the
// whole set automatically.
export async function refreshEvidenceForClaim(claimId: string): Promise<ScreenWatchClaimEvidence | null> {
  const claim = currentClaims.find((c) => c.id === claimId)
  if (!claim) return null
  const result = await findEvidenceCached(claim.searchQuery, claim.text)
  if (!currentClaims.some((c) => c.id === claimId)) return null
  evidenceResultByClaimId.set(claimId, {
    evidence: result.evidence,
    score: result.score,
    breakdown: result.breakdown
  })
  // The critique was an argument ABOUT the evidence that just got replaced —
  // it cites its sources by number ("supported by evidence 2", per
  // CRITIQUE_SYSTEM_PROMPT), and those numbers now point into a different
  // list. Keeping it left the panel showing a fresh source list beside a
  // verdict reasoned over the old one, and `problemKindsFor` reporting "weak
  // reasoning" on grounds nothing on screen still supports. Dropping it puts
  // the claim back to offering "Critique Argument", which is the truth.
  if (critiqueByClaimId.delete(claimId)) {
    logScreenWatch(`dropped stale critique for ${claimId.slice(0, 8)} — its evidence was refreshed`)
  }
  refreshWatchOutline()
  redrawOverlay()
  return leanEvidence(claimId)
}

/**
 * Recompute the structural read if anything it depends on has moved.
 *
 * The key is deliberately the three things the outline is a function of: the
 * analyzed text, which claims were found in it, and which of those now have a
 * relevant source (coverage and the `unsupported-claim` weakness both turn on
 * that, and evidence arrives asynchronously well after detection). Anything
 * finer — a timestamp, an evidence count — would rebuild the object without
 * changing what it says, and cost the payload dedupe.
 */
function refreshWatchOutline(): void {
  if (!lastAnalyzedText) {
    watchStructure = null
    return
  }

  const sourced = currentClaims
    .map((claim) => `${claim.id}:${(evidenceResultByClaimId.get(claim.id)?.breakdown.sourceCount ?? 0) > 0 ? 1 : 0}`)
    .sort()
    .join(',')
  const key = `${sourceHashFor(lastAnalyzedText)}|${currentClaims.map((c) => c.id).join(',')}|${sourced}`
  if (watchStructure?.key === key) return

  const structure = computeWatchOutline({
    analyzedText: lastAnalyzedText,
    claims: currentClaims.map(withEvidenceScores),
    analyzedAt: new Date().toISOString()
  })
  watchStructure = { key, structure }
  if (structure) {
    logScreenWatch(
      `structure: ${structure.score}/100${structure.complete ? '' : ' (provisional)'}, ` +
        `${structure.paragraphs.length} paragraph(s), ${structure.weaknesses.length} weakness(es)`
    )
  }
}

/**
 * A Screen Watch claim with whatever its evidence search found folded in.
 *
 * Screen Watch claims are synthesized in memory with `strengthScore: null` and
 * no breakdown, because nothing here is ever written to the claims table. Any
 * consumer that expects a scored `Claim` — `generateCritique`, and structure's
 * `computeEvidenceCoverage` — has to be handed this instead of the raw claim.
 *
 * BOTH fields, deliberately. `computeEvidenceCoverage` decides "has a relevant
 * source" from `scoreBreakdown.sourceCount`, not from `strengthScore`, so
 * folding only the score marks a claim resolved-but-unsourced and produces an
 * "unsupported claim" weakness for every claim that actually has sources.
 */
function withEvidenceScores(claim: Claim): Claim {
  const evidence = evidenceResultByClaimId.get(claim.id)
  return {
    ...claim,
    strengthScore: evidence?.score ?? null,
    scoreBreakdown: evidence?.breakdown ?? null
  }
}

/**
 * The work this claim's sentence already cites — the left-hand side of the
 * overlay's "Compare sources".
 *
 * Returns null rather than throwing when the claim has aged out. A comparison
 * that cannot be drawn is a card with one list in it, which is what it was
 * before; a thrown error would take the source list down with it.
 *
 * Free: Crossref and Open Library, no relay. That is what makes it safe to run
 * from a passive surface at all — the rule Screen Watch lives by is that
 * nothing here spends money without being asked.
 */
async function resolveCitedForClaim(claimId: string): Promise<ResolvedCitedWork | null> {
  const claim = currentClaims.find((c) => c.id === claimId)
  if (!claim) return null
  const span = computeClaimSpans(lastAnalyzedText, [claim])[0]
  const sentence = span ? sentenceAround(lastAnalyzedText, span.start, span.end) : claim.text
  try {
    return resolveCitedWork(await checkReferences(sentence, lastAnalyzedText))
  } catch (error) {
    console.warn(
      `[screenWatch] cited-work lookup failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  }
}

/**
 * "Find the cited work" from the overlay: records that look like what this
 * claim's sentence cites.
 *
 * Free and user-triggered — Crossref and Open Library, the same two indexes
 * `resolveCitedForClaim` above asks — so it is allowed on this passive surface
 * for the same reason that one is. The critique's `citationFix`, when a
 * critique has run, rides along as one more query string; it is never shown.
 *
 * Refuses rather than guesses when the sentence carries two citations: there
 * is no telling which one the card is about. The overlay then says so.
 */
export async function findCitedWorkForClaim(claimId: string): Promise<ScreenWatchFindCitedWorkResponse> {
  const empty = (target: ScreenWatchFindCitedWorkResponse['target']): ScreenWatchFindCitedWorkResponse => ({
    target,
    citation: '',
    entry: null,
    citedYear: null,
    candidates: [],
    searched: false
  })
  const claim = currentClaims.find((c) => c.id === claimId)
  if (!claim) throw new Error('This claim is no longer being tracked (the watched text likely changed).')
  const span = computeClaimSpans(lastAnalyzedText, [claim])[0]
  const sentence = span ? sentenceAround(lastAnalyzedText, span.start, span.end) : claim.text
  const defect = findCitationDefects(sentence)[0] ?? null
  const target = citationTarget(sentence, defect?.text ?? null)
  if (target.status !== 'one') return empty(target.status)
  const result = await findCitedWork({
    citation: target.text,
    documentText: lastAnalyzedText,
    hint: critiqueByClaimId.get(claimId)?.citationFix ?? null
  })
  return { ...result, target: 'one' }
}

/** Both halves of the comparison, in one round trip from the overlay. */
export async function findSourceWithCited(
  claimId: string,
  query?: string
): Promise<{ candidates: ScreenWatchSourceCandidate[]; cited: ResolvedCitedWork | null }> {
  // In parallel: the lookup is two unmetered HTTP requests and the search is
  // already the slow half, so the comparison costs nothing in wall clock.
  const [candidates, cited] = await Promise.all([
    findSourceForClaim(claimId, query),
    resolveCitedForClaim(claimId)
  ])
  return { candidates, cited }
}

// User-initiated only (the overlay's "Check Claim" button) — unlike
// evidence search this hits the paid relay, so it never runs automatically
// for passive background reading.
export async function critiqueClaim(claimId: string): Promise<CritiqueResult> {
  const claim = currentClaims.find((c) => c.id === claimId)
  if (!claim) throw new Error('This claim is no longer being tracked (the watched text likely changed).')
  const evidence = evidenceResultByClaimId.get(claimId)
  const evidenceItems = evidence ? evidence.evidence.map((item, i) => synthesizeEvidenceItem(item, i)) : []
  // The claim's SENTENCE, so the reference check can see a citation the claim
  // span stops short of — the relay returns the assertion and ends before the
  // "(Minges & Redeker, 2016)" that follows it. Same widening, and the same
  // reason, as hasInlineCitationNear above. Falls back to the claim text when
  // the span cannot be located, which is what generateCritique defaults to.
  const span = computeClaimSpans(lastAnalyzedText, [claim])[0]
  const sentence = span ? sentenceAround(lastAnalyzedText, span.start, span.end) : undefined
  // The watched text entire, for a numbered or MLA citation whose reference
  // list sits at the end of the document rather than near the claim. Screen
  // Watch sees whatever is on screen, so the list may not be captured at all —
  // in which case the marker simply goes unchecked, as it did before.
  const result = await generateCritique(
    withEvidenceScores(claim),
    evidenceItems,
    sentence,
    lastAnalyzedText
  )
  if (currentClaims.some((c) => c.id === claimId)) {
    critiqueByClaimId.set(claimId, result)
    redrawOverlay()
  }
  return result
}

// Ranked candidates for one claim, capped so the picker stays scannable —
// this is deliberately smaller/more curated than Refresh Evidence's list.
const MAX_FIND_SOURCE_CANDIDATES = 5
// Mirrors PER_PROVIDER_LIMIT in search/scoring.ts — that constant isn't
// exported (it's an internal tuning knob for the whole-claim strength
// score), so it's duplicated here for the same per-item rank-relevance
// blend, applied to a single claim's candidate list rather than the whole
// evidence set.
const RANK_RELEVANCE_LIMIT = 6

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

// The focused, single-claim search behind the overlay's "Find a source"
// action — same cached evidence lookup Refresh Evidence already uses, but with a
// per-item match % (the same text-relevance/rank blend computeStrengthScore
// uses internally for the whole claim, just surfaced per candidate here)
// so the user can pick one specific source to cite instead of browsing a
// plain list. `query` overrides the claim's own searchQuery for the
// picker's "search again" box.
export async function findSourceForClaim(claimId: string, query?: string): Promise<ScreenWatchSourceCandidate[]> {
  const claim = currentClaims.find((c) => c.id === claimId)
  if (!claim) return []
  const result = await findEvidenceCached(query ?? claim.searchQuery, claim.text)
  if (!currentClaims.some((c) => c.id === claimId)) return []
  findSourceResultByClaimId.set(claimId, result.evidence)

  const ranked = result.evidence
    .map((item, i) => {
      // The aggregator's own figure, not a re-derivation. It recomputed word
      // overlap here, which now disagrees with how the results were actually
      // ranked: findEvidence scores candidates by embedding similarity when
      // the model is available, so recomputing coverage would show the user a
      // match % for a metric that had no part in choosing or ordering these.
      const textRelevance = item.textRelevance
      const rankRelevance = clamp01(1 - item.relevanceRank / RANK_RELEVANCE_LIMIT)
      const matchPercent = Math.round(100 * clamp01(0.75 * textRelevance + 0.25 * rankRelevance))
      return { item, sourceRef: sourceRefFor(item, i), matchPercent }
    })
    .sort((a, b) => b.matchPercent - a.matchPercent)
    .slice(0, MAX_FIND_SOURCE_CANDIDATES)

  // Unlike leanEvidence's fire-and-forget favicon lookups (fine there since
  // widget.claims re-pushes on every redraw), this response is a one-shot
  // IPC reply the renderer stores directly — there's no later redraw that
  // would pick up a favicon that resolved after the fact. So this awaits
  // the (small, capped, timeout-bounded) fetch for just the final top-N
  // candidates before returning, rather than returning null placeholders.
  const candidates: ScreenWatchSourceCandidate[] = await Promise.all(
    ranked.map(async ({ item, sourceRef, matchPercent }) => ({
      sourceRef,
      title: item.title,
      venue: item.venue,
      year: item.year,
      provider: item.provider,
      url: item.url,
      matchPercent,
      faviconDataUrl: await getFaviconDataUrl(item.url),
      credibility: credibilityOf({
        url: item.url,
        venue: item.venue,
        venueType: item.venueType,
        doi: item.doi
      }),
      // For the receipts the overlay asks for once this list is on screen
      // (sources:verify). Carried, not fetched: the search already returned
      // them, and nothing is sent anywhere until the writer has opened the
      // list. shared/sourceReceipts.ts decides whether the abstract is the
      // work's own words before it leaves the machine.
      doi: item.doi,
      abstract: item.abstract
    }))
  )
  // Most citable first, the same order the editor's picker uses. Stable, so
  // the match percentage still decides within a tier.
  return byCredibility(candidates, (c) => c.credibility.tier)
}

/**
 * The "Preview" button beside "Insert citation" — the same two formatted forms
 * insertCitationForClaim would write, without writing anything.
 *
 * Everything here is the pure half of that function: no UIA write-back, no
 * `currentSpans` lookup and no `citationByClaimId` entry, so previewing leaves
 * the claim exactly as flagged as it was. It deliberately does NOT require the
 * claim to still be locatable in the document (insert does, and says so) — you
 * can read what a citation would look like even in a moment where the text has
 * shifted under Tracely and the insert would have to be retried.
 */
export function previewCitationForClaim(
  claimId: string,
  sourceRef: string,
  style: CitationStyle
): ScreenWatchClaimCitation {
  const item = resolveSourceRef(claimId, sourceRef)
  if (!item) throw new Error('That source is no longer available — try searching again.')
  const source = synthesizeSourceFromResult(item, 0)
  return {
    inTextCitation: formatInTextCitation(source, style),
    worksCitedEntry: formatCitation(source, style)
  }
}

// The overlay's "Insert citation" action — formats both citation forms from
// the chosen candidate (never touching sourcesRepo/citationsRepo, same
// ephemeral rule as the rest of Screen Watch) and types the in-text form
// into the watched external document right after the claim's current text,
// via the new UIA write-back in uiaSnapshot.ts.
export async function insertCitationForClaim(
  claimId: string,
  sourceRef: string,
  style: CitationStyle
): Promise<ScreenWatchClaimCitation> {
  const claim = currentClaims.find((c) => c.id === claimId)
  if (!claim) throw new Error('This claim is no longer being tracked (the watched text likely changed).')

  const item = resolveSourceRef(claimId, sourceRef)
  if (!item) throw new Error('That source is no longer available — try searching again.')

  const source = synthesizeSourceFromResult(item, 0)
  const worksCitedEntry = formatCitation(source, style)
  const inTextCitation = formatInTextCitation(source, style)

  const span = currentSpans.find((s) => s.id === claimId)
  if (!span) throw new Error('Could not locate this claim in the document anymore — try again.')

  const fullText = lastUpdateInputs?.fullText ?? ''
  // Fail closed. uia-watch.ps1 skips the staleness check entirely when the
  // expected snippet is empty, so an empty fullText here meant inserting blind
  // at a possibly-stale offset rather than refusing.
  if (!fullText) throw new Error('Could not locate this claim in the document anymore — try again.')

  // Not `span.start + span.length`: that lands after the sentence's full stop,
  // which is what produced "…low weight. (Smith, 2020)".
  const { offset: insertOffset, prefix } = findCitationInsertPoint(fullText, span.start + span.length)
  // Must come from the ADJUSTED offset — comparing live text at the new offset
  // against a snippet taken from the old one makes uia-watch.ps1's staleness
  // check abort every insert with "the document changed since this claim was
  // located".
  const expectedSnippet = fullText.slice(insertOffset, insertOffset + 30)

  const result = await insertCitationText(insertOffset, `${prefix}${inTextCitation}`, expectedSnippet)
  if (!result.ok) throw new Error(result.error)

  const citation: ScreenWatchClaimCitation = { inTextCitation, worksCitedEntry }
  citationByClaimId.set(claimId, { ...citation, insertOffset })
  redrawOverlay()
  return citation
}

// "Undo" on the citation-added confirmation — a plain Ctrl+Z to whatever
// app is still focused. Reliable because insertCitationForClaim always
// performs exactly one paste, which is one undo step in effectively every
// real text editor/browser; Tracely doesn't need to track its own undo
// stack for this. Leaves the claim flagged again (removed from
// citationByClaimId) so the user can retry or pick a different source.
export async function undoCitationForClaim(claimId: string): Promise<void> {
  if (!citationByClaimId.has(claimId)) return
  const result = await undoLastInsert()
  if (!result.ok) throw new Error(result.error)
  citationByClaimId.delete(claimId)
  redrawOverlay()
}

function updateOverlayAndWidget(
  windowRect: ScreenRect,
  controlRect: ScreenRect | null,
  claimRects: { id: string; rects: ScreenRect[] }[],
  claims: Claim[],
  fullText: string
): void {
  // A snapshot may finish after the user has opened Tracely. Do not let that
  // stale external-window result re-show the screen-saver-level overlay over
  // main or the floating claim checker between their immediate focus handlers
  // and the next UIA poll.
  //
  // `focusedShieldableWindow()` rather than checking getMainWindow()/
  // getFloatingWindow() directly — that is the one-rule shield this branch
  // merged with, and duplicating its focus test here is exactly what it was
  // written to stop. `clearOverlay()` rather than `hideOverlay()`, because
  // hiding alone is what left stale underlines to be re-shown on the next
  // present; clearing the state with it is this branch's whole point.
  // Belt and braces with the guard in `tick`. This is the single function that
  // can put the overlay on screen, so a disabled watcher is refused here too
  // rather than trusting every caller to have checked.
  if (!enabled) {
    clearOverlay()
    return
  }

  const focused = focusedShieldableWindow()
  if (focused === 'main' || focused === 'floating') {
    clearOverlay()
    return
  }

  // A genuine change of target — a different app, or a resized window. NOT a
  // pure translation: dragging the watched window leaves every window-local
  // rect identical, so clearing there would blink the underlines on every move.
  const targetChanged =
    lastUpdateInputs !== null &&
    (lastUpdateInputs.windowRect.width !== windowRect.width ||
      lastUpdateInputs.windowRect.height !== windowRect.height)

  lastUpdateInputs = { windowRect, controlRect, claimRects, claims, fullText }

  // Clear BEFORE the window is moved or resized under the old content.
  if (targetChanged) clearOverlay()

  // Clip in physical pixels, on the single source both the drawn rects and the
  // hover hit-test region are derived from, so the two cannot disagree — an
  // unclipped rect hanging off the window edge used to be invisible and still
  // open a popover. controlRect is preferred because the window includes the
  // app's own toolbars, and text scrolled under a sticky header still reports a
  // valid rect that was then drawn on top of the header.
  /**
   * Is this claim's SENTENCE cited? Decided once, against the document.
   *
   * Was `hasInlineCitation(c.text)` at both call sites. A detected claim is a
   * sub-span of a sentence — the relay returns the assertion and stops before
   * the "(Author, Year)" that follows — so a properly cited sentence was
   * reported as uncited. `fullText` is already a parameter here, so the
   * surrounding sentence costs one span lookup.
   *
   * The fallback matters: computeClaimSpans drops claims it cannot locate (the
   * text moved on between the snapshot and now), and those keep the old
   * claim-only test rather than silently becoming uncited.
   */
  const citedById = new Map(
    computeClaimSpans(fullText, claims).map(
      (span) => [span.claim.id, isCitedInScope(fullText, span.start, span.end)] as const
    )
  )
  const isCited = (claim: Claim): boolean => citedById.get(claim.id) ?? hasInlineCitation(claim.text)

  /**
   * The claim's own SENTENCE, read for the two things the editor has always
   * passed and this surface never did: whether the sentence carries a citation
   * of its own (rather than being covered by one in its paragraph), and whether
   * that citation is visibly broken. Without them a "(Genghis Khan and the,
   * 2022)" could never reach the overlay as a mark, and the card could not tell
   * "find the work you cited" from "find a source".
   *
   * Both are free, local and decided from the text — nothing here calls
   * anything. Falls back to the claim's own text when its span cannot be
   * located, exactly as `isCited` does.
   */
  interface SentenceInfo {
    own: boolean
    defect: CitationDefect | null
    target: CitationTarget['status']
  }
  const readSentence = (sentence: string, own: boolean): SentenceInfo => {
    const defect = findCitationDefects(sentence)[0] ?? null
    return { own, defect, target: citationTarget(sentence, defect?.text ?? null).status }
  }
  const sentenceInfoById = new Map<string, SentenceInfo>()
  for (const span of computeClaimSpans(fullText, claims)) {
    sentenceInfoById.set(
      span.claim.id,
      readSentence(sentenceAround(fullText, span.start, span.end), hasInlineCitationNear(fullText, span.start, span.end))
    )
  }
  const sentenceInfo = (claim: Claim): SentenceInfo =>
    sentenceInfoById.get(claim.id) ?? readSentence(claim.text, hasInlineCitation(claim.text))

  /** Decided once here, so the underline and the card cannot disagree. */
  const problemKindById = new Map(
    claims.map((c) => {
      const evidence = evidenceResultByClaimId.get(c.id)
      const info = sentenceInfo(c)
      return [
        c.id,
        problemKindsFor({
          claimType: c.claimType,
          claimText: c.text,
          hasInlineCitation: isCited(c),
          hasOwnCitation: info.own,
          citationDefect: info.defect?.message ?? null,
          evidence: evidence
            ? {
                score: evidence.score,
                count: evidence.evidence.length,
                // NOT `evidence.evidence.length > 0`. The aggregator returns
                // its top eight for every claim regardless of whether any of
                // them are on topic, so the list length says how hard the
                // providers tried, not what they found.
                hasRelevantSource: hasRelevantSource(evidence.breakdown)
              }
            : null,
          critiqueVerdict: critiqueByClaimId.get(c.id)?.verdict ?? null,
          // The critique is kept in memory here rather than in SQLite, so the
          // flag comes straight off the result that carried the verdict.
          citedWorkRead: critiqueByClaimId.get(c.id)?.citedWorkRead ?? null,
          outOfIndexScope: retrievalScopeFor(c.text)
        })
      ] as const
    })
  )

  /**
   * Claims with nothing to say about them, which are not drawn at all.
   *
   * Read straight off `problemKindsFor` rather than re-tested here. It used to
   * be its own predicate — cited AND scoring at least 70 — which
   * meant two functions decided whether a sentence was worth interrupting
   * someone about, on different rules, and the gap between them was where a
   * cited claim the databases had no opinion on ended up flagged. One function
   * owns the judgement now; an empty list is its way of saying "nothing".
   */
  const settled = new Set(
    claims.filter((c) => (problemKindById.get(c.id) ?? ['searching']).length === 0).map((c) => c.id)
  )
  if (settled.size > 0) {
    logScreenWatch(
      `not flagging ${settled.size} claim(s) with nothing to report: ` +
        claims
          .filter((c) => settled.has(c.id))
          .map((c) => `${inlineCitationKind(c.text)}/${evidenceResultByClaimId.get(c.id)?.score ?? '-'}`)
          .join(', ')
    )
  }

  const clip = resolveClip([controlRect, windowRect])
  const underlines = (Array.isArray(claimRects) ? claimRects : [])
    .filter((r) => !settled.has(r.id))
    .map((r) => ({
      ...r,
      rects: !Array.isArray(r.rects)
        ? []
        : clip
          ? r.rects.map((rect) => clipUnderline(rect, clip)).filter((x): x is ScreenRect => x !== null)
          : r.rects
    }))
    .filter((r) => r.rects.length > 0)

  if (underlines.length === 0 && claims.length > 0) {
    logScreenWatch(`${claims.length} claim(s) tracked but none located on screen (off-screen or no match)`)
  }

  const center = {
    x: windowRect.x + windowRect.width / 2,
    y: windowRect.y + windowRect.height / 2
  }
  const display = screen.getDisplayNearestPoint(center)

  // UI Automation returns physical screen pixels; Electron window bounds are
  // logical (DPI-scaled) pixels. On anything other than 100% display scaling
  // (125%/150% are the common Windows defaults on modern laptops) these are
  // different units — divide by scaleFactor or every rect lands in the wrong
  // place. This assumes the display's physical top-left aligns with its
  // logical (0,0), which holds for the primary display; a true secondary-
  // display-with-different-scale fix would need each display's physical
  // origin, which Electron doesn't expose — still a known gap for that
  // specific case.
  const scale = display.scaleFactor || 1
  const windowLogical = {
    x: windowRect.x / scale,
    y: windowRect.y / scale,
    width: windowRect.width / scale,
    height: windowRect.height / scale
  }
  lastOverlayOrigin = { x: windowLogical.x, y: windowLogical.y }

  // The overlay is sized to the focused app's own window, not the whole
  // display — the OS clips anything drawn outside a window's own bounds for
  // free, which is what keeps underlines/the widget confined to whichever
  // app is actually focused instead of "leaking" across the rest of the
  // screen. The widget badge (see hoverTracking.ts / OverlayApp.tsx) shows
  // whenever a supported text field is focused — like Grammarly's icon —
  // independent of whether any claims were found yet, so the overlay stays
  // shown for that even with zero underlines.
  // Positioned only. Showing happens at the very end, after the payload
  // describing this window has actually been sent — moving and showing in one
  // call painted the previous document's rects against the new window's origin
  // for one IPC hop.
  const win = positionOverlayWindow({
    x: Math.round(windowLogical.x),
    y: Math.round(windowLogical.y),
    width: Math.max(1, Math.round(windowLogical.width)),
    height: Math.max(1, Math.round(windowLogical.height))
  })

  const toLocal = (r: ScreenRect): ScreenRect => ({
    x: r.x / scale - windowLogical.x,
    y: r.y / scale - windowLogical.y,
    width: r.width / scale,
    height: r.height / scale
  })
  const toAbsolute = (r: ScreenRect): ScreenRect => ({
    x: r.x / scale,
    y: r.y / scale,
    width: r.width / scale,
    height: r.height / scale
  })

  const localized = underlines.map((u) => ({
    id: u.id,
    rects: u.rects.map(toLocal),
    claimType: claims.find((c) => c.id === u.id)?.claimType ?? 'factual',
    problemKinds: problemKindById.get(u.id) ?? ['searching']
  }))

  // Anchored to a fixed corner of the focused app's window, not the focused
  // control — a control-relative anchor moved every time the user typed (the
  // control's rect can shift as text reflows), which is exactly the "don't
  // follow where I'm typing" behavior this replaced. Local space is already
  // window-local logical pixels (the overlay window IS the app window), so
  // no physical/scale conversion is needed here at all, unlike the underline
  // rects above.
  const winBounds = win.getBounds()
  const widgetLocalAnchored: ScreenRect = {
    x: Math.max(0, winBounds.width - WIDGET_SIZE - EDGE_MARGIN),
    y: Math.max(0, winBounds.height - WIDGET_SIZE - EDGE_MARGIN),
    width: WIDGET_SIZE,
    height: WIDGET_SIZE
  }
  const structure = watchStructure?.structure ?? null
  // See ScreenWatchWidget.analyzing: only ever true BEFORE a first reading, so
  // a re-detection of an already-graded draft cannot replace its score with a
  // spinner. The 'grade' card is the only panel the design gives this state to.
  const analyzing = structure === null && analysisPending()
  const desiredPanelSize =
    widgetViewMode === 'all'
      ? computeAllPanelSize(claims.length)
      : widgetViewMode === 'structure'
        ? computeStructurePanelSize({
            weaknessCount: structure?.weaknesses.length ?? 0,
            paragraphCount: structure?.paragraphs.length ?? 0
          })
        : widgetViewMode === 'grade'
          ? analyzing
            ? { width: ANALYZING_PANEL_WIDTH, height: ANALYZING_PANEL_HEIGHT }
            : { width: GRADE_PANEL_WIDTH, height: GRADE_PANEL_HEIGHT }
          : widgetViewMode === 'report'
            ? { width: REPORT_PANEL_WIDTH, height: REPORT_PANEL_HEIGHT }
            : widgetViewMode === 'paragraph'
              ? { width: PARAGRAPH_PANEL_WIDTH, height: PARAGRAPH_PANEL_HEIGHT }
              : { width: SINGLE_PANEL_WIDTH, height: SINGLE_PANEL_HEIGHT }
  // Some watched windows are narrower/shorter than the ideal 400px card. The
  // overlay itself is clipped to that window, so an unclamped panel makes its
  // right/bottom actions unreachable. Keep a small inset and let the renderer
  // scroll the content when the full card does not fit.
  const panelInset = Math.min(8, Math.floor(Math.min(winBounds.width, winBounds.height) / 4))
  const panelSize = {
    width: Math.min(desiredPanelSize.width, Math.max(1, winBounds.width - panelInset * 2)),
    height: Math.min(desiredPanelSize.height, Math.max(1, winBounds.height - panelInset * 2))
  }
  // 'grade' is centred over the watched window; every other mode hangs off the
  // bottom-right corner beside the launcher. That split is the design's, not a
  // preference: 370:191 is drawn at x=155 of an 870-wide document (dead centre),
  // because it is a verdict on the whole draft rather than a note about the one
  // sentence the cursor is on.
  const panelLocalAnchored: ScreenRect =
    widgetViewMode === 'grade' || widgetViewMode === 'report' || widgetViewMode === 'paragraph'
      ? {
          x: Math.max(panelInset, Math.round((winBounds.width - panelSize.width) / 2)),
          y: Math.max(panelInset, Math.round((winBounds.height - panelSize.height) / 2)),
          width: panelSize.width,
          height: panelSize.height
        }
      : {
          x: Math.max(panelInset, winBounds.width - panelSize.width - EDGE_MARGIN),
          y: Math.max(panelInset, winBounds.height - panelSize.height - EDGE_MARGIN),
          width: panelSize.width,
          height: panelSize.height
        }

  const anchoredLocal = widgetExpanded ? panelLocalAnchored : widgetLocalAnchored
  // A user-dragged position overrides the anchor until the widget collapses
  // or a new control/app comes into focus (see widgetManualPos above).
  const activeLocal: ScreenRect = widgetManualPos
    ? {
        x: Math.min(Math.max(0, widgetManualPos.x), Math.max(0, winBounds.width - anchoredLocal.width)),
        y: Math.min(Math.max(0, widgetManualPos.y), Math.max(0, winBounds.height - anchoredLocal.height)),
        width: anchoredLocal.width,
        height: anchoredLocal.height
      }
    : anchoredLocal
  // Must add the overlay's own origin (the focused app window's logical
  // top-left, windowLogical), not display.bounds — the overlay is sized to
  // that window, not the whole display, since the window-scoping change.
  // Adding the display's origin here left the widget's hit-test rect offset
  // from where it's actually drawn whenever the app window didn't start at
  // the display's own top-left corner, so hoverTracking.ts never detected
  // the cursor over it and clicks always passed through.
  const activeAbsolute: ScreenRect = {
    x: activeLocal.x + windowLogical.x,
    y: activeLocal.y + windowLogical.y,
    width: activeLocal.width,
    height: activeLocal.height
  }

  if (underlines.length > 0) {
    logScreenWatch(
      `showing ${underlines.length} underline(s) on display ${display.id} (bounds ${JSON.stringify(display.bounds)}, scaleFactor=${display.scaleFactor}), overlay window bounds=${JSON.stringify(win.getBounds())}, visible=${win.isVisible()}, rects=${JSON.stringify(localized)}`
    )
  }

  const claimSummaries: ScreenWatchClaimSummary[] = claims
    .filter((c) => !settled.has(c.id))
    // Severity first, confidence only to break ties. Confidence says how sure
    // Tracely is that a sentence IS a claim — not how much trouble it is in —
    // so sorting by it alone buried the reasoning failure under tidy claims
    // that merely wanted a citation.
    .sort((a, b) => {
      const worst = (id: string): number =>
        problemSeverity(problemKindById.get(id)?.[0] ?? 'searching')
      const bySeverity = worst(a.id) - worst(b.id)
      return bySeverity !== 0 ? bySeverity : b.confidence - a.confidence
    })
    .map((c) => {
      const critique = critiqueByClaimId.get(c.id)
      const citation = citationByClaimId.get(c.id)
      return {
        id: c.id,
        text: c.text,
        claimType: c.claimType,
        confidence: c.confidence,
        hasInlineCitation: isCited(c),
        problemKinds: problemKindById.get(c.id) ?? ['searching'],
        evidence: leanEvidence(c.id),
        critique: critique?.critique ?? null,
        critiqueVerdict: critique?.verdict ?? null,
        suggestedRevision: critique?.suggestedRevision ?? null,
        citationFix: critique?.citationFix ?? null,
        citation: citation ? { inTextCitation: citation.inTextCitation, worksCitedEntry: citation.worksCitedEntry } : null,
        hasOwnCitation: sentenceInfo(c).own,
        citationDefect: sentenceInfo(c).defect?.message ?? null,
        citationDefectKind: sentenceInfo(c).defect?.kind ?? null,
        citationTarget: sentenceInfo(c).target
      }
    })
  // The actual number of sources found across every currently-flagged claim
  // — previously this also added +1 per claim (counting the claim itself as
  // a piece of "info"), which inflated the badge well past the number of
  // real sources anyone could actually see or click on.
  const totalInfoCount = claimSummaries.reduce((sum, c) => sum + (c.evidence?.count ?? 0), 0)

  const payload: {
    underlines: typeof localized
    widget: {
      rect: ScreenRect
      expanded: boolean
      viewMode: WidgetViewMode
      claimCount: number
      claims: ScreenWatchClaimSummary[]
      totalInfoCount: number
      underlineCount: number
      structure: ScreenWatchStructure | null
      analyzing: boolean
    }
  } = {
    underlines: localized,
    widget: {
      rect: activeLocal,
      expanded: widgetExpanded,
      viewMode: widgetViewMode,
      claimCount: claimSummaries.length,
      claims: claimSummaries,
      totalInfoCount,
      // `underlines`, not `claims`: it is the post-clip, post-filter list —
      // exactly the marks that will be painted — so a claim scrolled out of
      // view stops being counted at the same moment it stops being drawn.
      underlineCount: underlines.length,
      // Read, never computed here. This function runs on every poll tick and
      // on every resolved favicon; refreshWatchOutline owns when the reading
      // is actually redone, and returning the same object identity is what
      // keeps the dedupe below working.
      structure,
      analyzing
    }
  }

  // Native hit-testing uses absolute coordinates and must be refreshed even
  // when the renderer payload is unchanged. Moving the watched window changes
  // these coordinates without changing any window-local rect in `payload`; an
  // early dedupe return here previously left the visible panel at its new
  // position while clicks were still tested against its old position.
  const claimTargets = underlines
    .map((u, idx) => {
      const claim = claims.find((c) => c.id === u.id)
      if (!claim) return null
      const target: HoverTarget = {
        claimId: u.id,
        kind: 'claim',
        text: claim.text,
        claimType: claim.claimType,
        rectsAbsolute: u.rects.map(toAbsolute),
        rectsWindowLocal: localized[idx].rects
      }
      return target
    })
    .filter((t): t is HoverTarget => t !== null)

  const widgetTarget: HoverTarget = {
    claimId: '__widget__',
    kind: 'widget',
    text: fullText,
    claimType: 'factual',
    rectsAbsolute: [activeAbsolute],
    rectsWindowLocal: [activeLocal],
    capturePadding: widgetExpanded ? 0 : 5
  }

  // The widget is painted above underlines, so it must win overlapping native
  // hit tests. Once expanded, do not let a hidden underline behind the panel
  // open a competing popover over its controls.
  hoverTargets = widgetExpanded ? [widgetTarget] : [widgetTarget, ...claimTargets]

  // Re-sending an unchanged payload every poll tick (every 1.2s, even when
  // nothing on screen actually changed) forces the renderer to re-render
  // the whole overlay tree for no reason — on a transparent always-on-top
  // window that's a plausible source of visible flicker. Skip the send
  // (and the resulting re-render) when nothing observable changed.
  const payloadKey = JSON.stringify(payload)
  if (payloadKey !== lastSentPayloadKey) {
    lastSentPayloadKey = payloadKey
    sendToOverlay(IPC_EVENTS.SCREENWATCH_OVERLAY_UPDATE, payload)
  }

  // Outside the dedupe, and last. This used to be an early `return`, with the
  // show happening near the top of the function — so simply moving the show
  // after the send would have stopped the overlay ever appearing whenever the
  // payload was unchanged, which is the steady state for the badge-only case
  // (a focused text field with no claims found). Showing after the send is the
  // whole point: the window is never presented describing the previous
  // document.
  void win
  presentOverlay()
}

export function isScreenWatchEnabled(): boolean {
  return enabled
}

export function startScreenWatch(): void {
  if (enabled) return
  enabled = true
  setSetting('screenWatchEnabled', 'true')
  resetTrackingState()
  resetScreenWatchLog()
  lastError = null
  lastStatus = { ...lastStatus, enabled: true, lastError: null }
  startHoverTracking()
  void tick()
}

export function stopScreenWatch(): void {
  enabled = false
  setSetting('screenWatchEnabled', 'false')
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  stopHoverTracking()
  resetTrackingState()
  // clearOverlay, not hideOverlay. Hiding leaves the renderer holding the last
  // payload and leaves `lastSentPayloadKey` stale, so the underlines are still
  // there to be re-shown by the next present — and on re-enable an identical
  // first payload would be swallowed by the dedupe in updateOverlayAndWidget.
  clearOverlay()
  emitStatus({
    enabled: false,
    active: false,
    processName: null,
    supportsUnderlines: false,
    claimCount: 0,
    lastError: null,
    authRequired,
    blockedApp: null
  })
}

export function initScreenWatch(): void {
  if (getSetting('screenWatchEnabled') === 'true') {
    startScreenWatch()
  }
}

export function shutdownScreenWatch(): void {
  enabled = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  stopHoverTracking()
  const win = getOverlayWindow()
  win?.destroy()
}
