# Core API — `ImmersiveAudioEngine` + spatial-core changes

This document covers two things:

1. The **public API** of the reusable audio core (`src/audio/ImmersiveAudioEngine.js`).
2. The **`feat/spatial-core` changes**: how a *stem* became a generic **spatial
   source**, the **WebXR AR** mode (3D objects as audio sources), and the
   **synchronized close-up videos** (DASH multi-track).

> The engine is framework-agnostic (vanilla / Three.js / WebXR). It owns the
> whole Web Audio graph and exposes a small surface. The player (`index.html`)
> is just one consumer.

---

## 1. Signal graph

```
mediaElement → [source] ─┬─ ch 0..3 (FOA) → decoder (HRTF + head rotation) → gain ─┬→ destination
                         │                                                          └→ analyser
                         └─ ch 4..N (stems) → split → [gain → PannerNode(HRTF)]·N → stemBus → gain
```

- **FOA bed** (channels 0–3): ambisonic soundfield, binaural-decoded with HRTF
  (Omnitone) and rotated with the head.
- **Stems / spatial sources** (channels 4…N): one mono signal per musician, each
  spatialized by a `PannerNode` (HRTF) at a 3D position. A *spotlight* raises a
  source's gain as a function of **where you look × how much you zoom**.

One multichannel stream → **one timeline, one decoder, zero drift**.

---

## 2. Construction & lifecycle

```js
import { ImmersiveAudioEngine } from './src/audio/ImmersiveAudioEngine.js';

const engine = new ImmersiveAudioEngine({
  order: 1,                 // Ambisonics order (1 = FOA)
  renderer: 'omnitone',     // 'omnitone' (HRTF, default) | 'hoast' (cardioid fallback)
  sampleRate: 48000,
  stems: [                  // optional, one entry per musician (channels 4..N)
    { azimuthDeg: -30, elevationDeg: 0, name: 'GT' },
    { azimuthDeg:  30, name: 'SAX' },
  ],
});

await engine.attach(audioElement);   // builds the AudioContext + graph
// … drive it (see below) …
await engine.dispose();              // tear down
```

| Method | Description |
|--------|-------------|
| `attach(mediaEl)` → `Promise` | Connect an `<audio>`/`<video>` and build the graph. Splits ch 0–3 (FOA) from ch 4…N (stems) when stems are present. |
| `resume()` → `Promise` | Resume a suspended `AudioContext` (call from a user gesture). |
| `dispose()` → `Promise` | Disconnect nodes and close the context (if owned). |
| `loadIRs(url)` | (`hoast` mode only) Load binaural impulse responses. |

---

## 3. Head orientation & alignment

| Method | Description |
|--------|-------------|
| `setRotationFromQuaternion(q)` | Head orientation from a WebXR/THREE quaternion `{x,y,z,w}`. |
| `setRotationFromMatrix4(elements)` | Head transform from `THREE.Matrix4.elements` (column-major). **Also sets the listener position** from the translation (origin in 360, moving head in AR). |
| `setAlignment({ yawOffsetDeg, mirror })` | Fixed audio↔video alignment (independent of head turn). |

Convention (shared by Three.js, WebXR and Web Audio): **front = −Z, up = +Y,
left = −X**.

---

## 4. Acoustic zoom

| Method | Description |
|--------|-------------|
| `setZoomByFactor(factor)` | Zoom from the camera FOV (`1` = none … `2.5` = max). Drives the ambisonic zoom matrix (`hoast`) and the stem spotlight. |
| `setZoomNormalized(t)` | Normalized `0..1` zoom for the spotlight when zoom doesn't come from the FOV (e.g. VR joystick). |

---

## 5. Spatial sources (stems) — **new in `feat/spatial-core`**

A stem starts placed by azimuth/elevation on a sphere of radius `_stemRadius`
(**fully backward-compatible**: with no dynamic positioning the behavior is
identical to before). Its position can become **dynamic**: set explicitly or
bound to an `Object3D` (e.g. an AR anchor).

| Method | Description |
|--------|-------------|
| `setStemPosition(ref, x, y, z)` | **Anchors** a source at a world position, so it is measured against the head (walk closer, hear it louder). `ref` = index or name; accepts `(ref, x, y, z)`, `(ref, [x,y,z])`, `(ref, {x,y,z})` or `(ref, object3D)`. Unbinds any bound object. Moves are smoothed by `smoothSec` — this is the entry point for externally tracked positions. |
| `bindStemToObject(ref, object3d)` | Anchor a source to an `Object3D` (reads its `matrixWorld`). After `update()` the panner follows it each frame. |
| `unbindStem(ref)` | Drop the anchor: the source returns to the head-relative sphere given by its azimuth/elevation (what you want on leaving AR). |
| `update()` | Call **once per frame** in the render loop when using bound/AR sources. Refreshes positions and the spotlight. No-op if nothing is bound. |

> **Two geometries.** A source is either *anchored* (room coordinates: direction
> and distance measured from the head, so walking changes both) or *not* (it rides
> a sphere fixed to the head, like the 360 mesh, always at `refDistance`). Sources
> declared by `azimuthDeg`/`elevationDeg` start unanchored; `setStemPosition` and
> `bindStemToObject` anchor them, `unbindStem` releases them.
| `setStemRadius(r)` | Radius of the static azimuth/elevation placement (default `1`). |
| `getFocusedStem(minWeight = 0.2)` → `number` | Index of the most-focused source (look × zoom) above the threshold, or `-1`. Reuses the spotlight weight — used to trigger the close-up of the musician you look at. |
| `getGazedStem({ coneDeg = 12, tieAim = 0.01 })` → `number` | Index of the source being **looked at**, zoom out of the picture, or `-1` if none falls in the cone. Anchored sources are measured head→source, so walking changes the angle by itself; equal angles go to the closer one. This is the AR counterpart of `getFocusedStem`, whose weight is always 0 there (no zoom). It decides nothing on its own — dwell and hysteresis belong to the caller. |
| `get stemCount` → `number` | Number of spatial sources. |

`ref` accepts a **numeric index** (`0..N-1`, channel order) or the source's
**name** string.

### Spotlight tuning

| Method | Description |
|--------|-------------|
| `setStemGainDb(indexOrName, dB)` | Fixed per-stem trim, in dB, applied before the spotlight. Levels the recording: `maxBoost` is the same for every stem, so one recorded 6 dB below the others never lifts off the bed. Its home is `scene.json` → `stems[i].gainDb`. |
| `getSpotlightState()` | Instantaneous spotlight: zoom factor and range, normalized zoom, gaze azimuth/elevation, the focused stem (`focusIdx`/`focusName`) with its `boostDb`/`duckDb`, `bedGain` (the duck) and `bedLevel` (the static level — what you hear is the **product**), and per stem its direction, how far your gaze is from it in azimuth and elevation, its weight, trim and reached gain. Backs the player's `?spotlog=1` overlay. |
| `setSpotlightParams({ restGain, maxBoost, focusExp, zoomMin, zoomMax, bedDuck })` | Tune the spotlight. `restGain` = stem level at rest (0 = only on zoom). `maxBoost` = extra gain when looked at with max zoom. `focusExp` = focus-cone tightness. `zoomMin/zoomMax` = zoom range that maps to the boost. `bedDuck` (0..1) = how far the FOA bed drops when a musician is focused; `0.7` leaves the bed at 30%. |
| `getSpotlightParams()` → `object` | Current spotlight params (to save/restore, e.g. on entering/leaving AR). |
| `setFocusedStem(i)` | Declare which musician is focused, to raise them; `-1` releases. The engine knows where the head points, not for how long, and a boost that follows the raw gaze flickers with neck tremor — so the dwell policy stays with the caller (`updateARFocus` in the player) and this takes only its verdict. Cheap and idempotent: work happens on a change, and then the ramp starts at once. |
| `getFocusedStemIndex()` → `number` | Focused source, or `-1`. |
| `setFocusParams({ boostDb, duckDb })` | How much focus is worth, in dB. `boostDb` lifts the focused musician, `duckDb` (positive = down) lowers the rest. Both make contrast and they don't sound alike: the boost brings the musician closer, the duck pushes the others away. Boost alone reaches the mix ceiling sooner — six stems already play at once — so a strong contrast splits better between the two than asking 12 dB of the boost. Applied on top of the zoom spotlight, so with no focus declared nothing changes. |
| `getFocusParams()` → `object` | Current `{ boostDb, duckDb }`. |
| `setBedLevel(v)` / `getBedLevel()` | Static level of the FOA bed, 0..1, **multiplying** the duck rather than sharing a node with it. Two nodes because `bedDuck` is rewritten on every frame from the gaze, so a level written into it would not survive the next one. Used by AR (`scene.json` → `ar.bedGain`); the duck is left to the spotlight. |
| `setSourceParams({ distanceModel, refDistance, rolloffFactor, maxDistance, smoothSec })` | Distance-attenuation curve of every source, plus `smoothSec`, the time constant used when an *anchored* position is moved (0 = jump). Applies live to existing panners. In AR this curve, not the spotlight, decides how loud a musician is. |
| `getSourceParams()` → `object` | Current source params. |

---

## 6. Volume & visualization

| Method / getter | Description |
|-----------------|-------------|
| `setVolume(v)` / `toggleMute()` | Master gain / mute toggle. |
| `get audioContext` / `get gainNode` / `analyser` | Derived nodes for UI/visualizers. |
| `getFrequencyData(uint8Array)` | Fill an array with analyser frequency data. |
| `getDominantDirection()` → `{az, el, conf}` | Direction of arrival of the dominant sound (FOA intensity vector) in head frame, after rotation/alignment. |

---

## 7. WebXR AR mode — *3D objects as audio sources* (Caso A)

The player (`index.html`) adds an **AR** button (`immersive-ar`, passthrough).
Each musician is anchored as a 3D marker (wireframe ball + name sprite) in the
room and bound to its stem; its channel is spatialized at that position.

How it works:

- `renderer` is created with `alpha: true`; on entering AR, `setClearAlpha(0)`
  lets the **passthrough** show through. The 360 sphere is hidden.
- **The 360 is not decoded in AR.** Hiding the sphere does not stop the decoder:
  measured on the Quest, the loop ran at 90 fps with 0.52 ms of JavaScript per
  frame while the browser kept decoding the 4K 360 at its full 24 fps for a
  texture nobody samples — work done off the main thread, which is why it never
  showed in a per-section split and still stalled the passthrough compositor when
  the viewer walked. Entering AR therefore sets `manifest.disableVideo` and
  **reloads the source** (Shaka only reads that flag at `load()`); leaving AR
  reloads with video back on and re-attaches the texture. The audio survives the
  reload because it lives in its own `AdaptationSet` (multichannel Opus in WebM)
  and the `<video>` element stays the Web Audio source, just without a picture
  track. Live reloads at the live edge; VOD saves `currentTime` and returns to it.
  `?arnovideo=0` keeps the old behaviour for an A/B comparison.

  > Verified on the Quest (2026-07-30): the frame rate holds and walking is
  > smooth. Two caveats before trusting it elsewhere. The reload costs a
  > **~1–2 s audio gap** on entering AR — it is fired *after* the session starts,
  > where passthrough is already up and the gap is least annoying. And the
  > audio's **channel count is re-negotiated** on reload: the
  > `MediaElementAudioSourceNode` survives, but a silent fall back to stereo
  > would also look like "smoother", so confirm the stems still come from their
  > own positions.
- `buildARSources()` places one marker per stem (using its azimuth/elevation) and
  calls `engine.bindStemToObject(i, marker)`.
- In AR `restGain` is set to `1` (every source is audible from its real spot;
  distance is handled by the `PannerNode`'s `inverse` model), and zoom boost is
  disabled. The previous spotlight is restored on exit.
- The bed is pushed into the background with `setBedLevel(scene.ar.bedGain)`,
  default `0.35`. It holds the whole concert, which in passthrough competes with
  the real room and buries the anchored musicians. `bedDuck` cannot do this job:
  AR runs at zoom 0, so every stem weighs 0 and the duck never fires. The level
  is restored on exit alongside the spotlight.
- The XR frame loop calls `engine.setRotationFromMatrix4(pose.transform.matrix)`
  (head orientation **and** position) and `engine.update()` (panners follow the
  objects — ready for draggable markers later).

To build a custom AR experience on top of the engine you only need:

```js
engine.bindStemToObject('violin', violinObject3D);   // follows its matrixWorld
engine.setStemPosition(0, 1.2, 0, -2);               // or a fixed world position
// per frame:
engine.setRotationFromMatrix4(camera.matrixWorld.elements);
engine.update();
```

---

## 8. Synchronized close-up videos — DASH multi-track (Caso B)

Per-musician "see them closer" videos are packaged as **extra video tracks in the
same DASH manifest** (one `AdaptationSet` each). Same timeline as the 360 video
and the audio → switching tracks in the player stays **sample-synced**, with no
drift logic.

### Encode (`stream.sh`)

New environment variables (file mode; **not** supported in live capture yet):

| Variable | Default | Description |
|----------|---------|-------------|
| `CLOSEUPS` | — | `;`-separated list of close-up video files, in the order of the stems that have one. Empty → no close-ups (manifest identical to before). |
| `CLOSEUP_SCALE` | `1280:720` | Scale of each close-up (empty = original). |
| `CLOSEUP_VBITRATE` | `2500k` | Video bitrate of each close-up. |

```bash
STEMS="media/sax.mp3;media/tpt.mp3" \
CLOSEUPS="media/sax_cu.mp4;media/tpt_cu.mp4" \
  ./stream.sh vod
```

**Stream/representation layout** in the output manifest:

```
RepresentationID 0          → 360 video        (AdaptationSet id=0)
RepresentationID 1..N       → close-ups        (one AdaptationSet each)
last stream                 → multichannel Opus (FOA + stems)
```

The `-adaptation_sets` string and per-stream video filters/bitrates (`-filter:v:k`,
`-b:v:k`) are built dynamically; with no close-ups the ffmpeg invocation is
equivalent to the original.

### Editor (`editor.html`)

Each musician row (VOD mode) gets a **close-up video** selector. The choice is
saved as `stems[i].closeup` in `scene.json`.

### Server (`server.js`)

The `/api/encode` VOD path collects `scene.stems[*].closeup` (in order) into the
`CLOSEUPS` env var, plus optional `encode.closeupScale` / `encode.closeupVbitrate`.

### Player (`index.html`)

- A **third Shaka instance** (`shakaCloseup`) loads the same manifest and plays
  the selected close-up track onto a **floating plane** in front of the camera
  (works on desktop and in XR; the plane is a child of the camera). It runs with
  `manifest.disableAudio` and pinned to a close-up track, so it neither
  re-downloads the multichannel Opus nor risks decoding the 4K a second time.
- `setupCloseups()` detects the extra video tracks and builds the
  **stem → `RepresentationID`** map (stems with a close-up get `1..N` in order,
  matching `stream.sh`).
- `updateCloseupFocus()` picks the musician from `engine.getFocusedStem()` (look
  + zoom) and `updateCloseupAnim()`, once per rendered frame, brings the panel in
  and out. It is hidden in AR mode.
- The close-up element is kept in sync via `currentTime`/`playbackRate` like the
  audio element. Fully **backward-compatible**: a manifest with no close-up tracks
  does nothing.

> ⚠️ Extra video `AdaptationSet`s change how Shaka chooses the **sphere's** track:
> it picks by bandwidth even with ABR off, and the 4K loses. `pinSphereTrack()`
> has to run after every manifest load. That, the transition, the preload and the
> thresholds are all in **[`closeup-panel.md`](closeup-panel.md)**.

### `scene.json` additions

```jsonc
{
  "stems": [
    { "file": "media/sax.mp3", "name": "SAX", "azimuthDeg": 10, "closeup": "media/sax_cu.mp4" }
  ],
  "encode": { "closeupScale": "1280:720", "closeupVbitrate": "2500k" }
}
```

---

## 9. Change summary (`feat/spatial-core`)

| Area | File | Change |
|------|------|--------|
| Core | `src/audio/ImmersiveAudioEngine.js` | Stems → spatial sources (`pos`/`object3d`); `setStemPosition`, `bindStemToObject`, `unbindStem`, `update`, `setStemRadius`, `getFocusedStem`, `getGazedStem`, `getSpotlightParams`, `get stemCount`. Listener position from the head matrix. Spotlight uses the live head→source direction. |
| Player | `index.html` | WebXR **AR** mode (passthrough, 3D source markers); **close-up** floating plane + 3rd Shaka instance + focus-driven track switching; `renderer` `alpha:true`. |
| Encode | `stream.sh` | Multi-track DASH: `CLOSEUPS`/`CLOSEUP_SCALE`/`CLOSEUP_VBITRATE`, dynamic adaptation sets, per-stream video filters/bitrate. |
| Editor | `editor.html` | Per-musician close-up video selector (VOD). |
| Backend | `server.js` | Pass `CLOSEUPS` (+ optional scale/bitrate) from `scene.json`. |

> **Not yet device-verified:** AR passthrough (Quest `immersive-ar` + transparent
> render) and the multi-track close-up manifest need testing on real hardware.
