import { test } from "node:test";
import assert from "node:assert/strict";
import { problemsFor, markFor, PROBLEM_KINDS, COLORS } from "../shared/marks.js";

const base = {
  status: "checked",
  claimType: "factual",
  confidence: 0.8,
  hasOwnCitation: false,
  citationDefects: [],
  searched: true,
  sources: { count: 0, aboveFloor: 0, citableAboveFloor: 0, providers: ["openalex"] },
  outsideIndex: false,
  strength: null,
  critique: null,
};

test("pending claims carry only the grey searching mark", () => {
  assert.deepEqual(problemsFor({ status: "pending" }), ["searching"]);
  assert.equal(markFor({ status: "pending" }).color, "grey");
});

test("RULE: never flag a correctly cited sentence on retrieval's say-so", () => {
  const cited = { ...base, hasOwnCitation: true, sources: { ...base.sources, count: 0 } };
  const kinds = problemsFor(cited);
  assert.ok(!kinds.includes("no-sources"), "retrieval reported on a cited sentence it never opened");
  assert.ok(!kinds.includes("weak-evidence"));
  assert.ok(!kinds.includes("missing-citation"));
});

test("uncited claim with zero sources → no-sources (orange)", () => {
  const kinds = problemsFor(base);
  assert.ok(kinds.includes("no-sources"));
  assert.equal(markFor(base).color, "orange");
});

test("outside-index outranks nothing but suppresses no-sources", () => {
  const st = { ...base, outsideIndex: true };
  const kinds = problemsFor(st);
  assert.ok(kinds.includes("outside-index"));
  assert.ok(!kinds.includes("no-sources"));
});

test("contradicted verdict → red mark; fabricated outranks it", () => {
  const contradicted = { ...base, critique: { verdict: "contradicted", overstated: false } };
  assert.equal(markFor(contradicted).kind, "contradicted-claim");
  assert.equal(markFor(contradicted).hex, COLORS.red);
  const both = { ...base, hasOwnCitation: true, critique: { verdict: "fabricated", overstated: false } };
  assert.equal(markFor(both).kind, "fabricated-citation");
});

test("weak vs partial strength bands (uncited, above-floor evidence)", () => {
  const weak = { ...base, sources: { count: 3, aboveFloor: 2, citableAboveFloor: 2 }, strength: { score: 20, metric: "lexical" } };
  assert.ok(problemsFor(weak).includes("weak-evidence"));
  const partial = { ...base, sources: { count: 3, aboveFloor: 2, citableAboveFloor: 2 }, strength: { score: 50, metric: "lexical" } };
  const kinds = problemsFor(partial);
  assert.ok(kinds.includes("partial-evidence"));
  assert.ok(!kinds.includes("weak-evidence"));
});

test("unverified statistic flags only when no citable source and critique not sound", () => {
  const stat = { ...base, claimType: "statistic" };
  assert.ok(problemsFor(stat).includes("unverified-statistic"));
  const sound = { ...stat, critique: { verdict: "sound", overstated: false } };
  assert.ok(!problemsFor(sound).includes("unverified-statistic"));
});

test("missing-citation needs citable evidence available and a citation-needing claim type", () => {
  const st = { ...base, sources: { count: 3, aboveFloor: 2, citableAboveFloor: 2 }, strength: { score: 80, metric: "lexical" } };
  assert.ok(problemsFor(st).includes("missing-citation"));
  const opinion = { ...st, claimType: "opinion" };
  assert.ok(!problemsFor(opinion).includes("missing-citation"));
});

test("sound critique on a clean cited claim → no marks at all", () => {
  const clean = {
    ...base, hasOwnCitation: true,
    sources: { count: 4, aboveFloor: 3, citableAboveFloor: 3 },
    strength: { score: 85, metric: "lexical" },
    critique: { verdict: "sound", overstated: false },
  };
  assert.equal(markFor(clean), null);
});

test("retrieval miss: an unsupported verdict over zero relevant sources is a report on the SEARCH", () => {
  // Ported from the production problemKind.ts isRetrievalMiss: the critique
  // handed nothing on-topic cannot indict the sentence — the empty-retrieval
  // kinds report the same state honestly instead.
  const miss = {
    ...base,
    sources: { count: 8, aboveFloor: 0, citableAboveFloor: 0, providers: ["openalex"] },
    critique: { verdict: "unsupported", overstated: false },
  };
  const kinds = problemsFor(miss);
  assert.ok(!kinds.includes("unsupported-by-evidence"), "verdict reached over an empty table was reported as a finding");
  assert.ok(kinds.includes("no-sources"));
  // With relevant evidence in front of it, the same verdict IS a finding.
  const real = { ...miss, sources: { count: 8, aboveFloor: 3, citableAboveFloor: 2, providers: ["openalex"] } };
  assert.ok(problemsFor(real).includes("unsupported-by-evidence"));
});

test("no-sources keys on the relevance floor, not the raw row count", () => {
  // Providers return a merged list for nearly any query; eight off-topic rows
  // are still 'nothing found'.
  const offTopic = { ...base, sources: { count: 8, aboveFloor: 0, citableAboveFloor: 0, providers: ["openalex"] } };
  assert.ok(problemsFor(offTopic).includes("no-sources"));
});

test("the empty-retrieval kinds are mutually exclusive: outside-index > unverified-statistic > no-sources", () => {
  const statOutside = { ...base, claimType: "statistic", outsideIndex: true };
  const kinds = problemsFor(statOutside);
  assert.deepEqual(kinds.filter((k) => ["outside-index", "unverified-statistic", "no-sources"].includes(k)), ["outside-index"]);
  const statIn = { ...base, claimType: "statistic" };
  const kinds2 = problemsFor(statIn);
  assert.ok(kinds2.includes("unverified-statistic"));
  assert.ok(!kinds2.includes("no-sources"));
});

test("a shape defect fires without a citation gate — wrong the moment it is typed", () => {
  const defect = { ...base, hasOwnCitation: false, citationDefects: ["citation-needed"] };
  assert.ok(problemsFor(defect).includes("citation-defect"));
});

test("missing-citation only when the evidence is strong — weak/partial bands name their own problem", () => {
  const partial = { ...base, sources: { count: 3, aboveFloor: 2, citableAboveFloor: 2 }, strength: { score: 50, metric: "lexical" } };
  const kinds = problemsFor(partial);
  assert.ok(kinds.includes("partial-evidence"));
  assert.ok(!kinds.includes("missing-citation"), "'add a citation' over thin evidence points at the wrong repair");
});

test("rank: cited-unverified sits directly under contradicted; outside-index is last of the real findings", () => {
  const ranked = PROBLEM_KINDS.map((p) => p.kind);
  assert.equal(ranked.indexOf("cited-unverified"), ranked.indexOf("contradicted-claim") + 1);
  assert.equal(ranked.indexOf("outside-index"), ranked.length - 2); // only 'searching' below it
  assert.equal(ranked.indexOf("citation-defect"), ranked.indexOf("fabricated-citation") + 1);
});

test("problem order follows the ranked list", () => {
  const ranked = PROBLEM_KINDS.map((p) => p.kind);
  const messy = {
    ...base, hasOwnCitation: true, citationDefects: ["bare-url"],
    critique: { verdict: "contradicted", overstated: true },
  };
  const kinds = problemsFor(messy);
  const idx = kinds.map((k) => ranked.indexOf(k));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), "kinds not in rank order");
});

// ── the relay's verdict vocabulary ───────────────────────────────────────
// The critique moved from this server's own six verdicts (+ an overstated
// boolean) to the desktop relay's seven. Each case below is a verdict the old
// table could not express, or one whose meaning changed.

const withVerdict = (verdict, extra = {}) => ({ ...base, critique: { verdict, citationFix: null }, ...extra });

test("overstated is its own verdict now, and draws the amber narrow-this mark", () => {
  assert.ok(problemsFor(withVerdict("overstated")).includes("overstated-claim"));
});

test("a weak verdict is NOT promoted to overstated any more, however confident the detection", () => {
  // The old table inferred overstatement from weak + confidence >= 0.85,
  // because the old prompt had no overstated verdict. The relay's does, so the
  // proxy would contradict what the critique actually said.
  const kinds = problemsFor(withVerdict("weak", { confidence: 0.95 }));
  assert.ok(!kinds.includes("overstated-claim"), JSON.stringify(kinds));
});

test("well-supported behaves exactly as sound did", () => {
  const stat = { ...base, claimType: "statistic", sources: { ...base.sources, citableAboveFloor: 0 } };
  assert.ok(!problemsFor({ ...stat, critique: { verdict: "well-supported", citationFix: null } }).includes("unverified-statistic"));
  assert.deepEqual(
    problemsFor({ ...stat, critique: { verdict: "well-supported", citationFix: null } }),
    problemsFor({ ...stat, critique: { verdict: "sound", overstated: false } }),
  );
});

test("partially-supported is a verdict that draws the partial mark, not the weak one", () => {
  const kinds = problemsFor(withVerdict("partially-supported"));
  assert.ok(kinds.includes("partial-evidence"), JSON.stringify(kinds));
  assert.ok(!kinds.includes("weak-evidence"), JSON.stringify(kinds));
});

test("a corrected reference from the critique is a citation defect", () => {
  // The relay returns citationFix as a FIELD. It used to be a verdict that
  // drew "citation may not support this", which is not what a malformed but
  // real reference means.
  const kinds = problemsFor({ ...base, hasOwnCitation: true, critique: { verdict: "well-supported", citationFix: "Smith, J. (2019)." } });
  assert.ok(kinds.includes("citation-defect"), JSON.stringify(kinds));
});

test("a cited sentence the critique doubts is 'citation may not support this', not 'thin evidence'", () => {
  for (const verdict of ["weak", "unsupported"]) {
    const kinds = problemsFor({ ...base, hasOwnCitation: true, critique: { verdict, citationFix: null } });
    assert.ok(kinds.includes("cited-unverified"), `${verdict}: ${JSON.stringify(kinds)}`);
    assert.ok(!kinds.includes("weak-evidence") && !kinds.includes("unsupported-by-evidence"), `${verdict}: ${JSON.stringify(kinds)}`);
  }
});

test("well-supported and partially-supported never say the writer's citation is doubtful", () => {
  for (const verdict of ["well-supported", "partially-supported", "overstated"]) {
    const kinds = problemsFor({ ...base, hasOwnCitation: true, critique: { verdict, citationFix: null } });
    assert.ok(!kinds.includes("cited-unverified"), `${verdict}: ${JSON.stringify(kinds)}`);
  }
});
