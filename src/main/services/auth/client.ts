import WebSocket from 'ws'
import { createClient, type Session, type User } from '@supabase/supabase-js'
import { getMainWindow } from '../../windows/mainWindow'
import { IPC_EVENTS } from '@shared/ipc-channels'
import type { AuthUser } from '@shared/types'
import { fileSessionStorage, pruneForeignSessions } from './sessionStore'

// Electron's bundled Node (v20.x as of Electron 32) has no native
// WebSocket global — supabase-js's Realtime client requires one internally
// even though this app never subscribes to realtime channels. Polyfill it
// with `ws` rather than waiting on an Electron/Node upgrade.
if (typeof globalThis.WebSocket === 'undefined') {
  // @ts-expect-error - ws's types don't perfectly match the DOM WebSocket type supabase-js expects, but the runtime behavior is compatible.
  globalThis.WebSocket = WebSocket
}

// Baked in at build time (see the `define` block in electron.vite.config.ts).
// The anon key is not secret — it identifies the project, not a user; real
// access control is enforced by Row-Level Security policies in Supabase.
declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string

let client: ReturnType<typeof createClient> | null = null

export function getSupabase(): ReturnType<typeof createClient> {
  if (client) return client
  if (!__SUPABASE_URL__ || !__SUPABASE_ANON_KEY__) {
    throw new Error('This build has no Supabase project configured. Set SUPABASE_URL/SUPABASE_ANON_KEY and rebuild.')
  }
  // Before the client reads storage, not after: a build that has changed
  // Supabase projects since it last ran (a preview channel repointed at
  // staging, say) otherwise leaves the previous project's session sitting in
  // the same file, unusable and indistinguishable from being signed in.
  pruneForeignSessions(new URL(__SUPABASE_URL__).hostname.split('.')[0])
  client = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__, {
    auth: {
      storage: fileSessionStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false
    }
  })
  client.auth.onAuthStateChange((_event, session) => {
    const win = getMainWindow()
    win?.webContents.send(IPC_EVENTS.AUTH_STATE_CHANGED, toAuthUser(session?.user ?? null))
  })
  return client
}

export function isAuthConfigured(): boolean {
  return Boolean(__SUPABASE_URL__ && __SUPABASE_ANON_KEY__)
}

/**
 * The identity every relay call is billed to — obtained without ever asking
 * the user for anything.
 *
 * There is no sign-in in this app. There is still an ACCOUNT, because the
 * relay refuses a call it cannot attribute (`resolveUser` in the relay's
 * lib/auth.ts fails closed) and because both spend guards are keyed on a user
 * id: the burst limiter and the 150-per-UTC-day free ceiling in the relay's
 * lib/entitlements.ts. Removing the login screen was a product decision;
 * removing the thing those limits count against would have been a billing
 * one, and they are not the same decision.
 *
 * So the app signs itself in anonymously on first launch and keeps that
 * session for the life of the install. A Supabase anonymous user is a real
 * user row with a real JWT — the relay verifies it exactly like any other and
 * needs no change — carrying no email, no password and no name.
 *
 * **The session file is the identity.** `fileSessionStorage` persists it under
 * the user-data dir and supabase-js refreshes it in the background, so an
 * install keeps one account across launches and its daily quota means
 * something. Clearing that file (or a fresh install) yields a new anonymous
 * account with a fresh quota — the same exposure any anonymous tier has, and
 * far narrower than dropping attribution altogether, which would have made the
 * shared installer token the only thing between a script and the OpenAI bill.
 *
 * **Never throws.** Called during startup, where a rejection would take the
 * boot sequence with it. A failure here leaves the app in exactly the state it
 * had when a user simply had not signed in yet: local features work, relay
 * calls answer 401, and `isAuthError` already routes that to a message. It is
 * retried on the next launch.
 *
 * Requires "Allow anonymous sign-ins" to be enabled on the Supabase project.
 * With it off, Supabase refuses and this logs and moves on.
 */
export async function ensureAnonymousSession(): Promise<void> {
  if (!isAuthConfigured()) return
  try {
    const supabase = getSupabase()
    // Ask for the stored session first. This is the ordinary path on every
    // launch after the first, and skipping it would mint a new account — and
    // a new daily allowance — every time the app started.
    const { data } = await supabase.auth.getSession()
    if (data.session) return

    const { error } = await supabase.auth.signInAnonymously()
    if (error) {
      console.error('[auth] anonymous sign-in failed:', error.message)
      return
    }
    console.log('[auth] anonymous session established')
  } catch (err) {
    console.error('[auth] anonymous sign-in threw:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * An anonymous account has no email, no name and no username — there is no
 * sign-up form to have collected them and no provider to have supplied them.
 * The id is the whole of it, and it is the only field anything reads: the
 * renderer uses this to know a session exists at all, and the relay attributes
 * spend by the id inside the JWT rather than by anything sent from here.
 */
export function toAuthUser(user: User | null): AuthUser | null {
  if (!user) return null
  return { id: user.id, email: null, firstName: null, username: null }
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  if (!isAuthConfigured()) return null
  const { data } = await getSupabase().auth.getSession()
  return toAuthUser(data.session?.user ?? null)
}

export type { Session }
