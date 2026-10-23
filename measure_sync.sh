#!/usr/bin/env bash
# ============================================================================
#  measure_sync.sh — Mide el desfase A/V del directo AUTOMÁTICAMENTE (sin ojo ni
#  cuentas). Captura unos segundos de vídeo+audio igual que el directo
#  (mismos timestamps), detecta el instante de la palmada en el audio y el del
#  flash/golpe en el vídeo, y te imprime los milisegundos a meter en el editor.
#
#  A diferencia del monitor en vivo, esto NO aplica delay y NO reproduce en
#  tiempo real → no hay xrun ni cortes. Solo mide.
#
#  Uso:
#     ./measure_sync.sh                       # hw:1,0 + /dev/video10, 8 s
#     ./measure_sync.sh hw:1,0 /dev/video10   # dispositivos explícitos
#     DUR=6 CH=32 WCH=0 JUMP=15 ./measure_sync.sh
#     FROM_OUT=encoded CUR_DELAY=450 ./measure_sync.sh   # sobre el directo (mejor)
#
#  Método: UNA sola acción que suene y se vea a la vez (no dos manos). En cuanto
#  arranque, quédate ~1 s EN SILENCIO y luego da una PALMADA seca delante de la
#  cámara: las manos juntándose son el evento visual y el sonido, sincronizados.
#  Valen igual una claqueta o tapar/destapar la lente. La palmada rompe el
#  silencio (audio) y provoca un cambio de escena (vídeo).
#
#  Timestamps: los MISMOS que el directo (stream.sh): sin
#  -use_wallclock_as_timestamps, v4l2 y ALSA con sus marcas nativas. Con reloj de
#  pared se medía la latencia de LLEGADA de cada paquete, que no es el desfase
#  que acaba en el MPD (daba ~990 ms donde el directo necesitaba ~500). Así el
#  número es el `live.audio.delay` que hay que poner, medido con delay 0.
#
#  Detección: el audio (el golpe más brusco) ancla el instante; el vídeo es el punto de
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
SKIP="${SKIP:-0.4}"     # s iniciales ignorados (el device abre con un pop/ruido)
WIN="${WIN:-2.0}"       # s DESPUÉS del audio donde buscar el vídeo (llega tarde)
PRE="${PRE:-0.2}"       # s ANTES del audio admitidos (el movimiento previo a la
                        # palmada daba picos falsos y delays negativos imposibles)
VMIN="${VMIN:-0.008}"   # movimiento mínimo aceptable del pico (rechaza el ruido)

FR="${FR:-30}"           # fps a pedir a la cámara (la misma que el directo)
INFORMAT="${INFORMAT:-}" # p.ej. mjpeg (webcams: sin él no dan resoluciones altas)
VSIZE="${VSIZE:-}"       # p.ej. 2560x1440

TMP="$(mktemp -d)"; CLIP="$TMP/sync.mkv"
trap 'rm -rf "$TMP"' EXIT
AFILE="$CLIP"; VFILE="$CLIP"; ACH="$WCH"

# ── FROM_OUT: measure ON THE RUNNING LIVE, from its own DASH output ─────────
#  The capture below opens the devices on its own, and its A/V offset is not
#  the live's (it gave 989 and 200 where the live needed 450). The live's
#  segments are exactly what the players get: clap while it runs, rebuild the
#  last seconds of the 360 and of the audio from $FROM_OUT, and measure the
#  offset LEFT in them. The answer is CUR_DELAY (the delay the live runs with)
#  plus that residual. Does not touch the devices.
if [[ -n "${FROM_OUT:-}" ]]; then
  SEG="${SEG:-2}"; CUR_DELAY="${CUR_DELAY:-0}"
  echo "▶ Midiendo sobre el directo ($FROM_OUT, delay actual ${CUR_DELAY} ms)"
  echo "  → quédate 1s en SILENCIO y luego una PALMADA seca delante de la cámara…"
  # Wait for the clap, then for the segments that hold it to close.
  [[ "${NOWAIT:-0}" == "1" ]] || sleep "$(( DUR + 2 * SEG ))"
  vinit=$(ls -t "$FROM_OUT"/init_*_0.m4s 2>/dev/null | head -1)
  [[ -n "$vinit" ]] || { echo "✗ No hay segmentos del directo en $FROM_OUT (¿está en marcha?)."; exit 1; }
  sess="${vinit##*/init_}"; sess="${sess%_0.m4s}"
  ainit=$(ls "$FROM_OUT"/init_"$sess"_*.webm 2>/dev/null | head -1)
  [[ -n "$ainit" ]] || { echo "✗ El directo no tiene pista de audio Opus (.webm) en $FROM_OUT."; exit 1; }
  arep="${ainit##*_}"; arep="${arep%.webm}"
  n=$(( (DUR + 2 * SEG) / SEG + 1 ))
  # Only closed segments (ffmpeg writes .tmp and renames), the newest n of each.
  { cat "$vinit"; ls "$FROM_OUT"/chunk_"$sess"_0_*.m4s | sort | tail -n "$n" | xargs cat; } > "$TMP/v.mp4"
  { cat "$ainit"; ls "$FROM_OUT"/chunk_"$sess"_"$arep"_*.webm | sort | tail -n "$n" | xargs cat; } > "$TMP/a.webm"
  VFILE="$TMP/v.mp4"; AFILE="$TMP/a.webm"; ACH=0   # channel 0 of the output = W
else

# Open the devices the way stream.sh does, or the capture fails before it starts.
# The audio device: ask it what it takes. UAC2 interfaces (X32, Scarlett) only
# open as S32_LE, a headset only as S16_LE mono; ffmpeg asks S16 by default.
[[ -e "$VIDEO" ]] || { echo "✗ No existe la cámara $VIDEO (¿desconectada?)."; exit 1; }
card="${AUDIO#*:}"; card="${card%%,*}"
if [[ "$AUDIO" == hw:* && ! -e "/proc/asound/card$card" ]]; then
  echo "✗ No hay tarjeta de sonido $AUDIO (¿desconectada?). Conectadas ahora:"
  sed -n 's/^ *\([0-9]*\) \[[^]]*\]: \(.*\)/  hw:\1,0  \2/p' /proc/asound/cards
  exit 1
fi
ACODEC="${ACODEC:-}"
hwp=$(LC_ALL=C timeout 3 arecord -D "$AUDIO" --dump-hw-params -d 1 /dev/null 2>&1 || true)
if grep -qi busy <<< "$hwp"; then
  echo "✗ $AUDIO está ocupado por otro programa (¿el directo, el monitor, o PulseAudio/Ajustes de Sonido?)."
  exit 1
fi
fmts=$(sed -n 's/^FORMAT: *//p' <<< "$hwp")
if [[ -z "$ACODEC" ]]; then
  for f in S32_LE S16_LE S24_LE; do
    [[ " $fmts " == *" $f "* ]] && { ACODEC="pcm_$(tr 'A-Z' 'a-z' <<< "${f/_/}")"; break; }
  done
fi
chs=$(sed -n 's/^CHANNELS: *//p' <<< "$hwp" | tr -d '[]')
if [[ -n "$chs" ]]; then
  read -r chmin chmax <<< "$chs"; chmax="${chmax:-$chmin}"
  (( CH > chmax )) && CH=$chmax
  (( CH < chmin )) && CH=$chmin
fi
(( WCH < CH )) || WCH=0
VIN=(-f v4l2 -framerate "$FR")
[[ -n "$INFORMAT" ]] && VIN+=(-input_format "$INFORMAT")
[[ -n "$VSIZE" ]] && VIN+=(-video_size "$VSIZE")

echo "▶ Capturando ${DUR}s desde video=$VIDEO audio=$AUDIO (${CH}ch ${ACODEC:-?}, canal $WCH)"
echo "  → quédate 1s en SILENCIO y luego una PALMADA seca delante de la cámara…"
if ! ffmpeg -hide_banner -loglevel error \
  -thread_queue_size 1024 "${VIN[@]}" -i "$VIDEO" \
  -thread_queue_size 1024 -f alsa ${ACODEC:+-acodec "$ACODEC"} -channels "$CH" -i "$AUDIO" \
  -map 0:v -map 1:a -af "pan=mono|c0=c${WCH}" -t "$DUR" "$CLIP" 2> "$TMP/err"; then
  echo "✗ La captura falló: $(grep -v '^\s*$' "$TMP/err" | tail -2 | tr '\n' ' ')"
  exit 1
fi
ACH=0   # the clip is already mono (pan above)
fi

# ── Audio: el GOLPE más brusco (la palmada) ─────────────────────────────────
#  Not "the first sound after silence": in a live room there is no silence, and
#  that picked a voice or the band. A clap is the biggest sudden jump in level:
#  peak per 10 ms block, minus the loudest of the previous 100 ms. It must be
#  at least JUMP dB, or it was not a clap. Of those, the LOUDEST: when the
#  player is heard in the room the mic takes the clap again ~20 s later (the
#  CDN delay), quieter, with no clap on the video; the biggest jump could be
#  one of those echoes and gave nonsense (218 where the live needed 440). -copyts keeps each file's own times
#  (the live's segments do not start at 0, and A and V share that timeline).
JUMP="${JUMP:-15}"
ASTART=$(ffprobe -v error -show_entries format=start_time -of csv=p=0 "$AFILE" 2>/dev/null || echo 0)
TA=$(ffmpeg -hide_banner -nostats -copyts -i "$AFILE" \
       -af "pan=mono|c0=c${ACH},asetnsamples=n=480:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level" \
       -f null - 2>&1 \
     | awk '/pts_time:/{t=$0; sub(/.*pts_time:/,"",t); sub(/[^0-9.].*/,"",t)}
            /Peak_level=/{v=$0; sub(/.*=/,"",v); if (v ~ /inf/) v=-120; print t, v+0}' \
     | awk -v t0="$(awk -v a="${ASTART:-0}" -v k="$SKIP" 'BEGIN{print a+k}')" -v jump="$JUMP" '
            {t[NR]=$1; v[NR]=$2}
            END{ for (i=11; i<=NR; i++) { if (t[i] < t0) continue
                   m=-200; for (j=i-10; j<i; j++) if (v[j]>m) m=v[j]
                   if (v[i]-m >= jump && (bt == "" || v[i] > bv)) { bv=v[i]; bt=t[i] } }
                 if (bt != "") print bt }') || true

# Sin audio no hay ancla → no se puede medir (y el vídeo solo no basta).
if [ -z "${TA:-}" ]; then
  echo "────────────────────────────────────────────"
  echo "✗ No oí la palmada: ningún golpe de ${JUMP} dB sobre lo anterior. Más fuerte y"
  echo "  más seca, cerca del micro (o baja JUMP). Canal: $ACH. Clip: $AFILE"
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
TV=$(ffmpeg -hide_banner -nostats -copyts -i "$VFILE" -an \
       -vf "${CROP}select='gt(scene,0)',metadata=print" -f null - 2>&1 \
     | awk '/pts_time:/{t=$0; sub(/.*pts_time:/,"",t); sub(/[^0-9.].*/,"",t)}
            /scene_score=/{s=$0; sub(/.*scene_score=/,"",s); print t" "s}' \
     | awk -v ta="$TA" -v w="$WIN" -v pre="$PRE" -v vmin="$VMIN" '
            ($1>=ta-pre && $1<=ta+w && $2+0>best){best=$2+0; bt=$1}
            END{ if(best>=vmin) print bt }') || true

echo "────────────────────────────────────────────"
if [ -z "${TV:-}" ]; then
  echo "✗ No vi la palmada cerca de TA=${TA}s (sin movimiento > ${VMIN} en -${PRE}..+${WIN}s)."
  echo "  Palma dentro del cuadro y usa un ROI ceñido a las manos (📷 ROI en el"
  echo "  editor), o baja VMIN. Clip: $VFILE (no se borró)"
  trap - EXIT
  exit 1
fi

DELAY=$(awk -v tv="$TV" -v ta="$TA" 'BEGIN{printf "%.0f", (tv-ta)*1000}')
echo "  Audio (palmada)  Ta = ${TA}s"
echo "  Vídeo (palmada)  Tv = ${TV}s"
if [[ -n "${FROM_OUT:-}" ]]; then
  echo "  queda en el directo: ${DELAY} ms (con delay ${CUR_DELAY} ms)"
  DELAY=$(( CUR_DELAY + DELAY ))
fi
echo "────────────────────────────────────────────"
echo "  A/V delay = ${DELAY} ms"
if (( DELAY >= 0 )); then
  echo "  → mete ${DELAY} en 'A/V delay (ms)' del editor (retrasa el audio para"
  echo "    alinearlo con el vídeo, que llega más tarde)."
else
  echo "  → el vídeo llega ANTES que el audio (${DELAY} ms). El delay del editor"
  echo "    retrasa audio; aquí tendrías que retrasar el vídeo. Revisa la cadena."
fi
