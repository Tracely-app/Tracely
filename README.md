# Tracely

Tracely is a private, local AI writing and research assistant. Instead of fixing grammar, it checks the *credibility* of what you write: it detects factual claims, finds academic evidence for them (OpenAlex, Crossref, Semantic Scholar, PubMed), scores how well-supported each claim is, critiques weak arguments, generates citations (APA/MLA/Chicago), and keeps a local library of sources you've used.

It's a desktop app (Electron + React + TypeScript), not a website. Everything — your text, your source library, your settings — stays on your machine in a local SQLite database. The only network calls are to the **Tracely relay** (a small backend you deploy and control — see below) for claim detection/critique, and to the academic search APIs, and only when you explicitly click Analyze, Find Evidence, or Critique.

## Requirements

- Windows 10/11 (primary, tested target). macOS packaging config is included but untested — see [Building for macOS](#building-for-macos).
- [Node.js](https://nodejs.org) 22+ (developed against Node 24).
- A deployed [Tracely Relay](../Tracely-relay/README.md) for the AI features (claim detection, argument critique). Everything else — evidence search, citations, the library — works without one.

No Python or C++ build tools are required: Tracely's local database uses `sql.js` (SQLite compiled to WebAssembly), so there's no native module to compile.

## Install

```bash
npm install
```

## Connecting Tracely to the relay

Tracely never talks to OpenAI directly and has no API-key field anywhere in its UI. Instead it calls a backend you deploy once — the [Tracely Relay](../Tracely-relay/README.md) — which holds the real OpenAI key server-side. This means end users who download the built app cannot see or change which AI provider/key/model is in use; only whoever builds the app controls that.

1. Deploy the relay first — follow [`../Tracely-relay/README.md`](../Tracely-relay/README.md). You'll end up with a URL (e.g. `https://tracely-relay-yourname.vercel.app`) and a shared token.
2. In this folder, copy `.env.example` to `.env` and fill in:
   ```
   RELAY_URL=https://tracely-relay-yourname.vercel.app
   RELAY_TOKEN=<the same APP_SHARED_TOKEN you set on the relay>
   ```
3. These two values are read once, at build time, by `electron.vite.config.ts` and compiled directly into the app — `npm run dev` and `npm run dist:win` both pick them up automatically from `.env`. There is no `.env` shipped inside the built app and no Settings field for these; changing which relay Tracely talks to means editing `.env` and rebuilding.

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
  - `config.json` — your optional Semantic Scholar API key. The AI relay URL/token are compiled into the app, not stored here.

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
      ai/             Relay client — claim detection and critique both call the Tracely Relay (see
                       ../Tracely-relay) over HTTPS instead of OpenAI directly, behind an explicit
                       user action and a SQLite-backed cache. No OpenAI key ever exists in this app.
      search/         OpenAlex / Crossref / Semantic Scholar / PubMed clients, a parallel aggregator with
                       DOI-based dedup, and a deterministic (non-AI) evidence-strength scoring function.
      citations/       Pure APA/MLA/Chicago formatters from source metadata — no AI call.
      storage/         sql.js-backed SQLite access: schema, one repo module per table, request cache,
                       and the app-data config.json (Semantic Scholar key only).
  preload/            contextBridge surface exposed to the renderer as `window.tracely`.
  renderer/           React UI — two entry points (main window `index.html`, floating window `floating.html`)
                       sharing the same components (ClaimCard, EvidenceCard, CitationBlock, etc.).
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

- AI is only called on an explicit user action (Analyze, Find Evidence's critique step, or Critique) — never on keystrokes.
- Claim detection uses a cheap model (`gpt-4.1-mini` by default); critique uses a stronger model (`gpt-4.1` by default) only when explicitly requested, and reuses evidence already fetched rather than searching again. Both models are chosen server-side by the relay (`CHEAP_MODEL`/`REASONING_MODEL` env vars) — end users have no control over this.
- Every AI and evidence-search call is cached locally in SQLite keyed by a hash of its normalized input, so repeating the same analysis or evidence lookup costs nothing on subsequent runs (no relay/OpenAI call at all).
- Evidence-strength scoring is a deterministic formula (source count, venue quality, recency, relevance) — it does not make an additional AI call.
- The relay itself re-enforces input-size limits server-side (see `../Tracely-relay/lib/limits.ts`) rather than trusting the app to behave, since the app is running on machines you don't control. Set a hard monthly budget limit on your OpenAI account (Billing → Limits) as the real backstop against runaway usage.

### Troubleshooting `npm run dist:win`

The first time you package the app, electron-builder downloads a small tool bundle (`winCodeSign`) that includes some macOS-only files as symlinks. On a standard (non-admin, Developer-Mode-off) Windows account, extracting those symlinks fails with:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
```

This does **not** affect anything actually needed for the Windows build (icon embedding, NSIS) — only two irrelevant macOS `.dylib` symlinks fail to extract, but electron-builder's downloader treats the whole archive as failed and retries forever. Fix: enable **Settings → Privacy & Security → For developers → Developer Mode** (grants your account the symlink-creation privilege without needing admin), then re-run `npm run dist:win`.

### Known MVP simplifications

- Author name formatting in citations truncates to "et al." after 3 authors (not the full APA/MLA rule sets).
- "Government datasets" mentioned as a possible evidence source is an intentionally unbuilt extension point — no specific API was given for it.
- PubMed results don't include an abstract (NCBI E-utilities would need a third `efetch` call per result; the other three providers already supply abstracts).
