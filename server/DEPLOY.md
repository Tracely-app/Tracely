# Deploying the Tracely API

The server as deployed on 2026-09-18, and how to redeploy it.

## Where it runs

`45.56.92.67` (Linode `psychtest_server`, Ubuntu 22.04, 2 cores, 3.9GB).

**This box is shared.** It already serves WealthPsychology, Ephor,
psychtest.app and a Flon agent. Everything below is deliberately additive: a
separate user, a separate systemd unit, and a new Apache vhost. No existing
vhost or service was edited, so a mistake in Tracely's config can only break
Tracely.

| | |
|---|---|
| code | `/srv/tracely/app` (rsync target; `--delete` is safe, see below) |
| data | `/srv/tracely/data` (SQLite; **outside** the rsync target on purpose) |
| config | `/srv/tracely/app/.env`, mode 600, owned by `tracely` |
| service | `tracely.service`, user `tracely`, bound to `127.0.0.1:4477` |
| logs | `/var/log/tracely.log`, `/var/log/apache2/tracely-{access,error}.log` |
| runtime | `/opt/node22/bin/node` |

## Two things that are not obvious

**Node lives in `/opt/node22`, not the system path.** `node:sqlite` needs
Node >= 22.5 and the system node is v20 — which the Flon agent on `:18770`
runs on. Upgrading system-wide to satisfy Tracely could break that app, so
Tracely carries its own runtime and the unit uses the absolute path.

**`TRACELY_DATA_DIR` is set in the UNIT, not in `.env`.** `lib/db.js` opens the
database at ESM import time, which happens before `server.js` reaches
`loadEnvFile()`. A `.env` line is read too late and the service fails to boot
with `ENOENT ... mkdir`. Every other variable belongs in `.env`.

## Redeploy

```sh
cd ~/tracely-repo
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .env \
  --exclude test --exclude .git --exclude '*.log' \
  server/ root@45.56.92.67:/srv/tracely/app/
ssh root@45.56.92.67 'chown -R tracely:tracely /srv/tracely/app && systemctl restart tracely'
```

`--delete` is safe: `.env` and `data` are both excluded, so rsync will not
remove them. The database is outside the target anyway.

The server has **zero runtime dependencies**, so there is no `npm install`
step. If one ever appears, this document is wrong.

## Not every .env value is hot-reloaded

`loadEnvFile()` runs at the top of each request, so anything read from
`process.env` AT REQUEST TIME picks up an edit with no restart — the API key,
the daily budget, the Stripe values.

Anything captured in a module-level `const` does not. Those are read once at
boot:

| variable | needs a restart |
|---|---|
| `TRACELY_EXTENSION_ID` | yes — `PINNED_EXTENSION` in server.js |
| `PORT` | yes |
| `TRACELY_DATA_DIR` | yes, and it must be a real env var, not a .env line |
| everything else | no |

This bites quietly: set `TRACELY_EXTENSION_ID`, watch a foreign origin still
get a 204, and conclude the pin does not work. It does; the process was still
holding the boot-time value. `systemctl restart tracely` and re-check.

## The API key

```sh
ssh root@45.56.92.67
sh /srv/tracely/app/scripts/set-openai-key.sh /srv/tracely/app/.env
```

It prompts with echo off, never touches shell history, and preserves the
file's ownership — root running it must not leave a root-owned `.env`, or the
service cannot read its own config and reports "no key configured", which
looks exactly like the script having failed.

`.env` is re-read on every request, so there is nothing to restart.

## Spend safety

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are **what switch enforcement on**. With
them absent the server behaves as a local install: nothing metered, nothing
clamped, and the most expensive model served to anyone who asks. Correct on a
laptop, ruinous on a public box. They are set here deliberately; do not remove
them to "simplify" the config.

`TRACELY_DAILY_BUDGET_USD=10` is the hard daily ceiling. An explicit `0` turns
it off; an empty value does **not** (it falls back to the built-in default).

`TRACELY_TRUSTED_PROXY_HOPS=1` because Apache is the one proxy in front. Wrong
here and rate limiting keys on the wrong address.

Watch it with:

```sh
curl -s -H 'Host: localhost:4477' localhost:4477/api/status
```

## Resource ceilings

The unit sets `MemoryMax=600M`, `MemoryHigh=450M`, `CPUQuota=120%`,
`TasksMax=256`. On a 3.9GB box running a live business, a Tracely leak or
traffic spike must degrade Tracely rather than take WealthPsychology down with
it. Raise these only with that in mind.

## Apache

`/etc/apache2/sites-available/zz-tracely-http.conf`, vhost for
`api.jointracely.com` proxying to `127.0.0.1:4477`.

`ProxyPreserveHost` is left **Off** deliberately. `hostAllowed()` in
`server.js` pins the Host header to the bind address as a DNS-rebinding guard,
so Apache has to send `Host: 127.0.0.1:4477`. Turning preserve-host on makes
every request 403.

`/.well-known/acme-challenge/` is excluded from the proxy so certbot can
answer HTTP-01 without going through the app.

## Release hosting — dl.jointracely.com

The desktop app's installers and its auto-update feed are served from this same
box, as static files, by a **second vhost**:
`/etc/apache2/sites-available/zz-tracely-dl.conf`, DocumentRoot
`/srv/tracely/releases`. It does not proxy to the Node server and has nothing to
do with the API.

**Why it exists.** The repo went private. electron-updater ships inside every
installed copy with no credentials and read release assets over GitHub's PUBLIC
API — so private would have stopped auto-update for everyone, silently, because
electron-updater logs the 404 and carries on. There is no token we could ship
instead: anything that can read a private repo's releases can read its source.

**Why its own hostname and not `api.jointracely.com/dl/`.** That URL is compiled
into `app-update.yml` inside every installer and can never be changed for copies
already out there. A separate name can be repointed at DNS level — at a CDN, at
another box — without touching the app.

| | |
|---|---|
| files | `/srv/tracely/releases` (owned by `tracelydl`, which owns nothing else) |
| upload | `scripts/publish-dl.mjs`, over scp, key at `~/.ssh/tracely-dl` |
| CI | the same key as the `DL_SSH_KEY` repo secret |
| feed | `latest.yml` (stable), `preview.yml` (preview channel) |
| stable links | `/download/Tracely-Setup.exe`, `/download/Tracely-arm64.dmg`, `/download/Tracely-x64.dmg` — symlinks the publish script repoints, so the website never needs editing per release |
| retention | last 10 stable and 3 preview builds per extension; anything a live feed or symlink names is kept regardless of age |

**Getting the upload key.** It is not in the repo. `~/.ssh/tracely-dl` on Sam's
machine and the `DL_SSH_KEY` secret in GitHub Actions are the same key; the
public half is in `tracelydl`'s `authorized_keys` on the box. To issue another,
generate a fresh pair and append the public half — do not copy the private one
around.

**Cache headers are deliberate and sit in two places.** Installers are
`immutable, max-age=31536000` (their bytes never change for a given URL); the
`.yml` files are `no-cache, must-revalidate` (they are the switch). The stable
`/download/` symlinks have to be `max-age=300`, and that header is set in a
`<LocationMatch>` rather than beside them in `<Directory>`, because Apache
merges `<LocationMatch>` LAST — the `<FilesMatch "\.(exe|dmg|zip|blockmap)$">`
rule would otherwise stamp them immutable and freeze every visitor's browser on
whichever version they downloaded first.

**Apache serves the upload user's home directory**, so `.ssh/authorized_keys`
literally sits under DocumentRoot. It is denied by an explicit `<DirectoryMatch>`
plus `<FilesMatch "^\.">`, and autoindex is off. Verify both after any vhost
edit — `curl -I https://dl.jointracely.com/.ssh/authorized_keys` must be 403.

## Still outstanding

1. **DNS for `dl.jointracely.com`.** The zone is on Vercel's nameservers
   (`ns1.vercel-dns.com`), where a wildcard currently answers `dl` with a Vercel
   404. Add an `A` record `dl -> 45.56.92.67` in the Vercel dashboard, then:
   ```bash
   certbot --apache -d dl.jointracely.com
   ```
   Until that lands, `publish-dl.mjs` uploads correctly and then fails its own
   HTTPS verification — deliberately, because a release nobody can download is
   not a release.

Everything else on this list is done and was verified live:

- ~~**DNS** for `api.jointracely.com`~~ — resolves to `45.56.92.67`.
- ~~**TLS**~~ — issued, and renewal was verified rather than assumed.
- ~~**The OpenAI key**~~ — set; `/api/status` reports `hasKey: true`.
- ~~**Pin the extension id**~~ — `TRACELY_EXTENSION_ID` is
  `dffmoeebkkghhgcklkbmaibfhgiegmdm`, which the manifest `key` pins for unpacked
  builds too, so one value covers the team's betas and the published extension.
  Verified live: our origin 204, a foreign extension 403, docs.google.com 204.
- ~~**Billing**~~ — `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STUDENT`,
  `STRIPE_PRICE_PRO` and `SUPABASE_SERVICE_ROLE_KEY` are all set; the webhook
  answers 400 to an unsigned request, which is it verifying signatures.

## Not done, and worth knowing

- No backups of `/srv/tracely/data`. The box has a 2-backup policy for
  WealthPsychology under `/root/backups`; Tracely is not in it.
- `ufw` is inactive on this host. Port 4477 binds loopback only so it is not
  exposed, but the box has no host firewall.
- No log rotation for `/var/log/tracely.log`.
