import { createHash } from 'crypto'
import type { EvidenceItem } from '@shared/types'
import type { ServerModel } from '@shared/plan'
import { getCached, setCached } from '../storage/cacheRepo'
import { callServer } from './client'
import { modelForCall } from './modelTier'

export interface CorrectionResult {
  contradicted: boolean
  correction: string | null
  reason: string
}

// The client's own ceiling on what it will send, independent of the server's.
// Four is more than enough to establish a contradiction, and every extra
// passage is tokens on the reasoning model.
const MAX_CONTRADICTING_PASSAGES = 4
const MAX_PASSAGE_CHARS = 900

// Long, because unlike a search result this answer does not go stale: the
// claim text and the specific passages are both in the key, so a hit is the
// same question with the same inputs.
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7

function passageFor(item: EvidenceItem): string {
  const { title, abstract } = item.source
  return `${title}${abstract ? `. ${abstract}` : ''}`.slice(0, MAX_PASSAGE_CHARS)
}

function cacheKey(claimText: string, passages: string[], model: ServerModel): string {
  // v2: correction moved from the relay to the Tracely server, and the model
  // is now in the key. The relay picked one model for every account; the
  // server runs the one the plan resolves to, so a rejection the fast model
  // cached on Free must not keep answering "no" for a week after the account
  // upgrades to a model that might confirm it. The bump retires every v1
  // entry, all written by the relay.
  return createHash('sha256')
    .update(`ai:correction::v2::${model}::${claimText}::${passages.join('||')}`)
    .digest('hex')
}

/**
 * Confirms a locally-flagged contradiction and returns the correction, or null
 * when there is nothing to say.
 *
 * Returns null — meaning "say nothing" — in every ambiguous case: no flagged
 * evidence, the server unreachable, the model declining to confirm. That
 * asymmetry is the whole design. A student who is told nothing is where they
 * started; a student told their true sentence is false has been actively
 * misled by a tool they trusted to check facts.
 *
 * This is the only paid call in the correction path. It fires only for claims
 * that already have relevant evidence AND a high-confidence local
 * contradiction flag, which on the labelled essays is a small minority.
 */
export async function generateCorrection(
  claimText: string,
  contradicting: EvidenceItem[]
): Promise<CorrectionResult | null> {
  if (contradicting.length === 0) return null

  const passages = contradicting.slice(0, MAX_CONTRADICTING_PASSAGES).map(passageFor)
  const model = await modelForCall()
  const key = cacheKey(claimText, passages, model)

  const cached = getCached<CorrectionResult>(key)
  if (cached) return cached.contradicted ? cached : null

  try {
    const result = await callServer<CorrectionResult>(
      'correction',
      {
        claimText,
        contradictingPassages: passages
      },
      { model }
    )

    // Cached either way. A rejected flag is exactly as expensive to compute as
    // a confirmed one, and re-asking on every redraw would spend the reasoning
    // model to be told "no" repeatedly.
    setCached(key, 'ai:correction', result, CACHE_TTL_MS)

    return result.contradicted && result.correction ? result : null
  } catch (error) {
    // Never surfaces as an error to the user: a correction that could not be
    // confirmed is indistinguishable, from where they sit, from one that was
    // never warranted.
    console.warn('[correction] server call failed', error)
    return null
  }
}
