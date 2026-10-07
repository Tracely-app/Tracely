## What and why

<!-- What changes and what problem it solves. Link the issue if there is one.
     Measurements beat adjectives: "improves results" needs a number
     (eval/models/FINDINGS.md for anything that touches a prompt or a model). -->

## Surface

<!-- Tick every one that applies. Each names who has to act after the merge. -->

- [ ] **Desktop** (`src/`, `scripts/`, packaging) — ships only when Merrick runs `/ship`; users keep the old build until then.
- [ ] **Server** (`server/`) — live only when Sam deploys per `server/DEPLOY.md`. Say which client features depend on it.
- [ ] **Extension** (`extension/`, `server/test/ext-*`) — manifest bumped to `___`; `EXTENSION_API` in `server/server.js` untouched (changing it is a store release); users have it only after Sam uploads the store zip.
- [ ] **Docs, tests, tooling** — nothing to deploy.

## Checks

- [ ] `cd server && npm test` (server AND extension tests, zero deps) — green
- [ ] `npm run typecheck && npm test` — green, or not applicable (no `src/` change)
- [ ] A prompt changed → re-measured and its SHA updated in `server/test/prompts.test.js`
- [ ] No `.env*`, key, token or `beta.json` in the diff — **this repo is public**
- [ ] Branch is up to date with `main`

## Handoff

<!-- The other developer's agent reads this. One line each; delete what is empty. -->

- **Needs Sam:** <!-- deploy the server / upload the store zip / a .env change / nothing -->
- **Needs Merrick:** <!-- ship an installer / a Vercel or DNS change / nothing -->
- **Order:** <!-- e.g. "deploy server before the 2.21.25 store zip" -->
- **Hot files touched:** <!-- content.js: which section or function; server.js: which route; CLAUDE.md: which heading -->
- **STATUS.md:** <!-- updated in this PR / to update after deploy / not needed -->
