#!/usr/bin/env node
/**
 * One-command release: check, bump, build, publish.
 *
 * It integrates nothing. Fast-forwarding main to origin is the one exception,
 * and it is not integration — it moves to commits that are already the remote's
 * tip, and refuses the moment a real merge would be needed. Bringing branches
 * together happens when a feature is done, not when a release is due, so this
 * only publishes what is already on main.
 *
 * The steps are ordered so the irreversible one is last and gated. preflight
 * runs inside release:win and refuses to publish unless main is clean, in
 * sync, typechecked, every server endpoint is live, and the version is above
 * the published one — so a bad state stops here rather than reaching users.
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Every child of a production ship gets TRACELY_ENV=production, pinned here and
// never inherited from the shell.
//
// This is the most dangerous thing in the environment split. If TRACELY_ENV
// were left over as 'staging' from an earlier `ship:preview`, this script would
// build a *production* release against the staging relay and staging Supabase,
// publish it to latest.yml, and every installed copy would take it inside six
// hours. The relay URL is inlined at build time with no runtime path back to
// it, so nobody could see what happened until users started failing to sign in.
const SHIP_ENV = { ...process.env, TRACELY_ENV: 'production' }
const run = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: SHIP_ENV, ...opts })
const out = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()

const die = (msg) => {
  console.error(`\n${msg}\n`)
  process.exit(1)
}

/**
 * SHIP_DRY_RUN=1 — everything except the part that reaches users.
 *
 * Exists because the only way to find out whether a release works was to
 * publish one, and a production release cannot be taken back: electron-updater
 * will not downgrade, so a bad build is in front of everyone until a good one
 * replaces it (see ROLLBACK.md). That made the release path the least-tested
 * code in the repo, which is the wrong way round.
 *
 * It is NOT side-effect free, and pretending otherwise would make it useless.
 * It really bumps the version, really opens the release PR and really merges it
 * to main — that sequence is the thing worth testing, and a version number is
 * cheap. What it does not do is build an installer or publish a release, so
 * nothing reaches a user.
 *
 * The cost is one skipped patch number: main ends up a version ahead of the
 * latest release, and the next real ship bumps past it. preflight is happy
 * either way — it requires the version to be strictly above the last published
 * release, which stays true.
 */
// Both forms, because the env-var one does not work everywhere. `FOO=1 npm run
// ship` is a bash-ism; through cmd.exe it silently sets nothing and you get a
// real release — the same trap CLAUDE.md records for TRACELY_ENV. The flag is
// shell-agnostic, and `npm run ship:dry` is the form worth remembering.
const DRY_RUN = process.env.SHIP_DRY_RUN === '1' || process.argv.includes('--dry-run')
if (DRY_RUN) {
  console.log('\nDRY RUN — will bump, open and merge the release PR, then stop before building.')
  console.log('          Nothing will be published. One version number will be used up.\n')
}

if (out('git status --porcelain')) die('Uncommitted work. Commit or stash it first.')

// Ship releases what is already on main; it does not gather anything.
//
// This used to merge agent1-work, agent2-work and agent3-work first, which
// meant release time was also integration time — the moment a conflict or a
// half-finished feature was most expensive to discover. Features now reach main
// when they are done, and a release is only ever a decision to publish what is
// already there.
const branch = out('git rev-parse --abbrev-ref HEAD')
if (branch !== 'main') {
  die(
    `On '${branch}', not main.\n\n` +
      `Releases are cut from main only. Land your work first:\n\n` +
      `  git checkout main && git merge --no-ff ${branch} && git push\n\n` +
      `then run npm run ship again.`
  )
}

// main falls behind origin every time a PR merges on GitHub, which is most of
// the time — v0.3.84 was blocked nine commits behind. preflight is right to
// refuse to publish a commit that isn't the tip of the remote, since the tag
// would point at something nobody else can fetch. But a hard stop made that
// gate fire on the one condition whose entire fix is `git pull`, typed by hand,
// followed by running the whole release again from the top.
//
// So do the pull here. It is safe *because* it is a fast-forward and nothing
// else: no merge commit, no conflict, and therefore no chance of resolving one
// badly under release pressure. The working tree was checked clean above, so
// there is nothing local for it to overwrite.
//
// Diverged main is the case this deliberately does not handle. Local commits
// *and* remote commits means someone pushed straight to main while a PR landed,
// and choosing what belongs in the release is integration — the thing this
// script exists to keep out of release time (see the header). It stops instead.
//
// preflight still checks sync on its own afterwards. This narrows what reaches
// the gate; it does not remove the gate.
try {
  run('git fetch --quiet origin main')
  const behind = Number(out('git rev-list --count HEAD..origin/main'))
  const ahead = Number(out('git rev-list --count origin/main..HEAD'))
  if (behind && ahead) {
    die(
      `main has diverged from origin/main — ${ahead} local commit(s), ${behind} remote.\n\n` +
        `Ship will not reconcile that for you. Sort it out, then run npm run ship again:\n\n` +
        `  git pull --rebase origin main`
    )
  }
  if (behind) {
    console.log(`\nSyncing main — ${behind} commit(s) behind origin`)
    run('git merge --ff-only origin/main')
  }
} catch {
  // Offline, or main has never been pushed. preflight tells both stories
  // properly a few lines down, and a second message here would only drift out
  // of step with that one. Fall through and let the gate speak.
}

// Before bumping, not after: a blocked ship should cost nothing, and bumping
// first burns a version number on every failed attempt.
console.log('\n1/4  Checking everything is releasable')
try {
  run('npm run preflight', { env: { ...SHIP_ENV, PREFLIGHT_SKIP_VERSION: '1' } })
} catch {
  die('Not releasable — nothing was changed. Fix the above and run npm run ship again.')
}

console.log('\n2/4  Bumping version')
run('npm version patch --no-git-tag-version')
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// The bump reaches main through a PR, because main no longer accepts anything
// else — branch protection requires a pull request and enforces it on admins,
// so the `git push origin main` this used to do now fails outright.
//
// Zero approvals are required, which is what keeps this automatic: the PR is
// opened, its `check` run has to go green, and it merges itself. The rule is
// "everything on main was a reviewed PR", not "a human clicks a button at 2am
// mid-release".
//
// Deliberately NOT solved by giving the release an admin bypass. A bypass that
// exists is a bypass that gets used for the thing that is urgent, which is
// exactly when the check matters most.
const releaseBranch = `release/v${version}`
run(`git checkout -b ${releaseBranch}`)
run(`git commit -am "Release v${version}"`)
run(`git push -u origin ${releaseBranch}`)
run(
  `gh pr create --base main --head ${releaseBranch} ` +
    `--title "Release v${version}" ` +
    `--body "Version bump for v${version}. Opened by npm run ship; merges itself once check passes."`
)

// --auto rather than a plain merge: `check` has not started yet at this point,
// and an immediate merge attempt is refused for a pending required check.
run(`gh pr merge ${releaseBranch} --merge --auto --delete-branch`)

console.log('     waiting for the release PR to merge…')
const MERGE_TIMEOUT_MS = 15 * 60_000
const startedAt = Date.now()
for (;;) {
  const state = out(`gh pr view ${releaseBranch} --json state --jq .state`)
  if (state === 'MERGED') break
  if (state === 'CLOSED') die(`The release PR for v${version} was closed without merging.`)
  if (Date.now() - startedAt > MERGE_TIMEOUT_MS) {
    // Nothing is published at this point and the bump is only on a branch, so
    // stopping here costs a version number and nothing else.
    die(
      `The release PR for v${version} has not merged in 15 minutes.\n\n` +
        `  gh pr view ${releaseBranch} --web\n\n` +
        'Nothing has been built or published. Merge it and run npm run ship again.'
    )
  }
  // A blocking sleep, in a script that is otherwise entirely synchronous.
  // Atomics.wait rather than a shell sleep so this does not depend on which
  // shell is behind execSync — `sleep` is not a command on Windows.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000)
}

// Back onto main at the merge commit, because that is what gets built and
// tagged. Building the release branch would tag a commit that is no longer
// what main says v<version> is.
run('git checkout main')
run('git pull --ff-only origin main')
console.log(`     v${version}`)

if (DRY_RUN) {
  const head = out('git rev-parse --short HEAD')
  console.log(`
DRY RUN COMPLETE — v${version} is on main at ${head}, nothing was published.

  Verified:   preflight, the version bump, the release PR, its auto-merge,
              and returning to main at the merge commit.
  Not run:    GH_TOKEN load, electron-builder, the GitHub release.
  Cost:       v${version} is now on main with no release behind it. The next
              real ship bumps past it; preflight still passes, since it asks
              for a version above the last PUBLISHED release.

Run npm run ship without SHIP_DRY_RUN to publish for real.
`)
  process.exit(0)
}

console.log('\n3/4  Loading GH_TOKEN')
// electron-builder does not read .env.release itself; --publish silently
// no-ops without a token, producing a "successful" release nobody receives.
const envFile = join(ROOT, '.env.release')
if (!existsSync(envFile)) die('.env.release not found — GH_TOKEN is required to publish.')
const token = readFileSync(envFile, 'utf8').match(/^GH_TOKEN=(.+)$/m)?.[1]?.trim()
if (!token) die('No GH_TOKEN in .env.release.')

console.log('\n4/4  Build + publish')
run('npm run release:win', { env: { ...SHIP_ENV, GH_TOKEN: token } })

console.log(`\nPublished v${version}. Users are offered it within 6 hours.\n`)
