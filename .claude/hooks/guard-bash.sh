#!/usr/bin/env bash
# PreToolUse(Bash): keep main clean, and make spending deliberate.
#
# Exit codes matter more than they look. Exit 2 blocks the call and shows
# stderr to Claude. Exit 0 allows it. EVERY OTHER non-zero exit — 1 from a
# scripting slip, 127 from a missing binary — is treated as a hook error and
# the tool runs anyway. So this script must only ever exit 0 or 2, and any
# internal failure must land on 0 rather than 1.
set -uo pipefail

payload=$(cat)

# Parsed with node rather than bash string surgery. Git Bash has no jq, and the
# usual ${x#*\"command\":\"} trick silently truncates any command containing an
# escaped quote — which would make this guard skip exactly the commands most
# likely to be doing something unusual.
field() {
  printf '%s' "$payload" | node -e "
    let s=''
    process.stdin.on('data', d => s += d).on('end', () => {
      try { process.stdout.write(String(JSON.parse(s).tool_input?.$1 ?? '')) } catch { /* allow */ }
    })
  " 2>/dev/null
}

cmd=$(field command)
[ -z "$cmd" ] && exit 0

# The branch comes from the checkout the command will actually run in. Parallel
# work happens in throwaway worktrees, where CLAUDE_PROJECT_DIR still names the
# main workspace — so reading it there judged every worktree agent against
# whatever branch main happened to be on, and a worktree sitting on main was
# never stopped from committing. The payload's own cwd is the directory the
# Bash tool runs in; CLAUDE_PROJECT_DIR is the fallback when it is absent.
#
# A LEADING `cd` WINS over the payload's `cwd`, and the order is the whole
# point. `cwd` is the session's directory as it stands BEFORE the command runs;
# `cd <worktree> && git commit` runs somewhere else entirely, and reading `cwd`
# there judges a worktree commit against whatever branch the main checkout
# happens to be on. That denied every commit inside a worktree with "On main" —
# the original bug with its sign flipped, worktree agents going from unable to
# Edit to unable to commit.
#
# Worth recording how that was found, because it was invisible twice over: a
# hand-built payload has no `cwd`, so the synthetic test fell through to the
# `cd` parse and passed while the real thing failed. Only running an actual
# commit inside a worktree showed it. Test this hook with real commands, not
# with payloads written by hand.
where=$(printf '%s' "$cmd" | node -e "
  let s=''
  process.stdin.on('data', d => s += d).on('end', () => {
    try {
      const m = /^\s*cd\s+(\"([^\"]+)\"|'([^']+)'|([^\s&;|]+))/.exec(s)
      process.stdout.write(m ? (m[2] || m[3] || m[4] || '') : '')
    } catch { /* allow */ }
  })
" 2>/dev/null)

if [ ! -d "$where" ]; then
  where=$(printf '%s' "$payload" | node -e "
    let s=''
    process.stdin.on('data', d => s += d).on('end', () => {
      try { process.stdout.write(String(JSON.parse(s).cwd ?? '')) } catch { /* allow */ }
    })
  " 2>/dev/null)
fi

[ -d "$where" ] || where=${CLAUDE_PROJECT_DIR:-$PWD}

cd "$where" 2>/dev/null || exit 0
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0

deny() {
  printf '%s\n' "$1" >&2
  exit 2
}

# Hand-rolled JSON, same reason as above: no jq available.
ask() {
  local m=${1//\\/\\\\}
  m=${m//\"/\\\"}
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$m"
  exit 0
}

if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  case "$cmd" in
    # `git merge` is deliberately NOT here. Landing a reviewed branch means
    # checking out main and merging into it, so denying merge-on-main banned
    # the one way main is supposed to advance — the guard forbade the workflow
    # it exists to enforce. Anything genuinely dangerous about a merge is
    # covered by the commit/rebase/force-push rules that remain.
    *"git commit"*|*"git rebase"*)
      # npm run ship is exempt: it commits the version bump on main by design,
      # and it runs git inside execSync, so this hook never sees those calls —
      # it only sees the single `npm run ship` invocation.
      deny "On ${branch}. It advances only by a reviewed merge, so releases stay reproducible.

Work on a branch instead:
  git checkout -b feat/<what-you-are-doing>

To land a finished branch:  git merge --no-ff <branch>
To release what is on main: npm run ship"
      ;;
    # Pushing main is legitimate — it is how a merge reaches origin — but it is
    # also the moment work becomes public and, for the relay, the moment a
    # deploy fires. Worth a beat, not a wall.
    *"git push"*)
      ask "Pushing ${branch}. main is what releases are cut from and what the server is deployed from." ;;
  esac
fi

# Money and irreversibility. 'ask' rather than 'deny' — these are all things you
# legitimately want to run, just never by accident.
case "$cmd" in
  *EVAL_ALLOW_SPEND*|*EVAL_REFRESH*|*"npm run evaluate"*|*"eval/models/harness/run.mjs"*)
    ask "This runs an eval: paid OpenAI calls (and, for the desktop eval, OpenAlex credits). Say what it costs first." ;;
  # A dry run publishes nothing, and saying it does would be worse than saying
  # nothing: a prompt that cries wolf on the safe form is what teaches people to
  # click through the dangerous one. It still asks, because it does bump the
  # version and merge a PR to main.
  *"ship:dry"*|*"--dry-run"*)
    ask "Dry run: bumps the version and merges the release PR to main, then stops. Nothing is built or published." ;;
  *"run ship"*|*release:win*|*preview:win*)
    ask "This publishes a release. Installed copies pick it up within 6 hours and electron-updater cannot downgrade them." ;;
  # The server's publishing path (server/DEPLOY.md): anything that reaches the
  # Linode or restarts the service is a production change every installed
  # extension and desktop talks to the moment it lands.
  *45.56.92.67*|*"systemctl restart tracely"*|*"systemctl stop tracely"*|*"/srv/tracely/"*)
    ask "This touches the production server (the Linode). Every installed extension and desktop talks to it; follow server/DEPLOY.md (snapshot, backup, verify) and update STATUS.md after." ;;
  # The extension's publishing path. The --beta zip carries the token that
  # grants testers Pro; it must never reach the Developer Dashboard.
  *"pack-extension.sh"*)
    ask "This builds an extension zip. The store zip is what Sam uploads; the --beta zip carries the Pro-grant token and must never be uploaded to the Web Store." ;;
  # Landing a PR is the moment the other developer's agent inherits it.
  *"gh pr merge"*)
    ask "This merges a pull request into main. Its Handoff section must say who acts next (deploy, store upload, ship)." ;;
  *"git tag"*"ext/"*|*"git tag"*"server/"*)
    ask "This tags a release point other tooling and STATUS.md refer to." ;;
  *"git push --force"*|*"git push -f"*)
    ask "Force push. This rewrites history other checkouts may already have." ;;
esac

exit 0
