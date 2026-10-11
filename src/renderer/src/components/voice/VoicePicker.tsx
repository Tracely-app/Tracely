import { useEffect, useRef } from 'react'
import { Check } from 'lucide-react'
import { VOICES, type VoiceId } from '@shared/voices'

/**
 * The persona list behind the chip, before a call. Native radios (visually
 * hidden inside each row) so arrow keys move the choice the way they do in
 * any radio group; Enter, Esc or a click outside closes it. Focus lands on the
 * chosen voice when it opens and goes back to the chip when it closes.
 */
export default function VoicePicker({
  value,
  onChange,
  onClose
}: {
  value: VoiceId
  onChange: (id: VoiceId) => void
  onClose: () => void
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  // A pointer pick chooses and closes; arrow keys only move the choice.
  const pointerPick = useRef(false)
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
          if (e.key === 'Escape' || e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <p id="voice-picker-title" className="voice-picker-title">
          Choose a voice
        </p>
        {VOICES.map((v) => {
          const selected = v.id === value
          return (
            <label
              key={v.id}
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
          )
        })}
      </div>
    </>
  )
}
