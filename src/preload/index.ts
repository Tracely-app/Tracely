import { contextBridge, ipcRenderer } from 'electron'
import { IPC, IPC_EVENTS } from '@shared/ipc-channels'
import type {
  AppGetBuildInfoResponse,
  AnalyzeDetectClaimsRequest,
  AnalyzeDetectClaimsResponse,
  AnalyzeGetResultRequest,
  AnalyzeGetResultResponse,
  AuthGetPlanResponse,
  AuthGetUserResponse,
  AuthRefreshResponse,
  AuthSignInWithGoogleResponse,
  AuthSignOutResponse,
  CitationGenerateRequest,
  CitationGenerateResponse,
  CitationListRequest,
  CitationResolveCitedRequest,
  CitationResolveCitedResponse,
  CitationListResponse,
  ClipboardReadResponse,
  ClipboardWriteRequest,
  ClipboardWriteResponse,
  CritiqueGenerateRequest,
  CritiqueGenerateResponse,
  ClaimsOffTopicRequest,
  ClaimsOffTopicResponse,
  EvidenceForTextRequest,
  EvidenceForTextResponse,
  EvidenceFindRequest,
  EvidenceFindResponse,
  EvidenceGetForClaimRequest,
  EvidenceGetForClaimResponse,
  SourcesFaviconsRequest,
  SourcesFaviconsResponse,
  FloatingClipboardCapturedEvent,
  HistoryClearRequest,
  HistoryClearResponse,
  LibraryGetRequest,
  LibraryGetResponse,
  LibraryListRequest,
  LibraryListResponse,
  LibraryRemoveRequest,
  LibraryRemoveResponse,
  DocumentsGetRequest,
  DocumentsGetResponse,
  DocumentsLatestResponse,
  DocumentsListResponse,
  DocumentsRemoveRequest,
  DocumentsRemoveResponse,
  DocumentsSaveRequest,
  DocumentsSaveResponse,
  LibrarySaveRequest,
  LibrarySaveResponse,
  LibraryUpdateRequest,
  LibraryUpdateResponse,
  ProfileGetResponse,
  ProfileSetRequest,
  ProfileSetResponse,
  ScreenWatchCritiqueClaimRequest,
  ScreenWatchCritiqueClaimResponse,
  ScreenWatchFindSourceRequest,
  ScreenWatchFindSourceResponse,
  ScreenWatchGetStatusResponse,
  ScreenWatchHoverEvent,
  ScreenWatchInsertCitationRequest,
  ScreenWatchInsertCitationResponse,
  ScreenWatchPreviewCitationRequest,
  ScreenWatchPreviewCitationResponse,
  ScreenWatchOverlayUpdateEvent,
  ScreenWatchRefreshEvidenceRequest,
  ScreenWatchRefreshEvidenceResponse,
  ScreenWatchSetActivePopoverRectRequest,
  ScreenWatchSetActivePopoverRectResponse,
  ScreenWatchSetEnabledRequest,
  ScreenWatchSetEnabledResponse,
  ScreenWatchSetWidgetExpandedRequest,
  ScreenWatchSetWidgetExpandedResponse,
  ScreenWatchSetWidgetViewModeRequest,
  ScreenWatchSetWidgetViewModeResponse,
  ScreenWatchStatus,
  ScreenWatchUndoCitationRequest,
  ScreenWatchUndoCitationResponse,
  ScreenWatchWidgetDragEndRequest,
  ScreenWatchWidgetDragEndResponse,
  ScreenWatchWidgetDragStartResponse,
  SettingsScanInstalledAppsResponse,
  SettingsSetRequest,
  SettingsSetResponse,
  StructureAnalyzeRequest,
  StructureAnalyzeResponse,
  StructureGetRequest,
  TracerGetConversationRequest,
  TracerGetConversationResponse,
  TracerNewConversationResponse,
  TracerSendRequest,
  TracerSendResponse,
  StructureGetResponse,
  ShellOpenExternalRequest,
  ShellOpenExternalResponse,
  WindowIsMaximizedResponse,
  WindowMinimizeResponse,
  WindowResizeMoveRequest,
  WindowToggleMaximizeResponse,
  WindowResizeMoveResponse,
  WindowResizeStartRequest,
  WindowResizeStartResponse,
  WindowTargetRequest,
  WindowTargetResponse
} from '@shared/ipc-contract'
import type { AppSettings, AuthUser } from '@shared/types'

const api = {
  analyze: {
    detectClaims: (req: AnalyzeDetectClaimsRequest): Promise<AnalyzeDetectClaimsResponse> =>
      ipcRenderer.invoke(IPC.ANALYZE_DETECT_CLAIMS, req),
    getResult: (req: AnalyzeGetResultRequest): Promise<AnalyzeGetResultResponse> =>
      ipcRenderer.invoke(IPC.ANALYZE_GET_RESULT, req)
  },
  evidence: {
    find: (req: EvidenceFindRequest): Promise<EvidenceFindResponse> =>
      ipcRenderer.invoke(IPC.EVIDENCE_FIND, req),
    getForClaim: (req: EvidenceGetForClaimRequest): Promise<EvidenceGetForClaimResponse> =>
      ipcRenderer.invoke(IPC.EVIDENCE_GET_FOR_CLAIM, req),
    /** Sources for text the user typed, with no document behind it — Home. */
    forText: (req: EvidenceForTextRequest): Promise<EvidenceForTextResponse> =>
      ipcRenderer.invoke(IPC.EVIDENCE_FOR_TEXT, req),
    /** Which claims are not about the rest of the draft. Local, free. */
    offTopic: (req: ClaimsOffTopicRequest): Promise<ClaimsOffTopicResponse> =>
      ipcRenderer.invoke(IPC.CLAIMS_OFF_TOPIC, req)
  },
  sources: {
    favicons: (req: SourcesFaviconsRequest): Promise<SourcesFaviconsResponse> =>
      ipcRenderer.invoke(IPC.SOURCES_FAVICONS, req)
  },
  citation: {
    generate: (req: CitationGenerateRequest): Promise<CitationGenerateResponse> =>
      ipcRenderer.invoke(IPC.CITATION_GENERATE, req),
    list: (req: CitationListRequest): Promise<CitationListResponse> =>
      ipcRenderer.invoke(IPC.CITATION_LIST, req),
    resolveCited: (req: CitationResolveCitedRequest): Promise<CitationResolveCitedResponse> =>
      ipcRenderer.invoke(IPC.CITATION_RESOLVE_CITED, req)
  },
  critique: {
    generate: (req: CritiqueGenerateRequest): Promise<CritiqueGenerateResponse> =>
      ipcRenderer.invoke(IPC.CRITIQUE_GENERATE, req)
  },
  library: {
    save: (req: LibrarySaveRequest): Promise<LibrarySaveResponse> =>
      ipcRenderer.invoke(IPC.LIBRARY_SAVE, req),
    list: (req: LibraryListRequest): Promise<LibraryListResponse> =>
      ipcRenderer.invoke(IPC.LIBRARY_LIST, req),
    get: (req: LibraryGetRequest): Promise<LibraryGetResponse> =>
      ipcRenderer.invoke(IPC.LIBRARY_GET, req),
    update: (req: LibraryUpdateRequest): Promise<LibraryUpdateResponse> =>
      ipcRenderer.invoke(IPC.LIBRARY_UPDATE, req),
    remove: (req: LibraryRemoveRequest): Promise<LibraryRemoveResponse> =>
      ipcRenderer.invoke(IPC.LIBRARY_REMOVE, req)
  },
  documents: {
    list: (): Promise<DocumentsListResponse> => ipcRenderer.invoke(IPC.DOCUMENTS_LIST, {}),
    get: (req: DocumentsGetRequest): Promise<DocumentsGetResponse> =>
      ipcRenderer.invoke(IPC.DOCUMENTS_GET, req),
    latest: (): Promise<DocumentsLatestResponse> => ipcRenderer.invoke(IPC.DOCUMENTS_LATEST, {}),
    save: (req: DocumentsSaveRequest): Promise<DocumentsSaveResponse> =>
      ipcRenderer.invoke(IPC.DOCUMENTS_SAVE, req),
    remove: (req: DocumentsRemoveRequest): Promise<DocumentsRemoveResponse> =>
      ipcRenderer.invoke(IPC.DOCUMENTS_REMOVE, req)
  },
  structure: {
    analyze: (req: StructureAnalyzeRequest): Promise<StructureAnalyzeResponse> =>
      ipcRenderer.invoke(IPC.STRUCTURE_ANALYZE, req),
    get: (req: StructureGetRequest): Promise<StructureGetResponse> =>
      ipcRenderer.invoke(IPC.STRUCTURE_GET, req)
  },
  // Home's "Chat with Tracer". Three calls, not the eight the removed Tracer
  // window had — this panel shows one conversation and cannot open, close,
  // list or delete windows that no longer exist.
  tracer: {
    getConversation: (req: TracerGetConversationRequest): Promise<TracerGetConversationResponse> =>
      ipcRenderer.invoke(IPC.TRACER_GET_CONVERSATION, req),
    send: (req: TracerSendRequest): Promise<TracerSendResponse> =>
      ipcRenderer.invoke(IPC.TRACER_SEND, req),
    newConversation: (): Promise<TracerNewConversationResponse> =>
      ipcRenderer.invoke(IPC.TRACER_NEW_CONVERSATION, {})
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET, {}),
    set: (req: SettingsSetRequest): Promise<SettingsSetResponse> =>
      ipcRenderer.invoke(IPC.SETTINGS_SET, req),
    scanInstalledApps: (): Promise<SettingsScanInstalledAppsResponse> =>
      ipcRenderer.invoke(IPC.SETTINGS_SCAN_INSTALLED_APPS, {})
  },
  profile: {
    get: (): Promise<ProfileGetResponse> => ipcRenderer.invoke(IPC.PROFILE_GET, {}),
    set: (req: ProfileSetRequest): Promise<ProfileSetResponse> => ipcRenderer.invoke(IPC.PROFILE_SET, req)
  },
  // Optional Google sign-in (main/services/auth/googleSignIn.ts). Signed out,
  // the app is a free install; signed in, it runs on that account's plan.
  auth: {
    getUser: (): Promise<AuthGetUserResponse> => ipcRenderer.invoke(IPC.AUTH_GET_USER, {}),
    /** Which plan this account is on. Never throws, never answers above free. */
    getPlan: (): Promise<AuthGetPlanResponse> => ipcRenderer.invoke(IPC.AUTH_GET_PLAN, {}),
    /** Opens the browser; resolves when the browser comes back signed in. */
    signInWithGoogle: (): Promise<AuthSignInWithGoogleResponse> =>
      ipcRenderer.invoke(IPC.AUTH_SIGN_IN_WITH_GOOGLE, {}),
    /** This computer only. */
    signOut: (): Promise<AuthSignOutResponse> => ipcRenderer.invoke(IPC.AUTH_SIGN_OUT, {}),
    /** Re-read the account now, e.g. right after buying a plan. */
    refresh: (): Promise<AuthRefreshResponse> => ipcRenderer.invoke(IPC.AUTH_REFRESH, {})
  },
  history: {
    clear: (req: HistoryClearRequest): Promise<HistoryClearResponse> =>
      ipcRenderer.invoke(IPC.HISTORY_CLEAR, req)
  },
  clipboard: {
    // No `read`. It had zero renderer callers — the global hotkey reads the
    // clipboard main-side (hotkey.ts) — so it was an unnecessary
    // read-the-user's-clipboard capability sitting on the bridge.
    write: (req: ClipboardWriteRequest): Promise<ClipboardWriteResponse> =>
      ipcRenderer.invoke(IPC.CLIPBOARD_WRITE, req)
  },
  window: {
    hide: (req: WindowTargetRequest): Promise<WindowTargetResponse> =>
      ipcRenderer.invoke(IPC.WINDOW_HIDE, req),
    show: (req: WindowTargetRequest): Promise<WindowTargetResponse> =>
      ipcRenderer.invoke(IPC.WINDOW_SHOW, req),
    // Manual resizing, because a transparent frameless window gets no
    // OS resize border — see windows/mainWindow.ts.
    resizeStart: (req: WindowResizeStartRequest): Promise<WindowResizeStartResponse> =>
      ipcRenderer.invoke(IPC.WINDOW_RESIZE_START, req),
    resizeMove: (req: WindowResizeMoveRequest): Promise<WindowResizeMoveResponse> =>
      ipcRenderer.invoke(IPC.WINDOW_RESIZE_MOVE, req),
    minimize: (): Promise<WindowMinimizeResponse> => ipcRenderer.invoke(IPC.WINDOW_MINIMIZE, {}),
    toggleMaximize: (): Promise<WindowToggleMaximizeResponse> =>
      ipcRenderer.invoke(IPC.WINDOW_TOGGLE_MAXIMIZE, {}),
    isMaximized: (): Promise<WindowIsMaximizedResponse> => ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED, {})
    // No `close`. Its handler was byte-identical to `hide` — both called
    // .hide() — and it had zero callers.
  },
  shell: {
    openExternal: (req: ShellOpenExternalRequest): Promise<ShellOpenExternalResponse> =>
      ipcRenderer.invoke(IPC.SHELL_OPEN_EXTERNAL, req)
  },
  app: {
    getBuildInfo: (): Promise<AppGetBuildInfoResponse> => ipcRenderer.invoke(IPC.APP_GET_BUILD_INFO, {})
  },
  screenWatch: {
    setEnabled: (req: ScreenWatchSetEnabledRequest): Promise<ScreenWatchSetEnabledResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_SET_ENABLED, req),
    getStatus: (): Promise<ScreenWatchGetStatusResponse> => ipcRenderer.invoke(IPC.SCREENWATCH_GET_STATUS, {}),
    setWidgetExpanded: (req: ScreenWatchSetWidgetExpandedRequest): Promise<ScreenWatchSetWidgetExpandedResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_SET_WIDGET_EXPANDED, req),
    setWidgetViewMode: (req: ScreenWatchSetWidgetViewModeRequest): Promise<ScreenWatchSetWidgetViewModeResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_SET_WIDGET_VIEW_MODE, req),
    widgetDragStart: (): Promise<ScreenWatchWidgetDragStartResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_WIDGET_DRAG_START, {}),
    widgetDragEnd: (req: ScreenWatchWidgetDragEndRequest): Promise<ScreenWatchWidgetDragEndResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_WIDGET_DRAG_END, req),
    setActivePopoverRect: (
      req: ScreenWatchSetActivePopoverRectRequest
    ): Promise<ScreenWatchSetActivePopoverRectResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_SET_ACTIVE_POPOVER_RECT, req),
    refreshEvidence: (req: ScreenWatchRefreshEvidenceRequest): Promise<ScreenWatchRefreshEvidenceResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_REFRESH_EVIDENCE, req),
    critiqueClaim: (req: ScreenWatchCritiqueClaimRequest): Promise<ScreenWatchCritiqueClaimResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_CRITIQUE_CLAIM, req),
    findSource: (req: ScreenWatchFindSourceRequest): Promise<ScreenWatchFindSourceResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_FIND_SOURCE, req),
    previewCitation: (req: ScreenWatchPreviewCitationRequest): Promise<ScreenWatchPreviewCitationResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_PREVIEW_CITATION, req),
    insertCitation: (req: ScreenWatchInsertCitationRequest): Promise<ScreenWatchInsertCitationResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_INSERT_CITATION, req),
    undoCitation: (req: ScreenWatchUndoCitationRequest): Promise<ScreenWatchUndoCitationResponse> =>
      ipcRenderer.invoke(IPC.SCREENWATCH_UNDO_CITATION, req)
  },
  onClipboardCaptured: (callback: (event: FloatingClipboardCapturedEvent) => void): (() => void) => {
    const listener = (_: unknown, payload: FloatingClipboardCapturedEvent): void => callback(payload)
    ipcRenderer.on(IPC_EVENTS.FLOATING_CLIPBOARD_CAPTURED, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.FLOATING_CLIPBOARD_CAPTURED, listener)
  },
  onScreenWatchStatus: (callback: (status: ScreenWatchStatus) => void): (() => void) => {
    const listener = (_: unknown, payload: ScreenWatchStatus): void => callback(payload)
    ipcRenderer.on(IPC_EVENTS.SCREENWATCH_STATUS_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.SCREENWATCH_STATUS_CHANGED, listener)
  },
  onScreenWatchOverlayUpdate: (callback: (event: ScreenWatchOverlayUpdateEvent) => void): (() => void) => {
    const listener = (_: unknown, payload: ScreenWatchOverlayUpdateEvent): void => callback(payload)
    ipcRenderer.on(IPC_EVENTS.SCREENWATCH_OVERLAY_UPDATE, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.SCREENWATCH_OVERLAY_UPDATE, listener)
  },
  onScreenWatchHover: (callback: (event: ScreenWatchHoverEvent | null) => void): (() => void) => {
    const listener = (_: unknown, payload: ScreenWatchHoverEvent | null): void => callback(payload)
    ipcRenderer.on(IPC_EVENTS.SCREENWATCH_HOVER_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.SCREENWATCH_HOVER_CHANGED, listener)
  },
  // Fires on the anonymous session being established at first launch and on
  // every background token refresh after that. Nothing shows a user here any
  // more; what still reads it is lib/plan.tsx, which re-asks for the plan
  // whenever the session moves.
  onAuthStateChanged: (callback: (user: AuthUser | null) => void): (() => void) => {
    const listener = (_: unknown, payload: AuthUser | null): void => callback(payload)
    ipcRenderer.on(IPC_EVENTS.AUTH_STATE_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_EVENTS.AUTH_STATE_CHANGED, listener)
  }
}

export type TracelyApi = typeof api

contextBridge.exposeInMainWorld('tracely', api)
