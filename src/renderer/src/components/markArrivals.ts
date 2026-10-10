import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  ANIMATION_BACKSTOP_MS,
  MARK_EASE,
  MARK_IN_KEYFRAMES,
  MARK_IN_MS,
  MARK_OUT_MS,
  POPOVER_IN_MS,
  isFreshMark,
  markInDelay,
  popoverInKeyframes,
  sameSpot,
  type SeenMark
} from '@shared/markMotion'

/*
 * Arrivals and departures for the two surfaces that draw marks — the editor
 * (DocumentMarkLayer) and the Screen Watch overlay (OverlayApp). The decisions
 * are shared/markMotion.ts; this is only the React plumbing around them, kept
 * in one place so the two surfaces cannot drift.
 */

/**
 * The reader's reduced-motion setting. One MediaQueryList for the module,
 * made on first use; `.matches` is read live, so turning the OS setting on
 * stops the next mark's entrance without a reload. When it is on, nothing
 * here moves: no draw-in, no stagger, no card entrance, no departing ghost.
 */
let motionQuery: MediaQueryList | null | undefined
export function reducedMotion(): boolean {
  if (motionQuery === undefined) {
    try {
      motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    } catch {
      motionQuery = null
    }
  }
  return motionQuery?.matches ?? false
}

/**
 * Plays an entrance once, then CANCELS it on a timer. Chromium does not advance
 * animations in a window that is not painting — the overlay is never focused
 * and always above another app — and an entrance holds its element at the
 * first keyframe until it runs. The timer makes the worst case "appears".
 */
export function playEntrance(
  el: Element | null,
  keyframes: Keyframe[],
  options: { duration: number; delay?: number; easing?: string }
): Animation | null {
  if (!el || typeof el.animate !== 'function' || reducedMotion()) return null
  try {
    const anim = el.animate(keyframes, { ...options, fill: 'backwards' })
    setTimeout(() => anim.cancel(), (options.delay ?? 0) + options.duration + ANIMATION_BACKSTOP_MS)
    return anim
  } catch {
    /* no animation: it simply appears */
    return null
  }
}

/** The line of a new mark draws itself in, once, when it mounts. */
export function useDrawIn(ref: RefObject<Element>, delay: number | undefined): void {
  const first = useRef(delay)
  useLayoutEffect(() => {
    if (first.current === undefined) return
    const anim = playEntrance(ref.current, MARK_IN_KEYFRAMES as Keyframe[], {
      duration: MARK_IN_MS,
      delay: first.current,
      easing: MARK_EASE
    })
    // StrictMode runs this twice on mount in development; one stroke, not two.
    return () => anim?.cancel()
    // Mount only: a mark that is already on the page never animates again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

export interface MarkItem {
  /** The React key the mark is rendered under. */
  id: string
  seen: SeenMark
}

/** How long a mark is remembered after it was last drawn. Long enough to span
 *  a re-detection on either surface. */
const RECENT_MS = 10_000

/**
 * Which of this render's marks are new on the page, and their stagger. Only a
 * mark MOUNTING now can be in it, and only if `isFreshMark` says nothing like
 * it was drawn recently — so typing, scrolling, re-measuring and re-detecting
 * never replay an entrance.
 */
export function useMarkArrivals(items: MarkItem[]): Map<string, number> {
  const mounted = useRef<Set<string>>(new Set())
  const recent = useRef<Map<string, SeenMark & { t: number }>>(new Map())
  const fresh = items
    .filter((i) => !mounted.current.has(i.id) && isFreshMark([...recent.current.values()], i.seen))
    .sort((a, b) => a.seen.y - b.seen.y || a.seen.x0 - b.seen.x0)
  // Under reduced motion the stagger is 0 too: every mark is simply there.
  const still = reducedMotion()
  const arrivals = new Map(fresh.map((i, n) => [i.id, still ? 0 : markInDelay(n)]))
  useEffect(() => {
    mounted.current = new Set(items.map((i) => i.id))
    const now = Date.now()
    for (const [k, r] of recent.current) if (now - r.t > RECENT_MS) recent.current.delete(k)
    for (const i of items) recent.current.set(`${i.seen.key}|${Math.round(i.seen.x0)}|${Math.round(i.seen.y)}`, { ...i.seen, t: now })
  })
  return arrivals
}

/**
 * Marks that just left — dismissed, fixed, edited away — kept for one fade.
 * Not one that was replaced in place (same text, or same colour on the same
 * spot: an edit re-keyed it), and not one `stillLive` says is only out of view.
 * `items` must be memoised by the caller; the comparison runs when it changes.
 */
export function useMarkDepartures<T extends MarkItem>(items: T[], stillLive?: (id: string) => boolean): T[] {
  const prev = useRef<T[]>(items)
  const [ghosts, setGhosts] = useState<T[]>([])
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(() => {
    const live = timers.current
    return () => {
      for (const t of live) clearTimeout(t)
    }
  }, [])
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id))
    const gone = prev.current.filter(
      (p) =>
        !ids.has(p.id) &&
        !(stillLive?.(p.id) ?? false) &&
        !items.some((n) => n.seen.key === p.seen.key || sameSpot(p.seen, n.seen))
    )
    prev.current = items
    if (gone.length === 0 || reducedMotion()) return
    setGhosts((g) => [...g, ...gone])
    const t = setTimeout(() => {
      timers.current.delete(t)
      setGhosts((g) => g.filter((x) => !gone.includes(x)))
    }, MARK_OUT_MS + 80)
    timers.current.add(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])
  return ghosts
}

/**
 * A hover card grows out of its sentence the first time it is drawn for `key`,
 * once `ready` (measured, so `above` is the side it will actually sit on).
 * Moving straight from one sentence's card to the next is a short crossfade
 * instead, so the card does not bounce on every swap.
 */
export function usePopoverEntrance(ref: RefObject<Element>, key: string, ready: boolean, above: boolean): void {
  const played = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!ready || played.current === key) return
    const switching = played.current !== null
    played.current = key
    playEntrance(
      ref.current,
      (switching ? [{ opacity: 0 }, { opacity: 1 }] : popoverInKeyframes(above)) as Keyframe[],
      { duration: switching ? 90 : POPOVER_IN_MS, easing: MARK_EASE }
    )
  })
}

export { MARK_OUT_MS }
