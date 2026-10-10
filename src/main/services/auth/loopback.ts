import http from 'node:http'

/**
 * The loopback half of desktop Google sign-in — the parts with no Electron in
 * them, so `npm test` can load this file.
 *
 * WHY LOOPBACK. The desktop cannot host a Google sign-in page itself (Google
 * refuses embedded webviews), so it opens the user's own browser and needs the
 * browser to hand the result back. The first version of desktop sign-in did
 * that with a custom `tracely://` protocol; it was deleted with the rest of
 * sign-in in #216, along with the per-channel scheme fight between dev,
 * stable and preview builds it caused. A loopback redirect — the browser is
 * sent to http://127.0.0.1:<port>/…, where this app is briefly listening — is
 * the standard pattern for native apps (RFC 8252 §7.3) and needs no protocol
 * registration, no installer change and nothing that differs between builds.
 *
 * WHY GOOGLE AND NOT A PASSWORD. The Chrome extension signs people in with
 * Google only, and the extension is where plans are sold. So every paying
 * customer's account is a Google identity with no password. A password form
 * here would create a SECOND, unrelated account for each of them — one with no
 * plan — which is the opposite of one account across both surfaces.
 *
 * THE PORT IS FIXED on purpose. Supabase only redirects to addresses on its
 * allow list, and an exact entry is the one form of that list we can rely on.
 * `LOOPBACK_REDIRECT` must be listed under Authentication → URL Configuration
 * → Redirect URLs on the Supabase project, character for character. Unlisted,
 * Supabase silently redirects to the Site URL (jointracely.com) instead, and
 * this app waits for a callback that never comes — see TIMEOUT_MESSAGE.
 */

export const LOOPBACK_PORT = 53117
export const LOOPBACK_PATH = '/auth/callback'
export const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}${LOOPBACK_PATH}`

/** Long enough to choose an account and approve; short enough not to hold a port all day. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000

export const TIMEOUT_MESSAGE =
  'Sign-in timed out. If your browser ended up on jointracely.com instead of a "You\'re signed in" page, ' +
  "this build's sign-in address is not on Tracely's allowed list yet — tell whoever runs Tracely."

export type CallbackResult =
  | { kind: 'code'; code: string }
  | { kind: 'error'; message: string }
  // A request that is not the redirect at all — the browser asking for
  // /favicon.ico, say. Answered and otherwise ignored; it must not end the wait.
  | { kind: 'ignore' }

/** What the browser's request to the loopback address means. */
export function parseCallback(rawUrl: string): CallbackResult {
  let url: URL
  try {
    url = new URL(rawUrl, `http://127.0.0.1:${LOOPBACK_PORT}`)
  } catch {
    return { kind: 'ignore' }
  }
  if (url.pathname !== LOOPBACK_PATH) return { kind: 'ignore' }
  const code = url.searchParams.get('code')
  if (code) return { kind: 'code', code }
  // Supabase and Google report a refusal (the user pressed Cancel, the
  // provider is off) as error / error_description on the redirect.
  const description = url.searchParams.get('error_description') ?? url.searchParams.get('error')
  if (description) return { kind: 'error', message: description.replace(/\+/g, ' ') }
  return { kind: 'error', message: 'Google sent no sign-in code back. Please try again.' }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/**
 * The page the browser shows once it has handed the result back. Its only job
 * is to tell the person to go back to the app — this tab has nothing else to do.
 * Self-contained: no network request, nothing loaded from anywhere.
 */
export function callbackPage(ok: boolean, message?: string): string {
  const title = ok ? "You're signed in" : 'Sign-in did not finish'
  const body = ok
    ? 'You can close this tab and go back to Tracely.'
    : `${escapeHtml(message ?? 'Something went wrong.')} Close this tab and try again from Tracely.`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} — Tracely</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f6f3;color:#17140f;
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:420px;padding:32px;text-align:center}
h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#6d645b}.mark{font-size:28px;margin-bottom:12px;color:${ok ? '#2e6b47' : '#d93636'}}
@media (prefers-color-scheme:dark){body{background:#15130f;color:#f2ede4}p{color:#a09585}}</style></head>
<body><main><div class="mark">${ok ? '✓' : '!'}</div><h1>${title}</h1><p>${body}</p></main></body></html>`
}

/**
 * Listen on the loopback port, and resolve `callback` with the code the
 * browser brings back — or reject it with the reason it did not.
 *
 * Here rather than in googleSignIn.ts so it can be tested without Electron.
 * `port` and `timeoutMs` are parameters for the same reason; the app always
 * uses the defaults, because the redirect Supabase allows names this port.
 */
export function listenForCallback({
  port = LOOPBACK_PORT,
  timeoutMs = SIGN_IN_TIMEOUT_MS
}: { port?: number; timeoutMs?: number } = {}): Promise<{ server: http.Server; callback: Promise<string> }> {
  return new Promise((resolveListen, rejectListen) => {
    let settle: { ok: (code: string) => void; fail: (err: Error) => void } = { ok: () => {}, fail: () => {} }
    const callback = new Promise<string>((ok, fail) => {
      settle = { ok, fail }
    })
    // Handled even if nothing awaits it yet, so a failure before the await
    // cannot surface as an unhandled rejection that takes main down.
    callback.catch(() => undefined)

    const timer = setTimeout(() => settle.fail(new Error(TIMEOUT_MESSAGE)), timeoutMs)
    timer.unref?.()

    const server = http.createServer((req, res) => {
      const result = parseCallback(req.url ?? '/')
      // Connection: close on every answer. This server lives for one request;
      // a browser that kept the socket alive would be holding a connection to
      // something about to shut down, and reusing it on a retry gets a reset.
      if (result.kind === 'ignore') {
        res.writeHead(404, { Connection: 'close' }).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
      res.end(callbackPage(result.kind === 'code', result.kind === 'error' ? result.message : undefined))
      clearTimeout(timer)
      if (result.kind === 'code') settle.ok(result.code)
      else settle.fail(new Error(result.message))
    })
    server.on('close', () => clearTimeout(timer))

    server.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      rejectListen(
        new Error(
          err.code === 'EADDRINUSE'
            ? `Tracely signs in through port ${port} on this computer, and something else is using it. ` +
                'Close the other program (or another Tracely sign-in) and try again.'
            : `Could not start sign-in: ${err.message}`
        )
      )
    })
    // 127.0.0.1 only — never 0.0.0.0. The code in the redirect is a
    // credential for a few seconds, and nothing on the network should see it.
    server.listen(port, '127.0.0.1', () => resolveListen({ server, callback }))
  })
}
