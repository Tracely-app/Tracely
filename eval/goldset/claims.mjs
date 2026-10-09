// The 36 hand-labelled retrieval claims, each with the paragraph it sits in.
//
// The claims come from eval/retrieval/labels/*.json, joined to their August
// reports by eval/retrieval/load.mjs (by claim-text prefix, never by position).
// That join gives the claim text the desktop's detector produced, its search
// query and the essay; the paragraph is read here from eval/essays/.
//
// Both runners read this, so the extension run and the desktop run measure the
// SAME claims under the SAME ids, and a later run on another branch can be
// joined to these baselines by `id`.
import { readFileSync } from 'node:fs'
import { loadLabelled, REPO } from '../retrieval/load.mjs'

const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

/**
 * [{ id, essay, labelFile, labelPrefix, claim, claimType, searchQuery,
 *    paragraph, paragraphIndex, essayText }]
 *
 * `id` is "<essay number>-c<n>", n counting the essay's labelled claims in
 * label order (01-c1 … 09-c3). A paragraph is a run of text between line
 * breaks — the extension's own definition (content.js coveredByLaterCitation).
 */
export function goldClaims() {
  const { rows } = loadLabelled()
  const perEssay = new Map()
  return rows.map((r) => {
    const essayText = readFileSync(`${REPO}/eval/essays/${r.essay}`, 'utf8')
    const paragraphs = essayText.split(/\r?\n+/).map((p) => p.trim()).filter(Boolean)
    const needle = norm(r.claim.text).slice(0, 80)
    let paragraphIndex = paragraphs.findIndex((p) => norm(p).includes(needle))
    if (paragraphIndex === -1) {
      // The detected span is normally verbatim; fall back to the label's own prefix.
      paragraphIndex = paragraphs.findIndex((p) => norm(p).includes(norm(r.labelled.claim)))
    }
    if (paragraphIndex === -1) throw new Error(`${r.essay}: claim not found in any paragraph: ${needle}`)
    const n = (perEssay.get(r.essay) ?? 0) + 1
    perEssay.set(r.essay, n)
    return {
      id: `${r.essay.slice(0, 2)}-c${n}`,
      essay: r.essay,
      labelFile: r.file,
      labelPrefix: r.labelled.claim,
      claim: r.claim.text,
      claimType: r.claim.claimType,
      searchQuery: r.claim.searchQuery,
      paragraph: paragraphs[paragraphIndex],
      paragraphIndex,
      essayText
    }
  })
}

/** `--claims 01-c1,05` → only those ids, or ids starting with a given prefix. */
export function filterClaims(claims, spec) {
  if (!spec) return claims
  const wanted = String(spec).split(',').map((s) => s.trim()).filter(Boolean)
  return claims.filter((c) => wanted.some((w) => c.id === w || c.id.startsWith(w)))
}
