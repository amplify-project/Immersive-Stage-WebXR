#!/usr/bin/env bash
# Close-up videos cut from a 360 master, one per musician in scene.json, full
# length and frame-aligned with it (same input frames, same timestamps).
#
# One ffmpeg pass: the 360 is decoded once and split into one flat view per
# musician (v360 equirect → flat), aimed with the calibrated angles
# (yaw = -azimuthDeg, pitch = elevationDeg). The width of each view is the
# stem's cropFovDeg, or 4 × hitDeg (8° by default → 32°), clamped to 20-90°,
# the same rule the server uses for "✂ crop from the 360".
#
#   tools/make-closeup-crops.sh <360 video> [out dir]
#
#   OUT dir      default media/  → media/<NAME><SUFFIX>.mp4, pickable in the editor
#   SUFFIX=_cu   file name suffix (another one keeps existing close-ups)
#   START=s      start this many seconds into the master: when the scene's 360
#                is an excerpt of it (media/video.mp4 = Pisa from 4.908 s)
#   DURATION=s   only s seconds (a test, or the length of that excerpt)
#   FOV=deg      same width for every musician (overrides the scene)
#   SIZE=1280:720  CRF=16  PRESET=faster  SHARPEN=0.5 (cas; 0 = off)
#   INTERP=lanc  v360 interpolation (lanc | cube | line)
#   HWDEC=1      decode the 360 on the NVIDIA GPU (CUDA)
#
# Fragmented MP4: a run cut short (closed terminal, Ctrl-C) leaves files that
# open up to where it got, instead of an mp4 with no index ("moov atom not
# found") that nothing can read.
#
# The close-ups only stay in sync if they start where the scene's 360 starts.
# If the 360 is an excerpt of the master, pass where it begins as START (find it
# from the audio: the scene's stems against the master's, or the black intro).
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:?usage: tools/make-closeup-crops.sh <360 video> [out dir]}"
OUT="${2:-media}"
INTERP="${INTERP:-lanc}"; SUFFIX="${SUFFIX:-_cu}"
SIZE="${SIZE:-1280:720}"; CRF="${CRF:-16}"; PRESET="${PRESET:-faster}"; SHARPEN="${SHARPEN:-0.5}"
[[ -f "$SRC" ]] || { echo "no such video: $SRC"; exit 1; }
mkdir -p "$OUT"
IFS=':' read -r W H <<< "$SIZE"

# name yaw pitch hfov vfov, one line per stem.
mapfile -t STEMS < <(python3 - "$W" "$H" "${FOV:-0}" <<'PY'
import json, math, sys
w, h, force = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
for s in json.load(open("scene.json"))["stems"]:
    fov = force or float(s.get("cropFovDeg") or 0) or max(20.0, min(90.0, 4 * float(s.get("hitDeg") or 8)))
    vfov = 2 * math.degrees(math.atan(math.tan(math.radians(fov / 2)) * h / w))
    print(s["name"], -float(s.get("azimuthDeg", 0)), float(s.get("elevationDeg", 0)), round(fov, 3), round(vfov, 3))
PY
)
N=${#STEMS[@]}
(( N > 0 )) || { echo "no stems in scene.json"; exit 1; }

SH=""; [[ "$SHARPEN" != "0" ]] && SH=",cas=${SHARPEN}"
FC="[0:v]split=${N}"; for ((i=0; i<N; i++)); do FC+="[s$i]"; done; FC+=";"
MAPS=()
for ((i=0; i<N; i++)); do
  read -r name yaw pitch hfov vfov <<< "${STEMS[i]}"
  FC+="[s$i]v360=input=e:output=flat:yaw=$yaw:pitch=$pitch:h_fov=$hfov:v_fov=$vfov:w=$W:h=$H:interp=${INTERP}${SH},format=yuv420p[o$i];"
  MAPS+=(-map "[o$i]" -c:v libx264 -preset "$PRESET" -crf "$CRF" -an -movflags +frag_keyframe+empty_moov+default_base_moof "$OUT/${name}${SUFFIX}.mp4")
  echo "  $name  yaw $yaw  pitch $pitch  fov ${hfov}x${vfov}  → $OUT/${name}${SUFFIX}.mp4"
done

DUR=(); [[ -n "${START:-}" ]] && DUR+=(-ss "$START"); [[ -n "${DURATION:-}" ]] && DUR+=(-t "$DURATION")
HW=(); [[ "${HWDEC:-0}" == "1" ]] && HW=(-hwaccel cuda)
ffmpeg -nostdin -hide_banner -y "${HW[@]}" "${DUR[@]}" -i "$SRC" -filter_complex "${FC%;}" "${MAPS[@]}"
echo "done: $N close-ups in $OUT/"
