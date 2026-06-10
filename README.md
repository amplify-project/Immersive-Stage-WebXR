# Livestreamed Immersive Player

Web player for **360° equirectangular video + Ambisonics (FOA) audio** with
binaural decoding, **WebXR (Meta Quest)** support, and a **per-musician audio
spotlight**: zoom in on an instrumentalist and their stem swells from its
position in space.

Ships with a **visual editor** to place each musician in the 3D scene and launch
the encodes (VOD and live) from the browser.

---

## How it works

Audio travels as **a single multichannel Opus stream** inside the same DASH
manifest as the video:

```
channels 0..3  → FOA Ambisonics (ACN/SN3D)  → binaural HRTF decode (Omnitone) + head rotation
channels 4..N  → one mono stem per musician  → GainNode → PannerNode(HRTF) at its azimuth → spotlight
```

One stream means **one timeline, one decoder, zero drift**: the stems stay
sample-accurate with the ambisonic bed without any tricks. The *spotlight* raises
a stem's gain as a function of **where you look × how much you zoom**.

### Why one multichannel stream (not N tracks)

- Shaka/DASH plays **one** audio track at a time; it does not mix or sync several
  `AdaptationSet`s.
- For **live** you can't preload stems as `AudioBuffer`s (the file is still being
  generated) → you'd have to reinvent scheduling. The multichannel stream solves
  this by construction.
- Verified on the **Meta Quest** browser: it decodes and separates up to
  **10 channels** of Opus over MSE (4 FOA + 6 stems). Test: `channel-test.html`.

---

## Requirements

- **Node.js** (no npm dependencies; uses only built-in modules).
- **ffmpeg** and **ffprobe** on `PATH` (with `libvpx-vp9`, `libopus`, `libx264`).
- **git-lfs** (media files `*.mp4 / *.wav / *.mp3` are stored via LFS).
- WebXR/VR over IP needs **HTTPS** → generate a self-signed certificate with
  `./gen-cert.sh`.

---

## Quick start

```bash
git lfs install && git lfs pull      # fetch the sample media
./gen-cert.sh                        # cert for HTTPS/WebXR (once)
node server.js                       # start the server (https if certs exist)
```

Open in the browser:

- **Editor**  → `https://<host>:60000/editor.html`
- **Player**  → `https://<host>:60000/index.html`

> On the Meta Quest use the **PC's IP** (not `localhost`) and accept the
> self-signed certificate.

---

## Editor workflow

1. **Sources**: pick the 360 video, the FOA bed (4 channels) and its format
   (*FuMa* or *AmbiX*).
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

### ⚠️ Two things that matter for the Quest

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

---

## Player controls

| Action | Desktop | WebXR (Quest) |
|--------|---------|----------------|
| Look around | drag mouse | move your head |
| Zoom (spotlight) | mouse wheel | right thumbstick (Y axis) |
| Play/pause | spacebar | HUD controls |
| Enter VR | **VR** button | — |

With no zoom only the FOA bed plays (everything mixed). When you **look at a
musician + zoom in**, their stem appears from its position.

---

## Verification tools

- **`channel-test.html`** — checks how many Opus channels the browser exposes
  over MSE (default 10, from `encoded10/`). Handy to validate a Quest.
- **`make-channel-test.sh`** / **`make-stem-demo.sh`** — generate test manifests
  (audio-only N-channel / video + FOA + tones).

---

## File map

```
index.html              Player (Three.js + Shaka + WebXR + HUD)
editor.html             Visual scene editor
server.js               Static server (Range/MSE) + /api/* backend
stream.sh               DASH packaging (video + multichannel Opus) VOD/live
scene.json              Scene config (stems, placement, spotlight)
src/audio/              Reusable immersive-audio engine (ESM)
  ImmersiveAudioEngine.js   Public API: rotation, zoom, spotlight, stems
  OmnitoneFOADecoder.js     Binaural FOA decode (HRTF) via Omnitone
  HOAST*.js / *.js          Cardioid fallback, matrices, axes
media/                  360 video, FOA bed and stems (Git LFS)
```

### Backend API (`/api/*`)

| Route | Method | Description |
|-------|--------|-------------|
| `/api/media` | GET | List `media/` with type and channel count |
| `/api/scene` | GET/POST | Read / save `scene.json` |
| `/api/encode` | POST `{mode}` | Launch `stream.sh` (`vod`\|`live`) |
| `/api/proxy` | POST `{src,scale}` | Transcode a lightweight 8-bit proxy |
| `/api/encode/status` | GET | Encode status (running, `speed`, log) |
| `/api/encode/stop` | POST | Stop the running encode |

### `scene.json` schema

```jsonc
{
  "video": "media/video_1920.mp4",
  "bed":   "media/ambisonic_bformat.wav",
  "bedFormat": "fuma",                       // fuma | ambix
  "stems": [
    { "file": "media/DR - stem - sync.mp3", "name": "DR", "azimuthDeg": -50, "elevationDeg": 0 }
  ],
  "spotlight": { "maxBoost": 1.5, "focusExp": 4, "restGain": 0, "zoomMax": 2.5 },
  "encode":    { "codec": "vp9", "scale": "1920:960", "vbitrate": "6000k", "seg": 2 }
}
```

> Azimuth: `0°` = front of the video, `+` = left. The player sets `zoomMin`
> automatically (current view) so that at rest the stems are silent, both on
> desktop and in VR.
