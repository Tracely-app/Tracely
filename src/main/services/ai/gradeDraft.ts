import { createHash } from 'crypto'
import type { ServerModel } from '@shared/plan'
import { callServer } from './client'
import { modelForCall } from './modelTier'
import { getCached, setCached } from '../storage/cacheRepo'
import { MAX_GRADE_INPUT_CHARS, MAX_GRADE_PARAGRAPHS } from './costGuard'
import { buildGradePrompt, verifyGrade, type VerifiedGrade } from '@shared/gradedDraft'

/**
 * One graded read of the whole draft, from the Tracely server.
 *
 * This replaces a stack of local rules — ten prose detectors, a cohesion pass,
 * an embedding-based tangent check and most of a weakness generator. Owner,
 * 2026-08-19, after two days of false positives: *"if I just gave an essay to
 * ChatGPT and had it graded with a detailed prompt, it would give a pretty good
 * response on what to change."*
 *
 * The rules were covering the easy half of the rubric and producing most of the
 * noise. The half a rule genuinely cannot reach — does this evidence actually
 * support this claim, is this counterargument the strongest one available — was
 * already in a prompt.
 *
 * **The model judges; this side adds up.** Component sub-scores come back and
 * `scoreDraft` sums them, so an unchanged draft scores an unchanged number and
 * every point traces to a quoted sentence.
 *
 * Null on any failure, and null is a supported answer: the caller keeps the
 * local path. A graded read that degrades to the old behaviour beats one that
 * fails the whole analysis because a network call did.
 */

const CACHE_TYPE = 'ai:gradeDraft'

function cacheKey(prompt: string, model: ServerModel): string {
  // Keyed on the assembled prompt, like every other server call here. The
  // v-prefix is the invalidation lever — bump it when the prompt, the rubric or
  // the response schema changes, or a stale grade computed under different
  // instructions will be served forever.
  //
  // v2: grading moved from the relay's `grade-draft` to the server's `grade`,
  // and the model is now in the key. This entry never expires, so without the
  // model a draft graded on Free would show the fast model's grade for as long
  // as the draft is unchanged — an upgrade to Pro would not regrade a single
  // essay the student had already opened, and the "Re-grade" button would
  // keep returning the same free-tier answer. The bump also retires every v1
  // grade, all written by the relay.
  return createHash('sha256').update(`ai:gradeDraft::v2::${model}::${prompt}`).digest('hex')
}

export async function gradeDraft(
  paragraphTexts: string[],
  /**
   * The document the quotes must be found in — offsets are computed against
   * THIS string, so it has to be the text the editor is showing, not the
   * truncated prompt.
   */
  draftText: string
): Promise<VerifiedGrade | null> {
  if (paragraphTexts.length === 0) return null

  const prompt = buildGradePrompt(paragraphTexts, {
    maxParagraphs: MAX_GRADE_PARAGRAPHS,
    maxInputChars: MAX_GRADE_INPUT_CHARS
  })
  if (!prompt) return null

  const model = await modelForCall()
  const key = cacheKey(prompt, model)
  // The cached value is the VERIFIED grade, not the raw response: verification
  // is a pure function of (response, draft), and a prompt that hashes the same
  // came from the same paragraphs. Re-grading an unchanged draft is free, which
  // is what makes an always-available "Re-grade" button honest.
  const cached = getCached<VerifiedGrade>(key)
  if (cached) return cached

  try {
    const raw = await callServer<unknown>('grade', { text: prompt }, { model })
    // Told how many paragraphs the DOCUMENT has, not how many were sent, so
    // paragraphs dropped by the caps come back 'unknown' — the honest label for
    // "never read" — and the vector stays aligned with the document.
    const verified = verifyGrade(raw, draftText, paragraphTexts.length)
    if (!verified) {
      console.warn('[grade] response did not verify')
      return null
    }
    if (verified.dropped.length > 0) {
      // Logged rather than surfaced. A student does not need to know a finding
      // was discarded; whoever is tuning the prompt very much does, and an
      // unfindable quote is the signal that it needs tuning.
      console.warn(
        `[grade] dropped ${verified.dropped.length} finding(s):`,
        verified.dropped.map((d) => `${d.label} — ${d.reason}`).join('; ')
      )
    }
    setCached(key, CACHE_TYPE, verified)
    return verified
  } catch (error) {
    console.warn('[grade] failed, falling back to the local read', error)
    return null
  }
}
