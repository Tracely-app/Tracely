#!/usr/bin/env bash
# Pack extension/ into a zip a tester can Load-unpacked, named for its version.
#
#   server/scripts/pack-extension.sh [--beta] [OUT_DIR]      (OUT_DIR defaults to ~/Desktop)
#
# The name is the whole point. "Tracely-beta.zip" was handed round for weeks and
# nobody — including us — could say which build any given person had, so the
# first current-build bug reported was diagnosed as a stale install. The version
# is now in the filename, and it is the same string the Extensions page shows
# beside the card.
#
# Nothing here is a build step: the extension ships its source as-is. This only
# removes what should never have been in a tester's copy.
#
# --beta builds the TEST extension: everyone who loads it unpacked is served as
# Pro by the hosted server. It needs TRACELY_BETA_TOKEN in the environment (one
# of the server's TRACELY_BETA_TOKENS — see server/DEPLOY.md), writes it to
# beta.json in the STAGED copy only, and names the zip Tracely-<version>-beta.zip.
# The token is never written into extension/ and beta.json is never committed:
# this repo is public. The extension sends the token only when beta.json is
# present AND Chrome reports the copy was loaded unpacked, so the same token in
# a Web Store upload would do nothing — but a plain build excludes beta.json
# explicitly anyway, even if a stray one sits in extension/.
set -euo pipefail

BETA=0
OUT_DIR=""
for arg in "$@"; do
  case "$arg" in
    --beta) BETA=1 ;;
    -*) echo "pack-extension: unknown option $arg (usage: pack-extension.sh [--beta] [OUT_DIR])" >&2; exit 2 ;;
    *)
      if [ -n "$OUT_DIR" ]; then
        echo "pack-extension: more than one OUT_DIR given (usage: pack-extension.sh [--beta] [OUT_DIR])" >&2
        exit 2
      fi
      OUT_DIR="$arg"
      ;;
  esac
done
OUT_DIR="${OUT_DIR:-$HOME/Desktop}"

if [ "$BETA" = 1 ]; then
  TOKEN="${TRACELY_BETA_TOKEN:-}"
  if [ -z "$TOKEN" ]; then
    echo "pack-extension --beta: TRACELY_BETA_TOKEN is not set (or empty)." >&2
    echo "  Set it to one of the server's TRACELY_BETA_TOKENS, e.g." >&2
    echo "  TRACELY_BETA_TOKEN=... server/scripts/pack-extension.sh --beta" >&2
    exit 1
  fi
  # The server splits TRACELY_BETA_TOKENS on commas, trims each entry and
  # reads at most 200 characters of a header, so a token that breaks any of
  # those could never match: refuse it here rather than ship a zip that is
  # silently free. Matched against the WHOLE string with bash's =~ — grep
  # matches line by line, so "abc<newline>d,e f" passed when one line did.
  TOKEN_RE='^[A-Za-z0-9._~+/=-]{1,200}$'
  if ! [[ "$TOKEN" =~ $TOKEN_RE ]]; then
    echo "pack-extension --beta: TRACELY_BETA_TOKEN must be 1-200 characters of A-Z a-z 0-9 . _ ~ + / = -" >&2
    echo "  (no commas or spaces: the server's TRACELY_BETA_TOKENS is a comma-separated list)." >&2
    exit 1
  fi
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXT="$ROOT/extension"

VERSION=$(node -p "require('$EXT/manifest.json').version")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
NAME="Tracely-$VERSION"
[ "$BETA" = 1 ] && NAME="$NAME-beta"

# Copied into a named directory first, because Chrome installs the FOLDER: a
# zip whose contents sit at the root unpacks as a pile of loose files next to
# whatever else is in Downloads, and "pick the folder" then has no folder.
# /beta.json is excluded on EVERY build: a plain build must never carry one,
# and a beta build gets a fresh one written below, never a stray local copy.
mkdir -p "$STAGE/$NAME"
rsync -a --exclude '.*' --exclude 'node_modules' --exclude '*.map' --exclude '/beta.json' "$EXT/" "$STAGE/$NAME/"

if [ "$BETA" = 1 ]; then
  # JSON-encoded by node, not by string pasting, so no token can break the file.
  TRACELY_BETA_TOKEN="$TOKEN" node -e 'process.stdout.write(JSON.stringify({ token: process.env.TRACELY_BETA_TOKEN }) + "\n")' \
    > "$STAGE/$NAME/beta.json"
fi

mkdir -p "$OUT_DIR"
ZIP="$(cd "$OUT_DIR" && pwd)/$NAME.zip"
rm -f "$ZIP"
( cd "$STAGE" && zip -qr "$ZIP" "$NAME" -x '*.DS_Store' )

# Belt and braces: check the zip itself, not the intent. grep -c rather than
# grep -q: -q exits on the first match, unzip then dies of SIGPIPE, and
# pipefail turns a found file into "not found".
HAS_BETA=$(unzip -Z1 "$ZIP" | grep -c '/beta\.json$' || true)
if [ "$HAS_BETA" -gt 0 ]; then
  if [ "$BETA" != 1 ]; then
    rm -f "$ZIP"
    echo "pack-extension: a plain build contained beta.json — refusing to leave that zip behind." >&2
    exit 1
  fi
elif [ "$BETA" = 1 ]; then
  rm -f "$ZIP"
  echo "pack-extension --beta: beta.json did not make it into the zip." >&2
  exit 1
fi

echo "$ZIP"
echo "  version   $VERSION$([ "$BETA" = 1 ] && echo '  (beta: served as Pro when loaded unpacked)')"
echo "  files     $(unzip -l "$ZIP" | tail -1 | awk '{print $2}')"
echo "  size      $(du -h "$ZIP" | cut -f1)"
