# server/ — the backend every client talks to (Sam deploys)

Read the root `CLAUDE.md` first. Runbooks: `DEPLOY.md` (deploy, rollback,
env), `BILLING.md` (plans, Stripe, Supabase), `scripts/healthcheck.sh`,
`STATUS.md` at the root for what is live. Zero npm dependencies: `node --test`
is the whole toolchain, and it also runs the extension's tests (`test/ext-*`).

## One backend, one reasoning implementation

- **Every AI call from every client goes to `server/`.** The desktop called a
  separate Vercel relay (`questionablepuddle/Tracely-relay`) until the backend
  unification; its prompts, schemas and guardrails moved into the server and
  nothing new ships to the relay. **v0.3.99 (2026-10-03) is the first stable
  release on the server.** Every stable release up to v0.3.97 (2026-08-23)
  predates the move, was compiled against the relay and the since-deleted
  Supabase project `epafyygdvvkgpdkbevqi`, and cannot sign in, so every AI
  call on it fails; 0.3.98-preview.251 (#251) and later previews call the
  server. (There was no stable 0.3.98: `ship` bumps the patch, and `main`
  already said 0.3.98.) A stable install is still a relay-era build until
  its user accepts the 0.3.99 update — production asks first, and
  electron-updater offers only a strictly higher version and cannot
  downgrade.
- **The prompts live in `server/lib/prompts/`**, one file per route, and
  `server/test/prompts.test.js` pins each one's SHA-256. Editing a prompt is
  allowed and should be a decision: every one carries numbers measured on real
  drafts, so re-measure, then update the hash.
- **The guardrails run on the server**, so every client gets them:
  `normalizeCritique` (a revision may only narrow; `fabricated` is withdrawn
  when no reference lookup ran) and `verifyGrade` (a finding whose quote is not
  in the draft is dropped), in `server/shared/`. The desktop still runs its own
  copies on the answer; both are idempotent.
- **A source search shows its receipts** (`lib/sourceVerify.js`, 2026-10-07;
  three judges found 16 of 51 "relevant" sources backed the sentence). Every
  source `/api/sources` returns is READ — the OpenAlex abstract, its
  open-access copy when the abstract does not settle it, else the page; never
  a PDF — and judged in the one existing verify call. It is
  `supports`/`refutes` only with a verbatim `quote` from that text, checked
  by `matchQuote` (whitespace, quote marks, dashes, case folded; word
  boundaries kept), and carries `verified`, `readFrom`, `quote` — additive,
  optional. Unread or unjudged is `context` + `verified: false`, never
  backing, which every installed extension already honours. Retracted works
  (Crossref `updated-by`/`update-to`, PubMed, OpenAlex `is_retracted`) are
  dropped; a DOI whose registered title or year is another work's is not
  applied (`lib/sourceEnrich.js` `sameWork`). The route's `verified` and
  `retracted` tallies are log-line only.
- **`server/lib/reasoning.js`** is the desktop's reasoning, one export per
  route, on the relay's request/response contract — which is why the desktop's
  request builders and parsers did not change when it moved.
- **The server picks the model per route** (plan policy of 2026-09-21,
  `server/shared/plan.js` `modelForRoute`): `gpt-5.6-luna` on every route and
  every plan — the most accurate and the cheapest model the blind-judged eval
  measured (`eval/models/FINDINGS.md`; re-run it before changing a tier or an
  effort) — and `gpt-6-astra` only for Pro's "Explain in depth" (`/api/check`
  `deep: true`) and desktop critiques, out of a $1.50/month Thorough allowance
  reserved per call, falling back to luna, never refused. Two tiers, `fast`
  and `thorough`; `gpt-5.6-terra` (balanced) is retired. The client's model
  id is read only on those two routes and only picks thorough over fast; the
  client's effort is never read on a hosted server (check `medium`, sources
  none, everything else `low`). A local server keeps `pickModel`. The ids are
  copied by hand into `server/shared/plan.js` and `src/shared/plan.ts`
  (`MODEL_FOR_TIER`); `server/test/models.test.js` fails if they drift. The
  extension still ships its three-stop slider (terra on the middle stop)
  until 2.20.0; `models.test.js` and `mirror-contracts.test.js` pin its ids
  to ones the server maps. Retired ids (`gpt-5-nano`, `gpt-5.4`,
  `gpt-5.6-terra`) are still SENT by shipped extensions and desktops:
  `LEGACY_MODEL_TIER` reads them all as fast — keep that map until no such
  build is in use; a desktop settings row holding `'balanced'` reads as fast
  too. Paid plans have no daily check limit but a per-account fair-use limit
  (Student $1/day $4/month, Pro $2/$8) that drops them to Free's limits;
  source searches are metered on every plan (5/40, 20/100, 40/250 a
  day/month). The reverse skew is NOT handled: a 2.19.3+ extension on a
  pre-2026-09-21 server runs `gpt-5-nano` at the Fast stop's `medium` (the
  eval's slowest config) and ignores the beta header, so deploy the server
  before any zip from the same change ships, beta included, and never roll it
  back to an older `app.bak-*` while 2.19.3+ is installed
  (`server/DEPLOY.md`, "The model tiers"; limits in `server/BILLING.md`).
- **Hand-copied logic is mirror-tested.** `server/shared/*` holds leaf ports of
  desktop modules (the splitters, `gradedDraft`, `normalizeCritique`,
  `narrowing`, the owner's `RUBRIC_TEXT`); `server/test/mirror.test.js` runs
  each side by side with its `src/` original. Change one side and the test
  names the other.
- **The provider is a seam.** `lib/llm.js` is a facade; everything
  OpenAI-specific is in `lib/providers/openai.js`, selected by
  `TRACELY_LLM_PROVIDER` (only `openai` is registered). Every error message on
  that path reaches the shipped extension verbatim — reword nothing there
  without an extension release in mind.

## Two products on one server: keep them apart

- **The extension's routes are FROZEN while a Web Store build is in review**:
  `/api/status /api/check /api/flow /api/sources /api/cite-url /api/docs/apply
  /api/entitlement`. Their response fields, error `kind`/`message` text, the
  401-then-anonymous behaviour, `corsHeaders()` (it must keep `Authorization`
  and `X-Tracely-Install`), port 4477, `api.jointracely.com`, the Supabase
  project, the three model ids, the plan names `free|student|pro` and the
  Stripe `PORTAL_URL` are all baked into the shipped extension. Changing any of
  them needs an extension release, not a server deploy.
- **The desktop's routes have their own guard rails and must never share the
  extension's**: `APP_AI_ROUTES` go through `appGate`/`appCall` — their own
  spend pool (`TRACELY_APP_DAILY_BUDGET_USD`), their own per-caller limiter,
  their own daily quota kind (`ai`: free 150/day, paid no daily limit but
  bounded by fair use), their own web-search window (source searches share
  one per-plan day/month count with the extension's). Shared, one busy desktop user on the thorough model could
  empty the extension's day and 503 every `/api/check`.
  `server/test/boundary.test.js` drives desktop traffic at a real mock server
  and asserts the extension's routes do not move.
- **A caller's model is never read from the global prefs row on a hosted
  server.** `PUT /api/prefs` is unauthenticated and that row is shared by every
  caller; it drives the model only on a local, single-user server (and a
  hosted server refuses the PUT outright).
- **The extension's model routes spend three pools** (`spendGate`): free
  callers the shared `extension` pool, Student/Pro the `paid` pool, test-build
  callers (`X-Tracely-Beta`) the `beta` pool. The paid and beta pools serve
  the thorough model, so they reserve each admitted call's worst case
  (`WORST_CALL`, `lib/spend.js` `reserveSpend`; a check's truncation split
  is admitted the same way, `reservation.extend`) and fall back — to the fast
  model, or to the caller's own plan — instead of ever 503ing. A pool that
  can reach expensive models must never share a day with free users.

## Accounts and billing

- One Supabase project, `sxifbtelrtbsgnnwnmdf`, for every surface. Stripe
  checkout → webhook → `app_metadata.plan` on the user (`server/BILLING.md`).
  `user_metadata` is user-writable and is never read for a plan.
- **Anonymous sign-ins are ON** on that project (checked 2026-09-22:
  `/auth/v1/settings` reports `external.anonymous_users: true`; #251's
  description predates this). A desktop built against `sxifbtelrtbsgnnwnmdf`
  signs in anonymously at boot and is metered as `user:<id>` on the free plan.
  Every call also carries `X-Tracely-Install` (a stable per-install UUID in
  `config.json`), which the server meters when there is no session — sign-in
  failed, or the build names another project.
- **The old production project `epafyygdvvkgpdkbevqi` is deleted** (its host
  no longer resolves). A build compiled against it — every stable release up
  to v0.3.97 — can never get a session.

## Where things are

- `server.js` — every route, inline. `EXTENSION_API` (~line 150) is the
  shipped contract: append, never remove. `PAID_ROUTES`, `APP_AI_ROUTES`,
  `MODEL_ROUTES` beside it say what spends, what is the desktop's, what is
  logged as a model failure.
- `lib/llm.js` → `lib/providers/openai.js` — the one model seam; prompts in
  `lib/prompts/` (SHA-pinned by `test/prompts.test.js`), the extension's check
  and source search in `lib/factcheck.js`, the desktop's reasoning in
  `lib/reasoning.js` (the relay's contract, byte-frozen prompts).
- `shared/` — leaf ports of desktop modules, mirror-tested
  (`test/mirror.test.js`, `test/mirror-contracts.test.js`); `shared/plan.js`
  is the plan policy, model tiers, allowances and effort per route;
  `shared/prices.js` the price table the spend cap does arithmetic with.
- `lib/spend.js`, `lib/entitlement.js`, `lib/billing.js`, `lib/db.js` — the
  cap, who is calling, Stripe, SQLite.
- `scripts/` — `pack-extension.sh`, `bump-extension.mjs`, `healthcheck.sh`,
  and two Linode-only scripts (`set-server-env.sh`, `deploy-openai-key.sh`).
- `public/app/` — the vanilla web app, served by `server.js`; local only.
- `eval/models/FINDINGS.md` (root) — every measured decision about models,
  efforts, prompts and costs. Re-measure before changing one; append a dated
  section after.
