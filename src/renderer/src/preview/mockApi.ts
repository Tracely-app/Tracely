import { hasInlineCitation } from '@shared/inlineCitation'
import { byCredibility, credibilityOf } from '@shared/sourceCredibility'
import { DEFAULT_WIDGET_VIEW_MODE } from '@shared/ipc-contract'
import type { Plan } from '@shared/plan'
import type {
  ScreenWatchClaimSummary,
  ScreenWatchWidget,
  ScreenWatchHoverEvent,
  ScreenWatchOverlayUpdateEvent
} from '@shared/ipc-contract'
import type {
  AppSettings,
  AuthUser,
  Claim,
  DocumentOutline,
  DocumentListItem,
  DocumentRecord,
  EvidenceCoverage,
  ScoreBreakdown,
  TracerMessage
} from '@shared/types'

// Deliberately `Window['tracely']` rather than a direct import of
// src/preload/index.ts. Both resolve to the same `TracelyApi`, but pulling
// the preload *implementation* into the renderer's tsconfig program drags
// electron's Node-flavoured typings in with it and degrades inference across
// every renderer file. The global is already declared by
// src/preload/index.d.ts, which tsconfig.web.json includes.
type TracelyApi = Window['tracely']
import * as fx from './fixtures'

// ---------------------------------------------------------------------------
// THE DRIFT GUARD
//
// `createMockApi` returns `TracelyApi` — the exact type the real preload
// bridge exports (`typeof api`). It is not a loose stand-in: add, rename or
// re-shape any method in src/preload/index.ts and `npm run typecheck` fails
// here until this file is updated too. tsconfig.web.json includes preview/,
// specifically so that check runs in CI and in `npm run preflight`.
//
// That is the entire reason this harness is worth having. A hand-maintained
// copy of the UI would rot in a week; this one cannot silently fall behind
// the contract it mocks.
// ---------------------------------------------------------------------------

/** Which variant of the world the preview is rendering. */
export type Scenario = {
  /**
   * What the account has paid for — Settings > Billing, and the locked model
   * rows in Preferences.
   *
   * There is no `auth` switch beside it any more: the app has no sign-in and
   * no gate, so the only auth state a preview can be in is the one every
   * install is in — an anonymous session that already exists.
   */
  plan: Plan
  /** With no relay compiled in, every relay-backed action refuses up front. */
  relayConfigured: boolean
  /** Make every relay-backed call reject, to review error states. */
  failRelay: boolean
  /** Add a delay to async calls so loading states are actually visible. */
  latencyMs: number
  /**
   * Which Structure outline to serve.
   *
   * 'heuristic' is what the local rules produce with no relay: two paragraphs
   * unlabelled, `complete: false`, whole-draft weaknesses withheld. 'none'
   * covers a document that has never been analyzed, and 'stale' one edited
   * since. The confident, fully classified state is otherwise unreachable in
   * the preview, since there is no relay behind the harness to produce it.
   */
  structure: 'heuristic' | 'classified' | 'stale' | 'none'
  /**
   * Screen Watch has text it has not produced a reading for yet — the overlay's
   * Analyzing card (Figma 391:342).
   *
   * Its own switch rather than a value of `structure` above, which serves the
   * main window's Structure rail: this one drops `widget.structure` AND sets
   * `widget.analyzing`, and those two travel together in exactly one direction
   * (see ScreenWatchWidget.analyzing). In the real product the state lasts as
   * long as one detection pass, which is not long enough to review.
   */
  watchAnalyzing: boolean
}

/** What a claim's breakdown looks like once a search has found something. */
const FOUND_BREAKDOWN: ScoreBreakdown = {
  sourceCount: 0.33,
  quality: 0.6,
  recency: 0.7,
  relevance: 0.5,
  support: 0
}

export const defaultScenario: Scenario = {
  // The plan most installs are on, and the only one with an upgrade prompt.
  plan: 'free',
  relayConfigured: true,
  failRelay: false,
  latencyMs: 0,
  structure: 'heuristic',
  watchAnalyzing: false
}

/** Names of every call the harness logs, so the UI can show what fired. */
export type CallLogEntry = { at: number; method: string }

export function createMockApi(scenario: Scenario, log: (method: string) => void): TracelyApi {
  let latency = scenario.latencyMs

  async function ok<T>(method: string, value: T): Promise<T> {
    log(method)
    if (latency > 0) await new Promise((r) => setTimeout(r, latency))
    return value
  }

  async function relay<T>(method: string, value: T): Promise<T> {
    log(method)
    if (latency > 0) await new Promise((r) => setTimeout(r, latency))
    if (scenario.failRelay) {
      throw new Error('Relay request failed: 503 Service Unavailable (preview scenario)')
    }
    return value
  }

  // Event subscriptions: fire the fixture payload once on the next tick so
  // components that only ever render from a pushed event (the overlay, most
  // of all) have something to draw, then return a real unsubscribe.
  function subscribe<T>(method: string, payload: T, cb: (value: T) => void): () => void {
    log(`${method} (subscribe)`)
    const id = window.setTimeout(() => cb(payload), 0)
    return () => window.clearTimeout(id)
  }

  // The anonymous session every install has. No name, no email — the same
  // shape toAuthUser builds in the real client.
  const authUser = (): AuthUser | null => fx.user

  // Mutable so an evidence search visibly resolves a claim, exactly as the
  // real store would. Reset per document, like every other bit of preview
  // state, because the mock is constructed once per bridge.
  let previewClaims: Claim[] = [...fx.claims]
  // DocumentListItem, because the Documents page lists grades — a
  // DocumentRecord[] here would make the mock the one place those are absent.
  let previewDocs: DocumentListItem[] = [...fx.documents]
  // See window.toggleMaximize below.
  let previewMaximized = false
  let previewSettings: AppSettings = { ...fx.settings }
  // Tracer's transcript, kept as state so a sent message stays on screen —
  // the panel appends what the bridge returns rather than what it typed.
  const previewConversation = fx.tracerConversation
  let previewTracerMessages: TracerMessage[] = [...fx.tracerMessages]
  // Screen Watch's claims are pushed, not fetched: the real service folds a
  // refresh or a critique into its in-memory claim and redraws the overlay, so
  // the panel's two result states are only reachable here if the mock does the
  // same. Without this, "Critique Argument" logged an IPC call and the card
  // never changed.
  let watchClaims: ScreenWatchClaimSummary[] = [...fx.screenWatchClaims]
  // The contract's own union, not a copy of it. This was spelled out by hand
  // and so silently stopped covering the panel's modes the moment one was
  // added — which is exactly the drift this harness exists to catch.
  let lastWidget: { expanded: boolean; viewMode: ScreenWatchWidget['viewMode'] } = {
    expanded: fx.overlayUpdate.widget?.expanded ?? false,
    viewMode: fx.overlayUpdate.widget?.viewMode ?? 'single'
  }

  function patchWatchClaim(claimId: string, patch: Partial<ScreenWatchClaimSummary>): void {
    watchClaims = watchClaims.map((c) => (c.id === claimId ? { ...c, ...patch } : c))
    emitWidget({})
  }
  let nextId = 100

  /** Mirrors computeEvidenceCoverage in the main process. */
  const coverageOf = (claims: Claim[]): EvidenceCoverage => {
    const resolved = claims.filter((c) => c.strengthScore !== null)
    return {
      detected: claims.length,
      withRelevantSource: claims.filter((c) => (c.scoreBreakdown?.sourceCount ?? 0) > 0).length,
      withOwnCitation: claims.filter((c) => hasInlineCitation(c.text)).length,
      meanStrength: resolved.length
        ? Math.round(resolved.reduce((sum, c) => sum + (c.strengthScore ?? 0), 0) / resolved.length)
        : null,
      unchecked: claims.length - resolved.length
    }
  }

  const outlineForScenario = (): DocumentOutline | null => {
    if (scenario.structure === 'none') return null
    return scenario.structure === 'classified' ? fx.documentOutlineClassified : fx.documentOutline
  }

  // Rebuild the overlay payload the way screenWatchService would, so the
  // widget's own controls actually move it. Panel size is computed in main in
  // production (hoverTracking.ts hit-tests the same rect the renderer draws),
  // so the sizes here mirror panelSize.ts — if they drift, the preview lies
  // about how much room the content has.
  function emitWidget(patch: {
    expanded?: boolean
    viewMode?: ScreenWatchWidget['viewMode']
  }): void {
    const w = window as Window & {
      __previewEmitOverlay?: (e: ScreenWatchOverlayUpdateEvent) => void
    }
    if (!w.__previewEmitOverlay) return
    const base = fx.overlayUpdate.widget
    if (!base) return
    const viewMode = patch.viewMode ?? lastWidget.viewMode
    const expanded = patch.expanded ?? lastWidget.expanded
    lastWidget = { expanded, viewMode }
    // Taken from panelSize.ts for this fixture's shape (3 claims, 4 weaknesses,
    // 6 paragraphs), not estimated: PANEL_WIDTH = 480, SINGLE_PANEL_HEIGHT =
    // 532, computeAllPanelSize(3) = 313, computeStructurePanelSize({4, 6}) =
    // 568. Guessing these makes the preview claim more or less room than the
    // real panel has, which is the one thing it must not do — re-read them from
    // that module whenever its constants change rather than adjusting by eye.
    // 'grade' is the one mode with its own width and its own anchor:
    // GRADE_PANEL_WIDTH/HEIGHT = 560x321, centred rather than cornered. Sized
    // wrong here it still *renders*, but its two 251px pills flex down to fit a
    // 480px box and the harness quietly shows a card the product never draws.
    // ANALYZING_PANEL_* is 340x204 — its own size, not the grade card's, and
    // centred the same way. Reachable only through the rail's Screen Watch
    // switch; see Scenario.watchAnalyzing.
    const rect = expanded
      ? viewMode === 'grade'
        ? scenario.watchAnalyzing
          ? { x: 210, y: 138, width: 340, height: 204 }
          : { x: 100, y: 80, width: 560, height: 321 }
        : viewMode === 'report'
          ? // REPORT_PANEL_* is 560x1210, which main clamps to the watched
            // window. 760x480 here is smaller than most, so this is the clamped
            // height — the harness should show the scrolling case, not a
            // 1210px card no real window would give it.
            { x: 100, y: 8, width: 560, height: 464 }
          : viewMode === 'paragraph'
            ? // PARAGRAPH_PANEL_* is 520x930, clamped the same way.
              { x: 120, y: 8, width: 520, height: 464 }
        : {
            x: 90,
            y: 20,
            width: 480,
            height: viewMode === 'single' ? 532 : viewMode === 'all' ? 313 : 568
          }
      : { x: 520, y: 300, width: 56, height: 56 }
    w.__previewEmitOverlay({
      ...fx.overlayUpdate,
      widget: {
        ...base,
        claims: watchClaims,
        rect,
        expanded,
        viewMode,
        // Together, never apart: `analyzing` means "no reading YET", so leaving
        // the fixture's structure in place would push a state main cannot
        // produce and let the harness pass a card that never renders for real.
        structure: scenario.watchAnalyzing ? null : base.structure,
        analyzing: scenario.watchAnalyzing
      }
    })
  }

  return {
    analyze: {
      detectClaims: () => relay('analyze.detectClaims', { analysisId: fx.analysis.id, claims: fx.claims }),
      getResult: () =>
        ok('analyze.getResult', { analysis: fx.analysis, claims: previewClaims, evidenceByClaimId: {} })
    },
    sources: {
      /**
       * A real data: URI, not null.
       *
       * Returning null everywhere would make every row fall back to the
       * monogram, which is precisely the state the favicon work exists to
       * replace — the harness would then be unable to show, or catch a
       * regression in, the only path that matters. A flat orange square is
       * obviously synthetic to anyone looking, and it exercises the <img>
       * branch, the CSP, the sizing box and the fallback swap for real.
       *
       * The preprint fixture (psyarxiv) deliberately gets null. A domain the
       * favicon service has nothing for is the common real case, not an edge
       * one, and without it every row in the harness has an icon and the
       * monogram fallback — the thing every row looked like until now — is
       * unreachable here. Both branches are on screen at once this way.
       */
      favicons: (req) =>
        relay('sources.favicons', {
          icons: Object.fromEntries(
            req.urls.map((url) => [
              url,
              url.includes('psyarxiv')
                ? null
                : 'data:image/svg+xml;base64,' +
                  btoa('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="#ff5900"/></svg>')
            ])
          )
        })
    },
    evidence: {
      // Records the result against the claim, so the Structure rail's
      // "Check if supportable" flow can actually be reviewed: without this the
      // claim stays unchecked forever and the button never resolves into a
      // score, which is the half of the interaction worth looking at.
      find: (req) => {
        previewClaims = previewClaims.map((claim) =>
          claim.id === req.claimId && claim.strengthScore === null
            ? { ...claim, strengthScore: 42, scoreBreakdown: FOUND_BREAKDOWN }
            : claim
        )
        return ok('evidence.find', {
          evidence: fx.evidence,
          strengthScore: fx.claims[0].strengthScore ?? 0,
          // `support` is how much of the evidence actually agrees with the
          // claim — see search/scoring.ts. Zero here means "no stance verdict",
          // which is the honest default for a fixture.
          scoreBreakdown: fx.claims[0].scoreBreakdown ?? {
            sourceCount: 0,
            quality: 0,
            recency: 0,
            relevance: 0,
            support: 0
          }
        })
      },
      getForClaim: () => ok('evidence.getForClaim', { evidence: fx.evidence }),
      /**
       * Home's source finder.
       *
       * Returns the fixture sources ordered and labelled the way main does it,
       * so the harness shows the real ranking rather than the fixture's order —
       * and honours the short-text refusal, because "type a bit more" is a
       * state the panel has to render and is otherwise unreachable here.
       */
      forText: (req) => {
        const trimmed = (req.text ?? '').trim()
        if (trimmed.length < 25) {
          return ok('evidence.forText', {
            candidates: [],
            citations: {},
            note: 'Type a sentence or two — at least 25 characters — and Tracely will look for sources that speak to it.'
          })
        }
        const candidates = byCredibility(
          fx.sources.map((s, i) => ({
            sourceRef: `text:${i}`,
            title: s.title,
            venue: s.venue,
            year: s.year,
            provider: s.provider,
            url: s.url,
            matchPercent: [88, 71, 63, 44][i] ?? 38,
            faviconDataUrl: null,
            credibility: credibilityOf({
              url: s.url,
              venue: s.venue,
              venueType: s.venueType,
              doi: s.doi
            })
          })),
          (c) => c.credibility.tier
        )
        return ok('evidence.forText', {
          candidates,
          citations: Object.fromEntries(
            candidates.map((c, i) => [
              c.sourceRef,
              `${fx.sources[i]?.authors?.[0]?.family ?? 'Author'}, ${fx.sources[i]?.year ?? 'n.d.'}. ${c.title}. ${c.venue ?? ''}`.trim()
            ])
          ),
          note: null
        })
      },
      /**
       * Flags the fixture claim that genuinely is a tangent, so the underline
       * and its card are reachable here at all.
       *
       * The resistance claim sits in a draft about screen time and adolescent
       * mental health — it is exactly the shape this finding exists for, which
       * is why it is matched on its text rather than pinned to an id: the point
       * is to show the state a real tangent produces, not to hardcode one.
       */
      offTopic: (req) =>
        ok('evidence.offTopic', {
          offTopicClaimIds: (req.claims ?? [])
            .filter((c) => /resistance|underground newspapers|lamine yamal/i.test(c.text))
            .map((c) => c.id)
        })
    },
    citation: {
      /**
       * The work a sentence cites — the left half of "Compare sources".
       *
       * Answers by CLAIM, because the two fixtures are the two outcomes: c6
       * cites a work Crossref holds, c2 cites "(Unknown Author, 2025)", which
       * nothing holds and which the card must report as an empty lookup rather
       * than as a verdict. Every other claim resolves to null — the state where
       * the sentence cites nothing the lookup can check.
       */
      resolveCited: (req) =>
        ok('citation.resolveCited', {
          cited:
            req.claimId === 'c6'
              ? fx.citedFound
              : req.claimId === 'c2'
                ? fx.citedMissing
                : null
        }),
      // Looks the source UP, rather than always answering with the first
      // citation. It did the latter, and the consequence was that the picker's
      // "WILL BE INSERTED" block showed one source's in-text marker beside a
      // DIFFERENT source's works-cited entry — which reads exactly like a real
      // formatting bug, and would equally have HIDDEN one.
      generate: (req: { sourceId: string }) =>
        ok('citation.generate', {
          citation: (
            fx.citations.find((c) => c.sourceId === req.sourceId) ?? fx.citations[0]
          ).formattedText
        }),
      list: () => ok('citation.list', { citations: fx.citations })
    },
    critique: {
      generate: () =>
        relay('critique.generate', {
          critique: fx.claims[0].critique ?? '',
          verdict: fx.claims[0].critiqueVerdict ?? 'weak',
          // Null is the realistic default: a correction is only produced when
          // the stance model finds a source that contradicts the claim, which
          // is rare and currently never (see task #17).
          correction: null
        })
    },
    library: {
      save: () => ok('library.save', { item: fx.libraryItems[0] }),
      // Honours `search` rather than always returning everything, so the
      // Library view's no-results state is reachable in the preview. Roughly
      // what libraryRepo.listLibrary matches on.
      list: (req) =>
        ok('library.list', {
          items: req.search
            ? fx.libraryItems.filter((i) =>
                `${i.source.title} ${i.source.authors.map((a) => a.family).join(' ')} ${i.notes ?? ''}`
                  .toLowerCase()
                  .includes(req.search!.toLowerCase())
              )
            : fx.libraryItems
        }),
      get: () => ok('library.get', { item: fx.libraryItems[0], citations: fx.citations }),
      update: () => ok('library.update', { item: fx.libraryItems[0] }),
      remove: () => ok('library.remove', { ok: true as const })
    },
    documents: {
      // Backed by a module-level store so autosave, reload-last and the
      // document list actually behave like storage in the preview instead of
      // returning one frozen fixture.
      list: () => ok('documents.list', { documents: previewDocs }),
      get: (req) => ok('documents.get', { document: previewDocs.find((d) => d.id === req.id) ?? null }),
      latest: () => ok('documents.latest', { document: previewDocs[0] ?? null }),
      save: (req) => {
        const now = fx.T0
        const existing = req.id ? previewDocs.find((d) => d.id === req.id) : undefined
        const doc = existing
          ? { ...existing, title: req.title, bodyHtml: req.bodyHtml, updatedAt: now }
          : {
              id: `doc-${nextId++}`,
              title: req.title,
              bodyHtml: req.bodyHtml,
              createdAt: now,
              updatedAt: now,
              // A brand-new document has not been read, so it has no grade —
              // the same state main returns for a row with no
              // document_structure behind it. Seeding a score here would make
              // "+ New document" produce a graded card in the preview and
              // an ungraded one in the app.
              score: null,
              gradedAt: null
            }
        previewDocs = [doc, ...previewDocs.filter((d) => d.id !== doc.id)]
        return ok('documents.save', { document: doc })
      },
      remove: (req) => {
        previewDocs = previewDocs.filter((d) => d.id !== req.id)
        return ok('documents.remove', { ok: true as const })
      }
    },
    structure: {
      // Serves a fixture rather than running the real engine: analyzeStructure
      // lives in the main process and reaches for node:crypto, so it cannot be
      // imported into a renderer iframe. The fixtures are hand-computed from
      // the same rubric — see the score trace in fixtures.ts.
      // Analyzing always yields an outline, including under the 'none'
      // scenario — 'none' means "nothing stored yet", which is a fact about
      // the store, not about whether analysis can run.
      //
      // Coverage is recomputed from previewClaims rather than served from the
      // fixture, mirroring what the real handler does by reading the database.
      // A frozen coverage line would still say "1 not checked" directly above
      // a claim that had just resolved to a score — a contradiction the real
      // app cannot produce, and exactly the kind of thing a reviewer would
      // waste time chasing.
      analyze: (req) =>
        ok('structure.analyze', {
          outline: {
            ...(outlineForScenario() ?? fx.documentOutline),
            documentId: req.documentId ?? null,
            coverage: coverageOf(previewClaims)
          }
        }),
      get: (req) => {
        const outline = outlineForScenario()
        if (!outline) return ok('structure.get', { outline: null, stale: false })
        return ok('structure.get', {
          outline: { ...outline, documentId: req.documentId },
          stale: scenario.structure === 'stale'
        })
      }
    },
    // Tracer answers locally here. The real one is a relay round trip on the
    // reasoning model, and the harness has no relay by design — but a chat
    // panel with a dead composer cannot be reviewed at all, so this echoes a
    // canned reply after a beat. The delay is real: it is what makes the
    // typing indicator reachable.
    tracer: {
      getConversation: () =>
        ok('tracer.getConversation', {
          conversation: previewConversation,
          messages: previewTracerMessages,
          context: { processName: null, documentText: fx.documentText, claims: [] },
          relayConfigured: scenario.relayConfigured,
          focusedClaimId: null,
          focusedPrompt: null
        }),
      send: (req) => {
        const userMessage = {
          id: `mock-user-${previewTracerMessages.length}`,
          conversationId: req.conversationId,
          role: 'user' as const,
          content: req.message,
          createdAt: fx.T0
        }
        const reply = {
          id: `mock-reply-${previewTracerMessages.length}`,
          conversationId: req.conversationId,
          role: 'tracer' as const,
          // Carries a rewrite block whose FIND is the first sentence of
          // documents[0], so the Apply path is reachable here at all. Without
          // it the card could only be reviewed against a live relay, which is
          // exactly the kind of state this harness exists to make reachable.
          content: [
            'In the harness I answer from a fixture rather than the relay, so this is the same reply every time. That opening sentence claims more than the studies support — it asserts cause where the evidence only shows association.',
            '',
            '<<<REWRITE',
            'FIND: Screen time causes depression in teenagers.',
            'REPLACE: Screen time is associated with depression in teenagers.',
            '>>>'
          ].join('\n'),
          createdAt: fx.T0
        }
        previewTracerMessages = [...previewTracerMessages, userMessage, reply]
        return ok('tracer.send', { userMessage, reply })
      },
      newConversation: () => {
        previewTracerMessages = []
        return ok('tracer.newConversation', { conversation: previewConversation })
      }
    },
    settings: {
      get: () => ok('settings.get', previewSettings),
      // Merges the patch and keeps it, rather than returning the fixture
      // unchanged. It used to do the latter, which made every settings control
      // in the harness look broken in the same way a real persistence bug
      // would: toggle it, watch it snap back. Worse, it made the harness
      // useless for exactly the round-trips it should be proving — the Save
      // changes dialog's "Do not show anymore" could never take effect here.
      set: (patch) => {
        previewSettings = { ...previewSettings, ...patch }
        return ok('settings.set', previewSettings)
      },
      scanInstalledApps: () =>
        ok('settings.scanInstalledApps', {
          found: [
            { exe: 'WINWORD.EXE', name: 'Microsoft Word' },
            { exe: 'chrome.exe', name: 'Google Chrome' },
            { exe: 'notepad.exe', name: 'Notepad' }
          ]
        })
    },
    profile: {
      get: () => ok('profile.get', fx.profile),
      set: () => ok('profile.set', fx.profile)
    },
    auth: {
      getUser: () => ok('auth.getUser', { user: authUser(), configured: true }),
      getPlan: () => ok('auth.getPlan', { plan: scenario.plan })
    },
    history: {
      clear: () => ok('history.clear', { ok: true as const })
    },
    clipboard: {
      write: () => ok('clipboard.write', { ok: true as const })
    },
    window: {
      hide: () => ok('window.hide', { ok: true as const }),
      show: () => ok('window.show', { ok: true as const }),
      // Logged and otherwise inert. The preview renders each surface in an
      // iframe at a fixed size, so there is no BrowserWindow to resize — but
      // the grips are still real DOM in that iframe, and the call log is how a
      // reviewer sees that a drag is reaching the bridge at all.
      resizeStart: (req) => ok(`window.resizeStart ${req.handle}`, { ok: true as const }),
      resizeMove: (req) => ok(`window.resizeMove ${req.dx},${req.dy}`, { ok: true as const }),
      // Logged, and `maximized` toggles so the button's icon can be reviewed in
      // both states. There is no BrowserWindow behind an iframe to actually
      // resize — the harness renders each surface at a fixed size — so the
      // alternative is a control that looks permanently un-maximized.
      minimize: () => ok('window.minimize', { ok: true as const }),
      toggleMaximize: () => {
        previewMaximized = !previewMaximized
        return ok(`window.toggleMaximize -> ${previewMaximized}`, { maximized: previewMaximized })
      },
      isMaximized: () => Promise.resolve({ maximized: previewMaximized })
    },
    shell: {
      // Opening a real browser from a preview is the one side effect worth
      // suppressing outright — reviewing the UI shouldn't spray tabs.
      openExternal: () => ok('shell.openExternal (suppressed)', { ok: true as const })
    },
    app: {
      getBuildInfo: () =>
        ok('app.getBuildInfo', { version: '0.0.0-harness', isPreview: true })
    },
    screenWatch: {
      setEnabled: () => ok('screenWatch.setEnabled', fx.screenWatchStatus),
      getStatus: () => ok('screenWatch.getStatus', fx.screenWatchStatus),
      // These two re-emit the overlay payload rather than only logging.
      // In production the service owns widget geometry and pushes a new
      // payload back, so the panel's own Back / Show all / score chip / close
      // buttons are how you navigate it. Returning a bare ok left every one of
      // them inert in the preview, which is precisely where they need
      // exercising — the overlay is the hardest surface to reach for real.
      setWidgetExpanded: (req) => {
        // The shared default, not a literal. This line said 'single' and so
        // reproduced the pre-'grade' behaviour in the harness no matter what
        // main was set to — the harness agreeing with a stale copy of the app
        // is worse than it not covering the case at all.
        emitWidget({
          expanded: req.expanded,
          viewMode: req.expanded ? undefined : DEFAULT_WIDGET_VIEW_MODE
        })
        return ok('screenWatch.setWidgetExpanded', { ok: true as const })
      },
      setWidgetViewMode: (req) => {
        emitWidget({ expanded: true, viewMode: req.mode })
        return ok('screenWatch.setWidgetViewMode', { ok: true as const })
      },
      widgetDragStart: () => ok('screenWatch.widgetDragStart', { ok: true as const }),
      widgetDragEnd: () => ok('screenWatch.widgetDragEnd', { ok: true as const }),
      setActivePopoverRect: () => ok('screenWatch.setActivePopoverRect', { ok: true as const }),
      refreshEvidence: async (req) => {
        const result = await ok('screenWatch.refreshEvidence', {
          evidence: fx.screenWatchEvidenceRefreshed
        })
        patchWatchClaim(req.claimId, { evidence: fx.screenWatchEvidenceRefreshed })
        return result
      },
      critiqueClaim: async (req) => {
        const result = await relay('screenWatch.critiqueClaim', {
          critique: fx.screenWatchCritique,
          verdict: 'weak' as const,
          // Null on the default preview claim: a suggested revision on every
          // critique is precisely the failure mode the relay prompt guards
          // against, and a fixture that always returns one would make the
          // preview a bad reference for what the feature should look like.
          suggestedRevision: null,
          citationFix: null
        })
        patchWatchClaim(req.claimId, { critique: fx.screenWatchCritique, critiqueVerdict: 'weak' })
        return result
      },
      findSource: () =>
        ok('screenWatch.findSource', {
          // Both halves in one round trip — Screen Watch claims are never
          // persisted, so there is no id to look the citation up by later.
          //
          // The MISSING fixture, on purpose: the editor's card reaches
          // `citedFound` through claim c6, and without this the branch where the
          // lookup comes back empty — the one the card must not turn into an
          // accusation — is unreachable in the harness. It is also the likelier
          // case here, since Screen Watch reads whatever is on screen.
          cited: fx.citedMissing,
          // Ordered and labelled the same way main does it, so the harness
          // shows the real ranking rather than the fixture's own order.
          candidates: byCredibility(
            fx.sources.map((s, i) => ({
              sourceRef: s.id,
              title: s.title,
              authors: s.authors.map((a) => [a.given, a.family].filter(Boolean).join(' ')),
              year: s.year,
              venue: s.venue,
              provider: s.provider,
              url: s.url,
              matchPercent: [92, 74, 51, 47][i] ?? 40,
              faviconDataUrl: null,
              credibility: credibilityOf({
                url: s.url,
                venue: s.venue,
                venueType: s.venueType,
                doi: s.doi
              })
            })),
            (c) => c.credibility.tier
          )
        }),
      // Formatting is local and synchronous in main, so this returns the same
      // pair insertCitation would — the preview block is only worth reviewing
      // in the harness if it shows what the insert would actually write.
      previewCitation: () =>
        ok('screenWatch.previewCitation', {
          citation: {
            inTextCitation: '(Okonkwo et al., 2023)',
            worksCitedEntry: fx.citations[0].formattedText
          }
        }),
      insertCitation: () =>
        ok('screenWatch.insertCitation', {
          citation: {
            inTextCitation: '(Okonkwo et al., 2023)',
            worksCitedEntry: fx.citations[0].formattedText
          }
        }),
      undoCitation: () => ok('screenWatch.undoCitation', { ok: true as const })
    },
    onClipboardCaptured: (cb) =>
      subscribe('onClipboardCaptured', { text: fx.analysis.sourceText }, cb),
    onScreenWatchStatus: (cb) => subscribe('onScreenWatchStatus', fx.screenWatchStatus, cb),
    // Also driveable on demand, so the harness can replay the sequence that
    // makes underlines flicker in production: an update where a claim is
    // still tracked but its rects came back empty (a FindText miss during
    // reflow). See useStableUnderlines in OverlayApp.tsx.
    onScreenWatchOverlayUpdate: (cb) => {
      log('onScreenWatchOverlayUpdate (subscribe)')
      const w = window as Window & {
        __previewEmitOverlay?: (e: ScreenWatchOverlayUpdateEvent) => void
      }
      w.__previewEmitOverlay = (e) => cb(e)
      const id = window.setTimeout(() => cb(fx.overlayUpdate), 0)
      return () => {
        window.clearTimeout(id)
        delete w.__previewEmitOverlay
      }
    },
    // Hover is the one event the harness has to be able to drive on demand:
    // in production it comes from hoverTracking.ts hit-testing the real
    // cursor against the watched app's text, which has no equivalent inside
    // an iframe. Without this, the overlay's hover states (highlight band,
    // popover) are simply unreachable in the preview.
    onScreenWatchHover: (cb) => {
      log('onScreenWatchHover (subscribe)')
      const w = window as Window & { __previewEmitHover?: (e: ScreenWatchHoverEvent | null) => void }
      w.__previewEmitHover = (e) => cb(e)
      cb(null)
      return () => {
        delete w.__previewEmitHover
      }
    },
    onAuthStateChanged: (cb) => subscribe('onAuthStateChanged', authUser(), cb)
  }
}
