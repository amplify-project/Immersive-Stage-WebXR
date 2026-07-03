#!/usr/bin/env bash
# ============================================================================
#  measure_sync.sh — Mide el desfase A/V del directo AUTOMÁTICAMENTE (sin ojo ni
#  cuentas). Captura unos segundos de vídeo+audio con timestamps de reloj de
#  pared (fieles), detecta el instante de la palmada en el audio y el del
#  flash/golpe en el vídeo, y te imprime los milisegundos a meter en el editor.
#
#  A diferencia del monitor en vivo, esto NO aplica delay y NO reproduce en
#  tiempo real → no hay xrun ni cortes. Solo mide.
#
#  Uso:
#     ./measure_sync.sh                       # hw:1,0 + /dev/video10, 8 s
#     ./measure_sync.sh hw:1,0 /dev/video10   # dispositivos explícitos
#     DUR=6 CH=32 WCH=0 THRESH=-30 ./measure_sync.sh
#
#  Método: UNA sola acción que suene y se vea a la vez (no dos manos). En cuanto
#  arranque, quédate ~1 s EN SILENCIO y luego da una PALMADA seca delante de la
#  cámara: las manos juntándose son el evento visual y el sonido, sincronizados.
#  Valen igual una claqueta o tapar/destapar la lente. La palmada rompe el
#  silencio (audio) y provoca un cambio de escena (vídeo).
#
#  Detección: el audio (silencedetect) ancla el instante; el vídeo es el punto de
#  MÁXIMO movimiento en una ventana alrededor de ese instante (no un umbral
#  global), así el fondo de la escena no despista. Un ROI ceñido a las manos
#  afina el pico si hace falta:
#     ROI=640:360:1120:360 ./measure_sync.sh     # píxeles (uso manual)
#  Repite 2-3 veces y promedia si los valores bailan.
# ============================================================================
set -euo pipefail

AUDIO="${1:-hw:1,0}"
VIDEO="${2:-/dev/video10}"
CH="${CH:-32}"          # canales que abre el device de audio (X32 = 32)
WCH="${WCH:-0}"         # canal a escuchar (W del FOA = omni; 0 en 1-2 ch)
DUR="${DUR:-8}"         # segundos a capturar
THRESH="${THRESH:--30}" # umbral de silencio en dB (sube a -25/-20 si hay ruido)
WIN="${WIN:-1.2}"       # ventana (s) alrededor del audio donde buscar el vídeo
VMIN="${VMIN:-0.008}"   # movimiento mínimo aceptable del pico (rechaza el ruido)

TMP="$(mktemp -d)"; CLIP="$TMP/sync.mkv"
trap 'rm -rf "$TMP"' EXIT

echo "▶ Capturando ${DUR}s desde video=$VIDEO audio=$AUDIO (${CH}ch, canal $WCH)"
echo "  → quédate 1s en SILENCIO y luego una PALMADA seca delante de la cámara…"
ffmpeg -hide_banner -loglevel error \
  -f v4l2 -framerate 24 -use_wallclock_as_timestamps 1 -i "$VIDEO" \
  -f alsa -channels "$CH" -use_wallclock_as_timestamps 1 -i "$AUDIO" \
  -map 0:v -map 1:a -af "pan=mono|c0=c${WCH}" -t "$DUR" "$CLIP"

# ── Audio: primer instante en que el sonido rompe el silencio (la palmada) ──
#  `|| true` + awk sin `exit`: no cerramos la tubería pronto (evita SIGPIPE →
#  pipefail → set -e), y un "sin coincidencias" deja TA vacío en vez de abortar.
TA=$(ffmpeg -hide_banner -nostats -i "$CLIP" -af "silencedetect=n=${THRESH}dB:d=0.05" -f null - 2>&1 \
     | awk -F'silence_end: ' '/silence_end/ && !f {print $2+0; f=1}') || true

# Sin audio no hay ancla → no se puede medir (y el vídeo solo no basta).
if [ -z "${TA:-}" ]; then
  echo "────────────────────────────────────────────"
  echo "✗ No oí la palmada (TA vacío). Sube el nivel o baja el umbral: THRESH=-25"
  echo "  (o -20). Verifica que la palmada está en el canal WCH=$WCH. Clip: $CLIP"
  trap - EXIT; exit 1
fi

# ── Vídeo: momento de MÁXIMO movimiento en una ventana alrededor del audio ──
#  El movimiento de una palmada da un "scene score" pequeño; en vez de un umbral
#  global (frágil: el fondo de una escena 360 lo supera), anclamos en TA: ya
#  sabemos cuándo sonó y el desfase A/V es pequeño, así que el mayor movimiento
#  en TA±WIN ES la palmada. Un ROI ceñido a las manos afina el pico.
#    ROI_REL="w:h:x:y"  fracciones 0..1 (lo usa el editor: indep. de resolución)
#    ROI="w:h:x:y"      píxeles absolutos (uso manual desde terminal)
if [ -n "${ROI_REL:-}" ]; then
  IFS=: read -r rw rh rx ry <<<"$ROI_REL"
  CROP="crop=iw*${rw}:ih*${rh}:iw*${rx}:ih*${ry},"
elif [ -n "${ROI:-}" ]; then
  CROP="crop=${ROI},"
else
  CROP=""
fi
# Lista (t score) de todos los frames; el argmax en la ventana lo hace awk.
TV=$(ffmpeg -hide_banner -nostats -i "$CLIP" -an \
       -vf "${CROP}select='gt(scene,0)',metadata=print" -f null - 2>&1 \
     | awk '/pts_time:/{t=$0; sub(/.*pts_time:/,"",t); sub(/[^0-9.].*/,"",t)}
            /scene_score=/{s=$0; sub(/.*scene_score=/,"",s); print t" "s}' \
     | awk -v ta="$TA" -v w="$WIN" -v vmin="$VMIN" '
            ($1>=ta-w && $1<=ta+w && $2+0>best){best=$2+0; bt=$1}
            END{ if(best>=vmin) print bt }') || true

echo "────────────────────────────────────────────"
if [ -z "${TV:-}" ]; then
  echo "✗ No vi la palmada cerca de TA=${TA}s (sin movimiento > ${VMIN} en ±${WIN}s)."
  echo "  Palma dentro del cuadro y usa un ROI ceñido a las manos (📷 ROI en el"
  echo "  editor), o baja VMIN. El clip quedó en: $CLIP (no se borró)"
  trap - EXIT
  exit 1
fi

DELAY=$(awk -v tv="$TV" -v ta="$TA" 'BEGIN{printf "%.0f", (tv-ta)*1000}')
echo "  Audio (palmada)  Ta = ${TA}s"
echo "  Vídeo (palmada)  Tv = ${TV}s"
echo "────────────────────────────────────────────"
echo "  A/V delay = ${DELAY} ms"
if (( DELAY >= 0 )); then
  echo "  → mete ${DELAY} en 'A/V delay (ms)' del editor (retrasa el audio para"
  echo "    alinearlo con el vídeo, que llega más tarde)."
else
  echo "  → el vídeo llega ANTES que el audio (${DELAY} ms). El delay del editor"
  echo "    retrasa audio; aquí tendrías que retrasar el vídeo. Revisa la cadena."
fi
