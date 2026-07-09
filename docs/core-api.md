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
| `get stemCount` → `number` | Number of spatial sources. |

`ref` accepts a **numeric index** (`0..N-1`, channel order) or the source's
**name** string.

### Spotlight tuning

| Method | Description |
|--------|-------------|
| `setSpotlightParams({ restGain, maxBoost, focusExp, zoomMin, zoomMax })` | Tune the spotlight. `restGain` = stem level at rest (0 = only on zoom). `maxBoost` = extra gain when looked at with max zoom. `focusExp` = focus-cone tightness. `zoomMin/zoomMax` = zoom range that maps to the boost. |
| `getSpotlightParams()` → `object` | Current spotlight params (to save/restore, e.g. on entering/leaving AR). |
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
- `buildARSources()` places one marker per stem (using its azimuth/elevation) and
  calls `engine.bindStemToObject(i, marker)`.
- In AR `restGain` is set to `1` (every source is audible from its real spot;
  distance is handled by the `PannerNode`'s `inverse` model), and zoom boost is
  disabled. The previous spotlight is restored on exit.
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
  (works on desktop and in XR; the plane is a child of the camera).
- `setupCloseups()` detects the extra video tracks and builds the
  **stem → `RepresentationID`** map (stems with a close-up get `1..N` in order,
  matching `stream.sh`).
- Each frame, `updateCloseupFocus()` calls `engine.getFocusedStem()` and shows
  the focused musician's close-up (look + zoom). It's hidden in AR mode.
- The close-up element is kept in sync via `currentTime`/`playbackRate` like the
  audio element. Fully **backward-compatible**: a manifest with no close-up tracks
  does nothing.

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
| Core | `src/audio/ImmersiveAudioEngine.js` | Stems → spatial sources (`pos`/`object3d`); `setStemPosition`, `bindStemToObject`, `unbindStem`, `update`, `setStemRadius`, `getFocusedStem`, `getSpotlightParams`, `get stemCount`. Listener position from the head matrix. Spotlight uses the live head→source direction. |
| Player | `index.html` | WebXR **AR** mode (passthrough, 3D source markers); **close-up** floating plane + 3rd Shaka instance + focus-driven track switching; `renderer` `alpha:true`. |
| Encode | `stream.sh` | Multi-track DASH: `CLOSEUPS`/`CLOSEUP_SCALE`/`CLOSEUP_VBITRATE`, dynamic adaptation sets, per-stream video filters/bitrate. |
| Editor | `editor.html` | Per-musician close-up video selector (VOD). |
| Backend | `server.js` | Pass `CLOSEUPS` (+ optional scale/bitrate) from `scene.json`. |

> **Not yet device-verified:** AR passthrough (Quest `immersive-ar` + transparent
> render) and the multi-track close-up manifest need testing on real hardware.
