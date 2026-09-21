/* Tracely live preview — one command that keeps this machine showing the
 * latest changes the Discord bot makes, with no manual pulling or reloading.
 *
 * What it does, in a loop:
 *   1. runs `npm run dev` (the real app) once, and leaves it running — its
 *      electron-vite HMR reloads the window whenever a file changes;
 *   2. every few seconds, fetches the live-preview branch; when it moved, hard-
 *      resets to it (which changes files → the app hot-reloads) and rebuilds
 *      extension-dev (which bumps DEV-VERSION → the extension hot-reloads).
 *
 * So: bot makes a change → pushes live-preview → this pulls it → both the app
 * and the extension refresh on their own. Load `extension-dev/` unpacked in
 * Chrome once; you never touch it again.
 *
 * This machine is a VIEWER of the branch: a hard reset discards local edits on
 * it by design. Do your own editing somewhere else.
 *
 * Env: LIVE_BRANCH (default "live-preview"), LIVE_POLL_MS (default 4000).
 */
import { spawn, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRANCH = process.env.LIVE_BRANCH || 'live-preview'
const POLL_MS = Number(process.env.LIVE_POLL_MS || 4000)
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

async function git(...args) {
  const { stdout } = await run('git', args, { cwd: REPO })
  return stdout.trim()
}

async function ensureEnv() {
  if (existsSync(join(REPO, '.env'))) return
  console.error(
    '\n[live] No .env found. The dev app needs the Supabase values to run.\n' +
      '       Ask Sam for the .env contents (they are the same values the shipped\n' +
      '       app is built with) and save them as .env in this folder, then rerun.\n'
  )
  process.exit(1)
}

async function rebuildExtension(sha) {
  if (!existsSync(join(REPO, 'extension'))) return
  try {
    await run(process.execPath, [join(REPO, 'scripts', 'live-extension.mjs'), sha], { cwd: REPO })
  } catch (e) {
    console.error('[live] extension-dev rebuild failed:', e.message)
  }
}

async function syncOnce() {
  try {
    await git('fetch', '--quiet', 'origin', BRANCH)
  } catch (e) {
    console.error(`[live] fetch failed (will retry): ${e.message.split('\n')[0]}`)
    return
  }
  let local, remote
  try {
    local = await git('rev-parse', 'HEAD')
    remote = await git('rev-parse', `origin/${BRANCH}`)
  } catch {
    console.error(`[live] branch ${BRANCH} not found on origin yet — waiting for the first bot run`)
    return
  }
  if (local === remote) return

  // A hard reset is destructive, so it is fenced by three checks. All three are
  // no-ops on a real viewer machine (clean tree, on-branch, always strictly
  // behind) and only ever bite when `npm run live` is pointed at a checkout
  // something else is using — e.g. the bridge's own WORKDIR on Sam's Mac, where
  // resetting would delete a Claude run's in-progress edits. Fail-safe: when
  // unsure, skip the update rather than destroy work. (Run this on a separate
  // clone from the bridge — see LIVE-PREVIEW.md.)
  const current = await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')
  if (current !== BRANCH) {
    console.error(`[live] HEAD is on '${current}', not '${BRANCH}' — refusing to reset. Check out ${BRANCH} here.`)
    return
  }
  const dirty = await git('status', '--porcelain').catch(() => 'x')
  if (dirty) {
    console.warn('[live] working tree has uncommitted changes — deferring reset so nothing is lost')
    return
  }
  // Only fast-forward: refuse if this checkout has commits origin doesn't (i.e.
  // HEAD is not an ancestor of origin/BRANCH), which is the mid-edit / diverged case.
  const ff = await run('git', ['merge-base', '--is-ancestor', 'HEAD', `origin/${BRANCH}`], { cwd: REPO }).then(() => true).catch(() => false)
  if (!ff) {
    console.warn('[live] local checkout is ahead of / diverged from origin — refusing to reset backward')
    return
  }
  console.log(`[live] new changes on ${BRANCH} (${local.slice(0, 7)} → ${remote.slice(0, 7)}) — applying`)
  try {
    await git('reset', '--hard', `origin/${BRANCH}`)
  } catch (e) {
    console.error('[live] reset failed:', e.message.split('\n')[0])
    return
  }
  await rebuildExtension(remote.slice(0, 12))
  console.log('[live] applied — app HMR + extension reload should follow within ~2s')
}

async function main() {
  await ensureEnv()

  // Make sure we're ON the branch. This must succeed — syncOnce does hard
  // resets scoped to whatever HEAD points at, so running from the wrong branch
  // would rewrite THAT branch to live-preview's tree. If we can't land on the
  // branch (usually: a dirty checkout refusing the switch), stop rather than
  // reset something we shouldn't.
  try {
    const already = await git('rev-parse', '--abbrev-ref', 'HEAD')
    if (already !== BRANCH) {
      const haveLocal = await git('rev-parse', '--verify', '--quiet', BRANCH).then(() => true).catch(() => false)
      if (haveLocal) await git('checkout', BRANCH)
      else {
        await git('fetch', 'origin', BRANCH)
        await git('checkout', '-b', BRANCH, `origin/${BRANCH}`)
      }
    }
    const landed = await git('rev-parse', '--abbrev-ref', 'HEAD')
    if (landed !== BRANCH) throw new Error(`still on ${landed}`)
  } catch (e) {
    console.error(
      `\n[live] Could not check out '${BRANCH}' (${e.message.split('\n')[0]}).\n` +
        `       This checkout may have uncommitted changes. Commit/stash them, or run\n` +
        `       'npm run live' from a fresh clone (recommended — never the bridge's copy).\n`
    )
    process.exit(1)
  }

  const head = await git('rev-parse', 'HEAD').catch(() => String(Date.now()))
  await rebuildExtension(head.slice(0, 12))

  console.log(`\n  Tracely live preview\n  ────────────────────`)
  console.log(`  branch : ${BRANCH}`)
  console.log(`  app    : starting (electron-vite dev, hot-reloads on change)`)
  console.log(`  ext    : load extension-dev/ unpacked in Chrome once (chrome://extensions → Load unpacked)`)
  console.log(`  polling every ${POLL_MS}ms — Ctrl+C to stop\n`)

  // Start the real app. HMR is its own; we never restart it.
  const dev = spawn(npmCmd, ['run', 'dev'], { cwd: REPO, stdio: 'inherit' })
  dev.on('error', (e) => {
    console.error(`[live] could not start the app dev server: ${e.message}`)
    console.error('       Is Node installed and did `npm install` run in this folder?')
    process.exit(1)
  })
  dev.on('exit', (code) => {
    console.log(`[live] app dev server exited (${code}) — stopping`)
    process.exit(code ?? 0)
  })

  const stop = () => {
    try {
      if (process.platform === 'win32' && dev.pid) {
        // npm spawns a child electron tree; a bare kill() orphans it on Windows.
        spawn('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        dev.kill()
      }
    } catch {}
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  // Poll for branch changes forever.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await syncOnce()
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

main().catch((e) => {
  console.error('[live] fatal:', e)
  process.exit(1)
})
