import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { IPC_EVENTS } from '@shared/ipc-channels'
import { oauthSchemeFor } from '@shared/oauthScheme'
import { isPreviewBuild } from './appIdentity'
import { registerGlobalHotkey, registerScreenWatchHotkey, unregisterGlobalHotkey, unregisterScreenWatchHotkey } from './hotkey'
import { registerIpcHandlers } from './ipc'
import { setAccessTokenProvider, setPlanProvider } from './services/ai/identity'
import { getSupabase, handleOAuthRedirect, isAuthConfigured } from './services/auth/client'
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
import { createMainWindow, getMainWindow, setQuitting, showMainWindow } from './windows/mainWindow'

// Google's OAuth consent screen opens in the user's real default browser
// (Electron can't embed it), then redirects to this custom scheme to hand
// control back to the app.
//
// PER CHANNEL, because exactly one program on Windows owns a scheme: stable
// and preview both claiming `tracely://` meant the last one launched received
// the other's authorization code, and had no PKCE verifier to exchange it
// with. See shared/oauthScheme.ts.
const OAUTH_PROTOCOL = oauthSchemeFor(isPreviewBuild())

function handleOAuthUrl(url: string): void {
  if (!url.startsWith(`${OAUTH_PROTOCOL}://auth-callback`)) return
  showMainWindow()
  console.log('[auth] OAuth redirect received, exchanging code…')
  handleOAuthRedirect(url)
    .then(() => {
      console.log('[auth] OAuth redirect handled successfully')
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[auth] OAuth redirect failed:', message)
      // A failure here (e.g. an expired/already-used code, or a session
      // storage mismatch) previously vanished into the main-process log
      // with nothing shown in the app — LoginView listens for this so the
      // user gets a real, retryable error instead of silence.
      getMainWindow()?.webContents.send(IPC_EVENTS.AUTH_OAUTH_ERROR, message)
    })
}

/**
 * Claims this channel's scheme for THIS build, on every launch.
 *
 * Two things were wrong here and both produced the same silent failure: Google
 * completes sign-in, redirects to `tracely://auth-callback?code=…`, Windows
 * hands it to whatever owns the scheme, and if that is not a running Tracely
 * the code is never exchanged. The login screen then sits on "Continue in the
 * browser window that just opened" forever, with nothing to report — nothing
 * calls back, so there is no error to show.
 *
 * **Dev was registering a dead handler.** With no exec path, Electron writes
 * `"…\node_modules\electron\dist\electron.exe" "%1"` — the raw binary with no
 * app to run — so after any `npm run dev` the INSTALLED app's Google login
 * broke, and stayed broken, because the scheme now pointed at something that
 * starts nothing. Measured on the owner's machine, 2026-09-11: that exact
 * command was in HKCU, and invoking the protocol launched no process at all.
 * Windows needs the exec path and the app path explicitly in dev.
 *
 * **The `isDefaultProtocolClient` guard made it sticky.** It is a fine test for
 * "am I already registered", and a bad one for recovery: nothing re-asserted
 * the claim, so a stale registration survived every later launch of the real
 * app. Re-asserting unconditionally means launching the app you actually use
 * repairs it, which is the only fix a user can perform without a registry
 * editor.
 */
function registerOAuthProtocol(): void {
  const claimed = app.isPackaged
    ? app.setAsDefaultProtocolClient(OAUTH_PROTOCOL)
    : // argv[1] is the app path electron was started with. Guarded because a
      // launch shape without it would otherwise throw here, during startup,
      // over a protocol that is not required for the app to run.
      typeof process.argv[1] === 'string'
      ? app.setAsDefaultProtocolClient(OAUTH_PROTOCOL, process.execPath, [
          path.resolve(process.argv[1])
        ])
      : false

  // Logged because this is otherwise invisible until someone tries to sign in
  // with Google and nothing happens — which is a long way from the cause.
  console.log(
    `[auth] ${OAUTH_PROTOCOL}:// ${claimed ? 'registered to' : 'NOT registered for'} ` +
      `${app.isPackaged ? app.getPath('exe') : 'dev'}`
  )
}
registerOAuthProtocol()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Windows/Linux: a protocol-URL launch relaunches the exe, which the
  // single-instance lock redirects into this 'second-instance' event on the
  // already-running instance, with the URL as one of the argv entries.
  app.on('second-instance', (_event, argv) => {
    showMainWindow()
    const url = argv.find((arg) => arg.startsWith(`${OAUTH_PROTOCOL}://`))
    if (url) handleOAuthUrl(url)
  })

  // macOS delivers protocol launches via this event instead of argv.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleOAuthUrl(url)
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

    // Before any window exists, because a window is where AI calls come from.
    // The relay bills per account and refuses calls it cannot attribute, so
    // every request carries the signed-in user's Supabase access token —
    // read fresh each time so an expired one is refreshed rather than sent.
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

    // Cold start via the protocol (app wasn't already running) delivers the
    // URL as a plain argv entry instead of 'second-instance'/'open-url'.
    const coldStartUrl = process.argv.find((arg) => arg.startsWith(`${OAUTH_PROTOCOL}://`))
    if (coldStartUrl) handleOAuthUrl(coldStartUrl)

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
