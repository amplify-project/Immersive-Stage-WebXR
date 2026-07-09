#!/usr/bin/env bash
# make-chtest.sh [N] — pista DASH de N canales, un tono distinto por canal.
#
# Sirve para MEDIR si el navegador reordena los canales de un Opus multicanal.
# Chromium lo hace con 3..8 canales aunque se encodee con mapping_family 255; en
# src/audio/opusChannelMap.js está la tabla, pero solo la fila de 7 se ha medido
# en un dispositivo real. Con esto se comprueba cualquier otra:
#
#   ./make-chtest.sh 6
#   → https://<host>:60000/channel-test.html?src=/chtest6/manifest.mpd&ch=6
#
# Cada fila debe marcar el tono de su canal fuente. Con &chmap=identity se ven
# las salidas crudas del ChannelSplitter, que es donde se aprecia la permutación.
set -euo pipefail

N="${1:-7}"
[[ "$N" =~ ^[0-9]+$ ]] && (( N >= 1 && N <= 16 )) || { echo "N debe estar entre 1 y 16"; exit 1; }

OUT="chtest${N}"
[[ "$N" == 7 ]] && OUT="chtest"      # el de 7 vive en chtest/, referenciado en los docs

# Tonos bien separados y fáciles de leer en la FFT (bins de ~23 Hz a 48 kHz/2048).
TONES=(200 300 400 500 800 1200 1600 2000 2400 2800 3200 3600 4000 4400 4800 5200)

INPUTS=(); FILTER=""
for (( i = 0; i < N; i++ )); do
  INPUTS+=(-f lavfi -i "sine=f=${TONES[$i]}:d=30")
  FILTER+="[${i}:a]"
done
FILTER+="amerge=inputs=${N}[a]"

rm -rf "$OUT"; mkdir -p "$OUT"

# Mismo encoder que stream.sh: mapping_family 255 (canales discretos, sin layout).
ffmpeg -hide_banner -v error "${INPUTS[@]}" \
  -filter_complex "$FILTER" -map "[a]" \
  -c:a libopus -mapping_family 255 -b:a "$(( 64 * N ))k" -ar 48000 \
  -f dash -dash_segment_type webm -seg_duration 6 \
  -init_seg_name 'init_$RepresentationID$.webm' \
  -media_seg_name 'chunk_$RepresentationID$_$Number%05d$.webm' \
  "$OUT/manifest.mpd"

echo "→ $OUT/manifest.mpd  ($N canales)"
for (( i = 0; i < N; i++ )); do echo "   canal $i → ${TONES[$i]} Hz"; done
echo
echo "Abre:  https://<host>:60000/channel-test.html?src=/$OUT/manifest.mpd&ch=$N"
