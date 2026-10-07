/**
 * The canonical rubric — ONE document, quoted by both the grade report and the
 * flag system. Every problem kind must name the clause it comes from, and the
 * test suite asserts each named clause is a verbatim substring of the rubric
 * text under the section it claims. The compiler cannot tell a real clause
 * from a plausible one; the test can.
 */

export const RUBRIC = {
  thesis: {
    title: "Thesis",
    points: 20,
    text: "The draft states a thesis that claims something contestable. A topic announcement is not a thesis; the reader should be able to disagree with it.",
  },
  governingClaims: {
    title: "Governing claims",
    points: 20,
    text: "Body paragraphs open with or are governed by a claim that advances the thesis. The score follows the fraction of body paragraphs that govern a claim, never the count, so padding lowers it.",
  },
  warrant: {
    title: "Warrant",
    points: 20,
    text: "Evidence is explained rather than dropped. After each piece of evidence the draft says why it supports the claim it serves.",
  },
  counterargument: {
    title: "Counterargument",
    points: 15,
    text: "The draft acknowledges a serious opposing view and answers it. When the draft contains no counterargument this component leaves the denominator entirely rather than scoring zero.",
  },
  significance: {
    title: "Significance",
    points: 15,
    text: "The stakes are stated: the draft says why the argument matters and to whom.",
  },
  conclusion: {
    title: "Conclusion",
    points: 10,
    text: "The conclusion concludes rather than restates: it extends the argument, names a consequence, or answers the significance.",
  },
  credibility: {
    title: "Credibility",
    points: 0,
    text: "Claims of fact are true as far as the check can tell, and each checkable claim is supported: a fact the check believes is wrong must be corrected, a source that appears not to exist must be replaced, a citation that may not support the sentence must be verified against the work it names, an incomplete citation must be completed, a statistic must be verifiable, a claim with no supporting sources needs evidence or attribution, evidence that is weak or only partially supports a sentence should be strengthened or the sentence narrowed, an overstated sentence should be narrowed to what the evidence carries, a claim outside the databases searched needs a hand-checked source, and a checkable sentence with a missing citation needs one. While a claim is still being checked it carries no finding.",
  },
};

/**
 * Total mapping from every flag kind to the rubric clause it comes from.
 * A new flag kind must be added here or tests fail — enforced, not promised.
 */
export const FLAG_CLAUSES = {
  "fabricated-citation":     { section: "credibility", clause: "a source that appears not to exist must be replaced" },
  "citation-defect":         { section: "credibility", clause: "an incomplete citation must be completed" },
  "contradicted-claim":      { section: "credibility", clause: "a fact the check believes is wrong must be corrected" },
  "unsupported-by-evidence": { section: "credibility", clause: "each checkable claim is supported" },
  "overstated-claim":        { section: "credibility", clause: "an overstated sentence should be narrowed to what the evidence carries" },
  "unverified-statistic":    { section: "credibility", clause: "a statistic must be verifiable" },
  "no-sources":              { section: "credibility", clause: "a claim with no supporting sources needs evidence or attribution" },
  "outside-index":           { section: "credibility", clause: "a claim outside the databases searched needs a hand-checked source" },
  "weak-evidence":           { section: "credibility", clause: "evidence that is weak or only partially supports a sentence should be strengthened" },
  "cited-unverified":        { section: "credibility", clause: "a citation that may not support the sentence must be verified against the work it names" },
  "partial-evidence":        { section: "credibility", clause: "evidence that is weak or only partially supports a sentence should be strengthened or the sentence narrowed" },
  "missing-citation":        { section: "credibility", clause: "a checkable sentence with a missing citation needs one" },
  "searching":               { section: "credibility", clause: "While a claim is still being checked it carries no finding" },
};

export const GRADE_COMPONENTS = ["thesis", "governingClaims", "warrant", "counterargument", "significance", "conclusion"];

/**
 * Letter from a 0-100 score — the standard scale: 90-100 A, 80-89 B, 70-79 C,
 * 60-69 D, below 60 F, with thirds inside each decade for plus and minus.
 * A+ exists (>= 97): without it "A" is a ceiling, and a draft that meets every
 * expectation of its level cannot be told it has. (Bands ported from the
 * production app's shared/gradeLevel.ts, which is the shipped behavior.)
 */
export function letterFor(score) {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 67) return "D+";
  if (score >= 63) return "D";
  if (score >= 60) return "D-";
  return "F";
}

/**
 * The grading level (grades 7-12) shifts the SCORE, and the letter follows.
 * Credit: +4 points per grade below 12 (the shipped constant — grade 7 sits 20
 * points below grade 12, so an essay that is an A for a seventh-grader lands
 * around a C against final-year expectations). A level below 7 (offered until
 * 2026-10) is read as 7, as the app's storedGradeLevel does. Clamped to 0-100 so a shifted
 * score never leaves the band table. The report prints the arithmetic as its
 * own row so a student can trace the number.
 */
export const POINTS_PER_LEVEL = 4;

export function applyGradeLevel(rubricScore, level) {
  const lv = Math.min(12, Math.max(7, Number(level) || 12));
  const credit = (12 - lv) * POINTS_PER_LEVEL;
  const total = Math.max(0, Math.min(100, Math.round(rubricScore + credit)));
  return { rubricScore, credit, total, letter: letterFor(total) };
}

/**
 * Sum component sub-scores. Counterargument leaves the denominator entirely
 * when the draft has none (component.absent === true) — that is what stops
 * the score being a length proxy is governingClaims-as-fraction; this is what
 * stops punishing prompts that never asked for a counterargument.
 */
export function sumComponents(components) {
  let earned = 0;
  let possible = 0;
  for (const key of GRADE_COMPONENTS) {
    const c = components[key];
    if (!c) continue;
    if (key === "counterargument" && c.absent) continue;
    earned += Math.max(0, Math.min(RUBRIC[key].points, c.score ?? 0));
    possible += RUBRIC[key].points;
  }
  if (possible === 0) return 0;
  // Integer, matching the shipped scoreFromComponents: the /100 a student
  // reads is a whole number, and every point still traces to a component.
  return Math.round((earned / possible) * 100);
}

/* ── custom (pasted) rubrics ──────────────────────────────────────────────
   A teacher's rubric replaces the built-in components wholesale: the model
   extracts what the rubric scores and how many points each is worth, then
   judges each one. The arithmetic stays here — the model never computes the
   total, same stance as sumComponents. */

export const MAX_CUSTOM_COMPONENTS = 12;

/** Clean the model's extracted components: drop unusable rows, clamp the
    numbers. Pure and shared so the server can normalize and a test can pin
    the clamping without touching the SDK. */
export function normalizeCustomComponents(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const title = String(item?.title ?? "").trim().slice(0, 80);
    const points = Math.round(Number(item?.points));
    if (!title || !Number.isFinite(points) || points <= 0) continue;
    const p = Math.min(100, points);
    out.push({
      title,
      points: p,
      score: Math.max(0, Math.min(p, Math.round(Number(item?.score) || 0))),
      quote: String(item?.quote ?? "").slice(0, 600),
      note: String(item?.note ?? "").slice(0, 300),
    });
    if (out.length >= MAX_CUSTOM_COMPONENTS) break;
  }
  return out;
}

/** earned/possible → /100, integer. 0 when nothing was scorable. */
export function sumCustomComponents(list) {
  let earned = 0;
  let possible = 0;
  for (const c of Array.isArray(list) ? list : []) {
    const points = Number(c?.points) || 0;
    if (points <= 0) continue;
    earned += Math.max(0, Math.min(points, Number(c?.score) || 0));
    possible += points;
  }
  if (possible === 0) return 0;
  return Math.round((earned / possible) * 100);
}
