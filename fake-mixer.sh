#!/usr/bin/env bash
# fake-mixer.sh — pretend to be the mixer, from the scene's files.
#
# On the live machine the ambisonic mic and every musician arrive as channels of
# ONE multichannel ALSA device (the desk over USB), and the editor's Live mode
# says which channel is which: FOA ch for the mic, a "ch" box per stem. Here we
# have files instead. This script mixes them into the same shape and plays it,
# in a loop, into an ALSA loopback card. stream.sh then captures that card
# exactly as it would capture the desk, so the whole live path (channel patch,
# encode, player with stems) runs without the hardware.
#
#   channel 0..3   the scene's bed (FOA, untouched: FuMa stays FuMa)
#   channel 4+i    scene.stems[i], downmixed to mono
#
# One-time setup (needs root, lasts until reboot):
#   sudo modprobe snd-aloop
#
# Then:
#   ./fake-mixer.sh              ← leave it running; Ctrl-C to stop
#
# and in the editor, Live mode → Audio: USB (ALSA), the "Loopback" device whose
# hw:N,1 the script prints (device 1 is the capture side), Total ch. = 4 + stems,
# FOA ch 0,1,2,3, and stem i on channel 4+i. The video stays whatever camera
# the editor has: the picture will not match the music, that is expected.
#
# The mix is rendered once to a cache WAV and only rebuilt when the scene or a
# file changes, so every channel loops on the same sample and never drifts.
#
#   SCENE=scene.json   DEVICE=hw:Loopback,0,0 (playback side)
#   CACHE=~/.cache/amplify-fake-mixer.wav
set -euo pipefail
cd "$(dirname "$0")"

SCENE="${SCENE:-scene.json}"
DEVICE="${DEVICE:-hw:Loopback,0,0}"
CACHE="${CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/amplify-fake-mixer.wav}"
RATE=48000          # what stream.sh opens ALSA at (ffmpeg's default)

[[ -f "$SCENE" ]] || { echo "No scene: $SCENE"; exit 1; }
# As root it cannot reach the user's PulseAudio (which holds the loopback card)
# and the cache lands in /root. Only the modprobe needs sudo.
(( EUID != 0 )) || { echo "Run it as your normal user, not with sudo (only 'sudo modprobe snd-aloop' needs root)."; exit 1; }

# — Bed and stems, in the scene's order (that order IS the channel order) —
BED=$(node -e 'console.log(require(require("path").resolve(process.argv[1])).bed || "")' "$SCENE")
mapfile -t STEMS < <(node -e '
  for (const s of require(require("path").resolve(process.argv[1])).stems || []) console.log(s.file || "")' "$SCENE")
[[ -n "$BED" && -f "$BED" ]] || { echo "The scene has no bed (or it is missing): '$BED'"; exit 1; }
for s in "${STEMS[@]}"; do [[ -f "$s" ]] || { echo "Missing stem file: '$s'"; exit 1; }; done
NST=${#STEMS[@]}
NCH=$((4 + NST))

# — Render the cache if it is missing or older than any input —
stale=0
[[ -f "$CACHE" && ! "$SCENE" -nt "$CACHE" && ! "$BED" -nt "$CACHE" ]] || stale=1
for s in "${STEMS[@]}"; do [[ "$s" -nt "$CACHE" ]] && stale=1; done
if (( stale )); then
  echo "Rendering the $NCH-channel mix → $CACHE"
  mkdir -p "$(dirname "$CACHE")"
  in=(-i "$BED"); fc="[0:a]aresample=$RATE,pan=4c|c0=c0|c1=c1|c2=c2|c3=c3[foa];"; merge="[foa]"
  for ((i=0; i<NST; i++)); do
    in+=(-i "${STEMS[i]}")
    # aformat first so a mono stem also works: upmixed to stereo, averaged back.
    fc+="[$((i+1)):a]aresample=$RATE,aformat=channel_layouts=stereo,pan=mono|c0=0.5*c0+0.5*c1[s$i];"
    merge+="[s$i]"
  done
  if (( NST )); then fc+="${merge}amerge=inputs=$((NST+1))[out]"; else fc="${fc%;}"; fc="${fc/\[foa\]/[out]}"; fi
  # amerge stops at the shortest input, so all channels share one length.
  ffmpeg -hide_banner -loglevel error -y "${in[@]}" -filter_complex "$fc" \
    -map "[out]" -c:a pcm_s32le "$CACHE.tmp.wav"
  mv "$CACHE.tmp.wav" "$CACHE"
fi

# — The loopback card —
card=$(sed -n 's/^ *\([0-9]\+\) \[Loopback *\].*/\1/p' /proc/asound/cards | head -1)
if [[ -z "$card" ]]; then
  echo "No ALSA loopback card. Load it once (lasts until reboot):"
  echo "    sudo modprobe snd-aloop"
  exit 1
fi

# PulseAudio grabs a new card the moment it appears and keeps its first
# substream open ("Device or resource busy"). Switching that card's profile off
# releases it; undo with: pactl set-card-profile <card> output:analog-stereo+input:analog-stereo
if command -v pactl >/dev/null; then
  pcard=$(pactl list short cards 2>/dev/null | awk '/snd_aloop/ {print $2; exit}')
  if [[ -n "$pcard" ]]; then
    pactl set-card-profile "$pcard" off && echo "  PulseAudio released the loopback card ($pcard)"
  fi
fi

echo
echo "  Fake mixer: $NCH channels @ $RATE Hz → $DEVICE"
echo "    ch 0..3  FOA  ($BED)"
for ((i=0; i<NST; i++)); do echo "    ch $((4+i))     ${STEMS[i]}"; done
echo
echo "  In the editor (Live): audio USB (ALSA) → hw:$card,1 (Loopback, capture side)"
echo "    Total ch. $NCH · FOA ch 0,1,2,3 · stems ch 4..$((NCH-1)) in this order"
echo "  Ctrl-C to stop."
echo

# ALSA paces playback at real time, so no -re. The loopback forces the capture
# side to the same format, rate and channel count as this playback.
exec ffmpeg -hide_banner -loglevel warning -nostdin -stream_loop -1 -i "$CACHE" \
  -c:a pcm_s32le -ar "$RATE" -ac "$NCH" -f alsa "$DEVICE"
