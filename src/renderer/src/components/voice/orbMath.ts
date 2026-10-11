/* Pure helpers behind Tracer's voice orb (VoiceOrb.tsx): smoothing, easing,
 * the level → size/brightness mapping, the motion targets for each call
 * state, and the colour mixing that turns the app's accent tokens into the
 * orb's palette.
 *
 * Nothing here touches the DOM. The per-frame functions write into objects the
 * caller owns and return numbers, so the orb's animation loop allocates
 * nothing; the colour helpers allocate, and run only when the theme changes.
 */
import type { VoiceState } from '../../voice/types'

// ── numbers ──────────────────────────────────────────────────────────────────

/** Clamp to [lo, hi]; NaN becomes lo, so a bad level can never blow up a radius. */
export function clamp(x: number, lo: number, hi: number): number {
  if (!(x >= lo)) return lo
  return x > hi ? hi : x
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Hermite smoothstep of x between e0 and e1. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/**
 * One breath: 0 → 1 → 0 over `periodSec`, eased (a raised cosine), so the orb
 * slows at the top and bottom of each breath instead of bouncing.
 */
export function breath(tSec: number, periodSec: number): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * tSec) / periodSec)
}

// ── smoothing ────────────────────────────────────────────────────────────────

/** Time constant of a state cross-fade: ~95% of the way there after 250 ms. */
export const CROSSFADE_TAU = 0.25 / 3

/**
 * Exponential approach toward `target`, frame-rate independent: two 8 ms steps
 * land exactly where one 16 ms step does.
 */
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (!(tau > 0)) return target
  if (!(dt > 0)) return current
  return target + (current - target) * Math.exp(-dt / tau)
}

export interface Spring {
  /** position */
  x: number
  /** velocity, per second */
  v: number
}

/**
 * Advance a critically damped spring toward `target` by `dt` seconds.
 *
 * This is the exact solution, not an Euler step: it cannot go unstable on a
 * long frame, it is frame-rate independent (ten 1.6 ms steps equal one 16 ms
 * step), and from rest it never overshoots — which is what keeps a jittery mic
 * level from making the orb tremble. `omega` sets the speed: the spring is
 * ~90% settled after 4 / omega seconds.
 */
export function springStep(s: Spring, target: number, omega: number, dt: number): void {
  if (!(dt > 0)) return
  const e = s.x - target
  const k = s.v + omega * e
  const decay = Math.exp(-omega * dt)
  s.x = target + (e + k * dt) * decay
  s.v = (s.v - omega * k * dt) * decay
}

export function springSettled(s: Spring, target: number, eps = 1e-3): boolean {
  return Math.abs(s.x - target) < eps && Math.abs(s.v) < eps * 10
}

// ── levels → size and brightness ─────────────────────────────────────────────

/** Below this a level is room noise, not speech. */
export const LEVEL_FLOOR = 0.03

/**
 * The engine's levels are smoothed 0..1 loudness. Gate the noise floor, then
 * lift quiet speech (gamma < 1) so a soft-spoken student still moves the orb.
 * Out-of-range and NaN input is clamped.
 */
export function levelCurve(level: number): number {
  const x = clamp01(level)
  if (x <= LEVEL_FLOOR) return 0
  return Math.pow((x - LEVEL_FLOOR) / (1 - LEVEL_FLOOR), 0.6)
}

/** The orb never shrinks below this or swells past ORB_SCALE_MAX. */
export const ORB_SCALE_MIN = 0.94
export const ORB_SCALE_MAX = 1.14
/** How far each driver can swell the orb, as a fraction of its radius. */
export const INPUT_SWELL = 0.11
export const OUTPUT_SWELL = 0.07

/**
 * The orb's motion, as numbers that cross-fade between states. Each state sets
 * targets (stateTargets); the orb eases its current values toward them every
 * frame (approachParams), so a state change never snaps.
 */
export interface OrbParams {
  /** speed of the internal liquid flow; 1 = the speaking pace */
  flow: number
  /** breathing amplitude as a fraction of the radius (0.03 = 1 → 1.03) */
  breathe: number
  /** 0..1 rotating sheen while the call sets up */
  shimmer: number
  /** 0..1 how much the microphone level moves the orb */
  inputDrive: number
  /** 0..1 how much the voice speaking back moves the orb */
  outputDrive: number
  /** 0..1 fade toward the background (idle, ended, error) */
  dim: number
  /** 0..1 desaturation (muted, error) */
  desat: number
  /** 0..1 opacity of the thin ring that says the mic is off */
  mutedRing: number
  /** 0..1 resting strength of the halo */
  glow: number
}

export function createOrbParams(): OrbParams {
  return { flow: 0, breathe: 0, shimmer: 0, inputDrive: 0, outputDrive: 0, dim: 0, desat: 0, mutedRing: 0, glow: 0 }
}

function setParams(o: OrbParams, flow: number, breathe: number, shimmer: number, inputDrive: number,
  outputDrive: number, dim: number, desat: number, glow: number): void {
  o.flow = flow
  o.breathe = breathe
  o.shimmer = shimmer
  o.inputDrive = inputDrive
  o.outputDrive = outputDrive
  o.dim = dim
  o.desat = desat
  o.glow = glow
  o.mutedRing = 0
}

/** The states in which the mic is live, so "muted" means something. */
export function isLiveState(state: VoiceState): boolean {
  return state === 'listening' || state === 'user-speaking' || state === 'assistant-speaking' ||
    state === 'connecting' || state === 'requesting-mic'
}

/**
 * Write the motion targets for `state` into `out` and return it (setParams
 * order: flow, breathe, shimmer, input, output, dim, desat, glow).
 * idle / ended            still, slightly dimmed
 * requesting-mic          gentle shimmer rotation + low breathing
 * connecting              the same, a touch livelier
 * listening               slow breathing, 1 → 1.03 every ~4 s; mic nudges it
 * user-speaking           swell and halo follow the mic
 * assistant-speaking      wobble and brightness follow the voice
 * ending                  winding down
 * error                   still, dimmer and greyer than idle
 * Muted (in a live state) drops the mic's influence, desaturates, slows the
 * flow and shows the thin muted ring.
 */
export function stateTargets(state: VoiceState, muted: boolean, out: OrbParams): OrbParams {
  switch (state) {
    case 'requesting-mic': setParams(out, 0.5, 0.012, 0.75, 0, 0, 0.12, 0.1, 0.5); break
    case 'connecting': setParams(out, 0.65, 0.012, 1, 0, 0, 0.06, 0.04, 0.6); break
    case 'listening': setParams(out, 0.4, 0.03, 0, 0.35, 0, 0, 0, 0.75); break
    case 'user-speaking': setParams(out, 0.65, 0.008, 0, 1, 0, 0, 0, 0.85); break
    case 'assistant-speaking': setParams(out, 1, 0.006, 0, 0, 1, 0, 0, 0.9); break
    case 'ending': setParams(out, 0.15, 0, 0, 0, 0, 0.22, 0.15, 0.45); break
    case 'ended': setParams(out, 0, 0, 0, 0, 0, 0.32, 0.14, 0.32); break
    case 'error': setParams(out, 0, 0, 0, 0, 0, 0.42, 0.6, 0.2); break
    case 'idle':
    default: setParams(out, 0, 0, 0, 0, 0, 0.26, 0.08, 0.35); break
  }
  if (muted && isLiveState(state)) {
    out.inputDrive = 0
    out.flow *= 0.5
    out.glow *= 0.6
    out.desat = Math.max(out.desat, 0.92)
    out.dim = Math.max(out.dim, 0.12)
    out.mutedRing = 1
  }
  return out
}

/** Ease every field of `cur` toward `target` (one frame of a cross-fade). */
export function approachParams(cur: OrbParams, target: OrbParams, dt: number, tau: number): void {
  cur.flow = approach(cur.flow, target.flow, dt, tau)
  cur.breathe = approach(cur.breathe, target.breathe, dt, tau)
  cur.shimmer = approach(cur.shimmer, target.shimmer, dt, tau)
  cur.inputDrive = approach(cur.inputDrive, target.inputDrive, dt, tau)
  cur.outputDrive = approach(cur.outputDrive, target.outputDrive, dt, tau)
  cur.dim = approach(cur.dim, target.dim, dt, tau)
  cur.desat = approach(cur.desat, target.desat, dt, tau)
  cur.mutedRing = approach(cur.mutedRing, target.mutedRing, dt, tau)
  cur.glow = approach(cur.glow, target.glow, dt, tau)
}

export function paramsSettled(cur: OrbParams, target: OrbParams, eps = 1e-3): boolean {
  return Math.abs(cur.flow - target.flow) < eps && Math.abs(cur.breathe - target.breathe) < eps * 0.1 &&
    Math.abs(cur.shimmer - target.shimmer) < eps && Math.abs(cur.inputDrive - target.inputDrive) < eps &&
    Math.abs(cur.outputDrive - target.outputDrive) < eps && Math.abs(cur.dim - target.dim) < eps &&
    Math.abs(cur.desat - target.desat) < eps && Math.abs(cur.mutedRing - target.mutedRing) < eps &&
    Math.abs(cur.glow - target.glow) < eps
}

/**
 * Radius multiplier for this frame: breathing (`breathPhase` 0..1 from
 * breath()) plus the swell from each level, weighted by how much the state
 * lets that level drive the orb; a dimmed orb sits slightly smaller. Levels
 * are the already-curved, spring-smoothed values. Clamped.
 */
export function orbScale(p: OrbParams, inLevel: number, outLevel: number, breathPhase: number): number {
  const s = 1 + p.breathe * breathPhase +
    p.inputDrive * INPUT_SWELL * clamp01(inLevel) +
    p.outputDrive * OUTPUT_SWELL * clamp01(outLevel) -
    0.04 * clamp01(p.dim)
  return clamp(s, ORB_SCALE_MIN, ORB_SCALE_MAX)
}

/** Halo strength 0..1: the state's resting glow, lifted by whichever level drives the orb. */
export function haloStrength(p: OrbParams, inLevel: number, outLevel: number): number {
  return clamp01(p.glow * (1 - 0.6 * clamp01(p.dim)) * (1 - 0.6 * clamp01(p.desat)) +
    p.inputDrive * 0.45 * clamp01(inLevel) + p.outputDrive * 0.35 * clamp01(outLevel))
}

/** Multiplier on the liquid's opacity: speech brightens the inside of the orb. */
export function blobBrightness(p: OrbParams, inLevel: number, outLevel: number): number {
  return clamp(1 + 0.2 * p.inputDrive * clamp01(inLevel) + 0.45 * p.outputDrive * clamp01(outLevel), 0, 1.6)
}

// ── colour ───────────────────────────────────────────────────────────────────

/** r, g, b in 0..255; a in 0..1. */
export interface Rgb {
  r: number
  g: number
  b: number
  a: number
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255, a: 1 }
export const BLACK: Rgb = { r: 0, g: 0, b: 0, a: 1 }

function channel(token: string, scale: number): number {
  const t = token.trim()
  if (t.endsWith('%')) return (parseFloat(t) / 100) * scale
  return parseFloat(t)
}

/**
 * Parse the colours the app's tokens use: #rgb, #rgba, #rrggbb, #rrggbbaa,
 * rgb()/rgba() with commas or spaces and an optional "/ alpha". Anything else
 * (a named colour, color-mix(), oklch()) returns null and the caller falls back.
 */
export function parseColor(input: string | null | undefined): Rgb | null {
  const s = (input ?? '').trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s)
  if (!fn) return null
  const slash = fn[1].split('/')
  const parts = slash[0].split(/[\s,]+/).filter(Boolean)
  let alphaToken = slash.length > 1 ? slash[1] : undefined
  if (alphaToken === undefined && parts.length === 4) alphaToken = parts.pop()
  if (parts.length !== 3) return null
  const [r, g, b] = parts.map((p) => channel(p, 255))
  const a = alphaToken === undefined ? 1 : channel(alphaToken, 1)
  if (![r, g, b, a].every(Number.isFinite)) return null
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp01(a) }
}

/** Mix a → b by t (clamped to 0..1), alpha included. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t)
  return { r: lerp(a.r, b.r, k), g: lerp(a.g, b.g, k), b: lerp(a.b, b.b, k), a: lerp(a.a, b.a, k) }
}

/** CSS rgba() string, channels rounded; `alpha` overrides the colour's own. */
export function toRgba(c: Rgb, alpha: number = c.a): string {
  const ch = (x: number): number => Math.round(clamp(x, 0, 255))
  return `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${Math.round(clamp01(alpha) * 1000) / 1000})`
}

/** WCAG relative luminance, 0 (black) .. 1 (white); alpha ignored. */
export function relativeLuminance(c: Rgb): number {
  const lin = (x: number): number => {
    const v = clamp(x, 0, 255) / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** Rotate the hue by `deg` degrees in HSL, keeping saturation and lightness. */
export function shiftHue(c: Rgb, deg: number): Rgb {
  const r = clamp(c.r, 0, 255) / 255, g = clamp(c.g, 0, 255) / 255, b = clamp(c.b, 0, 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { ...c }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = (((h * 60 + deg) % 360) + 360) % 360
  const C = (1 - Math.abs(2 * l - 1)) * s
  const X = C * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - C / 2
  const [r1, g1, b1] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X]
    : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X]
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255, a: c.a }
}

/** The colours inside a CSS gradient string such as the --accent-gradient token, in order. */
export function gradientColors(css: string | null | undefined): Rgb[] {
  const found = (css ?? '').match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? []
  const out: Rgb[] = []
  for (const token of found) {
    const c = parseColor(token)
    if (c) out.push(c)
  }
  return out
}

/** The CSS custom properties the orb reads (getComputedStyle), as raw strings. */
export interface OrbTokens {
  accent: string
  accent2: string
  accentGradient: string
  surface: string
  muted: string
}

/** The orb's colours, derived from the tokens once per theme change. */
export interface OrbPalette {
  /** the surface behind the orb is dark: glow more, blend lighter */
  dark: boolean
  /** lit centre of the sphere */
  core: Rgb
  /** body colour */
  mid: Rgb
  /** shadowed edge and the deep currents of the liquid */
  deep: Rgb
  /** pale streaks of the liquid */
  cloud: Rgb
  /** the accent rotated one way round the hue wheel, for depth */
  warm: Rgb
  /** and the other way, for highlights */
  cool: Rgb
  halo: Rgb
  /** the thin muted ring */
  ring: Rgb
}

const FALLBACK_ACCENT: Rgb = { r: 249, g: 115, b: 22, a: 1 } // #f97316, the default orange

export function orbPalette(t: OrbTokens): OrbPalette {
  const accent = parseColor(t.accent) ?? FALLBACK_ACCENT
  const accent2 = parseColor(t.accent2) ?? mixRgb(accent, WHITE, 0.3)
  const stops = gradientColors(t.accentGradient)
  const g0 = stops[0] ?? accent
  const g1 = stops.length > 1 ? stops[stops.length - 1] : accent2
  const surface = parseColor(t.surface) ?? WHITE
  const dark = relativeLuminance(surface) < 0.25
  const ring = parseColor(t.muted) ?? (dark ? { r: 246, g: 246, b: 248, a: 0.66 } : { r: 0, g: 0, b: 0, a: 0.6 })
  // Shadows are the accent turned toward red and only slightly darkened: a
  // dark orange reads as brown, and a brown orb reads as dirty.
  return {
    dark,
    core: mixRgb(g1, WHITE, dark ? 0.5 : 0.6),
    mid: mixRgb(g0, g1, 0.55),
    deep: shiftHue(mixRgb(g0, BLACK, dark ? 0.16 : 0.08), -14),
    cloud: mixRgb(g1, WHITE, 0.82),
    warm: mixRgb(shiftHue(accent, -18), WHITE, 0.08),
    cool: shiftHue(accent2, 18),
    halo: accent,
    ring,
  }
}

// ── words ────────────────────────────────────────────────────────────────────

/** The orb's accessible name for a state; `name` is the voice speaking back. */
export function stateLabel(state: VoiceState, muted: boolean, name = 'Tracer'): string {
  const mutedLive = muted && isLiveState(state)
  switch (state) {
    case 'requesting-mic': return 'Waiting for microphone access'
    case 'connecting': return 'Connecting'
    case 'listening': return mutedLive ? 'Muted' : 'Listening'
    case 'user-speaking': return mutedLive ? 'Muted' : 'You are speaking'
    case 'assistant-speaking': return mutedLive ? `${name} is speaking, microphone muted` : `${name} is speaking`
    case 'ending': return 'Ending the call'
    case 'ended': return 'Call ended'
    case 'error': return 'Voice unavailable'
    case 'idle':
    default: return 'Ready to talk'
  }
}

// ── frame cost ───────────────────────────────────────────────────────────────

/** What one orb's draw calls cost, measured with performance.now() around each draw. */
export interface FrameStats {
  frames: number
  totalMs: number
  lastMs: number
  maxMs: number
}

export function createFrameStats(): FrameStats {
  return { frames: 0, totalMs: 0, lastMs: 0, maxMs: 0 }
}

export function recordFrame(s: FrameStats, ms: number): void {
  if (!(ms >= 0)) return
  s.frames += 1
  s.totalMs += ms
  s.lastMs = ms
  if (ms > s.maxMs) s.maxMs = ms
}

export function resetFrameStats(s: FrameStats): void {
  s.frames = 0
  s.totalMs = 0
  s.lastMs = 0
  s.maxMs = 0
}

// ---------------------------------------------------------------------------
// Adaptive quality

/**
 * The inside of the sphere is drawn into a buffer at one of these fractions of
 * the device resolution, best first. Full resolution is the look. The steps
 * down exist for machines where the canvas is rasterised in software (no GPU):
 * there a frame costs roughly buffer rows × layers, and a smaller buffer
 * trades a little softness (upscaled gradients band faintly) for a cheaper
 * frame. On a GPU canvas the draw call only records commands and never steps.
 */
export const BUFFER_QUALITY: readonly number[] = [1, 0.6, 0.42, 0.3]
/** Main-thread draw budget per frame, in ms; a window averaging more steps the buffer down. */
export const DRAW_BUDGET_MS = 2
/** Frames per measuring window. */
export const QUALITY_WINDOW = 40

export interface QualityMeter {
  /** index into BUFFER_QUALITY */
  level: number
  frames: number
  totalMs: number
}

export function createQualityMeter(): QualityMeter {
  return { level: 0, frames: 0, totalMs: 0 }
}

/**
 * Count one frame's draw time. Each full window that averages over the budget
 * steps one level down (never back up: a slow machine stays slow). One stalled
 * frame counts at most four budgets, so a hiccup alone cannot step it.
 * Returns true when the level changed, so the caller resizes its buffer.
 */
export function meterFrame(q: QualityMeter, ms: number): boolean {
  if (!(ms >= 0)) return false
  q.frames += 1
  q.totalMs += Math.min(ms, DRAW_BUDGET_MS * 4)
  if (q.frames < QUALITY_WINDOW) return false
  const avg = q.totalMs / q.frames
  q.frames = 0
  q.totalMs = 0
  if (avg <= DRAW_BUDGET_MS || q.level >= BUFFER_QUALITY.length - 1) return false
  q.level += 1
  return true
}
