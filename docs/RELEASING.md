# Releasing — three surfaces, three paths, one order

Each surface has its own version, its own publisher and its own command.
`STATUS.md` records what is live; the person who publishes has their agent
replace that row in the same PR or right after.

| Surface | Version lives in | Bumped by | Published by | Command |
|---|---|---|---|---|
| **Server** | the commit hash (no version field) | — | **Sam** (SSH to the Linode) | `server/DEPLOY.md` runbook |
| **Extension** | `extension/manifest.json` `version` | the PR that changes shipped code, once, in its last commit | **Sam** (Web Store publisher account) | `server/scripts/pack-extension.sh` → upload the zip |
| **Desktop** | `package.json` `version` — never by hand | `npm run ship` (opens and auto-merges a `release/vX.Y.Z` PR) | **Merrick** (Windows box, `GH_TOKEN`) | `/ship`; macOS installers come from CI (`BUILDING.md`) |

## The order

1. **Server first.** `scripts/preflight.mjs` refuses a desktop ship while any
   route in `callServer`'s union answers 404, and the extension has no such
   gate at all — a store build that calls a route the server lacks fails for
   every user until the next review. Deploy, then run
   `server/scripts/healthcheck.sh`, then update `STATUS.md`.
2. **Extension zip** from the same `main` (`pack-extension.sh`, no `--beta`),
   uploaded by Sam. The Web Store cannot roll back, so the server must stay
   compatible with every version still installed (`EXTENSION_API` in
   `server/server.js` is the frozen contract; `LEGACY_MODEL_TIER` in
   `server/shared/plan.js` reads the ids old builds still send).
3. **Desktop `/ship`** last. `electron-updater` only ever offers a strictly
   higher version and cannot downgrade.

## Server

`server/DEPLOY.md`, in short: snapshot `origin/main` into a worktree, `cp -a`
the live app to `app.bak-<ts>`, rsync `server/` (excluding `.env`, `data`,
`test`), `chown`, `systemctl restart tracely`, then
`server/scripts/healthcheck.sh` and the `STATUS.md` row. Rollback is the
backup rsynced back (`DEPLOY.md`, "Roll back").

A merged PR that touched `server/` carries the label `needs:sam-deploy` until
its commit is in `STATUS.md`.

## Extension

- Bump `manifest.json` once per PR that changes shipped code, in the last
  commit after rebasing, so two PRs never fight over the version line.
  `server/test/ext-docs-edit.test.js` pins the manifest's permissions, not its
  version.
- **Store zip:** `server/scripts/pack-extension.sh [OUT_DIR]` → `Tracely-<v>-store.zip`
  with `manifest.json` at the zip root, no `beta.json`, no localhost
  permission. Sam uploads it on the Developer Dashboard (Package → Upload new
  package → Submit for review). Review usually takes a few days.
- **Beta zip:** `pack-extension.sh --beta` (needs `TRACELY_BETA_TOKEN`, which
  lives in the server's `.env` on the Linode). Testers unzip and Load
  unpacked. `beta.json` grants Pro to whoever has it — it must never reach the
  store.
- Every Tracely build pins the same extension id (`key` in the manifest), so
  Chrome runs one at a time: remove the old entry before loading a new one.
- A merged extension PR carries `needs:sam-store-upload` until the store row in
  `STATUS.md` says that version.

## Desktop

`CLAUDE.md` "Branches and releasing" has the full story; the short version:
`npm run ship` runs `scripts/preflight.mjs` (on `main`, clean, in sync,
typecheck, every server route live, version above the latest release), bumps
the version, opens `release/vX.Y.Z`, auto-merges it once `check` is green,
builds and publishes. `ship:dry` does everything but build and publish.
Preview builds publish themselves from every push to `main`
(`.github/workflows/preview.yml`). A merged desktop PR carries
`needs:merrick-ship` until `STATUS.md` names a stable that includes it.

## Health

`server/scripts/healthcheck.sh [BASE_URL] [--mock] [--commit <sha>]` runs the
DEPLOY.md checks and exits non-zero on the first failure. Either developer can
run it against production at any time; it spends nothing.
