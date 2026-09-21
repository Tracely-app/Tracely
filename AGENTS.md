# AGENTS.md

Instructions for coding agents working in this repository — Codex, Claude Code,
or anything else.

**Read [CLAUDE.md](CLAUDE.md) first** — the source of truth for what this
project is, how it is built, and why the odd parts are the way they are — and
**[CONTRIBUTING.md](CONTRIBUTING.md)** for setup and the review process. Neither
is repeated here. Only `AGENTS.md` is loaded automatically, so those two are
linked rather than copied: three files saying the same thing is three files that
disagree within a month.

What follows are the rules Claude Code enforces automatically through hooks in
`.claude/`, and that **every other agent must follow by hand**, because those
hooks do not run for you.

## Working a task

This is the standing loop. It does not need restating in a prompt — assume it
unless you are told otherwise.

1. **Read the linked issue first.** It carries the constraints, and it is what
   the change gets reviewed against. If a task arrives without one, ask what
   "done" means before writing code.
2. **Branch off an up-to-date `main`**, named `feat/<short-description>` (or
   `fix/`, `docs/`). Never work on `main` itself.
3. **Stay inside the scope the issue names.** Finishing early is not a reason to
   add adjacent improvements; it makes a small reviewable change into a large
   unreviewable one. Raise the idea instead.
4. **Run `npm run typecheck` and `npm test` before committing.** Both are fast
   and both are cheap; neither touches the network or spends anything.
5. **Push the branch and hand back the pull request link.** `git push` prints one.
6. **Never merge, and never release.** A human decides both.

Prompts should carry only what cannot be read from the repository — product
judgment, scope, and where to stop. Which file to imitate and how to write the
code are things you can work out faster by reading than by being told.

## Working alongside other agents

**Assume you are not the only agent in this repository.** More than one works
here, on different schedules, and none of them can see each other. Two people
have write access, and scheduled Claude Code runs open PRs unattended.

**When the scheduled runs fire** (America/Los_Angeles):

| | |
|---|---|
| Hourly, 6am–11pm | Triage and small fixes. Silent when there is nothing. |
| 10pm nightly | One substantial change. Runs for as long as it takes. |

They take work in a fixed order: pull requests the maintainer has already
approved, then open blockers, then the queue, then widening `eval/`. They
branch, run `npm run typecheck` and `npm test`, and open a pull request. **They
never merge anything the maintainer has not explicitly approved, and never
commit to `main`.**

**The collision rule: do not start work on a file that already has an open pull
request touching it.** Check `gh pr list` — or the PR list on GitHub — before
you begin. If your task genuinely needs that file, either say so and wait, or
branch off *that* PR's head rather than off `main`, and say in your PR body that
you did. Two branches rewriting the same file from `main` is the one failure
mode that costs real time here, and it is entirely avoidable with one command.

**Open a draft PR early.** It is the only signal other agents can see. A branch
that exists only on your machine is invisible; a draft PR claims the territory
and costs nothing.

**The work queue is not in this repository.** It lives in the maintainer's
notes, along with the bug list and the approval flow. If you were given a task
without context, that is why — ask rather than inferring priority from the code.
Nothing in the repo tells you what matters this week.

**Remember that `.claude/` hooks do not run for you** (see the top of this
file). For Claude Code the branch guard and the auto-commit are enforced
mechanically. For you they are rules you have to keep by hand, and the branch
guard is the one that matters: `electron-builder` packages the working tree
rather than `HEAD`, so an uncommitted edit made while on `main` can reach an
installer without ever being committed.

## Never do these

**Never read, edit, or commit any `.env*` file** except `.env.example`. They hold
Supabase keys, a GitHub release token, and on older checkouts the relay token.
**This repository is public.** A secret committed here is a secret published to
the internet, and rewriting history does not unpublish it.

**Never commit directly to `main`.** Branch, open a pull request. `main` is the
only branch releases are cut from, and it advances by reviewed merge.

**Never edit the `version` field in `package.json`.** It belongs to
`scripts/ship.mjs` alone. Editing it by hand desynchronises the published
release channel from the repository.

**Never run the eval without asking first.** `npm run evaluate` makes paid
OpenAI calls and spends OpenAlex credits. Say what a run will cost before
proposing it. `EVAL_SKIP_CRITIQUE=1` is *not* free — detection is unconditional
and also paid.

**Never publish a release.** `npm run ship` and `npm run ship:preview` are the
maintainer's, and require a `GH_TOKEN` you do not have.

## Always do these

**Run `npm run typecheck` AND `npm test` before pushing.** These are the two
automated correctness checks this project has, and they are free.

`npm test` runs Node's built-in runner over `src/**/*.test.ts` — 282 tests
across 57 suites, in under a second. This file used to say "there is no test
suite yet", which was true when it was written and has not been for a while; an
agent that believed it skipped the only check that can catch a logic regression,
because typecheck cannot.

Note the constraint that shapes what is testable: the runner uses Node's type
stripping, whose ESM resolver rejects the extensionless relative imports used
throughout this codebase. **A module with a relative *value* import cannot be
unit tested.** That is why the tested modules are leaves — see the Structure
section of CLAUDE.md, which explains which logic was deliberately pushed into
leaf modules so it could be covered.

**Commit before building.** `electron-builder` packages the *working tree*, not
`HEAD`, so an uncommitted edit can end up inside an installer while being absent
from the commit it was supposedly built from.

**Keep branches short-lived.** Open a PR within a day or two. Long-lived
branches are the single largest source of pain in this repo's history: a
six-hunk conflict in a renderer component came from `main` rebuilding it on
Tailwind while a branch kept editing the pre-Tailwind version, and 421 lines
once sat uncommitted in stale worktrees.

## Which environment your build talks to

`TRACELY_API_URL`, `SUPABASE_URL` and `SUPABASE_ANON_KEY` are compiled into the
bundle at build time by `electron.vite.config.ts`. There is **no runtime
override** — no setting, no config file. The only way to see which backend a
build uses is the banner every build prints:

```
env=staging  file=.env.staging  api=api.jointracely.com (default)  supabase=sxifbtelrtbsgnnwnmdf
```

If you are not the maintainer, your `.env` holds **staging** Supabase values.
`TRACELY_API_URL` is different: unset, it defaults to the hosted production
server, `https://api.jointracely.com` — there is one server, not one per
environment the way there was one relay per environment. A session from a
Supabase project the server is not configured for does not verify there, so
your calls are metered as a signed-out free install (its own install id, the
free daily quota, and the server's app spend ceiling) rather than as any real
account. To keep a build off the hosted server entirely, point
`TRACELY_API_URL` at one you run (`cd server && npm start`, then
`http://localhost:4477`; `TRACELY_MOCK=1` makes it spend nothing). If the
banner ever says `production` on your machine, stop and ask.

## Where the backend lives

The desktop's AI calls go to the Tracely server — `server/` in this
repository, deployed as described in `server/DEPLOY.md`. `callServer` in
`src/main/services/ai/client.ts` is the only thing in the app that calls it,
and `scripts/preflight.mjs` refuses a release while any endpoint in that
function's union answers 404.

`Tracely-relay` is a separate repository, and installed builds from before the
move onto the server still call it until they update. It deploys by pushing a
branch: `staging` deploys the staging relay, `main` deploys production. There
is no deploy command. Always run `npx tsc --noEmit` before pushing the relay.
Vercel does not reliably fail a deploy on type errors, so a type-broken relay
can reach production.

## The two rules that exist because something broke

**Do not add a blanket exclusion to `files` in `electron-builder.yml`** without
checking what actually imports the thing you are excluding. v0.3.76 shipped with
the entire ML stack excluded; the app degraded to word-overlap ranking exactly as
designed — silently, with no error — while every measurement described a code
path no user was running.

**Do not change the order of checks in a relay endpoint** (the relay still
serves older installed builds). It is
`isAuthorized → resolveUser → checkRateLimit → parse → reserveUsage → OpenAI`.
Each step is cheaper than the one after it, and identity is resolved before
anything can spend. `resolveUser` fails **closed** and `checkRateLimit` fails
**open**, and that asymmetry is deliberate.
