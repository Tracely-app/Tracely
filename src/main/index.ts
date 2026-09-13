import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerGlobalHotkey, registerScreenWatchHotkey, unregisterGlobalHotkey, unregisterScreenWatchHotkey } from './hotkey'
import { registerIpcHandlers } from './ipc'
import { setAccessTokenProvider, setPlanProvider } from './services/ai/identity'
import { ensureAnonymousSession, getSupabase, isAuthConfigured } from './services/auth/client'
import { getCurrentPlan } from './services/auth/plan'
import { warmUpUia } from './services/screenWatch/uiaSnapshot'
import { initScreenWatch, shutdownScreenWatch } from './services/screenWatch/screenWatchService'
import { warmUp as warmUpMl } from './services/ml'
import { warmUp as warmUpWorldBank } from './services/search/worldBank'
import { initDb, persist } from './services/storage/db'
import { forgetDocumentNames, recoverLearnedNames } from './spellcheck'
import { setAppPaths } from './services/storage/paths'
import { getSetting } from './services/storage/settingsRepo'
import { createTray } from './tray'
import { initAutoUpdater } from './updater'
import { createFloatingWindow } from './windows/floatingWindow'
import { createMainWindow, setQuitting, showMainWindow } from './windows/mainWindow'


const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // A second launch refocuses the running app rather than starting another.
  // It used to also fish an OAuth callback URL out of argv; there is no
  // sign-in to call back into any more, so this is just the refocus.
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.tracely.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // Must precede initDb and anything else that touches storage — every
    // write location now resolves through storage/paths.ts rather than
    // calling Electron directly, so that the same modules can run headless
    // under scripts/evaluate.mjs.
    setAppPaths({
      dataDir: app.getPath('userData'),
      appRoot: app.getAppPath(),
      resourcesDir: app.isPackaged ? process.resourcesPath : null
    })

    await initDb()

    // Immediately after the DB and before any document is opened. A session
    // that did not shut down cleanly left its learned names in Chromium's
    // PERSISTENT dictionary, and leaving them there is exactly what
    // session-scoped name learning exists to prevent — see spellcheck.ts.
    recoverLearnedNames()

    // Nobody signs in to Tracely, but the relay still refuses a call it
    // cannot attribute and still counts a daily allowance per account — so
    // the app quietly holds an anonymous Supabase session instead. First
    // launch creates it; every launch after this reuses the stored one. See
    // ensureAnonymousSession.
    //
    // Awaited, and before the token provider is registered, so the first AI
    // call of the session has an identity to send. It cannot reject.
    await ensureAnonymousSession()

    // Before any window exists, because a window is where AI calls come from.
    // The relay bills per account and refuses calls it cannot attribute, so
    // every request carries that session's Supabase access token — read fresh
    // each time so an expired one is refreshed rather than sent.
    setAccessTokenProvider(async () => {
      if (!isAuthConfigured()) return null
      const { data } = await getSupabase().auth.getSession()
      return data.session?.access_token ?? null
    })
    // And what that account has paid for, which decides the model tier every
    // one of those calls runs at — see services/ai/modelTier.ts.
    setPlanProvider(getCurrentPlan)

    createMainWindow()
    createFloatingWindow()
    createTray()
    registerIpcHandlers()
    registerGlobalHotkey(getSetting('hotkeyAccelerator'))
    registerScreenWatchHotkey(getSetting('screenWatchHotkeyAccelerator'))
    initAutoUpdater()
    initScreenWatch()
    // Same "pay it at boot, not in front of the user" reasoning as the ML
    // worker below: the first
    // uia-watch.ps1 run costs ~1160ms against ~380ms for later ones, and
    // without this that penalty lands on the moment Screen Watch is turned
    // on and the user is waiting for the widget. Loads assemblies only —
    // it reads no window text (see warmUpUia).
    warmUpUia()

    // Same reasoning as warmUpUia above: pay the one-time cost at boot rather
    // than in front of the user. Measured, the first
    // findEvidence call spent 10.0 seconds on local work against ~1.2s for
    // later ones — worker spawn, the transformers import, onnxruntime init and
    // ~22MB of weights, all of it once. Reads as "the app is slow to find
    // sources" when it is really "the model is loading".
    //
    // Deliberately not awaited: nothing here depends on it, and a failure just
    // means the first analysis takes the old path.
    warmUpMl()
    // The World Bank catalogue is another one-time local-ML cost: roughly
    // 1,500 indicator names must be embedded before statistical matching is
    // available. Build it in the background at boot; searches never wait on
    // the build, and incomplete cold-start results are not cached.
    warmUpWorldBank()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    // Tracely keeps running in the tray so the global hotkey stays live even
    // if the main window is closed.
  })

  app.on('before-quit', () => {
    setQuitting(true)
    // The other half of session-scoped: every name Tracely taught the
    // spellchecker is removed on the way out, so nothing it learned from one
    // essay survives into the next launch.
    forgetDocumentNames()
    persist()
  })

  app.on('will-quit', () => {
    unregisterGlobalHotkey()
    unregisterScreenWatchHotkey()
    shutdownScreenWatch()
  })
}
