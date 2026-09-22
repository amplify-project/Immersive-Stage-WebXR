# Livestreamed Immersive Player

Web player for **360° equirectangular video + Ambisonics (FOA) audio** with
binaural decoding, **WebXR (Meta Quest)** support, and a **per-musician audio
spotlight**: zoom in on an instrumentalist and their stem swells from its
position in space.

Ships with a **visual editor** to place each musician in the 3D scene and launch
the encodes (VOD and live) from the browser.

It also supports a **WebXR AR** mode (3D objects as positional audio sources in
passthrough) and **synchronized per-musician close-up videos** (extra DASH video
tracks). See **[`docs/core-api.md`](docs/core-api.md)** for the engine API and
these features in detail.

> **Research prototype from the AMPLIFY project.** Built at
> [Vicomtech](https://www.vicomtech.org) for work package «WP-N», and run
> against real takes on real hardware — a Meta Quest 3, a 360° camera and a
> 32-channel desk in a room with musicians. Code under BSD 2-Clause; the sample
> recording in `media/` is **not** free to reuse. See
> [The project](#the-project), [Licence](#licence) and
> [Personal data](#personal-data) at the end of this file.

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

- **Node.js**. The player and editor use only built-in modules; the optional
  pose telemetry needs `ws` (`cd telemetry && npm install`). Without it the
  server warns once and runs with telemetry disabled.
- **ffmpeg** and **ffprobe** on `PATH` (with `libvpx-vp9`, `libopus`, `libx264`).
- **git-lfs** (media files `*.mp4 / *.wav / *.mp3` are stored via LFS).
- WebXR/VR over IP needs **HTTPS** → generate a self-signed certificate with
  `./gen-cert.sh`.

---

## Quick start

```bash
git lfs install && git lfs pull      # fetch the sample media
./gen-cert.sh                        # cert for HTTPS/WebXR (once)
cd telemetry && npm install && cd ..  # `ws`, only needed for pose telemetry
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
   The bed must have **exactly 4 channels**, and channel *i* must be ambisonic
   component *i* — nothing downstream can tell otherwise. Video editors happily
   export a B-format take as 7.1 with every channel duplicated. Check and extract
   with `./make-bed.sh -l take.wav`, then
   `./make-bed.sh take.wav media/bed.wav 0,2,4,6`. The encoder refuses any other
   channel count rather than silently reading the wrong four.
   If instead the take arrives as **four separate mono files**, one per component
   (an NT-SF1 recording, a DAW export), merge them with **Build a bed from
   separate W/X/Y/Z files** in the editor, or from a terminal:
   `./make-bed.sh -m W.wav X.wav Y.wav Z.wav media/bed.wav [fuma|ambix]`.
   The arguments are named by **component**, never by the position they had in the
   recorder: the write order is what the format decides — FuMa `W,X,Y,Z`, AmbiX
   `W,Y,Z,X`. Order only; gains are untouched. Getting this wrong yields a rotated
   sound field that *Analyse bed* can no longer undo.
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
For live capture (`CAPTURE=1`): `VIDEO_SRC`/`AUDIO_SRC` (`usb`|`udp`),
`VIDEO_DEVICE`, `AUDIO_DEVICE`, `AUDIO_CHANNELS`, and **`AUDIO_DELAY`** (ms,
positive = audio later, to compensate the stitch latency — see *A/V sync* below).

**Close-up videos** (Caso B): add per-musician "see them closer" tracks to the
same manifest with `CLOSEUPS` (`;`-separated, in stem order), `CLOSEUP_SCALE`
(default `1280:720`) and `CLOSEUP_VBITRATE` (default `2500k`). See
[`docs/core-api.md`](docs/core-api.md).

### ⚠️ Three things that matter for the Quest

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

---

## Live capture & A/V sync

For a live show the 360 video comes from an **Insta360 X4** through a bridge that
stitches it and exposes a virtual camera at `/dev/video10` (see
[`x4_bridge/`](x4_bridge/README.md)); the audio (FOA + stems) comes from the X32
over ALSA. Start the bridge, then in the editor (**LIVE** mode) pick the virtual
camera as the USB video source and the X32 as the audio device.

### The desync

The stitching adds latency to the **video** (~hundreds of ms), so the audio
arrives ahead. All capture inputs are timestamped with the wall clock
(`-use_wallclock_as_timestamps 1`) so the residual offset equals the real stitch
latency — **stable, measurable, and identical** in the monitor and in the live
encode. The fix is a one-time calibration: delay the audio to match the late
video.

### Calibrating the delay

1. Bridge running, **LIVE** mode, audio device set.
2. **🎯 Medir sync (ffplay)** — opens a faithful, low-latency (<300 ms) window on
   the production machine (requires the server started from a graphical session
   with `DISPLAY`). It muxes `/dev/video10` + audio with the current delay applied.
   Equivalent CLI: `./monitor_sync.sh <ms> [audio_dev] [video_dev]` (`CH=` for the
   channel count).
3. Watch a transient (a clap / snare hit): the gap you see↔hear is the desync.
   Set it in **A/V delay (ms)**, press 🎯 again to verify, repeat until aligned.
4. **Parar**, then **Start LIVE** — the value is saved in `scene.json`
   (`live.audio.delay`) and applied to the encode.

> **▶ Vista navegador** is an MSE preview — handy to confirm A+V are flowing, but
> it adds latency and biases the video, so **don't trust it for the exact offset**;
> use ffplay for the measurement.
>
> The monitor and the live encode share the X32 (ALSA is **exclusive**), so they
> can't run at once — stop the monitor before going live. The encode applies the
> delay via `-itsoffset` on the raw audio input, before FOA/stems are split, so the
> whole audio bed shifts together.

---

## Pose telemetry

Head pose, zoom and focused musician stream out to an external render (e.g.
Unity) over WebSocket. `server.js` hosts the relay on **its own port**, so the
headset talks to `/ingest` on the same origin, port and certificate it already
accepted to load the player — a relay on a separate port would need its own
certificate, trusted separately, and the failure is silent.

```bash
cd telemetry && npm install      # once — `ws`
node server.js                   # player, editor and relay in one process
```

Enable the client in `scene.json` (`"telemetry": { "enabled": true }`); leaving
`url` empty points it at this server. Then:

- **Consumer** (Unity) → `wss://<host>:60000/consume`
- **Health** → `https://<host>:60000/telemetry/health` — how many headsets and
  consumers are attached right now; open it from the Quest to confirm it landed.

The relay listens regardless of `telemetry.enabled`, which only governs whether
the *player* sends: consumers routinely connect before any headset does. Sampling
starts on entering VR or AR and stops on exit, so nothing is sent from a desktop
browser. Test without editing the scene with
`?telemetry=wss://<host>:60000/ingest&player=NAME`.

`RELAY=off` leaves the relay out. The relay also runs standalone
(`node telemetry/relay.js`) for a separate machine or behind nginx, and ships a
simulator that fakes N headsets so the Unity client can be built without one. See
[`docs/telemetry.md`](docs/telemetry.md) for the wire protocol and
[`telemetry/README.md`](telemetry/README.md) for the relay itself.

---

## Player controls

| Action | Desktop | WebXR (Quest) |
|--------|---------|----------------|
| Look around | drag mouse | move your head |
| Zoom (spotlight) | mouse wheel | right thumbstick (Y axis) |
| Play/pause | spacebar | HUD controls |
| Enter VR | **VR** button | — |
| Enter AR (passthrough) | **AR** button | **AR** button |

When you look at a musician + zoom in, their **close-up video** (if the manifest
has one) appears on a floating panel, synced to the audio.

With no zoom only the FOA bed plays (everything mixed). When you **look at a
musician + zoom in**, their stem appears from its position.

---

## Verification tools

- **`channel-test.html`** — checks how many Opus channels the browser exposes
  over MSE (default 10, from `encoded10/`). Handy to validate a Quest.
- **`make-channel-test.sh`** / **`make-stem-demo.sh`** — generate test manifests
  (audio-only N-channel / video + FOA + tones).
- **`tools/browse-targets.test.mjs`** — checks the editor's *Browse…* buttons
  without a browser or a server: that every button names a real target, that each
  one lists only the kind it can use, and what each leaves behind once the file
  has been copied. It lifts the functions out of `editor.html` by text, so it
  cannot drift from what ships: `node tools/browse-targets.test.mjs`.
- **`tools/closeup-transition.test.mjs`** / **`tools/sphere-track.test.mjs`** —
  run the close-up logic without a headset or a browser. They lift the real
  functions out of `player.js` by text, so they cannot drift from what ships:
  `node tools/closeup-transition.test.mjs`. The second one checks track selection
  against the manifest actually sitting in `encoded/`.

### Debug flags (player URL)

| Flag | What it does |
|------|--------------|
| `?arperf=1` | **AR frame budget.** Splits every AR frame into audio / focus / render, keeps the worst frame of each 2 s window, and counts how many video frames the browser actually decodes (`getVideoPlaybackQuality`). The report is a **sprite panel 1.2 m in front of your face** — an immersive session has no console and nobody reads the flat page — and a persistent block lands top-right on exit (click to dismiss). Read it like this: if `total` spikes while the sections stay in tenths of a millisecond, the time is **not** in our JavaScript (passthrough compositor or the audio thread), and the decode line says whether the 360 is still being decoded for nobody. |
| `?arnovideo=0` | Keeps decoding the 360 while in AR (the pre-`1e42924` behaviour), to A/B against the default. |
| `?spotlog=1` | Overlay of the instantaneous spotlight state (zoom, gaze, per-stem weight and gain). |
| `?avlog=1` | A/V diagnosis in the console every second (`window.avDiag()`). |
| `?maxh=1440` | Caps the video rendition height — confirms whether audio lag comes from the 4K decode not keeping up. |

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
meshes/                 Musician .glb models for AR (git-ignored but test-figure.glb)
docs/architecture.md    Dev guide: how the pieces fit + how to extend
docs/core-api.md        Engine API + AR mode + close-up multi-track reference
docs/musician-meshes.md 3D models per musician in AR: sizing, editor, upload
docs/closeup-panel.md   Close-up panel: transition, preload, sphere-track trap
tools/docs-bundle.sh    Concatenate every doc into one file (for NotebookLM etc.)
docs/shared-spaces.md   One origin for two headsets: what Quest offers, and its traps
docs/handoff.md         Pending partner features (AR tracking, zoom quality)
LICENSE                 BSD 2-Clause — the code only
THIRD-PARTY.md          Libraries, vendored files and derived code, with licences
```

> **Contributing / building on top of this?** Start with
> [`docs/architecture.md`](docs/architecture.md).

### Backend API (`/api/*`)

| Route | Method | Description |
|-------|--------|-------------|
| `/api/media` | GET | List `media/` with type and channel count |
| `/api/browse` | GET `?dir=` | List one directory **on the machine running the server** — subfolders and media files only. Defaults to `$HOME`, capped at 500 entries per kind |
| `/api/media/import` | POST `{src}` | Copy a media file from anywhere on that machine into `media/`. Same name and size → reuses it; same name, different size → numbers it; already inside `media/` → no copy |
| `/api/meshes` | GET | List `meshes/` (`.glb` musician models) |
| `/api/mesh` | POST `?name=` | Upload one `.glb` (raw body, max 64 MB) |
| `/api/scene` | GET/POST | Read / save `scene.json` |
| `/api/encode` | POST `{mode}` | Launch `stream.sh` (`vod`\|`live`) |
| `/api/proxy` | POST `{src,scale}` | Transcode a lightweight 8-bit proxy |
| `/api/bed/analyze` | POST `{bed,bedFormat,stems}` | Check the declared channel order and measure the mic's rotation |
| `/api/bed/build` | POST `{w,x,y,z,out,bedFormat}` | Merge four mono components into a 4-channel bed (runs `make-bed.sh -m`) |
| `/api/encode/status` | GET | Encode status (running, `speed`, log) |
| `/api/encode/stop` | POST | Stop the running encode |

### `scene.json` schema

```jsonc
{
  "video": "media/video_1920.mp4",
  "bed":   "media/ambisonic_bformat.wav",
  "bedFormat": "fuma",                       // fuma | ambix
  "stems": [
    // "closeup" is optional (Caso B): a per-musician close-up video track.
    // "gainDb" is optional: a fixed trim for this take. The spotlight boosts
    // every stem by the same maxBoost, so a musician recorded below the bed
    // never lifts off it, however hard you look at him. "Analyse bed" measures
    // the imbalance and fills these in.
    // "elevationDeg" is not decoration: the focus cone is circular around your
    // gaze, so a musician 40° below the camera is 40° off however well you aim.
    // "mesh" is optional (AR only): the 3D model shown instead of the wireframe
    // marker. A bare path uses the defaults; the object form tunes them. The size
    // is NOT the file's own — the model is scaled so it is "heightM" metres tall,
    // because a .glb's units cannot be trusted. See docs/musician-meshes.md.
    { "file": "media/DR - stem - sync.mp3", "name": "DR", "azimuthDeg": -50, "elevationDeg": 0,
      "gainDb": 0, "closeup": "media/dr_cu.mp4", "mesh": "meshes/drums.glb" },
    { "file": "media/SAX - stem - sync.mp3", "name": "SAX", "azimuthDeg": 50, "elevationDeg": 0,
      "mesh": { "url": "meshes/sax.glb", "heightM": 1.4, "yawDeg": 45, "zUp": false } }
  ],
  // `bedDuck` pulls the FOA bed down as you focus a musician. Without it the
  // spotlight can only add a stem on top of the bed's own copy of that same
  // musician: louder, not more solo. 0 = off, 0.7 = bed drops to 30%.
  "spotlight": { "maxBoost": 1.5, "focusExp": 4, "restGain": 0, "zoomMax": 2.5,
                 "bedDuck": 0.7 },
  // AR only. The bed holds the whole concert; in passthrough it competes with the
  // real room and buries the anchored musicians. `bedDuck` cannot help here — AR
  // runs at zoom 0, so no stem is ever "focused" and the duck never fires.
  // 0.35 ≈ -9 dB. Restored to 1 on leaving AR.
  // "mesh" here is the fallback model for every stem without one of its own.
  "ar": { "bedGain": 0.35, "mesh": "meshes/generic.glb" },
  // How far the ambisonic mic was turned from the camera when recording. Rotates
  // the FOA bed only, never the stems. Override live with ?ayaw= / ?amirror=.
  "alignment": { "yawOffsetDeg": 0, "mirror": false },
  // Distance attenuation per source, and smoothing for positions pushed in from
  // outside (AR tracking). Only audible in AR: in 360 the sources ride a sphere
  // fixed to your head, always at the same distance.
  "sources":   { "distanceModel": "inverse", "refDistance": 1, "rolloffFactor": 1,
                 "maxDistance": 10000, "smoothSec": 0.05 },
  "encode":    { "codec": "vp9", "scale": "1920:960", "vbitrate": "6000k", "seg": 2 },
  // Pose telemetry. Empty "url" = /ingest on the server hosting the player.
  "telemetry": { "enabled": false, "url": "", "rateHz": 20, "flushMs": 100 }
}
```

> Azimuth: `0°` = front of the video (the **centre column** of the equirect
> frame), `+` = left. To read a musician's azimuth straight off a frame, take
> their horizontal position `u` (0 at the left edge, 1 at the right) and compute
> `azimuthDeg = (0.5 - u) * 360`. The player sets `zoomMin` automatically
> (current view) so that at rest the stems are silent, both on desktop and in VR.


---

## The project

This is the software side of one work package of **AMPLIFY**, a European
research project: capturing a live concert in 360° with an ambisonic bed and
one stem per musician, and letting a remote audience listen to it in a headset
— where **looking at a musician is what brings them forward**.

What that makes it, and what it does not. It is a **research prototype**: there
is no build step, no package to install, and the deployment it knows about is
`node server.js` on the machine standing next to the camera. What it does have
is mileage — every session with real musicians left something in `docs/`, from
the A/V offset a USB camera introduces to the frame budget of passthrough on a
Quest 3. Those documents are the part most worth reading before building on
this.

**Verified on hardware**, not only in a desktop browser: 10-channel Opus over
MSE on the Quest browser (4 FOA + 6 stems, `channel-test.html`), VR and AR
passthrough sessions, and live streaming from an Insta360 camera and a
Behringer X32 desk with NVENC. Per-musician 3D models in AR are implemented and
tuned from the editor, preview included
([`docs/musician-meshes.md`](docs/musician-meshes.md)).

**Not done, and honest about it:** shared spatial anchors between two headsets
are researched but unbuilt ([`docs/shared-spaces.md`](docs/shared-spaces.md)),
and [`docs/handoff.md`](docs/handoff.md) lists the features handed to partners
with what is missing in each. Each document says at the top how far it got and
on what hardware — that line is the one to trust.

### Funding

Funded by the European Union under grant agreement No «NNNNNN» («AMPLIFY —
full project title», «call / programme»). Views and opinions expressed are
however those of the author(s) only and do not necessarily reflect those of the
European Union or «the granting authority». Neither the European Union nor the
granting authority can be held responsible for them.

---

## Licence

The **code** is BSD 2-Clause — see [`LICENSE`](LICENSE). Third-party components
keep their own terms, listed in [`THIRD-PARTY.md`](THIRD-PARTY.md); that file
also flags the two things to check before reusing this in another project.

The **sample media** in `media/` — the 360° video, the ambisonic bed and the six
stems, carried by Git LFS — is **not** covered by that licence and is **not free
to reuse**. It is a recording of identifiable performers, included so that the
player can be run against real material instead of a test tone: a scene where
the stems are genuinely a band, mixed in a real room, is the only way to hear
whether the spotlight works. Reuse, redistribution, or any derivative of that
recording needs written permission — ask first. The same applies to media
reachable through the repository's history, including takes no longer in the
working tree.

`meshes/test-figure.glb` is the one 3D model that travels with the repository,
as a known-good file to check a headset against. Every other `.glb` is
per-venue, git-ignored, and carries its author's own terms.

---

## Personal data

The pose telemetry records **where a person looked**: head orientation, zoom,
which musician was in focus, sampled at 20 Hz and tagged with whatever name the
session was given ([`docs/telemetry.md`](docs/telemetry.md)). For anyone wearing
the headset, that is personal data.

- It is **off by default** (`"telemetry": { "enabled": false }` in `scene.json`).
- The player only samples **inside a VR or AR session**. A desktop browser sends
  nothing, whatever the flag says.
- With `url` empty it goes to the same server that served the player, and
  nowhere else.
- Recorded sessions are CSV files written by `telemetry/recorder.js`; they are
  git-ignored, and **no recorded session is in this repository**.

Running this with participants — telling them what is recorded, and getting
their consent — is the operator's responsibility, under their own institution's
ethics and data-protection rules.

---

## Citing and contact

If this work is useful in academic work, please cite the AMPLIFY project
«publication / deliverable reference». Questions about the code, or about
reusing the recording, go to «contact e-mail».
