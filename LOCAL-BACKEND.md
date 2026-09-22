# Tracely, local-first — the OpenAI backend

`server/` is also a second way to run Tracely: **one local Node process, one
OpenAI API key, no Supabase, no Electron required.** The renderer
you already have runs unmodified in a browser on top of it, and a Chrome
extension brings checking + in-place fixes to Google Docs and any website.

The same `server/` is the hosted backend for every client (`api.jointracely.com`,
`server/DEPLOY.md`); run locally with no Supabase values in its `.env` it
enforces nothing. The pieces:

| Path | What it is |
|---|---|
| `server/` | The backend: Express-free Node server (`node server/server.js`, port 4477), OpenAI calls with model tiering (gpt-5.6-luna by default — a few cents to write and check a whole essay, see `eval/models/FINDINGS.md`), free retrieval (OpenAlex/Crossref/S2 and Wikipedia on every claim, plus PubMed for biomedical claims and World Bank for statistics — `routeProviders` in `lib/evidence.js`), SQLite storage (`node:sqlite`, no native builds), macOS Screen Watch via the accessibility API, Google Docs write-back bridge. About 600 backend tests (`cd server && node --test`). See `server/README.md`. |
| `src/renderer/src/bridge/` | A typed HTTP implementation of the whole `window.tracely` preload contract — the renderer talks to `server/` instead of Electron IPC. Typechecked against `ipc-contract.ts`, so drift fails `npm run typecheck`. |
| `web.vite.config.mts` | Builds the real renderer for the browser with the bridge injected (same mechanism as the preview harness's mock injection). Output: `dist-web/`, served by the server at `/`. |
| `demo.vite.config.mts` + `scripts/make-demo.mjs` | Single-file offline demo (`demo.html`) with the preview mock — shareable, runs with zero backend, sandbox-safe. |
| `extension/` | Chrome extension (MV3): Google Docs widget with real in-doc edits, Grammarly-style underlines + in-place fixes on any site. It always talks to a Tracely server — `localhost:4477` when one answers, else `api.jointracely.com` (the standalone key mode was removed). |

## Run it (contributors)

```bash
# 1. backend
cd server && npm install && cp .env.example .env   # paste your OpenAI key
node server.js                                      # http://localhost:4477

# 2. renderer in the browser (from repo root)
npm install --ignore-scripts
node_modules/.bin/vite build --config web.vite.config.mts
# reload http://localhost:4477 — the full renderer, no Electron

# 3. extension: chrome://extensions → Developer mode → Load unpacked → extension/
#    (it prefers localhost:4477 automatically)

# keyless development: TRACELY_MOCK=1 node server/server.js  (canned verdicts)
npm test --prefix server                            # backend suite
```

## Cost model (the point of this backend)

Model strategy `economy` (default) runs everything on the fast tier,
`gpt-5.6-luna`, with request caching, incremental per-paragraph detection,
clamped context, and web search strictly opt-in — **fractions of a cent per
call** (measured in `eval/models/FINDINGS.md`), with a live token/cost meter. `smart` (the
balanced tier, `gpt-5.6-terra`, for critique, grading and checks) and
`uniform` (your pick) are one Settings dropdown away. These strategies apply
only on a local server; a hosted server ignores the prefs row and runs the
model each client asks for, clamped to its plan.

## Google Docs write-back (optional, per user)

Each user deploys `server/docs-bridge/Code.gs` (as of 67120d1 a one-line
placeholder, not the script — see `server/README.md`) as their own Apps Script Web App
(Execute as: Me / access: Anyone), sets a random shared token in the script and
in `server/.env` (`TRACELY_BRIDGE_TOKEN` + `GOOGLE_DOCS_BRIDGE_URL`). The
widget then gains Fix-in-doc / Highlight / Cite-in-doc. Full steps in
`server/README.md`.
