/**
 * Why a hover popover does not close the instant the pointer leaves the mark.
 *
 * The card is drawn a short gap away from the text it is about — `POPOVER_GAP`,
 * plus the tail. Crossing that gap means the pointer is, for a few frames, over
 * neither the mark nor the card. Closing on the first such frame makes the card
 * impossible to reach: it vanishes exactly as the user moves toward it, which
 * is the single most common way a hover UI is unusable, and it looks like the
 * feature is broken rather than like a timing choice.
 *
 * The fix is a grace period, not a bigger hit area. Widening the mark's hit
 * region would make it swallow neighbouring text, and bridging the gap with an
 * invisible element only works for one of the four placements the card takes
 * (above, below, and shifted left or right to stay inside the editor).
 *
 * Kept here rather than as a magic number inside the view because it is a
 * decision with a wrong answer on both sides, and because both surfaces that
 * draw a hover card — the claim popover and the prose card — have to agree. A
 * card that lingers when the pointer has genuinely gone elsewhere is its own
 * bug: it covers the very text the writer moved on to read.
 */

/**
 * How long the pointer may be over neither the mark nor the card before the
 * card closes.
 *
 * 140ms. A deliberate 10px move takes roughly 30–60ms at ordinary pointer
 * speeds, so this clears the gap with room to spare; past about 250ms the card
 * starts visibly outstaying the pointer on a fast sweep across a paragraph of
 * marks, which reads as lag.
 */
export const HOVER_CLOSE_DELAY_MS = 140

/**
 * A pending close that can be cancelled — the whole mechanism, in a shape both
 * surfaces can hold in a ref.
 *
 * `arm` is idempotent: arming an already-armed close does NOT restart the
 * timer. That matters because `mousemove` fires continuously while the pointer
 * sits in the gap, and restarting on each event would hold the card open for as
 * long as the pointer hovered a dead zone — which is precisely the lingering
 * failure this is bounded to avoid.
 */
export interface HoverCloser {
  /** Schedule the close, unless one is already scheduled. */
  arm: (close: () => void) => void
  /** The pointer reached the card, or another mark. Nothing closes. */
  cancel: () => void
  /** Close now, without waiting — for cases that are not a gap crossing, like
   *  the flow being dismissed or the document being closed. */
  flush: (close: () => void) => void
  /** Whether a close is currently pending. */
  armed: () => boolean
}

export function createHoverCloser(
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  unschedule: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  delayMs: number = HOVER_CLOSE_DELAY_MS
): HoverCloser {
  let handle: unknown = null

  const cancel = (): void => {
    if (handle === null) return
    unschedule(handle)
    handle = null
  }

  return {
    arm(close) {
      if (handle !== null) return
      handle = schedule(() => {
        handle = null
        close()
      }, delayMs)
    },
    cancel,
    flush(close) {
      cancel()
      close()
    },
    armed: () => handle !== null
  }
}

/*
 * ---- Opening and swapping: hover INTENT ------------------------------------
 *
 * Owner, 2026-10-06: "it jumps too much when there are underlines everywhere …
 * maybe do the triangle method where it ignores everything within a triangle
 * of the mouse and the button on the overlay."
 *
 * Two causes, on every surface that draws a hover card. A card opened the
 * instant the pointer crossed ANY underline, so moving across a marked page
 * flashed card after card. And the way from a sentence to its card crosses the
 * lines in between — each one another sentence's underline — and each swapped
 * the card before the pointer could reach a button.
 *
 * - A card OPENS once the pointer has stayed on an underline for
 *   HOVER_OPEN_MS, so a pass across the page opens nothing.
 * - The SAFE ZONE (Amazon's menu-aim, Floating UI's safePolygon): from the
 *   pointer's last spot on the open card's own sentence to the card, whatever
 *   the pointer crosses is ignored. Stopping on another underline inside it
 *   for HOVER_REST_MS still opens that one, so nothing becomes unreachable.
 * - Outside the zone, another underline takes over after HOVER_SWAP_MS, and
 *   empty page closes the card after the surface's own close grace
 *   (HOVER_CLOSE_DELAY_MS here, the overlay's LEAVE_GRACE_MS).
 *
 * The Chrome extension carries a hand copy (extension/content.js hoverIntent,
 * inSafeTriangle); keep the two in step.
 */

/** A card opens after the pointer stays this long on one underline. Long
 *  enough that a sweep across a line opens nothing, short enough to feel
 *  immediate. */
export const HOVER_OPEN_MS = 140
/** Outside the safe zone, another underline takes the card after this long. */
export const HOVER_SWAP_MS = 120
/** Inside the safe zone, another underline takes the card only once the
 *  pointer has RESTED on it this long — it stopped, rather than passed. */
export const HOVER_REST_MS = 300
/** Movement under this many px does not restart a rest. */
export const HOVER_REST_SLOP_PX = 3

export interface HoverState {
  /** A card is open. */
  open: boolean
  /** What the open card is about, in the surface's own key space. */
  openKey: string | null
  /** The pointer is on the card (padded). */
  onCard: boolean
  /** The pointer is on the open card's own underline. */
  onOwn: boolean
  /** The pointer is on the way from its own underline to the card. */
  inSafeZone: boolean
  /** The underline under the pointer, if any. */
  under: string | null
}

export type HoverDecision =
  | { act: 'none' }
  | { act: 'stay' }
  | { act: 'hide' }
  | { act: 'open' | 'swap'; key: string; ms: number; rest: boolean }

/** One pointer position's decision. */
export function hoverIntent(s: HoverState): HoverDecision {
  if (!s.open) return s.under ? { act: 'open', key: s.under, ms: HOVER_OPEN_MS, rest: false } : { act: 'none' }
  if (s.onCard || s.onOwn) return { act: 'stay' }
  const other = s.under !== null && s.under !== s.openKey ? s.under : null
  if (s.inSafeZone) return other ? { act: 'swap', key: other, ms: HOVER_REST_MS, rest: true } : { act: 'stay' }
  if (other) return { act: 'swap', key: other, ms: HOVER_SWAP_MS, rest: false }
  return { act: 'hide' }
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

type Pt = [number, number]

/**
 * Is (x, y) on the way from `apex` to the card?
 *
 * The convex hull of a short segment around the apex (2·slack wide, so the
 * first pixel of a move is never outside a needle-thin tip) and the whole card,
 * widened by `slack`. The card's FAR corners are in it for the reason Floating
 * UI's safePolygon reaches them: a card sits ~10px under its line, so a pointer
 * leaving from the end of a long line arrives at the card's side, not its top
 * edge. Moving straight down past the card, or away from it, is outside.
 */
export function inSafeZone(
  apex: { x: number; y: number } | null,
  card: Box | null,
  x: number,
  y: number,
  slack = 6
): boolean {
  if (!apex || !card) return false
  const pts: Pt[] = [
    [apex.x - slack, apex.y],
    [apex.x + slack, apex.y],
    [card.left - slack, card.top - slack],
    [card.right + slack, card.top - slack],
    [card.right + slack, card.bottom + slack],
    [card.left - slack, card.bottom + slack]
  ]
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1])
  const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: Pt[]): Pt[] => {
    const h: Pt[] = []
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop()
      h.push(p)
    }
    h.pop()
    return h
  }
  const hull = [...half(pts), ...half([...pts].reverse())]
  for (let i = 0; i < hull.length; i++) {
    if (cross(hull[i], hull[(i + 1) % hull.length], [x, y]) < 0) return false
  }
  return true
}

/** An open or a swap that is counting down. */
export interface PendingHover {
  act: 'open' | 'swap'
  key: string
  ms: number
  rest: boolean
  /** When the count started (restarted by movement, for a rest). */
  since: number
  x: number
  y: number
}

/**
 * Advance the countdown by one decision. Both surfaces run it: the overlay on
 * every 80ms poll, the editor on every mousemove plus a timer for the moment
 * the pointer stops moving. `fire` means "do it now"; the caller then opens
 * the card for `key` and makes the pointer the new apex.
 *
 * The same decision again keeps counting — re-arming on every event would hold
 * a card shut for as long as the pointer kept moving — except a REST, which
 * restarts whenever the pointer moves more than HOVER_REST_SLOP_PX.
 */
export function stepPending(
  prev: PendingHover | null,
  d: HoverDecision,
  now: number,
  x: number,
  y: number
): { pending: PendingHover | null; fire: boolean } {
  if (d.act !== 'open' && d.act !== 'swap') return { pending: null, fire: false }
  let p: PendingHover
  if (prev && prev.act === d.act && prev.key === d.key) {
    const moved = Math.hypot(x - prev.x, y - prev.y) > HOVER_REST_SLOP_PX
    p = d.rest && moved ? { ...prev, since: now, x, y } : prev
  } else {
    p = { act: d.act, key: d.key, ms: d.ms, rest: d.rest, since: now, x, y }
  }
  if (now - p.since >= p.ms) return { pending: null, fire: true }
  return { pending: p, fire: false }
}
