// Small stroke-style line icons matching the Figma design's thin-line icon
// set. Hand-rolled inline SVG (same convention as WindowControls.tsx) rather
// than an icon library dependency, since none exists in this project.
interface IconProps {
  size?: number
  className?: string
}

// Hidden from assistive tech: every icon here sits inside a control or label
// that carries the words, so an unnamed `img` in the tree is only noise.
function base(size: number): { width: number; height: number; viewBox: string; 'aria-hidden': true } {
  return { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true }
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

// Tracer Voice. Same line weight as the rest of the set.

export function WaveformIcon({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 10v4M8 6.5v11M12 3.5v17M16 7.5v9M20 10v4" strokeLinecap="round" />
    </svg>
  )
}

export function MicIcon({ size = 20, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="9" y="3" width="6" height="11.5" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" strokeLinecap="round" />
    </svg>
  )
}

export function MicOffIcon({ size = 20, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M15 9.4V6a3 3 0 00-5.7-1.3M9 9v2.5a3 3 0 004.6 2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18.5 11a6.5 6.5 0 01-1 3.4M5.5 11a6.5 6.5 0 0010 5.5M12 17.5V21M4 4l16 16" strokeLinecap="round" />
    </svg>
  )
}

/** Hang up: a handset turned down. */
export function PhoneOffIcon({ size = 22, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="currentColor" stroke="currentColor" strokeWidth="1.2">
      <path
        d="M3.2 13.6c4.9-4.4 12.7-4.4 17.6 0 .5.5.5 1.2 0 1.7l-1.9 1.6c-.4.4-1 .4-1.5.1l-2.2-1.4a1.1 1.1 0 01-.5-1v-1.9a12.5 12.5 0 00-5.4 0v1.9c0 .4-.2.8-.5 1l-2.2 1.4c-.5.3-1.1.3-1.5-.1l-1.9-1.6a1.2 1.2 0 010-1.7z"
        strokeLinejoin="round"
      />
    </svg>
  )
}
export { PhoneOffIcon as EndIcon }

export function CaptionsIcon({ size = 20, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M10.5 10.3a2.2 2.2 0 100 3.4M17 10.3a2.2 2.2 0 100 3.4" strokeLinecap="round" />
    </svg>
  )
}

export function PlayIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="currentColor" stroke="none">
      <path d="M8 5.3v13.4a.8.8 0 001.2.7l10.6-6.7a.8.8 0 000-1.4L9.2 4.6A.8.8 0 008 5.3z" />
    </svg>
  )
}

export function PauseIcon({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="currentColor" stroke="none">
      <rect x="6.5" y="5" width="4" height="14" rx="1" />
      <rect x="13.5" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}
