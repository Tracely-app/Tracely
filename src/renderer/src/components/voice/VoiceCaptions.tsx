import type { VoiceCaption } from '../../voice/types'

/** How many captions are drawn; the band's fixed height and fade show the last few lines of them. */
const SHOWN = 3

/**
 * Live captions: the newest at the bottom, Tracer's words in the text colour
 * and the student's in muted, older lines fading out under the top edge. The
 * box has a fixed height (voice.css), so a caption arriving never moves the
 * orb. Deliberately NOT a live region: a screen reader already hears the call,
 * and announcing every word would talk over it.
 */
export default function VoiceCaptions({
  captions,
  on,
  personaName
}: {
  captions: readonly VoiceCaption[]
  on: boolean
  personaName: string
}): JSX.Element {
  if (!on) {
    return (
      <div className="voice-captions">
        <p className="voice-captions-off">Captions are off</p>
      </div>
    )
  }
  const recent = captions.filter((c) => c.text.trim()).slice(-SHOWN)
  return (
    <div className="voice-captions" aria-label="Live captions">
      {recent.map((c) => (
        <p
          key={c.id}
          className={`voice-caption ${c.role === 'user' ? 'voice-caption-user' : 'voice-caption-assistant'}`}
        >
          <span className="sr-only">{c.role === 'user' ? 'You: ' : `${personaName}: `}</span>
          {c.text.trim()}
        </p>
      ))}
    </div>
  )
}
