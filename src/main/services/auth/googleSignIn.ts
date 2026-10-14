import { shell } from 'electron'
import type { AuthUser } from '@shared/types'
import { getSupabase, isAuthConfigured, toAuthUser } from './client'
import { LOOPBACK_REDIRECT, listenForCallback } from './loopback'

/**
 * Desktop Google sign-in: the user's own browser, a loopback redirect, and
 * Supabase's PKCE code exchange. See loopback.ts for why each of those.
 *
 * One attempt at a time. A second click while the browser is still open joins
 * the attempt in progress instead of racing it for the port.
 */
let inFlight: Promise<AuthUser> | null = null

export function signInWithGoogle(): Promise<AuthUser> {
  if (!isAuthConfigured()) {
    return Promise.reject(new Error('This build has no Supabase project configured, so it cannot sign anyone in.'))
  }
  inFlight ??= run().finally(() => {
    inFlight = null
  })
  return inFlight
}

async function run(): Promise<AuthUser> {
  const { server, callback } = await listenForCallback()
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: LOOPBACK_REDIRECT,
        // We open the browser ourselves: supabase-js would otherwise try to
        // navigate a window this process does not have.
        skipBrowserRedirect: true,
        // Always show the account chooser. Someone signed into several Google
        // accounts must be able to pick the one the extension uses.
        queryParams: { prompt: 'select_account' }
      }
    })
    if (error || !data?.url) throw new Error(error?.message ?? 'Could not start Google sign-in.')
    await shell.openExternal(data.url)

    const code = await callback
    const exchanged = await supabase.auth.exchangeCodeForSession(code)
    if (exchanged.error || !exchanged.data.session) {
      throw new Error(exchanged.error?.message ?? 'Google sign-in did not produce a session.')
    }
    const user = toAuthUser(exchanged.data.session.user)
    if (!user) throw new Error('Google sign-in did not produce an account.')
    return user
  } finally {
    server.close()
  }
}

/**
 * Sign out of THIS computer only.
 *
 * `scope: 'local'` is load-bearing. supabase-js signs out GLOBALLY by default,
 * which revokes every refresh token the account has — so signing out of the
 * desktop would also sign the same person out of the Chrome extension, on
 * every browser they use. Local ends this session and nothing else.
 */
export async function signOutHere(): Promise<void> {
  if (!isAuthConfigured()) return
  const { error } = await getSupabase().auth.signOut({ scope: 'local' })
  if (error) throw new Error(error.message)
}

/**
 * Re-read the account from Supabase now, rather than when the access token
 * next refreshes (up to an hour). A plan bought on the website is written to
 * the account's app_metadata, and the session only carries what was true when
 * its token was minted — this is what lets "I just paid" take effect at once.
 * The refresh fires AUTH_STATE_CHANGED, which the renderer's plan re-reads on.
 */
export async function refreshAccount(): Promise<void> {
  if (!isAuthConfigured()) return
  const { data } = await getSupabase().auth.getSession()
  if (!data.session) return
  await getSupabase().auth.refreshSession()
}
