import { useEffect, useRef } from 'react'

/**
 * The document toolbar's dropdown menus — Figma 226:95 (Font), 226:104
 * (Align), 234:46 (Font Size), 234:67 (Share), 234:74 (More), 234:85 (Word
 * Count).
 *
 * All six share one chrome — the shared menu recipe: var(--surface), a 1px
 * var(--border-strong) edge, 12px radius, 6px/4px padding, 2px between rows
 * and var(--shadow-lg). Rows are 32px tall with a 6px radius, 13px/500
 * var(--text), hover var(--hover); the active row keeps the accent wash.
 *
 * The widths are the frames' own and differ per menu (132, 109, 48, 125, 123,
 * 131), so each caller passes its own rather than one shared value being
 * approximately right for all of them.
 *
 * `disabled` items are the design's rows that the product cannot do — sharing
 * a document that only exists on this machine, folders that do not exist. They
 * render because the frame draws them and stay dead because there is nothing
 * behind them; `title` says which.
 */
export interface ToolbarMenuItem {
  label: string
  onSelect?: () => void
  active?: boolean
  disabled?: boolean
  /** Hover text — used to say why a disabled row is disabled. */
  title?: string
}

export default function ToolbarMenu({
  items,
  width,
  align = 'left',
  onClose
}: {
  items: ToolbarMenuItem[]
  /** The frame's own width for this menu. */
  width: number
  /** Which edge to hang from, when the trigger is near the window edge. */
  align?: 'left' | 'right'
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  // Click-away and Escape. Pointerdown rather than click so it closes before
  // the editor takes focus back and the caret jumps.
  useEffect(() => {
    function onPointerDown(e: PointerEvent): void {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="toolbar-menu"
      style={{ width, [align]: 0 }}
      role="menu"
      // The editor is a contentEditable; letting these buttons take focus
      // would collapse the selection the command is about to act on.
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={`toolbar-menu-item${item.active ? ' active' : ''}`}
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            if (item.disabled) return
            item.onSelect?.()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
