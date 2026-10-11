import { useState } from 'react'
import { tracelyApi } from '../../lib/api'
import Button from '../Button'

/**
 * The disclosure the first call shows (and Settings → Voice repeats). Says
 * what actually leaves the computer: the audio, and the most recently edited
 * draft with its title (main's currentContext(), which may not be the one on
 * screen), via Tracely's server. "AI‑generated" uses a non-breaking hyphen
 * (U+2011) so it never wraps as "AI-/generated". Wording decided in review;
 * recorded in the voice SPEC.
 */
export const VOICE_DISCLOSURE =
  "Voice sends your microphone audio and your most recently edited draft (with its title) to OpenAI, through Tracely's server, so Tracer can answer out loud. Tracely doesn't record or keep the audio. The voice is AI‑generated, not a person."

/** The voice section of PRIVACY.md (the website has no /privacy page yet). */
export const VOICE_PRIVACY_URL =
  'https://github.com/Tracely-app/Tracely/blob/main/PRIVACY.md#voice-conversations-tracely-desktop-app'

/**
 * Shown before the first call (voiceConsent is false). Two answers on the
 * sheet: whether the call's words are saved to the chat (voiceSaveTranscript,
 * saved as it changes) and "I'm 13 or older", which Start talking needs.
 * Accepting saves voiceConsent=true — which therefore also records the age
 * answer — and starts the call. A student under 13 is told voice isn't for
 * them yet and nothing is stored. A sheet over the voice view rather than a
 * modal over the app, so the student can still see — and change — which
 * voice they're about to talk to.
 */
export default function VoiceConsent({
  busy,
  saveTranscript,
  onSaveTranscriptChange,
  onAccept,
  onDecline
}: {
  busy: boolean
  saveTranscript: boolean
  onSaveTranscriptChange: (save: boolean) => void
  onAccept: () => void
  onDecline: () => void
}): JSX.Element {
  const [olderThan13, setOlderThan13] = useState(false)
  const [underAge, setUnderAge] = useState(false)

  if (underAge) {
    return (
      <>
        <div className="voice-sheet-scrim" aria-hidden="true" />
        <section className="voice-sheet" role="dialog" aria-modal="false" aria-labelledby="voice-consent-title">
          <h3 id="voice-consent-title">Voice is for students 13 and older</h3>
          <p>You can keep chatting with Tracer by text any time.</p>
          <div className="voice-actions">
            <Button autoFocus variant="primary" onClick={onDecline}>
              Back to chat
            </Button>
          </div>
        </section>
      </>
    )
  }

  return (
    <>
      <div className="voice-sheet-scrim" aria-hidden="true" />
      <section
        className="voice-sheet"
        role="dialog"
        aria-modal="false"
        aria-labelledby="voice-consent-title"
        aria-describedby="voice-consent-text"
      >
        <h3 id="voice-consent-title">Before you talk</h3>
        <p id="voice-consent-text">{VOICE_DISCLOSURE}</p>
        <label className="voice-check">
          <input
            autoFocus
            type="checkbox"
            checked={saveTranscript}
            onChange={(e) => onSaveTranscriptChange(e.target.checked)}
          />
          <span>
            Save the transcript to my chat
            {saveTranscript ? (
              <small>
                What you both say is added to your Tracer chat on this computer. You can turn that off in Settings →
                Voice.
              </small>
            ) : null}
          </span>
        </label>
        <label className="voice-check">
          <input type="checkbox" checked={olderThan13} onChange={(e) => setOlderThan13(e.target.checked)} />
          <span>I&rsquo;m 13 or older</span>
        </label>
        <p className="voice-sheet-links">
          <button type="button" className="voice-link" onClick={() => void tracelyApi.openExternal(VOICE_PRIVACY_URL)}>
            How voice uses your data
          </button>
          <button type="button" className="voice-link voice-link-quiet" onClick={() => setUnderAge(true)}>
            I&rsquo;m under 13
          </button>
        </p>
        <div className="voice-actions">
          <Button variant="secondary" onClick={onDecline}>
            Not now
          </Button>
          <Button variant="primary" disabled={busy || !olderThan13} onClick={onAccept}>
            Start talking
          </Button>
        </div>
      </section>
    </>
  )
}
