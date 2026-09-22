# Tracely

Tracely is a private, local AI writing and research assistant. Instead of fixing grammar, it checks the *credibility* of what you write: it detects factual claims, finds evidence for them (OpenAlex, Crossref and Semantic Scholar always; PubMed for biomedical claims, Wikipedia for general ones, the World Bank's indicators for statistical ones), scores how well-supported each claim is, critiques weak arguments, generates citations (APA/MLA/Chicago), and keeps a local library of sources you've used.

It's a desktop app (Electron + React + TypeScript), not a website. Everything — your text, your source library, your settings — stays on your machine in a local SQLite database. Network calls go to the **Tracely server** (see below) for AI features and to free academic search APIs. The editor detects claims after a 2.5-second pause in typing, searches evidence for them, and, while Settings → "Fact-check my claims automatically" is on (the default), critiques up to 6 claims per analysis. Screen Watch (Windows, off by default) detects claims in other apps after a pause in typing.

## Requirements

- Windows 10/11 (primary, tested target). macOS packaging config is included but untested — see [Building for macOS](#building-for-macos).
- [Node.js](https://nodejs.org) 22+ (developed against Node 24).
- The Tracely server for the AI features (claim detection, argument critique) — the hosted one at `https://api.jointracely.com` by default. Everything else — evidence search, citations, the library — works without it.

No Python or C++ build tools are required: Tracely's local database uses `sql.js` (SQLite compiled to WebAssembly), so there's no native module to compile.

## Install

```bash
npm install
```

## Connecting Tracely to the server

Tracely never talks to OpenAI directly and has no API-key field anywhere in its UI. Its AI calls go to the Tracely server (`server/` in this repo, hosted at `https://api.jointracely.com`), which holds the real OpenAI key and decides which model each account's plan may use. End users who download the built app cannot see or change which AI provider/key/model is in use; only whoever builds the app controls that.

1. Nothing to set for the hosted server: a build with no `TRACELY_API_URL` talks to `https://api.jointracely.com`.
2. To point a build somewhere else (a server you run locally, say), copy `.env.example` to `.env` and set:
   ```
   TRACELY_API_URL=http://localhost:4477
   ```
3. The value is read once, at build time, by `electron.vite.config.ts` and compiled directly into the app — `npm run dev` and `npm run dist:win` both pick it up automatically from `.env`. There is no `.env` shipped inside the built app and no Settings field for it; changing which server Tracely talks to means editing `.env` and rebuilding. Every build prints the answer: `api=<host>`, with `(default)` when nothing set it.

`SEMANTIC_SCHOLAR_API_KEY` in `.env.example` is optional and works differently — it's a free-tier rate-limit key, not a cost/security concern, and it's still editable per-user from in-app Settings. OpenAlex, Crossref, and PubMed all work without any key at MVP-scale usage.

## Run in development

```bash
npm run dev
```

This opens the main window and boots a hidden floating-assistant window. Press **Ctrl+Shift+F** (configurable in Settings) from anywhere on your desktop to grab the current clipboard contents into the floating popup and analyze it immediately.

## Build a Windows installer

```bash
npm run dist:win
```

The installer (NSIS `.exe`) is written to `release/`. It lets the user pick an install directory and creates Desktop/Start Menu shortcuts.

### Windows SmartScreen warning

This installer isn't code-signed (no Windows code-signing certificate has been purchased — see `BUILDING.md`), so Windows will show a blue **"Windows protected your PC"** SmartScreen screen the first time someone runs it. That's expected for any small, unsigned app and isn't a sign anything is wrong. To proceed: click **More info**, then **Run anyway**. It only shows up on that first launch.

## Building for macOS

```bash
npm run dist:mac
```

`electron-builder.yml` is configured for a `dmg` target with a bundled `.icns` icon. This has not been built or tested on macOS as part of this project (built on Windows) — treat it as a starting point.

## Where your data lives

Everything is local, under Electron's per-OS user-data directory for the app (`Tracely`):

- Windows: `%APPDATA%\Tracely\`
  - `tracely.db` — SQLite database: analyses, claims, evidence, citations, your saved library, and a request cache (so repeated identical AI/search calls don't re-hit the network).
  - `config.json` — your optional Semantic Scholar and NCBI API keys, and a random install id sent to the server so a signed-out install gets its own daily quota. The server URL is compiled into the app, not stored here.

**Settings → Privacy** has two destructive actions:
- **Clear Analysis History** — deletes past analyses, claims, and the cached request results. Your saved library is kept.
- **Clear History + Library** — deletes everything above, plus every saved source and citation.

## Architecture

```
src/
  shared/            Types and IPC channel/contract definitions shared by all three processes.
  main/               Electron main process (Node.js).
    windows/          Main window + floating assistant window creation.
    hotkey.ts         Global shortcut registration and clipboard capture.
    tray.ts           System tray icon (keeps the hotkey alive when the main window is closed).
    ipc/              One ipcMain.handle registrar per feature area; validates payloads with zod.
    services/
      ai/             Server client — claim detection, critique and grading call the Tracely server
                       (callServer in client.ts) over HTTPS instead of OpenAI directly, behind a debounce or
                       an explicit action and a SQLite-backed cache. No OpenAI key ever exists in this app.
      search/         OpenAlex / Crossref / Semantic Scholar / PubMed / Wikipedia / World Bank clients
                       (plus a capped, paid web-search fallback), a parallel aggregator with
                       DOI-based dedup, and a deterministic (non-AI) evidence-strength scoring function.
      citations/       Pure APA/MLA/Chicago formatters from source metadata — no AI call.
      storage/         sql.js-backed SQLite access: schema, one repo module per table, request cache,
                       and the app-data config.json (optional API keys and the install id).
  preload/            contextBridge surface exposed to the renderer as `window.tracely`.
  renderer/           React UI — three entry points (main window `index.html`, floating window `floating.html`,
                       Screen Watch overlay `overlay.html`) sharing the same components (ClaimCard, EvidenceCard, CitationBlock, etc.).
```

### IPC channels

| Channel | Purpose |
|---|---|
| `analyze:detectClaims`, `analyze:getResult` | Run/re-fetch claim detection for a block of text |
| `evidence:find`, `evidence:getForClaim` | Search academic APIs for a claim / re-read cached results |
| `citation:generate`, `citation:list` | Format and persist a citation for a source |
| `critique:generate` | Argument critique for a claim (reasoning model) |
| `library:save`, `library:list`, `library:get`, `library:update`, `library:remove` | Local source library |
| `settings:get`, `settings:set` | App preferences and the optional Semantic Scholar key |
| `history:clear` | Wipe analysis history (optionally including the library) |
| `clipboard:read`, `clipboard:write` | Used by the floating window and citation "Copy" buttons |
| `window:hide`, `window:show`, `window:close` | Show/hide the main or floating window |

### Cost control

- AI runs on an explicit action (AI Insights, Find Evidence, Critique) or after a debounced pause: live claim detection (2.5 s idle, at least 80 characters, the text changed by at least 80 characters, at most once per 15 s), up to 6 automatic critiques per analysis while "Fact-check my claims automatically" is on, and Screen Watch detection. Never on every keystroke.
- The server picks the model per call: every plan checks, detects, grades and searches on `gpt-5.6-luna`, the most accurate model in our tests. Pro's critiques use `gpt-6-astra` (the Thorough setting, the default) while the account's monthly allowance lasts, then luna (`MODEL_FOR_TIER` in `src/shared/plan.ts`, `modelForRoute` in `server/shared/plan.js`). The app sends the tier the user picked as a request; the server can lower it but never raise it. Critique reuses evidence already fetched rather than searching again; beyond the 6 automatic ones it runs only when requested.
- Every AI and evidence-search call is cached locally in SQLite keyed by a hash of its normalized input, so repeating the same analysis or evidence lookup costs nothing on subsequent runs (no server/OpenAI call at all). AI cache keys include the model, so an upgrade is not answered from the free tier's cache.
- Evidence-strength scoring is a deterministic formula (source count, venue quality, recency, relevance) — it does not make an additional AI call.
- The server itself enforces its own limits — input size, a per-caller rate limit, a daily quota for free accounts and a daily spend ceiling (see `server/shared/guards.js`) — rather than trusting the app to behave, since the app is running on machines you don't control. Set a hard monthly budget limit on your OpenAI account (Billing → Limits) as the real backstop against runaway usage.

### Troubleshooting `npm run dist:win`

The first time you package the app, electron-builder downloads a small tool bundle (`winCodeSign`) that includes some macOS-only files as symlinks. On a standard (non-admin, Developer-Mode-off) Windows account, extracting those symlinks fails with:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
```

This does **not** affect anything actually needed for the Windows build (icon embedding, NSIS) — only two irrelevant macOS `.dylib` symlinks fail to extract, but electron-builder's downloader treats the whole archive as failed and retries forever. Fix: enable **Settings → Privacy & Security → For developers → Developer Mode** (grants your account the symlink-creation privilege without needing admin), then re-run `npm run dist:win`.

### Known MVP simplifications

- Author name formatting in citations truncates to "et al." after 3 authors (not the full APA/MLA rule sets).
- PubMed results don't include an abstract (NCBI E-utilities would need a third `efetch` call per result; the other three providers already supply abstracts).
