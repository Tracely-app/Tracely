import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { UPGRADE_URL, planRank } from '@shared/plan'
import { DEFAULT_VOICE_ID, voiceById, type VoiceId } from '@shared/voices'
import { tracelyApi } from '../../lib/api'
import { usePlan } from '../../lib/plan'
import { formatClock, voiceAnnouncement, voiceStateLine } from '../../voice/session'
import type { VoiceState } from '../../voice/types'
import { rememberVoiceRemaining, useVoiceSession } from '../../voice/useVoiceSession'
import Button from '../Button'
import VoiceCaptions from './VoiceCaptions'
import VoiceConsent from './VoiceConsent'
import VoiceControls from './VoiceControls'
import VoiceOrb from './VoiceOrb'
import { ORB_SIZE_MAX, orbSizeFor } from './orbMath'
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

/**
 * The system pane where microphone access is switched back on, or null where
 * there's no such link (the engine's platform test, kept here because the UI
 * owns the button). macOS never asks twice after a denial, so this is the
 * student's only way back.
 */
function micSettingsUrl(): string | null {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Mac/i.test(ua)) return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
  if (/Windows/i.test(ua)) return 'ms-settings:privacy-microphone'
  return null
}

/** 245 → "4 minutes 5 seconds", for the live region (a clock reads badly aloud). */
function spokenDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const m = Math.floor(s / 60)
  const r = s % 60
  const part = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`
  if (m === 0) return part(r, 'second')
  return r === 0 ? part(m, 'minute') : `${part(m, 'minute')} ${part(r, 'second')}`
}

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

  // Voice is Pro-only. The plan this window knows is checked first, so a
  // Free or Student account sees why before the consent sheet, the OS mic
  // prompt and a connection attempt — not after. The server stays the
  // authority: "I have Pro, try anyway" goes ahead for a stale plan read or a
  // local server that doesn't enforce plans, and a real refusal still comes
  // back as the 'plan' error.
  const plan = usePlan()
  const [tryAnyway, setTryAnyway] = useState(false)
  const gated = planRank(plan) < planRank('pro') && !tryAnyway

  // The call starts by itself once — when the view opens with consent given,
  // or the moment consent is (and once the plan allows it: usePlan reads
  // 'free' until the first plan read lands).
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!prefs?.consent || gated || autoStarted.current) return
    autoStarted.current = true
    void call.start()
  }, [prefs?.consent, gated, call])

  const [consentBusy, setConsentBusy] = useState(false)
  async function acceptConsent(): Promise<void> {
    setConsentBusy(true)
    // Saved before the call starts; if saving fails the call still starts —
    // the student agreed, and the sheet will simply ask again next time.
    // The sheet only enables Start talking once "I'm 13 or older" is ticked,
    // so voiceConsent=true records that answer too.
    await tracelyApi.setSettings({ voiceConsent: true }).catch(() => undefined)
    setConsentBusy(false)
    setPrefs((p) => (p ? { ...p, consent: true } : p))
  }

  function savePrefs(patch: Partial<VoicePrefs>): void {
    setPrefs((p) => (p ? { ...p, ...patch } : p))
    const settings: Parameters<typeof tracelyApi.setSettings>[0] = {}
    if (patch.voiceId) settings.voiceId = patch.voiceId
    if (patch.captions !== undefined) settings.voiceCaptions = patch.captions
    if (patch.saveTranscript !== undefined) settings.voiceSaveTranscript = patch.saveTranscript
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
  // Sticky across engines: changing the voice after a call, or a Talk again
  // that fails, makes a new engine and clears call.result — but the earlier
  // transcript is still in the chat, which has to re-read to show it.
  const savedAny = useRef(false)
  useEffect(() => {
    if (call.result?.transcriptSaved) savedAny.current = true
  }, [call.result])
  const exit = (): void => onExit(saved || savedAny.current)
  useEffect(() => {
    if (snap.state !== 'ended' || !endedByStudent.current || !call.result || stayOpen) return
    const timer = window.setTimeout(() => onExit(saved || savedAny.current), RETURN_AFTER_MS)
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

  // Microphone denied: open the system pane, and try once more when the
  // student comes back to the window (after switching access on there).
  const retryOnFocus = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      if (retryOnFocus.current) window.removeEventListener('focus', retryOnFocus.current)
    },
    []
  )
  function openMicSettings(url: string): void {
    void tracelyApi.openExternal(url).catch(() => undefined)
    if (retryOnFocus.current) window.removeEventListener('focus', retryOnFocus.current)
    const onFocus = (): void => {
      retryOnFocus.current = null
      retry()
    }
    retryOnFocus.current = onFocus
    window.addEventListener('focus', onFocus, { once: true })
  }

  // The orb is sized to its band, so a short or zoomed window shrinks it
  // rather than letting it cover the state line, timer and captions.
  const stageRef = useRef<HTMLDivElement>(null)
  const [orbSize, setOrbSize] = useState(ORB_SIZE_MAX)
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const h = entries[entries.length - 1]?.contentRect.height
      if (h !== undefined) setOrbSize(orbSizeFor(h))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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
      else exit()
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

  const showConsent = prefs !== null && !prefs.consent && snap.state === 'idle' && !gated
  const showPlanGate = prefs !== null && gated && snap.state === 'idle'
  const chipLocked = prefs === null || !UNLOCKED.includes(snap.state)
  // The AI-voice disclosure stays on screen for the whole call (the chip), and
  // the line under the orb says it again before one starts.
  const stateLine =
    prefs === null
      ? ''
      : showPlanGate
        ? 'Voice is part of Pro'
        : snap.state === 'idle'
          ? `Talk with ${persona.name}, Tracer's AI voice`
          : voiceStateLine(snap, persona.name)
  const left = snap.maxSec - snap.elapsedSec
  const nearLimit = live && snap.maxSec > 0 && left <= NEAR_LIMIT_SEC
  // The same test closedError makes from the same snapshot: this call's cap
  // comes from what is left of today's allowance, not the per-call limit.
  const dailyBound = snap.remainingTodaySec !== null && snap.remainingTodaySec <= snap.maxSec
  const minutesToday = Math.max(1, Math.ceil(snap.maxSec / 60))
  // Notices that aren't failures (a plan, a limit) rest the orb like an ended
  // call; the desaturated error look is kept for mic, network and server faults.
  const calmError = snap.state === 'error' && ['plan', 'daily-limit', 'ended-by-limit'].includes(snap.error?.kind ?? '')
  const orbState: VoiceState = calmError ? 'ended' : snap.state

  let meta: JSX.Element | string | null = null
  if (live) {
    meta = nearLimit ? (
      <span className="voice-meta-near">
        {formatClock(snap.elapsedSec)} / {formatClock(snap.maxSec)}
      </span>
    ) : dailyBound && snap.elapsedSec < 5 ? (
      // A call capped by today's allowance says so as it starts.
      `${formatClock(snap.elapsedSec)} · About ${minutesToday} min left today`
    ) : (
      formatClock(snap.elapsedSec)
    )
  } else if (snap.state === 'requesting-mic') {
    meta = 'Allow the microphone if your computer asks.'
  } else if (snap.state === 'idle' && !showPlanGate) {
    meta = persona.tagline
  } else if (snap.state === 'ended' || snap.error?.kind === 'ended-by-limit') {
    meta = `Talked for ${formatClock(call.result?.seconds ?? snap.elapsedSec)}`
  } else if (snap.state === 'error' && (call.result?.seconds ?? 0) > 0) {
    // A call that dropped after it was live still says how long it ran.
    meta = `Talked for ${formatClock(call.result?.seconds ?? 0)}`
  }

  const back = (
    <Button variant="secondary" onClick={exit}>
      Back to chat
    </Button>
  )
  const savedLine =
    call.result?.transcriptSaved === true ? (
      <p className="voice-notice-saved">
        <Check size={14} strokeWidth={2.4} aria-hidden="true" />
        Transcript saved to the chat
      </p>
    ) : call.result?.transcriptSaved === false ? (
      <p>The transcript couldn't be saved.</p>
    ) : null

  const seePro = (
    <Button variant="primary" onClick={() => void tracelyApi.openExternal(UPGRADE_URL)}>
      See Pro
    </Button>
  )

  let notice: JSX.Element | null = null
  if (showPlanGate) {
    notice = (
      <div className="voice-notice">
        <p>Upgrade to Pro to talk with Tracer out loud. You can keep chatting by text any time.</p>
        <button type="button" className="voice-link" onClick={() => setTryAnyway(true)}>
          I have Pro, try anyway
        </button>
        <div className="voice-actions">
          {back}
          {seePro}
        </div>
      </div>
    )
  } else if (snap.state === 'ended') {
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
    // A call cut by today's allowance (not the per-call cap) has nothing left to retry with.
    const canRetry = kind !== 'plan' && kind !== 'daily-limit' && !(kind === 'ended-by-limit' && dailyBound)
    const settingsUrl = kind === 'mic-denied' ? micSettingsUrl() : null
    notice = (
      <div className="voice-notice">
        <p>{snap.error.message}</p>
        {/* Whatever ended it, a call that had words saves them (finish() always does). */}
        {savedLine}
        <div className="voice-actions">
          {back}
          {kind === 'plan' ? (
            seePro
          ) : settingsUrl ? (
            <Button variant="primary" onClick={() => openMicSettings(settingsUrl)}>
              Open Settings
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

  // What the polite live region says. Built here so the end of a call and
  // the limits are heard, not only seen: the summary before the chat comes
  // back, today's cap once as the call connects, and the last minute once.
  let announcement = ''
  if (prefs !== null) {
    if (showPlanGate) {
      announcement = 'Voice is part of Pro. Upgrade to Pro to talk with Tracer out loud.'
    } else if (snap.state === 'idle') {
      announcement = stateLine
    } else if (snap.state === 'ended') {
      announcement = `Call ended. Talked for ${spokenDuration(call.result?.seconds ?? snap.elapsedSec)}.${saved ? ' Transcript saved to the chat.' : ''}`
    } else {
      announcement = voiceAnnouncement(snap, persona.name)
      if (live && dailyBound) announcement += ` About ${minutesToday} ${minutesToday === 1 ? 'minute' : 'minutes'} left today.`
      if (nearLimit) announcement += ' One minute left.'
      if (snap.state === 'error' && saved) announcement += ' Transcript saved to the chat.'
    }
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
          aria-label={`Voice: ${persona.name}, an AI voice, ${persona.accent}${chipLocked ? '' : '. Change voice'}`}
          title={chipLocked && inCall ? 'The voice can be changed between calls' : undefined}
          onClick={() => setPickerOpen(true)}
        >
          <i className="voice-chip-dot" aria-hidden="true" />
          <b>{persona.name}</b>
          <span className="voice-chip-accent">· AI voice · {persona.accent}</span>
          {chipLocked ? null : (
            <span className="voice-chip-caret" aria-hidden="true">
              <ChevronDown size={14} strokeWidth={2.2} />
            </span>
          )}
        </button>
      </div>

      <div ref={stageRef} className="voice-stage">
        <VoiceOrb
          state={orbState}
          inputLevel={snap.inputLevel}
          outputLevel={snap.outputLevel}
          muted={snap.muted}
          label={persona.name}
          size={orbSize}
          decorative
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
            <VoiceCaptions
              captions={snap.captions}
              on={prefs?.captions ?? true}
              personaName={persona.name}
              state={snap.state}
            />
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
        {announcement}
      </div>

      {pickerOpen && !chipLocked ? (
        <VoicePicker
          value={voiceId}
          onChange={(id) => {
            if (snap.state === 'ended' || snap.state === 'error') setPickedAfterCall(true)
            savePrefs({ voiceId: id })
          }}
          onClose={closePicker}
          onCloseWithoutFocus={() => setPickerOpen(false)}
        />
      ) : null}

      {showConsent ? (
        <VoiceConsent
          busy={consentBusy}
          saveTranscript={prefs.saveTranscript}
          onSaveTranscriptChange={(save) => savePrefs({ saveTranscript: save })}
          onAccept={() => void acceptConsent()}
          onDecline={exit}
        />
      ) : null}
    </div>
  )
}
