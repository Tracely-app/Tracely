import { test } from "node:test";
import assert from "node:assert/strict";
import { RUBRIC, FLAG_CLAUSES, GRADE_COMPONENTS, sumComponents, applyGradeLevel, letterFor } from "../shared/rubric.js";
import { PROBLEM_KINDS } from "../shared/marks.js";

test("every flag kind names a rubric clause (total mapping — a new kind fails here until someone names its clause)", () => {
  for (const { kind } of PROBLEM_KINDS) {
    assert.ok(FLAG_CLAUSES[kind], `flag kind "${kind}" has no rubric clause`);
  }
});

test("every named clause is a verbatim substring of the rubric text under the section it claims", () => {
  for (const [kind, { section, clause }] of Object.entries(FLAG_CLAUSES)) {
    const sec = RUBRIC[section];
    assert.ok(sec, `flag "${kind}" names unknown rubric section "${section}"`);
    assert.ok(
      sec.text.includes(clause),
      `flag "${kind}": clause is not verbatim in RUBRIC.${section}.text:\n  "${clause}"`
    );
  }
});

test("component points sum to 100", () => {
  const total = GRADE_COMPONENTS.reduce((n, k) => n + RUBRIC[k].points, 0);
  assert.equal(total, 100);
});

test("sumComponents: full marks → 100", () => {
  const components = Object.fromEntries(GRADE_COMPONENTS.map((k) => [k, { score: RUBRIC[k].points }]));
  assert.equal(sumComponents(components), 100);
});

test("counterargument leaves the denominator entirely when absent", () => {
  const full = Object.fromEntries(GRADE_COMPONENTS.map((k) => [k, { score: RUBRIC[k].points }]));
  full.counterargument = { absent: true, score: 0 };
  assert.equal(sumComponents(full), 100); // not 85/100
});

test("scores are clamped to component points", () => {
  const components = Object.fromEntries(GRADE_COMPONENTS.map((k) => [k, { score: 999 }]));
  assert.equal(sumComponents(components), 100);
});

test("grade level shifts the score and the letter follows; arithmetic is traceable", () => {
  const g12 = applyGradeLevel(80, 12);
  assert.equal(g12.credit, 0);
  assert.equal(g12.total, 80);
  // Shipped arithmetic: 4 points of credit per grade below 12.
  const g8 = applyGradeLevel(80, 8);
  assert.equal(g8.credit, 16);
  assert.equal(g8.total, 96);
  assert.equal(g8.letter, letterFor(96));
  // An A for a seventh-grader is a C for a senior.
  assert.equal(applyGradeLevel(73, 7).total, 93);
  assert.equal(letterFor(applyGradeLevel(73, 7).total), "A");
  assert.equal(letterFor(73), "C");
  assert.equal(applyGradeLevel(99, 7).total, 100); // capped
  // Grades 3-6 are no longer offered (13+ minimum age); a stored one reads as 7.
  assert.equal(applyGradeLevel(50, 3).credit, 20);
  assert.equal(applyGradeLevel(50, 6).total, 70);
});

test("letter bands are the standard scale with thirds — A+ exists, D has thirds", () => {
  assert.equal(letterFor(100), "A+");
  assert.equal(letterFor(97), "A+");
  assert.equal(letterFor(96), "A");
  assert.equal(letterFor(93), "A");
  assert.equal(letterFor(90), "A-");
  assert.equal(letterFor(89), "B+");
  assert.equal(letterFor(80), "B-");
  assert.equal(letterFor(79), "C+");
  assert.equal(letterFor(70), "C-");
  assert.equal(letterFor(69), "D+");
  assert.equal(letterFor(63), "D");
  assert.equal(letterFor(60), "D-");
  assert.equal(letterFor(59), "F");
});

test("sumComponents rounds to an integer, like the shipped scoreFromComponents", () => {
  // thesis 13/20 with only thesis+conclusion present → 13+10 of 30 = 76.666…
  const partial = { thesis: { score: 13 }, conclusion: { score: 10 } };
  assert.equal(sumComponents(partial), 77);
  assert.ok(Number.isInteger(sumComponents(partial)));
});

/* ── custom (pasted) rubrics ─────────────────────────────────────────── */
import { MAX_CUSTOM_COMPONENTS, normalizeCustomComponents, sumCustomComponents } from "../shared/rubric.js";

test("normalizeCustomComponents drops unusable rows and clamps the numbers", () => {
  const out = normalizeCustomComponents([
    { title: "Thesis", points: 20, score: 25, quote: "q", note: "n" },   // score clamped to points
    { title: "", points: 10, score: 5 },                                  // no title → dropped
    { title: "Void", points: 0, score: 0 },                               // zero points → dropped
    { title: "Neg", points: -5, score: 3 },                               // negative → dropped
    { title: "Huge", points: 500, score: 400 },                           // points clamped to 100
    { title: "Frac", points: 9.6, score: -2 },                            // rounded; score floored at 0
  ]);
  assert.deepEqual(out.map((c) => [c.title, c.points, c.score]), [
    ["Thesis", 20, 20],
    ["Huge", 100, 100],
    ["Frac", 10, 0],
  ]);
});

test("normalizeCustomComponents caps the list and rejects non-arrays", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ title: `C${i}`, points: 5, score: 3 }));
  assert.equal(normalizeCustomComponents(many).length, MAX_CUSTOM_COMPONENTS);
  assert.deepEqual(normalizeCustomComponents(null), []);
  assert.deepEqual(normalizeCustomComponents({ title: "obj" }), []);
});

test("sumCustomComponents is earned over possible, integer, and 0 when nothing was scorable", () => {
  assert.equal(sumCustomComponents([
    { title: "A", points: 20, score: 15 },
    { title: "B", points: 30, score: 30 },
  ]), 90);
  // 13 of 30 → 43.33 → 43; the /100 a student reads is a whole number
  assert.equal(sumCustomComponents([{ title: "A", points: 30, score: 13 }]), 43);
  assert.equal(sumCustomComponents([]), 0);
  assert.equal(sumCustomComponents(null), 0);
  // over-scored rows cannot push past 100
  assert.equal(sumCustomComponents([{ title: "A", points: 10, score: 99 }]), 100);
});
