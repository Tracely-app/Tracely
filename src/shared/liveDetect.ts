/**
 * When the editor may detect claims without anyone pressing anything.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Underlines needed a button. `runStructure` was the only relay-touching path
 * in the editor and its own docstring said "Never automatic ... `handleInput`
 * fires on every keystroke" — a correct worry, answered by making the writer
 * ask for the whole reading every time. Owner, 2026-08-21: *"How can we get the
 * underlines to appear immediately, kind of like Grammarly, instead of waiting
 * until we click the 'grade essay' button?"*
 *
 * ── Detection is not grading, and only one of them belongs on the button ───
 * `runStructure` makes TWO relay calls: `detect-claims`, which is what the
 * underlines are made of, and `grade`, which is the essay score. Only the
 * first has anything to do with marks. So detection becomes automatic and
 * grading stays exactly where it is — behind "AI Insights", which is a button
 * that means "grade my essay" and should keep meaning that.
 *
 * ── The bounds are Screen Watch's, because it solved this already ──────────
 * Screen Watch has read other applications' text automatically for months under
 * three guards, and they are the same three here. The names differ only because
 * Screen Watch polls and the editor has real input events, so the "has it been
 * quiet?" part is a debounce timer rather than a comparison against a poll.
 *
 * Re-detecting UNCHANGED text is free — `ai/claimDetection.ts` caches on a hash
 * of the normalized input — so what these bound is the cost of text that has
 * genuinely moved on.
 *
 * A leaf with no imports, so `npm test` can load it.
 */

/**
 * How long the writer has to stop typing before detection runs.
 *
 * Shorter than Screen Watch's 4s STABLE_MS on purpose. That one is fighting the
 * gap between its 1200ms poll and the pause between words; here the input event
 * is exact, so the only thing being waited out is mid-sentence hesitation. 2.5s
 * is past a comma and well short of a reread.
 */
export const DETECT_IDLE_MS = 2500

/**
 * Shortest draft worth a detection call.
 *
 * Below this there is no claim to find, and firing would spend the interval
 * floor below on a sentence fragment — the same trap `screenWatch/firstSight.ts`
 * documents from the other direction.
 */
export const MIN_DETECT_CHARS = 80

/**
 * How much has to change before the text counts as a different draft.
 *
 * Mirrors Screen Watch's MIN_TEXT_DELTA_CHARS (80). Fixing a typo and pausing
 * should not re-read the document to find the same claims plus one corrected
 * word; a sentence-sized delta means detection is triggered by new content.
 * Deletions count, hence the absolute value.
 */
export const MIN_DETECT_DELTA_CHARS = 80

/**
 * Floor between two automatic detections, however much is typed.
 *
 * The idle timer alone bounds nothing: type-pause-type-pause clears it
 * indefinitely, and each pass is a full relay call on the whole document. This
 * is the actual ceiling — at most one automatic detection per 15s per document
 * while someone is actively writing. Screen Watch uses 20s; the editor can
 * afford to be quicker because the writer is looking at it.
 */
export const MIN_DETECT_INTERVAL_MS = 15_000

export interface LiveDetectInput {
  /** The draft as it stands now. */
  text: string
  /** The text the last automatic or manual detection ran on, if any. */
  lastDetectedText: string | null
  /** When that detection started. Null if none has run for this document. */
  lastDetectAt: number | null
  now: number
}

/** Did enough change to be a different draft rather than a corrected one? */
export function hasMeaningfulDelta(text: string, previous: string | null): boolean {
  if (previous === null) return true
  if (text === previous) return false
  return Math.abs(text.length - previous.length) >= MIN_DETECT_DELTA_CHARS
}

/**
 * Whether an automatic detection may run right now.
 *
 * Assumes the caller has already waited DETECT_IDLE_MS — this answers "and is
 * it worth it", not "has the writer stopped". Every branch returns false on the
 * safe side: a detection missed costs a redraw the next pause brings anyway,
 * and a detection taken costs a relay call.
 */
export function shouldDetectNow(input: LiveDetectInput): boolean {
  const text = input.text.trim()
  if (text.length < MIN_DETECT_CHARS) return false
  if (!hasMeaningfulDelta(text, input.lastDetectedText?.trim() ?? null)) return false
  if (input.lastDetectAt !== null && input.now - input.lastDetectAt < MIN_DETECT_INTERVAL_MS) {
    return false
  }
  return true
}
