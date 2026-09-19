# Contributing

Two people work on Tracely, usually not at the same time. This describes how
that stays untangled.

## Setup

```bash
git clone https://github.com/Tracely-app/Tracely.git
cd Tracely
npm install
```

Then ask the maintainer for a `.env`. Nothing in this repo contains credentials
and nothing should — it is public. Copy the values you are sent into **both**
`.env` and `.env.staging`.

```bash
npm run dev        # boots the app
npm run typecheck  # the only automated correctness check
```

If `npm run dist:win` fails on `Cannot create symbolic link`, enable Settings →
Privacy & Security → For developers → Developer Mode and re-run.

The backend lives in a separate repository, `Tracely-relay`. You only need it if
you are changing an endpoint, auth, or quota.

## The loop

```bash
git checkout main && git pull
git checkout -b feat/what-you-are-doing
# work
npm run typecheck
git push -u origin feat/what-you-are-doing
```

Then open a pull request. CI runs typecheck and the eval-bundle check on every
PR. Get a review, merge, delete the branch.

**`main` is protected.** You cannot push to it directly, and that applies to
everyone including the maintainer. This is the mechanism that replaces
remembering.

## Saying what you are working on

There is no fixed ownership split — either of us can work anywhere. That only
works if we say what we are touching, because we are rarely online together.

**Before starting anything non-trivial, claim it.** Open a GitHub issue, or
comment on the existing one, saying what you are doing and roughly which files.
Two agents rewriting the same component in parallel is the expensive failure
mode here, and it has already happened once in this repo.

**Keep pull requests small and short-lived.** A branch open for a week is a
merge conflict with a delay fuse. The worst conflict in this project's history —
six hunks in one renderer component — happened because `main` rebuilt it on
Tailwind while a branch kept editing the version that existed before.

**Pull `main` daily** while a branch is open. Conflicts found early are typing;
conflicts found late are archaeology.

## Reviewing

Look for these, in roughly this order:

1. **Secrets.** Any `.env*`, key-shaped literal, or token. The repo is public.
2. **Does it need a relay change?** The app and the relay ship together. A client
   calling an endpoint that is not deployed returns 404 in production — that
   shipped once, as v0.3.73.
3. **Packaging.** Changes to `electron-builder.yml` or `scripts/` can break an
   installer in ways that do not fail the build. v0.3.76 shipped with the ML
   stack silently excluded.
4. **Does it move the number?** For anything touching retrieval or scoring, the
   claim "this improves results" needs the eval, not reasoning. See
   `eval/baseline.md`.

## Releasing

**Only the maintainer releases.** It needs a `GH_TOKEN` that is not distributed.

- Changed something in `Tracely-relay`? → `/promote` (merges `staging` → `main`;
  Vercel deploys it, no build, no installer)
- Changed something here? → `/ship` (builds an installer, publishes it, users
  install it)
- Changed both? → `/promote` first, then `/ship`. Deploy the thing being called
  before the thing calling it.

`electron-updater` **cannot downgrade**, so a bad desktop release is only
fixable by shipping another one. See [ROLLBACK.md](ROLLBACK.md) — the relay
reverts in about two seconds; the app does not revert at all.

## Environments

| | Yours | Production |
|---|---|---|
| Relay | `tracely-relay-staging.vercel.app` | `folio-relay.vercel.app` |
| Supabase | staging project | production project |
| Accounts | sign up separately | real users |
| OpenAI | separate key, low cap | real key |

Your builds point at staging. Your account does not exist in production, and
production's does not exist in staging — that is working as intended.

Every build prints which backend it targets. Read that line.
