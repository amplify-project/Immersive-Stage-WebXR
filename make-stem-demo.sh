#!/usr/bin/env bash
# ============================================================================
#  make-stem-demo.sh — Demo PARA EL PLAYER del spotlight posicional por músico.
#
#  Genera un manifest DASH (vídeo 360 + audio Opus de 6 canales) en
#  encoded_stemdemo/:  c0..c3 = FOA Ambisonics,  c4 = tono 300 Hz (músico izq),
#  c5 = tono 2000 Hz (músico der). Un solo stream multicanal → sync a muestra.
#
#  Probar en la Quest:
#     node server.js
#     https://<host>:60000/index.html?src=https://<host>:60000/encoded_stemdemo/manifest.mpd&stems=40,-40
#
#  Con ?stems=40,-40 el player coloca el stem 300 Hz a +40° (izquierda) y el
#  2000 Hz a −40° (derecha). Haz zoom (rueda / joystick VR) mirando a la
#  izquierda → debe crecer el 300 Hz desde la izquierda; a la derecha → el
#  2000 Hz. Sin zoom, solo el lecho FOA.
#
#  Cambia los tonos por stems reales sustituyendo las entradas sine por
#  -i stem_izq.wav -i stem_der.wav (mono).
# ============================================================================
set -euo pipefail

VIDEO="${VIDEO:-media/video.mp4}"
AUDIO="${AUDIO:-media/ambisonic_bformat.wav}"
OUT="${OUT:-encoded_stemdemo}"
SEG="${SEG:-2}"
DUR="${DUR:-30}"                 # demo corta para encodear rápido
SCALE="${SCALE:-2560:1280}"

command -v ffmpeg >/dev/null || { echo "ffmpeg no encontrado"; exit 1; }
[[ -f "$VIDEO" ]] || { echo "No existe el vídeo: $VIDEO"; exit 1; }
[[ -f "$AUDIO" ]] || { echo "No existe el audio FOA: $AUDIO"; exit 1; }

mkdir -p "$OUT"
rm -f "$OUT"/*.webm "$OUT"/*.m4s "$OUT"/*.mp4 "$OUT"/*.mpd 2>/dev/null || true

echo "▶ Demo spotlight → $OUT/manifest.mpd  (${DUR}s, escala ${SCALE})"

ffmpeg -y \
  -t "$DUR" -i "$VIDEO" \
  -t "$DUR" -i "$AUDIO" \
  -f lavfi -i "sine=frequency=300:duration=$DUR" \
  -f lavfi -i "sine=frequency=2000:duration=$DUR" \
  -map 0:v:0 \
  -filter_complex "\
[1:a][2:a][3:a]amerge=inputs=3[m];\
[m]pan=6.0|c0=1.41421356*c0|c1=c2|c2=c3|c3=c1|c4=c4|c5=c5[a6]" \
  -map "[a6]" \
  -vf "scale=${SCALE}:flags=bicubic" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -b:v 6000k -g 48 -keyint_min 48 \
  -c:a libopus -mapping_family 255 -b:a 256k -ar 48000 \
  -f dash -dash_segment_type mp4 -seg_duration "$SEG" \
  -use_template 1 -use_timeline 1 \
  -adaptation_sets "id=0,streams=0 id=1,streams=1" \
  -init_seg_name "init_\$RepresentationID\$.m4s" \
  -media_seg_name "chunk_\$RepresentationID\$_\$Number%05d\$.m4s" \
  "$OUT/manifest.mpd"

echo "✓ Listo. Canales de audio:"
grep -o 'AudioChannelConfiguration[^/]*' "$OUT/manifest.mpd" || true
echo
echo "Abre en la Quest:"
echo "  https://<host>:60000/index.html?src=https://<host>:60000/$OUT/manifest.mpd&stems=40,-40"
