import { strictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { VOICE_DEFAULT_DAILY_SECONDS, VOICE_DEFAULT_MAX_SECONDS, VOICE_MIN_BILLED_SECONDS } from './voicePolicy.ts'

/** A numeric `export const NAME = 1_000;` from the server's source. */
function serverVoiceConstant(name: string): number {
  const src = readFileSync(new URL('../../server/lib/voice.js', import.meta.url), 'utf8')
  const m = new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)\\s*;`).exec(src)
  if (!m) throw new Error(`server/lib/voice.js has no numeric export ${name}`)
  return Number(m[1].replace(/_/g, ''))
}

describe("voicePolicy: the desktop's copies of the server's voice numbers", () => {
  it('match server/lib/voice.js', () => {
    strictEqual(VOICE_MIN_BILLED_SECONDS, serverVoiceConstant('VOICE_MIN_BILLED_SECONDS'))
    strictEqual(VOICE_DEFAULT_MAX_SECONDS, serverVoiceConstant('DEFAULT_MAX_SECONDS'))
    strictEqual(VOICE_DEFAULT_DAILY_SECONDS, serverVoiceConstant('DEFAULT_DAILY_SECONDS'))
  })
})
