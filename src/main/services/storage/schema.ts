export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  doi TEXT UNIQUE,
  title TEXT NOT NULL,
  authors TEXT NOT NULL,
  year INTEGER,
  venue TEXT,
  venue_type TEXT,
  url TEXT,
  pdf_url TEXT,
  abstract TEXT,
  provider TEXT NOT NULL,
  provider_id TEXT,
  citation_count INTEGER,
  oa_status TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_provider ON sources(provider, provider_id);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  source_text TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  claim_type TEXT,
  confidence REAL,
  search_query TEXT,
  strength_score INTEGER,
  score_breakdown TEXT,
  critique TEXT,
  critique_verdict TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_analysis ON claims(analysis_id);

CREATE TABLE IF NOT EXISTS claim_evidence (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  relevance_score REAL,
  rank INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(claim_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim ON claim_evidence(claim_id);

CREATE TABLE IF NOT EXISTS citations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  style TEXT NOT NULL,
  formatted_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_id, style)
);

CREATE TABLE IF NOT EXISTS library_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  claim_id TEXT REFERENCES claims(id) ON DELETE SET NULL,
  notes TEXT,
  tags TEXT,
  saved_at TEXT NOT NULL,
  UNIQUE(source_id)
);

CREATE TABLE IF NOT EXISTS request_cache (
  cache_key TEXT PRIMARY KEY,
  cache_type TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cache_type ON request_cache(cache_type);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracer_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracer_conversations_updated ON tracer_conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS tracer_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES tracer_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracer_messages_conversation ON tracer_messages(conversation_id, created_at);

-- The document editor's writing surface. Everything it produced used to live
-- only in an uncontrolled contentEditable node, so pressing Back unmounted the
-- component and destroyed the work with no warning, and the "name your
-- document" field fed nothing but itself.
--
-- body_html rather than plain text because the editor is a rich-text surface
-- (execCommand bold/italic/colour/alignment), and storing text would silently
-- discard every bit of formatting on the first reload.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);

-- The Structure panel's last analysis of a document.
--
-- This is a CACHE of a pure function, not a source of truth: given the same
-- text and claims, analyzeStructure() reproduces it exactly. It is persisted
-- anyway because it cannot be recomputed on demand — the analysis runs on the
-- editor's innerText, and body_html above cannot be turned back into the same
-- string from the main process without parsing HTML, which this side
-- deliberately never does.
--
-- One row per document (PRIMARY KEY on document_id, upserted), and it cascades
-- with the document since foreign keys are on.
--
-- outline_json as a blob with a schema_version beside it rather than a column
-- per field: the outline's shape changes as roles and weakness kinds are added,
-- and because the row is only a cache, a version bump can discard incompatible
-- rows for the cost of one re-analysis instead of needing a migration.
--
-- source_hash is over the innerText, so reformatting (bold, colour, alignment)
-- leaves the analysis valid while an edit to the words marks it stale.
-- Settings → Documents (2026-10-17, the extension's per-Doc settings mirrored):
-- one document's own settings. A table of its own rather than columns on
-- documents, so it is a brand-new table (SCHEMA_SQL creates it for every
-- install; no migration) and it cascades with the document. No row is "as
-- Settings says" for everything.
CREATE TABLE IF NOT EXISTS document_prefs (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  citation_style TEXT,
  never_check INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_structure (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  outline_json TEXT NOT NULL,
  analyzed_at TEXT NOT NULL
);
`
