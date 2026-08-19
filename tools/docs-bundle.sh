#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Build ONE Markdown file with all the project documentation, for uploading
#  to a reader that takes a single source (NotebookLM, an LLM chat, a PDF
#  printer). Not for humans reading the repo — in the repo the docs are
#  separate files on purpose, and that is where they get edited.
#
#      ./tools/docs-bundle.sh              → dist/docs-bundle.md
#      ./tools/docs-bundle.sh /tmp/out.md  → wherever you say
#
#  Regenerate it whenever the docs change: the bundle is a copy, and a stale
#  copy answering questions confidently is worse than no copy at all — which
#  is why it is generated, git-ignored, and stamped with the commit it was
#  built from.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-dist/docs-bundle.md}"
mkdir -p "$(dirname "$OUT")"

# Reading order, not alphabetical order: what the thing is, then how it is put
# together, then the reference material, then the operational guides.
DOCS=(
  README.md
  docs/architecture.md
  docs/core-api.md
  docs/musician-meshes.md
  docs/telemetry.md
  docs/live-editor-tutorial.md
  docs/produccion-hardware.md
  docs/handoff.md
)

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
DIRTY=""; git diff --quiet 2>/dev/null || DIRTY=" + uncommitted changes"
DATE="$(date -I)"

{
cat <<EOF
# Livestreamed Immersive Player — complete documentation

Generated $DATE from branch \`$BRANCH\` at commit \`$COMMIT\`$DIRTY by
\`tools/docs-bundle.sh\`. It is the concatenation of the repository's own
documents, listed below in reading order. Anything not in those files is not in
here: the source code is the authority on behaviour, and where this bundle and
the code disagree, the code is right and the document is out of date.

## What this project is

A web player for **live and recorded immersive concerts**: a 360 video sphere
with **first-order ambisonic (FOA) sound**, plus **one audio stem per musician**
placed in space. Looking at a musician raises that musician — the "spotlight" —
so the audience mixes the concert by looking around. It runs in a browser, in VR
headsets (WebXR), and in **AR passthrough**, where the 360 video is dropped and
the musicians stay anchored to points of the real room, optionally shown as 3D
models.

The repository holds the player, a **scene editor** (a web page that writes
\`scene.json\` and launches the encodes), a **Node server** (static files, editor
API, telemetry ingest), the **encode pipeline** (ffmpeg → DASH, VOD and live),
and the **immersive audio engine** as a reusable ES module.

## Vocabulary

Terms used throughout without re-explanation:

- **FOA / bed** — first-order ambisonics, 4 channels (W, X, Y, Z), the whole
  concert as one sound field. **FuMa** and **AmbiX** are two channel orders and
  normalisations for it; the scene declares which one a file uses.
- **Stem** — one musician's audio on its own, placed as a point source. Stems ride
  *on top of* the bed, which already contains everybody.
- **Spotlight** — the gain a stem gets for being looked at (VR/360) or gazed at
  long enough (AR). \`maxBoost\`, \`focusExp\`, \`restGain\`, \`bedDuck\` tune it.
- **Scene / \`scene.json\`** — the whole configuration: sources, each musician's
  placement, the spotlight, AR, telemetry, encode settings. The editor owns this
  file; nothing else should rewrite it.
- **Room / AR room** — AR coordinates in **metres**, origin where the headset's
  calibration puts the listener. Distinct from the **360 sphere**, where a
  musician is a *direction* (azimuth/elevation) at a fixed radius, not a point.
- **roomGroup** — the single Three.js node carrying room→headset alignment, so the
  room can be turned and shifted as one thing.
- **Close-up** — a per-musician video track, a separate crop, selected as an
  alternative to the 360 (multi-track DASH).
- **Mesh** — a \`.glb\` 3D model shown instead of a wireframe marker in AR.
- **DASH** — the streaming format everything is delivered in (\`manifest.mpd\` plus
  segments), produced by ffmpeg for both VOD and live.

## Contents

EOF
i=0
for f in "${DOCS[@]}"; do
  i=$((i+1))
  title="$(grep -m1 '^# ' "$f" 2>/dev/null | sed 's/^# //')"
  echo "$i. \`$f\` — ${title:-（no title）}"
done

for f in "${DOCS[@]}"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; continue; }
  printf '\n\n---\n\n'
  # The path is repeated as a heading before each document: in one long file it
  # is the only thing that says which document an answer came from.
  printf '# ── Source file: `%s` ──\n\n' "$f"
  cat "$f"
done

printf '\n\n---\n\n'
printf '# ── End of bundle: `%s` documents, built %s from `%s` ──\n' "${#DOCS[@]}" "$DATE" "$COMMIT"
} > "$OUT"

printf '%s  (%s, %s lines, %s words)\n' "$OUT" \
  "$(du -h "$OUT" | cut -f1)" "$(wc -l < "$OUT")" "$(wc -w < "$OUT")"
