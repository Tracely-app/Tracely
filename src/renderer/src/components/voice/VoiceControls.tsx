import { CaptionsIcon, MicIcon, MicOffIcon, PhoneOffIcon } from '../icons'

/**
 * The call's three controls: Mute, End (centred, the danger recipe, larger),
 * Captions. Labels sit under each circle so the controls read without
 * hovering; the buttons carry the same words for screen readers, and the
 * toggles say their state with aria-pressed. Keyboard: M mutes and Esc ends,
 * handled by VoiceMode while the voice view has focus.
 */
export default function VoiceControls({
  muted,
  captionsOn,
  disabled,
  onToggleMute,
  onEnd,
  onToggleCaptions
}: {
  muted: boolean
  captionsOn: boolean
  /** before the mic is live, and while the call is ending */
  disabled: boolean
  onToggleMute: () => void
  onEnd: () => void
  onToggleCaptions: () => void
}): JSX.Element {
  return (
    <div className="voice-controls" role="group" aria-label="Call controls">
      <div className="voice-control">
        <button
          type="button"
          className="voice-round"
          aria-pressed={muted}
          aria-label={muted ? 'Unmute microphone (M)' : 'Mute microphone (M)'}
          title={muted ? 'Unmute (M)' : 'Mute (M)'}
          disabled={disabled}
          onClick={onToggleMute}
        >
          {muted ? <MicOffIcon /> : <MicIcon />}
        </button>
        <span aria-hidden="true">{muted ? 'Unmute' : 'Mute'}</span>
      </div>
      <div className="voice-control">
        <button
          type="button"
          className="voice-round voice-round-end"
          aria-label="End call (Esc)"
          title="End call (Esc)"
          onClick={onEnd}
        >
          <PhoneOffIcon size={24} />
        </button>
        <span aria-hidden="true">End</span>
      </div>
      <div className="voice-control">
        <button
          type="button"
          className="voice-round"
          aria-pressed={captionsOn}
          aria-label="Live captions"
          title={captionsOn ? 'Hide captions' : 'Show captions'}
          onClick={onToggleCaptions}
        >
          <CaptionsIcon />
        </button>
        <span aria-hidden="true">Captions</span>
      </div>
    </div>
  )
}
