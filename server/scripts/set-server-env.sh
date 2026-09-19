#!/bin/sh
# Set ONE variable in the deployed server's .env, without it appearing in
# scrollback, shell history, argv, or a temp file.
#
#   sh scripts/set-server-env.sh SUPABASE_SERVICE_ROLE_KEY
#   sh scripts/set-server-env.sh STRIPE_WEBHOOK_SECRET
#
# Run it on YOUR machine. It prompts locally with echo disabled and pipes the
# value over ssh. Safe to re-run: it replaces an existing line rather than
# appending, so it is also how you rotate a value.
set -e

VAR="$1"
REMOTE_HOST="${TRACELY_HOST:-root@45.56.92.67}"
REMOTE_ENV="${TRACELY_REMOTE_ENV:-/srv/tracely/app/.env}"

case "$VAR" in
  "") echo "Usage: sh scripts/set-server-env.sh <VARIABLE_NAME>"; exit 1 ;;
  [A-Z]*) ;;
  *) echo "Variable names are UPPER_SNAKE_CASE. Got: $VAR"; exit 1 ;;
esac

if [ -d /srv/tracely/app ]; then
  echo "You are running this ON the server. Run it from your own machine —"
  echo "it prompts there and pipes the value here."
  exit 1
fi

printf 'Paste the value for %s (input is hidden): ' "$VAR"
stty -echo 2>/dev/null || true
read -r VAL
stty echo 2>/dev/null || true
printf '\n'
VAL=$(printf '%s' "$VAL" | tr -d '[:space:]')
[ -n "$VAL" ] || { echo "Nothing pasted. Unchanged."; exit 1; }

# The value goes over stdin, never argv — argv is visible in `ps` to every
# user on the remote box.
printf '%s' "$VAL" | ssh "$REMOTE_HOST" "
set -e
F='$REMOTE_ENV'
VAR='$VAR'
NEW=\$(cat)
OWNER=\$(ls -ld \"\$F\" | awk '{print \$3\":\"\$4}')
umask 077
TMP=\"\$F.tmp.\$\$\"
grep -v \"^\$VAR=\" \"\$F\" > \"\$TMP\" 2>/dev/null || : > \"\$TMP\"
printf '%s=%s\n' \"\$VAR\" \"\$NEW\" >> \"\$TMP\"
mv \"\$TMP\" \"\$F\"
chmod 600 \"\$F\"
chown \"\$OWNER\" \"\$F\" 2>/dev/null || true
printf '  %s set (%s chars, ending ...%s)\n' \"\$VAR\" \"\${#NEW}\" \"\$(printf '%s' \"\$NEW\" | tail -c 4)\"
printf '  %s is now %s\n' \"\$F\" \"\$(ls -l \"\$F\" | cut -c1-10)\"
"
echo
echo "  .env is re-read on every request — nothing to restart."
