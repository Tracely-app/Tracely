/* The second look at a source search (lib/sourceVerify.js): read what each
 * "supports"/"refutes" source itself says and judge it against the claim.
 * Owner, 2026-10-04: Ord & Davies (2022) was offered for a sentence it never
 * makes. The model is a fake here; what is tested is everything around it —
 * the text it is given, and what its verdicts do to the list. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setHostResolver } from "../lib/citeMeta.js";
import { abstractFromIndex, pageText, relevantPassages, gatherEvidence, applyVerdicts, verifySources, VERIFY_SYSTEM, OPENALEX_WORK } from "../lib/sourceVerify.js";

// A stubbed fetch never needs DNS; safeFetch still checks every host, against this.
test.before(() => setHostResolver(async () => [{ address: "93.184.216.34" }]));
test.after(() => setHostResolver(null));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
const FACTCHECK = readFileSync(path.join(HERE, "..", "lib", "factcheck.js"), "utf8");

const ORD_ABSTRACT = "'Levelling UP' has taken on considerable significance in the policy discourses of the Johnson conservative government. Youth work can be the best placed service for (re)investment. The investment required must be seen in the context of the huge austerity cuts to youth services in England which disproportionately affected disadvantaged communities.";
const toIndex = (text) => { const idx = {}; text.split(" ").forEach((w, i) => { (idx[w] ??= []).push(i); }); return idx; };
const GOVUK = `<html><head><script>var x = "73% fake";</script><style>p{}</style></head><body><nav>Menu Cookies</nav>
<h1>Youth Matters: State of the Nation</h1><p>Young people told us about loneliness and the cost of living in every region.</p>
<p>Between 2010/11 and 2022/23, spending on youth facilities fell by 73%, leaving gaps in services across much of the country (DCMS, 2024).</p>
<p>${"Unrelated filler about digital life and schools. ".repeat(60)}</p></body></html>`;

function fakeFetch(routes) {
  return async (url) => {
    const u = String(url);
    for (const [k, v] of Object.entries(routes)) if (u.includes(k)) {
      return { ok: v.status ? v.status < 400 : true, status: v.status ?? 200, headers: { get: (h) => (h.toLowerCase() === "content-type" ? v.type ?? "text/html" : h.toLowerCase() === "location" ? null : null) }, json: async () => v.json, text: async () => v.text ?? "" };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" };
  };
}

test("an OpenAlex abstract is rebuilt in word order", () => {
  assert.equal(abstractFromIndex({ cuts: [3], "huge": [2], "the": [0, 4], "after": [1], "budget": [5] }), "the after huge cuts the budget");
  assert.equal(abstractFromIndex(null), "");
});

test("a page's text: no scripts, styles or navigation, entities decoded", () => {
  const t = pageText(GOVUK);
  assert.ok(t.includes("spending on youth facilities fell by 73%"));
  assert.ok(!t.includes("fake") && !t.includes("Menu Cookies"));
  assert.equal(pageText("<p>A &amp; B</p>"), "A & B.");
});

test("a long text is cut to the passages that share the claim's words and figures", () => {
  const p = relevantPassages(pageText(GOVUK), "investment in youth facilities has fallen by 73% between 2010/11 and 2022/23");
  assert.ok(p.length <= 1400);
  assert.match(p, /spending on youth facilities fell by 73%/);
  assert.equal(relevantPassages("Short abstract.", "anything"), "Short abstract.", "short text whole");
});

test("only vouched-for sources are read: the abstract for a DOI, else the page", async () => {
  const sources = [
    { title: "Ord & Davies", url: "https://doi.org/10.1177/02690942221098971", stance: "supports" },
    { title: "GOV.UK", url: "https://www.gov.uk/youth", stance: "supports" },
    { title: "Context only", url: "https://example.org/ctx", stance: "context" },
    { title: "Walled", url: "https://paywall.example/x", stance: "supports" },
  ];
  const fetchImpl = fakeFetch({
    [OPENALEX_WORK.replace("https://", "")]: { json: { abstract_inverted_index: toIndex(ORD_ABSTRACT) } },
    "www.gov.uk/youth": { text: GOVUK },
    "paywall.example": { status: 403, text: "denied" },
  });
  const ev = await gatherEvidence(sources, "youth facilities fell by 73%", { fetchImpl, deadlineMs: 2000 });
  assert.deepEqual(ev.map((e) => e.i), [0, 1], "the context source is not read; the walled one has nothing to judge");
  assert.match(ev[0].text, /austerity cuts to youth services/);
  assert.match(ev[1].text, /fell by 73%/);
});

test("the verdicts rewrite the stance, and the snippet becomes the source's own words", () => {
  const sources = [
    { title: "Ord & Davies", stance: "supports", snippet: "Says support for youth leadership increased." },
    { title: "GOV.UK", stance: "supports", snippet: "model's paraphrase" },
    { title: "Walled", stance: "supports", snippet: "kept" },
  ];
  const evidence = [{ i: 0, text: ORD_ABSTRACT }, { i: 1, text: "Between 2010/11 and 2022/23, spending on youth facilities fell by 73%, leaving gaps in services." }];
  const changed = applyVerdicts(sources, evidence, [
    { id: 0, verdict: "topic", quote: "" },
    { id: 1, verdict: "backs", quote: "spending on youth facilities fell by 73%" },
  ]);
  assert.equal(changed, 1);
  assert.equal(sources[0].stance, "context", "Ord & Davies: on the topic, not backing — the extension will not offer it");
  assert.equal(sources[1].stance, "supports");
  assert.equal(sources[1].snippet, "“spending on youth facilities fell by 73%”");
  assert.equal(sources[2].stance, "supports", "unread: the search's label stands");
});

test("a quote that is not in the source's text never becomes its snippet", () => {
  const sources = [{ stance: "supports", snippet: "orig" }];
  applyVerdicts(sources, [{ i: 0, text: "The report covers loneliness." }], [{ id: 0, verdict: "backs", quote: "an invented line that is not there" }]);
  assert.equal(sources[0].snippet, "orig");
});

test("verifySources: one call for all of them, usage returned, and any failure leaves the list alone", async () => {
  const fetchImpl = fakeFetch({ "www.gov.uk/youth": { text: GOVUK } });
  const sources = [{ title: "GOV.UK", url: "https://www.gov.uk/youth", stance: "supports" }];
  let calls = 0, sent = null;
  const call = async (req) => { calls++; sent = req; return { parsed: { verdicts: [{ id: 0, verdict: "topic", quote: "" }] }, usage: { input: 900, output: 60, cached: 0, cacheWrite: 0 } }; };
  const r = await verifySources({ claim: "youth facilities fell by 73%", sources, model: "gpt-5.6-luna", call, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(sent.effort, "low");
  assert.equal(sent.system, VERIFY_SYSTEM);
  assert.match(sent.user, /SOURCE 0: GOV\.UK/);
  assert.deepEqual([r.checked, r.changed, r.usage.input], [1, 1, 900]);
  assert.equal(sources[0].stance, "context");

  const kept = [{ title: "GOV.UK", url: "https://www.gov.uk/youth", stance: "supports" }];
  const boom = async () => { throw Object.assign(new Error("model down"), { llm: { usage: { input: 5, output: 0 } } }); };
  const f = await verifySources({ claim: "x fell by 73%", sources: kept, model: "m", call: boom, fetchImpl });
  assert.equal(kept[0].stance, "supports", "unchanged");
  assert.equal(f.usage.input, 5, "what a failed call billed is still reported");
  const nothing = await verifySources({ claim: "x", sources: [{ url: "https://e.org", stance: "context" }], model: "m", call: async () => { throw new Error("not called"); }, fetchImpl });
  assert.equal(nothing.checked, 0, "nothing vouched for: no call");
});

test("the judge works from the text alone and defaults to topic", () => {
  assert.match(VERIFY_SYSTEM, /Judge from that text ONLY/);
  assert.match(VERIFY_SYSTEM, /This is the answer whenever you are unsure/);
  assert.match(VERIFY_SYSTEM, /"facilities" or "services" when the text means the same figure/);
});

test("wired: after the page lookups, billed with the search, and kept out of the frozen response", () => {
  assert.match(FACTCHECK, /await verifySources\(\{ claim, correction, sources: merged, model: chosenModel \}\)/);
  assert.match(FACTCHECK, /usage: verified\.usage \? addUsage\(usage, verified\.usage\) : usage/);
  assert.match(SERVER, /const \{ webSearchCalls, webSearchActions, enriched, dropped, verified, \.\.\.result \} = await findSources/, "verified never reaches the extension");
  assert.match(SERVER, /verified=\$\{verified\?\.checked \?\? 0\}\/\$\{verified\?\.changed \?\? 0\}/);
});
