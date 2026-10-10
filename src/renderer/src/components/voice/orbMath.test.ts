import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CROSSFADE_TAU, ORB_SCALE_MAX, ORB_SCALE_MIN, approach, approachParams, blobBrightness, breath, clamp, clamp01,
  createFrameStats, createOrbParams, gradientColors, haloStrength, levelCurve, mixRgb, orbPalette, orbScale,
  paramsSettled, parseColor, recordFrame, relativeLuminance, shiftHue, springSettled, springStep, stateLabel,
  stateTargets, toRgba, type Rgb, type Spring,
} from './orbMath.ts'
import type { VoiceState } from '../../voice/types'

const ALL_STATES: VoiceState[] = ['idle', 'requesting-mic', 'connecting', 'listening', 'user-speaking',
  'assistant-speaking', 'ending', 'ended', 'error']
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps

describe('clamp', () => {
  it('clamps both ends and turns NaN into the floor', () => {
    strictEqual(clamp(5, 0, 1), 1)
    strictEqual(clamp(-5, 0, 1), 0)
    strictEqual(clamp(0.4, 0, 1), 0.4)
    strictEqual(clamp01(Number.NaN), 0)
    strictEqual(clamp01(Number.POSITIVE_INFINITY), 1)
  })
})

describe('springStep (critically damped)', () => {
  it('settles on the target', () => {
    const s: Spring = { x: 0, v: 0 }
    for (let i = 0; i < 120; i++) springStep(s, 1, 18, 1 / 60)
    ok(near(s.x, 1, 1e-4), `x=${s.x}`)
    ok(springSettled(s, 1))
  })

  it('never overshoots from rest, so a level step cannot make the orb tremble', () => {
    const s: Spring = { x: 0, v: 0 }
    let prev = 0
    for (let i = 0; i < 300; i++) {
      springStep(s, 1, 18, 1 / 60)
      ok(s.x <= 1 + 1e-12, `overshot to ${s.x} at frame ${i}`)
      ok(s.x >= prev - 1e-12, `went backwards at frame ${i}`)
      prev = s.x
    }
  })

  it('is frame-rate independent: ten small steps equal one big one', () => {
    const a: Spring = { x: 0.2, v: -0.5 }
    const b: Spring = { x: 0.2, v: -0.5 }
    springStep(a, 0.9, 14, 0.1)
    for (let i = 0; i < 10; i++) springStep(b, 0.9, 14, 0.01)
    ok(near(a.x, b.x, 1e-12) && near(a.v, b.v, 1e-12), `${a.x},${a.v} vs ${b.x},${b.v}`)
  })

  it('stays stable on a very long frame and ignores dt <= 0', () => {
    const s: Spring = { x: 0, v: 0 }
    springStep(s, 1, 18, 5)
    ok(Number.isFinite(s.x) && near(s.x, 1, 1e-9))
    const t: Spring = { x: 0.3, v: 0.1 }
    springStep(t, 1, 18, 0)
    springStep(t, 1, 18, -1)
    deepStrictEqual(t, { x: 0.3, v: 0.1 })
  })
})

describe('cross-fade (approach)', () => {
  it('is ~95% of the way after 250 ms and does not snap on the first frame', () => {
    let x = 0
    for (let t = 0; t < 0.25 - 1e-9; t += 1 / 60) x = approach(x, 1, 1 / 60, CROSSFADE_TAU)
    ok(x > 0.93 && x < 1, `x=${x}`)
    ok(approach(0, 1, 1 / 60, CROSSFADE_TAU) < 0.25)
  })

  it('is frame-rate independent and handles degenerate inputs', () => {
    const one = approach(0, 1, 0.032, CROSSFADE_TAU)
    const two = approach(approach(0, 1, 0.016, CROSSFADE_TAU), 1, 0.016, CROSSFADE_TAU)
    ok(near(one, two, 1e-12))
    strictEqual(approach(0.3, 1, 0.016, 0), 1)
    strictEqual(approach(0.3, 1, 0, CROSSFADE_TAU), 0.3)
  })

  it('approachParams eases every field and paramsSettled sees the end', () => {
    const cur = stateTargets('idle', false, createOrbParams())
    const target = stateTargets('assistant-speaking', false, createOrbParams())
    approachParams(cur, target, 1 / 60, CROSSFADE_TAU)
    ok(cur.outputDrive > 0 && cur.outputDrive < 0.3, 'moved, but not snapped')
    ok(!paramsSettled(cur, target))
    for (let i = 0; i < 120; i++) approachParams(cur, target, 1 / 60, CROSSFADE_TAU)
    ok(paramsSettled(cur, target))
  })
})

describe('breath', () => {
  it('runs 0 → 1 → 0 over the period', () => {
    ok(near(breath(0, 4), 0))
    ok(near(breath(2, 4), 1))
    ok(near(breath(4, 4), 0, 1e-12))
    ok(breath(1, 4) > 0.49 && breath(1, 4) < 0.51)
  })
})

describe('levelCurve', () => {
  it('clamps out-of-range and NaN input', () => {
    strictEqual(levelCurve(-1), 0)
    strictEqual(levelCurve(Number.NaN), 0)
    strictEqual(levelCurve(2), 1)
    strictEqual(levelCurve(1), 1)
  })

  it('gates the noise floor, then rises monotonically and lifts quiet speech', () => {
    strictEqual(levelCurve(0.02), 0)
    let prev = 0
    for (let x = 0.04; x <= 1; x += 0.02) {
      const y = levelCurve(x)
      ok(y > prev, `not monotonic at ${x}`)
      prev = y
    }
    ok(levelCurve(0.25) > 0.25, 'quiet speech is lifted')
  })
})

describe('level → radius and brightness', () => {
  const p = (s: VoiceState, muted = false) => stateTargets(s, muted, createOrbParams())

  it('listening breathes from 1 to 1.03', () => {
    ok(near(orbScale(p('listening'), 0, 0, 0), 1))
    ok(near(orbScale(p('listening'), 0, 0, 1), 1.03))
  })

  it('clamps the radius for any input, even absurd levels', () => {
    for (const s of ALL_STATES) {
      for (const level of [-5, 0, 0.5, 1, 7, Number.NaN]) {
        const k = orbScale(p(s), level, level, 1)
        ok(k >= ORB_SCALE_MIN && k <= ORB_SCALE_MAX, `${s} level ${level} → ${k}`)
      }
    }
    const absurd = { ...p('user-speaking'), inputDrive: 50, outputDrive: 50 }
    strictEqual(orbScale(absurd, 1, 1, 1), ORB_SCALE_MAX)
  })

  it('swells with the mic only while the student speaks, and with the voice only while it speaks', () => {
    ok(orbScale(p('user-speaking'), 1, 0, 0) > orbScale(p('user-speaking'), 0, 0, 0) + 0.08)
    ok(near(orbScale(p('assistant-speaking'), 1, 0, 0), orbScale(p('assistant-speaking'), 0, 0, 0)))
    ok(orbScale(p('assistant-speaking'), 0, 1, 0) > orbScale(p('assistant-speaking'), 0, 0, 0) + 0.05)
    ok(near(orbScale(p('user-speaking', true), 1, 0, 0), orbScale(p('user-speaking', true), 0, 0, 0)), 'muted mic moves nothing')
    ok(orbScale(p('idle'), 0, 0, 0) < 1, 'idle sits slightly smaller')
  })

  it('halo and brightness stay in range and follow the driving level', () => {
    for (const s of ALL_STATES) {
      for (const level of [-1, 0, 1, 9]) {
        const h = haloStrength(p(s), level, level)
        const b = blobBrightness(p(s), level, level)
        ok(h >= 0 && h <= 1, `halo ${s} ${level} → ${h}`)
        ok(b >= 0 && b <= 1.6, `brightness ${s} ${level} → ${b}`)
      }
    }
    ok(haloStrength(p('user-speaking'), 1, 0) > haloStrength(p('user-speaking'), 0, 0))
    ok(blobBrightness(p('assistant-speaking'), 0, 1) > blobBrightness(p('assistant-speaking'), 0, 0))
    ok(haloStrength(p('error'), 0, 0) < haloStrength(p('listening'), 0, 0), 'error is dimmer')
  })
})

describe('stateTargets', () => {
  it('keeps idle, ended and error still and dimmed', () => {
    for (const s of ['idle', 'ended', 'error'] as const) {
      const t = stateTargets(s, false, createOrbParams())
      strictEqual(t.flow, 0, s)
      strictEqual(t.breathe, 0, s)
      strictEqual(t.shimmer, 0, s)
      ok(t.dim > 0, s)
    }
  })

  it('shimmers while setting up and hands each level to its own state', () => {
    ok(stateTargets('connecting', false, createOrbParams()).shimmer > 0.5)
    ok(stateTargets('requesting-mic', false, createOrbParams()).shimmer > 0.5)
    strictEqual(stateTargets('user-speaking', false, createOrbParams()).inputDrive, 1)
    strictEqual(stateTargets('assistant-speaking', false, createOrbParams()).outputDrive, 1)
    strictEqual(stateTargets('assistant-speaking', false, createOrbParams()).inputDrive, 0)
  })

  it('muted desaturates, shows the ring and ignores the mic, in live states only', () => {
    const m = stateTargets('listening', true, createOrbParams())
    strictEqual(m.inputDrive, 0)
    strictEqual(m.mutedRing, 1)
    ok(m.desat >= 0.8)
    strictEqual(stateTargets('ended', true, createOrbParams()).mutedRing, 0)
    strictEqual(stateTargets('assistant-speaking', true, createOrbParams()).outputDrive, 1, 'the voice still moves it')
  })

  it('writes into the object it is given (no allocation per frame)', () => {
    const o = createOrbParams()
    strictEqual(stateTargets('listening', false, o), o)
  })
})

describe('colour', () => {
  it('parses every form the tokens use', () => {
    deepStrictEqual(parseColor('#f97316'), { r: 249, g: 115, b: 22, a: 1 })
    deepStrictEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 })
    deepStrictEqual(parseColor('#00000080'), { r: 0, g: 0, b: 0, a: 128 / 255 })
    deepStrictEqual(parseColor(' rgba(244, 123, 32, 0.07) '), { r: 244, g: 123, b: 32, a: 0.07 })
    deepStrictEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 })
    deepStrictEqual(parseColor('rgb(300, -4, 20)'), { r: 255, g: 0, b: 20, a: 1 })
    strictEqual(parseColor('oklch(0.7 0.1 50)'), null)
    strictEqual(parseColor(''), null)
    strictEqual(parseColor(undefined), null)
    strictEqual(parseColor('#12345'), null)
  })

  it('mixes with a clamped weight, alpha included', () => {
    const a: Rgb = { r: 0, g: 100, b: 200, a: 0 }
    const b: Rgb = { r: 200, g: 100, b: 0, a: 1 }
    deepStrictEqual(mixRgb(a, b, 0), a)
    deepStrictEqual(mixRgb(a, b, 1), b)
    deepStrictEqual(mixRgb(a, b, 0.5), { r: 100, g: 100, b: 100, a: 0.5 })
    deepStrictEqual(mixRgb(a, b, -3), a)
    deepStrictEqual(mixRgb(a, b, 3), b)
  })

  it('formats rgba() with rounded, clamped channels', () => {
    strictEqual(toRgba({ r: 249.6, g: 115.2, b: 22, a: 1 }), 'rgba(250, 115, 22, 1)')
    strictEqual(toRgba({ r: 300, g: -2, b: 0, a: 1 }, 0.12345), 'rgba(255, 0, 0, 0.123)')
  })

  it('measures luminance and rotates hue without touching alpha', () => {
    strictEqual(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 }), 1)
    strictEqual(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 }), 0)
    const c: Rgb = { r: 249, g: 115, b: 22, a: 0.5 }
    const back = shiftHue(c, 360)
    ok(near(back.r, c.r, 1e-6) && near(back.g, c.g, 1e-6) && near(back.b, c.b, 1e-6) && back.a === 0.5)
    const red = shiftHue({ r: 0, g: 255, b: 0, a: 1 }, -120)
    ok(near(red.r, 255, 1e-6) && near(red.g, 0, 1e-6) && near(red.b, 0, 1e-6))
    deepStrictEqual(shiftHue({ r: 128, g: 128, b: 128, a: 1 }, 90), { r: 128, g: 128, b: 128, a: 1 }, 'grey has no hue')
  })

  it('reads the colours out of the --accent-gradient token', () => {
    const stops = gradientColors('linear-gradient(164deg, #f47b20 0%, #f9a050 100%)')
    deepStrictEqual(stops.map((c) => toRgba(c)), ['rgba(244, 123, 32, 1)', 'rgba(249, 160, 80, 1)'])
    deepStrictEqual(gradientColors('none'), [])
  })

  it('builds a palette for both themes from the real tokens', () => {
    const base = { accent: '#f97316', accent2: '#f9a050', accentGradient: 'linear-gradient(164deg, #f47b20 0%, #f9a050 100%)' }
    const light = orbPalette({ ...base, surface: '#ffffff', muted: 'rgba(0, 0, 0, 0.6)' })
    const dark = orbPalette({ ...base, surface: '#17171b', muted: 'rgba(246, 246, 248, 0.66)' })
    strictEqual(light.dark, false)
    strictEqual(dark.dark, true)
    for (const pal of [light, dark]) {
      const L = relativeLuminance
      ok(L(pal.core) > L(pal.mid) && L(pal.mid) > L(pal.deep), 'lit centre > body > shadow')
      ok(L(pal.cloud) > L(pal.mid))
      for (const c of [pal.core, pal.mid, pal.deep, pal.cloud, pal.warm, pal.cool, pal.halo]) {
        for (const ch of [c.r, c.g, c.b]) ok(ch >= 0 && ch <= 255)
      }
    }
    ok(relativeLuminance(dark.deep) < relativeLuminance(light.deep), 'deeper shadows on dark')
    deepStrictEqual(dark.ring, { r: 246, g: 246, b: 248, a: 0.66 })
  })

  it('falls back to the default orange when a token is unreadable', () => {
    const pal = orbPalette({ accent: 'color-mix(in srgb, red, blue)', accent2: '', accentGradient: '', surface: '', muted: '' })
    strictEqual(toRgba(pal.halo), 'rgba(249, 115, 22, 1)')
    strictEqual(pal.dark, false)
  })
})

describe('stateLabel', () => {
  it('names every state in plain words, with the speaking voice', () => {
    strictEqual(stateLabel('listening', false), 'Listening')
    strictEqual(stateLabel('listening', true), 'Muted')
    strictEqual(stateLabel('assistant-speaking', false, 'Linden'), 'Linden is speaking')
    strictEqual(stateLabel('assistant-speaking', false), 'Tracer is speaking')
    strictEqual(stateLabel('ended', true), 'Call ended')
    for (const s of ALL_STATES) ok(stateLabel(s, false).length > 0)
  })
})

describe('frame stats', () => {
  it('counts, sums and keeps the worst frame; ignores garbage', () => {
    const s = createFrameStats()
    recordFrame(s, 1)
    recordFrame(s, 3)
    recordFrame(s, Number.NaN)
    recordFrame(s, 2)
    deepStrictEqual(s, { frames: 3, totalMs: 6, lastMs: 2, maxMs: 3 })
  })
})
