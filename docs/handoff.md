# Partner handoff — three pending use cases

This document hands three features off to partner teams, building on what already
exists in `feat/spatial-core`. All are **scaffolded and documented but not
finished** (and not yet device-verified). For the engine API and the existing
scaffolding see **[`core-api.md`](core-api.md)** (sections 7 and 8).

- **Case A** — WebXR AR with 3D objects as audio sources (with real-world tracking).
- **Case B** — Zoom that shows the 360 video at higher quality.
- **Case C** — Interface contract for an external, camera-based tracking service.

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
  sphere hidden **and no longer decoded** — entering AR reloads the source with
  `manifest.disableVideo`, so the paragraph above is now true at runtime and not
  only on paper; see [`core-api.md`](core-api.md) §7).
- One 3D marker per musician (wireframe ball + name label), placed at its **room
  point in metres** — `stem.ar = {x, y, z}` in `scene.json`, authored in the
  editor's *AR room* panel, and the same frame the cameras will publish into.
  A stem without that block falls back to its **360 direction projected onto a
  sphere** (`AR_RADIUS = 1.6 m`, `AR_HEIGHT = 1.3 m`, `arPosition()` in
  `player.js`): a scene that was never placed still sounds like something, with
  everyone at the same invented distance.

  > The 360 sphere and the room are **not the same model**. In VR the listener
  > sits at the centre and a stem is a *direction* — distance is not heard,
  > because an unanchored source always rides `_stemRadius`. In AR the spectator
  > walks among the sources, so distance and height above the floor are heard and
  > have to be real. That is why placement is authored twice, and why `ar` is a
  > separate block rather than a reinterpretation of `azimuthDeg`/`elevationDeg`.
- Each marker bound to its stem: `engine.bindStemToObject(i, marker)` +
  `engine.update()` per frame → the HRTF `PannerNode` follows the object, with
  natural distance attenuation.
- Head moves through the room (`engine.setRotationFromMatrix4(pose.transform.matrix)`).
- **Focus by sustained gaze.** No zoom exists in AR, so the musician being
  attended to is the one held near the centre of view for `dwellMs`
  (`engine.getGazedStem` + the dwell/hysteresis in `updateARFocus`). His marker
  turns amber, and the index travels in the telemetry `f` field, in the same
  room frame as everything else. Tunable per venue in `scene.json` → `ar.focus`.
- The FOA bed drops to `scene.json` → `ar.bedGain` (default `0.35`) via
  `engine.setBedLevel()`, and back to its old level on exit. The bed is the whole
  concert, musicians included: at full level it competes with the real room and
  buries the anchored sources. Note this is *not* the spotlight's `bedDuck`, which
  is driven by gaze × zoom and never fires in AR (zoom is 0 there).

- **Manual room alignment.** All the markers hang from a single `roomGroup`,
  whose transform *is* the room→XR alignment. See below.

The audio engine is already generic: `bindStemToObject` / `update` follow **any**
`Object3D`, so the partner only works in Three.js / WebXR placing objects — the
spatial audio comes for free.

### Room alignment: `roomGroup`

`local-floor` puts the origin wherever each user started their session, so the
same musician lands somewhere different for every spectator. The goal is not to
register the room physically — it is that everyone shares the same layout.

The correction has only **4 degrees of freedom** (yaw + XZ translation): the floor
is already at y=0 and the IMU aligns the vertical. Solving 6 DoF would tilt the
room a few degrees and sound wrong with no error message. Those three numbers are
`roomGroup.position` / `roomGroup.rotation.y`.

Nothing is computed today: holding the **grip**, the left stick translates and the
right stick rotates the room until the wireframe markers sit on the real
musicians (pressing a stick resets). Rotation is applied **around the head**, not
around the group origin — otherwise the scene orbits an arbitrary point and
alignment is impossible. Releasing the grip stores the three numbers in
`localStorage` under `arCalib:<ar.venue|default>`, so the next session starts
aligned. Tolerance is generous: the ear resolves ~5-10° off-axis, ~40 cm at 3 m.

This is the same mechanism Case C drives later — the cameras just set those three
numbers instead of the hand, and everything downstream is unchanged.

### What's missing (partner work)

- **Anchoring to the real world.** Beyond the manual alignment above, the markers
  are not *tracked* to the room. Add WebXR **hit-test** + **anchors** (and/or
  **plane / mesh detection**) so each musician sticks to a real surface. If
  instead the positions come from an external camera rig, see **Case C**.
- **Interactive placement.** Drag / position *individual* markers (`roomGroup`
  moves them all as a block). `hand-tracking` is requested as an `optionalFeature`
  but is **not used** yet.
- **Scene persistence** of the per-musician AR layout (the alignment itself
  already persists).

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

---

## Case C — External tracking service (camera-based positions)

A partner rig detects people and musicians with cameras and wants to drive the
AR audio with those positions. The audio engine is ready for this: an *anchored*
source is measured against the head, so walking closer makes it louder. What is
missing is a **downlink** (telemetry is player→relay only today) and, above all,
an agreed contract. This section is that contract.

### Split the problem in two — only one half is ours to receive

**Musician positions: yes, send them.** They are the audio sources. The player
feeds them straight into `engine.setStemPosition()`.

**Spectator head pose: no, do not send it.** The headset already localizes itself
with inside-out tracking, to millimetres and a few milliseconds. Driving the head
from cameras (tens of ms of latency, plus jitter) makes the sound field swim as
the user turns. Head pose stays with WebXR. The cameras' view of the spectator is
still useful — see the calibration trick below — but never as the listener pose.

### The only hard problem: one common origin

WebXR's `local-floor` origin is wherever that user started their session. It is
arbitrary and different for every headset and every run. The cameras work in a
fixed room frame. So each headset needs a rigid transform **T: room → that
headset's XR frame**.

`T` can be estimated from data we *already publish*. The cameras see the
spectator's position in room coordinates; the headset publishes its own position
`p` in XR coordinates over `/consume` (see [`telemetry.md`](telemetry.md)).
Correlating the two trajectories for a few seconds solves `T`. Better still, both
frames share the vertical — the headset's IMU aligns Y with gravity — so `T` has
only **4 degrees of freedom** (yaw + translation), not 6. That is robust to solve
and easy to sanity-check.

**Therefore the natural division of labour:** the tracking service consumes
`/consume`, matches each detected person to a `playerId`, estimates `T` per
spectator, and sends musician positions **already expressed in that headset's XR
frame**. The player then knows nothing about cameras or calibration — the numbers
it receives are already its own.

### Message contract (service → player)

```jsonc
{ "type": "sources", "playerId": "quest-1", "t": 1719480000123,   // ms, service clock
  "sources": [
    { "id": "violin",  "p": [1.2, 1.1, -2.3], "conf": 0.94, "track": 17 },
    { "id": "cello",   "p": [-0.8, 1.0, -2.1], "conf": 0.41, "track": 22 }
  ] }
```

- `id` matches `scene.json` → `stems[].name`, so the player resolves it by name:
  `engine.setStemPosition(id, ...p)`.
- `p` is in the **target headset's XR frame**, i.e. `T` already applied.
- `conf` lets the player ignore or hold a source instead of teleporting it.
- `track` is the tracker's identity, so an id swap is visible rather than silent.

### Axes, units, and the bug that will bite you

WebXR/Three.js is **right-handed, Y up, −Z forward, metres**. Unity is
**left-handed, Z forward**. Converting between them means negating one axis
(usually Z), and getting it wrong produces a mirrored scene with **no error
message** — musicians appear and sound on the wrong side. State the convention on
both ends, and test with one deliberately asymmetric source before trusting it.

### Failure modes to design for

| Risk | Consequence | Mitigation |
|---|---|---|
| Occlusion → identity swap | A musician teleports across the room | Send `track` + `conf`; the player holds the last good position below a confidence floor |
| XR frame drifts or relocalizes | `T` silently goes stale | Re-estimate `T` continuously, not once at startup |
| Network jitter at 10–20 Hz | Zipper noise on the `PannerNode` | Already handled: `sources.smoothSec` in `scene.json` ramps anchored moves |
| Sending head pose from cameras | Sound field swims when turning | Don't. WebXR owns head pose |

### Latency budget

Source positions tolerate **~100 ms** end to end; musicians move slowly and
`smoothSec` absorbs the rest. Head pose tolerates **none** — which is precisely
why it never leaves the headset.

### What we build on this side

- A **downlink** on the relay: a `sources` frame addressed to a `playerId`,
  delivered to that player over its existing socket (or a second one). The wire
  protocol in [`telemetry.md`](telemetry.md) is unchanged for everything else.
- A thin adapter in the player: on `sources`, call `engine.setStemPosition(id, p)`
  per source. Nothing in the audio engine changes.

### Engine hooks the partner's integration uses

```js
// One anchored source, moved from outside. Ramped by `sources.smoothSec`.
engine.setStemPosition('violin', 1.2, 1.1, -2.3);

// Attenuation curve for the room (scene.json → `sources`, or live):
engine.setSourceParams({ distanceModel: 'inverse', refDistance: 1,
                         rolloffFactor: 1, maxDistance: 12, smoothSec: 0.08 });

// Releasing an anchor returns the source to the head-relative sphere:
engine.unbindStem('violin');
```
| Player | `setupCloseups()` / `closeupRepByStem` and `shakaCloseup` are the multi-track + single-decoder pattern to build on. |
