import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  LOOPBACK_PORT,
  LOOPBACK_REDIRECT,
  TIMEOUT_MESSAGE,
  callbackPage,
  listenForCallback,
  parseCallback
} from './loopback.ts'

describe('parseCallback', () => {
  it('takes the code off the redirect', () => {
    deepStrictEqual(parseCallback('/auth/callback?code=abc123'), { kind: 'code', code: 'abc123' })
  })
  it('reports a refusal in the words Supabase or Google gave', () => {
    deepStrictEqual(parseCallback('/auth/callback?error=access_denied&error_description=User+cancelled'), {
      kind: 'error',
      message: 'User cancelled'
    })
    deepStrictEqual(parseCallback('/auth/callback?error=access_denied'), { kind: 'error', message: 'access_denied' })
  })
  it('ignores anything that is not the redirect, so a favicon request cannot end the wait', () => {
    deepStrictEqual(parseCallback('/favicon.ico'), { kind: 'ignore' })
    deepStrictEqual(parseCallback('/'), { kind: 'ignore' })
  })
  it('treats a redirect with neither code nor error as a failure, not a hang', () => {
    strictEqual(parseCallback('/auth/callback').kind, 'error')
  })
})

describe('the loopback address', () => {
  it('is exactly the one the Supabase allow list must carry', () => {
    // If this changes, the allow list entry on the Supabase project must
    // change with it — or sign-in silently redirects to jointracely.com.
    strictEqual(LOOPBACK_REDIRECT, 'http://127.0.0.1:53117/auth/callback')
  })
})

describe('callbackPage', () => {
  it('never renders the error message as markup', () => {
    const page = callbackPage(false, '<script>alert(1)</script>')
    ok(!page.includes('<script>alert'))
    ok(page.includes('&lt;script&gt;'))
  })
})

describe('listenForCallback', () => {
  // A different port from the app's, so a running Tracely cannot collide.
  const port = LOOPBACK_PORT + 1

  it('resolves with the code the browser brings back, after ignoring a favicon request', async () => {
    const { server, callback } = await listenForCallback({ port })
    try {
      strictEqual((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status, 404)
      const page = await fetch(`http://127.0.0.1:${port}/auth/callback?code=the-code`)
      ok((await page.text()).includes("You're signed in"))
      strictEqual(await callback, 'the-code')
    } finally {
      server.close()
    }
  })

  it('rejects with the refusal when the user cancels', async () => {
    const { server, callback } = await listenForCallback({ port })
    try {
      await fetch(`http://127.0.0.1:${port}/auth/callback?error_description=Access+denied`)
      await rejects(callback, /Access denied/)
    } finally {
      server.close()
    }
  })

  it('gives up with a message that names the likely cause', async () => {
    const { server, callback } = await listenForCallback({ port, timeoutMs: 20 })
    try {
      await rejects(callback, (err: Error) => err.message === TIMEOUT_MESSAGE && /jointracely\.com/.test(err.message))
    } finally {
      server.close()
    }
  })

  it('says plainly when the port is taken', async () => {
    const first = await listenForCallback({ port })
    try {
      await rejects(listenForCallback({ port }), /something else is using it/)
    } finally {
      first.server.close()
    }
  })

  it('listens on 127.0.0.1 only', async () => {
    const { server } = await listenForCallback({ port })
    try {
      const addr = server.address()
      ok(addr && typeof addr === 'object' && addr.address === '127.0.0.1')
    } finally {
      server.close()
    }
  })
})

describe('sign-out', () => {
  it('is LOCAL — a global sign-out would also sign the user out of the Chrome extension', () => {
    // supabase-js signs out globally by default. Read as text: googleSignIn.ts
    // imports Electron, which this runner cannot load.
    const src = readFileSync(new URL('./googleSignIn.ts', import.meta.url), 'utf8')
    ok(/auth\.signOut\(\{\s*scope:\s*'local'\s*\}\)/.test(src), 'signOutHere must pass { scope: "local" }')
  })
  it('the client runs the PKCE flow the code exchange needs', () => {
    const src = readFileSync(new URL('./client.ts', import.meta.url), 'utf8')
    ok(/flowType:\s*'pkce'/.test(src))
  })
})
