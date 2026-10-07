#!/usr/bin/env bash
# Stop hook: commit any work from the finished turn and push it to the current
# branch, so nothing survives only in a working tree.
#
# Lives in the repo rather than ~/.claude/hooks so it is versioned with the
# rules it enforces. The previous copy was global and registered per worktree;
# two of those registrations disappeared with their worktrees, and work sat
# uncommitted in both — 421 lines of it — which is the exact outcome this
# script exists to prevent.
#
# Never exits non-zero: a failed commit or push should report itself and get
# out of the way, not wedge the session.
set -uo pipefail

# Hand-rolled rather than `jq -nc --arg` because Git Bash on Windows has no
# jq, and a hook whose only reporting path is a missing binary fails silently.
emit() {
  local m=${1//\\/\\\\}
  m=${m//\"/\\\"}
  m=${m//$'\n'/ }
  m=${m//$'\r'/}
  m=${m//$'\t'/ }
  printf '{"systemMessage":"%s"}\n' "$m"
  exit 0
}

cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Committing on top of a half-finished merge/rebase produces a state that is
# genuinely painful to unwind by hand, so bail rather than "help".
gitdir=$(git rev-parse --git-dir)
for marker in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  if [ -e "$gitdir/$marker" ]; then
    emit "Auto-commit skipped: repo is mid-merge/rebase. Finish it, then commit manually."
  fi
done

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "HEAD" ] && emit "Auto-commit skipped: detached HEAD."

# main is the integration branch and the branch releases are cut from, so it
# only ever advances by a deliberate merge. Sweeping a half-finished turn onto
# it would quietly make the next release's source untrustworthy — the one thing
# this hook must never do. Work belongs on feat/* branches.
case "$branch" in
  main|master)
    if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files -o --exclude-standard)" ]; then
      emit "Auto-commit skipped: on ${branch}, which only advances by deliberate merge. Run: git checkout -b feat/<name>"
    fi
    exit 0
    ;;
esac

# Tracked files: everything the turn modified. Untracked files: only inside
# the directories the project owns, plus Markdown at the root. `git add -A`
# used to sweep whatever happened to be lying around — editor fragments,
# builder-error.log — into main four times over.
git add -u 2>/dev/null
git add -- src server extension eval scripts docs e2e .claude .github resources '*.md' 2>/dev/null
stray=$(git ls-files -o --exclude-standard | grep -v '/' | grep -v '\.md$' | head -5 | paste -sd', ' -)

# Nothing staged means the turn changed no files (a question, a read-only
# investigation) — stay completely silent rather than reporting a non-event.
if git diff --cached --quiet; then
  [ -n "$stray" ] && emit "Nothing committed. Untracked at the root and left alone: ${stray}"
  exit 0
fi

count=$(git diff --cached --name-only | wc -l | tr -d ' ')
areas=$(git diff --cached --name-only -z \
  | while IFS= read -r -d '' f; do d=$(dirname "$f"); [ "$d" = "." ] && d=root; echo "$d"; done \
  | sort -u | head -3 | paste -sd', ' -)
[ -z "$areas" ] && areas="repo"

# The subject is the PR's title when the branch has one — so a squash merge,
# and `git log` between merges, say what the work is rather than "auto: 3
# file(s)". Without a PR it is the branch name. The checkpoint count stays in
# the body.
subject=""
if command -v gh >/dev/null 2>&1; then
  subject=$(gh pr view "$branch" --json title -q .title 2>/dev/null | head -1)
fi
[ -z "$subject" ] && subject="${branch}: checkpoint (${count} file(s) in ${areas})"
coauthor=${CLAUDE_COAUTHOR:-"Claude <noreply@anthropic.com>"}

if ! git commit -q -m "$subject" \
    -m "Automatic checkpoint at the end of a Claude Code turn: ${count} file(s) in ${areas}, $(date '+%Y-%m-%d %H:%M')." \
    -m "Co-Authored-By: ${coauthor}" 2>/dev/null; then
  emit "Auto-commit failed on ${branch} — changes are staged but uncommitted."
fi

sha=$(git rev-parse --short HEAD)

if err=$(git push origin "HEAD:${branch}" 2>&1); then
  nudge=""
  if command -v gh >/dev/null 2>&1 && ! gh pr view "$branch" --json number >/dev/null 2>&1; then
    nudge=" No PR yet: open a draft (gh pr create --draft) — it is the only signal the other developer's agent can see."
  fi
  [ -n "$stray" ] && nudge="${nudge} Untracked at the root and left alone: ${stray}."
  emit "Auto-committed ${sha} (${count} file(s)) and pushed to ${branch}.${nudge}"
fi

# Most common cause is the remote having moved ahead. Never auto-resolve that
# with a force push — the commit is safe locally, so just say so.
reason=$(printf '%s' "$err" | grep -Eio 'rejected|permission denied|could not resolve host|authentication failed|timed out' | head -1)
emit "Auto-committed ${sha} (${count} file(s)) to ${branch}, but push failed (${reason:-see git output}). Run: git push origin ${branch}"
