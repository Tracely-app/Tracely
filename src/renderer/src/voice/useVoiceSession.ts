/* useVoiceSession: one voice engine (voice/session.ts) per voice view, read
 * through useSyncExternalStore.
 *
 * The engine is made in an effect, not in render or a state initializer: React
 * StrictMode mounts, unmounts and remounts in development, and an engine made
 * during render would be made twice and one of them never disposed (its
 * listeners left on the window). The effect's cleanup disposes it, which hangs
 * up a call that is still open. A start asked for before the engine exists
 * waits for it, deferred a tick so a StrictMode throwaway engine never opens a
 * call (one live call per account — a second would be refused as busy).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { VoiceId } from '@shared/voices'
import { tracelyApi } from '../lib/api'
import { createVoiceSession, type VoiceCallResult, type VoiceEngine } from './session'
import type { VoiceSnapshot } from './types'

export interface UseVoiceSessionOptions {
  /** voiceSaveTranscript, read when the call ends */
  saveTranscript?: boolean
  /** the conversation the panel shows; the transcript is added to it */
  conversationId?: string | null
}

export interface VoiceSessionControls {
  snapshot: VoiceSnapshot
  start(): Promise<void>
  end(): Promise<void>
  setMuted(muted: boolean): void
  /** A fresh engine (same voice), started — "Try again" / "Talk again". */
  restart(): void
  /** What the finished call left: seconds talked, whether the transcript saved. */
  result: VoiceCallResult | null
}

const NOOP_UNSUBSCRIBE = (): void => {}

function idleSnapshot(voiceId: VoiceId): VoiceSnapshot {
  return {
    state: 'idle',
    voiceId,
    muted: false,
    elapsedSec: 0,
    maxSec: 0,
    remainingTodaySec: null,
    inputLevel: 0,
    outputLevel: 0,
    captions: [],
    error: null,
    mock: false
  }
}

export function useVoiceSession(voiceId: VoiceId, options: UseVoiceSessionOptions = {}): VoiceSessionControls {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [engine, setEngine] = useState<VoiceEngine | null>(null)
  const [generation, setGeneration] = useState(0)
  const [result, setResult] = useState<VoiceCallResult | null>(null)
  const pendingStart = useRef(false)

  useEffect(() => {
    const e = createVoiceSession({
      voiceId,
      api: tracelyApi.voice,
      shouldSaveTranscript: () => optionsRef.current.saveTranscript === true,
      conversationId: () => optionsRef.current.conversationId
    })
    setEngine(e)
    setResult(null)
    // Deferred so StrictMode's throwaway engine is disposed (and refuses to
    // start) before this runs; the surviving engine starts.
    const timer = window.setTimeout(() => {
      if (!pendingStart.current) return
      pendingStart.current = false
      void e.start()
    }, 0)
    let live = true
    const off = e.subscribe((s) => {
      if (s.state === 'ended' || s.state === 'error') {
        void e.settled().then((r) => {
          if (live) setResult(r)
        })
      }
    })
    return () => {
      live = false
      window.clearTimeout(timer)
      off()
      e.dispose()
    }
  }, [voiceId, generation])

  const fallback = useRef<VoiceSnapshot>(idleSnapshot(voiceId))
  if (fallback.current.voiceId !== voiceId) fallback.current = idleSnapshot(voiceId)
  const subscribe = useCallback(
    (listener: () => void) => (engine ? engine.subscribe(listener) : NOOP_UNSUBSCRIBE),
    [engine]
  )
  const getSnapshot = useCallback(() => (engine ? engine.getSnapshot() : fallback.current), [engine])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)

  const start = useCallback(async () => {
    if (engine && engine.getSnapshot().voiceId === voiceId) return engine.start()
    pendingStart.current = true
  }, [engine, voiceId])
  const end = useCallback(async () => {
    pendingStart.current = false
    await engine?.end()
  }, [engine])
  const setMuted = useCallback((muted: boolean) => engine?.setMuted(muted), [engine])
  const restart = useCallback(() => {
    pendingStart.current = true
    setGeneration((g) => g + 1)
  }, [])

  return { snapshot, start, end, setMuted, restart, result }
}

// ── Today's voice minutes, as last seen ─────────────────────────────────────
// The server tells the app what is left only when a call starts. Settings
// shows the figure from the latest call, kept per local day in this
// renderer's storage (the server counts days the same way, by calendar date),
// and nothing once the day has turned over. A convenience, not a ledger.

const REMAINING_KEY = 'tracely.voice.remainingToday'
/** Every call costs at least this much of the allowance (OpenAI bills the set-up). */
const MIN_BILLED_SEC = 15

function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/** After a call: what was left when it started, less what it used. */
export function rememberVoiceRemaining(remainingAtStartSec: number, talkedSec: number, at = new Date()): void {
  const seconds = Math.max(0, Math.round(remainingAtStartSec - Math.max(talkedSec, MIN_BILLED_SEC)))
  try {
    localStorage.setItem(REMAINING_KEY, JSON.stringify({ day: localDay(at), seconds }))
  } catch {
    /* storage blocked: Settings just won't show the figure */
  }
}

/** Seconds of voice left today as last seen, or null when unknown (no call today). */
export function readVoiceRemaining(at = new Date()): number | null {
  try {
    const raw = localStorage.getItem(REMAINING_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { day?: unknown; seconds?: unknown }
    return v.day === localDay(at) && typeof v.seconds === 'number' ? v.seconds : null
  } catch {
    return null
  }
}
