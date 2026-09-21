import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A random id for this installation, created the first time it is asked for
 * and kept in config.json forever after.
 *
 * ── Why the app needs one ───────────────────────────────────────────────────
 * The Tracely server meters free usage per caller. A signed-in caller is
 * metered by its Supabase id, but the desktop's anonymous sign-in can fail (it
 * is off on the live project today), and then a call carries no identity at
 * all. The server's last resort is the client ADDRESS, and it deliberately
 * puts no daily quota on an address: a few hundred students behind one school
 * or CGNAT address are indistinguishable from one attacker behind it (see
 * `callerId` in server/lib/entitlement.js). Without this id every signed-out
 * desktop user would land on that rung. With it, each install gets its own
 * quota — the same arrangement the extension has had since it was hosted.
 *
 * It is NOT a credential and not a defence. It is generated on the client, so
 * anyone can rotate it; the server's global budget is what bounds a determined
 * caller. It separates honest users from each other, which is the common case.
 * Random, never derived from anything about the user or the machine, so it
 * identifies an install and nothing else.
 *
 * ── Why it is never regenerated ─────────────────────────────────────────────
 * A new id is a fresh daily quota. An app that minted one per launch (or per
 * call, or whenever a read hiccuped) would hand every user unlimited free use
 * by accident — the rotation the server cannot stop, done by us. So an id is
 * only ever created when there is provably none: no config.json, or one that
 * parses and holds no id. Every other failure keeps whatever is on disk.
 *
 * A leaf — node built-ins only — so `npm test` can exercise the real file
 * handling against a temporary directory. `getInstallId` in config.ts is the
 * caller; it owns where config.json lives.
 */

export const INSTALL_ID_FIELD = 'installId'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Only a UUID counts. This function is the only writer of the field, so
 * anything else there — a blank string, a hand edit, a 300-character value the
 * server's 200-character header bound would silently ignore — is damage, not
 * an id, and is replaced once. That is the single case where a stored value is
 * overwritten.
 */
export function isInstallId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export interface InstallIdResult {
  id: string
  /**
   * False when the id could not be put on disk, so it lasts only as long as
   * this process. The caller keeps it in memory for exactly that long, which
   * keeps it stable for the session even when it cannot be stable across one.
   */
  persisted: boolean
  /** Whether this call minted the id rather than reading it back. */
  created: boolean
}

export function readOrCreateInstallId(configPath: string, generate: () => string = randomUUID): InstallIdResult {
  let text: string | null
  try {
    text = readFileSync(configPath, 'utf-8')
  } catch (error) {
    // No file is the ordinary first launch. Any OTHER read failure (a
    // permissions problem, a locked file) means there may well be an id we
    // simply cannot see right now — so answer for this session and leave the
    // file alone rather than overwrite it with a second id.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { id: generate(), persisted: false, created: true }
    }
    text = null
  }

  let stored: Record<string, unknown> = {}
  if (text !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    // A config.json that does not parse is the user's file, not ours: it holds
    // their Semantic Scholar and NCBI keys, and config.ts already refuses to
    // crash on it. Writing an id over it would destroy those keys to save a
    // quota bucket. The id is session-only until the file is readable again.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { id: generate(), persisted: false, created: true }
    }
    stored = parsed as Record<string, unknown>
    const existing = stored[INSTALL_ID_FIELD]
    if (isInstallId(existing)) return { id: existing, persisted: true, created: false }
  }

  const id = generate()
  const next = JSON.stringify({ ...stored, [INSTALL_ID_FIELD]: id }, null, 2)
  return { id, persisted: writeReplacing(configPath, next), created: true }
}

/**
 * Write-then-rename, so a crash mid-write cannot leave half a config.json —
 * which would cost the user their API keys AND, by the rule above, their id.
 * Falls back to a plain write where the rename is refused (Windows can refuse
 * one while another process holds the target open).
 */
function writeReplacing(path: string, contents: string): boolean {
  const temp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temp, contents)
    renameSync(temp, path)
    return true
  } catch {
    try {
      rmSync(temp, { force: true })
      writeFileSync(path, contents)
      return true
    } catch {
      return false
    }
  }
}
