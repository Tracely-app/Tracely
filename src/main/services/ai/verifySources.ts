import { createHash } from 'crypto'
import type { SourcesVerifyResponse } from '@shared/ipc-contract'
import {
  answerFromCache,
  receiptsCacheKeyMaterial,
  receiptsInOrder,
  settleReceipts,
  verifyRequestBody,
  type CachedReceipts,
  type VerifySourceInput
} from '@shared/sourceReceipts'
import { getCached, setCached } from '../storage/cacheRepo'
import { callServer } from './client'

/**
 * Receipts for the source list a surface is showing: one call to the server's
 * `/api/verify-sources`, which reads each source and judges it with the same
 * verifier the extension's source search runs. See shared/sourceReceipts.ts
 * for the rule and the measurement behind it; that leaf holds every decision
 * here with a wrong answer available — what is sent, what is trusted back,
 * what is cached and for how long, what the fallback is — so `npm test` can
 * reach them. This file is the shell: the cache and the network.
 *
 * WHEN IT RUNS is the callers' half and the whole cost story: only when the
 * writer OPENS a list — the editor's citation flow, or Screen Watch's "Find a
 * source" from a hover card or the grade panel. Never from passive watching:
 * Screen Watch makes no paid call the writer did not click for, and this is a
 * paid call (one AI action on the desktop's own quota; ~0.1-0.4 cent on the
 * fast model).
 *
 * Never throws. Any failure — no server compiled in, the server unreachable,
 * an older server that 404s the route, a quota refusal, a judge that failed —
 * is `unavailable`, and the surface falls back to the list as it was before
 * receipts, saying nothing was checked. A citation flow that stopped working
 * whenever the server did is a regression this does not get to cause.
 */

const CACHE_TYPE = 'ai:verify-sources'

export async function verifySourceList(
  claimText: string,
  sources: VerifySourceInput[]
): Promise<SourcesVerifyResponse> {
  const ids = sources.map((s) => s.id)
  const body = verifyRequestBody(claimText, sources)
  if (body.sources.length === 0) return { status: 'checked', receipts: [] }
  // No sentence to judge against: nothing can be decided, which is not the
  // same as every source failing to back it.
  if (!body.claim) return { status: 'unavailable', reason: 'There is no sentence to check these sources against.' }
  const sentIds = body.sources.map((s) => s.id)
  const key = createHash('sha256').update(receiptsCacheKeyMaterial(body.claim, sentIds)).digest('hex')

  const cached = getCached<CachedReceipts>(key)
  let answer = cached ? answerFromCache(cached) : null
  if (!answer) {
    let settled: ReturnType<typeof settleReceipts>
    try {
      // callServer retries once, and only when no answer came back at all: a
      // second judge call is a second bill for the same list.
      const raw = await callServer<unknown>('verify-sources', body as unknown as Record<string, unknown>)
      settled = settleReceipts({ ok: true, body: raw }, sentIds)
    } catch (error) {
      settled = settleReceipts({ ok: false, reason: error instanceof Error ? error.message : String(error) }, sentIds)
    }
    if (settled.answer.status === 'unavailable') console.warn('[receipts] could not check the source list:', settled.answer.reason)
    setCached(key, CACHE_TYPE, settled.cache, settled.ttlMs)
    answer = settled.answer
  }
  return answer.status === 'checked' ? { status: 'checked', receipts: receiptsInOrder(ids, answer.receipts) } : answer
}
