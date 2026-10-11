import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * The confirmation sheet — Figma 212:65 (Frame 5).
 *
 * Its own component rather than a variant of ConfirmDialog, because the two
 * disagree about which button is loud and only one of them can be right per
 * dialog. ConfirmDialog gives the quiet treatment to Cancel and the heavy one
 * to Confirm. The frame drew the opposite (Cancel as the orange gradient pill,
 * Confirm grey); the polish pass put both on the shared button recipe —
 * an outlined Cancel and a solid accent Confirm.
 *
 * It was called SaveChangesDialog and it is not only about saving any more, so
 * the name went. What it IS about is the button arrangement, and that
 * arrangement turns out to be right for two different reasons:
 *
 *  - **Saving** is not destructive, so there is no reason to make the safe
 *    option the quiet one. The frame says so explicitly.
 *  - **Deleting** is destructive, and a loud Cancel is the SAFER arrangement,
 *    not a riskier one: the button that does nothing is the one under the
 *    cursor's natural path. An earlier note here warned that generalising this
 *    would put "a bright, inviting Cancel one prop away from the delete-account
 *    dialog". That worry had the sign backwards for a delete — a bright Cancel
 *    beside a quiet Confirm is exactly what a delete wants.
 *
 * ConfirmDialog stays where it is. Sign-out, clear-all-data and delete-account
 * carry a `requireText` gate this sheet has no concept of, and collapsing the
 * two would mean building it here for one caller.
 *
 * The "Do not show anymore" tick is OPTIONAL, and off for deletes. It persists
 * to `suppressSaveConfirm` for the save case, because a confirmation nobody can
 * disable is one people learn to click through without reading. A delete has no
 * undo and no trash behind it, so a switch that turns its only guard off for
 * good is not the same offer — see `showSuppress`.
 */
export default function ConfirmSheet({
  title = 'Save changes',
  message = 'Are you sure you want to save your changes?',
  confirmLabel = 'Confirm',
  busyLabel = 'Saving…',
  showSuppress = true,
  busy = false,
  danger = false,
  onConfirm,
  onCancel
}: {
  title?: string
  message?: string
  confirmLabel?: string
  busyLabel?: string
  /**
   * Whether to offer "Do not show anymore".
   *
   * False for irreversible actions. The checkbox is a real part of the frame
   * and belongs on the dialogs it was drawn for; on a delete it would let
   * someone permanently remove the last thing standing between a stray click
   * and work that exists nowhere else.
   */
  showSuppress?: boolean
  busy?: boolean
  /** A destructive confirm (Delete): the danger recipe, never the orange
   *  primary — the same as ConfirmDialog's Delete. */
  danger?: boolean
  /** `suppress` is the checkbox state at the moment Confirm was pressed. It is
   *  always false when `showSuppress` is off. */
  onConfirm: (suppress: boolean) => void
  onCancel: () => void
}): JSX.Element {
  const [suppress, setSuppress] = useState(false)
  const titleId = useId()

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
        className="modal-card savechanges-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h4 id={titleId} className="savechanges-title">
          {title}
        </h4>
        <p className="savechanges-message">{message}</p>

        {/* Not the `hidden` attribute: that is a UA `display: none`, and
            `.savechanges-check` sets `display: flex`, which wins on
            specificity — the checkbox stayed on screen. Not rendering it is
            also the honest thing, since there is nothing to read for a
            dialog that does not offer the choice. */}
        {showSuppress ? (
          <label className="savechanges-check">
            <input
              type="checkbox"
              checked={suppress}
              onChange={(e) => setSuppress(e.target.checked)}
              disabled={busy}
            />
            <span className="savechanges-box" aria-hidden="true" />
            Do not show anymore
          </label>
        ) : null}

        <div className="savechanges-actions">
          {/* Focus moves into the sheet on open, as ConfirmDialog's does. */}
          <button className="savechanges-btn cancel" onClick={onCancel} disabled={busy} autoFocus>
            Cancel
          </button>
          <button
            className={`savechanges-btn confirm${danger ? ' danger' : ''}`}
            onClick={() => onConfirm(suppress)}
            disabled={busy}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
