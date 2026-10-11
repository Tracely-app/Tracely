import { join } from 'path'
import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { FontSize } from '@shared/types'
import type { ResizeHandle } from '@shared/ipc-contract'
import { IPC_EVENTS } from '@shared/ipc-channels'
import {
  clampWindowBounds,
  LAYOUT_HEIGHT,
  LAYOUT_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  TITLEBAR_HEIGHT
} from '@shared/windowSize'
import { windowTitle } from '../appIdentity'
import { getSetting, setSetting } from '../services/storage/settingsRepo'
import { getAppIconPath } from '../icon'
import { hideFloatingWindow } from './floatingWindow'
import { hideOverlay } from './overlayWindow'
import { installSpellcheck } from '../spellcheck'
import { voiceService } from '../services/voice'

let mainWindow: BrowserWindow | null = null
let isQuitting = false

export function setQuitting(value: boolean): void {
  isQuitting = value
}

/** Reads the persisted font size, tolerating an unset or junk value. */
function currentFontSize(): FontSize {
  const raw = getSetting('fontSize')
  return raw === 'small' || raw === 'large' ? raw : 'medium'
}

/** Where the user last left the window. A plain key rather than an AppSettings
 *  field: this is window state, not a preference anyone sets, and it has no
 *  business in the Settings IPC contract. */
const SCALE_KEY = 'mainWindowScale'
const SIZE_KEY = 'mainWindowSize'
const POSITION_KEY = 'mainWindowPosition'

/**
 * The size the user last left the window at.
 *
 * A width and a height, because the window no longer has one degree of freedom
 * — see the note in shared/windowSize.ts. SCALE_KEY is still read, once, so an
 * install that has been remembering a scale opens at the size that scale meant
 * instead of snapping back to the default; nothing writes it any more.
 */
function savedSize(): { width: number; height: number } | null {
  const raw = getSetting(SIZE_KEY)
  const [w, h] = raw.split(',').map(Number)
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: w, height: h }
  }
  const legacy = Number(getSetting(SCALE_KEY))
  if (Number.isFinite(legacy) && legacy > 0) {
    return { width: Math.round(LAYOUT_WIDTH * legacy), height: Math.round(LAYOUT_HEIGHT * legacy) }
  }
  return null
}

function persistSize(width: number, height: number): void {
  setSetting(SIZE_KEY, `${Math.round(width)},${Math.round(height)}`)
}

/**
 * The font-size setting no longer touches the window, and that is the change.
 *
 * It used to resize it, because the two really were the same operation: a
 * `zoom` derived from the window's width meant "bigger text" and "bigger
 * window" were one control wearing two hats, and they had to be composed or
 * they fought. With the zoom back on the setting alone (renderer/lib/
 * appearance.ts) they are independent — larger text simply means less fits in
 * whatever window you have chosen, exactly as in any other application.
 *
 * Kept as an exported no-op rather than deleted: it is called from the settings
 * handler, and a signature change there is a bigger edit than this needs.
 */
export function applyMainWindowFontSize(_fontSize: FontSize): void {
  // Deliberately nothing.
}

/**
 * The remembered position, but only if it is still on a screen.
 *
 * A window restored onto a monitor that has since been unplugged is invisible
 * and — because this app has no taskbar minimize and no window menu — genuinely
 * unrecoverable without clearing settings. The test is that the window's own
 * rectangle overlaps some display's work area by a usable amount, not that its
 * origin is inside one: a window whose top-left sits just off the left edge is
 * fine and common, one that is entirely off is not.
 *
 * Returns null to mean "centre it", which is what the window did before this
 * existed.
 */
function savedPosition(width: number, height: number): { x: number; y: number } | null {
  const raw = getSetting(POSITION_KEY)
  const [x, y] = raw.split(',').map(Number)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null

  // Enough of the window to grab and drag back. The card is the drag handle and
  // its top edge is where a user reaches for, so this is deliberately generous.
  const VISIBLE_MARGIN = 120
  const onScreen = screen.getAllDisplays().some((display) => {
    const a = display.workArea
    return (
      x + width - VISIBLE_MARGIN > a.x &&
      x + VISIBLE_MARGIN < a.x + a.width &&
      y + height - VISIBLE_MARGIN > a.y &&
      // The TOP edge specifically: a window dragged below the bottom of the
      // screen leaves nothing draggable above the taskbar.
      y >= a.y - 8 &&
      y < a.y + a.height - VISIBLE_MARGIN
    )
  })
  return onScreen ? { x: Math.round(x), y: Math.round(y) } : null
}

export function createMainWindow(): BrowserWindow {
  // The Figma frame's own size plus a gutter, scaled by the font-size setting —
  // the app IS the frame, not a resizable OS window with the frame floating
  // inside it. No minimize/maximize either: the design has no such chrome, only
  // its own in-content close button (see HomeView/AnalyzeView).
  const workArea = screen.getPrimaryDisplay().workArea
  const { width, height } = clampWindowBounds(
    savedSize() ?? { width: LAYOUT_WIDTH, height: LAYOUT_HEIGHT },
    workArea
  )
  const position = savedPosition(width, height)
  const win = new BrowserWindow({
    width,
    height,
    ...(position ?? {}),
    // Without this, Electron falls back to OS default placement (often
    // hugging a screen edge rather than the middle) since no x/y is given.
    // Skipped when a remembered position is being restored.
    center: position === null,
    // An ordinary OS window. Frame, title bar, native minimize/maximize/close,
    // native resize borders, snap, double-click-to-maximize, Win+Arrow — all of
    // it, for free and behaving exactly as every other window on the machine.
    //
    // This app spent a long time as a frameless transparent floating card,
    // because the Figma frames draw no chrome and the design IS the app. What
    // that cost: a hand-written resize grip per edge (the OS will not send
    // non-client hit-tests to a transparent frameless window), a hand-written
    // minimize/maximize/close cluster, a drag region that had to be opted out
    // of by every interactive element, and a "maximize" that could only ever
    // approximate the real one — it sized to the work area and centred, which
    // is not maximizing and does not fullscreen.
    //
    // Owner's call, 2026-08-18: "make it like an actual app". Every one of
    // those hand-written pieces is now the OS's job.
    resizable: true,
    // The menu bar is HIDDEN, not removed. `File Edit View Window Help` across
    // the top of the app is chrome the design does not have and does not want —
    // but `Menu.setApplicationMenu(null)` would take the Edit role with it, and
    // that role is what carries Ctrl+Z into the document editor. There is an
    // e2e test asserting it is installed for exactly that reason. Auto-hide
    // keeps every accelerator and shows the bar on Alt.
    autoHideMenuBar: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    show: false,
    frame: true,
    // No title bar strip, but the real window buttons.
    //
    // Owner's call, 2026-08-18: "please remove this top panel" — the grey band
    // with the app name across the top. `titleBarStyle: 'hidden'` removes the
    // band; `titleBarOverlay` puts the OS's own minimize/maximize/close back
    // over the page's top-right corner, so this is not a return to the
    // hand-written cluster that was deleted a day earlier. The buttons are
    // drawn and hit-tested by Windows — its hover states, its snap-layouts
    // flyout on maximize, its high-contrast handling.
    //
    // Transparent, so the page's own background runs to the top edge and no
    // panel of any colour is left. That also means the overlay needs no theme
    // wiring: there is nothing to keep in sync with light/dark.
    //
    // The cost is that the caption area no longer exists, so dragging the
    // window becomes CSS's job (`.app-dragbar` in index.css), and the buttons
    // sit ON the page, so any view with content along its top edge has to keep
    // clear of them. `--winctl-reserve` exists for exactly that and is non-zero
    // again.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#212429',
      height: TITLEBAR_HEIGHT
    },
    // Opaque. Transparency existed only so the CSS-rounded card was the sole
    // visible thing; with a real frame the window is a rectangle and painting
    // it is what stops a white flash on show.
    backgroundColor: '#ffffff',
    title: windowTitle(),
    icon: getAppIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })


  // No aspect lock. It existed because the layout box had one shape and the
  // zoom absorbed the difference; with the UI no longer scaling, width and
  // height are independent and the window behaves like any other. No maximum
  // either — the work-area clamp in the resize path is the real bound, and a
  // fixed maximum would be wrong the moment a second monitor appeared.
  win.setMinimumSize(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)

  // Chromium's spell checker, and the context menu that makes its suggestions
  // reachable. The editor asks for the squiggle (`spellCheck` on the
  // contentEditable); this is the half that has to live in main.
  installSpellcheck(win)

  // Remember where the user put it, and how big. Debounced because `resize`
  // fires continuously through a drag and `setSetting` writes the whole SQLite
  // database to disk on every call (see storage/db.ts persist) — one write per
  // frame of a resize would be the most expensive thing in the app.
  let saveTimer: NodeJS.Timeout | undefined
  const remember = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const [w, h] = win.getSize()
      const [x, y] = win.getPosition()
      persistSize(w, h)
      setSetting(POSITION_KEY, `${Math.round(x)},${Math.round(y)}`)
    }, 400)
  }
  win.on('resize', remember)
  win.on('move', remember)

  // A page's <title> replaces the window title the moment it loads, so the
  // `title` option above was being silently overwritten by 'Tracely' from the
  // HTML — which is why a preview build still called itself Tracely in the
  // taskbar and Alt-Tab. Found by launching both builds and reading the real
  // window titles; the code looked correct.
  win.on('page-title-updated', (event) => event.preventDefault())
  win.on('ready-to-show', () => {
    hideOverlay()
    hideFloatingWindow()
    win.show()
  })

  // Screen Watch's transparent window deliberately sits at the screen-saver
  // always-on-top level. Hide it synchronously when main is shown/focused;
  // waiting for the 1.2s UIA poll leaves stale underlines/popovers over this
  // window and, if hover capture was active, blocks its controls too.
  const prepareMainWindow = (): void => {
    hideOverlay()
    hideFloatingWindow()
  }
  win.on('show', prepareMainWindow)
  win.on('focus', prepareMainWindow)

  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      // Closing hides to the tray and the renderer lives on, so a voice call
      // would keep streaming the mic and billing the student's minutes from
      // a window nobody can see. Hang it up: the renderer (which stops the
      // mic and saves the transcript) and main itself, in case the renderer
      // is too busy to answer. Minimizing or switching windows leaves a call
      // alone — talking while looking at the draft is the point.
      win.webContents.send(IPC_EVENTS.VOICE_HANG_UP)
      void voiceService.endOpen()
      win.hide()
    }
  })
  // A crashed renderer never sends its end; the server would hold the line
  // until OpenAI noticed the peer had gone.
  win.webContents.on('render-process-gone', () => {
    void voiceService.endOpen()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = win
  win.on('closed', () => {
    mainWindow = null
  })

  return win
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function showMainWindow(): void {
  if (mainWindow) {
    hideOverlay()
    hideFloatingWindow()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

/**
 * The renderer no longer drives resizing — the OS does, through the window's
 * own borders. Kept as no-ops because the IPC channels and the preload surface
 * still name them, and unwiring an implementation is not a reason to
 * restructure a shared contract (see the branch rules in CLAUDE.md).
 *
 * What they used to do: a frameless TRANSPARENT window receives no non-client
 * hit-test on Windows, so the invisible resize border every other window gets
 * simply did not exist. Eight DOM handles stood in for it, forwarding a pointer
 * delta to `setBounds` once per IPC round-trip. It worked, and it was never as
 * good as the border the OS was already prepared to give us.
 */
export function beginWindowResize(_handle: ResizeHandle): void {
  // Deliberately nothing.
}

export function updateWindowResize(_dx: number, _dy: number): void {
  // Deliberately nothing.
}


// -- window controls ---------------------------------------------------------

export function minimizeMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.minimize()
}

/**
 * Maximize and restore.
 *
 * The title bar's own button does this now. These are kept because the IPC
 * contract and the preload surface still expose them — `src/shared/*` is
 * additive — and because the renderer's own control called them.
 *
 * They are the REAL maximize now, not an approximation. The old pair sized the
 * window to the work area less a margin and centred it, which is a large window
 * and not a maximized one: it did not snap, did not restore, and did not
 * fullscreen. `win.maximize()` does all three because the OS is doing it.
 */
export function toggleMaximizeMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
}

export function isMainWindowMaximized(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return mainWindow.isMaximized()
}
