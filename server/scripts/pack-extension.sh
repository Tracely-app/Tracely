#!/usr/bin/env bash
# Pack extension/ into a zip named for its version. Two layouts, because the
# two consumers disagree about where manifest.json goes:
#
#   server/scripts/pack-extension.sh [OUT_DIR]           -> Tracely-<version>-store.zip
#   server/scripts/pack-extension.sh --beta [OUT_DIR]    -> Tracely-<version>-beta.zip
#                                                        (OUT_DIR defaults to ~/Desktop)
#
# The plain build is the CHROME WEB STORE upload: manifest.json sits at the ZIP
# ROOT, as the store requires ("place the manifest file in the root directory,
# not in a folder"), and it never contains beta.json. Before #256 this build
# wrote Tracely-<version>.zip with everything inside a Tracely-<version>/
# folder like the beta one, which the store does not accept.
#
# The --beta build is for testers, who install with Load unpacked. Chrome
# installs a FOLDER, so that zip keeps its Tracely-<version>-beta/ wrapper: a
# zip whose contents sit at the root unpacks as a pile of loose files next to
# whatever else is in Downloads, and "pick the folder" then has no folder.
#
# The name is the whole point. "Tracely-beta.zip" was handed round for weeks and
# nobody — including us — could say which build any given person had, so the
# first current-build bug reported was diagnosed as a stale install. The version
# is now in the filename, and it is the same string the Extensions page shows
# beside the card.
#
# Nothing here is a build step: the extension ships its source as-is. This only
# removes what should never have been in a shipped copy.
#
# --beta builds the TEST extension: everyone who loads it unpacked is served as
# Pro by the hosted server. It needs TRACELY_BETA_TOKEN in the environment (one
# of the server's TRACELY_BETA_TOKENS — see server/DEPLOY.md), writes it to
# beta.json in the STAGED copy only, and names the zip Tracely-<version>-beta.zip.
# The token is never written into extension/ and beta.json is never committed:
# this repo is public. The extension sends the token only when beta.json is
# present AND Chrome reports the copy was loaded unpacked, so the same token in
# a Web Store upload would do nothing — but a plain build excludes beta.json
# explicitly anyway, even if a stray one sits in extension/, and the layout
# check at the end refuses a store zip that carries one anywhere.
#
# manifest.json's "key" is shipped unchanged in BOTH zips. It is the Web Store
# item's own public key, and it pins the id (dffmoeebkkghhgcklkbmaibfhgiegmdm)
# for unpacked builds so they match the published extension, Supabase's
# redirect allowlist and the server's TRACELY_EXTENSION_ID. Verify it on the
# first store upload from this layout: if the Web Store rejects the zip over
# "key", strip the field from the STAGED store copy here — never from
# extension/, which every unpacked build needs.
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
if [ "$BETA" = 1 ]; then NAME="Tracely-$VERSION-beta"; else NAME="Tracely-$VERSION-store"; fi

# Staged into a named directory on both builds; only the beta zip keeps that
# directory as its top-level folder (see the header for why the two differ).
# /beta.json is excluded on EVERY build: a plain build must never carry one,
# and a beta build gets a fresh one written below, never a stray local copy.
# /dev/ is developer tooling (the fix-in-doc spike and its browser harness,
# which names a public test Doc): nothing in the manifest loads it, and no
# tester's copy should carry it.
mkdir -p "$STAGE/$NAME"
rsync -a --exclude '.*' --exclude 'node_modules' --exclude '*.map' --exclude '/beta.json' --exclude '/dev/' "$EXT/" "$STAGE/$NAME/"

if [ "$BETA" = 1 ]; then
  # JSON-encoded by node, not by string pasting, so no token can break the file.
  TRACELY_BETA_TOKEN="$TOKEN" node -e 'process.stdout.write(JSON.stringify({ token: process.env.TRACELY_BETA_TOKEN }) + "\n")' \
    > "$STAGE/$NAME/beta.json"
fi

# The store build asks for no permission a store user can use. The localhost
# host permission exists for a developer's own server on :4477 (the unpacked
# and beta builds keep it); on a published extension it is a permission with
# no feature behind it, which is what the store's "narrowest permissions"
# rule is about. Stripped from the STAGED copy only — the repo manifest is
# what developers load.
if [ "$BETA" != 1 ]; then
  node -e '
    const fs = require("fs"); const p = process.argv[1];
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.host_permissions = (m.host_permissions || []).filter((h) => !/^http:\/\/localhost(:\d+)?\//.test(h));
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  ' "$STAGE/$NAME/manifest.json"
fi

mkdir -p "$OUT_DIR"
ZIP="$(cd "$OUT_DIR" && pwd)/$NAME.zip"
rm -f "$ZIP"
if [ "$BETA" = 1 ]; then
  ( cd "$STAGE" && zip -qr "$ZIP" "$NAME" -x '*.DS_Store' )      # Tracely-<v>-beta/manifest.json
else
  ( cd "$STAGE/$NAME" && zip -qr "$ZIP" . -x '*.DS_Store' )     # manifest.json at the root
fi

# Belt and braces: check the zip itself, not the intent, and delete it on any
# failure so a wrong layout is never left lying where it could be uploaded or
# handed out. The listing is taken once and searched through here-strings, not
# pipes: under pipefail an early-exiting grep -q kills the writer with SIGPIPE
# and turns a found file into "not found". Entry names are matched as FIXED
# strings (-F, awk index) because the version's dots are regex wildcards.
fail() {
  rm -f "$ZIP"
  echo "pack-extension$([ "$BETA" = 1 ] && echo ' --beta'): $1 — refusing to leave that zip behind." >&2
  exit 1
}
LISTING=$(unzip -Z1 "$ZIP")
has() { grep -Fqx -- "$1" <<<"$LISTING"; }
count() { grep -cE -- "$1" <<<"$LISTING" || true; }

# extension/dev/ is developer tooling (the fix-in-doc spike and its browser
# harness). rsync excludes it; this proves it stayed out, in either layout.
[ "$(count '(^|/)dev/')" = 0 ] || fail "the zip contained extension/dev/ (developer tooling)"

if [ "$BETA" = 1 ]; then
  MANIFEST_ENTRY="$NAME/manifest.json"
  has "$MANIFEST_ENTRY" || fail "$MANIFEST_ENTRY is missing (Load unpacked needs the folder)"
  has "$NAME/beta.json" || fail "$NAME/beta.json did not make it into the zip"
  [ "$(count '(^|/)beta\.json$')" = 1 ] || fail "expected exactly one beta.json, at $NAME/beta.json"
  OUTSIDE=$(awk -v p="$NAME/" 'index($0, p) != 1 { n++ } END { print n + 0 }' <<<"$LISTING")
  [ "$OUTSIDE" = 0 ] || fail "$OUTSIDE entries sit outside the $NAME/ folder"
  # The token that went in is the token that came out, still valid JSON.
  unzip -p "$ZIP" "$NAME/beta.json" | TRACELY_BETA_TOKEN="$TOKEN" node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      process.exit(JSON.parse(s).token === process.env.TRACELY_BETA_TOKEN ? 0 : 1);
    });' || fail "$NAME/beta.json does not hold the token"
else
  MANIFEST_ENTRY="manifest.json"
  has "$MANIFEST_ENTRY" || fail "manifest.json is not at the zip root (the Web Store rejects a foldered zip)"
  [ "$(count '(^|/)beta\.json$')" = 0 ] || fail "a store build contained beta.json"
fi
# Whichever layout, the manifest in the zip parses and is the version named.
ZIP_VERSION=$(unzip -p "$ZIP" "$MANIFEST_ENTRY" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(String(JSON.parse(s).version)));') \
  || fail "$MANIFEST_ENTRY in the zip is not valid JSON"
[ "$ZIP_VERSION" = "$VERSION" ] || fail "$MANIFEST_ENTRY says $ZIP_VERSION, expected $VERSION"

echo "$ZIP"
if [ "$BETA" = 1 ]; then
  echo "  version   $VERSION  (beta: served as Pro when loaded unpacked)"
  echo "  layout    $NAME/manifest.json + $NAME/beta.json  (unzip, then Load unpacked the folder)"
else
  echo "  version   $VERSION  (Web Store upload)"
  echo "  layout    manifest.json at the zip root, no beta.json"
fi
echo "  files     $(unzip -l "$ZIP" | tail -1 | awk '{print $2}')"
echo "  size      $(du -h "$ZIP" | cut -f1)"
