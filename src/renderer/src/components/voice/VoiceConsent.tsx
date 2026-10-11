import Button from '../Button'

/** The first-use disclosure, word for word from the voice spec. */
export const VOICE_DISCLOSURE =
  "Voice sends your microphone audio and your current draft to OpenAI so Tracer can answer out loud. Tracely doesn't record or keep the audio. The voice is AI-generated."

/**
 * Shown before the first call (voiceConsent is false). Accepting saves
 * voiceConsent=true and starts the call; "Not now" goes back to the chat.
 * A sheet over the voice view rather than a modal over the app, so the
 * student can still see — and change — which voice they're about to talk to.
 */
export default function VoiceConsent({
  busy,
  onAccept,
  onDecline
}: {
  busy: boolean
  onAccept: () => void
  onDecline: () => void
}): JSX.Element {
  return (
    <>
      <div className="voice-sheet-scrim" aria-hidden="true" />
      <section className="voice-sheet" role="dialog" aria-modal="false" aria-labelledby="voice-consent-title">
        <h3 id="voice-consent-title">Before you talk</h3>
        <p>{VOICE_DISCLOSURE}</p>
        <div className="voice-actions">
          <Button variant="secondary" onClick={onDecline}>
            Not now
          </Button>
          <Button autoFocus variant="primary" disabled={busy} onClick={onAccept}>
            Start talking
          </Button>
        </div>
      </section>
    </>
  )
}
