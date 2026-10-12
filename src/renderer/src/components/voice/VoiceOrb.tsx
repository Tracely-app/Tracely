/* Tracer's voice orb: the living sphere at the centre of a voice call.
 *
 * A 2D canvas, drawn every animation frame from three inputs — the call state,
 * the microphone level and the level of the voice speaking back — and the
 * app's accent tokens. The sphere is a lit base gradient with a slow liquid
 * inside it (soft elongated blobs orbiting and turning at different speeds,
 * some laid over normally, some screened on as light), a rim shadow, a faint
 * specular highlight and a halo. States cross-fade over ~250 ms; levels go
 * through a critically damped spring, so speech moves the orb without jitter.
 *
 * Engineering rules this file keeps:
 * - Nothing is allocated per frame. Gradients are built once per theme in a
 *   unit coordinate space and placed with setTransform; the outline is traced
 *   from preallocated tables; the per-state targets are written in place;
 *   style values come from preformatted string tables.
 * - Cheap frames. The inside of the sphere (all soft gradients) is painted
 *   into a buffer and drawn in through a full-resolution clip; if frames run
 *   over budget (a canvas rasterised in software, no GPU) the buffer steps
 *   down in resolution. The halo and the dimming are compositor work (a CSS
 *   layer's transform and opacity, the canvas's opacity), not canvas pixels.
 * - The loop runs only when it has something to show: it stops while the page
 *   is hidden or the orb is scrolled off-screen, and it sleeps once a still
 *   state (idle, ended, error, anything under reduced motion) has settled,
 *   waking on the next prop or theme change.
 * - Reduced motion (the prop, else the OS setting) draws a still orb and shows
 *   the level only as the opacity of a ring around it.
 * The maths is in orbMath.ts (pure, tested); the contract is voice/types.ts.
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { VoiceState } from '../../voice/types'
import {
  BUFFER_QUALITY, CROSSFADE_TAU, ORB_SCALE_MAX, ORB_SCALE_MIN, approachParams, blobBrightness, breath, clamp01,
  createFrameStats, createOrbParams, createQualityMeter, haloStrength, levelCurve, meterFrame, orbPalette, orbScale,
  paramsSettled, recordFrame, resetFrameStats, springSettled, springStep, stateLabel, stateTargets, toRgba,
  type FrameStats, type OrbPalette, type Rgb, type Spring,
} from './orbMath'
import '../../styles/voice-orb.css'

/** Room around the largest swell for the muted and level rings, in CSS pixels. */
const RING_MARGIN = 16
/** The canvas's side in CSS pixels: the sphere at its largest swell plus the rings. */
const canvasCss = (size: number): number => Math.ceil(size * ORB_SCALE_MAX + RING_MARGIN * 2)
/**
 * The dim cross-fade (the canvas's opacity) and the halo (a CSS layer the
 * compositor scales and fades) are set from preformatted strings, quantised
 * finely enough not to show, so a frame allocates nothing.
 */
const OPACITY_STEPS: readonly string[] = Array.from({ length: 101 }, (_, i) => String(i / 100))
/** The halo greys with the sphere (muted, error): CSS grayscale in twentieths. */
const GRAY_STEPS: readonly string[] = Array.from({ length: 21 }, (_, i) => (i === 0 ? 'none' : `grayscale(${i / 20})`))
const SCALE_STEP = 0.002
const SCALE_STEPS: readonly string[] = Array.from({ length: Math.round((ORB_SCALE_MAX - ORB_SCALE_MIN) / SCALE_STEP) + 1 },
  (_, i) => `scale(${(ORB_SCALE_MIN + i * SCALE_STEP).toFixed(3)})`)
const BREATH_PERIOD_SEC = 4
/** Spring speeds for the two levels; the voice is a little quicker, to catch syllables. */
const INPUT_OMEGA = 16
const OUTPUT_OMEGA = 22
const TAU = Math.PI * 2

/** The inner buffer covers the sphere out to this multiple of its radius. */
const INNER_EXTENT = 1.1

/** Points on the outline that ripples while the voice speaks. */
const OUTLINE_POINTS = 48
const OUTLINE_COS = new Float32Array(OUTLINE_POINTS)
const OUTLINE_SIN = new Float32Array(OUTLINE_POINTS)
const OUTLINE_ANGLE = new Float32Array(OUTLINE_POINTS)
for (let k = 0; k < OUTLINE_POINTS; k++) {
  OUTLINE_ANGLE[k] = (k / OUTLINE_POINTS) * TAU
  OUTLINE_COS[k] = Math.cos(OUTLINE_ANGLE[k])
  OUTLINE_SIN[k] = Math.sin(OUTLINE_ANGLE[k])
}

type BlobColor = 'deep' | 'mid' | 'warm' | 'cool' | 'cloud' | 'core'

/** One current of the liquid inside the sphere. Units are the sphere's radius. */
interface BlobSpec {
  color: BlobColor
  /** screened on as light (true) or laid over as colour (false) */
  light: boolean
  /** distance of its centre from the sphere's centre */
  orbit: number
  /** radians per second at flow 1; the sign sets the direction */
  speed: number
  phase: number
  /** radius of the blob */
  size: number
  /** elongation: >1 is a streak rather than a disc */
  stretch: number
  alpha: number
  /** how fast its size breathes on its own */
  pulse: number
}

const BLOBS: readonly BlobSpec[] = [
  { color: 'cool', light: false, orbit: 0.42, speed: 0.4, phase: 0.0, size: 0.86, stretch: 1.3, alpha: 0.42, pulse: 0.31 },
  { color: 'warm', light: false, orbit: 0.44, speed: -0.31, phase: 2.4, size: 0.8, stretch: 1.45, alpha: 0.4, pulse: 0.27 },
  { color: 'mid', light: false, orbit: 0.2, speed: 0.5, phase: 4.2, size: 0.7, stretch: 1.2, alpha: 0.3, pulse: 0.37 },
  { color: 'cloud', light: true, orbit: 0.34, speed: -0.44, phase: 1.1, size: 0.72, stretch: 1.75, alpha: 0.4, pulse: 0.43 },
  { color: 'cloud', light: true, orbit: 0.3, speed: 0.35, phase: 3.6, size: 0.58, stretch: 1.95, alpha: 0.32, pulse: 0.23 },
  { color: 'core', light: true, orbit: 0.14, speed: -0.56, phase: 5.1, size: 0.52, stretch: 1.2, alpha: 0.3, pulse: 0.51 },
]

export interface VoiceOrbProps {
  state: VoiceState
  /** 0..1 smoothed microphone level (VoiceSnapshot.inputLevel) */
  inputLevel: number
  /** 0..1 smoothed level of the voice speaking back (VoiceSnapshot.outputLevel) */
  outputLevel: number
  muted: boolean
  /** diameter in CSS pixels; the halo spills past it without taking layout space */
  size?: number
  /** defaults to the OS setting, prefers-reduced-motion */
  reducedMotion?: boolean
  /** the speaking voice's name for the accessible label ("Linden is speaking"); defaults to "Tracer" */
  label?: string
  /**
   * Hidden from assistive tech: for a page that already says the state in
   * words (the voice view's state line and live region), where the orb's own
   * label would only repeat it — or contradict it a beat later.
   */
  decorative?: boolean
}

/** For diagnostics (the demo page measures frame cost through it). */
export interface VoiceOrbHandle {
  frameStats(): Readonly<FrameStats>
  resetFrameStats(): void
  /** the inner buffer's current fraction of the device resolution (BUFFER_QUALITY) */
  bufferQuality(): number
}

/** Owns the canvas, the observers and the animation loop for one orb. */
class OrbRenderer {
  readonly stats = createFrameStats()
  get bufferQuality(): number {
    return BUFFER_QUALITY[this.quality.level]
  }
  private ctx: CanvasRenderingContext2D | null
  /**
   * The inside of the sphere (all soft gradients), redrawn each frame into this
   * buffer and drawn in through a clip traced at full resolution, so the
   * outline stays crisp whatever the buffer's resolution (BUFFER_QUALITY).
   */
  private readonly inner: HTMLCanvasElement
  private readonly ictx: CanvasRenderingContext2D | null
  private readonly quality = createQualityMeter()
  private opacityStep = -1
  private haloOpacityStep = -1
  private haloScaleStep = -1
  private haloGrayStep = -1
  private size = 168
  private dpr = 1
  private side = 0
  private state: VoiceState = 'idle'
  private muted = false
  private reduced = false
  private inLevel = 0
  private outLevel = 0
  private readonly cur = createOrbParams()
  private readonly target = createOrbParams()
  private readonly inSpring: Spring = { x: 0, v: 0 }
  private readonly outSpring: Spring = { x: 0, v: 0 }
  private flowT = 0
  private realT = 0
  private shimmerT = 0
  private raf = 0
  private last = 0
  private running = false
  private onScreen = true
  private themeDirty = true
  private palette: OrbPalette | null = null
  private gBase: CanvasGradient | null = null
  private gRim: CanvasGradient | null = null
  private gSpec: CanvasGradient | null = null
  private gBounce: CanvasGradient | null = null
  private readonly gBlobs: (CanvasGradient | null)[] = BLOBS.map(() => null)
  private ringStroke = 'rgba(0, 0, 0, 0.6)'
  private levelStroke = 'rgba(249, 115, 22, 1)'
  private readonly radii = new Float32Array(OUTLINE_POINTS)
  private readonly io: IntersectionObserver | null
  private readonly mo: MutationObserver | null
  private readonly schemeQuery: MediaQueryList | null
  private dprQuery: MediaQueryList | null = null

  constructor(private readonly root: HTMLElement, private readonly canvas: HTMLCanvasElement,
    private readonly halo: HTMLElement) {
    this.ctx = canvas.getContext('2d')
    this.inner = document.createElement('canvas')
    this.ictx = this.inner.getContext('2d')
    this.tick = this.tick.bind(this)
    this.onVisibility = this.onVisibility.bind(this)
    this.onThemeChange = this.onThemeChange.bind(this)
    this.onDprChange = this.onDprChange.bind(this)
    this.io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        this.onScreen = entries[entries.length - 1]?.isIntersecting ?? true
        this.wake()
      })
      : null
    this.io?.observe(root)
    this.mo = typeof MutationObserver === 'function' ? new MutationObserver(this.onThemeChange) : null
    this.mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent', 'class', 'style'] })
    this.schemeQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null
    this.schemeQuery?.addEventListener('change', this.onThemeChange)
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  setSize(size: number): void {
    this.size = Number.isFinite(size) && size > 0 ? size : 168
    this.resize()
  }

  setState(state: VoiceState, muted: boolean): void {
    this.state = state
    this.muted = muted
    this.wake()
  }

  setLevels(input: number, output: number): void {
    // Jitter under the noise floor curves to the same target: no reason to wake a sleeping orb.
    const changed = levelCurve(input) !== levelCurve(this.inLevel) || levelCurve(output) !== levelCurve(this.outLevel)
    this.inLevel = input
    this.outLevel = output
    if (changed) this.wake()
  }

  setReduced(reduced: boolean): void {
    this.reduced = reduced
    this.wake()
  }

  /** Jump straight to the current targets, so the first paint is not a fade from nothing. */
  snap(): void {
    stateTargets(this.state, this.muted, this.cur)
    this.inSpring.x = levelCurve(this.inLevel)
    this.outSpring.x = levelCurve(this.outLevel)
    this.inSpring.v = 0
    this.outSpring.v = 0
    this.wake()
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.running = false
    this.io?.disconnect()
    this.mo?.disconnect()
    this.schemeQuery?.removeEventListener('change', this.onThemeChange)
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.ctx = null
    // Let the buffer's backing store go now rather than at garbage collection.
    this.inner.width = this.inner.height = 0
  }

  private resize(): void {
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    const css = canvasCss(this.size)
    const side = Math.round(css * dpr)
    if (this.canvas.width !== side || this.canvas.height !== side) {
      this.canvas.width = side
      this.canvas.height = side
    }
    this.side = side
    this.dpr = side / css
    this.sizeInner()
    // A window dragged to a screen with another pixel ratio changes dpr; listen for the next change.
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    this.dprQuery = window.matchMedia?.(`(resolution: ${dpr}dppx)`) ?? null
    this.dprQuery?.addEventListener('change', this.onDprChange)
    this.wake()
  }

  /** The buffer holds the sphere at its largest swell, out to INNER_EXTENT, at the current quality. */
  private sizeInner(): void {
    const unit = this.size * 0.5 * this.dpr * ORB_SCALE_MAX * BUFFER_QUALITY[this.quality.level]
    const innerSide = Math.max(8, Math.ceil(unit * INNER_EXTENT * 2))
    if (this.inner.width !== innerSide) this.inner.width = this.inner.height = innerSide
  }

  private onVisibility(): void {
    this.wake()
  }

  private onThemeChange(): void {
    this.themeDirty = true
    this.wake()
  }

  private onDprChange(): void {
    this.resize()
  }

  private canRun(): boolean {
    return this.ctx !== null && this.onScreen && !document.hidden
  }

  private wake(): void {
    if (this.running || !this.canRun()) return
    this.running = true
    this.last = 0
    this.raf = requestAnimationFrame(this.tick)
  }

  private tick(now: number): void {
    this.raf = 0
    if (!this.canRun()) {
      this.running = false
      return
    }
    if (this.themeDirty) this.readTheme()
    // A long gap (the loop was asleep, or the frame stalled) counts as one frame, not a jump.
    const dt = this.last > 0 ? Math.min(0.1, Math.max(0, (now - this.last) / 1000)) : 1 / 60
    this.last = now
    this.step(dt)
    const t0 = performance.now()
    this.draw()
    const ms = performance.now() - t0
    recordFrame(this.stats, ms)
    if (meterFrame(this.quality, ms)) this.sizeInner()
    if (this.settled()) {
      this.running = false
      return
    }
    this.raf = requestAnimationFrame(this.tick)
  }

  private step(dt: number): void {
    stateTargets(this.state, this.muted, this.target)
    approachParams(this.cur, this.target, dt, CROSSFADE_TAU)
    springStep(this.inSpring, levelCurve(this.inLevel), INPUT_OMEGA, dt)
    springStep(this.outSpring, levelCurve(this.outLevel), OUTPUT_OMEGA, dt)
    if (this.reduced) return
    this.flowT += dt * this.cur.flow
    this.realT += dt
    this.shimmerT += dt * (0.4 + this.cur.shimmer)
  }

  /** Nothing left to animate: a still state has finished its cross-fade and the levels are at rest. */
  private settled(): boolean {
    const p = this.cur
    const still = this.reduced || (p.flow < 1e-3 && p.breathe < 1e-4 && p.shimmer < 1e-3)
    return still && paramsSettled(p, this.target) &&
      springSettled(this.inSpring, levelCurve(this.inLevel)) && springSettled(this.outSpring, levelCurve(this.outLevel))
  }

  /** Re-read the accent tokens and rebuild every gradient (theme changes only, never per frame). */
  private readTheme(): void {
    this.themeDirty = false
    // Every gradient is painted into the inner buffer, so it is built on that context.
    const ctx = this.ictx
    if (!this.ctx || !ctx) return
    const cs = getComputedStyle(this.root)
    const pal = orbPalette({
      accent: cs.getPropertyValue('--accent'),
      accent2: cs.getPropertyValue('--accent-2'),
      accentGradient: cs.getPropertyValue('--accent-gradient'),
      surface: cs.getPropertyValue('--surface'),
      muted: cs.getPropertyValue('--muted'),
    })
    this.palette = pal
    this.ringStroke = toRgba(pal.ring)
    this.levelStroke = toRgba(pal.halo, 1)

    // Lit from the upper left: pale core → body → shadowed edge.
    const base = ctx.createRadialGradient(-0.34, -0.4, 0.02, 0, 0, 1.04)
    base.addColorStop(0, toRgba(pal.core, 1))
    base.addColorStop(0.38, toRgba(pal.mid, 1))
    base.addColorStop(0.74, toRgba(pal.halo, 1))
    base.addColorStop(1, toRgba(pal.deep, 1))
    this.gBase = base

    for (let i = 0; i < BLOBS.length; i++) this.gBlobs[i] = softDisc(ctx, blobColor(pal, BLOBS[i].color))

    // The edge of a sphere turns away from the light: a darker band gives it volume.
    const rim = ctx.createRadialGradient(0, 0, 0.5, 0, 0, 1)
    const rimMax = pal.dark ? 0.55 : 0.4
    rim.addColorStop(0, toRgba(pal.deep, 0))
    rim.addColorStop(0.7, toRgba(pal.deep, rimMax * 0.12))
    rim.addColorStop(0.9, toRgba(pal.deep, rimMax * 0.5))
    rim.addColorStop(1, toRgba(pal.deep, rimMax))
    this.gRim = rim

    this.gSpec = softDisc(ctx, { r: 255, g: 255, b: 255, a: 1 })
    this.gBounce = softDisc(ctx, pal.cloud)
  }

  private draw(): void {
    const ctx = this.ctx
    const pal = this.palette
    if (!ctx || !pal || !this.gBase || !this.gRim || !this.gSpec) return
    const p = this.cur
    const D = this.side
    const c = D / 2
    const reduced = this.reduced
    const inL = this.inSpring.x
    const outL = this.outSpring.x
    const scale = reduced ? 1 - 0.04 * p.dim : orbScale(p, inL, outL, breath(this.realT, BREATH_PERIOD_SEC))
    const R = this.size * 0.5 * this.dpr * scale

    const ictx = this.ictx
    if (!ictx) return
    // The inside of the sphere, in the buffer's own space: the swell is applied when it is drawn in below.
    const iw = this.inner.width
    ictx.setTransform(1, 0, 0, 1, 0, 0)
    ictx.globalCompositeOperation = 'source-over'
    ictx.globalAlpha = 1
    ictx.clearRect(0, 0, iw, iw)
    this.drawInside(ictx, pal, iw / 2, iw / (2 * INNER_EXTENT), inL, outL)

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, D, D)

    // The halo is a CSS layer: hand the compositor its scale and opacity (only when a step changes).
    const halo = reduced ? haloStrength(p, 0, 0) : haloStrength(p, inL, outL)
    const haloOpacity = Math.round(clamp01(halo * (pal.dark ? 0.8 : 0.45)) * 100)
    if (haloOpacity !== this.haloOpacityStep) {
      this.haloOpacityStep = haloOpacity
      this.halo.style.opacity = OPACITY_STEPS[haloOpacity]
    }
    const haloScale = Math.round((Math.min(ORB_SCALE_MAX, Math.max(ORB_SCALE_MIN, scale)) - ORB_SCALE_MIN) / SCALE_STEP)
    if (haloScale !== this.haloScaleStep) {
      this.haloScaleStep = haloScale
      this.halo.style.transform = SCALE_STEPS[haloScale]
    }
    const haloGray = Math.round(clamp01(p.desat) * 20)
    if (haloGray !== this.haloGrayStep) {
      this.haloGrayStep = haloGray
      this.halo.style.filter = GRAY_STEPS[haloGray]
    }

    const morph = reduced ? 0 : 0.035 * p.outputDrive * clamp01(outL) + 0.008 * p.inputDrive * clamp01(inL)
    this.traceOutline(ctx, c, R, morph)
    ctx.save()
    ctx.clip()
    const e = INNER_EXTENT * R
    ctx.drawImage(this.inner, c - e, c - e, e * 2, e * 2)
    ctx.restore()

    // Dimming fades the whole orb toward whatever is behind it: the canvas's own opacity, which costs no pixels.
    const step = Math.round(clamp01(1 - p.dim * 0.55) * 100)
    if (step !== this.opacityStep) {
      this.opacityStep = step
      this.canvas.style.opacity = OPACITY_STEPS[step]
    }
    if (p.mutedRing > 0.01) {
      this.strokeRing(ctx, c, R + 7 * this.dpr, 1.5 * this.dpr, this.ringStroke, p.mutedRing * 0.9)
    }
    if (reduced) {
      const level = Math.max(p.inputDrive * clamp01(inL), p.outputDrive * clamp01(outL))
      if (level > 0.01) this.strokeRing(ctx, c, R + 12 * this.dpr, 2.5 * this.dpr, this.levelStroke, clamp01(level * 1.15) * 0.9)
    }
    ctx.globalAlpha = 1
  }

  private strokeRing(ctx: CanvasRenderingContext2D, c: number, r: number, width: number, style: string, alpha: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = alpha
    ctx.strokeStyle = style
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.arc(c, c, r, 0, TAU)
    ctx.stroke()
  }

  /** Everything inside the sphere; the caller has clipped to the outline. */
  private drawInside(ctx: CanvasRenderingContext2D, pal: OrbPalette, c: number, R: number, inL: number, outL: number): void {
    const p = this.cur
    const reduced = this.reduced
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.setTransform(R, 0, 0, R, c, c)
    ctx.fillStyle = this.gBase!
    ctx.fillRect(-1.1, -1.1, 2.2, 2.2)

    const bright = reduced ? 1 : blobBrightness(p, inL, outL)
    const wobble = reduced ? 0 : p.outputDrive * clamp01(outL)
    const swell = reduced ? 0 : p.inputDrive * clamp01(inL)
    const ft = this.flowT
    const rt = this.realT
    const lightBoost = pal.dark ? 1 : 1.15
    for (let i = 0; i < BLOBS.length; i++) {
      const g = this.gBlobs[i]
      if (!g) continue
      const b = BLOBS[i]
      const ang = b.phase + b.speed * ft
      const orbit = b.orbit * (1 + 0.18 * Math.sin(ft * 0.7 + b.phase * 1.3))
      const x = Math.cos(ang) * orbit
      const y = Math.sin(ang * 1.13 + 0.4) * orbit * 0.9
      const ripple = wobble * (0.24 * Math.sin(rt * 6.1 + b.phase * 2) + 0.12 * Math.sin(rt * 9.7 + b.phase * 3.1))
      const size = b.size * (1 + 0.08 * Math.sin(ft * b.pulse * 3 + b.phase) + ripple + 0.14 * swell)
      const rot = b.phase * 0.7 + b.speed * 1.6 * ft
      const sx = R * size * b.stretch
      const sy = (R * size) / Math.sqrt(b.stretch)
      const cr = Math.cos(rot)
      const sr = Math.sin(rot)
      ctx.setTransform(cr * sx, sr * sx, -sr * sy, cr * sy, c + x * R, c + y * R)
      ctx.globalCompositeOperation = b.light ? 'screen' : 'source-over'
      ctx.globalAlpha = clamp01(b.alpha * bright * (b.light ? lightBoost : 1))
      ctx.fillStyle = g
      ctx.fillRect(-1, -1, 2, 2)
    }

    if (!reduced && p.shimmer > 0.01 && this.gBounce) {
      // Two soft streaks of light chasing each other round just inside the rim.
      ctx.globalCompositeOperation = 'screen'
      for (let j = 0; j < 2; j++) {
        const a = this.shimmerT * 1.9 + j * Math.PI
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        const sx = R * 0.5
        const sy = R * 0.17
        // long axis along the tangent: rotate by a + 90 degrees
        ctx.setTransform(-sa * sx, ca * sx, -ca * sy, -sa * sy, c + ca * R * 0.7, c + sa * R * 0.7)
        ctx.globalAlpha = p.shimmer * (pal.dark ? 0.6 : 0.75) * (j === 0 ? 1 : 0.55)
        ctx.fillStyle = this.gBounce
        ctx.fillRect(-1, -1, 2, 2)
      }
    }

    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.setTransform(R, 0, 0, R, c, c)
    ctx.fillStyle = this.gRim!
    ctx.fillRect(-1.1, -1.1, 2.2, 2.2)

    this.drawLights(ctx, pal, c, R)
  }

  /** Bounce light along the bottom, the specular highlight, then desaturation for muted/error. */
  private drawLights(ctx: CanvasRenderingContext2D, pal: OrbPalette, c: number, R: number): void {
    const p = this.cur
    ctx.globalCompositeOperation = 'screen'
    if (this.gBounce) {
      ctx.globalAlpha = pal.dark ? 0.32 : 0.22
      ctx.setTransform(R * 0.62, 0, 0, R * 0.3, c + R * 0.08, c + R * 0.8)
      ctx.fillStyle = this.gBounce
      ctx.fillRect(-1, -1, 2, 2)
    }
    // A soft oval, turned to follow the curve of the sphere.
    const rot = -0.62
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    const sx = R * 0.44
    const sy = R * 0.26
    ctx.globalAlpha = pal.dark ? 0.42 : 0.62
    ctx.setTransform(cr * sx, sr * sx, -sr * sy, cr * sy, c - R * 0.36, c - R * 0.44)
    ctx.fillStyle = this.gSpec!
    ctx.fillRect(-1, -1, 2, 2)

    if (p.desat > 0.01) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'saturation'
      ctx.globalAlpha = clamp01(p.desat)
      ctx.fillStyle = '#808080'
      ctx.fillRect(0, 0, this.inner.width, this.inner.height)
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }

  /**
   * The sphere's outline: a circle, or while the voice speaks a smooth closed
   * curve whose radius ripples by up to `morph` of R (quadratic curves through
   * the midpoints of preallocated points).
   */
  private traceOutline(ctx: CanvasRenderingContext2D, c: number, R: number, morph: number): void {
    ctx.beginPath()
    if (morph < 5e-4) {
      ctx.arc(c, c, R, 0, TAU)
      return
    }
    const t = this.realT
    const radii = this.radii
    for (let k = 0; k < OUTLINE_POINTS; k++) {
      const a = OUTLINE_ANGLE[k]
      radii[k] = R * (1 + morph * (0.55 * Math.sin(3 * a + t * 2.3) + 0.3 * Math.sin(5 * a - t * 3.1 + 1.3) +
        0.15 * Math.sin(2 * a + t * 1.7)))
    }
    const n = OUTLINE_POINTS
    let qx = c + radii[0] * OUTLINE_COS[0]
    let qy = c + radii[0] * OUTLINE_SIN[0]
    const px = c + radii[n - 1] * OUTLINE_COS[n - 1]
    const py = c + radii[n - 1] * OUTLINE_SIN[n - 1]
    ctx.moveTo((px + qx) / 2, (py + qy) / 2)
    for (let k = 0; k < n; k++) {
      const j = k + 1 === n ? 0 : k + 1
      const nx = c + radii[j] * OUTLINE_COS[j]
      const ny = c + radii[j] * OUTLINE_SIN[j]
      ctx.quadraticCurveTo(qx, qy, (qx + nx) / 2, (qy + ny) / 2)
      qx = nx
      qy = ny
    }
    ctx.closePath()
  }
}

/** A unit disc of `color` fading out on a near-Gaussian curve: one soft blob of light or colour. */
function softDisc(ctx: CanvasRenderingContext2D, color: Rgb): CanvasGradient {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
  g.addColorStop(0, toRgba(color, 1))
  g.addColorStop(0.25, toRgba(color, 0.82))
  g.addColorStop(0.5, toRgba(color, 0.46))
  g.addColorStop(0.75, toRgba(color, 0.15))
  g.addColorStop(1, toRgba(color, 0))
  return g
}

function blobColor(pal: OrbPalette, name: BlobColor): Rgb {
  return pal[name]
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(REDUCED_MOTION_QUERY).matches),
  )
  useEffect(() => {
    const mql = window.matchMedia?.(REDUCED_MOTION_QUERY)
    if (!mql) return
    const update = (): void => setReduced(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [])
  return reduced
}

const NO_STATS: Readonly<FrameStats> = Object.freeze(createFrameStats())

/**
 * The orb. Purely visual: it reads the call state and the two levels and
 * draws; it never touches the call. role="img" with a label naming the state,
 * unless `decorative`, where the words beside it carry the state instead.
 */
const VoiceOrb = forwardRef<VoiceOrbHandle, VoiceOrbProps>(function VoiceOrb(
  { state, inputLevel, outputLevel, muted, size = 168, reducedMotion, label, decorative = false },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const haloRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<OrbRenderer | null>(null)
  const systemReduced = usePrefersReducedMotion()
  const reduced = reducedMotion ?? systemReduced
  const latest = useRef({ state, muted, inputLevel, outputLevel, size, reduced })
  latest.current = { state, muted, inputLevel, outputLevel, size, reduced }

  useLayoutEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    const halo = haloRef.current
    if (!root || !canvas || !halo) return
    const engine = new OrbRenderer(root, canvas, halo)
    const now = latest.current
    engine.setSize(now.size)
    engine.setReduced(now.reduced)
    engine.setState(now.state, now.muted)
    engine.setLevels(now.inputLevel, now.outputLevel)
    engine.snap()
    engineRef.current = engine
    return () => {
      engine.destroy()
      engineRef.current = null
    }
  }, [])
  useLayoutEffect(() => engineRef.current?.setSize(size), [size])
  useLayoutEffect(() => engineRef.current?.setReduced(reduced), [reduced])
  useLayoutEffect(() => engineRef.current?.setState(state, muted), [state, muted])
  useLayoutEffect(() => engineRef.current?.setLevels(inputLevel, outputLevel), [inputLevel, outputLevel])

  useImperativeHandle(ref, () => ({
    frameStats: () => engineRef.current?.stats ?? NO_STATS,
    resetFrameStats: () => {
      if (engineRef.current) resetFrameStats(engineRef.current.stats)
    },
    bufferQuality: () => engineRef.current?.bufferQuality ?? BUFFER_QUALITY[0],
  }), [])

  const canvasSide = canvasCss(size)
  return (
    <div ref={rootRef} className="voice-orb" role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : stateLabel(state, muted, label)} aria-hidden={decorative || undefined}
      data-state={state} style={{ width: size, height: size }}>
      <div ref={haloRef} className="voice-orb-halo" aria-hidden="true" />
      <canvas ref={canvasRef} className="voice-orb-canvas" aria-hidden="true"
        style={{ width: canvasSide, height: canvasSide }} />
    </div>
  )
})

export default VoiceOrb
