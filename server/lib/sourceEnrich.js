/**
 * Free, authoritative citation metadata for a source that carries a DOI.
 *
 * Why: the source search's citation fields (authors, year, container, DOI)
 * were what made the model OPEN pages after searching, and OpenAI bills every
 * web_search_call — real users' searches ran 5.8-6.0 cents each on 2026-10-01
 * (3-5 calls) against the 1.2 cents one search costs. Journal pages are also
 * the ones a server cannot read for itself: Nature, Elsevier and Pew answer a
 * plain fetch with a bot wall (measured 2026-10-02, 2 of 8 real pages yielded a
 * year). Crossref's REST API answers for the same DOI in ~0.5 s with the
 * authors, the issue date, the journal and the publisher as the publisher
 * registered them — better than what a model reads off the page, and free.
 *
 * So: after the model has picked its sources, every one that names a DOI
 * (in its `doi` field, a doi.org URL, or a publisher URL carrying "/10.xxxx/")
 * is looked up, in parallel, under one short deadline. A PubMed link — the
 * model's favourite for a research finding, and a page whose metadata a plain
 * fetch does not see — goes through NCBI's free esummary first (PMID → DOI,
 * ~0.35 s), then Crossref; when Crossref does not answer, esummary's own
 * fields (title, initials-style authors, "2022 Jun 1", journal) are used. What comes back
 * REPLACES the model's authors/year/date/container and sets the DOI and
 * kind=journal; the model's title, URL, snippet and stance stay. A lookup
 * that fails, times out or finds nothing changes nothing — the answer is
 * never worse than the model's.
 *
 * Polite pool: Crossref asks for a mailto in the User-Agent and in return
 * routes the request to its faster pool. Zero dependencies, as everywhere.
 *
 * Two more answers ride on the same lookups (source receipts, 2026-10-07),
 * at no extra request:
 *   - IS IT THE SAME WORK? A registered record is applied only when its title
 *     really matches the source's (sameWork: most of the source's title words
 *     in the registered title, a fair share of the registered title covered)
 *     and the years agree within one. One shared five-letter word used to be
 *     enough, which let a neighbour on the same topic lend its authors, year
 *     and journal to the source. A record that fails is not applied at all and
 *     the source's DOI is dropped (DOI_REJECTED); a source whose LINK is the
 *     rejected work (a doi.org or PubMed URL under another work's title) is
 *     returned as `mixed`, and the caller drops it — never two works in one.
 *   - IS IT RETRACTED? Crossref's `updated-by` / `update-to` entries of type
 *     retraction (Retraction Watch's data, and publishers' own notices) and
 *     PubMed's "Retracted Publication" publication type. The caller drops a
 *     retracted source entirely. Field names pinned against the live APIs in
 *     test/fixtures/retraction/live-2026-10-07.json.
 */

export const CROSSREF_API = "https://api.crossref.org/works/";
export const ENRICH_DEADLINE_MS = 2_500;
const UA = "Tracely/1.0 (https://jointracely.com; mailto:hello@jointracely.com)";
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>#?]+)/i;
export const ESUMMARY_API = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&tool=tracely&email=hello@jointracely.com&id=";
const PMID_RE = /^https?:\/\/(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\/(\d{1,9})(?:[/?#]|$)/i;

/** The PubMed id a source's URL names, or "". */
export function pmidOf(source) {
  const m = String(source?.url ?? "").match(PMID_RE);
  return m ? m[1] : "";
}

/** NCBI esummary's record for one PMID → the citation fields, plus the DOI it names. Pure. */
export function fieldsFromEsummary(rec) {
  if (!rec || typeof rec !== "object" || rec.error) return null;
  const out = {};
  const authors = (rec.authors ?? []).filter((a) => a && a.name && (a.authtype ?? "Author") === "Author").map((a) => String(a.name).trim()).filter(Boolean);
  if (authors.length) out.authors = authors.slice(0, 30);
  const y = String(rec.pubdate ?? rec.epubdate ?? "").match(/^(\d{4})/);
  if (y) out.year = Number(y[1]);
  if (rec.fulljournalname) out.container = String(rec.fulljournalname).trim().slice(0, 200);
  if (rec.title) out.crossrefTitle = String(rec.title).trim().slice(0, 200);
  const doi = (rec.articleids ?? []).find((a) => a && a.idtype === "doi" && a.value)?.value;
  if (doi) out.doi = String(doi).toLowerCase();
  out.kind = "journal";
  return Object.keys(out).length > 1 ? out : null;
}

/* The DOI enrichSources found to name ANOTHER work than the source's title
 * (sameWork failed). A symbol, so it is never serialised to a client; doiOf
 * skips it, so no later step (the page reader, the receipt check) reads the
 * other work in this source's name. */
export const DOI_REJECTED = Symbol("doiRejected");
const DOI_ORG_URL = /^https?:\/\/(dx\.)?doi\.org\//i;

/** The DOI a source names, normalised (no resolver prefix, no trailing punctuation), or "". */
export function doiOf(source) {
  const fromField = String(source?.doi ?? "").replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "").trim();
  const url = String(source?.url ?? "");
  const candidates = [[fromField, false], [url, !DOI_ORG_URL.test(url)]];
  const rejected = String(source?.[DOI_REJECTED] ?? "").toLowerCase();
  for (const [c, fromPublisherPath] of candidates) {
    const m = c.match(DOI_RE);
    if (!m) continue;
    let doi = m[1].replace(/[.,;:)\]]+$/, "");
    // A publisher's path can continue past the DOI with its own article id
    // (OUP: /doi/10.1093/sleep/zsz307/5651364). A DOI suffix rarely ends in a
    // bare run of digits after a slash; the article id always does.
    if (fromPublisherPath) doi = doi.replace(/\/\d+$/, "");
    if (rejected && doi.toLowerCase() === rejected) continue;
    return doi;
  }
  return "";
}

/* ── is it the same work? ─────────────────────────────────────────────────
 * Content words: case and accents folded, short function words and anything
 * under three letters dropped (numbers kept — "COVID-19", "2020" identify a
 * work). A title is compared whole and without its subtitle (what follows
 * ": ", " — " or " | "), the best pairing winning, because the model often
 * gives the main title alone and Crossref keeps the subtitle elsewhere.
 *
 * The test is asymmetric on purpose:
 *   - at least 70% of the SOURCE's title words must be in the registered
 *     title — the source's title is what the student will cite, so most of it
 *     has to be this work's; and
 *   - the shared words must cover at least 40% of the REGISTERED title — so a
 *     two-word title ("Teenage Sleep") cannot claim a long paper that merely
 *     contains those words; and
 *   - at least two words shared, unless a title has only one.
 * Measured on the cases it has to separate (test/sourceEnrich.test.js): the
 * model's main title alone (100% / 78%), a search engine's truncated title
 * (100% / 44%) and a light paraphrase (80% / 44%) pass; a different paper on
 * the same topic sharing four topical words (67% / 44%) and an unrelated work
 * (0%) fail. The rule it replaced — one shared word of five letters — passed
 * all five. */
const TITLE_STOP = new Set("about above after among and are been before being between but by can did does for from had has have how into its not of off on onto or our out over per than that the their them then there these they this those through to under upon via versus was were what when where which while who why will with within without you your".split(" "));
function titleWords(t) {
  const folded = String(t ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return new Set((folded.match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => (w.length >= 3 || /\d/.test(w)) && !TITLE_STOP.has(w)));
}
function titleVariants(t) {
  const full = String(t ?? "").trim();
  const main = full.split(/\s*[:|]\s+|\s+[—–-]\s+/)[0].trim();
  return main && main !== full ? [full, main] : [full];
}
/** Do these two titles name the same work? Pure; see the comment above for the thresholds. */
export function titlesMatch(sourceTitle, registeredTitle) {
  for (const a of titleVariants(sourceTitle)) {
    for (const b of titleVariants(registeredTitle)) {
      const A = titleWords(a), B = titleWords(b);
      if (!A.size || !B.size) continue;
      let shared = 0;
      for (const w of A) if (B.has(w)) shared++;
      if (shared >= Math.min(2, A.size, B.size) && shared / A.size >= 0.7 && shared / B.size >= 0.4) return true;
    }
  }
  return false;
}
/** A title that is really a placeholder (the URL, as a harvested search citation carries): nothing to compare. */
const placeholderTitle = (t) => !String(t ?? "").trim() || /^https?:\/\//i.test(String(t).trim());
/**
 * Is the registered record this source's work? `registered` is { title, year }.
 * "unknown" when the source has no real title to compare (the record is then
 * trusted, as before); otherwise true or false. Years must be within one of
 * each other when both are stated (online-first and print years differ by
 * one; two different works usually differ by more).
 */
export function sameWork(source, registered) {
  const y1 = source?.year, y2 = registered?.year;
  if (Number.isInteger(y1) && Number.isInteger(y2) && Math.abs(y1 - y2) > 1) return false;
  if (!registered?.title || placeholderTitle(source?.title)) return "unknown";
  return titlesMatch(source.title, registered.title);
}

/* ── is it retracted? ─────────────────────────────────────────────────────
 * Crossref, measured live 2026-10-07 (test/fixtures/retraction): Wakefield
 * 1998 carries `updated-by: [{ type: "retraction", source: "retraction-watch" }]`
 * beside a correction; the Surgisphere paper (2020) carries both `update-to`
 * and `updated-by` entries of type "retraction"; the Lancet's 2010 notice
 * carries `update-to: [{ type: "retraction" }]` — a notice is not a work a
 * student cites for a claim, and OpenAlex marks it is_retracted too. No live
 * record carried a retraction under `relation` (seen: {} and "has-review"),
 * but a relation type naming a retraction is read as one. Corrections and
 * expressions of concern are not retractions. */
const RETRACTION_TYPE = /^(?:partial_)?retraction$|^withdrawal$|^removal$/;
export function retractedInCrossref(message) {
  if (!message || typeof message !== "object") return false;
  const updates = [message["updated-by"], message["update-to"]].flatMap((x) => (Array.isArray(x) ? x : []));
  if (updates.some((u) => RETRACTION_TYPE.test(String(u?.type ?? "").toLowerCase().replace(/[\s-]+/g, "_")))) return true;
  const rel = message.relation && typeof message.relation === "object" ? message.relation : {};
  return Object.keys(rel).some((k) => /retract/i.test(k));
}
/** NCBI esummary's publication types: "Retracted Publication" on the retracted paper (Wakefield 1998, live). */
export function retractedInEsummary(rec) {
  return Array.isArray(rec?.pubtype) && rec.pubtype.some((t) => /^retracted publication$/i.test(String(t).trim()));
}

/** Crossref's `message` for one work → the citation fields the clients read. Pure. */
export function fieldsFromCrossref(message) {
  if (!message || typeof message !== "object") return null;
  const out = {};
  const people = (message.author ?? []).filter((a) => a && (a.given || a.family));
  const authors = people.map((a) => `${a.given ?? ""} ${a.family ?? ""}`.replace(/\s+/g, " ").trim()).filter(Boolean);
  const orgs = (message.author ?? []).filter((a) => a && a.name && !a.given && !a.family).map((a) => String(a.name));
  if (authors.length) out.authors = authors.slice(0, 30);
  else if (orgs.length) { out.authors = []; out.groupAuthor = orgs[0].slice(0, 150); }
  const parts = message.issued?.["date-parts"]?.[0] ?? message["published-print"]?.["date-parts"]?.[0] ?? message["published-online"]?.["date-parts"]?.[0] ?? message.published?.["date-parts"]?.[0];
  if (Array.isArray(parts) && Number.isInteger(parts[0]) && parts[0] >= 1500) {
    out.year = parts[0];
    if (Number.isInteger(parts[1]) && Number.isInteger(parts[2])) out.date = `${parts[0]}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`;
  }
  const container = String(message["container-title"]?.[0] ?? "").trim();
  if (container) out.container = container.slice(0, 200);
  if (message.publisher) out.publisher = String(message.publisher).trim().slice(0, 100);
  const title = String(message.title?.[0] ?? "").trim();
  if (title) out.crossrefTitle = title.slice(0, 200);
  if (message.DOI) out.doi = String(message.DOI).toLowerCase();
  const type = String(message.type ?? "");
  if (/journal-article|proceedings-article/.test(type)) out.kind = "journal";
  else if (/^book|monograph|edited-book|reference-book/.test(type)) out.kind = "book";
  else if (/book-chapter|book-section|book-part/.test(type)) out.kind = "book";
  else if (/report|posted-content/.test(type)) out.kind = "report";
  if (message.volume) out.volume = String(message.volume).slice(0, 20);
  if (message.issue) out.issue = String(message.issue).slice(0, 20);
  if (message.page) out.pages = String(message.page).slice(0, 30);
  return Object.keys(out).length ? out : null;
}

/* One registrar record → { fields, retracted }, or null when it does not answer. */
async function lookup(doi, { fetchImpl, signal }) {
  const res = await fetchImpl(`${CROSSREF_API}${encodeURIComponent(doi)}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const fields = fieldsFromCrossref(json?.message);
  return fields ? { fields, retracted: retractedInCrossref(json?.message) } : null;
}

async function lookupPubMed(pmid, { fetchImpl, signal }) {
  const res = await fetchImpl(`${ESUMMARY_API}${encodeURIComponent(pmid)}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const rec = json?.result?.[pmid];
  const summary = fieldsFromEsummary(rec);
  if (!summary) return null;
  // The registrar's record has full names where esummary has "Yip T".
  const registered = summary.doi ? await lookup(summary.doi, { fetchImpl, signal }).catch(() => null) : null;
  return {
    fields: registered ? { ...summary, ...registered.fields } : summary,
    retracted: retractedInEsummary(rec) || Boolean(registered?.retracted),
  };
}

/**
 * Sources in, the same sources out, each DOI-bearing one filled from Crossref
 * where the lookup answered in time and the record is the source's own work
 * (sameWork). Never throws. `fetchImpl` is injectable so tests never touch
 * the network. On the result:
 *   enriched  — how many sources changed, for the route's log line;
 *   rejected  — how many records named another work (their DOI is dropped);
 *   mixed     — sources whose LINK is that other work (a doi.org or PubMed
 *               URL under another title): the caller drops them;
 *   retracted — sources the registrar or PubMed records as retracted: the
 *               caller drops them.
 */
export async function enrichSources(sources, { fetchImpl = globalThis.fetch, deadlineMs = ENRICH_DEADLINE_MS } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const out = { sources: list, enriched: 0, rejected: 0, mixed: [], retracted: [] };
  const jobs = list.map((s) => ({ s, doi: doiOf(s), pmid: doiOf(s) ? "" : pmidOf(s) })).filter((j) => j.doi || j.pmid);
  if (!jobs.length || typeof fetchImpl !== "function") return out;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadlineMs);
  try {
    const results = await Promise.allSettled(jobs.map((j) => (j.doi ? lookup(j.doi, { fetchImpl, signal: ctrl.signal }) : lookupPubMed(j.pmid, { fetchImpl, signal: ctrl.signal }))));
    results.forEach((r, i) => {
      if (r.status !== "fulfilled" || !r.value) return;
      const { fields: { crossrefTitle, ...fields }, retracted } = r.value;
      const { s, doi, pmid } = jobs[i];
      const same = sameWork(s, { title: crossrefTitle, year: fields.year });
      if (same === false) {
        // Another work's record: none of it is applied, and the DOI that led
        // to it is dropped so nothing downstream reads that work as this one.
        out.rejected++;
        const named = doi || String(fields.doi ?? "");
        if (named) Object.defineProperty(s, DOI_REJECTED, { value: named, enumerable: false, configurable: true, writable: true });
        if (named && s.doi && String(s.doi).toLowerCase().includes(named.toLowerCase())) delete s.doi;
        const url = String(s.url ?? "");
        const linkNamesIt = pmid || (DOI_ORG_URL.test(url) && doiOf({ url }).toLowerCase() === named.toLowerCase());
        if (linkNamesIt) out.mixed.push(s);
        return;
      }
      if (retracted) { out.retracted.push(s); return; }
      for (const [k, v] of Object.entries(fields)) {
        // Crossref is the registrar; it wins on every field it states. Empty
        // model fields ("" / [] / null) are filled, stated ones replaced.
        s[k] = v;
      }
      // A harvested citation's "title" is its URL: the registered title is the real one.
      if (same === "unknown" && crossrefTitle && placeholderTitle(s.title)) s.title = crossrefTitle;
      if (!("editors" in s) && fields.container) s.editors = [];
      out.enriched++;
    });
  } finally {
    clearTimeout(timer);
  }
  return out;
}
