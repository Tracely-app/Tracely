#!/bin/sh
# Set OPENAI_API_KEY in a Tracely .env without the key ever touching shell
# history, the terminal, or a file you might later `cat` by accident.
#
#   sh scripts/set-openai-key.sh            # writes ../.env next to this script
#   sh scripts/set-openai-key.sh /srv/tracely/.env   # explicit target (the server)
#
# Safe to re-run: it REPLACES any existing OPENAI_API_KEY line rather than
# appending a second one, so this is also the key-rotation command. Every other
# line in the file is preserved byte for byte.
set -e

ENVFILE="${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/.env}"

printf 'Paste your OpenAI key (input is hidden), then press Return: '
# `read -s` is not POSIX, so echo is disabled around the read instead — this
# works identically in sh, bash and zsh, including over ssh on the server.
stty -echo 2>/dev/null || true
read -r KEY
stty echo 2>/dev/null || true
printf '\n'

# Strip anything a copy-paste picks up: spaces, newlines, a stray CR from a
# Windows clipboard.
KEY=$(printf '%s' "$KEY" | tr -d '[:space:]')

case "$KEY" in
  sk-*) ;;
  "")   echo "Nothing pasted. $ENVFILE unchanged."; exit 1 ;;
  *)    echo "That does not look like an OpenAI key (expected it to start with sk-). $ENVFILE unchanged."; exit 1 ;;
esac

umask 077
touch "$ENVFILE"
TMP="$ENVFILE.tmp.$$"
grep -v '^OPENAI_API_KEY=' "$ENVFILE" > "$TMP" 2>/dev/null || : > "$TMP"
printf 'OPENAI_API_KEY=%s\n' "$KEY" >> "$TMP"
mv "$TMP" "$ENVFILE"
chmod 600 "$ENVFILE"

# Confirm without ever printing the key.
echo "OPENAI_API_KEY set in $ENVFILE"
echo "  ${#KEY} characters, ending ...$(printf '%s' "$KEY" | tail -c 4)"
echo "  file mode now $(ls -l "$ENVFILE" | cut -c1-10)"
echo
echo "The server re-reads .env on every request, so there is nothing to restart."
