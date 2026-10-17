/* The panel's header names the kind of writing Tracely reads (content.js
 * readKind → kindTitle). Owner, 2026-10-13: "on the widget overlay, add the
 * type of literature tracely thinks it is. So for example the header of one
 * will be arguementative essay, anotherone will be email", "create like 15
 * different types". Since 2.21.57 (owner, 2026-10-15: "Fix it for a plethora
 * of writing, so it is very unlikely that tracely will detect something
 * wrong") there are 56 kinds (WRITING_KINDS), and the header names one only
 * when it is very sure (KIND_SURE), else nothing — never a guess. Display
 * only: the genre decides the checks. The kinds' corpora are scored in
 * ext-writing-kinds.test.js. */
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
  ({ detectGenre, readKind, kindTitle, genreTitle, essayTypeOf, GENRE_TITLE, WRITING_KINDS, panelHeadHtml })`, vm.createContext({}));

const CORPORA = [...WRITING_TYPES, ...WRITING_TYPES_HOLDOUT, ...WRITING_TYPES_BLIND2];
// What each corpus essay is, by its name in the corpus.
const ESSAY_WANT = [[/book report/i, "Book report"], [/Compare\/contrast/i, "Compare and contrast essay"], [/Cause\/effect/i, "Cause and effect essay"], [/.*/, "Argumentative essay"]];

test("every kind has a title in sentence case, and a document is only ever named as a kind of its own genre", () => {
  const kinds = Object.entries(X.WRITING_KINDS);
  assert.equal(kinds.length, 56, "the 56 kinds the owner approved");
  for (const [k, { title, genre, label, parent }] of kinds) {
    assert.ok(/^[A-Z]/.test(title) && !/\s[A-Z][a-z]/.test(title), `${title}: sentence case`);
    assert.ok(X.GENRE_TITLE[genre] || genre === "prose", `${k}: ${genre} is a genre`);
    assert.ok(label, k);
    if (parent) assert.ok(X.WRITING_KINDS[parent], `${k}: its broader name is a kind`);
  }
  for (const d of CORPORA.filter((d) => d.expect !== "prose" && X.detectGenre(d.text) === d.expect)) {
    const { kind, shown } = X.readKind(d.text);
    assert.equal(X.WRITING_KINDS[kind].genre, d.expect, d.name);
    if (shown) assert.equal(X.WRITING_KINDS[shown].genre, d.expect, d.name);
  }
  assert.equal(X.GENRE_TITLE.email, "Email");
});

test("an essay's own kind in the three older corpora: right or nothing — never another kind", () => {
  const wrong = [];
  for (const d of CORPORA.filter((d) => d.expect === "prose")) {
    const want = ESSAY_WANT.find(([re]) => re.test(d.name))[1];
    const got = X.genreTitle(X.detectGenre(d.text), d.text);
    if (got !== want && got !== "") wrong.push(`${want} → ${got}: ${d.name}`);
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

test("the header names a kind only when very sure: a recognised shape, not an essay's words alone", () => {
  const essay = "Schools should start later because teenagers need more sleep. ".repeat(12);
  assert.deepEqual({ ...X.readKind(essay) }, { kind: "argumentative", shown: "" }, "checked as an essay, named nothing");
  const memo = "MEMORANDUM\nTo: All staff\nFrom: Dana Ruiz\nDate: October 3\nRe: New closing checklist\n\nStarting Monday every shift lead signs the closing checklist before leaving.";
  assert.deepEqual({ ...X.readKind(memo) }, { kind: "memo", shown: "memo" });
  assert.deepEqual({ ...X.readKind("Thanks for the notes!", "mail.google.com/mail/u/0/") }, { kind: "email", shown: "email" }, "the site is sure");
});

test("an essay's own kind: the ones written for it, tuned and fresh", () => {
  for (const d of [...ESSAY_KINDS_TUNED, ...ESSAY_KINDS_FRESH]) {
    assert.equal(X.detectGenre(d.text), "prose", d.name);
    assert.ok([d.expect, "Essay", ""].includes(X.genreTitle("prose", d.text)), d.name);
  }
});

test("too little text: no title rather than a guess", () => {
  assert.equal(X.essayTypeOf(""), "");
  assert.equal(X.essayTypeOf("Schools should start later."), "");
  assert.equal(X.genreTitle("prose", "Short."), "");
  assert.equal(X.genreTitle("unknown-kind", "x"), "");
  assert.equal(X.kindTitle("", "x ".repeat(80)), "", "nothing named, nothing shown");
  assert.equal(X.genreTitle("prose", "Schools should start later because teenagers need more sleep. ".repeat(12)), "", "unsure: no title");
  assert.equal(X.kindTitle("argumentative", "Short."), "", "an essay's kind needs forty words");
  assert.equal(X.kindTitle("email", "Hi, thanks!"), "Email", "an email does not");
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
  // The fifth argument (2026-10-14): what the kind means for its citations, on the chip's hover (genreNote).
  // Since 2.21.57 the header names what readKind is sure of (docShown), and the note follows it.
  assert.match(SRC, /panelHeadHtml\(tally, statusMsg, statusKind === "error" \|\| statusKind === "offline", kindTitle\(docShown, docText\), \{ note: genreNote\(docGenre, docText, settings\.citationStyle, docShown\)/);
  assert.match(SRC, /panelHeadHtml\(tally, statusMsg, statusKind === "error" \|\| statusKind === "offline", kindTitle\(docShown, fieldText\), \{ note: genreNote\(docGenre, fieldText, settings\.citationStyle, docShown\)/);
});
