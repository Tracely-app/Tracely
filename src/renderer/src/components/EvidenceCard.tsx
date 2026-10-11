import { useState } from 'react'
import type { EvidenceItem } from '@shared/types'
import { tracelyApi } from '../lib/api'
import Button from './Button'
import CitationBlock from './CitationBlock'

function authorNames(item: EvidenceItem): string {
  if (!item.source.authors.length) return 'Unknown author'
  return item.source.authors
    .slice(0, 3)
    .map((a) => (a.given ? `${a.given} ${a.family}` : a.family))
    .join(', ')
}

export default function EvidenceCard({
  item,
  claimId
}: {
  item: EvidenceItem
  claimId: string
}): JSX.Element {
  const [showCitation, setShowCitation] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  async function saveToLibrary(): Promise<void> {
    setSaving(true)
    try {
      await tracelyApi.saveToLibrary(item.source.id, claimId)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const { source } = item

  // A doi.org link is a redirect to a publisher page that is often paywalled,
  // and it is what every Crossref result carries — which is most of them, since
  // Crossref finds the most relevant papers. When OpenAlex says a free copy
  // exists, send the reader there instead: a source you can actually read is
  // worth more than a correctly-formatted one you can't.
  const openAccessUrl = source.oaStatus && source.oaStatus !== 'closed' ? source.pdfUrl : null
  const primaryUrl = openAccessUrl ?? source.url

  return (
    <div className="evidence-card">
      {/* Only the two decisive verdicts get a badge. 'unclear' is the common
          case — the paper is on topic but is not evidence either way — and
          labelling it would put a chip on most of the list, which teaches a
          reader to stop seeing them. Null means the question was never asked,
          which is not a finding to report. */}
      {item.stance === 'supports' || item.stance === 'contradicts' ? (
        <span
          className={`evidence-stance evidence-stance-${item.stance}`}
          title={
            item.stance === 'contradicts'
              ? 'This source appears to state the opposite of the claim.'
              : 'This source appears to back the claim.'
          }
        >
          {item.stance === 'contradicts' ? 'Contradicts' : 'Supports'}
        </span>
      ) : null}

      <div className="evidence-title">
        {primaryUrl ? (
          <a href={primaryUrl} target="_blank" rel="noreferrer">
            {source.title}
          </a>
        ) : (
          source.title
        )}
      </div>
      <div className="evidence-meta">
        {authorNames(item)}
        {source.year ? ` · ${source.year}` : ''}
        {source.venue ? ` · ${source.venue}` : ''}
        {source.venueType ? ` · ${source.venueType}` : ''}
        {openAccessUrl ? <span className="evidence-oa">Free full text</span> : null}
      </div>
      {source.abstract ? <p className="evidence-abstract">{source.abstract.slice(0, 280)}…</p> : null}
      <div className="evidence-actions">
        <Button variant="ghost" size="sm" onClick={() => setShowCitation((v) => !v)}>
          {showCitation ? 'Hide citation' : 'Cite'}
        </Button>
        <Button variant="ghost" size="sm" onClick={saveToLibrary} disabled={saving || saved}>
          {saved ? 'Saved' : 'Save to Library'}
        </Button>
      </div>
      {showCitation ? <CitationBlock sourceId={source.id} /> : null}
    </div>
  )
}
