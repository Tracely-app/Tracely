/* The server completes a source's citation fields itself (lib/sourceEnrich.js,
 * factcheck.js completeSources) so the model need not open pages — the page
 * opens were 3 of every 8 billed web_search_call items on 2026-10-02. */
import test from "node:test";
import assert from "node:assert/strict";
import { doiOf, pmidOf, fieldsFromCrossref, fieldsFromEsummary, enrichSources } from "../lib/sourceEnrich.js";
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

test("enrichSources refuses a DOI whose registered title shares no word with the source's, survives failures, and honours its deadline", async () => {
  const wrong = [{ title: "Finland literacy rate", url: "https://x.org/a", doi: "10.1093/sleep/zsz307", authors: [], year: null }];
  let r = await enrichSources(wrong, { fetchImpl: async () => ({ ok: true, json: async () => CR() }) });
  assert.equal(r.enriched, 0); assert.equal(wrong[0].year, null, "a DOI that resolves to another work is not trusted");
  const failing = [{ title: "t", url: "https://doi.org/10.1/abc", authors: [], year: null }];
  r = await enrichSources(failing, { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(r.enriched, 0);
  r = await enrichSources(failing, { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  assert.equal(r.enriched, 0);
  const slow = [{ title: "t", url: "https://doi.org/10.1/abc", authors: [], year: null }];
  const t0 = Date.now();
  r = await enrichSources(slow, { deadlineMs: 50, fetchImpl: (url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  assert.equal(r.enriched, 0); assert.ok(Date.now() - t0 < 1000, "the deadline, not the lookup, decides");
  assert.deepEqual(await enrichSources([], {}), { sources: [], enriched: 0 });
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
  let pageReads = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.openai.com")) return new Response(JSON.stringify({ status: "completed", model: "gpt-5.6-luna", usage: { input_tokens: 10, output_tokens: 10 }, output: [{ type: "web_search_call", status: "completed", action: { type: "search" } }, { type: "web_search_call", status: "completed", action: { type: "open_page" } }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(model), annotations: [] }] }] }), { status: 200 });
    if (u.includes("cdc.gov")) { pageReads++; return new Response(html, { status: 200, headers: { "content-type": "text/html" } }); }
    throw new Error("unexpected " + u);
  };
  try {
    const r = await findSources({ claim: "Adults need seven or more hours of sleep.", model: "gpt-5.6-luna", effort: "low" });
    assert.equal(pageReads, 1, "the dated-but-unattributed page was read");
    assert.equal(r.sources[0].groupAuthor, "Centers for Disease Control and Prevention");
    assert.equal(r.sources[0].year, 2024, "the model's year stands");
    assert.deepEqual(r.webSearchActions, { search: 1, open_page: 1 }, "actions are reported by type");
    assert.equal(r.webSearchCalls, 2, "and the ledger still counts every item");
  } finally { globalThis.fetch = realFetch; }
});
