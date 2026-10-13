/* How citable is a source the extension offers? content.js credibilityOf is
 * a copy of the desktop's src/shared/sourceCredibility.ts (decided from the
 * publisher, never by the model; unvetted is ranked last and labelled, never
 * dropped). Each source row shows the label beside its publisher, with the
 * reason on hover, and backingSources offers the most citable first. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const DESKTOP = path.join(HERE, "..", "..", "src", "shared", "sourceCredibility.ts");

const X = vm.runInContext(`const CHECK_INTERVAL_MS = 10000; function hashText(s) { return s; }
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ credibilityOf, credibilityFor, byCredibility, sourceMetaHtml, backingSources, unreadSourcesHtml })`, vm.createContext({ URL }));

let SKIP = false;
if (!existsSync(DESKTOP)) SKIP = "no desktop tree (a server-only checkout)";
else if (!process.features?.typescript) SKIP = `this Node (${process.version}) cannot strip TypeScript types`;
const desktop = SKIP ? null : await import(pathToFileURL(DESKTOP).href);

const CORPUS = [
  { url: "https://doi.org/10.1093/qje/qju032", doi: "10.1093/qje/qju032", venueType: "journal" },
  { url: "https://www.cdc.gov/antibiotic-use/data/outpatient-prescribing.html" },
  { url: "https://www.gov.uk/government/statistics/x" },
  { url: "https://www.ox.ac.uk/research" },
  { url: "https://www.who.int/news-room/fact-sheets/detail/antimicrobial-resistance" },
  { url: "https://data.worldbank.org/indicator/EG.ELC.ACCS.ZS" },
  { url: "https://www.britannica.com/biography/Johannes-Gutenberg" },
  { url: "https://www.loc.gov/item/x" },
  { url: "https://www.nytimes.com/2023/01/01/x.html" },
  { url: "https://news.bbc.co.uk/x" },
  { url: "https://nottime.com/x" },
  { url: "https://en.wikipedia.org/wiki/Printing_press" },
  { url: "https://arxiv.org/abs/1234", venueType: "preprint" },
  { url: "https://example-journal.net/x", doi: "10.1234/x" },
  { url: "https://historydraft.com/story/printing-press" },
  { url: "not a url" },
  {},
];

test("the same verdict as the desktop on every source", { skip: SKIP }, () => {
  // Spread: an object made in the vm sandbox has the sandbox's prototype.
  for (const s of CORPUS) assert.deepEqual({ ...X.credibilityOf(s) }, desktop.credibilityOf(s), JSON.stringify(s));
});

test("an extension source: a journal article with a DOI is peer-reviewed; the rest by its publisher", () => {
  const label = (s) => X.credibilityFor(s).label;
  assert.equal(label({ url: "https://doi.org/10.1093/qje/qju032", doi: "10.1093/qje/qju032", kind: "journal" }), "Peer-reviewed");
  assert.equal(label({ url: "https://doi.org/10.1093/qje/qju032", doi: "10.1093/qje/qju032", kind: "book" }), "Check this one", "a DOI on a book: academic-looking, publisher unconfirmed");
  assert.equal(label({ url: "https://www.cdc.gov/x", kind: "institutional" }), "Official");
  assert.equal(label({ url: "https://www.britannica.com/x", kind: "reference" }), "Reference work");
  assert.equal(label({ url: "https://www.reuters.com/x", kind: "news" }), "News of record");
  assert.equal(label({ url: "https://en.wikipedia.org/wiki/X", kind: "reference" }), "Encyclopedia");
  assert.equal(label({ url: "https://historydraft.com/x", kind: "other" }), "Check this one");
});

test("backing sources come most citable first; within a tier the server's order stands; unread stays apart", () => {
  const blog = { url: "https://historydraft.com/a", stance: "supports", verified: true };
  const blog2 = { url: "https://thevintagenews.com/b", stance: "supports", verified: true };
  const cdc = { url: "https://www.cdc.gov/c", stance: "supports", verified: true };
  const paper = { url: "https://doi.org/10.1/d", doi: "10.1/d", kind: "journal", stance: "supports", verified: true };
  const walled = { url: "https://www.nytimes.com/e", stance: "context", verified: false };
  const { list, unread } = X.backingSources([blog, cdc, blog2, paper, walled], null);
  assert.deepEqual(Array.from(list, (s) => s.url), [paper.url, cdc.url, blog.url, blog2.url]);
  assert.deepEqual(Array.from(unread, (s) => s.url), [walled.url]);
});

test("a source row's meta: publisher, then the label in the meta's own grey, the reason on hover", () => {
  const html = X.sourceMetaHtml({ url: "https://www.cdc.gov/x", publisher: "Centers for Disease Control & Prevention" });
  assert.equal(html, `Centers for Disease Control &amp; Prevention · <span class="src-cred" title="Published by the government, university or organisation it is about.">Official</span>`);
  assert.equal(X.sourceMetaHtml({ url: "https://historydraft.com/x" }), `<span class="src-cred" title="Tracely does not recognise this publisher. It may still be fine — check who wrote it and whether they cite their own sources.">Check this one</span>`, "no publisher: the label alone");
  assert.ok(!/color|style=/.test(html), "no colour of its own: colour only means a finding");
  assert.ok(X.unreadSourcesHtml("h", [{ url: "https://en.wikipedia.org/wiki/X", title: "X", publisher: "Wikipedia" }], true).includes(">Encyclopedia</span>"), "the unread list says it too");
});
