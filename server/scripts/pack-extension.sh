#!/usr/bin/env bash
# Pack extension/ into a zip a tester can Load-unpacked, named for its version.
#
# The name is the whole point. "Tracely-beta.zip" was handed round for weeks and
# nobody — including us — could say which build any given person had, so the
# first current-build bug reported was diagnosed as a stale install. The version
# is now in the filename, and it is the same string the Extensions page shows
# beside the card.
#
# Nothing here is a build step: the extension ships its source as-is. This only
# removes what should never have been in a tester's copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXT="$ROOT/extension"
OUT_DIR="${1:-$HOME/Desktop}"

VERSION=$(node -p "require('$EXT/manifest.json').version")
STAGE=$(mktemp -d)
NAME="Tracely-$VERSION"

# Copied into a named directory first, because Chrome installs the FOLDER: a
# zip whose contents sit at the root unpacks as a pile of loose files next to
# whatever else is in Downloads, and "pick the folder" then has no folder.
mkdir -p "$STAGE/$NAME"
rsync -a --exclude '.*' --exclude 'node_modules' --exclude '*.map' "$EXT/" "$STAGE/$NAME/"

ZIP="$OUT_DIR/$NAME.zip"
rm -f "$ZIP"
( cd "$STAGE" && zip -qr "$ZIP" "$NAME" -x '*.DS_Store' )
rm -rf "$STAGE"

echo "$ZIP"
echo "  version   $VERSION"
echo "  files     $(unzip -l "$ZIP" | tail -1 | awk '{print $2}')"
echo "  size      $(du -h "$ZIP" | cut -f1)"
