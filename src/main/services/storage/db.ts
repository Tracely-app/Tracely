import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import { getAppPaths } from './paths'
import { SCHEMA_SQL } from './schema'

let db: Database | null = null
let dbPath: string | null = null

function getWasmPath(): string {
  const { appRoot, resourcesDir } = getAppPaths()
  if (resourcesDir) {
    return join(resourcesDir, 'sql-wasm.wasm')
  }
  return join(appRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
}

export async function initDb(): Promise<void> {
  if (db) return

  const wasmBytes = readFileSync(getWasmPath())
  const wasmBinary = wasmBytes.buffer.slice(
    wasmBytes.byteOffset,
    wasmBytes.byteOffset + wasmBytes.byteLength
  ) as ArrayBuffer
  const SQL = await initSqlJs({ wasmBinary })

  dbPath = join(getAppPaths().dataDir, 'tracely.db')
  mkdirSync(dirname(dbPath), { recursive: true })

  if (existsSync(dbPath)) {
    db = new SQL.Database(readFileSync(dbPath))
  } else {
    db = new SQL.Database()
  }

  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  sweepExpiredCache(db)
  persist()
}

// Expiry was checked on read and never acted on: getCached returns null for
// an expired row and leaves it in place, so every evidence search a user has
// ever run stayed in the file forever. Since the whole database is
// serialized to disk on every write, dead rows are not merely wasted space —
// they are a tax on every subsequent write in the app.
//
// Once per boot rather than on a timer: this is garbage that accumulates
// over sessions, not within one, and it costs a single DELETE.
function sweepExpiredCache(database: Database): void {
  database.run('DELETE FROM request_cache WHERE expires_at IS NOT NULL AND expires_at < $now', {
    $now: new Date().toISOString()
  })
}

// SCHEMA_SQL is all CREATE TABLE IF NOT EXISTS, so it is a complete no-op
// against a database that already exists. That is fine for adding a whole
// new table — it appears on next boot for everyone — but it means editing an
// existing table's definition silently does nothing for every current user,
// and the first SELECT or INSERT naming the new column throws at runtime.
// There was no mechanism to catch that. This is it.
//
// Rules: never edit an existing table's definition in SCHEMA_SQL — add a
// migration here instead. A brand-new database runs SCHEMA_SQL and then
// every migration, so migrations must be idempotent; addColumnIfMissing
// handles that for the common case.

interface Migration {
  version: number
  describe: string
  up: (database: Database) => void
}

function columnExists(database: Database, table: string, column: string): boolean {
  const stmt = database.prepare(`PRAGMA table_info(${table})`)
  let found = false
  while (stmt.step()) {
    if ((stmt.getAsObject() as { name?: string }).name === column) {
      found = true
      break
    }
  }
  stmt.free()
  return found
}

function addColumnIfMissing(database: Database, table: string, column: string, decl: string): void {
  if (columnExists(database, table, column)) return
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    describe: 'sources.doi_key — case/whitespace-normalized DOI with an index',
    up: (database) => {
      // findByDoi matched on lower(trim(doi)), which no index can serve, so
      // every source encountered in every search was a full table scan of a
      // table that grows forever. Normalizing on write makes it an index hit.
      addColumnIfMissing(database, 'sources', 'doi_key', 'TEXT')
      database.exec('CREATE INDEX IF NOT EXISTS idx_sources_doi_key ON sources(doi_key)')
      database.exec(
        "UPDATE sources SET doi_key = lower(trim(doi)) WHERE doi IS NOT NULL AND doi_key IS NULL"
      )
    }
  },
  {
    version: 2,
    describe: 'reclaim sources.raw_json — write-only provider payloads',
    up: (database) => {
      // See upsertSource: raw_json was never read back by anything. Existing
      // installs are carrying several KB per paper of it, and every write
      // rewrites the whole file. VACUUM is what actually returns the space —
      // a DELETE/UPDATE alone leaves the pages allocated.
      database.exec('UPDATE sources SET raw_json = NULL WHERE raw_json IS NOT NULL')
      database.exec('VACUUM')
    }
  },
  {
    version: 3,
    describe: 'claim_evidence.stance — whether each source agrees with the claim',
    up: (database) => {
      // Stance is computed during the evidence search, where the model output
      // is in hand, but it is needed later by the critique and correction
      // steps, which read evidence back from the database and would otherwise
      // have no idea which sources disagree. Persisted here rather than in its
      // own table because a verdict is meaningless without the exact claim
      // wording it was computed against — so it should live and die with the
      // claim, and be cleared by "Clear Analysis History" like any other
      // record of what the user wrote.
      addColumnIfMissing(database, 'claim_evidence', 'stance', 'TEXT')
      addColumnIfMissing(database, 'claim_evidence', 'stance_confidence', 'REAL')
    }
  },
  {
    version: 4,
    describe: 'claims.suggested_revision / citation_fix — the critique output that is a fix',
    up: (database) => {
      // The critique has returned both since the relay's v7 response, and both
      // went to the renderer that asked for it and nowhere else. Everything
      // that reads a claim back — the document editor's underlines and the
      // popover over them — sees only `critique` and `critique_verdict`, so a
      // sentence flagged "Overstated" could offer the complaint and not the
      // narrowed sentence that is the whole content of that verdict.
      //
      // No backfill is possible: the values were never written, and re-deriving
      // them means paying for the most expensive call in the product on every
      // historical claim. Old rows stay null and the card falls back to the
      // critique prose, which is what they have.
      addColumnIfMissing(database, 'claims', 'suggested_revision', 'TEXT')
      addColumnIfMissing(database, 'claims', 'citation_fix', 'TEXT')
    }
  },
  {
    version: 5,
    describe: 'claims.cited_work_read — did the critique open the work the sentence cites',
    up: (database) => {
      // The fact that separates "your source does not support this" from "other
      // papers on this topic do not". referenceCheck.ts resolves the cited work
      // and citedEvidence.ts gives it slot 1 when it resolves; the critique
      // returns the same four verdicts either way, so downstream the two were
      // indistinguishable and the second was being printed as the first.
      //
      // No backfill. Whether a lookup succeeded is not recoverable from a
      // stored verdict, and re-deriving it means re-running the reference check
      // for every historical claim. Old rows stay null, which problemKind.ts
      // reads as "not read" and stays quiet about — the safe direction, and the
      // one the owner asked for on 2026-08-19.
      addColumnIfMissing(database, 'claims', 'cited_work_read', 'INTEGER')
    }
  },
  {
    version: 6,
    describe: 'claims.retrieval_generation — which retrieval stack produced a stored score',
    up: (database) => {
      // A stored score is inherited forever (findSearchedClaimByText matches on
      // strength_score IS NOT NULL, and 0 is not null), so a claim that came
      // back empty under an older fan-out was reported empty for good — the app
      // never consulted the request cache, because it never searched again.
      //
      // Deliberately left NULL on every existing row rather than backfilled to
      // the current generation. Null means "produced by something we can no
      // longer identify", which is exactly right, and it is what makes the
      // sweep re-search them once. Backfilling would preserve the bug it exists
      // to clear.
      addColumnIfMissing(database, 'claims', 'retrieval_generation', 'INTEGER')
    }
  },
  {
    version: 7,
    describe: "sources.venue_type — a stored 'book' with a container title is a chapter",
    up: (database) => {
      // Crossref types a chapter `book-chapter`, and `type.includes('book')`
      // collapsed it onto 'book' — which citationLocator.ts gives no locator,
      // because a book is found by author, title and publisher. A chapter is
      // not: nothing catalogues chapter six of an edited collection, so its DOI
      // is the only address it has. Owner, 2026-08-20, on what "Replace
      // citation" produced: an Oreskes chapter, formatted, "with no link".
      //
      // This has to reach STORED rows or it fixes nothing anyone can see.
      // upsertSource returns the existing row untouched when the DOI already
      // matches, so a re-search never re-classifies anything — the same shape
      // as the inherited claim scores in v6, where three consecutive correct
      // fixes were invisible because no stored row could change.
      //
      // The container title is the test, and it is what the field MEANS rather
      // than a heuristic: a chapter always sits in something, a whole book sits
      // in nothing. Measured on the owner's two databases before writing this —
      // 142 of 148 'book' rows carry a container, and the 6 that do not are
      // real books (Victory at Stalingrad, Metallographie). Those keep their
      // locator-free entry, which is the original complaint this must not undo.
      database.exec(
        `UPDATE sources SET venue_type = 'book-chapter'
          WHERE venue_type = 'book' AND venue IS NOT NULL AND TRIM(venue) <> ''`
      )
    }
  }
]

function runMigrations(database: Database): void {
  const stmt = database.prepare('PRAGMA user_version')
  stmt.step()
  const current = Number(Object.values(stmt.getAsObject())[0] ?? 0)
  stmt.free()

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    migration.up(database)
    // Not parameterizable — PRAGMA takes a literal. version is a hardcoded
    // integer from the table above, never user input.
    database.exec(`PRAGMA user_version = ${migration.version}`)
    console.log(`[db] migrated to v${migration.version}: ${migration.describe}`)
  }
}

export function getDb(): Database {
  if (!db) throw new Error('Database not initialized — call initDb() first')
  return db
}

// sql.js holds the database in memory with no incremental write path, so
// "saving" means serializing the whole thing and rewriting the file. That is
// fine for one write and ruinous for a loop: a single evidence search
// upserts a source and links evidence per result, then updates the claim's
// score, which was ~21 full-database serializations back to back on the main
// thread. The cost scales with total database size, so it got worse the
// longer someone used the app, and it would get much worse again once
// embedding vectors live in here.
//
// Depth-counted rather than a boolean so nested transaction() calls collapse
// into one write instead of the inner one committing early.
let persistDepth = 0
let persistPending = false

export function persist(): void {
  if (!db || !dbPath) return
  if (persistDepth > 0) {
    persistPending = true
    return
  }
  const bytes = db.export()
  writeFileSync(dbPath, Buffer.from(bytes))
}

/**
 * Runs `fn` with disk writes deferred, then writes once at the end.
 *
 * This is a write-batching helper, NOT a SQL transaction — it does not begin
 * or roll back anything. If `fn` throws, writes made before the throw are
 * still in the in-memory database and are still flushed, exactly as they
 * would have been without this wrapper. The guarantee is only that the file
 * is rewritten once rather than N times.
 */
export function transaction<T>(fn: () => T): T {
  persistDepth++
  try {
    return fn()
  } finally {
    persistDepth--
    if (persistDepth === 0 && persistPending) {
      persistPending = false
      persist()
    }
  }
}

export type SqlParams = Record<string, SqlValue> | SqlValue[]

export function run(sql: string, params: SqlParams = []): void {
  getDb().run(sql, params)
  persist()
}

export function queryAll<T = Record<string, SqlValue>>(sql: string, params: SqlParams = []): T[] {
  const stmt = getDb().prepare(sql)
  stmt.bind(params)
  const rows: T[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T)
  }
  stmt.free()
  return rows
}

export function queryOne<T = Record<string, SqlValue>>(sql: string, params: SqlParams = []): T | null {
  const rows = queryAll<T>(sql, params)
  return rows[0] ?? null
}

export function resetDatabase(): void {
  if (!dbPath) return
  // document_structure is in this list for the same reason it is in
  // clearAnalysisHistory's: its weakness messages and role labels are
  // statements about the user's own writing. It was missing here, which meant
  // the WEAKER clear removed it and the stronger one left it behind — exactly
  // backwards, and the sort of asymmetry a reader would assume was deliberate.
  getDb().exec(
    'DELETE FROM claim_evidence; DELETE FROM citations; DELETE FROM library_items; DELETE FROM claims; DELETE FROM analyses; DELETE FROM sources; DELETE FROM request_cache; DELETE FROM tracer_messages; DELETE FROM tracer_conversations; DELETE FROM document_structure;'
  )
  // Deleting rows does not shrink a SQLite file, so without this a user who
  // clears everything for privacy reasons still ships the same
  // multi-megabyte file around, and every write still pays for its size.
  getDb().exec('VACUUM')
  persist()
}

// Tracer conversations are cleared here too: they quote the user's own
// writing back at them, so leaving them behind would defeat the point of
// "Clear Analysis History" as a privacy control, even though they live in
// their own tables rather than analyses/claims.
// document_structure goes with them for two reasons: its weakness messages
// quote paragraph positions in the user's writing, and its claim ids point at
// claims this statement is about to delete — leaving it would strand an
// outline referring to analyses that no longer exist. The documents themselves
// are the user's work and stay, exactly as the library does.
export function clearAnalysisHistory(): void {
  getDb().exec(
    'DELETE FROM claim_evidence; DELETE FROM claims; DELETE FROM analyses; DELETE FROM request_cache; DELETE FROM tracer_messages; DELETE FROM tracer_conversations; DELETE FROM document_structure;'
  )
  getDb().exec('VACUUM')
  persist()
}

// Settings → Memory (2026-10-17, the extension's mirrored): the same history,
// one part at a time. clearAnalysisHistory above is Privacy's one-press
// version and stays as it is.

/** What each part of Memory holds now, counted. */
export function memoryCounts(): { answers: number; checks: number; grades: number; tracerChats: number; library: number } {
  const n = (sql: string): number => queryOne<{ n: number }>(sql)?.n ?? 0
  return {
    // Answers kept so the same words are never asked or paid for twice: checks, critiques, grades, searches.
    answers: n('SELECT COUNT(*) AS n FROM request_cache'),
    checks: n('SELECT COUNT(*) AS n FROM analyses'),
    grades: n('SELECT COUNT(*) AS n FROM document_structure'),
    tracerChats: n('SELECT COUNT(*) AS n FROM tracer_conversations'),
    library: n('SELECT COUNT(*) AS n FROM library_items')
  }
}

/**
 * Saved checks: the analyses with their claims and evidence, every kept answer
 * and search, and the documents' grades — clearAnalysisHistory's rows less
 * Tracer's. Tracer chats, the library and the documents stay. The sources
 * table stays too, as clearAnalysisHistory leaves it: it is public records
 * (titles, authors), and an open Screen Watch card may still cite one by id.
 */
export function clearSavedChecks(): void {
  getDb().exec(
    'DELETE FROM claim_evidence; DELETE FROM claims; DELETE FROM analyses; DELETE FROM request_cache; DELETE FROM document_structure;'
  )
  getDb().exec('VACUUM')
  persist()
}

/** Tracer chats: every conversation and its messages. */
export function clearTracerChats(): void {
  getDb().exec('DELETE FROM tracer_messages; DELETE FROM tracer_conversations;')
  getDb().exec('VACUUM')
  persist()
}
