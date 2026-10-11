export type SpinnerSize = 'sm' | 'lg'

/**
 * The one loading indicator: a 14px ring (12 sm / 20 lg) in ink on
 * var(--border), with an optional label beside it. Announced politely so a
 * screen reader hears the label change without being interrupted.
 */
export default function Spinner({ label, size }: { label?: string; size?: SpinnerSize }): JSX.Element {
  const cls = size ? `spinner spinner-${size}` : 'spinner'
  return (
    <div className="spinner-row" role="status" aria-live="polite">
      <span className={cls} aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </div>
  )
}
