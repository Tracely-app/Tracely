## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Which release does this need?

<!-- Delete the ones that do not apply. -->

- [ ] **Nothing** — docs, tests, tooling
- [ ] **`/ship`** — desktop app changed; users need a new installer
- [ ] **Server deploy** — `server/` changed; redeploy api.jointracely.com per `server/DEPLOY.md`, nothing to install. (The Vercel relay is retired: nothing new is deployed to it, and it stays up only for installs too old to update.)
- [ ] **Both** — promote first, then ship

## Checks

- [ ] `npm run typecheck` passes
- [ ] No `.env*` file, key, or token in the diff — **this repo is public**
- [ ] Branch is up to date with `main`

## If this touches retrieval or scoring

<!-- "This should improve results" is not evidence. The baseline is 30/102 (29%)
     retrieval precision in eval/baseline.md. Say whether the number moved, did
     not move, or moved within noise — three essays is a small sample. Delete
     this section if it does not apply. -->
