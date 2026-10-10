import { useEffect, useId, useRef } from 'react'
import type { Guide } from '../content/guides'
import { CloseIcon } from './icons'

/**
 * The reader behind a Resources card.
 *
 * A modal over Home rather than a fifth tab: a guide is something you open,
 * read and dismiss, and it has no state to come back to. Making it a route
 * would mean Home losing its scroll position on the way out and back.
 *
 * Escape closes it, the backdrop closes it, and focus moves into the dialog on
 * open so the keyboard can scroll it — the article is the only thing in here,
 * so the article is what gets focus.
 */
export default function GuideReader({
  guide,
  onClose
}: {
  guide: Guide
  onClose: () => void
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    bodyRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="guide-backdrop" onClick={onClose}>
      <div
        className="guide-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="guide-head">
          <div>
            <p className="guide-kicker">
              Resources · {guide.readMinutes} min read
            </p>
            <h1 id={titleId} className="guide-title">
              {guide.title}
            </h1>
          </div>
          <button className="guide-close" onClick={onClose} aria-label="Close guide">
            <CloseIcon size={16} />
          </button>
        </header>

        {/* tabIndex so the scroll container itself can hold focus — without it
            the arrow keys do nothing until the reader clicks the text. */}
        <div className="guide-body" ref={bodyRef} tabIndex={-1}>
          <p className="guide-standfirst">{guide.standfirst}</p>
          {guide.sections.map((section) => (
            <section key={section.heading} className="guide-section">
              <h2>{section.heading}</h2>
              {section.body.map((paragraph) => (
                <p key={paragraph.slice(0, 40)}>{paragraph}</p>
              ))}
              {section.bullets ? (
                <ul>
                  {section.bullets.map((item) => (
                    <li key={item.slice(0, 40)}>{item}</li>
                  ))}
                </ul>
              ) : null}
              {section.note ? <p className="guide-note">{section.note}</p> : null}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
