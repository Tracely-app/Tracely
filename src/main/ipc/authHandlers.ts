import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  AuthGetPlanResponse,
  AuthGetUserResponse,
  AuthRefreshResponse,
  AuthSignInWithGoogleResponse,
  AuthSignOutResponse
} from '@shared/ipc-contract'
import { getCurrentUser, isAuthConfigured } from '../services/auth/client'
import { getCurrentPlan } from '../services/auth/plan'
import { refreshAccount, signInWithGoogle, signOutHere } from '../services/auth/googleSignIn'

/**
 * Auth: who is signed in, which plan they are on, and Google sign-in / out.
 *
 * Sign-in came back with the backend unification. The desktop's AI calls go to
 * the Tracely server, which applies the plan of whichever account a call
 * carries; with no sign-in, every desktop user was a free install and a plan
 * bought on the website could never reach this app. Google only — see
 * services/auth/loopback.ts for why not a password, and why a loopback
 * redirect rather than the `tracely://` protocol the first version used.
 *
 * Signing in is OPTIONAL. Signed out, the app works as a free install (the
 * server meters it by the X-Tracely-Install id). Still unregistered, and
 * staying that way: email/password sign-up and sign-in, name and username
 * updates, and delete-account — their channel constants live on in shared/
 * under the additive rule.
 */
export function registerAuthHandlers(): void {
  // Not "who are you" — an anonymous account has no name or email to answer
  // with. It reports whether a session exists at all, which is what tells the
  // renderer an AI call has an identity behind it.
  ipcMain.handle(IPC.AUTH_GET_USER, async (): Promise<AuthGetUserResponse> => {
    if (!isAuthConfigured()) return { user: null, configured: false }
    return { user: await getCurrentUser(), configured: true }
  })

  // Every anonymous account resolves to `free`; there is no signed-in account
  // for a subscription to be attached to. Kept rather than hardcoded because
  // the plan still decides the model tier a relay call runs at, and
  // getCurrentPlan is the one place that decision is made — a renderer that
  // assumed `free` itself would be a second answer able to disagree with it.
  ipcMain.handle(IPC.AUTH_GET_PLAN, async (): Promise<AuthGetPlanResponse> => {
    return { plan: await getCurrentPlan() }
  })

  // Resolves once the browser has come back and a session exists — or rejects
  // with a message written for the person who clicked. The signed-in user also
  // arrives through AUTH_STATE_CHANGED, which is what the plan re-reads on.
  ipcMain.handle(IPC.AUTH_SIGN_IN_WITH_GOOGLE, async (): Promise<AuthSignInWithGoogleResponse> => {
    await signInWithGoogle()
    return { ok: true }
  })

  // This computer only — see signOutHere for why never global.
  ipcMain.handle(IPC.AUTH_SIGN_OUT, async (): Promise<AuthSignOutResponse> => {
    await signOutHere()
    return { ok: true }
  })

  ipcMain.handle(IPC.AUTH_REFRESH, async (): Promise<AuthRefreshResponse> => {
    await refreshAccount()
    return { ok: true }
  })
}
