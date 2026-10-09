/* Citations in context (server + extension 2.21.30). Owner, 2026-10-08:
 *   - on "… but the extent remains uncertain (Shiraishi).": "it said that
 *     they cant find this source, are they right or are they wrong?" — a
 *     citation that names only a person now gets that person's works on the
 *     essay's subject (Shiraishi is a real Mongol-empire archaeologist; none
 *     of his catalogued works is about literacy), and the card says so;
 *   - on "The study does not need a publication date because Harvard is a
 *     famous institution.": "tracely is trying to cite this instead of remove
 *     it" — an excuse is the writer's note: Delete it, look the date up,
 *     never a verdict or a search on the excuse itself;
 *   - "sometimes a sentence is underlined with two different problems and it
 *     becomes jumbled" — one underline per span of text.
 * Pinned: the server's authorWorks (namesakes and general words filtered
 * out), what the extension sends and how it reads the answer (an older server
 * answers as before), the excuse rules, and the one-underline rule. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";
import { authorWorks } from "../lib/evidence.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const SERVER = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
const ESSAY = readFileSync(path.join(ROOT, "eval", "revision", "flawed-mongols.txt"), "utf8").replace(/\r\n/g, "\n");
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ── the server: an author's works on the subject ───────────────────────── */

function withFetch(routes, fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    for (const [k, body] of Object.entries(routes)) if (u.includes(k)) return { ok: true, status: 200, json: async () => body };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return fn(asked).finally(() => { globalThis.fetch = real; });
}
const cr = (title, family, year, container, extra = {}) => ({ title: [title], author: [{ given: "N.", family }], issued: { "date-parts": [[year]] }, "container-title": container ? [container] : [], DOI: `10.1/${title.length}`, type: "journal-article", ...extra });

test("server: an author's works on the essay's subject — namesakes and general words filtered out", () => withFetch({
  "api.crossref.org": { message: { items: [
    cr("Archaeological Sources", "Shiraishi", 2023, "The Cambridge History of the Mongol Empire"),
    cr("Seasonal Migrations of the Mongol Emperors and the Peri-Urban Area of Kharakhorum", "Shiraishi", 2004, "International Journal of Asian Studies"),
    cr("Avraga Site: The Great Ordu of Genghis Khan", "Shiraishi", 2006, "Beyond the Legacy of Genghis Khan"),
    cr("Factors in the Development of Trade Credit", "Shiraishi", 2014, "Emerging Markets Finance and Trade"),
    cr("Empire, Rogue States, Islamism", "Shiraishi", 2003, "Japanese Journal of Southeast Asian Studies"),
    cr("The Mongol Conquests", "Shiraishimura", 2010, "A Journal"),
  ] } },
  "openlibrary.org": { docs: [{ title: "Mongoru teikokushi no kōkogakuteki kenkyū", author_name: ["Noriyuki Shiraishi"], first_publish_year: 2002, key: "/works/OL1W" }, { title: "Mongol Horses", author_name: ["Ann Lee"], first_publish_year: 2001, key: "/works/OL2W" }] },
}, async (asked) => {
  const r = await authorWorks({ author: "Shiraishi", topic: "mongol empire trade genghis" });
  assert.deepEqual(r.subject, ["mongol", "empire", "trade", "genghis"]);
  assert.deepEqual(r.works.map((w) => w.title), [
    "Archaeological Sources",
    "Seasonal Migrations of the Mongol Emperors and the Peri-Urban Area of Kharakhorum",
    "Avraga Site: The Great Ordu of Genghis Khan",
    "Mongoru teikokushi no kōkogakuteki kenkyū",
  ], "his Mongol-empire works (a venue counts, 'Mongoru' is 'Mongol'); not a namesake's trade-credit or rogue-states paper, nor another surname, nor another author's book");
  assert.ok(asked.some((u) => /query\.author=Shiraishi/.test(u) && /query\.bibliographic=mongol%20empire%20trade%20genghis/.test(u)));
}));

test("server: no author, no works; the route answers the additive field and leaves a plain lookup as it was", async () => {
  assert.deepEqual(plain(await authorWorks({ author: "", topic: "x" })).works, []);
  assert.match(SERVER, /if \(typeof author === "string" && author\.trim\(\)\) \{/);
  assert.match(SERVER, /json\(res, 200, \{ matches: \[\], nearMisses: \[\], resolved: false, authorWorks: works \}, cors\);/);
  assert.match(SERVER, /json\(res, 200, await evidence\.compareSource\(\{ citedRef: citedRef\.slice\(0, 1000\) \}\), cors\);/, "a request without `author` is answered exactly as before");
});

/* ── the extension: what is sent, and how the answer reads ─────────────── */

const HELPERS = `const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false };
  function hashText(s) { return "h" + s.length + s.slice(0, 24); }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}`;
function load(answer) {
  const ctx = vm.createContext({ calls: [], console });
  ctx.api = async (p, b) => { ctx.calls.push({ p, b: plain(b) }); if (answer instanceof Error) throw answer; return answer; };
  const X = vm.runInContext(`${HELPERS}
    ${sliceBetween(SRC, "  function offlineError(err) {", "  /* The live source search (POST /api/sources/stream")}
    ${sliceBetween(SRC, '  /* "Find the cited work": one /api/compare-source call', "  /* ── widget chrome (shared shadow-DOM shell)")}
    ({ citedLookupPlan, lookupCitedWork, tipCitedTarget, segmentText, flagShown, citationTips, deleteEditFor, tipDeletes, tipCoversSentence, factSpanOf, CITED_COPY, citedWorkHtml, sameCitation, formatCitation })`, ctx);
  return { X, ctx };
}
const SENT = "Some researchers have argued that literacy expanded in parts of the empire, but the extent remains uncertain (Shiraishi).";
const DOC = ESSAY.replace(/Some researchers have argued that literacy expanded[^.]*\./, SENT);

test("extension: a surname-only citation asks for the author's works on the essay's subject", async () => {
  const { X, ctx } = load({ matches: [], nearMisses: [], resolved: false, authorWorks: { author: "Shiraishi", subject: [], works: [] } });
  assert.ok(DOC.includes(SENT));
  const target = { kind: "sentence", sentence: SENT, raw: "(Shiraishi)", inner: "Shiraishi", segHash: "h1" };
  const plan = X.citedLookupPlan(target, DOC);
  assert.equal(plan.thin, true);
  assert.equal(plan.author, "Shiraishi");
  assert.match(plan.topic, /\bmongols?\b/, "the essay's subject");
  assert.ok(plan.claimTerms.includes("literacy"), "the claim's own word");
  assert.ok(!plan.claimTerms.includes("shiraishi") && !plan.claimTerms.includes("empire"), "never the citation, never the whole essay's subject");
  await X.lookupCitedWork(plan);
  assert.deepEqual(ctx.calls[0], { p: "/api/compare-source", b: { citedRef: "Shiraishi", author: "Shiraishi", topic: plan.topic } });
  for (const [inner, author] of [["Khan, 2022", "Khan"], ["Lee 45", "Lee"], ["Lee and Kim", "Lee"], ["Lee et al., n.d.", "Lee"], ["Genghis Khan and the, 2022", null], ["Weatherford", "Weatherford"]]) {
    const p = X.citedLookupPlan({ kind: "sentence", sentence: `A claim (${inner}).`, raw: `(${inner})`, inner }, "Some text.");
    assert.equal(p.author, p.thin ? author : null, inner);
  }
});

test("extension: the works come back as the card's records, and when no title is about the claim it says so", async () => {
  const works = [
    { title: "Archaeological Sources", authors: ["Noriyuki Shiraishi"], year: 2023, venue: "The Cambridge History of the Mongol Empire", venueType: "chapter", doi: "10.1017/9781316337424.041", provider: "crossref" },
    { title: "Seasonal Migrations of the Mongol Emperors and the Peri-Urban Area of Kharakhorum", authors: ["Noriyuki Shiraishi"], year: 2004, venue: "International Journal of Asian Studies", venueType: "journal", doi: "10.1017/s1479591404000075", provider: "crossref" },
  ];
  const { X } = load({ matches: [], resolved: false, authorWorks: { author: "Shiraishi", works } });
  const plan = X.citedLookupPlan({ kind: "sentence", sentence: SENT, raw: "(Shiraishi)", inner: "Shiraishi", segHash: "h1" }, DOC);
  const r = plain(await X.lookupCitedWork(plan));
  assert.equal(r.resolved, true);
  assert.deepEqual(r.matches.map((m) => m.title), works.map((w) => w.title));
  assert.equal(r.byAuthor.name, "Shiraishi");
  assert.ok(r.byAuthor.offClaim.includes("literacy"));
  const html = X.citedWorkHtml({ ...r, plan, target: { segHash: "h1" } }, () => "");
  assert.match(html, /Works by Shiraishi on this subject/);
  assert.match(html, /“Shiraishi” names a person, not a work\./);
  assert.match(html, /None of these titles mentions “literacy”/);
  assert.equal(X.sameCitation("(Shiraishi)", X.formatCitation({ title: "Archaeological Sources", authors: ["Noriyuki Shiraishi"], year: 2023, kind: "book" }, "mla").marker, "mla"), true, "MLA already cites it: the entry is what is added");
});

test("extension: none found says a reader can't find it; an older server says what it said before", async () => {
  const plan = { thin: true, author: "Khan", topic: "mongol", claimTerms: [], display: "Khan, 2022" };
  const none = plain(await load({ matches: [], resolved: false, authorWorks: { author: "Khan", works: [] } }).X.lookupCitedWork(plan));
  assert.equal(none.resolved, false);
  assert.match(none.note, /No work by Khan on your essay's subject turned up in Crossref or Open Library, so a reader can't find this source from “Khan, 2022”/);
  const old = load({ matches: [{ title: "Some Khan paper", authors: ["A Khan"] }], resolved: true }).X;
  const r = plain(await old.lookupCitedWork(plan));
  assert.equal(r.resolved, false, "a one-word lookup's matches are never offered");
  assert.equal(r.note, old.CITED_COPY.thin("Khan, 2022"));
});

/* ── the excuse ─────────────────────────────────────────────────────────── */

test("excuse: never a verdict on it; its note deletes it, the citation it excuses is looked up", () => {
  const { X } = load({});
  const EXCUSE = "The study does not need a publication date because Harvard is a famous institution.";
  assert.equal(X.flagShown({ verdict: "questionable" }, {}, "prose", EXCUSE), false, "no verdict card offering to source the excuse");
  assert.equal(X.flagShown({ verdict: "needs_citation" }, {}, "prose", EXCUSE), false);
  assert.equal(X.flagShown({ verdict: "false" }, {}, "prose", "The Mongols invented the American dollar."), true, "other sentences as before");
  const tip = X.citationTips(ESSAY, "mla", new Set()).find((t) => t.kind === "excuse");
  assert.ok(tip && X.tipDeletes(tip));
  assert.match(tip.message, /note about your citation, not part of your argument: delete it/);
  assert.ok(X.deleteEditFor(ESSAY, tip.quote), "Delete can be planned for it");
  const bySrc = (re) => sliceBetween(SRC, re, "\n").replace(/^\s*const \w+ = /, "");
  assert.equal(bySrc("  const EXCUSE_SENTENCE ="), bySrc("  const PRESTIGE_EXCUSE ="), "the excuse is one pattern, in two places");
  const docs = SRC.slice(SRC.indexOf("function docsMode()"), SRC.indexOf("function fieldMode()"));
  assert.match(docs, /!\(tip\.kind === "excuse" && target\)/, "no Find a source beside Find the cited work on an excuse");
});

/* ── one underline per span ─────────────────────────────────────────────── */

test("one underline per span: a note over the sentence rides on its mark; one on its citation sits beside it", () => {
  const { X } = load({});
  assert.equal(X.tipCoversSentence(SENT, SENT), true);
  assert.equal(X.tipCoversSentence(SENT, SENT.slice(0, -14)), true, "most of it");
  assert.equal(X.tipCoversSentence(SENT, "(Shiraishi)"), false, "its citation");
  assert.equal(X.tipCoversSentence(SENT, ""), false);
  assert.deepEqual(plain(X.factSpanOf(SENT, [{ mark: "(Shiraishi)" }])), { start: 0, end: SENT.indexOf(" (Shiraishi)") }, "the words before the citation");
  const lead = "[History.com / Gutenberg] Trade grew under the Mongols because merchants could travel safely.";
  assert.deepEqual(plain(X.factSpanOf(lead, [{ mark: "[History.com / Gutenberg]" }])), { start: lead.indexOf("Trade"), end: lead.length }, "or after it, the longer side");
  assert.deepEqual(plain(X.factSpanOf(SENT, [{ mark: SENT }])), { start: 0, end: SENT.length }, "a note over all of it changes nothing");
  const docs = SRC.slice(SRC.indexOf("function docsMode()"), SRC.indexOf("function fieldMode()"));
  assert.match(docs, /if \(also\.length\) put\(dmAlso\(also, hash, VERDICT_LABEL\[f\.verdict\] \?\? f\.verdict\)\);/, "the card lists what else is on the sentence");
  assert.match(docs, /`Also here: \$\{TIP_LABEL\[t\.kind\] \?\? "a note"\}`/);
  assert.match(docs, /if \(from\.backTo\) \{/, "and the note's card has a way back");
});
