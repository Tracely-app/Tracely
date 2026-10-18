// The desktop's source search (POST /api/find-sources, server/lib/prompts/sources.js)
// as it is, and the one candidate change measured against it (2026-10-17).
//
// `lean` is the current prompt with exactly two edits, each named below, and
// is built FROM the current one by exact replacement, so it can never drift
// from it in any other word. Nothing here is live: the server still sends
// `current`, and changing that is a SHA-pinned prompt edit that needs the
// measurement and both owners (root CLAUDE.md, "Not without the other human").
//
//   1. Step 4 no longer opens every page. The extension's search made the same
//      change on 2026-10-02 (eval/models/FINDINGS.md): each opened page pulls
//      ~8k tokens of page text into the input, and the cost fell 53% and the
//      wait 26% with the same number of dated sources. The desktop then reads
//      the pages itself for the receipts (/api/verify-sources). The searching
//      strategy — several queries, site-restricted ones to archives and
//      institutions — is the quality lever and is untouched.
//   2. Step 6 no longer asks for `claimProblem`, `revisedClaim` or `disputed`:
//      no client reads them (src/main/services/search/webSources.ts uses
//      title, url, publisher, year, kind, authors, supports and note). A
//      genuine dispute still goes in `note`, which the desktop shows.
//
// `searchesRun` and `assertions` stay: the prompt's own notes call them
// forcing functions (the retrieval trail stops answers from memory; the
// decomposition stops a page that carries a quarter of a claim reading as
// support).
import { SOURCE_SEARCH_SYSTEM_PROMPT, SOURCE_SEARCH_SCHEMA } from '../../server/lib/prompts/sources.js'

function replaceOnce(text, from, to, what) {
  const n = text.split(from).length - 1
  if (n !== 1) throw new Error(`find-sources-variants: "${what}" matched ${n} times in the current prompt; it moved, so the variant must be rebuilt`)
  return text.replace(from, to)
}

const STEP4 = `STEP 4 — OPEN EVERY PAGE BEFORE YOU JUDGE IT

A relevant-sounding title is not evidence. Read the page and answer, for each source:
- Which assertion from Step 1 does it actually support?
- Is it reporting this directly, or repeating another source? If it is repeating one, say which in "echoes" and prefer the original.
- Does anything on the page contradict the claim, or say it is disputed?`

const STEP4_LEAN = `STEP 4 — JUDGE FROM THE SEARCH RESULTS. DO NOT OPEN PAGES.

Do not open any page. Tracely reads every page you return afterwards, quotes what it says and drops any that does not hold up, so opening pages here repeats that work. Judge each source from what the search result itself shows:
- Which assertion from Step 1 does the result show it supports? If the result does not show that, leave the source out.
- Is it reporting this directly, or repeating another source? If it is plainly repeating one, say which in "echoes" and prefer the original.
- Does the result show anything that contradicts the claim, or says it is disputed?`

const STEP6 = `STEP 6 — JUDGE THE CLAIM, NOT JUST THE SOURCES

If the sentence is overstated, wrong in a detail, or asserts a causal link the sources only show as a sequence, say so in "claimProblem" and put wording the sources DO support in "revisedClaim". Keep it concise and appropriate for a school essay. If the claim is accurate as written, both are null — do not invent a criticism.

If the underlying facts are genuinely disputed among historians or reporting, set "disputed" and explain in "note". Do not resolve a real dispute by picking a side.`

const STEP6_LEAN = `STEP 6 — SAY SO WHEN IT IS DISPUTED

If the underlying facts are genuinely disputed among historians or reporting, explain in "note". Do not resolve a real dispute by picking a side.`

const SUPPORTS = `It must be true of the page you opened.`
const SUPPORTS_LEAN = `It must be true of what the search result shows.`

let lean = SOURCE_SEARCH_SYSTEM_PROMPT
lean = replaceOnce(lean, STEP4, STEP4_LEAN, 'step 4')
lean = replaceOnce(lean, STEP6, STEP6_LEAN, 'step 6')
lean = replaceOnce(lean, SUPPORTS, SUPPORTS_LEAN, 'supports field')

const { claimProblem: _p, revisedClaim: _r, disputed: _d, ...keptProps } = SOURCE_SEARCH_SCHEMA.schema.properties
const leanSchema = {
  ...SOURCE_SEARCH_SCHEMA.schema,
  properties: keptProps,
  required: SOURCE_SEARCH_SCHEMA.schema.required.filter((k) => !['claimProblem', 'revisedClaim', 'disputed'].includes(k))
}

export const VARIANTS = {
  current: { system: SOURCE_SEARCH_SYSTEM_PROMPT, schema: SOURCE_SEARCH_SCHEMA.schema, name: SOURCE_SEARCH_SCHEMA.name },
  lean: { system: lean, schema: leanSchema, name: SOURCE_SEARCH_SCHEMA.name }
}
