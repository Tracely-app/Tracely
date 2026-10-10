// The one icon set: 24-grid line icons, 1.75px stroke, round caps and joins,
// no fills, currentColor, 16px by default (20 in tiles). Hand-rolled inline
// SVG rather than an icon library so the overlay's string markup (ICON_SVG,
// below) and the React components can share the identical paths.
import type { ReactNode } from 'react'
import figmaLogo from '../assets/figma-logo.png'

interface IconProps {
  size?: number
  className?: string
}

/** Paths shared between the React icons and the overlay's SVG strings. */
const PATHS = {
  close: 'M6 6l12 12M18 6L6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  check: 'M5 12l5 5 9-10'
} as const

function Icon({ size = 16, className, children }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function UserIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" />
    </Icon>
  )
}

export function SunIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" />
    </Icon>
  )
}

export function SignOutIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M9 20H5.5A1.5 1.5 0 014 18.5v-13A1.5 1.5 0 015.5 4H9" />
      <path d="M13 16l4-4-4-4M17 12H9" />
    </Icon>
  )
}

export function BackIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M15 19l-7-7 7-7" />
    </Icon>
  )
}

export function CloseIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d={PATHS.close} />
    </Icon>
  )
}

/** The bare plus. The circled one is PlusCircleIcon. */
export function PlusIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  )
}

export function PlusCircleIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </Icon>
  )
}

export function DocumentIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M7 3.5h7l4 4V20a1 1 0 01-1 1H7a1 1 0 01-1-1V4.5a1 1 0 011-1z" />
      <path d="M14 3.5V8h4" />
    </Icon>
  )
}

export function SlidersIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
    </Icon>
  )
}

export function ShieldIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5V6l7-3z" />
    </Icon>
  )
}

export function ShieldCheckIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </Icon>
  )
}

export function CogIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" />
    </Icon>
  )
}

export function SearchIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </Icon>
  )
}

export function ArrowRightIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  )
}

export function ChevronDownIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d={PATHS.chevronDown} />
    </Icon>
  )
}

export function ChevronRightIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d={PATHS.chevronRight} />
    </Icon>
  )
}

/** Three 1.75px dots: zero-length strokes with round caps. */
export function MoreHorizontalIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d={PATHS.more} />
    </Icon>
  )
}

export function GripIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d={PATHS.grip} />
    </Icon>
  )
}

export function ShareIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
    </Icon>
  )
}

export function AlignLeftIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M3 6h18M3 12h12M3 18h16" />
    </Icon>
  )
}

export function ExpandIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </Icon>
  )
}

export function CheckIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d={PATHS.check} />
    </Icon>
  )
}

export function SendIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </Icon>
  )
}

export function BellIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 003.4 0" />
    </Icon>
  )
}

export function LinkIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <path d="M9 17H7A5 5 0 017 7h2M15 7h2a5 5 0 110 10h-2M8 12h8" />
    </Icon>
  )
}

export function CardIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </Icon>
  )
}

export function InfoIcon(p: IconProps): JSX.Element {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </Icon>
  )
}

/**
 * The brand mark — figma-logo.png, nowhere else. `inverted` paints it white
 * for the launcher's dark tile.
 */
export function BrandMark({ size = 24, inverted = false, className }: IconProps & { inverted?: boolean }): JSX.Element {
  return (
    <img
      src={figmaLogo}
      alt=""
      width={size}
      height={size}
      className={className}
      draggable={false}
      style={{ display: 'block', objectFit: 'contain', filter: inverted ? 'brightness(0) invert(1)' : undefined }}
    />
  )
}

/** The same paths as 16px SVG strings, for OverlayApp's inline markup. */
function svgString(d: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`
}

export const ICON_SVG: Record<keyof typeof PATHS, string> = {
  close: svgString(PATHS.close),
  chevronDown: svgString(PATHS.chevronDown),
  chevronRight: svgString(PATHS.chevronRight),
  more: svgString(PATHS.more),
  grip: svgString(PATHS.grip),
  check: svgString(PATHS.check)
}
