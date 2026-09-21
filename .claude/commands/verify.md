---
description: Free end-to-end health check of the server, auth, quota and RLS
---

Check that Tracely's backend is actually working. **This costs nothing** — every
probe stops before reaching OpenAI — so it is safe to run against production any
time.

Run these and report what you find. Do not assume a result; a check that was
skipped is not a check that passed.

## 1. Which host is production

The Tracely server URL is compiled into every installer — `TRACELY_API_URL` in
`.env`, or `https://api.jointracely.com` when it is unset (the build banner says
`api=<host> (default)` in that case). Pointing a release at the wrong host
breaks every copy of the app.

`GET <server>/api/status` answers only from a Tracely server, and says whether
it can spend: expect JSON with `hasKey: true` and `mock: false`. Anything else —
a 404, an HTML page, `mock: true` — means this is not the production server.
No token is needed and nothing is spent.

(Installed builds from before the move onto the server still call the relay
until they update. For the relay: send the real shared token and compare the
message — `Sign in to use Tracely.` means the token was accepted, `Unauthorized`
means this is not production. Read `RELAY_TOKEN` out of `.env` without printing
it, where an older checkout still has one.)

## 2. Every endpoint is live

`node scripts/preflight.mjs` covers this, or probe each endpoint in
`callServer`'s type union directly with an empty `POST {}`. A `404` means the
server was not deployed with the client — the failure that shipped in v0.3.73.

## 3. The migration actually ran

This is the one that hides. `checkRateLimit` fails **open** on error, so against
a database with no `relay_quota()` every quota check silently passes and there is
no rate limiting at all — indistinguishable from working, from the outside.

With the anon key from `.env`, against `SUPABASE_URL`:

- `POST /rest/v1/rpc/relay_quota` with a zero uuid → must return a row, not a
  "could not find the function" error
- `GET /rest/v1/user_entitlements?limit=1` → must not 404

## 4. RLS is closed

The anon key ships inside every installer, so treat it as public and test what a
stranger could do with it:

- `GET /rest/v1/usage_log?limit=1` → must be empty
- `POST /rest/v1/usage_log` with a dummy row → must fail with `42501 new row
  violates row-level security policy`

If that insert succeeds, anyone with the app can inflate `burst_global` past its
ceiling and lock out every real user. That is the highest-severity thing this
command checks.

**Do not** test DELETE with a filter that matches everything. If RLS were not
applied, that command would erase the usage log rather than report a problem.

## Report

State each check as pass or fail with the evidence, and say plainly which checks
you could not perform and why. "Probably fine" is not a result.
