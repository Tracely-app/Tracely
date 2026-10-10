import React from 'react'
import ReactDOM from 'react-dom/client'
// The overlay names Instrument Sans in its FONT_STACK but never loaded it, so
// every card drew in the system fallback (Segoe UI on Windows) while the main
// and floating windows — and the Figma designs all of this is drawn
// from — used Instrument Sans. Nothing about the layout was wrong; it simply
// was not the same typeface, which is most of why the overlay never quite
// looked like the mockups.
//
// Bundled by @fontsource, not fetched: overlay.html ships `default-src 'self'`
// with no font-src, so a Google Fonts URL would be blocked outright. No 700:
// 600 is the heaviest weight drawn here (OverlayApp maps strong/b to it).
import '@fontsource/instrument-sans/400.css'
import '@fontsource/instrument-sans/500.css'
import '@fontsource/instrument-sans/600.css'
import OverlayApp from './OverlayApp'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>
)
