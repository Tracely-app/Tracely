#!/usr/bin/env bash
# PreToolUse(Edit|Write): don't let source changes accumulate on main.
#
# This is the guard that actually protects main. Blocking `git commit` only
# stops the *record* of the mistake — by then the edit exists in the working
# tree, and electron-builder packages the working tree rather than HEAD, so a
# stray edit on main can reach an installer without ever being committed.
#
# Only exits 0 or 2. See guard-bash.sh for why exit 1 would be worse than
# having no hook at all.
set -uo pipefail

payload=$(cat)

path=$(printf '%s' "$payload" | node -e "
  let s=''
  process.stdin.on('data', d => s += d).on('end', () => {
    try { process.stdout.write(String(JSON.parse(s).tool_input?.file_path ?? '')) } catch { /* allow */ }
  })
" 2>/dev/null)

[ -z "$path" ] && exit 0

# Forward slashes so one pattern set matches whatever separator the tool used.
#
# tr rather than ${path//\\//}. That substitution looks right and silently does
# nothing here — which meant this guard allowed every Windows-style path, i.e.
# exactly the paths it exists to catch. Caught only because the test used
# backslashes; a forward-slash-only test would have passed while the guard was
# inert in practice.
norm=$(printf '%s' "$path" | tr '\\' '/')

# The branch is read from the checkout the edit LANDS IN, not from
# CLAUDE_PROJECT_DIR. Parallel work happens in throwaway worktrees (see
# CLAUDE.md), where CLAUDE_PROJECT_DIR still points at the main workspace — so
# reading it there reported "main" for every edit and blocked worktree agents
# from using Edit/Write at all, while a worktree that really was on main went
# unguarded. Both failures came from asking the wrong checkout.
dir=${norm%/*}
[ "$dir" = "$norm" ] && dir=.
# Walk up to the nearest existing directory: a Write can name a path whose
# parent does not exist yet.
while [ ! -d "$dir" ] && [ "$dir" != "${dir%/*}" ]; do
  dir=${dir%/*}
  [ -z "$dir" ] && dir=/
done
[ -d "$dir" ] || dir=${CLAUDE_PROJECT_DIR:-$PWD}

branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null) ||
  branch=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --abbrev-ref HEAD 2>/dev/null) ||
  exit 0
[ "$branch" = "main" ] || [ "$branch" = "master" ] || exit 0

case "$norm" in
  */src/*|*/scripts/*|*/package.json|*/electron-builder.yml|*/electron.vite.config.ts|*/server/*|*/extension/*)
    printf '%s\n' "Editing ${norm##*/} while on ${branch}.

main only advances by pull request. It is what releases are cut from, what the
server is deployed from and what the store zip is built from, and
electron-builder packages the working tree rather than HEAD.

  git checkout -b <type>/<slug>     # feat/, fix/, docs/, chore/

Then open a draft PR early: it is the only signal the other agent can see." >&2
    exit 2
    ;;
esac

exit 0
