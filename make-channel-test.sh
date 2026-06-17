#!/usr/bin/env bash
# ============================================================================
#  make-channel-test.sh — SPIKE de verificación de canales multicanal Opus.
#
#  Genera un manifest DASH (audio-only) con UNA pista Opus de 6 canales:
#       c0..c3 → FOA Ambisonics (ACN/SN3D, convertido desde el B-format FuMa)
#       c4     → tono senoidal 300 Hz   (stem de prueba "músico 1")
#       c5     → tono senoidal 2000 Hz  (stem de prueba "músico 2")
#
#  Objetivo: medir CUÁNTOS canales decodifica y expone a Web Audio el navegador
#  de la Meta Quest (MSE → MediaElementSource → ChannelSplitter). Si los 6 llegan
#  separados, la vía "un único stream multicanal" para el spotlight por músico es
#  viable. Si topa en 2/8, sabremos el techo real antes de construir nada.
#
#  Los tonos son señales identificables a propósito: en channel-test.html, el
#  canal 4 debe leer ~300 Hz y el 5 ~2000 Hz con niveles INDEPENDIENTES. Si se
#  mezclan o desaparecen, hay downmix/acoplamiento. Cambia los tonos por stems
#  reales (-i stem1.wav -i stem2.wav) cuando el techo esté confirmado.
#
#  Uso:   ./make-channel-test.sh
#  Luego: node server.js   y abre en la Quest:
#         https://<host>:60000/channel-test.html
# ============================================================================
set -euo pipefail

AUDIO="${AUDIO:-media/ambisonic_bformat.wav}"   # 4ch FOA B-format (FuMa)
OUT="${OUT:-encoded6}"
SEG="${SEG:-2}"
DUR="${DUR:-60}"                                 # duración del test (s)
ABITRATE="${ABITRATE:-256k}"                     # más holgado: 6 canales

command -v ffmpeg >/dev/null || { echo "ffmpeg no encontrado"; exit 1; }
[[ -f "$AUDIO" ]] || { echo "No existe el audio FOA: $AUDIO"; exit 1; }

mkdir -p "$OUT"
rm -f "$OUT"/*.webm "$OUT"/*.mpd 2>/dev/null || true

echo "▶ Generando test de 6 canales (4 FOA + tono 300Hz + tono 2000Hz) → $OUT/manifest.mpd"

# amerge: [FOA 4ch][sine 300][sine 2000] → 6 canales crudos
# pan=6.0: aplica FuMa→AmbiX SOLO a los 4 primeros (√2·W, reordena WXYZ→WYZX)
#          y pasa los stems (c4,c5) tal cual.
ffmpeg -y \
  -t "$DUR" -i "$AUDIO" \
  -f lavfi -i "sine=frequency=300:duration=$DUR" \
  -f lavfi -i "sine=frequency=2000:duration=$DUR" \
  -filter_complex "\
[0:a][1:a][2:a]amerge=inputs=3[m];\
[m]pan=6.0|c0=1.41421356*c0|c1=c2|c2=c3|c3=c1|c4=c4|c5=c5[a6]" \
  -map "[a6]" \
  -c:a libopus -mapping_family 255 -b:a "$ABITRATE" -ar 48000 \
  -f dash -dash_segment_type webm -seg_duration "$SEG" \
  -use_template 1 -use_timeline 1 \
  -adaptation_sets "id=0,streams=0" \
  -init_seg_name "init_\$RepresentationID\$.webm" \
  -media_seg_name "chunk_\$RepresentationID\$_\$Number%05d\$.webm" \
  "$OUT/manifest.mpd"

echo "✓ Listo."
echo "  Verifica canales codificados:"
grep -o 'AudioChannelConfiguration[^/]*' "$OUT/manifest.mpd" || true
echo "  Abre en la Quest:  https://<host>:60000/channel-test.html"
