/**
 * Which custom URL scheme this build's Google sign-in comes back through.
 *
 * Exactly one program on Windows owns a scheme, and both Tracely and Tracely
 * Preview used to claim `tracely://`. Whichever launched last won, so signing
 * in from the other one sent the authorization code to a build that never
 * started that flow — it has no PKCE verifier for it, and
 * `exchangeCodeForSession` fails with something opaque. The working rule was
 * "launch the build you intend to sign in on, first", which is not a rule
 * anyone should have to know.
 *
 * Two schemes, one per channel, and the two builds stop competing.
 *
 * ── The redirect URL and the scheme must not be derived separately ─────────
 * Supabase only redirects to a URL on the project's allowlist, and Windows only
 * delivers a scheme someone registered. Those are two different systems reading
 * what has to be one decision, so both come from here — a leaf with no imports,
 * which is also what lets `npm test` load it.
 *
 * ── `isPreview` is passed IN, never re-derived ─────────────────────────────
 * `appIdentity.isPreviewBuild()` reads `app.getName()` and is the single truth
 * for which channel this is. Re-deriving it here — from the version's
 * `-preview` suffix, say — would be a second truth that can silently disagree
 * with the first, which is the trap `appIdentity`'s own docstring warns about.
 */

/** The stable channel's scheme. Unchanged, so no installed stable build moves. */
export const STABLE_OAUTH_SCHEME = 'tracely'

/**
 * The preview channel's scheme.
 *
 * `tracely-preview` matches the preview build's package name (set by
 * `-c.extraMetadata.name` and read back by `appIdentity`), so the scheme, the
 * app name and the user-data directory all say the same word.
 */
export const PREVIEW_OAUTH_SCHEME = 'tracely-preview'

/**
 * The host part of the callback. Shared, because only the scheme distinguishes
 * the channels — `handleOAuthUrl` matches on `<scheme>://auth-callback` and
 * would silently stop recognising its own redirect if these drifted apart.
 */
export const OAUTH_CALLBACK_HOST = 'auth-callback'

/** The scheme this build registers with the OS and answers on. */
export function oauthSchemeFor(isPreview: boolean): string {
  return isPreview ? PREVIEW_OAUTH_SCHEME : STABLE_OAUTH_SCHEME
}

/**
 * What this build asks Supabase to redirect to after the consent screen.
 *
 * Must be on the Supabase project's redirect allowlist or OAuth fails outright
 * — before the browser ever reaches the app — so adding a channel means adding
 * its URL to that project first.
 */
export function oauthRedirectUrlFor(isPreview: boolean): string {
  return `${oauthSchemeFor(isPreview)}://${OAUTH_CALLBACK_HOST}`
}
