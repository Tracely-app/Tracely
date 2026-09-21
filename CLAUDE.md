# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tracely is a private, local-first Electron desktop app (React + TypeScript) that checks the *credibility* of user-written text: it detects factual claims, finds academic evidence (OpenAlex, Crossref, Semantic Scholar, PubMed), scores how well-supported each claim is, critiques weak arguments, and generates citations (APA/MLA/Chicago). All user data lives in a local SQLite (`sql.js`, WASM — no native module compilation needed) database under Electron's per-OS user-data dir. Network calls are to academic search APIs, to the **Tracely Relay** (a separate sibling project, `../Tracely-relay`, that holds the real OpenAI key server-side — this app has no API-key field and never talks to OpenAI directly), and to a public favicon service (`main/services/search/favicon.ts`) for real per-source icons in the Screen Watch overlay — the one place this app's "only academic APIs + relay" network surface is knowingly broadened, opted into by the user after being told it reveals source domains to that service.

## The design file

**[Real Tracely UI](https://www.figma.com/design/k7R5x1M9alKktaMLlZFSJn/Real-Tracely-UI)** — file key
`k7R5x1M9alKktaMLlZFSJn`, one page, `0:1`. Every overlay/widget/settings frame
lives there.

Recorded here because it was not recorded anywhere. A dozen comments in this
codebase cite "the Figma mockup" — the 56px launcher, the 870x606 frame, the
thin-line icons — without a link, so the UI was being built from *prose
descriptions of* the design rather than the design. That drift is what produced
a near-miss palette (`#17171b` for `#1c1c1c`, `#f47b20` for `#ff5900`), pill
buttons where the design has 8px rounded rectangles, and an overlay that never
loaded Instrument Sans at all.

Read it with the Figma MCP (`get_metadata` on `0:1` to list frames, then
`get_design_context` on a node). The overlay frames are named
`Overlay Mockup - <state>`.

**The overlay's frames, and what each one governs:**

| frame | governs |
|---|---|
| `Widget over Document` (+ Refresh / Critique / Show All results) | the panel the launcher opens |
| `Inline Detection (Grammarly-style / Statistic / Citation / Reasoning)` | the hover popover — `ProblemCard` |
| `Find a Source (Searching / Results)`, `Add Citation (Choose Source / Inserted)` | `CitationFlowCard` |
| `Collapsed Launcher` | the 56px circle and its 31px count badge |
| `Inline Detection (Resting State)` | the underline marks with nothing hovered |

**Three underline colours, not eight.** `#ff5900` for an unverified figure,
`#ffb800` for a missing citation, `#d93636` for weak reasoning — read off the
marks in those frames, with the popover's dot always matching the mark that
opened it. `PROBLEM_COLOR` in `OverlayApp.tsx` groups all eight problem kinds
onto those three, because inventing a fourth hue is what produced a purple
statistic underline and an orange "missing citation" one — the design's two
colours, swapped.

**Every popover has a 16x10 tail** (`PopoverTail`, path from node `288:545`)
pointing at the sentence, overlapping the card border by 2px so the strokes
meet. The overlay shipped without one for months; on a paragraph with three
flagged sentences a card floating nearby is genuinely ambiguous.

**Two deliberate departures:**

- Source rows show the real favicon, not the design's two-letter provider tile.
  It identifies the publication rather than which API returned it. The tile
  remains as the fallback, in the design's 28px / 8px-radius box so both line up
  on the same grid.
- `Add Citation (Choose Source)`'s library list and text search field are not
  built. Screen Watch persists nothing, so there is no per-document library to
  list, and `overlayWindow.ts` sets `focusable: false` — this window can never
  host a real text input. Its style pills ARE used, in the Results step. (A
  filter box over the results list was built once anyway; it could not be typed
  into, for that same reason, and the frame's full-width **"Search again"** is
  what stands in that slot.)

**The hover popover runs the whole flow, on both surfaces.** `Inline Detection`
→ `Find a Source (Searching)` → `Find a Source (Results)` → `Add Citation
(Inserted)` are four states of one card, and Screen Watch's overlay
(`CitationFlowCard` in `OverlayApp.tsx`) and the document editor's marks
(`DocumentMarkLayer.tsx`) both draw all four. The editor used to answer "Add
citation" by opening the report modal instead — a full-screen context switch
away from the paragraph being written, to answer a question asked about one of
its lines.

- **The wording is shared (`components/citationFlowCopy.ts`), the markup is
  not.** Same rule as `problemCopy.ts`, and for the same reason: the overlay is
  inline styles in a window that loads no stylesheet, the editor is `.docmark-*`
  classes from `index.css`. Two copies of the strings would be two products.
- **The confirmation says different things on the two surfaces, because they do
  different things.** The editor appends a real reference section to the
  document (`shared/worksCited.ts`, written through the same `execCommand` path
  as the marker, so one Undo unwinds both), and "ADDED TO WORKS CITED" is true
  there. The overlay writes the in-text marker into another application through
  UIA and nothing else — it owns no document and cannot see that window's
  reference list — so it says `ADD THIS TO YOUR REFERENCE LIST` over an
  always-visible entry with **Copy entry**, where the frame draws "View Works
  Cited". It carried the editor's label for a while over a list it had added
  nothing to, which is a card that makes a student hand in an essay one
  reference short and hear about it from a marker.
- **`Preview` earns its place differently on each surface.** Over another app
  the overlay writes through UIA, and being shown the citation first is the only
  way to see it before it lands. In Tracely's own editor the insert goes through
  `execCommand('insertText')` — it appears in the sentence a few pixels away and
  Ctrl+Z (or the card's own Undo, which is that same undo stack) takes it back
  out. It is offered there anyway, because the works-cited entry is the half
  that does *not* appear in the sentence.
- **A running flow pins the editor's popover** (`flowPinnedRef` in
  `AnalyzeView`). The card unmounts the instant the pointer leaves the sentence,
  so the flow state is owned by the view, and the hit-test stops swapping marks
  while one is open — otherwise reaching across another underline on the way to
  "Insert citation" takes the card with it.
- **The editor's marks are driveable from a browser pane that is not
  displayed** — they were not, until `renderer/src/frameScheduler.ts`. They are
  measured inside a frame callback (deliberately: it batches a keystroke and a
  ResizeObserver callback that both force layout), and Chromium freezes rAF
  entirely on a page that is not compositing, so `marks` stayed empty and the
  popover was unreachable in `npm run preview:ui`. `scheduleFrame` arms a rAF
  and a 50ms timer and takes whichever fires first: the frame always wins when
  there is one, so the batching is unchanged in the shipped app, and the timer
  is the only thing that ever fires in a hidden window. Measured in the
  harness: 0 marks before, 4 after, with the hover popover opening on them.

## Commands

```bash
npm install
npm run dev          # electron-vite dev — boots main window + hidden floating-assistant window
npm run typecheck    # tsc --noEmit for both main/preload (tsconfig.node.json) and renderer (tsconfig.web.json)
npm run build        # electron-vite build
npm run dist:win     # build + electron-builder --win -> installer in release/
npm run dist:mac     # build + electron-builder --mac (untested, config-only)
```

There is no lint script configured. The two automated correctness checks are `npm run typecheck` and `npm test` (Node's built-in runner over `src/**/*.test.ts` — 282 tests, 57 suites, under a second). Run both after making changes; neither costs anything. This line previously claimed there was no test suite, which sent agents pushing on typecheck alone.

### Server setup for AI features

Claim detection, critique and every other AI call go to the Tracely server (`server/` in this repo, hosted at `https://api.jointracely.com`) through `callServer` in `services/ai/client.ts`. The URL is `TRACELY_API_URL` from `.env`, defaulting to the hosted server when unset or blank (`apiUrl()` in `scripts/env.mjs`); it is read once by `electron.vite.config.ts` and compiled into the main-process bundle as `__API_URL__` — there's no runtime/user-facing way to change it; changing the server means editing `.env` and rebuilding. There is no shared token any more (the relay's `RELAY_TOKEN` identified nobody). Each call sends the Supabase access token when there is one, an `X-Tracely-Install` id from `config.json`, and a `model` in the body resolved from the plan (`MODEL_FOR_TIER` in `shared/plan.ts`), which the server clamps. The relay (`Tracely-relay`) still serves installed builds from before this change. Evidence search, scoring, citations, and the library all work with no server.

### Nobody signs in, and the app still has an account

There is no sign-in screen, no sign-up, no Google button, no name prompt, no
sign-out and no account panel. There is still a Supabase ACCOUNT, created
without asking, because two things downstream need one and neither is a UI
concern:

- **The relay refuses a call it cannot attribute.** `resolveUser` in the
  relay's `lib/auth.ts` fails closed, on all seven AI endpoints — no
  `Authorization` header is a 401, not a cheaper answer.
- **Both spend guards are keyed on a user id**: the burst limiter
  (`lib/rateLimit.ts`, `relay_quota(p_user_id)`) and the 150-per-UTC-day free
  ceiling (`lib/entitlements.ts`). With nothing to count against, the shared
  installer token — extractable from any release in about a minute — would be
  the only thing between a script and the OpenAI bill.

So `ensureAnonymousSession` (`services/auth/client.ts`) signs the install in
anonymously at boot, and `main/index.ts` awaits it before registering the
access-token provider. A Supabase anonymous user is an ordinary user row with
an ordinary JWT: **the relay needed no change and was not changed.**

- **THE SESSION FILE IS THE IDENTITY.** `sessionStore.ts` persists it under the
  user-data dir and supabase-js refreshes it, so one install keeps one account
  and its daily allowance means something. Getting the stored session BEFORE
  minting one is the whole of that — skip it and every launch is a new account
  with a fresh 150.
- **It requires "Allow anonymous sign-ins" on the Supabase project.** With that
  off, Supabase refuses, the app logs it and carries on: local features work
  and relay calls 401, which is exactly the state a signed-out install used to
  be in.
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

The section this replaced described the `tracely://` scheme fight between dev,
stable and preview builds over Google's OAuth callback. All of it — the scheme,
`registerOAuthProtocol`, the `protocols:` block in `electron-builder.yml`, the
per-channel redirect URLs — is deleted. `npm run dev` no longer takes anything
from the installed app. **`tracely-preview://auth-callback` is still on the
staging Supabase project's allowlist**; harmless, and left there because
removing an allowlist entry is the kind of change that is only noticed when
something needs it back.

### Windows packaging gotcha

`npm run dist:win` can fail the first time with `Cannot create symbolic link : A required privilege is not held by the client` while electron-builder extracts `winCodeSign` (irrelevant macOS `.dylib` symlinks, but the whole archive extraction is treated as failed). Fix: enable Settings → Privacy & Security → For developers → Developer Mode, then re-run.

## Branches and releasing

One workspace, `C:\Users\merri\Tracely-agent1`, on `main`. Work happens on
`feat/*` branches. A `Stop` hook auto-commits and pushes the current branch at
the end of every turn, so work is never left only in a working tree.

- **`main` is the integration branch and the only branch releases are cut
  from.** It advances by deliberate merge. `.claude/hooks/guard-edit.sh` refuses
  edits to `src/`, `scripts/` and the build config while on `main`, because
  `electron-builder` packages the working tree rather than `HEAD` — an
  uncommitted edit there can reach an installer without ever being committed.
- **Merge into `main` when a feature is done, not when a release is due.**
  `npm run ship` no longer merges anything; it publishes what is already on
  `main`. Release time should not also be integration time.
- **Parallel work uses throwaway worktrees, not permanent ones.** Subagents
  launched with `isolation: "worktree"` get their own checkout and clean up
  after themselves. Three standing worktrees with a file-ownership contract were
  retired in favour of this: the contract needed maintaining, branches drifted
  24 commits behind, and 421 lines once sat uncommitted in two of them because
  each worktree registered the auto-commit hook separately.
- **A worktree runs the guards it was branched from, not the ones on `main`.**
  `settings.json` invokes them as `$CLAUDE_PROJECT_DIR/.claude/hooks/*.sh`, and
  in a worktree session that variable resolves to the worktree — so the hook
  files are whatever that checkout has, and fixing a guard on `main` does
  nothing for any worktree already in flight. A live probe of the revised
  `guard-bash.sh` sailed through a `git commit` aimed at `main` for exactly this
  reason: the session was four commits behind and running the version with the
  bug. **Merge `main` before trusting a guard in a long-lived worktree**, and
  test hook changes from a checkout that actually has them.
- **Test the guards with real tool calls, not hand-built payloads.** A synthetic
  payload has no `cwd` field, so it falls through to whatever the fallback is
  and passes while the real thing fails. Both hook bugs so far were found by
  running an actual command and neither was caught by a 19-case suite over
  invented JSON. The suite is still worth having for the branches real probes
  cannot reach — the deny path needs some checkout to be sitting on `main` —
  but it confirms nothing on its own.

### When a release goes wrong

See **[ROLLBACK.md](ROLLBACK.md)**. The short version: the relay reverts in
seconds with `vercel rollback`, the desktop app cannot be reverted at all
(electron-updater will not downgrade), so the first question in any incident is
whether the relay can fix it instead.

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

### Releasing

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

## Architecture

Three Electron processes, strictly separated:

```
src/shared/         Types (types.ts) and IPC contract (ipc-contract.ts request/response shapes,
                     ipc-channels.ts channel name constants) — the only import shared across all
                     three processes. Import via the `@shared` alias.
src/main/           Node.js main process — all business logic lives here, nothing in the renderer.
src/preload/        contextBridge surface exposed as `window.tracely` (typed `TracelyApi`).
src/renderer/       React UI, three entry points (index.html main window, floating.html popup,
                     overlay.html Screen Watch overlay) sharing components.
                     Import via the `@renderer` alias.
```

### IPC pattern (adding a new feature follows this shape every time)

1. Define request/response types in `src/shared/ipc-contract.ts` and a channel constant in `src/shared/ipc-channels.ts`.
2. Add a handler in `src/main/ipc/<feature>Handlers.ts`: parse `raw` with a zod schema, call into a `services/` module, return the typed response. Register it in `src/main/ipc/index.ts`.
3. Expose it on the `api` object in `src/preload/index.ts` as a typed `ipcRenderer.invoke` wrapper.
4. Call it from the renderer via `window.tracely.<namespace>.<method>(...)`.

Every handler validates its input with zod before touching a service — there is no untrusted input path into `services/`.

### `main/services/` — four independent domains

- **`ai/`** — `client.ts` (`callServer`) is the only thing that ever makes a network call to the Tracely server; its retry/timeout/error-envelope rules are the tested leaf `serverCallPolicy.ts`; `claimDetection.ts` and `critique.ts` build the request bodies. `costGuard.ts` centralizes hard limits (max input chars, max claims per analysis, max evidence items sent to critique) — check here before loosening any AI-related limit. AI is invoked either from an explicit user action (Analyze / Find Evidence / Critique) or automatically by Screen Watch after a debounced pause in typing — never on every keystroke. (This used to say "the renderer's Live tab (`LiveView.tsx`)"; there is no such tab.) Every call result is cached in SQLite (`cacheRepo.ts`) keyed by a hash of normalized input, which also caps live-editing cost since re-detecting unchanged text is free.
- **`search/`** — one client module per provider, each returning a `NormalizedSourceResult`. The three core scholarly searches always run; routing can add PubMed for biomedical claims, Wikipedia for general facts, or World Development Indicators from the World Bank for statistical claims. `worldBank.ts` embeds the indicator catalogue once per session and returns at most one dataset only above its measured semantic-match floor. `aggregator.ts` fans providers out in parallel via `safeSearch` (a provider failure returns `[]` rather than failing the whole search), dedupes by DOI (falling back to normalized title+year), and caps merged results. `scoring.ts` computes evidence strength as a **deterministic formula** (source count, venue quality, recency, relevance rank) — not an AI call. `rateLimiter.ts` throttles per-provider request rate.
- **`citations/`** — pure formatters (`formatters/{apa,mla,chicago}.ts`) from source metadata, no AI/network involved. `authorUtils.ts` truncates author lists to "et al." after 3 authors (a known MVP simplification, not the full style-guide rule).
- **`storage/`** — `db.ts` wraps `sql.js`: the whole database is an in-memory WASM DB that gets fully re-serialized and written to disk (`persist()`) after every `run()`. `schema.ts` holds the SQL DDL. One repo module per table (`analysesRepo`, `claimsRepo`, `claimEvidenceRepo`, `sourcesRepo`, `citationsRepo`, `libraryRepo`, `cacheRepo`, `settingsRepo`) — go through these rather than querying `db.ts` directly from elsewhere. `config.ts` handles the small `config.json` (currently just the optional Semantic Scholar key).

### Main-process entry (`src/main/index.ts`)

Single-instance lock (second launch just refocuses the main window). Boots in order: `initDb()` → create main window → create (hidden) floating window → tray → register IPC handlers → register global hotkey. The app stays alive in the system tray on `window-all-closed` specifically so the global hotkey keeps working with no window open; `before-quit` forces a final `persist()`.

### Floating window / hotkey flow

`hotkey.ts` registers a configurable global accelerator (default reflected in Settings) that grabs the current clipboard and shows the floating window (`windows/floatingWindow.ts`), which emits `FLOATING_CLIPBOARD_CAPTURED` to the floating renderer (`FloatingApp.tsx`) to auto-trigger analysis. Main window and floating window are separate `BrowserWindow`s with separate Vite entry points but share renderer components (`ClaimCard`, `EvidenceCard`, `CitationBlock`, etc.).

### The Live tab does not exist

This file described one at `views/LiveView.tsx` + `components/LiveEditor.tsx`,
and called it "the main window's default tab". Neither file is in the tree, and
the default tab is Home (`App.tsx`). The main window's tabs are Home, Analyze
and Settings.

What survives of it is `shared/claimSpans.ts`, which locates a claim's text
within a document to compute underline offsets. Its only importer now is
`screenWatchService.ts` — Screen Watch is where in-place underlining actually
happens, and it is the only place AI runs automatically.

### Screen Watch (`main/services/screenWatch/`, `windows/overlayWindow.ts`, `resources/uia-watch.ps1`)

Opt-in (Settings → Screen Watch, off by default, also toggleable from the tray menu), reads text from whatever field is focused in *other* apps and underlines flagged claims directly on screen — the "read my whole screen" version of what an in-app live editor would do. Windows-only.

- **`resources/uia-watch.ps1`** does the actual reading via .NET's `System.Windows.Automation` (UI Automation / UIA), spawned fresh by `uiaSnapshot.ts` on every poll tick (no persistent helper process, to sidestep async-stdin complexity in PowerShell). It reads `AutomationElement.FocusedElement`, extracts text via `TextPattern.DocumentRange` (falling back to `ValuePattern` for controls that don't support rich text access), and — for already-detected claims passed in via `-ClaimsB64` — uses `TextPatternRange.FindText()` + `GetBoundingRectangles()` to get exact on-screen rectangles for underlining. **Writes raw UTF-8 bytes directly to the stdout handle** rather than `Write-Output`, because PowerShell's console encoding is inconsistent across hosts/versions and silently corrupts non-ASCII characters (smart quotes, accents, em-dashes) into invalid JSON otherwise — this was caught by live-testing against a real Chromium browser, not by inspection, so don't "simplify" it back to `Write-Output` without re-testing against real accented text.
- **Coverage is real but bounded by UIA support in the target app**: works well in Word, WordPad, other RichEdit-based apps, and — usefully — in Chromium-based browsers (Chrome/Edge/Opera all expose page text via UIA TextPattern when an accessibility client is attached), confirmed against live pages during development. It does **not** work in apps that render text as pixels without exposing an accessibility tree — Google Docs is the main example. `controlRect` is always available as a fallback even without `TextPattern`, but per-claim underline rectangles require it.
- **`screenWatchService.ts`** owns the poll loop (`POLL_INTERVAL_MS` = 1200ms) and a stability debounce (text must be unchanged for `STABLE_MS` before triggering `detectClaims`) — this is the other place AI runs automatically. Detected claims here are **not persisted** to the analyses/claims tables (they're synthesized in-memory `Claim` objects with a fresh UUID) — deliberately, so passive background reading doesn't pollute Analysis History with things the user never asked to save. Unlike claim detection, evidence search for these claims (`findEvidence` from `search/aggregator.ts`) *does* run automatically here, fire-and-forget per claim right after detection (`triggerEvidenceSearch`) — safe to auto-run since it only hits the four free public search APIs, not the paid relay, and results are kept in an in-memory `evidenceResultByClaimId` map (also never persisted), not written to the `evidence`/`sources` tables the main Analyze flow uses. The overlay also exposes real "Find Evidence"/"Critique Argument" actions (`refreshEvidenceForClaim`/`critiqueClaim`, same `ai/critique.ts` call the main app uses). **Critique never runs automatically here** — it is the paid relay, and Screen Watch is passive and always-on, so an unprompted call is a bill the user did not ask for and cannot watch being run up. Evidence search gets to stay automatic precisely because it only hits the four free public APIs; that is the whole line, and it is the one to hold when this comes up again. A bounded automatic version (one call per detection, spent on the first top claim whose evidence resolved) was built, shipped to beta, and pulled before the stable release that would have carried it. Its known cost is real and is not a bug to be rediscovered: `problemKindFor` reports "Weak reasoning" only when `critiqueVerdict` is set, so passive watching can speak about citations and evidence but never about reasoning until asked. Everything needed to bring it back — `synthesizeEvidenceItem`, `withEvidenceScores`, the evidence map — is still in place, and an opt-in Settings toggle is the shape it should return in. `refreshEvidenceForClaim` **deletes** the claim's critique: the critique cites its sources by number, so leaving it would show a verdict reasoned over a source list that no longer exists. Critique needs `EvidenceItem`-shaped objects (with a `Source`), which normally come from `sourcesRepo`; since Screen Watch results are never persisted there, `synthesizeEvidenceItem` builds them in-memory from the raw search results instead.
- The overlay's widget popup (`OverlayApp.tsx`) has three view modes, `single` (top claim by confidence), `all` (every currently-flagged claim, as a single vertical column — it was a grid once, and `gridColumns` no longer exists) and `structure` (the draft's structural read) — `widgetViewMode` lives server-side in `screenWatchService.ts` because the panel's actual pixel size is computed there too, so hoverTracking.ts's click-through hit-test region matches what's drawn. That sizing now lives in `screenWatch/panelSize.ts`, a leaf module so it can be unit tested; **every mode is `PANEL_WIDTH` wide on purpose** — the panel is anchored bottom-right, so a mode with its own width would make the whole card jump sideways on a mode switch, and there is a test asserting the three agree. The card-size math is duplicated client-side in `OverlayApp.tsx` (`GRID_*`) and must be kept in sync, or the rendered cards won't fit the panel sized for them.
- Off-screen/scrolled-out matches come back from `GetBoundingRectangles()` with zero/negative extents and are filtered out rather than drawn — underlines only ever appear over currently-visible text.
- **Underline rendering (`UnderlineMark` / `useStableUnderlines` in `OverlayApp.tsx`) fights three specific artifacts.** Hovering a flagged span fades in a translucent highlighter band over the text plus a slightly thicker line; the band is `rgba(color, 0.3)` and *must* stay translucent, because the overlay window sits **on top of** the watched app — anything opaque hides the very words it is highlighting.
  - **Blinking.** `FindText`/`GetBoundingRectangles` intermittently returns nothing for a claim that is plainly still visible (mid-reflow, mid-scroll, target app repainting). `useStableUnderlines` holds a claim's last rects for `RECT_GRACE_MS` (900ms, under one `POLL_INTERVAL_MS`) — but only while it is still in `widget.claims`. A claim that was dismissed, cited or re-detected away vanishes immediately, because there the empty payload is the truth rather than a missed measurement. The hold is deliberately keyed off the *previous payload*, not the merged output, so a claim can be held once and cannot renew itself forever.
  - **Snapping.** Marks move by `transform` (GPU-composited; these repaint over another app on every poll, so a layout-triggering animation is felt). The transition is suppressed for large deltas: a few pixels of typing/reflow should glide, but a scroll moves the same rect hundreds of pixels and animating that sends the underline swooping across unrelated text.
  - **Invisibility.** The entrance fade is a CSS animation with **no fill-mode**, and the mark's base opacity is 1. This window is never focused and always sits above another app — exactly the case Chromium throttles rAF/animation callbacks in — so gating visibility on a JS frame callback (the first attempt) risked underlines that never appear at all. Degraded behaviour is now "appears instantly", not "invisible".
  - Each mark carries `data-claim-id` / `data-hovered`. The overlay renders no text, so without them its DOM is unreadable when inspecting or preview-testing it.
- **`overlayWindow.ts`** is a transparent, click-through (`setIgnoreMouseEvents(true, { forward: true })`), always-on-top, unfocusable `BrowserWindow` sized to cover whichever display the focused control is on; `OverlayApp.tsx` (its own renderer entry, `overlay.html`) just draws positioned bars from the rects it's pushed — it has no other interactivity by design, since a window that could intercept clicks over another app's UI would break that app.
- Known gap: screen coordinates from UIA and Electron's display bounds are assumed to be in the same coordinate space, which holds at 100% DPI scaling; multi-monitor setups with different per-monitor scale factors haven't been verified and may misalign underlines.
- The PowerShell script ships via `extraResources` in `electron-builder.yml` (`resources/uia-watch.ps1` → packaged `resources/uia-watch.ps1`), located at runtime the same dev/packaged-path-branching way as `icon.ts`.

### Structure (`main/services/structure/`, `shared/paragraphSplit.ts`, `renderer/src/components/ArgumentScoreModal.tsx`)

> **READ THIS FIRST — the editor's report is ONE relay call now.**
>
> `ipc/structureHandlers.ts` calls `ai/gradeDraft.ts` (`/api/grade` on the Tracely server) and
> builds the outline from what comes back (`structure/gradedOutline.ts`). There
> is **no local fallback**: when the call fails the handler throws and the panel
> shows the error. Owner, 2026-08-19: *"lets reset the whole reasoning system
> into a simple chatgpt answers it and it kicks back to tracely. Extremely
> simple and efficient."*
>
> Most of the section below describes the rule engine that used to compute it —
> ten prose detectors, a lexical cohesion pass, a hand-written role classifier
> and a six-component formula. **That engine is still in the tree and still
> runs, but only for Screen Watch** (`screenWatch/watchOutline.ts` →
> `analyzeStructure`), which is passive and may not make paid calls. Read
> anything below as "how the OVERLAY grades", not the editor.
>
> What is still local on the editor's path, and why:
>
> - **The arithmetic.** The model returns six component sub-scores; the client
>   sums them (`shared/gradedDraft.ts`, `scoreFromComponents`). An unchanged
>   draft scores an unchanged number and every point traces to a quoted
>   sentence. The model judges, the client adds up.
> - **Quote verification.** `verifyGrade` discards any finding whose quote is
>   not in the draft, whose paragraph does not exist, or whose `rubricSection`
>   is not one of the owner's. That replaces "every word a student reads comes
>   from a local template" — a finding cannot describe a paragraph they did not
>   write if it has to quote a sentence they did — and it is what produces the
>   underline offsets.
> - **`shared/citationShape.ts` and the prose rules.** Free, instant, and about
>   the surface of a reference rather than about the argument.
>
> `structure/thesisSupport.ts` and its rules module are **deleted** — the model
> answers "does this paragraph support the thesis" directly. `STRUCTURE_SCHEMA_VERSION`
> is 9; a v8 row is a report from an engine the editor no longer runs, and
> `structureRepo` refuses it.
>
> **Not done:** Screen Watch still grades with the heuristics. The owner's call
> (2026-08-19) is that it gets a manual "Grade this draft" button running the
> same relay call, so passive reading never bills anyone — until then the two
> surfaces grade one draft differently, which is the disagreement class fixed in
> #156 on the same day.


A reading of the draft as an *argument* rather than as sentences: it labels what each paragraph is doing, scores the draft out of 100, and names what is missing. Everything else in the app asks whether a sentence is true; this asks whether the essay works.

It used to be a rail beside the editor (`StructurePanel.tsx`). The rail was removed when the report modal took over the flow, and the component sat orphaned for a while afterwards — with it went the only bulk **"Check all N"** evidence sweep, leaving `checkClaims` reachable only from a mark popover that needs an already-scored claim to exist. That button now lives in the report's paragraph breakdown (`ScoreReport`, `onCheckClaims`/`checking` threaded down from `AnalyzeView`); the panel and its `docedit-structure`/`docedit-score`/`docedit-evidence`/`docedit-para` CSS are deleted. The sweep stays owned by `AnalyzeView` because it is serial with a visible count and must survive the modal closing mid-run.

- **ONE report, rendered on both surfaces** (`components/EssayGradeReport.tsx`).
  Screen Watch's breakdown and the editor's "AI Insights" report were two
  implementations of one rubric — the overlay's built verbatim from Figma
  "Essay Grade Widget (Full Report)" (404:185), the editor's from `.argscore-*`
  classes in `index.css` — drifting apart at the pace of whichever was edited
  last. The owner's call (2026-08-19) was that the widget's is the one to keep,
  so it moved out of `OverlayApp.tsx` and `ArgumentScoreModal` renders it for
  `view.name === 'full'`. **Inline styles, deliberately**: the overlay window
  loads no stylesheet, so that is the one form that works in both. It is the
  opposite of the `problemCopy.ts` rule (share the wording, not the markup) and
  the exception is that here the markup is the thing being shared. Its props
  (`GradeInput`/`GradeClaim`) are narrower than `ScreenWatchStructure` so the
  editor can adapt a `DocumentOutline` without pretending to be a Screen Watch
  payload — the two fields it must supply itself, previews and stats, are the
  two `DocumentOutline` deliberately has no prose for.
- **The score is a deterministic formula, not a model output** (`structure/scoreDraft.ts`) — the same stance `search/scoring.ts` takes for evidence strength, and for the same reason: a number a student is asked to act on has to be one they can argue with. Six components (thesis 20, governing claims 20, warrant 20, counterargument 15, significance 15, conclusion 10). Governing claims is a **fraction of the body, never a count**, which is what stops the score being a length proxy — padding an essay lowers it. The panel displays every paragraph's role label beside the number so a wrong label is visibly wrong rather than mysteriously costly.
- **`shared/gradeLevel.ts` owns score → letter end to end** — the bands AND the
  level shift. The bands were in `renderer/components/essayGrade.ts`, which
  `npm test` cannot load (it resolves the `@shared` alias), and a band table
  nothing can test is how the scale shipped with no A+ at all: "A" was the top,
  so a draft that met every expectation of its level could not be told it had.
  That file is now a re-export.
- **The grading LEVEL moves the SCORE, and the letter follows it**
  (`shared/gradeLevel.ts`, Settings → Preferences, grades 3-12). It moved the
  letter only at first, on the argument that the report's six components add to
  the number shown; the owner's answer was that the number is what a student
  reads, and a 78 with an "A+" beside it is a card arguing with itself. So the
  ring shows `adjustedScore` and the report prints the step — rubric score,
  credit, total — as its own row, which is what keeps the arithmetic visible.
  4 points per year below 12, the level the bands are written against, so an
  install that never opens the setting grades exactly as before.
- **The bands are the standard scale**: 90-100 A, 80-89 B, 70-79 C, 60-69 D,
  below 60 F, with thirds inside each decade for the plus and minus. The Figma
  frame's own example (82 reading "B+") is the one thing that gave — on this
  scale 82 is a B-, and a grading scale belongs to the reader rather than to
  the mockup.
- **Real names stop being underlined, and the learning is SESSION-SCOPED by construction.** Chromium's dictionary does not know "Hepburn", "Arnhem" or "Lähteenmäki", and nothing in this repo draws that squiggle, so the only lever is telling Chromium about the document's names.
  - **Electron has exactly one API for it and it is PERSISTENT.** `addWordToSpellCheckerDictionary` writes to the user's real custom dictionary; there is no per-session word list and no way to ask Chromium whether it already knows a word. So session-scoped had to be built as *added and reliably removed*: `spellcheck.ts` keeps the set it taught, `learnDocumentNames` diffs against it (so switching documents forgets the previous one's names), `before-quit` removes them all, and **`recoverLearnedNames` clears the leftovers at startup after a crash** — without that last one an unclean shutdown makes the learning permanent, which is the exact outcome the design exists to prevent. Only words Tracely added are ever removed, so a word the user added through "Add to dictionary" is untouched.
  - **The test for a name is mid-sentence capitalisation, not capitalisation.** Every sentence starts with a capital, so a word capitalised only there is evidence of nothing. It must also appear TWICE: a name used once is the one the writer is least likely to have proof-read, and a misspelling learned is a misspelling hidden — a worse failure than the squiggle it removes.
  - **Learned from `withoutWorksCited(text)`, never the raw draft.** A reference list is title-case noise — "The Pen Is Mightier Than the Keyboard", "Psychological Science" — and measured on real documents it took the list from 27 words to 5-7 actual names. Cited authors are still learned, because an in-text citation puts them in the body.
  - **Screen Watch deliberately does not do this.** It reads other applications' text, and teaching the user's dictionary from whatever is on screen is not a thing a passive reader should do.

- **The ML worker's IMPORTS have to be unpacked too, and that was the root cause
  of everything above.** Unpacking `out/main/mlWorker.js` moved the worker OUT of
  `app.asar` so worker_threads could read it — and Node then resolves that
  worker's bare imports by walking up from `app.asar.unpacked`, never into the
  archive. `@huggingface/transformers` is pure JS, matched none of the existing
  globs (`onnxruntime-node` is unpacked only because `**/*.node` and `**/*.dll`
  caught its binaries), and stayed inside the asar where the worker cannot see
  it.
  - **Measured by running the shipped worker directly** against
    v0.3.94-preview.184: `Cannot find package '@huggingface/transformers'`.
    `ml/index.ts` then latches `unavailable`, `embedCached` returns null,
    `classifyClaim` returns **'scholarly' for every claim**, and the two
    providers gated on a routed domain — web search and Wikipedia — never run at
    all. Retrieval also drops to lexical word overlap. Silently, as designed.
  - **This is the same failure as v0.3.76 and v0.3.91, a third directory over**,
    and it is why the ML packaging rules are called load-bearing.
  - **`verify-packaged-ml.mjs` could not catch it, for a reason worth keeping.**
    Its expectations read `app.asar` — the wrong place to look for something
    resolved by name — and its embedding test resolves from the REPO's
    `node_modules`, because run from the repo Node walks up past
    `release/win-unpacked` and finds them. Green on the build machine, broken on
    every user's. The new assertion is a filesystem check against
    `app.asar.unpacked/node_modules`, which is true or false the same way
    wherever it runs, and it was confirmed to FAIL against the installed broken
    build before being trusted.
- **`shared/sourceCredibility.ts` asks whether a MARKER would accept a source,
  which retrieval never did.** Relevance answers "is this page about the claim";
  citability is a different question and nothing asked it. Owner, 2026-08-21, on
  what one web search returned: TIME and British Heritage beside Historydraft,
  The Vintage News and The Imaginative Conservative — a paper of record, a
  timeline site, an enthusiast blog and an opinion journal, offered as five
  equal options. A student loses marks for three of them and the card said
  nothing.
  - **Decided LOCALLY and deterministically**, not by the model. The relay
    prompt already says to avoid content farms and returned those five anyway,
    labelling an enthusiast history site `news`. A model grading its own output
    grades it generously, and this verdict has to be defensible to a student who
    disagrees — same stance as `scoring.ts` and `weaknessSeverity.ts`.
  - **Nothing is hidden.** Unvetted sources are ranked last and labelled, never
    dropped: filtering silently would leave a writer unable to tell "found
    nothing" from "found things and binned them", and after a day of cards
    wrongly reading "No sources found" that state must not get easier to reach.
  - **`unvetted` is grey, never red.** It means "Tracely does not recognise this
    publisher" — a fact about our list, not about the site. The same rule the
    cited-source block follows.
  - **The tier outranks the match percentage**, and that is the point. Measured
    in the harness: Historydraft scored 0.71 against TIME's 0.62 and still sorts
    below it. The allowlists are deliberately short — a long one is a long list
    of things to be wrong about — and `.gov`/`.edu`/`.mil`/`.int` need no list
    at all, because those registries cannot be bought.
- **An EMPTY evidence answer is cached for MINUTES, not a day**
  (`EMPTY_TTL_MS` in `cachedEvidence.ts`). `safeSearch` turns every provider
  failure into `[]`, so "nothing exists" and "every provider failed" arrive at
  the cache as the same value — and both were frozen onto the claim for 24
  hours. That is the wrong bet twice over: an empty result is far more likely
  transient, and it is the one answer a writer retries.
  - **It is what made three consecutive fixes invisible.** The v7 key bump and
    the retrieval-generation retry both correctly triggered a fresh search, and
    both were handed a row cached at 00:37 saying `evidence: 0`, live until the
    next day — on exactly the document being used to judge them. Owner,
    2026-08-21: *"wait it still does it I dont know why???"*
  - **Fixing the TTL does not reach rows already written**, which is why this
    also bumped the key to v8. A TTL change is about the future; the version is
    the only thing that reaches the past.
  - **When a retrieval fix appears to do nothing, look for a cached empty before
    looking at the code.** Compute the key (`sha256` of
    `search:aggregate::v8::${query}::${claimText}`) and read the row — three
    layers of staleness have now hidden three separate fixes here, and each was
    one query away from being obvious.
- **A stored score has a RETRIEVAL GENERATION, because the request cache is only
  half the staleness** (`shared/retrievalGeneration.ts`, migration v6).
  `cachedEvidence.ts` versions the 24h cache; nothing versioned the answer
  written into `claims`. `findSearchedClaimByText` matched on `strength_score IS
  NOT NULL` — **and 0 is not null** — `insertClaims` copied the score, the
  breakdown and the `claim_evidence` rows onto every future analysis of the same
  sentence, and the editor's sweep only searched claims whose score was NULL. So
  an empty answer from an older fan-out was reported forever, and the app never
  consulted the cache because it never searched again.
  - Measured on the owner's database, 2026-08-21: **123 stored claims scored
    with zero sources, across 14 distinct sentences**, still saying "No sources
    found" hours after the build that could answer them had installed. Owner:
    *"why does it still do this."*
  - **BUMP IT WHEN `findEvidence` GAINS OR LOSES A SOURCE OF RESULTS**, not for
    a ranking change — `rescoreFromBreakdown` already re-scores stored
    breakdowns on read, so weights flow through without it.
  - **Old rows stay NULL rather than being backfilled.** Null means "produced by
    something we can no longer identify", which is what makes the sweep retry
    them once; backfilling would preserve the bug the column exists to clear.
    One fresh search stamps the row, so it converges rather than looping.
  - **The harness cannot drive that sweep.** `analysisIdRef` is set only by
    running insights, so opening a document in the preview never fires it. This
    was verified against a COPY of the real database instead — migration
    applied in memory, then the old and new inheritance queries run
    side by side on the owner's own claims.
- **The prose popover lives in its OWN layer, because `.docprose-layer` is a
  stacking context.** That layer is `z-index: 1` deliberately — claim marks
  should read above prose marks — and a positioned element with a z-index traps
  its descendants, so `.docmark-popover`'s `z-index: 3` could only ever mean "3
  among this layer's children". The claim marks at `z-index: 2` painted straight
  over an open prose card. Owner, 2026-08-20: *"when I hover over the style
  underlines … the normal yellow orange underlines appear over the overlays."*
  - `.docprose-popover-layer` is a SIBLING of the claim layer. The marks stay at
    1: raising the whole layer would have fixed the card by breaking the thing
    the z-index was there for.
  - **`elementFromPoint` cannot test this on its own.** Every mark is
    `pointer-events: none`, so hit-testing skips them whatever the z-index, and
    the first probe reported a pass in BOTH states. Turn `pointer-events` on for
    the duration and it discriminates: `docprose-card-body` with the fix,
    `docmark-band` with the layer forced back to 1.
- **"Replace citation" is scoped to the claim's SENTENCE, not to the document.**
  `replaceCitationText` required the defective text to be unique in the whole
  draft and refused otherwise — so pasting one malformed reference after four
  sentences made all four permanently unfixable, each blocked by the other
  three. Owner, 2026-08-20: *"this keeps appearing."* One bad source used
  repeatedly is the ordinary way a student produces this, not an edge case.
  - The uniqueness test was standing in for *"am I replacing the right one"*,
    and the card already knows: it was opened from ONE claim.
    `sentenceRangeAround` (extracted from `sentenceAround`, same code, now
    returning offsets) bounds the search. Duplicates elsewhere became
    irrelevant rather than fatal — and it is strictly more correct, since a
    unique match in another paragraph was never the right target either.
  - **Still refuses when the SAME SENTENCE carries it twice.** Genuinely
    ambiguous, and guessing rewrites the half the writer was not looking at.
  - **The error message named the wrong cause**, which is why it read as a
    glitch: *"Could not find … in the document any more — it may have been
    edited"* over a draft that visibly still contained the text, sending the
    writer hunting for an edit they never made.
- **The IN-TEXT marker had its own copy of the placeholder bug, and #168 did not
  reach it.** `shared/citationInText.ts` read `authors[0].family` raw and fell
  back to the literal string `'Unknown Author'`, so a source with no author put
  **"(Unknown Author, 2025)"** in the sentence above a reference entry that
  correctly began with its title — the two halves of one citation naming
  different things, and the half a reader follows naming something that appears
  nowhere in the list. Owner, 2026-08-19: *"Please never cite 'unknown author'
  again."* Said after #168, because #168 fixed only the reference formatters.
  - **The marker leads with whatever the ENTRY leads with.** That is the whole
    job of an in-text citation, so the fallback is a four-word `shortTitle`, not
    a name. Below the title it falls to the venue, and below that to the year
    alone — a poor marker and an honest one.
  - `realAuthors` here too: providers send placeholders as DATA, and an empty
    list is only one of the shapes "no author" arrives in.
- **A CHAPTER is not a BOOK, and conflating them printed a reference with no
  link.** `citationLocator.ts` gives a book no locator — a book is found by
  author, title and publisher, and that rule is the answer to the owner's "can
  you make it so the citations … is not all Doi?". Crossref types a chapter
  `book-chapter`, `type.includes('book')` collapsed it, and a work whose ONLY
  address is its DOI was formatted without one. Owner, 2026-08-20, on what
  "Replace citation" returned: `Oreskes, N. (2014). The Scientific Consensus on
  Climate Change: How Do We Know We're Not Wrong?. Climate Change.` — *"With no
  link"*.
  - **`venueType: 'book-chapter'` is in `ARTICLE`, not `UNLOCATED`.** Nothing
    catalogues chapter six of an edited collection. The whole-book case is
    untouched, so the original complaint still holds.
  - **The bare venue was the second half of the same bug.** `Climate Change.`
    printed in the slot a journal name occupies, naming a journal that does not
    exist. APA and Chicago mark the container with `In`; MLA 9 does not.
    `shared/citationTitle.ts` owns both that and `endTitle`, which stops
    `…Not Wrong?.` — every formatter stripped a trailing PERIOD and appended its
    own, guarding one of the three marks a title can end with. In MLA and
    Chicago the doubled mark lands *inside* the quotes, where it reads as the
    writer's typo.
  - **THE MIGRATION IS THE HALF THAT MAKES IT VISIBLE.** `upsertSource` returns
    the existing row untouched when the DOI matches, so a re-search never
    re-classifies anything and the fix would have reached no stored row — the
    same shape as v6's inherited claim scores, where three correct fixes in a
    row were invisible. Migration v7 reclassifies on the CONTAINER TITLE, which
    is what the field means rather than a heuristic: a chapter always sits in
    something, a whole book sits in nothing. Measured on both of the owner's
    databases before it was written — 142 of 148 `book` rows carry a container,
    and the 6 that do not are real books.
- **A citation NEVER carries a placeholder author.** `formatAuthors*` returned the literal string `'Unknown Author'` for an empty author list, which is not a citation in any style — it is a placeholder that reads to a marker exactly like an invented source, and the same string in a draft's reference list is what made `referenceCheck` search Crossref for an author called "Author" and the critique call three true sentences fabricated. They now return `null` and every formatter moves the TITLE into the author slot, which is what APA, MLA and Chicago all prescribe for an unattributed work. Title-first rather than refusing to format: the citation that comes out is correct and usable.
- **A hover card shows the FIRST SENTENCE of a critique, never the whole thing** (`shared/critiqueSummary.ts`). `popoverCopyFor` used `claim.critique` verbatim, and `CRITIQUE_SYSTEM_PROMPT` budgets that at "under 120 words" — a specification for a report, rendered into a popover. It also arrives as markdown, which was being shown raw. The full critique is still in the report, unchanged; the prompt asks for the finding first and the reasoning after, so the first sentence is the verdict.
- **`shared/weaknessSeverity.ts` decides the Strong / Needs Work badge, and it is NOT `issues.length === 0`.** Owner, 2026-08-19: *"It feels like the system is flagging things just for the sake of flagging them."* With twenty-odd kinds live, every finding of every kind flipped the badge, so one "obviously" printed the same NEEDS WORK as a circular argument and a well-written draft could not keep a single Strong. The badge asks "would a marker take marks off", the findings list still shows everything, and **an unlisted kind defaults to substantive** — a real problem shown quietly is worse than a small one shown loudly.
- **Revision guidance is one sentence per field, capped at 110 characters and tested.** It was capped at 340, which let the three fields reach ~640 characters — about 100 words behind a "+ How to fix this" toggle. Skimmable is the requirement; the depth belongs in Tracer.
- **Two prose rules had to learn what a reference list looks like.** `capitalisation` flagged the `h` in `https` after "…National Biography." and suggested capitalising it, which BREAKS THE LINK — confidently wrong and destructive if taken. `filler` flagged "really" in "the stakes are not really about essays", where the negation makes it load-bearing and removing it changes the sentence. Both now have guards (`URL_START`, `NEGATED_BEFORE`).
- **`\b` written through a shell heredoc becomes a literal 0x08 backspace byte, and it is invisible in every tool that renders it.** It happened again on 2026-08-19 and cost several turns: the regex compiles, the tests pass, and the rule silently never matches. `grep -P` cannot be used to find it in this environment's locale. **Check with `od -c` — 0x08 renders as a single `\b` cell where a real backslash-b renders as two.** A pre-existing one was found the same way in `revisionGuidance.test.ts`, where `DESCRIPTIVE = /^(the|this|…)<0x08>/i` had made that assertion vacuous. Prefer the Edit tool for anything containing a regex.

- **`shared/rubric.ts` is the list of things Tracely is allowed to flag, and it is enforced rather than promised.** Owner, 2026-08-19: *"from now on, ONLY flag stuff that come out of this list."* Two mechanisms, and both are needed:
  - `FLAG_RUBRIC_SOURCE` is a Record TOTAL over `StructureWeaknessKind | CohesionFindingKind | ProseIssueKind`, so a new flag kind does not compile until someone names the rubric clause it comes from.
  - `rubric.test.ts` asserts each named clause is a VERBATIM substring of `RUBRIC_TEXT`, and that it sits under the section it claims. The compiler cannot tell a real clause from a plausible one; this can. **Both failure modes were probed by breaking them deliberately** — an invented clause and a mis-attributed section each fail by name.
  - **When the owner revises the rubric, replace `RUBRIC_TEXT` wholesale and let the test name the flags that no longer have a home.** That failure is the review.
  - **Three flags were deleted to land this, and one of them hurt.** `no-counterargument` — the rubric says "Do not require counterarguments for every essay; judge based on the prompt and genre", and Tracely never sees the prompt, so it cannot judge and must not require. `passive-voice` — absent from the rubric, and against its opening line about judging thinking rather than how sophisticated the writing sounds. `spacing` — "Do not heavily penalize an occasional typo or comma mistake." Two `citationShape` defects went the same way: `duplicated` and `undated` are formatting, and SOURCE USE asks only whether a source SUPPORTS the claim.
  - **The route back for any of them is a new rubric clause, not a widened neighbouring one.** A mapping that stretches is the same failure as no mapping, one commit later.
  - **Counterargument still carries 15 points in `scoreDraft.ts`.** Removing the flag while leaving the penalty is a known inconsistency, raised with the owner rather than fixed unilaterally: silently docking 15 points for something the report no longer mentions is worse than either answer alone.

- **`shared/paragraphNames.ts` owns EVERY name a paragraph is given, on every surface.** There were four schemes drawing one report: `paragraphNames` (title dropped, body numbered) headed the row, `P{paragraph.index}` sat beside it, `ordinal(paragraph.index)` wrote the finding's prose, and `¶{fromIndex}` labelled the seam. On a titled essay the first disagrees with the other three by one, so a card headed **"Paragraph 11"** carried **"The 12th paragraph states something absolutely"** — read, correctly, as a report about a paragraph the writer was not looking at. Owner, 2026-08-19.
  - **`paragraphSubject` is the prose form and `paragraphTag` the chip form**, both derived from `paragraphNames`, so a fifth scheme cannot be added without noticing. `weaknesses.ts` imports them through a relative `.ts` path — it is a tested leaf.
  - **The templates take a full subject phrase now** (`${where} states…`, not `The ${where} paragraph states…`), because "The Introduction paragraph" is not a sentence. An ordinal also *cannot say* "the conclusion", which is half the reason it went.
  - **`cohesion.ts` names nothing at all.** Its message opened `¶12 → ¶13 —` while the renderer drew the same pair beside it — the location printed twice and wrong once. The finding carries `fromIndex`/`toIndex`; only the surface knows whether the draft has a title, so only the surface may name them.
  - `paragraphSubject` returns `'This paragraph'` for the title or an index off the end. Inventing a number there is the exact failure it exists to remove.
- **The Strong / Needs Work badge is `needsWork(this paragraph's findings)` and nothing else.** `ArgumentScoreModal` computed it from the average of `outline.components` for the paragraph's ROLE — draft-level numbers, identical for every paragraph sharing a role and blind to the findings printed underneath. So the full report (which asks `weaknessSeverity.ts`) said NEEDS WORK and the card behind that row said **Strong**, about one paragraph, on one screen. Owner, 2026-08-19. Both surfaces ask `shared/weaknessSeverity.ts` now; the role components are still drawn as bars, where they are labelled as what they are.

- **The rubric asks what a paragraph IS; `structure/reasoningIssues.ts` asks whether it does the job.** A draft could score well by being well-formed — a thesis in place, evidence present, a conclusion at the end — while none of the links between them held. The reasoning pass reads the prose for the CLAIM → EVIDENCE → REASONING → SIGNIFICANCE chain and names the link that is missing: evidence dropped without analysis, an absolute nothing earns, emphasis standing in for argument, a demonstrative with no antecedent, a conclusion that restates the thesis, a sentence that repeats the one before it, an opening that would fit any essay.
  - **Most of the rubric is NOT in that module and must not be moved there.** Whether evidence actually proves the claim it is attached to, whether a counterargument is the strongest available one, whether an analysis explains a mechanism or merely restates — those need a reader. They live in `CRITIQUE_SYSTEM_PROMPT` (Pass 3) and `STRUCTURE_SYSTEM_PROMPT` (`hasWarrant`) in `../Tracely-relay/lib/prompts.ts`. What is local is the subset a rule can be *right* about.
  - **Every detector is anchored** — to the end of a paragraph, the start of a paragraph, or a closed word list — rather than matched anywhere in the draft, and the negative tests outnumber the positive ones. Two rules were already caught being too wide by their own negatives: `\([^)]*\)` read "(an itinerary few would attempt)" as a citation, and `every (?:country|society|culture)` read "she visited every country on the itinerary" as an unfalsifiable claim. Both were narrowed rather than kept with an exception list.
  - **Exactly two of the findings reach the score, and both quote the sentence they cost points for.** `dropped-evidence` vetoes `hasWarrant` in `analyzeStructure` — a paragraph whose last sentence IS the citation has demonstrably not explained it, and where the label and the text disagree the text wins. `restated-conclusion` halves the conclusion component, compounding with the existing halving for a misplaced one. Nothing else touches the number: a prose rule is a weaker instrument than a role label, and the rule of this rubric is that a point lost traces to something the writer can look at.
  - **They are NOT gated on `allLabelled`, unlike every whole-draft weakness.** That gate exists because "this draft has no counterargument" asserts something about paragraphs nothing read; these assert something about words that are demonstrably there and are quoted back. Suppressing them because a model returned `unknown` for paragraph 6 would withhold the only feedback that does not depend on the labelling at all.
  - **`dropped-evidence` suppresses `warrant-gap` on the same paragraph.** They are one complaint from two sources, and a report naming both reads as two problems. The quoted one wins.
  - `StructureWeakness.quote` is optional because the seven original kinds have nothing to quote — an absence has no words. `ArgumentScoreModal`'s problem card falls back to it when there is no claim behind the finding.

- **The classifier NAMES the reasoning fault; it does not just report that there was one.** `hasWarrant` is a boolean, and the model was making a far richer judgement to answer it — the prompt asks it to tell summary from a logical leap from sequence-read-as-cause from a single-case generalisation. All of that was discarded on the way back, so a paragraph treating a correlation as a cause and one that simply stopped after a quotation produced the identical sentence: *"presents evidence without explaining how it supports the argument."* `ReconciledRoles.reasoningFailure` carries the name; `circular-reasoning`, `sequence-as-cause`, `single-case-generalisation` and `logical-leap` are the resulting weaknesses, each citing its own rubric line.
  - **Same call, same model, no extra cost.** The work was already being done.
  - **A named fault VETOES `hasWarrant`** the way `dropped-evidence` does, so the finding costs marks rather than being free — and it REPLACES `warrant-gap` on its paragraph, because they are one complaint at two resolutions and printing both buries the one that says something.
  - **`'none'` must stay the easy answer.** The prompt says so explicitly, including for paragraphs where `hasWarrant` is false: a paragraph that presents a statistic and stops has no reasoning to be faulty, it has none at all. Without that line the field becomes a slot the model fills.
  - **The model supplies a LABEL and never a sentence.** Every word a student reads is a local template in `weaknesses.ts` — the rule that file has held since it was written.
- **`structure/thesisSupport.ts` answers the two rubric lines no rule can reach**: *"Flag if the body paragraphs do not actually support the thesis"* and *"Flag tangents."* Both had zero implementation. It embeds each body paragraph and the thesis with the LOCAL MiniLM in `services/ml` and reports the ones below `MIN_THESIS_SIMILARITY` — free, in-process, no relay, which is what makes it safe to run on every analysis.
  - **0.15, and it is NOT `MIN_COUNTABLE_RELEVANCE.dense` (0.42).** That constant separates "this source speaks to this claim" from "it does not". Two paragraphs of ONE essay are related by construction, and a body paragraph developing a strand of the argument sits at 0.25-0.40 from the thesis — exactly what it should look like. Borrowing 0.42 would flag half of every draft. On the same labelled pairs irrelevant sources sat at 0.03-0.23, so 0.15 is inside that band rather than at its edge.
  - **`cohesion.ts`'s `topic-jump` is not this.** It compares a paragraph to its NEIGHBOUR, so an essay that drifts away from its thesis over five paragraphs passes it at every step.
  - **Null, never `[]`, when nothing could be measured** — no thesis, no ML worker, too little text. The caller must be able to tell "nothing is off-topic" from "nothing was measured"; only the first is a finding.
  - **The thesis position comes from the MODEL only**, never the local fallback. That fallback is good enough to score a component and not good enough to tell a student a paragraph does not belong in their essay.
  - The decidable half lives in `thesisSupportRules.ts` so `npm test` can load it — `thesisSupport.ts` value-imports the ML worker and is therefore untestable, the same constraint `analyzeStructure` lives under.

- **The classifier is sent the ARGUMENT, not the bibliography, and `shared/structureText.ts` is what keeps it that way.** `ipc/structureHandlers.ts` classified `splitParagraphs(input.text)` while `analyzeStructure` scored `splitParagraphs(withoutWorksCited(input.text))` — under a comment reading *"The paragraphs are split here with the SAME function analyzeStructure uses."* Same function, different input; the warning was accurate and describing the code beneath it. Both now call `argumentParagraphs`, so the invariant is a shared function rather than a comment.
  - **Measured across the owner's five real documents, 2026-08-19: 42% of the paragraphs sent to the classifier were reference lines, and 24% of its input tokens.** A quarter of every structure call asked a model what role an ODNB entry plays in the argument.
  - **It also explains most of a 37% `unknown` rate** across 249 cached classifications, which had made the classifier look far worse than it is. A reference line is correctly `unknown`; it just should never have been asked.
  - **Alignment survived only by luck.** `withoutWorksCited` trims a SUFFIX, so indices 0..n-1 of the untrimmed vector name the same paragraphs. The real exposure is the caps: `MAX_STRUCTURE_PARAGRAPHS` (24) and `MAX_STRUCTURE_INPUT_CHARS` (8000) apply to whatever is handed over, so a long bibliography pushes real paragraphs out of the classification entirely — one of those documents already sends 25 paragraphs, 11 of them references.
  - **Read the cached relay responses before theorising about the classifier.** `request_cache` holds every `ai:classifyStructure` and `ai:critique` result the app has ever received; the role distribution, the `hasWarrant` rate and the verdict spread are all one query away, and every wrong guess in this feature's history would have been caught by looking.

- **Three scoring changes on 2026-08-19 closed a 25-point gap that was entirely labelling artifact**, measured on the owner's own essay: 75/100 where every lost point came from one of these, not from the writing.
  - **`conclusionFallbackIndex`** — the mirror of `thesisFallbackIndex`, and it exists for the same reason `significanceAnywhere` does. A paragraph carries ONE role, and the closing paragraph is routinely both the conclusion and the place the stakes are stated; the classifier called it `significance`, so `lastIndexOf('conclusion')` was -1 and the draft scored 0/10 for a conclusion plainly there. `looksLikeClosing` already returned true on it — the signal existed and was simply not consulted.
  - **Counterargument leaves the DENOMINATOR when the draft has none**, and the remaining 85 rescales to 100. The rubric: "Do not require counterarguments for every essay; judge based on the prompt and genre", and Tracely never sees the prompt. Deleting the `no-counterargument` finding while keeping the 15-point penalty was the worst of both — the draft still lost the marks and the report no longer said why. A draft that raises one still earns it, so the move can only help.
  - **A paragraph credited by another component no longer dilutes `governingClaims`.** `counterargument` and `significance` can never satisfy `governsAClaim` (deliberately — no double pay), so leaving them in the divisor charged the draft for paragraphs it had already been rewarded for. **Adding a counterargument took the score DOWN**, which was invisible until the rescale stopped masking it, and was caught by a monotonicity test rather than by reading. `unknown` and `transition` deliberately stay in the divisor: that dilution is the anti-padding property.
  - **The essay now scores 100, and that is the remaining problem rather than the fix working.** `warrant` and `governingClaims` are computed from the classifier's labels and still saturate — every paragraph came back warranted. Do not answer that by re-adding a penalty somewhere else; the lever is the classifier prompt.

- **Four of the six components are presence checks, and two now have a quality axis.** Owner, 2026-08-19: *"Can these all be 100%? Besides significance and counterargument, it just doesn't make sense."* They could, and it didn't: `thesis` was 20/20 for a thesis-shaped paragraph in the first third, `conclusion` 10/10 for a last paragraph labelled one. `topic-not-thesis` now halves the first (an opening that announces a subject has oriented the reader and claimed nothing) and `restated-conclusion` halves the second, each compounding with the existing positional halving. `summary-without-point` vetoes `statesClaim`, so a paragraph that only relays sources stops counting toward `governingClaims`.
  - **This narrows the saturation; it does not remove it.** The remaining cause is that `warrant` and `governingClaims` are computed from the role vector, and the vector is only as good as whatever produced it. In the editor that is the relay classifier; in Screen Watch it is `roles.ts`, hand-written patterns, where a draft can max `warrant` by writing "therefore" once per paragraph. **An earlier version of this bullet said the classifier was not deployed. It is, and has been** — see below. The lever is the classifier's PROMPT, not its existence.
- **`new-claim-in-conclusion` is gated on `conclusionDrawsOnBody`, and was wrong without it.** It fired on ANY detected claim in the closing paragraph, which is the move a conclusion exists to make: owner, 2026-08-19, *"obviously by the end, it is completely supported by everything above. It is simply creating a claim using the evidence from everything preceding it."* Correct. The finding is only about a claim made of material the draft never introduced, measured as vocabulary overlap with everything above it, at a deliberately low bar (half) — a false positive here tells a student to delete the best sentence in their essay.
- **Where a critique's money actually goes**, measured 2026-08-19 from the caps in `costGuard.ts` and the price table in the relay's `lib/usageLog.ts` (gpt-4.1, $2/$0.50-cached/$8 per 1M): system prompt 32% (3,213 tokens, identical every call, so it prefix-caches at a quarter price), **evidence summary 40%**, completion 26%, claim and score 2%. A warm call is ~$0.004; six are ~2.9c.
  - **The evidence summary is the lever, not the system prompt.** The prompt is the bigger token count and the smaller bill, because it is cached; the evidence is fresh every call.
  - **`searchedSlots` takes `citedHasAbstract` for that reason.** Pass 2.5 tells the model to STOP at slot 1 when the cited source answers — "do not read the other items" — and we were sending three of them anyway at ~225 tokens each. When the resolved work came back with an abstract the client knows the model can answer from it, so one fallback goes instead of three; with no abstract, Pass 2.5's own fall-through condition is already met and the full set goes. ~20% off a cited claim's call, and the request now agrees with the prompt instead of contradicting it. An UNCITED claim is untouched: that list is not a fallback, it is the evidence.
  - **Anything changing what is SENT must change the cache key.** `searchedSlots` is exported precisely so `cacheKey` and the request derive the cut from one place; the abstract flag is now in both.
  - **Not done, and why:** batching claims into one call saves ~27% of the prompt cost and breaks the per-claim SQLite cache — editing one sentence would re-critique all six, which makes the common case worse. `gpt-4.1-mini` is 5x cheaper and is a real option, but it is the model that has to hold `fabricated` to a high bar, and swapping it is an eval question (`eval/critique/FINDINGS.md`), not a config change.
  - **The cache hit rate is assumed, not observed.** `logUsage` prints `cached=N (X%)` per call and nothing has read it. Six auto-critiques fire back to back so calls 2-6 should hit; one essay an hour may pay cold every time. Read the relay logs before optimising further.

- **The citation check has a free half and a paid half, and they were added together for one reason.** Once `claimsWithoutEvidence` stopped calling a cited claim unsupported, a broken citation and a good one both went silent — the owner's own draft carried `(Unknown Author, 2025)` one card below a real reference and neither was named.
  - **Free: `shared/citationShape.ts`** — defects visible in the SHAPE of a reference, nothing read. Placeholder authors, `[citation needed]`, a year that has not happened yet, a bare URL, `n.d.`, and the same reference pasted twice in a row (which that draft also had). Raised as the `malformed-citation` weakness, run per paragraph over the works-cited-TRIMMED spans — a reference list is a page of parentheses and every rule would fire down it. **"Anonymous" is deliberately not a placeholder** and `(Smith)` with no year is deliberately not a defect: nothing on the surface separates it from "(see Smith)".
  - **Paid: `autoCritiqueCited`** (Settings → Preferences, ON by default). The critique is the only thing in this app that opens the cited work, so it is the only thing that can tell a formatting slip from a fabrication. Eligibility lives in `shared/autoCritique.ts` — a tested leaf, not a `useEffect` — because it decides when money is spent without anyone pressing anything: cited only, evidence resolved, no verdict yet, capped at `MAX_AUTO_CRITIQUE_CLAIMS`, in document order.
  - **ON by default here, still NEVER in Screen Watch, and the difference is consent.** Screen Watch reads whatever is on screen forever without being asked, so an unprompted paid call there is a bill nobody can watch being run up — that rule stands. This fires inside a document the user opened, on claims they themselves attached a source to. `autoCritiquedRef` guards re-firing, and a failed settings read leaves it null so the sweep never runs.
  - `MAX_AUTO_CRITIQUE_CLAIMS` is defined in `shared/` and **re-exported from `costGuard.ts`**, so that file stays the one place to look for an AI limit while the renderer — which drives the sweep — can still import it.
  - **`hasCheckableAssertion` is ANY DIGIT, and it used to be a list that only
    ever matched a year.** The five branches — four-digit year, percentage,
    magnitude word, `\d{4,}`, calendar date — read as a policy and behaved as an
    incomplete enumeration. Measured 2026-08-20: `Lamine Yamal is 22 years old`,
    `The Eiffel Tower is 90 metres tall`, `Mount Everest is 5,000 feet high`
    (the comma beat `\d{4,}`) and `Barack Obama was the 43rd president` were
    ALL skipped; only the year sentence passed. Owner, on the first: *"it didnt
    flag it."* The docstring already promised "a quantity", so the test is now
    the thing the branches were enumerating.
  - **The cap now prefers claims with a hard number when it cuts.** A CITED
    claim qualifies on its citation alone and may carry no assertion at all, so
    six vague cited sentences at the top of a draft could take every slot. A
    stable partition, so document order still decides within each group.
  - **ELIGIBILITY IS THE CLAIM'S TYPE NOW, not a pattern over its text**
    (`isCheckableClaim`). A digit-only gate catches the arithmetic half of
    being wrong and nothing else: `Lamine Yamal plays for Real Madrid` is
    false, uncited, and carries no number, and it was answered with a list of
    topical sources. The relay already returns `factual | statistic | causal |
    opinion | prediction` on every claim and nothing here read it —
    `opinion`/`prediction` are exactly the "nothing for Pass 1 to be confident
    about" cases this module had been describing in prose and inferring from
    punctuation.
  - **This SPENDS more on purpose.** A draft with no numbers in it used to
    critique nothing; now almost any analysis uses its full
    `MAX_AUTO_CRITIQUE_CLAIMS`. Owner, 2026-08-20, shown the trade first: *"do
    the claimType gate too."* The ceiling is unchanged — six per analysis, once
    per analysis id, and `ai/critique.ts` caches on claim TEXT so re-opening an
    unedited document is free. **`hasCheckableAssertion` survives as the
    RANKING signal**, deciding which claims get the six slots.
  - It reversed four tests in `autoCritique.test.ts`, and the fix was the
    FIXTURE rather than the assertion: they hardcoded `claimType: 'factual'` on
    interpretive sentences the relay would type `opinion`. The ones testing the
    citation path now pass `opinion` deliberately, so they measure that path in
    isolation instead of passing for the wrong reason.
  - The Settings toggle is **"Fact-check my claims automatically"**. It read
    "Check my citations automatically" over a setting that had also been
    fact-checking uncited claims since the WWII fix — a label describing half
    of what the switch does, on the switch that spends money.

- **A claim the WRITER cited is never reported as unsupported on retrieval's say-so.** `claimsWithoutEvidence` filtered on resolved / no-relevant-source / in-scope and never asked whether the sentence carried a reference, so a line ending `(Lähteenmäki, 2006)` was named **"Unsupported claim · 0/100 evidence — no supporting source yet"**. That sentence is not unhelpful, it is false: there is a supporting source, in the sentence. What was established is that a topical search of four scholarly indexes returned nothing, and nothing in the retrieval path ever opens the work the writer named.
  - It is the SAME rule `problemKindsFor` has applied to the underline since 2026-08-16, where `nothingFound` gates `cited-unverified`. The two surfaces were reading one claim and disagreeing — the mark stayed quiet, the report accused. `citationLookup` is now shared with `computeEvidenceCoverage`, so a claim counted under `withOwnCitation` cannot also be listed under "no supporting source" in the same panel.
  - **Pass `documentText`.** A detected claim is a sub-span of its sentence, so the reference frequently sits outside the claim text; without the document this falls back to the claim-only test and misses it. Both callers (`structureHandlers`, `watchOutline`) pass it.
  - **The cost is the same one `problemKind.ts` already accepts: a genuinely miscited claim says nothing HERE until the critique runs.** That is not a gap — `citedEvidence.ts` puts the writer's resolved source in slot 1 and `CRITIQUE_SYSTEM_PROMPT` Pass 2/2.5 judge the citation itself, which is the only path in this app that ever reads it. Retrieval cannot reach `citationFix` or `fabricated` and must stop implying it has. **Critique is manual**, so between analysis and that click Tracely is silent about a cited claim rather than wrong about it.

- **A strength score of 0 means two different things and must not render as one.** When nothing clears the relevance floor, every factor in `ScoreBreakdown` is 0 by construction, and the Argument Check card drew "0/100" over four empty bars beside a correctly cited biographical sentence. `problemKindsFor` has drawn this distinction since 2026-08-16 (`nothingFound` gates `cited-unverified`); the score display had not, so the accusation the problem kinds refuse to make was being made by the number underneath them. `ArgumentScoreModal`'s `measured` now suppresses the number, the track and the metric grid entirely and says what was searched instead. **There were two of these and the first fix caught one**: the problem card's `· 0/100 evidence` chip is a separate render path and kept printing for another day. Both are gated on `hasRelevantSource` now; grep for `/100` before assuming a third does not exist. **Do not reinstate a zero here.** The four indexes hold scholarly articles; biography, institutional records, news and primary texts are structurally outside them, and `retrievalScope.ts` names only five of those categories.

- **Evidence is deliberately NOT in the /100.** `strengthScore` already contains a `sourceCount` factor, so folding retrieval in would double-count it — and worse, would make the score track how *searchable* the topic is, capping a close reading of a novel near 50 because the academic APIs have nothing to say about it. `structure/evidenceCoverage.ts` reports it beside the score as a ratio instead. It reads `scoreBreakdown.sourceCount` rather than re-thresholding `claim_evidence.relevance_score`, because which metric produced those values (lexical 0.2 vs dense 0.35 floor) is *not* persisted with the rows.
- **`unknown` is a real answer.** `structure/roles.ts` labels only what a marker or a detected claim justifies and returns `unknown` for everything else; `complete: false` then makes the panel say **"provisional"**, and `structure/weaknesses.ts` **withholds whole-draft findings entirely** while any paragraph is unlabelled — "this draft has no counterargument" is an assertion about paragraphs nothing read. A guessed label produces a confident number computed from nothing, which is worse than admitting the paragraph wasn't read.
- **The structure classifier is gone.** `ai/structureClassifier.ts` and the `classify-structure` endpoint were deleted when the desktop moved onto the Tracely server: nothing had called `classifyStructure` since `ipc/structureHandlers.ts` switched to the graded read (`ai/gradeDraft.ts`, now `/api/grade`), whose paragraph roles replaced it — yet preflight was still probing the route before every release. This bullet said it was live, and before that said it was undeployed; it was right about neither for long.
  - **This paragraph used to say the opposite, and the stale comment block at the top of `structureClassifier.ts` said it too — three enabling steps that had all already been taken.** It cost a wrong answer to the owner about where the grading weakness lives. **Probe the endpoint before repeating either claim**; a source comment is not evidence about a deployment.
  - **Screen Watch deliberately does NOT classify** (`screenWatch/watchOutline.ts`), so the overlay's grade is heuristic-only and the editor's is not. Two surfaces, two label qualities, one rubric — worth remembering before comparing scores between them.
  - **The client and the relay prompt version each other.** `statesClaim` arrived in the client and in `STRUCTURE_SYSTEM_PROMPT` at the same time; a production relay behind staging returns a vector the client then falls back on (`governsAClaim` degrades to `role === 'claim'`). Check `git log origin/main..origin/staging` in `../Tracely-relay` before concluding anything from a production score.
- **It runs in Screen Watch too, and that is where it costs least.** `uia-watch.ps1` returns the *whole* document of the focused control (`TextPattern.DocumentRange.GetText(-1)`, falling back to `ValuePattern.Current.Value`), and the whole engine is local, so the draft score follows the user into Word or Chrome for nothing. `screenWatch/watchOutline.ts` runs it; `screenWatchService.ts` memoises the result against `sourceHashFor(lastAnalyzedText)` + the claim ids + which claims have a relevant source. Three things about that are load-bearing:
  - **It analyses `lastAnalyzedText`, never the live snapshot.** Every paragraph index and role is a joint function of the text *and* the claims found in it; analysing live text while bucketing older claims lets a claim relocate into another paragraph and flips its role underneath the score. It also damps the whole feature for free — that text moves at most once per detection.
  - **The memo protects the payload dedupe, not just CPU.** `updateOverlayAndWidget` dedupes its IPC push by `JSON.stringify` of the whole payload, and it runs on every poll tick *and* every resolved favicon. A structure object rebuilt each tick would differ by identity alone and re-render the overlay over another app at 1.2s intervals forever.
  - **`screenWatch/structureFit.ts` is allowed to refuse.** UIA newline fidelity varies by app: some return the document with no newlines at all, others break on visual lines. `findWeaknesses` suppresses whole-draft findings behind `allLabelled`, but `warrant-gap`/`evidence-stacking` are per-paragraph and are *not* gated that way, so a bad split turns straight into confident accusations about paragraphs that do not exist. The gate fails to silence rather than to noise, and logs why.
- **`weak` and `unsupported` are EVIDENCE-FIT verdicts and must not wear a reasoning label.** The kind was called `weak-reasoning` until 2026-08-19 and is now `unsupported-by-evidence`, drawn in orange with the other evidence findings rather than in the red the design reserves for weak reasoning. Both verdicts come out of `CRITIQUE_SYSTEM_PROMPT` Pass 3, which asks *"does the evidence actually back the claim as phrased?"* — a question about sources.
  - Measured on the owner's draft: *"The study has since had a rough time — Morehead, Dunlosky and Rawson failed to replicate the headline effect in 2019, and anyone citing the original as settled science is overreaching (Shelly J. Schmidt, 2019)."* Some of the best reasoning in the document — a conceded replication failure and a bounded claim — underlined in red as bad thinking, because its cited work turned out to be about a different subject. The critique was right; the label was a category error.
  - **"Weak reasoning" now belongs to the classifier's named faults** (`circular-reasoning`, `sequence-as-cause`, `single-case-generalisation`, `logical-leap`), which are the only things in this app that judge an argument rather than its sources. They are paragraph-level and live in the report. A SENTENCE-level reasoning fault would need Pass 3 to name what it found, the same change the classifier got — until then this kind must not borrow the word.
- **"Compare sources" shows BOTH sources now** (`shared/citedComparison.ts`,
  `CitedSourceBlock` on each surface). It drew one list — what a topical search
  returned — under a heading promising two. Owner, 2026-08-19: *"I want it to
  pull up the source before and the source it recommends now, because that's
  what comparing sources means."* The lookup has existed since #155 because the
  critique needs it; nothing surfaced it.
  - **Free, so it does not wait for a critique.** Crossref and Open Library, no
    relay and no key — which is what lets it run whenever the card opens. The
    card is pressed on sentences nobody has critiqued.
  - **`found: false` must never render as "your source is fake".** Those two
    indexes hold journal articles and books; a UNICEF page, a newspaper, a
    government report and an archive record are in neither, and the lookup
    already misses 2 of 8 real BOOKS on eval/fabrication's set. The block reports
    what was searched and says the empty answer settles nothing — grey, never
    red. That wording lives in one place and both surfaces read it.
  - **Two channels, because Screen Watch persists nothing.** The editor asks
    `citation:resolveCited` by `claimId`; the overlay gets `cited` back on
    `screenWatch:findSource`, since its claims have no id to look up later.
  - **The card's header and buttons are pinned; `.docmark-scroll` is what
    gives.** Making the RESULTS LIST the scroller was the obvious move and does
    not work: measured in the harness, the fixed content came to 415px in a
    341px card, so the list collapsed to zero and the buttons were still drawn
    60px past the editor. `maxCardHeight` (a tested leaf beside `placePopover`,
    which deliberately lets a too-tall card clip rather than flip it) caps the
    card, and it must subtract the tail — eight pixels of card hung past the
    bottom until it did. This is also the answer to owner, 2026-08-19: *"there
    is no dismiss button once I am in it."* There was; it was off the screen.
- **`cited-unverified` and `unsupported-by-evidence` now require that the
  critique actually OPENED the work the sentence cites** (`citedWorkRead` on
  `Claim`, `problemKind.ts`, migration v5). `referenceCheck.ts` resolves the
  cited work and `citedEvidence.ts` gives it slot 1 when it resolves; when it
  does not, the critique reasons over a topical search the writer never claimed
  as support. The four verdicts read identically either way, so `weak` over the
  writer's own source and `weak` over four papers they never cited were the same
  word downstream — and only the first says anything about their citation. Owner,
  2026-08-19: *"It doesn't matter what the other five sources found; as long as
  that specific source backs up their evidence, don't flag it."*
  - **`null` suppresses, exactly like `false`.** Old rows, and any surface that
    does not track it. The assertion needs the source to have been read, and
    "probably" is not read. No backfill is possible — whether a lookup succeeded
    is not recoverable from a stored verdict.
  - **The card stopped quoting the retrieval score, because it was never the
    reason.** It read *"the 5 sources found score 54/100 for supporting it"*
    under a finding the score has not decided since the gate came off. The
    description is `summariseCritique(claim.critique)` now, so `cited-unverified`
    moved into `popoverCopyFor` beside the other critique-driven kinds.
  - **`!nothingFound` is GONE from this kind, and that is a loosening on
    purpose.** It was a PROXY for "do we have any basis to judge this citation",
    written when nothing carried the real answer. `citedWorkRead` is that
    answer and is strictly stronger. The newly reachable case — the critique
    read their source, found it does not carry the claim, and the topical search
    returned nothing — is the most valuable finding in the product, and it was
    being discarded over what OTHER papers did not say.
- **A citation does not have to be in brackets.** `inlineCitation.ts`'s
  `attributed` patterns read prose attribution — "According to Pearson from
  UNICEF", "As the Red Cross reported", "published in the Lancet", "UNICEF's own
  records". Owner, 2026-08-19: *"a citation doesn't need to have parentheses
  directly at the very end … there is not just one way to cite stuff."* A bare
  `Name verb that …` is deliberately NOT detected: in an essay about a person
  that attributes to its own subject and cites nothing. `attributed` is
  deliberately absent from `CHECKABLE_CITATION_SHAPES` — none of these carries
  the author-and-year `referenceCheck` needs.
- **`cited-unverified` has NO retrieval-score gate, and removing it was the fix.** It required `evidence.score < 40`; the sentence above scored 47 and missed by seven points, so the citation finding never fired and `weak-reasoning` did. `evidence.score` measures a TOPICAL SEARCH of four indexes and this kind is about the source the WRITER named — different questions about different documents. The same argument was already made twice in that file for `nothingFound`; it applies to the band as much as to the floor. What licenses the finding is `citationDoubted`, a verdict from the one call that resolves the cited work and reads its abstract. The middle-band `partial-evidence` branch for cited claims went with it — its condition was a strict subset.

- **The `contradicted` verdict is its own problem kind, not weak reasoning.** `CRITIQUE_SYSTEM_PROMPT` reserves it for "a specific fact you're confident is factually wrong" and tells the model to fall through to the rigor pass whenever it is merely unsure — so it is a claim about truth, while every other kind is a claim about support. `problemKind.ts` ranks `contradicted-claim` above everything, including `cited-unverified`.
- **The critique cache is keyed on the claim's TEXT, not its id** (`ai/critique.ts`, v6). Screen Watch mints a fresh `randomUUID()` per detection, so an id-keyed entry could never be hit there: re-detecting an unchanged sentence paid a fresh call on the reasoning model, the most expensive call in the product. `strengthScore` is in the key too, because it is in the request body.
- **Screen Watch claims need BOTH evidence fields folded in.** `withEvidenceScores` in `screenWatchService.ts` sets `strengthScore` *and* `scoreBreakdown`, because `computeEvidenceCoverage` decides "has a relevant source" from `scoreBreakdown.sourceCount`. Folding only the score marks every searched claim resolved-but-unsourced, producing an `unsupported-claim` weakness for every claim that in fact *has* sources. `evidenceCoverage.test.ts` pins this.
- **The editor DETECTS CLAIMS automatically now, so underlines need no button**
  (`shared/liveDetect.ts`, the live-detect effect in `AnalyzeView`). Owner,
  2026-08-21: *"How can we get the underlines to appear immediately, kind of
  like Grammarly, instead of waiting until we click the 'grade essay' button?"*
  - **Detection is not grading, and only ONE of them was ever the button's
    job.** `runStructure` makes two relay calls: `detect-claims`, which is what
    marks are made of, and `grade`, the essay score. Only the first has
    anything to do with underlines. So detection is automatic and **`AI
    Insights` still means "grade my essay"** — automating the second would
    spend the expensive call on every pause and pop a report nobody asked for.
  - **The bounds are Screen Watch's, because it solved this already**: a 2.5s
    idle debounce (shorter than STABLE_MS — an input event is exact where a
    1200ms poll is not), `MIN_DETECT_CHARS` 80, `MIN_DETECT_DELTA_CHARS` 80,
    and `MIN_DETECT_INTERVAL_MS` 15s, which is the real ceiling: the idle timer
    alone bounds nothing, since type-pause-type clears it forever. Re-detecting
    UNCHANGED text is free (`claimDetection.ts` caches on an input hash), so
    what these bound is text that genuinely moved on.
  - **`lastDetectRef` is stamped BEFORE the call**, so the floor measures the
    gap between requests rather than between answers, and a manual
    `runStructure` stamps it too — otherwise pressing the button and pausing
    re-detects the same text.
  - **The debounce keys off `textTick`, NOT `measureTick`.** `measureTick` also
    counts layout (a ResizeObserver on the editor bumps it), so dragging the
    window edge would clear the timer for as long as the drag lasted and
    detection would never run.
- **A claim being CHECKED is drawn, in its own layer**
  (`measurePendingMarks`, `.docpending`). `measureMarks` still refuses to draw
  a claim with no evidence — but its stated reason, *"nothing searches
  automatically in this editor"*, has been false since the sweep landed, and
  the honest reason is narrower: a mark THERE is a finding with a colour and a
  hover card, and a claim mid-search has neither. So the in-flight state gets a
  grey dotted line with **no popover** — hovering something that cannot explain
  itself is worse than not being able to hover it. Grey `#9a9ba1` is the colour
  `problemCopy.ts` already gives `searching` on the overlay, so both surfaces
  say "checking" the same way. `z-index: 0`, under prose (1) and claims (2),
  and `pointer-events: none` like every other layer — verified in the harness
  that a click at a marked word still lands on `docedit-body`, which is the
  Screen Watch click-through bug the prose layer already reintroduced once.
  The pulse is **opacity only** (composited, and it rests at the VISIBLE end,
  so a non-compositing window degrades to a steady line rather than an
  invisible one — the overlay entrance-fade trap).
- **The editor searches evidence automatically, and that is what draws the
  underlines.** `measureMarks` skips any claim with no evidence (null means
  "never looked", and underlining an unchecked claim reports a verdict Tracely
  has not reached), so before this a freshly analysed document had claims, a
  score and NOT ONE mark until the writer found "Check all N" two screens away
  inside the full report. `AnalyzeView` now sweeps unsearched claims once per
  analysis, tracked in `autoSearchedRef` so a search that comes back empty
  cannot loop. The rule that allows it is the same one Screen Watch runs under:
  evidence search hits the four free public APIs and never the relay. Critique
  — the paid call — stays manual on both surfaces. The sweep shows its progress
  (`.docedit-checking`), because a 30-second wait that shows nothing is
  indistinguishable from marks that never come.
  - **The sweep refreshes AS IT GOES, and runs three at a time.** It was a
    strictly serial loop with ONE `onRefreshClaims` after it, so `claims` never
    changed until the last search returned and every underline in the document
    appeared at once, minutes in. Owner, 2026-08-20: *"the underlines are too
    delayed."* A refresh is a SQLite read and a setState — no relay — so it now
    runs per completed claim, behind an in-flight guard because three workers
    finish independently. `runStructure` is the expensive one and stays at the
    end, once.
  - **The four scholarly indexes were never the wait.** Measured 2026-08-20,
    all four answer one claim in ~700ms because they fan out in parallel. What
    costs seconds is `findWebSources`, which `aggregator.ts` **awaits inside**
    the fan-out for any `general`-routed claim — a relay call running several
    site-restricted web searches. Eight of those one after another is where the
    delay came from, so the fix is concurrency across CLAIMS, not tuning
    providers.
  - Verified in the preview harness with 300ms injected per search: three
    starts at t=0, a refresh after each completion, six claims done in two
    waves instead of six. First mark at ~310ms where it was ~1800ms.
- **Screen Watch's 4-second typing debounce does not apply to text that was
  already there.** `STABLE_MS` exists because the 1200ms poll is the pause
  between WORDS, and a drafting writer clears that bar dozens of times a
  paragraph — each one a full relay call on the whole document. None of that
  describes the first snapshot after a tracking reset: a document switched to
  with a page in it was written before Screen Watch looked at it.
  `screenWatch/firstSight.ts` is the rule, as a leaf so it is testable at all.
  - **The length test is the discriminator, and only on the FIRST snapshot.**
    Typing into an empty control arrives a character at a time, so its first
    snapshot is short. Testing length on every change would fire mid-paragraph,
    analyse half a sentence, and then take `MIN_ANALYSIS_INTERVAL_MS` (20s) —
    locking out the analysis the writer was waiting for. Skipping the debounce
    must never cost a detection.
  - **`pendingSince` is BACKDATED, not zeroed.** Every other guard — the delta
    test, the 20s floor, the retry cooldown — still applies. It says "already
    stable", not "analyse regardless". And it still costs one tick, because the
    analysis branch is the `else` of the change branch: two matching reads is
    also what rules out a torn UIA snapshot. ~5.2s becomes ~1.2s, not zero.
- **Tested modules are leaves.** `npm test` runs these through Node's type stripping, whose ESM resolver rejects the extensionless relative imports used throughout this codebase — so a module with a relative *value* import cannot be unit tested. That is why `roles.ts` duplicates three lines of sentence splitting instead of importing `splitSentences`, why the paragraph-bucketing logic lives in `shared/paragraphSplit.ts`, and why `analyzeStructure.ts` is thin: every decision with a wrong answer available sits somewhere the runner can load it.
- **`splitParagraphs` treats ANY newline run as a boundary**, not just a blank line. It runs on the contentEditable editor's `innerText`, where execCommand wraps each Enter in a `<div>` that Chromium renders as a single `\n`; requiring `\n\n` would see a normal essay as one giant paragraph. It lives in `shared/` because the renderer must re-derive the same paragraphs to draw text beside the labels — a `DocumentOutline` carries **no prose**, only indices, roles, booleans and ids.
- **`document_structure` is a cache of a pure function that still has to be persisted**, because it cannot be recomputed on demand: the analysis runs on `innerText`, and `documents.body_html` cannot be turned back into that string from main without parsing HTML. `source_hash` is over the innerText, so reformatting leaves the analysis valid while an edit to the words marks it stale.
- Layout: `.docedit-view` is a **row**, with the editor column in `.docedit-main`. `.docedit-wordcount` and `.docedit-error` must stay inside it or they become flex items of the row (the row had a second column, the Structure rail, until it was deleted; anything added back beside `.docedit-main` needs `-webkit-app-region: no-drag`, because `.docedit-view` is a drag region). Paragraph jumps use `scrollIntoView({ behavior: 'auto' })` — smooth scrolling is compositor-driven and silently does nothing when the window is not compositing, the same trap as the overlay's entrance animation.

### Tracer (removed, then restored as a panel)

Tracer is a conversational writing tutor. It was removed — window, relay
client, IPC handlers, repo, renderer entry and every "Ask Tracer" entry point —
when the Screen Watch widget was rebuilt on the Figma "Widget over Document"
frames, which have no Tracer in them. It came back on 2026-08-18 because Home's
frame draws a **"Chat with Tracer"** launcher and the owner asked for the panel
behind it.

**It is a panel inside the main window now, not a `BrowserWindow`.**
`components/TracerChat.tsx`, anchored bottom-left over Home, above the launcher
that opens it. That is what makes the restored version about a quarter of the
old one: no window to open or close, no conversation list, no retry — those
existed to give a separate window a sidebar.

- **`ipc/tracerHandlers.ts` registers three channels**, all of them ones
  `shared/` already had (`TRACER_GET_CONVERSATION`, `TRACER_SEND`,
  `TRACER_NEW_CONVERSATION`). The `Tracer*` types and `TRACER_*` constants were
  never deleted — `src/shared/*` is additive — so the contract was waiting.
- **The context comes from the most recent draft, not from Screen Watch.**
  `currentContext()` in `services/ai/tracer.ts` reads `getLatestDocument()`.
  The old one read whatever document was focused in another application, which
  is the wrong source for a launcher on Home: if Home is on screen, the app's
  own window is focused, so Screen Watch is by definition looking at nothing.
- **Nothing is cached.** Every other relay call is keyed by a hash of its input
  and served from `cacheRepo` on a repeat, because those are pure functions of
  their input. A chat turn depends on the whole conversation so far, so a cache
  would be actively wrong rather than merely useless.
- **The history cap is on TURNS, not characters** (`MAX_TRACER_HISTORY_MESSAGES`
  = 12). Every prior turn is re-sent on every message, so an uncapped
  conversation costs quadratically. The OLDEST turns are trimmed, which keeps
  the exchange the user is in the middle of intact.
- **`callServer`'s endpoint union names `'tracer'`.**
  `scripts/preflight.mjs` scrapes that union and requires each endpoint to
  answer non-404 on the server, so the server's `/api/tracer` has to be
  deployed before a release. (It was `callRelay` and the relay's
  `api/tracer.ts` until the move onto the server.)
- **The `tracer_conversations` / `tracer_messages` tables and both Privacy
  clears' DELETEs against them** survived the removal, so restoring wrote no
  migration. `tracerRepo.ts` came back from `git show f7eb21a^` unchanged.
- **Tracer can edit the draft, and only in one direction.** It may end a reply
  with a `<<<REWRITE / FIND: / REPLACE: / >>>` block; `shared/tracerRewrite.ts`
  parses it, and the offer only becomes an Apply button if the replacement
  passes `isNarrowing` — it may DROP a named thing, a number or a date, never
  introduce one. That is the same rule critique's `suggestedRevision` lives by,
  which is why `isNarrowing` moved to `shared/narrowing.ts`: one copy, enforced
  on both paths. The relay prompt asks for the same thing and the client checks
  it again, because the model broke this rule in production once already.
- **The Apply button only exists in the editor.** `TracerChat`'s
  `onApplyRewrite` is optional, and Home does not pass it — there is no open
  document there, so the card would be a button that cannot work. In
  `AnalyzeView` the edit goes through `applyTracerRewrite` →
  `documentMarks.replaceRange` → `execCommand('insertText')`, so ONE Ctrl+Z
  takes it back out. Verified in the harness, not assumed.
- **`find` is re-located in the live document**, never applied at a stored
  offset, and it refuses a sentence that appears twice rather than guessing
  which copy was meant. The conversation can be minutes old and the writer has
  been typing.
- **Do not call the apply function inside a `setState` updater.** It was, for
  one build: React invokes an updater twice under StrictMode, the second call
  re-ran the rewrite against a document that had already taken it, and the card
  said "that sentence is not in the document any more" over a correctly
  rewritten sentence. The harness caught it; the fix is to run the edit in the
  handler and set state with the result.
- **`tracerPrompt` on `StructureWeakness` is still unrendered.** Nothing writes
  an "Ask Tracer about this weakness" entry point yet; the panel takes typed
  questions only.

Tailwind did NOT come back with it — it was scoped to the old window by import,
and this panel is `.tracer-*` classes in `index.css` like everything else.

### Where user data lives at runtime

- Windows: `%APPDATA%\Tracely\tracely.db` (SQLite: analyses, claims, evidence, citations, library, request cache) and `config.json` (Semantic Scholar key only — never the relay URL/token, which are compiled in).
- Settings → Privacy has two destructive ops: "Clear Analysis History" (`historyHandlers.ts` → `clearAnalysisHistory()`, keeps the library) vs. "Clear History + Library" (also wipes `sources`/`library_items`/`citations`). Both also clear `tracer_*` rows — Tracer conversations are real rows again (see above), and "clear my history" has to mean them too.

### Spelling and grammar

Two different mechanisms, deliberately:

- **Spelling is Chromium's** (`main/spellcheck.ts`). The editor sets
  `spellCheck` on its contentEditable, which draws the squiggle; main builds
  the context menu Electron requires an app to build itself, carrying
  `params.dictionarySuggestions` plus "Add to dictionary" and the ordinary
  edit roles. The dictionary is downloaded per language and cached in the
  user-data dir; offline it degrades to no squiggles rather than wrong ones.
- **Grammar is `shared/proseIssues.ts`** — pattern matching over the text, no
  dictionary and no parser. It can catch "teh the", "a apple", "would of" and
  "alot"; it can never catch "ctaclysm", and shipping a dictionary to try would
  be a worse copy of the checker already in the process.

The rules there are bounded on purpose: a credibility flag that is wrong makes
the tool look cautious, a grammar flag that is wrong makes it look illiterate,
and writers forgive the first and switch off the second. The capitalisation
rule's `ABBREVIATIONS` list is the shape of that — every entry is a false
positive it would otherwise produce on ordinary academic prose.

## Known MVP simplifications (intentional, not bugs)

- Citation author formatting truncates to "et al." after 3 authors rather than implementing full APA/MLA/Chicago author-list rules.
- PubMed results have no abstract (would need a second NCBI `efetch` call per result; the other three providers already include abstracts).

- **Web search is a FALLBACK, capped, and cached for a week** (`search/webBudget.ts`,
  the fallback branch in `aggregator.ts`, `CACHE_TTL_MS`/`EMPTY_TTL_MS` in
  `webSources.ts`). Measured on the owner's OpenAI dashboard, 2026-08-21: the
  first day web search ever actually ran in a packaged build cost $0.62, against
  $1.18 for the entire preceding fortnight. Fourteen web searches were ~53c of
  it; every chat call combined — 13 critiques, 20 detections, 8 grades — was ~9c.
  - **Its cost is invisible to our own usage log, and that is why a cap was
    needed rather than a dashboard.** OpenAI bills `web_search_preview` per call,
    separately from tokens, and `response.usage` does not carry it — so
    `[usage] find-sources … cost=$…` reports the smaller half. The prompt also
    runs several site-restricted queries inside one call (seven observed), so one
    cache entry is many billed searches.
  - **The fallback does the saving; the cap is a ceiling.** `findWebSources` left
    the `Promise.all` fan-out — running it beside five free providers meant paying
    on every `general` claim whether or not those providers had already answered.
    It now runs only when nothing from them is both above the relevance floor and
    `credibilityOf(...).citable`. Replayed against yesterday's real workload: 43%
    of claims already had a citable free source, taking an 8-claim essay from 8
    web searches to 4.6 with no quality loss. A cap of 4 would buy ~7 more points
    by denying the web to claims that need it — the "No sources found" card this
    provider exists to fix — so it is 6, matching `MAX_AUTO_CRITIQUE_CLAIMS`.
  - **CITABILITY, not just relevance, is the test.** A Wikipedia hit clears the
    relevance floor easily and must NOT suppress the paid search: it is a finding
    aid, and a claim whose only relevant result is an encyclopedia article is
    exactly the claim the web search was added for.
  - **The hourly cap is not redundant with the per-analysis one.** The
    per-analysis cap assumes analyses are discrete; Screen Watch mints a fresh
    claim id per detection and passes no analysis at all, and the editor now
    detects on a debounce. A loop with a new analysis each time would honour the
    per-analysis cap perfectly and still spend without limit.
  - **A 24h TTL meant re-opening a draft the next morning re-paid for all of it.**
    Now a week — what the open web says about a historical claim does not move
    between Tuesday and Friday. An EMPTY answer still expires in minutes, the same
    split `cachedEvidence.ts` had to learn: every failure path arrives as the same
    empty list as "the web genuinely has nothing", and freezing that for a week
    would hide a fixed retrieval bug for a week.
