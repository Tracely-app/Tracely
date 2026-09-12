import WebSocket from 'ws'
import { createClient, type Session, type User } from '@supabase/supabase-js'
import { getMainWindow } from '../../windows/mainWindow'
import { IPC_EVENTS } from '@shared/ipc-channels'
import type { AuthUser } from '@shared/types'
import { oauthRedirectUrlFor } from '@shared/oauthScheme'
import { isPreviewBuild } from '../../appIdentity'
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

// Same injected values ai/client.ts uses for AI calls — redeclared here so
// this module doesn't depend on that one for an unrelated concern (account
// deletion has to go through the relay too, since only it holds the
// service-role key that can actually delete a Supabase auth user).
declare const __RELAY_URL__: string
declare const __RELAY_TOKEN__: string

// The custom protocol Google's OAuth consent screen redirects back into
// (registered in main/index.ts via app.setAsDefaultProtocolClient).
//
// A FUNCTION, not a const, and it must stay one: this module is imported at
// main's top level, and reading `app.getName()` while the module graph is still
// being evaluated is a needless dependency on import order. Called per sign-in
// instead, which is neither hot nor early.
//
// Preview and stable answer on different schemes — see shared/oauthScheme.ts
// for why. Whatever this returns must be on the redirect allowlist of the
// Supabase project this build was compiled against, or the consent screen
// refuses before the browser ever comes back.
export function oauthRedirectUrl(): string {
  return oauthRedirectUrlFor(isPreviewBuild())
}

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
      // The main process has no browser URL bar for Supabase to read a
      // session out of automatically; the OAuth code exchange is done
      // explicitly instead (see handleOAuthRedirect below). That exchange
      // (exchangeCodeForSession) only works with the PKCE flow — the default
      // 'implicit' flow instead redirects back with tokens in a URL
      // fragment (#access_token=...), which never appears as a `code` query
      // param and is what caused "OAuth redirect had no authorization code".
      flowType: 'pkce',
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

// Supabase has no built-in "name" field. Email/password sign-up stores one
// explicitly under user_metadata.first_name (see signUpWithPassword);
// Google sign-in populates given_name/name/full_name itself, so those are
// read as a fallback for OAuth accounts that never went through our
// sign-up form.
function extractFirstName(user: User): string | null {
  const meta = user.user_metadata as Record<string, unknown> | undefined
  const explicit = meta?.first_name
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  const given = meta?.given_name
  if (typeof given === 'string' && given.trim()) return given.trim()
  const full = meta?.full_name ?? meta?.name
  if (typeof full === 'string' && full.trim()) return full.trim().split(/\s+/)[0]
  return null
}

// Every account gets a usable username with zero setup: explicit ones (set
// via updateUsername) win, otherwise it defaults to the account's email —
// which is also exactly what a Google sign-in already has, so "Google
// accounts get their email as a username" falls out of this same fallback
// rather than needing separate provider-specific logic.
function extractUsername(user: User): string | null {
  const meta = user.user_metadata as Record<string, unknown> | undefined
  const explicit = meta?.username
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  return user.email ?? null
}

export function toAuthUser(user: User | null): AuthUser | null {
  if (!user) return null
  return { id: user.id, email: user.email ?? null, firstName: extractFirstName(user), username: extractUsername(user) }
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  if (!isAuthConfigured()) return null
  const { data } = await getSupabase().auth.getSession()
  return toAuthUser(data.session?.user ?? null)
}

export async function signUpWithPassword(
  email: string,
  password: string,
  firstName: string
): Promise<AuthUser | null> {
  const { data, error } = await getSupabase().auth.signUp({
    email,
    password,
    options: { data: { first_name: firstName } }
  })
  if (error) throw new Error(error.message)
  return toAuthUser(data.user)
}

// For accounts that reach this app with no name yet — legacy password
// accounts created before this field existed, or the rare Google account
// with no name on file. Persisted server-side so it only needs to be asked
// once, not every launch.
export async function updateFirstName(firstName: string): Promise<AuthUser | null> {
  const { data, error } = await getSupabase().auth.updateUser({ data: { first_name: firstName } })
  if (error) throw new Error(error.message)
  return toAuthUser(data.user)
}

export async function updateUsername(username: string): Promise<AuthUser | null> {
  const { data, error } = await getSupabase().auth.updateUser({ data: { username } })
  if (error) throw new Error(error.message)
  return toAuthUser(data.user)
}

export async function signInWithPassword(email: string, password: string): Promise<AuthUser | null> {
  const { data, error } = await getSupabase().auth.signInWithPassword({ email, password })
  if (error) throw new Error(error.message)
  return toAuthUser(data.user)
}

export async function signOut(): Promise<void> {
  const { error } = await getSupabase().auth.signOut()
  if (error) throw new Error(error.message)
}

// Permanently deletes the Supabase auth account itself — not just local
// data. The anon key this app ships with can never do that (Supabase admin
// operations require the service-role key, which only the relay holds), so
// this hands the user's own access token to a dedicated relay endpoint that
// verifies it belongs to a real, currently-signed-in user before deleting
// exactly that account. Local session/app data is cleaned up by the caller
// once this resolves (see authHandlers.ts).
export async function deleteAccount(): Promise<void> {
  if (!__RELAY_URL__) {
    throw new Error('This build has no relay configured, so account deletion is unavailable.')
  }
  const { data } = await getSupabase().auth.getSession()
  const accessToken = data.session?.access_token
  if (!accessToken) throw new Error('No active session — sign in again and retry.')

  const response = await fetch(`${__RELAY_URL__}/api/delete-account`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tracely-token': __RELAY_TOKEN__,
      Authorization: `Bearer ${accessToken}`
    }
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string }
    throw new Error(body.error ?? `Account deletion failed (${response.status})`)
  }

  // The account no longer exists server-side, so the sign-out call Supabase
  // would normally make is expected to fail — only the local session file
  // needs clearing at this point, which is what actually drives the UI back
  // to LoginView via the auth-state-changed listener.
  await getSupabase()
    .auth.signOut()
    .catch(() => undefined)
}

// Returns the Google consent-screen URL to open in the system browser
// (electron's shell.openExternal) — Electron apps can't embed a real Google
// OAuth prompt in a BrowserWindow (Google blocks it), so the flow hands off
// to the user's actual default browser and the redirect comes back via a
// custom protocol (<scheme>://auth-callback) handled by main/index.ts.
export async function startGoogleOAuth(): Promise<string> {
  const { data, error } = await getSupabase().auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: oauthRedirectUrl(), skipBrowserRedirect: true }
  })
  if (error) throw new Error(error.message)
  if (!data.url) throw new Error('Supabase did not return an OAuth URL')
  return data.url
}

// Called with the full tracely://auth-callback?code=... URL once Electron
// catches the redirect (see main/index.ts's 'open-url' / second-instance
// handling).
export async function handleOAuthRedirect(url: string): Promise<AuthUser | null> {
  const code = new URL(url).searchParams.get('code')
  if (!code) throw new Error('OAuth redirect had no authorization code')
  const { data, error } = await getSupabase().auth.exchangeCodeForSession(code)
  if (error) throw new Error(error.message)
  return toAuthUser(data.user)
}

export type { Session }
