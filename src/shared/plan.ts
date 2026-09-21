/**
 * Which plan an account is on, and what that entitles it to.
 *
 * Three tiers exist on jointracely.com and the desktop app had no concept of
 * any of them: someone who paid got exactly what someone who did not got. This
 * is the whole vocabulary — the plan, the model tiers it unlocks, and the one
 * function that decides which model a call is allowed to use.
 *
 * **`free` is the answer to every question this module cannot answer.** Signed
 * out, a build with no Supabase project, a metadata field holding something
 * nobody anticipated, a read that threw — all of them land on `free`. The
 * failure mode of guessing high is that an unpaid account quietly spends on the
 * top model; the failure mode of guessing low is a paying user seeing an
 * upgrade prompt they can dismiss by signing in again. Only one of those is
 * recoverable, so nothing here ever fails open.
 *
 * A leaf: no relative value imports, so `npm test` can load it.
 */

export type Plan = 'free' | 'student' | 'pro'

/** Cheapest first. The order IS the entitlement ordering — see planRank. */
export const PLANS = ['free', 'student', 'pro'] as const

export const DEFAULT_PLAN: Plan = 'free'

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value)
}

/**
 * Anything at all, narrowed to a plan.
 *
 * Case and surrounding space are forgiven because the value is written by
 * whatever provisions the subscription rather than by this app; a stored
 * `"Pro "` is the same intent as `"pro"`. Everything else is `free`.
 */
export function normalizePlan(value: unknown): Plan {
  if (typeof value !== 'string') return DEFAULT_PLAN
  const normalized = value.trim().toLowerCase()
  return isPlan(normalized) ? normalized : DEFAULT_PLAN
}

/**
 * The plan a Supabase user carries, read from `app_metadata` ONLY.
 *
 * That is the half of a Supabase user which only the service role can write,
 * so it is the only half a checkout can be trusted to have set.
 *
 * **`user_metadata` is deliberately not consulted, and reading it as a
 * "fallback" was a working free-to-Pro escalation.** The account holder can
 * write it themselves with one request against Supabase's own API:
 *
 *     PUT /auth/v1/user   {"data": {"plan": "pro"}}
 *
 * The earlier version defended the fallback on the grounds that app_metadata
 * still won, so a user could not override a plan the server had set. True, and
 * beside the point: an account that has never been through the webhook has NO
 * app_metadata plan at all — that is every free account — so the fallback was
 * the only field consulted for precisely the people who had not paid.
 *
 * Anything unreadable, absent or unrecognised is `free`. Guessing high spends
 * the top model on an unpaid account; guessing low shows a paying user a
 * prompt they can clear by signing in again.
 */
export function planFromMetadata(appMetadata: unknown): Plan {
  return normalizePlan(readPlanField(appMetadata))
}

function readPlanField(metadata: unknown): unknown {
  if (typeof metadata !== 'object' || metadata === null) return null
  const value = (metadata as Record<string, unknown>).plan
  return value ?? null
}

/**
 * How much model a check, critique or grade is allowed to use.
 *
 * Named for what the reader gets rather than for a model, because the models
 * behind a tier get renamed (twice under the relay alone) while "fast" keeps
 * meaning fast. The UI, the settings row and the plan ceiling all speak tiers;
 * only the request body names a model — see MODEL_FOR_TIER.
 */
export type ModelTier = 'fast' | 'balanced' | 'thorough'

/** Cheapest first, like PLANS. */
export const MODEL_TIERS = ['fast', 'balanced', 'thorough'] as const

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value)
}

/**
 * The model id each tier asks the Tracely server for.
 *
 * A MIRROR of `MODEL_FOR_TIER` in `server/shared/plan.js`, and it has to be
 * one. The server's `clampModel` only knows model ids: handed a tier NAME it
 * does not recognise the value and resolves it down to the cheapest model, so
 * `clampModel('thorough', 'pro')` is the fast model. When the desktop sent its
 * tier as an `x-tracely-model-tier` header to the relay that did not matter —
 * the relay ignored the header and chose from its own environment. The server
 * does read what it is sent, so the translation happens here, before the
 * request, and every paying user would otherwise silently get the cheap model.
 *
 * The id is a REQUEST, not a grant. The server re-derives the plan from the
 * access token and clamps to it, so a tampered id buys nothing — which is also
 * why a Pro user who picked `fast` in Settings gets `fast`: the preference is
 * resolved here, and the server only ever lowers it.
 *
 * Pinned by plan.test.ts against the server's copy.
 */
export const MODEL_FOR_TIER = {
  fast: 'gpt-5.6-luna',
  balanced: 'gpt-5.6-terra',
  thorough: 'gpt-6-astra'
} as const satisfies Record<ModelTier, string>

/** A model id this app may put in a request body. */
export type ServerModel = (typeof MODEL_FOR_TIER)[ModelTier]

/** The best tier each plan may reach. Free never leaves `fast`. */
export const PLAN_MODEL_CEILING: Record<Plan, ModelTier> = {
  free: 'fast',
  student: 'balanced',
  pro: 'thorough'
}

export function planRank(plan: Plan): number {
  return PLANS.indexOf(plan)
}

export function modelTierRank(tier: ModelTier): number {
  return MODEL_TIERS.indexOf(tier)
}

/** Whether a plan may ask for this tier at all — what greys out a UI row. */
export function modelTierUnlocked(tier: ModelTier, plan: Plan): boolean {
  return modelTierRank(tier) <= modelTierRank(PLAN_MODEL_CEILING[plan])
}

/**
 * The tier a call actually runs at: the stored preference, clamped to the plan.
 *
 * `preferred` is deliberately `unknown`. It arrives from a settings row that
 * long outlives the plan that was current when it was written — a cancelled Pro
 * subscription leaves `'thorough'` sitting in SQLite — and a row can also be
 * hand-edited. Narrowing it here rather than at the call site is what makes
 * "a stale preference cannot leak a paid model" a property of the type rather
 * than of every caller remembering.
 *
 * An unreadable preference resolves to the plan's ceiling rather than to
 * `fast`: the result can never exceed the ceiling, so the safe answer and the
 * useful one are the same value.
 */
export function resolveModelTier(preferred: unknown, plan: Plan): ModelTier {
  const ceiling = PLAN_MODEL_CEILING[plan] ?? PLAN_MODEL_CEILING[DEFAULT_PLAN]
  if (!isModelTier(preferred)) return ceiling
  return modelTierRank(preferred) <= modelTierRank(ceiling) ? preferred : ceiling
}

export const PLAN_LABEL: Record<Plan, string> = {
  free: 'Free',
  student: 'Student',
  pro: 'Pro'
}

export const PLAN_PRICE: Record<Plan, string> = {
  free: '$0',
  student: '$4.99/mo',
  pro: '$9.99/mo'
}

/** What each plan gets, in the order the pricing page lists it. */
export const PLAN_INCLUDES: Record<Plan, readonly string[]> = {
  free: ['The fast model', '5 source searches a day'],
  student: ['Unlimited checks and sources', 'A smarter model'],
  pro: ['Everything in Student', 'The most thorough model']
}

export const MODEL_TIER_LABEL: Record<ModelTier, string> = {
  fast: 'Fast',
  balanced: 'Smarter',
  thorough: 'Most thorough'
}

export const MODEL_TIER_DESCRIPTION: Record<ModelTier, string> = {
  fast: 'Quickest answers, on every plan.',
  balanced: 'A stronger model for checks, critique and grading.',
  thorough: 'The most careful read Tracely can give a draft.'
}

/** The plan each tier first becomes available on — what an upgrade prompt names. */
export const MODEL_TIER_REQUIRES: Record<ModelTier, Plan> = {
  fast: 'free',
  balanced: 'student',
  thorough: 'pro'
}

/** Opened in the user's own browser, never in a window of ours. */
export const UPGRADE_URL = 'https://jointracely.com/order'
