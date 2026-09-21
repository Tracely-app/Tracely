import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { appDefines, loadEnv } from './scripts/env.mjs'

// Which .env is read — and therefore which backend this build talks to — is
// decided by TRACELY_ENV in scripts/env.mjs, not here. ship.mjs pins it to
// production and ship-preview.mjs pins it to staging, so neither can be
// influenced by whatever happens to be in the shell.
//
// loadEnv prints the environment it chose. That line is the only place the
// answer appears: these constants are inlined into the main bundle with no
// runtime path back to them, so without it a build aimed at the wrong backend
// looks exactly like a correct one.
loadEnv()

// Baked into the compiled main-process bundle at build time. There is no
// runtime/user-editable path to these values — only whoever runs
// `npm run dist:win` with a given .env controls which server the app talks to
// (TRACELY_API_URL, defaulting to https://api.jointracely.com; see env.mjs).
const { __API_URL__, __SUPABASE_URL__, __SUPABASE_ANON_KEY__ } = appDefines()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __API_URL__,
      __SUPABASE_URL__,
      __SUPABASE_ANON_KEY__
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Second entry rather than a chunk of the main bundle: worker_threads
          // needs a real file on disk to spawn, and services/ml/index.ts
          // resolves it as mlWorker.js beside the main bundle.
          mlWorker: resolve(__dirname, 'src/main/services/ml/worker.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    // Tailwind came in with the Tracer window and left with it: no entry
    // imports a Tailwind stylesheet now, so the plugin has nothing to
    // generate. The three remaining entries (index/floating/overlay) are on
    // the inline-style + styles/index.css idiom, which is what kept
    // Tailwind's preflight reset out of them even while Tracer shipped it.
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          floating: resolve(__dirname, 'src/renderer/floating.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
        }
      }
    }
  }
})
