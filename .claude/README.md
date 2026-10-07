# `.claude/` — how the guardrails work

Checked in on purpose. These are project rules, not personal preferences, and
they should be the same for anyone (or any agent) working on Tracely.
Machine-specific settings go in `settings.local.json`, which is gitignored.

## Why secrets are a permission rule, not a hook

`settings.json` denies reads and writes of `.env`, `.env.staging`, `.env.release`,
`.env.live` and `server/.env` through `permissions.deny` rather than through a hook.

A hook has to *run* to protect you. If bash is missing, or the file picked up
CRLF line endings, or there's a typo on line 3, the hook exits non-zero — and a
non-zero exit that isn't exactly `2` is treated as a hook *error*, which means
the tool call proceeds anyway. So a broken secret-guard hook looks identical to
a working one right up until it lets something through. A permission rule is
declarative and cannot fail open.

The paths are enumerated rather than globbed as `.env*`, because that glob would
also block `.env.example`, which is documentation and should stay readable.

**Consequence:** `.env.staging` has to be created by hand. That is intended.

## The hooks

| File | Fires on | Does |
|---|---|---|
| `guard-bash.sh` | before any `Bash` | Denies `git commit`/`rebase` on `main`. Asks before: pushing `main`, anything that reaches the production server (the Linode, `systemctl restart tracely`), `pack-extension.sh`, `gh pr merge`, release tags, `npm run ship`, force pushes, and anything that spends on an eval. |
| `guard-edit.sh` | before any `Edit`/`Write` | Refuses edits to `src/`, `scripts/`, `server/`, `extension/`, `package.json` and the build config while on `main`. Docs and `.claude/` may be edited on `main`. |
| `typecheck.sh` | end of turn | `npm run typecheck` if the turn touched TypeScript; `cd server && npm test` (the server AND extension suite, ~10 s) if it touched `server/` or `extension/`. `TRACELY_HOOK_NO_TESTS=1` skips the suite for a session. |
| `autocommit.sh` | end of turn | Commits the turn's work with the PR's title as the subject (or the branch name) and pushes to the current branch. Refuses on `main`. Adds only tracked changes and new files under the project's own directories; names, and leaves alone, anything untracked at the root. Reminds you to open a draft PR when the branch has none. |

**Not guarded, by design:** the Web Store upload, the website and DNS (Vercel),
and the server's `.env` on the Linode. Those are people's actions, named in
`STATUS.md` and the PR template's Handoff section, not commands this repo can see.

### Rules any new hook here must follow

**Only ever exit 0 or 2.** Exit 2 blocks and shows stderr to Claude; exit 0
allows. Every other non-zero exit is a hook error and the tool runs regardless,
so `exit 1` on a scripting slip means the guard silently stops guarding.

**No `jq`.** Git Bash on Windows doesn't have it. Parse the stdin payload with
`node`, which this project already depends on. Don't use bash string slicing
like `${x#*\"command\":\"}` — it truncates on the first escaped quote, so it
fails on exactly the unusual commands worth inspecting.

**Test that it actually blocks.** Feed it a payload and check the exit code. Two
real bugs were caught this way: a `${path//\\//}` substitution that silently
didn't normalise Windows separators, so the edit guard allowed every backslash
path; and a test whose own JSON was malformed, which made a working guard look
broken. A hook nobody has watched block is not a guardrail.

**Line endings.** `.gitattributes` pins `*.sh` to LF. Without it, `core.autocrlf`
hands bash a trailing `\r` and the script dies before its first check.

## Why `guard-edit.sh` exists when `guard-bash.sh` already blocks commits

Blocking `git commit` stops the *record* of the mistake, not the mistake.
`electron-builder` packages the working tree rather than `HEAD`, so an
uncommitted edit sitting on `main` can reach an installer without ever being
committed. The edit guard is the real protection; the commit rule is a backstop.

`npm run ship` is unaffected: it runs git inside `execSync`, so the hook only
ever sees the single `npm run ship` invocation, not the commands underneath it.

## Lore: how main, worktrees and the guards relate

Moved verbatim from the root CLAUDE.md on 2026-10-07; each bullet was written after something broke.

- **`main` is the integration branch and the only branch releases are cut
  from.** It advances by deliberate merge. `.claude/hooks/guard-edit.sh` refuses
  edits to `src/`, `scripts/` and the build config while on `main`, because
  `electron-builder` packages the working tree rather than `HEAD` — an
  uncommitted edit there can reach an installer without ever being committed.
- **Merge into `main` when a feature is done, not when a release is due.**
  `npm run ship` no longer merges anything; it publishes what is already on
  `main`. Release time should not also be integration time.
- **Parallel work uses throwaway worktrees, not permanent ones.** Subagents
  launched with `isolation: "worktree"` get their own checkout and clean up
  after themselves. Three standing worktrees with a file-ownership contract were
  retired in favour of this: the contract needed maintaining, branches drifted
  24 commits behind, and 421 lines once sat uncommitted in two of them because
  each worktree registered the auto-commit hook separately.
- **A worktree runs the guards it was branched from, not the ones on `main`.**
  `settings.json` invokes them as `$CLAUDE_PROJECT_DIR/.claude/hooks/*.sh`, and
  in a worktree session that variable resolves to the worktree — so the hook
  files are whatever that checkout has, and fixing a guard on `main` does
  nothing for any worktree already in flight. A live probe of the revised
  `guard-bash.sh` sailed through a `git commit` aimed at `main` for exactly this
  reason: the session was four commits behind and running the version with the
  bug. **Merge `main` before trusting a guard in a long-lived worktree**, and
  test hook changes from a checkout that actually has them.
- **Test the guards with real tool calls, not hand-built payloads.** A synthetic
  payload has no `cwd` field, so it falls through to whatever the fallback is
  and passes while the real thing fails. Both hook bugs so far were found by
  running an actual command and neither was caught by a 19-case suite over
  invented JSON. The suite is still worth having for the branches real probes
  cannot reach — the deny path needs some checkout to be sitting on `main` —
  but it confirms nothing on its own.
