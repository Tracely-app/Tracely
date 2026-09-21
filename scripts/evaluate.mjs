#!/usr/bin/env node
// Runs src/main/eval/harness.ts on plain node.
//
// The harness can't be executed directly for three reasons, all of which
// this script handles: it's TypeScript, it imports through the `@shared`
// alias, and services/ai/client.ts reads __API_URL__ which only exists
// because electron.vite.config.ts inlines it at build time. So
// esbuild does one bundle pass with the same alias and the same defines, and
// node runs the result.
//
// Output lands in out/eval/ (gitignored) so node can still resolve sql.js
// and dotenv from the repo's node_modules.
//
// Provider responses are recorded to out/eval/cassettes on the first run and
// replayed for free afterwards (see scripts/eval-http.mjs), so iterating on
// ranking and scoring costs nothing and compares against byte-identical
// inputs. EVAL_REFRESH=1 re-records against live providers.
//
// Usage:
//   npm run evaluate                      # uses eval/essays/
//   npm run evaluate -- --essays path     # a different folder
//   EVAL_SKIP_CRITIQUE=1 npm run evaluate # retrieval + scoring only, no relay critique calls
//   npm run evaluate:smoke                # critique ONLY the claims marked
//                                         # "smoke": true in eval/critique/expected.json.
//                                         # 6 relay calls instead of 20 for a prompt
//                                         # change; the report is stamped so
//                                         # eval:critique will not auto-select it.
//   EVAL_REFRESH=1 npm run evaluate       # ignore recordings, fetch live again
//   EVAL_NO_CASSETTE=1 npm run evaluate   # never record or replay

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import * as esbuild from 'esbuild'
import { announce, installHttpRecorder, report } from './eval-http.mjs'
import { ENV_NAME, apiUrl, appDefines, cassetteDir as cassettesFor, loadEnv } from './env.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ root: repoRoot })

// The eval is pinned to production on purpose.
//
// It measures retrieval and scoring quality against hand labels in
// eval/baseline.md, and those numbers are only comparable across runs if the
// backend behind them never moves. Two environments would silently split the
// baseline into two incomparable halves.
//
// It would also just fail: identity.ts borrows the desktop app's session, and
// supabase-js keys that file by Supabase project ref — so a staging-built eval
// asks the production session file for a key it does not contain, gets nothing,
// omits the Authorization header, and 401s on every paid call while reporting
// nothing about why.
if (ENV_NAME === 'staging' && !process.env.EVAL_ALLOW_STAGING) {
  console.error('Refusing to run: TRACELY_ENV=staging.')
  console.error('')
  console.error('The eval is pinned to production so its numbers stay comparable')
  console.error('against eval/baseline.md, and it borrows the production app\'s')
  console.error('session — which a staging build cannot read.')
  console.error('')
  console.error('Unset TRACELY_ENV, or set EVAL_ALLOW_STAGING=1 if you really mean it')
  console.error('(and sign in to the Tracely Preview app first).')
  process.exit(1)
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index !== -1 ? process.argv[index + 1] : undefined
}

const essayArg = argValue('--essays') ?? 'eval/essays'
const essayDir = isAbsolute(essayArg) ? essayArg : join(repoRoot, essayArg)
const outDir = join(repoRoot, 'eval', 'reports')
// Namespaced by environment for exactly the reason the cassette directory is,
// and it was not — which cost a full run to discover on 2026-08-16.
//
// This scratch profile holds the SQLite `ai:critique` cache, and that cache is
// keyed on the claim text, score, evidence ids and reference lookup: the
// REQUEST. Not on the backend host, because a shipped build has its backend
// URL compiled in and can never talk to a second one. The eval can. So a run
// against staging populated the cache, and the next run — against production,
// deliberately, to test a newly deployed prompt — answered every claim out of
// staging's cache, made zero relay calls, and reported the OLD build's verdicts
// as production's. It looked like a clean free re-run.
const dataDir = join(repoRoot, 'out', 'eval', 'data', ENV_NAME)
const bundlePath = join(repoRoot, 'out', 'eval', 'harness.mjs')
const workerPath = join(repoRoot, 'out', 'eval', 'mlWorker.cjs')

if (!existsSync(essayDir)) {
  console.error(`No essay folder at ${essayDir}`)
  console.error('Create it and drop in .txt/.md files, or pass --essays <dir>.')
  process.exit(1)
}

// Namespaced by environment, and that is load-bearing rather than tidy.
//
// Cassette keys hash the request URL, which includes the server host. Switching
// environment therefore invalidates every server recording at once — but the
// spend guard below decides whether to demand EVAL_ALLOW_SPEND by *counting*
// recordings. A flat directory would still hold the old environment's files, so
// the guard would read "recordings exist, this run is free" and wave through a
// run where every single server call goes live and paid.
const cassetteDir = cassettesFor(join(repoRoot, 'out', 'eval'))
const cassetteMode = process.env.EVAL_NO_CASSETTE ? 'off' : process.env.EVAL_REFRESH ? 'refresh' : 'cassette'

// A first run bills the OpenAI account behind the server — one detect-claims
// call per essay plus one critique per claim — and spends OpenAlex credits at
// 10 per claim. Seven runs in one morning is ~910 of the 1,000 free daily
// credits and a visible line on the bill, which is exactly how this guard came
// to exist. Spending is opt-in per invocation rather than the default.
//
// EVAL_SKIP_CRITIQUE was never the whole story and the old message implied it
// was: detection runs unconditionally and is a paid call too. Said plainly now.
//
// The guard only applies when a run can actually spend. Replaying recorded
// responses costs nothing, so it should not need a flag that trains you to
// type EVAL_ALLOW_SPEND=1 reflexively.
// Counts actual recordings rather than testing for the directory. The recorder
// creates the directory on startup, so a run that recorded nothing — every
// provider erroring, say — would otherwise leave behind an empty folder that
// silently disables this guard for every run after it.
const recordedCount = existsSync(cassetteDir)
  ? readdirSync(cassetteDir).filter((f) => f.endsWith('.json')).length
  : 0
const canSpend = cassetteMode !== 'cassette' || recordedCount === 0
if (canSpend && !process.env.EVAL_ALLOW_SPEND) {
  console.error('Refusing to run: with no recordings yet, this makes paid server calls')
  console.error('and spends OpenAlex credits.')
  console.error('')
  console.error('  Retrieval and scoring only (still pays for detection):')
  console.error('    EVAL_ALLOW_SPEND=1 EVAL_SKIP_CRITIQUE=1 npm run evaluate')
  console.error('')
  console.error('  Full run including critique (most expensive):')
  console.error('    EVAL_ALLOW_SPEND=1 npm run evaluate')
  console.error('')
  console.error('After one run, provider responses are recorded and every re-run is free.')
  console.error('Rebuilding the preview from an existing report costs nothing: npm run preview')
  process.exit(1)
}

// There used to be a hard stop here when RELAY_URL was unset. The server URL
// has a default now (scripts/env.mjs), so there is always somewhere to call —
// which makes the banner loadEnv printed above, `api=<host>`, the thing to read
// before letting a paid run go ahead.

mkdirSync(dirname(bundlePath), { recursive: true })

// The JS API rather than the CLI: define values are JSON strings, and on
// Windows spawning through a .cmd shim strips their quotes before esbuild
// ever sees them ("Invalid define value").
await esbuild.build({
  entryPoints: [join(repoRoot, 'src', 'main', 'eval', 'harness.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundlePath,
  alias: { '@shared': join(repoRoot, 'src', 'shared') },
  // Left external so node loads them from node_modules at runtime —
  // sql.js in particular ships a wasm sidecar that a bundler would break.
  external: ['sql.js', 'dotenv'],
  // services/ml falls back to join(__dirname, ...) when no worker override is
  // set, and __dirname does not exist in an ESM bundle. The override below
  // means that branch is never taken, but a bundle that would throw on an
  // unrelated future edit is not worth saving three lines.
  banner: {
    js: "import{createRequire as __cr}from'module';import{fileURLToPath as __f}from'url';import{dirname as __d}from'path';const require=__cr(import.meta.url);const __filename=__f(import.meta.url);const __dirname=__d(__filename);"
  },
  define: appDefines()
})

// The ML worker, bundled separately because worker_threads spawns a file from
// disk. Without this the harness finds no worker, services/ml disables itself,
// and retrieval silently falls back to word overlap — the harness would then
// report that embeddings changed nothing, which is the one wrong answer this
// measurement must never give.
//
// CJS with a .cjs extension: the repo's package.json declares no "type", and
// the worker reaches @huggingface/transformers through a dynamic import that
// must stay external rather than being bundled.
await esbuild.build({
  entryPoints: [join(repoRoot, 'src', 'main', 'services', 'ml', 'worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: workerPath,
  external: ['@huggingface/transformers']
})

process.env.TRACELY_ML_WORKER = workerPath
process.env.EVAL_REPO_ROOT = repoRoot
process.env.EVAL_DATA_DIR = dataDir
process.env.EVAL_ESSAY_DIR = essayDir
process.env.EVAL_OUT_DIR = outDir

// -- --smoke: critique only the claims a change can plausibly move -----------
//
// A full verification of both suites is 20 relay calls. Five sequential prompt
// changes on 2026-08-16 therefore cost ~60, and every one of those runs was
// justified — two caught regressions I had just introduced. But most of the
// claims in each run could not have moved: they carry no citation, so the
// fabrication rules cannot reach them.
//
// Smoke mode critiques only the claims marked `"smoke": true` in
// eval/critique/expected.json, and skips the rest. Retrieval still runs for
// everything (it is cassetted and free), so the reports stay comparable in
// every respect except which claims carry a critique.
//
// The selection lives in expected.json rather than here on purpose: it is the
// file that already says what each claim is FOR, so a claim's role and its
// membership of the fast set cannot drift apart.
if (process.argv.includes('--smoke')) {
  const expectedPath = join(repoRoot, 'eval', 'critique', 'expected.json')
  const { claims } = JSON.parse(readFileSync(expectedPath, 'utf8'))
  const prefixes = claims.filter((c) => c.claim && c.smoke).map((c) => c.claim)
  if (prefixes.length === 0) {
    console.error(`--smoke: no claims marked "smoke": true in ${expectedPath}`)
    process.exit(1)
  }
  process.env.EVAL_ONLY_CLAIMS = JSON.stringify(prefixes)
  console.log(
    `\n  SMOKE MODE — critiquing ${prefixes.length} marked claim(s); every other claim is\n` +
      `  retrieved and scored but NOT critiqued. The report is stamped so eval:critique\n` +
      `  will not mistake it for a full run.\n`
  )
}

// Patched before the bundle is imported, so the harness and every provider
// under src/ pick it up through the global without knowing it exists.
announce({ cassetteDir, mode: cassetteMode, skipCritique: Boolean(process.env.EVAL_SKIP_CRITIQUE) })
const { stats } = installHttpRecorder({
  cassetteDir,
  mode: cassetteMode,
  apiUrl: apiUrl()
})

try {
  const { main } = await import(pathToFileURL(bundlePath).href)
  await main()
} finally {
  // In a finally block on purpose: a run that dies partway has still spent
  // whatever it spent, and that is exactly when you want to know.
  report(stats)
}
