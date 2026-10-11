import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { UPGRADE_URL } from '@shared/plan'
import { DEFAULT_VOICE_ID, voiceById, type VoiceId } from '@shared/voices'
import { tracelyApi } from '../../lib/api'
import { refusalFor, type VoiceRefusal } from '../../voice/limits'
import {
  LIVE_STATES,
  errorTitle,
  formatClock,
  startError,
  voiceAnnouncement,
  voiceCallBound,
  voiceStateLine,
  type VoiceError
} from '../../voice/session'
import type { VoiceState } from '../../voice/types'
import { rememberVoiceAllowance, rememberVoiceRemaining, useVoiceSession } from '../../voice/useVoiceSession'
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
 * Flow: open → the server says whether a call may start (eligibility: plan,
 * voice on, a free line, minutes left) → (first time) the consent sheet → the
 * call starts by itself → End → "Talked for 4:05 · Transcript saved to the
 * chat" → back to the chat. A refusal is shown before the consent sheet and
 * the microphone prompt, never after them; "Talk again" asks again first.
 * Keys while the view has focus: Esc ends the call (or leaves), M mutes.
 */

/** The timer shows the cap once this little of the call is left. */
const NEAR_LIMIT_SEC = 60
/** After the student hangs up, the summary stays this long, then the chat comes back. */
const RETURN_AFTER_MS = 3000
const IN_CALL: readonly VoiceState[] = ['requesting-mic', 'connecting', ...LIVE_STATES]
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

/** The eligibility answer as the view uses it. */
type EligibilityCheck =
  | { status: 'checking' }
  | { status: 'ok' }
  | { status: 'refused'; refusal: VoiceRefusal }
  /** Couldn't reach Tracely to ask: shown like a failed start, with Try again. */
  | { status: 'unreachable'; error: VoiceError }

interface VoicePrefs {
  voiceId: VoiceId
  captions: boolean
  saveTranscript: boolean
  consent: boolean
}

export default function VoiceMode({
  conversationId,
  onExit,
  onTranscriptSaved
}: {
  /** The conversation the panel shows; a saved transcript is added to it. */
  conversationId: string | null
  /** Back to the chat; `transcriptSaved` tells the panel to re-read the conversation. */
  onExit: (transcriptSaved: boolean) => void
  /** Once per call whose transcript was saved: who it was with and how long, for the chat's divider. */
  onTranscriptSaved?: (call: { voiceName: string; seconds: number }) => void
}): JSX.Element {
  const [prefs, setPrefs] = useState<VoicePrefs | null>(null)
  useEffect(() => {
    let cancelled = false
    tracelyApi
      .getSettings()
      .then((s) => ({
        voiceId: voiceById(s.voiceId).id,
        captions: s.voiceCaptions !== false,
        // Off unless the student turned it on (the default is false).
        saveTranscript: s.voiceSaveTranscript === true,
        consent: s.voiceConsent === true
      }))
      .catch(() => ({ voiceId: DEFAULT_VOICE_ID, captions: true, saveTranscript: false, consent: false }))
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
  const live = LIVE_STATES.includes(snap.state)
  const inCall = IN_CALL.includes(snap.state)

  // May a call start? The server answers (plan, voice switched on, a free
  // line, minutes left today and this month) before the consent sheet and the
  // OS mic prompt, so a refusal costs the student neither. It is asked again
  // before every new call. When it can't be asked: offline is said at once;
  // anything else (an older server) goes ahead and lets the start decide.
  const [check, setCheck] = useState<EligibilityCheck>({ status: 'checking' })
  const checkSeq = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    // Set again on mount: StrictMode unmounts and remounts once in development.
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function checkEligibility(): Promise<boolean> {
    const seq = ++checkSeq.current
    setCheck({ status: 'checking' })
    let next: EligibilityCheck
    try {
      const e = await tracelyApi.voice.eligibility()
      if (e.allowed) {
        rememberVoiceAllowance(e)
        next = { status: 'ok' }
      } else {
        next = { status: 'refused', refusal: refusalFor(e) }
      }
    } catch (err) {
      const kind = (err as { kind?: unknown } | null)?.kind
      next = kind === 'network' ? { status: 'unreachable', error: startError(err) } : { status: 'ok' }
    }
    if (seq !== checkSeq.current || !mounted.current) return false
    setCheck(next)
    return next.status === 'ok'
  }
  useEffect(() => {
    void checkEligibility()
    // Once, as the view opens; retry() asks again before each new call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const allowed = check.status === 'ok'

  // The call starts by itself once — when the view opens with consent given,
  // or the moment consent is — and only once the server has said yes.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!prefs?.consent || !allowed || autoStarted.current) return
    autoStarted.current = true
    void call.start()
  }, [prefs?.consent, allowed, call])

  const [consentBusy, setConsentBusy] = useState(false)
  async function acceptConsent(): Promise<void> {
    setConsentBusy(true)
    // Saved before the call starts; if saving fails the call still starts —
    // the student agreed, and the sheet will simply ask again next time.
    // The sheet only enables Start talking once "I'm 13 or older" is ticked,
    // so voiceConsent=true records that answer too.
    // The transcript answer is written with it, explicitly, whether or not
    // the box was touched: what the student saw on the sheet is what applies.
    await tracelyApi
      .setSettings({ voiceConsent: true, voiceSaveTranscript: prefs?.saveTranscript === true })
      .catch(() => undefined)
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
  const reported = useRef<typeof call.result>(null)
  const onSavedRef = useRef(onTranscriptSaved)
  onSavedRef.current = onTranscriptSaved
  useEffect(() => {
    const r = call.result
    if (!r?.transcriptSaved) return
    savedAny.current = true
    if (reported.current === r) return
    reported.current = r
    // Reported when the result lands, while the voice is still the call's own
    // (picking another clears the result first; `reported` guards a re-run).
    onSavedRef.current?.({ voiceName: persona.name, seconds: r.seconds })
  }, [call.result, persona.name])
  const exit = (): void => onExit(saved || savedAny.current)
  useEffect(() => {
    if (snap.state !== 'ended' || !endedByStudent.current || !call.result || stayOpen) return
    const timer = window.setTimeout(() => onExit(saved || savedAny.current), RETURN_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [snap.state, call.result, stayOpen, saved, onExit])

  // Settings shows the minutes as last seen: what was left at the start less
  // what the server metered (its hang-up answer), else the app's own clock.
  useEffect(() => {
    if (call.result && snap.remainingTodaySec !== null && !snap.mock) {
      rememberVoiceRemaining(snap.remainingTodaySec, call.result.serverSeconds ?? call.result.seconds, {
        resetAt: snap.resetAt,
        remainingMonthSec: snap.remainingMonthSec
      })
    }
  }, [call.result, snap.remainingTodaySec, snap.mock, snap.resetAt, snap.remainingMonthSec])

  // "Try again" / "Talk again" / "New call": ask the server again first, so a
  // call that used up today's minutes, or a line still busy, is said without
  // lighting the microphone.
  const [rechecking, setRechecking] = useState(false)
  async function checkThen(go: () => void): Promise<void> {
    setRechecking(true)
    const ok = await checkEligibility()
    if (!mounted.current) return
    setRechecking(false)
    if (ok) go()
  }
  async function retry(): Promise<void> {
    endedByStudent.current = false
    setStayOpen(false)
    // Refused before any call started (as the view opened): a yes now hands
    // over to the auto-start (or the consent sheet) — restarting here too
    // would open a second call.
    if (!autoStarted.current) return checkThen(() => undefined)
    await checkThen(() => call.restart())
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
      void retry()
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

  // A refusal (or no way to ask) holds the view whenever no call is running:
  // as it opens, and when a new call was refused.
  const refusal = check.status === 'refused' && !inCall ? check.refusal : null
  const unreachable = check.status === 'unreachable' && !inCall ? check.error : null
  const showConsent = prefs !== null && !prefs.consent && snap.state === 'idle' && allowed && !rechecking
  const chipLocked = prefs === null || !UNLOCKED.includes(snap.state) || rechecking
  // The AI-voice disclosure stays on screen for the whole call (the chip), and
  // the line under the orb says it again before one starts.
  const stateLine =
    prefs === null
      ? ''
      : rechecking
        ? 'Connecting…'
        : refusal
          ? refusal.title
          : unreachable
            ? errorTitle(unreachable.kind)
            : snap.state === 'idle'
              ? `Talk with ${persona.name}, Tracer's AI voice`
              : voiceStateLine(snap, persona.name)
  const left = snap.maxSec - snap.elapsedSec
  const nearLimit = live && snap.maxSec > 0 && left <= NEAR_LIMIT_SEC
  // The same test closedError makes from the same snapshot: what capped this
  // call — the month's allowance, today's, or the per-call limit.
  const bound = voiceCallBound(snap.maxSec, snap.remainingTodaySec, snap.remainingMonthSec ?? null)
  const minutesLeft = Math.max(1, Math.ceil(snap.maxSec / 60))
  const boundWhen = bound === 'month' ? 'this month' : 'today'
  // Notices that aren't failures (a plan, a limit, a safety stop) rest the orb
  // like an ended call; the desaturated look is kept for mic, network and
  // server faults.
  const calmError =
    snap.state === 'error' &&
    ['plan', 'daily-limit', 'monthly-limit', 'ended-by-limit', 'safety'].includes(snap.error?.kind ?? '')
  const orbState: VoiceState = rechecking
    ? 'connecting'
    : refusal
      ? 'ended'
      : unreachable
        ? 'error'
        : calmError
          ? 'ended'
          : snap.state

  let meta: JSX.Element | string | null = null
  if (rechecking) {
    meta = null
  } else if (refusal || unreachable) {
    // Refused after a call: that call still says how long it ran.
    meta = (call.result?.seconds ?? 0) > 0 ? `Talked for ${formatClock(call.result?.seconds ?? 0)}` : null
  } else if (live) {
    meta = nearLimit ? (
      <span className="voice-meta-near">
        {formatClock(snap.elapsedSec)} / {formatClock(snap.maxSec)}
      </span>
    ) : bound !== 'call' && snap.elapsedSec < 5 ? (
      // A call capped by today's (or this month's) allowance says so as it starts.
      `${formatClock(snap.elapsedSec)} · About ${minutesLeft} min left ${boundWhen}`
    ) : (
      formatClock(snap.elapsedSec)
    )
  } else if (snap.state === 'requesting-mic') {
    meta = 'Allow the microphone if your computer asks.'
  } else if (snap.state === 'idle') {
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
  if (refusal) {
    // The server said no before any consent sheet or microphone prompt (or
    // before a new call): why, when the minutes come back, and the way on.
    notice = (
      <div className="voice-notice">
        <p>{refusal.message}</p>
        {savedLine}
        <div className="voice-actions">
          {back}
          {refusal.reason === 'plan' ? (
            seePro
          ) : refusal.reason === 'busy' ? (
            <Button variant="primary" onClick={() => void retry()}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    )
  } else if (unreachable) {
    notice = (
      <div className="voice-notice">
        <p>{unreachable.message}</p>
        {savedLine}
        <div className="voice-actions">
          {back}
          <Button variant="primary" onClick={() => void retry()}>
            Try again
          </Button>
        </div>
      </div>
    )
  } else if (snap.state === 'ended') {
    notice = (
      <div className="voice-notice">
        {savedLine ?? <p>Thanks for talking.</p>}
        <div className="voice-actions">
          {back}
          <Button variant="primary" onClick={() => void retry()}>
            Talk again
          </Button>
        </div>
      </div>
    )
  } else if (snap.state === 'error' && snap.error) {
    const kind = snap.error.kind
    // A used-up allowance has nothing left to retry with (a call cut by
    // today's or the month's minutes, not the per-call cap), and a call a
    // safety check stopped is not one to jump straight back into.
    const canRetry =
      kind !== 'plan' &&
      kind !== 'daily-limit' &&
      kind !== 'monthly-limit' &&
      kind !== 'safety' &&
      !(kind === 'ended-by-limit' && bound !== 'call')
    const settingsUrl = kind === 'mic-denied' ? micSettingsUrl() : null
    notice = (
      <div className="voice-notice">
        <p>{snap.error.message}</p>
        {/* Whatever ended it, a call that had words saves them (finish() always does). */}
        {savedLine}
        <div className="voice-actions">
          {kind === 'safety' ? (
            // The way back is the one action, and the prominent one.
            <Button variant="primary" onClick={exit}>
              Back to chat
            </Button>
          ) : (
            back
          )}
          {kind === 'plan' ? (
            seePro
          ) : settingsUrl ? (
            <Button variant="primary" onClick={() => openMicSettings(settingsUrl)}>
              Open Settings
            </Button>
          ) : canRetry ? (
            <Button variant="primary" onClick={() => void retry()}>
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
              void checkThen(() => void call.start())
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
    if (rechecking) {
      announcement = 'Connecting…'
    } else if (refusal) {
      announcement = `${refusal.title}. ${refusal.message}`
    } else if (unreachable) {
      announcement = `${errorTitle(unreachable.kind)}. ${unreachable.message}`
    } else if (snap.state === 'idle') {
      announcement = stateLine
    } else if (snap.state === 'ended') {
      announcement = `Call ended. Talked for ${spokenDuration(call.result?.seconds ?? snap.elapsedSec)}.${saved ? ' Transcript saved to the chat.' : ''}`
    } else {
      announcement = voiceAnnouncement(snap, persona.name)
      if (live && bound !== 'call') {
        announcement += ` About ${minutesLeft} ${minutesLeft === 1 ? 'minute' : 'minutes'} left ${boundWhen}.`
      }
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
        {rechecking ? null : notice ?? (
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
