import { useEffect, useRef } from 'react'
import { Check } from 'lucide-react'
import { VOICES, type VoiceId } from '@shared/voices'
import { PauseIcon, PlayIcon } from '../icons'
import { useVoicePreview } from './voiceClips'

/**
 * The persona list behind the chip, before a call. Native radios (visually
 * hidden inside each row) so arrow keys move the choice the way they do in
 * any radio group; Enter, Esc or a click outside closes it. Focus lands on the
 * chosen voice when it opens and goes back to the chip when it closes — except
 * when the student tabs out of it, where it closes and focus goes on where
 * they sent it. Each row has a ▶ to hear the voice (the clips Settings plays),
 * one at a time, stopped when the picker closes.
 */
export default function VoicePicker({
  value,
  onChange,
  onClose,
  onCloseWithoutFocus
}: {
  value: VoiceId
  onChange: (id: VoiceId) => void
  onClose: () => void
  /** Closes without moving focus: focus has already left for somewhere else. */
  onCloseWithoutFocus: () => void
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  // A pointer pick chooses and closes; arrow keys only move the choice.
  const pointerPick = useRef(false)
  const preview = useVoicePreview()
  useEffect(() => {
    listRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus()
  }, [])

  return (
    <>
      <div className="voice-picker-scrim" onMouseDown={onClose} />
      <div
        ref={listRef}
        className="voice-picker"
        role="radiogroup"
        aria-labelledby="voice-picker-title"
        onKeyDown={(e) => {
          // Enter on a ▶ plays it; Enter anywhere else, or Esc, closes.
          const onButton = e.target instanceof HTMLButtonElement
          if (e.key === 'Escape' || (e.key === 'Enter' && !onButton)) {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
        onBlur={(e) => {
          // Tabbing out (focus moving to a control outside) closes it. A null
          // target is the window losing focus, which leaves it open.
          const next = e.relatedTarget as Node | null
          if (next && !e.currentTarget.contains(next)) onCloseWithoutFocus()
        }}
      >
        <p id="voice-picker-title" className="voice-picker-title">
          Choose a voice
        </p>
        {VOICES.map((v) => {
          const selected = v.id === value
          const isPlaying = preview.playing === v.id
          return (
            <div key={v.id} className="voice-option-row">
              <label
                className={`voice-option ${selected ? 'voice-option-selected' : ''}`}
                onPointerDown={() => {
                  pointerPick.current = true
                }}
                onClick={(e) => {
                  // Clicking the voice already chosen changes nothing; it still closes.
                  if (selected && e.detail > 0) onClose()
                }}
              >
                <input
                  type="radio"
                  name="tracer-voice"
                  value={v.id}
                  checked={selected}
                  onKeyDown={() => {
                    pointerPick.current = false
                  }}
                  onChange={() => {
                    onChange(v.id)
                    if (pointerPick.current) onClose()
                    pointerPick.current = false
                  }}
                />
                <span className="voice-option-text">
                  <span className="voice-option-name">
                    <b>{v.name}</b>
                    <em>AI voice · {v.accent}</em>
                  </span>
                  <span>{v.description}</span>
                </span>
                <span className="voice-option-check" aria-hidden="true">
                  <Check size={16} strokeWidth={2.2} />
                </span>
              </label>
              <button
                type="button"
                className="voice-preview"
                aria-label={`Hear ${v.name}`}
                aria-pressed={isPlaying}
                title={isPlaying ? 'Stop' : `Hear ${v.name}`}
                onClick={() => preview.toggle(v.id)}
              >
                {isPlaying ? <PauseIcon size={13} /> : <PlayIcon size={13} />}
              </button>
            </div>
          )
        })}
      </div>
    </>
  )
}
