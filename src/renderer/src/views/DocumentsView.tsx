import { useEffect, useState } from 'react'
import type { DocumentListItem } from '@shared/types'
import type { Tab } from '../App'
import { useGradeLevel } from '../lib/gradeLevel'
import { gradeFor } from '../components/essayGrade'
import { tracelyApi } from '../lib/api'
import { documentSort, gradedOn, type DocumentSort } from '../components/documentSort'
import ConfirmSheet from '../components/ConfirmSheet'
import Spinner from '../components/Spinner'
import { BackIcon, MoreHorizontalIcon, PlusIcon } from '../components/icons'

/**
 * Every essay Tracely has graded — Figma "DocumentsPage" (58:172).
 *
 * This replaced the Analyze view's landing, which was a text field and a
 * "Create Document" button. That screen asked for a name before it would let
 * anyone type, and it was the only way back to work you had already done: the
 * documents existed in SQLite but nothing listed them, so reopening a draft
 * meant it happening to be the most recent one. The frame answers both — the
 * grid IS the list, and "New document" starts an "Untitled document" and goes
 * straight to the editor, where the title is editable inline.
 *
 * The card geometry is the frame's own, read with get_design_context rather
 * than taken off a screenshot: 181.5x200 cards on a 197.5px pitch and a 122px
 * thumbnail. The controls on it (button, select, chip, menu, icons) follow the
 * app's shared recipes in index.css so this page matches Home and Settings.
 *
 * The grade is not computed here. `gradeFor` is the same function the Screen
 * Watch grade panel and the in-app modal use, so one draft cannot carry two
 * letters across three surfaces — the same rule as problemCopy.ts.
 */

/** The frame's card geometry. A grid, not absolute positions: the design lays
 *  four columns at a fixed pitch, and a grid reproduces that while letting the
 *  row count follow the data instead of the mockup's eight. */
const CARD_WIDTH = 181.5
const CARD_GAP = 16
const THUMB_HEIGHT = 122

/** The chip's palette, by SCORE and on Home's bands (>= 80 good, >= 65 mid,
 *  else low) — the same three `.home-doc-grade.tone-*` classes, so one
 *  document shows one colour on both screens. It used to key on the letter
 *  (A = green, everything else amber), which put a B- on amber here and on
 *  green on Home. The colours are CSS classes (`.docs-card-chip.tone-*` in
 *  index.css), not inline styles, because an inline style is unreachable by
 *  the dark-theme rules — the chips stayed light-mode pastel on a dark card. */
function chipTone(score: number): string {
  return score >= 80 ? 'tone-good' : score >= 65 ? 'tone-mid' : 'tone-low'
}

/**
 * The skeleton bars in the card's thumbnail.
 *
 * The frame draws grey bars at fixed widths rather than a rendering of the
 * document, and they are kept as drawn — four of its five, so the thumbnail
 * carries the same weight as Home's document tiles. A real thumbnail would
 * mean rasterising the body HTML per card on every open of this page, and the
 * design is not trying to show the text — it is showing that the card is a
 * document.
 */
const THUMB_BARS = [110.25, 133.875, 94.5, 126]

function DocumentCard({
  document: doc,
  onOpen,
  onDelete
}: {
  document: DocumentListItem
  onOpen: () => void
  onDelete: () => void
}): JSX.Element {
  const gradingLevel = useGradeLevel()
  const grade = doc.score === null ? null : gradeFor(doc.score, gradingLevel)
  // The menu, not a bare delete on the card. Opening it IS the deliberate
  // step: a destructive item chosen from a menu you had to open is the
  // pattern every file manager uses, and it is far harder to hit by accident
  // than a control that appears under the cursor on hover — which is what this
  // replaced.
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    // Closes on any click elsewhere and on Escape. Without the first, a menu
    // left open on one card sits over the card beside it; without the second
    // there is no keyboard way out of it.
    const onDown = (event: MouseEvent): void => {
      // Anything inside this card's own menu is not a dismiss. The listener is
      // in the CAPTURE phase — it has to be, or a click on the card underneath
      // opens the document before the menu can close — which means
      // stopPropagation on the item cannot stop it: capture runs before the
      // target's own handlers, so the menu closed on mousedown and the click
      // then landed on nothing. That is why Delete did nothing in the app while
      // passing in the harness, where the test called element.click() and never
      // fired a mousedown at all.
      const target = event.target as HTMLElement | null
      if (target?.closest('.docs-card-menu-popup, .docs-card-menu')) return
      setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    // Capture phase, so this runs before the card's own click handler and the
    // dismissing click cannot also open the document.
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <button className="docs-card" onClick={onOpen} title={`Open ${doc.title}`}>
      <span className="docs-card-thumb" aria-hidden="true">
        {THUMB_BARS.map((width, i) => (
          <span key={i} className="docs-card-bar" style={{ width }} />
        ))}
        {grade && doc.score !== null ? (
          <span className={`docs-card-chip ${chipTone(doc.score)}`}>{grade.letter}</span>
        ) : null}
      </span>
      {/* Spans with role=button rather than <button>s: this card is itself a
          button, and nesting one inside another is invalid HTML that Chromium
          resolves by hoisting the inner one out of the card. */}
      <span
        role="button"
        tabIndex={0}
        className={`docs-card-menu${menuOpen ? ' open' : ''}`}
        title="Document actions"
        aria-label="Document actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onMouseDown={(event) => {
          // mousedown, not click: the dismiss listener above is on mousedown in
          // the capture phase, so a click handler here would run after it and
          // the menu would close and reopen on every press.
          event.stopPropagation()
        }}
        onClick={(event) => {
          event.stopPropagation()
          setMenuOpen((open) => !open)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          setMenuOpen((open) => !open)
        }}
      >
        <MoreHorizontalIcon size={16} />
      </span>
      {menuOpen ? (
        <span className="docs-card-menu-popup" role="menu">
          <span
            role="menuitem"
            tabIndex={0}
            className="docs-card-menu-delete"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              setMenuOpen(false)
              onDelete()
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              setMenuOpen(false)
              onDelete()
            }}
          >
            Delete
          </span>
        </span>
      ) : null}
      <span className="docs-card-title">{doc.title}</span>
      {/* "Not graded yet" rather than an empty line or a dash: a draft nothing
          has read is a normal state, and the card should say which state it is
          in rather than leaving a gap where every other card has a date. */}
      <span className="docs-card-date">
        {doc.gradedAt ? `Graded ${gradedOn(doc.gradedAt)}` : 'Not graded yet'}
      </span>
    </button>
  )
}

export default function DocumentsView({
  onNavigate,
  onOpenDocument
}: {
  onNavigate: (tab: Tab) => void
  /** Null means "start a new one". The editor owns creation; this page only
   *  decides which document it should open with. */
  onOpenDocument: (id: string | null) => void
}): JSX.Element {
  const [documents, setDocuments] = useState<DocumentListItem[] | null>(null)
  const [sort, setSort] = useState<DocumentSort>('recent')
  const [error, setError] = useState<string | null>(null)
  // The document the menu asked to delete, held until the sheet answers. The
  // whole record rather than an id, so the dialog can name it — "this document"
  // is a worse question than "Climate Policy Essay".
  const [pendingDelete, setPendingDelete] = useState<DocumentListItem | null>(null)

  useEffect(() => {
    let cancelled = false
    tracelyApi
      .listDocuments()
      .then((res) => {
        if (!cancelled) setDocuments(res.documents)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Removes the row first, then the record.
   *
   * Optimistic because the alternative is re-listing, and a re-list would
   * re-sort — so a card the user had just deleted could be followed by the grid
   * visibly rearranging under the cursor. On failure the document is put back
   * and the error shown, which is the only state where the list can disagree
   * with storage.
   */
  async function removeDocument(id: string): Promise<void> {
    const previous = documents
    setDocuments((docs) => (docs ?? []).filter((d) => d.id !== id))
    try {
      await tracelyApi.removeDocument(id)
    } catch (err) {
      setDocuments(previous)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const sorted = documents ? documentSort(documents, sort) : []

  return (
    <div className="docs-view">
      <button className="docs-back" onClick={() => onNavigate('home')}>
        <BackIcon size={14} />
        Back
      </button>

      <div className="docs-head">
        <div className="docs-head-text">
          <h1 className="docs-title">Documents</h1>
          <p className="docs-subtitle">Every essay Tracely has graded, in one place.</p>
        </div>
        <div className="docs-head-actions">
          <button className="docs-new" onClick={() => onOpenDocument(null)}>
            <PlusIcon size={16} />
            New document
          </button>
          {/* A real <select>. The frame draws a pill with a chevron, which is
              what a select already is — and building a custom menu here would
              mean re-implementing keyboard handling for a control the platform
              gives us correct. The visible "Sort" label says what the control
              is; the aria-label stays the accessible name. */}
          <div className="docs-sort-field">
            <label className="docs-sort-label" htmlFor="docs-sort">
              Sort
            </label>
            <select
              id="docs-sort"
              className="docs-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as DocumentSort)}
              aria-label="Sort documents"
            >
              <option value="recent">Recently opened</option>
              <option value="graded">Recently graded</option>
              <option value="score">Highest score</option>
              <option value="title">Title A–Z</option>
            </select>
          </div>
        </div>
      </div>

      {error ? (
        <p className="error-text docs-error" role="alert">
          {error}
        </p>
      ) : null}

      {documents === null && !error ? (
        <div className="docs-loading">
          <Spinner label="Loading…" />
        </div>
      ) : null}

      {documents !== null && documents.length === 0 ? (
        <p className="docs-empty">
          No documents yet. Start one and Tracely will grade it as you write.
        </p>
      ) : null}

      {pendingDelete ? (
        <ConfirmSheet
          title="Delete document"
          message={`Delete “${pendingDelete.title}”? This cannot be undone.`}
          confirmLabel="Delete"
          busyLabel="Deleting…"
          // No opt-out on a delete: there is no trash and no undo behind it.
          showSuppress={false}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const target = pendingDelete
            setPendingDelete(null)
            void removeDocument(target.id)
          }}
        />
      ) : null}

      <div className="docs-grid">
        {sorted.map((doc) => (
          <DocumentCard
            key={doc.id}
            document={doc}
            onOpen={() => onOpenDocument(doc.id)}
            onDelete={() => setPendingDelete(doc)}
          />
        ))}
      </div>
    </div>
  )
}

export { CARD_WIDTH, CARD_GAP, THUMB_HEIGHT }
