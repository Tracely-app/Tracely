---
description: Build and publish a staging build to the preview channel (was /preview)
---

Publish a preview build. It installs **alongside** stable rather than upgrading
over it, keeps its own database under `%APPDATA%\Tracely Preview`, and publishes
to `preview.yml` — so production installs poll `latest.yml` and never see it.

**You usually do not run anything.** `.github/workflows/preview.yml` runs
`ship:preview` on a Windows runner on **every push to `main`**, so merging a PR
puts the change in Tracely Preview within a couple of minutes with nobody's
laptop involved. The command below is the fallback for when CI is broken.

The channel is `preview`, not `beta`, and that is deliberate: electron-updater
ranks `alpha`/`beta` as channels of one app and will offer a beta client any
newer stable release. Preview is a separate application, so that would hand
reviewers the production installer — it did, on 2026-08-14. See the header of
`scripts/ship-preview.mjs`.

## What makes this safe to try things in

A preview build uses the **staging** Supabase project, but the same AI
backend as production — there is only one Tracely server:

| | Preview build | Stable build |
|---|---|---|
| AI backend | `api.jointracely.com` (or `TRACELY_API_URL` in `.env.staging`) | `api.jointracely.com` |
| Supabase | staging project | production project |
| Accounts | separate — sign up again | real users |
| AI spend | the server's app pool (`TRACELY_APP_DAILY_BUDGET_USD`) | the same pool |

The Vercel relay the desktop used to call is retired: it stays deployed only
for installs too old to update, and nothing new ships to it.

That separation is the entire point. A migration, a quota change or a broken
endpoint costs a throwaway database and pocket change instead of reaching users.

## The normal path: merge it

Merge to `main`. Watch the run:

```bash
gh run watch $(gh run list --workflow=preview --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

The workflow is `concurrency: preview` with `cancel-in-progress`, so a second
merge supersedes an in-flight build rather than queueing behind it.

## Publishing by hand (only when CI is broken)

`ship-preview.mjs` refuses unless **all** of these hold:

1. **You are on `main`.** Not a `feat/*` branch — this gate used to be the other
   way round and was reversed on purpose. Branch and main previews both land on
   the one preview channel, so publishing from a branch replaces everyone's
   Tracely Preview with your unmerged work until the next merge takes it back.
   Two people comparing notes would be looking at different software with no way
   to tell.
2. **The tree is clean**, and **`HEAD` equals `origin/main`**. electron-builder
   packages the working tree rather than `HEAD`, so an uncommitted edit would
   ship inside a build no commit can reproduce.
3. **`.env.staging` exists.** `env.mjs` refuses rather than falling back to
   `.env`, because a "preview" pointed at production is worse than no preview.
4. **`GH_TOKEN`** is in the environment, or in `.env.release`. The environment
   wins, so a one-off run can use a different token without editing the file.
5. If `server/` changed, deploy it to api.jointracely.com first
   (`server/DEPLOY.md`) — preflight probes every endpoint the build calls and
   refuses a 404.

```bash
cd C:\Users\merri\Tracely-agent1 && npm run ship:preview
```

It pins `TRACELY_ENV=staging` in the environment it spawns, so this does not
depend on anything set in your shell — which would not work through `cmd.exe` on
Windows anyway. Preflight runs *before* the version bump, so a blocked attempt
costs nothing and does not burn a number.

**The version is picked differently in the two paths**, and it is worth knowing
which build you are looking at:

- **In CI** it is `<base>-preview.<GITHUB_RUN_NUMBER>`, and it is **not
  committed** — `package.json` on `main` stays at whatever the last real release
  left there. Run numbers only ever increase, which is all electron-updater
  needs. CI cannot commit to `main` anyway: `check` is a required status check,
  so a bot push would deadlock waiting on a check that cannot start until the
  push lands.
- **Locally** it runs `npm version prerelease --preid=preview`, commits
  `Preview v…`, pushes, and force-moves the tag onto the built commit.

## Watch for

**`env=staging file=.env.staging api=...`** in the build log. If that line
says `production`, stop — you are about to publish a preview wired to real
users' Supabase project.

## After

Install it and sign in. Staging is a different Supabase project, so your
production account does not exist there; create one. That is working as intended,
not a bug.

Preview builds **update themselves** — checked every 20 minutes, downloaded
silently, installed without a prompt whenever the app is idle in the tray with
Screen Watch off (`updatePolicy.ts`). So testers only install by hand once. If a
window is open or Screen Watch is running it asks instead, and failing that
installs on the next quit.

The eval deliberately refuses to run against staging. Its numbers are only
comparable across runs if the backend behind them never moves.

## Not a release

A preview build never auto-updates into production — different `appId`, different
channel. Promoting means running `/ship` on `main`, which rebuilds against
production.
