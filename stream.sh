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

ABITRATE="${ABITRATE:-$(( 160 + 64 * NSTEMS ))k}"

FPS=24                       # media/video.mp4 → 24 fps
GOP=$(( SEG * FPS ))         # keyframe en cada frontera de segmento (48)

# ── Comprobaciones ──────────────────────────────────────────────────────────
command -v ffmpeg >/dev/null || { echo "ffmpeg no encontrado"; exit 1; }
[[ -f "$VIDEO" ]] || { echo "No existe el vídeo: $VIDEO"; exit 1; }
[[ -f "$AUDIO" ]] || { echo "No existe el audio: $AUDIO"; exit 1; }
for s in "${STEM_ARR[@]}"; do
  [[ -f "$s" ]] || { echo "No existe el stem: $s"; exit 1; }
done

mkdir -p "$OUT"
rm -f "$OUT"/*.webm "$OUT"/*.mp4 "$OUT"/*.m4s "$OUT"/*.mpd 2>/dev/null || true

# ── Filtro de escala opcional (solo si SCALE está definido) ──────────────────
VF=()
[[ -n "$SCALE" ]] && VF=(-vf "scale=${SCALE}:flags=bicubic")

# ── Conversión FuMa→ACN/SN3D del lecho FOA (4 canales) ──────────────────────
#  FuMa [W,X,Y,Z] (W a −3 dB) → AmbiX [√2·W, Y, Z, X] (SN3D).
case "$FORMAT" in
  fuma)  FOA_FILTER="pan=4.0|c0=1.41421356*c0|c1=c2|c2=c3|c3=c1" ;;
  ambix) FOA_FILTER="anull" ;;
  *) echo "FORMAT desconocido: '$FORMAT' (usa 'fuma' o 'ambix')"; exit 1 ;;
esac

# ── Audio: Opus AMBISÓNICO/multicanal (canales discretos) ───────────────────
#  mapping_family 255 → sin coupling estéreo; -ar 48000 porque Opus es 48 kHz.
AUDIO_ENC=(-c:a libopus -mapping_family 255 -b:a "$ABITRATE" -ar 48000)

# ── Vídeo + tipo de segmento según códec ────────────────────────────────────
case "$CODEC" in
  vp9)
    SEGTYPE=webm; EXT=webm
    VID_COMMON=(-c:v libvpx-vp9 -pix_fmt yuv420p -b:v "$VBITRATE"
                -row-mt 1 -tile-columns 2 -frame-parallel 1
                -g "$GOP" -keyint_min "$GOP")
    VID_VOD=(-deadline good -cpu-used 2)
    VID_LIVE=(-deadline realtime -cpu-used 8)
    ;;
  h264)
    SEGTYPE=mp4; EXT=m4s
    VID_COMMON=(-c:v libx264 -pix_fmt yuv420p -b:v "$VBITRATE"
                -g "$GOP" -keyint_min "$GOP")
    VID_VOD=(-preset veryfast)
    VID_LIVE=(-preset ultrafast -tune zerolatency)
    ;;
  *) echo "CODEC desconocido: '$CODEC' (usa 'vp9' o 'h264')"; exit 1 ;;
esac

# ── Empaquetado DASH (común): un manifest, 2 adaptation sets ────────────────
DASH_COMMON=(
  -f dash -dash_segment_type "$SEGTYPE" -seg_duration "$SEG"
  -use_template 1 -use_timeline 1
  -adaptation_sets "id=0,streams=0 id=1,streams=1"
  -init_seg_name "init_\$RepresentationID\$.${EXT}"
  -media_seg_name "chunk_\$RepresentationID\$_\$Number%05d\$.${EXT}"
)

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

  if (( NSTEMS == 0 )); then
    # Camino clásico de 4 canales FOA.
    A_ARGS=(-map 0:v:0 -map 1:a:0 -af "$FOA_FILTER" "${AUDIO_ENC[@]}")
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
    A_ARGS=(-filter_complex "$fc" -map 0:v:0 -map "[aout]" "${AUDIO_ENC[@]}")
  fi
}

echo "  códec vídeo : $CODEC ($SEGTYPE)   FOA: $FORMAT   stems: $NSTEMS   audio: $ABITRATE"
[[ -n "$SCALE" ]] && echo "  escala      : $SCALE"
(( NSTEMS > 0 )) && { echo "  orden stems (canales 4..$((3+NSTEMS))):"; for s in "${STEM_ARR[@]}"; do echo "    · $s"; done; }

case "$MODE" in
  # ──────────────────────────────────────────────────────────────────────────
  vod)
    echo "▶ VOD → $OUT/manifest.mpd"
    build_inputs vod
    ffmpeg -y \
      "${IN_ARGS[@]}" \
      -map_metadata -1 -map_chapters -1 \
      "${VF[@]}" "${VID_COMMON[@]}" "${VID_VOD[@]}" \
      "${A_ARGS[@]}" \
      "${DASH_COMMON[@]}" \
      "$OUT/manifest.mpd"
    echo "✓ Listo. Canales de audio:"
    grep -o 'AudioChannelConfiguration[^/]*' "$OUT/manifest.mpd" || true
    ;;

  # ──────────────────────────────────────────────────────────────────────────
  live)
    echo "▶ LIVE (bucle) → $OUT/manifest.mpd   [Ctrl-C para parar]"
    if [[ "$CODEC" == "vp9" && -z "$SCALE" ]]; then
      echo "  ⚠ VP9 a 4K nativo NO llega a tiempo real en CPU (~0.95x) → cortes."
      echo "    Opciones:  SCALE=2560:1280 ./stream.sh live   (VP9 escalado, ~1.6x)"
      echo "           o:  CODEC=h264 ./stream.sh live         (4K nativo, ~2.3x)"
    fi
    REMOVE=1; [[ "${KEEP:-0}" == "1" ]] && REMOVE=0
    build_inputs live
    ffmpeg -y \
      "${IN_ARGS[@]}" \
      "${VF[@]}" "${VID_COMMON[@]}" "${VID_LIVE[@]}" \
      "${A_ARGS[@]}" \
      "${DASH_COMMON[@]}" \
      -streaming 1 -ldash 1 \
      -window_size 5 -extra_window_size 5 -remove_at_exit "$REMOVE" \
      "$OUT/manifest.mpd"
    ;;

  *)
    echo "Modo desconocido: '$MODE'   (usa 'vod' o 'live')"; exit 1 ;;
esac
