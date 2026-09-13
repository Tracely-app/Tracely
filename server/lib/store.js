/** Storage route handlers — thin SQL passthroughs over lib/db.js. */
import { db, uuid, upsertSource, settingsGet, settingsSet } from "./db.js";
import { CheckError } from "./factcheck.js";
import { MODEL_TIERS } from "./llm.js";

const DOC_SORTS = {
  graded: "ORDER BY grade_score IS NULL, updated_at DESC",
  opened: "ORDER BY last_opened_at DESC",
  title: "ORDER BY title COLLATE NOCASE ASC",
  score: "ORDER BY grade_score DESC",
};

export const documents = {
  list(sort = "graded") {
    const order = DOC_SORTS[sort] ?? DOC_SORTS.graded;
    return db.prepare(`SELECT id, title, created_at, updated_at, last_opened_at, grade_letter, grade_score FROM documents ${order}`).all();
  },
  latest() {
    // Most recently OPENED, not edited — the "resume where I was" document.
    // A read, deliberately: it must not bump last_opened_at the way get() does,
    // or polling it would pin one document at the top forever.
    return db.prepare("SELECT * FROM documents ORDER BY last_opened_at DESC LIMIT 1").get() ?? null;
  },
  get(id) {
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    if (!doc) throw new CheckError("not_found", "Document not found", { status: 404 });
    db.prepare("UPDATE documents SET last_opened_at = ? WHERE id = ?").run(Date.now(), id);
    return doc;
  },
  create({ title, bodyHtml }) {
    const id = uuid();
    const t = Date.now();
    db.prepare("INSERT INTO documents (id, title, body_html, created_at, updated_at, last_opened_at) VALUES (?,?,?,?,?,?)")
      .run(id, String(title ?? "Untitled").slice(0, 300), String(bodyHtml ?? ""), t, t, t);
    return db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  },
  update(id, patch) {
    const doc = db.prepare("SELECT id FROM documents WHERE id = ?").get(id);
    if (!doc) throw new CheckError("not_found", "Document not found", { status: 404 });
    if (typeof patch.title === "string") db.prepare("UPDATE documents SET title = ?, updated_at = ? WHERE id = ?").run(patch.title.slice(0, 300), Date.now(), id);
    if (typeof patch.bodyHtml === "string") db.prepare("UPDATE documents SET body_html = ?, updated_at = ? WHERE id = ?").run(patch.bodyHtml, Date.now(), id);
    if (typeof patch.gradeLetter === "string" || typeof patch.gradeScore === "number") {
      db.prepare("UPDATE documents SET grade_letter = ?, grade_score = ?, updated_at = ? WHERE id = ?")
        .run(patch.gradeLetter ?? null, patch.gradeScore ?? null, Date.now(), id);
    }
    return db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  },
  remove(id) {
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    return { ok: true };
  },
};

export const library = {
  list(q) {
    const rows = db.prepare(`
      SELECT li.id, li.note, li.created_at, s.id AS source_id, s.doi, s.title, s.authors_json, s.year,
             s.venue, s.venue_type, s.url, s.provider, s.oa_url
      FROM library_items li JOIN sources s ON s.id = li.source_id
      ORDER BY li.created_at DESC`).all();
    const items = rows.map((r) => ({
      id: r.id, note: r.note, createdAt: r.created_at,
      source: {
        id: r.source_id, doi: r.doi, title: r.title, authors: JSON.parse(r.authors_json ?? "[]"),
        year: r.year, venue: r.venue, venueType: r.venue_type, url: r.url, provider: r.provider, oaUrl: r.oa_url,
      },
    }));
    if (!q) return items;
    const needle = q.toLowerCase();
    return items.filter((i) =>
      i.source.title?.toLowerCase().includes(needle) ||
      i.note?.toLowerCase().includes(needle) ||
      i.source.authors?.some((a) => String(a).toLowerCase().includes(needle))
    );
  },
  add({ source, note }) {
    if (!source?.title) throw new CheckError("bad_request", "library item needs a source with a title");
    const s = upsertSource(source);
    const existing = db.prepare("SELECT id FROM library_items WHERE source_id = ?").get(s.id);
    if (existing) return { id: existing.id, duplicate: true };
    const id = uuid();
    db.prepare("INSERT INTO library_items (id, source_id, note, created_at) VALUES (?,?,?,?)")
      .run(id, s.id, String(note ?? "").slice(0, 2000), Date.now());
    return { id, duplicate: false };
  },
  update(id, patch) {
    if (typeof patch.note === "string") db.prepare("UPDATE library_items SET note = ? WHERE id = ?").run(patch.note.slice(0, 2000), id);
    return { ok: true };
  },
  remove(id) {
    db.prepare("DELETE FROM library_items WHERE id = ?").run(id);
    return { ok: true };
  },
};

export const prefs = {
  get() {
    return {
      citationStyle: "apa", gradingLevel: 12, autoCritique: true, autoSources: false,
      model: MODEL_TIERS.fast, effort: "low", modelStrategy: "economy",
      theme: "system", accent: "#f97316",
      fontSize: 14, density: "comfortable",
      ...settingsGet(),
    };
  },
  set(patch) {
    const allowed = ["citationStyle", "gradingLevel", "autoCritique", "autoSources", "model", "effort",
                     "modelStrategy", "theme", "accent", "fontSize", "density", "firstName", "lastName", "watchEnabled", "watchApps", "customRubric"];
    const clean = {};
    for (const k of allowed) if (k in patch) clean[k] = patch[k];
    settingsSet(clean);
    return prefs.get();
  },
};

export function stats() {
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const gradedThisMonth = db.prepare("SELECT COUNT(*) c FROM analyses WHERE grade_json IS NOT NULL AND created_at >= ?").get(monthStart.getTime()).c;
  const avg = db.prepare("SELECT AVG(grade_score) a FROM documents WHERE grade_score IS NOT NULL").get().a;
  // streak: consecutive days (back from today) with at least one graded analysis
  const days = new Set(
    db.prepare("SELECT created_at FROM analyses WHERE grade_json IS NOT NULL").all()
      .map((r) => new Date(r.created_at).toDateString())
  );
  let streak = 0;
  for (let d = new Date(); days.has(d.toDateString()); d.setDate(d.getDate() - 1)) streak++;
  const recent = db.prepare("SELECT id, title, grade_letter, last_opened_at FROM documents ORDER BY last_opened_at DESC LIMIT 6").all();
  return { gradedThisMonth, averageScore: avg == null ? null : Math.round(avg * 10) / 10, streak, recent };
}

export const analyses = {
  create({ documentId, sourceText, gradeJson }) {
    const id = uuid();
    db.prepare("INSERT INTO analyses (id, document_id, source_text, created_at, grade_json) VALUES (?,?,?,?,?)")
      .run(id, documentId ?? null, String(sourceText ?? "").slice(0, 100_000), Date.now(), gradeJson ? JSON.stringify(gradeJson) : null);
    return { id };
  },
  forDocument(documentId) {
    return db.prepare("SELECT id, created_at, grade_json FROM analyses WHERE document_id = ? ORDER BY created_at DESC LIMIT 20").all(documentId)
      .map((r) => ({ id: r.id, createdAt: r.created_at, grade: r.grade_json ? JSON.parse(r.grade_json) : null }));
  },
};

/**
 * Sources previously persisted for a claim, looked up by claim TEXT.
 * Claim ids are salted per occurrence/analysis, so text is the only stable
 * key a later session can ask by. Best-effort: unknown text → { sources: [] }.
 */
export function evidenceForClaim(claimText) {
  const t = String(claimText ?? "").trim();
  if (!t || t.length > 2000) return { sources: [] };
  const rows = db.prepare(`
    SELECT s.id, s.doi, s.title, s.authors_json, s.year, s.venue, s.venue_type,
           s.url, s.provider, s.oa_url, MAX(ce.relevance) AS relevance, ce.stance
    FROM claims c
    JOIN claim_evidence ce ON ce.claim_id = c.id
    JOIN sources s ON s.id = ce.source_id
    WHERE c.text = ?
    GROUP BY s.id
    ORDER BY relevance DESC
    LIMIT 20`).all(t);
  return {
    sources: rows.map((r) => ({
      id: r.id, doi: r.doi, title: r.title, authors: JSON.parse(r.authors_json ?? "[]"),
      year: r.year, venue: r.venue, venueType: r.venue_type, url: r.url,
      provider: r.provider, oaUrl: r.oa_url, relevance: r.relevance, stance: r.stance,
    })),
  };
}

export function clearHistory({ alsoLibrary = false } = {}) {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM analyses; DELETE FROM claims; DELETE FROM claim_evidence; DELETE FROM document_structure; DELETE FROM request_cache; DELETE FROM tracer_messages; DELETE FROM tracer_conversations;");
    if (alsoLibrary) db.exec("DELETE FROM library_items;");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { ok: true };
}
