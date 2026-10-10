import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { VoiceMicStatus } from '@shared/ipc-contract'
import { resolveMicAccess, type MediaAccessPrefs } from './micAccess.ts'

/** A fake systemPreferences that records whether the prompt was shown. */
function prefs(status: VoiceMicStatus, answer = true): MediaAccessPrefs & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    getMediaAccessStatus: () => status,
    askForMediaAccess: async (media) => {
      asked.push(media)
      return answer
    }
  }
}

describe('resolveMicAccess', () => {
  it('asks once on macOS when nobody has answered yet, and reports the answer', async () => {
    const yes = prefs('not-determined', true)
    strictEqual(await resolveMicAccess('darwin', yes), 'granted')
    deepStrictEqual(yes.asked, ['microphone'])
    strictEqual(await resolveMicAccess('darwin', prefs('not-determined', false)), 'denied')
  })

  it('never prompts on macOS once there is an answer', async () => {
    for (const status of ['granted', 'denied', 'restricted'] as const) {
      const p = prefs(status)
      strictEqual(await resolveMicAccess('darwin', p), status)
      deepStrictEqual(p.asked, [])
    }
  })

  it('reads the Windows privacy toggle and never prompts there', async () => {
    const p = prefs('denied')
    strictEqual(await resolveMicAccess('win32', p), 'denied')
    strictEqual(await resolveMicAccess('win32', prefs('not-determined')), 'not-determined')
    deepStrictEqual(p.asked, [])
  })

  it('answers unknown on every other platform without touching the API', async () => {
    const p: MediaAccessPrefs = {
      getMediaAccessStatus: () => {
        throw new Error('not on linux')
      }
    }
    strictEqual(await resolveMicAccess('linux', p), 'unknown')
  })

  it('answers unknown instead of throwing when the OS call fails', async () => {
    const p: MediaAccessPrefs = {
      getMediaAccessStatus: () => 'not-determined',
      askForMediaAccess: async () => {
        throw new Error('TCC exploded')
      }
    }
    strictEqual(await resolveMicAccess('darwin', p), 'unknown')
  })
})
