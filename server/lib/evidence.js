/**
 * Free evidence retrieval — the "fan out for evidence" pipeline.
 * Every provider is free and keyless; a slow or broken index returns [] and is
 * recorded under searched.failed — a provider failure must never take down the
 * sweep, and "searched and found nothing" must stay distinguishable from
 * "could not search" (failures are listed, and strength is null — not 0 —
 * when nothing clears the relevance floor).
 *
 * gatherEvidence({ claim, query, claimType }) →
 *   { sources: [{ doi, title, authors[], year, venue, venueType, url, abstract, provider, oaUrl, relevance, metric, citable }],
 *     strength: { score, breakdown, metric } | null,
 *     searched: { providers: [], failed: [], aboveFloor, citableAboveFloor, outsideIndex } }
 *
 * The relevance metric is CARRIED ALONGSIDE the value ("lexical") because the
 * floor and thresholds differ per metric — a dense-embedding metric would need
 * its own floor (see shared/marks.js RELEVANCE_FLOOR_LEXICAL).
 */
import { GUARDS } from "../shared/guards.js";
import { RELEVANCE_FLOOR_LEXICAL } from "../shared/marks.js";

const USER_AGENT = "Tracely/1.0 (local; mailto:tracely@localhost)";
const HEADERS = { "User-Agent": USER_AGENT, Accept: "application/json" };

// ── small pure helpers ─────────────────────────────────────────────────

/** Lowercase and strip the resolver prefix so "https://doi.org/10.1/X" == "10.1/x". */
export function normalizeDoi(doi) {
  if (!doi) return null;
  const norm = String(doi).trim().toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "");
  return norm || null;
}

function normTitle(title) {
  return String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function stripMarkup(s) {
  if (!s) return null;
  const text = String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 2000) : null;
}

/**
 * venueType from provider metadata: journal | book | chapter | web | report |
 * news | encyclopedia. Explicit type strings (Crossref/OpenAlex) win; then
 * provider defaults (PubMed indexes journals, Wikipedia is an encyclopedia,
 * World Bank documents are reports, Open Library holds books); Semantic
 * Scholar has no type field so a named venue is read as a journal. Default "web".
 */
export function classifyVenueType({ provider, type, venue } = {}) {
  const t = String(type ?? "").toLowerCase();
  if (t) {
    if (/^(journal-article|article|proceedings-article|journal|review)$/.test(t)) return "journal";
    if (/^(book-chapter|chapter|book-part|book-section)$/.test(t)) return "chapter";
    if (/^(book|monograph|edited-book|reference-book)$/.test(t)) return "book";
    if (/^(report|report-component|tech-report)$/.test(t)) return "report";
    if (/^(news|news-article)$/.test(t)) return "news";
    if (/^(encyclopedia|encyclopedia-entry|reference-entry)$/.test(t)) return "encyclopedia";
  }
  if (provider === "pubmed") return "journal";
  if (provider === "wikipedia") return "encyclopedia";
  if (provider === "worldbank") return "report";
  if (provider === "openlibrary") return "book";
  if (provider === "semanticscholar" && venue) return "journal";
  return "web";
}

const CITABLE_VENUE_TYPES = new Set(["journal", "book", "chapter", "report", "news"]);

/** Encyclopedias are never citable; otherwise a DOI or a real venue type is. */
export function isCitable(source) {
  if (!source || source.venueType === "encyclopedia") return false;
  return Boolean(source.doi) || CITABLE_VENUE_TYPES.has(source.venueType);
}

/**
 * Dedupe by normalized DOI, falling back to normalized title+year. First
 * occurrence wins (providers run in routing order); later duplicates backfill
 * fields the kept row is missing (abstract, DOI, oaUrl…) and may upgrade a
 * default "web" venueType to something more specific.
 */
export function dedupeSources(sources) {
  const out = [];
  const byKey = new Map();
  for (const s of sources) {
    if (!s || !s.title) continue;
    const doiKey = s.doi ? `doi:${normalizeDoi(s.doi)}` : null;
    const titleKey = `t:${normTitle(s.title)}|${s.year ?? ""}`;
    const existing = (doiKey && byKey.get(doiKey)) || byKey.get(titleKey);
    if (existing) {
      for (const k of ["doi", "abstract", "oaUrl", "venue", "year", "url"]) {
        if (existing[k] == null && s[k] != null) existing[k] = s[k];
      }
      if ((existing.authors ?? []).length === 0 && (s.authors ?? []).length > 0) existing.authors = s.authors;
      if (existing.venueType === "web" && s.venueType && s.venueType !== "web") existing.venueType = s.venueType;
      if (doiKey) byKey.set(doiKey, existing);
      byKey.set(titleKey, existing);
      if (existing.doi) byKey.set(`doi:${normalizeDoi(existing.doi)}`, existing);
      continue;
    }
    byKey.set(titleKey, s);
    if (doiKey) byKey.set(doiKey, s);
    out.push(s);
  }
  return out;
}

// ── lexical relevance ──────────────────────────────────────────────────

const STOPWORDS = new Set(("a an the and or but if then than that this these those of in on at to from by with for as is are was were be been being it its he she they them his her their we our you your i my me not no do does did have has had having will would can could should shall may might must about into over under between also such more most some any each which who whom whose what when where how why all both per vs via during after before while there here out up down only very just so because been").split(" "));

function tokenize(text) {
  return String(text ?? "").toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => (t.length > 1 || /\d/.test(t)) && !STOPWORDS.has(t));
}

// idf-lite without a corpus: rarity proxied deterministically — numbers carry
// the most weight (a matching figure is strong signal), longer tokens more
// than short common-ish ones. Pure and reproducible; no embedding model.
function tokenWeight(t) {
  if (/\d/.test(t)) return 2.5;
  return Math.min(t.length, 12) / 4;
}

/**
 * Weighted claim-side containment (Jaccard-ish overlap), metric "lexical".
 * 0..1: fraction of the claim's token weight found in the source text.
 * Callers must carry the metric alongside the value — the floor differs per metric.
 */
export function lexicalRelevance(claim, sourceText) {
  const claimTokens = [...new Set(tokenize(claim))];
  if (claimTokens.length === 0) return 0;
  const sourceSet = new Set(tokenize(sourceText));
  if (sourceSet.size === 0) return 0;
  let matched = 0;
  let total = 0;
  for (const t of claimTokens) {
    const w = tokenWeight(t);
    total += w;
    if (sourceSet.has(t)) matched += w;
  }
  return total === 0 ? 0 : Math.round((matched / total) * 10_000) / 10_000;
}

// ── strength ───────────────────────────────────────────────────────────

const VENUE_QUALITY = { journal: 25, chapter: 25, book: 18, report: 18, news: 10, web: 6, encyclopedia: 2 };

/**
 * Deterministic strength over the ABOVE-FLOOR set only (caller filters).
 * Returns null for an empty set: "searched and found nothing" must never
 * render as a 0-score finding. Each breakdown part is 0-25:
 *   sourceCount   round(min(n,4) * 6.25)          → 0,6,13,19,25
 *   venueQuality  best above-floor source's venue class
 *   recency       newest year: ≤5y=25 → ≥60y=3 (linear), missing year=8
 *   relevanceRank top relevance × 25
 */
export function strengthScore(aboveFloorSources, { nowYear = new Date().getFullYear() } = {}) {
  const list = Array.isArray(aboveFloorSources) ? aboveFloorSources : [];
  if (list.length === 0) return null;

  const sourceCount = Math.round(Math.min(list.length, 4) * 6.25);
  const venueQuality = Math.max(...list.map((s) => VENUE_QUALITY[s.venueType] ?? VENUE_QUALITY.web));

  const years = list.map((s) => s.year).filter((y) => Number.isFinite(y));
  let recency;
  if (years.length === 0) {
    recency = 8;
  } else {
    const age = nowYear - Math.max(...years);
    if (age <= 5) recency = 25;
    else if (age >= 60) recency = 3;
    else recency = Math.round(25 - (age - 5) * ((25 - 3) / (60 - 5)));
  }

  const topRelevance = Math.max(...list.map((s) => s.relevance ?? 0));
  const relevanceRank = Math.round(Math.max(0, Math.min(1, topRelevance)) * 25);

  const breakdown = { sourceCount, venueQuality, recency, relevanceRank };
  const score = Math.max(0, Math.min(100, sourceCount + venueQuality + recency + relevanceRank));
  return { score, metric: "lexical", breakdown };
}

// ── routing ────────────────────────────────────────────────────────────

// Simple keyword gate for the PubMed route. False positives are cheap (one
// extra free search); false negatives just mean the core three answer alone.
const BIOMEDICAL_RE = /\b(disease|drug|drugs|clinical|gene|genes|genetic|genome|cancer|vaccin\w*|protein|patient|patients|symptom|symptoms|diagnos\w*|therap\w*|tumou?r|virus|viral|bacteri\w*|infection|infectious|epidemi\w*|pandemic|mortality|dose|dosage|placebo|medicine|medical|medication|immune|immunity|cardiovascular|diabetes|obesity|antibiotic\w*|surgery|neuro\w*)\b/i;

/**
 * Routing ADDS providers, never replaces: OpenAlex + Crossref + Semantic
 * Scholar always run; claimType "statistic" adds World Bank; a biomedical
 * keyword adds PubMed; every claim also gets Wikipedia on the general tier.
 */
export function routeProviders({ claim, query, claimType } = {}) {
  const names = ["openalex", "crossref", "semanticscholar"];
  const text = `${claim ?? ""} ${query ?? ""}`;
  if (BIOMEDICAL_RE.test(text)) names.push("pubmed");
  if (claimType === "statistic") names.push("worldbank");
  names.push("wikipedia");
  return names;
}

// ── outsideIndex heuristic ─────────────────────────────────────────────

// Documented heuristic, kept deliberately simple: scholarly indexes lag on
// (a) current events — an explicit year within the last two, or breaking-news
// phrasing; (b) pop culture; (c) local/regional specifics. Only combined with
// "nothing citable came back" does it become outsideIndex — a covered claim
// that found citable sources is never flagged.
const RECENT_PHRASES_RE = /\b(yesterday|today|this (week|month|year)|last (week|month)|recently|breaking|just (announced|released)|announced)\b/i;
const POP_CULTURE_RE = /\b(movie|film|album|song|singer|rapper|band|actor|actress|celebrity|tv (show|series)|netflix|tiktok|instagram|youtube|youtuber|influencer|video game|grammy|oscar|box office|billboard|premiere)\b/i;
const LOCAL_RE = /\b(my (town|city|school|neighborhood|state)|local|city council|mayor|county|downtown|hometown|high school|school district)\b/i;

function looksOutsideIndex(text, nowYear) {
  const t = String(text ?? "");
  const yearMentions = [...t.matchAll(/\b(19|20)\d\d\b/g)].map((m) => Number(m[0]));
  const currentEvents = yearMentions.some((y) => y >= nowYear - 1) || RECENT_PHRASES_RE.test(t);
  return currentEvents || POP_CULTURE_RE.test(t) || LOCAL_RE.test(t);
}

// ── providers ──────────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(GUARDS.providerTimeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function invertAbstract(idx) {
  if (!idx || typeof idx !== "object") return null;
  const words = [];
  for (const [word, positions] of Object.entries(idx)) {
    for (const p of positions ?? []) words[p] = word;
  }
  const text = words.filter(Boolean).join(" ").trim();
  return text ? text.slice(0, 2000) : null;
}

async function searchOpenAlex(q) {
  const data = await fetchJson(`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=6`);
  return (data.results ?? []).map((w) => ({
    doi: normalizeDoi(w.doi),
    title: w.display_name ?? w.title ?? "",
    authors: (w.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year ?? null,
    venue: w.primary_location?.source?.display_name ?? null,
    venueType: classifyVenueType({ provider: "openalex", type: w.type, venue: w.primary_location?.source?.display_name }),
    url: w.doi ?? w.id ?? null,
    abstract: invertAbstract(w.abstract_inverted_index),
    provider: "openalex",
    oaUrl: w.open_access?.oa_url ?? null,
  })).filter((s) => s.title);
}

function crossrefItemToSource(item) {
  return {
    doi: normalizeDoi(item.DOI),
    title: item.title?.[0] ?? "",
    authors: (item.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
    year: item.issued?.["date-parts"]?.[0]?.[0] ?? null,
    venue: item["container-title"]?.[0] ?? item.publisher ?? null,
    venueType: classifyVenueType({ provider: "crossref", type: item.type, venue: item["container-title"]?.[0] }),
    url: item.URL ?? null,
    abstract: stripMarkup(item.abstract),
    provider: "crossref",
    oaUrl: null,
  };
}

async function searchCrossref(q) {
  const data = await fetchJson(`https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=6`);
  return (data.message?.items ?? []).map(crossrefItemToSource).filter((s) => s.title);
}

async function searchSemanticScholar(q) {
  const data = await fetchJson(
    `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=6&fields=title,authors,year,venue,externalIds,abstract,openAccessPdf`
  );
  return (data.data ?? []).map((p) => ({
    doi: normalizeDoi(p.externalIds?.DOI),
    title: p.title ?? "",
    authors: (p.authors ?? []).map((a) => a.name).filter(Boolean),
    year: p.year ?? null,
    venue: p.venue || null,
    venueType: classifyVenueType({ provider: "semanticscholar", venue: p.venue }),
    url: p.externalIds?.DOI ? `https://doi.org/${normalizeDoi(p.externalIds.DOI)}` : null,
    abstract: stripMarkup(p.abstract),
    provider: "semanticscholar",
    oaUrl: p.openAccessPdf?.url ?? null,
  })).filter((s) => s.title);
}

// PubMed: esearch then esummary (two requests). esummary carries NO abstract —
// documented gap: fetching abstracts would cost a further efetch per result,
// so PubMed sources score relevance on title alone.
async function searchPubMed(q) {
  const es = await fetchJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=5&term=${encodeURIComponent(q)}`
  );
  const ids = es.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];
  const sum = await fetchJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`
  );
  return ids.map((id) => {
    const r = sum.result?.[id];
    if (!r || !r.title) return null;
    const year = Number.parseInt(String(r.pubdate ?? "").slice(0, 4), 10);
    return {
      doi: normalizeDoi((r.articleids ?? []).find((a) => a.idtype === "doi")?.value),
      title: stripMarkup(r.title) ?? "",
      authors: (r.authors ?? []).map((a) => a.name).filter(Boolean),
      year: Number.isFinite(year) ? year : null,
      venue: r.fulljournalname || r.source || null,
      venueType: "journal",
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      abstract: null, // esummary has none; see note above
      provider: "pubmed",
      oaUrl: null,
    };
  }).filter(Boolean);
}

async function searchWikipedia(q) {
  const data = await fetchJson(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=3`);
  return (data.pages ?? []).map((p) => ({
    doi: null,
    title: p.title ?? "",
    authors: [],
    year: null,
    venue: "Wikipedia",
    venueType: "encyclopedia", // NOT citable — background only
    url: p.key ? `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}` : null,
    abstract: stripMarkup([p.description, p.excerpt].filter(Boolean).join(". ")),
    provider: "wikipedia",
    oaUrl: null,
  })).filter((s) => s.title);
}

async function searchWorldBank(q) {
  const data = await fetchJson(`https://search.worldbank.org/api/v3/wds?qterm=${encodeURIComponent(q)}&rows=3&format=json`);
  const docs = data.documents ?? {};
  const out = [];
  for (const [key, d] of Object.entries(docs)) {
    if (key === "facets" || !d || typeof d !== "object") continue;
    const title = stripMarkup(d.display_title ?? d.title);
    if (!title) continue;
    const year = Number.parseInt(String(d.docdt ?? "").slice(0, 4), 10);
    out.push({
      doi: null,
      title,
      authors: [],
      year: Number.isFinite(year) ? year : null,
      venue: "World Bank",
      venueType: "report",
      url: d.pdfurl ?? d.url ?? null,
      abstract: stripMarkup(d.abstracts?.["cdata!"] ?? d.abstract) ?? null,
      provider: "worldbank",
      oaUrl: d.pdfurl ?? null,
    });
  }
  return out;
}

const PROVIDERS = {
  openalex: searchOpenAlex,
  crossref: searchCrossref,
  semanticscholar: searchSemanticScholar,
  pubmed: searchPubMed,
  wikipedia: searchWikipedia,
  worldbank: searchWorldBank,
};

// Failure (timeout, bad status, unparseable body) → [] plus a failed record.
// A provider that answers with zero results still counts as responded.
async function runProvider(name, q) {
  try {
    const sources = await PROVIDERS[name](q);
    return { name, ok: true, sources };
  } catch {
    return { name, ok: false, sources: [] };
  }
}

// ── the pipeline ───────────────────────────────────────────────────────

export async function gatherEvidence({ claim, query, claimType } = {}) {
  const claimText = String(claim ?? "").trim();
  const q = String(query ?? "").trim() || claimText;
  const nowYear = new Date().getFullYear();
  const names = routeProviders({ claim: claimText, query: q, claimType });

  const results = await Promise.all(names.map((name) => runProvider(name, q)));
  const responded = results.filter((r) => r.ok).map((r) => r.name);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);

  const sources = dedupeSources(results.flatMap((r) => r.sources));
  // Rank against the claim PLUS the query: the query carries resolved
  // referents ("Einstein") that the claim text may hold only as a pronoun
  // ("He was famous for…"), and ranking on the pronoun form rewards sources
  // about the wrong subject entirely.
  const rankText = q === claimText ? claimText : `${claimText} ${q}`;
  for (const s of sources) {
    s.relevance = lexicalRelevance(rankText, `${s.title} ${s.abstract ?? ""}`);
    s.metric = "lexical"; // carried alongside — thresholds differ per metric
    s.citable = isCitable(s);
  }
  sources.sort((a, b) => (b.relevance - a.relevance) || String(a.title).localeCompare(String(b.title)));

  const aboveFloorList = sources.filter((s) => s.relevance >= RELEVANCE_FLOOR_LEXICAL);
  const citableAboveFloor = aboveFloorList.filter((s) => s.citable).length;
  const citableAnywhere = sources.some((s) => s.citable);

  // null, not 0: nothing above the floor is an empty state ("here is what was
  // searched"), not a zero-score finding.
  const strength = strengthScore(aboveFloorList, { nowYear });
  const outsideIndex = !citableAnywhere && looksOutsideIndex(`${claimText} ${q}`, nowYear);

  return {
    sources,
    strength,
    searched: {
      providers: responded,
      failed,
      aboveFloor: aboveFloorList.length,
      citableAboveFloor,
      outsideIndex,
    },
  };
}

// ── compareSource: resolve the writer's OWN citation string ────────────

async function crossrefBibliographic(ref) {
  const data = await fetchJson(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(ref)}&rows=3`);
  return (data.message?.items ?? []).map(crossrefItemToSource).filter((s) => s.title);
}

async function openLibrarySearch(ref) {
  const data = await fetchJson(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(ref)}&limit=3&fields=title,author_name,first_publish_year,key`
  );
  return (data.docs ?? []).map((d) => ({
    doi: null,
    title: d.title ?? "",
    authors: d.author_name ?? [],
    year: d.first_publish_year ?? null,
    venue: null,
    venueType: "book",
    url: d.key ? `https://openlibrary.org${d.key}` : null,
    abstract: null,
    provider: "openlibrary",
    oaUrl: null,
  })).filter((s) => s.title);
}

// Compare-specific resolve floor (lexical metric). Deliberately stricter than
// RELEVANCE_FLOOR_LEXICAL: a genuine hit for the writer's own reference should
// repeat most of the reference's title/author tokens, while Crossref's fuzzy
// bibliographic search returns SOMETHING for nearly any text-like string —
// unrelated hits on fabricated refs score well below this line once years are
// excluded from scoring.
export const COMPARE_RESOLVE_FLOOR = 0.5;

/* ── authorWorks: who "(Shiraishi)" could mean ───────────────────────────
 * A citation that names only a person names no work, and no lookup can say
 * which work it meant. Owner, 2026-10-08, on "(Shiraishi)" in a Mongol
 * Empire essay: what can still be said is whether that person has published
 * on the essay's SUBJECT, and what. Crossref (query.author, ranked by
 * query.bibliographic = the subject words) and Open Library (author + q),
 * kept only where one of the work's authors has that FAMILY name (accents and
 * case folded — Crossref's author search is fuzzy), and only where the title
 * or its venue shares a subject word (a common surname has works on every
 * subject). Word match is by the first five letters, so "Mongol" finds
 * "Mongoru" and "Mongolian". At most five records, each the index's own; none
 * of this says a work backs the sentence — the extension says which titles
 * share the claim's own words, and nothing more. */
const foldName = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const stem5 = (w) => w.slice(0, 5);
// Words too general to tie a namesake's work to the essay on their own: a
// "Trade Credit" paper and an "Empire, Rogue States" paper are not the Mongol
// Empire essay's subject. They still count beside a specific word.
const GENERAL_SUBJECT = new Set("empire empires trade history histories world people state states society culture cultures economy economic government power century period region country nation nations policy politics religion science health education school schools students language languages war wars city cities land family women children life".split(" ").map(stem5));
function subjectHit(text, subject) {
  const have = new Set((foldName(text).match(/\p{L}{4,}/gu) ?? []).map(stem5));
  const shared = subject.map(stem5).filter((w) => have.has(w));
  return shared.some((w) => !GENERAL_SUBJECT.has(w)) || new Set(shared).size >= 2;
}
export async function authorWorks({ author, topic } = {}) {
  const name = String(author ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const subject = [...new Set(foldName(topic).match(/\p{L}{4,}/gu) ?? [])].slice(0, 6);
  if (!name) return { author: "", subject, works: [] };
  const want = foldName(name);
  const q = subject.join(" ");
  const [cr, ol] = await Promise.all([
    fetchJson(`https://api.crossref.org/works?query.author=${encodeURIComponent(name)}${q ? `&query.bibliographic=${encodeURIComponent(q)}` : ""}&rows=20&select=DOI,title,author,issued,container-title,type,URL,publisher`)
      .then((d) => (d.message?.items ?? []).filter((it) => (it.author ?? []).some((a) => foldName(a.family) === want)).map(crossrefItemToSource))
      .catch(() => []),
    fetchJson(`https://openlibrary.org/search.json?author=${encodeURIComponent(name)}${q ? `&q=${encodeURIComponent(q)}` : ""}&limit=10&fields=title,author_name,first_publish_year,key`)
      .then((d) => (d.docs ?? []).filter((x) => (x.author_name ?? []).some((a) => foldName(String(a).split(/\s+/).pop()) === want)).map((x) => ({
        doi: null, title: x.title ?? "", authors: x.author_name ?? [], year: x.first_publish_year ?? null, venue: null, venueType: "book",
        url: x.key ? `https://openlibrary.org${x.key}` : null, abstract: null, provider: "openlibrary", oaUrl: null,
      })))
      .catch(() => []),
  ]);
  const works = dedupeSources([...cr, ...ol])
    .filter((w) => w.title && (!subject.length || subjectHit(`${w.title} ${w.venue ?? ""}`, subject)))
    .slice(0, 5);
  return { author: name, subject, works };
}

// Crossref holds journal articles (and some books); Open Library holds books.
// Government reports, news pages, and most websites are in NEITHER index, so
// a no-confident-match result must NEVER be reported as "this source is fake"
// — the resolvedNote carries that caveat to every surface that renders it.
export async function compareSource({ citedRef } = {}) {
  const ref = String(citedRef ?? "").trim();
  const [cr, ol] = await Promise.all([
    crossrefBibliographic(ref).catch(() => []),
    openLibrarySearch(ref).catch(() => []),
  ]);
  const matches = dedupeSources([...cr, ...ol]);
  // Score WITHOUT years on either side: a coincidental year match carries the
  // heaviest token weight and would let junk hits inflate their relevance.
  // (The raw ref is untouched — only the scoring copy is stripped.)
  const scoreRef = ref.replace(/\b(?:1[89]|20)\d{2}\b/g, " ");
  for (const m of matches) {
    m.relevance = lexicalRelevance(scoreRef, `${m.title} ${(m.authors ?? []).join(" ")}`);
    m.metric = "lexical";
    m.citable = isCitable(m);
  }
  matches.sort((a, b) => (b.relevance - a.relevance) || String(a.title).localeCompare(String(b.title)));

  const strong = matches.filter((m) => m.relevance >= COMPARE_RESOLVE_FLOOR);
  const nearMisses = matches.filter((m) => m.relevance < COMPARE_RESOLVE_FLOOR);
  const resolved = strong.length > 0;
  const result = { matches: strong, nearMisses, resolved };
  if (!resolved) {
    result.resolvedNote =
      (nearMisses.length > 0
        ? "No confident match in Crossref or Open Library — only loosely related items were found. "
        : "Not found in Crossref or Open Library. ") +
      "These indexes hold journal articles and books — " +
      "government reports, news pages, and many web sources are in neither, so no match does NOT mean the source is fake. " +
      "Verify it by hand instead.";
  }
  return result;
}
