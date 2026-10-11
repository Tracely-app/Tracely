import { deepStrictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VOICE_IPC_ERROR_KINDS, formatVoiceIpcError, parseVoiceIpcError } from './ipc-contract.ts'

// What Electron hands the renderer when a main handler throws: the channel,
// then the thrown Error's toString(). Nothing else survives the bridge.
const wrapped = (channel: string, message: string): string =>
  `Error invoking remote method '${channel}': Error: ${message}`

describe('voice IPC errors', () => {
  it('round-trips every kind through the Electron wrapper', () => {
    for (const kind of VOICE_IPC_ERROR_KINDS) {
      const message = `Something about ${kind}. With: a colon and [brackets].`
      deepStrictEqual(parseVoiceIpcError(wrapped('voice:start', formatVoiceIpcError({ kind, message }))), {
        kind,
        message
      })
    }
  })

  it('reads the tag with or without the wrapper, and keeps line breaks in the message', () => {
    deepStrictEqual(parseVoiceIpcError('[voice:busy] One call at a time.\nEnd the other one.'), {
      kind: 'busy',
      message: 'One call at a time.\nEnd the other one.'
    })
  })

  it('treats an untagged failure (a zod rejection, a bug) as server, without the wrapper noise', () => {
    deepStrictEqual(parseVoiceIpcError(wrapped('voice:end', 'Expected string, received number')), {
      kind: 'server',
      message: 'Expected string, received number'
    })
    deepStrictEqual(parseVoiceIpcError("Error invoking remote method 'voice:start': ZodError: bad"), {
      kind: 'server',
      message: 'bad'
    })
    deepStrictEqual(parseVoiceIpcError(''), { kind: 'server', message: 'Voice failed for an unknown reason.' })
  })

  it('does not invent a kind from an unknown tag', () => {
    deepStrictEqual(parseVoiceIpcError('[voice:mic-denied] nope').kind, 'server')
  })
})
