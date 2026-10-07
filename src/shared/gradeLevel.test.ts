import { strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GRADE_LEVELS,
  MIN_GRADE_LEVEL,
  REFERENCE_LEVEL,
  adjustedScore,
  gradeFor,
  gradeLevelCredit,
  gradeLevelLabel,
  isGradeLevel,
  storedGradeLevel
} from './gradeLevel.ts'

describe('adjustedScore', () => {
  it('leaves the reference level untouched', () => {
    strictEqual(adjustedScore(82, 12), 82)
    strictEqual(REFERENCE_LEVEL, 12)
  })

  it('credits four points per year below the reference', () => {
    strictEqual(adjustedScore(50, 11), 54)
    strictEqual(adjustedScore(50, 8), 66)
    strictEqual(adjustedScore(50, 7), 70)
  })

  it('makes an A for a seventh-grader a C for a senior', () => {
    // 73 bands as C against final-year expectations and as A (93) at grade 7.
    strictEqual(adjustedScore(73, 7), 93)
    strictEqual(gradeFor(73, 7).letter, 'A')
    strictEqual(gradeFor(73, 12).letter, 'C')
  })

  it('clamps rather than leaving the band table', () => {
    strictEqual(adjustedScore(90, 7), 100)
    strictEqual(adjustedScore(0, 12), 0)
  })

  it('falls back to the reference level for a junk setting', () => {
    // A stored value from a future build, or a hand-edited settings row.
    strictEqual(adjustedScore(70, 99), 70)
    strictEqual(adjustedScore(70, Number.NaN), 70)
  })

  it('offers grades 7 to 12, nothing an under-13 is in', () => {
    // The privacy policy and terms say 13 and over; grade 3 was a setting for
    // eight-year-olds.
    strictEqual(GRADE_LEVELS.length, 6)
    strictEqual(GRADE_LEVELS[0], 7)
    strictEqual(MIN_GRADE_LEVEL, 7)
    strictEqual(GRADE_LEVELS[GRADE_LEVELS.length - 1], 12)
    strictEqual(isGradeLevel(7), true)
    strictEqual(isGradeLevel(6), false)
    strictEqual(isGradeLevel(3), false)
    strictEqual(isGradeLevel('7'), false)
  })
})

describe('storedGradeLevel', () => {
  it('reads a grade 3-6 row from before the floor moved as grade 7, not 12', () => {
    // Someone who chose grade 5 asked for lenient grading; reading the row as
    // the reference would take 28 points off every grade without a word.
    for (const old of [3, 4, 5, 6]) {
      strictEqual(storedGradeLevel(old), 7)
      strictEqual(gradeLevelCredit(old), 20)
      strictEqual(gradeLevelLabel(old), 'Grade 7')
    }
    strictEqual(adjustedScore(50, 3), 70)
  })

  it('keeps an offered level and reads anything else as the reference', () => {
    strictEqual(storedGradeLevel(9), 9)
    strictEqual(storedGradeLevel(2), 12)
    strictEqual(storedGradeLevel(13), 12)
    strictEqual(storedGradeLevel(5.5), 12)
    strictEqual(storedGradeLevel(Number.NaN), 12)
    strictEqual(storedGradeLevel('5'), 12)
    strictEqual(storedGradeLevel(undefined), 12)
  })
})

describe('gradeFor', () => {
  it('bands on the standard scale: 90 A, 80 B, 70 C, 60 D', () => {
    strictEqual(gradeFor(90).letter, 'A-')
    strictEqual(gradeFor(89).letter, 'B+')
    strictEqual(gradeFor(80).letter, 'B-')
    strictEqual(gradeFor(79).letter, 'C+')
    strictEqual(gradeFor(70).letter, 'C-')
    strictEqual(gradeFor(69).letter, 'D+')
    strictEqual(gradeFor(60).letter, 'D-')
    strictEqual(gradeFor(59).letter, 'F')
    strictEqual(gradeFor(48).letter, 'F')
  })

  it('every decade is one letter', () => {
    for (const [from, letter] of [[90, 'A'], [80, 'B'], [70, 'C'], [60, 'D']] as const) {
      for (let score = from; score < from + 10; score++) {
        strictEqual(gradeFor(score).letter[0], letter, `${score} should be a ${letter}`)
      }
    }
  })

  it('has a top of the scale', () => {
    // A+ did not exist, so "A" was a ceiling: a draft that met every
    // expectation of its level could not be told it had.
    strictEqual(gradeFor(97).letter, 'A+')
    strictEqual(gradeFor(100).letter, 'A+')
    strictEqual(gradeFor(96).letter, 'A')
    strictEqual(gradeFor(93).letter, 'A')
  })

  it('is the Hepburn essay: A+ for a seventh-grader, C+ for a senior', () => {
    // 78 is what the rubric scores that draft (see scoreDraft.test.ts). At
    // grade 7 the shift takes it to 98, the top of the scale; at 12 it does
    // not move at all.
    strictEqual(gradeFor(78, 7).letter, 'A+')
    strictEqual(gradeFor(78, 12).letter, 'C+')
  })

  it('still has somewhere to fall at a low level', () => {
    // The shift is credit, not a floor: a draft with nothing the rubric can
    // find is still failing it, in year 7 as in year 12.
    strictEqual(gradeFor(0, 7).letter, 'F')
    strictEqual(gradeFor(30, 7).letter, 'F')
  })
})
