import { MODEL_FOR_TIER, resolveModelTier, type ModelTier, type ServerModel } from '@shared/plan'
import { getSetting } from '../storage/settingsRepo'
import { getPlan } from './identity'

/**
 * The model tier every server call runs at — checks, critique and grading alike.
 *
 * **This is the enforcement point, and it is main-side on purpose.** The
 * preference is a stored string in SQLite; the plan is what the account has
 * actually paid for. Deciding it in the renderer, or trusting the row on its
 * own, would mean a Pro subscription that lapsed last month still asks for the
 * top model — the row outlives the plan, and nothing rewrites it when a
 * subscription ends. `resolveModelTier` clamps, so the answer can never exceed
 * the plan's ceiling however the preference got there.
 *
 * Every AI call in this app goes through `callServer`, which is why the gate
 * sits one import away from it rather than at each of the six endpoints: a
 * new endpoint is gated by existing, not by remembering.
 */
export async function modelTierForCall(): Promise<ModelTier> {
  return resolveModelTier(getSetting('modelTier'), await getPlan())
}

/**
 * The model id a call sends in its body — the tier above, translated.
 *
 * Exported separately because the cached callers need it BEFORE the call, to
 * put it in their cache key: a critique written by the free model must not be
 * served to the same account after it upgrades to Pro, and the model is the
 * only part of the request that changes when the plan does. A caller that keys
 * on the model passes this same value to `callServer`, so the key and the
 * request cannot disagree even if the plan changes between the two.
 */
export async function modelForCall(): Promise<ServerModel> {
  return MODEL_FOR_TIER[await modelTierForCall()]
}
