/**
 * Widget panel geometry.
 *
 * Sizing lives in main rather than the renderer because hoverTracking.ts's
 * click-through hit-test region is derived from the same rect the panel is
 * drawn at — if the two disagreed, the panel would be visible in one place and
 * clickable in another. The renderer mirrors the GRID_* constants (see
 * OverlayApp.tsx) to lay content out inside the rect it is given; it never
 * computes the rect itself.
 *
 * A leaf module with no value imports, so `node --test` can load it. That is
 * also why the constants moved here out of screenWatchService.ts, which has
 * enough imports to be untestable.
 */

/** Collapsed launcher circle. */
export const WIDGET_SIZE = 56

// All of the numbers below are the Figma "Tracely Widget" frame's, not chosen
// here: 480 wide with 24px padding, which is what leaves the 432px source rows
// the design draws. They were 400/18/364 — close enough to look deliberate and
// wrong enough that nothing inside ever lined up with the mockups.

/**
 * 'single' — one claim's card, as the Figma "Widget over Document" frames draw
 * it. Fixed rather than measured, because the height depends on which claim is
 * selected and that lives in the renderer: main sizes the rect the click-through
 * hit-test is derived from, so it cannot ask.
 *
 * 532 is the TALLEST of the three frames (base 487, evidence-refreshed 506,
 * critique-result 532), not an average — the card's body scrolls, so being
 * larger than the content costs whitespace above the pinned button row, while
 * being smaller would clip a critique. It was 568, which is the list view's
 * cap and 36px taller than anything the design draws here.
 */
export const SINGLE_PANEL_WIDTH = 480
export const SINGLE_PANEL_HEIGHT = 532

/**
 * 'all' — a single vertical column (not a grid) so each row has room to show
 * real article titles, not just a count. Sized per claim count so a normal
 * number fits with no scrolling; capped for the rare case of many at once,
 * since letting the panel grow past the screen would just reintroduce
 * clipping. Mirrored client-side in OverlayApp.tsx — keep in sync.
 */
export const GRID_CARD_WIDTH = 432
export const GRID_CARD_HEIGHT = 62
export const GRID_GAP = 10
export const GRID_PADDING = 24
/** The panel's 24px inset on every side (the 4px grid; it was 22 against 24). */
export const PANEL_PADDING_Y = 24
/** The title row itself — the close button's 30px circle sets it. */
export const PANEL_HEADER_HEIGHT = 30
/** The design's stack gap between header, divider and content. */
export const PANEL_GAP = 16

/**
 * Header, its divider, and the gaps either side.
 *
 * The design has no tinted header BAR: the title sits inside the same padded
 * box as the content, with a hairline inset by the padding rather than running
 * edge to edge. This is the vertical cost of that block.
 */
export const GRID_HEADER_HEIGHT = PANEL_HEADER_HEIGHT + PANEL_GAP + 1 + PANEL_GAP
// 568 — the tallest widget frame the design draws. The single-claim card is
// shorter (see SINGLE_PANEL_HEIGHT); this is the ceiling a list of many claims
// or a long structural read is clamped to.
export const MAX_LIST_PANEL_HEIGHT = 568

/**
 * Every panel mode is this wide.
 *
 * Not a coincidence worth preserving by accident: the panel is anchored to the
 * watched window's bottom-right corner, so a mode with a different width would
 * make the whole panel jump sideways when the user switches views. There is a
 * test asserting all three agree.
 */
export const PANEL_WIDTH = GRID_PADDING * 2 + GRID_CARD_WIDTH

/**
 * 'grade' — the Figma "Essay Grade Widget" frame (370:191), 560x321.
 *
 * The one panel that does not share PANEL_WIDTH, and the one that is centred
 * rather than anchored to the bottom-right corner. Both come straight off the
 * frame: it is drawn at x=155 in an 870-wide document, which is dead centre,
 * and at 560 it is wider than the 480 every other mode uses. The "all modes
 * agree on width so the panel doesn't jump" rule still holds for the three
 * corner-anchored modes; a centred panel has no corner to jump away from.
 *
 * Fixed rather than measured for the same reason SINGLE_PANEL_HEIGHT is: main
 * sizes the rect the click-through hit-test derives from, and it cannot ask the
 * renderer how tall the card came out.
 */
export const GRADE_PANEL_WIDTH = 560
export const GRADE_PANEL_HEIGHT = 321

/**
 * 'grade' before there is a reading to show — Figma "Overlay Mockup - Essay
 * Grade (Analyzing)" (391:342), whose Analyzing Card (391:540) is 340x204.
 *
 * Its own size rather than the grade card's, because the frame draws it as its
 * own small card centred over the document rather than as a body inside the
 * 560x321 one: a spinner and two lines floating in a 321px-tall box would read
 * as a card that failed to load its contents. Same centred anchor as 'grade',
 * so the panel does not jump when the reading lands and it swaps in.
 */
export const ANALYZING_PANEL_WIDTH = 340
export const ANALYZING_PANEL_HEIGHT = 204

/**
 * 'report' — the same card expanded, Figma 404:185: 560x1210.
 *
 * 1210 is taller than most windows this is drawn over, and that is fine: the
 * caller already clamps a panel to the watched window minus an inset, and the
 * renderer scrolls the card's body. Asking for the frame's real height means a
 * tall window gets the whole report with no scrollbar at all, which is what the
 * frame draws; a short one scrolls instead of clipping.
 */
export const REPORT_PANEL_WIDTH = 560
export const REPORT_PANEL_HEIGHT = 1210

/**
 * 'paragraph' — Figma "Paragraph Detail" (407:359), 520x930.
 *
 * Narrower than the grade and report cards, which is the frame's own choice:
 * this one is about a single paragraph, and the design gives it a tighter
 * measure and a rounder corner (24 against 28) to say so. Clamped and scrolled
 * exactly like the report.
 */
export const PARAGRAPH_PANEL_WIDTH = 520
export const PARAGRAPH_PANEL_HEIGHT = 930

export function computeAllPanelSize(claimCount: number): { width: number; height: number } {
  const count = Math.max(1, claimCount)
  const naturalHeight =
    PANEL_PADDING_Y * 2 + GRID_HEADER_HEIGHT + count * GRID_CARD_HEIGHT + (count - 1) * GRID_GAP
  return { width: PANEL_WIDTH, height: Math.min(naturalHeight, MAX_LIST_PANEL_HEIGHT) }
}

// Row heights for the structure view, measured against the rendered layout in
// OverlayApp.tsx. These only need to be close: the body scrolls, so being a few
// pixels out costs a scrollbar rather than clipped content — unlike 'all',
// where the panel is sized to fit exactly and overflow is hidden.
const STRUCTURE_SCORE_BLOCK = 96
const STRUCTURE_RUBRIC_BLOCK = 6 * 22 + 12
const STRUCTURE_SECTION_HEADING = 26
const STRUCTURE_WEAKNESS_ROW = 62
const STRUCTURE_PARAGRAPH_ROW = 30
const STRUCTURE_FOOTER = 34

/**
 * Rows past these counts are reached by scrolling rather than by growing the
 * panel. Paragraph count is unbounded, and MAX_LIST_PANEL_HEIGHT binds on any
 * real essay anyway — asking for 900px only to be clamped to 560 wastes the
 * request and makes the height meaningless.
 */
const STRUCTURE_MAX_WEAKNESS_ROWS = 4
const STRUCTURE_MAX_PARAGRAPH_ROWS = 8

export function computeStructurePanelSize({
  weaknessCount,
  paragraphCount
}: {
  weaknessCount: number
  paragraphCount: number
}): { width: number; height: number } {
  const weaknessRows = Math.min(weaknessCount, STRUCTURE_MAX_WEAKNESS_ROWS)
  const paragraphRows = Math.min(paragraphCount, STRUCTURE_MAX_PARAGRAPH_ROWS)

  const natural =
    PANEL_PADDING_Y * 2 +
    GRID_HEADER_HEIGHT +
    STRUCTURE_SCORE_BLOCK +
    STRUCTURE_RUBRIC_BLOCK +
    (weaknessRows > 0 ? STRUCTURE_SECTION_HEADING + weaknessRows * STRUCTURE_WEAKNESS_ROW : 0) +
    (paragraphRows > 0 ? STRUCTURE_SECTION_HEADING + paragraphRows * STRUCTURE_PARAGRAPH_ROW : 0) +
    STRUCTURE_FOOTER

  return { width: PANEL_WIDTH, height: Math.min(natural, MAX_LIST_PANEL_HEIGHT) }
}
