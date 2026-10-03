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

/** The DOI a source names, normalised (no resolver prefix, no trailing punctuation), or "". */
export function doiOf(source) {
  const fromField = String(source?.doi ?? "").replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "").trim();
  const url = String(source?.url ?? "");
  const candidates = [[fromField, false], [url, !/^https?:\/\/(dx\.)?doi\.org\//i.test(url)]];
  for (const [c, fromPublisherPath] of candidates) {
    const m = c.match(DOI_RE);
    if (!m) continue;
    let doi = m[1].replace(/[.,;:)\]]+$/, "");
    // A publisher's path can continue past the DOI with its own article id
    // (OUP: /doi/10.1093/sleep/zsz307/5651364). A DOI suffix rarely ends in a
    // bare run of digits after a slash; the article id always does.
    if (fromPublisherPath) doi = doi.replace(/\/\d+$/, "");
    return doi;
  }
  return "";
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

async function lookup(doi, { fetchImpl, signal }) {
  const res = await fetchImpl(`${CROSSREF_API}${encodeURIComponent(doi)}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  return fieldsFromCrossref(json?.message);
}

async function lookupPubMed(pmid, { fetchImpl, signal }) {
  const res = await fetchImpl(`${ESUMMARY_API}${encodeURIComponent(pmid)}`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const summary = fieldsFromEsummary(json?.result?.[pmid]);
  if (!summary) return null;
  // The registrar's record has full names where esummary has "Yip T".
  const registered = summary.doi ? await lookup(summary.doi, { fetchImpl, signal }).catch(() => null) : null;
  return registered ? { ...summary, ...registered } : summary;
}

/**
 * Sources in, the same sources out, each DOI-bearing one filled from Crossref
 * where the lookup answered in time. Never throws. `fetchImpl` is injectable
 * so tests never touch the network; `enriched` on the result counts how many
 * sources changed, for the route's log line.
 */
export async function enrichSources(sources, { fetchImpl = globalThis.fetch, deadlineMs = ENRICH_DEADLINE_MS } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const jobs = list.map((s) => ({ s, doi: doiOf(s), pmid: doiOf(s) ? "" : pmidOf(s) })).filter((j) => j.doi || j.pmid);
  if (!jobs.length || typeof fetchImpl !== "function") return { sources: list, enriched: 0 };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadlineMs);
  let enriched = 0;
  try {
    const results = await Promise.allSettled(jobs.map((j) => (j.doi ? lookup(j.doi, { fetchImpl, signal: ctrl.signal }) : lookupPubMed(j.pmid, { fetchImpl, signal: ctrl.signal }))));
    results.forEach((r, i) => {
      if (r.status !== "fulfilled" || !r.value) return;
      const { crossrefTitle, ...fields } = r.value;
      const s = jobs[i].s;
      // The registered title confirms the DOI is this work and not a neighbour's: when
      // the two share no long word, the DOI the model wrote is not trusted.
      if (crossrefTitle && s.title && !sharesWord(crossrefTitle, s.title)) return;
      for (const [k, v] of Object.entries(fields)) {
        // Crossref is the registrar; it wins on every field it states. Empty
        // model fields ("" / [] / null) are filled, stated ones replaced.
        s[k] = v;
      }
      if (!("editors" in s) && fields.container) s.editors = [];
      enriched++;
    });
  } finally {
    clearTimeout(timer);
  }
  return { sources: list, enriched };
}

const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9]{5,}/g) ?? []);
function sharesWord(a, b) {
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return true; // nothing to compare on: trust the DOI
  for (const w of wa) if (wb.has(w)) return true;
  return false;
}
