/**
 * server/shared's ports of desktop logic, run side by side with the desktop
 * originals.
 *
 * narrowing, normalizeCritique, gradedDraft, paragraphSplit, sentenceSplit,
 * worksCited, structureText and rubricText are hand ports of TypeScript under
 * ../../src. Each one exists so the server makes the SAME decision the desktop
 * makes — the same paragraph gets the same number, the same fabrication
 * verdict is withdrawn, the same finding is dropped. A port that drifts does
 * not error; it quietly makes the two surfaces disagree about a student's
 * draft. The ported unit tests only prove the port passes the cases someone
 * thought to write down. This file feeds both copies the same inputs — a
 * fixed corpus of the cases that have bitten before, plus a few hundred
 * seeded random strings built from the characters every splitter here keys
 * on — and requires identical output.
 *
 * The desktop originals are IMPORTED, not re-derived: Node strips their types
 * (22.18+/23.6+), and every one of these files is a leaf whose imports are
 * type-only or relative-with-.ts, which is why they could be ported as leaves
 * in the first place.
 *
 * When ../../src is absent this SKIPS rather than fails. The server also
 * lives in a dev copy with no desktop tree beside it (~/tracely), and a test
 * that failed on every run there would teach everyone to ignore it. In this
 * repo, where src/ is always present, it always runs — including in CI once
 * the server suite runs there.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as narrowing from "../shared/narrowing.js";
import * as normalize from "../shared/normalizeCritique.js";
import * as graded from "../shared/gradedDraft.js";
import * as paragraphs from "../shared/paragraphSplit.js";
import * as sentences from "../shared/sentenceSplit.js";
import * as works from "../shared/worksCited.js";
import * as structure from "../shared/structureText.js";
import * as rubricText from "../shared/rubricText.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "..", "src");
const DESKTOP_FILES = {
  narrowing: "shared/narrowing.ts",
  normalize: "main/services/ai/normalizeCritique.ts",
  graded: "shared/gradedDraft.ts",
  paragraphs: "shared/paragraphSplit.ts",
  sentences: "main/services/ai/sentenceSplit.ts",
  works: "shared/worksCited.ts",
  structure: "shared/structureText.ts",
  rubric: "shared/rubric.ts",
};

let SKIP = false;
if (!existsSync(path.join(SRC, DESKTOP_FILES.graded))) {
  SKIP = `no desktop tree at ${SRC} (expected in a server-only checkout such as ~/tracely)`;
} else if (!process.features?.typescript) {
  SKIP = `this Node (${process.version}) cannot strip TypeScript types, so the desktop's .ts cannot be imported`;
}

const desktop = {};
let loadError = null;
if (!SKIP) {
  try {
    for (const [key, rel] of Object.entries(DESKTOP_FILES)) {
      desktop[key] = await import(pathToFileURL(path.join(SRC, rel)).href);
    }
  } catch (err) {
    loadError = err;
  }
}

/** Both copies, called with the same arguments, must return deep-equal values. */
function same(fnName, port, theirs, cases, prep = (x) => x) {
  let n = 0;
  for (const args of cases) {
    const ours = prep(port[fnName](...args));
    const expected = prep(theirs[fnName](...args));
    assert.deepEqual(ours, expected, `${fnName}(${args.map((a) => JSON.stringify(a)).join(", ")}) differs`);
    n++;
  }
  assert.ok(n > 0, `no cases for ${fnName}`);
}

/* A seeded generator, so a failure names an input that reproduces. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
/* The pieces every splitter and matcher in these files keys on: terminators,
   closers, brackets, initials, abbreviations, footnote marks, every newline
   shape, reference-list headings, and plain words between them. */
const PIECES = [
  "The rate rose", " ", " ", "  ", ".", ". ", "!", "?", "...", "\n", "\n\n", "\r\n", "\r\n\r\n", "\t",
  "(", ")", "[", "]", "\"", "“", "”", "’", "'", "¹", "²", "⁴", "U.S.", "e.g.", "Dr. Smith", "vol. 3",
  "R. Leinbach", "(Smith, 2020)", "Etc.", "in 2021", "70%", "GPT-4", "Works Cited", "References",
  "Bibliography:", "Ionescu, M. (2022). Grid-scale storage.", "and then", "Next one", "a", "B",
];
function randomTexts(seed, count, maxPieces = 18) {
  const rnd = seeded(seed);
  return Array.from({ length: count }, () => {
    let out = "";
    const n = Math.floor(rnd() * maxPieces);
    for (let i = 0; i < n; i++) out += PIECES[Math.floor(rnd() * PIECES.length)];
    return out;
  });
}

/* ── the fixed corpus ─────────────────────────────────────────────────── */

const ESSAY = [
  "More Than a Pretty Face: Audrey Hepburn",
  "Hepburn is remembered as a film star, but her humanitarian work reshaped celebrity advocacy.",
  "She delivered underground newspapers for the resistance (Walker, 2004). That involvement is what makes her later field visits read as continuity.",
  "Taken together, the records describe relief work that was continuous rather than a second act.",
].join("\n");
const REFERENCES = [
  "References",
  "Walker, A. (2004). Hepburn, Audrey. Oxford Dictionary of National Biography. https://doi.org/10.1093/ref:odnb/52107",
  "Paris, B. (1996). Audrey Hepburn. Putnam.",
].join("\n");
const GRADE_DRAFT = [
  "Screen time causes depression in teenagers.",
  "",
  "Studies show that 70% of adolescents who use social media for more than three hours a day report symptoms of anxiety. The effect persisted after controlling for baseline mental health.",
  "",
  "Schools in three districts have already moved to ban phones during instructional hours.",
].join("\n");

const TEXTS = [
  "", " ", "\n", "  \n\n \t \n", "a", "a\nb", "a\n\nb", "a\nb\nc\nd",
  "First paragraph.\nSecond paragraph.", "One.\r\nTwo.\r\n\r\nThree.", "One.\n   \n\t\nTwo.",
  "  Leading space.\n\nMiddle one.\n\n\nTrailing.  ",
  "Southeast Asia prioritizes Hokkien (Thomas R. Leinbach, 2026). Next one.",
  "Governments use that gap (Gregory P. Margarian, 2022: 23). And then this.",
  "Athletes are not tested (J Sports Med., 2024). Another sentence.",
  "88% of students in the U.S. have become less involved. Another.",
  "It was studied by Dr. Smith and confirmed later. Then this.",
  "He said “it works.” Then he left.", "He said \"it works.\" Then he left.",
  "First.\nSecond heading\nThird sentence.",
  "The U.S. rate rose (Smith, 2020). Dr. Chen disagreed (Chen et al., 2021: 14). Etc.\nA heading\nDone.",
  "Print spread fast.¹ Manuscripts did not.", "He was the most published author.⁴ The gap was not close.",
  "Print spread fast².  Manuscripts did not.",
  "An unclosed ( bracket here. And another sentence. And a third one.",
  "A closed [bracket. with a period] inside. Then more.",
  "Wait!! Really?! Yes... fine.",
  ESSAY, `${ESSAY}\n${REFERENCES}`, GRADE_DRAFT,
  "An essay about grids.\n\nIt ends here.", "Prior references disagree about storage.",
  "Body paragraph.\n\nWorks Cited\nIonescu, Maria. “Grid-Scale Storage.” 2022.\nBakker, Lena. “Curtailment.” 2021.",
  "Body.\n\nWorks Cited\nIonescu, M. (2022).\n\n\n", "A bibliography is a list.\n\nWorks Cited\nX. 2020.",
  "Body.\n\nREFERENCES\nA. 2020.", "Body.\n\n  literature cited :  \nA. 2020.", "Body.\n\nReference list\n",
  "Works Cited", "References\nReferences\nA.", "Body.\n\nReference List\nA.", "Body.\n\nLITERATURE CITED:\nA.",
  "Body.\n\nWorks  Cited\nA.", "Body.\n\nWorks Cited and Consulted\nA.", "Body.\n\n  Bibliography  \n\nA.\n\nB.\n",
];

/* ── the tests ────────────────────────────────────────────────────────── */

test("the desktop originals load", { skip: SKIP }, () => {
  assert.equal(loadError, null, `found ${SRC} but could not import a desktop module: ${loadError?.stack}`);
});

// A new desktop export is a decision about whether the server needs it, not
// something to find out later from a route that behaves differently.
test("each port exports exactly what the desktop module does, minus a named list", { skip: SKIP }, () => {
  const exportsOf = (m) => Object.keys(m).sort();
  const notPorted = {
    works: ["planWorksCited"], // writes into the desktop editor; nothing on the server writes a draft
  };
  const ports = { narrowing, normalize, graded, paragraphs, sentences, works, structure };
  for (const [key, port] of Object.entries(ports)) {
    const theirs = exportsOf(desktop[key]).filter((name) => !(notPorted[key] ?? []).includes(name));
    assert.deepEqual(exportsOf(port), theirs, `server/shared port of ${DESKTOP_FILES[key]} exports differ`);
  }
  // rubricText.js is two constants gathered from two desktop files.
  assert.deepEqual(exportsOf(rubricText), ["RUBRIC_SECTIONS", "RUBRIC_TEXT"]);
});

test("RUBRIC_TEXT is byte-equal to src/shared/rubric.ts", { skip: SKIP }, () => {
  assert.equal(rubricText.RUBRIC_TEXT, desktop.rubric.RUBRIC_TEXT);
});

test("RUBRIC_SECTIONS deep-equals src/shared/gradedDraft.ts, and gradedDraft.js re-exports the same list", { skip: SKIP }, () => {
  assert.deepEqual(rubricText.RUBRIC_SECTIONS, desktop.graded.RUBRIC_SECTIONS);
  assert.equal(graded.RUBRIC_SECTIONS, rubricText.RUBRIC_SECTIONS);
});

test("the component maxima and keys match", { skip: SKIP }, () => {
  assert.deepEqual(graded.COMPONENT_MAX, desktop.graded.COMPONENT_MAX);
  assert.deepEqual(graded.COMPONENT_KEYS, desktop.graded.COMPONENT_KEYS);
});

test("UNCHECKABLE_REFERENCE_CRITIQUE is word-for-word the desktop's", { skip: SKIP }, () => {
  assert.equal(normalize.UNCHECKABLE_REFERENCE_CRITIQUE, desktop.normalize.UNCHECKABLE_REFERENCE_CRITIQUE);
});

test("WORKS_CITED_HEADINGS match", { skip: SKIP }, () => {
  assert.deepEqual(works.WORKS_CITED_HEADINGS, desktop.works.WORKS_CITED_HEADINGS);
});

const SENTENCES = [
  "", "   ", "Recent large language models do well.",
  "GPT-5 class models now score above the median human rater on the AP English Language essay rubric, according to the vendor's own published evaluation.",
  "Recent large language models, such as GPT-4, have demonstrated scoring performance comparable to or sometimes exceeding the average human rater on academic English essay rubrics, according to published evaluations.",
  "The policy reduced emissions in all 50 US states.", "The policy reduced emissions in some states.",
  "People are 100% dangerous to the environment.", "People are generally harmful to the environment.",
  "Students always report the effect.", "Many students report the effect.",
  "The COVID–19 wave peaked in 2020 at 3.5 million, or 1,000 per Tokyo-3 district.",
  "In the U.S. the WHO reported 40% in 2021.", "In the US the WHO reported 40 percent.",
  "Hepburn was born in Brussels to an English father.", "She was born in Belgium.",
];

test("namedEntities agrees on every corpus sentence", { skip: SKIP }, () => {
  same("namedEntities", narrowing, desktop.narrowing, [...SENTENCES, ...randomTexts(11, 150)].map((s) => [s]), (set) => [...set].sort());
});

test("isNarrowing agrees on every ordered pair of corpus sentences", { skip: SKIP }, () => {
  const cases = [];
  for (const a of SENTENCES) for (const b of SENTENCES) cases.push([a, b]);
  same("isNarrowing", narrowing, desktop.narrowing, cases);
});

test("normalizeCritique agrees across verdict × revision × citation fix × claim × lookup fact", { skip: SKIP }, () => {
  const claim = "The policy reduced emissions in all 50 US states (Ramirez & Doyle, 2024).";
  const verdicts = ["contradicted", "fabricated", "overstated", "well-supported", "partially-supported", "weak", "unsupported", "not-a-verdict"];
  const revisions = [undefined, null, "", "   ", 42, "The policy reduced emissions in some states.",
    "  The policy reduced emissions in some states.  ", "The EPA says the policy reduced emissions in Texas."];
  const fixes = [undefined, null, "", "  ", "Ramirez, A., & Doyle, B. (2024).", "  Shoup, D. (2005).  "];
  const claims = [undefined, "", claim];
  const facts = [undefined, { referenceLookupRan: false }, { referenceLookupRan: true }];
  const cases = [];
  for (const verdict of verdicts)
    for (const suggestedRevision of revisions)
      for (const citationFix of fixes)
        for (const c of claims)
          for (const f of facts) {
            const raw = { critique: "The model's own paragraph.", verdict };
            if (suggestedRevision !== undefined) raw.suggestedRevision = suggestedRevision;
            if (citationFix !== undefined) raw.citationFix = citationFix;
            cases.push([raw, c, f]);
          }
  same("normalizeCritique", normalize, desktop.normalize, cases);
});

test("splitSentences agrees on the corpus and on seeded random text", { skip: SKIP }, () => {
  same("splitSentences", sentences, desktop.sentences, [...TEXTS, ...randomTexts(1, 400)].map((t) => [t]));
});

// The abbreviation list is private to both files, so it is read out of the
// desktop SOURCE: a word the desktop adds is then exercised here the day it
// lands, rather than the day someone thinks to add it to a corpus. Each word
// is tried outside brackets (inside them the bracket rule decides first, and
// would hide a drifted list), in three casings, and with a letter added.
test("splitSentences agrees on every desktop abbreviation, outside brackets", { skip: SKIP }, () => {
  const source = readFileSync(path.join(SRC, DESKTOP_FILES.sentences), "utf8");
  const list = source.match(/const ABBREVIATIONS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(list, "ABBREVIATIONS not found in the desktop's sentenceSplit.ts — update this test");
  const words = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(words.length >= 10, `only ${words.length} abbreviations parsed`);
  const cases = [];
  for (const word of words) {
    for (const form of [word, word.toUpperCase(), word[0].toUpperCase() + word.slice(1), `${word}x`]) {
      cases.push([`It was seen by ${form}. Then more followed. `], [`Seen ${form}.\nNext line.`]);
    }
  }
  same("splitSentences", sentences, desktop.sentences, cases);
});

test("splitParagraphs agrees on the corpus and on seeded random text", { skip: SKIP }, () => {
  same("splitParagraphs", paragraphs, desktop.paragraphs, [...TEXTS, ...randomTexts(2, 400)].map((t) => [t]));
});

test("paragraphIndexAt agrees at every offset of every corpus text", { skip: SKIP }, () => {
  const cases = [];
  for (const text of [...TEXTS, ...randomTexts(3, 60)]) {
    const spans = desktop.paragraphs.splitParagraphs(text);
    for (let offset = -1; offset <= text.length + 1; offset++) cases.push([spans, offset]);
  }
  same("paragraphIndexAt", paragraphs, desktop.paragraphs, cases);
});

test("bucketClaimsByParagraph agrees, including claims in gaps and past the end", { skip: SKIP }, () => {
  const cases = [];
  for (const text of TEXTS) {
    const spans = desktop.paragraphs.splitParagraphs(text);
    const claims = [];
    for (let offset = -1; offset <= text.length + 2; offset += 3) claims.push({ claimId: `c${offset}`, start: offset });
    cases.push([spans, claims], [spans, []]);
  }
  // A Map is compared as its entries, in insertion order.
  same("bucketClaimsByParagraph", paragraphs, desktop.paragraphs, cases, (map) => [...map.entries()]);
});

test("findWorksCitedSection and withoutWorksCited agree", { skip: SKIP }, () => {
  const cases = [...TEXTS, ...randomTexts(4, 400)].map((t) => [t]);
  same("findWorksCitedSection", works, desktop.works, cases);
  same("withoutWorksCited", works, desktop.works, cases);
});

test("argumentParagraphs agrees", { skip: SKIP }, () => {
  same("argumentParagraphs", structure, desktop.structure, [...TEXTS, ...randomTexts(5, 300)].map((t) => [t]));
});

test("locateQuote agrees on decorated, wrapped, short and absent quotes", { skip: SKIP }, () => {
  const quotes = [
    "", "the", "Studies", "Schools in three districts", "Schools in three districts have already moved",
    "\"Schools in three districts have already moved\"", "“Schools in three districts have already moved”",
    "'Schools in three districts'", "[3] Schools in three districts have already moved",
    "  Schools in three districts have already moved  ", "...Schools in three districts", "…in three districts have",
    "Studies show that 70% of adolescents who use social media",
    "Studies show that 70% of adolescents\nwho use social media", "anxiety. The effect persisted",
    "anxiety.  The   effect persisted", "The author cites Foucault at length here.",
    "teenagers. Studies show", "hours.", "instructional hours.",
  ];
  const cases = [];
  for (const draft of [GRADE_DRAFT, ESSAY, `${ESSAY}\n${REFERENCES}`, "", "   \n  "]) {
    for (const quote of quotes) cases.push([draft, quote]);
  }
  for (const text of randomTexts(6, 120)) cases.push([GRADE_DRAFT, text], [text, text.slice(2, 30)]);
  same("locateQuote", graded, desktop.graded, cases);
});

test("verifyGrade agrees on well-formed, malformed and adversarial responses", { skip: SKIP }, () => {
  const component = (score, quote = "") => ({ score, quote, reason: " because " });
  const finding = (over = {}) => ({
    paragraphIndex: 2,
    rubricSection: "ANALYSIS / REASONING",
    severity: "major",
    label: "Evidence left unexplained",
    quote: "The effect persisted after controlling for baseline mental health.",
    message: "The paragraph reports the finding and never says what it establishes.",
    fix: "Say what the persistence rules out.",
    ...over,
  });
  const good = {
    paragraphs: [
      { index: 1, role: "thesis", statesClaim: false, hasWarrant: false, reasoningFailure: "none" },
      { index: 2, role: "evidence", statesClaim: true, hasWarrant: true, reasoningFailure: "none" },
      { index: 3, role: "claim", statesClaim: true, hasWarrant: false, reasoningFailure: "leap" },
    ],
    components: {
      thesis: component(18, "Screen time causes depression in teenagers."), governingClaims: component(12),
      warrant: component(9.6), counterargument: component(-4), significance: component(99), conclusion: component("7"),
    },
    counterargumentApplicable: true,
    findings: [finding()],
    summary: "  A clear claim with thin warrants.  ",
  };
  const responses = [
    null, undefined, "nope", 42, [], {}, good,
    { ...good, counterargumentApplicable: false }, { ...good, counterargumentApplicable: "no" },
    { ...good, paragraphs: "not an array" }, { ...good, components: null }, { ...good, findings: {} },
    { ...good, paragraphs: [null, 7, { index: 2.4, role: "rebuttal", reasoningFailure: "circular" },
      { index: 2, role: "unknown", reasoningFailure: "circular" }, { index: 0 }, { index: 9 }, { index: "1" }] },
    { ...good, paragraphs: [{ index: 3, role: "unknown", statesClaim: true, hasWarrant: true, reasoningFailure: "leap" }] },
    { ...good, findings: [
      finding(), finding({ label: "Duplicate span" }),
      finding({ rubricSection: "VOICE AND TONE" }), finding({ rubricSection: "GRAMMAR / MECHANICS" }),
      finding({ message: "   " }), finding({ paragraphIndex: 12 }), finding({ paragraphIndex: 0 }),
      finding({ paragraphIndex: 2.6, quote: "Schools in three districts have already moved" }),
      finding({ paragraphIndex: null, quote: "", rubricSection: "COUNTERARGUMENTS / NUANCE", label: "No counterargument" }),
      finding({ paragraphIndex: 1, quote: "" }), finding({ quote: "The paragraph leans heavily on Foucault." }),
      finding({ severity: "nit", quote: "Screen time causes depression" }), finding({ severity: "minor", quote: "[1] Screen time causes" }),
      finding({ label: "", fix: 7, quote: "“report symptoms of anxiety”" }), null, "junk",
    ] },
  ];
  const cases = [];
  for (const raw of responses) for (const count of [0, 1, 2, 3, 4]) cases.push([raw, GRADE_DRAFT, count]);
  same("verifyGrade", graded, desktop.graded, cases);
});

test("scoreFromComponents agrees", { skip: SKIP }, () => {
  const make = (f) => Object.fromEntries(graded.COMPONENT_KEYS.map((k, i) => [k, { score: f(k, i), quote: "", reason: "" }]));
  const sets = [
    make(() => 0), make((k) => graded.COMPONENT_MAX[k]), make(() => 5), make((k, i) => i * 3),
    make((k) => (k === "counterargument" ? 0 : graded.COMPONENT_MAX[k])),
  ];
  const cases = [];
  for (const components of sets) for (const applicable of [true, false]) cases.push([components, applicable]);
  same("scoreFromComponents", graded, desktop.graded, cases);
});

test("buildGradePrompt agrees across paragraph and character limits", { skip: SKIP }, () => {
  const paragraphTexts = [
    desktop.paragraphs.splitParagraphs(GRADE_DRAFT).map((p) => p.text),
    desktop.structure.argumentParagraphs(`${ESSAY}\n${REFERENCES}`).map((p) => p.text),
    ["  padded  ", "", "x".repeat(500), "y".repeat(15990)],
    Array.from({ length: 55 }, (_, i) => `Paragraph ${i + 1} says something.`),
    [],
  ];
  const limits = [
    { maxParagraphs: 40, maxInputChars: 16000 }, { maxParagraphs: 2, maxInputChars: 16000 },
    { maxParagraphs: 40, maxInputChars: 60 }, { maxParagraphs: 40, maxInputChars: 0 },
  ];
  const cases = [];
  for (const texts of paragraphTexts) for (const l of limits) cases.push([texts, l]);
  same("buildGradePrompt", graded, desktop.graded, cases);
});
