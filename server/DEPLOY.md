# Deploying the Tracely API

The server (what is live, and since when, is in `STATUS.md`), and how to redeploy it.

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

Deploy from a clean snapshot of `origin/main`, never from a working checkout
(on Sam's Mac other sessions and branches share `~/tracely-repo`), and take a
backup first:

```sh
git -C ~/tracely-repo fetch -q origin
git -C ~/tracely-repo worktree add --detach /tmp/tracely-deploy origin/main   # clean snapshot
SHA=$(git -C /tmp/tracely-deploy rev-parse HEAD)
printf '{"commit":"%s","deployedAt":"%s"}\n' "$SHA" "$(date -u +%FT%TZ)" > /tmp/tracely-deploy/server/release.json   # /api/status.release
ssh root@45.56.92.67 'cp -a /srv/tracely/app /srv/tracely/app.bak-$(date +%Y%m%d-%H%M%S)'
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .env \
  --exclude test --exclude .git --exclude '*.log' \
  /tmp/tracely-deploy/server/ root@45.56.92.67:/srv/tracely/app/
ssh root@45.56.92.67 'mkdir -p /srv/tracely/app/extension' && rsync -az /tmp/tracely-deploy/extension/content.js root@45.56.92.67:/srv/tracely/app/extension/content.js   # /ext-content.js, which /try runs
ssh root@45.56.92.67 'chown -R tracely:tracely /srv/tracely/app && systemctl restart tracely'
server/scripts/healthcheck.sh https://api.jointracely.com --commit "$SHA"
git -C ~/tracely-repo tag "server/$(date -u +%Y%m%d)-${SHA:0:7}" "$SHA" && git -C ~/tracely-repo push -q origin "server/$(date -u +%Y%m%d)-${SHA:0:7}"
git -C ~/tracely-repo worktree remove /tmp/tracely-deploy
```

`git tag -l 'server/*'` then answers what has been deployed and when, and
`curl -s https://api.jointracely.com/api/status` carries `release.commit`.

`--delete` is safe: `.env` and `data` are both excluded, so rsync will not
remove them. The database is outside the target anyway.

**Copy `extension/content.js` on EVERY deploy, after the server rsync** (the
line after it above). `/ext-content.js` is served from
`app/extension/content.js` (server.js `STATIC_FILES`), and that file lives
outside `server/`, so the `--delete` rsync removes it each time — a one-off
copy lasts until the next deploy. It is the extension engine the public
try-out page (`/try`, below) runs; without it `/try` loads a page that does
nothing. `healthcheck.sh` fails on a 404 there while the try-out is
configured. The copy is whatever main is at deploy time, which may be ahead
of the Web Store build.

Verify after every deploy with `server/scripts/healthcheck.sh` (the status
shape; that OpenAI accepts the key — `/api/status?keyCheck=1` has the server
try it with a free `GET /v1/models`, because `hasKey` only says a key is set
and said `true` through the 2026-10-13 outage of 503 `no_key` on every model
call; a bad token served as free, the extension's CORS allow and deny, the
prefs route refused; exits non-zero on the first failure, and on a rejected
key — a probe that cannot tell is a `WARN`), then **replace the
server row in `STATUS.md`** with the commit, the time and the backup name.
That row is how the other developer's agent learns the deploy happened.

**Roll back** by syncing the backup over the app (keep the live `.env`) and
restarting:

```sh
ssh root@45.56.92.67 'rsync -a --delete --exclude .env /srv/tracely/app.bak-<ts>/ /srv/tracely/app/ && chown -R tracely:tracely /srv/tracely/app && systemctl restart tracely'
```

Never restore an `app.bak-*` from before 2026-09-21 while extension 2.19.3 or
later is installed (see "The model tiers").

The server has **zero runtime dependencies**, so there is no `npm install`
step. If one ever appears, this document is wrong.

## Deploying from GitHub (`deploy-server`)

The same deploy, run by either developer from **Actions → deploy-server →
Run workflow** (main only). The workflow (`.github/workflows/deploy-server.yml`):

1. runs `server/` tests;
2. packs `server/` with the runbook's excludes, plus `extension/content.js` and
   `release.json`;
3. sends the package to the box;
4. runs `healthcheck.sh --commit`, three tries;
5. if the healthcheck fails, rolls back to the backup it just took;
6. pushes the `server/<date>-<sha>` tag.

Its summary prints the `STATUS.md` row to paste, because STATUS.md moves only
by PR. Deploying from the Mac (above) keeps working.

**What the key can do.** It logs in as `tracely-deploy`, never root. Its
`authorized_keys` line is `restrict,command="/usr/local/sbin/tracely-receive"`,
so whatever the client asks, that one script runs.

- `tracely-receive` (as `tracely-deploy`) accepts exactly two commands:
  `deploy <40-hex commit>` and `rollback app.bak-YYYYMMDD-HHMMSS`.
- It unpacks the upload in its own home, unprivileged, and checks it:
  - gzip and unpacked size are capped;
  - only `app/` at the top;
  - regular files and directories only (no links, no special files);
  - `server.js`, `package.json` and `extension/content.js` are present;
  - `release.json` names the commit asked for.
- Only then does it run `sudo tracely-install`, its single sudo rule. That
  root script repeats the runbook and nothing else:
  - `cp -a` backup;
  - an `rsync -rt` that skips links;
  - `chown`, then `systemctl restart tracely`;
  - if the service is not active 3 s later, it restores the backup by itself.
- It refuses to restore a backup older than 2026-09-21 (see "The model tiers").

A stolen key can deploy Tracely code. It cannot get a shell, touch another app
on this shared box, or read `.env`.

**Setup, once, by Sam** (the box and the org are his):

1. Make the key pair on the Mac. Keep no copy after step 4:
   `ssh-keygen -t ed25519 -N '' -C github-actions-tracely-deploy -f ./tracely-deploy`
2. Copy the scripts to the box and run the setup with the PUBLIC half:
   ```sh
   scp -r server/scripts/linode root@45.56.92.67:/root/tracely-linode
   ssh root@45.56.92.67 "sh /root/tracely-linode/setup-deploy-user.sh '$(cat tracely-deploy.pub)'"
   ```
   It creates the user, installs both scripts root-owned in `/usr/local/sbin`,
   checks the sudo rule with `visudo` before installing it, and writes the
   key. It then prints:
   - any `AllowUsers`/`AllowGroups` line in sshd's config (add
     `tracely-deploy` if there is one);
   - the host key line.
3. If a firewall limits port 22 to known addresses, GitHub's runners need to
   reach it. Their addresses change; check before the first run.
4. GitHub → Tracely-app/Tracely → Settings → Environments → **New environment
   `production`**:
   - **Deployment branches: `main` only.** This is what keeps the key away
     from a workflow on any other branch.
   - Secret `LINODE_DEPLOY_KEY`: the private half (`cat tracely-deploy`). Then
     `rm tracely-deploy tracely-deploy.pub`.
   - Variable `LINODE_KNOWN_HOSTS`: the host key line step 2 printed
     (`45.56.92.67 ssh-ed25519 AAAA…`). Compare it with
     `ssh-keygen -F 45.56.92.67` on the Mac first.
   - Optional: required reviewers. A run then waits for a click from one of
     you.
5. Run the workflow once. Check the healthcheck, the tag and `/api/status`.

**Deploy on every merge** is off. Repo variable `AUTO_DEPLOY_SERVER=true` turns
it on for pushes to main that touch `server/` or `extension/content.js`. Agree
on it first: a merge whose code needs a new `.env` value would go live before
anyone set it.

**Revoke** by deleting the `authorized_keys` line, or the secret.

**Each deploy leaves a backup** in `/srv/tracely`, as the runbook does.
Deleting old `app.bak-*` stays a decision for both developers.

## Not every .env value is hot-reloaded

`loadEnvFile()` runs at the top of each request, so anything read from
`process.env` AT REQUEST TIME picks up an edit with no restart — the API key,
the daily budgets (`TRACELY_DAILY_BUDGET_USD`, `TRACELY_PAID_DAILY_BUDGET_USD`,
`TRACELY_BETA_DAILY_BUDGET_USD`, `TRACELY_APP_DAILY_BUDGET_USD`,
`TRACELY_DEMO_DAILY_BUDGET_USD`), the Stripe values, `TRACELY_BETA_TOKENS`
and the try-out's settings (`TRACELY_DEMO_SECRET`, `TRACELY_PUBLIC_ORIGIN`,
`TRACELY_DEMO_CHECKS` / `_SOURCES` / `_REVIEWS`).

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
`/api/flow` and `/api/sources` run luna on every plan (the server decides;
the widget's slider is ignored), except Pro's "Explain in depth", which may
run `gpt-6-astra` — 40-50x the fast model per token — out of the account's
monthly Thorough allowance. Paid and beta spend must still never 503 every
free user, so:

| pool | who | ceiling | when it is spent |
|---|---|---|---|
| extension | free callers, and anyone falling back | `TRACELY_DAILY_BUDGET_USD` (10) | 503 for everyone on it, as always |
| paid | Student/Pro accounts | `TRACELY_PAID_DAILY_BUDGET_USD` (10) | they run the FAST model on the extension pool; plan and quotas unchanged |
| beta | test-build callers (below) | `TRACELY_BETA_DAILY_BUDGET_USD` (10) | they run their own plan on the extension pool |
| demo | the public try-out page (`/try`, below) — not an extension route | `TRACELY_DEMO_DAILY_BUDGET_USD` (2) | 503 `demo_closed` on the try-out only; **never** falls back |

The first three follow the same parsing (empty or junk = default, explicit
`0` = no ceiling); the demo pool reads absent or empty as its default, and
ANYTHING else that is not a positive number (`0`, `0 # off`, `off`, `-1`)
switches the try-out OFF. The paid, beta and demo pools admit
a call only while their spend PLUS the worst case of every call still in flight leaves room: the worst
case is the route's output ceiling plus its largest input on the fast model
(~2.5 cents for a check, every input token priced as a cache write,
`WORST_CALL` in server.js); an "Explain in depth" admitted to the thorough
model holds its own worst case on top (`admitThorough`: its prompt's bytes
plus 2,000 output tokens on astra, at least 15 cents), which is
what bounds a beta tester who rotates install ids to get fresh allowances. A check that truncates splits
into two more calls, recursively; each split is admitted the same way (two
more worst cases held, or no split and a `truncated` error), and so are a
sharded check's extra calls and a shard's one retry for ids the model left
out (one worst case each, or one call / no retry). A source search's worst
case includes its second call, the receipts check (`verifySources`). So a burst —
including one with a rotating install id per request — overshoots by at most
the last admission (one call, or a split's two), and the number of thorough
calls those pools run AT ONCE is about the remaining budget ÷ 17.5 cents.
Raise the ceiling for a bigger team, not the reservation. A call that fails after
OpenAI billed it (truncated, refused, unparseable) is recorded into its pool
too, including every call of a split that failed part-way. A source search
records the web_search fee once per `web_search_call` its answer carried
(never fewer than one): a reasoning model can search, and open pages, more
than once per answer. Nothing we send bounds that, so the sources
reservation (40k input tokens and 3 searches for the search, plus 8k input
for the receipts call) is an allowance sized above the most seen live, not a
bound.

`TRACELY_TRUSTED_PROXY_HOPS=1` because Apache is the one proxy in front. Wrong
here and rate limiting keys on the wrong address.

**`PUT /api/prefs` is refused (403 `forbidden`) whenever Supabase is
configured.** The prefs row is one row shared by every caller and the route
has no authentication; on this box it used to let anyone with curl rewrite
it, and until 2026-09-21 that row chose the model every extension user's
`/api/check` ran at. `GET /api/prefs` still answers. Its only writers are the
web renderer bridge and the vanilla web app, both built for a LOCAL server
(the hosted box refuses their browser Origin anyway), so nothing hosted loses
anything. On a hosted server the SERVER picks the model and effort for every
route (`shared/plan.js` `modelForRoute`; server/CLAUDE.md, "The server picks
the model per route"). The client's model id only chooses Pro's thorough model
on a thorough route, and its effort is never read. The prefs row drives the
model only on a local server. (This paragraph used to say hosted routes run
the client's model and effort; that stopped being true on 2026-09-21. Do not
restore it.)

Watch it with:

```sh
curl -s -H 'Host: localhost:4477' localhost:4477/api/status
```

## The try-out page (`/try`)

`https://api.jointracely.com/try` is a public, capped demo document: an
editable sample essay running the extension's own engine (`/ext-content.js`,
copied on every deploy — see Redeploy), framed by the website's `/try/` page.
Its calls go to `/api/demo/check`, `/api/demo/sources` and
`/api/demo/review`, which run the same handlers as `/api/check`,
`/api/sources` and `/api/review` behind their own gate (server.js `demoGate`,
lib/demo.js) and their own pool. Nothing about the extension's routes, their
origins or their CORS changes.

In `/srv/tracely/app/.env` (read per request — no restart; comments on their
own lines, since `loadEnvFile()` keeps a trailing `# ...` as part of the value):

```sh
# Signs the visitor cookie; empty, absent or under 32 characters = the
# try-out is OFF. Generate once with: openssl rand -hex 32
TRACELY_DEMO_SECRET=
# The page's own origin: it may reach the demo routes and static files only.
TRACELY_PUBLIC_ORIGIN=https://api.jointracely.com
# Optional, shown at their defaults. A budget of 0 — or anything that is not
# a positive number, e.g. "2 # note" — turns the try-out OFF.
# TRACELY_DEMO_DAILY_BUDGET_USD=2
# TRACELY_DEMO_CHECKS=10
# TRACELY_DEMO_SOURCES=2
# TRACELY_DEMO_REVIEWS=2
```

What bounds it, in the order `demoGate` checks:

- **Off** without a secret, with one under 32 characters (`off`, `0`, the
  `# off` of an inline comment), or with a budget that is not a positive
  number (`0`, `off`, `-1`): `503 demo_closed`, and the server logs which at
  boot. Never a per-boot random secret — a restart would hand every visitor a
  new allowance.
- **The visitor cookie** `tracely_demo` (HttpOnly, Secure, SameSite=Lax, a
  day), minted by `GET /try`, HMAC-signed with the secret. Missing or forged:
  `403 demo_session`. Rotating the secret invalidates every cookie; the page
  mints a new one on reload.
- **The free plan**, enforced even though the caller is anonymous: the fast
  model, "Explain in depth" refused, the beta header ignored.
- **The demo pool**: the gate asks for room, and every call reserves its
  worst case once its body has been read and validated (`demoAdmit`) — never
  before, or a body sent a byte at a time would hold a reservation for free
  (a demo body has 10 seconds to arrive; only `POST` reaches the gate). A
  burst of fresh cookies overshoots by one call at most. Spent: `503
  demo_closed` ("comes back at midnight") on the try-out — the extension's
  pool is never touched. Room taken only by calls in flight: `503 demo_busy`
  ("try again in a minute"), and `/api/demo/status` stays `open` with
  `busy: true`. Below 20% left, source search pauses on the try-out; checks
  go on.
- **Per visitor per day**: 10 checks, 2 source searches, 2 writing reviews
  (`429 demo_limit` with `feature`). Fairness, not a cap: a private window
  mints a fresh cookie.
- **Per address**, in any rolling hour (`429 rate_limit`) — never a daily
  count, since a school is one address: 200 demo calls, and an eighth of the
  day's pool in dollars ($0.25 of $2), counting what the address's calls
  were charged plus what its calls in flight hold, so a burst of fresh
  cookies from one machine is bounded too. Keyed on
  `TRACELY_TRUSTED_PROXY_HOPS`, like every other address key.
- **A check's own ceiling**: 6,000 output tokens (the extension's is
  16,000), so its worst case — what each call holds — is ~0.92 cents
  (`WORST_CALL["/api/demo/check"]`), not 2.5.
- **Its own web-search window**: 10 an hour, apart from the store users' 15.
- **Text caps**: 3,000 characters a check or review, and 40 sentences a
  check — whose sentences (what the model is actually sent) must each be in
  the text and add up to no more than 3,000 characters; a source search's
  claim and correction up to 600 characters each and 1,500 characters of
  context (`400`).

`/try` is served with `Content-Security-Policy: frame-ancestors
https://jointracely.com https://www.jointracely.com` (no `X-Frame-Options`)
and `Cache-Control: no-store`; no other page carries either header. Worst
case: $2 × 31 ≈ $62 a month (BILLING.md). Watch `demoBudget` on
`/api/status`, which appears only while `TRACELY_DEMO_SECRET` is set; turn the
try-out off with `TRACELY_DEMO_DAILY_BUDGET_USD=0` or by emptying the secret.
After a deploy, `healthcheck.sh` checks `/try` (200, frame rule) and
`/ext-content.js` (200) whenever `demoBudget` is present; pass `--demo` to
insist on it.

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
- Builds before 2.20.0 defaulted to the options-page slider (Fast until a tester moved
  it); the beta grant raises the ceiling, not the default stop.

Build both zips from a checkout (never commit `extension/beta.json`; the repo
is public and `.gitignore` covers it) — and only once the server from the same
change is deployed (see "The model tiers" below). The two zips have different
layouts, because their consumers disagree about where `manifest.json` goes:

```sh
server/scripts/pack-extension.sh ~/Desktop
# -> ~/Desktop/Tracely-<version>-store.zip: the Web Store upload.
#    manifest.json at the ZIP ROOT (the store rejects a foldered zip), no beta.json.

TRACELY_BETA_TOKEN='<one of TRACELY_BETA_TOKENS>' server/scripts/pack-extension.sh --beta ~/Desktop
# -> ~/Desktop/Tracely-<version>-beta.zip: for testers. Everything inside a
#    Tracely-<version>-beta/ folder, because Load unpacked installs a folder;
#    beta.json is written into the staged copy only.
```

`OUT_DIR` defaults to `~/Desktop`. The store build excludes `beta.json` even if
one is lying in `extension/`. Each build then checks the zip it produced and
deletes it, exiting non-zero, if the layout is wrong: the store zip must have
`manifest.json` at the root and no `beta.json` anywhere; the beta zip must have
`Tracely-<version>-beta/manifest.json` and exactly one `beta.json`, at
`Tracely-<version>-beta/beta.json`, holding the token, with nothing outside
that folder. Before #256 the plain build produced `Tracely-<version>.zip`
with the same folder wrapper as the beta, which is not a valid store upload;
do not upload a zip with that name.

The manifest's `key` ships unchanged in both zips: it is the store item's
public key and pins the id for unpacked builds (`TRACELY_EXTENSION_ID`, see
"Still outstanding" below). Verify it on the first store upload of a
root-layout zip. If the store rejects the zip over `key`, strip it from the
script's STAGED store copy, never from `extension/`.

The token must be 1-200 characters of `A-Z a-z 0-9 . _ ~ + / = -` (no commas:
the server's list is comma-separated); the script refuses anything else rather
than build a zip that is silently free. Generate one with
`openssl rand -base64 24 | tr -d '\n'`.

## The model tiers (remapped 2026-09-21, two tiers since the plan policy)

fast `gpt-5.6-luna`, thorough `gpt-6-astra` (`lib/llm.js` MODEL_TIERS),
chosen by the eval in `eval/models/FINDINGS.md`. The old balanced tier
(`gpt-5.6-terra`) is retired: it lost to luna on both measured tasks at ~8-10x
the cost. On a hosted server the SERVER picks model, effort and output ceiling
per route (`shared/plan.js` `modelForRoute`) — luna on every route and plan,
astra only for Pro's "Explain in depth" (`/api/check` `deep: true`) and
desktop critiques, out of a $1.50 monthly allowance. BILLING.md "The plans"
has the limits. Before a deploy that changes a tier, know these things:

- **Deploy this server BEFORE any extension zip from the same change reaches
  a user**, beta or store, and never roll the server back to a snapshot from
  before 2026-09-21 (`app.bak-*`) while 2.19.3 or later is installed. The
  skew is harmless one way and not the other. An old client on this server
  is translated (below). A 2.19.3+ client (2.19.4 included) on an OLD server
  is not: its Fast
  stop sends `effort: "medium"`, and the old hosted `/api/check` ran
  `gpt-5-nano` at whatever effort the client sent — nano at medium, which
  the eval measured at p50 41.5 s / p90 62.4 s and 3.2x the cost of nano at
  low, for 76% accuracy, on the shared extension pool. An old server also
  ignores `X-Tracely-Beta`, so testers are served as free. Before
  `pack-extension.sh --beta` hands anyone a zip, confirm the new build is
  live: `curl -s -H 'Host: localhost:4477' localhost:4477/api/status` shows
  `paidBudget` (absent before this build), and `/api/entitlement` with
  `X-Tracely-Beta: <token>` answers `beta: true`.

- **Old clients keep sending the old ids.** Extension <= 2.19.2 sends
  `gpt-5-nano` and `gpt-5.4`, 2.19.3-2.19.5 send `gpt-5.6-terra`; older
  desktops send the same. The server reads all three as fast
  (`shared/plan.js` `LEGACY_MODEL_TIER`); since 2.20.0 the server picks the
  model and the client's id only chooses thorough over fast on the two routes
  that allow it. Keep the map until no such build is installed.
  Nothing runs, or logs a retired id; terra keeps its price row only so old
  usage still prices.
- **The client's effort is never read on a hosted server.** `/api/check` runs
  luna at `medium` (100% in the eval, against 90% at low), `/api/sources`
  sends no effort (the vendor default every search was measured at), and
  every other route runs at `low`; astra runs at `low`, its only measured
  level. Shipped extensions sent `medium` or `high`, and on flow, critique,
  correction, structure and find-sources that used to pass straight through.
  A local server (unenforced) keeps `pickModel` and `checkEffort` as before.
- **Extensions before 2.20.0 re-ran flow up to ~72 times an hour** while
  someone typed at the end of a document. The server holds every caller to
  one `/api/flow` call per 120 s (a 429 their `requestFlow` swallows silently)
  and a daily flow quota; 2.21.2+ no longer calls `/api/flow` at all.
- **Scale the paid and app pools with subscribers.** A regular Pro user
  spends about 9 cents a day and a regular Student about 4, so set
  `TRACELY_PAID_DAILY_BUDGET_USD` and `TRACELY_APP_DAILY_BUDGET_USD` to
  max(10, 0.15 x paying subscribers); at the defaults they become the binding
  limit at roughly 110-240 active regular users a day.
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

On `/api/check`, `kind=timeout` is now one SHARD that missed its 30 s
deadline (`CHECK_SHARD_TIMEOUT_MS`, `lib/factcheck.js`, env
`TRACELY_CHECK_SHARD_TIMEOUT_MS`), not necessarily a failed check: when
another shard answered, the check returns those findings and the extension
re-sends the omitted ids after its 30 s hold. Count them to watch the hang
rate:

```sh
grep 'route=/api/check kind=timeout' /var/log/tracely.log | wc -l
```

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

**The live source search streams** (`POST /api/sources/stream`, server-sent
events, 2026-10-08): its events must reach the browser as they are written.
The route sends `Cache-Control: no-cache, no-transform`, which keeps
`mod_deflate` from compressing (and so holding) them. To check after a deploy:
`curl -N -X POST https://api.jointracely.com/api/sources/stream -H 'Content-Type: application/json' -d '{"claim":"Water boils at 100 C at sea level."}'`
should print `data: {"type":"searching"}` at once and the rest over ~10 s
(it is one real, metered search). If it all arrives at the end, add
`SetEnvIf Request_URI "^/api/sources/stream" no-gzip` and `flushpackets=on` on
the `ProxyPass` line. Nothing breaks either way: a buffered stream is just a
search that looks like the old one.

## Open ops debt

Everything that was outstanding at launch is done (DNS, TLS, the key, the
pinned extension id, billing — all verified live). What is still open, each
Sam's to schedule:

- **No backups of `/srv/tracely/data`** (WAL-mode SQLite: back it up with
  `sqlite3 … "VACUUM INTO"`, not `cp`). The box's 2-backup policy covers
  WealthPsychology only.
- **No logrotate entry for `/var/log/tracely.log`.**
- **`ufw` is inactive** on the host; port 4477 binds loopback only.
- **Release hosting** (`dl.jointracely.com`, #242) waits on an `A dl 45.56.92.67`
  record in the zone — Merrick's Vercel — then `certbot --apache -d dl.jointracely.com`.
  Until then desktop updates come from GitHub Releases and the repo stays public.

## Data kept, and for how long

What the privacy policy (PRIVACY.md) promises, and where it is enforced:

- **Usage counters** (`entitlement_usage`): 13 months. `usagePurgeBefore`
  runs at boot and daily (server.js `sweepUsage`).
- **Billing events**: the Stripe payload is stored WITHOUT the payer's name,
  address or phone (lib/billing.js `redactStripeEvent`); the email stays —
  it is how a purchase finds its account.
- **Account deletion**: `DELETE /api/account` with the user's token purges
  their counters, customer links and unclaimed purchases, blanks their
  billing payloads, and deletes the Supabase user (lib/db.js `accountPurge`,
  lib/billing.js `deleteSupabaseUser`). Refused (409) while a paid plan is
  active — the subscription is Stripe's to end. The options page offers it.
- **Application log** (`/var/log/tracely.log`): route, kind, status, model —
  never text, emails, tokens or IPs. Rotate it: there is no logrotate entry
  yet (Apache's own logs rotate daily, 14 kept).
