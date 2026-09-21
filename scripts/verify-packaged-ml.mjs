// Proves the packaged build can actually run embeddings offline.
//
// This check exists because the failure it guards against is invisible. When
// the ML stack was excluded from the installer, services/ml/index.ts degraded
// to lexical scoring exactly as designed: no error, no crash, no log a user
// would see — the packaged app just quietly ran the old word-overlap path
// while every measurement in eval/ described the new one. A build can be
// "successful" and ship none of this.
//
// So: load the worker bundle that electron-vite actually emitted, point it at
// the weights electron-builder actually copied, forbid network access, and
// require a real vector back.

import { createRequire } from 'module'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'
import { apiUrl, loadEnv } from './env.mjs'

// afterPack spawns this as a bare node process, so nothing has read .env yet.
// Loading it here is what lets the backend-host check below know which server
// this build is supposed to be talking to — and env.mjs picks .env.staging on
// its own when TRACELY_ENV says so, so a preview build is checked against
// whatever staging names.
loadEnv({ quiet: true })

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
// The REPO's worker bundle, kept only for the "did you run npm run build"
// message below. The worker actually EXERCISED is the packaged one — see
// PACKED_WORKER.
const WORKER = join(REPO, 'out', 'main', 'mlWorker.js')
// electron-builder's afterPack hook passes the app it just packed, which is
// what makes this a gate rather than a report: it runs before the installer is
// built and before anything is published. Defaults to the standard Windows
// output so it can also be run by hand against an existing build.
const RESOURCES = process.argv[2] ?? join(REPO, 'release', 'win-unpacked', 'resources')
// Which platform's binaries this build must carry. afterPack passes it; run
// by hand it defaults to win32, matching the default RESOURCES above.
const PLATFORM = process.argv[3] ?? 'win32'
const MODELS = join(RESOURCES, 'models')
const ASAR = join(RESOURCES, 'app.asar')

function fail(message) {
  console.error(`FAIL  ${message}`)
  process.exit(1)
}

if (!existsSync(WORKER)) fail(`no worker bundle at ${WORKER} — run \`npm run build\` first`)
if (!existsSync(MODELS)) fail(`no bundled models at ${MODELS} — run \`npm run dist:win\` first`)
if (!existsSync(ASAR)) fail(`no app.asar at ${ASAR} — run \`npm run dist:win\` first`)

// Check the archive as well as the weights. The embedding test below resolves
// @huggingface/transformers from the repo's own node_modules, so it would pass
// happily for an installer that shipped none of it — which is exactly the bug
// being guarded against. These assertions read what electron-builder actually
// wrote.
const asar = createRequire(import.meta.url)('@electron/asar')
const packed = asar.listPackage(ASAR).map((path) => path.replace(/\\/g, '/'))
// Plain substring, so a fragment naming a DIRECTORY must end in '/' — see the
// `out/eval/` expectation below for what happens when it does not.
const count = (fragment) => packed.filter((path) => path.includes(fragment)).length

// Per-platform binary expectations. Everything else in the list is
// platform-neutral; these four fragments are what "the right binaries for
// THIS build" means. The list hardcoded win32 while afterPack skipped darwin,
// which is how the first mac dmg packed only the Windows binding.
const RUNTIME = {
  win32: {
    need: 'onnxruntime-node/bin/napi-v6/win32/x64',
    sharp: '@img/sharp-win32-x64',
    forbid: [
      ['onnxruntime-node/bin/napi-v6/win32/arm64', 'wrong architecture'],
      ['onnxruntime-node/bin/napi-v6/darwin', 'wrong platform'],
      ['@img/sharp-darwin', 'wrong platform']
    ]
  },
  darwin: {
    need: 'onnxruntime-node/bin/napi-v6/darwin',
    sharp: '@img/sharp-darwin',
    forbid: [
      ['onnxruntime-node/bin/napi-v6/win32', 'wrong platform'],
      ['@img/sharp-win32', 'wrong platform']
    ]
  }
}[PLATFORM]
if (!RUNTIME) fail(`no packaging expectations defined for platform '${PLATFORM}'`)

// [fragment, must be present?, why it matters]
const EXPECTATIONS = [
  ['@huggingface/transformers/dist', true, 'the library itself'],
  ['@huggingface/jinja', true, 'transitive dependency of transformers'],
  [RUNTIME.need, true, 'the inference runtime for this target'],
  [RUNTIME.sharp, true, 'transformers.node.mjs imports sharp at the top level'],
  ['@huggingface/transformers/.cache', false, '202MB of dev-downloaded weights'],
  ['@huggingface/transformers/src', false, 'TypeScript sources; dist is what runs'],
  ...RUNTIME.forbid.map(([fragment, why]) => [fragment, false, why]),
  ['onnxruntime-node/bin/napi-v6/linux', false, 'wrong platform'],
  ['onnxruntime-web', false, '128MB of browser WASM the node entry never imports'],
  // Trailing slash is load-bearing. As `out/eval` this also matched
  // `out/eval-run.log` — a stray 8KB dev log sitting BESIDE the directory — and
  // then described it with the sentence below, so the build failed for a true
  // reason ("something that should not ship is in the asar") while naming a
  // cause that was not there. v0.3.86 and v0.3.87 were both lost to it, and the
  // diagnosis took far longer than the fix.
  ['out/eval/', false, '114MB of eval harness — dev tooling the app never loads']
]

// The worker must exist as a REAL FILE, not just as an entry in the archive.
// worker_threads reads its entry script in native code that bypasses
// Electron's asar-aware fs patches, so a worker inside app.asar can fail to
// start in the packaged build alone — and when it does, services/ml disables
// itself and retrieval degrades silently to lexical scoring.
const unpackedWorker = join(RESOURCES, 'app.asar.unpacked', 'out', 'main', 'mlWorker.js')
if (!existsSync(unpackedWorker)) {
  fail(`ML worker is not unpacked at ${unpackedWorker} — add out/main/mlWorker.js to asarUnpack`)
}

// EVERY package the worker can reach must be unpacked, and the list is COMPUTED.
//
// app.asar is the wrong place to look for anything the worker imports BY NAME.
// mlWorker.js is unpacked so worker_threads can read it, and Node then resolves
// its bare imports by walking up from app.asar.unpacked — never into the
// archive. A package dutifully present in app.asar is invisible to it.
//
// Hand-listing the packages does not hold. Fixing @huggingface/transformers by
// name produced `Cannot find package 'onnxruntime-common'` on the very next
// run: once the worker lives outside the archive, its whole TRANSITIVE CLOSURE
// has to live there too, and a list maintained by hand is a list that is one
// dependency bump behind. So the closure is derived from the same
// node_modules electron-builder packaged from, and every member is required to
// be unpacked — a new transitive dependency fails the build instead of shipping
// embeddings that silently do not load.
//
// A filesystem assertion rather than another run of the worker, deliberately.
// The embedding test further down resolves from the REPO's node_modules,
// because run from the repo Node walks up past release/win-unpacked and finds
// them — green on the build machine and broken on every user's. This is true or
// false the same way wherever it runs.
const CLOSURE_ROOTS = ['@huggingface/transformers', 'sharp', 'onnxruntime-node']
// 128MB of browser WASM the node entry never imports, and an expectation above
// keeps it out of the archive entirely.
const CLOSURE_SKIP = new Set(['onnxruntime-web'])

/**
 * Every package.json the worker can reach, resolved the way NODE resolves.
 *
 * Walking dependency NAMES from the top-level node_modules is not the same
 * thing and gets a different answer: npm nests a package when versions
 * conflict, so `sharp` requires semver ^7 and gets `sharp/node_modules/semver`
 * while the top level holds an unrelated 6.3.1 that nothing here loads. The
 * name walk demanded the top-level copy, the build failed for a package the
 * worker never asks for, and the one it does ask for was already covered by
 * `sharp/**`.
 *
 * So each dependency is resolved FROM ITS REQUIRER, which is positional in
 * exactly the way Node is, and the result is a set of real paths rather than a
 * set of names.
 */
function findPackage(name, fromPath) {
  // Node's own node_modules walk, done by hand.
  //
  // `createRequire().resolve('<name>/package.json')` cannot be used here and
  // that is not a detail: @huggingface/transformers ships an `exports` map that
  // does not expose ./package.json, so resolve THROWS for the single most
  // important package in this check. The first version caught that and returned
  // — silently skipping transformers and both its @huggingface dependencies,
  // and reporting a confident PASS over a closure with the subject missing from
  // it. A guard that skips what it is guarding is worse than no guard.
  let dir = dirname(fromPath)
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'), 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function closurePaths(entryFile) {
  const found = new Set()
  const visit = (name, fromPath) => {
    const pkgJson = findPackage(name, fromPath)
    // Genuinely absent — an optional dependency npm did not install for this
    // platform. Nothing to assert about it.
    if (!pkgJson) return
    if (found.has(pkgJson)) return
    found.add(pkgJson)
    let deps = {}
    try {
      deps = JSON.parse(readFileSync(pkgJson, 'utf8')).dependencies ?? {}
    } catch {
      // Unreadable package.json. It is still required to be unpacked below,
      // which is the assertion that matters.
    }
    for (const dep of Object.keys(deps)) {
      if (!CLOSURE_SKIP.has(dep)) visit(dep, pkgJson)
    }
  }
  for (const root of CLOSURE_ROOTS) visit(root, entryFile)
  return [...found]
}

const closure = closurePaths(WORKER)
if (closure.length === 0) fail('could not compute the ML dependency closure — is node_modules installed?')
const unpackedRoot = join(RESOURCES, 'app.asar.unpacked')
const missing = closure
  // Each resolved path, relocated to where electron-builder should have put it.
  .map((abs) => ({ abs, at: join(unpackedRoot, relative(REPO, abs)) }))
  .filter(({ at }) => !existsSync(at))
  .map(({ abs }) => relative(REPO, abs).split('\\').join('/').replace(/\/package\.json$/, ''))
if (missing.length > 0) {
  fail(
    `${missing.length} of ${closure.length} ML packages are not unpacked: ${missing.join(', ')}. ` +
      'The worker runs from app.asar.unpacked and cannot resolve into the archive — ' +
      'add them to asarUnpack in electron-builder.yml.'
  )
}
console.log(`PASS  ML dependency closure is unpacked — ${closure.length} packages`)

let bad = 0
for (const [fragment, wanted, why] of EXPECTATIONS) {
  const found = count(fragment)
  const ok = wanted ? found > 0 : found === 0
  if (!ok) {
    bad++
    console.error(
      wanted
        ? `FAIL  ${fragment} is MISSING from app.asar — ${why}`
        : `FAIL  ${fragment} is in app.asar (${found} files) — ${why}`
    )
  }
}
if (bad > 0) fail(`${bad} packaging expectation(s) not met`)
console.log(`PASS  app.asar contents — ${EXPECTATIONS.length} packaging expectations met`)

// One backend per installer, and it must be this build's.
//
// The environment split is enforced at build time by inlining the backend URL
// into the bundle, so a build that also carries some *other* backend's host has
// broken the guarantee. That happened: out/ is not cleaned between environment
// switches, so a staging preview shipped out/eval bundles still pointing at
// folio-relay with the production shared token.
//
// It went unnoticed because the check we were running grepped out/main/index.js
// alone. This one reads the whole archive, which is the only version of the
// question that means anything — the leak was never in the file being checked.
//
// The backend is the Tracely server now, not a relay, and the relay half of
// this check inverts rather than disappears. It used to allow exactly one relay
// host — this build's — and fail on any other. Repointed at the server, that
// allowance would protect nothing (no relay host is expected at all), so ANY
// *relay*.vercel.app host is now a failure: nothing in a current build names
// one, and the likeliest way for one to appear is the very staleness described
// above — an out/ left over from a relay-era build.
const expectedUrl = apiUrl()
// TRACELY_API_URL=none: a build with no server at all. The check that matters
// then is the opposite one — that NO backend host made it into the archive.
if (expectedUrl === '') {
  const packed = readFileSync(ASAR).toString('latin1')
  const foreign = [...new Set(packed.match(/https?:\/\/[a-z0-9.-]*(?:relay[a-z0-9.-]*\.vercel\.app|api\.jointracely\.com)/gi) ?? [])]
  if (foreign.length) fail(`TRACELY_API_URL=none, but app.asar still names ${foreign.join(', ')}`)
  console.log('PASS  no backend in app.asar (TRACELY_API_URL=none — AI is off in this build)')
  process.exit(0)
}
const expectedHost = (() => {
  try {
    return new URL(expectedUrl).host.toLowerCase()
  } catch {
    return ''
  }
})()
if (!expectedHost) fail(`TRACELY_API_URL (${expectedUrl}) is unparseable — cannot tell which server this build should use`)

const archive = readFileSync(ASAR).toString('latin1')
const hostsMatching = (pattern) => [...new Set((archive.match(pattern) ?? []).map((h) => h.toLowerCase()))]

// Deliberately narrow: any *.vercel.app host with "relay" in the name. Broad
// enough to catch both relay projects, narrow enough that an unrelated
// dependency mentioning vercel.app cannot turn a release red for nothing.
const relayHosts = hostsMatching(/[a-z0-9-]*relay[a-z0-9.-]*\.vercel\.app/gi)
if (relayHosts.length > 0) {
  fail(
    `app.asar carries ${relayHosts.length} relay host(s): ${relayHosts.join(', ')}\n` +
      `      This build targets ${expectedHost}, and the relay is retired. Something stale is being\n` +
      `      packaged — try deleting out/ and rebuilding, then check the files globs.`
  )
}

// The same question for the server itself: an API host under jointracely.com
// that is not this build's (a staging server's bundle left in out/ under a
// production build, or the default host under a build aimed elsewhere). The
// bare jointracely.com is not matched — the upgrade link names it on purpose.
const foreignServers = hostsMatching(/[a-z0-9-]*api[a-z0-9-]*\.(?:[a-z0-9-]+\.)*jointracely\.com/gi).filter(
  (host) => host !== expectedHost
)
if (foreignServers.length > 0) {
  fail(
    `app.asar carries ${foreignServers.length} foreign server host(s): ${foreignServers.join(', ')}\n` +
      `      This build targets ${expectedHost}. Something stale is being packaged —\n` +
      `      try deleting out/ and rebuilding, then check the files globs.`
  )
}

// The full URL, not just the host: the define inlines the whole string, so its
// absence means the define did not take — and a bare host could turn up in a
// comment or a dependency without proving anything.
if (!archive.includes(expectedUrl)) {
  fail(`app.asar does not contain ${expectedUrl} at all — the define block did not take`)
}
console.log(`PASS  one backend in app.asar — ${expectedHost}, and no relay host`)

// allowRemote:false is the whole point. It mirrors what index.ts sets when it
// finds a bundled models dir, and it means a missing weight file fails here
// rather than being silently downloaded on a developer machine that has
// network — which would make this check pass for a build that strands every
// real user.
// THE PACKAGED WORKER, not the repo's.
//
// This ran `WORKER` — the copy in out/, where every chunk electron-vite emitted
// sits right beside it — and so it passed for two releases whose packaged
// worker could not start at all. electron-vite code-splits the main bundle, and
// asarUnpack listed the entry without the chunk it imports, so the shipped
// mlWorker.js threw `Cannot find module './chunks/protocol-*.js'` and retrieval
// silently fell back to lexical ranking. A check that loads a different file
// from the one the user runs is not a check.
const PACKED_WORKER = join(RESOURCES, 'app.asar.unpacked', 'out', 'main', 'mlWorker.js')
if (!existsSync(PACKED_WORKER)) {
  fail(
    `no unpacked worker at ${PACKED_WORKER}
` +
      `      asarUnpack must list out/main/mlWorker.js — see electron-builder.yml`
  )
}

// The runtime embed is native and can only run on its OWN platform: a Windows
// onnxruntime_binding.node cannot load on macOS, and vice versa. On a
// cross-build the static checks above (closure unpacked, weights + the right
// platform's binary present, one relay) are everything decidable here — the
// actual embed has to be exercised by a native run of the same commit. Skipping
// it silently would be the invisible-degradation trap this whole script exists
// to prevent, so it is loud, and the worker-file existence check above still
// ran. When target === host (a native build) the embed runs and must pass.
const HOST = process.platform
if (PLATFORM !== HOST) {
  console.log(
    `SKIP  offline embed test — cross-build (host ${HOST} → target ${PLATFORM}); ` +
      `a ${PLATFORM} onnxruntime binding cannot execute on ${HOST}. Run this on ${PLATFORM} to exercise it.`
  )
  process.exit(0)
}

const worker = new Worker(PACKED_WORKER, {
  workerData: { cacheDir: join(RESOURCES, 'unused-cache'), localModelPath: MODELS, allowRemote: false }
})

const timer = setTimeout(() => fail('timed out after 120s loading the bundled model'), 120_000)

worker.on('error', (error) => fail(`worker crashed — ${error.message}`))

worker.on('message', (response) => {
  clearTimeout(timer)

  if (!response.ok) fail(`worker returned an error — ${response.error}`)
  if (response.dim !== 384) fail(`expected 384 dimensions, got ${response.dim}`)
  if (response.data.length !== 2 * 384) fail(`expected 2 vectors, got ${response.data.length / response.dim}`)

  const a = response.data.subarray(0, 384)
  const b = response.data.subarray(384, 768)
  const dot = (x, y) => x.reduce((sum, value, i) => sum + value * y[i], 0)

  // A model that loaded but produced garbage would still return the right
  // shape, so check the vectors mean something: these two sentences are about
  // the same thing and must land far closer than chance.
  const similarity = dot(a, b)
  if (!Number.isFinite(similarity)) fail('embedding contains non-finite values')
  if (similarity < 0.4) fail(`related sentences scored ${similarity.toFixed(3)} — model loaded but output is wrong`)

  console.log(`PASS  bundled model embeds offline — 384 dims, related sentences at ${similarity.toFixed(3)}`)
  worker.terminate()
})

worker.postMessage({
  id: 1,
  op: 'embed',
  texts: [
    'Students who start school later get more sleep.',
    'Delaying school start times increases adolescent sleep duration.'
  ]
})
