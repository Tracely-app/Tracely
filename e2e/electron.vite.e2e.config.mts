import base from '../electron.vite.config'

/**
 * The normal build, with the backend credentials blanked.
 *
 * The e2e test drives the document editor, and the editor sits behind the auth
 * gate whenever Supabase is configured (`gateFor` in `App.tsx` returns 'ready'
 * immediately when it is not). Signing in is not something a test can do —
 * accounts, passwords and a live staging project are all the wrong side of the
 * line for an automated run — so the build under test is one where there is no
 * account to sign into.
 *
 * Done here rather than by adding a third environment to `scripts/env.mjs`.
 * That module exists to make it impossible to build "preview" against
 * production credentials, and it refuses to fall back for exactly that reason;
 * widening it so a test could opt out would put a hole in the thing guarding
 * every release. This config cannot reach a release: nothing but
 * `npm run test:e2e` names it.
 *
 * It also blanks the server URL, which is not incidental — and matters more
 * than it did, because that URL now has a default (api.jointracely.com), so a
 * build that merely forgot to set it can reach production. A test that could
 * reach `callServer` could spend money on a model call, and no test in this
 * repo is allowed to do that without the explicit flags `guard-bash.sh` asks
 * for. Blank here means `isServerConfigured()` is false and every AI call
 * refuses before it sends anything.
 */
const blank = {
  __API_URL__: '""',
  __SUPABASE_URL__: '""',
  __SUPABASE_ANON_KEY__: '""'
}

export default {
  ...base,
  main: {
    ...base.main,
    define: { ...(base.main as { define?: Record<string, string> }).define, ...blank }
  }
}
