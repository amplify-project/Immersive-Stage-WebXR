#!/usr/bin/env bash
# ============================================================================
#  stream.sh — Empaqueta / transmite por DASH el vídeo 360º + audio ambisónico
#  en UN ÚNICO manifest. El audio es UNA pista Opus multicanal:
#       4 canales FOA Ambisonics  [+ N stems mono por músico]
#  Un solo stream multicanal → sincronía a muestra (un decoder, un reloj), que
#  es lo que el player espera para el spotlight posicional por músico.
#
#  Uso:
#     ./stream.sh vod      # empaqueta una vez a VOD  → encoded/manifest.mpd
#     ./stream.sh live     # simula directo en bucle (low-latency, ventana móvil)
#
#  Variables de entorno (opcionales):
#     STEMS="a.mp3;b.mp3"  Lista de stems por músico separada por ';' (mono o
#                          estéreo; los estéreo se bajan a mono). Llegan en los
#                          canales 4..(4+N-1) del stream, en ESTE orden. El player
#                          los coloca con ?stems=az1,az2,… en el MISMO orden. Sin
#                          STEMS → solo los 4 canales FOA de siempre.
#     FORMAT=fuma     Convención del WAV ambisónico de entrada:
#                       fuma  → B-format clásico (WXYZ, W a −3 dB)  [POR DEFECTO]
#                       ambix → ya está en ACN/SN3D (no se toca)
#                     El decoder del player espera ACN/SN3D: con 'fuma' se
#                     reordena WXYZ→WYZX y se reescala W (×√2).
#     CODEC=vp9       Códec de vídeo:  vp9 (webm)  |  h264 (mp4)
#     SCALE=          Escala de vídeo, p.ej. "2560:1280" (recomendado vp9+live)
#     VIDEO=media/video.mp4
#     AUDIO=media/ambisonic_bformat.wav
#     OUT=encoded
#     SEG=2           Duración de segmento (s)
#     VBITRATE=6000k  Bitrate de vídeo
#     ABITRATE=       Bitrate de audio (por defecto 160k, o 160k+64k·Nstems)
#
#  Ejemplo con los 6 stems del proyecto (batería, guitarra, teclado, vientos):
#     STEMS="media/DR - stem - sync.mp3;media/GT - stem - sync.mp3;\
#media/KEY - stem - sync.mp3;media/SAX - stem - sync.mp3;\
#media/TBONE - stem - sync.mp3;media/TPT - stem - sync.mp3" \
#       ./stream.sh live
#
#  Después: arranca el server (node server.js) y en el player abre:
#     https://<host>:60000/index.html?src=<manifest>&stems=-50,-30,-10,10,30,50
# ============================================================================
set -euo pipefail

MODE="${1:-vod}"

VIDEO="${VIDEO:-media/video.mp4}"
AUDIO="${AUDIO:-media/ambisonic_bformat.wav}"
OUT="${OUT:-encoded}"
SEG="${SEG:-2}"
VBITRATE="${VBITRATE:-6000k}"
SCALE="${SCALE:-}"
FORMAT="${FORMAT:-fuma}"
CODEC="${CODEC:-vp9}"

# ── Captura LIVE (USB/UDP). Si CAPTURE=1, los inputs salen de dispositivos o de
#    red en vez de archivos. El X32 entrega TODO el audio por UN solo dispositivo
#    multicanal; el FOA va en 4 canales (FOA_CH) y cada stem en 1 canal (STEM_CH).
#      VIDEO_SRC=usb|udp   VIDEO_DEVICE=/dev/video0  VIDEO_INFORMAT=mjpeg
#      VIDEO_SIZE=3840x1920  VIDEO_FR=30  VIDEO_URL=udp://0.0.0.0:5001
#      AUDIO_SRC=usb|udp   AUDIO_DEVICE=hw:X32  AUDIO_CHANNELS=32
#      AUDIO_URL=udp://0.0.0.0:5002
#      FOA_CH="0,1,2,3"    canales del FOA dentro del device/stream (orden W,X,Y,Z)
#      FOA_AFORMAT=0|1     1 → matriz A→B del Rode NT-SF1 antes de FORMAT
#      STEM_CH="4,5,6,7"   canal de cada stem (mismo orden que la escena)
#
#  Publicación a S3 (opcional, vía upload-s3.sh):
#      S3_BUCKET=s3://bucket/prefijo   live → sube en background; vod → al final
#      S3_REGION=eu-west-1             región AWS (opcional)
#      S3_INTERVAL=1                   segundos entre pasadas de subida (live)
#
#  Códec recomendado para live 4K: CODEC=h264_nvenc (GPU NVIDIA, ~2.6× a 4K).
#  El audio Opus multicanal sale siempre en WebM (Quest ✓); el vídeo H.264 en MP4.
CAPTURE="${CAPTURE:-0}"
VIDEO_SRC="${VIDEO_SRC:-usb}"
VIDEO_DEVICE="${VIDEO_DEVICE:-/dev/video0}"
VIDEO_INFORMAT="${VIDEO_INFORMAT:-}"
VIDEO_SIZE="${VIDEO_SIZE:-}"
VIDEO_FR="${VIDEO_FR:-30}"
VIDEO_URL="${VIDEO_URL:-}"
AUDIO_SRC="${AUDIO_SRC:-usb}"
AUDIO_DEVICE="${AUDIO_DEVICE:-hw:0}"
AUDIO_CHANNELS="${AUDIO_CHANNELS:-32}"
AUDIO_URL="${AUDIO_URL:-}"
# Desfase A/V en la entrada (ms): el stitching de la Insta360 retrasa el vídeo,
# así que el audio llega adelantado. AUDIO_DELAY>0 retrasa el audio para alinear.
AUDIO_DELAY="${AUDIO_DELAY:-0}"
FOA_CH="${FOA_CH:-0,1,2,3}"
FOA_AFORMAT="${FOA_AFORMAT:-0}"
STEM_CH="${STEM_CH:-}"

# ── Stems: lista separada por ';' (los ficheros del proyecto llevan espacios) ─
#  Cada entrada se recorta de espacios sobrantes. Orden = orden de canales 4..N.
STEMS="${STEMS:-}"
STEM_ARR=()
if [[ -n "$STEMS" ]]; then
  IFS=';' read -r -a _raw <<< "$STEMS"
  for s in "${_raw[@]}"; do
    s="${s#"${s%%[![:space:]]*}"}"   # ltrim
    s="${s%"${s##*[![:space:]]}"}"   # rtrim
    [[ -n "$s" ]] && STEM_ARR+=("$s")
  done
fi
NSTEMS=${#STEM_ARR[@]}

# ── Canales (modo captura): FOA_CH y STEM_CH son listas de índices ','-separadas.
FOA_CH_ARR=(); STEM_CH_ARR=()
if [[ "$CAPTURE" == "1" ]]; then
  IFS=',' read -r -a FOA_CH_ARR <<< "$FOA_CH"
  [[ -n "$STEM_CH" ]] && IFS=',' read -r -a STEM_CH_ARR <<< "$STEM_CH"
  NSTEMS=${#STEM_CH_ARR[@]}
  (( ${#FOA_CH_ARR[@]} == 4 )) || { echo "FOA_CH debe tener 4 canales (tiene ${#FOA_CH_ARR[@]}): '$FOA_CH'"; exit 1; }
fi

# ── Close-ups (Caso B): vídeos "de cerca" por músico, empaquetados como pistas
#  de vídeo EXTRA en el MISMO manifest (un AdaptationSet por close-up). Misma
#  timeline que el 360 y el audio → al cambiar de pista en el player la sincronía
#  está garantizada. Lista ';'-separada, en el orden de los stems que lo tienen.
#     CLOSEUPS="media/sax_cu.mp4;media/tpt_cu.mp4"   (solo modo archivo, no captura)
#     CLOSEUP_SCALE=1280:720     escala de cada close-up (vacío = original)
#     CLOSEUP_VBITRATE=2500k     bitrate de vídeo de cada close-up
CLOSEUPS="${CLOSEUPS:-}"
CLOSEUP_SCALE="${CLOSEUP_SCALE:-1280:720}"
CLOSEUP_VBITRATE="${CLOSEUP_VBITRATE:-2500k}"
CLOSE_ARR=()
if [[ -n "$CLOSEUPS" ]]; then
  IFS=';' read -r -a _rawc <<< "$CLOSEUPS"
  for c in "${_rawc[@]}"; do
    c="${c#"${c%%[![:space:]]*}"}"   # ltrim
    c="${c%"${c##*[![:space:]]}"}"   # rtrim
    [[ -n "$c" ]] && CLOSE_ARR+=("$c")
  done
fi
NCLOSE=${#CLOSE_ARR[@]}
if [[ "$CAPTURE" == "1" && $NCLOSE -gt 0 ]]; then
  echo "  WARNING: close-ups (CLOSEUPS) aún no soportados en captura LIVE → ignorados."
  CLOSE_ARR=(); NCLOSE=0
fi

ABITRATE="${ABITRATE:-$(( 160 + 64 * NSTEMS ))k}"

FPS=24                       # media/video.mp4 → 24 fps (captura: VIDEO_FR)
[[ "$CAPTURE" == "1" ]] && FPS="$VIDEO_FR"
GOP=$(( SEG * FPS ))         # keyframe en cada frontera de segmento

# ── Comprobaciones ──────────────────────────────────────────────────────────
command -v ffmpeg >/dev/null || { echo "ffmpeg no encontrado"; exit 1; }
if [[ "$CAPTURE" != "1" ]]; then
  [[ -f "$VIDEO" ]] || { echo "No existe el vídeo: $VIDEO"; exit 1; }
  [[ -f "$AUDIO" ]] || { echo "No existe el audio: $AUDIO"; exit 1; }
  for s in "${STEM_ARR[@]}"; do
    [[ -f "$s" ]] || { echo "No existe el stem: $s"; exit 1; }
  done
  for c in "${CLOSE_ARR[@]}"; do
    [[ -f "$c" ]] || { echo "No existe el close-up: $c"; exit 1; }
  done
fi

mkdir -p "$OUT"
# Pizarra limpia en cada arranque: fuera segmentos, inits, manifest y .tmp de la
# pasada anterior, para que un pipeline nuevo nunca mezcle restos.
rm -f "$OUT"/*.webm "$OUT"/*.mp4 "$OUT"/*.m4s "$OUT"/*.mpd "$OUT"/*.tmp 2>/dev/null || true

# ── Cadena de filtros de vídeo: escala opcional + 8-bit/420 para NVENC ───────
#  NVENC H.264 necesita entrada 8-bit 4:2:0; un origen 10-bit/HEVC falla sin esto.
#  En captura USB el feed ya es 8-bit, pero lo forzamos por robustez.
VF_CHAIN=""
[[ -n "$SCALE" ]] && VF_CHAIN="scale=${SCALE}:flags=bicubic"
[[ "$CODEC" == "h264_nvenc" ]] && VF_CHAIN="${VF_CHAIN:+$VF_CHAIN,}format=yuv420p"
VF=()
[[ -n "$VF_CHAIN" ]] && VF=(-vf "$VF_CHAIN")

# Filtro de los close-ups (escala propia, normalmente menor que el 360).
CLOSEUP_VF_CHAIN=""
[[ -n "$CLOSEUP_SCALE" ]] && CLOSEUP_VF_CHAIN="scale=${CLOSEUP_SCALE}:flags=bicubic"
[[ "$CODEC" == "h264_nvenc" ]] && CLOSEUP_VF_CHAIN="${CLOSEUP_VF_CHAIN:+$CLOSEUP_VF_CHAIN,}format=yuv420p"

# ── Conversión FuMa→ACN/SN3D del lecho FOA (4 canales) ──────────────────────
#  FuMa [W,X,Y,Z] (W a −3 dB) → AmbiX [√2·W, Y, Z, X] (SN3D).
case "$FORMAT" in
  fuma)  FOA_FILTER="pan=4.0|c0=1.41421356*c0|c1=c2|c2=c3|c3=c1" ;;
  ambix) FOA_FILTER="anull" ;;
  *) echo "FORMAT desconocido: '$FORMAT' (usa 'fuma' o 'ambix')"; exit 1 ;;
esac

# ── Rode NT-SF1 A→B matrix (4-capsule A-format → FuMa WXYZ B-format) ─────────
#  Capsules (default order):  c0=FLU  c1=FRD  c2=BLD  c3=BRU
#    W = FLU+FRD+BLD+BRU   X = FLU+FRD−BLD−BRU
#    Y = FLU−FRD+BLD−BRU   Z = FLU−FRD−BLD+BRU      (×0.5 to avoid clipping)
#  Output is FuMa → then goes through the fuma→AmbiX conversion above.
#  WARNING: coefficients depend on the actual capsule orientation. If the
#  soundfield sounds rotated/flipped, reorder c0..c3 or flip the signs here.
A2B_FILTER="pan=4.0|c0=0.5*c0+0.5*c1+0.5*c2+0.5*c3|c1=0.5*c0+0.5*c1-0.5*c2-0.5*c3|c2=0.5*c0-0.5*c1+0.5*c2-0.5*c3|c3=0.5*c0-0.5*c1-0.5*c2+0.5*c3"

# ── Audio: Opus AMBISÓNICO/multicanal (canales discretos) ───────────────────
#  mapping_family 255 → sin coupling estéreo; -ar 48000 porque Opus es 48 kHz.
AUDIO_ENC=(-c:a libopus -mapping_family 255 -b:a "$ABITRATE" -ar 48000)

# ── Vídeo según códec. El contenedor se decide por stream (dash_segment_type
#    auto): VP9→webm/webm; H.264→mp4(vídeo)+webm(audio Opus). Esto último es lo
#    que la Quest necesita (reproduce H.264 y Opus multicanal en WebM, pero NO
#    Opus en MP4 ni HEVC).
case "$CODEC" in
  vp9)
    SEGTYPE="webm"
    VID_COMMON=(-c:v libvpx-vp9 -pix_fmt yuv420p
                -row-mt 1 -tile-columns 2 -frame-parallel 1
                -g "$GOP" -keyint_min "$GOP")
    VID_VOD=(-deadline good -cpu-used 2)
    VID_LIVE=(-deadline realtime -cpu-used 8)
    ;;
  h264)
    SEGTYPE="mp4(v)+webm(a)"
    VID_COMMON=(-c:v libx264 -pix_fmt yuv420p
                -g "$GOP" -keyint_min "$GOP")
    VID_VOD=(-preset veryfast)
    VID_LIVE=(-preset ultrafast -tune zerolatency)
    ;;
  h264_nvenc)
    # Encode H.264 por GPU NVIDIA (NVENC). ~2.6× tiempo real a 4K, indep. del
    # contenido. pix_fmt forzado en VF (format=yuv420p). Live: low-latency CBR.
    SEGTYPE="mp4(v)+webm(a) · NVENC"
    VID_COMMON=(-c:v h264_nvenc -g "$GOP" -keyint_min "$GOP")
    VID_VOD=(-preset p5 -tune hq -rc vbr -cq 21)
    VID_LIVE=(-preset p4 -tune ll -rc cbr -delay 0)
    ;;
  *) echo "CODEC desconocido: '$CODEC' (usa 'vp9', 'h264' o 'h264_nvenc')"; exit 1 ;;
esac

# ── ID de run: nombres de segmento ÚNICOS por arranque ──────────────────────
#  Los segmentos se sirven como inmutables (cache larga en el CDN). Si cada run
#  reusara los mismos nombres (chunk_0_00001…), tras reiniciar el live CloudFront
#  seguiría sirviendo el segmento VIEJO cacheado (contenido de hace rato). Con un
#  RUN_ID por arranque los nombres nunca colisionan → el CDN nunca sirve restos.
RUN_ID="${RUN_ID:-$(date +%y%m%d%H%M%S)}"

# ── Empaquetado DASH (común): un manifest, 2 adaptation sets ────────────────
#  dash_segment_type=auto → cada stream en su contenedor; $ext$ resuelve la
#  extensión por representación (init_<run>_0.m4s vídeo / init_<run>_1.webm audio).
DASH_COMMON=(
  -f dash -dash_segment_type auto -seg_duration "$SEG"
  -use_template 1 -use_timeline 1
  -init_seg_name "init_${RUN_ID}_\$RepresentationID\$.\$ext\$"
  -media_seg_name "chunk_${RUN_ID}_\$RepresentationID\$_\$Number%05d\$.\$ext\$"
)

# ── AdaptationSets dinámicos ────────────────────────────────────────────────
#  Orden de streams de salida (= orden de -map):  0 = vídeo 360,
#  1..NCLOSE = close-ups (cada uno en su AdaptationSet, son contenidos distintos),
#  NCLOSE+1 = audio Opus multicanal. Sin close-ups → "id=0,streams=0 id=1,streams=1"
#  (idéntico al de siempre). En el player, RepresentationID 0 = 360 y 1..N = close-ups.
AS_STR="id=0,streams=0"
_asid=1
for ((i=0; i<NCLOSE; i++)); do AS_STR+=" id=${_asid},streams=$((i+1))"; ((_asid++)); done
AS_STR+=" id=${_asid},streams=$((NCLOSE+1))"

# Mapas de los close-ups: input (2+NSTEMS+i) en modo archivo (tras vídeo, FOA y stems).
CLOSE_MAPS=()
for ((i=0; i<NCLOSE; i++)); do CLOSE_MAPS+=(-map "$((2 + NSTEMS + i)):v:0"); done

# Ensambla los args de codificación de vídeo en VENC, según haya close-ups o no.
#  $1 = nombre de un array con las opciones específicas del modo (VID_VOD/VID_LIVE).
assemble_venc() {
  local -n _mode="$1"
  VENC=("${VID_COMMON[@]}")
  if (( NCLOSE == 0 )); then
    VENC+=("${VF[@]}" -b:v "$VBITRATE")
  else
    # Filtros y bitrate POR stream (el genérico -vf afectaría a todos los vídeos).
    [[ -n "$VF_CHAIN" ]] && VENC+=(-filter:v:0 "$VF_CHAIN")
    VENC+=(-b:v:0 "$VBITRATE")
    for ((i=0; i<NCLOSE; i++)); do
      [[ -n "$CLOSEUP_VF_CHAIN" ]] && VENC+=(-filter:v:$((i+1)) "$CLOSEUP_VF_CHAIN")
      VENC+=(-b:v:$((i+1)) "$CLOSEUP_VBITRATE")
    done
  fi
  VENC+=("${_mode[@]}")
}

# ── Construcción de inputs y filtro de audio según haya stems o no ──────────
#  Input 0 = vídeo, input 1 = FOA, inputs 2..(1+N) = stems.
#  Con stems usamos -filter_complex: convertir FOA, bajar cada stem a mono y
#  amerge → 4+N canales discretos. Sin stems, -af sobre el FOA (camino de 4ch).
build_inputs() {   # $1 = "live" | "vod"  → rellena IN_ARGS y A_ARGS globales
  local mode="$1"
  IN_ARGS=()
  local loop=()
  [[ "$mode" == "live" ]] && loop=(-stream_loop -1 -re)

  IN_ARGS+=("${loop[@]}" -i "$VIDEO")
  IN_ARGS+=("${loop[@]}" -i "$AUDIO")
  for s in "${STEM_ARR[@]}"; do
    IN_ARGS+=("${loop[@]}" -i "$s")
  done
  # Close-ups: inputs extra tras los stems (índices 2+NSTEMS..1+NSTEMS+NCLOSE).
  for c in "${CLOSE_ARR[@]}"; do
    IN_ARGS+=("${loop[@]}" -i "$c")
  done

  if (( NSTEMS == 0 )); then
    # Camino clásico de 4 canales FOA.
    A_FILTER=(-af "$FOA_FILTER")
    MAP_AUDIO=(-map 1:a:0)
  else
    # filter_complex: [foa] + [s0..sN-1] → amerge (4+N canales).
    local fc="[1:a]${FOA_FILTER}[foa];"
    local merge_in="[foa]"
    local k=2
    for ((i=0; i<NSTEMS; i++)); do
      fc+="[${k}:a]pan=mono|c0=0.5*c0+0.5*c1[s${i}];"
      merge_in+="[s${i}]"
      ((k++))
    done
    fc+="${merge_in}amerge=inputs=$((NSTEMS+1))[aout]"
    A_FILTER=(-filter_complex "$fc")
    MAP_AUDIO=(-map "[aout]")
  fi
}

# ── Inputs en modo CAPTURA (USB/UDP) ────────────────────────────────────────
#  Input 0 = vídeo (v4l2 o UDP).  Input 1 = audio multicanal (el X32 por ALSA,
#  o UDP con todo el audio junto). El FOA y los stems se EXTRAEN por índice de
#  canal del input 1, no son inputs separados.
build_inputs_capture() {
  IN_ARGS=()
  local q=(-thread_queue_size 1024)

  # — Vídeo — (-use_wallclock_as_timestamps: misma referencia temporal que el
  #   monitor de sync, para que el AUDIO_DELAY ajustado allí transfiera al directo)
  case "$VIDEO_SRC" in
    usb)
      IN_ARGS+=("${q[@]}" -f v4l2 -framerate "$VIDEO_FR")
      [[ -n "$VIDEO_INFORMAT" ]] && IN_ARGS+=(-input_format "$VIDEO_INFORMAT")
      [[ -n "$VIDEO_SIZE" ]]     && IN_ARGS+=(-video_size "$VIDEO_SIZE")
      IN_ARGS+=(-use_wallclock_as_timestamps 1 -i "$VIDEO_DEVICE") ;;
    udp)
      [[ -n "$VIDEO_URL" ]] || { echo "VIDEO_SRC=udp pero VIDEO_URL vacío"; exit 1; }
      IN_ARGS+=("${q[@]}" -fflags nobuffer -use_wallclock_as_timestamps 1 -i "$VIDEO_URL") ;;
    *) echo "VIDEO_SRC desconocido: '$VIDEO_SRC' (usa 'usb' o 'udp')"; exit 1 ;;
  esac

  # — Audio multicanal (un solo input) —
  # Delay A/V: -itsoffset (en segundos) antes del -i desplaza los timestamps del
  # input de audio. Positivo = audio más tarde (compensa el vídeo retrasado por el
  # stitching). Se aplica al input crudo, antes de extraer FOA/stems.
  local off=()
  if [[ "$AUDIO_DELAY" != "0" && -n "$AUDIO_DELAY" ]]; then
    local osec; osec=$(awk "BEGIN{printf \"%.3f\", $AUDIO_DELAY/1000}")
    off=(-itsoffset "$osec")
  fi
  case "$AUDIO_SRC" in
    usb) IN_ARGS+=("${q[@]}" -f alsa -channels "$AUDIO_CHANNELS" -use_wallclock_as_timestamps 1 "${off[@]}" -i "$AUDIO_DEVICE") ;;
    udp)
      [[ -n "$AUDIO_URL" ]] || { echo "AUDIO_SRC=udp pero AUDIO_URL vacío"; exit 1; }
      IN_ARGS+=("${q[@]}" -fflags nobuffer -use_wallclock_as_timestamps 1 "${off[@]}" -i "$AUDIO_URL") ;;
    *) echo "AUDIO_SRC desconocido: '$AUDIO_SRC' (usa 'usb' o 'udp')"; exit 1 ;;
  esac

  # — Extracción FOA por índice + conversión (A→B opcional, luego FuMa/AmbiX) —
  local f0="${FOA_CH_ARR[0]}" f1="${FOA_CH_ARR[1]}" f2="${FOA_CH_ARR[2]}" f3="${FOA_CH_ARR[3]}"
  local fc="[1:a]pan=4.0|c0=c${f0}|c1=c${f1}|c2=c${f2}|c3=c${f3}[foasel];"
  if [[ "$FOA_AFORMAT" == "1" ]]; then
    # A-format del NT-SF1 → B-format FuMa → AmbiX.
    fc+="[foasel]${A2B_FILTER}[foab];[foab]pan=4.0|c0=1.41421356*c0|c1=c2|c2=c3|c3=c1[foa];"
  else
    fc+="[foasel]${FOA_FILTER}[foa];"
  fi

  # — Cada stem = 1 canal del input 1, por índice —
  local merge_in="[foa]"
  for ((i=0; i<NSTEMS; i++)); do
    fc+="[1:a]pan=mono|c0=c${STEM_CH_ARR[i]}[s${i}];"
    merge_in+="[s${i}]"
  done

  if (( NSTEMS == 0 )); then
    A_FILTER=(-filter_complex "${fc%;}")
    MAP_AUDIO=(-map "[foa]")
  else
    fc+="${merge_in}amerge=inputs=$((NSTEMS+1))[aout]"
    A_FILTER=(-filter_complex "$fc")
    MAP_AUDIO=(-map "[aout]")
  fi
}

echo "  códec vídeo : $CODEC ($SEGTYPE)   FOA: $FORMAT   stems: $NSTEMS   audio: $ABITRATE"
[[ -n "$SCALE" ]] && echo "  escala      : $SCALE"
if (( NCLOSE > 0 )); then
  echo "  close-ups   : $NCLOSE pista(s) de vídeo extra (RepresentationID 1..$NCLOSE)  escala: ${CLOSEUP_SCALE:-original}  bitrate: $CLOSEUP_VBITRATE"
  for c in "${CLOSE_ARR[@]}"; do echo "    · $c"; done
fi
if [[ "$CAPTURE" == "1" ]]; then
  echo "  captura     : vídeo[$VIDEO_SRC]=${VIDEO_SRC/usb/$VIDEO_DEVICE}${VIDEO_URL:+ $VIDEO_URL}   audio[$AUDIO_SRC]=${AUDIO_SRC/usb/$AUDIO_DEVICE}${AUDIO_URL:+ $AUDIO_URL}"
  echo "  FOA canales : ${FOA_CH}${FOA_AFORMAT:+  (A-format NT-SF1→B: ${FOA_AFORMAT})}"
  [[ "$AUDIO_DELAY" != "0" && -n "$AUDIO_DELAY" ]] && echo "  delay audio : ${AUDIO_DELAY} ms (itsoffset, +=audio más tarde)"
  (( NSTEMS > 0 )) && { echo "  patch stems (canal del device → orden de salida 4..$((3+NSTEMS))):"; for ((i=0;i<NSTEMS;i++)); do echo "    · ch ${STEM_CH_ARR[i]} → stem $i"; done; }
elif (( NSTEMS > 0 )); then
  echo "  orden stems (canales 4..$((3+NSTEMS))):"; for s in "${STEM_ARR[@]}"; do echo "    · $s"; done
fi

case "$MODE" in
  # ──────────────────────────────────────────────────────────────────────────
  vod)
    echo "▶ VOD → $OUT/manifest.mpd"
    build_inputs vod
    assemble_venc VID_VOD
    ffmpeg -y \
      "${IN_ARGS[@]}" \
      -map_metadata -1 -map_chapters -1 \
      -map 0:v:0 "${CLOSE_MAPS[@]}" "${MAP_AUDIO[@]}" \
      "${VENC[@]}" \
      "${A_FILTER[@]}" "${AUDIO_ENC[@]}" \
      "${DASH_COMMON[@]}" -adaptation_sets "$AS_STR" \
      "$OUT/manifest.mpd"
    echo "✓ Listo. Canales de audio:"
    grep -o 'AudioChannelConfiguration[^/]*' "$OUT/manifest.mpd" || true
    if [[ -n "${S3_BUCKET:-}" ]]; then
      OUT="$OUT" S3_BUCKET="$S3_BUCKET" REGION="${S3_REGION:-}" ONESHOT=1 bash upload-s3.sh
    fi
    ;;

  # ──────────────────────────────────────────────────────────────────────────
  live)
    if [[ "$CAPTURE" == "1" ]]; then
      echo "▶ LIVE CAPTURE (USB/UDP) → $OUT/manifest.mpd   [Ctrl-C to stop]"
    else
      echo "▶ LIVE (file loop) → $OUT/manifest.mpd   [Ctrl-C to stop]"
    fi
    if [[ "$CODEC" == "vp9" && -z "$SCALE" ]]; then
      echo "  WARNING: VP9 at native 4K does NOT keep real time on CPU (~0.95x) → stalls."
      echo "    Options:  SCALE=2560:1280 ./stream.sh live   (scaled VP9, ~1.6x)"
      echo "          or: CODEC=h264 ./stream.sh live         (native 4K, ~2.3x)"
    fi
    if [[ "$CAPTURE" == "1" && "$FOA_AFORMAT" == "1" ]]; then
      echo "  WARNING: NT-SF1 A→B uses the standard capsule order (FLU,FRD,BLD,BRU)."
      echo "    If the soundfield sounds rotated/flipped, reorder FOA_CH or flip signs in A2B_FILTER."
    fi
    REMOVE=1; [[ "${KEEP:-0}" == "1" ]] && REMOVE=0
    # ── Publicación a S3 en paralelo (si S3_BUCKET está definido) ────────────
    UPLOADER_PID=""
    if [[ -n "${S3_BUCKET:-}" ]]; then
      echo "  publishing → $S3_BUCKET   (upload-s3.sh en background)"
      OUT="$OUT" S3_BUCKET="$S3_BUCKET" REGION="${S3_REGION:-}" INTERVAL="${S3_INTERVAL:-1}" \
        bash upload-s3.sh &
      UPLOADER_PID=$!
      trap '[[ -n "$UPLOADER_PID" ]] && kill "$UPLOADER_PID" 2>/dev/null || true' EXIT INT TERM
    fi
    if [[ "$CAPTURE" == "1" ]]; then build_inputs_capture; else build_inputs live; fi
    assemble_venc VID_LIVE
    # ── Perfil DASH live según destino ──────────────────────────────────────
    #  Directo (sin S3): baja latencia CMAF (-streaming/-ldash) → muy fluido.
    #  Por CDN (S3): los chunks parciales + consistencia eventual rompen el
    #  player → usamos segmentado robusto (segmentos completos) y ventana más
    #  amplia para que las lecturas tardías del CDN sigan encontrando el segmento.
    #  Forzar con LOWLATENCY=1|0.
    if [[ -n "${S3_BUCKET:-}" ]]; then LOWLATENCY="${LOWLATENCY:-0}"; else LOWLATENCY="${LOWLATENCY:-1}"; fi
    LIVE_LL=(); WIN=(-window_size 5 -extra_window_size 5)
    if [[ "$LOWLATENCY" == "1" ]]; then
      LIVE_LL=(-streaming 1 -ldash 1)
    else
      WIN=(-window_size 6 -extra_window_size 12)   # CDN: más colchón de segmentos
    fi
    ffmpeg -y \
      "${IN_ARGS[@]}" \
      -map 0:v:0 "${CLOSE_MAPS[@]}" "${MAP_AUDIO[@]}" \
      "${VENC[@]}" \
      "${A_FILTER[@]}" "${AUDIO_ENC[@]}" \
      "${DASH_COMMON[@]}" -adaptation_sets "$AS_STR" \
      "${LIVE_LL[@]}" \
      "${WIN[@]}" -remove_at_exit "$REMOVE" \
      "$OUT/manifest.mpd"
    ;;

  *)
    echo "Modo desconocido: '$MODE'   (usa 'vod' o 'live')"; exit 1 ;;
esac
