import type { ResizeHandle, VoiceIpcErrorKind, VoiceStartRequest, VoiceTranscriptTurn } from '@shared/ipc-contract'
import { parseVoiceIpcError } from '@shared/ipc-contract'
export class TracelyApiError extends Error {}

/**
 * A voice.start / voice.end failure with the kind the voice UI switches on
 * (plan, daily-limit, monthly-limit, busy, network, server) and a message
 * without the tag.
 * Still a TracelyApiError, so code that only shows `message` keeps working.
 */
export class VoiceApiError extends TracelyApiError {
  readonly kind: VoiceIpcErrorKind
  /** The limits: when the minutes come back (ISO-8601), when the server said. */
  readonly resetAt?: string

  constructor(kind: VoiceIpcErrorKind, message: string, resetAt?: string) {
    super(message)
    this.name = 'VoiceApiError'
    this.kind = kind
    if (resetAt) this.resetAt = resetAt
  }
}

async function call<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new TracelyApiError(message.replace(/^Error invoking remote method '[^']*':\s*/, ''))
  }
}

/** call(), plus reading main's `[voice:<kind>]` tag back into a VoiceApiError. */
async function callVoice<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (error) {
    const { kind, message, resetAt } = parseVoiceIpcError(error instanceof Error ? error.message : String(error))
    throw new VoiceApiError(kind, message, resetAt)
  }
}

export const tracelyApi = {
  detectClaims: (text: string, origin: 'main' | 'floating') =>
    call(window.tracely.analyze.detectClaims({ text, origin })),
  getAnalysisResult: (analysisId: string) =>
    call(window.tracely.analyze.getResult({ analysisId })),

  findEvidence: (claimId: string) => call(window.tracely.evidence.find({ claimId })),
  getEvidenceForClaim: (claimId: string) =>
    call(window.tracely.evidence.getForClaim({ claimId })),

  generateCitation: (sourceId: string, style: 'APA' | 'MLA' | 'Chicago') =>
    call(window.tracely.citation.generate({ sourceId, style })),
  listCitations: (sourceId: string) => call(window.tracely.citation.list({ sourceId })),

  generateCritique: (claimId: string) => call(window.tracely.critique.generate({ claimId })),

  saveToLibrary: (sourceId: string, claimId?: string, notes?: string, tags?: string[]) =>
    call(window.tracely.library.save({ sourceId, claimId, notes, tags })),
  listLibrary: (search?: string, tag?: string) =>
    call(window.tracely.library.list({ search, tag })),
  getLibraryItem: (id: string) => call(window.tracely.library.get({ id })),
  updateLibraryItem: (id: string, notes?: string, tags?: string[]) =>
    call(window.tracely.library.update({ id, notes, tags })),
  removeLibraryItem: (id: string) => call(window.tracely.library.remove({ id })),

  listDocuments: () => call(window.tracely.documents.list()),
  getDocument: (id: string) => call(window.tracely.documents.get({ id })),
  getLatestDocument: () => call(window.tracely.documents.latest()),
  saveDocument: (input: { id?: string | null; title: string; bodyHtml: string }) =>
    call(window.tracely.documents.save(input)),
  removeDocument: (id: string) => call(window.tracely.documents.remove({ id })),

  getTracerConversation: (conversationId?: string) =>
    call(window.tracely.tracer.getConversation({ conversationId })),
  sendToTracer: (conversationId: string, message: string) =>
    call(window.tracely.tracer.send({ conversationId, message })),
  newTracerConversation: () => call(window.tracely.tracer.newConversation()),

  /** Tracer Voice — main's half of a call; the audio is the renderer's WebRTC peer. */
  voice: {
    /**
     * May this account start a call now — asked before the consent sheet and
     * the mic prompt. A refusal resolves (`allowed: false`); it rejects with a
     * VoiceApiError only when the server couldn't be asked.
     */
    eligibility: () => callVoice(window.tracely.voice.eligibility()),
    /** OS mic permission; prompts once on macOS. Never rejects for a refusal — read `status`. */
    ensureMic: () => call(window.tracely.voice.ensureMic()),
    /** Rejects with a VoiceApiError carrying `kind`. */
    start: (req: VoiceStartRequest) => callVoice(window.tracely.voice.start(req)),
    /** Rejects with a VoiceApiError; the server closes the call at its cap regardless. */
    end: (sessionId: string) => callVoice(window.tracely.voice.end({ sessionId })),
    saveTranscript: (turns: VoiceTranscriptTurn[], conversationId?: string) =>
      call(window.tracely.voice.saveTranscript(conversationId ? { turns, conversationId } : { turns }))
  },

  analyzeStructure: (input: Parameters<typeof window.tracely.structure.analyze>[0]) =>
    call(window.tracely.structure.analyze(input)),
  getStructure: (documentId: string, text: string) =>
    call(window.tracely.structure.get({ documentId, text })),

  getSettings: () => call(window.tracely.settings.get()),
  setSettings: (patch: Parameters<typeof window.tracely.settings.set>[0]) =>
    call(window.tracely.settings.set(patch)),
  scanInstalledApps: () => call(window.tracely.settings.scanInstalledApps()),

  getProfile: () => call(window.tracely.profile.get()),
  setProfile: (patch: Parameters<typeof window.tracely.profile.set>[0]) =>
    call(window.tracely.profile.set(patch)),

  clearHistory: (includeLibrary: boolean) =>
    call(window.tracely.history.clear({ includeLibrary })),

  writeClipboard: (text: string) => call(window.tracely.clipboard.write({ text })),

  showWindow: (target: 'main' | 'floating') => call(window.tracely.window.show({ target })),
  hideWindow: (target: 'main' | 'floating') => call(window.tracely.window.hide({ target })),
  resizeStart: (handle: ResizeHandle) => call(window.tracely.window.resizeStart({ handle })),
  /** Real site icons, by URL. Missing or null means "draw the monogram". */
  sourceFavicons: (urls: string[]) =>
    call(window.tracely.sources.favicons({ urls })).then((res) => res.icons),
  resizeMove: (dx: number, dy: number) => call(window.tracely.window.resizeMove({ dx, dy })),
  minimizeWindow: () => call(window.tracely.window.minimize()),
  toggleMaximizeWindow: () => call(window.tracely.window.toggleMaximize()),
  isWindowMaximized: () => call(window.tracely.window.isMaximized()),

  openExternal: (url: string) => call(window.tracely.shell.openExternal({ url })),

  getBuildInfo: () => call(window.tracely.app.getBuildInfo()),

  onClipboardCaptured: (cb: (payload: { text: string }) => void) =>
    window.tracely.onClipboardCaptured(cb),

  getScreenWatchStatus: () => call(window.tracely.screenWatch.getStatus()),
  setScreenWatchEnabled: (enabled: boolean) => call(window.tracely.screenWatch.setEnabled({ enabled })),
  onScreenWatchStatus: (cb: Parameters<typeof window.tracely.onScreenWatchStatus>[0]) =>
    window.tracely.onScreenWatchStatus(cb),

  /** Whether an (anonymous) session exists at all — there is no sign-in. */
  getAuthUser: () => call(window.tracely.auth.getUser()),
  /** The account's plan — see lib/plan.tsx, which is what reads it. */
  getPlan: () => call(window.tracely.auth.getPlan()),
  /** Pro's Thorough allowance (Settings > Preferences meter); `thorough` is null when unknown. */
  getThorough: () => call(window.tracely.auth.getThorough()),
  onAuthStateChanged: (cb: Parameters<typeof window.tracely.onAuthStateChanged>[0]) =>
    window.tracely.onAuthStateChanged(cb)
}
