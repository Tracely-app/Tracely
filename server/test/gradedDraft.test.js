/*
 * Ported from the desktop app's src/shared/gradedDraft.test.ts: the same cases with the same
 * expectations, so the server's copy is held to the behaviour the desktop's
 * is. Only the import lines changed, plus the TypeScript annotations a .js
 * file cannot carry. One server-only block is added at the end, and says why.
 */
import { describe, it } from 'node:test'
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import {
  buildGradePrompt,
  COMPONENT_MAX,
  locateQuote,
  scoreFromComponents,
  verifyGrade
} from '../shared/gradedDraft.js'

const DRAFT = [
  'Screen time causes depression in teenagers.',
  '',
  'Studies show that 70% of adolescents who use social media for more than three hours a day report symptoms of anxiety. The effect persisted after controlling for baseline mental health.',
  '',
  'Schools in three districts have already moved to ban phones during instructional hours.'
].join('\n')

const PARAGRAPHS = 3

function component(score) {
  return { score, quote: '', reason: 'because' }
}

function full(score) {
  return {
    thesis: component(score),
    governingClaims: component(score),
    warrant: component(score),
    counterargument: component(score),
    significance: component(score),
    conclusion: component(score)
  }
}

function grade(overrides = {}) {
  return {
    paragraphs: [
      { index: 1, role: 'thesis', statesClaim: false, hasWarrant: false, reasoningFailure: 'none' },
      { index: 2, role: 'evidence', statesClaim: true, hasWarrant: true, reasoningFailure: 'none' },
      { index: 3, role: 'claim', statesClaim: true, hasWarrant: false, reasoningFailure: 'leap' }
    ],
    components: full(10),
    counterargumentApplicable: true,
    findings: [],
    summary: 'ok',
    ...overrides
  }
}

function finding(overrides = {}) {
  return {
    paragraphIndex: 2,
    rubricSection: 'ANALYSIS / REASONING',
    severity: 'major',
    label: 'Evidence left unexplained',
    quote: 'The effect persisted after controlling for baseline mental health.',
    message: 'The paragraph reports the finding and never says what it establishes.',
    fix: 'Say what the persistence rules out.',
    ...overrides
  }
}

describe('locateQuote', () => {
  it('finds an exact span and reports offsets into the original', () => {
    const span = locateQuote(DRAFT, 'Schools in three districts')
    ok(span)
    strictEqual(DRAFT.slice(span.start, span.end), 'Schools in three districts')
  })

  // The model is sent paragraphs joined with blank lines and re-emits the quote
  // through a JSON encoder. An exact indexOf fails on quotes that are otherwise
  // perfect, and discarding those throws away real findings over whitespace.
  it('matches across a line break and still maps back to the real offsets', () => {
    const wrapped = 'Studies show that 70% of adolescents\nwho use social media'
    const span = locateQuote(DRAFT, 'Studies show that 70% of adolescents who use social media')
    ok(span, 'should match through normalised whitespace')
    strictEqual(DRAFT.slice(span.start, span.end).replace(/\s+/g, ' '), wrapped.replace(/\s+/g, ' '))
  })

  it('tolerates the decorations models add back after being told not to', () => {
    for (const quote of [
      '"Schools in three districts have already moved"',
      '“Schools in three districts have already moved”',
      '[3] Schools in three districts have already moved',
      '  Schools in three districts have already moved  '
    ]) {
      ok(locateQuote(DRAFT, quote), quote)
    }
  })

  it('refuses a quote the draft does not contain', () => {
    strictEqual(locateQuote(DRAFT, 'The author cites Foucault at length here.'), null)
  })

  // A two-word "quote" matches somewhere in every draft, which would make the
  // guard meaningless rather than strict.
  it('refuses a quote too short to be evidence of anything', () => {
    strictEqual(locateQuote(DRAFT, 'the'), null)
    strictEqual(locateQuote(DRAFT, 'Studies'), null)
  })
})

describe('verifyGrade — findings', () => {
  it('keeps a well-formed finding and locates it', () => {
    const out = verifyGrade(grade({ findings: [finding()] }), DRAFT, PARAGRAPHS)
    strictEqual(out.findings.length, 1)
    ok(out.findings[0].span)
    strictEqual(
      DRAFT.slice(out.findings[0].span.start, out.findings[0].span.end),
      'The effect persisted after controlling for baseline mental health.'
    )
  })

  // The guard that replaces "every word comes from a local template". A finding
  // cannot describe a paragraph the student never wrote if it has to quote a
  // sentence they did.
  it('DROPS a finding whose quote is not in the draft', () => {
    const out = verifyGrade(
      grade({ findings: [finding({ quote: 'The paragraph leans heavily on Foucault.' })] }),
      DRAFT,
      PARAGRAPHS
    )
    deepStrictEqual(out.findings, [])
    strictEqual(out.dropped[0].reason, 'quote not found in the draft')
  })

  it('DROPS a finding attributed to a section the rubric does not have', () => {
    const out = verifyGrade(
      grade({ findings: [finding({ rubricSection: 'VOICE AND TONE' })] }),
      DRAFT,
      PARAGRAPHS
    )
    deepStrictEqual(out.findings, [])
    strictEqual(out.dropped[0].reason, 'rubric section not in the rubric')
  })

  it('DROPS a finding on a paragraph that does not exist', () => {
    const out = verifyGrade(
      grade({ findings: [finding({ paragraphIndex: 12 })] }),
      DRAFT,
      PARAGRAPHS
    )
    deepStrictEqual(out.findings, [])
    ok(out.dropped[0].reason.includes('12'))
  })

  // Two findings on one sentence read as two problems — the over-flagging
  // complaint in a different shape.
  it('DROPS a second finding on the same span', () => {
    const out = verifyGrade(
      grade({ findings: [finding(), finding({ label: 'Something else' })] }),
      DRAFT,
      PARAGRAPHS
    )
    strictEqual(out.findings.length, 1)
    strictEqual(out.dropped[0].reason, 'duplicate quote')
  })

  it('keeps a whole-draft absence, which has no words to quote', () => {
    const out = verifyGrade(
      grade({
        findings: [
          finding({
            paragraphIndex: null,
            quote: '',
            rubricSection: 'COUNTERARGUMENTS / NUANCE',
            label: 'No counterargument'
          })
        ]
      }),
      DRAFT,
      PARAGRAPHS
    )
    strictEqual(out.findings.length, 1)
    strictEqual(out.findings[0].span, null)
  })

  it('treats an unrecognised severity as major rather than silently minor', () => {
    const out = verifyGrade(grade({ findings: [finding({ severity: 'nit' })] }), DRAFT, PARAGRAPHS)
    strictEqual(out.findings[0].severity, 'major')
  })
})

describe('verifyGrade — paragraphs', () => {
  it('fills a skipped paragraph with unknown rather than guessing', () => {
    const out = verifyGrade(
      grade({
        paragraphs: [
          { index: 1, role: 'thesis', statesClaim: false, hasWarrant: false, reasoningFailure: 'none' }
        ]
      }),
      DRAFT,
      PARAGRAPHS
    )
    strictEqual(out.paragraphs.length, 3)
    deepStrictEqual(out.paragraphs.map((p) => p.role), ['thesis', 'unknown', 'unknown'])
  })

  it('ignores an index outside the range it was sent', () => {
    const out = verifyGrade(
      grade({
        paragraphs: [
          { index: 9, role: 'thesis', statesClaim: true, hasWarrant: true, reasoningFailure: 'leap' }
        ]
      }),
      DRAFT,
      PARAGRAPHS
    )
    strictEqual(out.paragraphs.every((p) => p.role === 'unknown'), true)
  })

  // A named fault is a judgement about an argument. 'unknown' means the model
  // did not find one to judge, so it cannot also have found it faulty.
  it('will not carry a reasoning fault on a paragraph it could not label', () => {
    const out = verifyGrade(
      grade({
        paragraphs: [
          { index: 1, role: 'unknown', statesClaim: false, hasWarrant: false, reasoningFailure: 'circular' }
        ]
      }),
      DRAFT,
      PARAGRAPHS
    )
    strictEqual(out.paragraphs[0].reasoningFailure, 'none')
  })

  it('coerces an invented role to unknown', () => {
    const out = verifyGrade(
      grade({
        paragraphs: [
          { index: 1, role: 'rebuttal', statesClaim: true, hasWarrant: true, reasoningFailure: 'none' }
        ]
      }),
      DRAFT,
      PARAGRAPHS
    )
    strictEqual(out.paragraphs[0].role, 'unknown')
  })
})

describe('verifyGrade — components', () => {
  it('clamps a score above its maximum', () => {
    const out = verifyGrade(
      grade({ components: { ...full(10), conclusion: component(99) } }),
      DRAFT,
      PARAGRAPHS
    )
    strictEqual(out.components.conclusion.score, COMPONENT_MAX.conclusion)
  })

  it('treats a missing or non-numeric component as zero rather than throwing', () => {
    const out = verifyGrade(grade({ components: {} }), DRAFT, PARAGRAPHS)
    strictEqual(out.components.thesis.score, 0)
  })

  it('returns null for a response that is not an object', () => {
    strictEqual(verifyGrade(null, DRAFT, PARAGRAPHS), null)
    strictEqual(verifyGrade('nope', DRAFT, PARAGRAPHS), null)
  })
})

describe('scoreFromComponents', () => {
  it('sums to 100 when every component is full', () => {
    const components = {}
    for (const [key, max] of Object.entries(COMPONENT_MAX)) {
      components[key] = component(max)
    }
    strictEqual(scoreFromComponents(components, true).score, 100)
  })

  // The rubric: "Do not require counterarguments for every essay". Charging 15
  // points for one the report no longer asks for is the worst of both.
  it('drops counterargument from the DENOMINATOR when the draft attempts none', () => {
    const components = {}
    for (const [key, max] of Object.entries(COMPONENT_MAX)) {
      components[key] = component(key === 'counterargument' ? 0 : max)
    }
    strictEqual(scoreFromComponents(components, false).score, 100)
    strictEqual(scoreFromComponents(components, true).score, 85)
  })

  // Adding a counterargument must never LOWER the score — the monotonicity bug
  // the local scorer shipped once, caught by a test rather than by reading.
  it('never scores a draft lower for having attempted a counterargument', () => {
    const base = {}
    for (const [key, max] of Object.entries(COMPONENT_MAX)) {
      base[key] = component(key === 'counterargument' ? 0 : max)
    }
    const without = scoreFromComponents(base, false).score
    for (let earned = 1; earned <= COMPONENT_MAX.counterargument; earned++) {
      const withOne = scoreFromComponents(
        { ...base, counterargument: component(earned) },
        true
      ).score
      ok(withOne <= without, `earned ${earned}: ${withOne} vs ${without}`)
    }
  })

  it('reports the raw component values alongside the total', () => {
    const out = scoreFromComponents(full(5), true)
    strictEqual(out.components.thesis, 5)
    strictEqual(out.score, Math.round((30 / 100) * 100))
  })
})

/*
 * Server-only. The desktop has no test of its own for buildGradePrompt; the
 * server needs one because it now builds the grade prompt from a raw draft
 * (the web app's path), and verifyGrade's paragraph range is only honest if
 * the count passed to it is the count this actually sent.
 */
describe('buildGradePrompt', () => {
  const LIMITS = { maxParagraphs: 40, maxInputChars: 16000 }

  it('numbers from 1 and separates paragraphs with a blank line', () => {
    strictEqual(buildGradePrompt(['  One.  ', 'Two.'], LIMITS), '[1] One.\n\n[2] Two.')
  })

  it('drops whole paragraphs off the end rather than cutting one short', () => {
    // '[1] ' + 10 chars = 14, +2 for the separator = 16 per paragraph.
    const texts = ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']
    strictEqual(buildGradePrompt(texts, { maxParagraphs: 40, maxInputChars: 32 }), '[1] aaaaaaaaaa\n\n[2] bbbbbbbbbb')
    strictEqual(buildGradePrompt(texts, { maxParagraphs: 40, maxInputChars: 31 }), '[1] aaaaaaaaaa')
  })

  it('stops at maxParagraphs', () => {
    const texts = Array.from({ length: 50 }, (_, i) => `Paragraph ${i + 1}.`)
    const sent = buildGradePrompt(texts, LIMITS).split('\n\n')
    strictEqual(sent.length, 40)
    strictEqual(sent[39], '[40] Paragraph 40.')
  })

  it('sends text a verbatim quote can be found against', () => {
    const paragraphs = DRAFT.split('\n').filter((line) => line.trim())
    const prompt = buildGradePrompt(paragraphs, LIMITS)
    ok(prompt.includes('[2] Studies show that 70%'))
    ok(locateQuote(DRAFT, '[2] The effect persisted after controlling for baseline mental health.'))
  })
})
