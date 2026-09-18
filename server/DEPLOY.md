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

## Still outstanding

1. **DNS.** `api.jointracely.com` resolves to `64.29.17.65`, not this box. Point
   its A record at `45.56.92.67`. Until then the extension's hosted probe
   reaches the wrong host and TLS cannot be issued.
2. **TLS**, once DNS resolves here:
   `certbot --apache -d api.jointracely.com`
3. **The OpenAI key**, per above.
4. **Pin the extension id** once it is assigned by the Chrome Web Store:
   `TRACELY_EXTENSION_ID=<id>` in `.env` narrows the CORS allowlist from "any
   chrome-extension:// origin" to just ours.
5. **Billing**, when Stripe live setup is done: `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_STUDENT`, `STRIPE_PRICE_PRO`, and
   `SUPABASE_SERVICE_ROLE_KEY` (the webhook needs it to write plans).

## Not done, and worth knowing

- No backups of `/srv/tracely/data`. The box has a 2-backup policy for
  WealthPsychology under `/root/backups`; Tracely is not in it.
- `ufw` is inactive on this host. Port 4477 binds loopback only so it is not
  exposed, but the box has no host firewall.
- No log rotation for `/var/log/tracely.log`.
