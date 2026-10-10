import { useState, useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import Button from './Button'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  // For the highest-stakes actions (deleting an account) — the confirm
  // button stays disabled until the user types this exact string, the same
  // "type to confirm" pattern most apps use so a stray click can't trigger
  // something irreversible.
  requireText?: string
  onConfirm: () => void
  onCancel: () => void
}

// Generic "are you sure?" gate for actions that are annoying or impossible to
// undo (signing out, clearing data). Deliberately app-modal — no route/state
// machine of its own — so any screen can drop it in above a destructive
// button without restructuring its own state.
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  requireText,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element {
  const [typed, setTyped] = useState('')
  const locked = requireText !== undefined && typed !== requireText
  const titleId = useId()
  const messageId = useId()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={() => !busy && onCancel()}>
      <div
        className="modal-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h4 id={titleId} className="modal-title">
          {title}
        </h4>
        <p id={messageId} className="modal-message">
          {message}
        </p>
        {requireText !== undefined ? (
          <input
            className="modal-confirm-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={requireText}
            aria-label={`Type ${requireText} to confirm`}
            autoFocus
            disabled={busy}
          />
        ) : null}
        <div className="modal-actions">
          {/* Focus starts on the safe choice; the type-to-confirm input takes it instead when there is one. */}
          <Button variant="ghost" onClick={onCancel} disabled={busy} autoFocus={requireText === undefined}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'dark'} onClick={onConfirm} disabled={busy || locked}>
            {busy ? 'Please wait…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
