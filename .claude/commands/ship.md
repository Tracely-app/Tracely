---
description: Cut a production release of the desktop app
---

Publish a stable release. Every installed copy picks it up within 6 hours, and
`electron-updater` **cannot downgrade**, so a bad release is only fixable by
shipping another one. There is no rollback.

## Before

1. **Deploy the server first.** The app and `server/` ship together. A client
   released ahead of the endpoint it calls returns 404 in production — that is
   what happened in v0.3.73, and `preflight.mjs` exists because of it. If
   `server/` changed since the last deploy, Sam deploys it (`server/DEPLOY.md`)
   before this runs; `STATUS.md` says what is live.
2. **`main` must be the source.** Work belongs on `feat/*` branches and reaches
   `main` by merge. `preflight` enforces this.
3. Everything committed and pushed. `electron-builder` packages the working tree,
   not `HEAD`, so uncommitted edits ship silently and are unreproducible from the
   tag afterwards.

## Ship

```bash
cd C:\Users\merri\Tracely-agent1 && npm run ship
```

That runs preflight, bumps the version, pushes, builds and publishes. Preflight
runs *before* the bump, so a blocked attempt costs nothing and does not burn a
version number.

`ship.mjs` pins `TRACELY_ENV=production` in the environment it spawns. Do not
remove that: a leftover `staging` value would build a production release pointed
at a staging Supabase project, publish it to `latest.yml`, and reach
every install — with no runtime way to see which backend a build is using.

## Watch for

- **`env=production api=...`** in the build log. If it says anything else,
  stop.
- Preflight's server probes. A `404` means the server is not deployed.
- `PASS app.asar contents` and `PASS bundled model embeds offline`. The second
  one matters: v0.3.76 shipped with the entire ML stack excluded and silently
  degraded to word-overlap ranking. Nothing errored.

## If it fails

Read the failure. Preflight failing is preflight working — it is cheaper to fix
here than to discover it in an installer. Do not work around a gate; the gates
each exist because a release already went wrong that way.
