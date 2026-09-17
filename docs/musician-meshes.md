# Musician meshes in AR

In AR the passthrough replaces the 360 sphere, so a musician has nothing to be
seen *as*. Until now each one was a wireframe sphere: enough to prove the audio
was anchored to the room, not enough to show anybody. This feature puts a **3D
model (`.glb`) per musician** where that sphere was, chosen and tuned from the
editor, stored in `scene.json` next to the stem it represents.

The audio does not change. The mesh is decoration hung off a marker that was
already placed and already bound to the engine, so a scene with meshes sounds
exactly like the same scene without them. That property is worth keeping: it is
what makes `?nomesh=1` a real diagnostic and not a placebo.

**Files:** `src/app/mesh-fit.js` (shared loading + fitting), `src/app/player.js`
(`attachMeshTo`, `makeFocusRing`, `ensureARLights`), `editor.html` (selector,
upload, 3D preview), `server.js` (`/api/meshes`, `/api/mesh`), `meshes/`.

---

## 1. The data model

A `mesh` lives on the stem, because it is a property of *that* musician:

```jsonc
"stems": [
  { "name": "DR",  "mesh": "meshes/drums.glb" },              // just a file
  { "name": "SAX", "mesh": { "url": "meshes/sax.glb",         // …or tuned
                             "heightM": 1.4,                   // metres, default 1.7
                             "yawDeg": 45,                     // default 0
                             "zUp": false } }                  // default false
],
"ar": { "mesh": "meshes/generic.glb" }        // fallback for every stem without one
```

The bare string and the object are the same thing at two levels of detail. The
editor writes the object **only** once you touch height, yaw or Z-up
(`editor.html:646`), so a scene does not fill up with `{"heightM":1.7,"yawDeg":0}`
entries that say nothing — those two defaults belong to the player, and writing
them down would freeze today's default into every old scene.

Both sides read the field through `MeshFit.spec()` (`src/app/mesh-fit.js:47`), so
neither has to know which of the two forms it got.

---

## 2. Sizing — what the system does, and what you do

### The system normalises by height

`MeshFit.fit()` measures the model's bounding box and scales it so its **height
is exactly `heightM`** (default 1.7 m) — `src/app/mesh-fit.js:99`.

This is not a convenience, it is the difference between the feature working and
not. glTF 2.0 nominally measures in metres, but library and marketplace assets
routinely ignore that: the same figure arrives at 1.7, at 170 or at 0.017. Placed
as-is, half the models are invisible specks and the other half are a black wall
across the room — which inside the headset does not read as "bad mesh", it reads
as "passthrough is broken".

So you never type a scale factor. **You type metres**, and 1.70 means 1.70 m tall
standing in the room, whatever unit the file was authored in. That is the only
number that means anything when the model is seen next to real people in
passthrough.

### You override it per musician

In the editor, with a musician selected (`editor.html:231`):

| Control | Writes | Blank / default |
|---|---|---|
| **Mesh height m** | `heightM` | blank → the player's 1.70 |
| **Yaw °** | `yawDeg` | blank → 0 (also set by dragging the preview sideways) |
| **Z-up** | `zUp` | off |

A drum kit is 1.1 m, a double bass 1.9 m, a standing player 1.75 m. The preview
puts a 1.70 m reference figure beside the model, which is what turns "looks big"
into "that is two and a half metres tall".

**`Mesh height m` is not `Height m`.** The two sit in the same card and measure
different things: `Height m` (and `Elevation °`, the same number in degrees) is
*where the musician is heard*, while `Mesh height m` is *how tall the figure is*.
They are independent because the model is not placed at the audio point — it hangs
from it down to the floor. Raising the elevation moves the sound and leaves the
figure standing on the ground; raising the mesh height grows the figure and leaves
the sound where it was. A seated drummer is a negative elevation with a 1.1 m
mesh, and neither number implies the other.

### Two guards you cannot switch off

- **Footprint clamp.** If the model ends up wider than `3 × heightM`, it is shrunk
  to fit (`src/app/mesh-fit.js:120`). Normalising height *alone* lets impossible
  proportions through: a 45 × 1.7 × 30 slab keeps scale 1 — its height was already
  right — and shows up as a 45 m wall two steps from your face. That is not
  hypothetical, it is what the first test figure did. The limit is deliberately
  loose: a drum kit is legitimately wider than tall, and the point is not to
  impose a human silhouette but that nothing can black out the room.
- **Unmeasurable box → left alone.** Empty geometry, a Draco-compressed file
  without its decoder, a node with no mesh: the height comes out 0 and any scale
  derived from it is absurd. The model is left at scale 1 and a warning is logged
  and shown in the editor (`src/app/mesh-fit.js:100`).

### The fit, in order

Three nodes, because a single `Object3D` applies scale, then rotation, then
translation — and the order needed here is *rotate to Y-up, recentre, scale, yaw*:

```
wrap   scale = k, rotation.y = yaw     ← spins in place
 └ axis  rotation.x = −90° if zUp, position = −centre, feet on the floor
    └ obj  the model, exactly as the file has it
```

`fit()` returns the **wrapper** and never touches the model's own transform: a GLB
may carry one on its root node, and overwriting rather than composing with it
would silently undo part of the file. `zUp` is applied *before* measuring — on a
Z-up export the height runs along Z, so measuring first would scale by the wrong
dimension and the model would come out lying down *and* the wrong size.

What it measured ends up in `wrap.userData.fit` (`scale`, `heightM`, `spanM`,
`raw`, `warnings`), which is what the editor prints under the preview.

### Alternatives considered

| Alternative | Why not (for now) |
|---|---|
| **Raw scale factor** (`"scale": 2.5`, no normalisation) | It is the honest option for someone who already knows their asset is correct in metres, and it is ~5 lines in `spec()` + `fit()`. Left out because it is the wrong default: it requires knowing the file's unit, which is exactly the thing nobody can see. Worth adding as an *extra* field (`"scale"` overriding `heightM`) the day an asset must be shown at its authored size. |
| **Trust the file's units** | glTF says metres; assets disagree. Trusting them means the failure lands inside the headset. |
| **Guess the unit** (if the box is ~100× too big, assume cm) | A heuristic that is right most of the time and silently wrong the rest — and its failure mode is the 170 m wall again. Explicit metres cost one number and never surprise. |
| **A separate `meshes.json` registry** keyed by file | Would let one model carry its own height everywhere it is used. But height is a property of *this musician in this scene* (the same figure is a seated drummer here and a standing singer there), and one more file to keep in sync with `scene.json` is one more file to get out of sync. |
| **Fit inside the player only**, editor previews with its own code | Rejected on principle: "it looked fine in the editor" is the one failure this feature cannot have. Hence `mesh-fit.js` as a plain `window.MeshFit` script — the player is ESM but already takes THREE as a global, and the editor is one inline `<script>`; a module here would buy a build step or a second copy of the fit. |

---

## 3. The editor workflow

Everything about a mesh lives in the **AR room · passthrough (metres)** card, under
a collapsible **3D model (AR)** section, next to the musician's position in metres.
It is deliberately not in the 360 sphere card: a mesh is only ever seen in
passthrough, and having half of AR by the radar and half by the room views meant
jumping between two cards to place one musician. The 360 card is back to the five
fields that describe a direction on the sphere.

The section header carries the selected musician's name, because the block is no
longer inside the selection panel, and its fields grey out — rather than
disappear — when nothing is selected: a card that shrinks every time you deselect
moves the room views under the cursor, and the first drag of the day is lost.

1. Select a musician.
2. **Upload .glb…** — or pick one already on the server from the dropdown. Uploading
   with a musician selected assigns the mesh to them: that is the whole gesture,
   and making you return to the dropdown afterwards would be busywork.
3. Open **Preview** — collapsed by default, since it is a 340 px canvas that pushes
   the rest of the page down. It shows the model as the headset will place it, seen
   from where the audience will be, with the 1.70 m reference figure alongside. Drag
   sideways to turn it (writes `Yaw`), up and down to change the viewing angle.
4. Adjust **Mesh height m** if the proportions are wrong. Warnings from the fit
   appear under the preview.
5. Save the scene as usual.

Replacing a `.glb` with a corrected version **under the same name** works: the
upload invalidates `MeshFit`'s in-page cache for that URL and drops the preview's
model (`editor.html:679`), and the server sends `.glb` with `no-cache`
(`server.js:682`). Seeing the old model after uploading the fix would break the
entire tuning loop.

---

## 4. Server

| Route | Method | Description |
|---|---|---|
| `/api/meshes` | GET | List `meshes/` — `{ file, name, size }`, `.glb` only |
| `/api/mesh?name=…` | POST | Raw body upload, max 64 MB |

Meshes live in `meshes/`, not `media/`: they are not take material, they are the
representation of a musician, chosen at a different moment and listed separately.

The upload is a raw body, not multipart — it is one file, and hand-parsing
multipart (or taking a dependency) to wrap it buys nothing. Notes on the
implementation (`server.js:190`), each of which is a bug that was there:

- The name is `basename`-d and stripped to `[\w.-]` before touching the disk, so
  `?name=../../evil.glb` lands in `meshes/evil.glb`. **Verified.**
- Written to `dest.part` and renamed at the end: the editor lists this directory,
  and a half-written file must not appear in it.
- The body is checked for the `glTF` magic before the rename — a renamed `.zip` is
  rejected with 415 instead of failing later inside the headset, which is the
  worst place to find out. **Verified.**
- A failing `WriteStream` emits `error`, and with no listener that is not a
  rejected promise but a throw that takes the whole process down: the player's
  server would die, for everyone, because of an oversized upload.
- Over the limit, the request is drained rather than destroyed, so the 413 body
  actually reaches the browser. **Verified.**

`.glb`/`.gltf` are served as `model/gltf-binary` / `model/gltf+json` and grouped
with the *code* for caching (no-cache), not with the media segments.

`.gitignore` keeps `meshes/*` out of the repo except `test-figure.glb`: the assets
are big and per-venue, but one known-good file must travel with the code so a
headset can always be checked against a mesh that is certain to be valid.

---

## 5. In the headset

`buildARSources()` places and binds the marker exactly as before, and *then*
calls `attachMeshTo()` (`src/app/player.js:1796`). The mesh is hung off the marker
and dropped to the floor by `-p[1]` — the stem's point is where the sound *is*
(at `AR_HEIGHT`, or the `ar.y` the scene carries), while the model represents
somebody standing on the floor. Hanging it downward instead of moving the marker
is what keeps the panner unaware that a figure was added at all.

- **Loading is asynchronous on purpose.** The session starts with the wireframe
  spheres and each musician appears as their file finishes downloading, instead of
  everyone waiting for the largest one.
- **A file that fails to load leaves that musician as a sphere.** They can still be
  heard and still be focused; a bad file must not cost more than its own model.
- **Focus is shown by an amber ring on the floor**, not by tinting the model: a GLB
  brings its own materials, and repainting them wrecks the musician's texture and
  may not even be visible. The ring sits 1 cm off the floor — at y=0 it is coplanar
  with the model's base and the two fight for the same pixel, which flickers badly
  when you move your head.
- **Lights are added with the first mesh and removed with the meshes**
  (`ensureARLights`). The player had none and needed none: everything else is
  `MeshBasicMaterial`. A PBR material with no lights renders **black** — black lumps
  in the middle of the passthrough. A hemisphere light (no face left dark; the room
  is real and its lighting unknown) plus a soft directional key for volume. No
  shadows: they cost, and here they add nothing.
- **An environment, because lights alone do not light a metal** (`MeshFit.environment`).
  A metallic/roughness material has almost no diffuse response: nearly all of it is
  reflection, so with nothing to reflect it stays black however many lights are in
  the scene. That is why an unlit model came back fine from the partner's test and
  one with metal/roughness maps came back a silhouette. The environment is painted
  in code — a studio gradient with three soft lamps — so there is no asset to
  download onto a headset or to keep next to the scene, and it is built through
  PMREM **outside** any XR session (warmed at scene load when the scene declares
  meshes) rather than mid-session against the XR framebuffer. The hemisphere light
  drops to 0.5 when it comes in, since the environment now does the ambient work.
- **The renderer writes sRGB** (`MeshFit.setupRenderer`). three lights in linear
  light and r128 defaults to writing that linear value raw, which a display reads
  as sRGB: mid grey lands at 0.21 instead of 0.5, and a GLB looks nothing like it
  did in Blender, since GLTFLoader decodes its colour textures on the way in and
  nothing encoded them on the way out. It is a renderer-wide switch, so every
  texture that already holds sRGB pixels has to say so (`MeshFit.srgb`: the 360
  video, the close-up, the text canvases) or it gets encoded without ever having
  been decoded — measured, an unmarked grey 128 comes out 188. Same for colours
  written as hex literals (`MeshFit.colour`). The one exception is
  `scene.background`, which three paints as a clear colour straight into the
  framebuffer, bypassing the shader: converting that one turned the editor's
  background from 10,14,20 into 1,1,2.
- **`?nomesh=1`** brings the wireframe spheres back, to separate a mesh problem
  from a passthrough problem without editing the scene and re-entering.

While it was being wired up, a second bug surfaced and was fixed: the player's
`scene.json` reader enumerated stem fields by hand and dropped `ar` and `gainDb`
(`src/app/player.js:719`). That is what the partner saw as "it still draws the
circle" — every musician fell back to the 1.6 m sphere. It now spreads the whole
stem and normalises only what needs normalising, so a field the editor adds
tomorrow survives by default.

---

## 6. State

**Verified on this machine (2026-08-19):** all files parse; `/api/meshes` lists;
`.glb` is served with the right type and `no-cache`; upload accepts a good file,
rejects a renamed non-GLB (415), rejects a bad name (400) and contains traversal.

**Not yet verified in the headset:** the meshes themselves — placement, scale
against real people, the focus ring, the lighting, and frame cost with the two
heavy models (3.9 MB guitarist, 6.1 MB drum kit).

**Pending:**

- **Animation.** The guitarist GLB carries clips that nothing plays yet. Note that
  `attachMeshTo` uses a plain `clone(true)`, which does **not** carry a skinned
  mesh's skeleton — animating means moving to `SkeletonUtils.clone` and an
  `AnimationMixer` driven from the render loop.
- **S3 publishing — not needed as things are deployed today.** Publishing sends
  the *media* to S3: `upload-s3.sh` syncs `encoded/`, and the player is pointed at
  it with `?src=<manifest URL>`. The player **page** is still served by
  `server.js`, and `scene.json`'s mesh paths are relative, so they resolve against
  that same origin — the meshes are served by the machine that serves the page,
  and nothing about S3 touches them. (Confirmed 2026-08-19.)

  It becomes real work the day the page itself is hosted in the bucket, and then
  it is more than one more sync line: the meshes need their own `Content-Type`
  and a *short* cache-control (the segments' immutable year is exactly wrong for
  a file replaced under the same name while a scene is being tuned), and the
  bucket needs **CORS** — `GLTFLoader` fetches by XHR, so a cross-origin GLB
  without CORS headers fails where a `<video>` source would not.

- **Optional raw `scale`** as described above, if an asset ever has to be shown at
  its authored size.
