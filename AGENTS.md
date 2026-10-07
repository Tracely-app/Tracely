# AGENTS.md

Instructions for coding agents in this repository — Claude Code, Codex, or
anything else. **Read `CLAUDE.md` first**; it is the contract both developers'
agents read every session and nothing here repeats it. `CONTRIBUTING.md` has
setup and the review loop.

What follows is what Claude Code enforces mechanically through `.claude/`
hooks and settings, which **every other agent must keep by hand**.

## The standing loop

1. Read the linked issue or the request. If "done" is not defined, ask before
   writing code.
2. Branch off an up-to-date `main` (`<type>/<slug>`). Never work on `main`.
3. **Open a draft PR in your first turn** titled `<surface>: <what>`. Check
   `gh pr list` first and do not start on a file an open PR touches.
4. Stay inside the scope. Raise adjacent ideas in the PR body instead.
5. Run the checks for the surface you touched before pushing:
   `cd server && npm test` (server and extension, ~10 s);
   `npm run typecheck && npm test` for the desktop.
6. Push, fill the template's **Surface**, **Checks** and **Handoff** sections,
   and hand back the PR link. A human merges; a human publishes.

## What the hooks do for Claude Code (and you must do by hand)

- **On `main`:** no edits to `src/`, `scripts/`, `server/`, `extension/` or the
  build config; no `git commit` or `rebase`. `main` advances only by PR.
- **Asks before publishing:** anything that reaches the production server
  (`45.56.92.67`, `systemctl … tracely`), `pack-extension.sh`, `gh pr merge`,
  release tags, `npm run ship`, force pushes, and anything that runs an eval
  (paid).
- **End of turn:** typecheck when TypeScript changed; the server suite when
  `server/` or `extension/` changed; then commit and push the branch with the
  PR's title as the subject. Nothing survives only in a working tree.
- **Denied outright:** reading or writing `.env`, `.env.staging`,
  `.env.release`, `.env.live`, `server/.env`.

## Never

- **Never commit a secret.** This repository is public; rewriting history does
  not unpublish. `.env*` files, `beta.json`, keys, tokens.
- **Never edit `version` in `package.json`.** `scripts/ship.mjs` owns it.
- **Never change `EXTENSION_API` members, a prompt string behind a SHA pin,
  or `LEGACY_MODEL_TIER` as a cleanup.** Each is a contract with builds
  already installed; changing one is a release with a measurement.
- **Never run an eval without saying what it costs.** `eval/README.md`.
- **Never merge, deploy, upload or ship.** Those are the humans' actions;
  name them in the Handoff.
- **Never add a blanket exclusion to `files` in `electron-builder.yml`.**
  v0.3.76 shipped with the ML stack excluded and no error.

## Always

- Open the draft PR early; it is the only thing the other agent can see.
- Say in the Handoff which **hot file sections** you touched
  (`extension/content.js` by function or section; `server/server.js` by route;
  `CLAUDE.md` by heading), so the other agent can rebase by name.
- Bump `extension/manifest.json` **once**, in the last commit, when shipped
  extension code changed — and never otherwise.
- Update `STATUS.md` when you deploy, upload or ship; leave it alone otherwise.
- Keep branches short-lived; a six-hunk conflict in this repo's history came
  from a branch that outlived a rebuild of the file it was editing.

## Where things run

One hosted server (`server/`, `api.jointracely.com`, Sam deploys per
`server/DEPLOY.md`), one Supabase project, one Chrome Web Store listing, one
desktop release channel plus a preview channel. The Vercel relay is retired:
desktop installs at v0.3.97 or older still call it and cannot sign in; nothing
new ships there. `docs/environments.md` says which `.env` each command reads.

Test counts and timings in prose go stale within weeks; the CI `check` job and
the numbers `npm test` prints are the truth.
