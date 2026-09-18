#!/bin/sh
# Copy the OpenAI key from this machine's .env to the deployed server.
#
#   sh scripts/deploy-openai-key.sh
#
# The key travels local .env -> ssh stdin -> the server's .env. It is never
# printed, never placed in argv (visible in `ps`), never written to a temp
# file, and never enters shell history on either machine. You do not need to
# know it, find it, or type it.
#
# Safe to re-run: the remote script REPLACES any existing OPENAI_API_KEY line
# rather than appending, so this is also how you rotate the key.
set -e

LOCAL_ENV="${TRACELY_LOCAL_ENV:-$HOME/tracely/.env}"
REMOTE_HOST="${TRACELY_HOST:-root@45.56.92.67}"
REMOTE_ENV="${TRACELY_REMOTE_ENV:-/srv/tracely/app/.env}"
REMOTE_SCRIPT="${TRACELY_REMOTE_SCRIPT:-/srv/tracely/app/scripts/set-openai-key.sh}"

# This runs on the DEVELOPER'S machine and pushes to the server. Running it ON
# the server is the obvious mistake -- the prompt looks the same, ~ resolves to
# /root, and the error is a confusing "No such file" about a path you never
# typed. Detect it and say the one useful sentence instead.
if [ -d /srv/tracely/app ] && [ ! -f "$LOCAL_ENV" ]; then
  echo "You are running this ON the server."
  echo
  echo "This script belongs on your own machine: it reads the key from YOUR"
  echo ".env and pushes it here. The server has no copy of the key -- that is"
  echo "the whole point of it."
  echo
  echo "Log out (or open a new terminal on your Mac) and run:"
  echo "    sh ~/tracely/scripts/deploy-openai-key.sh"
  exit 1
fi

[ -f "$LOCAL_ENV" ] || {
  echo "No local env at $LOCAL_ENV"
  echo "If you are on the server, run this from your own machine instead."
  exit 1
}

# Presence check only — the value is never assigned to a shell variable here,
# because a variable can end up in a core dump or a `set -x` trace.
if ! grep -q '^OPENAI_API_KEY=.\+' "$LOCAL_ENV"; then
  echo "No OPENAI_API_KEY in $LOCAL_ENV."
  echo "Set it locally first:  sh scripts/set-openai-key.sh"
  exit 1
fi
LEN=$(grep '^OPENAI_API_KEY=' "$LOCAL_ENV" | head -1 | cut -d= -f2- | tr -d '\n' | wc -c | tr -d ' ')
echo "Found a key in $LOCAL_ENV ($LEN chars). Sending it to $REMOTE_HOST ..."

# The pipe is the whole point: the key exists only in flight.
grep '^OPENAI_API_KEY=' "$LOCAL_ENV" | head -1 | cut -d= -f2- \
  | ssh "$REMOTE_HOST" "sh $REMOTE_SCRIPT $REMOTE_ENV"

echo
echo "Verifying against the live API ..."
if command -v curl >/dev/null 2>&1; then
  curl -s --max-time 15 https://api.jointracely.com/api/status \
    | sed -E 's/.*"hasKey":(true|false).*/  server reports hasKey=\1/' || true
fi
echo "  (hasKey=true means it is live; nothing needs restarting)"
