import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VOICE_IPC_ERROR_KINDS, VOICE_KIND_COPY, formatVoiceIpcError, parseVoiceIpcError } from './ipc-contract.ts'

const wrapped = (channel: string, message: string): string =>
  `Error invoking remote method '${channel}': Error: ${message}`

describe('voice IPC errors: the limits and when they lift', () => {
  it('knows the monthly limit, with its own fallback words', () => {
    ok(VOICE_IPC_ERROR_KINDS.includes('monthly-limit'))
    ok(VOICE_KIND_COPY['monthly-limit'].includes("this month's voice minutes"))
  })

  it('carries resetAt through the Electron wrapper', () => {
    const resetAt = '2026-10-11T05:00:00.000Z'
    for (const kind of ['daily-limit', 'monthly-limit'] as const) {
      const message = `Used up. With: a colon and [brackets].`
      deepStrictEqual(parseVoiceIpcError(wrapped('voice:start', formatVoiceIpcError({ kind, message, resetAt }))), {
        kind,
        message,
        resetAt
      })
    }
  })

  it('keeps an offset form, and leaves resetAt out when there was none', () => {
    const tagged = formatVoiceIpcError({ kind: 'daily-limit', message: 'x', resetAt: '2026-10-11T00:00:00+02:00' })
    strictEqual(parseVoiceIpcError(tagged).resetAt, '2026-10-11T00:00:00+02:00')
    deepStrictEqual(parseVoiceIpcError(formatVoiceIpcError({ kind: 'daily-limit', message: 'x' })), {
      kind: 'daily-limit',
      message: 'x'
    })
  })

  it('drops a resetAt that could break the tag rather than writing it', () => {
    const tagged = formatVoiceIpcError({ kind: 'daily-limit', message: 'x', resetAt: 'soon] [voice:busy' })
    strictEqual(tagged, '[voice:daily-limit] x')
    deepStrictEqual(parseVoiceIpcError(tagged), { kind: 'daily-limit', message: 'x' })
  })
})
