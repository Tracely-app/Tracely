import { randomUUID } from 'crypto'
import type { Claim, ClaimType, CritiqueVerdict, ScoreBreakdown } from '@shared/types'
import { queryAll, queryOne, run, transaction } from './db'
import { rescoreFromBreakdown } from '../search/scoring'
import { oneSentenceRevision } from '../ai/oneSentence'
import { RETRIEVAL_GENERATION } from '@shared/retrievalGeneration'

interface ClaimRow {
  id: string
  analysis_id: string
  text: string
  claim_type: string
  confidence: number
  search_query: string
  strength_score: number | null
  score_breakdown: string | null
  critique: string | null
  critique_verdict: string | null
  suggested_revision: string | null
  citation_fix: string | null
  cited_work_read: number | null
  retrieval_generation: number | null
  created_at: string
}

function toDomain(row: ClaimRow): Claim {
  const breakdown = row.score_breakdown ? (JSON.parse(row.score_breakdown) as ScoreBreakdown) : null
  return {
    id: row.id,
    analysisId: row.analysis_id,
    text: row.text,
    claimType: row.claim_type as ClaimType,
    confidence: row.confidence,
    searchQuery: row.search_query,
    // Re-derived from the stored breakdown rather than read back, so a claim
    // searched under older weights bands the same way a fresh one does. See
    // rescoreFromBreakdown: it is exact, needs no network, and returns null
    // for a claim nobody has searched. Falls back to the stored number when
    // there is no breakdown to derive from — rows that predate the column.
    strengthScore: breakdown ? rescoreFromBreakdown(breakdown) : row.strength_score,
    scoreBreakdown: breakdown,
    critique: row.critique,
    critiqueVerdict: row.critique_verdict as CritiqueVerdict | null,
    // `?? null` rather than a bare read: these columns arrive by migration, and
    // sql.js hands back `undefined` for a column a row predates. `undefined`
    // would then travel to the renderer as a MISSING key, where every check on
    // them is `!== null`.
    // Held to one sentence for one sentence, as a fresh one is (oneSentence.ts):
    // a revision saved before 2026-10-13 may be two.
    suggestedRevision: oneSentenceRevision(row.text, row.suggested_revision),
    citationFix: row.citation_fix ?? null,
    // SQLite has no boolean. `== null` rather than `=== undefined`, so a row
    // that predates the column and a row whose lookup has not run both arrive
    // as null — which problemKind.ts reads as "not read".
    citedWorkRead: row.cited_work_read == null ? null : row.cited_work_read === 1,
    retrievalGeneration: row.retrieval_generation ?? null,
    createdAt: row.created_at
  }
}

export interface NewClaim {
  text: string
  claimType: ClaimType
  confidence: number
  searchQuery: string
}

/**
 * The most recent already-searched claim with exactly this text.
 *
 * Exported for the test, not for callers — `insertClaims` is the only path that
 * should be reaching for this.
 */
export function findSearchedClaimByText(text: string): ClaimRow | null {
  return (
    queryOne<ClaimRow>(
      // `retrieval_generation` as well as a score. A result produced by an
      // older fan-out is not one this build would produce, and inheriting it is
      // how an empty answer outlived the provider that could have filled it —
      // see shared/retrievalGeneration.ts. Old rows are NULL and never match,
      // so they are re-searched once.
      `SELECT * FROM claims
        WHERE text = $text AND strength_score IS NOT NULL
          AND retrieval_generation = $generation
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
      { $text: text, $generation: RETRIEVAL_GENERATION }
    ) ?? null
  )
}

/**
 * Inserts a run's claims, carrying forward what an identical sentence already
 * has behind it.
 *
 * Re-analysing a document makes a NEW analysis with a NEW set of claim rows,
 * and every search result, score and critique stays attached to the OLD ids. So
 * the second time you pressed AI Insights on the same essay, every claim came
 * back with `strength_score = null` — and the editor draws no underline at all
 * for a claim nothing has been searched for (see documentMarks.ts, which is
 * right to: an unsearched claim has no verdict to report). Every underline
 * vanished, on the most ordinary action there is: edit a bit, run it again.
 *
 * Found on Merrick's draft, which had been analysed six times: 48 claim rows,
 * one run of 8 scored, and the newest run — the one on screen — scored none.
 *
 * Matching is on EXACT text. A sentence the writer has since edited is a
 * different claim and must be searched again; only a sentence that survived the
 * edit untouched inherits, which is exactly when the old evidence still applies.
 * The evidence rows are copied too, not just the score: the editor reads its
 * article count from `claim_evidence` by claim id, and a score with no rows
 * beneath it is the same "nothing known" from the renderer's point of view.
 */
export function insertClaims(analysisId: string, claims: NewClaim[]): Claim[] {
  const createdAt = new Date().toISOString()
  // Batched: up to 8 claims per analysis, each of which was its own
  // full-database serialization to disk.
  return transaction(() =>
    claims.map((c) => {
      const id = randomUUID()
      const prior = findSearchedClaimByText(c.text)

      run(
        `INSERT INTO claims (
           id, analysis_id, text, claim_type, confidence, search_query, created_at,
           strength_score, score_breakdown, critique, critique_verdict,
           suggested_revision, citation_fix, cited_work_read, retrieval_generation
         ) VALUES (
           $id, $analysisId, $text, $type, $confidence, $query, $createdAt,
           $score, $breakdown, $critique, $verdict, $revision, $citationFix, $citedWorkRead,
           $generation
         )`,
        {
          $id: id,
          $analysisId: analysisId,
          $text: c.text,
          $type: c.claimType,
          $confidence: c.confidence,
          $query: c.searchQuery,
          $createdAt: createdAt,
          $score: prior?.strength_score ?? null,
          $breakdown: prior?.score_breakdown ?? null,
          $critique: prior?.critique ?? null,
          $verdict: prior?.critique_verdict ?? null,
          $revision: prior?.suggested_revision ?? null,
          $citationFix: prior?.citation_fix ?? null,
          $citedWorkRead: prior?.cited_work_read ?? null,
          // Only ever the CURRENT generation, because `prior` is now only found
          // when it already matches it.
          $generation: prior ? RETRIEVAL_GENERATION : null
        }
      )

      // The rows the score was computed from. Without these the new claim has a
      // number and an empty source list, which reads as "searched, found
      // nothing" — a worse lie than "not searched yet".
      if (prior) {
        run(
          `INSERT INTO claim_evidence (id, claim_id, source_id, relevance_score, rank, created_at, stance, stance_confidence)
           SELECT lower(hex(randomblob(16))), $newId, source_id, relevance_score, rank, created_at, stance, stance_confidence
             FROM claim_evidence WHERE claim_id = $oldId`,
          { $newId: id, $oldId: prior.id }
        )
      }

      return {
        id,
        analysisId,
        text: c.text,
        claimType: c.claimType,
        confidence: c.confidence,
        searchQuery: c.searchQuery,
        strengthScore: prior?.strength_score ?? null,
        scoreBreakdown: prior?.score_breakdown
          ? (JSON.parse(prior.score_breakdown) as ScoreBreakdown)
          : null,
        critique: prior?.critique ?? null,
        critiqueVerdict: (prior?.critique_verdict as CritiqueVerdict | null) ?? null,
        suggestedRevision: prior?.suggested_revision ?? null,
        citationFix: prior?.citation_fix ?? null,
        citedWorkRead: prior?.cited_work_read == null ? null : prior.cited_work_read === 1,
        retrievalGeneration: prior ? RETRIEVAL_GENERATION : null,
        createdAt
      }
    })
  )
}

export function getClaimsByAnalysis(analysisId: string): Claim[] {
  const rows = queryAll<ClaimRow>('SELECT * FROM claims WHERE analysis_id = $id ORDER BY created_at', {
    $id: analysisId
  })
  return rows.map(toDomain)
}

export function getClaim(id: string): Claim | null {
  const row = queryOne<ClaimRow>('SELECT * FROM claims WHERE id = $id', { $id: id })
  return row ? toDomain(row) : null
}

export function updateClaimScore(claimId: string, score: number, breakdown: ScoreBreakdown): void {
  // Stamped with the generation that produced it, so a later build can tell
  // whether this answer is still one it would give. See
  // shared/retrievalGeneration.ts.
  run(
    `UPDATE claims SET strength_score = $score, score_breakdown = $breakdown,
     retrieval_generation = $generation WHERE id = $id`,
    {
      $id: claimId,
      $score: score,
      $breakdown: JSON.stringify(breakdown),
      $generation: RETRIEVAL_GENERATION
    }
  )
}

/**
 * Writes the whole critique, not just its prose.
 *
 * `suggestedRevision` and `citationFix` are passed explicitly rather than
 * defaulted, so a caller that has them cannot forget to persist them — and so
 * one that genuinely has neither says so. They are NULLed on every write rather
 * than left alone: a re-critique of an edited claim that no longer needs
 * narrowing must not leave the previous run's replacement sentence sitting
 * under a verdict that no longer asks for it.
 */
export function updateClaimCritique(
  claimId: string,
  critique: string,
  verdict: CritiqueVerdict,
  suggestedRevision: string | null,
  citationFix: string | null,
  /**
   * Whether this critique read the work the sentence cites. Written on every
   * critique, alongside the verdict it qualifies — a verdict stored without it
   * is the state that made "your citation may not support this" fire over
   * correctly cited sentences.
   */
  citedWorkRead: boolean
): void {
  run(
    `UPDATE claims SET critique = $critique, critique_verdict = $verdict,
     suggested_revision = $revision, citation_fix = $fix,
     cited_work_read = $citedWorkRead WHERE id = $id`,
    {
      $id: claimId,
      $critique: critique,
      $verdict: verdict,
      $revision: suggestedRevision,
      $fix: citationFix,
      $citedWorkRead: citedWorkRead ? 1 : 0
    }
  )
}
