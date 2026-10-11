import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  CAPTION_PAUSE_MS, EMPTY_CAPTIONS, ICE_GATHER_TIMEOUT_MS, MOCK_CONNECT_MS, PREVIEW_VOICE_EVENT, TICK_MS,
  addTranscriptDelta, browserDeps, closedError, createSpeechGate, createVoiceSession, formatClock, micError, mockFrame,
  mockScript, rmsToLevel, settleCaptions, smoothLevel, startError, transcriptTurns, voiceStateLine,
  type VoiceApi, type VoiceDeps,
} from './session.ts'
import type { VoiceSnapshot } from './types'

// ── Fakes ──────────────────────────────────────────────────────────────────

/** A clock whose timers run only when the test advances it. */
function fakeClock() {
  let now = 1000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>()
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => (timers.set(++seq, { at: now + ms, fn, every: null }), seq),
    setInterval: (fn: () => void, ms: number) => (timers.set(++seq, { at: now + ms, fn, every: ms }), seq),
    clear: (h: unknown) => void timers.delete(h as number),
    pending: () => timers.size,
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        let next: [number, { at: number; fn: () => void; every: number | null }] | null = null
        for (const entry of timers) if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry
        if (!next) break
        const [id, t] = next
        now = t.at
        if (t.every === null) timers.delete(id)
        else t.at += t.every
        t.fn()
      }
      now = until
    }
  }
}

type FakeTrack = MediaStreamTrack & { stopped: boolean }
function fakeStream(): MediaStream & { track: FakeTrack } {
  const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true } } as unknown as FakeTrack
  return { track, getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream & { track: FakeTrack }
}

class FakeChannel {
  readyState = 'open'
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  label: string
  constructor(label: string) { this.label = label }
  close() { this.closed = true }
  emit(event: object) { this.onmessage?.({ data: JSON.stringify(event) }) }
}

class FakePeer {
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription: { sdp: string } | null = null
  remote: { type: string; sdp: string } | null = null
  onicegatheringstatechange: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((ev: { streams: readonly MediaStream[]; track: MediaStreamTrack }) => void) | null = null
  log: string[] = []
  channel: FakeChannel | null = null
  closed = false
  addTrack() { this.log.push('addTrack') }
  createDataChannel(label: string) { this.log.push(`channel:${label}`); this.channel = new FakeChannel(label); return this.channel }
  async createOffer() { this.log.push('offer'); return { type: 'offer', sdp: 'v=0 offer' } }
  async setLocalDescription(d: { sdp?: string }) { this.localDescription = { sdp: `${d.sdp} +candidates` } }
  async setRemoteDescription(d: { type: string; sdp: string }) { this.remote = d }
  close() { this.closed = true }
  setState(s: string) { this.connectionState = s; this.onconnectionstatechange?.() }
}

interface ApiCalls { ensureMic: number; start: { sdp: string; voiceId: string }[]; end: string[]; save: unknown[][] }

function fakeApi(over: Partial<VoiceApi> = {}): VoiceApi & { calls: ApiCalls } {
  const calls: ApiCalls = { ensureMic: 0, start: [], end: [], save: [] }
  return {
    calls,
    ensureMic: async () => { calls.ensureMic++; return { status: 'granted' } },
    start: async (req) => {
      calls.start.push(req)
      return { sdp: 'v=0 answer', sessionId: 'sess_1', voice: { id: req.voiceId, name: 'Atlas' }, maxSeconds: 900, remainingSeconds: 1800 }
    },
    end: async (id) => { calls.end.push(id); return { seconds: 12 } },
    saveTranscript: async (turns, conversationId) => { calls.save.push([turns, conversationId]); return { saved: true } },
    ...over
  }
}

/** A whole rig: engine + fakes. `rms` sets what the meters read. */
function rig(opts: { api?: VoiceApi & { calls: ApiCalls }; deps?: Partial<VoiceDeps>; save?: boolean } = {}) {
  const clock = fakeClock()
  const api = opts.api ?? fakeApi()
  const mic = fakeStream()
  const peer = new FakePeer()
  const rms = { input: 0, output: 0 }
  const played: MediaStream[] = []
  const preview = new EventTarget()
  let unload: (() => void) | null = null
  let metered = 0
  const deps: VoiceDeps = {
    getUserMedia: async () => mic,
    createPeer: () => peer as never,
    createMeter: () => { const which = metered++ === 0 ? 'input' : 'output'; return { rms: () => rms[which], dispose() {} } },
    createSpeaker: () => ({ play: (s) => void played.push(s), stop() {} }),
    now: clock.now,
    setTimeout: clock.setTimeout, clearTimeout: clock.clear, setInterval: clock.setInterval, clearInterval: clock.clear,
    platform: 'mac',
    previewEvents: preview,
    onUnload: (fn) => { unload = fn; return () => { unload = null } },
    ...opts.deps
  }
  const engine = createVoiceSession({ voiceId: 'atlas', api, deps, shouldSaveTranscript: () => opts.save ?? true, conversationId: () => 'conv_1' })
  const states: string[] = []
  engine.subscribe((s) => { if (states[states.length - 1] !== s.state) states.push(s.state) })
  return { engine, api, clock, mic, peer, rms, played, preview, states, unload: () => unload?.() }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
}

async function connected(opts: Parameters<typeof rig>[0] = {}) {
  const r = rig(opts)
  await r.engine.start()
  r.peer.channel!.emit({ type: 'session.started' })
  return r
}

// ── The happy path ─────────────────────────────────────────────────────────

describe('createVoiceSession: a call', () => {
  it('asks for the mic, builds the peer with the channel before the offer, and connects on session.started', async () => {
    const r = rig()
    strictEqual(r.engine.getSnapshot().state, 'idle')
    await r.engine.start()
    strictEqual(r.api.calls.ensureMic, 1)
    deepStrictEqual(r.peer.log, ['addTrack', 'channel:oai-events', 'offer'])
    deepStrictEqual(r.api.calls.start, [{ sdp: 'v=0 offer +candidates', voiceId: 'atlas' }])
    deepStrictEqual(r.peer.remote, { type: 'answer', sdp: 'v=0 answer' })
    strictEqual(r.engine.getSnapshot().state, 'connecting')
    strictEqual(r.engine.getSnapshot().maxSec, 900)
    strictEqual(r.engine.getSnapshot().remainingTodaySec, 1800)
    r.peer.channel!.emit({ type: 'session.started' })
    deepStrictEqual(r.states, ['requesting-mic', 'connecting', 'listening'])
    r.clock.advance(3200)
    strictEqual(r.engine.getSnapshot().elapsedSec, 3)
    strictEqual(r.engine.getSnapshot().mock, false)
  })

  it("plays Tracer's voice from the remote track", async () => {
    const r = await connected()
    const remote = fakeStream()
    r.peer.ontrack!({ streams: [remote], track: remote.track })
    deepStrictEqual(r.played, [remote])
  })

  it('sends the offer with what ICE gathered after 3 s when gathering never completes', async () => {
    const r = rig()
    r.peer.iceGatheringState = 'gathering'
    void r.engine.start()
    await flush()
    strictEqual(r.api.calls.start.length, 0)
    r.clock.advance(ICE_GATHER_TIMEOUT_MS)
    await flush()
    strictEqual(r.api.calls.start.length, 1)
  })

  it('stops waiting for ICE as soon as gathering completes', async () => {
    const r = rig()
    r.peer.iceGatheringState = 'gathering'
    void r.engine.start()
    await flush()
    r.peer.iceGatheringState = 'complete'
    r.peer.onicegatheringstatechange!()
    await flush()
    strictEqual(r.api.calls.start.length, 1)
  })

  it("fails as a network error when session.started never comes", async () => {
    const r = rig()
    await r.engine.start()
    r.clock.advance(15000)
    await flush()
    strictEqual(r.engine.getSnapshot().state, 'error')
    strictEqual(r.engine.getSnapshot().error?.kind, 'network')
    deepStrictEqual(r.api.calls.end, ['sess_1'])
  })
})

// ── Failures before the call ───────────────────────────────────────────────

describe('createVoiceSession: the microphone', () => {
  it('stops at a denied OS permission with where to turn it on, before opening the mic or the server', async () => {
    let opened = 0
    const api = fakeApi({ ensureMic: async () => ({ status: 'denied' }) })
    const r = rig({ api, deps: { getUserMedia: async () => { opened++; return fakeStream() } } })
    await r.engine.start()
    const s = r.engine.getSnapshot()
    strictEqual(s.state, 'error')
    strictEqual(s.error?.kind, 'mic-denied')
    ok(s.error?.message.includes('System Settings'), s.error?.message)
    strictEqual(opened, 0)
    strictEqual(api.calls.start.length, 0)
  })

  it('treats restricted like denied, and an IPC failure as unknown (getUserMedia decides)', async () => {
    const restricted = rig({ api: fakeApi({ ensureMic: async () => ({ status: 'restricted' }) }) })
    await restricted.engine.start()
    strictEqual(restricted.engine.getSnapshot().error?.kind, 'mic-denied')
    const broken = rig({ api: fakeApi({ ensureMic: async () => { throw new Error('ipc') } }) })
    await broken.engine.start()
    strictEqual(broken.engine.getSnapshot().state, 'connecting')
  })

  it("maps getUserMedia's refusals: NotAllowed → mic-denied (Windows wording), NotFound → mic-missing", async () => {
    const denied = rig({ deps: { platform: 'windows', getUserMedia: async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }) } } })
    await denied.engine.start()
    strictEqual(denied.engine.getSnapshot().error?.kind, 'mic-denied')
    ok(denied.engine.getSnapshot().error?.message.includes('Windows Settings'))
    const missing = rig({ deps: { getUserMedia: async () => { throw Object.assign(new Error('x'), { name: 'NotFoundError' }) } } })
    await missing.engine.start()
    strictEqual(missing.engine.getSnapshot().error?.kind, 'mic-missing')
    strictEqual(missing.api.calls.start.length, 0)
  })

  it('micError: a mic held by another app says so', () => {
    const e = micError({ name: 'NotReadableError' }, 'mac')
    strictEqual(e.kind, 'mic-missing')
    ok(e.message.includes('another app'))
  })
})

describe('createVoiceSession: server refusals', () => {
  const cases: [string, string][] = [['plan', 'Pro'], ['daily-limit', 'tomorrow'], ['busy', 'Another voice call'], ['network', 'internet']]
  for (const [kind, words] of cases) {
    it(`a VoiceApiError of kind ${kind} becomes that error, in plain words, and frees the mic and peer`, async () => {
      const api = fakeApi({ start: async () => { throw Object.assign(new Error('[voice] raw'), { kind }) } })
      const r = rig({ api })
      await r.engine.start()
      const s = r.engine.getSnapshot()
      strictEqual(s.state, 'error')
      strictEqual(s.error?.kind, kind)
      ok(s.error?.message.includes(words), s.error?.message)
      ok(r.mic.track.stopped)
      ok(r.peer.closed)
      deepStrictEqual(api.calls.end, [])
    })
  }

  it("anything else is a server error that keeps main's message", () => {
    deepStrictEqual(startError(Object.assign(new Error("Voice isn't available in this build."), { kind: 'server' })), {
      kind: 'server', message: "Voice isn't available in this build."
    })
    strictEqual(startError(new Error('')).kind, 'server')
    ok(startError(undefined).message.length > 0)
  })

  it('a broken peer (createOffer throws) is a server error, not an unhandled rejection', async () => {
    const r = rig()
    r.peer.createOffer = async () => { throw new Error('no codecs') }
    await r.engine.start()
    strictEqual(r.engine.getSnapshot().error?.kind, 'server')
    ok(r.mic.track.stopped)
  })
})

// ── Captions ───────────────────────────────────────────────────────────────

describe('captions', () => {
  it("merges one speaker's deltas into one open caption", () => {
    let log = addTranscriptDelta(EMPTY_CAPTIONS, 'assistant', 'What is', 5000)
    log = addTranscriptDelta(log, 'assistant', ' your claim?', 5300)
    deepStrictEqual(log.captions, [{ id: 'c1', role: 'assistant', text: 'What is your claim?', final: false }])
  })

  it('finalizes on a speaker switch', () => {
    let log = addTranscriptDelta(EMPTY_CAPTIONS, 'assistant', 'Read it to me.', 5000)
    log = addTranscriptDelta(log, 'user', ' Okay so', 5400)
    deepStrictEqual(log.captions.map((c) => [c.role, c.text, c.final]), [['assistant', 'Read it to me.', true], ['user', 'Okay so', false]])
  })

  it('starts a new caption after a pause over 1.2 s, by the clock or by the session timeline', () => {
    let log = addTranscriptDelta(EMPTY_CAPTIONS, 'user', 'First thought.', 5000)
    log = addTranscriptDelta(log, 'user', ' Second.', 5000 + CAPTION_PAUSE_MS + 1)
    strictEqual(log.captions.length, 2)
    ok(log.captions[0].final)
    let timed = addTranscriptDelta(EMPTY_CAPTIONS, 'user', 'One', 5000, 1000, 1200)
    timed = addTranscriptDelta(timed, 'user', ' two', 5100, 1300, 1500)
    timed = addTranscriptDelta(timed, 'user', ' later', 5200, 3000, 3200)
    deepStrictEqual(timed.captions.map((c) => c.text), ['One two', 'later'])
  })

  it('settleCaptions closes the open caption after the pause, and only then', () => {
    const log = addTranscriptDelta(EMPTY_CAPTIONS, 'assistant', 'Hm.', 5000)
    strictEqual(settleCaptions(log, 5000 + CAPTION_PAUSE_MS), log)
    ok(settleCaptions(log, 5000 + CAPTION_PAUSE_MS + 1).captions[0].final)
  })

  it('transcriptTurns trims and drops empty captions', () => {
    deepStrictEqual(transcriptTurns([
      { id: 'a', role: 'user', text: '  Hi there ', final: true },
      { id: 'b', role: 'assistant', text: '   ', final: true },
      { id: 'c', role: 'assistant', text: 'Hello.', final: false }
    ]), [{ role: 'user', text: 'Hi there' }, { role: 'assistant', text: 'Hello.' }])
  })

  it('the engine shows transcript deltas from the data channel as captions', async () => {
    const r = await connected()
    r.peer.channel!.emit({ type: 'session.output_transcript.delta', delta: 'What would a', start_ms: 100, end_ms: 400 })
    r.peer.channel!.emit({ type: 'session.output_transcript.delta', delta: ' skeptic ask?', start_ms: 400, end_ms: 900 })
    r.peer.channel!.emit({ type: 'session.input_transcript.delta', delta: 'Whether it', start_ms: 1500, end_ms: 1800 })
    deepStrictEqual(r.engine.getSnapshot().captions.map((c) => [c.role, c.text, c.final]), [
      ['assistant', 'What would a skeptic ask?', true],
      ['user', 'Whether it', false]
    ])
    r.peer.channel!.emit({ type: 'session.output_transcript.delta', delta: 42 })
    r.peer.channel!.onmessage!({ data: 'not json' })
    strictEqual(r.engine.getSnapshot().captions.length, 2)
  })
})

// ── Ending ─────────────────────────────────────────────────────────────────

describe('end()', () => {
  it('is idempotent: media stops, the server is told once, the transcript is saved once', async () => {
    const r = await connected()
    r.peer.channel!.emit({ type: 'session.output_transcript.delta', delta: 'Read me the sentence.' })
    r.peer.channel!.emit({ type: 'session.input_transcript.delta', delta: 'Okay.' })
    r.clock.advance(65_000)
    await Promise.all([r.engine.end(), r.engine.end()])
    await r.engine.end()
    deepStrictEqual(r.api.calls.end, ['sess_1'])
    deepStrictEqual(r.api.calls.save, [[[{ role: 'assistant', text: 'Read me the sentence.' }, { role: 'user', text: 'Okay.' }], 'conv_1']])
    ok(r.mic.track.stopped)
    ok(r.peer.closed)
    ok(r.peer.channel!.closed)
    strictEqual(r.engine.getSnapshot().state, 'ended')
    ok(r.engine.getSnapshot().captions.every((c) => c.final))
    // serverSeconds (finding 28) is the server's metered answer to voice:end.
    deepStrictEqual(r.engine.result(), { seconds: 65, transcriptSaved: true, serverSeconds: 12 })
    deepStrictEqual(await r.engine.settled(), { seconds: 65, transcriptSaved: true, serverSeconds: 12 })
    deepStrictEqual(r.states.slice(-2), ['ending', 'ended'])
    strictEqual(r.clock.pending(), 0)
  })

  it("saves the transcript in the same tick as the hang-up, without waiting for the server's answer", async () => {
    let answerEnd!: (v: { seconds: number }) => void
    const api = fakeApi({ end: () => new Promise((res) => { answerEnd = res }) })
    const r = await connected({ api })
    r.peer.channel!.emit({ type: 'session.input_transcript.delta', delta: 'Keep this.' })
    const ending = r.engine.end()
    strictEqual(api.calls.save.length, 1)
    answerEnd({ seconds: 30 })
    await ending
    deepStrictEqual(r.engine.result(), { seconds: 0, transcriptSaved: true, serverSeconds: 30 })
    const failing = await connected({ api: fakeApi({ end: async () => { throw new Error('offline') } }) })
    await failing.engine.end()
    strictEqual(failing.engine.result()?.serverSeconds, null)
  })

  it("doesn't save when saving transcripts is off, or when nothing was said", async () => {
    const off = await connected({ save: false })
    off.peer.channel!.emit({ type: 'session.input_transcript.delta', delta: 'Hello?' })
    await off.engine.end()
    deepStrictEqual(off.api.calls.save, [])
    strictEqual(off.engine.result()?.transcriptSaved, null)
    const quiet = await connected()
    await quiet.engine.end()
    deepStrictEqual(quiet.api.calls.save, [])
  })

  it("a failing voice:end or save doesn't stop the call from ending", async () => {
    const api = fakeApi({ end: async () => { throw new Error('503') }, saveTranscript: async () => { throw new Error('db') } })
    const r = await connected({ api })
    r.peer.channel!.emit({ type: 'session.input_transcript.delta', delta: 'Hi' })
    await r.engine.end()
    strictEqual(r.engine.getSnapshot().state, 'ended')
    strictEqual(r.engine.result()?.transcriptSaved, false)
  })

  it('ending while the server is still answering hangs up the session it opens', async () => {
    let answer!: (v: Awaited<ReturnType<VoiceApi['start']>>) => void
    const api = fakeApi({ start: () => new Promise((res) => { answer = res }) })
    const r = rig({ api })
    const starting = r.engine.start()
    await flush()
    await r.engine.end()
    strictEqual(r.engine.getSnapshot().state, 'ended')
    ok(r.mic.track.stopped)
    answer({ sdp: 'v=0', sessionId: 'sess_late', voice: { id: 'atlas', name: 'Atlas' }, maxSeconds: 900, remainingSeconds: 1800 })
    await starting
    deepStrictEqual(api.calls.end, ['sess_late'])
    strictEqual(r.peer.remote, null)
  })

  it('end() before start() does nothing; start() after the end does nothing', async () => {
    const r = rig()
    await r.engine.end()
    strictEqual(r.engine.getSnapshot().state, 'idle')
    const c = await connected()
    await c.engine.end()
    await c.engine.start()
    strictEqual(c.api.calls.start.length, 1)
    strictEqual(c.engine.getSnapshot().state, 'ended')
  })

  it('a disposed engine never starts', async () => {
    const r = rig()
    r.engine.dispose()
    await r.engine.start()
    strictEqual(r.api.calls.ensureMic, 0)
    strictEqual(r.engine.getSnapshot().state, 'idle')
  })

  it('the window closing and dispose() both hang up an open call', async () => {
    const a = await connected()
    a.unload()
    await flush()
    deepStrictEqual(a.api.calls.end, ['sess_1'])
    const b = await connected()
    b.engine.dispose()
    await flush()
    deepStrictEqual(b.api.calls.end, ['sess_1'])
    ok(b.mic.track.stopped)
  })
})

describe('browserDeps().onUnload', () => {
  it("hangs up on pagehide and on main's hang-up (the window closed to the tray), and unsubscribes both", () => {
    const g = globalThis as { window?: unknown }
    const had = 'window' in g
    const prev = g.window
    const win = new EventTarget() as EventTarget & { tracely?: unknown }
    let hangUp: (() => void) | null = null
    win.tracely = { voice: { onHangUp: (cb: () => void) => { hangUp = cb; return () => { hangUp = null } } } }
    g.window = win
    try {
      let calls = 0
      const off = browserDeps().onUnload(() => { calls++ })
      win.dispatchEvent(new Event('pagehide'))
      hangUp!()
      strictEqual(calls, 2)
      off()
      strictEqual(hangUp, null)
      win.dispatchEvent(new Event('pagehide'))
      strictEqual(calls, 2)
      // No desktop bridge (web, preview): pagehide alone, no throw.
      win.tracely = undefined
      browserDeps().onUnload(() => { calls++ })()
    } finally {
      if (had) g.window = prev
      else delete g.window
    }
  })
})

// ── How a call ends when the student didn't end it ─────────────────────────

describe('createVoiceSession: unasked endings', () => {
  it("the server's close at the cap is 'ended-by-limit', and the transcript is still saved", async () => {
    const r = await connected()
    r.peer.channel!.emit({ type: 'session.input_transcript.delta', delta: 'One more thing' })
    r.peer.channel!.emit({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 900 } })
    await flush()
    const s = r.engine.getSnapshot()
    strictEqual(s.state, 'error')
    strictEqual(s.error?.kind, 'ended-by-limit')
    ok(s.error?.message.includes('15-minute'), s.error?.message)
    strictEqual(r.api.calls.save.length, 1)
    deepStrictEqual(r.api.calls.end, ['sess_1'])
  })

  it("a call that ends in an error still settles with its result for a subscriber like useVoiceSession's", async () => {
    const r = rig()
    // Subscribed before the call, exactly as the hook does: on an end state, read settled().
    const seen: unknown[] = []
    r.engine.subscribe((s) => {
      if (s.state === 'ended' || s.state === 'error') void r.engine.settled().then((res) => seen.push(res))
    })
    await r.engine.start()
    r.peer.channel!.emit({ type: 'session.started' })
    r.peer.channel!.emit({ type: 'session.input_transcript.delta', delta: 'One more thing' })
    r.peer.channel!.emit({ type: 'session.closed', reason: 'close_requested' })
    await flush()
    ok(seen.length > 0)
    for (const res of seen) deepStrictEqual(res, { seconds: 0, transcriptSaved: true, serverSeconds: 12 })
  })

  it('closedError: the daily allowance, a safety filter, a dropped line', () => {
    ok(closedError('expired', 600, 600).message.includes("today's voice minutes"))
    // Behaviour change (finding 4): a safety stop was a generic 'server' error
    // ("Something went wrong"); it is its own kind with supportive words now.
    deepStrictEqual(closedError('content', 900, 1800), {
      kind: 'safety',
      message: 'This call was stopped by an automatic safety check. If something is worrying you, please talk to a trusted adult. In the US you can call or text 988 any time; elsewhere, contact your local emergency number.'
    })
    strictEqual(voiceStateLine({ state: 'error', muted: false, error: closedError('content', 900, 1800) }, 'Atlas'), 'Call ended')
    strictEqual(closedError('connection_lost', 900, 1800).kind, 'network')
    strictEqual(closedError('remote_hangup', 900, null).kind, 'network')
  })

  it("a safety stop shows the supportive notice and doesn't save the transcript", async () => {
    const r = await connected()
    r.peer.channel!.emit({ type: 'session.input_transcript.delta', delta: 'Something worrying' })
    r.peer.channel!.emit({ type: 'session.closed', reason: 'content' })
    await flush()
    strictEqual(r.engine.getSnapshot().error?.kind, 'safety')
    ok(r.engine.getSnapshot().error?.message.includes('988'))
    deepStrictEqual(r.api.calls.save, [])
    deepStrictEqual(r.api.calls.end, ['sess_1'])
    strictEqual((await r.engine.settled())?.transcriptSaved, null)
  })

  it('a failed peer ends the call as a dropped line; a brief disconnect that recovers does not', async () => {
    const r = await connected()
    r.peer.setState('disconnected')
    r.clock.advance(2000)
    r.peer.setState('connected')
    r.clock.advance(5000)
    strictEqual(r.engine.getSnapshot().state, 'listening')
    r.peer.setState('failed')
    await flush()
    strictEqual(r.engine.getSnapshot().error?.kind, 'network')
  })

  it('a disconnect that lasts 4 s is a dropped line', async () => {
    const r = await connected()
    r.peer.setState('disconnected')
    r.clock.advance(4000)
    await flush()
    strictEqual(r.engine.getSnapshot().error?.kind, 'network')
  })

  it('an error event alone does not end the call (some only cut Tracer off)', async () => {
    const r = await connected()
    r.peer.channel!.emit({ type: 'error', error: { type: 'invalid_request_error', message: 'moderation' } })
    r.clock.advance(1000)
    strictEqual(r.engine.getSnapshot().state, 'listening')
    strictEqual(r.engine.getSnapshot().error, null)
  })

  it('hangs up by itself if the cap passes and no close arrives', async () => {
    const api = fakeApi({ start: async () => ({ sdp: 'v=0', sessionId: 's', voice: { id: 'atlas', name: 'Atlas' }, maxSeconds: 60, remainingSeconds: 60 }) })
    const r = await connected({ api })
    r.clock.advance(69_000)
    strictEqual(r.engine.getSnapshot().state, 'listening')
    r.clock.advance(1_100)
    await flush()
    strictEqual(r.engine.getSnapshot().error?.kind, 'ended-by-limit')
  })
})

// ── Levels, speaking, mute ─────────────────────────────────────────────────

describe('levels and who is speaking', () => {
  it('rmsToLevel maps −58 dBFS to 0 and −14 dBFS to 1, and NaN/0 to 0', () => {
    strictEqual(rmsToLevel(0), 0)
    strictEqual(rmsToLevel(Number.NaN), 0)
    ok(Math.abs(rmsToLevel(10 ** (-58 / 20))) < 1e-9)
    strictEqual(rmsToLevel(10 ** (-14 / 20)), 1)
    strictEqual(rmsToLevel(1), 1)
  })

  it('smoothLevel attacks fast and releases slow', () => {
    ok(smoothLevel(0, 1) >= 0.5)
    ok(smoothLevel(1, 0) > 0.85)
    strictEqual(smoothLevel(0.001, 0), 0)
  })

  it('the speech gate needs the level to hold, and has hysteresis', () => {
    const g = createSpeechGate(0.24, 0.12, 80, 500)
    strictEqual(g.update(0.5, 0), false)
    strictEqual(g.update(0.5, 40), false)
    strictEqual(g.update(0.5, 80), true)
    strictEqual(g.update(0.18, 200), true)
    strictEqual(g.update(0.05, 300), true)
    strictEqual(g.update(0.05, 790), true)
    strictEqual(g.update(0.05, 800), false)
  })

  it('a loud remote stream is assistant-speaking, a loud mic is user-speaking, quiet is listening', async () => {
    const r = await connected()
    const remote = fakeStream()
    r.peer.ontrack!({ streams: [remote], track: remote.track })
    r.rms.output = 0.1
    r.clock.advance(TICK_MS * 5)
    strictEqual(r.engine.getSnapshot().state, 'assistant-speaking')
    ok(r.engine.getSnapshot().outputLevel > 0.5)
    r.rms.output = 0
    r.clock.advance(2000)
    strictEqual(r.engine.getSnapshot().state, 'listening')
    r.rms.input = 0.1
    r.clock.advance(TICK_MS * 5)
    strictEqual(r.engine.getSnapshot().state, 'user-speaking')
    ok(r.engine.getSnapshot().inputLevel > 0.5)
  })

  it('mute disables the mic track, zeroes the input level and keeps the call where it is', async () => {
    const r = await connected()
    r.rms.input = 0.1
    r.engine.setMuted(true)
    r.clock.advance(TICK_MS * 10)
    const s = r.engine.getSnapshot()
    strictEqual(r.mic.track.enabled, false)
    strictEqual(s.muted, true)
    strictEqual(s.inputLevel, 0)
    strictEqual(s.state, 'listening')
    strictEqual(voiceStateLine(s, 'Atlas'), 'Muted')
    r.engine.setMuted(false)
    strictEqual(r.mic.track.enabled, true)
  })
})

// ── The keyless demo and the preview driver ────────────────────────────────

const mockApi = () => fakeApi({ start: async (req) => ({ mock: true, sessionId: 'mock_1', voice: { id: req.voiceId, name: 'Atlas' }, maxSeconds: 900, remainingSeconds: 1800 }) })

describe('mock calls (keyless server, preview harness)', () => {
  it('let go of the mic and peer, connect after a beat, then play the demo in the persona\'s words', async () => {
    const r = rig({ api: mockApi() })
    await r.engine.start()
    ok(r.mic.track.stopped)
    ok(r.peer.closed)
    strictEqual(r.engine.getSnapshot().mock, true)
    strictEqual(r.engine.getSnapshot().state, 'connecting')
    const script = mockScript('atlas')
    r.clock.advance(MOCK_CONNECT_MS + script[0].from + 1500)
    let s = r.engine.getSnapshot()
    strictEqual(s.state, 'assistant-speaking')
    ok(s.outputLevel > 0)
    strictEqual(s.captions[0].role, 'assistant')
    ok(s.captions[0].text.startsWith("I'm Atlas"), s.captions[0].text)
    ok(!s.captions[0].final)
    r.clock.advance(script[1].from - script[0].from + 600 - 1500 + 400)
    s = r.engine.getSnapshot()
    strictEqual(s.state, 'user-speaking')
    ok(s.captions[0].final)
    strictEqual(s.captions[1].role, 'user')
    ok(s.elapsedSec >= 6)
  })

  it('end() on a demo saves what was "said" and tells the server', async () => {
    const r = rig({ api: mockApi() })
    await r.engine.start()
    r.clock.advance(MOCK_CONNECT_MS + 3000)
    await r.engine.end()
    deepStrictEqual(r.api.calls.end, ['mock_1'])
    strictEqual(r.api.calls.save.length, 1)
    strictEqual(r.engine.getSnapshot().state, 'ended')
  })

  it('mockFrame is a pure function of time: same t, same frame; muted turns are silent', () => {
    const script = mockScript('linden')
    deepStrictEqual(mockFrame(4321, script, false), mockFrame(4321, script, false))
    const userMid = (script[1].from + script[1].to) / 2
    strictEqual(mockFrame(userMid, script, false).state, 'user-speaking')
    const muted = mockFrame(userMid, script, true)
    strictEqual(muted.state, 'listening')
    strictEqual(muted.inputLevel, 0)
    const after = mockFrame(script[3].to + 5000, script, false)
    strictEqual(after.state, 'listening')
    strictEqual(after.captions.length, 4)
    ok(after.captions.every((c) => c.final))
  })

  it('every persona has its own demo lines', () => {
    const ids = ['linden', 'atlas', 'wren', 'rory', 'kip', 'hollis', 'sterling'] as const
    const greetings = new Set(ids.map((id) => mockScript(id)[0].text))
    strictEqual(greetings.size, ids.length)
  })

  it("the preview driver's event forces a state, and the demo stops writing over it", async () => {
    const r = rig({ api: mockApi() })
    const forced: Partial<VoiceSnapshot> = { state: 'error', error: { kind: 'mic-denied', message: 'x' } }
    r.preview.dispatchEvent(new CustomEvent(PREVIEW_VOICE_EVENT, { detail: forced }))
    strictEqual(r.engine.getSnapshot().state, 'error')
    r.preview.dispatchEvent(new CustomEvent(PREVIEW_VOICE_EVENT, { detail: { state: 'assistant-speaking', outputLevel: 0.7, error: null } }))
    r.clock.advance(1000)
    strictEqual(r.engine.getSnapshot().state, 'assistant-speaking')
    strictEqual(r.engine.getSnapshot().outputLevel, 0.7)
    await r.engine.end()
    strictEqual(r.engine.getSnapshot().state, 'ended')
  })

  it("PREVIEW_VOICE_EVENT is the harness's event name (preview/mockApi.ts)", () => {
    const src = readFileSync(new URL('../preview/mockApi.ts', import.meta.url), 'utf8')
    ok(src.includes(`export const PREVIEW_VOICE_EVENT = '${PREVIEW_VOICE_EVENT}'`))
  })
})

describe('words', () => {
  it('formatClock', () => {
    strictEqual(formatClock(0), '0:00')
    strictEqual(formatClock(245), '4:05')
    strictEqual(formatClock(900), '15:00')
    strictEqual(formatClock(-3), '0:00')
  })

  it("voiceStateLine names the persona when it speaks", () => {
    strictEqual(voiceStateLine({ state: 'assistant-speaking', muted: false, error: null }, 'Atlas'), 'Atlas is speaking')
    strictEqual(voiceStateLine({ state: 'connecting', muted: false, error: null }, 'Atlas'), 'Connecting…')
    strictEqual(voiceStateLine({ state: 'error', muted: false, error: { kind: 'plan', message: '' } }, 'Atlas'), 'Voice is part of Pro')
  })
})
