/* "Remove the detail": a source that backs all of a sentence but one small
 * detail (the server's `partial`, sourceVerify.js coverDetail) is offered as
 * that, never as backing the sentence as written. Owner, 2026-10-13: only a
 * small part or detail, never the claim (server/lib/claimTrim.js decides). */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return s; }
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ backingSources, partialSourceHtml, trimPreviewHtml, trimmedSourceEntry, TRIM_COPY })`, vm.createContext({ URL }));

const SENTENCE = "The novel was published anonymously in 1818, and the revised 1831 edition carries a new preface in which Shelley describes the book's origin during a stay at the Villa Diodati.";
const PARTIAL = {
  quote: "Frankenstein was first published anonymously in London in 1818 … For the revised edition of 1831, Mary Shelley wrote a new introduction explaining how the story had begun",
  missing: "during a stay at the Villa Diodati",
  trimmed: "The novel was published anonymously in 1818, and the revised 1831 edition carries a new preface in which Shelley describes the book's origin.",
};
const NLM = { title: "Frankenstein: Penetrating the Secrets of Nature", url: "https://www.nlm.nih.gov/exhibition/frankenstein/", publisher: "National Library of Medicine", stance: "context", verified: true, readFrom: "page", partial: PARTIAL };
const BLOG = { title: "Frankenstein facts", url: "https://historydraft.com/f", stance: "context", verified: true, partial: { ...PARTIAL } };

test("backingSources: a partial source is offered apart from the backing list, the most citable first, never as backing", () => {
  const r = X.backingSources([BLOG, NLM, { url: "https://example.org/x", stance: "context", verified: true }], null);
  assert.equal(r.list.length, 0, "nothing backs the sentence as written");
  assert.equal(r.partial.url, NLM.url, "an Official source before an unvetted one");
  assert.equal(r.unbacked, 3);
  assert.equal(X.backingSources([{ ...NLM, verified: false }], null).partial, null, "never one Tracely could not read");
  assert.equal(X.backingSources([{ ...NLM, partial: { missing: "x" } }], null).partial, null, "never a partial without its trimmed sentence");
  assert.equal(X.backingSources([NLM], null).list.length, 0);
});

test("the card: the source, what it says, the detail it doesn't mention, the sentence with that detail struck, and the mode's buttons", () => {
  const html = X.partialSourceHtml(SENTENCE, NLM, `<button class="act">Remove</button>`);
  assert.ok(html.includes(X.TRIM_COPY.head));
  assert.ok(html.includes("doesn't mention “during a stay at the Villa Diodati.”"));
  assert.ok(html.includes("The source says: “Frankenstein was first published anonymously in London in 1818"));
  assert.ok(html.includes(`origin <s class="trim-cut">during a stay at the Villa Diodati</s>.`));
  assert.ok(html.includes(">Official</span>"), "the credibility label beside the publisher");
  assert.ok(html.includes(`<button class="act">Remove</button>`));
  assert.equal(X.trimPreviewHtml("A <b> & c", "<b>"), `A <s class="trim-cut">&lt;b&gt;</s> &amp; c`, "escaped");
  assert.equal(X.trimPreviewHtml("No match here.", "elsewhere"), "No match here.");
});

test("after the removal, the source backs the sentence that is left, with its receipt", () => {
  const e = X.trimmedSourceEntry(NLM);
  assert.equal(e.list.length, 1);
  assert.equal(e.list[0].stance, "supports");
  assert.equal(e.list[0].quote, PARTIAL.quote);
  assert.equal(e.list[0].partial, undefined);
  assert.equal(e.partial, null);
});

test("wired in both modes and the Docs card: Remove through Fix in doc / Fix in field, Keep drops the card", () => {
  assert.match(SRC, /function trimPlan\(hash\) \{[\s\S]*?key: `trim:\$\{hash\}`/);
  assert.equal((SRC.match(/const plan = trimPlan\([^)]*\); if \(plan\) docFix\(/g) || []).length, 2, "the panel's click and the Docs card's click call docFix themselves");
  assert.match(SRC, /async function docFix\(hash, anchor = null, revision = null, \{ key = null, afterApplied = null \} = \{\}\)/);
  assert.match(SRC, /data-doc-trim=/);
  assert.match(SRC, /data-field-trim=/);
  assert.match(SRC, /fixInField\(hash, src\.partial\.trimmed\)/);
  assert.match(SRC, /if \(list\.length === 0 && s\.partial\?\.partial\?\.trimmed\) \{/, "the Docs hover card, before its no-backing card");
  assert.match(SRC, /\.filter\(\(\[, st\]\) => st\.list\?\.length \|\| st\.partial\)/, "a partial result is kept across a reload, not searched again");
});
