/* The panel's header names the kind of writing Tracely reads (content.js
 * genreTitle). Owner, 2026-10-13: "on the widget overlay, add the type of
 * literature tracely thinks it is. So for example the header of one will be
 * arguementative essay, anotherone will be email", "create like 15 different
 * types". detectGenre's seventeen kinds, and for an essay ("prose") its own
 * kind (essayTypeOf): argumentative, informative, compare and contrast, cause
 * and effect, a book report, a blog post. Display only. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";
import { WRITING_TYPES } from "./fixtures/writing-types.js";
import { WRITING_TYPES_HOLDOUT } from "./fixtures/writing-types-holdout.js";
import { WRITING_TYPES_BLIND2 } from "./fixtures/writing-types-blind2.js";
import { ESSAY_KINDS_TUNED, ESSAY_KINDS_FRESH } from "./fixtures/essay-kinds.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const X = vm.runInContext(`
  const CHECK_INTERVAL_MS = 10000;
  const FEATURES = { citeHintsToggle: false };
  function hashText(s) { return s; }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ detectGenre, genreTitle, essayTypeOf, GENRE_TITLE, panelHeadHtml })`, vm.createContext({}));

const CORPORA = [...WRITING_TYPES, ...WRITING_TYPES_HOLDOUT, ...WRITING_TYPES_BLIND2];
// What each corpus essay is, by its name in the corpus.
const ESSAY_WANT = [[/Blog post/i, "Blog post"], [/book report/i, "Book report"], [/Compare\/contrast/i, "Compare and contrast essay"], [/Cause\/effect/i, "Cause and effect essay"], [/.*/, "Argumentative essay"]];

test("every kind detectGenre reads has a header title, in sentence case", () => {
  for (const d of CORPORA.filter((d) => d.expect !== "prose")) {
    assert.ok(X.GENRE_TITLE[d.expect], `${d.expect} has a title`);
    if (X.detectGenre(d.text) === d.expect) assert.equal(X.genreTitle(d.expect, d.text), X.GENRE_TITLE[d.expect], d.name);
  }
  for (const t of Object.values(X.GENRE_TITLE)) assert.ok(/^[A-Z]/.test(t) && !/\s[A-Z][a-z]/.test(t), `${t}: sentence case`);
  assert.equal(X.GENRE_TITLE.email, "Email");
});

test("more than fifteen kinds in all", () => {
  const essays = new Set([...ESSAY_KINDS_TUNED, ...ESSAY_KINDS_FRESH].map((d) => d.expect).concat(["Book report", "Blog post"]));
  const all = new Set([...Object.values(X.GENRE_TITLE), ...essays]);
  assert.ok(all.size >= 15, `${all.size} kinds`);
  assert.equal(all.size, 23);
});

test("an essay's own kind: every essay in the three corpora (tuned on them)", () => {
  const wrong = [];
  for (const d of CORPORA.filter((d) => d.expect === "prose")) {
    const want = ESSAY_WANT.find(([re]) => re.test(d.name))[1];
    const got = X.genreTitle(X.detectGenre(d.text), d.text);
    if (got !== want) wrong.push(`${want} → ${got}: ${d.name}`);
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

test("an essay's own kind: the ones written for it, tuned and fresh", () => {
  for (const d of [...ESSAY_KINDS_TUNED, ...ESSAY_KINDS_FRESH]) {
    assert.equal(X.detectGenre(d.text), "prose", d.name);
    assert.equal(X.genreTitle("prose", d.text), d.expect, d.name);
  }
});

test("too little text: no title rather than a guess", () => {
  assert.equal(X.essayTypeOf(""), "");
  assert.equal(X.essayTypeOf("Schools should start later."), "");
  assert.equal(X.genreTitle("prose", "Short."), "");
  assert.equal(X.genreTitle("unknown-kind", "x"), "");
});

test("the header: a neutral chip beside the name, escaped, and nothing when there is no title", () => {
  const html = X.panelHeadHtml({}, "", false, "Argumentative essay");
  assert.match(html, /<span class="name">Tracely<\/span>\s*<span class="kind" title="What Tracely reads this as">Argumentative essay<\/span>/);
  assert.doesNotMatch(X.panelHeadHtml({}, "", false, ""), /class="kind"/);
  assert.doesNotMatch(X.panelHeadHtml({}, "", false), /class="kind"/, "an older caller");
  assert.match(X.panelHeadHtml({}, "", false, "<b>"), /class="kind"[^>]*>&lt;b&gt;</);
  assert.match(SRC, /\.head \.kind \{[^}]*background: var\(--chip-wash\); color: var\(--chip-ink\);/, "never a finding's colour");
});

test("wired in both modes", () => {
  assert.match(SRC, /panelHeadHtml\(tally, statusMsg, statusKind === "error" \|\| statusKind === "offline", genreTitle\(docGenre, docText\)\)/);
  assert.match(SRC, /panelHeadHtml\(tally, statusMsg, statusKind === "error" \|\| statusKind === "offline", genreTitle\(docGenre, fieldText\)\)/);
});
