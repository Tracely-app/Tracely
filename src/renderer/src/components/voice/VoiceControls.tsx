import { CaptionsIcon, MicIcon, MicOffIcon, PhoneOffIcon } from '../icons'

/**
 * The call's three controls: Mute, End (centred, the danger recipe, larger),
 * Captions. Labels sit under each circle so the controls read without
 * hovering; each button's name contains its visible word (WCAG 2.5.3), so
 * Mute's name flips with its label rather than using aria-pressed, and the
 * shortcuts live in aria-keyshortcuts and the tooltip, not the name. Captions
 * says its state with aria-pressed. Keyboard: M mutes and Esc ends, handled
 * by VoiceMode while the voice view has focus.
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
          className="voice-round voice-round-mute"
          data-muted={muted || undefined}
          aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-keyshortcuts="M"
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
          aria-label="End call"
          aria-keyshortcuts="Escape"
          title="End call (Esc)"
          onClick={onEnd}
        >
          <PhoneOffIcon size={26} />
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
