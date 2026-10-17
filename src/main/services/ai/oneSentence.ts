import { splitSentences } from './sentenceSplit.ts'

/**
 * A suggested revision replaces exactly one sentence with exactly one sentence,
 * or there is none.
 *
 * Owner, 2026-10-13: "make tracely extension and app both not overpower stuff.
 * Like for example right now it shouldnt replace more than one sentence at
 * once". "Apply revision" swaps the claim's whole span for the revision
 * (`replaceClaimText`), and nothing held either to one sentence:
 *   - the critique prompt asks for a narrowed sentence, but a model can write
 *     two;
 *   - a claim's span can run across two sentences when detection names two
 *     indices (`reconstructClaim` keeps the first now) or the splitter merges
 *     two at an abbreviation.
 * A revision that fails either test is dropped. The card keeps its finding and
 * the sentence is the writer's to change. Counted with the splitter the
 * claims come from, so "Dr. Smith" or "U.S." is one sentence here as it is in
 * the document. The extension's twin is content.js `oneSentenceFix`.
 */
export function sentenceCount(text: string): number {
  return splitSentences(text).filter((span) => /\p{L}/u.test(span.text)).length
}

export function oneSentenceRevision(claimText: string, revision: string | null | undefined): string | null {
  if (typeof revision !== 'string' || !revision.trim()) return null
  return sentenceCount(revision) === 1 && sentenceCount(claimText) <= 1 ? revision : null
}
