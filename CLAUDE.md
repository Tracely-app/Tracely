# CLAUDE.md

Both developers' Claude Code agents read this file every session; humans
rarely talk to each other directly. It is a map and a contract, kept under
~250 lines. Surface detail lives beside the code — `server/CLAUDE.md`,
`extension/CLAUDE.md`, `src/CLAUDE.md` — and history in `docs/`.

## Owners and surfaces

| Surface | Path | Publishes it | Needs the other human for |
|---|---|---|---|
| **Server** `api.jointracely.com` | `server/` | **Sam** — SSH to the Linode (`server/DEPLOY.md`); holds the OpenAI key, `server/.env`, the beta token | nothing |
| **Chrome extension** | `extension/`, tests in `server/test/ext-*` | **Sam** uploads the store zip (publisher account); either writes it | Merrick: nothing |
| **Desktop app** | `src/`, `scripts/`, packaging | **Merrick** — `/ship` from his Windows box; macOS installers from CI | Sam: deploy the server first when a route is new |
| **Website, DNS** | Tracely-Website repo | **Merrick** (Vercel) | Sam: install the Vercel GitHub App on the org |
| **Org, store listing, Linode** | — | **Sam** (org admin) | — |

GitHub logins: Sam is `@questionablepuddle`, Merrick is `@merrickphan`.
`CODEOWNERS` requests the other's review on their surface; that request is
the notification. Zero approvals are required.

## What is live

`STATUS.md` — one row per surface: version or commit, since when, how it got
there. The human who deploys, uploads or ships has their agent replace the
row in the same PR or right after. A merged PR that is not yet live carries
`needs:sam-deploy`, `needs:sam-store-upload` or `needs:merrick-ship`.
`server/scripts/healthcheck.sh` checks production for free.

## Products, and the one document for each

| Part | Where | Ships as | Read |
|---|---|---|---|
| Server | `server/` | rsync to the Linode | `server/CLAUDE.md`, `server/DEPLOY.md`, `server/BILLING.md` |
| Chrome extension | `extension/` | Web Store (published 2.21.1; main moves faster) | `extension/CLAUDE.md`, `extension/README.md` |
| Desktop app | `src/` | Electron installer (`npm run ship`) | `src/CLAUDE.md`, `BUILDING.md`, `docs/desktop-architecture.md` |
| Web app (local only) | `server/public/app/` | served by `server.js` | `server/README.md` |
| Model evals | `eval/` | paid runs | `eval/README.md`, `eval/models/FINDINGS.md` |

`web.vite.config.mts`, `demo.vite.config.mts` and `src/renderer/src/bridge/`
are experiments with no npm script, not a surface.

## One backend, two products — the rules in short

Every model call from every client goes through `server/`; the provider is a
seam (`lib/llm.js` → `lib/providers/openai.js`); the server picks the model per
route and plan (`shared/plan.js`). The extension's routes are **frozen while a
build is installed** — `EXTENSION_API` in `server/server.js` is the contract,
append-only. The desktop's AI routes have their **own** spend pool, limiter
and quota (`APP_AI_ROUTES`), never the extension's. Prompts are SHA-pinned
(`server/test/prompts.test.js`); hand-copied logic is mirror-tested. The full
text with its reasons: `server/CLAUDE.md`.

## Checks

```bash
cd server && npm test                 # server AND extension, zero deps, ~10 s
npm run typecheck && npm test         # desktop (Node 24)
TRACELY_MOCK=1 node server/server.js  # the whole product keyless, real shapes
```

CI's `check` runs all three on every PR. The `handoff` check wants a Handoff
section and a ticked Surface box. Test counts in prose go stale; the runner's
numbers are the truth.

## Commands

```bash
npm run dev            # desktop, hot reload (TRACELY_ENV=staging → .env.staging)
npm run preview:ui     # the renderer with everything mocked (/preview)
cd server && npm start # http://localhost:4477 (reads server/.env)
node server/scripts/bump-extension.mjs patch     # the extension's version, once per PR
server/scripts/pack-extension.sh [--beta] [OUT]  # store zip / tester zip
server/scripts/healthcheck.sh [URL]              # is production healthy
npm run ship           # desktop release — Merrick's box only (src/CLAUDE.md)
```

## Environments

One hosted server, one Supabase project (`sxifbtelrtbsgnnwnmdf`; the old
"production" project is deleted), anonymous desktop sessions, Google sign-in
in the extension. Which `.env` each command reads, and the build banner:
`docs/environments.md`. Nothing secret is in the tree; `server/.env` lives
only on the Linode.

## Branches, PRs, claiming

- Branch `<type>/<slug>` off an up-to-date `main`. Never work on `main`:
  the hooks refuse edits to `src/`, `scripts/`, `server/`, `extension/` and
  `git commit` there; it advances only by PR.
- **Open a draft PR in your first turn** titled `<surface>: <what>`. It is the
  only signal the other agent can see. Before starting: `gh pr list` — do not
  start on a file an open PR already touches; if you must, branch off that
  PR's head and say so in the body. A branch idle for three days is fair game.
- Fill the template: **Surface**, **Checks**, **Handoff** (Needs Sam / Needs
  Merrick / Order / Hot files touched / STATUS.md).
- Squash merge; the PR title and body are the commit. Merged branches are
  deleted. The end-of-turn hook commits and pushes every turn, so nothing
  survives only in a working tree. Parallel work uses throwaway worktrees.

## Hot files

`extension/content.js` (one file, FILE MAP at the top), `server/server.js`
(routes inline; `EXTENSION_API` is the contract) and this file. Rules:
anchors and `TEST ANCHOR` lines are test fixtures — never rename or re-indent;
add code inside its section, never at the top; one manifest bump per PR, in
the last commit; name the section or route you touched in Handoff so the other
agent can rebase by name.

## Releasing, in order

Server deploy first (`server/DEPLOY.md`; preflight fails a desktop ship on any
404), then the store zip, then `/ship`. The Web Store and electron-updater
cannot roll back, so the server stays compatible with every installed build
(`LEGACY_MODEL_TIER`, append-only routes). Details per surface:
`docs/RELEASING.md`; when something shipped wrong: `ROLLBACK.md`.

## Done means

| Surface | Checks | Moves together | Then |
|---|---|---|---|
| Server | `cd server && npm test`; a changed prompt re-measured and its SHA moved | `EXTENSION_API` append-only; `LEGACY_MODEL_TIER` kept | label `needs:sam-deploy`; Sam deploys, runs `healthcheck.sh`, updates `STATUS.md` |
| Extension | ext tests; manifest bumped once (`bump-extension.mjs`) | `background.js` `API_PATHS` ⊆ `EXTENSION_API` | label `needs:sam-store-upload` |
| Desktop | `typecheck && test`; `version` untouched by hand | `electron-builder.yml` ML globs intact | label `needs:merrick-ship`; `/ship` |
| Docs / tests | read it once as the other agent | — | nothing |

## Secrets and the public repo

Nothing secret is ever committed: `.env*` (except `.env.example`), keys,
tokens, `beta.json`. Rewriting history does not unpublish. The hooks deny
reading or writing `.env`, `.env.staging`, `.env.release`, `.env.live` and
`server/.env`. Docs name keys, never values.

## Hooks and guards (`.claude/`)

Deny: commit or rebase on `main`; source edits on `main`. Ask: pushing `main`,
anything that reaches the Linode or restarts the service, `pack-extension.sh`,
`gh pr merge`, release tags, `npm run ship`, force pushes, any eval (paid).
End of turn: typecheck when TypeScript changed, the server suite when
`server/` or `extension/` changed, then commit and push. Not guarded: the Web
Store upload, the website, DNS. Details and the rules for writing a hook:
`.claude/README.md`.

## UI decisions — the colour vocabulary shared by both clients

One colour vocabulary, the desktop's (`src/renderer/src/components/problemCopy.ts`,
mirrored in `server/shared/marks.js`): red `#d93636` wrong or invented;
orange `#ff5900` thin evidence or an unverified figure; amber `#ffb800` add or
fix the attribution; blue `#2563eb` grammar only; grey dotted `#9a9ba1` still
checking. Colour only ever means a finding; never colour alone (the extension's
`MARK_PATTERN`: solid / dashed / double, one legend). The design file and the
ratified decisions: `docs/design-file.md`.

## Not without the other human

Editing `server/.env`; publishing on the Web Store; a desktop ship; DNS or
Vercel; deleting an `app.bak-*`; changing prompt text behind a SHA pin;
removing or renaming an `EXTENSION_API` member; splitting `content.js` into
several content scripts (an extension release with a human Chrome test);
a CI-driven server deploy (a new user and key on a shared Linode). Say which
in the Handoff and stop there.

## Docs index

`STATUS.md` what is live · `docs/RELEASING.md` · `docs/environments.md` ·
`ROLLBACK.md` · `CONTRIBUTING.md` · `AGENTS.md` (for non-Claude agents) ·
`server/CLAUDE.md` · `server/DEPLOY.md` · `server/BILLING.md` ·
`extension/CLAUDE.md` · `src/CLAUDE.md` · `BUILDING.md` ·
`docs/desktop-architecture.md` (the decision log) · `docs/design-file.md` ·
`eval/README.md` · `eval/models/FINDINGS.md` · `.claude/README.md` ·
`PRIVACY.md`.

## History, dated

The Vercel relay was retired on 2026-09-21; desktop installs at v0.3.97 or
older still call it and cannot sign in, and nothing new ships there. The
extension was published on the Chrome Web Store in early October 2026 at
2.21.1. v0.3.99 (2026-10-03) was the first stable desktop release on the
server. This file was cut from 1,361 lines to a map on 2026-10-07; the moved
sections are in the files above, verbatim.
