---
description: Free health check of the production server, and what is live
---

Check that Tracely's backend is actually working. **This costs nothing** — the
one probe that reaches OpenAI is the server's `GET /v1/models` key check, which
runs no model — so it is safe to run against production any time. Report each check as pass or fail with the evidence; a check you could not
perform is not a check that passed.

## 1. Run the script

`server/scripts/healthcheck.sh` does sections 1 and 2 below in one go and
exits non-zero on the first failure. Run it, then do 3 and 4.

## 1b. The server is up and can spend

`GET https://api.jointracely.com/api/status?keyCheck=1` must answer JSON with
`hasKey: true`, `mock: false`, `budget.enforced: true` and a `paidBudget`
object. A 404, an HTML page or `mock: true` means this is not the production
server. No token is needed.

`keyCheck.valid: true` means OpenAI accepts the key. `hasKey` only says a key
is set: it stayed `true` through the 2026-10-13 outage, when every model call
answered 503 `no_key`. `false` is that outage, and a fail. `null` means OpenAI
could not be asked, so report it as unverified rather than passed. If there is
no `keyCheck` at all, the server is a build from before it.

## 2. The runbook checks (server/DEPLOY.md, "Verify after every deploy")

- `GET /api/entitlement` with a bad bearer token → `200` and `plan: "free"`.
- `OPTIONS /api/check` with `Origin: chrome-extension://dffmoeebkkghhgcklkbmaibfhgiegmdm`
  → `204`; the same from any other extension id → `403`.
- `PUT /api/prefs` → `403` (a hosted server refuses it).

## 3. Every desktop endpoint is live

`node scripts/preflight.mjs` probes every route in `callServer`'s union. A
`404` means the server was not deployed with the client — the failure that
shipped in v0.3.73.

## 4. What is live matches the record

Compare with `STATUS.md` (server commit and deploy time, store extension
version, desktop stable). If they disagree, fixing `STATUS.md` is part of the
report.
