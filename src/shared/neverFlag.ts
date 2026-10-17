// "Never flag this" (2026-10-17, the extension's mirrored on the desktop): the
// sentences a writer told Tracely never to flag again, kept in settings
// (`neverFlagSentences`) and honoured on every surface through
// problemKindsFor's `findings.never`. A leaf, so the test runner can load it.
//
// A plain Dismiss stays per session (owner, 2026-10-16); this list is the
// durable one, managed under Settings → Memory.

/** The newest 500 are kept, as the extension keeps them. */
export const NEVER_FLAG_MAX = 500

/**
 * A sentence as the list compares it: whatever its case, spacing, quote marks
 * or end stop. The same rule as the extension's `ignoreKey` (content.js), so
 * one sentence is one entry in both.
 */
export function neverFlagKey(text: string | null | undefined): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[“”"‘’']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?;:,\s]+$/, '')
}

/** The stored list (a JSON array of sentences), read safely: anything else is empty. */
export function neverFlagList(raw: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && neverFlagKey(x) !== '') : []
  } catch {
    return []
  }
}

/** The list with one more sentence, as written; unchanged when it is already there. The newest are kept. */
export function withNeverFlag(list: readonly string[], text: string): string[] {
  const key = neverFlagKey(text)
  if (!key || list.some((x) => neverFlagKey(x) === key)) return [...list]
  return [...list, text.replace(/\s+/g, ' ').trim()].slice(-NEVER_FLAG_MAX)
}

/** The list without one sentence, compared the list's way. */
export function withoutNeverFlag(list: readonly string[], text: string): string[] {
  const key = neverFlagKey(text)
  return list.filter((x) => neverFlagKey(x) !== key)
}

export function neverFlagSet(list: readonly string[]): ReadonlySet<string> {
  return new Set(list.map(neverFlagKey).filter((k) => k !== ''))
}
