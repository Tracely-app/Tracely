/**
 * The source's real site icon, falling back to the monogram tile.
 *
 * One component for both surfaces that draw a source row — the report's
 * evidence list and the editor's citation picker — for the same reason
 * problemCopy.ts is shared: two copies would be two products, and the version
 * that was edited second would drift on the box size, which is the thing that
 * has to match. The tile and the image occupy the SAME 28px / 8px-radius box
 * from the design, so a list mixing publishers that have an icon with ones that
 * do not still lines up on one grid rather than looking ragged.
 *
 * `className` rather than a fixed class, because the two surfaces style their
 * box differently (`argev-badge` in the report, `docmark-row-badge` in the
 * editor) and neither loads the other's stylesheet.
 *
 * The image is decoration over a row whose text is already correct: it renders
 * the monogram first and swaps when the icon arrives. There is deliberately no
 * loading state — a spinner where a publisher's mark will be makes a resolved
 * list look like it is still working.
 */
export default function SourceIconBox({
  className,
  initials,
  faviconDataUrl
}: {
  className: string
  initials: string
  /** null while the lookup is out, and permanently for a domain with no icon. */
  faviconDataUrl: string | null | undefined
}): JSX.Element {
  if (!faviconDataUrl) {
    return <span className={className}>{initials}</span>
  }
  return (
    <span className={`${className} has-icon`}>
      <img
        src={faviconDataUrl}
        alt=""
        // Decorative: the publisher is already named in the row's subtitle, so
        // announcing the icon would read the same fact twice.
        aria-hidden="true"
        width={16}
        height={16}
        loading="lazy"
        // A domain whose icon 404s or decodes badly must not leave an empty
        // box where the monogram was — the alt text is empty by design, so a
        // broken image is invisible rather than wrong.
        onError={(event) => {
          event.currentTarget.style.display = 'none'
        }}
      />
    </span>
  )
}
