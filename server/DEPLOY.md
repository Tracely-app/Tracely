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
the daily budgets (`TRACELY_DAILY_BUDGET_USD`, `TRACELY_PAID_DAILY_BUDGET_USD`,
`TRACELY_BETA_DAILY_BUDGET_USD`, `TRACELY_APP_DAILY_BUDGET_USD`), the Stripe
values and `TRACELY_BETA_TOKENS`.

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

**The extension's routes spend three pools, not one.** Hosted `/api/check`,
`/api/flow` and `/api/sources` run the model the widget's slider asks for,
clamped to the plan — up to `gpt-6-astra`, 40-50x the fast model per token.
One Pro user on "Smarter" could empty a shared $10 day in minutes and 503
every free user, so:

| pool | who | ceiling | when it is spent |
|---|---|---|---|
| extension | free callers, and anyone falling back | `TRACELY_DAILY_BUDGET_USD` (10) | 503 for everyone on it, as always |
| paid | Student/Pro accounts | `TRACELY_PAID_DAILY_BUDGET_USD` (10) | they run the FAST model on the extension pool; plan and quotas unchanged |
| beta | test-build callers (below) | `TRACELY_BETA_DAILY_BUDGET_USD` (10) | they run their own plan on the extension pool |

All three follow the same parsing (empty or junk = default, explicit `0` =
no ceiling). The paid and beta pools admit a call only while their spend
PLUS the worst case of every call still in flight leaves room: the worst
case is the route's output ceiling plus its largest input at the plan's top
model (~$1.10 for a thorough check, every input token priced as a cache
write, `WORST_CALL` in server.js), shrunk to the
model actually chosen once the body is read. So a burst — including one with
a rotating install id per request — overshoots by at most one call, and the
number of thorough calls those pools run AT ONCE is about the remaining
budget ÷ $1.10. Raise the ceiling for a bigger team, not the reservation.
A call that fails after OpenAI billed it (truncated, refused, unparseable)
is recorded into its pool too.

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
on a local server. `/api/sources` sends the client's reasoning effort when it
sends one (the 2.19.3 widgets do) and otherwise none, i.e. the vendor's
default, exactly as every source search from the store build always has.

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
  never the extension pool. When the beta pool has no room — checks and
  source searches alike, counting calls in flight (see Spend safety) — the
  tester silently falls back to their own plan, usually free, on the
  extension pool. Beta never causes a 503, and never draws on the extension
  pool while the beta pool can pay.
- Beta source searches count against their own window
  (`SPEND.betaWebSearchesPerHour`, 30/hour for all testers together), not the
  15/hour one every store user shares — testers are Pro, with no daily source
  quota, and could otherwise take the whole hour.
- `/api/status` gains `betaBudget` (same shape as `budget`) while any token
  is configured, and `paidBudget` always. Both report spend on disk, not
  reservations in flight.
- The widgets default to the options-page slider (Fast until a tester moves
  it); the beta grant raises the ceiling, not the default stop.

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

## The model tiers (remapped 2026-09-21)

fast `gpt-5.6-luna`, balanced `gpt-5.6-terra`, thorough `gpt-6-astra`
(`lib/llm.js` MODEL_TIERS), chosen by the eval in `eval/models/FINDINGS.md`.
Before a deploy that changes a tier, know three things:

- **Old clients keep sending the old ids.** Extension <= 2.19.2 (the Web
  Store build under review included) sends `gpt-5-nano` from Fast and
  `gpt-5.4` from Balanced; older desktops send the same. The server
  translates them to their tier's current model (`shared/plan.js`
  `currentModelId`), so a deploy needs no extension release. Nothing runs,
  prices or logs a retired id.
- **`/api/check` runs the fast tier at effort medium or above**, whatever the
  client sends (`checkEffort` in server.js) — the measured best config. Every
  other route keeps the client's effort or the default (`low`).
- **Every tier id must be in `shared/prices.js` before it serves traffic**,
  with its `cacheWrite` rate. An unpriced id is billed as the thorough model
  (40-50x luna per token), which would trip the spend cap early; a missing
  `cacheWrite` would under-count every cold call on these models, which bill
  a first-seen prefix at 1.25x input
  (`usage.input_tokens_details.cache_write_tokens`).

## Model failures in the log

A truncated, refused or unparseable answer — or any other failed model call on
a model route, extension or desktop — writes one line to `/var/log/tracely.log`:

```
[tracely] model call failed route=/api/check kind=truncated status=502 model=gpt-5.6-luna effort=medium
```

`kind` is `truncated`, `refusal`, `unparseable`, `empty`, `timeout`,
`network`, or the error kind. The line carries no user text, no message, and
no caller id — watch the rate, not the content. (What such a call was billed
is recorded into its spend pool; the log line does not carry the cost.)

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
