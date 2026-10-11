import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { UPGRADE_URL } from '@shared/plan'
import { DEFAULT_VOICE_ID, voiceById, type VoiceId } from '@shared/voices'
import { tracelyApi } from '../../lib/api'
import { formatClock, voiceAnnouncement, voiceStateLine } from '../../voice/session'
import type { VoiceState } from '../../voice/types'
import { rememberVoiceRemaining, useVoiceSession } from '../../voice/useVoiceSession'
import Button from '../Button'
import VoiceCaptions from './VoiceCaptions'
import VoiceConsent from './VoiceConsent'
import VoiceControls from './VoiceControls'
import VoiceOrb from './VoiceOrb'
import VoicePicker from './VoicePicker'
import '../../styles/voice.css'

/**
 * Tracer Voice: the voice view that replaces the message list in the Tracer
 * panel. One focal point — the orb — with the persona above it, what is
 * happening under it, then the captions and the three controls. Everything
 * the call does comes from the engine's snapshot (useVoiceSession); this file
 * only draws it and turns clicks and keys into start / end / mute.
 *
 * Flow: open → (first time) the consent sheet → the call starts by itself →
 * End → "Talked for 4:05 · Transcript saved to the chat" → back to the chat.
 * Keys while the view has focus: Esc ends the call (or leaves), M mutes.
 */

/** The timer shows the cap once this little of the call is left. */
const NEAR_LIMIT_SEC = 60
/** After the student hangs up, the summary stays this long, then the chat comes back. */
const RETURN_AFTER_MS = 3000
const LIVE: readonly VoiceState[] = ['listening', 'user-speaking', 'assistant-speaking']
const IN_CALL: readonly VoiceState[] = ['requesting-mic', 'connecting', ...LIVE]
/** States in which the persona can still be changed: nothing is connected. */
const UNLOCKED: readonly VoiceState[] = ['idle', 'ended', 'error']

interface VoicePrefs {
  voiceId: VoiceId
  captions: boolean
  saveTranscript: boolean
  consent: boolean
}

export default function VoiceMode({
  conversationId,
  onExit
}: {
  /** The conversation the panel shows; a saved transcript is added to it. */
  conversationId: string | null
  /** Back to the chat; `transcriptSaved` tells the panel to re-read the conversation. */
  onExit: (transcriptSaved: boolean) => void
}): JSX.Element {
  const [prefs, setPrefs] = useState<VoicePrefs | null>(null)
  useEffect(() => {
    let cancelled = false
    tracelyApi
      .getSettings()
      .then((s) => ({
        voiceId: voiceById(s.voiceId).id,
        captions: s.voiceCaptions !== false,
        saveTranscript: s.voiceSaveTranscript !== false,
        consent: s.voiceConsent === true
      }))
      .catch(() => ({ voiceId: DEFAULT_VOICE_ID, captions: true, saveTranscript: true, consent: false }))
      .then((p) => {
        if (!cancelled) setPrefs(p)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const voiceId = prefs?.voiceId ?? DEFAULT_VOICE_ID
  const persona = voiceById(voiceId)
  const call = useVoiceSession(voiceId, { saveTranscript: prefs?.saveTranscript, conversationId })
  const snap = call.snapshot
  const live = LIVE.includes(snap.state)
  const inCall = IN_CALL.includes(snap.state)

  // The call starts by itself once — when the view opens with consent given,
  // or the moment consent is.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!prefs?.consent || autoStarted.current) return
    autoStarted.current = true
    void call.start()
  }, [prefs?.consent, call])

  const [consentBusy, setConsentBusy] = useState(false)
  async function acceptConsent(): Promise<void> {
    setConsentBusy(true)
    // Saved before the call starts; if saving fails the call still starts —
    // the student agreed, and the sheet will simply ask again next time.
    await tracelyApi.setSettings({ voiceConsent: true }).catch(() => undefined)
    setConsentBusy(false)
    setPrefs((p) => (p ? { ...p, consent: true } : p))
  }

  function savePrefs(patch: Partial<VoicePrefs>): void {
    setPrefs((p) => (p ? { ...p, ...patch } : p))
    const settings: Parameters<typeof tracelyApi.setSettings>[0] = {}
    if (patch.voiceId) settings.voiceId = patch.voiceId
    if (patch.captions !== undefined) settings.voiceCaptions = patch.captions
    void tracelyApi.setSettings(settings).catch(() => undefined)
  }

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickedAfterCall, setPickedAfterCall] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  function closePicker(): void {
    setPickerOpen(false)
    chipRef.current?.focus()
  }

  // Hanging up: the summary shows, then the chat comes back by itself unless
  // the student starts doing something in the view.
  const endedByStudent = useRef(false)
  const [stayOpen, setStayOpen] = useState(false)
  async function hangUp(): Promise<void> {
    endedByStudent.current = true
    await call.end()
  }
  const saved = call.result?.transcriptSaved === true
  useEffect(() => {
    if (snap.state !== 'ended' || !endedByStudent.current || !call.result || stayOpen) return
    const timer = window.setTimeout(() => onExit(saved), RETURN_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [snap.state, call.result, stayOpen, saved, onExit])

  // Settings shows today's minutes as last seen.
  useEffect(() => {
    if (call.result && snap.remainingTodaySec !== null && !snap.mock) {
      rememberVoiceRemaining(snap.remainingTodaySec, call.result.seconds)
    }
  }, [call.result, snap.remainingTodaySec, snap.mock])

  function retry(): void {
    endedByStudent.current = false
    setStayOpen(false)
    call.restart()
  }

  // Focus lands in the view so Esc and M work at once, and comes back to it
  // when the focused control goes away (the consent sheet, a notice's
  // button) — but only when focus fell to the page, never taken from
  // somewhere the student moved it (typing in the draft during a call).
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    rootRef.current?.focus()
  }, [])
  const showingConsent = prefs !== null && !prefs.consent
  useEffect(() => {
    const active = document.activeElement
    if (!active || active === document.body) rootRef.current?.focus()
  }, [snap.state, showingConsent])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (pickerOpen || e.defaultPrevented) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (inCall) void hangUp()
      else onExit(saved)
      return
    }
    // Moving around the summary keeps it open; it only leaves by itself untouched.
    if (snap.state === 'ended') setStayOpen(true)
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey
    if (plain && (e.key === 'm' || e.key === 'M') && live) {
      e.preventDefault()
      call.setMuted(!snap.muted)
    }
  }

  const showConsent = prefs !== null && !prefs.consent && snap.state === 'idle'
  const chipLocked = prefs === null || !UNLOCKED.includes(snap.state)
  const stateLine = prefs === null ? '' : voiceStateLine(snap, persona.name)
  const left = snap.maxSec - snap.elapsedSec

  let meta: JSX.Element | string | null = null
  if (live) {
    meta =
      snap.maxSec > 0 && left <= NEAR_LIMIT_SEC ? (
        <span className="voice-meta-near">
          {formatClock(snap.elapsedSec)} / {formatClock(snap.maxSec)}
        </span>
      ) : (
        formatClock(snap.elapsedSec)
      )
  } else if (snap.state === 'requesting-mic') {
    meta = 'Allow the microphone if your computer asks.'
  } else if (snap.state === 'idle') {
    meta = persona.tagline
  } else if (snap.state === 'ended' || snap.error?.kind === 'ended-by-limit') {
    meta = `Talked for ${formatClock(call.result?.seconds ?? snap.elapsedSec)}`
  }

  const back = (
    <Button variant="secondary" onClick={() => onExit(saved)}>
      Back to chat
    </Button>
  )
  const savedLine =
    call.result?.transcriptSaved === true ? (
      <p className="voice-notice-saved">Transcript saved to the chat</p>
    ) : call.result?.transcriptSaved === false ? (
      <p>The transcript couldn't be saved.</p>
    ) : null

  let notice: JSX.Element | null = null
  if (snap.state === 'ended') {
    notice = (
      <div className="voice-notice">
        {savedLine ?? <p>Thanks for talking.</p>}
        <div className="voice-actions">
          {back}
          <Button variant="primary" onClick={retry}>
            Talk again
          </Button>
        </div>
      </div>
    )
  } else if (snap.state === 'error' && snap.error) {
    const kind = snap.error.kind
    const canRetry = kind !== 'plan' && kind !== 'daily-limit' && !(kind === 'ended-by-limit' && /today/.test(snap.error.message))
    notice = (
      <div className="voice-notice">
        <p>{snap.error.message}</p>
        {kind === 'ended-by-limit' ? savedLine : null}
        <div className="voice-actions">
          {back}
          {kind === 'plan' ? (
            <Button variant="primary" onClick={() => void tracelyApi.openExternal(UPGRADE_URL)}>
              See Pro
            </Button>
          ) : canRetry ? (
            <Button variant="primary" onClick={retry}>
              {kind === 'ended-by-limit' ? 'New call' : 'Try again'}
            </Button>
          ) : null}
        </div>
      </div>
    )
  } else if (snap.state === 'idle' && pickedAfterCall) {
    // A new voice was picked after a call ended: start when they're ready.
    notice = (
      <div className="voice-notice">
        <p>{persona.description}</p>
        <div className="voice-actions">
          {back}
          <Button
            variant="primary"
            onClick={() => {
              setPickedAfterCall(false)
              void call.start()
            }}
          >
            Start talking
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="voice-mode"
      tabIndex={-1}
      role="region"
      aria-label={`Voice call with ${persona.name}`}
      onKeyDown={onKeyDown}
      onPointerDown={() => {
        if (snap.state === 'ended') setStayOpen(true)
      }}
    >
      <div className="voice-top">
        <button
          ref={chipRef}
          type="button"
          className="voice-chip"
          disabled={chipLocked}
          aria-haspopup="true"
          aria-expanded={pickerOpen}
          aria-label={chipLocked ? `Voice: ${persona.name}, ${persona.accent}` : `Voice: ${persona.name}, ${persona.accent}. Change voice`}
          title={chipLocked && inCall ? 'The voice can be changed between calls' : undefined}
          onClick={() => setPickerOpen(true)}
        >
          <i className="voice-chip-dot" aria-hidden="true" />
          <b>{persona.name}</b>
          <span className="voice-chip-accent">· {persona.accent}</span>
          {chipLocked ? null : (
            <span className="voice-chip-caret" aria-hidden="true">
              <ChevronDown size={14} strokeWidth={2.2} />
            </span>
          )}
        </button>
      </div>

      <div className="voice-stage">
        <VoiceOrb
          state={snap.state}
          inputLevel={snap.inputLevel}
          outputLevel={snap.outputLevel}
          muted={snap.muted}
          label={persona.name}
          size={168}
        />
      </div>

      <div className="voice-status">
        {stateLine ? (
          <p key={stateLine} className="voice-state">
            {stateLine}
          </p>
        ) : null}
        <span className="voice-meta">
          {snap.mock && (live || snap.state === 'connecting') ? <span className="voice-demo">DEMO</span> : null}
          {meta}
        </span>
      </div>

      <div className="voice-bottom">
        {notice ?? (
          <>
            <VoiceCaptions captions={snap.captions} on={prefs?.captions ?? true} personaName={persona.name} />
            {prefs === null || showConsent || snap.state === 'idle' ? null : (
              <VoiceControls
                muted={snap.muted}
                captionsOn={prefs.captions}
                disabled={!live}
                onToggleMute={() => call.setMuted(!snap.muted)}
                onEnd={() => void hangUp()}
                onToggleCaptions={() => savePrefs({ captions: !prefs.captions })}
              />
            )}
          </>
        )}
      </div>

      <div className="sr-only" aria-live="polite">
        {prefs === null ? '' : voiceAnnouncement(snap, persona.name)}
      </div>

      {pickerOpen && !chipLocked ? (
        <VoicePicker
          value={voiceId}
          onChange={(id) => {
            if (snap.state === 'ended' || snap.state === 'error') setPickedAfterCall(true)
            savePrefs({ voiceId: id })
          }}
          onClose={closePicker}
        />
      ) : null}

      {showConsent ? (
        <VoiceConsent busy={consentBusy} onAccept={() => void acceptConsent()} onDecline={() => onExit(false)} />
      ) : null}
    </div>
  )
}
