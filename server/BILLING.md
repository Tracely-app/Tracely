# Accounts, plans and billing

Tracely's server can enforce plans — which model a call is allowed to use, and
how many source searches a free account gets in a day — and can accept Stripe
webhooks that write the plan onto the account.

**All of it is optional.** With none of the variables below set, the server
behaves exactly as it did before any of this existed: nothing is clamped,
nothing is metered, `/api/entitlement` answers `free`, and the webhook route
answers 503. That is the supported way to run Tracely locally, and it is what
`node server.js` with the stock `.env` does.

## Env vars

Put these in `~/tracely/.env` (same file as `OPENAI_API_KEY`; the running
server picks up changes without a restart).

| Variable | Needed for | What it is |
| --- | --- | --- |
| `SUPABASE_URL` | reading plans | The Supabase project URL, e.g. `https://abcd.supabase.co`. **Setting this and `SUPABASE_ANON_KEY` is what turns enforcement on.** |
| `SUPABASE_ANON_KEY` | reading plans | The project's anon/publishable key. Used only to call `/auth/v1/user` with the caller's own token. |
| `SUPABASE_SERVICE_ROLE_KEY` | writing plans | The service role key. Only the webhook uses it, to PATCH `app_metadata`. Never send it to a client. |
| `STRIPE_WEBHOOK_SECRET` | webhook | The `whsec_…` signing secret for this endpoint. |
| `STRIPE_PRICE_STUDENT` | webhook | The Stripe price id sold as the Student plan. |
| `STRIPE_PRICE_PRO` | webhook | The Stripe price id sold as the Pro plan. |

The three groups are independent. Supabase alone gives you plan enforcement
with plans set by hand in the Supabase dashboard; add the Stripe variables when
checkout should set them.

## The plans

| Plan | Model ceiling | Source searches |
| --- | --- | --- |
| `free` | `gpt-5-nano` (Fast) | 5 per calendar day, per account |
| `student` | `gpt-5.4` (Balanced) | unlimited |
| `pro` | `gpt-6-astra` (Thorough) | unlimited |

The ids come from `lib/llm.js`'s `MODEL_TIERS` and are mirrored in
`shared/plan.js` and three extension files; `test/models.test.js` fails the
build if any copy drifts.

`free` is the answer to every question the server cannot answer — no token, an
expired token, Supabase unreachable, metadata holding something unexpected. It
never fails open, and it never returns an error for being signed out: an
anonymous caller is a free caller, so the extension keeps working signed out.

The vocabulary lives in `shared/plan.js`, deliberately mirroring the desktop
app's `src/shared/plan.ts`. Change one and change the other.

## How a plan is read

**`app_metadata.plan`, and nothing else.** That is the half of a Supabase user
only the service role can write, so it is the half the webhook can be trusted
to have set. Absent, junk, or a non-object all normalize to `free`.

`user_metadata` is **not** consulted, not even as a fallback. It is writable by
the account holder — one `PUT /auth/v1/user` with their own access token and
`{"data":{"plan":"pro"}}` sets it — so any path that reads it is a self-service
upgrade button. "Only when `app_metadata` is silent" does not rescue it: an
account that has never been through the webhook has no `app_metadata.plan` at
all, which describes every free account, so the fallback would be the only
source consulted for exactly the users who have not paid.

Resolutions are cached in memory for 60 seconds, keyed on a hash of the token.

## The model clamp

Every AI endpoint (`/api/check`, `/api/flow`, `/api/sources`) accepts an
optional `Authorization: Bearer <supabase access token>` header. Whatever model
the client asks for is a **request, never a grant**: the server picks a model
from its own cost tiering, then clamps it to the plan's ceiling. Responses
carry `plan` and `modelUsed` so the client can say what actually ran.

An unrecognised or absent model request resolves *down* to the fast model, not
up to the plan's ceiling — "the client sent nothing" must not become an Opus
bill, and the cheap default was the pre-entitlement behaviour of every route.

## Free-tier metering

Counted server-side in SQLite (`entitlement_usage`, one row per account per
calendar day), so a restart does not hand the quota back. The day boundary is
**local midnight**, not UTC — a UTC reset lands mid-evening in the US and would
expire someone's quota while they were still writing.

Only *identified* free accounts are metered. An anonymous caller is counted by
nothing, which is what keeps a signed-out local run unaffected. Over the limit
is a 429 naming the limit.

**That is also the meter's escape hatch, and it is only acceptable while this
server is loopback-only.** A free account that has spent its five searches can
send the next request without the `Authorization` header and be served as an
anonymous caller. Today the server binds `127.0.0.1` and is started by the same
person it would be metering, so there is nothing to defend; the moment this is
hosted, "anonymous ⇒ unmetered" has to become "anonymous ⇒ metered by something
else" (IP, install id) or the quota is decorative. The model clamp does not
share this problem — dropping the header downgrades you to `free`, which is the
strictest tier, so the only thing an attacker wins by going anonymous is a
worse model.

## The Stripe webhook

`POST /api/billing/webhook`, handling `checkout.session.completed`,
`customer.subscription.updated` and `customer.subscription.deleted`.

The signature is HMAC-SHA256 over `"{timestamp}.{raw body}"`, compared
timing-safely, rejecting timestamps more than five minutes old. **The raw body
is read and verified before anything parses it** — a re-serialized body is not
the bytes Stripe signed, and that failure is total and silent.

Every accepted event is recorded in `billing_events` keyed on Stripe's own
event id, so a retried delivery is a 200 that does nothing. A write that fails
returns 500 and is *not* recorded, so Stripe retries it.

An unrecognised price id changes nothing rather than downgrading — otherwise an
unset `STRIPE_PRICE_PRO` would revoke every Pro account at its next renewal. A
plan is only taken away by an event that says so: a deletion, or a subscription
that has stopped being active (`canceled`, `unpaid`, `incomplete_expired`).

### Setting it up

1. The checkout link **must** carry the Supabase user id as
   `client_reference_id` (`metadata.supabase_user_id` also works). That is the
   only place Stripe tells us which account paid; the customer id learned there
   is stored in `billing_customers` and is what later subscription events —
   which carry no user id at all — are resolved through. The email fallback
   pages the admin user list and is a last resort, not the design.
2. Point Stripe at the endpoint. The server listens on loopback and pins the
   `Host` header, so in development use the Stripe CLI, which forwards with the
   right host:

   ```
   stripe listen --forward-to localhost:4477/api/billing/webhook
   ```

   Paste the `whsec_…` it prints into `.env` as `STRIPE_WEBHOOK_SECRET`.
3. In production, terminate TLS in front of the server and forward with
   `Host: localhost:4477` preserved, or widen `hostAllowed()` in `server.js`
   deliberately — it is a DNS-rebinding guard, not an accident.

## Endpoints

```
GET /api/entitlement
  Authorization: Bearer <supabase access token>   (optional)
  200 → { plan, email, enforced, checkedAt }
  No or invalid token → 200 { plan: "free", email: null, enforced, checkedAt }

POST /api/billing/webhook
  Stripe-Signature: t=…,v1=…
  200 → { received: true, … }        400 → bad signature or body
  503 → billing is not configured    500 → not applied yet; Stripe retries
```

`enforced` is false when no Supabase project is configured, and it means the
server clamps **nothing** — not "everyone is free". The extension reads it and
opens every stop of its model slider in that mode, because locking the slider
and showing an upgrade prompt against a server that will serve Opus on request
would be a lie. Anything other than an explicit `false` is treated as enforced.

## Event outcomes, and which ones Stripe retries

`billing_events` records the outcome of every event that reached a decision.
Recording an event id is what stops Stripe retrying it, so anything that has
*not* reached a decision is deliberately left unrecorded and answered 500:

| outcome | recorded | meaning |
| --- | --- | --- |
| `applied` | yes | the plan was written to `app_metadata` |
| `no_plan` | yes | a settled answer — the price is not one of ours, so nothing changes (an unrecognised price is never a downgrade) |
| `ignored` | yes | an event type this server does not act on |
| `no_user` | **no → 500** | the event says "this account is Pro" but no Supabase user could be resolved yet |
| `failed:*` | **no → 500** | the Supabase write itself failed |

`no_user` is a missing prerequisite, not an answer. **Stripe does not guarantee
event ordering**, and `customer.subscription.created/updated` routinely arrives
*before* the `checkout.session.completed` that carries the Supabase user id —
so the one event that grants the plan can land while `billing_customers` still
knows nothing about that customer. Recording it would 200 the only event that
mattered and Stripe would never send it again: the customer pays and is never
upgraded. The 500 buys Stripe's retry schedule (~3 days of backoff), by which
time the checkout event has landed and the customer → user lookup resolves.
