/* What kind of writing a document is, and what that means for its
 * citations (content.js detectGenre and its policy). Owner, 2026-10-09: "make
 * it extremely good at type of literature detection. For example, if it is
 * world history DBQ, no need for citations and worked cited. If it is a poem,
 * cite this way. If it is a research paper, cite that way. Even things i dont
 * mention such as resumes or emails be able to detect even writing types like
 * that."
 *
 * Two corpora: fixtures/writing-types.js, the documents the detector was
 * tuned on (every one must be read right), and
 * fixtures/writing-types-holdout.js, written blind by another author and
 * never tuned on — its score is the honest one. Every document is invented. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sliceBetween } from "./helpers/anchors.js";
import { WRITING_TYPES } from "./fixtures/writing-types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "..", "..", "extension", "content.js"), "utf8");
const HOLDOUT = path.join(HERE, "fixtures", "writing-types-holdout.js");
const plain = (v) => JSON.parse(JSON.stringify(v));

const X = vm.runInContext(`
  const CHECK_INTERVAL_MS = 10000;
  const FEATURES = { citeHintsToggle: false };
  function hashText(s) { return "h" + s.length + s.slice(0, 16); }
  ${sliceBetween(SRC, "  const ISSUE_VERDICTS =", "  /* Card titles")}
  ${sliceBetween(SRC, "  // Bibliography block", "  function wireChrome(")}
  ({ detectGenre, flagShown, genreLineHtml, isArgumentGenre, genreWantsList, citationTips, referenceTips, quoteCitationTips, literaryForm, docCitationStyle,
     citedWorksWithoutList, noListTip, citedMatchFor, attributeAloud, GENRE_LABEL })`, vm.createContext({}));

const KINDS = ["dbq", "research", "lab", "literary", "poem", "story", "script", "speech", "news", "personal", "email", "coverletter", "letter", "resume", "notes", "annotated", "homework", "prose"];

test("every kind of writing in the tuned corpus is read right", () => {
  const wrong = WRITING_TYPES.filter((d) => X.detectGenre(d.text) !== d.expect).map((d) => `${d.expect} → ${X.detectGenre(d.text)}: ${d.name}`);
  assert.deepEqual(wrong, [], wrong.join("\n"));
  for (const k of KINDS) assert.ok(WRITING_TYPES.some((d) => d.expect === k), `the corpus has ${k}`);
  for (const k of KINDS.filter((k) => k !== "prose")) assert.ok(X.GENRE_LABEL[k], `the panel can name ${k}`);
});

test("a held-out corpus, written blind, is read right at least 9 times in 10", { skip: !existsSync(HOLDOUT) && "no holdout corpus" }, async () => {
  const { WRITING_TYPES_HOLDOUT } = await import(pathToFileURL(HOLDOUT));
  const wrong = WRITING_TYPES_HOLDOUT.filter((d) => X.detectGenre(d.text) !== d.expect);
  const share = 1 - wrong.length / WRITING_TYPES_HOLDOUT.length;
  assert.ok(share >= 0.9, `${Math.round(share * 100)}% right; wrong:\n${wrong.map((d) => `${d.expect} → ${X.detectGenre(d.text)}: ${d.name}`).join("\n")}`);
});

test("short and odd documents: an essay unless something says otherwise", () => {
  const cases = [
    ["", "prose"], ["Sleep matters.", "prose"],
    ["My Essay\nSchools should start later. Teens need more sleep. Studies show later starts help grades.", "prose"],
    ["Why the Ocean Is Salty\nRivers carry minerals from rocks into the sea every day.\nEvaporation removes water but leaves the salt behind.\nOver millions of years the salt builds up to about 3.5 percent.\nThat is why seawater tastes the way it does today.\nSo next time you swim, remember the rivers.", "prose"],
    ["Hello,\nCan you send me the notes from class?\nThanks", "email"],
    ["Roses are red,\nViolets are blue,\nSugar is sweet,\nAnd so are you.", "poem"],
    ["Introduction\nHook\nThesis\nBody 1\nBody 2\nConclusion", "notes"],
    ["1. What is photosynthesis?\n2. Where does it happen?\n3. Why do plants need light?", "homework"],
    ["Title\r\n\r\nLine one of a poem, running on,\r\nline two comes after it\r\n\r\nline three in a new stanza,\r\nline four ends here", "poem"],
  ];
  for (const [text, want] of cases) assert.equal(X.detectGenre(text), want, JSON.stringify(text.slice(0, 40)));
});

test("what each kind is checked for: quiet, the writer's own account, a DBQ, everything else", () => {
  const shown = (genre, verdict, text = "Over 70% of teens use social media every day.") => X.flagShown({ verdict }, {}, genre, text);
  // A poem, a story, a script, homework: nothing in them is a claim to check or cite.
  for (const g of ["poem", "story", "script", "homework"]) for (const v of ["false", "questionable", "needs_citation"]) assert.equal(shown(g, v), false, `${g} ${v}`);
  // The writer's own account: a wrong public fact still shows; nothing asks for a source.
  for (const g of ["resume", "letter", "email", "coverletter", "personal", "notes", "annotated"]) {
    assert.equal(shown(g, "false"), true, `${g}: a wrong fact shows`);
    assert.equal(shown(g, "needs_citation"), false, `${g}: no source asked for`);
    assert.equal(shown(g, "questionable"), false, `${g}: the writer's life is not "worth checking"`);
  }
  // A DBQ: no source for its outside evidence, but a doubtful claim is still worth checking.
  assert.equal(shown("dbq", "needs_citation"), false);
  assert.equal(shown("dbq", "questionable"), true);
  assert.equal(shown("dbq", "false"), true);
  // An essay, a paper, a speech, a news story: a figure needs its source.
  for (const g of ["prose", "research", "literary", "lab", "speech", "news"]) assert.equal(shown(g, "needs_citation"), true, g);
  // Who keeps a reference list.
  assert.deepEqual(KINDS.filter((g) => X.genreWantsList(g)).sort(), ["lab", "literary", "prose", "research"]);
  assert.deepEqual(KINDS.filter((g) => X.isArgumentGenre(g)).sort(), ["dbq", "lab", "literary", "prose", "research"]);
});

test("the panel says what it is reading, and what that means for the citations", () => {
  assert.equal(X.genreLineHtml("prose"), "", "nothing for a plain essay");
  assert.match(X.genreLineHtml("dbq"), /Reading this as a DBQ — cite the documents by number, like \(Doc 3\); outside evidence needs no source, and a DBQ has no Works Cited/);
  assert.match(X.genreLineHtml("research", "", "apa"), /Reading this as a research paper — every finding needs an in-text citation and an entry in your References/);
  assert.match(X.genreLineHtml("literary", "The speaker of the poem repeats the stanza's last line (Frost, lines 5–8).", "mla"), /quote the poem by its line numbers and list it in your Works Cited/);
  assert.match(X.genreLineHtml("literary", "In the play, Hamlet's soliloquy in Act 3 (Hamlet 3.1.56) turns inward.", "mla"), /quote the play by act, scene and line/);
  assert.match(X.genreLineHtml("poem"), /This reads as a poem — nothing in it needs a source, so Tracely is staying quiet\./);
  assert.match(X.genreLineHtml("email"), /Reading this as an email — no citations needed/);
  assert.match(X.genreLineHtml("speech"), /name each source out loud/);
  assert.match(X.genreLineHtml("homework"), /This looks like homework questions/);
});

test("a DBQ's documents are its citations: no page, no 'names no work', no unnamed-source note", () => {
  const dbq = "Merchants traded silk across Eurasia (Doc 2). \"Paper money was accepted everywhere in the khan's lands\" (Polo). Some historians argue the routes were safe (Weatherford).";
  const kinds = (g) => plain(X.citationTips(dbq, "mla", new Set(), g)).map((t) => t.kind).sort();
  assert.ok(kinds("prose").length >= 2, `an essay gets its notes: ${kinds("prose")}`);
  assert.deepEqual(kinds("dbq"), [], "a DBQ gets none of them");
});

test("a poem is quoted by line, a play by act, scene and line, a novel by page", () => {
  const poem = "The speaker of the poem pauses in the snow. \"Whose woods these are I think I know\" (Frost). The stanza's rhyme slows the reader.";
  const play = "In the play, Hamlet's soliloquy turns inward. \"To be, or not to be, that is the question\" (Shakespeare). The scene ends in silence.";
  const novel = "The narrator returns to the green light in chapter one. \"So we beat on, boats against the current\" (Fitzgerald). The novel closes on it.";
  assert.equal(X.literaryForm(poem), "poem");
  assert.equal(X.literaryForm(play), "play");
  assert.equal(X.literaryForm(novel), "prose");
  const [p] = plain(X.quoteCitationTips(poem, "mla"));
  assert.equal(p.label, "Add the line numbers");
  assert.match(p.message, /A quoted line of a poem needs its line numbers — in MLA, like \(Frost, lines 5–8\)\./);
  const [q] = plain(X.quoteCitationTips(play, "mla"));
  assert.equal(q.label, "Add act, scene and line");
  assert.match(q.message, /\(Shakespeare 3\.1\.56–58\)/);
  const [n] = plain(X.quoteCitationTips(novel, "mla"));
  assert.equal(n.label, undefined);
  assert.match(n.message, /A direct quote needs the page it came from — in MLA, like \(Fitzgerald 23\)/);
});

test("Tracely cites the way the document already does — and MLA when it says nothing", () => {
  assert.equal(X.docCitationStyle("Sleep falls with screen time (Hale & Guan, 2015). Teens need nine hours (Owens, 2014).\nReferences\nHale, L. (2015). Screen time."), "apa");
  assert.equal(X.docCitationStyle("Gatsby reaches for the light (Fitzgerald 21). Nick doubts him (Fitzgerald 98).\nWorks Cited\nFitzgerald, F. Scott. The Great Gatsby. Scribner, 1925."), "mla");
  assert.equal(X.docCitationStyle("Trade grew.¹ Cities followed.²\nBibliography\nAllsen, Thomas. Culture and Conquest. 2001."), "chicago");
  assert.equal(X.docCitationStyle("An essay with no citations at all."), null);
  assert.match(SRC, /settings\.styleChosen = obj\.styleChosen \?\? Boolean\(obj\.citationStyle && obj\.citationStyle !== "mla"\);/, "a style picked before this build still counts as picked");
  assert.equal((SRC.match(/if \(!settings\.styleChosen\) settings\.citationStyle = docCitationStyle\((?:docText|fieldText)\) \?\? "mla";/g) || []).length, 2, "both modes, every read");
  assert.equal((SRC.match(/settings\.citationStyle = (?:k|key); settings\.styleChosen = true;/g) || []).length, 2, "a pick in the card wins from then on");
});

test("no Works Cited: the cited works, the note, and only a record that plainly is the cited work", () => {
  const essay = "Literacy spread (Weatherford, 2004). Paper money moved west (Weatherford 112). Some historians argue the courts kept records (Shiraishi). Trade grew along the routes (\"Silk Roads Today\", 2019).";
  const works = plain(X.citedWorksWithoutList(essay));
  assert.deepEqual(works.map((w) => w.raw), ["(Weatherford, 2004)", "(Shiraishi)", "(\"Silk Roads Today\", 2019)"], "(Weatherford 112) is a page of (Weatherford, 2004), not a second work");
  assert.deepEqual(plain(X.citedWorksWithoutList(essay + "\nWorks Cited\nWeatherford, Jack. Genghis Khan. 2004.")), [], "a list: nothing missing");
  const [tip] = plain(X.noListTip(essay, "prose", "mla"));
  assert.equal(tip.kind, "nolist");
  assert.equal(tip.label, "No Works Cited");
  assert.equal(tip.quote, "", "about the whole document: no underline");
  assert.deepEqual(plain(X.noListTip(essay, "dbq", "mla")), [], "a DBQ has none");
  assert.deepEqual(plain(X.noListTip(essay, "speech", "mla")), [], "nor a speech");
  assert.equal(plain(X.referenceTips(essay, new Set(), "prose", "apa"))[0].label, "No References");
  assert.deepEqual(plain(X.referenceTips(essay, new Set([tip.id]), "prose", "mla")), [], "dismissable");
  // The record that is plainly the cited work, or none.
  const rec = (authors, year, title = "A Book") => ({ title, authors, year, container: "" });
  const w = { author: "Weatherford", year: "2004", title: "" };
  assert.equal(X.citedMatchFor(w, { resolved: true, matches: [rec(["Jack Weatherford"], 2004)] }, {}).year, 2004);
  assert.equal(X.citedMatchFor(w, { resolved: true, matches: [rec(["Jack Weatherford"], 2010)] }, {}), null, "another year: another work");
  assert.equal(X.citedMatchFor(w, { resolved: true, matches: [rec(["Ann Lee"], 2004)] }, {}), null, "another author");
  assert.equal(X.citedMatchFor({ author: "Allsen", year: "2001" }, { resolved: true, byAuthor: { name: "Allsen" }, matches: [rec(["Thomas Allsen"], 2001, "Culture"), rec(["Thomas Allsen"], 2001, "Commodity")] }, { claimTerms: ["routes"] }), null, "two of his works that year, neither about the claim: no guess");
  assert.equal(X.citedMatchFor({ author: "Allsen", year: null }, { resolved: true, byAuthor: { name: "Allsen" }, matches: [rec(["Thomas Allsen"], 2001, "Trade Routes of Asia"), rec(["Thomas Allsen"], 1997, "Commodity")] }, { claimTerms: ["routes"] }).title, "Trade Routes of Asia", "one about the claim");
  assert.equal(X.citedMatchFor({ author: null, year: "2019", title: "Silk Roads Today" }, { resolved: true, matches: [rec(["Ann Lee"], 2019, "Silk Roads Today: A Survey")] }, {}).year, 2019, "a title-cited work, by most of its title's words");
  assert.equal(X.citedMatchFor(w, { resolved: false, matches: [] }, {}), null);
});

test("a speech or a news story names its source in the sentence", () => {
  const src = { title: "Teens and sleep", url: "https://example.org/sleep", publisher: "Pew Research Center", year: 2021 };
  assert.equal(X.attributeAloud("Most teens sleep less than eight hours a night.", src), "According to Pew Research Center in 2021, most teens sleep less than eight hours a night.");
  assert.equal(X.attributeAloud("NASA says the wall cannot be seen.", src), "According to Pew Research Center in 2021, NASA says the wall cannot be seen.", "a name keeps its capital");
  assert.equal(X.attributeAloud("According to the CDC, teens sleep less.", src), null, "already attributed");
  assert.equal(X.attributeAloud("Teens sleep less (Lee, 2021).", src), null, "already cited");
});

test("wired: quiet kinds send nothing; the note's button and its place in Let Tracely fix these", () => {
  assert.match(SRC, /const GENRE_QUIET = new Set\(\["homework", "poem", "story", "script"\]\);/);
  assert.match(SRC, /const GENRE_OWN = new Set\(\["resume", "letter", "email", "coverletter", "personal", "notes", "annotated"\]\);/);
  assert.match(SRC, /listOnly: !same && !genreWantsList\(docGenre\) \}\);/, "Replace citation starts a list where the writing keeps one");
  assert.match(SRC, /const spoken = swapped \|\| named \|\| genreWantsList\(docGenre\) \? null : attributeAloud\(seg\.text, src\);/);
  assert.match(SRC, /for \(const btn of shadow\.querySelectorAll\("\[data-tip-list\]"\)\) btn\.addEventListener\("click", \(\) => docAddWorksCited\(btn\.dataset\.tipList\)\);/);
  assert.match(SRC, /n\.kind === "nolist" \? "list" : null;/);
  assert.match(SRC, /if \(item\.act === "list"\) return docAddWorksCited\(item\.key\);/);
  assert.match(SRC, /if \(!canAppend\) \{\n\s+if \(editGate\.collect\) return false;/, "never copied to the clipboard while fix-all only prepares");
});
