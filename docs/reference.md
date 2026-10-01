# Reference

Lookup tables for the player, the editor's backend and the scene file: what the
controls do, which URL flags exist, where each file lives, the `/api/*` routes and
the `scene.json` schema. For *why* the pieces are arranged this way, read
[`architecture.md`](architecture.md).

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
server.js               Static server (Range/MSE) + /api/* backend + telemetry relay
stream.sh               DASH packaging (video + multichannel Opus) VOD/live
make-bed.sh             Inspect / extract / build the 4-channel ambisonic bed
scene.json              Scene config (stems, placement, spotlight)
src/audio/              Reusable immersive-audio engine (ESM)
  ImmersiveAudioEngine.js   Public API: rotation, zoom, spotlight, stems
  OmnitoneFOADecoder.js     Binaural FOA decode (HRTF) via Omnitone
  HOAST*.js / *.js          Cardioid fallback, matrices, axes
telemetry/              Pose relay, recorder and headset simulator
x4_bridge/              Insta360 X4 → virtual camera bridge for live capture
media/                  360 video, FOA bed and stems (Git LFS — not free to reuse)
meshes/                 Musician .glb models for AR (git-ignored but test-figure.glb)
tools/                  Node tests, bed analysis, docs-bundle.sh (all docs in one file)
docs/                   Guides — indexed in the README
LICENSE                 BSD 2-Clause — the code only
THIRD-PARTY.md          Libraries, vendored files and derived code, with licences
```

---

## Backend API (`/api/*`)

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

---

## `scene.json` schema

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
    // because a .glb's units cannot be trusted. It stands on the floor unless
    // "offsetYM" lifts it, which is what an instrument modelled on its own needs.
    // See docs/musician-meshes.md.
    { "file": "media/DR - stem - sync.mp3", "name": "DR", "azimuthDeg": -50, "elevationDeg": 0,
      "gainDb": 0, "closeup": "media/dr_cu.mp4", "mesh": "meshes/drums.glb" },
    { "file": "media/SAX - stem - sync.mp3", "name": "SAX", "azimuthDeg": 50, "elevationDeg": 0,
      "mesh": { "url": "meshes/sax.glb", "heightM": 1.4, "yawDeg": 45, "zUp": false,
                "offsetYM": 0 } }
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


> The player sets `zoomMin` automatically (current view) so that at rest the
> stems are silent, both on desktop and in VR. Azimuth convention: see
> [`encoding.md`](encoding.md#editor-workflow).
