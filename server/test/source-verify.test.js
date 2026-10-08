/* The receipt a source search shows (lib/sourceVerify.js): read what every
 * source itself says, judge it against the claim, and offer it as backing
 * only with the words from it that back the sentence — checked to be there.
 * Owner, 2026-10-04: Ord & Davies (2022) was offered for a sentence it never
 * makes; 2026-10-07: of 51 sources ranked relevant, three judges found 16
 * (31%) back the sentence. The model is a fake here; what is tested is
 * everything around it — the text it is given, the quote check, and what its
 * verdicts (or its silence) do to the list. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setHostResolver } from "../lib/citeMeta.js";
import {
  abstractFromIndex, pageText, claimTerms, abstractSettles, selectExcerpts, foldForMatch, matchQuote, openAccessPage,
  gatherEvidence, applyVerdicts, markUnverified, verifySources, VERIFY_SYSTEM, VERIFY_SCHEMA, OPENALEX_WORK, EXCERPT_CHARS, EXCERPT_WINDOWS, MAX_QUOTE_CHARS,
} from "../lib/sourceVerify.js";

// A stubbed fetch never needs DNS; safeFetch still checks every host, against this.
test.before(() => setHostResolver(async () => [{ address: "93.184.216.34" }]));
test.after(() => setHostResolver(null));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
const FACTCHECK = readFileSync(path.join(HERE, "..", "lib", "factcheck.js"), "utf8");
const LIVE = JSON.parse(readFileSync(path.join(HERE, "fixtures", "retraction", "live-2026-10-07.json"), "utf8"));

const ORD_ABSTRACT = "'Levelling UP' has taken on considerable significance in the policy discourses of the Johnson conservative government. Youth work can be the best placed service for (re)investment. The investment required must be seen in the context of the huge austerity cuts to youth services in England which disproportionately affected disadvantaged communities.";
const toIndex = (text) => { const idx = {}; text.split(" ").forEach((w, i) => { (idx[w] ??= []).push(i); }); return idx; };
const FILLER = "Unrelated filler about digital life and schools. ".repeat(60);
const GOVUK = `<html><head><title>Youth Matters</title><script>var x = "73% fake";</script><style>p{}</style></head><body><nav>Menu Cookies</nav>
<h1>Youth Matters: State of the Nation</h1><p>Young people told us about loneliness and the cost of living in every region.</p>
<p>${FILLER}</p>
<p>Between 2010/11 and 2022/23, spending on youth facilities fell by 73%, leaving gaps in services across much of the country (DCMS, 2024).</p>
<p>${FILLER}</p></body></html>`;
const CLAIM = "Investment in youth facilities has fallen by 73% between 2010/11 and 2022/23.";

function fakeFetch(routes) {
  const hits = [];
  const f = async (url) => {
    const u = String(url);
    hits.push(u);
    for (const [k, v] of Object.entries(routes)) if (u.includes(k)) {
      return { ok: v.status ? v.status < 400 : true, status: v.status ?? 200, headers: { get: (h) => (h.toLowerCase() === "content-type" ? v.type ?? "text/html" : null) }, json: async () => v.json, text: async () => v.text ?? "" };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
  };
  f.hits = hits;
  return f;
}
const OPENALEX = OPENALEX_WORK.replace("https://", "");

// ── reading ───────────────────────────────────────────────────────────────

test("an OpenAlex abstract is rebuilt in word order", () => {
  assert.equal(abstractFromIndex({ cuts: [3], "huge": [2], "the": [0, 4], "after": [1], "budget": [5] }), "the after huge cuts the budget");
  assert.equal(abstractFromIndex(null), "");
});

test("a page's text: no scripts, styles or navigation, entities decoded, a block's end a sentence end", () => {
  const t = pageText(GOVUK);
  assert.ok(t.includes("spending on youth facilities fell by 73%"));
  assert.ok(!t.includes("fake") && !t.includes("Menu Cookies"));
  assert.equal(pageText("<p>A &amp; B</p>"), "A & B.");
  assert.equal(pageText("<div>One</div><div>Two</div>"), "One. Two.");
  assert.equal(pageText("a < b and <!-- hidden --> c"), "a < b and c");
  assert.equal(pageText("<p>kept</p><script>never closed"), "kept.", "an unclosed script ends the text");
});

test("a hostile page cannot hold the thread: unclosed tags are one linear pass", () => {
  const evil = "<script".repeat(150_000) + "<a".repeat(150_000);
  const t0 = Date.now();
  pageText(evil);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test("the claim's terms: figures without commas or %, plurals folded, function words out", () => {
  const t = claimTerms("Spending on youth facilities fell by 73% — 1,200 centres closed in 2023.");
  assert.deepEqual([...t.numbers].sort(), ["1200", "2023", "73"]);
  assert.ok(t.words.has("facility") && t.words.has("youth") && t.words.has("centre"));
  assert.ok(!t.words.has("the") && !t.words.has("by"));
});

test("an abstract settles it only when it carries every figure and most of the words", () => {
  assert.equal(abstractSettles("Spending on youth facilities fell by 73% between 2010/11 and 2022/23.", CLAIM), true);
  assert.equal(abstractSettles("Spending on youth facilities fell sharply over the decade.", CLAIM), false, "the figure is missing: the full text is where it lives");
  assert.equal(abstractSettles(ORD_ABSTRACT, "Support for youth leadership has increased."), false);
});

// ── which passages the judge reads ───────────────────────────────────────

test("excerpts: the best passages from the WHOLE text, about 3 x 600 characters, in document order", () => {
  const text = pageText(GOVUK);
  assert.ok(text.length > 4000, "a long page");
  const ex = selectExcerpts([{ from: "page", text }], CLAIM);
  assert.ok(ex.length >= 1 && ex.length <= EXCERPT_WINDOWS);
  for (const p of ex) {
    assert.equal(p.from, "page");
    assert.ok(p.text.length <= EXCERPT_CHARS, `passage of ${p.text.length}`);
    assert.ok(text.includes(p.text), "every passage is a contiguous span of the source");
  }
  assert.ok(ex.some((p) => /spending on youth facilities fell by 73%/.test(p.text)), "the sentence two thousand characters in is found");
  const at = ex.map((p) => text.indexOf(p.text));
  assert.deepEqual(at, [...at].sort((a, b) => a - b), "document order");
});

test("excerpts: a short text is kept whole; nothing in common → the opening, so the judge can say 'topic'", () => {
  assert.deepEqual(selectExcerpts([{ from: "abstract", text: ORD_ABSTRACT }], CLAIM), [{ from: "abstract", text: ORD_ABSTRACT }]);
  const long = "Bananas are berries botanically. ".repeat(100);
  const ex = selectExcerpts([{ from: "page", text: long }], "Napoleon was of average height.");
  assert.equal(ex.length, 1);
  assert.ok(long.startsWith(ex[0].text) && ex[0].text.length <= EXCERPT_CHARS);
  assert.deepEqual(selectExcerpts([], CLAIM), []);
});

test("excerpts: passages cover different parts of the claim, from the abstract and the page both", () => {
  const abstract = `We studied youth facilities across England. ${"Background on methods and sampling. ".repeat(30)}`;
  const page = `${"Introductory material about policy. ".repeat(40)}Results: spending fell by 73% between 2010/11 and 2022/23. ${"Discussion of other things. ".repeat(40)}`;
  const ex = selectExcerpts([{ from: "abstract", text: abstract }, { from: "page", text: page }], CLAIM);
  assert.ok(ex.some((p) => p.from === "page" && /fell by 73%/.test(p.text)), "the figure, from the full text");
  assert.ok(ex.some((p) => p.from === "abstract" && /youth facilities/.test(p.text)), "and the subject, from the abstract");
});

// ── is the quote really there? ───────────────────────────────────────────

const PASSAGES = [
  { from: "abstract", text: "We find that teenagers’ sleep rose by 25 minutes — a “substantial” gain — when start times moved later." },
  { from: "page", text: "Between 2010/11 and 2022/23, spending on youth facilities fell by 73%, leaving gaps in services. Rates were 73.5% in Wales." },
];

test("quote folding: whitespace, smart quotes, dashes, case and invisible characters only", () => {
  assert.equal(foldForMatch("  It’s  “Fine” — OK­.  ").text, "it's \"fine\" - ok.");
  const { text, map } = foldForMatch("A  B");
  assert.equal(text, "a b");
  assert.deepEqual(map, [0, 1, 3]);
});

test("a quote is found in spite of quote style, dash style, case, line breaks and its own wrapping — and the receipt is the source's characters", () => {
  const m = matchQuote("\"Teenagers' sleep rose by 25 minutes - a \"substantial\"\ngain\"", PASSAGES);
  assert.ok(m);
  assert.equal(m.from, "abstract");
  assert.equal(m.text, "teenagers’ sleep rose by 25 minutes — a “substantial” gain", "curly quotes and the em dash as the source wrote them");
  const p = matchQuote("…spending on youth facilities fell by 73%.", PASSAGES);
  assert.equal(p.from, "page");
  assert.equal(p.text, "spending on youth facilities fell by 73%");
});

test("a quote that is not verbatim is not found: a paraphrase, a changed word, words stitched across a gap, across two excerpts", () => {
  assert.equal(matchQuote("spending on youth services fell by 73%", PASSAGES), null, "one word changed");
  assert.equal(matchQuote("youth facility spending dropped 73 percent", PASSAGES), null, "a paraphrase");
  assert.equal(matchQuote("teenagers’ sleep rose ... when start times moved later", PASSAGES), null, "an ellipsis stitching two spans");
  assert.equal(matchQuote("when start times moved later. Between 2010/11", PASSAGES), null, "two excerpts are not one text");
  assert.equal(matchQuote("fell by 73%", PASSAGES), null, "too short to be a receipt");
  assert.equal(matchQuote("", PASSAGES), null);
});

test("near misses on a word boundary are not found: 73 is not 73.5 or 735, and no half words", () => {
  const P = [{ from: "page", text: "Rates were 73.5% in Wales and 735 schools closed in Scotland." }];
  assert.equal(matchQuote("Rates were 73", P), null);
  assert.equal(matchQuote("and 73 schools closed", P), null);
  assert.equal(matchQuote("ates were 73.5% in Wales", P), null, "starts mid-word");
  assert.ok(matchQuote("Rates were 73.5% in Wales", P));
});

// ── what is read ──────────────────────────────────────────────────────────

test("every source is read — the abstract for a DOI, else the page; a wall, an error or a PDF leaves it unread", async () => {
  const sources = [
    { title: "Ord & Davies", url: "https://doi.org/10.1177/02690942221098971", stance: "supports" },
    { title: "GOV.UK", url: "https://www.gov.uk/youth", stance: "supports" },
    { title: "Context too", url: "https://example.org/ctx", stance: "context" },
    { title: "Walled", url: "https://paywall.example/x", stance: "supports" },
    { title: "Challenge", url: "https://cf.example/x", stance: "supports" },
    { title: "A PDF", url: "https://files.example/report.pdf", stance: "supports" },
  ];
  const fetchImpl = fakeFetch({
    [OPENALEX]: { json: { abstract_inverted_index: toIndex(ORD_ABSTRACT), is_retracted: false } },
    "www.gov.uk/youth": { text: GOVUK },
    "example.org/ctx": { text: `<p>${FILLER} Youth facilities matter.</p>` },
    "paywall.example": { status: 403, text: "denied" },
    "cf.example": { text: `<html><head><title>Just a moment...</title></head><body>${FILLER}</body></html>` },
  });
  const { evidence, retracted } = await gatherEvidence(sources, CLAIM, { fetchImpl, deadlineMs: 2000 });
  assert.deepEqual(evidence.map((e) => e.i), [0, 1, 2], "the context source is read too; the walled, challenged and PDF ones are not");
  assert.deepEqual(retracted, []);
  assert.equal(evidence[0].passages[0].from, "abstract");
  assert.match(evidence[0].passages[0].text, /austerity cuts to youth services/);
  assert.ok(evidence[1].passages.some((p) => /fell by 73%/.test(p.text)));
  assert.ok(!fetchImpl.hits.some((u) => u.includes("files.example")), "a PDF is never fetched");
});

test("a DOI whose abstract does not settle it: the open-access copy is read too, never a PDF", async () => {
  const work = {
    abstract_inverted_index: toIndex("We studied youth facilities in England over a decade and describe the changes in provision."),
    is_retracted: false,
    best_oa_location: { is_oa: true, landing_page_url: "https://repository.example/oa/123", pdf_url: "https://repository.example/oa/123.pdf" },
    open_access: { is_oa: true, oa_url: "https://repository.example/oa/123.pdf" },
  };
  assert.equal(openAccessPage(work), "https://repository.example/oa/123");
  assert.equal(openAccessPage({ open_access: { oa_url: "http://www.thelancet.com/article/S0140673620311806/pdf" } }), "", "the live Surgisphere oa_url is a PDF: skipped");
  assert.equal(openAccessPage(LIVE.openalex.wakefield1998), "", "closed: nothing to read");
  const fetchImpl = fakeFetch({ [OPENALEX]: { json: work }, "repository.example/oa/123": { text: GOVUK } });
  const { evidence } = await gatherEvidence([{ title: "Study", url: "https://doi.org/10.1234/abc", stance: "context" }], CLAIM, { fetchImpl, deadlineMs: 2000 });
  assert.deepEqual([...new Set(evidence[0].passages.map((p) => p.from))].sort(), ["abstract", "page"]);
  assert.ok(evidence[0].passages.some((p) => p.from === "page" && /fell by 73%/.test(p.text)));

  const settles = { ...work, abstract_inverted_index: toIndex("Between 2010/11 and 2022/23 spending on youth facilities fell by 73% in England.") };
  const quiet = fakeFetch({ [OPENALEX]: { json: settles }, "repository.example": { text: GOVUK } });
  await gatherEvidence([{ title: "Study", url: "https://doi.org/10.1234/abc", stance: "context" }], CLAIM, { fetchImpl: quiet, deadlineMs: 2000 });
  assert.ok(!quiet.hits.some((u) => u.includes("repository.example")), "an abstract that settles it: no second read");
});

test("OpenAlex's is_retracted (live: Wakefield 1998, the Lancet's 2010 notice, Surgisphere 2020) marks the source for dropping, unread", async () => {
  for (const k of ["wakefield1998", "wakefieldNotice2010", "surgisphere2020"]) assert.equal(LIVE.openalex[k].is_retracted, true, k);
  assert.equal(LIVE.openalex.winnebeck2019.is_retracted, false);
  const s = { title: "Ileal-lymphoid-nodular hyperplasia", url: "https://doi.org/10.1016/S0140-6736(97)11096-0", stance: "supports" };
  const fetchImpl = fakeFetch({ [OPENALEX]: { json: LIVE.openalex.wakefield1998 } });
  const { evidence, retracted } = await gatherEvidence([s], "The MMR vaccine causes autism.", { fetchImpl, deadlineMs: 2000 });
  assert.deepEqual(evidence, []);
  assert.deepEqual(retracted, [s]);
});

// ── what the verdicts do ──────────────────────────────────────────────────

test("backs with a quote that is there: supports, verified, the quote, where it was read — and the snippet is the quote", () => {
  const sources = [
    { title: "Ord & Davies", stance: "supports", snippet: "Says support for youth leadership increased." },
    { title: "GOV.UK", stance: "context", snippet: "model's paraphrase" },
    { title: "Contradicts", stance: "supports", snippet: "s" },
  ];
  const evidence = [
    { i: 0, passages: [{ from: "abstract", text: ORD_ABSTRACT }] },
    { i: 1, passages: [{ from: "page", text: "Between 2010/11 and 2022/23, spending on youth facilities fell by 73%, leaving gaps in services." }] },
    { i: 2, passages: [{ from: "abstract", text: "Spending on youth facilities rose by 12% between 2010/11 and 2022/23." }] },
  ];
  const t = applyVerdicts(sources, evidence, [
    { id: 0, verdict: "topic", quote: "" },
    { id: 1, verdict: "backs", quote: "spending on youth facilities fell by 73%" },
    { id: 2, verdict: "contradicts", quote: "Spending on youth facilities rose by 12%" },
  ]);
  assert.deepEqual(t, { changed: 3, quoted: 2, unquoted: 0, unjudged: 0 });
  assert.deepEqual(sources[0], { title: "Ord & Davies", stance: "context", snippet: "Says support for youth leadership increased.", verified: true, readFrom: "abstract" }, "on the topic, read, not backing: no quote");
  assert.deepEqual(sources[1], { title: "GOV.UK", stance: "supports", snippet: "“spending on youth facilities fell by 73%”", verified: true, readFrom: "page", quote: "spending on youth facilities fell by 73%" });
  assert.equal(sources[2].stance, "refutes");
  assert.equal(sources[2].quote, "Spending on youth facilities rose by 12%");
});

test("a verdict whose quote is not in the text falls to topic; a source the judge skipped is unverified", () => {
  const sources = [{ stance: "supports", snippet: "orig" }, { stance: "supports", snippet: "orig" }, { stance: "context" }];
  const evidence = [{ i: 0, passages: [{ from: "page", text: "The report covers loneliness among young people in England." }] }, { i: 1, passages: [{ from: "abstract", text: "Anything at all that was read here." }] }, { i: 2, passages: [{ from: "page", text: "x".repeat(100) }] }];
  const t = applyVerdicts(sources, evidence, [{ id: 0, verdict: "backs", quote: "an invented line that is not there at all" }, { id: 2, verdict: "nonsense", quote: "" }]);
  assert.deepEqual(t, { changed: 2, quoted: 0, unquoted: 1, unjudged: 2 });
  assert.deepEqual(sources[0], { stance: "context", snippet: "orig", verified: true, readFrom: "page" }, "read, but the receipt was not real: not backing");
  assert.deepEqual(sources[1], { stance: "context", snippet: "orig", verified: false }, "no verdict came back: unverified");
  assert.equal(sources[2].verified, false, "an answer outside the enum is no verdict");
});

test("a long quote is cut for display at a word, still the source's own words", () => {
  const long = `${"Youth facilities across England were studied in great detail over many years ".repeat(6)}and spending fell by 73%.`;
  const sources = [{ stance: "context" }];
  applyVerdicts(sources, [{ i: 0, passages: [{ from: "page", text: long }] }], [{ id: 0, verdict: "backs", quote: long }]);
  assert.equal(sources[0].stance, "supports");
  assert.ok(sources[0].quote.length <= MAX_QUOTE_CHARS + 1 && sources[0].quote.endsWith("…"));
  assert.ok(long.startsWith(sources[0].quote.slice(0, -1)));
});

test("unverified: never supports or refutes, no receipt", () => {
  for (const stance of ["supports", "refutes", "context"]) {
    const s = { stance, quote: "q", readFrom: "page", verified: true };
    markUnverified(s);
    assert.deepEqual(s, { stance: "context", verified: false });
  }
});

test("verifySources: unreadable → context + verified:false; one call for the rest; a judge failure unverifies everything it read", async () => {
  const fetchImpl = fakeFetch({ "www.gov.uk/youth": { text: GOVUK }, "paywall.example": { status: 403 } });
  const sources = [
    { title: "GOV.UK", url: "https://www.gov.uk/youth", stance: "context", snippet: "s" },
    { title: "Walled", url: "https://paywall.example/x", stance: "supports", snippet: "s" },
  ];
  let calls = 0, sent = null;
  const call = async (req) => { calls++; sent = req; return { parsed: { verdicts: [{ id: 0, verdict: "backs", quote: "spending on youth facilities fell by 73%" }] }, usage: { input: 900, output: 60, cached: 0, cacheWrite: 0 } }; };
  const r = await verifySources({ claim: CLAIM, sources, model: "gpt-5.6-luna", call, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(sent.effort, "low");
  assert.equal(sent.system, VERIFY_SYSTEM);
  assert.equal(sent.schema, VERIFY_SCHEMA);
  assert.match(sent.user, /SOURCE 0: GOV\.UK\n"""\n/);
  assert.doesNotMatch(sent.user, /SOURCE 1/, "nothing was read, so nothing is judged");
  assert.deepEqual([r.checked, r.changed, r.quoted, r.unread, r.usage.input], [1, 2, 1, 1, 900]);
  assert.deepEqual([sources[0].stance, sources[0].verified, sources[0].readFrom], ["supports", true, "page"]);
  assert.deepEqual(sources[1], { title: "Walled", url: "https://paywall.example/x", stance: "context", snippet: "s", verified: false }, "the search said supports; unread, it is never backing");

  const kept = [{ title: "GOV.UK", url: "https://www.gov.uk/youth", stance: "supports" }];
  const boom = async () => { throw Object.assign(new Error("model down"), { llm: { usage: { input: 5, output: 0 } } }); };
  const f = await verifySources({ claim: CLAIM, sources: kept, model: "m", call: boom, fetchImpl });
  assert.deepEqual([kept[0].stance, kept[0].verified], ["context", false], "read but never judged: not backing");
  assert.equal(f.usage.input, 5, "what a failed call billed is still reported");
  assert.match(f.error, /model down/);

  const none = [{ url: "https://paywall.example/y", stance: "refutes" }];
  const nothing = await verifySources({ claim: "x", sources: none, model: "m", call: async () => { throw new Error("not called"); }, fetchImpl });
  assert.deepEqual([nothing.checked, nothing.unread, none[0].stance, none[0].verified], [0, 1, "context", false], "nothing read: no call, nothing backing");
});

test("the judge works from the text alone, defaults to topic, is told topic includes the on-topic source that says something else, and must quote", () => {
  assert.match(VERIFY_SYSTEM, /Judge from that text ONLY/);
  assert.match(VERIFY_SYSTEM, /This is the answer whenever you are unsure/);
  assert.match(VERIFY_SYSTEM, /"facilities" or "services" when the text means the same figure/);
  assert.match(VERIFY_SYSTEM, /A source about the same subject that does not state this sentence's specific proposition is "topic"/);
  assert.match(VERIFY_SYSTEM, /character for character, as one contiguous span: no ellipses/);
  assert.match(VERIFY_SYSTEM, /a verdict whose quote is not there is discarded as "topic"/);
  assert.match(VERIFY_SCHEMA.properties.verdicts.items.properties.quote.description, /at most 300 characters/);
});

test("wired: after the page lookups, billed with the search, retracted dropped, tallies kept out of the frozen response", () => {
  assert.match(FACTCHECK, /await verifySources\(\{ claim, correction, sources: merged, model: chosenModel \}\)/);
  assert.match(FACTCHECK, /usage: verified\.usage \? addUsage\(usage, verified\.usage\) : usage/);
  assert.match(FACTCHECK, /const gone = new Set\(verified\.retracted \?\? \[\]\);/);
  assert.match(SERVER, /const \{ webSearchCalls, webSearchActions, enriched, dropped, verified, retracted, \.\.\.result \} = await findSources/, "the tallies never reach the extension");
  assert.match(SERVER, /verified=\$\{verified\?\.checked \?\? 0\}\/\$\{verified\?\.changed \?\? 0\} quoted=\$\{verified\?\.quoted \?\? 0\} unquoted=\$\{verified\?\.unquoted \?\? 0\} unread=\$\{verified\?\.unread \?\? 0\} retracted=\$\{retracted \?\? 0\}/);
});
