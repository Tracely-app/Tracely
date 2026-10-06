import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  HOVER_OPEN_MS,
  HOVER_REST_MS,
  HOVER_SWAP_MS,
  hoverIntent,
  inSafeZone,
  stepPending,
  type HoverState,
  type PendingHover
} from './hoverIntent.ts'
import { isFreshMark, markInDelay, MARK_IN_STAGGER_MAX_MS, sameSpot } from './markMotion.ts'

/*
 * Owner, 2026-10-06: "it jumps too much when there are underlines everywhere …
 * maybe do the triangle method." The editor and the Screen Watch overlay both
 * decide through these; the Chrome extension's copy is pinned by
 * server/test/ext-hover-intent.test.js on the same cases.
 */
const open: HoverState = { open: true, openKey: 'A', onCard: false, onOwn: false, inSafeZone: false, under: null }

describe('hoverIntent', () => {
  it('a pass across the page opens nothing: a card waits for the pointer to stay', () => {
    deepStrictEqual(hoverIntent({ ...open, open: false, openKey: null, under: 'A' }), {
      act: 'open',
      key: 'A',
      ms: HOVER_OPEN_MS,
      rest: false
    })
    strictEqual(hoverIntent({ ...open, open: false, openKey: null }).act, 'none')
    ok(HOVER_OPEN_MS >= 100 && HOVER_OPEN_MS <= 200)
  })

  it('on the way to the card other underlines are ignored, unless the pointer stops on one', () => {
    strictEqual(hoverIntent({ ...open, inSafeZone: true }).act, 'stay')
    deepStrictEqual(hoverIntent({ ...open, inSafeZone: true, under: 'B' }), {
      act: 'swap',
      key: 'B',
      ms: HOVER_REST_MS,
      rest: true
    })
    ok(HOVER_REST_MS > HOVER_SWAP_MS)
  })

  it('on the card or its own line it stays; elsewhere another mark takes over, and empty page hides', () => {
    strictEqual(hoverIntent({ ...open, onCard: true, under: 'B' }).act, 'stay')
    strictEqual(hoverIntent({ ...open, onOwn: true, under: 'B' }).act, 'stay')
    deepStrictEqual(hoverIntent({ ...open, under: 'B' }), { act: 'swap', key: 'B', ms: HOVER_SWAP_MS, rest: false })
    strictEqual(hoverIntent(open).act, 'hide')
    strictEqual(hoverIntent({ ...open, under: 'A' }).act, 'hide', 'its own key is never a swap')
  })
})

describe('inSafeZone', () => {
  const card = { left: 100, right: 420, top: 300, bottom: 500 }
  const apex = { x: 150, y: 200 }

  it('covers the way from the pointer to the card, and nothing else', () => {
    strictEqual(inSafeZone(apex, card, 150, 250), true)
    strictEqual(inSafeZone(apex, card, 280, 290), true)
    strictEqual(inSafeZone(apex, card, 152, 201), true, 'the first pixel of a move is inside')
    strictEqual(inSafeZone(apex, card, 60, 250), false, 'sideways')
    strictEqual(inSafeZone(apex, card, 150, 180), false, 'back up')
    strictEqual(inSafeZone(apex, card, 470, 290), false, 'out past the edge')
    strictEqual(inSafeZone(null, card, 150, 250), false)
  })

  it("reaches the card's far corners: from the end of a long line the card is beside the pointer", () => {
    // Measured in the extension's harness: this exact move swapped cards
    // before the zone took in the whole card.
    const near = { left: 13, right: 327, top: 74, bottom: 239 }
    const end = { x: 449, y: 63 }
    strictEqual(inSafeZone(end, near, 424, 79), true)
    strictEqual(inSafeZone(end, near, 360, 140), true)
    strictEqual(inSafeZone(end, near, 449, 150), false, 'straight down past the card')
  })

  it('works for a card above its sentence', () => {
    const up = { left: 100, right: 420, top: 0, bottom: 150 }
    strictEqual(inSafeZone(apex, up, 200, 170), true)
    strictEqual(inSafeZone(apex, up, 200, 230), false)
  })
})

describe('stepPending', () => {
  const openB = hoverIntent({ ...open, open: false, openKey: null, under: 'B' })
  const restB = hoverIntent({ ...open, inSafeZone: true, under: 'B' })

  it('fires once the decision has held for its time, and not before', () => {
    let s = stepPending(null, openB, 0, 10, 10)
    strictEqual(s.fire, false)
    s = stepPending(s.pending, openB, 80, 40, 10) // moving along the same line keeps counting
    strictEqual(s.fire, false)
    s = stepPending(s.pending, openB, HOVER_OPEN_MS, 60, 10)
    strictEqual(s.fire, true)
    strictEqual(s.pending, null)
  })

  it('a rest restarts when the pointer moves, so passing through never fires', () => {
    let p: PendingHover | null = null
    let fired = false
    for (let t = 0; t <= 900; t += 80) {
      const s = stepPending(p, restB, t, 10 + t / 10, 10)
      p = s.pending
      fired ||= s.fire
    }
    strictEqual(fired, false, 'kept moving: nothing')
    let s = stepPending(p, restB, 1000, 200, 10)
    s = stepPending(s.pending, restB, 1000 + HOVER_REST_MS - 1, 201, 10)
    strictEqual(s.fire, false)
    s = stepPending(s.pending, restB, 1000 + HOVER_REST_MS, 201, 11)
    strictEqual(s.fire, true, 'stopped: it opens')
  })

  it('another target or a non-opening decision drops the countdown', () => {
    const s = stepPending(null, openB, 0, 0, 0)
    const other = stepPending(s.pending, hoverIntent({ ...open, open: false, openKey: null, under: 'C' }), 100, 0, 0)
    strictEqual(other.pending?.key, 'C')
    strictEqual(other.pending?.since, 100)
    deepStrictEqual(stepPending(s.pending, { act: 'stay' }, 100, 0, 0), { pending: null, fire: false })
  })
})

describe('isFreshMark', () => {
  const seen = [{ key: 'Napoleon was short.', color: '#d93636', x0: 100, x1: 400, y: 1000 }]

  it('only a mark new on the page animates — not a redraw, not a sentence being typed in', () => {
    strictEqual(isFreshMark(seen, { ...seen[0], y: 1600 }), false, 'same sentence, moved')
    strictEqual(isFreshMark(seen, { key: 'Napoleon was very short.', color: '#d93636', x0: 100, x1: 410, y: 1002 }), false, 'edited, same spot')
    strictEqual(isFreshMark(seen, { key: 'Other.', color: '#ffb800', x0: 100, x1: 400, y: 1000 }), true, 'a new finding there')
    strictEqual(isFreshMark(seen, { key: 'Other.', color: '#d93636', x0: 100, x1: 400, y: 1040 }), true, 'another line')
    strictEqual(isFreshMark([], seen[0]), true)
    strictEqual(sameSpot(seen[0], { ...seen[0], key: 'x', x0: 400, x1: 500 }), false, 'touching is not overlapping')
  })

  it('arrivals stagger top to bottom, capped', () => {
    strictEqual(markInDelay(0), 0)
    ok(markInDelay(1) > 0)
    strictEqual(markInDelay(1000), MARK_IN_STAGGER_MAX_MS)
  })
})
