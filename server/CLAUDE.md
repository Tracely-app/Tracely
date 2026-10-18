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
  `retracted` tallies are log-line only. A judge that split the claim into
  parts (#327: `supports` only with a quote for every part, `refutes` on any
  one part) was live from 2026-10-13 and reverted the same day. On the same
  310 judged sources, the good "backs" it kept fell from 34 to 9, and 23 of
  its 26 "contradicts" were wrong (`eval/goldset/README.md`). Measure any
  change to the judge with `eval/goldset/run-verify-prod.mjs` before it ships.
  A "backs" whose quote does not show the figure the sentence states ("roughly
  70 percent" backed by "8 to 10 hours") is `context`, with no model involved
  (`lib/claimFigures.js`, tallied `figures=`). Measured free on recorded
  runs with `eval/goldset/figures.mjs`.
  **Trim a detail** (owner, 2026-10-13): when nothing backs the whole sentence,
  a second, separate call (`coverDetail`, `COVER_SYSTEM`) checks whether one
  source backs all of it but one small detail. The verdict judge and its
  prompt are untouched. The call splits the sentence into claim / detail /
  qualifier parts, with a quote for each part a source states.
  `lib/claimTrim.js` then decides, without a model, whether removing the
  missing part is safe: small, not a qualifier, scope, figure or attribution,
  and not used later in the paragraph. If so, the source carries
  `partial: { quote, missing, trimmed }` and stays `context`, never backing.
  The extension's search always asks for this (never with a `correction`).
  `/api/verify-sources` asks only with `partial: true` (receipt `trim`).
  It is tallied `partial=`, and costs up to 1,500 more output tokens, which
  is why `WORST_CALL["/api/sources"]` is 6,500.
  Measure it with `eval/goldset/run-verify-prod.mjs --partial`.
- **The desktop gets the same receipts from its own route,
  `/api/verify-sources`** (2026-10-07; `lib/reasoning.js` `verifySources` →
  the same `lib/sourceVerify.js`, never a second verifier). The desktop sends
  a list the writer OPENED — at most 8 sources `{ id, title, url?, doi?,
  abstract?, venue?, year? }`, clamped — and gets one `{ id, verdict:
  backs|contradicts|topic|unread, quote?, readFrom?, retracted? }` each. An
  `abstract` the desktop sends (a scholarly index's own) is read only when
  OpenAlex has none (`gatherEvidence` `abstractOf`; the extension passes none).
  It is an APP route: `appGate`/`appCall`, the app pool and limiter, one `ai`
  action per list, never the source-search allowance (nothing is searched),
  the fast model at low (`plan.js` `verifySources`), no server cache (a page
  that missed the deadline must not be frozen as unread; the desktop caches).
  A judge that fails is a 502, never a list of "unread" — the desktop falls
  back to its unchecked list. Why user-triggered: it is a paid call, and the
  desktop's passive Screen Watch never makes one unasked. `context` is
  accepted and not sent to the judge (VERIFY_SYSTEM is measured on the claim
  alone). Tests: `test/verify-sources.test.js`, `test/boundary.test.js`,
  `test/mirror-contracts.test.js`.
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

- **`/api/kind`** (2026-10-15, `lib/kind.js`, prompt `lib/prompts/kind.js`,
  SHA-pinned): the model names the kind of writing, one of the extension's 56
  (`WRITING_KINDS`; `test/kind.test.js` keeps the two lists equal) or
  "unsure". It reads the first 3,600 and last 400 characters, uses the fast
  model at low effort, and costs about 0.1¢ a call. It has its own daily
  count (`DAILY_KIND`) and a 2 s floor. An answer for text the server
  already has (an in-memory cache keyed by text) is free and not counted.
  The extension asks only when `FEATURES.modelKind` is on, and it is off
  until `eval/kinds/run.mjs` has measured it against production.
- **The wrong-source check** (2026-10-15, `lib/citeFit.js`, prompt
  `lib/prompts/citeFit.js`, SHA-pinned). `/api/check` runs it only when the
  request says `citeFit: true`, and never on Explain in depth or the try-out.
  It asks whether the source each cited sentence names could be where its
  claim comes from (Venus cited to the OECD, PISA to NASA).
  - It runs as one more call, admitted like a shard, on the fast model at
    low effort. It sees at most 12 cited sentences, and only ones the check
    called accurate.
  - A "wrong" turns that finding into `wrong_source`, which only a build
    that asked for it ever receives. "fits" and "unsure" change nothing,
    and a failure leaves the check's answer.
  - The extension sends it only while `FEATURES.citeFit` is on. That is off
    until `eval/citefit/run.mjs` has measured it against production.
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
- **Every pool reserves before it admits** (2026-10-17 spend audit). The
  `extension` and `app` pools used to read spend on disk only, so a burst
  with rotating install ids all ran before the first charge landed. Now
  `spendGate` and `appGate` hold the route's fast-model worst case
  (`WORST_CALL`, which lists the desktop routes too) and refuse with the
  `budget` 503 when what is in flight fills the day. A gate that holds a
  reservation gives the body `GATED_BODY_DEADLINE_MS` to arrive. The same
  audit made these rules, each with a test (`test/spend-hardening.test.js`,
  `test/beta-grant.test.js` I–K):
  - A call that **times out** is charged its worst case (`lib/llm.js` post →
    `timedOutUsage`): the vendor runs and bills a dropped request to its end.
  - Every failure **after the vendor answered** carries its cost
    (`tagFailure`, `lib/errors.js` `billedFailure`), all failed shards included.
  - **Web searches are capped per answer** (`max_tool_calls`: 3 on
    `/api/sources`, 4 on `/api/find-sources`), and find-sources has a
    global hourly window (`SPEND.appWebSearchesPerHour`).
  - **Effort is switched off for a model only after the same call succeeds
    without it** (`isEffortError` reads the vendor's `param`).
  - **A deployed server never runs unmetered**: with `release.json` present
    (or `TRACELY_HOSTED=1`) and Supabase unset, spending routes answer 503
    and `PUT /api/prefs` 403 (`refuseUnmetered`).
  - **Stripe:** a plan event older than the newest one applied for that
    customer is `stale` (`billing_event_order`), and only a confirmed,
    non-anonymous email claims an unclaimed purchase.
- **What the calls cost, by route, once an hour** (`lib/usageTally.js`,
  2026-10-17): `[tracely] usage route=… calls in cached (n%) write (n%) out
  searches cost`. The `cached` and `write` shares are the prompt cache's
  reads (a tenth of input) and writes (1.25×), which nothing recorded before,
  so measure any caching change against these lines. Counts and dollars only.
  - **`TRACELY_PROMPT_CACHE_KEY=caller`** (off by default) sends a hashed
    per-caller `prompt_cache_key` on `/api/check`. It changes where a call
    runs, never what it answers. It is off because a cache write costs more
    than plain input, so for one-off callers it could cost more. Keep it only
    if the usage lines show it pays. A vendor that refuses the field is
    answered without it (`postOptional`).
- **The public try-out page (`/try`) is a third product with its own fence**
  (`lib/demo.js`, `demoGate`; DEPLOY.md "The try-out page"): `DEMO_ROUTES`
  (`/api/demo/check|sources|review|status`) sit in NO other set — not
  `EXTENSION_API`, `PAID_ROUTES` or `APP_AI_ROUTES` — and alias into the
  `/api/check`, `/api/sources` and `/api/review` handlers (`api`, the aliased
  path, is what those handlers match on; never copy a handler for the demo).
  Its pool `demo` reserves per call — in `demoAdmit`, after the body is read,
  never in the gate — and REFUSES when spent (503 `demo_closed`; full of
  calls in flight, 503 `demo_busy`) — never fall back to another pool.
  `TRACELY_PUBLIC_ORIGIN`
  reaches the demo routes and static files only (decided before the self-origin
  pass); never add it to `SELF_ORIGINS`. The caller is always the free plan,
  enforced; never call `withBetaGrant` for it. `test/demo.test.js` pins all of
  this. `/ext-content.js` (the engine `/try` runs) must be copied on every
  deploy.

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
  cap, who is calling, Stripe, SQLite. `lib/demo.js` — the try-out's cookie,
  allowance, caps and status.
- `public/try.html|js|css` — the try-out page (`/try`, `/try.js`, `/try.css`);
  `server.js` owns only the headers `/try` is served with (`TRY_PAGES`).
- `scripts/` — `pack-extension.sh`, `bump-extension.mjs`, `healthcheck.sh`,
  and two Linode-only scripts (`set-server-env.sh`, `deploy-openai-key.sh`).
- `public/app/` — the vanilla web app, served by `server.js`; local only.
- `eval/models/FINDINGS.md` (root) — every measured decision about models,
  efforts, prompts and costs. Re-measure before changing one; append a dated
  section after.
