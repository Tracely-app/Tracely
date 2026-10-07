/**
 * Whether a popover's primary button should offer to INSERT a citation.
 *
 * Decided from the action WORDING rather than from the problem kind, because
 * the kind does not know: `popoverCopyFor` picks the action from the evidence
 * as well, so one kind says "Add citation" on a claim with strong support and
 * "Compare sources" on that same kind once the writer has cited it.
 *
 * Owner, 2026-08-19: *"how come everything pulls up a source… I only want it to
 * appear if it says add citation or something."* Right, and the reason is
 * sharper than clutter. "Compare sources" fires on a claim they ALREADY cited,
 * and "Review the sources" on one where the card has just said the sources do
 * not confirm the claim. A picker whose primary button inserts a citation
 * contradicts the sentence directly above it in the first case, and in the
 * second invites citing a source the card has called insufficient.
 *
 * Both still SHOW what came back, read-only — comparing is the entire point of
 * "Compare sources". What goes is the offer to insert.
 *
 * A leaf with no imports.
 */

/** The two actions that are asking the writer for a citation. */
const INSERTING: ReadonlySet<string> = new Set([
  'Add citation',
  'Find a source',
  // Added 2026-08-19. It was absent, so "Fix the citation" opened the read-only
  // list — a card headed "your citation is broken" with no way to fix it.
  // Owner: *"there is no replace button to replace the citation."*
  'Fix the citation'
])

export function insertsCitation(action: string): boolean {
  return INSERTING.has(action)
}

/**
 * The action on a card whose citation names a work that can be looked up.
 *
 * Added 2026-10-06. Owner, on "(Genghis Khan and the, 2022)": the card called
 * the citation out *"but it doesnt find citation for me"*. This is the button
 * that does: it shows the records that match what the writer typed, and in the
 * editor replaces the citation with the one they pick.
 */
export const FIND_CITED_WORK = 'Find the cited work'

/** The off-topic card's action. It opens Tracer — it never searched anything. */
export const ASK_TRACER = 'Ask Tracer'

/** The fix card's action: shows what the critique already wrote, calls nothing. */
export const SUGGEST_FIX = 'Suggest fix'

/** Where a card's primary button goes. */
export type PopoverRoute = 'cited-work' | 'insert' | 'read-only' | 'fix' | 'tracer'

/**
 * One dispatch for both surfaces, decided from the ACTION WORDING for the same
 * reason `insertsCitation` is: the card's label and its click must not
 * disagree. They did twice — "Ask Tracer" on the editor opened the read-only
 * source list, and the overlay ignored read-only altogether and offered an
 * Insert under "Compare sources" and "Cite it yourself".
 */
export function popoverRoute(action: string): PopoverRoute {
  if (action === FIND_CITED_WORK) return 'cited-work'
  if (action === ASK_TRACER) return 'tracer'
  if (action === SUGGEST_FIX) return 'fix'
  return insertsCitation(action) ? 'insert' : 'read-only'
}

/** Kinds that are about the citation already in the sentence. */
const ABOUT_THE_CITATION: ReadonlySet<string> = new Set([
  'citation-defect',
  'fabricated-citation',
  'cited-unverified'
])

/**
 * Was this card opened about a citation the sentence ALREADY carries?
 *
 * Then any source the writer picks must go in INSTEAD of that citation, never
 * beside it — appending is how "(Unknown Author, 2025) (Walker, 2004)" ended up
 * in a draft. The editor replaces in place. The overlay cannot (it can only
 * type at the caret through UI Automation), so it offers Copy instead of
 * Insert.
 *
 * `unsupported-by-evidence` counts only on a sentence with its own citation:
 * there the evidence that failed was the work the writer named.
 */
export function aboutTheCitation(kind: string, hasOwnCitation: boolean): boolean {
  return ABOUT_THE_CITATION.has(kind) || (kind === 'unsupported-by-evidence' && hasOwnCitation)
}
