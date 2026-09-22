export const IPC = {
  ANALYZE_DETECT_CLAIMS: 'analyze:detectClaims',
  ANALYZE_GET_RESULT: 'analyze:getResult',

  EVIDENCE_FIND: 'evidence:find',
  EVIDENCE_GET_FOR_CLAIM: 'evidence:getForClaim',
  EVIDENCE_FOR_TEXT: 'evidence:forText',
  CLAIMS_OFF_TOPIC: 'claims:offTopic',

  CITATION_GENERATE: 'citation:generate',
  CITATION_LIST: 'citation:list',
  CITATION_RESOLVE_CITED: 'citation:resolveCited',

  CRITIQUE_GENERATE: 'critique:generate',

  LIBRARY_SAVE: 'library:save',
  LIBRARY_LIST: 'library:list',
  LIBRARY_GET: 'library:get',
  LIBRARY_UPDATE: 'library:update',
  LIBRARY_REMOVE: 'library:remove',

  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_SCAN_INSTALLED_APPS: 'settings:scanInstalledApps',

  PROFILE_GET: 'profile:get',
  PROFILE_SET: 'profile:set',

  HISTORY_CLEAR: 'history:clear',

  DOCUMENTS_LIST: 'documents:list',
  DOCUMENTS_GET: 'documents:get',
  DOCUMENTS_LATEST: 'documents:latest',
  DOCUMENTS_SAVE: 'documents:save',
  DOCUMENTS_REMOVE: 'documents:remove',

  STRUCTURE_ANALYZE: 'structure:analyze',
  STRUCTURE_GET: 'structure:get',

  CLIPBOARD_READ: 'clipboard:read',
  CLIPBOARD_WRITE: 'clipboard:write',

  WINDOW_HIDE: 'window:hide',
  WINDOW_SHOW: 'window:show',
  WINDOW_CLOSE: 'window:close',
  // Manual window resizing. The OS cannot do this one for us — see
  // renderer/src/components/ResizeGrips.tsx.
  WINDOW_RESIZE_START: 'window:resizeStart',
  WINDOW_RESIZE_MOVE: 'window:resizeMove',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggleMaximize',
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',

  SHELL_OPEN_EXTERNAL: 'shell:openExternal',

  APP_GET_BUILD_INFO: 'app:getBuildInfo',

  SCREENWATCH_SET_ENABLED: 'screenWatch:setEnabled',
  SCREENWATCH_GET_STATUS: 'screenWatch:getStatus',
  SCREENWATCH_SET_WIDGET_EXPANDED: 'screenWatch:setWidgetExpanded',
  SCREENWATCH_SET_WIDGET_VIEW_MODE: 'screenWatch:setWidgetViewMode',
  SCREENWATCH_REFRESH_EVIDENCE: 'screenWatch:refreshEvidence',
  SCREENWATCH_CRITIQUE_CLAIM: 'screenWatch:critiqueClaim',
  SCREENWATCH_WIDGET_DRAG_START: 'screenWatch:widgetDragStart',
  SCREENWATCH_WIDGET_DRAG_END: 'screenWatch:widgetDragEnd',
  SCREENWATCH_SET_ACTIVE_POPOVER_RECT: 'screenWatch:setActivePopoverRect',
  SCREENWATCH_FIND_SOURCE: 'screenWatch:findSource',
  SCREENWATCH_PREVIEW_CITATION: 'screenWatch:previewCitation',
  SCREENWATCH_INSERT_CITATION: 'screenWatch:insertCitation',
  SCREENWATCH_UNDO_CITATION: 'screenWatch:undoCitation',

  TRACER_OPEN: 'tracer:open',
  TRACER_CLOSE: 'tracer:close',
  TRACER_SEND: 'tracer:send',
  TRACER_RETRY: 'tracer:retry',
  TRACER_GET_CONVERSATION: 'tracer:getConversation',
  TRACER_LIST_CONVERSATIONS: 'tracer:listConversations',
  TRACER_NEW_CONVERSATION: 'tracer:newConversation',
  TRACER_DELETE_CONVERSATION: 'tracer:deleteConversation',

  AUTH_GET_USER: 'auth:getUser',
  AUTH_SIGN_UP: 'auth:signUp',
  AUTH_SIGN_IN: 'auth:signIn',
  AUTH_SIGN_OUT: 'auth:signOut',
  AUTH_SIGN_IN_WITH_GOOGLE: 'auth:signInWithGoogle',
  AUTH_UPDATE_NAME: 'auth:updateName',
  AUTH_UPDATE_USERNAME: 'auth:updateUsername',
  AUTH_DELETE_ACCOUNT: 'auth:deleteAccount',
  AUTH_GET_PLAN: 'auth:getPlan',
  AUTH_GET_THOROUGH: 'auth:getThorough',
  SOURCES_FAVICONS: 'sources:favicons'
} as const

export const IPC_EVENTS = {
  FLOATING_CLIPBOARD_CAPTURED: 'floating:clipboardCaptured',
  SCREENWATCH_STATUS_CHANGED: 'screenWatch:statusChanged',
  SCREENWATCH_OVERLAY_UPDATE: 'screenWatch:overlayUpdate',
  SCREENWATCH_HOVER_CHANGED: 'screenWatch:hoverChanged',
  TRACER_CONTEXT_CHANGED: 'tracer:contextChanged',
  TRACER_OPENED: 'tracer:opened',
  AUTH_STATE_CHANGED: 'auth:stateChanged',
  AUTH_OAUTH_ERROR: 'auth:oauthError'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
export type IpcEvent = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]
