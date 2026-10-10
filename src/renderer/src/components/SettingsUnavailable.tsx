import SettingsField from './SettingsField'

/**
 * A Settings section the Figma file draws but the product does not have.
 *
 * Notifications, Security, Integrations and Billing exist as frames
 * (33:93, 33:184, 33:366, 33:457) with fully populated sample values —
 * "Connected · jamie.d@example.com", a payment method, a plan. There is no
 * notification code, no OAuth provider and no payments behind any of it.
 *
 * These four were built once before, verbatim with those sample values, and
 * deleted again; the note at the top of SettingsView records why and says to
 * add the section back with the feature rather than before it. Merrick's call
 * on 2026-08-15 was to build them anyway, so the whole app matches the design —
 * but visibly disabled rather than pretending.
 *
 * So the layout, the labels and the field order are the design's, and the
 * VALUES are not. Printing "Connected · jamie.d@example.com" over an account
 * that does not exist is the one thing this component is here to avoid: a
 * screen that looks like it works, in an app whose entire premise is not
 * overstating what it knows.
 */
export default function SettingsUnavailable({
  title,
  description,
  fields,
  note
}: {
  title: string
  description: string
  /** Figma's labels, in Figma's order. `full` spans both grid columns. */
  fields: { label: string; full?: boolean }[]
  /** What is missing, in one line. */
  note: string
}): JSX.Element {
  return (
    <div className="settings-panel-content">
      <div className="settings-panel-header">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>

      <p className="settings-unavailable-note">{note}</p>

      <div className="settings-panel-grid">
        {fields.map((field) => (
          <SettingsField key={field.label} label={field.label} full={field.full}>
            <div className="settings-static-value is-unavailable" aria-disabled="true">
              Not available yet
            </div>
          </SettingsField>
        ))}
      </div>

      {/* The frame puts a Save changes button here. It is rendered disabled
          rather than omitted, because the design has it and there is nothing
          for it to save — a live button that silently does nothing is exactly
          what the earlier version of these pages got wrong. */}
      <div className="settings-actions">
        <button className="btn btn-primary" disabled>
          Save changes
        </button>
      </div>
    </div>
  )
}
