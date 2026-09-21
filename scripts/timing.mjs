#!/usr/bin/env node
// Runs src/main/eval/timing.ts, the same way scripts/evaluate.mjs runs the
// harness: one esbuild pass with the @shared alias and the build defines, then
// node executes the bundle.
//
// Costs nothing. It makes no relay calls at all — no detection, no critique —
// and the providers it touches are free (Crossref, PubMed, Wikipedia) or
// answer 429 for nothing (OpenAlex, Semantic Scholar).

import { mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import * as esbuild from 'esbuild'
import { appDefines, loadEnv } from './env.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ root: repoRoot })

const bundlePath = join(repoRoot, 'out', 'eval', 'timing.mjs')
const workerPath = join(repoRoot, 'out', 'eval', 'mlWorker.cjs')
mkdirSync(dirname(bundlePath), { recursive: true })

await esbuild.build({
  entryPoints: [join(repoRoot, 'src', 'main', 'eval', 'timing.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundlePath,
  alias: { '@shared': join(repoRoot, 'src', 'shared') },
  external: ['sql.js', 'dotenv'],
  banner: {
    js: "import{createRequire as __cr}from'module';import{fileURLToPath as __f}from'url';import{dirname as __d}from'path';const require=__cr(import.meta.url);const __filename=__f(import.meta.url);const __dirname=__d(__filename);"
  },
  define: appDefines()
})

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

const { main } = await import(pathToFileURL(bundlePath).href)
await main()
process.exit(0)
