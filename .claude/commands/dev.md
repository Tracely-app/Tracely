---
description: Run the app locally against staging, so testing costs nothing real
---

Launch Tracely from source, pointed at the staging backend.

```bash
$env:TRACELY_ENV="staging"; npm run dev
```

Hot-reloads as files change. Nothing is packaged, nothing is published, and the
auto-updater is inert — `initAutoUpdater` returns early when `app.isPackaged` is
false.

## Why staging rather than plain `npm run dev`

`.env` holds **production** values, so a bare `npm run dev` spends the real
OpenAI key and counts against real quota on every Analyze, every Screen Watch
detection, every critique. Fine for looking at a button. Not fine for
running detection twenty times while tuning something.

`TRACELY_ENV=staging` reads `.env.staging` instead: separate Supabase project,
throwaway data.

The AI calls are the exception now that the app talks to the Tracely server
rather than a per-environment relay. They go wherever `TRACELY_API_URL` in the
env file points, and when it points nowhere that is the hosted server — the
production OpenAI key, though a staging session will not verify there unless
the server shares the staging Supabase project, so it is metered as a
signed-out free install. For AI calls that cost nothing real, set
`TRACELY_API_URL=http://localhost:4477` in `.env.staging` and run the server
locally with `TRACELY_MOCK=1` (`cd server && npm start`).

The variable lasts only for that terminal session. A new terminal is back to
production, which is the right default for a maintainer — but check the banner
rather than assuming.

## Confirm which backend you got

Every build prints it. This is the only way to know:

```
env=staging  file=.env.staging  api=api.jointracely.com (default)  supabase=sxifbtelrtbsgnnwnmdf
```

`env=` and `supabase=` are the fields that matter. If `env=` says `production`,
the variable did not take and you are on the production Supabase project.
`api=` is the Tracely server the build's AI calls go to; there is one hosted
server, so it reads `api.jointracely.com (default)` in both environments unless
`TRACELY_API_URL` in the env file names another.

## You will need the staging account

Staging is a different Supabase project, so your production login does not exist
there. Sign up separately, once. That is working as intended, not a bug.

## When this is not enough

`npm run dev` resolves modules from `node_modules`, so it cannot see anything
that only breaks once packaged — the ML worker loading out of `app.asar`, the
installer, auto-update. v0.3.76 shipped with the entire ML stack excluded and
dev was completely happy.

For those, build a real installer with `/beta`. (`/preview` is the UI harness —
real renderer, mocked everything else — which cannot see packaging problems
either.)
