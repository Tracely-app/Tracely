import React from 'react'
import ReactDOM from 'react-dom/client'
import FloatingApp from './FloatingApp'
import '@fontsource/instrument-sans/400.css'
import '@fontsource/instrument-sans/500.css'
import '@fontsource/instrument-sans/600.css'
// No 700: nothing in this window asks for it any more (600 is the heaviest
// weight in the product), so the face would be downloaded and never drawn.
import './styles/index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <FloatingApp />
  </React.StrictMode>
)
