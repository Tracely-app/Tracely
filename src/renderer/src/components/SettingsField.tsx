import { useId } from 'react'
import type { ReactNode } from 'react'

// The repeated Figma Settings pattern: a muted label above a bordered rounded
// input/select/textarea/static value. Used by every Settings panel (both the
// real, IPC-backed ones and the static placeholder pages).
//
// The label is a span, not a <label>: some fields hold more than one control
// (the accent swatches, select + meter), and a wrapping <label> would forward
// a click on it to the first one. role=group + aria-labelledby announces the
// label as the context of the controls inside, without that side effect.
export default function SettingsField({
  label,
  full,
  children
}: {
  label: string
  full?: boolean
  children: ReactNode
}): JSX.Element {
  const labelId = useId()
  return (
    <div
      className={`settings-field ${full ? 'settings-panel-grid-full' : ''}`.trim()}
      role="group"
      aria-labelledby={labelId}
    >
      <span id={labelId} className="settings-field-label">
        {label}
      </span>
      {children}
    </div>
  )
}
