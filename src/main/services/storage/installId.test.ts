import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { INSTALL_ID_FIELD, isInstallId, readOrCreateInstallId } from './installId.ts'

// Real files in a scratch directory rather than a mocked fs: what matters is
// what ends up on disk, and a mock would only prove the mock.
const root = mkdtempSync(join(tmpdir(), 'tracely-install-id-'))
after(() => rmSync(root, { recursive: true, force: true }))

let n = 0
/** A fresh config.json path in its own directory, optionally pre-filled. */
function configPath(contents?: string): string {
  const dir = join(root, `case-${n++}`)
  const path = join(dir, 'config.json')
  if (contents !== undefined) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, contents)
  }
  return path
}

const onDisk = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf-8'))

/** A generator that counts how often it was asked, so "never regenerated" is checkable. */
function counting(ids: string[]): { generate: () => string; calls: () => number } {
  let calls = 0
  return {
    generate: () => ids[calls++] ?? `unexpected-call-${calls}`,
    calls: () => calls
  }
}

const A = '11111111-2222-4333-8444-555555555555'
const B = '66666666-7777-4888-9999-aaaaaaaaaaaa'

describe('readOrCreateInstallId — created once', () => {
  it('mints an id on first read and writes it to config.json', () => {
    const path = configPath()
    const gen = counting([A])
    deepStrictEqual(readOrCreateInstallId(path, gen.generate), { id: A, persisted: true, created: true })
    strictEqual(onDisk(path)[INSTALL_ID_FIELD], A)
  })

  it('returns the stored id on every later read and never mints another', () => {
    const path = configPath()
    const gen = counting([A, B])
    readOrCreateInstallId(path, gen.generate)
    for (let i = 0; i < 5; i++) {
      deepStrictEqual(readOrCreateInstallId(path, gen.generate), { id: A, persisted: true, created: false })
    }
    // The property the server's quota depends on: one install, one id. A
    // second call to the generator would be a second free daily quota.
    strictEqual(gen.calls(), 1)
  })

  it('keeps every key already in config.json', () => {
    const path = configPath(JSON.stringify({ semanticScholarApiKey: 'ss-key', ncbiApiKey: null }))
    readOrCreateInstallId(path, counting([A]).generate)
    deepStrictEqual(onDisk(path), { semanticScholarApiKey: 'ss-key', ncbiApiKey: null, installId: A })
  })

  it('reads an id written alongside other settings', () => {
    const path = configPath(JSON.stringify({ ncbiApiKey: 'k', installId: B }))
    const gen = counting([A])
    deepStrictEqual(readOrCreateInstallId(path, gen.generate), { id: B, persisted: true, created: false })
    strictEqual(gen.calls(), 0)
  })

  it('creates the data directory when it does not exist yet', () => {
    const path = join(root, `missing-${n++}`, 'nested', 'config.json')
    strictEqual(readOrCreateInstallId(path, counting([A]).generate).persisted, true)
    strictEqual(onDisk(path)[INSTALL_ID_FIELD], A)
  })

  it('generates UUIDs by default', () => {
    const { id } = readOrCreateInstallId(configPath())
    strictEqual(isInstallId(id), true)
  })
})

describe('readOrCreateInstallId — never overwrites what it cannot read', () => {
  it('leaves an unparseable config.json byte-for-byte alone', () => {
    const broken = '{"semanticScholarApiKey": "ss-key",'
    const path = configPath(broken)
    deepStrictEqual(readOrCreateInstallId(path, counting([A]).generate), { id: A, persisted: false, created: true })
    strictEqual(readFileSync(path, 'utf-8'), broken)
  })

  it('treats JSON that is not an object as unreadable too', () => {
    for (const contents of ['[]', 'null', '"installId"', '42']) {
      const path = configPath(contents)
      strictEqual(readOrCreateInstallId(path, counting([A]).generate).persisted, false)
      strictEqual(readFileSync(path, 'utf-8'), contents)
    }
  })

  it('replaces a stored value that is not a UUID, once', () => {
    for (const bad of ['', '   ', 'abc', 42, null, 'x'.repeat(300)]) {
      const path = configPath(JSON.stringify({ installId: bad, ncbiApiKey: 'k' }))
      const gen = counting([A, B])
      strictEqual(readOrCreateInstallId(path, gen.generate).id, A)
      strictEqual(readOrCreateInstallId(path, gen.generate).id, A)
      strictEqual(gen.calls(), 1)
      strictEqual(onDisk(path).ncbiApiKey, 'k')
    }
  })
})

describe('isInstallId', () => {
  it('accepts a UUID in either case and nothing else', () => {
    strictEqual(isInstallId(A), true)
    strictEqual(isInstallId(A.toUpperCase()), true)
    strictEqual(isInstallId(`${A} `), false)
    strictEqual(isInstallId(A.replace(/-/g, '')), false)
    strictEqual(isInstallId(undefined), false)
  })
})
