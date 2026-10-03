import { describe, it } from 'node:test'
import { strictEqual } from 'node:assert/strict'
import { selfProcessName } from './selfProcess.ts'

describe('selfProcessName', () => {
  it('is the stable build\'s own executable', () => {
    strictEqual(selfProcessName('C:\\Users\\a\\AppData\\Local\\Programs\\Tracely\\Tracely.exe'), 'Tracely.exe')
  })

  /** The case that never matched: app.name is "tracely-preview". */
  it('keeps the preview build\'s space, which app.name never had', () => {
    strictEqual(
      selfProcessName('C:\\Users\\a\\AppData\\Local\\Programs\\Tracely Preview\\Tracely Preview.exe'),
      'Tracely Preview.exe'
    )
  })

  /** `npm run dev` runs under Electron's own binary, not a Tracely.exe. */
  it('is electron.exe under npm run dev', () => {
    strictEqual(selfProcessName('C:\\repo\\node_modules\\electron\\dist\\electron.exe'), 'electron.exe')
  })
})
