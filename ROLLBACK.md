# Rollback

What to do when something that shipped is wrong. Read the first section before
you need it.

## The one thing to know

**The server reverts in about a minute. The desktop app and the extension
cannot be reverted at all.**

- `electron-updater` refuses a lower version and `allowDowngrade` is not set
  (`src/main/updater.ts`): the only way out of a bad desktop release is a
  *higher* one.
- The Chrome Web Store has no rollback either: a fixed build goes through
  review again (days), and users on the bad version stay there until it lands.

So the first question in any incident is **"can the server fix this
instead?"** Every client talks to it, it is versionless, and the backup taken
before each deploy is the previous version.

| Surface | Reversible? | How long | How |
|---|---|---|---|
| Server code | Yes | ~1 min | restore `app.bak-<ts>` (below) |
| Server env var | Yes | ~1 min | `server/scripts/set-server-env.sh`, restart |
| Desktop release | **No** — forward only | 20–40 min | stop the offer, ship N+1 |
| Extension | **No** — forward only | days | upload a fixed zip, wait for review |

## Incident 1 — the server is broken (Sam)

Every deploy first copies the live app to `/srv/tracely/app.bak-<timestamp>`
(`server/DEPLOY.md`). Restore the newest good one over the app, keeping the
live `.env`, and restart:

```sh
ssh root@45.56.92.67 'ls -d /srv/tracely/app.bak-*'
ssh root@45.56.92.67 'rsync -a --delete --exclude .env /srv/tracely/app.bak-<ts>/ /srv/tracely/app/ && chown -R tracely:tracely /srv/tracely/app && systemctl restart tracely'
server/scripts/healthcheck.sh
```

Then replace the server row in `STATUS.md` with the restored commit. Never
restore a backup from before 2026-09-21 while extension 2.19.3+ is installed
(`DEPLOY.md`, "The model tiers"). The SQLite database under
`/srv/tracely/data` is outside the app directory and is not touched by this.

## Incident 2 — a bad desktop release (Merrick)

Two moves, in this order. The first is fast and stops most of the damage; the
second is the fix.

### 2a. Stop the offer

Preserve the artifacts first — deleting a release cannot be undone, and the
`.exe` is the only evidence of what shipped:

```bash
gh release download v<bad-version> --dir ./forensics
```

Then delete the **release** (not the tag) on GitHub. electron-updater's GitHub
provider reads `latest.yml` from the newest non-prerelease release; removing
it makes the previous version current again. Do not mark it as a prerelease
instead — that release carries `latest.yml` and no `preview.yml`, so shelving
it into the prerelease slot confuses preview clients. Anyone already on the
bad version stays on it.

### 2b. Ship forward

Branch, revert the offending commit, verify in a preview build, merge to
`main`, then `/ship`. The bump outranks the bad build, so affected users are
offered the fix on their next check. Preflight refuses if `main` is dirty,
out of sync, fails typecheck, any server route 404s, or the version is not
above the published one.

## Incident 3 — a bad extension (Sam uploads, either fixes)

Fix on a branch, bump `manifest.json`, merge, build the store zip
(`docs/RELEASING.md`), upload, submit for review. Meanwhile, if the server
can make the bad build harmless — refuse a route, change a default, map a
model id — do that first (Incident 1's path, forward); the server is what
every installed extension talks to.

## Incident 4 — a bad environment variable (Sam)

`server/scripts/set-server-env.sh NAME` writes one value into the live `.env`
without it touching scrollback or history; some values need a restart
(`DEPLOY.md`, "Not every .env value is hot-reloaded"). Then
`healthcheck.sh`.

## What cannot be rolled back at all

`TRACELY_API_URL` (default `https://api.jointracely.com`), `SUPABASE_URL` and
`SUPABASE_ANON_KEY` are inlined into the desktop bundle at build time
(`electron.vite.config.ts`) with no runtime override; the extension bakes the
same host, the Supabase project and `EXTENSION_API`'s shapes into every store
build. If a shipped build points at a wrong host, or a value it uses is
rotated, every install of that version is broken until a new release. It
happened once: a token rotation stranded every install.

- Never retire a host or rotate a value while builds referencing it are in the
  wild. Add the new one, wait for adoption, remove the old one last.
- The server must stay compatible with the previous desktop version and every
  extension version still installed. Users cannot downgrade.

## Drill it

A rollback path nobody has walked is a guess. The server restore above has
**not yet been drilled on production**; the relay-era drill (2026-08-09) no
longer applies. Next deploy with a quiet hour: restore the pre-deploy backup,
run `healthcheck.sh`, restore the new build, run it again, and record the two
timings here.
