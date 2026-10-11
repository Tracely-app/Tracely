import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VOICE_KIND_COPY } from '../../../shared/ipc-contract.ts'
import { closedError, createVoiceSession, errorTitle, startError, voiceCallBound, type VoiceApi, type VoiceDeps } from './session.ts'

// Times are said in the machine's own zone here (limits.test.ts pins the
// wording in a fixed one), so these accept "at" and "tomorrow at" alike.
// A small rig of its own (session.test.ts keeps its fakes private): just
// enough of the browser for a start to reach the server and come back.
function rig(start: VoiceApi['start']) {
  const track = { kind: 'audio', enabled: true, stop() {} } as unknown as MediaStreamTrack
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
  const peer = {
    iceGatheringState: 'complete',
    connectionState: 'new',
    localDescription: null as { sdp: string } | null,
    onicegatheringstatechange: null,
    onconnectionstatechange: null,
    ontrack: null,
    addTrack() {},
    createDataChannel: () => ({ readyState: 'open', onmessage: null, onclose: null, close() {} }),
    async createOffer() { return { type: 'offer', sdp: 'v=0 offer' } },
    async setLocalDescription(d: { sdp?: string }) { peer.localDescription = { sdp: String(d.sdp) } },
    async setRemoteDescription() {},
    close() {}
  }
  const api: VoiceApi = {
    ensureMic: async () => ({ status: 'granted' }),
    start,
    end: async () => ({ seconds: 0 }),
    saveTranscript: async () => ({ saved: false })
  }
  const deps: VoiceDeps = {
    getUserMedia: async () => stream,
    createPeer: () => peer as never,
    createMeter: () => null,
    createSpeaker: () => ({ play() {}, stop() {} }),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    platform: 'mac',
    previewEvents: null,
    onUnload: () => () => {},
    onUserGesture: () => () => {}
  }
  return createVoiceSession({ voiceId: 'kip', api, deps })
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

describe('the limits in the engine', () => {
  it("keeps the start answer's month figure and reset time on the snapshot", async () => {
    const resetAt = inAnHour()
    const engine = rig(async (req) => ({
      mock: true, sessionId: 'mock_1', voice: { id: req.voiceId, name: 'Kip' },
      maxSeconds: 900, remainingSeconds: 1500, remainingMonthSeconds: 4200, resetAt
    }))
    await engine.start()
    const s = engine.getSnapshot()
    strictEqual(s.remainingTodaySec, 1500)
    strictEqual(s.remainingMonthSec, 4200)
    strictEqual(s.resetAt, resetAt)
    engine.dispose()
  })

  it('a start refused for the month is monthly-limit, saying when the minutes come back', async () => {
    const resetAt = inAnHour()
    const engine = rig(async () => {
      throw Object.assign(new Error('x'), { kind: 'monthly-limit', resetAt })
    })
    await engine.start()
    const s = engine.getSnapshot()
    strictEqual(s.state, 'error')
    strictEqual(s.error?.kind, 'monthly-limit')
    // "at 7:00 PM", or "tomorrow at …" when run late in the evening.
    ok(/^You've used this month's voice minutes\. They come back (at|tomorrow at) /.test(s.error?.message ?? ''), s.error?.message)
    strictEqual(errorTitle('monthly-limit'), "This month's voice minutes are used")
  })

  it('startError: the daily limit names the time when it has one, else says tomorrow', () => {
    const now = new Date('2026-10-10T12:00:00Z')
    const later = '2026-10-10T18:00:00Z'
    const named = startError(Object.assign(new Error(''), { kind: 'daily-limit', resetAt: later }), now).message
    ok(/They come back (at|tomorrow at) /.test(named), named)
    deepStrictEqual(startError(Object.assign(new Error(''), { kind: 'daily-limit' }), now), {
      kind: 'daily-limit',
      message: VOICE_KIND_COPY['daily-limit']
    })
  })
})

describe('a call cut by an allowance', () => {
  it('voiceCallBound: the smallest of the month, the day and the call', () => {
    strictEqual(voiceCallBound(900, 1800, 7200), 'call')
    strictEqual(voiceCallBound(600, 600, 7200), 'day')
    strictEqual(voiceCallBound(300, 600, 300), 'month')
    strictEqual(voiceCallBound(900, null, null), 'call')
    strictEqual(voiceCallBound(600, null, 600), 'month')
  })

  it("closedError says when today's minutes come back, from the start answer's resetAt", () => {
    const now = new Date('2026-10-10T12:00:00Z')
    const e = closedError('close_requested', 600, 600, { resetAt: '2026-10-10T18:00:00Z', now })
    strictEqual(e.kind, 'ended-by-limit')
    ok(/^That's all of today's voice minutes\. They come back (at|tomorrow at) /.test(e.message), e.message)
    ok(closedError('expired', 600, 600, { now }).message.includes('They come back tomorrow'))
  })

  it("closedError: a call cut by the month's allowance says the month, and when it turns", () => {
    const now = new Date('2026-10-10T12:00:00Z')
    const e = closedError('close_requested', 300, 1200, { remainingMonthSec: 300, resetAt: '2026-10-11T00:00:00Z', now })
    ok(e.message.startsWith("That's all of this month's voice minutes. They come back on "), e.message)
    // The per-call cap is unchanged.
    ok(closedError('close_requested', 900, 1800, { remainingMonthSec: 7200, now }).message.includes('15-minute limit'))
  })
})
