import { useEffect, useId, useRef, useState } from 'react'
import type { CitationStyle } from '@shared/types'
import type { ScreenWatchSourceCandidate } from '@shared/ipc-contract'
import { MIN_EVIDENCE_TEXT_CHARS } from '@shared/evidenceLimits'
import SourceIconBox from './SourceIconBox'
import { sourceInitials } from './citationFlowCopy'
import Spinner from './Spinner'
import { CloseIcon } from './icons'

/**
 * "Find sources" — paste a piece of evidence, get the sources that speak to it.
 *
 * Every other route to retrieval in this app goes through a document: write a
 * draft, have claims detected, pick one, search. That is the right shape when
 * you are writing, and the wrong shape for the question people actually arrive
 * with — *I have a fact, who says it?* Owner, 2026-08-22: a place on Home where
 * you "enter a piece of evidence and it returns sources that work with it".
 *
 * It writes nothing. No document, no analysis, no claim, no library entry —
 * this is a question, not a draft, and it must not turn up in Analysis History.
 * Saving a result is a separate, deliberate act (the Copy button below).
 *
 * The rows are the app's own source rows: same favicon, same credibility chip,
 * same match percentage, same most-citable-first order. A second source list
 * with its own idea of what a good source looks like would be a second product.
 */
export default function SourceFinderPanel({
  style,
  onClose
}: {
  style: CitationStyle
  onClose: () => void
}): JSX.Element {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [candidates, setCandidates] = useState<ScreenWatchSourceCandidate[] | null>(null)
  const [citations, setCitations] = useState<Record<string, string>>({})
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const titleId = useId()
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // The panel exists to be typed into, so it takes the caret on open rather
  // than making the first interaction a click on the box you just opened.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Escape closes, like every other dismissible surface in the app.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const tooShort = text.trim().length < MIN_EVIDENCE_TEXT_CHARS

  async function search(): Promise<void> {
    if (loading || tooShort) return
    setLoading(true)
    setError(null)
    setCopied(null)
    try {
      const res = await window.tracely.evidence.forText({ text, style })
      setCandidates(res.candidates)
      setCitations(res.citations)
      setNote(res.note)
    } catch (err) {
      // Named, not swallowed: this is the only thing on the panel that can
      // fail, and "nothing happened" is indistinguishable from "no sources".
      setError(err instanceof Error ? err.message : String(err))
      setCandidates(null)
    } finally {
      setLoading(false)
    }
  }

  async function copy(ref: string): Promise<void> {
    const entry = citations[ref]
    if (!entry) return
    await window.tracely.clipboard.write({ text: entry })
    setCopied(ref)
  }

  return (
    <div className="srcfind-backdrop" onClick={onClose}>
      <div
        className="srcfind"
        role="dialog"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="srcfind-head">
          <div>
            <h2 id={titleId}>Find sources</h2>
            <p>Paste a fact or a sentence. Tracely looks for work that speaks to it.</p>
          </div>
          <button className="srcfind-close" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </header>

        <textarea
          ref={inputRef}
          className="srcfind-input"
          value={text}
          rows={3}
          placeholder="e.g. Screen time is linked to higher rates of depression in teenagers."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter searches; Shift+Enter is a newline. The box holds a
            // sentence, so the common case is one line and a press.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void search()
            }
          }}
        />

        <div className="srcfind-actions">
          <span className="srcfind-hint">
            {tooShort && text.trim().length > 0
              ? `A little more — ${MIN_EVIDENCE_TEXT_CHARS} characters minimum.`
              : `Citations shown in ${style}.`}
          </span>
          <button className="srcfind-go" onClick={() => void search()} disabled={loading || tooShort}>
            {loading ? 'Searching…' : 'Find sources'}
          </button>
        </div>

        <div className="srcfind-results">
          {loading ? (
            <div className="srcfind-loading">
              <Spinner label="Searching the academic indexes…" />
            </div>
          ) : error ? (
            <p className="srcfind-note srcfind-error" role="alert">
              {error}
            </p>
          ) : note ? (
            <p className="srcfind-note">{note}</p>
          ) : candidates && candidates.length > 0 ? (
            <ul className="srcfind-list">
              {candidates.map((c) => (
                <li key={c.sourceRef} className="srcfind-row">
                  {/* The favicon main already resolved for this row; the
                      two-letter tile is the fallback, on the same 28px grid so
                      both line up — the rule the rest of the app follows. */}
                  <SourceIconBox
                    className="srcfind-badge"
                    initials={sourceInitials(c.venue ?? c.title)}
                    faviconDataUrl={c.faviconDataUrl}
                  />
                  <div className="srcfind-row-main">
                    <div className="srcfind-row-title">{c.title}</div>
                    <div className="srcfind-row-meta">
                      {[c.venue, c.year].filter(Boolean).join(' · ') || '—'}
                    </div>
                    {citations[c.sourceRef] ? (
                      <div className="srcfind-row-cite">{citations[c.sourceRef]}</div>
                    ) : null}
                  </div>
                  <div className="srcfind-row-side">
                    {/* The same chip the editor and the overlay draw. `unvetted`
                        is grey and reads "Tracely does not recognise this
                        publisher" — a fact about our list, never an accusation. */}
                    <span
                      className="srcfind-cred"
                      data-tier={c.credibility.tier}
                      title={c.credibility.why}
                    >
                      {c.credibility.label}
                    </span>
                    <span className="srcfind-match">{c.matchPercent}% match</span>
                    <div className="srcfind-row-btns">
                      {c.url ? (
                        <button
                          className="srcfind-open"
                          onClick={() => void window.tracely.shell.openExternal({ url: c.url as string })}
                        >
                          Open
                        </button>
                      ) : null}
                      <button className="srcfind-copy" onClick={() => void copy(c.sourceRef)}>
                        {copied === c.sourceRef ? 'Copied' : 'Copy citation'}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  )
}
