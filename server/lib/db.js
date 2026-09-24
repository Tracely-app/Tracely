/**
 * Storage — node:sqlite (built in, no native build), one file under data/.
 * Migrations are a versioned list keyed off PRAGMA user_version; a brand-new
 * database runs the schema and then every migration, so migrations must be
 * idempotent. Never edit an existing table's definition in SCHEMA — add a
 * migration. If a fix changes how something is DERIVED, ask whether stored
 * rows need re-deriving too (that is usually the half that makes it visible).
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/* TRACELY_DATA_DIR relocates the database. Two callers need it: a deployed box
 * that keeps state outside the checkout (/srv/tracely/data), and tests that
 * must not write into the developer's real database — the spend ledger lives
 * in this file, and a test that bumps a real counter would quietly consume the
 * operator's daily budget. */
const DATA_DIR = process.env.TRACELY_DATA_DIR
  ? path.resolve(process.env.TRACELY_DATA_DIR)
  : path.join(ROOT, "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "tracely.db"));
db.exec("PRAGMA journal_mode = WAL;");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled',
  body_html TEXT NOT NULL DEFAULT '', created_at INTEGER, updated_at INTEGER,
  last_opened_at INTEGER, grade_letter TEXT, grade_score REAL
);
CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY, document_id TEXT, source_text TEXT NOT NULL,
  created_at INTEGER, grade_json TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, text TEXT NOT NULL,
  sentence TEXT, start_off INTEGER, end_off INTEGER,
  claim_type TEXT, confidence REAL, query TEXT,
  strength_score REAL, strength_json TEXT,
  critique_verdict TEXT, critique_json TEXT, retrieval_gen INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, doi TEXT, title TEXT NOT NULL, authors_json TEXT,
  year INTEGER, venue TEXT, venue_type TEXT, url TEXT, abstract TEXT,
  provider TEXT, oa_url TEXT, created_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_doi ON sources(doi) WHERE doi IS NOT NULL;
CREATE TABLE IF NOT EXISTS claim_evidence (
  claim_id TEXT NOT NULL, source_id TEXT NOT NULL,
  relevance REAL, metric TEXT, stance TEXT,
  PRIMARY KEY (claim_id, source_id)
);
CREATE TABLE IF NOT EXISTS citations (
  source_id TEXT NOT NULL, style TEXT NOT NULL, formatted TEXT, in_text TEXT,
  PRIMARY KEY (source_id, style)
);
CREATE TABLE IF NOT EXISTS library_items (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, note TEXT DEFAULT '',
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS document_structure (
  document_id TEXT PRIMARY KEY, text_hash TEXT, structure_json TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS request_cache (
  key TEXT PRIMARY KEY, kind TEXT, value_json TEXT, created_at INTEGER, version INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tracer_conversations (
  id TEXT PRIMARY KEY, document_id TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS tracer_messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT, content TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
`;

// Versioned migrations. Push new entries; never rewrite old ones.
const MIGRATIONS = [
  // v1 — baseline lives in SCHEMA; this slot exists so user_version starts at 1.
  () => {},
  // v2 — entitlement: free-tier metering and the Stripe webhook ledger. These
  // are not in SCHEMA because a database created before entitlement existed
  // must gain them too, and SCHEMA only ever runs its CREATE IF NOT EXISTS.
  () => {
    db.exec(`
CREATE TABLE IF NOT EXISTS entitlement_usage (
  account_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER,
  PRIMARY KEY (account_id, day, kind)
);
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY, type TEXT, user_id TEXT, customer_id TEXT,
  plan TEXT, outcome TEXT, received_at INTEGER, payload_json TEXT
);
CREATE TABLE IF NOT EXISTS billing_customers (
  customer_id TEXT PRIMARY KEY, user_id TEXT, email TEXT, updated_at INTEGER
);
`);
  },
  // v3 — unclaimed purchases. A customer paid for a plan and no event named
  // the account (a checkout reached from the website while signed out, or
  // before the account existed). The purchase waits here, keyed on the Stripe
  // customer, until an event links that customer to a user or the payer's
  // email signs in — instead of hanging on Stripe's three-day retry schedule
  // and then being lost for good (that is how a beta tester paid and stayed
  // on Free, 2026-09-23).
  () => {
    db.exec(`
CREATE TABLE IF NOT EXISTS billing_pending (
  customer_id TEXT PRIMARY KEY, email TEXT, plan TEXT NOT NULL, event_id TEXT, received_at INTEGER
);
CREATE INDEX IF NOT EXISTS billing_pending_email ON billing_pending (email);
`);
  },
];

export function migrate() {
  db.exec(SCHEMA);
  const current = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      MIGRATIONS[v]();
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
migrate();

export const now = () => Date.now();
export const uuid = () => randomUUID();
export const hashKey = (s) => createHash("sha256").update(s).digest("hex").slice(0, 40);

// ── request cache: every model result, keyed on a hash of normalized input.
// An EMPTY answer and a FAILED answer must never be conflated by callers:
// failures are simply not cached. Version the key when the answering set changes.
export function cacheGet(kind, key, { maxAgeMs = null, version = 1 } = {}) {
  const row = db.prepare("SELECT value_json, created_at, version FROM request_cache WHERE key = ?").get(`${kind}:${version}:${key}`);
  if (!row) return null;
  if (maxAgeMs != null && Date.now() - row.created_at > maxAgeMs) return null;
  try { return JSON.parse(row.value_json); } catch { return null; }
}
export function cacheSet(kind, key, value, { version = 1 } = {}) {
  db.prepare(
    "INSERT INTO request_cache (key, kind, value_json, created_at, version) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, created_at = excluded.created_at"
  ).run(`${kind}:${version}:${key}`, kind, JSON.stringify(value), Date.now(), version);
}

// ── sources: deduped by DOI, falling back to normalized title+year.
// NOTE (spec trap): rows are returned untouched when a DOI already matches, so
// a re-search never re-classifies anything — derived-column fixes need a
// migration that re-derives stored rows.
export function upsertSource(s) {
  if (s.doi) {
    const existing = db.prepare("SELECT * FROM sources WHERE doi = ?").get(s.doi);
    if (existing) return existing;
  }
  const normTitle = (s.title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const byTitle = db.prepare("SELECT * FROM sources WHERE lower(title) = ? AND year IS ?").get(normTitle, s.year ?? null);
  if (byTitle) return byTitle;
  const id = uuid();
  db.prepare(
    "INSERT INTO sources (id, doi, title, authors_json, year, venue, venue_type, url, abstract, provider, oa_url, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(id, s.doi ?? null, s.title ?? "", JSON.stringify(s.authors ?? []), s.year ?? null, s.venue ?? null,
        s.venueType ?? null, s.url ?? null, s.abstract ?? null, s.provider ?? null, s.oaUrl ?? null, Date.now());
  return db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
}

// ── entitlement usage: one counter per account, per calendar day, per kind.
// Counted here rather than in memory because a free account must not get its
// quota back by restarting the server, and because the count is the only
// evidence when someone asks why they saw a 429.
export function usageCount(accountId, day, kind) {
  const row = db.prepare("SELECT count FROM entitlement_usage WHERE account_id = ? AND day = ? AND kind = ?")
    .get(accountId, day, kind);
  return row?.count ?? 0;
}

/** Increments and returns the NEW count. Stamped before the call it meters. */
export function usageBump(accountId, day, kind) {
  db.prepare(
    "INSERT INTO entitlement_usage (account_id, day, kind, count, updated_at) VALUES (?, ?, ?, 1, ?) " +
    "ON CONFLICT(account_id, day, kind) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at"
  ).run(accountId, day, kind, Date.now());
  return usageCount(accountId, day, kind);
}

/**
 * Adds N and returns the NEW total. The spend ledger needs this because it
 * accumulates a COST, not a call count — usageBump's +1 cannot express
 * "this request cost 641 micro-cents".
 *
 * Negative and non-finite deltas are floored to 0 rather than rejected: a
 * miscomputed price must never be able to REFUND the budget, which would turn
 * an arithmetic bug into an uncapped spend.
 */
export function usageAdd(accountId, day, kind, n) {
  const delta = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  db.prepare(
    "INSERT INTO entitlement_usage (account_id, day, kind, count, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(account_id, day, kind) DO UPDATE SET count = count + ?, updated_at = excluded.updated_at"
  ).run(accountId, day, kind, delta, Date.now(), delta);
  return usageCount(accountId, day, kind);
}

// ── billing ledger: every Stripe event we accepted, keyed on Stripe's own id.
// Stripe retries deliveries, so "already recorded" must mean "already applied":
// the insert IS the replay guard, which is why it returns whether it won.
export function billingEventRecord({ id, type, userId, customerId, plan, outcome, payload }) {
  const existing = db.prepare("SELECT id FROM billing_events WHERE id = ?").get(id);
  if (existing) return false;
  db.prepare(
    "INSERT INTO billing_events (id, type, user_id, customer_id, plan, outcome, received_at, payload_json) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, type ?? null, userId ?? null, customerId ?? null, plan ?? null, outcome ?? null, Date.now(),
        payload == null ? null : JSON.stringify(payload).slice(0, 100_000));
  return true;
}

export function billingEventSeen(id) {
  return Boolean(db.prepare("SELECT id FROM billing_events WHERE id = ?").get(id));
}

// The Stripe customer → Supabase user mapping, learned at checkout.
// Later subscription events carry a customer id and no user id at all, so
// without this the renewal that matters most would have nobody to write to.
export function billingCustomerLink({ customerId, userId, email }) {
  if (!customerId) return;
  db.prepare(
    "INSERT INTO billing_customers (customer_id, user_id, email, updated_at) VALUES (?,?,?,?) " +
    "ON CONFLICT(customer_id) DO UPDATE SET " +
    "user_id = COALESCE(excluded.user_id, user_id), email = COALESCE(excluded.email, email), updated_at = excluded.updated_at"
  ).run(customerId, userId ?? null, email ?? null, Date.now());
}

export function billingCustomerLookup(customerId) {
  if (!customerId) return null;
  return db.prepare("SELECT customer_id, user_id, email FROM billing_customers WHERE customer_id = ?").get(customerId) ?? null;
}

/* ── unclaimed purchases (billing_pending) ─────────────────────────────
 * One row per Stripe customer: the plan they paid for and, when known, the
 * email they paid with (lower-cased, so a sign-in matches however Google
 * capitalises it). A later event for the same customer replaces the plan;
 * the row goes when the purchase is claimed or the subscription ends. */
export function billingPendingPut({ customerId, email, plan, eventId }) {
  if (!customerId || !plan) return;
  db.prepare(
    "INSERT INTO billing_pending (customer_id, email, plan, event_id, received_at) VALUES (?,?,?,?,?) " +
    "ON CONFLICT(customer_id) DO UPDATE SET " +
    "email = COALESCE(excluded.email, email), plan = excluded.plan, event_id = excluded.event_id, received_at = excluded.received_at"
  ).run(customerId, email ? String(email).trim().toLowerCase() : null, plan, eventId ?? null, Date.now());
}
export function billingPendingByCustomer(customerId) {
  if (!customerId) return null;
  return db.prepare("SELECT customer_id, email, plan, event_id, received_at FROM billing_pending WHERE customer_id = ?").get(customerId) ?? null;
}
export function billingPendingByEmail(email) {
  if (!email) return null;
  return db.prepare("SELECT customer_id, email, plan, event_id, received_at FROM billing_pending WHERE email = ? ORDER BY received_at DESC LIMIT 1")
    .get(String(email).trim().toLowerCase()) ?? null;
}
export function billingPendingDelete(customerId) {
  if (!customerId) return;
  db.prepare("DELETE FROM billing_pending WHERE customer_id = ?").run(customerId);
}

/* Everything this server keeps about one account, gone: the usage counters
 * under user:<id>, the customer links, any unclaimed purchase under the
 * email, and the Stripe payloads of that account's billing events (the rows
 * themselves stay as the bare payment record — id, type, plan, outcome — with
 * no payer details in them). Returns what was removed, for the reply. */
export function accountPurge({ userId, email }) {
  if (!userId) return { usage: 0, customers: 0, pending: 0, events: 0 };
  const out = {};
  db.exec("BEGIN");
  try {
    out.usage = db.prepare("DELETE FROM entitlement_usage WHERE account_id = ?").run(`user:${userId}`).changes;
    out.customers = db.prepare("DELETE FROM billing_customers WHERE user_id = ?").run(userId).changes;
    out.pending = email ? db.prepare("DELETE FROM billing_pending WHERE email = ?").run(String(email).trim().toLowerCase()).changes : 0;
    out.events = db.prepare("UPDATE billing_events SET payload_json = NULL WHERE user_id = ?").run(userId).changes;
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return out;
}

/* Retention: usage counters older than the cutoff day ("YYYY-MM-DD") go.
 * Month rows are "YYYY-MM", which sorts before any day in that month, so a
 * cutoff on the 1st also drops the month that ended before it. */
export function usagePurgeBefore(cutoffDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cutoffDay))) return 0;
  return db.prepare("DELETE FROM entitlement_usage WHERE day < ?").run(cutoffDay).changes;
}

export function settingsGet() {
  const out = {};
  for (const row of db.prepare("SELECT key, value FROM settings").all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
  }
  return out;
}
export function settingsSet(patch) {
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.exec("BEGIN");
  try {
    for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return settingsGet();
}
