import { spawn } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { selfProcessName } from './selfProcess'

export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ClaimSpanRequest {
  id: string
  start: number
  length: number
}

export interface ClaimRectResult {
  id: string
  rects: ScreenRect[]
  // Diagnostic-only fields below, temporary while chasing down a provider
  // (confirmed: Windows 11 Notepad) that returns zero bounding rects for a
  // range built from character offsets. rawRectCount distinguishes "provider
  // returned nothing at all" from "returned rects but they were all
  // off-screen"; rangeTextPreview confirms whether the offset math actually
  // landed the range on the right text in the first place; the *Error
  // fields catch exceptions that would otherwise be silently swallowed.
  rawRectCount?: number
  rangeTextPreview?: string | null
  moveError?: string | null
  scrollError?: string | null
  rectError?: string | null
}

export type UiaSnapshot =
  | { ok: true; skip: true; reason: string; processName?: string }
  | {
      ok: true
      skip: false
      processName: string
      text: string
      supportsTextPattern: boolean
      controlRect: ScreenRect
      // The focused control's top-level application window, walked via
      // TreeWalker — used to scope the overlay to that one window instead of
      // the whole display (falls back to controlRect if no Window ancestor
      // was found; see uia-watch.ps1).
      windowRect: ScreenRect
      claimRects: ClaimRectResult[]
      // Diagnostic-only, see the comment on ClaimRectResult.
      wholeDocRectCount?: number
      visibleRangeCount?: number
      visibleRangeRectCount?: number
    }
  | { ok: false; error: string }

const SCRIPT_TIMEOUT_MS = 4000
// Insert mode does a clipboard round-trip and a 200ms settle sleep on top of
// the UIA work snapshot mode does, so it gets a little more headroom before
// being treated as hung.
const INSERT_TIMEOUT_MS = 6000

function getScriptPath(): string {
  return is.dev
    ? join(app.getAppPath(), 'resources', 'uia-watch.ps1')
    : join(process.resourcesPath, 'uia-watch.ps1')
}

let warmedUp = false

/**
 * Loads PowerShell and the three UI Automation assemblies into the OS file
 * cache ahead of the first real snapshot.
 *
 * Measured on this machine: the first `uia-watch.ps1` run costs ~1160ms,
 * subsequent ones ~380ms. Nearly all of that first-run penalty is process
 * startup plus JIT/assembly loading, and it lands squarely on the moment
 * the user turns Screen Watch on and waits for the widget to appear.
 *
 * Deliberately runs `Add-Type` only, and NOT a snapshot: warming must not
 * read anything from any window. Screen Watch is opt-in precisely because
 * it reads other apps' text, and a warm-up that took a real snapshot would
 * be doing that before the user opted in.
 *
 * Fire-and-forget: nothing waits on it, and a failure just means the first
 * real call pays the cost it would have paid anyway.
 */
export function warmUpUia(): void {
  if (warmedUp || process.platform !== 'win32') return
  warmedUp = true
  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; Add-Type -AssemblyName System.Windows.Forms; exit'
      ],
      { windowsHide: true, stdio: 'ignore' }
    )
    child.on('error', () => {})
    child.unref()
  } catch {
    // Warming is best-effort by definition.
  }
}

/**
 * Spawns uia-watch.ps1 with the given extra args and returns its parsed
 * single-line JSON result. Spawned fresh per call (rather than kept alive)
 * to avoid async-stdin complexity in the PowerShell side — see
 * resources/uia-watch.ps1 for why. Shared by snapshot/insert/undo modes;
 * each caller supplies its own -Mode and mode-specific args.
 */
function runUiaScript<T>(args: string[], timeoutMs: number): Promise<T | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        getScriptPath(),
        '-SelfProcessName',
        selfProcessName(process.execPath),
        ...args
      ],
      { windowsHide: true }
    )

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: T | { ok: false; error: string }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, error: 'uia-watch.ps1 timed out' })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: err.message })
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        finish(JSON.parse(stdout.trim()) as T)
      } catch {
        // Was previously just "Unparseable output from uia-watch.ps1" with no
        // way to tell what actually went wrong — the two live candidates are
        // (a) the script hit a terminating error before its own catch could
        // run (rare, since almost everything is wrapped), which lands on
        // stderr, not stdout, or (b) PowerShell's transcript/verbose/warning
        // streams leaking non-JSON text onto stdout ahead of our own output.
        // Truncated snippets of both let a future occurrence actually be
        // diagnosed from the log instead of hitting this same dead end again.
        const stdoutSnippet = stdout.trim().slice(0, 300)
        const stderrSnippet = stderr.trim().slice(0, 300)
        finish({
          ok: false,
          error: `Unparseable output from uia-watch.ps1 (stdout: ${JSON.stringify(stdoutSnippet)}, stderr: ${JSON.stringify(stderrSnippet)})`
        })
      }
    })
  })
}

export function takeUiaSnapshot(spans: ClaimSpanRequest[]): Promise<UiaSnapshot> {
  const spansB64 = spans.length > 0 ? Buffer.from(JSON.stringify(spans), 'utf-8').toString('base64') : ''
  return runUiaScript<UiaSnapshot>(['-SpansB64', spansB64], SCRIPT_TIMEOUT_MS) as Promise<UiaSnapshot>
}

export type UiaWriteResult = { ok: true; processName: string } | { ok: false; error: string }

/**
 * Types `text` into the currently focused external control at `offset`
 * (character offset into that control's live text). `expectedSnippet` is
 * the ~30 characters the caller last saw starting at that offset — the
 * script aborts rather than inserting if the live text there no longer
 * matches, since the document may have changed since the offset was
 * computed. See the "insert" mode block in resources/uia-watch.ps1.
 */
export function insertCitationText(
  offset: number,
  text: string,
  expectedSnippet: string
): Promise<UiaWriteResult> {
  return runUiaScript<UiaWriteResult>(
    [
      '-Mode',
      'insert',
      '-InsertOffset',
      String(offset),
      '-InsertTextB64',
      Buffer.from(text, 'utf-8').toString('base64'),
      '-ExpectedSnippetB64',
      Buffer.from(expectedSnippet, 'utf-8').toString('base64')
    ],
    INSERT_TIMEOUT_MS
  ) as Promise<UiaWriteResult>
}

/** Sends Ctrl+Z to whatever external control is currently focused. */
export function undoLastInsert(): Promise<UiaWriteResult> {
  return runUiaScript<UiaWriteResult>(['-Mode', 'undo'], SCRIPT_TIMEOUT_MS) as Promise<UiaWriteResult>
}
