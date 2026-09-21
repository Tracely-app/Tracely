import { createHash } from 'crypto'
import type { Claim, CritiqueVerdict, EvidenceItem } from '@shared/types'
import type { ServerModel } from '@shared/plan'
import { getCached, setCached } from '../storage/cacheRepo'
import { callServer } from './client'
import { modelForCall } from './modelTier'
import { normalizeCritique } from './normalizeCritique'
import { checkReferences, citedWorkEvidence, describeReferenceChecks } from '../search/referenceCheck'
import { buildEvidenceSummary, searchedSlots, type CritiqueSource } from '@shared/citedEvidence'
import {
  MAX_CRITIQUE_ABSTRACT_CHARS,
  MAX_CRITIQUE_EVIDENCE_ITEMS,
  MIN_CRITIQUE_EVIDENCE_ITEMS,
  MIN_CRITIQUE_RELEVANCE
} from './costGuard'

export interface CritiqueResult {
  critique: string
  verdict: CritiqueVerdict
  /**
   * The claim's own sentence with ONLY its quantifier, scope or hedge changed,
   * when it is defensible but overstated. Null in every other case.
   *
   * Deliberately narrow. Tracer's prompt forbids writing sentences for the
   * student and that rule is not being relaxed here: narrowing "100%" to
   * "generally" is a correction of accuracy, not composition — it changes what
   * the sentence claims, not how it reads. Anything that adds a fact, a clause
   * or a citation is out of scope, and the relay prompt says so explicitly.
   */
  suggestedRevision: string | null
  /**
   * The corrected reference when a real source is cited in a malformed way.
   *
   * The counterweight to `fabricated`. A student who reversed the author order
   * or mixed MLA with APA has made a formatting mistake, and the single worst
   * thing this product could do is call that an invented source — so the relay
   * is instructed to prefer this outcome whenever it is unsure, and this field
   * is always null when the verdict is `fabricated`.
   */
  citationFix: string | null
  /**
   * Did this critique have the work the writer cited in front of it?
   *
   * Not from the relay — the client already knows, because it is the client
   * that resolves the reference and decides whether it earns slot 1 (see
   * `citedWorkEvidence` and shared/citedEvidence.ts). It is reported because
   * nothing downstream could tell: `weak` reached over the writer's own source
   * and `weak` reached over four topical papers they never cited are the same
   * word, and only the first says anything about their citation.
   *
   * Set OUTSIDE the cache, deliberately. It is a pure function of `citedWork`,
   * which is computed before the cache key and is IN that key — so a cached
   * critique always belongs to the same answer, and recomputing it costs
   * nothing while bumping the cache version would re-pay for every critique in
   * the database.
   */
  citedWorkRead: boolean
}

// Critique is the app's single most expensive call — it runs once per
// claim, on the reasoning model, while detection runs once per document on
// the cheap one. Eight claims means eight of these, so what goes into them
// is where the money is.
//
// Previously: the top 5 evidence items by rank, whatever they were. An eval
// run showed ~2 of 3 retrieved sources are off-topic, so most of that
// spend was paying the expensive model to read a paper about atrial
// fibrillation and conclude it doesn't support a claim about school start
// times. Dropping items that don't clear the relevance floor cuts input
// while *improving* the critique, because the model stops splitting its
// attention across noise — the one case where cheaper and better point the
// same way.
//
// The floor is only applied while at least MIN_KEPT items survive it: a
// claim whose retrieval failed entirely still needs a critique that says
// so, and "no supporting evidence was found" is a different (and less
// useful) message than "here are the two closest things we found".
// Relevant items FIRST, then the rest as padding — not "the filtered list, or
// else the raw list". The raw list is ordered by rank, so the old fallback
// (`relevant.length >= MIN ? relevant : evidence`) then took the first four by
// rank: a claim with exactly one relevant source sitting at rank 5 had that
// source dropped and four off-topic ones sent in its place. The one case the
// fallback exists for is the one case it broke.
//
// `slots` is what the cited source takes one of when the sentence named a work
// the lookup found — see shared/citedEvidence.ts. Passing it in rather than
// reading the constant directly is what keeps the cost of reading a citation at
// zero: the list does not grow, its last searched item is displaced.
function selectCritiqueEvidence(evidence: EvidenceItem[], slots = MAX_CRITIQUE_EVIDENCE_ITEMS): EvidenceItem[] {
  const relevant = evidence.filter((e) => e.relevanceScore >= MIN_CRITIQUE_RELEVANCE)
  if (relevant.length >= MIN_CRITIQUE_EVIDENCE_ITEMS) return relevant.slice(0, slots)

  const padding = evidence.filter((e) => e.relevanceScore < MIN_CRITIQUE_RELEVANCE)
  return [...relevant, ...padding].slice(0, slots)
}

function cacheKey(
  claim: Claim,
  evidence: EvidenceItem[],
  referenceCheck: string | null,
  citedWork: CritiqueSource | null,
  model: ServerModel
): string {
  // Keyed on the evidence actually sent, not the first N of the raw list —
  // otherwise two different evidence sets that happen to share their first
  // few entries would collide on one cached critique.
  // The abstract is part of the budget now (see searchedSlots), so it is part
  // of the key: the same claim critiqued once before its citation resolved and
  // once after sends different evidence and must not share a cached verdict.
  const evidenceIds = selectCritiqueEvidence(
    evidence,
    searchedSlots(citedWork !== null, MAX_CRITIQUE_EVIDENCE_ITEMS, citedWork?.abstract != null)
  )
    .map((e) => e.source.id)
    .sort()
    .join(',')
  // v6: keyed on the claim's TEXT and score — the actual request body — rather
  // than `claim.id`.
  //
  // The id looked equivalent and was not. Screen Watch synthesizes its claims
  // in memory with a fresh randomUUID() on every detection (see
  // synthesizeClaim), so an id-keyed entry could never be hit there: editing a
  // paragraph and having the same sentence re-detected paid a fresh call on the
  // reasoning model — the most expensive call in the product — for input the
  // relay had already answered. The in-app path had a weaker version of the
  // same problem, since re-analyzing a document mints new claim rows too.
  //
  // strengthScore is in the key because it is in the request body. It usually
  // moves with the evidence set, but not always: the same sources rescored (ML
  // on vs off) is a different question with the same evidenceIds.
  // v7: the response gained `suggestedRevision` and `citationFix`. Every v6
  // entry was written by a relay that could not produce either, so reusing them
  // would silently withhold the new output from exactly the claims a user has
  // already looked at — the ones most likely to be looked at again.
  // v8: the request gained `referenceCheck`. It is IN the key rather than
  // merely bumping the version, because it can differ between two runs of the
  // same claim over the same evidence — Crossref is a live index and the
  // check can time out — and a critique reasoned over "no work by these authors
  // was found" must not be served for a request that says the opposite.
  // v9: the cited work now occupies slot 1 of the evidence list when a
  // reference resolved. It is IN the key rather than merely bumping the
  // version, for the same reason `referenceCheck` is: whether Crossref answered,
  // and whether OpenAlex had an abstract for what it returned, can differ
  // between two runs of an unchanged claim over an unchanged evidence set — and
  // a critique reasoned over the writer's own source must not be served for a
  // request that never saw it, nor the reverse.
  const cited = citedWork ? `${citedWork.title}|${citedWork.year ?? ''}|${citedWork.abstract ? 'abs' : 'noabs'}` : 'none'
  // v10: the searched sources moved under a heading marking them as NOT cited
  // by the writer, and the relay's Pass 2.5 became a stop rather than a
  // priority. Neither is visible in `evidenceIds` — the key is built from the
  // set of source ids, not from the rendered summary — so without this bump
  // every claim already critiqued kept returning its v9 answer, written by the
  // old prompt over the old flat list. The symptom was the exact behaviour that
  // change existed to remove: "7 of 10 other articles do not support this",
  // still being reported after the fix shipped.
  //
  // The lesson for the next change here: this key must be bumped whenever the
  // REQUEST BODY or the relay PROMPT changes, not only when the response shape
  // does. A cached critique is an answer to a question that is no longer being
  // asked.
  // v11: critique moved from the relay to the Tracely server, and the request
  // body gained `model`. By v10's own rule that is a bump, and the model goes
  // IN the key rather than merely bumping the version, because it changes with
  // the account rather than with the code: the relay chose its reasoning model
  // from its own environment for everyone, while the server runs whatever the
  // plan resolves to. Without it, a claim critiqued on Free keeps its fast-
  // model verdict after an upgrade to Pro — on the reasoning-heavy call where
  // the paid model's difference is the whole point of paying. Every v10 entry
  // was written by the relay — the same prompt text, ported verbatim, but a
  // different model behind a different API — so none of them is reused either.
  const normalizedText = claim.text.trim().replace(/\s+/g, ' ').toLowerCase()
  return createHash('sha256')
    .update(
      `ai:critique::v11::${model}::${normalizedText}::${claim.strengthScore ?? 'null'}::${evidenceIds}::${referenceCheck ?? 'none'}::${cited}`
    )
    .digest('hex')
}

/**
 * @param sentence The claim's SURROUNDING sentence, when the caller has the
 *   document. A detected claim is a sub-span that stops at the end of the
 *   assertion, so a trailing "(Minges & Redeker, 2016)" is not inside
 *   `claim.text` — the reference check would never see the citation it exists
 *   to look up. Omitted, the check falls back to the claim text, which still
 *   covers narrative citations ("Ramirez and Doyle (2024) found …") since those
 *   sit at the front.
 * @param document The whole draft, when the caller has it. Numbered "[3]" and
 *   MLA "(Shoup 45)" citations name nobody and no year in the sentence — the
 *   reference lives in a list at the end — so the check needs the document to
 *   resolve them, and without it an IEEE or MLA draft gets no fabrication check
 *   at all.
 */
export async function generateCritique(
  claim: Claim,
  evidence: EvidenceItem[],
  sentence?: string,
  document?: string
): Promise<CritiqueResult> {
  // Looked up before the cache key is built, because the answer is part of the
  // question — the same claim and evidence with a corroborated reference and
  // with an uncorroborated one are two different critiques.
  const references = await checkReferences(sentence ?? claim.text, document)
  const referenceCheck = describeReferenceChecks(references)

  // The source the writer actually pointed at, when they pointed at one that
  // exists. Checking a cited claim against a topical search while never looking
  // at the citation is the failure this closes — see shared/citedEvidence.ts.
  // Null costs nothing: no corroborated reference means no extra request.
  const citedWork = await citedWorkEvidence(references)

  const model = await modelForCall()
  const key = cacheKey(claim, evidence, referenceCheck, citedWork, model)

  const cached = getCached<CritiqueResult>(key)
  if (cached) return { ...cached, citedWorkRead: citedWork !== null }

  const topEvidence = selectCritiqueEvidence(
    evidence,
    searchedSlots(citedWork !== null, MAX_CRITIQUE_EVIDENCE_ITEMS, citedWork?.abstract != null)
  )
  const evidenceSummary = buildEvidenceSummary(
    citedWork,
    topEvidence.map((e) => ({ title: e.source.title, abstract: e.source.abstract })),
    { maxItems: MAX_CRITIQUE_EVIDENCE_ITEMS, maxAbstractChars: MAX_CRITIQUE_ABSTRACT_CHARS }
  )

  const raw = await callServer<CritiqueResult>(
    'critique',
    {
      claimText: claim.text,
      strengthScore: claim.strengthScore,
      evidenceSummary,
      // Omitted rather than sent empty when there was nothing to look up. The
      // prompt's Pass 2(c) keys on this line being PRESENT and negative; a line
      // saying "no references checked" would read to the model as a result, and
      // the references this cannot check (a single author, an institution, a
      // quoted title) are exactly the ones where absence means nothing.
      ...(referenceCheck ? { referenceCheck } : {})
    },
    { model }
  )

  // `referenceCheck` is null exactly when nothing was searched — the same
  // condition that makes the prompt's Pass 2(c) unavailable. Passing it here is
  // what turns that from an instruction the model may ignore into a rule it
  // cannot. See CritiqueFacts.referenceLookupRan.
  const result = normalizeCritique(raw, claim.text, {
    referenceLookupRan: referenceCheck !== null
  })
  setCached(key, 'ai:critique', result)
  return { ...result, citedWorkRead: citedWork !== null }
}
