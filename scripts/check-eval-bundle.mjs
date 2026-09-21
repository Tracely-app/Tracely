// Does the eval harness still bundle on plain node — and without Electron?
//
// The server wants a per-user access token, and the obvious way to get one
// is to import services/auth/client. That module reaches Electron for the
// userData path, and scripts/evaluate.mjs runs the harness OUTSIDE Electron:
// bundling it would resolve `electron` to the shim whose export is a path
// string, and app.getPath would be undefined at runtime. The eval would break
// as a side effect of an auth change — and the eval is the quality gate.
//
// So this asserts the property directly rather than trusting that it holds.
// Same esbuild options as scripts/evaluate.mjs; a metafile instead of running.
import { join } from 'path'
import * as esbuild from 'esbuild'

const ROOT = process.argv[2] ?? process.cwd()

const result = await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'main', 'eval', 'harness.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  write: false,
  metafile: true,
  alias: { '@shared': join(ROOT, 'src', 'shared') },
  external: ['sql.js', 'dotenv'],
  define: {
    __API_URL__: '""',
    __SUPABASE_URL__: '""',
    __SUPABASE_ANON_KEY__: '""'
  }
})

const inputs = Object.keys(result.metafile.inputs)
const electron = inputs.filter((f) => /(^|\/)node_modules\/electron\//.test(f))

console.log(`  modules bundled : ${inputs.length}`)
console.log(`  electron in it  : ${electron.length ? 'YES -> ' + electron.join(', ') : 'no'}`)
console.log(`  supabase-js     : ${inputs.some((f) => f.includes('@supabase')) ? 'yes (expected — eval signs in)' : 'no'}`)
console.log(`\n  ${electron.length ? 'FAIL: the eval would break at runtime.' : 'OK: the harness still runs on plain node.'}`)
process.exit(electron.length ? 1 : 0)
