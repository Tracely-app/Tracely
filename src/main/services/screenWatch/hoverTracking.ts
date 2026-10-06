import { screen } from 'electron'
import { IPC_EVENTS } from '@shared/ipc-channels'
import type { ScreenWatchHoverEvent } from '@shared/ipc-contract'
import { shouldCaptureMouse } from '@shared/overlayCapture'
import { hoverIntent, inSafeZone, stepPending, type PendingHover } from '@shared/hoverIntent'
import { focusedShieldableWindow } from '../../windows/overlayShield'
import { getOverlayWindow, setOverlayMouseEventsCaptured } from '../../windows/overlayWindow'
import { getActivePopoverRect, getHoverTargets } from './screenWatchService'
import type { ScreenRect } from './uiaSnapshot'

// The overlay window is click-through by default (setIgnoreMouseEvents with
// forward:true) so it never steals clicks from whatever app is underneath —
// that's the whole point of an overlay. But that also means the renderer
// never receives real mouse events, so hovering can't be detected from
// inside the window itself. Instead we poll the OS-level cursor position
// from the main process (which works regardless of window focus) and toggle
// click-through on/off depending on whether the cursor is over a claim's
// underline — the same technique Grammarly's desktop overlay uses.
const POLL_MS = 80
// Opening a popover requires the cursor to actually touch the underline —
// like Grammarly — not just be somewhere in its general vicinity. Small,
// uniform pad, used for every target every time (no more "loose zone while
// already hovered" guesswork — see below for what replaced that).
const PAD_SIDE = 2
const PAD_TOP = 2
const PAD_BOTTOM = 3
// The collapsed launcher circle's badge pokes a few px past the circle's own
// bounds (see WIDGET_SIZE in screenWatchService.ts), and needs a small pad
// to stay clickable. The target explicitly overrides this to zero for the
// expanded panel so transparent pixels around it remain click-through.
const WIDGET_PAD = 5
// Once a claim's popover is open, its REAL rendered rect (reported by the
// renderer via setActivePopoverRect — see screenWatchService.ts) is used to
// decide whether the cursor is still "in" it, with just this small comfort
// margin — not a blindly large guessed pad. This is what makes moving to
// "Find a source"/"Dismiss" work AND makes moving away from the popover
// (not just away from the underline) actually close it.
const POPOVER_PAD = 4
// Small grace period after the cursor leaves the hit zone before actually
// hiding — absorbs the kind of momentary jitter that'd otherwise make the
// tooltip flicker in and out near the boundary, and bridges the small gap
// between the underline and the popover's top edge.
const LEAVE_GRACE_MS = 200

let pollTimer: ReturnType<typeof setInterval> | null = null
let leaveTimer: ReturnType<typeof setTimeout> | null = null
let hoveredKey: string | null = null
// Hover intent (shared/hoverIntent.ts): an open or a swap counting down, and
// the cursor's last spot on the open card's own underline — the tip of the
// safe zone toward the card. Owner, 2026-10-06: "it jumps too much when there
// are underlines everywhere."
let pending: PendingHover | null = null
let apex: { x: number; y: number } | null = null
// While a widget drag is in progress the cursor moves freely around the
// whole screen, well outside the widget's own (small, or not-yet-updated)
// hit-test rect — normal poll-based hit-testing would toggle click-through
// back on mid-drag and drop the rest of the drag on the floor. Forcing
// capture for the drag's duration keeps mouse events flowing to the
// renderer regardless of what the poll loop would otherwise decide.
let dragActive = false

function setCaptureMouseEvents(capture: boolean): void {
  setOverlayMouseEventsCaptured(capture)
}

export function setDragActive(active: boolean): void {
  dragActive = active
  setCaptureMouseEvents(active)
}

function sendHover(event: ScreenWatchHoverEvent | null): void {
  const win = getOverlayWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC_EVENTS.SCREENWATCH_HOVER_CHANGED, event)
}

function clearHover(): void {
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
  const hadHover = hoveredKey !== null
  hoveredKey = null
  pending = null
  apex = null
  setCaptureMouseEvents(false)
  if (hadHover) sendHover(null)
}

/**
 * Drops any active hover, releasing native mouse capture and telling the
 * overlay to close its popover.
 *
 * Exported for `clearOverlay` in screenWatchService: clearing the overlay
 * payload alone is not enough, because OverlayApp synthesizes a popover from
 * the hover event when the payload's claim list has no match — so the card
 * would keep floating over an overlay with nothing else left on it.
 */
export function clearHoverState(): void {
  clearHover()
}

function within(point: { x: number; y: number }, rect: ScreenRect, pad: number): boolean {
  return (
    point.x >= rect.x - pad &&
    point.x <= rect.x + rect.width + pad &&
    point.y >= rect.y - pad &&
    point.y <= rect.y + rect.height + pad
  )
}

function poll(): void {
  // The overlay is at the screen-saver always-on-top level, above every
  // other Tracely window. Whichever one owns focus, release native capture so
  // a stale Screen Watch target can never turn transparent pixels into a
  // click shield over its controls.
  //
  // One rule rather than a branch per window, and it runs ABOVE the
  // dragActive early-return: a widget drag interrupted by another Tracely
  // window taking focus used to keep native capture until some later drag
  // ended. Clearing dragActive uniformly closes that.
  if (focusedShieldableWindow() !== null) {
    dragActive = false
    clearHover()
    return
  }

  if (dragActive) return

  const targets = getHoverTargets()
  if (targets.length === 0) {
    clearHover()
    return
  }

  const cursor = screen.getCursorScreenPoint()

  const activeClaimId = hoveredKey?.split(':')[0] ?? null
  const activeTarget = activeClaimId ? targets.find((t) => t.claimId === activeClaimId) : undefined
  const popover = getActivePopoverRect()

  // If a claim is already hovered, first check whether the cursor is still
  // on its underline OR inside its actually-open popover's real rect. If
  // so, nothing to do — stay hovered, no new event needed.
  if (activeTarget) {
    const pad = activeTarget.kind === 'widget' ? (activeTarget.capturePadding ?? WIDGET_PAD) : PAD_SIDE
    const onUnderline = activeTarget.rectsAbsolute.some((r) => within(cursor, r, pad))
    const inPopover =
      popover.claimId === activeClaimId &&
      popover.rectAbsolute !== null &&
      within(cursor, popover.rectAbsolute, POPOVER_PAD)
    if (onUnderline || inPopover) {
      if (leaveTimer) {
        clearTimeout(leaveTimer)
        leaveTimer = null
      }
      pending = null
      // Where the cursor last was on its own line is where the way to the
      // card starts.
      if (onUnderline && activeTarget.kind !== 'widget') apex = { x: cursor.x, y: cursor.y }
      // Re-decided every tick rather than latched at hover time: this is the
      // path the cursor takes when it moves from an underline onto the card,
      // and back off again.
      setCaptureMouseEvents(
        shouldCaptureMouse({ dragActive, hovering: activeTarget.kind, inPopover })
      )
      return
    }
  }

  // Otherwise, look for any target the cursor newly touches — always a
  // tight pad, every target, so hovering never sloppily jumps from one
  // flagged word straight into a neighboring one.
  let match: (typeof targets)[number] | null = null
  let matchedRectIndex = 0
  for (const t of targets) {
    const widgetPad = t.capturePadding ?? WIDGET_PAD
    const padSide = t.kind === 'widget' ? widgetPad : PAD_SIDE
    const padTop = t.kind === 'widget' ? widgetPad : PAD_TOP
    const padBottom = t.kind === 'widget' ? widgetPad : PAD_BOTTOM
    const idx = t.rectsAbsolute.findIndex(
      (r) =>
        cursor.x >= r.x - padSide &&
        cursor.x <= r.x + r.width + padSide &&
        cursor.y >= r.y - padTop &&
        cursor.y <= r.y + r.height + padBottom
    )
    if (idx !== -1) {
      match = t
      matchedRectIndex = idx
      break
    }
  }

  const take = (t: NonNullable<typeof match>, rectIndex: number): void => {
    if (leaveTimer) {
      clearTimeout(leaveTimer)
      leaveTimer = null
    }
    pending = null
    // Outside the hoverKey check below: that only fires when the target
    // CHANGES, and the capture state has to be correct on every tick — a claim
    // whose popover closed under a stationary cursor would otherwise hold the
    // mouse indefinitely.
    setCaptureMouseEvents(shouldCaptureMouse({ dragActive, hovering: t.kind, inPopover: false }))
    // Only re-send on an actual target (or matched line, for a claim that
    // wraps multiple lines) change — the tooltip is anchored to that rect,
    // not the cursor, so it has no reason to move on every tick.
    const hoverKey = `${t.claimId}:${rectIndex}`
    if (hoveredKey !== hoverKey) {
      hoveredKey = hoverKey
      if (t.kind !== 'widget') apex = { x: cursor.x, y: cursor.y }
      sendHover({
        claimId: t.claimId,
        kind: t.kind,
        text: t.text,
        claimType: t.claimType,
        anchor: t.rectsWindowLocal[rectIndex] ?? t.rectsWindowLocal[0]
      })
    }
  }

  // The launcher and the panel are buttons, not underlines: no intent delay.
  if (match?.kind === 'widget') {
    take(match, matchedRectIndex)
    return
  }

  // Underlines go through hover intent (shared/hoverIntent.ts): open only once
  // the cursor stays, and on the way from a card's sentence to the card, ignore
  // the lines it crosses.
  const cardOpen = activeTarget !== undefined && activeTarget.kind !== 'widget'
  const card =
    cardOpen && popover.claimId === activeClaimId && popover.rectAbsolute
      ? {
          left: popover.rectAbsolute.x,
          top: popover.rectAbsolute.y,
          right: popover.rectAbsolute.x + popover.rectAbsolute.width,
          bottom: popover.rectAbsolute.y + popover.rectAbsolute.height
        }
      : null
  const decision = hoverIntent({
    open: cardOpen,
    openKey: cardOpen ? activeClaimId : null,
    onCard: false,
    onOwn: false,
    inSafeZone: cardOpen && inSafeZone(apex, card, cursor.x, cursor.y),
    under: match?.claimId ?? null
  })
  const step = stepPending(pending, decision, Date.now(), cursor.x, cursor.y)
  pending = step.pending
  if (step.fire && match) {
    take(match, matchedRectIndex)
    return
  }
  // Between underlines, over other text, or counting down: the cursor is over
  // the watched app, so the overlay must stay click-through.
  setCaptureMouseEvents(false)
  if (decision.act === 'stay' || pending?.act === 'swap') {
    // On the way to the card, or about to swap: the card stays up.
    if (leaveTimer) {
      clearTimeout(leaveTimer)
      leaveTimer = null
    }
    return
  }

  if (hoveredKey !== null && !leaveTimer) {
    leaveTimer = setTimeout(() => {
      leaveTimer = null
      clearHover()
    }, LEAVE_GRACE_MS)
  }
}

export function startHoverTracking(): void {
  if (pollTimer) return
  pollTimer = setInterval(poll, POLL_MS)
}

export function stopHoverTracking(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
  hoveredKey = null
  pending = null
  apex = null
  setCaptureMouseEvents(false)
}
