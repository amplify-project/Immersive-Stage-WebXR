#!/usr/bin/env bash
# ============================================================================
#  stream.sh — Empaqueta / transmite por DASH el vídeo 360º + audio ambisónico
#  en UN ÚNICO manifest (vídeo + audio Ambisonics Opus 4ch), que es lo que
#  espera el player (carga el mismo .mpd en dos instancias de Shaka).
#
#  Basado en los ejemplos "Dual Encoding/Muxing" de cmd.md.
#
#  Uso:
#     ./stream.sh vod      # empaqueta una vez a VOD  → encoded/manifest.mpd
#     ./stream.sh live     # simula directo en bucle (low-latency, ventana móvil)
#
#  Variables de entorno (opcionales):
#     FORMAT=fuma     Convención del WAV ambisónico de entrada:
#                       fuma  → B-format clásico (WXYZ, W a −3 dB)  [POR DEFECTO,
#                               es el formato de media/ambisonic_bformat.wav]
#                       ambix → ya está en ACN/SN3D (no se toca)
#                     El decoder del player espera ACN/SN3D, así que con 'fuma'
#                     se reordena WXYZ→WYZX y se reescala W (×√2). Sin esto los
#                     músicos suenan girados (el frente se oye en los lados).
#     CODEC=vp9       Códec de vídeo:  vp9 (webm)  |  h264 (mp4)
#                       vp9  → mejor calidad; 4K nativo NO llega a tiempo real
#                              en CPU (usa SCALE para 'live').
#                       h264 → ultrafast, aguanta 4K nativo en directo (~2x).
#     SCALE=          Escala de vídeo, p.ej. "2560:1280" (recomendado con vp9+live)
#     VIDEO=media/video.mp4
#     AUDIO=media/ambisonic_bformat.wav
#     OUT=encoded
#     SEG=2           Duración de segmento (s)
#     VBITRATE=6000k  Bitrate de vídeo
#     ABITRATE=160k   Bitrate de audio
#
#  Después: arranca el server (node server.js) y en el player abre:
#     http://<host>:60000/encoded/manifest.mpd
# ============================================================================
set -euo pipefail

MODE="${1:-vod}"

VIDEO="${VIDEO:-media/video.mp4}"
AUDIO="${AUDIO:-media/ambisonic_bformat.wav}"
OUT="${OUT:-encoded}"
SEG="${SEG:-2}"
VBITRATE="${VBITRATE:-6000k}"
ABITRATE="${ABITRATE:-160k}"
SCALE="${SCALE:-}"
FORMAT="${FORMAT:-fuma}"
CODEC="${CODEC:-vp9}"

FPS=24                       # media/video.mp4 → 24 fps
GOP=$(( SEG * FPS ))         # keyframe en cada frontera de segmento (48)

# ── Comprobaciones ──────────────────────────────────────────────────────────
command -v ffmpeg >/dev/null || { echo "ffmpeg no encontrado"; exit 1; }
[[ -f "$VIDEO" ]] || { echo "No existe el vídeo: $VIDEO"; exit 1; }
[[ -f "$AUDIO" ]] || { echo "No existe el audio: $AUDIO"; exit 1; }

mkdir -p "$OUT"
rm -f "$OUT"/*.webm "$OUT"/*.mp4 "$OUT"/*.m4s "$OUT"/*.mpd 2>/dev/null || true

# ── Filtro de escala opcional (solo si SCALE está definido) ──────────────────
VF=()
[[ -n "$SCALE" ]] && VF=(-vf "scale=${SCALE}:flags=bicubic")

# ── Conversión ambisónica de canales (FuMa → ACN/SN3D) ──────────────────────
#  FuMa  [W,X,Y,Z] (W a −3 dB, maxN)  →  AmbiX [W,Y,Z,X] (SN3D, W=1)
#  out: c0=√2·W | c1=Y(=in c2) | c2=Z(=in c3) | c3=X(=in c1)
case "$FORMAT" in
  fuma)  AF=(-af "pan=4.0|c0=1.41421356*c0|c1=c2|c2=c3|c3=c1") ;;
  ambix) AF=() ;;
  *) echo "FORMAT desconocido: '$FORMAT' (usa 'fuma' o 'ambix')"; exit 1 ;;
esac

# ── Audio: Opus AMBISÓNICO (canales discretos) ──────────────────────────────
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
#  id=0,streams=0 → vídeo   |   id=1,streams=1 → audio
DASH_COMMON=(
  -f dash -dash_segment_type "$SEGTYPE" -seg_duration "$SEG"
  -use_template 1 -use_timeline 1
  -adaptation_sets "id=0,streams=0 id=1,streams=1"
  -init_seg_name "init_\$RepresentationID\$.${EXT}"
  -media_seg_name "chunk_\$RepresentationID\$_\$Number%05d\$.${EXT}"
)

echo "  códec vídeo : $CODEC ($SEGTYPE)   formato audio entrada: $FORMAT"
[[ -n "$SCALE" ]] && echo "  escala      : $SCALE"

case "$MODE" in
  # ──────────────────────────────────────────────────────────────────────────
  vod)
    echo "▶ VOD → $OUT/manifest.mpd"
    ffmpeg -y \
      -i "$VIDEO" -i "$AUDIO" \
      -map_metadata -1 -map_chapters -1 \
      -map 0:v:0 -map 1:a:0 \
      "${VF[@]}" "${VID_COMMON[@]}" "${VID_VOD[@]}" \
      "${AF[@]}" "${AUDIO_ENC[@]}" \
      "${DASH_COMMON[@]}" \
      "$OUT/manifest.mpd"
    echo "✓ Listo. Abre en el player:  http://<host>:60000/$OUT/manifest.mpd"
    ;;

  # ──────────────────────────────────────────────────────────────────────────
  live)
    echo "▶ LIVE (bucle) → $OUT/manifest.mpd   [Ctrl-C para parar]"
    if [[ "$CODEC" == "vp9" && -z "$SCALE" ]]; then
      echo "  ⚠ VP9 a 4K nativo NO llega a tiempo real en CPU (~0.95x) → cortes."
      echo "    Opciones:  SCALE=2560:1280 ./stream.sh live   (VP9 escalado, ~1.6x)"
      echo "           o:  CODEC=h264 ./stream.sh live         (4K nativo, ~2.3x)"
    fi
    # KEEP=1 → no borrar segmentos/manifest al parar (evita el 404 tras Ctrl-C).
    REMOVE=1; [[ "${KEEP:-0}" == "1" ]] && REMOVE=0
    ffmpeg -y \
      -stream_loop -1 -re -i "$VIDEO" \
      -stream_loop -1 -re -i "$AUDIO" \
      -map 0:v:0 -map 1:a:0 \
      "${VF[@]}" "${VID_COMMON[@]}" "${VID_LIVE[@]}" \
      "${AF[@]}" "${AUDIO_ENC[@]}" \
      "${DASH_COMMON[@]}" \
      -streaming 1 -ldash 1 \
      -window_size 5 -extra_window_size 5 -remove_at_exit "$REMOVE" \
      "$OUT/manifest.mpd"
    ;;

  *)
    echo "Modo desconocido: '$MODE'   (usa 'vod' o 'live')"; exit 1 ;;
esac
