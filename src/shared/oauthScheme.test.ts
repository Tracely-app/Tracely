import { describe, it } from 'node:test'
import { strictEqual, notStrictEqual } from 'node:assert/strict'
import {
  OAUTH_CALLBACK_HOST,
  PREVIEW_OAUTH_SCHEME,
  STABLE_OAUTH_SCHEME,
  oauthRedirectUrlFor,
  oauthSchemeFor
} from './oauthScheme.ts'

describe('oauthSchemeFor', () => {
  /**
   * The whole point: two builds on one machine must not claim the same scheme.
   * If these ever collapse to one value the collision is back, and it comes
   * back as a login that fails with something opaque rather than as a crash.
   */
  it('gives the two channels different schemes', () => {
    notStrictEqual(oauthSchemeFor(true), oauthSchemeFor(false))
  })

  /**
   * Stable's scheme is pinned by every copy already installed and by the
   * production Supabase allowlist. Changing it would break sign-in for every
   * existing user at once, and they cannot fix it from inside the app.
   */
  it('leaves stable on the scheme already in the wild', () => {
    strictEqual(oauthSchemeFor(false), 'tracely')
    strictEqual(STABLE_OAUTH_SCHEME, 'tracely')
  })

  // Must match what was added to the STAGING Supabase redirect allowlist.
  // Supabase rejects a redirect that is not on the list before the browser ever
  // gets back to the app, so a typo here is a total sign-in failure, not a
  // degraded one.
  it('uses the scheme registered on the staging allowlist', () => {
    strictEqual(oauthSchemeFor(true), 'tracely-preview')
    strictEqual(PREVIEW_OAUTH_SCHEME, 'tracely-preview')
  })
})

describe('oauthRedirectUrlFor', () => {
  it('builds the callback URL from the channel scheme', () => {
    strictEqual(oauthRedirectUrlFor(false), 'tracely://auth-callback')
    strictEqual(oauthRedirectUrlFor(true), 'tracely-preview://auth-callback')
  })

  /**
   * `handleOAuthUrl` in main/index.ts accepts a URL by testing it starts with
   * `<scheme>://auth-callback`. It builds that prefix from the same two
   * exports, so this pins them together: a redirect URL whose host stopped
   * matching would be delivered by Windows and then silently ignored by the
   * app, which looks exactly like the bug this change exists to fix.
   */
  it('keeps the host the redirect handler matches on', () => {
    for (const isPreview of [true, false]) {
      strictEqual(
        oauthRedirectUrlFor(isPreview),
        `${oauthSchemeFor(isPreview)}://${OAUTH_CALLBACK_HOST}`
      )
    }
  })

  // A scheme with a colon, a slash or a space in it produces a URL Windows
  // cannot register and Supabase will not match. Cheap to assert, and the
  // failure it catches is only visible at sign-in time.
  it('produces schemes that are legal in a URL', () => {
    for (const scheme of [STABLE_OAUTH_SCHEME, PREVIEW_OAUTH_SCHEME]) {
      strictEqual(/^[a-z][a-z0-9+.-]*$/.test(scheme), true, `illegal scheme: ${scheme}`)
    }
  })
})
