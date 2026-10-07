# Environments — which backend a build talks to

There is **one hosted server** (`https://api.jointracely.com`) and **one
Supabase project** (`sxifbtelrtbsgnnwnmdf`). The second project that older
docs call "production" (`epafyygdvvkgpdkbevqi`) is deleted; builds compiled
against it (desktop ≤ v0.3.97) can never sign in. Nobody signs up anywhere:
the desktop creates an anonymous Supabase session at boot, the extension signs
in with Google through Supabase, and both are metered by the server on the
plan that session carries (free by default).

## Desktop (`src/`)

Build-time constants, inlined by `electron.vite.config.ts` through
`scripts/env.mjs`. **No runtime override exists** — not a setting, not a
config file.

| `TRACELY_ENV` | Reads | `TRACELY_API_URL` | Supabase |
|---|---|---|---|
| unset (production) | `.env` | default `https://api.jointracely.com` | the one project |
| `staging` | `.env.staging` | same default, or a URL you set | the same project (historically a second one; there is only one now) |

Every build prints one banner line; read it rather than assuming:

```
env=staging  file=.env.staging  api=api.jointracely.com (default)  supabase=sxifbtelrtbsgnnwnmdf
```

To make AI calls that cost nothing real: `TRACELY_API_URL=http://localhost:4477`
in the env file and `cd server && TRACELY_MOCK=1 npm start` (canned answers in
the real shapes). A build pointed at the hosted server spends the production
OpenAI key through the server's app pool.

## Extension (`extension/`)

Prefers `http://localhost:4477` when it answers, otherwise
`https://api.jointracely.com` (the store build drops the localhost
permission). The Supabase URL and anon key are in `background.js`; the anon
key is public by design. The beta build's `beta.json` carries the token that
grants Pro.

## Server (`server/`)

Reads `server/.env` (never committed; `server/.env.example` lists every key
by name). With no `SUPABASE_URL` it enforces nothing — right on a laptop,
ruinous on a public box. `TRACELY_MOCK=1` answers without a key. The live
`.env` is on the Linode and only Sam can change it
(`server/scripts/set-server-env.sh`, `deploy-openai-key.sh`).

## Commands and what they read

| Command | Env |
|---|---|
| `npm run dev` | `.env` (`TRACELY_ENV=staging` → `.env.staging`) |
| `npm run preview:ui` | nothing — mocked renderer |
| `npm run ship` / `release:win` | `.env` + `.env.release` (`GH_TOKEN`) |
| `cd server && npm start` | `server/.env` |
| `cd server && npm test` | nothing — zero dependencies, no network |
| `eval/models/harness/run.mjs` | `OPENAI_API_KEY` in the shell (the harness key is not on any laptop; see `eval/README.md`) |
