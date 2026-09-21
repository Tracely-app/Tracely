/**
 * The fabrication guardrail, ported from the desktop relay along with the
 * prompt it enforces.
 *
 * A prompt rule is a REQUEST. This is the enforcement, and the pair is the
 * whole reason the measured 17% false-fabrication rate on real student drafts
 * is not simply a smaller number now. Telling a student their real source is
 * invented is the most damaging thing this product can say, so the verdict is
 * withdrawn whenever the model was not entitled to reach it — which is a
 * question about what was SEARCHED, not about how confident the model sounded.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCritique, VERDICTS } from "../lib/prompts/critique.js";

const accusing = {
  verdict: "fabricated",
  explanation: "No work by these authors exists.",
  revision: "Some narrowed sentence.",
  overstated: false,
  citationFix: null,
  confidence: 0.9,
};

test("a fabrication verdict needs a citation to accuse", () => {
  const out = normalizeCritique(accusing, { lookupRan: true, lookupResolved: false, citedRef: null });
  assert.equal(out.verdict, "unsupported");
});

test("NO lookup means the verdict is withdrawn, however sure the model sounded", () => {
  const out = normalizeCritique(accusing, { lookupRan: false, citedRef: "Smith, J. (2020). A Study." });
  assert.equal(out.verdict, "unsupported");
  // Replaced, not merely relabelled: the model's sentence asserted absence it
  // had no grounds for, so it must not survive as the explanation.
  assert.match(out.explanation, /not evidence the source is invented/);
  assert.equal(out.revision, "");
});

test("a lookup that FOUND the work withdraws it too — the indexes say it exists", () => {
  const out = normalizeCritique(accusing, { lookupRan: true, lookupResolved: true, citedRef: "Smith, J. (2020). A Study." });
  assert.equal(out.verdict, "unsupported");
  assert.match(out.explanation, /not evidence the source is invented/);
});

test("a lookup that ran and came back empty is the ONE case it survives", () => {
  const out = normalizeCritique(accusing, { lookupRan: true, lookupResolved: false, citedRef: "Smith, J. (2020). A Study." });
  assert.equal(out.verdict, "fabricated");
  assert.equal(out.explanation, "No work by these authors exists.");
});

test("narrowing cannot repair a source, so an unplaced reference carries no revision", () => {
  for (const verdict of ["fabricated", "unsupported"]) {
    const out = normalizeCritique(
      { ...accusing, verdict, revision: "A softer version of the sentence." },
      { lookupRan: true, lookupResolved: false, citedRef: "Smith, J. (2020)." },
    );
    assert.equal(out.revision, "", `${verdict} should not carry a revision when the reference is unplaced`);
  }
});

test("a revision survives when the reference was resolved — only the source is the problem", () => {
  const out = normalizeCritique(
    { ...accusing, verdict: "weak", revision: "Most students, rather than all students." },
    { lookupRan: true, lookupResolved: true, citedRef: "Smith, J. (2020)." },
  );
  assert.equal(out.revision, "Most students, rather than all students.");
});

test("sound and a suggested rewrite are contradictory", () => {
  const out = normalizeCritique({ ...accusing, verdict: "sound", revision: "something" }, { lookupRan: true, lookupResolved: true, citedRef: "x" });
  assert.equal(out.verdict, "sound");
  assert.equal(out.revision, "");
});

test("an unrecognised verdict falls to unsupported rather than through", () => {
  assert.equal(normalizeCritique({ ...accusing, verdict: "definitely-wrong" }, {}).verdict, "unsupported");
  assert.equal(normalizeCritique({}, {}).verdict, "unsupported");
  assert.equal(normalizeCritique(null, {}).verdict, "unsupported");
});

test("citationFix is a trimmed string or null, never an empty one", () => {
  assert.equal(normalizeCritique({ ...accusing, verdict: "weak", citationFix: "   " }, {}).citationFix, null);
  assert.equal(normalizeCritique({ ...accusing, verdict: "weak", citationFix: 42 }, {}).citationFix, null);
  assert.equal(
    normalizeCritique({ ...accusing, verdict: "citationFix", citationFix: "  Smith, J. (2020). A Study. Journal.  " }, {}).citationFix,
    "Smith, J. (2020). A Study. Journal.",
  );
});

test("confidence is clamped, and a missing one is not zero", () => {
  assert.equal(normalizeCritique({ ...accusing, confidence: 5 }, {}).confidence, 1);
  assert.equal(normalizeCritique({ ...accusing, confidence: -2 }, {}).confidence, 0);
  // Absent is "no opinion", not "certainly false" — a zero here would rank a
  // finding last in any UI that sorts by confidence.
  assert.equal(normalizeCritique({ ...accusing, confidence: undefined }, {}).confidence, 0.5);
});

test("the verdict vocabulary is the one shared/marks.js maps, unchanged by the port", () => {
  // marks.js is itself the mirror of the desktop's src/shared/problemKind.ts,
  // so this list is load-bearing on both surfaces. The port deliberately kept
  // it rather than adopting the relay's seven.
  assert.deepEqual(VERDICTS, ["contradicted", "citationFix", "fabricated", "weak", "unsupported", "sound"]);
});

/* ── the request the port assembles ───────────────────────────────────────
 * Both guardrails are really properties of the REQUEST: Pass 2(c) is gated on
 * a heading being present, and Pass 2.5 on an item being tagged. Neither is
 * reachable in mock mode, which short-circuits inside ai.js above the prompt,
 * so these stub fetch and read the body that would have left the process. */
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
delete process.env.TRACELY_MOCK;

const { critiqueClaim } = await import("../lib/ai.js");

function stubAndCapture() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "gpt-5-nano",
        output_text: JSON.stringify({ verdict: "sound", explanation: "ok", revision: "", overstated: false, citationFix: null, confidence: 0.8 }),
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
  };
  return calls;
}

const SOURCES = [
  { title: "Topical one", abstract: "A".repeat(50) },
  { title: "Topical two", abstract: "B".repeat(50) },
  { title: "Topical three", abstract: "C".repeat(50) },
  { title: "Topical four", abstract: "D".repeat(50) },
];

test("with no lookup, the Reference lookup heading is ABSENT — that is the gate", async () => {
  const calls = stubAndCapture();
  await critiqueClaim({ claim: "A claim", sentence: "A claim (Smith 2020).", citedRef: "Smith, J. (2020).", referenceCheck: null, sources: SOURCES });
  assert.ok(!calls[0].input.includes("Reference lookup:"), "the heading must not appear when nothing was searched");
});

test("an empty lookup prints the heading, so the model may reach fabricated", async () => {
  const calls = stubAndCapture();
  await critiqueClaim({
    claim: "A claim",
    sentence: "A claim (Smith 2020).",
    citedRef: "Smith, J. (2020).",
    referenceCheck: { resolved: false, matches: [], resolvedNote: "Not found in Crossref or Open Library." },
    sources: SOURCES,
  });
  assert.match(calls[0].input, /Reference lookup:/);
  assert.match(calls[0].input, /Not found in Crossref/);
});

test("a resolved source is item 1 and is TAGGED, which is what Pass 2.5 keys on", async () => {
  const calls = stubAndCapture();
  await critiqueClaim({
    claim: "A claim",
    sentence: "A claim (Smith 2020).",
    citedRef: "Smith, J. (2020).",
    referenceCheck: { resolved: true, matches: [{ title: "The Real Study", year: 2020, abstract: "It says the thing." }] },
    sources: SOURCES,
  });
  const body = calls[0].input;
  assert.match(body, /\[S1\] The Real Study \[CITED BY THE WRITER\]/);
  assert.match(body, /Other sources found by a topical search:/);
  // Pass 2.5 tells the model to stop at item 1 when it answers. Sending the
  // full list anyway is paying for tokens it was just told to ignore.
  assert.match(body, /\[S2\] Topical one/);
  assert.ok(!body.includes("Topical two"), "only one fallback should ride along when the cited work has an abstract");
});

test("a resolved source with NO abstract cannot answer, so the full set still goes", async () => {
  const calls = stubAndCapture();
  await critiqueClaim({
    claim: "A claim",
    sentence: "A claim (Smith 2020).",
    citedRef: "Smith, J. (2020).",
    referenceCheck: { resolved: true, matches: [{ title: "The Real Study", year: 2020 }] },
    sources: SOURCES,
  });
  const body = calls[0].input;
  assert.match(body, /\[S1\] The Real Study \[CITED BY THE WRITER\]/);
  assert.match(body, /Topical four/, "the prompt's own fall-through condition is met, so they are the evidence");
});
