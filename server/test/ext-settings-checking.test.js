/* Settings → Checking and Citations, as the widget reads them (content.js
 * "Settings → the widget"; options.js writes chrome.storage "prefs").
 * Owner, 2026-10-16: "yes to all, go ahead with phase 1", on a plan that
 * listed, for Checking: each kind of finding on or off (factual errors
 * always on), "Only clear errors / Balanced / Thorough", "My writing is
 * usually…", the automatic evidence search, Review all typed or at once, a
 * preview before each edit; and for Citations: a default style or "match
 * the document", the list's heading, sources to prefer or avoid, links and
 * access dates. Every default is the widget as it was. */
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const SRC = readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));

function between(from, to) {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a);
  assert.ok(a > 0 && b > a, `content.js: could not find ${from} .. ${to}`);
  return SRC.slice(a, b);
}

// The verdicts (flagShown), the Settings block (prefs), and the shared helpers through the panel's notes.
function load() {
  const log = { sets: [], storageCb: null };
  const ctx = vm.createContext({
    log, URL, Date, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {},
    storageGet: (_d, cb) => { log.storageCb = cb; },
    storageSet: (o) => log.sets.push(plain(o)),
    storageOnChanged() {},
    extCall: () => null,
  });
  return vm.runInContext(`const CHECK_INTERVAL_MS = 10000; const FEATURES = { citeHintsToggle: false, refList: false, essayFeedback: false, quoteTips: true }; function hashText(s) { return String(s); }
    ${between("  const ISSUE_VERDICTS =", "  /* Card titles")}
    ${between("  /* ── Settings → the widget", '  /* ── "Explain in depth" (2.20.0)')}
    ${between("  // Bibliography block", "  function wireChrome(")}
    ({ flagShown, isGeneralStatement, citationWorthy, notePrefs, prefs: () => prefs, setPrefs, adoptStylePick, citeStyleFor, kindWithUsual, refilterSources,
       formatCitation, refHeadingFor, backingSources, sourceAllowed, tipKindShown, tipCat, readKind, log })`, ctx);
}

const GENERAL = "Technology has changed the way people communicate with each other.";
const FIGURE = "In 2019, 64 percent of teenagers in the United States owned a smartphone.";

test("each kind on or off: Needs evidence and the citation findings can go; a factual error never does", () => {
  const X = load();
  X.notePrefs({});
  const shown = (verdict, extra = {}) => X.flagShown({ verdict, confidence: "high", ...extra }, {}, "prose", FIGURE);
  assert.ok(shown("questionable") && shown("needs_citation") && shown("false") && shown("incoherent"), "all on by default");
  X.notePrefs({ showEvidence: false });
  assert.equal(shown("questionable"), false);
  assert.ok(shown("needs_citation") && shown("false"));
  X.notePrefs({ showCitations: false });
  assert.equal(shown("needs_citation"), false);
  assert.equal(shown("wrong_source"), false);
  assert.ok(shown("questionable"));
  X.notePrefs({ showEvidence: false, showCitations: false });
  assert.ok(shown("false") && shown("incoherent"), "nothing turns off a factual error");
  // The notes follow their kind: an unnamed source needs evidence, a missing page is a citation issue.
  assert.equal(X.tipCat({ kind: "vague" }), "check");
  assert.equal(X.tipCat({ kind: "page" }), "cite");
  assert.equal(X.tipKindShown({ kind: "vague" }), false);
  assert.equal(X.tipKindShown({ kind: "page" }), false);
  X.notePrefs({ showCitations: false });
  assert.equal(X.tipKindShown({ kind: "vague" }), true);
  assert.equal(X.tipKindShown({ kind: "uncited" }), false);
});

test("how strict: Only clear errors keeps what the check was sure of; Thorough asks a source for more", () => {
  const X = load();
  X.notePrefs({});
  assert.equal(X.isGeneralStatement(GENERAL), true, "precondition: a general statement");
  assert.equal(X.citationWorthy(FIGURE), true, "precondition: a figure that wants a source");
  const f = (verdict, confidence) => ({ verdict, confidence });
  // Balanced: as before.
  assert.equal(X.flagShown(f("false", "medium"), {}, "prose", FIGURE), true);
  assert.equal(X.flagShown(f("questionable", "high"), {}, "prose", GENERAL), false, "a general statement needs no evidence");
  assert.equal(X.flagShown(f("needs_citation", "high"), {}, "prose", FIGURE, true), false, "a later citation in its paragraph carries it");
  X.notePrefs({ strictness: "clear" });
  assert.equal(X.flagShown(f("false", "high"), {}, "prose", FIGURE), true);
  assert.equal(X.flagShown(f("false", "medium"), {}, "prose", FIGURE), false, "less than sure: hidden, as the setting says");
  assert.equal(X.flagShown(f("questionable", "low"), {}, "prose", FIGURE), false);
  assert.equal(X.flagShown({ verdict: "false" }, {}, "prose", FIGURE), false, "no confidence reads as the server's medium");
  X.notePrefs({ strictness: "thorough" });
  assert.equal(X.flagShown(f("questionable", "high"), {}, "prose", GENERAL), true);
  assert.equal(X.flagShown(f("needs_citation", "high"), {}, "prose", FIGURE, true), true);
  assert.equal(X.flagShown(f("needs_citation", "high"), {}, "resume", FIGURE), false, "the writer's own account still needs no source");
  assert.equal(X.flagShown(f("questionable", "high"), {}, "poem", FIGURE), false, "a quiet kind stays quiet");
});

test("My writing is usually…: read where the rules aren't sure and the site doesn't say — never over a shape Tracely is sure of", () => {
  const X = load();
  X.notePrefs({ usualKind: "research" });
  assert.deepEqual(plain(X.kindWithUsual({ kind: "essay", shown: "" })), { kind: "research", shown: "research" });
  assert.deepEqual(plain(X.kindWithUsual({ kind: "letter", shown: "letter" })), { kind: "letter", shown: "letter" }, "sure: kept");
  assert.deepEqual(plain(X.kindWithUsual({ kind: "email", shown: "" }, "mail.google.com/mail/u/0/")), { kind: "email", shown: "" }, "the site says");
  X.notePrefs({ usualKind: "nonsense" });
  assert.deepEqual(plain(X.kindWithUsual({ kind: "essay", shown: "" })), { kind: "essay", shown: "" });
  X.notePrefs({});
  assert.deepEqual(plain(X.kindWithUsual({ kind: "essay", shown: "" })), { kind: "essay", shown: "" }, "Let Tracely tell");
  // The page's list (options.js KIND_CHOICES, for "usually" and each Doc's own): each a checked kind the widget knows, named as its header names it.
  const OPTIONS_JS = readFileSync(path.join(ROOT, "extension", "options.js"), "utf8");
  const choices = JSON.parse(OPTIONS_JS.match(/const KIND_CHOICES = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]$/, "]"));
  assert.ok(choices.length >= 10);
  assert.match(OPTIONS_JS, /usual\.innerHTML = kindOptionsHtml\("Let Tracely tell"\);/);
  for (const [k, title] of choices) assert.match(SRC, new RegExp(`\\n    ${k}: WK\\("${title}", "(?!homework|poem|story|script)`), `${k}: a checked kind, titled ${title}`);
});

test("the citation style: Settings' everywhere, else the document's own, else MLA; a pick from before moves in once", () => {
  const X = load();
  X.notePrefs({});
  const apaDoc = "Sleep falls with screen time (Hale & Guan, 2015).\nReferences\nHale, L. (2015). Screen time.";
  assert.equal(X.citeStyleFor(apaDoc), "apa", "match each document");
  assert.equal(X.citeStyleFor("No citations here."), "mla");
  X.notePrefs({ citeStyle: "chicago" });
  assert.equal(X.citeStyleFor(apaDoc), "chicago");
  // A style picked in the widget before 2.21.63 lived with the site.
  X.notePrefs({});
  X.adoptStylePick({ citationStyle: "apa", styleChosen: true });
  assert.equal(X.prefs().citeStyle, "apa");
  assert.equal(X.log.sets.at(-1).prefs.citeStyle, "apa", "written where Settings reads it");
  const n = X.log.sets.length;
  X.adoptStylePick({ citationStyle: "chicago", styleChosen: true });
  assert.equal(X.log.sets.length, n, "once: Settings has a style now");
  X.notePrefs({ citeStyle: "match" });
  X.adoptStylePick({ citationStyle: "apa", styleChosen: true });
  assert.equal(X.prefs().citeStyle, "match", "a choice made in Settings is never overwritten");
  // The widget's picker writes Settings' style.
  X.setPrefs({ citeStyle: "mla" });
  assert.equal(X.prefs().citeStyle, "mla");
  assert.equal(X.log.sets.at(-1).prefs.citeStyle, "mla");
  assert.equal((SRC.match(/settings\.citationStyle = (?:k|key); settings\.styleChosen = true; (?:saveSettings\(\)|persistSettings\(settings, SETTINGS_KEY\)); setPrefs\(\{ citeStyle: (?:k|key) \}\);/g) || []).length, 2);
});

test("the list's heading: the one Settings names, else the style's own", () => {
  const X = load();
  X.notePrefs({});
  assert.equal(X.refHeadingFor("mla"), "Works Cited");
  assert.equal(X.refHeadingFor("apa"), "References");
  X.notePrefs({ listHeading: "Bibliography" });
  assert.equal(X.refHeadingFor("mla"), "Bibliography");
  X.notePrefs({ listHeading: "Sources I liked" });
  assert.equal(X.refHeadingFor("mla"), "Works Cited", "only the three headings");
  assert.doesNotMatch(SRC.replace(/const refHeadingFor = [^\n]+/, ""), /REF_HEADINGS\[(?:style|settings\.citationStyle)\]/, "every list Tracely names or adds goes through it");
});

test("links and access dates: off and on in each style's words, a date only on a web page, and by default exactly as before", () => {
  const X = load();
  const web = { title: "Teens and Sleep", url: "https://www.example.org/teens-sleep", publisher: "Sleep Foundation", year: 2023, kind: "web" };
  const journal = { title: "Screen time and sleep", url: "https://example.org/a", doi: "10.1000/xyz", authors: ["Lauren Hale"], year: 2015, kind: "journal", container: "Sleep Medicine", venueType: "journal" };
  X.notePrefs({});
  const before = Object.fromEntries(["mla", "apa", "chicago"].map((s) => [s, plain(X.formatCitation(web, s))]));
  for (const s of ["mla", "apa", "chicago"]) assert.ok(before[s].ref.includes("example.org/teens-sleep"), `${s}: the link by default`);
  X.notePrefs({ citeLinks: false });
  for (const s of ["mla", "apa", "chicago"]) {
    const c = X.formatCitation(web, s);
    assert.equal(c.ref, c.doc, `${s}: no link, the entry without it`);
    assert.equal(c.marker, before[s].marker);
    assert.ok(!X.formatCitation(journal, s).ref.includes("doi.org"), `${s}: no DOI either`);
  }
  X.notePrefs({ citeAccessed: true });
  const d = new Date();
  const mla = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."][d.getMonth()];
  const full = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getMonth()];
  assert.equal(X.formatCitation(web, "mla").ref, `${before.mla.ref} Accessed ${d.getDate()} ${mla} ${d.getFullYear()}.`);
  assert.equal(X.formatCitation(web, "apa").ref, `${before.apa.doc} Retrieved ${full} ${d.getDate()}, ${d.getFullYear()}, from https://www.example.org/teens-sleep`);
  assert.equal(X.formatCitation(web, "chicago").ref, `${before.chicago.doc} Accessed ${full} ${d.getDate()}, ${d.getFullYear()}. https://www.example.org/teens-sleep.`);
  for (const s of ["mla", "apa", "chicago"]) assert.doesNotMatch(X.formatCitation(journal, s).ref, /Accessed|Retrieved/, `${s}: a journal article with a DOI is dated by its own year`);
  X.notePrefs({ citeAccessed: true, citeLinks: false });
  assert.equal(X.formatCitation(web, "apa").ref, before.apa.doc, "APA dates a retrieval only with its address");
  assert.match(X.formatCitation(web, "mla").ref, / Accessed \d+ \S+ \d{4}\.$/);
});

test("sources: a site the writer never wants is left out, every part of it; Only sources teachers accept keeps the citable ones; a pasted link stays", () => {
  const X = load();
  const wiki = { url: "https://en.wikipedia.org/wiki/Sleep", title: "Sleep", stance: "supports" };
  const blog = { url: "https://someblog.example/post", title: "My sleep tips", stance: "supports" };
  const cdc = { url: "https://www.cdc.gov/sleep/data.html", title: "Sleep data", stance: "supports" };
  const pasted = { url: "https://someblog.example/mine", title: "Mine", stance: "manual" };
  X.notePrefs({});
  assert.equal(X.backingSources([wiki, blog, cdc, pasted], "questionable").list.length, 4, "nothing left out by default");
  X.notePrefs({ avoidSites: ["wikipedia.org"] });
  const out = X.backingSources([wiki, blog, cdc], "questionable");
  assert.deepEqual(plain(out.list.map((s) => s.title)), ["Sleep data", "My sleep tips"]);
  assert.equal(out.unbacked, 0, "left out, not counted as found and unbacking");
  X.notePrefs({ citableOnly: true });
  assert.deepEqual(plain(X.backingSources([wiki, blog, cdc, pasted], "questionable").list.map((s) => s.title).sort()), ["Mine", "Sleep data"]);
  // Sources already found lose what Settings now leaves out.
  const map = new Map([["h", { list: [wiki, cdc], unread: [{ ...blog, verified: false }] }]]);
  X.refilterSources(map);
  assert.deepEqual(plain(map.get("h").list.map((s) => s.title)), ["Sleep data"]);
  assert.deepEqual(plain(map.get("h").unread), []);
  assert.equal(X.sourceAllowed(null), true);
});

test("wired: the evidence search, the preview and Review all follow Settings; a change reaches an open page at once", () => {
  assert.equal((SRC.match(/async function autoFindSources\(findings\) \{\n\s+if \(prefs\.autoEvidence === false\) return;/g) || []).length, 2, "both modes");
  assert.match(SRC, /if \(previewDocEdit && prefs\.previewEdits !== false && !job\.previewed && !editGate\.approved\.has\(key\)\) \{/);
  assert.match(SRC, /fixTour = \{ queue: \[\], running: false, instant: prefs\.reviewTyping === false \};/);
  const docs = SRC.slice(SRC.indexOf("  function docsMode()"), SRC.indexOf("  function fieldMode()"));
  const field = SRC.slice(SRC.indexOf("  function fieldMode()"));
  assert.match(docs, /adoptStylePick\(settings\);\n\s+if \(docText\) \{ readDocKind\(\); settings\.citationStyle = citeStyleFor\(docText, own\.style\); \}\n\s+refilterSources\(sourcesMap\);\n\s+render\(\);[^\n]*\n\s+if \(!docQuiet\(\)\) \{ requestDocsMarks\(\); cycle\(\); \}/);
  assert.match(field, /adoptStylePick\(settings\);\n\s+if \(fieldText\) \{ readFieldKind\(\); settings\.citationStyle = citeStyleFor\(fieldText\); \}\n\s+refilterSources\(sourcesMap\);\n\s+render\(\);/);
  // The notes' memo knows the switches and the kind: a change lists the notes again.
  assert.equal((SRC.match(/kinds: JSON\.stringify\(tipKindsOn\(\)\), genre: docGenre \};/g) || []).length, 2);
});
