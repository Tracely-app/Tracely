// Small stroke-style line icons matching the Figma design's thin-line icon
// set. Hand-rolled inline SVG (same convention as WindowControls.tsx) rather
// than an icon library dependency, since none exists in this project.
interface IconProps {
  size?: number
  className?: string
}

function base(size: number): { width: number; height: number; viewBox: string } {
  return { width: size, height: size, viewBox: '0 0 24 24' }
}

export function UserIcon({ size = 15, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" strokeLinecap="round" />
    </svg>
  )
}




export function SunIcon({ size = 15, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}



export function SignOutIcon({ size = 15, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 20H5.5A1.5 1.5 0 014 18.5v-13A1.5 1.5 0 015.5 4H9" strokeLinecap="round" />
      <path d="M13 16l4-4-4-4M17 12H9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function BackIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function CloseIcon({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  )
}


export function PlusIcon({ size = 20, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" strokeLinecap="round" />
    </svg>
  )
}


export function DocumentIcon({ size = 22, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M7 3.5h7l4 4V20a1 1 0 01-1 1H7a1 1 0 01-1-1V4.5a1 1 0 011-1z" strokeLinejoin="round" />
      <path d="M14 3.5V8h4" strokeLinejoin="round" />
    </svg>
  )
}


export function SlidersIcon({ size = 15, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 7h14M5 12h14M5 17h14" strokeLinecap="round" />
      <circle cx="9" cy="7" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="10" cy="17" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}




export function ShieldIcon({ size = 15, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5V6l7-3z" strokeLinejoin="round" />
    </svg>
  )
}

/** "Never flag this": the struck-through eye beside Dismiss, as the extension's cards have it. */
export function EyeOffIcon({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 12s3.3-6 9-6 9 6 9 6-3.3 6-9 6-9-6-9-6z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M4 4l16 16" strokeLinecap="round" />
    </svg>
  )
}
