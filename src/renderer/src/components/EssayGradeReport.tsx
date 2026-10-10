import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { ParagraphRole, StructureComponents, StructureWeaknessKind } from '@shared/types'
import { needsWork } from '@shared/weaknessSeverity'
import type { ScreenWatchProblemKind } from '@shared/ipc-contract'
import { PROBLEM_LABEL } from './problemCopy'
import { POINTS_PER_LEVEL, REFERENCE_LEVEL, adjustedScore, gradeFor, gradeLevelCredit } from '@shared/gradeLevel'
import { paragraphNames } from './paragraphNames'
import { ArrowRightIcon, ChevronRightIcon, CloseIcon } from './icons'

/**
 * The Essay Grade report, drawn once and rendered on both surfaces.
 *
 * This was Screen Watch's alone — built verbatim from Figma "Essay Grade Widget
 * (Full Report)" (404:185) inside OverlayApp.tsx — while Tracely's own
 * documents had a second report of their own in `ArgumentScoreModal`, built
 * from class names in index.css. Two readings of one rubric, drifting apart at
 * the pace of whichever was edited last.
 *
 * Owner's call: the widget's breakdown is the one to keep. So it moved here and
 * both surfaces render it.
 *
 * **Inline styles, deliberately.** The overlay window loads no stylesheet
 * (see OverlayApp.tsx), so this cannot be class-based; inline styles are the
 * one form that works in both windows. That is the opposite of the usual rule
 * in this codebase — `problemCopy.ts` shares the wording and lets each surface
 * own its markup — and the reason for the exception is that here the MARKUP is
 * what was asked for, not the vocabulary.
 *
 * What it takes is deliberately narrower than `ScreenWatchStructure`: the
 * fields below are the ones the panel reads, and a `DocumentOutline` from the
 * editor can be adapted to them (see `AnalyzeView`'s `gradeInput`) without
 * pretending to be a Screen Watch payload.
 */

/** The paragraph outline shape the report reads. */
export interface GradeParagraph {
  index: number
  role: ParagraphRole
  claimIds: string[]
}

/** A whole-draft or per-paragraph finding. `paragraphIndex` null means draft. */
export interface GradeWeakness {
  kind: string
  message: string
  paragraphIndex: number | null
  claimId: string | null
}

/**
 * What the report needs to know about a claim: whether the writer cited it, how
 * confident detection was, and what is wrong with it. Both
 * `ScreenWatchClaimSummary` and an adapted editor `Claim` satisfy this.
 */
export interface GradeClaim {
  id: string
  confidence: number
  hasInlineCitation: boolean
  problemKinds: ScreenWatchProblemKind[]
}

/** Reading figures for the stats row. */
export interface GradeStats {
  words: number
  sentences: number
  uniqueWords: number
}

export interface GradeInput {
  score: number
  /** False when any paragraph is `unknown` — the score is then provisional. */
  complete: boolean
  components: StructureComponents
  weaknesses: GradeWeakness[]
  paragraphs: GradeParagraph[]
  /** Whether `paragraphs[0]` is the document's title rather than an argument. */
  titleParagraph?: boolean
  /** First line of each paragraph, index-aligned: `previews[p.index - 1]`. */
  previews: string[]
  stats: GradeStats
}

/* The overlay's two text greys, which are the frame's. Exported because
   OverlayApp draws the rest of its cards in them and one definition is what
   keeps the shared report and the panels around it the same colour. */
export const DIM = '#9a9ba1'
export const W_BODY = '#55565c'

export const ROLE_LABEL: Record<ParagraphRole, string> = {
  thesis: 'Thesis',
  claim: 'Claim',
  evidence: 'Evidence',
  reasoning: 'Reasoning',
  significance: 'Significance',
  counterargument: 'Counterargument',
  conclusion: 'Conclusion',
  transition: 'Transition',
  unknown: 'Unlabelled'
}

// Ordered as the rubric reads, not by weight — a writer looks for "do I have a
// thesis" before "how are my warrants doing". Maxima match COMPONENT_MAX in
// services/structure/scoreDraft.ts.
export const COMPONENT_ROWS: Array<[keyof StructureComponents, string, number]> = [
  ['thesis', 'Thesis', 20],
  ['governingClaims', 'Governing claims', 20],
  ['warrant', 'Reasoning markers', 20],
  ['counterargument', 'Counterargument', 15],
  ['significance', 'Significance', 15],
  ['conclusion', 'Conclusion', 10]
]

/**
 * The Screen Watch panel in 'grade' mode — Figma "Essay Grade Widget" (370:191).
 *
 * Every number below is the frame's own, read with get_design_context rather
 * than eyeballed off a screenshot: 560x321 at 28px radius, 24/22 padding, 22px
 * between blocks, a 116px ring, and two 251px pills with a 10px gutter. This
 * card draws its OWN chrome and header, so unlike 'single'/'all'/'structure' it
 * replaces the shared panel box rather than filling it — the design gives it a
 * close button and no drag title, and it is centred rather than cornered.
 *
 * The ring is drawn as an SVG arc, not the frame's two exported ring images.
 * Those images encode 82/100 specifically; a score of 41 rendered with them
 * would show an 82% arc. The geometry (116px box, 10px stroke) is the frame's.
 */
export const GRADE_RING_TRACK = '#e7ebe8'
/** The frame's green, which is not the app's #16a34a — same family, 4pt darker. */
export const GRADE_GREEN = '#168449'
export const GRADE_PILL_BG = '#ddf2e0'

/**
 * Every colour this report paints, under a semantic name.
 *
 * The report renders in two windows with two different obligations. The
 * overlay window draws over OTHER applications and was built verbatim from
 * Figma — it must keep exactly the frame's colours, always. The main window's
 * report modal follows the app theme, so in dark mode the same markup needs a
 * second set of inks. One palette type, two constant instances, and a context
 * that defaults to the light one — so a surface that mounts no provider (the
 * overlay) is byte-identical to what it drew before this type existed.
 *
 * The three mark colours (#d93636 / #ffb800 / #ff5900) are NOT here: they are
 * the 3-colour underline system and deliberately theme-invariant.
 */
export interface GradePalette {
  /** Primary ink — titles, figures, bold spans. */
  text: string
  /** The frame's caption grey (DIM). */
  dim: string
  /** The frame's body grey (W_BODY). */
  body: string
  /** Hairline between header / footer and the body. */
  divider: string
  /** The card/button surface — the frame's white. */
  surface: string
  /** The tinted panel behind the rubric bars, paragraph cards and score row. */
  panelBg: string
  /** The empty part of a MiniBar meter. */
  trackBg: string
  /** The unfilled part of the score ring. */
  ringTrack: string
  /** The role chip behind "Thesis" / "Evidence" etc. */
  chipBg: string
  /** The `›` affordance on a paragraph card. */
  chevron: string
  /** Score green — ring, bars, "Strong". */
  green: string
  /** The letter pill's green wash. */
  greenWash: string
  /** The "Strong" badge wash (a different light green than the pill's). */
  strongWash: string
  /** Ring colour for a mid score. */
  ringMid: string
  /** Ring colour for a low score. */
  ringLow: string
  /** MiniBar colour for a mid band. */
  barMid: string
  /** MiniBar colour for a low band. */
  barLow: string
  /** "Needs Work" text. */
  warnText: string
  /** "Needs Work" wash. */
  warnWash: string
  /** Link blue — "Open Argument Check →", "Find →", the Summary dot. */
  blue: string
  /** The round close button's wash. */
  closeBg: string
  /** The round close button's glyph. */
  closeText: string
  /** The secondary button's outline. */
  btnBorder: string
  /** The secondary button's label. */
  btnText: string
  /** Text on the filled primary button (and on the `!` badge). */
  onPrimary: string
  /** The primary button's solid accent fill (the app's --accent). */
  primary: string
  /** A claim issue card's wash. */
  issueBg: string
  /** The `!` badge's fill. */
  issueBadge: string
  /** An issue card's headline. */
  issueTitle: string
  /** An issue card's body text. */
  issueBody: string
}

/** The frame's own colours — exactly what both surfaces drew before theming. */
export const GRADE_LIGHT: GradePalette = {
  text: '#1a1a1f',
  dim: DIM,
  body: W_BODY,
  divider: '#e7e7e7',
  surface: '#fff',
  panelBg: '#f8f9f8',
  trackBg: '#eaeaea',
  ringTrack: GRADE_RING_TRACK,
  chipBg: '#e8e9ec',
  chevron: '#999a9e',
  green: GRADE_GREEN,
  greenWash: GRADE_PILL_BG,
  strongWash: '#e0f2e5',
  ringMid: '#b3690a',
  ringLow: '#d6301a',
  barMid: '#c79216',
  barLow: '#d3514b',
  warnText: '#cb5c19',
  warnWash: '#fff1e5',
  blue: '#2563eb',
  closeBg: '#eaf2ec',
  closeText: '#376049',
  btnBorder: '#d3d8d4',
  btnText: '#2d362f',
  onPrimary: '#fff',
  primary: '#f97316',
  issueBg: '#fff7f0',
  issueBadge: '#d95319',
  issueTitle: '#b35116',
  issueBody: '#5a3e1b'
}

/**
 * The same report on the app's dark tokens (styles/index.css,
 * `:root[data-theme='dark']`): surface #17171b, text #f6f6f8, borders as white
 * washes, and the score colours moved to their dark-token equivalents
 * (--score-good #34d399, --score-mid #ffab3d, --score-low #ff5a36). Light-grey
 * panels become translucent light-on-dark washes so they read as the same
 * grouping without glowing.
 */
export const GRADE_DARK: GradePalette = {
  text: '#f6f6f8',
  dim: 'rgba(246, 246, 248, 0.62)',
  body: 'rgba(246, 246, 248, 0.78)',
  divider: 'rgba(255, 255, 255, 0.18)',
  surface: '#17171b',
  panelBg: 'rgba(255, 255, 255, 0.04)',
  trackBg: 'rgba(255, 255, 255, 0.14)',
  ringTrack: 'rgba(255, 255, 255, 0.12)',
  chipBg: 'rgba(255, 255, 255, 0.08)',
  chevron: 'rgba(246, 246, 248, 0.45)',
  green: '#34d399',
  greenWash: 'rgba(52, 211, 153, 0.16)',
  strongWash: 'rgba(52, 211, 153, 0.16)',
  ringMid: '#ffab3d',
  ringLow: '#ff5a36',
  barMid: '#ffab3d',
  barLow: '#ff5a36',
  warnText: '#ffab3d',
  warnWash: 'rgba(255, 171, 61, 0.18)',
  blue: '#60a5fa',
  closeBg: 'rgba(52, 211, 153, 0.16)',
  closeText: '#34d399',
  btnBorder: 'rgba(255, 255, 255, 0.28)',
  btnText: '#f6f6f8',
  onPrimary: '#fff',
  primary: '#f97316',
  issueBg: 'rgba(255, 171, 61, 0.1)',
  issueBadge: '#d95319',
  issueTitle: '#ffab3d',
  issueBody: 'rgba(246, 246, 248, 0.75)'
}

/**
 * Defaults to LIGHT, which is what keeps the overlay untouched: that window
 * mounts no provider, so every component below reads the frame's own values.
 * The main window's modal wraps the report in a provider when dark is active.
 */
const GradePaletteContext = createContext<GradePalette>(GRADE_LIGHT)

export function GradePaletteProvider({
  palette,
  children
}: {
  palette: GradePalette
  children: ReactNode
}): JSX.Element {
  return <GradePaletteContext.Provider value={palette}>{children}</GradePaletteContext.Provider>
}

export function gradeRingColor(score: number, palette: GradePalette = GRADE_LIGHT): string {
  if (score >= 70) return palette.green
  if (score >= 40) return palette.ringMid
  return palette.ringLow
}

/** The header both frames draw: an 18/600 title left (the modal's title size),
 *  a 28px icon close right. */
export function GradeHeader({ title, onClose }: { title: string; onClose: () => void }): JSX.Element {
  const P = useContext(GradePaletteContext)
  return (
    <div
      style={{
        height: 28,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexShrink: 0,
        width: '100%'
      }}
    >
      <div style={{ minWidth: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.3, color: P.text }}>{title}</div>
      <button
        className="tracely-btn-text"
        onClick={onClose}
        title="Close"
        aria-label="Close"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: 8,
          border: 'none',
          background: P.closeBg,
          color: P.closeText,
          cursor: 'pointer',
          padding: 0
        }}
      >
        <CloseIcon size={16} />
      </button>
    </div>
  )
}

export function GradeDivider(): JSX.Element {
  const P = useContext(GradePaletteContext)
  return <div style={{ height: 1, background: P.divider, flexShrink: 0, width: '100%' }} />
}

/** The ring + band block, byte-identical between 370:191 and 404:185. */
export function GradeScoreSection({
  structure,
  gradingLevel
}: {
  structure: GradeInput | null
  /** The school year the letter is banded against — see shared/gradeLevel.ts. */
  gradingLevel?: number
}): JSX.Element {
  // THE score, which is the rubric's number moved to the writer's year — not
  // the raw one with a different letter beside it. The two used to disagree on
  // screen: a 78 with an "A+" under it is a card arguing with itself.
  //
  // The rubric's own measurement is not lost; the report prints it, and the
  // adjustment, as their own line under the breakdown.
  const P = useContext(GradePaletteContext)
  const raw = structure?.score ?? 0
  const score = adjustedScore(raw, gradingLevel)
  const { letter, line } = gradeFor(raw, gradingLevel)
  // 116px box, 10px stroke => r 53. The arc starts at 12 o'clock (the rotation
  // below) and runs clockwise, as the frame's does.
  const R = 53
  const CIRC = 2 * Math.PI * R

  return (
    <div style={{ height: 116, position: 'relative', flexShrink: 0, width: '100%' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 116, height: 116 }}>
        <svg width={116} height={116} viewBox="0 0 116 116" aria-hidden="true">
          <circle cx={58} cy={58} r={R} fill="none" stroke={P.ringTrack} strokeWidth={10} />
          <circle
            cx={58}
            cy={58}
            r={R}
            fill="none"
            stroke={gradeRingColor(score, P)}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={`${(CIRC * Math.max(0, Math.min(100, score))) / 100} ${CIRC}`}
            transform="rotate(-90 58 58)"
          />
        </svg>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 38,
            textAlign: 'center',
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            fontVariantNumeric: 'tabular-nums',
            color: P.text,
            lineHeight: 1
          }}
        >
          {structure ? score : '—'}
        </div>
        <div
          style={{ position: 'absolute', left: 0, right: 0, top: 74, textAlign: 'center', fontSize: 12, color: P.dim, fontVariantNumeric: 'tabular-nums' }}
        >
          / 100
        </div>
      </div>

      <div style={{ position: 'absolute', left: 144, top: 22, right: 0, minWidth: 0, height: 72 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: P.dim, letterSpacing: '0.04em', lineHeight: '16px' }}>OVERALL SCORE</div>
        <div
          style={{
            position: 'absolute',
            top: 24,
            left: 0,
            height: 20,
            borderRadius: 999,
            background: P.greenWash,
            color: P.green,
            fontSize: 11,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            display: 'inline-flex',
            alignItems: 'center',
            padding: '0 8px'
          }}
        >
          {structure ? letter : '—'}
        </div>
        {/* The frame says "Above average for this assignment type" here. There
            is no cohort and no assignment type, so the slot keeps its place
            and says what the band means — see essayGrade.ts. */}
        <div style={{ position: 'absolute', top: 52, left: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.5, color: P.body }}>
          {structure ? line : 'No reading of this draft yet'}
        </div>
      </div>
    </div>
  )
}

/**
 * The two-button row at the foot of both frames. Only the primary label differs.
 *
 * "Re-grade Writing" is drawn as the frame draws it and disabled: the structural
 * read is recomputed on every poll (see refreshWatchOutline), so the number
 * above is already live and a re-grade would do nothing but redraw it.
 */
export function GradeButtonRow({ primaryLabel, onPrimary }: { primaryLabel: string; onPrimary: () => void }): JSX.Element {
  const P = useContext(GradePaletteContext)
  // One button recipe with the app chrome: 36px, radius 8, a solid accent
  // primary beside a 1px outlined secondary, splitting the row evenly.
  const base = {
    flex: 1,
    minWidth: 0,
    height: 36,
    padding: '0 18px',
    borderRadius: 8,
    fontFamily: 'inherit',
    fontSize: 14,
    lineHeight: 1,
    whiteSpace: 'nowrap'
  } as const
  return (
    <div style={{ height: 36, display: 'flex', gap: 12, flexShrink: 0, width: '100%' }}>
      <button
        className="tracely-btn-primary"
        onClick={onPrimary}
        style={{
          ...base,
          border: 'none',
          background: P.primary,
          color: P.onPrimary,
          fontWeight: 600,
          cursor: 'pointer'
        }}
      >
        {primaryLabel}
      </button>
      <button
        className="tracely-btn-secondary"
        disabled
        title="The score updates on its own as you write"
        style={{
          ...base,
          border: `1px solid ${P.btnBorder}`,
          background: P.surface,
          color: P.btnText,
          fontWeight: 500,
          cursor: 'not-allowed',
          opacity: 0.5
        }}
      >
        Re-grade Writing
      </button>
    </div>
  )
}

/** 238 wpm — Brysbaert 2019, silent reading of English prose. Same figure the
 *  in-app report uses, so the two cannot disagree about a draft's read time. */
export const OVERLAY_READING_WPM = 238

/** One stat chip from 404:203 — 18px figure over an 11px tracked caption. */
export function StatChip({ value, label }: { value: string; label: string }): JSX.Element {
  const P = useContext(GradePaletteContext)
  return (
    // Flow, not an absolutely-positioned caption. The chip used to take its
    // width from the VALUE alone with the label floating out of the box, which
    // is invisible at the frame's own spacing and clipped "VOCAB DIVERSITY" off
    // the right edge the moment the row was laid out anywhere else. Measuring
    // the wider of the two is what lets the row space itself.
    <div style={{ height: 40, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          lineHeight: '22px',
          fontVariantNumeric: 'tabular-nums',
          color: P.text,
          whiteSpace: 'nowrap'
        }}
      >
        {value}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 11,
          fontWeight: 600,
          lineHeight: '14px',
          color: P.dim,
          letterSpacing: '0.04em',
          whiteSpace: 'nowrap'
        }}
      >
        {label}
      </div>
    </div>
  )
}

/** The 4px rounded meter the frame draws under every metric label. */
export function MiniBar({ label, percent, color }: { label: string; percent: number; color: string }): JSX.Element {
  const P = useContext(GradePaletteContext)
  const pct = Math.max(0, Math.min(100, percent))
  return (
    <div style={{ position: 'relative', height: 22, flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap' }}>
        <span style={{ fontWeight: 500, color: P.body }}>{label}</span>
        <span style={{ fontWeight: 600, color: P.text, fontVariantNumeric: 'tabular-nums' }}>{Math.round(pct)}%</span>
      </div>
      <div
        style={{ position: 'absolute', top: 18, left: 0, right: 0, height: 4, borderRadius: 999, background: P.trackBg }}
      >
        <div style={{ width: `${pct}%`, height: 4, borderRadius: 999, background: color }} />
      </div>
    </div>
  )
}

/** The frame's three meter colours, by band. */
export function miniBarColor(percent: number, palette: GradePalette = GRADE_LIGHT): string {
  if (percent >= 85) return palette.green
  if (percent >= 70) return palette.barMid
  return palette.barLow
}

/**
 * The Screen Watch panel in 'report' mode — Figma "Essay Grade Widget (Full
 * Report)" (404:185).
 *
 * The frame's structure verbatim: header, score section, a four-chip stats row,
 * a paragraph card per paragraph, a Summary block, then the two pills. Where it
 * differs from the frame it is because the frame's content is not something
 * Tracely measures, and every one of those is called out below rather than
 * filled with a plausible number.
 *
 * The largest of them: the frame gives EVERY paragraph card its own metric bars
 * (Thesis Clarity, Evidence & Support, Grammar & Mechanics, Vocabulary & Word
 * Choice). Tracely scores the draft on a six-part rubric and does not score
 * paragraphs individually, so per-paragraph bars would be a draft-level number
 * printed four times under four labels that never produced it. The bars are
 * drawn once instead, in the design's own style, over the rubric they actually
 * come from.
 */
export function EssayGradeReportPanel({
  structure,
  claims,
  gradingLevel,
  onClose,
  onBackToSummary,
  onArgumentCheck,
  onOpenParagraph,
  onFindForClaim
}: {
  structure: GradeInput | null
  claims: GradeClaim[]
  /**
   * The school year the LETTER is banded against, not the score.
   *
   * A prop rather than context because this renders in the overlay window too,
   * which mounts no provider — it reads the setting from its own bridge and
   * passes it in. Undefined bands at the reference level, which is what the app
   * did before the setting existed.
   */
  gradingLevel?: number
  onClose: () => void
  onBackToSummary: () => void
  onArgumentCheck: () => void
  onOpenParagraph: (index: number) => void
  onFindForClaim: (claimId: string) => void
}): JSX.Element {
  const P = useContext(GradePaletteContext)
  const stats = structure?.stats ?? null
  const readMinutes = stats ? Math.max(1, Math.round(stats.words / OVERLAY_READING_WPM)) : 0
  const perSentence = stats ? (stats.words / Math.max(1, stats.sentences)).toFixed(1) : '—'
  const vocab = stats && stats.words > 0 ? Math.round((stats.uniqueWords / stats.words) * 100) : 0

  const claimById = new Map(claims.map((c) => [c.id, c] as const))
  // Whole-draft weaknesses have no paragraph, and they are what the frame's
  // "Summary" block is: the things to say about the essay rather than about one
  // of its paragraphs.
  const draftWeaknesses = (structure?.weaknesses ?? []).filter((w) => w.paragraphIndex === null)

  return (
    <>
      <GradeHeader title="Writing Grade — Full Report" onClose={onClose} />
      <GradeDivider />
      <GradeScoreSection structure={structure} gradingLevel={gradingLevel} />

      {/*
        The frame spaces these four by their own x positions (404:203), which a
        fixed 66px gap reproduces at exactly the frame's numbers and nowhere
        else: the widest caption, "WORDS / SENTENCE", ran into "VOCAB
        DIVERSITY" the moment the row was rendered in the editor's window,
        where the font metrics are not the overlay's. Spread instead, with a
        minimum gutter — the frame's spacing at the frame's width, and legible
        at any other.
      */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16,
          flexShrink: 0,
          width: '100%'
        }}
      >
        <StatChip value={stats ? stats.words.toLocaleString() : '—'} label="WORDS" />
        <StatChip value={stats ? `~${readMinutes} min` : '—'} label="READ TIME" />
        <StatChip value={perSentence} label="WORDS / SENTENCE" />
        <StatChip value={stats ? `${vocab}%` : '—'} label="VOCAB DIVERSITY" />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: P.dim, letterSpacing: '0.04em' }}>BREAKDOWN BY PARAGRAPH</div>
          {/* The frame's link. There is no separate Argument Check panel in the
              overlay, and the claim list IS where a claim is checked one at a
              time, so it goes there rather than nowhere. */}
          <button
            className="tracely-btn-text"
            onClick={onArgumentCheck}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              border: 'none',
              background: 'none',
              padding: 0,
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 600,
              color: P.blue,
              cursor: 'pointer'
            }}
          >
            Open Argument Check <ArrowRightIcon size={12} />
          </button>
        </div>

        {/* The rubric, once. See the note on this component for why these bars
            are not repeated inside every paragraph card as the frame draws. */}
        <div
          style={{
            background: P.panelBg,
            borderRadius: 12,
            padding: 14,
            display: 'flex',
            flexWrap: 'wrap',
            gap: '12px 24px',
            width: '100%',
            boxSizing: 'border-box'
          }}
        >
          {COMPONENT_ROWS.map(([key, label, max]) => {
            const pct = structure ? ((structure.components[key] ?? 0) / max) * 100 : 0
            return (
              <div key={key} style={{ flex: '1 1 232px', minWidth: 0, display: 'flex' }}>
                <MiniBar label={label} percent={pct} color={miniBarColor(pct, P)} />
              </div>
            )
          })}
        </div>

        {/* Named by position, and the title dropped — the same rule and the same
            function as the in-app report, so the two surfaces cannot describe
            one draft differently. See components/paragraphNames.ts. */}
        {(structure?.paragraphs ?? []).map((paragraph, i) => {
          const name = paragraphNames(structure?.paragraphs ?? [], structure?.titleParagraph)[i]
          // null is the title: not part of the argument, and listing it as a
          // paragraph of one is what produced a row reading "P1 · Unlabelled".
          if (name === null) return null
          const issues = (structure?.weaknesses ?? []).filter((w) => w.paragraphIndex === paragraph.index)
          // NOT `issues.length === 0`. Every finding used to flip this badge, so
          // one "obviously" printed the same NEEDS WORK as a circular argument and a
          // well-written draft could not keep a single Strong. See
          // shared/weaknessSeverity.ts — the notes still render underneath.
          const strong = !needsWork(issues.map((w) => w.kind as StructureWeaknessKind))
          const preview = structure?.previews[paragraph.index - 1] ?? ''
          const cited = paragraph.claimIds.filter((id) => claimById.get(id)?.hasInlineCitation).length

          return (
            // A button, not a div: the frame puts a `›` on every card, and a
            // chevron that is not a control is a promise the panel does not
            // keep. The whole card is the target, as the chevron implies.
            <button
              key={paragraph.index}
              className="tracely-list-row"
              onClick={() => onOpenParagraph(paragraph.index)}
              title={`Open ${name}`}
              style={{
                background: P.panelBg,
                border: 'none',
                font: 'inherit',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                borderRadius: 12,
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                width: '100%',
                boxSizing: 'border-box'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <span
                  style={{
                    background: P.chipBg,
                    borderRadius: 999,
                    height: 20,
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '0 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    color: P.body,
                    flexShrink: 0
                  }}
                >
                  {ROLE_LABEL[paragraph.role]}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: P.text, fontVariantNumeric: 'tabular-nums' }}>{name}</span>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    background: strong ? P.strongWash : P.warnWash,
                    color: strong ? P.green : P.warnText,
                    borderRadius: 999,
                    height: 20,
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '0 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    flexShrink: 0
                  }}
                >
                  {strong ? 'Strong' : 'Needs Work'}
                </span>
                <span style={{ display: 'inline-flex', color: P.chevron, flexShrink: 0 }} aria-hidden="true">
                  <ChevronRightIcon size={12} />
                </span>
              </div>

              {/* The frame's line here is an assessment of the paragraph. Where
                  there is a weakness that IS the assessment; otherwise the
                  paragraph's own opening line says which paragraph this is,
                  which a role label alone does not. */}
              <div style={{ fontSize: 13, color: P.body, lineHeight: 1.5 }}>
                {issues[0]?.message ?? preview}
              </div>

              {paragraph.claimIds.length > 0 ? (
                <div style={{ fontSize: 12, fontWeight: 500, color: P.body, fontVariantNumeric: 'tabular-nums' }}>
                  {cited} of {paragraph.claimIds.length} claim{paragraph.claimIds.length === 1 ? '' : 's'} cited in this
                  paragraph
                </div>
              ) : null}

              {issues
                .filter((issue) => issue.claimId !== null)
                .map((issue, i) => {
                  const claim = issue.claimId ? claimById.get(issue.claimId) : null
                  return (
                    <div
                      key={`${issue.kind}-${i}`}
                      style={{
                        background: P.issueBg,
                        borderRadius: 8,
                        padding: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        width: '100%',
                        boxSizing: 'border-box'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span
                            style={{
                              background: P.issueBadge,
                              color: P.onPrimary,
                              borderRadius: 999,
                              width: 18,
                              height: 18,
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: 11,
                              fontWeight: 600,
                              flexShrink: 0
                            }}
                          >
                            !
                          </span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: P.issueTitle, fontVariantNumeric: 'tabular-nums' }}>
                            {/* `problemKinds` can be EMPTY on a claim a
                                weakness points at — the finding came off the
                                prose or the role vector, not off the claim —
                                and indexing [0] then rendered the literal
                                string "undefined · 88% confidence". Seen in
                                the harness on the fixture report. */}
                            {claim && claim.problemKinds.length > 0
                              ? `${PROBLEM_LABEL[claim.problemKinds[0]]} · ${Math.round(claim.confidence * 100)}% confidence`
                              : 'Needs attention'}
                          </span>
                        </div>
                        {issue.claimId ? (
                          <button
                            className="tracely-btn-text"
                            // The paragraph card is itself a button, so without
                            // this the click reaches it too and "Find" opens the
                            // paragraph detail as well as the source finder —
                            // which throws the reader out of the report they
                            // asked from, the exact thing openGradeSourceFinder
                            // exists to stop. Harmless while both paths ended in
                            // the same panel; not any more.
                            onClick={(e) => {
                              e.stopPropagation()
                              onFindForClaim(issue.claimId as string)
                            }}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              border: 'none',
                              background: 'none',
                              padding: 0,
                              fontFamily: 'inherit',
                              fontSize: 12,
                              fontWeight: 600,
                              color: P.blue,
                              cursor: 'pointer',
                              flexShrink: 0
                            }}
                          >
                            Find <ArrowRightIcon size={12} />
                          </button>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 12, color: P.issueBody, lineHeight: 1.5 }}>{issue.message}</div>
                    </div>
                  )
                })}
            </button>
          )
        })}
      </div>

      {/*
        Where the number came from, whenever it is not the rubric's own.
        Shown as arithmetic rather than as a badge: the six components above
        add to the rubric score, and without this line they would not add to
        the number in the ring — which is exactly the objection that keeps the
        score arguable in the first place.
      */}
      {structure && gradeLevelCredit(gradingLevel) > 0 ? (
        <div
          style={{
            width: '100%',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderRadius: 8,
            background: P.panelBg,
            fontSize: 13,
            lineHeight: 1.5,
            fontVariantNumeric: 'tabular-nums',
            color: P.body,
            boxSizing: 'border-box'
          }}
        >
          <span>
            Rubric score <b style={{ color: P.text }}>{structure.score}</b> · grade{' '}
            {REFERENCE_LEVEL - gradeLevelCredit(gradingLevel) / POINTS_PER_LEVEL} credit{' '}
            <b style={{ color: P.text }}>+{gradeLevelCredit(gradingLevel)}</b>
          </span>
          <span>
            <b style={{ color: P.text }}>{adjustedScore(structure.score, gradingLevel)}</b> / 100
          </span>
        </div>
      ) : null}

      <div style={{ width: '100%', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 20 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: P.blue, flexShrink: 0 }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: P.text }}>Summary</span>
        </div>
        {/* The frame's summary is written prose ("You're in great shape!").
            Nothing here writes prose about a draft — weaknesses come from local
            templates, never a model (see structure/weaknesses.ts) — so the block
            carries the whole-draft findings, which is what it would be
            summarising, and the band line when there are none. */}
        <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: P.body }}>
          {draftWeaknesses.length > 0
            ? draftWeaknesses.map((w) => w.message).join(' ')
            : structure
              ? `${gradeFor(structure.score, gradingLevel).line}. Nothing outstanding across the draft as a whole.`
              : 'No reading of this draft yet.'}
        </div>
      </div>

      <GradeDivider />
      <GradeButtonRow primaryLabel="Back to Summary" onPrimary={onBackToSummary} />
    </>
  )
}
