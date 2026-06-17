# Partner handoff — two pending use cases

This document hands two features off to partner teams, building on what already
exists in `feat/spatial-core`. Both are **scaffolded and documented but not
finished** (and not yet device-verified). For the engine API and the existing
scaffolding see **[`core-api.md`](core-api.md)** (sections 7 and 8).

- **Case A** — WebXR AR with 3D objects as audio sources (with real-world tracking).
- **Case B** — Zoom that shows the 360 video at higher quality.

Each case below lists: what already works, what's missing, and the exact
integration points in the code.

---

## Case A — AR: 3D objects as audio sources (tracking)

In AR the passthrough replaces the 360 sphere, so the **equirectangular video is
not needed** — only the multichannel audio (FOA bed + per-musician stems) is
used. This case is therefore *lighter* than the regular player: no video encode,
no GPU for video, no A/V drift to manage.

### What already works

`index.html` (`enterAR()` / `buildARSources()`) + the engine:

- `immersive-ar` session with passthrough (`renderer.setClearAlpha(0)`, 360
  sphere hidden).
- One 3D marker per musician (wireframe ball + name label), placed **around the
  user by azimuth/elevation** at a fixed radius (`AR_RADIUS = 1.6 m`,
  `AR_HEIGHT = 1.3 m`).
- Each marker bound to its stem: `engine.bindStemToObject(i, marker)` +
  `engine.update()` per frame → the HRTF `PannerNode` follows the object, with
  natural distance attenuation.
- Head moves through the room (`engine.setRotationFromMatrix4(pose.transform.matrix)`).

The audio engine is already generic: `bindStemToObject` / `update` follow **any**
`Object3D`, so the partner only works in Three.js / WebXR placing objects — the
spatial audio comes for free.

### What's missing (partner work)

- **Anchoring to the real world.** Markers currently float at fixed positions
  *relative to the user*; they are not *tracked* to the room. Add WebXR
  **hit-test** + **anchors** (and/or **plane / mesh detection**) so each musician
  sticks to a real surface and persists as the user moves.
- **Interactive placement.** Drag / position the markers (the code already notes
  "ready for draggable markers later"). `hand-tracking` is requested as an
  `optionalFeature` but is **not used** yet.
- **Scene persistence** of the AR layout across sessions.

### Audio-only authoring in the editor (recommended design)

The editor must let an operator author an AR scene **without a 360 video source**.
Recommended approach: **a toggle "Audio only (AR · no 360 video)", not a third
tab.** Rationale: the editor's two existing modes (`VOD` / `LIVE`) describe the
**source** of the material; "AR without video" is **orthogonal** to that (you may
want a live AR concert *or* an AR scene from files). A third tab would duplicate
all the source logic; a checkbox coexists with VOD/LIVE instead.

When the toggle is on:

- **Hide** the video source picker (`vodSources` video input / `lvDevice` +
  `lvUrl` in live). It is unused in AR.
- **Keep** the sections AR does use, unchanged: *Musicians / stems*,
  *3D placement (top-down)*, *Spotlight*, *Encode*.
- Persist a flag in the scene, e.g. `scene.audioOnly: true`.

### Layers to touch (full chain)

| Layer | Change |
|-------|--------|
| `editor.html` | "Audio only" toggle; when on, hide the video source and persist `scene.audioOnly`. |
| `server.js` | Propagate the flag to `stream.sh` (e.g. `AUDIO_ONLY=1` in the job env). |
| `stream.sh` | Audio-only branch: omit `-map 0:v:0`, `VENC` and the close-ups; emit **only** the multichannel Opus AdaptationSet. (Today the video map is hardcoded at lines ~412 / ~467.) |
| `index.html` (player) | Detect a manifest with no video track → go straight to AR (no 360 sphere, no close-ups). |

### Engine hooks the partner uses

```js
engine.bindStemToObject('violin', violinObject3D);   // follows its matrixWorld
engine.setStemPosition(0, 1.2, 0, -2);               // or a fixed world position
// per frame:
engine.setRotationFromMatrix4(camera.matrixWorld.elements);
engine.update();
```

---

## Case B — Zoom showing the video at higher quality

Two things must be kept separate here; the literal goal ("on zoom, see the video
at higher quality") is **not solved yet**.

### What already works

- **Acoustic zoom** (`getZoomFactor()` → `engine.setZoomByFactor`): works, but
  only affects **audio** (the per-musician spotlight).
- **Close-ups (Case B scaffolding, see `core-api.md` §8):** extra video tracks in
  the same DASH manifest; focusing a musician shows their video on a floating
  plane. That gives "see them closer", but it is a **separate video**, not the
  360 video at higher resolution.
- The 360 video is encoded as a **single representation** (`RepresentationID 0`,
  one bitrate) with **ABR disabled** in Shaka (`abr.enabled = false`). So zooming
  into the equirect just **upscales fixed pixels** → it looks worse.

### Chosen approach — per-musician ROI crops ("partial 8K")

**Key principle: the 8K never reaches the device.** It lives only server-side, at
encode time. The device always decodes at most the 4K 360 + **one small crop** —
which is exactly what the existing close-up mechanism already does. So this is an
*improvement of the close-ups*, not a new pipeline.

#### Why ROI crops beat a higher-resolution 360

The musician looks bad on zoom because of **angular density**, not screen
resolution:

- 4K 360 = 3840 / 360 ≈ **10.7 px/degree**. Zooming to ~30° FOV magnifies it ~3× → blurry.
- 8K 360 = **21.3 px/degree** — better, but decoding an 8K equirect on Quest is
  not viable (hardware decoder limit).
- A **dedicated crop** of the musician, encoded at normal resolution (e.g.
  1920×1080) but covering only ~30° FOV = **~64 px/degree**. Much sharper, **and**
  it is a small video the device decodes easily.

So we don't need the device to see 8K — we need **high angular density only where
the musician is**, obtained by cropping the 8K master server-side. Source for the
crops: **the 8K 360 master** (no dedicated close-up cameras).

#### Pipeline (extends the close-ups, not replacing them)

Already in place: per-musician crop → extra video tracks in the **same DASH
manifest** (`CLOSEUPS` in `stream.sh`), switched by `getFocusedStem()`, sharing
the timeline (zero drift). What the partner changes is the **source** and the
**display**:

1. **Source (encode, `stream.sh`).** Generate each crop from the highest-resolution
   master: 8K 360 → `v360`/`crop` to a viewport centered on the musician's azimuth
   (from `scene.json`), encoded at ~1080p → high angular density, cheap decode.
   Today the close-up scale defaults to `1280:720` and the source is a separate
   file; here it is a viewport extracted from the 8K equirect.
2. **Display (player, `index.html`).** Today the close-up is a **separate floating
   plane**. To make the musician *sharper in place* on zoom, the crop must
   **replace the 360 region at its position**: place the crop quad on the sphere at
   the musician's azimuth and **cross-fade** from the blurry equirect to the crisp
   crop driven by `getZoomFactor()`. No popping — that region just becomes sharp as
   you approach.

#### One crop decoded, N crops available

"One crop" means **how many are decoded at once, not how many exist.** The
manifest carries **N crop tracks** (one per musician, or per region); the device
decodes **only the focused one** (`getFocusedStem()`) at a time. This is enough
because the user **zooms into one target at a time** — the other musicians stay
visible in the underlying 4K 360 (normal density is fine for anything not zoomed).

Two cases to cover:

- **Several musicians together in the zoomed viewport.** A crop need not be "1
  musician = 1 crop": define the crop **region / FOV to cover a group** (e.g. a
  whole brass section in one crop). This is an authoring choice in the editor —
  crops can be **per region, not necessarily per individual musician**.
- **Fast panning between musicians.** During the track swap, fall back to the 360
  (there is always an image, no pop); the prefetch of the focused musician's crop
  avoids the stall.

#### What makes it fluid (the critical part)

- **Decoder budget.** Quest has few simultaneous hardware decoders. Rule:
  **4K (360) + 1 crop = 2 decoders.** Never decode all N crops at once — switch the
  single close-up element to the focused musician's/region's track (as
  `shakaCloseup` already does).
- **Prefetch.** Musician positions are **known** (azimuth in `scene.json`), so
  prebuffer the crop of the musician you are starting to look at **before** the
  zoom completes → no stall on switch.
- **No drift.** Same manifest → same timeline (already the design).
- **Zoom-driven transition.** `getZoomFactor()` + `getFocusedStem()` already give
  "who you look at and how much" → drive the cross-fade opacity.

#### Alternative to avoid

**Tiled / viewport-adaptive 360 (MPEG-OMAF style):** split the 8K into tiles,
stream only the viewport in high quality. General (works looking anywhere) but far
heavier for a partner — tiled encoder, gaze-based tile selection, client-side
stitching, and Shaka/Quest don't support it out of the box. **Unnecessary here**
because the musicians are at fixed, known positions; ROI crops cover the real case
at a fraction of the effort.

### Integration points

| Layer | Where |
|-------|-------|
| Encode | `stream.sh` — crop each ROI from the 8K master (`v360`/`crop` at the musician azimuth) into the existing `CLOSEUPS` tracks. |
| Player | `getZoomFactor()` + `getFocusedStem()` drive the cross-fade; move the close-up from a floating plane to a sphere-aligned quad at the musician azimuth. |
| Player | `setupCloseups()` / `closeupRepByStem` and `shakaCloseup` are the multi-track + single-decoder pattern to build on. |
