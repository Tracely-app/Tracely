/* The server completes a source's citation fields itself (lib/sourceEnrich.js,
 * factcheck.js completeSources) so the model need not open pages — the page
 * opens were 3 of every 8 billed web_search_call items on 2026-10-02. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doiOf, pmidOf, fieldsFromCrossref, fieldsFromEsummary, enrichSources, titlesMatch, sameWork, retractedInCrossref, retractedInEsummary } from "../lib/sourceEnrich.js";
import { findSources } from "../lib/factcheck.js";

// The page reader resolves every hostname before fetching (citeMeta.js
// safeFetch); with fetch stubbed, DNS is stubbed too — a public address.
import { setHostResolver } from "../lib/citeMeta.js";
test.before(() => setHostResolver(async () => [{ address: "93.184.216.34" }]));
test.after(() => setHostResolver(null));


const CR = (over = {}) => ({ message: { DOI: "10.1093/sleep/zsz307", type: "journal-article", title: ["Later school start times in a flexible system improve teenage sleep"],
  author: [{ given: "Eva C", family: "Winnebeck" }, { given: "Maria T", family: "Vuori-Brodowski" }], issued: { "date-parts": [[2019, 12, 10]] },
  "container-title": ["Sleep"], publisher: "Oxford University Press (OUP)", volume: "43", issue: "6", page: "zsz307", ...over } });

test("doiOf reads a DOI from the field, a doi.org URL or a publisher path, and strips resolver prefixes and trailing punctuation", () => {
  assert.equal(doiOf({ doi: "https://doi.org/10.1093/sleep/zsz307" }), "10.1093/sleep/zsz307");
  assert.equal(doiOf({ doi: "doi: 10.1016/j.sleh.2017.10.002." }), "10.1016/j.sleh.2017.10.002");
  assert.equal(doiOf({ url: "https://academic.oup.com/sleep/article/doi/10.1093/sleep/zsz307/5651364" }), "10.1093/sleep/zsz307");
  assert.equal(doiOf({ url: "https://doi.org/10.1016/S0140-6736(20)30183-5" }), "10.1016/S0140-6736(20)30183-5", "a doi.org URL is taken whole, parentheses included");
  assert.equal(doiOf({ url: "https://www.cdc.gov/sleep/about/index.html" }), "");
  assert.equal(doiOf(null), "");
});

test("fieldsFromCrossref maps people, issue date, journal, publisher, kind and the registered DOI; an organisation author becomes the group author", () => {
  const f = fieldsFromCrossref(CR().message);
  assert.deepEqual(f.authors, ["Eva C Winnebeck", "Maria T Vuori-Brodowski"]);
  assert.equal(f.year, 2019); assert.equal(f.date, "2019-12-10"); assert.equal(f.container, "Sleep"); assert.equal(f.kind, "journal");
  assert.equal(f.publisher, "Oxford University Press (OUP)"); assert.equal(f.doi, "10.1093/sleep/zsz307"); assert.equal(f.volume, "43");
  const org = fieldsFromCrossref(CR({ author: [{ name: "World Health Organization" }], type: "report" }).message);
  assert.deepEqual(org.authors, []); assert.equal(org.groupAuthor, "World Health Organization"); assert.equal(org.kind, "report");
  assert.equal(fieldsFromCrossref(null), null);
  assert.equal(fieldsFromCrossref({ issued: { "date-parts": [[null]] } }), null, "nothing stated → nothing returned");
});

test("enrichSources fills every DOI-bearing source from Crossref, replaces what the model guessed, and leaves the rest untouched", async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: true, json: async () => CR() }; };
  const list = [
    { title: "Later school start times improve teenage sleep", url: "https://doi.org/10.1093/sleep/zsz307", publisher: "OUP", snippet: "", stance: "supports", authors: ["E. Winnebeck"], year: 2020, date: "", container: "", editors: [], doi: "" },
    { title: "About Sleep", url: "https://www.cdc.gov/sleep/about/index.html", publisher: "CDC", snippet: "", stance: "context", authors: [], year: null },
  ];
  const r = await enrichSources(list, { fetchImpl });
  assert.equal(r.enriched, 1);
  assert.equal(seen.length, 1); assert.match(seen[0], /api\.crossref\.org\/works\/10\.1093%2Fsleep%2Fzsz307/);
  assert.deepEqual(list[0].authors, ["Eva C Winnebeck", "Maria T Vuori-Brodowski"]);
  assert.equal(list[0].year, 2019, "Crossref's issue year replaces the model's guess");
  assert.equal(list[0].container, "Sleep"); assert.equal(list[0].doi, "10.1093/sleep/zsz307"); assert.equal(list[0].kind, "journal");
  assert.equal(list[0].title, "Later school start times improve teenage sleep", "the model's title stays");
  assert.equal(list[1].year, null, "no DOI, not touched");
});

test("enrichSources refuses a DOI whose registered title is another work's, survives failures, and honours its deadline", async () => {
  const wrong = [{ title: "Finland literacy rate", url: "https://x.org/a", doi: "10.1093/sleep/zsz307", authors: [], year: null }];
  let r = await enrichSources(wrong, { fetchImpl: async () => ({ ok: true, json: async () => CR() }) });
  assert.equal(r.enriched, 0); assert.equal(wrong[0].year, null, "a DOI that resolves to another work is not trusted");
  assert.equal(r.rejected, 1);
  assert.ok(!("doi" in wrong[0]), "and the DOI that led there is dropped (source receipts, 2026-10-07)");
  assert.equal(doiOf(wrong[0]), "");
  const failing = [{ title: "t", url: "https://doi.org/10.1/abc", authors: [], year: null }];
  r = await enrichSources(failing, { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(r.enriched, 0);
  r = await enrichSources(failing, { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  assert.equal(r.enriched, 0);
  const slow = [{ title: "t", url: "https://doi.org/10.1/abc", authors: [], year: null }];
  const t0 = Date.now();
  r = await enrichSources(slow, { deadlineMs: 50, fetchImpl: (url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  assert.equal(r.enriched, 0); assert.ok(Date.now() - t0 < 1000, "the deadline, not the lookup, decides");
  // The result grew three fields with the receipts (rejected, mixed,
  // retracted): the caller drops the last two. Pinned deliberately.
  assert.deepEqual(await enrichSources([], {}), { sources: [], enriched: 0, rejected: 0, mixed: [], retracted: [] });
});

// ── the DOI guard: is the registered record this source's work? ───────────

test("titlesMatch: the main title, a truncated title and a light paraphrase pass; a neighbour on the same topic and an unrelated work do not", () => {
  const REG = "Later school start times in a flexible system improve teenage sleep";
  assert.equal(titlesMatch("Later school start times improve teenage sleep", REG), true, "the main idea, words dropped: 100% / 78%");
  assert.equal(titlesMatch("Later school start times in a…", REG), true, "a search engine's truncation: 100% / 44%");
  assert.equal(titlesMatch("School start times and teen sleep", REG), true, "a light paraphrase: 80% / 44%");
  assert.equal(titlesMatch("Later School Start Times in a Flexible System Improve Teenage Sleep: Evidence from a German High School", REG), true, "the subtitle the registrar keeps elsewhere");
  assert.equal(titlesMatch("Sleep duration and school start times in adolescents", REG), false, "a different paper sharing four topical words: 67% of its title");
  assert.equal(titlesMatch("Teenage sleep", REG), false, "two words of a long title: 22% of it");
  assert.equal(titlesMatch("Finland literacy rate", REG), false);
  assert.equal(titlesMatch("Sueño adolescente y horarios escolares", "Sueno adolescente y horarios escolares"), true, "accents folded");
  // What the old rule (one shared word of five letters or more) would have said:
  const oldRule = (a, b) => { const w = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9]{5,}/g) ?? []); const wb = w(b); return [...w(a)].some((x) => wb.has(x)); };
  assert.equal(oldRule("Sleep duration and school start times in adolescents", REG), true, "the neighbour used to pass");
});

test("sameWork: titles AND years — within one year when both are stated; a placeholder title is 'unknown'", () => {
  const reg = { title: "Later school start times in a flexible system improve teenage sleep", year: 2019 };
  assert.equal(sameWork({ title: "Later school start times improve teenage sleep", year: 2020 }, reg), true, "online-first vs print: one year apart");
  assert.equal(sameWork({ title: "Later school start times improve teenage sleep", year: 2016 }, reg), false, "the same words, three years apart: another work");
  assert.equal(sameWork({ title: "Later school start times improve teenage sleep", year: null }, reg), true, "missing year: the title decides");
  assert.equal(sameWork({ title: "Later school start times improve teenage sleep" }, { title: reg.title }), true, "no registered year: the title decides");
  assert.equal(sameWork({ title: "https://doi.org/10.1093/sleep/zsz307" }, reg), "unknown", "a harvested citation's title is its URL");
  assert.equal(sameWork({ title: "Finland literacy rate", year: 2019 }, reg), false);
});

test("enrichSources: a mismatched record is not applied; a doi.org or PubMed link to that other work is returned to be dropped; a year apart is a mismatch too", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => CR() });
  const linkIsOther = { title: "Finland literacy rate", url: "https://doi.org/10.1093/sleep/zsz307", authors: [], year: null };
  const fieldOnly = { title: "Finland literacy rate", url: "https://www.oph.fi/literacy", doi: "10.1093/sleep/zsz307", authors: [], year: null };
  const yearOff = { title: "Later school start times improve teenage sleep", url: "https://example.org/sleep", doi: "10.1093/sleep/zsz307", authors: [], year: 2015 };
  const r = await enrichSources([linkIsOther, fieldOnly, yearOff], { fetchImpl });
  assert.equal(r.enriched, 0); assert.equal(r.rejected, 3);
  assert.deepEqual(r.mixed, [linkIsOther], "the link IS the other work: no title can be cited over it");
  assert.equal(doiOf(fieldOnly), "", "the page stays; the DOI is gone");
  assert.equal(yearOff.year, 2015, "nothing of the record applied");
  assert.equal(JSON.stringify(fieldOnly).includes("zsz307"), false, "the rejection marker never serialises");
  const harvested = { title: "https://doi.org/10.1093/sleep/zsz307", url: "https://doi.org/10.1093/sleep/zsz307", publisher: "doi.org", snippet: "", stance: "context" };
  const h = await enrichSources([harvested], { fetchImpl });
  assert.equal(h.enriched, 1); assert.equal(harvested.title, "Later school start times in a flexible system improve teenage sleep", "a URL-for-a-title takes the registered one");
});

// ── retractions: the live records, pinned ────────────────────────────────

const LIVE = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "retraction", "live-2026-10-07.json"), "utf8"));

test("retractedInCrossref reads updated-by / update-to retraction entries exactly as the live API returned them", () => {
  const cr = LIVE.crossref;
  assert.equal(retractedInCrossref(cr.wakefield1998.message), true, "updated-by: [{ type: 'retraction', source: 'retraction-watch' }] beside a correction");
  assert.equal(retractedInCrossref(cr.surgisphere2020.message), true, "update-to and updated-by, publisher and Retraction Watch");
  assert.equal(retractedInCrossref(cr.wakefieldNotice2010.message), true, "the notice itself: update-to retraction");
  assert.equal(retractedInCrossref(cr.winnebeck2019.message), false, "an ordinary paper: relation {} and nothing else");
  const correctedOnly = { ...cr.wakefield1998.message, "updated-by": cr.wakefield1998.message["updated-by"].filter((u) => u.type !== "retraction") };
  assert.equal(retractedInCrossref(correctedOnly), false, "a correction is not a retraction");
  assert.equal(retractedInCrossref({ "updated-by": [{ type: "expression_of_concern" }] }), false, "nor an expression of concern");
  assert.equal(retractedInCrossref({ relation: { "is-retracted-by": [{ id: "10.1/x" }] } }), true, "a relation naming a retraction");
  assert.equal(retractedInCrossref({ "update-to": [{ type: "Withdrawal" }] }), true);
  assert.equal(retractedInCrossref(null), false);
  assert.deepEqual(Object.keys(cr.wakefield1998.message).filter((k) => /update|relation/.test(k)), ["updated-by", "relation"], "the field names the live record used");
});

test("retractedInEsummary reads PubMed's 'Retracted Publication' type (live, PMID 9500320)", () => {
  assert.equal(retractedInEsummary(LIVE.esummary.wakefield1998), true);
  assert.equal(retractedInEsummary({ pubtype: ["Journal Article"] }), false);
  assert.equal(retractedInEsummary(null), false);
});

test("enrichSources returns a retracted work to be dropped, by DOI and by PubMed link, and applies nothing of it", async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("esummary")) return { ok: true, json: async () => ({ result: { 9500320: LIVE.esummary.wakefield1998 } }) };
    if (u.includes("crossref")) return { ok: true, json: async () => LIVE.crossref.wakefield1998 };
    throw new Error("unexpected " + u);
  };
  const byDoi = { title: "Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children", url: "https://doi.org/10.1016/S0140-6736(97)11096-0", authors: [], year: 1998 };
  const byPmid = { title: "Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children", url: "https://pubmed.ncbi.nlm.nih.gov/9500320/", authors: [], year: null };
  const r = await enrichSources([byDoi, byPmid], { fetchImpl });
  assert.deepEqual(r.retracted, [byDoi, byPmid]);
  assert.equal(r.enriched, 0);
  assert.deepEqual(byDoi.authors, [], "nothing applied");
});

test("findSources drops a retracted source, whichever registry said so, even when it leaves fewer", async () => {
  const realFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  const none = { kind: "journal", authors: [], groupAuthor: "", year: null, date: "", container: "", editors: [], doi: "" };
  const model = { sources: [
    { ...none, title: "Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children", url: "https://doi.org/10.1016/S0140-6736(97)11096-0", publisher: "The Lancet", snippet: "s", stance: "supports" },
    { ...none, title: "Hydroxychloroquine or chloroquine with or without a macrolide for treatment of COVID-19: a multinational registry analysis", url: "https://www.thelancet.com/journals/lancet/article/PIIS0140-6736(20)31180-6/fulltext", doi: "10.1016/S0140-6736(20)31180-6", publisher: "The Lancet", snippet: "s", stance: "supports" },
  ] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.openai.com")) return new Response(JSON.stringify({ status: "completed", model: "gpt-5.6-luna", usage: { input_tokens: 10, output_tokens: 10 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(model), annotations: [] }] }] }), { status: 200 });
    // Crossref answers only for Wakefield; OpenAlex is what catches the other.
    if (u.includes("api.crossref.org") && u.includes("97")) return new Response(JSON.stringify(LIVE.crossref.wakefield1998), { status: 200 });
    if (u.includes("api.openalex.org")) return new Response(JSON.stringify(LIVE.openalex.surgisphere2020), { status: 200 });
    return new Response("", { status: 404 });
  };
  try {
    const r = await findSources({ claim: "Hydroxychloroquine raised mortality in hospitalised COVID-19 patients.", model: "gpt-5.6-luna" });
    assert.deepEqual(r.sources, [], "both gone: a retracted paper is never offered");
    assert.equal(r.retracted, 2);
  } finally { globalThis.fetch = realFetch; }
});

/* findSources end to end with a stubbed network: the model's answer (one
 * search, no page opened), then Crossref for the DOI source, the page for the
 * one without a year, and a 404 dropped. */
test("findSources completes the fields from Crossref and the page, drops a dead link, and keeps the count off the model's answer", async () => {
  const realFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  const model = { sources: [
    { title: "Later school start times in a flexible system improve teenage sleep", url: "https://doi.org/10.1093/sleep/zsz307", publisher: "Sleep", snippet: "s", stance: "supports", kind: "journal", authors: [], groupAuthor: "", year: null, date: "", container: "", editors: [], doi: "" },
    { title: "About Sleep", url: "https://www.cdc.gov/sleep/about/index.html", publisher: "CDC", snippet: "s", stance: "context", kind: "institutional", authors: [], groupAuthor: "", year: null, date: "", container: "", editors: [], doi: "" },
    { title: "Gone", url: "https://example.org/gone", publisher: "Example", snippet: "s", stance: "context", kind: "other", authors: [], groupAuthor: "", year: null, date: "", container: "", editors: [], doi: "" },
  ] };
  const html = `<html><head><title>About Sleep | CDC</title><meta property="og:site_name" content="CDC"><meta property="article:published_time" content="2024-05-15"><meta name="citation_author" content="Centers for Disease Control and Prevention"></head><body></body></html>`;
  const hits = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url); hits.push(u.slice(0, 40));
    if (u.includes("api.openai.com")) return new Response(JSON.stringify({ status: "completed", model: "gpt-5.6-luna", usage: { input_tokens: 10, output_tokens: 10 },
      output: [{ type: "web_search_call", status: "completed", action: { type: "search" } }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(model), annotations: [] }] }] }), { status: 200 });
    if (u.includes("api.crossref.org")) return new Response(JSON.stringify(CR()), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("cdc.gov")) return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    if (u.includes("example.org/gone")) return new Response("", { status: 404 });
    throw new Error("unexpected " + u);
  };
  try {
    const r = await findSources({ claim: "Later school start times improve adolescent sleep.", model: "gpt-5.6-luna", effort: "low" });
    assert.equal(r.webSearchCalls, 1);
    assert.equal(r.dropped, 1, "the 404 is gone");
    assert.equal(r.enriched, 2, "one from Crossref, one from the page");
    assert.equal(r.sources.length, 2);
    const [j, c] = r.sources;
    assert.deepEqual(j.authors, ["Eva C Winnebeck", "Maria T Vuori-Brodowski"]); assert.equal(j.year, 2019); assert.equal(j.doi, "10.1093/sleep/zsz307");
    assert.equal(c.year, 2024); assert.equal(c.date, "2024-05-15"); assert.equal(c.groupAuthor, "Centers for Disease Control and Prevention", "the page's own citation_author, validated by the reader — better than the model's \"CDC\"");
    assert.ok(hits.some((h) => h.includes("crossref")) && hits.some((h) => h.includes("cdc.gov")), "both completions ran");
    // The model is no longer asked to open pages, and is asked for one search.
    const sentBody = JSON.parse((await (async () => { let b; globalThis.fetch = async (u, i) => { if (String(u).includes("openai")) b = i.body; return new Response(JSON.stringify({ status: "completed", model: "m", usage: {}, output: [{ type: "message", content: [{ type: "output_text", text: "{\"sources\":[]}", annotations: [] }] }] }), { status: 200 }); }; await findSources({ claim: "x", model: "gpt-5.6-luna" }).catch(() => {}); return b; })()));
    assert.match(sentBody.instructions, /Run ONE web search/);
    assert.match(sentBody.instructions, /Do NOT open pages/);
    assert.equal(sentBody.max_output_tokens, 3000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("findSources with enrich:false touches no other host", async () => {
  const realFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  const hosts = [];
  globalThis.fetch = async (url) => { hosts.push(new URL(String(url)).hostname);
    return new Response(JSON.stringify({ status: "completed", model: "m", usage: {}, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ sources: [{ title: "t", url: "https://doi.org/10.1/x", publisher: "p", snippet: "", stance: "context", kind: "other", authors: [], groupAuthor: "", year: null, date: "", container: "", editors: [], doi: "" }] }), annotations: [] }] }] }), { status: 200 }); };
  try {
    const r = await findSources({ claim: "x", model: "gpt-5.6-luna", enrich: false });
    assert.deepEqual([...new Set(hosts)], ["api.openai.com"]); assert.equal(r.enriched, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("a PubMed link is completed through NCBI esummary, then Crossref for the full names; esummary alone when Crossref is silent", async () => {
  assert.equal(pmidOf({ url: "https://pubmed.ncbi.nlm.nih.gov/35593065/" }), "35593065");
  assert.equal(pmidOf({ url: "https://www.ncbi.nlm.nih.gov/pubmed/29157635" }), "29157635");
  assert.equal(pmidOf({ url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9665092/" }), "", "a PMC page is read by the page reader instead");
  const ES = { result: { uids: ["35593065"], 35593065: { title: "School Start Times, Sleep, and Youth Outcomes: A Meta-analysis", authors: [{ name: "Yip T", authtype: "Author" }, { name: "Wang Y", authtype: "Author" }], pubdate: "2022 Jun 1", fulljournalname: "Pediatrics", articleids: [{ idtype: "pubmed", value: "35593065" }, { idtype: "doi", value: "10.1542/peds.2021-054068" }] } } };
  const f = fieldsFromEsummary(ES.result["35593065"]);
  assert.deepEqual(f.authors, ["Yip T", "Wang Y"]); assert.equal(f.year, 2022); assert.equal(f.container, "Pediatrics"); assert.equal(f.doi, "10.1542/peds.2021-054068"); assert.equal(f.kind, "journal");
  assert.equal(fieldsFromEsummary({ error: "cannot get document summary" }), null);
  const CRX = { message: { DOI: "10.1542/peds.2021-054068", type: "journal-article", title: ["School Start Times, Sleep, and Youth Outcomes: A Meta-analysis"], author: [{ given: "Tiffany", family: "Yip" }, { given: "Yijie", family: "Wang" }], issued: { "date-parts": [[2022, 6, 1]] }, "container-title": ["Pediatrics"], publisher: "American Academy of Pediatrics (AAP)" } };
  const hits = [];
  const fetchImpl = async (url) => { hits.push(String(url)); if (String(url).includes("esummary")) return { ok: true, json: async () => ES }; if (String(url).includes("crossref")) return { ok: true, json: async () => CRX }; throw new Error("unexpected"); };
  const src = [{ title: "School start times, sleep, and youth outcomes", url: "https://pubmed.ncbi.nlm.nih.gov/35593065/", authors: [], groupAuthor: "", year: null, date: "", container: "", editors: [], doi: "" }];
  let r = await enrichSources(src, { fetchImpl });
  assert.equal(r.enriched, 1);
  assert.deepEqual(src[0].authors, ["Tiffany Yip", "Yijie Wang"], "Crossref's full names win over esummary's initials");
  assert.equal(src[0].year, 2022); assert.equal(src[0].date, "2022-06-01"); assert.equal(src[0].doi, "10.1542/peds.2021-054068"); assert.equal(src[0].container, "Pediatrics");
  assert.ok(hits[0].includes("esummary") && hits[1].includes("crossref"), "esummary first, then the registrar");
  const src2 = [{ title: "School start times, sleep, and youth outcomes", url: "https://pubmed.ncbi.nlm.nih.gov/35593065/", authors: [], year: null }];
  r = await enrichSources(src2, { fetchImpl: async (url) => (String(url).includes("esummary") ? { ok: true, json: async () => ES } : { ok: false, json: async () => ({}) }) });
  assert.equal(r.enriched, 1); assert.deepEqual(src2[0].authors, ["Yip T", "Wang Y"], "esummary's names stand when Crossref does not answer"); assert.equal(src2[0].year, 2022);
});

import { claimWindow } from "../lib/factcheck.js";
test("claimWindow sends the claim's own neighbourhood, not the document's head, and falls back to the head when the claim is not in the context", () => {
  const para = (n) => `Paragraph ${n} sentence one about topic ${n}. Paragraph ${n} sentence two with more detail on ${n}. Paragraph ${n} sentence three closes it.`;
  const doc = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(para).join("\n\n");
  const claim = "Paragraph 9 sentence two with more detail on 9.";
  const w = claimWindow(doc, claim, { radius: 150 });
  assert.ok(w.includes(claim), "the claim is inside the window");
  assert.ok(w.includes("Paragraph 8") && w.includes("Paragraph 10"), "and so are its neighbours");
  assert.ok(!w.includes("Paragraph 1 sentence"), "the introduction is not");
  assert.ok(w.startsWith("…") && w.endsWith("…"), "marked as an excerpt both ends");
  assert.ok(w.length <= 2 * 150 + claim.length + 420, `bounded: ${w.length}`);
  assert.equal(claimWindow(doc, "A sentence that is not in the document at all.", { head: 50 }), doc.slice(0, 50), "not found → the head, as before");
  assert.equal(claimWindow(doc, "short", { head: 50 }), doc.slice(0, 50), "too short a needle to trust → the head");
  assert.equal(claimWindow("", claim), "");
  const first = claimWindow(doc, "Paragraph 1 sentence one about topic 1.", { radius: 60 });
  assert.ok(first.startsWith("Paragraph 1") && first.endsWith("…"), "at the very start: no leading ellipsis");
});

test("completeSources also reads the page for a source that has a year but no author", async () => {
  const realFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  const model = { sources: [{ title: "About Sleep", url: "https://www.cdc.gov/sleep/about/index.html", publisher: "CDC", snippet: "s", stance: "context", kind: "institutional", authors: [], groupAuthor: "", year: 2024, date: "", container: "", editors: [], doi: "" }] };
  const html = `<html><head><title>About Sleep | CDC</title><meta property="og:site_name" content="CDC"><meta name="citation_author" content="Centers for Disease Control and Prevention"></head></html>`;
  let pageReads = 0, receiptReads = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("api.openai.com")) return new Response(JSON.stringify({ status: "completed", model: "gpt-5.6-luna", usage: { input_tokens: 10, output_tokens: 10 }, output: [{ type: "web_search_call", status: "completed", action: { type: "search" } }, { type: "web_search_call", status: "completed", action: { type: "open_page" } }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(model), annotations: [] }] }] }), { status: 200 });
    // The citation reader sends no Accept header; the receipt check
    // (lib/sourceVerify.js) reads every source's page too, with one.
    if (u.includes("cdc.gov")) { if (init?.headers?.Accept) receiptReads++; else pageReads++; return new Response(html, { status: 200, headers: { "content-type": "text/html" } }); }
    throw new Error("unexpected " + u);
  };
  try {
    const r = await findSources({ claim: "Adults need seven or more hours of sleep.", model: "gpt-5.6-luna", effort: "low" });
    assert.equal(pageReads, 1, "the dated-but-unattributed page was read");
    assert.equal(receiptReads, 1, "and read once more for its receipt");
    assert.equal(r.sources[0].groupAuthor, "Centers for Disease Control and Prevention");
    assert.equal(r.sources[0].year, 2024, "the model's year stands");
    assert.deepEqual(r.webSearchActions, { search: 1, open_page: 1 }, "actions are reported by type");
    assert.equal(r.webSearchCalls, 2, "and the ledger still counts every item");
  } finally { globalThis.fetch = realFetch; }
});
