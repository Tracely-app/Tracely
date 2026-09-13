import { useEffect, useState } from 'react'
import AnalyzeView from './views/AnalyzeView'
import DocumentsView from './views/DocumentsView'
import LibraryView from './views/LibraryView'
import HomeView from './views/HomeView'
import SettingsView from './views/SettingsView'
import { applyTheme } from './lib/theme'
import { applyAccentColor, applyDensity, applyFontSize, trackWindowZoom } from './lib/appearance'
import { tracelyApi } from './lib/api'
import { GradeLevelProvider } from './lib/gradeLevel'
import { PlanProvider } from './lib/plan'

export type Tab = 'home' | 'documents' | 'analyze' | 'library' | 'settings'

// There is no gate here any more.
//
// This file used to open on one of three screens depending on an auth lookup:
// a blank shell while it resolved, LoginView if nobody was signed in, then
// NamePromptView if that account had no first name. Nobody signs in now — the
// app holds an anonymous Supabase session it creates for itself at boot, purely
// so the relay has an account to attribute spend to (see ensureAnonymousSession
// in main/services/auth/client.ts). None of that is the user's business, so
// none of it is on their screen, and the window opens straight into Home.
//
// The blank `.app-shell` that used to cover the first paint went with it: it
// existed to avoid flashing the login card at someone who turned out to be
// signed in, and there is no card left to flash.

// One piece of window chrome, and it is invisible: `.app-dragbar`.
//
// The window is an ordinary OS window — native resize borders, snap, Win+Arrow,
// and the real minimize / maximize / close, which Windows draws over the
// page's top-right corner because the title BAR is hidden and only its overlay
// remains (createMainWindow). What a hidden title bar does not leave behind is
// a caption area to drag the window by, so that strip is it.
//
// The app draws no buttons of its own. It did once, and the cluster was deleted
// in favour of the OS's; two close buttons on one window is worse than none.
export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('home')
  // Which document the editor should open. Lives here rather than inside
  // AnalyzeView because the Documents page is what chooses it, and the two are
  // siblings. `null` means a new, untitled one.
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null)

  // Before the settings round-trip, not after: the window opens at whatever
  // size it was last left at, and until the zoom matches that width the card
  // renders at the wrong scale. Waiting on an IPC call to fix it is a visible
  // flash of a mis-sized UI on every launch.
  useEffect(() => trackWindowZoom(), [])

  useEffect(() => {
    tracelyApi.getSettings().then((s) => {
      applyTheme(s.theme)
      applyAccentColor(s.accentColor)
      applyDensity(s.density)
      applyFontSize(s.fontSize)
    })
  }, [])

  return (
    // Every letter grade in this window is banded against the school year in
    // Settings > Preferences. The provider reads it once; the six places that
    // draw a letter take it from context rather than from four layers of props.
    <GradeLevelProvider>
    {/* What this account has paid for. Settings > Billing names it, and the
        model rows in Preferences lock against it. */}
    <PlanProvider>
    <div className="app-shell">
      {/* The window has no title bar to drag by — see mainWindow.ts. This is
          the strip that replaces its caption area; it stops short of the
          corner Windows draws the real window buttons in. */}
      <div className="app-dragbar" aria-hidden="true" />
      <main className={`app-main ${tab === 'home' ? 'app-main-fixed' : ''}`}>
        {tab === 'home' ? (
          <HomeView
            onNavigate={setTab}
            // The same route DocumentsView's "+ New document" takes: a null id
            // is what the editor reads as "start an Untitled document", so
            // Home's primary action lands in the editor rather than one page
            // short of it.
            onNewDocument={() => {
              setOpenDocumentId(null)
              setTab('analyze')
            }}
            // Identical to the Documents list's row handler below — Home's
            // recent cards are a shortcut into the editor, not a shortcut to
            // the list.
            onOpenDocument={(id) => {
              setOpenDocumentId(id)
              setTab('analyze')
            }}
          />
        ) : null}
        {tab === 'documents' ? (
          <DocumentsView
            onNavigate={setTab}
            onOpenDocument={(id) => {
              setOpenDocumentId(id)
              setTab('analyze')
            }}
          />
        ) : null}
        {tab === 'analyze' ? <AnalyzeView onNavigate={setTab} openDocumentId={openDocumentId} /> : null}
        {tab === 'library' ? <LibraryView onNavigate={setTab} /> : null}
        {tab === 'settings' ? <SettingsView onNavigate={setTab} /> : null}
      </main>
    </div>
    </PlanProvider>
    </GradeLevelProvider>
  )
}
