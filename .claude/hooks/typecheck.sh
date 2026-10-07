#!/usr/bin/env bash
# Stop: typecheck (and the server/extension suite) once per turn, at the only
# moment the code is meant to cohere.
#
# Deliberately NOT PostToolUse. Firing after every .ts edit means firing in the
# middle of a refactor, when the code is legitimately and temporarily broken —
# producing a stream of errors that are all noise, which is how a guardrail
# becomes something you learn to scroll past. Once per turn is also far cheaper:
# `npm run typecheck` is two full tsc passes over the project.
set -uo pipefail

payload=$(cat)

cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || exit 0

# Claude Code sets stop_hook_active when it is already responding to a Stop hook
# that blocked. Without honouring it, a genuinely unfixable type error would
# bounce between "stop" and "here are the errors" forever.
active=$(printf '%s' "$payload" | node -e "
  let s=''
  process.stdin.on('data', d => s += d).on('end', () => {
    try { process.stdout.write(JSON.parse(s).stop_hook_active ? '1' : '') } catch { /* fall through */ }
  })
" 2>/dev/null)
[ -n "$active" ] && exit 0

# A turn that touched no TypeScript gets no typecheck; a turn that touched
# neither server/ nor extension/ gets no server tests. A question, a git
# command or a docs edit stays silent rather than costing seconds.
ts=$(git status --porcelain -- '*.ts' '*.tsx' 2>/dev/null)
srv=$(git status --porcelain -- server/lib server/shared server/server.js server/scripts server/test 2>/dev/null)
ext=$(git status --porcelain -- extension 2>/dev/null)

if [ -n "$ts" ]; then
  if ! out=$(npm run typecheck 2>&1); then
    # Only the compiler's own lines — npm's wrapper output is noise here.
    errors=$(printf '%s' "$out" | grep -E "error TS[0-9]+" | head -20)
    [ -z "$errors" ] && errors=$(printf '%s' "$out" | tail -20)
    printf 'Typecheck failed:\n\n%s\n\nFix these before finishing.\n' "$errors" >&2
    exit 2
  fi
fi

# The server suite is zero-dependency and guards the extension too: 29 of its
# files slice extension/content.js by comment markers, so a moved marker or a
# changed verdict shape fails here, not on the other developer's machine. An
# extension-only turn runs just the ext-* files (~9 s); a server turn runs
# everything (986 tests, ~11 s alone, longer on a busy machine).
# TRACELY_HOOK_NO_TESTS=1 skips it for a session.
if [ -z "${TRACELY_HOOK_NO_TESTS:-}" ] && { [ -n "$srv" ] || [ -n "$ext" ]; }; then
  if [ -n "$srv" ]; then files=""; else files="test/ext-*.test.js"; fi
  if ! out=$(cd server && node --test $files 2>&1); then
    failed=$(printf '%s' "$out" | grep -E "^✖|^not ok" | head -12)
    [ -z "$failed" ] && failed=$(printf '%s' "$out" | tail -20)
    printf 'Server tests failed (cd server && npm test):\n\n%s\n\nFix these before finishing.\n' "$failed" >&2
    exit 2
  fi
fi

exit 0
