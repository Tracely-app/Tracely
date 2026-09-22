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
export type ModelTier = 'fast' | 'thorough'

/**
 * Cheapest first, like PLANS.
 *
 * TWO tiers since the plan policy of 2026-09-21, mirroring the server. The
 * fast model (gpt-5.6-luna) was both the most accurate and the cheapest the
 * eval measured, so every check, detection, grade and source search runs on
 * it, on every plan. The old middle tier, `balanced` (gpt-5.6-terra), lost to
 * it on both measured tasks at ~8-10x the cost and is retired — see
 * LEGACY_MODEL_TIER. `thorough` is Pro's largest model, used for critiques
 * while the monthly allowance lasts (the server decides; see
 * server/shared/plan.js modelForRoute).
 */
export const MODEL_TIERS = ['fast', 'thorough'] as const

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value)
}

/**
 * Tier NAMES an earlier build stored in the settings row that no longer
 * exist, and the tier each one means now. A stored `'balanced'` becomes
 * `'fast'`: the tier it asked for is gone, and fast was the more accurate
 * model on every task measured. Own keys only.
 */
export const LEGACY_MODEL_TIER: Readonly<Record<string, ModelTier>> = { balanced: 'fast' }

/** A stored tier with a retired name translated (`'balanced'` → `'fast'`); anything else unchanged. */
export function normalizeModelTier(value: unknown): unknown {
  return typeof value === 'string' && Object.hasOwn(LEGACY_MODEL_TIER, value) ? LEGACY_MODEL_TIER[value] : value
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
  thorough: 'gpt-6-astra'
} as const satisfies Record<ModelTier, string>

/** A model id this app may put in a request body. */
export type ServerModel = (typeof MODEL_FOR_TIER)[ModelTier]

/**
 * The model the server says it ACTUALLY ran, as one of MODEL_FOR_TIER's ids —
 * what a cached answer must be keyed on, rather than the id the call asked for.
 *
 * Since the 2026-09-21 plan policy the server answers a Pro critique on the
 * thorough model only while the monthly allowance lasts, then on the fast
 * one, so the id requested and the id served can differ. Keyed on the request,
 * a fast fallback would sit in the local cache under the thorough key for its
 * whole lifetime and be shown as a Thorough critique after the allowance
 * resets. The API echoes dated snapshots ("gpt-6-astra-2026-08-01"), so a
 * family prefix matches. Anything unrecognised — no model field, a mock, a
 * provider rename — is treated as fast: it can then never be served under the
 * thorough key.
 */
export function servedModel(served: unknown): ServerModel {
  if (typeof served === 'string') {
    for (const id of Object.values(MODEL_FOR_TIER)) {
      if (served === id || served.startsWith(`${id}-`)) return id
    }
  }
  return MODEL_FOR_TIER.fast
}

/** The best tier each plan may reach. Only Pro reaches `thorough`, and the server uses it for critiques only. */
export const PLAN_MODEL_CEILING: Record<Plan, ModelTier> = {
  free: 'fast',
  student: 'fast',
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
 * useful one are the same value. A retired tier name (a stored `'balanced'`)
 * is translated first, so it resolves to `fast` — not to the ceiling.
 */
export function resolveModelTier(preferred: unknown, plan: Plan): ModelTier {
  const ceiling = PLAN_MODEL_CEILING[plan] ?? PLAN_MODEL_CEILING[DEFAULT_PLAN]
  const tier = normalizeModelTier(preferred)
  if (!isModelTier(tier)) return ceiling
  return modelTierRank(tier) <= modelTierRank(ceiling) ? tier : ceiling
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

/** What each plan gets, in the order the pricing page lists it.
 *
 * Every model claim here is one the model eval measured
 * (eval/models/FINDINGS.md): every plan checks with the same model, the most
 * accurate one tested, so plans are sold on their allowances and on Pro's
 * Thorough allowance — never on a "smarter" checker. The numbers are the ones
 * the server meters (server/shared/plan.js SOURCE_LIMITS, FREE_DAILY_CHECKS,
 * FREE_DAILY_AI_CALLS), pinned by server/test/mirror-contracts.test.js. */
export const PLAN_INCLUDES: Record<Plan, readonly string[]> = {
  free: ['The most accurate checker in our tests', '400 checks and 150 AI actions a day', '5 source searches a day (40 a month)'],
  student: ['Everything in Free', 'No daily check or AI-action limit (fair use)', '100 source searches a month'],
  pro: [
    'Everything in Student',
    'Thorough critiques and explanations from our largest model (monthly allowance)',
    '250 source searches a month'
  ]
}

export const MODEL_TIER_LABEL: Record<ModelTier, string> = {
  fast: 'Standard',
  thorough: 'Thorough'
}

export const MODEL_TIER_DESCRIPTION: Record<ModelTier, string> = {
  fast: 'The most accurate fact-checker in our tests. Every check, detection, grade and source search runs on it, on every plan.',
  thorough:
    "Pro: critiques of your cited sources come from our largest model while this month's allowance lasts, then Standard. More thorough explanations, not more accurate verdicts."
}

/** The plan each tier first becomes available on — what an upgrade prompt names. */
export const MODEL_TIER_REQUIRES: Record<ModelTier, Plan> = {
  fast: 'free',
  thorough: 'pro'
}

/** Opened in the user's own browser, never in a window of ours. */
export const UPGRADE_URL = 'https://jointracely.com/order'
