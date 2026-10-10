import { useEffect, useState } from 'react'
import type { CitationStyle } from '@shared/types'
import { tracelyApi } from '../lib/api'
import Button from './Button'
import Spinner from './Spinner'
import { CheckIcon } from './icons'

const STYLES: CitationStyle[] = ['APA', 'MLA', 'Chicago']

export default function CitationBlock({ sourceId }: { sourceId: string }): JSX.Element {
  // Starts on the user's default rather than always APA. The setting was read
  // by the Screen Watch citation flow and ignored here, so the same preference
  // produced two different styles depending on which surface you were in.
  const [style, setStyle] = useState<CitationStyle>('APA')

  useEffect(() => {
    tracelyApi
      .getSettings()
      .then((s) => setStyle(s.defaultCitationStyle))
      .catch(() => {})
  }, [])
  const [citation, setCitation] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate(nextStyle: CitationStyle): Promise<void> {
    setStyle(nextStyle)
    setLoading(true)
    setError(null)
    setCopied(false)
    try {
      const res = await tracelyApi.generateCitation(sourceId, nextStyle)
      setCitation(res.citation)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function copy(): Promise<void> {
    if (!citation) return
    await tracelyApi.writeClipboard(citation)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="citation-block">
      <div className="citation-style-picker" role="group" aria-label="Citation style">
        {STYLES.map((s) => (
          <Button
            key={s}
            variant={s === style && citation ? 'primary' : 'ghost'}
            size="sm"
            aria-pressed={s === style && citation !== null}
            onClick={() => generate(s)}
            disabled={loading}
          >
            {s}
          </Button>
        ))}
      </div>
      {loading ? <Spinner size="sm" label="Generating…" /> : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {citation ? (
        <div className="citation-result">
          <code>{citation}</code>
          <Button variant="ghost" size="sm" className="citation-copy" onClick={copy}>
            {copied ? (
              <>
                <CheckIcon className="citation-copied-icon" />
                Copied
              </>
            ) : (
              'Copy'
            )}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
