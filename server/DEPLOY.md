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
the daily budgets, the Stripe values, `TRACELY_BETA_TOKENS` and
`TRACELY_BETA_DAILY_BUDGET_USD`.

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

**`PUT /api/prefs` is refused (403 `forbidden`) whenever Supabase is
configured.** The prefs row is one row shared by every caller and the route
has no authentication; on this box it used to let anyone with curl rewrite
it, and until 2026-09-21 that row chose the model every extension user's
`/api/check` ran at. `GET /api/prefs` still answers. Its only writers are the
web renderer bridge and the vanilla web app, both built for a LOCAL server
(the hosted box refuses their browser Origin anyway), so nothing hosted loses
anything. Hosted `/api/check` and `/api/sources` now run the model the client
asks for, clamped to the caller's plan — the prefs row drives the model only
on a local server.

Watch it with:

```sh
curl -s -H 'Host: localhost:4477' localhost:4477/api/status
```

## The test extension (beta build)

Everyone on the test extension is served as **Pro** on the extension's routes,
on a budget of its own. The test build is the Web Store build loaded unpacked
(the manifest `key` gives both the same id), so the server cannot tell them
apart by origin; instead the beta zip carries a token, and the extension sends
it as `X-Tracely-Beta` only when `beta.json` is packaged AND Chrome reports the
copy was loaded unpacked.

In `/srv/tracely/app/.env` (read per request — no restart):

| variable | meaning |
|---|---|
| `TRACELY_BETA_TOKENS` | comma-separated tokens; a caller presenting one gets max(plan, `pro`). **Empty or absent = beta off.** Rotate by adding the new token, shipping a new zip, then removing the old one. |
| `TRACELY_BETA_DAILY_BUDGET_USD` | the beta pool's daily ceiling, default `10`. Same parsing as the other budgets: empty or junk is the default, and an explicit `0` removes the CEILING (unlimited beta spend) — it does not turn beta off. |

What a matching token does, and does not:

- Applies on the extension's routes only (`spendGate` and `/api/entitlement`).
  The desktop's app routes never look at the header.
- `/api/entitlement` reports `plan: "pro"` and adds `beta: true`; a signed-in
  tester is still metered and billed as themselves.
- Spend goes to the **beta pool** (`__global_beta__` in `entitlement_usage`),
  never the extension pool. When the beta pool is spent (for source searches:
  when it reaches its own 20% shed line) the tester silently falls back to
  their own plan — usually free — on the extension pool. Beta never causes a
  503, and never draws on the extension pool while the beta pool can pay.
- `/api/status` gains `betaBudget` (same shape as `budget`) while any token
  is configured.

Build the zip from a checkout (never commit `extension/beta.json`; the repo is
public and `.gitignore` covers it):

```sh
TRACELY_BETA_TOKEN='<one of TRACELY_BETA_TOKENS>' server/scripts/pack-extension.sh --beta ~/Desktop
# -> ~/Desktop/Tracely-<version>-beta.zip, with beta.json in the staged copy only
```

A plain `pack-extension.sh [OUT_DIR]` excludes `beta.json` even if one is
lying in `extension/`. The token must be 1-200 characters of
`A-Z a-z 0-9 . _ ~ + / = -` (no commas: the server's list is comma-separated);
the script refuses anything else rather than build a zip that is silently free.
Generate one with `openssl rand -base64 24 | tr -d '\n'`.

## Model failures in the log

A truncated, refused or unparseable answer — or any other failed model call on
a model route, extension or desktop — writes one line to `/var/log/tracely.log`:

```
[tracely] model call failed route=/api/check kind=truncated status=502 model=gpt-5-nano effort=low
```

`kind` is `truncated`, `refusal`, `unparseable`, `empty`, `timeout`,
`network`, or the error kind. The line carries no user text, no message, and
no caller id — watch the rate, not the content:

```sh
grep -c 'model call failed' /var/log/tracely.log
grep 'model call failed' /var/log/tracely.log | awk '{print $5, $6, $8}' | sort | uniq -c
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

## Still outstanding

1. **DNS.** `api.jointracely.com` resolves to `64.29.17.65`, not this box. Point
   its A record at `45.56.92.67`. Until then the extension's hosted probe
   reaches the wrong host and TLS cannot be issued.
2. **TLS**, once DNS resolves here:
   `certbot --apache -d api.jointracely.com`
3. **The OpenAI key**, per above.
4. ~~Pin the extension id~~ — **done**. `TRACELY_EXTENSION_ID` is
   `dffmoeebkkghhgcklkbmaibfhgiegmdm`, which the manifest `key` pins for
   unpacked builds too, so one value covers the team's betas and the published
   extension. Verified live: our origin 204, a foreign extension 403,
   docs.google.com still 204.
5. **Billing**, when Stripe live setup is done: `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_STUDENT`, `STRIPE_PRICE_PRO`, and
   `SUPABASE_SERVICE_ROLE_KEY` (the webhook needs it to write plans).

## Not done, and worth knowing

- No backups of `/srv/tracely/data`. The box has a 2-backup policy for
  WealthPsychology under `/root/backups`; Tracely is not in it.
- `ufw` is inactive on this host. Port 4477 binds loopback only so it is not
  exposed, but the box has no host firewall.
- No log rotation for `/var/log/tracely.log`.
