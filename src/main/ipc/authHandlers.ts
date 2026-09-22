import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { AuthGetPlanResponse, AuthGetThoroughResponse, AuthGetUserResponse } from '@shared/ipc-contract'
import { fetchThoroughAllowance } from '../services/ai/client'
import { getCurrentUser, isAuthConfigured } from '../services/auth/client'
import { getCurrentPlan } from '../services/auth/plan'

/**
 * What is left of auth once there is no sign-in.
 *
 * The app holds an anonymous Supabase session so the relay has an account to
 * attribute spend to (see ensureAnonymousSession), and these two channels are
 * everything the renderer still asks about it. Nothing here can start, end or
 * modify a session — there is no sign-up, sign-in, sign-out, Google OAuth,
 * name, username or delete-account handler any more, and the
 * `AUTH_SIGN_*`/`AUTH_UPDATE_*`/`AUTH_DELETE_ACCOUNT` channel constants that
 * addressed them are unregistered. They stay in shared/ because
 * `src/shared/*` is additive, the same way the `TRACER_*` constants outlived
 * Tracer's removal.
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

  // The Settings meter's numbers (Pro's Thorough allowance). Display only.
  ipcMain.handle(IPC.AUTH_GET_THOROUGH, async (): Promise<AuthGetThoroughResponse> => {
    return { thorough: await fetchThoroughAllowance() }
  })
}
