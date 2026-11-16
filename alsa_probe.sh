# alsa_probe.sh — sourced by monitor_sync.sh and measure_sync.sh (not run).
#
# Ask an ALSA capture device what it really accepts before ffmpeg opens it.
# Without -acodec, ffmpeg opens ALSA as S16_LE; a desk that only takes S32_LE
# (the X32, the client's 18-channel mixer) then fails at open with "cannot set
# sample format ... Invalid argument". stream.sh does the same query inline.
#
#   alsa_probe <device>     reads  $CH (channels asked for), $AUDIO_CODEC (override)
#                           sets   ALSA_FMT=(-acodec pcm_xxx) or (), and clamps $CH
#                                  into the range the device opens with.
#
# The editor's channel count is the source of truth: it is only changed when the
# device would refuse it anyway. If the device is busy (an encode holds it) the
# query returns nothing and ffmpeg's defaults are left alone.

alsa_probe() {
  local dev="$1" hwp fmts chs chmin chmax f codec="${AUDIO_CODEC:-}"
  ALSA_FMT=()
  if command -v arecord >/dev/null; then
    hwp=$(LC_ALL=C timeout 3 arecord -D "$dev" --dump-hw-params -d 1 /dev/null 2>&1 || true)
    fmts=$(sed -n 's/^FORMAT: *//p' <<< "$hwp")
    chs=$(sed -n 's/^CHANNELS: *//p' <<< "$hwp" | tr -d '[]')
    # S24_LE is left out on purpose: ALSA's S24_LE is 24 bits in a 32-bit word,
    # ffmpeg's pcm_s24le is packed 3-byte (S24_3LE) — not the same layout.
    if [[ -z "$codec" && -n "$fmts" ]]; then
      for f in S32_LE S16_LE; do
        [[ " $fmts " == *" $f "* ]] && { codec="pcm_$(tr 'A-Z' 'a-z' <<< "${f/_/}")"; break; }
      done
    fi
    if [[ -n "$chs" && "$CH" =~ ^[0-9]+$ ]]; then
      read -r chmin chmax <<< "$chs"; chmax="${chmax:-$chmin}"
      if (( CH < chmin || CH > chmax )); then
        local want=$CH
        (( CH > chmax )) && CH=$chmax || CH=$chmin
        echo "  ALSA $dev: asked for $want ch, it opens with $chmin..$chmax → using $CH" >&2
      fi
    fi
    [[ -z "$fmts" ]] && echo "  ALSA $dev: could not query it (busy?) — opening with ffmpeg defaults" >&2
  fi
  [[ -n "$codec" ]] && ALSA_FMT=(-acodec "$codec")
  [[ -n "$codec" || -n "$chs" ]] && echo "  ALSA $dev: ${codec:-default format}, $CH ch" >&2
  return 0
}
