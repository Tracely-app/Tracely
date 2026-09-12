/**
 * Removes the native binaries belonging to platforms this build is NOT for.
 *
 * `onnxruntime-node` and `sharp` ship one prebuilt per platform, and npm
 * installs several of them. electron-builder then packages whatever is in
 * `node_modules`, so a Windows installer ends up carrying macOS `.dylib`s —
 * which `scripts/verify-packaged-ml.mjs` rejects in `afterPack`, with the
 * installer already half-built:
 *
 *     FAIL  onnxruntime-node/bin/napi-v6/darwin is in app.asar — wrong platform
 *     ⨯ ML packaging check failed — The installer was NOT built.
 *
 * That check is right and stays. This is the other half: stop producing the
 * state it catches.
 *
 * ── Why this exists as a script rather than a line in the workflow ─────────
 * It WAS a line in the workflow — `preview.yml` stripped these before building
 * and nothing else did, so CI previews succeeded while every LOCAL `npm run
 * ship` failed at `afterPack`. One list, invoked from each build, is what stops
 * the two paths disagreeing again. Owner, 2026-09-12, after a stable ship died
 * here: *"add the strip step"*.
 *
 * ── IT STRIPS BY TARGET PLATFORM, and that is load-bearing ────────────────
 * `.github/workflows/mac-installers.yml` builds the arm64 AND x64 dmgs on a Mac
 * runner and **needs** the darwin binaries — its own header says `--mac --x64`
 * requires the darwin-x64 set. A blanket "delete darwin" would fix the Windows
 * ship by breaking every Mac release. So the platform to KEEP defaults to
 * `process.platform`: on a Windows runner that strips darwin and linux, on a
 * Mac runner it strips win32 and linux and keeps both darwin arches.
 *
 * ── Anything it cannot classify, it keeps ─────────────────────────────────
 * `@img/colour` is platform-neutral and carries no platform token. A rule that
 * deleted what it did not recognise would eventually delete something real, so
 * the default is always to leave a package alone.
 *
 * Idempotent: running it twice removes nothing the second time, which is what
 * lets a workflow step and an npm script both call it safely.
 *
 * Usage:  node scripts/strip-foreign-natives.mjs [--keep <platform>]
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = join(REPO_ROOT, 'node_modules')

const keepIndex = process.argv.indexOf('--keep')
const KEEP = keepIndex === -1 ? process.platform : process.argv[keepIndex + 1]

/**
 * Platform tokens as they appear in package names, mapped to `process.platform`
 * values. `linuxmusl` is the Alpine build of sharp and is still linux — without
 * this line a linux build would strip its own binaries.
 */
const PLATFORM_OF = {
  darwin: 'darwin',
  linux: 'linux',
  linuxmusl: 'linux',
  win32: 'win32',
  wasm32: null // neutral fallback build; never strip it
}

/**
 * The binary we are BUILDING with has to be there BEFORE anything is deleted.
 *
 * This ran after the strip in its first version, which made it a correct
 * diagnosis of a tree it had already destroyed: `--keep darwin` on a Windows
 * checkout removed win32, then reported that darwin was missing. Refusing up
 * front means a wrong `--keep` costs nothing.
 *
 * Loud rather than silent, because the alternative is an installer with no
 * native onnxruntime — the degradation `verify-packaged-ml.mjs` exists to
 * prevent, reached from the other direction.
 */
const onnxRoot = join(MODULES, 'onnxruntime-node')
const keptOnnx = join(onnxRoot, 'bin', 'napi-v6', KEEP)
if (existsSync(onnxRoot) && !existsSync(keptOnnx)) {
  console.error(
    `\nstrip-foreign-natives: no onnxruntime binaries for '${KEEP}'.\n` +
      `  Expected ${keptOnnx}\n` +
      `  Refusing to strip — this build would ship with no native onnxruntime.\n` +
      `  Check the --keep value, or run 'npm install' to restore.\n`
  )
  process.exit(1)
}

const removed = []

function remove(path, label) {
  if (!existsSync(path)) return
  rmSync(path, { recursive: true, force: true })
  removed.push(label)
}

/**
 * onnxruntime-node/bin/napi-v6/<platform> — the directory names are already
 * `process.platform` values, so this is a direct comparison.
 */
function stripOnnxRuntime() {
  const base = join(MODULES, 'onnxruntime-node', 'bin', 'napi-v6')
  if (!existsSync(base)) return
  for (const entry of readdirSync(base)) {
    if (entry !== KEEP) remove(join(base, entry), `onnxruntime-node/bin/napi-v6/${entry}`)
  }
}

/**
 * @img/sharp-<platform>-<arch> and @img/sharp-libvips-<platform>-<arch>.
 * A name that does not match — `colour`, or anything added later — is left
 * alone rather than guessed at.
 */
function stripSharp() {
  const base = join(MODULES, '@img')
  if (!existsSync(base)) return
  for (const entry of readdirSync(base)) {
    const token = /^sharp-(?:libvips-)?([a-z0-9]+)-/.exec(entry)?.[1]
    if (token === undefined) continue
    const platform = PLATFORM_OF[token]
    if (platform == null || platform === KEEP) continue
    remove(join(base, entry), `@img/${entry}`)
  }
}

stripOnnxRuntime()
stripSharp()

console.log(
  removed.length === 0
    ? `  strip-foreign-natives — nothing foreign to remove (keeping ${KEEP})`
    : `  strip-foreign-natives — keeping ${KEEP}, removed ${removed.length}: ${removed.join(', ')}`
)
