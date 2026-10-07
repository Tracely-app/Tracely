/**
 * What year the writer is in, and what that does to the letter.
 *
 * The rubric measures the same six things at every level — a thesis is a thesis
 * in year 7 and in year 12 — so the /100 does NOT move with this setting. What
 * moves is what the number is worth: the same essay that meets a seventh-grader's
 * expectations is thin for someone about to leave school.
 *
 * That distinction is the whole design. Scaling the score would break the
 * report, whose six components add to the number shown; and a score that
 * changed with a dropdown could not be argued with, which is the property
 * `structure/scoreDraft.ts` exists to protect. So this is a band shift and
 * nothing else, and the report says so beside the letter.
 *
 * A leaf with no imports, so `npm test` can load it.
 */

/**
 * The school years offered in Settings → Preferences.
 *
 * Grade 7 up. They ran from grade 3, and a setting for eight-year-olds is a
 * product inviting users under 13 — which COPPA governs from the first one,
 * while the privacy policy and terms say Tracely is for 13 and over. The
 * lowest grade offered is the age the app tells people it is for.
 */
export const GRADE_LEVELS = [7, 8, 9, 10, 11, 12] as const
export type GradeLevel = (typeof GRADE_LEVELS)[number]
export const MIN_GRADE_LEVEL: GradeLevel = GRADE_LEVELS[0]

/**
 * The level the bands were written against.
 *
 * `GRADE_BANDS` in `components/essayGrade.ts` was tuned so 82 reads "B+" as the
 * Figma frame draws it, and it was tuned against unqualified academic writing —
 * final-year work. So year 12 applies no shift at all, and every level below it
 * is easier by construction rather than by a second table of bands that could
 * disagree with the first.
 */
export const REFERENCE_LEVEL: GradeLevel = 12

/**
 * Points of credit per year below the reference.
 *
 * 4 a year, so year 7 sits 20 points below year 12: an essay that is an A for a
 * seventh-grader lands around a C against final-year expectations (93 vs 73 on
 * these bands). (The owner's original example was year 3, 36 points below — an
 * A+ against a D+ — from when the levels started there.)
 *
 * Deliberately linear. A curve fitted to something would need that something to
 * exist; there is no cohort here to norm against, and inventing a shape would
 * dress a guess up as a measurement.
 */
export const POINTS_PER_LEVEL = 4

export function isGradeLevel(value: unknown): value is GradeLevel {
  return typeof value === 'number' && (GRADE_LEVELS as readonly number[]).includes(value)
}

/**
 * The level a stored or passed-in value means.
 *
 * Grades 3-6 were offered until the floor moved to 7, so a settings row can
 * still hold one. It reads as the lowest level offered, not as the reference:
 * someone who chose grade 5 asked for lenient grading, and jumping them to 12
 * would take 28 points off every grade with nothing on screen saying why.
 * Anything else that is not a level — a hand edit, a future build's value,
 * NaN — reads as the reference, the pre-setting behaviour.
 */
export function storedGradeLevel(value: unknown): GradeLevel {
  if (isGradeLevel(value)) return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 3 && value < MIN_GRADE_LEVEL) {
    return MIN_GRADE_LEVEL
  }
  return REFERENCE_LEVEL
}

/**
 * The score to band, once the writer's year is taken into account.
 *
 * Clamped to 0-100 so a shifted score never leaves the table: the bands' floor
 * is 0 and their top is 97, and a year-7 draft scoring 90 would otherwise be
 * asked for a letter at 110.
 */
export function adjustedScore(score: number, level: number = REFERENCE_LEVEL): number {
  const shift = (REFERENCE_LEVEL - storedGradeLevel(level)) * POINTS_PER_LEVEL
  return Math.max(0, Math.min(100, Math.round(score + shift)))
}

/**
 * The letter bands, worst floor last.
 *
 * These lived in `renderer/src/components/essayGrade.ts`, which cannot be unit
 * tested — it imports through the `@shared` alias and Node's type-stripping
 * runner does not resolve it. They are here because this module already owns
 * the other half of the same question, and because a band table nothing can
 * test is how the top of the scale went missing for as long as it did.
 *
 * Bands are set so 82 reads "B+" exactly as the Figma frame does. The second
 * string fills the frame's "Above average for this assignment type" slot: that
 * line asserts a comparison against other students' work, and there is no
 * cohort and no assignment type here to compare against, so the slot keeps the
 * design's position and says what the band means instead.
 */
export const GRADE_BANDS: Array<[number, string, string]> = [
  // The owner's scale, 2026-08-19: 90-100 an A, 80-89 a B, 70-79 a C, 60-69 a
  // D, below 60 an F — with the thirds inside each decade that give the plus
  // and minus. It replaces a hand-tuned table whose bands were set so 82 read
  // "B+" exactly as the Figma frame draws it; on this scale 82 is a B-, and
  // the frame's own example number is the one thing that had to give. A
  // grading scale is the reader's, not the mockup's.
  [97, 'A+', 'Does everything the rubric asks, and does it well'],
  [93, 'A', 'Built the way the rubric asks for'],
  [90, 'A-', 'Strong throughout, with small gaps'],
  [87, 'B+', 'Well built — a few gaps to close'],
  [83, 'B', 'Solid, with parts left implied'],
  [80, 'B-', 'The shape is there; the support is thin'],
  [77, 'C+', 'Half the argument is doing the work'],
  [73, 'C', 'Key moves are missing or unstated'],
  [70, 'C-', 'More asserted than argued'],
  [67, 'D+', 'Reads as notes rather than an argument'],
  [63, 'D', 'The pieces of an argument are mostly absent'],
  [60, 'D-', 'Barely an argument the rubric can follow'],
  [0, 'F', 'Not yet arguing anything the rubric can find']
]

/**
 * The letter for a score, at a school year.
 *
 * `level` shifts what the number is WORTH, never the number itself. Defaulted,
 * so every caller with no business knowing the setting keeps the pre-setting
 * behaviour: year 12, no shift.
 */
export function gradeFor(score: number, level?: number): { letter: string; line: string } {
  const banded = adjustedScore(score, level)
  const band = GRADE_BANDS.find(([floor]) => banded >= floor) ?? GRADE_BANDS[GRADE_BANDS.length - 1]
  return { letter: band[1], line: band[2] }
}

/**
 * The points a level is credited, before clamping.
 *
 * Separate from `adjustedScore` because the report shows the arithmetic — the
 * six components add to the rubric score, and the reader is owed the step
 * between that and the number in the ring.
 */
export function gradeLevelCredit(level: number = REFERENCE_LEVEL): number {
  return (REFERENCE_LEVEL - storedGradeLevel(level)) * POINTS_PER_LEVEL
}

/** "Grade 12" / "Grade 7" — the label the setting shows. */
export function gradeLevelLabel(level: number): string {
  return `Grade ${storedGradeLevel(level)}`
}
