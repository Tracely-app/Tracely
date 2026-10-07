import { test } from 'node:test'
import { strictEqual, deepStrictEqual } from 'node:assert/strict'
import { citationWorthy, isGeneralStatement } from './citationWorthy.ts'
import { problemKindsFor } from './problemKind.ts'

// Owner, 2026-10-04: "basic abstractions and generalizations followed by a
// piece of evidence do not necessarily need a citation."

test('a number, a quotation or a research finding owes a source of its own', () => {
  for (const s of [
    'Spending on youth facilities fell by 73% between 2010 and 2023.',
    'Nearly half of teenagers report sleeping under seven hours.',
    'Millions of students now own a smartphone.',
    'Malala said "one child, one teacher, one book and one pen can change the world."',
    'A 2019 study found that later start times improved attendance.',
    'Research shows that sleep consolidates memory.',
    'According to the World Bank, remittances exceed aid.'
  ]) strictEqual(citationWorthy(s), true, s)
})

test('a general statement, an abstraction, the writer\'s argument: no citation of its own', () => {
  for (const s of [
    'Smartphones have changed how students learn.',
    'Technology plays an important role in modern education.',
    'Youth leadership is essential to a stable future.',
    'This shows that schools must adapt to new tools.',
    'Social media affects how teenagers communicate with each other.'
  ]) strictEqual(citationWorthy(s), false, s)
})

test('opinions and predictions never; a statistic always', () => {
  strictEqual(citationWorthy('Exactly 40% of voters will regret it.', 'prediction'), false)
  strictEqual(citationWorthy('Jazz is the greatest art form.', 'opinion'), false)
  strictEqual(citationWorthy('Turnout fell sharply.', 'statistic'), true)
})

test('a general statement names nothing specific', () => {
  strictEqual(isGeneralStatement('Smartphones have changed how students learn.'), true)
  strictEqual(isGeneralStatement('Napoleon was a brilliant but reckless leader.'), true, 'the first word may be a name')
  strictEqual(isGeneralStatement('The policy reshaped how Europe was governed.'), false, 'a proper noun is something specific')
  strictEqual(isGeneralStatement('Turnout fell by 9%.'), false)
})

const evidence = { score: 30, count: 3, hasRelevantSource: true }

test('desktop: an uncited generalization gets no weak-evidence or missing-citation finding', () => {
  deepStrictEqual(
    problemKindsFor({ claimType: 'factual', claimText: 'Smartphones have changed how students learn.', hasInlineCitation: false, evidence, critiqueVerdict: null }),
    []
  )
  deepStrictEqual(
    problemKindsFor({ claimType: 'factual', claimText: 'Smartphones have changed how students learn.', hasInlineCitation: false, evidence: { ...evidence, hasRelevantSource: false }, critiqueVerdict: null }),
    [],
    'nor "no sources"'
  )
})

test('desktop: an uncited figure still gets one, and a contradicted fact always does', () => {
  deepStrictEqual(
    problemKindsFor({ claimType: 'factual', claimText: 'Nine in ten students own a smartphone, up 40% since 2015.', hasInlineCitation: false, evidence, critiqueVerdict: null }),
    ['weak-evidence']
  )
  strictEqual(
    problemKindsFor({ claimType: 'factual', claimText: 'Smartphones were invented in 1850.', hasInlineCitation: false, evidence, critiqueVerdict: 'contradicted' })[0],
    'contradicted-claim'
  )
  deepStrictEqual(
    problemKindsFor({ claimType: 'factual', hasInlineCitation: false, evidence, critiqueVerdict: null }),
    ['weak-evidence'],
    'no claim text: the old behaviour'
  )
})
