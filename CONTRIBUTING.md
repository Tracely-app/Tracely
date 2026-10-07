# Contributing

Two people work on Tracely, almost entirely through their own Claude Code
agents, rarely at the same time. The repository is the channel between them:
a pull request's **Handoff** section is how one developer's agent tells the
other's what to do next. Read `CLAUDE.md` first — it is the contract both
agents read every session.

## Setup, per surface

```bash
git clone https://github.com/Tracely-app/Tracely.git && cd Tracely
cd server && npm test            # the server AND extension tests; zero dependencies, ~10 s
npm install && npm run typecheck && npm test     # the desktop app (Node 24)
```

Nothing in the repo contains credentials and nothing should — **it is public**.
`docs/environments.md` says which `.env` each command reads and that there is
one Supabase project and one hosted server. A keyless server is
`TRACELY_MOCK=1 node server/server.js`.

## The loop

1. Branch off an up-to-date `main`: `<type>/<slug>` (`feat/`, `fix/`, `docs/`, `chore/`).
2. **Open a draft PR in your first turn.** It is the only signal the other agent
   can see; a branch that lives only on your machine is invisible. Before
   starting, `gh pr list` — do not start on a file an open PR already touches;
   if you must, branch off that PR's head and say so.
3. Keep it small and short-lived. Pull `main` daily while a branch is open.
4. Fill the template: **Surface** (who acts after the merge), **Checks**,
   **Handoff** (Needs Sam / Needs Merrick / Order / Hot files touched / STATUS.md).
5. CI (`check`) must be green. Merge is a squash; the PR title and body become
   the commit. Zero approvals are required — the auto-requested review from
   `CODEOWNERS` is the notification, not a gate.

## Who publishes what

| | Sam | Merrick |
|---|---|---|
| Server deploy (`server/DEPLOY.md`) | ✓ | — (no Linode key) |
| Extension store upload | ✓ (publisher account) | — |
| Desktop installers (`/ship`) | — | ✓ (Windows box, `GH_TOKEN`) |
| Website, DNS (Vercel) | — | ✓ |
| Server `.env`, OpenAI key, beta token | ✓ | — |

Either may change any file. A merged PR that needs the other person carries a
`needs:*` label until `STATUS.md` says it is live. Order across surfaces:
server first, then store zip, then `/ship` (`docs/RELEASING.md`).

## Reviewing (your agent does this on the request)

1. **Secrets.** Any `.env*`, key-shaped literal, token, `beta.json`.
2. **Surface and handoff.** Does the PR say what must happen after the merge,
   and is the manifest bumped exactly once when `extension/` changed?
3. **Frozen contracts.** `EXTENSION_API` in `server/server.js`, the prompt
   SHAs in `server/test/prompts.test.js`, `LEGACY_MODEL_TIER` — changing one
   is a release, not a refactor.
4. **Packaging.** `electron-builder.yml` and `scripts/` can break an installer
   without failing the build (v0.3.76 shipped with the ML stack excluded).
5. **Does it move the number?** A prompt or model change needs
   `eval/models/FINDINGS.md`, not an adjective.

## When something shipped wrong

`ROLLBACK.md`: the server reverts in a minute; the desktop and the extension
cannot be rolled back, only shipped forward.
