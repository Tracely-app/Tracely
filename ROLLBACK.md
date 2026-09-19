# Rollback

What to do when something that shipped is wrong. Read the first section before
you need it — the rest is reference.

## The one thing to know

**The relay can be undone in seconds. The desktop app cannot be undone at all.**

electron-updater refuses to install a version lower than the one already
present, and `allowDowngrade` is not set (`src/main/updater.ts`). There is no
"revert v0.3.79". The only way out of a bad desktop release is a *higher*
version containing the corrected code.

So the first question in any incident is not "how do I roll back the app?" It is
**"can the relay fix this instead?"** The relay is versionless, deploys in ~20
seconds, and reverts with one command. Reach for it first, every time.

| Surface | Reversible? | How long | Command |
|---|---|---|---|
| Relay code | Yes, fully | ~30s | `vercel rollback` |
| Relay env var | Yes | ~1 min | dashboard edit + redeploy |
| Desktop release | **No** — forward only | 20–40 min | stop the offer, then ship N+1 |
| Supabase schema | Manual only | varies | hand-written reverse SQL |

## Blast radius, honestly

Updates are **opt-in twice**. `autoDownload = false`, so a user sees "Update
available → Download", and then "Update ready → Restart now". Both are dismissable.
The check runs at launch and every 6 hours.

That means a bad release spreads over hours-to-days, not minutes, and the
population is split: some on the bad version, most not yet. **Stopping the offer
is worth doing even after the bad build is out**, because most people haven't
taken it yet.

---

## Incident 1 — the relay is broken

Symptoms: every install fails at once, errors appear immediately after a relay
deploy, `vercel logs` shows 5xx or auth failures.

```bash
vercel rollback --cwd C:\Users\merri\Tracely-relay
```

It prompts with the previous production deployment. Confirm, then check it took:

```bash
vercel rollback status --cwd C:\Users\merri\Tracely-relay
```

Verify the endpoints answer. Unauthenticated calls must return **401**, not 500 —
this costs nothing and reaches no model. PowerShell throws on non-2xx, so the
status comes out of the exception:

```bash
try { (Invoke-WebRequest "https://folio-relay.vercel.app/api/detect-claims" -Method POST -ContentType "application/json" -Body "{}" -UseBasicParsing).StatusCode } catch { [int]$_.Exception.Response.StatusCode }
```

(Do not use `curl` here. In PowerShell it is an alias for `Invoke-WebRequest`,
which does not accept curl's flags and will fail confusingly.)

Then **revert the commit on `main`** so the next push doesn't redeploy the same
bug on top of your rollback:

```bash
git -C C:\Users\merri\Tracely-relay revert --no-edit <bad-sha>
```

> **Target the right project.** The `Tracely-relay` folder is linked to
> `tracely-relay` (production, serving `folio-relay.vercel.app`). Staging is a
> *separate* Vercel project and is not selected by the folder. To act on staging,
> set `VERCEL_PROJECT_ID=prj_1OW4RgXlZ5axLY80kSUKr8vvSA0z` first. Running a bare
> `vercel env rm` in that folder hits production.

## Incident 2 — a bad desktop release

Two moves, in this order. The first is fast and stops most of the damage; the
second is the actual fix.

### 2a. Stop the offer

**This is now a one-line change on the download host, and it is reversible.**
electron-updater reads `https://dl.jointracely.com/latest.yml`; that file, and
nothing else, decides what every installed copy is offered. Point it back at the
last good version and the offer stops on the next poll.

```bash
ssh tracelydl@45.56.92.67
cd /srv/tracely/releases
ls -1t *.exe                      # every version still on the box (the last 10 are kept)
cp latest.yml latest.yml.bad      # keep the bad feed; it is the evidence
```

Then edit `latest.yml` so `version:`, `path:`, `url:` and `sha512:` all name the
**previous** installer — every field, together. A feed whose `version` is rolled
back but whose `path` still names the bad `.exe` hands the bad build to everyone
who has not taken it yet, under the old version number, which is worse than
doing nothing.

The clean way to get a correct one is not to hand-edit at all: the `.yml` from
the good release is still in that version's `release/` directory on the machine
that built it, so re-run its publish instead.

```bash
# from the repo, on the commit that built the good version
node scripts/publish-dl.mjs        # re-uploads and re-verifies that feed
```

**This does not pull anyone back.** electron-updater will not downgrade, so
whoever already installed the bad version stays on it until a *higher* version
replaces it. What this buys is that the bleeding stops in seconds instead of
over the hours it takes to build and ship N+1.

**Do not delete the GitHub release.** It used to be the mechanism and it is now
only the archive — deleting it changes nothing for users, and destroys the
artifacts you want during a post-mortem. Keep them:

```bash
gh release download v<bad-version> --dir ./forensics   # works on a private repo; gh is authenticated
```

### 2b. Ship forward

```bash
git checkout -b fix/<what-broke>
```

Revert the offending commit, verify on staging first (`npm run preview` →
install → confirm the failure is actually gone), merge to `main`, then:

```bash
npm run ship
```

`npm version patch` takes 0.3.79 → 0.3.80, which outranks the bad build, so the
affected users are offered the fix on their next check. Preflight will refuse if
`main` is dirty, out of sync, fails typecheck, or the version isn't above the
published one.

## Incident 3 — a bad environment variable

This is the most likely incident, and it has already happened twice: a
`SUPABASE_URL` with a `/rest/v1/` suffix, and a service key from the wrong
project. Both looked like a healthy deployment.

Fix the variable in the Vercel dashboard, then **redeploy** — env changes do not
reach an already-built deployment. `vercel rollback` will *not* help here,
because the old deployment reads the same (still wrong) variables.

Diagnose it from the relay's own log line, which names both project refs:

```bash
vercel logs folio-relay.vercel.app
```

A mismatch between `relayProjectRef` and `tokenIssuerRef` is the bug. Matching
refs plus `Invalid API key` means the service key is wrong.

## Incident 4 — a bad migration

There is no down-migration mechanism. Write the reverse SQL by hand, apply it to
**staging first**, confirm the relay still works there, then production.

Before touching anything destructive, remember `usage_log` feeds `relay_quota()`.
Deleting rows from it changes everyone's rate limit. Never run an unfiltered
`delete` against it.

---

## What cannot be rolled back at all

`TRACELY_API_URL` (or its default, `https://api.jointracely.com`),
`SUPABASE_URL`, and `SUPABASE_ANON_KEY` are inlined into the main bundle at
build time by `electron.vite.config.ts`. They have **no runtime
representation** — no setting, no config file, no override. (Builds from before
the move onto the Tracely server inlined `RELAY_URL` and `RELAY_TOKEN` instead,
and the same applies to them.)

If a shipped build points at the wrong host, or a token it uses is rotated, every
install of that version is permanently broken and only a new release fixes it.
This has happened once already: a token rotation stranded every install.

Two consequences worth holding onto:

- **Never retire a relay host or rotate `APP_SHARED_TOKEN` while builds
  referencing it are still in the wild.** Add the new one, wait for adoption,
  remove the old one last.
- **The relay must stay compatible with the previous app version.** Users cannot
  downgrade and many will not update promptly, so a relay change that only works
  with the newest client breaks everyone who hasn't clicked through two dialogs
  yet. This is the strongest argument for the staging environment: it is where
  you find that out.

## Drill it

A rollback path nobody has walked is a guess, not a plan — the same lesson the
branch guard taught, having silently denied the merge it was written to permit.

**Last run: 2026-08-09, on staging. It works.**

| Step | Result |
|---|---|
| `vercel rollback` to the previous deployment | 2s |
| Outage reproduced | 503, misconfigured relay |
| `vercel rollback` forward to the good deployment | 3s |
| Recovery verified | 400, auth passing |

Two things that run made obvious:

**You do not need to author a broken build.** Rolling back to a deployment that
predates a fix reproduces the real outage using real history. `vercel rollback`
takes an explicit deployment URL and moves in *both* directions, so the same
command undoes the drill.

**Verify recovery with an empty body, not a real request.** Posting
`{"text":""}` to `/api/detect-claims` passes `isAuthorized`, `resolveUser` and
the rate limit, then fails schema validation at line 32 — before `reserveUsage`
and before OpenAI. A **400 proves authentication resolved** and costs nothing.
A 503 means the relay is misconfigured; a 401 means the token was rejected.

```bash
$t = "<APP_SHARED_TOKEN>"; $at = "<a valid access token>"; try { (Invoke-WebRequest "https://tracely-relay-staging.vercel.app/api/detect-claims" -Method POST -ContentType "application/json" -Headers @{ "x-tracely-token" = $t; Authorization = "Bearer $at" } -Body '{"text":""}' -UseBasicParsing).StatusCode } catch { [int]$_.Exception.Response.StatusCode }
```

Re-run the drill after any change to `resolveUser`, the Vercel project wiring,
or the deployment protection settings.
