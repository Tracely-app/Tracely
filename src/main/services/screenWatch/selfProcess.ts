import { win32 } from 'node:path'

/**
 * The image name UIA will report for Tracely's own windows, e.g. "Tracely.exe".
 *
 * `uia-watch.ps1` compares it against `Get-Process` for the focused element, to
 * skip Tracely's own windows and to refuse inserting a citation into them. It
 * used to be `${app.name}.exe`, but `app.name` is package.json's `name`, not
 * the executable's: "tracely" happens to match "Tracely.exe" under PowerShell's
 * case-insensitive -ieq, while a preview build is "tracely-preview" running as
 * "Tracely Preview.exe" and `npm run dev` is "tracely" running as
 * "electron.exe". Neither ever matched, so in those builds Screen Watch read
 * Tracely's own editor as another app (when allowed), and a citation insert
 * that lost focus to Tracely went into Tracely's own editor.
 *
 * The executable path is the truth. `win32` because UIA is Windows-only, and
 * so the test means the same thing on any machine.
 */
export function selfProcessName(execPath: string): string {
  return win32.basename(execPath)
}
