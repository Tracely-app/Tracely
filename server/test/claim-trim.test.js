/* Removing one small detail so a source backs the rest (lib/claimTrim.js,
 * the deterministic half; sourceVerify.js applyCoverage, the model's half).
 * Owner, 2026-10-13: only a small part or detail, never the claim itself. */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { trimSentence } from "../lib/claimTrim.js";
import { setHostResolver } from "../lib/citeMeta.js";
import { applyCoverage, paragraphAfter, verifySources, VERIFY_SYSTEM, COVER_SYSTEM, COVER_SCHEMA, COVER_MAX_TOKENS } from "../lib/sourceVerify.js";
import * as reasoning from "../lib/reasoning.js";

test.before(() => setHostResolver(async () => [{ address: "93.184.216.34" }]));
test.after(() => setHostResolver(null));

const SHELLEY = "The novel was published anonymously in 1818, and the revised 1831 edition carries a new preface in which Shelley describes the book's origin during a stay at the Villa Diodati.";
const AFTER = " Read against that preface, the famous phrase about the \"workshop of filthy creation\" sounds less like laboratory horror than like secrecy.";
const PARAGRAPH = SHELLEY + AFTER;

test("a small detail comes out, and the sentence still reads", () => {
  assert.deepEqual(trimSentence(SHELLEY, "during a stay at the Villa Diodati", { after: AFTER }), {
    ok: true,
    sentence: "The novel was published anonymously in 1818, and the revised 1831 edition carries a new preface in which Shelley describes the book's origin.",
    removed: "during a stay at the Villa Diodati",
  });
  assert.equal(trimSentence("The first phone running Android, the HTC Dream, went on sale in October 2008 in the United States.", "in October 2008").sentence,
    "The first phone running Android, the HTC Dream, went on sale in the United States.", "a bare date is a detail");
  assert.equal(trimSentence("Byron's guests, among them a young doctor, told ghost stories at the villa that wet summer of the year.", ", among them a young doctor").ok, false, "'among' opens a scope");
});

test("never the claim: not a qualifier, a scope, a figure, an attribution, a long passage, or what the paragraph uses next", () => {
  const no = (sentence, remove, after = "") => trimSentence(sentence, remove, { after }).reason;
  assert.equal(no("Some studies suggest that screen time harms sleep in teenagers across Europe.", "Some studies suggest"), "it would change what the sentence claims");
  assert.equal(no("Students in the US rarely get enough sleep on school nights.", "in the US"), "it limits who or where the claim holds");
  assert.equal(no("Teenagers require between eight and ten hours of sleep, and roughly 70 percent of them get less than seven.", "and roughly 70 percent of them get less than seven"), "more than a small detail");
  assert.equal(no("Remote workers at a Chinese travel agency were 13 percent more productive, according to a 2015 study by Nicholas Bloom.", "by Nicholas Bloom"), "it names the source");
  assert.equal(no("The bridge, which cost 40 million dollars to build in the end, opened to traffic in the spring of that year.", "which cost 40 million dollars"), "it carries a figure");
  assert.equal(no(SHELLEY, "during a stay at the Villa Diodati", "At the Villa Diodati, Byron proposed the ghost-story contest."), "the paragraph goes on to use it");
  assert.equal(no("Gutenberg printed the Bible in Mainz.", "in Mainz"), "it limits who or where the claim holds");
  assert.equal(no(SHELLEY, "the Villa Medici"), "the detail is not in the sentence, once");
  assert.equal(no("A short one here.", "here"), "too little would be left");
});

test("the paragraph after the sentence, or nothing when the sentence is not in it", () => {
  assert.equal(paragraphAfter(PARAGRAPH, SHELLEY), AFTER);
  assert.equal(paragraphAfter("Something else entirely.", SHELLEY), "");
});

// ── the model's half, applied ──
const EVIDENCE = [{ i: 0, passages: [{ from: "page", text: "Frankenstein was first published anonymously in London in 1818. For the revised edition of 1831, Mary Shelley wrote a new introduction explaining how the story had begun, recalling the ghost-story challenge among friends." }] }];
const PARTS = [
  { text: "The novel was published anonymously in 1818", role: "claim" },
  { text: "the revised 1831 edition carries a new preface in which Shelley describes the book's origin", role: "claim" },
  { text: "during a stay at the Villa Diodati", role: "detail" },
];
const STATED = [{ part: 0, quote: "Frankenstein was first published anonymously in London in 1818" }, { part: 1, quote: "For the revised edition of 1831, Mary Shelley wrote a new introduction explaining how the story had begun" }];
const read = () => [{ title: "Frankenstein at 200", url: "https://example.org/f", stance: "context", verified: true, readFrom: "page" }];

test("coverage: every claim part quoted, one detail missing → partial, still on topic, never backing", () => {
  const sources = read();
  const t = applyCoverage(SHELLEY, AFTER, sources, EVIDENCE, { parts: PARTS, sources: [{ id: 0, stated: STATED }] });
  assert.deepEqual(t, { checked: 1, trims: 1 });
  assert.equal(sources[0].stance, "context");
  assert.deepEqual(sources[0].partial, {
    quote: "Frankenstein was first published anonymously in London in 1818 … For the revised edition of 1831, Mary Shelley wrote a new introduction explaining how the story had begun",
    missing: "during a stay at the Villa Diodati",
    trimmed: "The novel was published anonymously in 1818, and the revised 1831 edition carries a new preface in which Shelley describes the book's origin.",
  });
});

test("coverage: no partial when a claim part is missing, two parts are, the missing part is a qualifier, a quote is not in the text, or the parts are not the sentence's words", () => {
  const none = (parsed) => { const s = read(); applyCoverage(SHELLEY, AFTER, s, EVIDENCE, parsed); return s[0].partial; };
  assert.equal(none({ parts: PARTS, sources: [{ id: 0, stated: [STATED[0]] }] }), undefined, "a claim part unbacked: it needs a source");
  assert.equal(none({ parts: PARTS.map((p, k) => (k === 2 ? { ...p, role: "qualifier" } : p)), sources: [{ id: 0, stated: STATED }] }), undefined, "a qualifier is never removed");
  assert.equal(none({ parts: PARTS, sources: [{ id: 0, stated: [STATED[0], { part: 1, quote: "Shelley wrote a preface at the Villa" }] }] }), undefined, "a quote not in the text counts for nothing");
  assert.equal(none({ parts: [{ text: "The novel was published anonymously", role: "claim" }, { text: "in Paris", role: "detail" }], sources: [{ id: 0, stated: [STATED[0]] }] }), undefined, "a part that is not in the sentence");
  assert.equal(none({ parts: [PARTS[0]], sources: [{ id: 0, stated: [STATED[0]] }] }), undefined, "one part is not a split");
  const s = [{ ...read()[0], stance: "supports" }];
  applyCoverage(SHELLEY, AFTER, s, EVIDENCE, { parts: PARTS, sources: [{ id: 0, stated: STATED }] });
  assert.equal(s[0].partial, undefined, "only a source on the topic, never one already backing");
});

// ── the second call, end to end with a stubbed model ──
function fetchPage(text) {
  return async () => ({ ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === "content-type" ? "text/html" : null) }, json: async () => ({}), text: async () => `<html><body><p>${text}</p><p>${"Unrelated filler about other books and their authors. ".repeat(20)}</p></body></html>` });
}
const PAGE = EVIDENCE[0].passages[0].text;

test("verifySources: nothing backs → one more call, COVER_SYSTEM, the paragraph sent, partial set and its tokens billed", async () => {
  const sent = [];
  const call = async (req) => {
    sent.push(req);
    if (req.system === VERIFY_SYSTEM) return { parsed: { verdicts: [{ id: 0, verdict: "topic", quote: "" }] }, usage: { input: 900, output: 60 } };
    return { parsed: { parts: PARTS, sources: [{ id: 0, stated: STATED }] }, usage: { input: 700, output: 200 } };
  };
  const sources = [{ title: "Frankenstein at 200", url: "https://example.org/f", stance: "supports" }];
  const r = await verifySources({ claim: SHELLEY, sources, model: "m", call, fetchImpl: fetchPage(PAGE), partial: true, context: PARAGRAPH });
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1].system, sent[1].schema, sent[1].maxTokens, sent[1].effort], [COVER_SYSTEM, COVER_SCHEMA, COVER_MAX_TOKENS, "low"]);
  assert.match(sent[1].user, /PARAGRAPH \(what the essay needs the sentence for\):\nThe novel was published/);
  assert.equal(r.partial, 1);
  assert.deepEqual([r.usage.input, r.usage.output], [1600, 260]);
  assert.equal(sources[0].stance, "context");
  assert.equal(sources[0].partial.missing, "during a stay at the Villa Diodati");
});

test("verifySources: no second call when a source backs, when there is a correction, or when partial is not asked for; a failing one changes nothing", async () => {
  const run = async (verdict, opts) => {
    let n = 0;
    const call = async (req) => { n++; if (req.system === VERIFY_SYSTEM) return { parsed: { verdicts: [{ id: 0, verdict, quote: verdict === "backs" ? "first published anonymously in London in 1818" : "" }] }, usage: { input: 1, output: 1 } }; throw Object.assign(new Error("cover down"), { llm: { usage: { input: 7, output: 0 } } }); };
    const sources = [{ title: "F", url: "https://example.org/f", stance: "context" }];
    const r = await verifySources({ claim: SHELLEY, sources, model: "m", call, fetchImpl: fetchPage(PAGE), ...opts });
    return { n, r, s: sources[0] };
  };
  assert.equal((await run("backs", { partial: true })).n, 1, "something backs: nothing to trim");
  assert.equal((await run("topic", { partial: true, correction: "It was 1817." })).n, 1, "a wrong sentence is corrected, not trimmed");
  assert.equal((await run("topic", {})).n, 1, "not asked");
  const failed = await run("topic", { partial: true });
  assert.equal(failed.n, 2);
  assert.deepEqual([failed.s.stance, failed.s.verified, failed.s.partial], ["context", true, undefined], "the verdicts stand");
  assert.equal(failed.r.usage.input, 8, "what the failed call billed is kept");
});

test("the desktop's route: partial only when asked, and the receipt carries the trim", async () => {
  assert.equal(reasoning.verifySourcesInput({ claim: "c", sources: [{ id: "a" }] }).partial, false);
  assert.equal(reasoning.verifySourcesInput({ claim: "c", sources: [{ id: "a" }], partial: true }).partial, true);
  const call = async (req) => (req.system === VERIFY_SYSTEM
    ? { parsed: { verdicts: [{ id: 0, verdict: "topic", quote: "" }] }, usage: { input: 1, output: 1 } }
    : { parsed: { parts: PARTS, sources: [{ id: 0, stated: STATED }] }, usage: { input: 1, output: 1 } });
  const r = await reasoning.verifySources({ claim: SHELLEY, context: PARAGRAPH, partial: true, sources: [{ id: "f", title: "Frankenstein at 200", url: "https://example.org/f" }], model: "m", call, fetchImpl: fetchPage(PAGE) });
  assert.equal(r.receipts[0].verdict, "topic");
  assert.equal(r.receipts[0].trim.missing, "during a stay at the Villa Diodati");
  assert.equal(r.tally.partial, 1);
});

test("the search turns it on for the extension, never for a correction", () => {
  const FACTCHECK = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "factcheck.js"), "utf8");
  assert.match(FACTCHECK, /partial: true, context: context \? claimWindow\(context, claim\) : ""/);
});
