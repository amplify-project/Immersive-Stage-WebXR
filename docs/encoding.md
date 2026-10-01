# Preparing and encoding a scene

How a recorded take becomes a DASH manifest the player can open: the editor
workflow for **VOD**, the `stream.sh` script it drives, and the three things that
decide whether a Meta Quest plays the result at all.

For a **live** show — camera, mixer channels, A/V delay, publishing — follow
[`live-editor-tutorial.md`](live-editor-tutorial.md) instead; it walks the
editor's LIVE panel field by field.

---

## Editor workflow

Open `https://<host>:60000/editor.html` (see the README's *Quick start*).

1. **Sources**: pick the 360 video, the FOA bed (4 channels) and its format
   (*FuMa* or *AmbiX*).
   The dropdowns only offer what is in `media/`, which is the folder the server
   reads and the only path a scene can name. **Browse…** opens the filesystem *of
   the machine running the server*, and whatever you pick is copied into `media/`
   — it is not a browser file picker, because the file has to end up where ffmpeg
   is, and uploading 300 MB over HTTP to land it in the folder next door would be
   absurd. On Btrfs/XFS the copy is a reflink, so it is instant and takes no extra
   space. There is one next to every source: the **360 video**, the **bed**, the
   **stem** adder (it browses audio and adds the musician in one go), the
   **proxy** source, and a compact `…` on each musician row for their
   **close-up**. Each one only lists the kind it can use.
2. **Musicians**: add one stem per instrumentalist and **drag it on the top-down
   radar** to place it in azimuth (top = front of the video, left = +90°). Fine
   tune name/azimuth/elevation in the side panel.
3. **Spotlight**: tune `maxBoost`, `focusExp` (focus cone), `restGain`
   (stems' background level) and `zoomMax`.
4. **Encode**: choose codec/scale/bitrate and hit **Generate VOD** or
   **Start LIVE**. The status shows `speed` (≥ 1× = real time).
5. **Save** writes `scene.json`, which the player reads to place the stems.

Placement and spotlight can be tuned **without re-encoding** (just reload the
player); re-encoding is only needed when the **sources/stems** change.

> Azimuth: `0°` = front of the video (the **centre column** of the equirect
> frame), `+` = left. To read a musician's azimuth straight off a frame, take
> their horizontal position `u` (0 at the left edge, 1 at the right) and compute
> `azimuthDeg = (0.5 - u) * 360`.

### The ambisonic bed

The bed must have **exactly 4 channels**, and channel *i* must be ambisonic
component *i* — nothing downstream can tell otherwise. Video editors happily
export a B-format take as 7.1 with every channel duplicated. Check and extract
with `./make-bed.sh -l take.wav`, then
`./make-bed.sh take.wav media/bed.wav 0,2,4,6`. The encoder refuses any other
channel count rather than silently reading the wrong four.

If instead the take arrives as **four separate mono files**, one per component
(an NT-SF1 recording, a DAW export), merge them with **Build a bed from separate
W/X/Y/Z files** in the editor, or from a terminal:
`./make-bed.sh -m W.wav X.wav Y.wav Z.wav media/bed.wav [fuma|ambix]`.
The arguments are named by **component**, never by the position they had in the
recorder: the write order is what the format decides — FuMa `W,X,Y,Z`, AmbiX
`W,Y,Z,X`. Order only; gains are untouched. Getting this wrong yields a rotated
sound field that *Analyse bed* can no longer undo.

---

## Command-line encoding (`stream.sh`)

The editor launches this same script; you can also run it directly:

```bash
# VOD
STEMS="media/DR - stem - sync.mp3;media/GT - stem - sync.mp3;..." \
  ./stream.sh vod

# Live (low-latency loop, sliding window)
VIDEO=media/video_1920.mp4 \
STEMS="media/DR - stem - sync.mp3;media/GT - stem - sync.mp3;..." \
CODEC=vp9 ./stream.sh live
```

Variables (all optional): `STEMS` (`;`-separated list), `FORMAT`
(`fuma`|`ambix`), `CODEC` (`vp9`|`h264`), `SCALE` (e.g. `1920:960`), `VIDEO`,
`AUDIO`, `OUT`, `SEG`, `VBITRATE`. Output in `encoded/manifest.mpd`.

For live capture (`CAPTURE=1`): `VIDEO_SRC`/`AUDIO_SRC` (`usb`|`udp`),
`VIDEO_DEVICE`, `AUDIO_DEVICE`, `AUDIO_CHANNELS`, and **`AUDIO_DELAY`** (ms,
positive = audio later, to compensate the camera's stitching latency — measured as
in step 7 of [`live-editor-tutorial.md`](live-editor-tutorial.md)). The delay is
applied with `-itsoffset` on the raw audio input, before FOA and stems are split,
so the whole audio bed shifts together.

**Close-up videos**: add per-musician "see them closer" tracks to the same
manifest with `CLOSEUPS` (`;`-separated, in stem order), `CLOSEUP_SCALE`
(default `1280:720`) and `CLOSEUP_VBITRATE` (default `2500k`). See
[`core-api.md`](core-api.md) and [`closeup-panel.md`](closeup-panel.md).

---

## ⚠️ Three things that matter for the Quest

1. **Use VP9 / WebM** (not H.264). H.264 puts Opus in **MP4**, and the Oculus
   browser **won't play multichannel Opus in MP4** → no video, no audio. WebM
   (VP9) carries Opus in its native container, which does decode.
2. **Real time**: VP9 from a **4K/HEVC** source can't hit 1× (decoding 4K HEVC is
   the bottleneck). Generate a **lightweight 8-bit proxy** and stream from it
   (*Create proxy* button in the editor, or):
   ```bash
   ffmpeg -i media/video.mp4 -an -vf "scale=1920:960,format=yuv420p" \
     -c:v libx264 -profile:v high -preset veryfast -crf 20 media/video_1920.mp4
   ```
3. **The browser reorders Opus channels when the track has 3–8 of them.**
   Chromium maps multichannel Opus to Vorbis channel order even for
   `mapping_family 255` (discrete channels, no layout), while ffmpeg does not —
   so the file measures perfectly on disk and arrives shuffled in Web Audio. With
   4 FOA + 3 stems (7 channels) the ambisonic X channel receives a musician's
   stem and the stems play at each other's positions. The engine undoes this
   (`VORBIS_SRC_TO_OUT`); `?chmap=identity` disables it. Channel counts of 4, or
   of 9 and above, are passed through untouched, which is why the original
   10-channel spike never showed the problem. Verify any layout with
   `channel-test.html?src=/chtest/manifest.mpd&ch=7` — one tone per channel.
