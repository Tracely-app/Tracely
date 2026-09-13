import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScreenWatchHoverEvent } from '@shared/ipc-contract'
import { mainWindowSize } from '@shared/windowSize'
import { defaultScenario, type Scenario } from './mockApi'
import * as fx from './fixtures'

// The contract between the harness (this window) and each previewed iframe.
// bootstrap.ts reads it off window.parent.
export type PreviewBridge = {
  scenario: Scenario
  log: (method: string) => void
}

// Real dimensions, read off the BrowserWindow definitions in src/main/windows/.
// Keeping the frames at true pixel size is the point: a 420x620 popup that
// looks fine at 900px wide in a browser is not evidence of anything.
type Surface = {
  id: string
  label: string
  hint: string
  src: string
  width: number
  height: number
  /** Overlay is transparent + click-through over other apps in reality. */
  checkerboard?: boolean
}

// Taken from the shared constant the main process sizes the real window with,
// rather than repeated here. The window is no longer a fixed 870×606 — it
// carries a gutter and scales with the font-size setting — and a harness that
// previewed the old size would quietly misreport every margin in the app.
const MAIN_WINDOW = mainWindowSize('medium')

const SURFACES: Surface[] = [
  {
    id: 'main',
    label: 'Main window',
    hint: `index.html · ${MAIN_WINDOW.width} × ${MAIN_WINDOW.height} · Home / Analyze / Settings`,
    src: '/index.html',
    width: MAIN_WINDOW.width,
    height: MAIN_WINDOW.height
  },
  {
    id: 'floating',
    label: 'Floating popup',
    hint: 'floating.html · 380 × 480 · global-hotkey clipboard capture',
    src: '/floating.html',
    width: 380,
    height: 480
  },
  {
    id: 'overlay',
    label: 'Screen Watch overlay',
    hint: 'overlay.html · transparent, click-through, drawn over other apps',
    src: '/overlay.html',
    width: 760,
    height: 480,
    checkerboard: true
  }
]

const ZOOMS = [0.75, 1, 1.25]

export default function PreviewApp(): JSX.Element {
  const [active, setActive] = useState<string[]>(['overlay'])
  const [scenario, setScenario] = useState<Scenario>(defaultScenario)
  const [zoom, setZoom] = useState(1)
  const [calls, setCalls] = useState<string[]>([])
  const [logOpen, setLogOpen] = useState(true)
  const [hovered, setHovered] = useState<string | null>(null)

  // Bumped whenever the scenario changes, and used as the iframe key so every
  // visible surface remounts against the new mock. Reloading is the honest
  // way to apply a scenario — the mock is constructed once per document, the
  // same way the real preload bridge is.
  const [generation, setGeneration] = useState(0)

  const log = useCallback((method: string) => {
    setCalls((prev) => [method, ...prev].slice(0, 200))
  }, [])

  // Published before any iframe loads; bootstrap.ts reads it synchronously.
  useEffect(() => {
    ;(window as Window & { __tracelyPreview?: PreviewBridge }).__tracelyPreview = {
      scenario,
      log
    }
  }, [scenario, log])

  function update<K extends keyof Scenario>(key: K, value: Scenario[K]): void {
    setScenario((prev) => ({ ...prev, [key]: value }))
    setCalls([])
    // Let the effect above publish the new scenario before the reload.
    window.setTimeout(() => setGeneration((g) => g + 1), 0)
  }

  function toggleSurface(id: string): void {
    setActive((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
  }

  const shown = useMemo(() => SURFACES.filter((s) => active.includes(s.id)), [active])

  // Reaches into the overlay iframe's mock (see onScreenWatchHover in
  // mockApi.ts) to push a hover event, standing in for hoverTracking.ts's
  // real cursor hit-testing.
  function emitHover(claimId: string | null): void {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Screen Watch overlay"]')
    const w = frame?.contentWindow as
      | (Window & { __previewEmitHover?: (e: ScreenWatchHoverEvent | null) => void })
      | null
      | undefined
    if (!w?.__previewEmitHover) return
    if (claimId === null) {
      w.__previewEmitHover(null)
      setHovered(null)
      return
    }
    const underline = fx.overlayUpdate.underlines.find((u) => u.id === claimId)
    const claim = fx.screenWatchClaims.find((c) => c.id === claimId)
    if (!underline || !claim || underline.rects.length === 0) return
    w.__previewEmitHover({
      claimId,
      kind: 'claim',
      text: claim.text,
      claimType: claim.claimType,
      anchor: underline.rects[0]
    })
    setHovered(claimId)
  }

  return (
    <div className="preview-root">
      <aside className="preview-rail">
        <div className="preview-brand">
          <span className="preview-dot" />
          <div>
            <div className="preview-title">Tracely Preview</div>
            <div className="preview-sub">live · mocked IPC</div>
          </div>
        </div>

        <Section title="Surfaces">
          {SURFACES.map((s) => (
            <label key={s.id} className="preview-check">
              <input type="checkbox" checked={active.includes(s.id)} onChange={() => toggleSurface(s.id)} />
              <span>
                <strong>{s.label}</strong>
                <em>{s.hint}</em>
              </span>
            </label>
          ))}
        </Section>

        <Section title="Scenario">
          {/* The "Auth gate" control stood here, switching between signed in,
              signed out, needs-name and not-configured. All four screens are
              gone with the sign-in feature; the app has one auth state now. */}
          <Field label="Plan">
            <select value={scenario.plan} onChange={(e) => update('plan', e.target.value as Scenario['plan'])}>
              <option value="free">Free</option>
              <option value="student">Student</option>
              <option value="pro">Pro</option>
            </select>
          </Field>
          <Field label="Structure">
            <select
              value={scenario.structure}
              onChange={(e) => update('structure', e.target.value as Scenario['structure'])}
            >
              <option value="heuristic">Provisional (no relay)</option>
              <option value="classified">Fully classified</option>
              <option value="stale">Stale (draft edited since)</option>
              <option value="none">Never analyzed</option>
            </select>
          </Field>
          <Field label="Latency">
            <select value={scenario.latencyMs} onChange={(e) => update('latencyMs', Number(e.target.value))}>
              <option value={0}>None</option>
              <option value={600}>600 ms</option>
              <option value={2500}>2.5 s (see spinners)</option>
            </select>
          </Field>
          <label className="preview-check">
            <input
              type="checkbox"
              checked={scenario.relayConfigured}
              onChange={(e) => update('relayConfigured', e.target.checked)}
            />
            <span>
              <strong>Relay configured</strong>
              <em>off ⇒ Critique Argument refuses up front</em>
            </span>
          </label>
          <label className="preview-check">
            <input
              type="checkbox"
              checked={scenario.failRelay}
              onChange={(e) => update('failRelay', e.target.checked)}
            />
            <span>
              <strong>Fail relay calls</strong>
              <em>review error banners</em>
            </span>
          </label>
          <label className="preview-check">
            <input
              type="checkbox"
              checked={scenario.watchAnalyzing}
              onChange={(e) => update('watchAnalyzing', e.target.checked)}
            />
            <span>
              <strong>Screen Watch analyzing</strong>
              <em>Essay Grade before its first reading</em>
            </span>
          </label>
        </Section>

        <Section title="Overlay hover">
          <div className="preview-zooms preview-wrap">
            <button className={hovered === null ? 'on' : ''} onClick={() => emitHover(null)}>
              none
            </button>
            {fx.screenWatchClaims.map((c, i) => (
              <button key={c.id} className={hovered === c.id ? 'on' : ''} onClick={() => emitHover(c.id)}>
                claim {i + 1}
              </button>
            ))}
          </div>
          <p className="preview-note">
            Hover is normally hit-tested against the real cursor over the watched app, which has no
            equivalent inside an iframe — these drive it directly.
          </p>
        </Section>

        <Section title="Zoom">
          <div className="preview-zooms">
            {ZOOMS.map((z) => (
              <button key={z} className={z === zoom ? 'on' : ''} onClick={() => setZoom(z)}>
                {z}×
              </button>
            ))}
          </div>
        </Section>

        <button className="preview-reload" onClick={() => setGeneration((g) => g + 1)}>
          Reload surfaces
        </button>
      </aside>

      <main className="preview-stage">
        {shown.length === 0 ? (
          <div className="preview-empty">Pick a surface on the left.</div>
        ) : (
          shown.map((s) => (
            <figure key={s.id} className="preview-frame" style={{ width: s.width * zoom }}>
              <figcaption>
                <strong>{s.label}</strong>
                <span>
                  {s.width} × {s.height}
                </span>
              </figcaption>
              <div
                className={`preview-viewport${s.checkerboard ? ' checker' : ''}`}
                style={{ width: s.width * zoom, height: s.height * zoom }}
              >
                <iframe
                  key={`${s.id}-${generation}`}
                  title={s.label}
                  src={s.src}
                  width={s.width}
                  height={s.height}
                  style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
                />
              </div>
            </figure>
          ))
        )}
      </main>

      <aside className={`preview-log${logOpen ? '' : ' collapsed'}`}>
        <header>
          <strong>IPC calls</strong>
          <div>
            <button onClick={() => setCalls([])}>Clear</button>
            <button onClick={() => setLogOpen((o) => !o)}>{logOpen ? '›' : '‹'}</button>
          </div>
        </header>
        {logOpen ? (
          <ol>
            {calls.length === 0 ? <li className="muted">Nothing yet — interact with a surface.</li> : null}
            {calls.map((c, i) => (
              <li key={`${c}-${i}`}>{c}</li>
            ))}
          </ol>
        ) : null}
      </aside>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="preview-section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="preview-field">
      <span>{label}</span>
      {children}
    </label>
  )
}
