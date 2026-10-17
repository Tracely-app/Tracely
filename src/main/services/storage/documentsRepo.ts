import { randomUUID } from 'crypto'
import type { CitationStyle, DocumentListItem, DocumentPrefs, DocumentRecord } from '@shared/types'
// Imported rather than duplicated: this query treats an outline written by an
// older schema as ungraded, and a copy of the number here would silently start
// trusting stale rows the day analyzeStructure bumps it.
import { STRUCTURE_SCHEMA_VERSION } from '../structure/analyzeStructure'
import { queryAll, queryOne, run } from './db'

interface DocumentRow {
  id: string
  title: string
  body_html: string
  created_at: string
  updated_at: string
  // From `LEFT JOIN document_prefs p` (PREFS_SELECT): null when the document has none.
  p_citation_style?: string | null
  p_never_check?: number | null
}

const STYLES: readonly CitationStyle[] = ['APA', 'MLA', 'Chicago']

function toDomain(row: DocumentRow): DocumentRecord {
  const style = row.p_citation_style as CitationStyle | null | undefined
  return {
    id: row.id,
    title: row.title,
    bodyHtml: row.body_html,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    prefs: {
      citationStyle: style && STYLES.includes(style) ? style : null,
      neverCheck: row.p_never_check === 1
    }
  }
}

// Settings → Documents: each document's own settings, joined onto every read.
const PREFS_SELECT = 'p.citation_style AS p_citation_style, p.never_check AS p_never_check'
const PREFS_JOIN = 'LEFT JOIN document_prefs p ON p.document_id = d.id'

/**
 * Every document, newest-edited first, with the grade it last earned.
 *
 * LEFT JOIN, not a filter: a document nothing has analysed yet still belongs on
 * the Documents page. It arrives with `score`/`gradedAt` null and the card says
 * so — dropping it would hide a draft the user has actually written from the
 * only list of their drafts.
 *
 * The score is dug out of `outline_json` rather than stored in a column of its
 * own, because it is one field of a cached DocumentOutline and duplicating it
 * would give the same draft two scores that can disagree. `json_extract` is
 * available: sql.js is SQLite with JSON1 compiled in.
 *
 * A row whose outline predates the current schema is treated as ungraded. Its
 * shape is not guaranteed, and a number read out of an older layout is worse
 * than no number — see SCHEMA_VERSION in structure/analyzeStructure.ts.
 */
export function listDocuments(): DocumentListItem[] {
  return queryAll<DocumentRow & { score: number | null; graded_at: string | null }>(
    `SELECT d.*, ${PREFS_SELECT},
            CASE WHEN s.schema_version = $version
                 THEN json_extract(s.outline_json, '$.score') END AS score,
            CASE WHEN s.schema_version = $version THEN s.analyzed_at END AS graded_at
       FROM documents d
       LEFT JOIN document_structure s ON s.document_id = d.id
       ${PREFS_JOIN}
      ORDER BY d.updated_at DESC`,
    { $version: STRUCTURE_SCHEMA_VERSION }
  ).map((row) => ({
    ...toDomain(row),
    score: typeof row.score === 'number' ? row.score : null,
    gradedAt: row.graded_at ?? null
  }))
}

export function getDocument(id: string): DocumentRecord | null {
  const row = queryOne<DocumentRow>(`SELECT d.*, ${PREFS_SELECT} FROM documents d ${PREFS_JOIN} WHERE d.id = $id`, {
    $id: id
  })
  return row ? toDomain(row) : null
}

/** The most recently edited document, for reopening where the user left off. */
export function getLatestDocument(): DocumentRecord | null {
  const row = queryOne<DocumentRow>(
    `SELECT d.*, ${PREFS_SELECT} FROM documents d ${PREFS_JOIN} ORDER BY d.updated_at DESC LIMIT 1`
  )
  return row ? toDomain(row) : null
}

/**
 * Settings → Documents: change one document's own settings. A patch names only
 * what it changes; a row back at "as Settings says" for everything is removed,
 * so the table holds only documents that differ.
 */
export function setDocumentPrefs(id: string, patch: Partial<DocumentPrefs>): DocumentRecord | null {
  const doc = getDocument(id)
  if (!doc) return null
  const next: DocumentPrefs = { citationStyle: null, neverCheck: false, ...doc.prefs, ...patch }
  if (next.citationStyle === null && !next.neverCheck) {
    run('DELETE FROM document_prefs WHERE document_id = $id', { $id: id })
  } else {
    run(
      `INSERT INTO document_prefs (document_id, citation_style, never_check, updated_at)
       VALUES ($id, $style, $never, $now)
       ON CONFLICT(document_id) DO UPDATE SET
         citation_style = excluded.citation_style, never_check = excluded.never_check, updated_at = excluded.updated_at`,
      { $id: id, $style: next.citationStyle, $never: next.neverCheck ? 1 : 0, $now: new Date().toISOString() }
    )
  }
  return getDocument(id)
}

/** Settings → Documents → Forget its grade: the cached outline goes; the next grade is a fresh one. */
export function forgetDocumentGrade(id: string): void {
  run('DELETE FROM document_structure WHERE document_id = $id', { $id: id })
}

/** Settings → Memory: how many documents have settings of their own, and clearing them all. */
export function countDocumentPrefs(): number {
  return queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM document_prefs')?.n ?? 0
}
export function clearDocumentPrefs(): void {
  run('DELETE FROM document_prefs')
}

/**
 * Creates or updates a document.
 *
 * Upsert rather than separate create/update calls because the caller is an
 * autosave: the editor does not care whether this is the first save of a new
 * document or the fortieth of an existing one, and making it track that would
 * put the "have I saved yet?" race in the renderer.
 */
export function saveDocument(input: {
  id?: string | null
  title: string
  bodyHtml: string
}): DocumentRecord {
  const now = new Date().toISOString()
  const existing = input.id ? getDocument(input.id) : null

  if (existing) {
    run('UPDATE documents SET title = $title, body_html = $body, updated_at = $now WHERE id = $id', {
      $id: existing.id,
      $title: input.title,
      $body: input.bodyHtml,
      $now: now
    })
    return { ...existing, title: input.title, bodyHtml: input.bodyHtml, updatedAt: now }
  }

  const id = input.id ?? randomUUID()
  run(
    `INSERT INTO documents (id, title, body_html, created_at, updated_at)
     VALUES ($id, $title, $body, $now, $now)`,
    { $id: id, $title: input.title, $body: input.bodyHtml, $now: now }
  )
  return { id, title: input.title, bodyHtml: input.bodyHtml, createdAt: now, updatedAt: now }
}

export function removeDocument(id: string): void {
  run('DELETE FROM documents WHERE id = $id', { $id: id })
}
