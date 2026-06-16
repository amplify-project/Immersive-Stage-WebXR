#!/usr/bin/env bash
# ============================================================================
#  monitor_sync.sh — Monitor A/V FIEL y de baja latencia (<300ms) para AJUSTAR
#  el delay audio/vídeo del directo. Reproduce /dev/video10 + audio con ffplay,
#  muxados (mjpeg + pcm: sin GOP ni encode → sin sesgo de latencia vídeo↔audio,
#  a diferencia del preview MSE del navegador).
#
#  Uso:  ./monitor_sync.sh [delay_ms] [audio_dev] [video_dev]
#        ./monitor_sync.sh 0            # mide el desfase crudo (palmada/golpe)
#        ./monitor_sync.sh 120          # verifica con 120 ms de delay aplicado
#        CH=8 ./monitor_sync.sh 0 hw:1,0
#
#  Mira un transitorio (palmada, golpe de caja): ves el frame y oyes el sonido;
#  ese hueco es el desfase real. Mételo como "A/V delay (ms)" en el editor.
# ============================================================================
set -euo pipefail

DELAY_MS="${1:-0}"
AUDIO="${2:-hw:1,0}"
VIDEO="${3:-/dev/video10}"
CH="${CH:-32}"            # canales que abre el dispositivo de audio (X32 = 32)
WCH="${WCH:-0}"           # canal a monitorizar (por defecto el W del FOA = omni).
                          # OJO: -ac 2 no sabe bajar 32 canales discretos → silencio;
                          # por eso seleccionamos un canal concreto con pan.

# Delay audio→vídeo: NO con -itsoffset en el input. itsoffset obliga a ffmpeg a
# bufferizar ~DELAY_MS de vídeo para intercalar el audio retrasado; con captura
# en vivo + nobuffer deja de drenar la ALSA → desborda su ring buffer →
# "snd_pcm_recover underrun" → broken pipe (con 800ms casca, con 80ms aún cuela).
# En su lugar retrasamos el audio con el filtro adelay (silencio al principio):
# ambos streams siguen en PTS 0, el muxer no acumula skew y ALSA se vacía normal.
AF="pan=stereo|c0=c${WCH}|c1=c${WCH}"
if [ "$DELAY_MS" -gt 0 ] 2>/dev/null; then
  AF="${AF},adelay=${DELAY_MS}|${DELAY_MS}"
fi

# Mata un monitor anterior: v4l2loopback no admite dos lectores de /dev/video10,
# así que un monitor previo dejaría el device "busy". El ffmpeg del monitor es
# único por "-f nut -"; al matarlo, su ffplay se cierra solo (EOF).
pkill -f -- '-f nut -' 2>/dev/null || true
pkill -x ffplay 2>/dev/null || true
sleep 0.4

echo "Monitor sync → video=$VIDEO  audio=$AUDIO (${CH}ch→estéreo)  delay=${DELAY_MS}ms   [Ctrl-C para salir]"

# thread_queue_size grande en AMBOS inputs + max_muxing_queue_size: para aplicar
# un delay hay que sostener ~DELAY_MS de un stream en el muxer; con colas pequeñas
# ffmpeg deja de leer la ALSA y su ring se desborda (xrun). Con delay grande la
# baja latencia es imposible igualmente, así que aquí prima no romper el stream.
ffmpeg -hide_banner -loglevel warning -fflags nobuffer -flags low_delay \
  -thread_queue_size 4096 -f v4l2 -framerate 24 -use_wallclock_as_timestamps 1 -i "$VIDEO" \
  -thread_queue_size 4096 -f alsa -channels "$CH" -use_wallclock_as_timestamps 1 -i "$AUDIO" \
  -map 0:v -map 1:a -af "$AF" \
  -vf scale=960:-2 -c:v mjpeg -q:v 7 -c:a pcm_s16le -max_muxing_queue_size 4096 -f nut - \
| ffplay -hide_banner -loglevel warning -framedrop -autoexit -i -
