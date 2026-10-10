import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@fontsource/instrument-sans/400.css'
import '@fontsource/instrument-sans/500.css'
import '@fontsource/instrument-sans/600.css'
// 700 stays in this window only: no product rule asks for it, but the editor
// keeps a pasted document's inline `font-weight: 700` spans, and the user can
// set those in Instrument Sans.
import '@fontsource/instrument-sans/700.css'
import './styles/index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  // No ResizeGrips and no WindowControls any more.
  //
  // Both existed to replace chrome a frameless, transparent window does not
  // get: the OS sends no non-client hit-test to such a window, so there was no
  // resize border and no title bar to minimize, maximize or close from. Eight
  // DOM handles and a three-button cluster stood in for them.
  //
  // The window has a real frame now, so the OS provides every one of those —
  // and provides them better: snap, Win+Arrow, double-click-to-maximize,
  // fullscreen, and a maximize that actually maximizes rather than sizing to
  // the work area and centring. Keeping the hand-written versions alongside
  // would put two close buttons on the same window.
  //
  // The MAIN window's entry only. floating.tsx and overlay.tsx are separate
  // documents in separate windows — the floating popup is a fixed-size panel
  // and the overlay is click-through by design.
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
