#!/usr/bin/env bash
# Refresh src/vendor/xr-telemetry.js, the XR-telemetry JavaScript SDK, from its
# repository at a given ref. The vendored file is never edited by hand: a change
# goes to XR-telemetry first and comes back through this script.
#
#   tools/update-xr-telemetry.sh [REF]          REF = tag, branch or commit (default: main)
#
# Source: a local clone if XRTEL_DIR points at one (default ~/projects/XR-telemetry),
# otherwise GitHub. Prints the diff against the copy in the repo.
set -euo pipefail
REF="${1:-main}"
REPO="${XRTEL_REPO:-amplify-project/XR-telemetry}"
SRC_PATH="sdk/js/xr-telemetry.js"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src/vendor/xr-telemetry.js"
DIR="${XRTEL_DIR:-$HOME/projects/XR-telemetry}"
tmp=$(mktemp); trap 'rm -f "$tmp" "$tmp.new"' EXIT

if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" fetch -q origin 2>/dev/null || echo "  (could not fetch $DIR; using what it has)"
  rev=$(git -C "$DIR" rev-parse --verify -q "origin/$REF^{commit}" || git -C "$DIR" rev-parse --verify "$REF^{commit}")
  git -C "$DIR" show "$rev:$SRC_PATH" > "$tmp"
  from="$DIR"
else
  rev=$(git ls-remote "https://github.com/$REPO.git" "$REF" | awk 'NR==1{print $1}')
  [[ -n "$rev" ]] || rev="$REF"                     # a commit hash is not listed by ls-remote
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$rev/$SRC_PATH" -o "$tmp"
  from="github.com/$REPO"
fi

{
  echo "// VENDORED — do not edit. XR-telemetry JavaScript SDK (Apache-2.0),"
  echo "// https://github.com/$REPO/blob/$rev/$SRC_PATH"
  echo "// ref: $REF · commit: $rev · refreshed with tools/update-xr-telemetry.sh"
  echo
  cat "$tmp"
} > "$tmp.new"

if [[ -f "$DEST" ]] && diff -q <(tail -n +5 "$DEST") "$tmp" >/dev/null; then
  echo "src/vendor/xr-telemetry.js already matches $REF ($rev); header refreshed."
else
  [[ -f "$DEST" ]] && diff -u <(tail -n +5 "$DEST") "$tmp" | sed 's/^/  /' || true
fi
mv "$tmp.new" "$DEST"
echo "✓ src/vendor/xr-telemetry.js ← $from @ ${rev:0:7} ($REF)"
