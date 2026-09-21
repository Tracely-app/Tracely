/*
 * Ported from the desktop app's src/shared/gradedDraft.ts.
 *
 * On the desktop this ran on what the relay sent back. The server now answers
 * /api/grade itself, and applies verifyGrade BEFORE the answer leaves, against
 * the paragraphs it actually sent the model — so the web app gets the guard
 * the desktop always had (a finding about words must quote words that are in
 * the draft), and the desktop's own verifyGrade receives an answer that
 * already passes it. buildGradePrompt is here so a raw draft is numbered and
 * windowed server-side exactly as the desktop does it (40 paragraphs, 16000
 * characters, whole paragraphs only).
 *
 * RUBRIC_SECTIONS is not redefined: it is imported from ./rubricText.js, the
 * server's one copy (the same list the grade schema's enum is built from), and
 * re-exported so this module's surface matches the desktop's. COMPONENT_MAX
 * holds the six component maxima — thesis 20, governingClaims 20, warrant 20,
 * counterargument 15, significance 15, conclusion 10 — which verifyGrade
 * clamps to.
 *
 * test/mirror.test.js runs this copy and the desktop's on a shared corpus
 * whenever the desktop tree is present. The desktop's formatting is kept on
 * purpose, so a diff against the original shows only the TypeScript that had
 * to go; its comments follow unedited.
 */

import { RUBRIC_SECTIONS } from './rubricText.js'

export { RUBRIC_SECTIONS }

/**
 * @typedef {'thesis' | 'claim' | 'evidence' | 'reasoning' | 'significance' | 'counterargument' | 'conclusion' | 'transition' | 'unknown'} ParagraphRole
 * @typedef {{ thesis: number, governingClaims: number, warrant: number, counterargument: number, significance: number, conclusion: number }} StructureComponents
 */

/**
 * What the relay's graded read returns, and what has to be true before any of
 * it reaches a student.
 *
 * The old design's guarantee was that every word a student read came from a
 * local template, so an invented paragraph could not appear in a report that is
 * supposed to be a reading of their draft. Moving the judgement to a model
 * gives that up. This file is what replaces it:
 *
 * **A finding about words must quote those words, and the quote must be in the
 * draft.** Anything else is dropped. A finding cannot describe a paragraph the
 * student never wrote if it has to quote a sentence they did — and the same
 * check is what lets "Show me in the document" scroll to a real offset.
 *
 * Everything here is a pure function of (response, draft). A leaf with a
 * type-only import, so `npm test` can load it.
 */

/**
 * Maxima for the six components. The client owns the arithmetic; see scoreDraft.ts.
 * @type {StructureComponents}
 */
export const COMPONENT_MAX = {
  thesis: 20,
  governingClaims: 20,
  warrant: 20,
  counterargument: 15,
  significance: 15,
  conclusion: 10
}

/** @typedef {keyof StructureComponents} ComponentKey */

/** @type {ComponentKey[]} */
export const COMPONENT_KEYS = [
  'thesis',
  'governingClaims',
  'warrant',
  'counterargument',
  'significance',
  'conclusion'
]

// RUBRIC_SECTIONS is imported from ./rubricText.js above. The desktop's
// comment on why it is checked here as well as constrained by the schema enum
// travelled with it.

/** @typedef {'major' | 'minor'} GradeSeverity */
/** @typedef {'none' | 'circular' | 'sequence-as-cause' | 'single-case' | 'leap'} ReasoningFailure */

/**
 * @typedef {object} GradeParagraph
 * @property {number} index
 * @property {ParagraphRole} role
 * @property {boolean} statesClaim
 * @property {boolean} hasWarrant
 * @property {ReasoningFailure} reasoningFailure
 */

/**
 * @typedef {object} GradeComponent
 * @property {number} score
 * @property {string} quote  The sentence that earned or cost the marks. Empty when the thing is absent.
 * @property {string} reason
 */

/**
 * @typedef {object} GradeFinding
 * @property {number | null} paragraphIndex  1-based, or null for something the draft is missing entirely.
 * @property {string} rubricSection
 * @property {GradeSeverity} severity
 * @property {string} label
 * @property {string} quote
 * @property {string} message
 * @property {string} fix
 */

/**
 * @typedef {object} GradedDraft
 * @property {GradeParagraph[]} paragraphs
 * @property {Record<ComponentKey, GradeComponent>} components
 * @property {boolean} counterargumentApplicable
 * @property {GradeFinding[]} findings
 * @property {string} summary
 */

/**
 * A verified finding, carrying where its quote actually sits in the draft.
 *
 * @typedef {GradeFinding & { span: { start: number, end: number } | null }} LocatedFinding
 *   `span`: character offsets into the ORIGINAL draft, or null for an absence.
 */

/**
 * @typedef {object} VerifiedGrade
 * @property {GradeParagraph[]} paragraphs
 * @property {Record<ComponentKey, GradeComponent>} components
 * @property {boolean} counterargumentApplicable
 * @property {LocatedFinding[]} findings
 * @property {string} summary
 * @property {{ reason: string, label: string }[]} dropped  How many findings were thrown away, and why. Surfaced for diagnosis, never to the student.
 */

/** @type {readonly ParagraphRole[]} */
const ROLES = [
  'thesis',
  'claim',
  'evidence',
  'reasoning',
  'significance',
  'counterargument',
  'conclusion',
  'transition',
  'unknown'
]

/** @type {readonly ReasoningFailure[]} */
const FAILURES = [
  'none',
  'circular',
  'sequence-as-cause',
  'single-case',
  'leap'
]

/**
 * Whitespace-insensitive search that reports the span in the ORIGINAL string.
 *
 * The model is sent paragraphs joined with blank lines and prefixed with "[3] ",
 * and it re-emits a quote by copying — through a JSON encoder, from text whose
 * line breaks it never saw as line breaks. So an exact `indexOf` fails on
 * quotes that are otherwise perfect, and dropping those would throw away real
 * findings for a whitespace difference.
 *
 * Normalising both sides and keeping an index map is what lets the finding
 * survive AND still point at a real offset, which is what the underline needs.
 *
 * @param {string} draft
 * @param {string} quote
 * @returns {{ start: number, end: number } | null}
 */
export function locateQuote(draft, quote) {
  const cleaned = quote
    // Models add these back despite being told not to. Cheaper to tolerate than
    // to discard a correct finding over a decoration.
    .replace(/^\s*["'“”‘’]+/, '')
    .replace(/["'“”‘’]+\s*$/, '')
    .replace(/^\.{3}|…/, '')
    .replace(/^\s*\[\d+\]\s*/, '')
    .trim()
  if (cleaned.length < 8) return null

  const map = []
  let normalized = ''
  let pendingSpace = false
  for (let i = 0; i < draft.length; i++) {
    if (/\s/.test(draft[i])) {
      pendingSpace = normalized.length > 0
      continue
    }
    if (pendingSpace) {
      map.push(i)
      normalized += ' '
      pendingSpace = false
    }
    map.push(i)
    normalized += draft[i]
  }

  const needle = cleaned.replace(/\s+/g, ' ')
  const at = normalized.indexOf(needle)
  if (at === -1) return null

  const start = map[at]
  // `map` holds the original index of each normalized character, so the end is
  // one past the original index of the last one — not start + needle.length,
  // which would be wrong wherever the original had a newline or a double space.
  const end = map[at + needle.length - 1] + 1
  return { start, end }
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {number}
 */
function clampScore(value, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0
  return Math.max(0, Math.min(max, n))
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Everything the client is willing to believe from one graded read.
 *
 * `paragraphCount` is how many paragraphs were actually SENT. The model is told
 * to use those numbers and generally does, but an index outside the range would
 * put a finding on a paragraph that does not exist — the exact failure the
 * report has already shipped once, from a different cause.
 *
 * @param {unknown} raw
 * @param {string} draft
 * @param {number} paragraphCount
 * @returns {VerifiedGrade | null}
 */
export function verifyGrade(raw, draft, paragraphCount) {
  if (!raw || typeof raw !== 'object') return null
  const body = raw

  const paragraphs = []
  const seen = new Set()
  for (const entry of Array.isArray(body.paragraphs) ? body.paragraphs : []) {
    if (!entry || typeof entry !== 'object') continue
    const p = entry
    const index = typeof p.index === 'number' ? Math.round(p.index) : -1
    if (index < 1 || index > paragraphCount || seen.has(index)) continue
    seen.add(index)
    const role = ROLES.includes(p.role) ? p.role : 'unknown'
    const failure = FAILURES.includes(p.reasoningFailure)
      ? p.reasoningFailure
      : 'none'
    paragraphs.push({
      index,
      role,
      statesClaim: p.statesClaim === true,
      hasWarrant: p.hasWarrant === true,
      // A role the model could not place cannot carry a named reasoning fault:
      // the fault is a judgement about an argument, and 'unknown' means it did
      // not find one to judge.
      reasoningFailure: role === 'unknown' ? 'none' : failure
    })
  }
  // A gap means the model skipped a paragraph. 'unknown' is the honest label
  // and the one the score treats as unread — never a guess to fill the vector.
  for (let i = 1; i <= paragraphCount; i++) {
    if (!seen.has(i)) {
      paragraphs.push({
        index: i,
        role: 'unknown',
        statesClaim: false,
        hasWarrant: false,
        reasoningFailure: 'none'
      })
    }
  }
  paragraphs.sort((a, b) => a.index - b.index)

  const rawComponents = body.components ?? {}
  const components = {}
  for (const key of COMPONENT_KEYS) {
    const c = rawComponents[key] ?? {}
    components[key] = {
      score: clampScore(c.score, COMPONENT_MAX[key]),
      quote: asString(c.quote),
      reason: asString(c.reason)
    }
  }

  const dropped = []
  const findings = []
  const seenQuotes = new Set()

  for (const entry of Array.isArray(body.findings) ? body.findings : []) {
    if (!entry || typeof entry !== 'object') continue
    const f = entry
    const label = asString(f.label) || 'Finding'

    if (!RUBRIC_SECTIONS.includes(asString(f.rubricSection))) {
      dropped.push({ reason: 'rubric section not in the rubric', label })
      continue
    }

    const message = asString(f.message)
    if (!message) {
      dropped.push({ reason: 'no message', label })
      continue
    }

    const index =
      typeof f.paragraphIndex === 'number' ? Math.round(f.paragraphIndex) : null
    if (index !== null && (index < 1 || index > paragraphCount)) {
      dropped.push({ reason: `paragraph ${index} does not exist`, label })
      continue
    }

    const quote = asString(f.quote)
    let span = null
    if (quote) {
      span = locateQuote(draft, quote)
      if (!span) {
        // The load-bearing one. A quote the draft does not contain means the
        // model is describing something the student did not write.
        dropped.push({ reason: 'quote not found in the draft', label })
        continue
      }
      // One finding per span. Two findings on one sentence read as two
      // problems, which is the over-flagging complaint in a different shape.
      const key = `${span.start}:${span.end}`
      if (seenQuotes.has(key)) {
        dropped.push({ reason: 'duplicate quote', label })
        continue
      }
      seenQuotes.add(key)
    } else if (index !== null) {
      // No quote but a paragraph number: the model is asserting an absence
      // inside one paragraph, which it was told to report as a whole-draft
      // finding. Keep it, but as what it is.
      span = null
    }

    findings.push({
      paragraphIndex: index,
      rubricSection: asString(f.rubricSection),
      severity: f.severity === 'minor' ? 'minor' : 'major',
      label,
      quote,
      message,
      fix: asString(f.fix),
      span
    })
  }

  return {
    paragraphs,
    components,
    counterargumentApplicable: body.counterargumentApplicable !== false,
    findings,
    summary: asString(body.summary),
    dropped
  }
}

/**
 * The /100, summed from the model's component scores.
 *
 * The model judges and this adds up, so the same draft scores the same number
 * and every point traces to a quoted sentence. Counterargument leaves the
 * DENOMINATOR when the draft does not attempt one — the rubric says not to
 * require one of every essay, and Tracely is never shown the assignment.
 *
 * @param {Record<ComponentKey, GradeComponent>} components
 * @param {boolean} counterargumentApplicable
 * @returns {{ score: number, components: StructureComponents }}
 */
export function scoreFromComponents(components, counterargumentApplicable) {
  const values = {}
  let earned = 0
  let applicable = 0
  for (const key of COMPONENT_KEYS) {
    const score = components[key].score
    values[key] = score
    if (key === 'counterargument' && !counterargumentApplicable) continue
    earned += score
    applicable += COMPONENT_MAX[key]
  }
  return {
    score: applicable === 0 ? 0 : Math.round((earned / applicable) * 100),
    components: values
  }
}

/**
 * The numbered paragraphs the grader is sent.
 *
 * Deliberately NOT `buildStructurePrompt`, which windows each paragraph to its
 * opening and closing moves. That is right for labelling — a paragraph's ROLE
 * lives at its edges — and wrong here. This call judges whether the evidence
 * supports the claim and quotes the sentence it is talking about, both of which
 * live in the middle it would have elided. A finding quoting text that was
 * never sent cannot be located, and would be dropped by `verifyGrade`.
 *
 * So paragraphs go whole, and the budget is spent by dropping WHOLE paragraphs
 * off the end rather than the middle of every one. Paragraphs that do not fit
 * are never labelled, and `verifyGrade` fills them with 'unknown' — the honest
 * label for "not read".
 *
 * @param {string[]} paragraphTexts
 * @param {{ maxParagraphs: number, maxInputChars: number }} limits
 * @returns {string}
 */
export function buildGradePrompt(paragraphTexts, limits) {
  const lines = []
  let used = 0

  for (const [i, text] of paragraphTexts.slice(0, limits.maxParagraphs).entries()) {
    const line = `[${i + 1}] ${text.trim()}`
    // Stop at a whole paragraph. A partial entry would invite a quote from a
    // sentence the model only saw half of.
    if (used + line.length + 2 > limits.maxInputChars) break
    lines.push(line)
    used += line.length + 2
  }

  return lines.join('\n\n')
}
