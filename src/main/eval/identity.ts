// Signs the eval harness in as a real Tracely user.
//
// The relay bills and rate-limits per account and refuses any call it cannot
// attribute, so the harness needs a genuine Supabase access token like the app
// does. It cannot get one the way the app does: scripts/evaluate.mjs runs this
// on plain node, and services/auth/client reaches Electron for the userData
// path, which would put the Electron binary shim in the eval bundle.
//
// So it borrows the session the desktop app already wrote. Nothing new to
// configure and no credentials to keep anywhere: launch Tracely once and it
// creates its own anonymous session (there is no sign-in), which the eval then
// authenticates as. The refresh token in that file is exchanged for a fresh
// access token by supabase-js, exactly as the app does, so a stale file still
// works.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import { DEFAULT_PLAN, planFromMetadata, type Plan } from '@shared/plan'

declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string

// Mirrors Electron's app.getPath('userData'), which is
// %APPDATA%\<productName> on Windows and Application Support on macOS. Only
// these two matter — nobody runs the eval anywhere else.
function userDataDir(appName: string): string | null {
  if (process.platform === 'win32') {
    return process.env.APPDATA ? join(process.env.APPDATA, appName) : null
  }
  if (process.platform === 'darwin') {
    return process.env.HOME ? join(process.env.HOME, 'Library', 'Application Support', appName) : null
  }
  return process.env.HOME ? join(process.env.HOME, '.config', appName) : null
}

// Electron derives userData from package.json's `name`, which is lowercase
// `tracely` — and `tracely-preview` for the preview build, via
// `-c.extraMetadata.name` in the preview:win script. NOT the productName
// ("Tracely", "Tracely Preview").
//
// These were previously capitalised. That worked only because Windows paths are
// case-insensitive, so it was a latent bug that would surface as "no signed-in
// session found" the first time anyone ran the eval on macOS — where the real
// directory is ~/Library/Application Support/tracely and the lookup would miss
// it entirely.
const STABLE_APP = 'tracely'
const PREVIEW_APP = 'tracely-preview'

// The eval is pinned to production (evaluate.mjs refuses TRACELY_ENV=staging),
// so the stable app's session is the one that matches the Supabase project this
// bundle was built against. The preview app is only a fallback for a machine
// that has nothing else installed — and if that session belongs to a different
// project, supabase-js will simply not find its key, which is why the caller
// verifies it actually got a session rather than trusting the file's existence.
function sessionFile(): string | null {
  const preferPreview = process.env.TRACELY_ENV === 'staging'
  const order = preferPreview ? [PREVIEW_APP, STABLE_APP] : [STABLE_APP, PREVIEW_APP]
  for (const name of order) {
    const dir = userDataDir(name)
    if (!dir) continue
    const path = join(dir, 'auth-session.json')
    if (existsSync(path)) return path
  }
  return null
}

// Built once and shared by both providers below. Two clients over one session
// file would each refresh the token independently and write over each other.
let client: ReturnType<typeof createClient> | null = null
let clientBuilt = false

function appSessionClient(): { client: ReturnType<typeof createClient>; path: string } | null {
  if (!__SUPABASE_URL__ || !__SUPABASE_ANON_KEY__) return null
  const path = sessionFile()
  if (!path) return null
  if (clientBuilt) return client ? { client, path } : null
  clientBuilt = true

  // Reads and writes the same JSON blob shape services/auth/sessionStore.ts
  // uses, so a refresh performed here is picked up by the app on next launch
  // rather than silently invalidating the session it is holding.
  const storage = {
    getItem(key: string): string | null {
      try {
        return (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>)[key] ?? null
      } catch {
        return null
      }
    },
    setItem(key: string, value: string): void {
      let all: Record<string, string> = {}
      try {
        all = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>
      } catch {
        /* corrupt or missing — start fresh */
      }
      all[key] = value
      writeFileSync(path, JSON.stringify(all))
    },
    removeItem(): void {
      // Deliberately inert. The eval must never sign the user out of their
      // own app as a side effect of measuring retrieval quality.
    }
  }

  client = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__, {
    auth: { storage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false }
  })
  return { client, path }
}

/**
 * Returns a provider suitable for setAccessTokenProvider, or null when there
 * is no session to borrow — the caller decides how loudly to complain,
 * because a retrieval-only run does not need one.
 */
export function appSessionTokenProvider(): (() => Promise<string | null>) | null {
  const session = appSessionClient()
  if (!session) return null
  const { client, path } = session

  let warned = false
  return async () => {
    const { data } = await client.auth.getSession()
    const token = data.session?.access_token ?? null
    // Say so, once, rather than returning null into a wall of 401s.
    //
    // A session file exists — that is why we got this far — but supabase-js
    // keys it by project ref, so a file written against a different Supabase
    // project yields nothing here and looks identical to being signed out. The
    // harness's own "no session" message never printed in that case, because
    // appSessionTokenProvider had already returned non-null.
    if (!token && !warned) {
      warned = true
      console.warn(
        `\n[eval] Found ${path} but it holds no session for this build's Supabase project.\n` +
          `       It was probably written by a build pointed somewhere else.\n` +
          `       Launch the app once and re-run; paid relay calls will 401 until then.\n`
      )
    }
    return token
  }
}

/**
 * The same borrowed session, read for the account's plan.
 *
 * Registered alongside the token provider so the harness measures the model
 * tier the signed-in account actually gets. Without it `getPlan` answers `free`
 * for want of a provider, and the eval would quietly grade the product at a
 * tier its paying users never see — the same silent-degradation shape as an
 * eval that scores lexical ranking while believing it scored the ML model.
 */
export function appSessionPlanProvider(): (() => Promise<Plan>) | null {
  const session = appSessionClient()
  if (!session) return null
  const { client } = session
  return async () => {
    const { data } = await client.auth.getSession()
    const user = data.session?.user
    if (!user) return DEFAULT_PLAN
    return planFromMetadata(user.app_metadata)
  }
}

export function noSessionMessage(): string {
  return [
    'No Tracely session found. Live relay calls (claim detection, critique)',
    'will come back 401 — launch Tracely once so it creates its anonymous',
    'session, then re-run.',
    'Replaying a recorded cassette is unaffected: it never reaches the network,',
    'so it never needs a token.'
  ].join('\n')
}
