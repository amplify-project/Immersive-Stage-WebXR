# Architecture & how to extend

This is the developer guide for building **on top of** the existing system. It
explains how the pieces fit, the invariants you must not break, and where to plug
in new features.

- To **run / operate** the system → [`../README.md`](../README.md).
- The **audio engine API** → [`core-api.md`](core-api.md).
- The **two pending partner features** (AR tracking, zoom-quality) → [`handoff.md`](handoff.md).
- **Live 360 capture** (Insta360 X4 bridge) → [`../x4_bridge/README.md`](../x4_bridge/README.md).

---

## 1. System overview

One scene config drives everything. The editor writes it, the server encodes from
it, the player reads it.

```
                       scene.json
                          ▲ │
              save (POST) │ │ read (GET)
                          │ ▼
   editor.html  ──/api/encode──▶  server.js  ──spawn──▶  stream.sh
  (author scene)                 (HTTP + jobs)          (ffmpeg → DASH)
                                                            │
                                                            ▼
                                                   encoded/manifest.mpd
                                                   (360 video + multichannel
                                                    Opus + optional close-ups)
                                                            │
                                                            ▼
   index.html  ◀── GET scene.json + manifest ── Shaka → <video> → Three.js (visuals)
  (player)                                              └────────▶ ImmersiveAudioEngine
                                                                   (Web Audio: FOA + stems)
```

The contract between halves is **two artifacts**: `scene.json` (placement,
spotlight, encode params) and the **DASH manifest** (one 360 video track + one
multichannel Opus track + optional close-up video tracks). Change one side, keep
those two contracts, and the other side keeps working.

---

## 2. Components & responsibilities

| File | Role | You touch it to… |
|------|------|------------------|
| `index.html` | **Player.** Three.js scene, Shaka playback, WebXR (VR/AR), HUD, A/V drift control, close-up logic. | Add a viewer-side feature (rendering, XR, UI, track switching). |
| `src/audio/ImmersiveAudioEngine.js` | **Audio engine.** Owns the whole Web Audio graph: FOA HRTF decode + per-stem `PannerNode`s + spotlight. Framework-agnostic. | Add spatial-audio behavior (positions, spotlight, new sources). |
| `src/audio/*` | Engine internals: `OmnitoneFOADecoder` (HRTF), `HOAST*` (cardioid fallback), `zoom-matrix`, `ambisonicAxes`. | Rarely — low-level DSP. |
| `editor.html` | **Visual editor.** Authors `scene.json`: sources, top-down placement radar, spotlight, encode controls, live device pickers. | Add an authoring control or a new scene field. |
| `server.js` | **Backend.** Static file server (Range/MSE) + `/api/*` (scene I/O, encode/proxy jobs, live devices, monitor). No npm deps. | Add an API route or a job type. |
| `stream.sh` | **Encoder.** Builds the ffmpeg invocation that packages video + multichannel Opus (+ close-ups) into DASH, for VOD and live. | Add an encode option / output layout. |
| `x4_bridge/` | **Live 360 capture.** Stitches the Insta360 X4 and exposes `/dev/video10`. | Live capture pipeline only. |
| `scene.json` | The shared config artifact. | Whenever a feature needs new authored data. |

---

## 3. Invariants — do not break these

These are hard-won and several are non-obvious. Breaking one tends to reintroduce
a bug we already fixed.

- **One multichannel Opus stream, not N audio tracks.** Channels 0–3 = FOA bed,
  4…N = one mono stem per musician, all in a single track. Shaka/DASH plays one
  audio track at a time and won't mix/sync several `AdaptationSet`s; one stream =
  one timeline = zero drift, and it's the only thing that works for **live**
  (stems can't be preloaded as `AudioBuffer`s). Verified ≤10 ch on Quest.
- **A single Shaka on the `<video>` for the main content.** The `<video>` carries
  both video and the multichannel Opus, so the audio is taken from that **same**
  element via `createMediaElementSource` (in `setupFOA`) — **do not** open a
  second Shaka on a separate `<audio>`. The stale `loadDualShaka` name predates
  this; the A/V drift between two Shaka instances was the original bug. (A
  *separate* Shaka, `shakaCloseup`, for the close-up track is the one exception —
  see §below.)
- **A/V drift is corrected by `playbackRate`, not seeking.** `window.avSync`
  nudges the audio's rate proportionally to the offset (dead-band, EMA, capped so
  it's inaudible); a hard seek is the last resort (>1.5 s). The video is the
  master clock.
- **VP9 / WebM for the Quest, not H.264.** H.264 puts Opus in MP4 and the Oculus
  browser won't decode **multichannel Opus in MP4** → no audio. WebM (VP9) carries
  Opus natively. (`dash_segment_type auto` keeps H.264 in mp4 + Opus in webm where
  used — see the live encode notes.)
- **Coordinate convention everywhere:** front = −Z, up = +Y, left = −X. Azimuth
  `0°` = front of the video, `+` = left. Shared by Three.js, WebXR and the engine.
- **Backward compatibility:** a manifest with no stems / no close-ups must behave
  exactly like the plain 360 player. Guard new features behind "is this present?"
  checks (as `setupCloseups` / the stems split already do).
- **Decoder budget on Quest:** few simultaneous hardware decoders. Keep it to
  4K 360 + at most one extra video (e.g. one close-up). Don't decode N videos at
  once (see [`handoff.md`](handoff.md) Case B).

---

## 4. Data flow in detail

### Authoring (editor → scene.json)
`editor.html` edits an in-memory `scene` object and `POST`s it to `/api/scene`.
Placement comes from the top-down radar (azimuth/elevation per stem); spotlight
and encode params from their panels; live device choices into `scene.live`.

### Encoding (scene.json → manifest)
`POST /api/encode {mode}` reads `scene.json` and translates it into **environment
variables** for `stream.sh` (`server.js` §`/api/encode`):
- Common: `FORMAT`, `CODEC`, `SEG`, `VBITRATE`, `SCALE`, optional `S3_*`.
- VOD/files: `VIDEO`, `AUDIO` (bed), `STEMS` (`;`-joined), `CLOSEUPS` (only stems
  that have one, in order → `RepresentationID 1..N`).
- Live/capture: `CAPTURE=1`, `VIDEO_SRC/DEVICE/URL`, `AUDIO_SRC/DEVICE/CHANNELS/URL`,
  `AUDIO_DELAY`, `FOA_CH`, `STEM_CH`.
`stream.sh` builds the `-map`s, per-stream filters/bitrates and the
`-adaptation_sets` string dynamically, then runs ffmpeg. Output:
`encoded/manifest.mpd`.

### Playback (manifest + scene.json → player)
`index.html` loads `scene.json` (stem names/positions/closeups, spotlight) and the
manifest. Shaka attaches to `<video>`; `setupFOA` taps the same element's
multichannel audio into `ImmersiveAudioEngine`; `setupCloseups` discovers extra
video tracks and builds the stem→`RepresentationID` map. Each frame the render
loop feeds head pose + zoom into the engine and refreshes the spotlight / close-up.

---

## 5. How to extend (recipes)

### Add an engine method (spatial-audio behavior)
1. Add the method to `src/audio/ImmersiveAudioEngine.js`, operating on the Web
   Audio graph it already owns (`_panners`, `_stemGains`, listener, etc.).
2. Keep the public surface small and framework-agnostic; accept `ref` as index
   **or** name like the existing stem methods.
3. If it needs per-frame work, do it inside `update()` (called once per frame).
4. Document it in [`core-api.md`](core-api.md).

### Add a player feature (rendering / XR / UI)
1. Wire it in `index.html`'s render loop. Read head pose via
   `setRotationFromMatrix4` and zoom via `getZoomFactor()`; ask the engine *what*
   you look at with `getFocusedStem()`.
2. For XR, branch on the active session (`immersive-vr` vs `immersive-ar`); restore
   any spotlight params you changed on exit (see the AR enter/exit code).
3. Guard behind a presence check so a plain manifest is unaffected.

### Add a close-up-style extra video track
Follow the existing Case B pattern: extra `AdaptationSet`s in the **same** manifest
(shared timeline), discovered by `setupCloseups`, switched on the single
`shakaCloseup` element, synced via `currentTime`/`playbackRate` in the `avSync`
loop. Respect the decoder budget. This is the basis for the Case B "ROI crop" work
in [`handoff.md`](handoff.md).

### Add a scene field (new authored data)
1. Add the control in `editor.html`; write the value into the `scene` object.
2. Extend the `scene.json` schema doc in [`../README.md`](../README.md).
3. Consume it: in `server.js` (→ a `stream.sh` env var) if it affects the encode,
   and/or in `index.html` if it's playback-only.
4. Default it so old scenes without the field still work.

### Add a `/api/*` route
1. Add an `if (pathname === '/api/x' && req.method === ...)` branch in
   `handleAPI` (`server.js`). Use `readBody`/`sendJSON` helpers.
2. Long-running work goes through the single-job model (`startJob`); only one
   encode/monitor job runs at a time (ALSA is exclusive for live).

### Add an encode option (`stream.sh`)
1. Read a new `ENV_VAR` near the top of `stream.sh` with a default.
2. Thread it into the ffmpeg args (filters/maps/bitrates) — keep the
   no-feature path byte-for-byte equivalent to before.
3. Emit it from `server.js` `/api/encode` (from a `scene.encode.*` field).

---

## 6. Roadmap

Two features are scaffolded but unfinished, intended for partner teams — full
specs, current state, and integration points in **[`handoff.md`](handoff.md)**:

- **Case A** — AR 3D objects with real-world tracking (audio-only authoring).
- **Case B** — sharper musician on zoom via per-musician ROI crops ("partial 8K").
