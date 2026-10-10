import { useEffect, useState } from 'react'
import type { Claim } from '@shared/types'
import ClaimCard from './components/ClaimCard'
import Button from './components/Button'
import Spinner from './components/Spinner'
import TextArea from './components/TextArea'
import { tracelyApi } from './lib/api'
import { applyTheme } from './lib/theme'
import { applyAccentColor, applyDensity, applyFontSize } from './lib/appearance'
import Logo from './components/Logo'
import { CloseIcon, ExpandIcon } from './components/icons'

export default function FloatingApp(): JSX.Element {
  const [text, setText] = useState('')
  const [claims, setClaims] = useState<Claim[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // All four appearance settings, not just theme — this window applied only
    // the theme for a while, so accent, density and font size changed in the
    // main window and silently not here ("only some parts actually change").
    tracelyApi.getSettings().then((s) => {
      applyTheme(s.theme)
      applyAccentColor(s.accentColor)
      applyDensity(s.density)
      applyFontSize(s.fontSize)
    })
  }, [])

  useEffect(() => {
    return tracelyApi.onClipboardCaptured(({ text: captured }) => {
      setText(captured)
      setClaims(null)
      setError(null)
      analyze(captured)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function analyze(input: string): Promise<void> {
    if (!input.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await tracelyApi.detectClaims(input, 'floating')
      setClaims(res.claims)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  function close(): void {
    tracelyApi.hideWindow('floating')
  }

  function openInMain(): void {
    tracelyApi.showWindow('main')
  }

  return (
    <div className="floating-app">
      <div className="floating-drag-region">
        <div className="floating-brand">
          <Logo size={16} />
          <span>Tracely</span>
        </div>
        <div className="floating-controls">
          <button type="button" onClick={openInMain} title="Open in main window" aria-label="Open in main window">
            <ExpandIcon size={16} />
          </button>
          <button type="button" onClick={close} title="Close" aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
      </div>
      <div className="floating-body">
        <TextArea
          size="md"
          rows={3}
          placeholder="Paste or type a claim…"
          aria-label="Claim text"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button variant="primary" onClick={() => analyze(text)} disabled={loading || !text.trim()}>
          Analyze
        </Button>
        {loading ? <Spinner label="Detecting claims…" /> : null}
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        {claims && claims.length === 0 ? <p className="floating-empty">No checkable claims found.</p> : null}
        <div className="floating-results">
          {claims?.map((claim) => <ClaimCard key={claim.id} claim={claim} />)}
        </div>
      </div>
    </div>
  )
}
