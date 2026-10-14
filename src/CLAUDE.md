# src/ — the desktop app (Merrick's surface)

Read the root `CLAUDE.md` first. This file holds what only the desktop needs.
The long decision log is `docs/desktop-architecture.md`; the design file and
the ratified UI decisions are `docs/design-file.md`; packaging is `BUILDING.md`.

## What it is

Tracely's desktop app is a private, local-first Electron app (React +
TypeScript) that checks the *credibility* of user-written text: it detects
factual claims, finds evidence (OpenAlex, Crossref and Semantic Scholar
always; PubMed for biomedical claims, Wikipedia for general ones, the World
Bank's indicators for statistical ones — `search/aggregator.ts`), scores how
well-supported each claim is, critiques weak arguments, and
generates citations (APA/MLA/Chicago). All user data lives in a local SQLite
(`sql.js`, WASM — no native module compilation needed) database under
Electron's per-OS user-data dir. Network calls are to academic search APIs, to
the **Tracely server** for every model call (this app has no API-key field and
never talks to OpenAI directly), and to a public favicon service
(`main/services/search/favicon.ts`) for real per-source icons in the Screen
Watch overlay — the one place this app's "only academic APIs + our server"
network surface is knowingly broadened, opted into by the user after being told
it reveals source domains to that service.

## Commands

```bash
npm install
npm run dev          # electron-vite dev — boots main window + hidden floating-assistant window
npm run typecheck    # tsc --noEmit for both main/preload (tsconfig.node.json) and renderer (tsconfig.web.json)
npm run build        # electron-vite build
npm run dist:win     # build + electron-builder --win -> installer in release/
npm run dist:mac     # build + electron-builder --mac (untested, config-only)
```

There is no lint script configured. The two automated correctness checks are `npm run typecheck` and `npm test` (Node's built-in runner over `src/**/*.test.ts` — about 1,200 tests, a few seconds). Run both after making changes; neither costs anything. This line previously claimed there was no test suite, which sent agents pushing on typecheck alone.

## Server setup for AI features

Claim detection, critique and every other AI call go to the Tracely server (`server/` in this repo, hosted at `https://api.jointracely.com`) through `callServer` in `services/ai/client.ts`. The URL is `TRACELY_API_URL` from `.env`, defaulting to the hosted server when unset or blank (`apiUrl()` in `scripts/env.mjs`); it is read once by `electron.vite.config.ts` and compiled into the main-process bundle as `__API_URL__` — there's no runtime/user-facing way to change it; changing the server means editing `.env` and rebuilding. There is no shared token any more (the relay's `RELAY_TOKEN` identified nobody). Each call sends the Supabase access token when there is one, an `X-Tracely-Install` id from `config.json`, and a `model` in the body resolved from the plan (`MODEL_FOR_TIER` in `shared/plan.ts`), which the server clamps. Stable installs at v0.3.97 or older still call the relay (`Tracely-relay`) until they take the v0.3.99 update. Evidence search, scoring, citations, and the library all work with no server.

## Source lists show receipts (`shared/sourceReceipts.ts`, 2026-10-07)

**No source is presented as backing a sentence unless Tracely read it and can
show the exact words from it that back the sentence.** Measured 2026-10-07:
three judges graded the 145 sources the desktop's search showed across 36
claims — 15 (10%) backed their sentence, 71 were on-topic without backing it,
56 were off-topic, and 11 of 36 claims got even one backing source. The list
was ranked by topical relevance; a "92% match" beside a paper that says
something else was the product vouching for a citation it never read.

- **What verifies:** the server's `/api/verify-sources` (an app route), which
  runs THE verifier the extension's source search runs
  (`server/lib/sourceVerify.js`): it reads each source (OpenAlex abstract, the
  open-access copy, else the page; or the abstract the desktop sends when it is
  the work's own — never `webSources.ts`'s model summary), picks the best
  passages, and one fast-model call returns backs / contradicts with a
  verbatim quote it checks, topic, or unread. Retracted works are dropped.
- **When:** only when the writer OPENS a list — the editor's citation flow
  (`AnalyzeView` `checkReceipts`) and Screen Watch's "Find a source" from a
  hover card or the grade panel (`OverlayApp` `startCitationFlow` →
  `checkReceipts`). **Never from passive watching**: it is a paid call (one AI
  action, ~0.1–0.4 cent), and Screen Watch makes no paid call the writer did
  not click for. "Find the cited work" candidates are not verified: they are
  the writer's own citation, not a claim to back.
- **How it shows** (both surfaces, wording in `citationFlowCopy.ts`): a
  "Checking what each source says…" step, then backs first with `The source
  says: “…”` and "from the abstract"/"from the page"; "Says otherwise"; a
  collapsed "Related, but they don't say this"; "Couldn't read these — check
  them yourself". No match percentage once read — it measured the topic.
- **Insert only on backs** (`mayInsert`): the editor's Insert/Replace, the
  overlay's Insert, Copy citation and Copy entry. Every other row is Open
  only. **The fallback:** when nothing could be checked (server unreachable,
  an older server that 404s the route, a refusal, a judge failure) main
  answers `unavailable` and the list is the one from before receipts, Insert
  allowed, under "Tracely couldn't check these — read a source before citing
  it" — so a server outage cannot take the citation flow down.
- **Cache** (`services/ai/verifySources.ts`, `request_cache`): keyed on
  `RECEIPTS_VERIFIER_VERSION` + the claim + the SET of source ids. A failure
  is kept 1 minute, an answer that read nothing 10 minutes (the EMPTY_TTL
  lesson, `docs/desktop-architecture.md`), a partial one an hour, a full one a
  week. Bump the version when what a verdict means changes.
- **Not fed into the score or the underlines yet.** `scoring.ts`'s strength
  score and `problemKind.ts`'s kinds still read retrieval relevance and the
  local NLI stance; receipts exist only for a list someone opened.

## Signing in is optional, and it is Google

Signed in (Settings → Billing → **Sign in with Google**; back on 2026-10-10,
Sam's #253 rebased), every call carries that Google account's access token and
runs on its plan — the same Supabase account, and so the same plan, as the
Chrome extension. Signed out, the desktop is a free install that still has a
Supabase ACCOUNT, created without asking, because two things downstream need
one and neither is a UI concern:

- **The server's quotas are keyed on an identity** (`callerId`,
  `server/lib/entitlement.js`): `user:<supabase id>`, then
  `install:<X-Tracely-Install>`, then the address, which only ever carries a
  rate limit, never a daily quota. The desktop's free ceiling is
  `FREE_DAILY_AI_CALLS` (150/day, `server/shared/plan.js`); its limiter is
  `appCallerCallsPerMinute` (30, `server/shared/guards.js`).
- **A plan needs a user to attach to.** A signed-out call is not refused — it
  is served as free and metered by install id — but a plan
  (`app_metadata.plan`) or a later sign-in can only attach to a Supabase user,
  and the anonymous session is that user.

So `ensureAnonymousSession` (`services/auth/client.ts`) signs the install in
anonymously at boot, and `main/index.ts` awaits it before registering the
access-token provider. A Supabase anonymous user is an ordinary user row with
an ordinary JWT. (This section was written against the relay, whose
`resolveUser` 401'd any call without a session; the server does not.)

- **THE SESSION FILE IS THE IDENTITY.** `sessionStore.ts` persists it under the
  user-data dir and supabase-js refreshes it, so one install keeps one account
  and its daily allowance means something. Getting the stored session BEFORE
  minting one is the whole of that — skip it and every launch is a new account
  with a fresh 150.
- **It requires "Allow anonymous sign-ins", which is ON for
  `sxifbtelrtbsgnnwnmdf`.** If it is turned off, Supabase refuses, the app
  logs it and carries on, and server calls are metered by install id; nothing
  401s. A build compiled against the deleted project `epafyygdvvkgpdkbevqi`
  gets the same refusal, and on a relay-era build (v0.3.97 or older) every AI
  call then fails, because the relay 401s a call without a session.
- **`ensureAnonymousSession` cannot throw.** It runs inside the boot sequence.
- **`authRequired` did not go away and no longer means "sign in".** It is a 401
  reaching Screen Watch, and the one thing it must not now say is that the
  reader can fix it by signing in — see the status line in `HomeView`.
- **`src/shared/*` kept its auth surface**, the same way the `TRACER_*`
  constants outlived Tracer's removal: the `AUTH_SIGN_*` / `AUTH_UPDATE_*` /
  `AUTH_DELETE_ACCOUNT` channels, the `Auth*` request/response types and
  `shared/oauthScheme.ts` (plus its test) are all still there with nothing
  registered against them. Additive, per the rule below.
- **The relay's `api/delete-account.ts` now has no caller.** Left deployed
  rather than removed — an endpoint nothing calls costs nothing, and the client
  half of that decision is not ours to make from here.

Signing in:

- **Google, not a password.** The extension signs people in with Google only,
  and the extension is where plans are sold, so every paying account is a
  Google identity with no password. A password form here would mint a second,
  planless account per customer — the opposite of one account on both surfaces.
- **A loopback redirect, not `tracely://`.** `services/auth/googleSignIn.ts`
  opens the user's browser and listens on `http://127.0.0.1:53117/auth/callback`
  (RFC 8252, `services/auth/loopback.ts`); Supabase's PKCE code comes back there
  and is exchanged in main (`flowType: 'pkce'` on the one client — the verifier
  waits in `fileSessionStorage` between the two halves). The custom protocol
  the first version used, and the dev/stable/preview scheme fight it caused,
  stay deleted. **That exact URL must be on the Supabase project's Redirect
  URLs allow list** (Authentication → URL Configuration); unlisted, Supabase
  silently sends the browser to the Site URL and sign-in times out after five
  minutes (the message says so). It cannot be checked from outside: the
  authorize step accepts any `redirect_to`, and only the callback refuses one.
  `loopback.test.ts` pins the address.
- **Signing in replaces the anonymous session**; what the anonymous user spent
  stays on that user. **Sign-out is `scope: 'local'`** — supabase-js signs out
  GLOBALLY by default, which would also sign the person out of the extension
  everywhere. After it there is no session until the next launch mints a new
  anonymous one; calls meanwhile are metered by install id.
- **"Refresh plan"** re-reads the account at once (`AUTH_REFRESH`); otherwise a
  plan bought on the website reaches the session at the next token refresh.
- The upgrade link carries `?uid=<account id>` (`upgradeUrlFor` in
  `shared/plan.ts`), which jointracely.com/order forwards to Stripe as
  client_reference_id — the same contract as the extension's `orderUrl()`.
- Still gone: email/password, name and username prompts, delete-account.
  `AUTH_SIGN_IN_WITH_GOOGLE` and `AUTH_SIGN_OUT` are registered again; the
  other `AUTH_*` channels and `shared/oauthScheme.ts` still have nothing
  behind them (additive rule).

The section this replaced described the `tracely://` scheme fight between dev,
stable and preview builds over Google's OAuth callback. All of it — the scheme,
`registerOAuthProtocol`, the `protocols:` block in `electron-builder.yml`, the
per-channel redirect URLs — is deleted. `npm run dev` no longer takes anything
from the installed app. **`tracely-preview://auth-callback` is still on
`sxifbtelrtbsgnnwnmdf`'s redirect allowlist** (the old staging project, now
the only one); harmless, and left there because
removing an allowlist entry is the kind of change that is only noticed when
something needs it back.

## Windows packaging gotcha

`npm run dist:win` can fail the first time with `Cannot create symbolic link : A required privilege is not held by the client` while electron-builder extracts `winCodeSign` (irrelevant macOS `.dylib` symlinks, but the whole archive extraction is treated as failed). Fix: enable Settings → Privacy & Security → For developers → Developer Mode, then re-run.

## Releasing the desktop app

`docs/RELEASING.md` has the order across surfaces (server first). The desktop's own path, verbatim from the old CLAUDE.md:

### `npm run ship`

`npm run release:win` runs `scripts/preflight.mjs` first and refuses to publish
unless: you're on `main`, the tree is clean and in sync with origin, typecheck
passes, **every server endpoint in `callServer`'s parameter type answers
something other than 404**, and the version is strictly above the latest
published GitHub release.

That endpoint check is the important one. **The desktop app and the server
(`server/`, deployed per `server/DEPLOY.md`) must ship together**, and nothing
else enforces it: v0.3.73 was committed, typechecked and building cleanly with
the then-new `/api/tracer` returning 404 in production (on the relay, which the
app called then). Deploy the server first, then release the client. The version check matters for the
opposite failure — `electron-updater` only offers a *strictly higher* version,
so publishing without bumping produces a release nobody is ever shown.

`GH_TOKEN` lives in `.env.release` and must be in the environment for
`--publish` to work; electron-builder does not read that file on its own.

- **The token must reach `Tracely-app/Tracely`, and it is checked only at the
  very end.** v0.3.99's first `ship` built for twenty minutes and then got
  `403 Resource not accessible by personal access token` creating the
  release — a token that predated the org transfer. Nothing was published,
  but the version bump had already merged.
- **A fine-grained token cannot name Tracely-app unless you are an org
  MEMBER.** A repo collaborator with push access (Merrick, 2026-10-03) never
  sees it as a resource owner. Use a classic token with `repo`, or the gh
  CLI's own login.
- **To publish without re-bumping, run `release:win` directly** — `ship`
  would bump again. Set what `ship` would have set (PowerShell):
  `$env:TRACELY_ENV = "production"; $env:GH_TOKEN = (gh auth token)`, then
  `npm run release:win`. Clear `GH_TOKEN` from that shell afterwards.

**`main` requires a pull request, enforced on admins**, so nothing — including
`npm run ship` — can push to it directly. The release bump therefore goes to
`release/vX.Y.Z`, opens a PR and auto-merges once `check` is green (zero
approvals required, which is what keeps it automatic); ship then returns to main
at the merge commit, which is what gets built and tagged. `ship:preview`'s local
path used to push to main too and now derives its version without committing at
all, the same way CI always has.

**`npm run ship:dry`** runs all of that and stops before building. It is not
side-effect free and pretending otherwise would make it useless: it really bumps
the version and really merges the release PR, because that sequence is the thing
worth testing. It publishes nothing. The cost is one skipped patch number — main
sits a version above the latest release, and the next real ship bumps past it.
Written because the release path was otherwise the least-tested code here, for
the worst possible reason: the only way to test it was to publish, and
electron-updater cannot downgrade.

### When a release goes wrong

See **[ROLLBACK.md](ROLLBACK.md)** (still written around the relay). The short
version: the server reverts in about a minute by restoring the `app.bak-*`
snapshot taken before each deploy (`server/DEPLOY.md`), the desktop app cannot
be reverted at all (electron-updater will not downgrade), so the first question
in any incident is whether the server can fix it instead. The relay's
`vercel rollback` matters only for stable installs at v0.3.97 or older.

**Two rules survive from the old ownership contract, because both were written
after something broke:**

- **`package.json`'s `version` line belongs to `npm run ship` alone.** Never
  edit it by hand.
- **The ML packaging rules in `electron-builder.yml`** — the `@huggingface` and
  `onnxruntime` globs, `asarUnpack` of `out/main/mlWorker.js`, `extraResources`
  for `resources/models`, and the `afterPack` hook — are load-bearing and
  easy to "tidy" into breakage. v0.3.76 shipped with the entire ML stack
  excluded, silently degraded to word-overlap ranking, and nothing errored.
  `scripts/verify-packaged-ml.mjs` runs in `afterPack` to make that failure
  loud; leave it wired.
- **Shared files (`src/shared/*`) are additive.** Add, don't restructure.

### How updates reach each build (`updater.ts`, `updatePolicy.ts`)

**Preview updates itself; production asks first.** The two channels are not
just different feeds, they behave differently on purpose:

| | production | preview |
|---|---|---|
| `autoDownload` | `false` — asks | `true` — silent |
| check interval | 6h | 20min |
| install | always a dialog | silent when idle, else dialog |

The reason is that a preview channel only does its job if the testers are on the
**same** build. Landing an update used to take two separate clicks — "Download",
then "Restart now" — either of which could be declined forever, and with 13
previews published in three days any two testers diverged within hours and then
reported the difference between their builds as a bug in one of them.

- **`shouldInstallImmediately` (`updatePolicy.ts`) is the only thing that
  restarts the app unasked**, and it requires preview + no visible window +
  Screen Watch off. That combination is this app's *resting* state, not a rare
  one — `window-all-closed` deliberately keeps it alive in the tray. When it
  says no the update is not dropped: the dialog offers it, and failing that
  `autoInstallOnAppQuit` installs it on the next quit. It decides *silently now*
  vs *ask*, never *now* vs *never*.
- **Do not derive "is this a preview build?" from the version's `-preview`
  suffix.** `appIdentity.isPreviewBuild()` reads `app.getName()`, which
  electron-builder sets via `-c.extraMetadata.name=tracely-preview`. A second
  derivation is a second truth that can disagree with the first, silently.
- **This cannot fix an install retroactively.** A tester already running an
  older preview has to install one build by hand; every one after that is
  automatic. Auto-update can only be delivered *by* an update.

## Previewing the UI (`npm run preview:ui`, or `/preview`)

**`/preview` is the command for this** — it covers booting the harness, driving
the surfaces through the mock bridge, and the measurements worth asserting.
(The slash command that publishes a beta installer is now `/beta`; it used to
be called `/preview`, which is why anything older may say so.)

A desktop harness for looking at and reviewing the UI without booting the real
app — no SQLite, no relay, no Screen Watch, no global hotkey. It opens one
Electron window that loads **the real renderer entries** (`index.html`,
`floating.html`, `overlay.html`) in iframes at their true BrowserWindow pixel
sizes, against a mocked IPC bridge. HMR is live, and it's safe to run alongside
the real app.

It exists because most of this UI is otherwise awkward to reach: the floating
window needs a global hotkey and a clipboard payload, and the overlay only
draws when UIA is reading a real focused control in another app.

- **`src/renderer/src/preview/mockApi.ts` is the drift guard, and the reason
  this is worth having.** `createMockApi` is typed as `Window['tracely']` —
  i.e. the real `TracelyApi` (`typeof api` from the preload bridge). Add,
  rename or re-shape any method in `src/preload/index.ts` and
  `npm run typecheck` fails here until the mock is updated. A hand-maintained
  replica of the UI would rot in a week; this one cannot silently fall behind
  the contract it mocks. (It's `Window['tracely']` rather than a direct import
  of `src/preload/index.ts` on purpose: importing the preload *implementation*
  drags electron's Node typings into the renderer's tsconfig program and
  degrades inference across every renderer file.)
- **Iframes, not one shared document.** Each surface is a real document with
  its own stylesheet, which is the only way to show them side by side without
  one window's reset reaching another. (Tracer, which shipped Tailwind's
  preflight next to windows relying on default UA styling, is why this was
  never negotiable.)
- **The mock is injected by `preview/vite.config.mts`, dev-server-side only.**
  `transformIndexHtml` prepends `src/preview/bootstrap.ts` as a module script
  to the three real entries. ES module scripts run in document order, so
  `window.tracely` is installed before the app's own entry module — the same
  guarantee the preload contextBridge gives it in production. **No shipped
  file is modified to support the preview.**
- **It cannot ship.** `preview.html` is deliberately absent from
  `electron.vite.config.ts`'s `rollupOptions.input`, so it's never built into
  `out/`, and electron-builder packages `out/**/*` only.
- Scenario controls in the left rail (auth gate, relay configured, structure
  variant, forced relay failure, injected latency) re-create states that are
  otherwise hard to reach on demand — the error banner, the loading spinners. Changing one reloads the
  surfaces, because the mock is constructed once per document exactly like the
  real bridge. The right-hand panel logs every IPC call that fires.
- **Overlay hover and overlay updates are driveable from the rail.** Hover normally comes from `hoverTracking.ts` hit-testing the real cursor against the watched app, and overlay payloads from the poll loop — neither has an equivalent inside an iframe, so `mockApi.ts` exposes `__previewEmitHover` / `__previewEmitOverlay` on the overlay frame. Without them the hover states and the dropped-rect flicker path are simply unreachable in the preview.
- Fixtures (`preview/fixtures.ts`) use a **fixed timestamp**, not `Date.now()`,
  so two screenshots of an unchanged UI are identical.

