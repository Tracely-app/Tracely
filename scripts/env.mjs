// Which backend is this build talking to?
//
// Every build-time constant the app has — the Tracely server's URL, the
// Supabase URL and anon key — is inlined by electron.vite.config.ts and has no
// runtime representation anywhere. There is no settings field, no about box, nothing to
// read back. So the answer to "is this build pointed at staging or production?"
// is decided entirely here, once, and everything else imports it.
//
// That concentration is deliberate. The same constants used to be re-declared
// in four places (the vite config, evaluate.mjs, timing.mjs,
// check-eval-bundle.mjs); getting one of them wrong produces a build that talks
// to the staging backend with production credentials, or the reverse, and
// looks completely normal while doing it.

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 'staging' only when asked for explicitly. Anything else is production. */
export const ENV_NAME = process.env.TRACELY_ENV === 'staging' ? 'staging' : 'production'

export const ENV_FILE = ENV_NAME === 'staging' ? '.env.staging' : '.env'

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

// https://abcdefgh.supabase.co -> abcdefgh. Enough to tell two projects apart
// in a log line without printing anything sensitive.
const refOf = (url) => hostOf(url).split('.')[0] ?? ''

/**
 * The Tracely server a build talks to when nothing says otherwise.
 *
 * A default rather than a required value, which is the opposite of what
 * RELAY_URL was, and the reason is what each one was protecting against. The
 * relay existed per environment — tracely-relay and tracely-relay-staging —
 * and nothing about a build said which one it wanted, so a missing value had
 * to stop the build. There is one hosted server, and every extension build
 * already talks to it. What a missing value used to produce was an installer
 * with every AI feature dead; what it produces now is an installer pointed at
 * the one place it could have meant.
 *
 * The cost lands on staging. There is no staging server, so a preview build
 * whose .env.staging sets no TRACELY_API_URL talks to production — with
 * staging-project Supabase tokens the production server cannot verify, so it
 * is metered as a signed-out install (free quota, its own install id). That is
 * a preview that works and spends a little of the production app budget, not
 * one that reaches a real user's data. When a staging server exists, set
 * TRACELY_API_URL in .env.staging and the banner stops saying "(default)".
 */
export const DEFAULT_API_URL = 'https://api.jointracely.com'

/**
 * TRACELY_API_URL, or the default. Call loadEnv() first.
 *
 * Blank counts as unset. A CI step that writes `TRACELY_API_URL=${{ secrets.X }}`
 * for a secret nobody created produces exactly that line, and "the empty
 * string is a real value" is how a build ships with its AI switched off and
 * every check still green. Trailing slashes are dropped because the client
 * appends `/api/<endpoint>` and a double slash is a 404 on some proxies.
 */
export function apiUrl() {
  const configured = (process.env.TRACELY_API_URL ?? '').trim().replace(/\/+$/, '')
  return configured || DEFAULT_API_URL
}

/**
 * Loads exactly one env file and returns what it selected.
 *
 * One file, never two. dotenv skips keys already present in process.env, so
 * "load .env then overlay .env.staging" silently keeps the first file's values
 * and gives you a production build wearing a staging label. `override: true`
 * for the same reason at the shell level: a TRACELY_ENV or TRACELY_API_URL left over
 * from an earlier session must not outrank the file being loaded.
 */
export function loadEnv({ root = REPO_ROOT, quiet = false } = {}) {
  const file = join(root, ENV_FILE)

  // Hard failure, not a fallback. Falling back to .env when .env.staging is
  // missing is the single most expensive mistake available here: it would build
  // something labelled "preview", point it at the production backend and the
  // production Supabase project, and publish it to reviewers.
  if (!existsSync(file)) {
    console.error(`\n${ENV_FILE} not found at ${file}`)
    if (ENV_NAME === 'staging') {
      console.error('Staging was requested explicitly, so falling back to .env would')
      console.error('build a "staging" app pointed at production. Refusing.\n')
    }
    process.exit(1)
  }

  dotenv.config({ path: file, override: true })

  const info = {
    name: ENV_NAME,
    file: ENV_FILE,
    apiHost: hostOf(apiUrl()),
    // Printed beside the host because the default and a deliberate override
    // look identical in a log line otherwise, and "which one did I get?" is
    // the question the banner exists to answer.
    apiFromEnv: Boolean((process.env.TRACELY_API_URL ?? '').trim()),
    supabaseRef: refOf(process.env.SUPABASE_URL ?? '')
  }

  if (!quiet) console.log(describeEnv(info))
  return info
}

/**
 * One line naming the environment, printed by every entry point that builds or
 * verifies something.
 *
 * This is the cheapest fix for the design's biggest weakness. Because the
 * constants are compile-time only, a build aimed at the wrong backend is
 * invisible — you would find out when users start getting 401s. A line in the
 * build log turns that from undetectable into obvious.
 */
export function describeEnv(info) {
  const api = `${info.apiHost}${info.apiFromEnv ? '' : ' (default)'}`
  const supabase = info.supabaseRef || '(no SUPABASE_URL)'
  return `  env=${info.name}  file=${info.file}  api=${api}  supabase=${supabase}`
}

/**
 * The three compile-time constants, for anything running esbuild by hand.
 * Call loadEnv() first.
 *
 * Was relayDefines(), with RELAY_URL and RELAY_TOKEN in place of __API_URL__.
 * The token has no successor: it shipped in every installer and identified no
 * one, and the server does not read it.
 */
export function appDefines() {
  return {
    __API_URL__: JSON.stringify(apiUrl()),
    __SUPABASE_URL__: JSON.stringify(process.env.SUPABASE_URL ?? ''),
    __SUPABASE_ANON_KEY__: JSON.stringify(process.env.SUPABASE_ANON_KEY ?? '')
  }
}

/**
 * Recorded HTTP lives under the environment that recorded it.
 *
 * Not cosmetic — it plugs a hole this whole environment split would otherwise
 * open. evaluate.mjs only demands EVAL_ALLOW_SPEND when a run *can* spend, and
 * decides that by counting recordings: once cassettes exist, the flag stops
 * being required. But cassette keys include the API host, so switching
 * environment invalidates every server recording at once — every call goes live
 * and paid, while the guard stays disarmed because the old environment's
 * recordings are still sitting there being counted.
 *
 * Per-environment directories mean the count is of recordings that can actually
 * replay, so the first staging run correctly reads zero and asks for the flag.
 */
export function cassetteDir(outDir) {
  return join(outDir, 'cassettes', ENV_NAME)
}
