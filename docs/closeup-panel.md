# The close-up panel: turning zoom into a flat screen

Zooming into a 360 sphere does not add detail. The 4K equirect gives 10.7 px per
degree; a Quest 3 displays about 19, so we are already at half the panel's
resolution with no zoom at all, and a musician standing 3 m away occupies some
123 px however far you push the FOV. Cropping harder only magnifies those pixels.
A flat plane does remove the equirectangular distortion, but that is shape, not
resolution.

Detail can only come from **somewhere else**: a separate close-up video of that
musician. At 1280×720 filling the panel, that is roughly 8× the detail on the
face you are looking at. This document is about how that panel behaves — how it
arrives, how it leaves, and the two traps that cost a day between them.

The packaging (`stream.sh` env vars, the manifest layout, the editor selector,
the `scene.json` field) is documented in
[`core-api.md` §8](core-api.md#8-synchronized-close-up-videos--dash-multi-track-caso-b).
This file starts where that one ends: at the player.

**Files:** `src/app/player.js` (everything named `closeup*`, plus
`sphereVariants`/`pinSphereTrack` and `makeVideoTexture`),
`tools/closeup-transition.test.mjs`, `tools/sphere-track.test.mjs`.

---

## 1. Four variables, because intent is not mechanics

| Variable | Means |
|----------|-------|
| `closeupWant` | the stem the gaze is asking for (`-1` = nothing) |
| `closeupArmed` | the stem worth **preloading**, shown or not |
| `closeupStem` | the stem whose track is actually **selected** in `shakaCloseup` |
| `closeupFade` | 0..1, how far the panel has come in |

They exist separately because the thing the viewer asks for and the thing the
decoder is doing cannot change at the same instant. `showCloseup()` only writes
down a destination; `selectCloseupTrack()` performs the switch; and
`updateCloseupAnim()`, which runs once per rendered frame, is the only place that
reconciles them.

That last point matters more than it looks. The animation lives in **both render
loops** (desktop and XR) rather than hanging off the focus code, because
`updateCloseupFocus()` only runs when there is a pose, and in AR it answers to
the pin rather than the gaze (§12). If the fade depended on it, losing tracking
would leave the panel frozen at half opacity in front of your face.

---

## 2. The transition

The panel does not appear; it **arrives**. Opacity and scale rise together —
0.92 → 1 over `CLOSEUP_FADE_S` (0.25 s), smoothstepped — so it reads as moving
closer rather than switching on. It leaves the same way, and the material is
created at `opacity: 0` so the very first frame cannot flash at full brightness.

Two rules make the difference between a fade and a cut:

**The panel goes to zero before the content changes.** When the focus jumps from
one musician to another, `updateCloseupAnim()` fades the current one out, and
only at `closeupFade <= 0` does it call `selectCloseupTrack()`. Crossfading the
track underneath a half-opaque panel would show the swap, which is exactly what
the fade is there to hide.

**It will not start entering until the track is running.**

```js
const fresh = closeupEl.readyState >= 3 && !closeupEl.seeking && !closeupEl.paused;
const want  = closeupStem >= 0 && closeupStem === closeupWant;
const target = (want && (closeupFade > 0 || fresh)) ? 1 : 0;
```

`selectVariantTrack` with `clearBuffer`, plus the `currentTime` jump, leaves a
few frames undecoded; without the gate the panel would fade in holding the last
frame of the *previous* musician. Note it only gates the **start**: once
`closeupFade > 0` a rebuffer does not throw the panel out and drag it back in,
which would look worse than a half-second freeze.

The frame clock is capped at 0.1 s. A background tab or a long load would
otherwise turn one enormous `dt` into a jump, and it is better for the
transition to eat a long frame than to skip it.

---

## 3. Two thresholds, because gaze trembles

`getFocusedStem()` returns the stem whose spotlight weight (aim × zoom) is
highest above a floor. With a single floor, a weight hovering around it toggles
the panel every few frames — and a weight *always* hovers, because nobody holds
their head that still.

So there are two: `CLOSEUP_ENTER` (0.35) is needed to bring the panel out,
`CLOSEUP_EXIT` (0.20) is enough to keep it. A musician who clearly beats the
current one takes over directly; otherwise the incumbent stays until it drops
below EXIT.

The regression test sweeps 60 frames with the weight alternating either side of
the old single threshold and requires **zero** dropped frames.

---

## 4. Preloading, and the storm it caused

Segments are 6 s (`encode.seg` in the editor). A track switch with `clearBuffer`
must fetch a whole segment and decode from its keyframe before there is anything
to show — and that wait is most of the delay between deciding to show a panel
and seeing it.

So EXIT does double duty: crossing it does not show anything, but it **arms**
that stem — the track is selected and playing, invisibly, while the viewer is
still zooming in. By the time ENTER is crossed the video is already decoding, and
the fade starts on the same frame, with no new switch and no new seek.

The first version armed straight off `getFocusedStem(CLOSEUP_EXIT)`, and it was
a disaster. The candidate flipped between "stem 0" and "nothing" at 60 Hz, and
every flip was a `pause()`/`play()` on the video element. Worse: a paused element
falls behind the 360, so once the drift passed 0.5 s every re-arm also issued a
`currentTime` jump, flushing the decoder. Measured over 5 s of gaze trembling on
the threshold:

| | without dwell | with dwell |
|---|---|---|
| `play()` calls | **150** | 0 |
| `currentTime` seeks | **5** | 0 |
| track switches | 1 | 0 |

The fix is `CLOSEUP_ARM_DWELL_S` (0.4 s): a candidate must **hold** before it is
armed. Preloading is fine; changing your mind sixty times a second is not.

Three smaller guards came out of the same episode:

- `selectCloseupTrack()` skips `selectVariantTrack` when the variant is already
  active — reselecting costs a `clearBuffer` and a fresh segment download, which
  is precisely what we are trying to save.
- It only seeks when the drift exceeds 0.5 s (same tolerance as the sync loop).
  Seeking when you are already there parks the element in `seeking` and stops the
  picture for nothing.
- `play()` is re-asserted from the render loop instead of waiting up to 250 ms
  for the sync interval. A `currentTime` assignment **aborts a pending `play()`**,
  and the rejection was being swallowed by `.catch(() => {})` — that was the real
  reason the panel so often opened on a frozen frame.

The cost of arming is honest: one 720p decode running unseen while your gaze
rests near a musician. It is not permanent — with no zoom every weight is 0 and
nothing is armed.

---

## 5. The trap: with close-ups, Shaka stops picking the sphere

**Symptom:** the 360 disappeared and a musician's close-up wrapped the whole
scene instead.

With close-ups the manifest carries several video `AdaptationSet`s and **none of
them says "I am the 360"**. Shaka chooses the startup variant by bandwidth *even
with `abr.enabled: false`*, comparing against `defaultBandwidthEstimate` (5
Mbps). The 360 advertises 26 Mbps and does not fit, so it settled for the most
expensive close-up that did — which is why it was reproducibly the *second* one,
not the first: 1.83 Mbps beat 1.70.

Nothing was wrong with the encode; the MPD was correct. The sphere has to be
requested by **which representation it is**, not by what it costs:

```js
const SPHERE_REP = '0';        // stream.sh maps -map 0:v:0 first
function sphereVariants() { /* tracks whose originalVideoId is SPHERE_REP */ }
function pinSphereTrack()  { /* select the tallest of those, if not already active */ }
```

`pinSphereTrack()` must be called **after every manifest load**, and there are
two: `loadDualShaka()` and the reload inside `setVideoDisabled(false)` when
leaving AR. Miss the second and you come back from passthrough wearing a
close-up.

`?maxh` now filters among sphere variants only. A 720p close-up "fits" under any
cap, so `?maxh=1080` was the silliest possible way to end up with the wrong
sphere again.

> **If lighter 360 renditions are ever added**, this whole scheme assumes
> *representation 0 = sphere, 1..N = close-ups in scene order* — `SPHERE_REP` and
> `closeupRepByStem` both rest on it. The rule to move to is "the sphere is what
> is not a close-up", which is already how `sphereVariants()` is written
> internally.

---

## 6. Two more things that were quietly expensive

**The second Shaka instance was downloading the audio.** It loads the same
manifest, so it was pulling the multichannel Opus stream just to throw it away
(the element is muted; the sound comes from the engine). It now runs with
`manifest.disableAudio`, with the same defensive check used for `disableVideo`
elsewhere: if a build ignores the key, say so in the console rather than in the
bandwidth bill.

It is also **pinned to a close-up track at setup**. Left to choose, it could
settle on the 360 — and then the 4K would be decoded *twice*, once for nobody.
That is the same hole that ate the frame budget in AR.

Its buffering config is deliberately looser than the sphere's
(`rebufferingGoal: 0.5`, `bufferingGoal: 4`): this instance is asked to start
quickly, not to survive. A close-up that stalls is almost always hidden, and the
fade already waits for pictures. With the sphere's 2 s cushion inherited, the
panel was late every single time.

**Video textures were being uploaded on every render.** We are on three r128,
which predates `VideoTexture` learning about `requestVideoFrameCallback`: its
`update()` sets `needsUpdate` on *every* render while the element has data. For
24 fps content that is the same 8 Mpx image pushed to the GPU 60 times a second
on desktop and 90 in the headset.

`makeVideoTexture()` returns a plain `THREE.Texture` — which does **not**
self-mark — and drives `needsUpdate` from rVFC, which fires exactly once per
presented frame. `generateMipmaps` is set to `false` explicitly, because a plain
texture defaults to `true` and rebuilding mipmaps for 8 Mpx per frame would be
ruinous. Without rVFC the render loops mark it as before.

On the test machine this took a tab from ~200% CPU to ~120%, together with the
dwell fix and hardware video decode enabled.

---

## 7. Constants

| Constant | Value | Why |
|----------|-------|-----|
| `CLOSEUP_FADE_S` | 0.25 s | Long enough not to jolt, short enough not to lag the gaze. |
| `CLOSEUP_SCALE_IN` | 0.92 | Entry scale. Small: it should read as approaching, not as popping. |
| `CLOSEUP_ENTER` | 0.35 | Spotlight weight needed to bring the panel out. |
| `CLOSEUP_EXIT` | 0.20 | Weight that keeps it, and that arms the preload. |
| `CLOSEUP_ARM_DWELL_S` | 0.4 s | How long a candidate must hold before it is preloaded. |
| `SPHERE_REP` | `'0'` | Representation of the 360 in `stream.sh` manifests. |

---

## 8. Testing without a headset

Two harnesses extract the **real functions out of `player.js`** (by text, so they
cannot drift from what ships) and run them against stubs:

```bash
node tools/closeup-transition.test.mjs   # 44 checks: fade, hysteresis, preload, AR, thrash
node tools/sphere-track.test.mjs         # 7 checks, against the real encoded/manifest.mpd
```

`sphere-track.test.mjs` reads `encoded/manifest.mpd` if it is there, and one of
its checks *reproduces* the bug — it asserts that unpinned selection lands on
something other than the sphere, so the fix cannot be quietly declared unnecessary.

Between them they caught two things that were invisible on screen: the pause/play
storm, and `?maxh` picking a close-up.

---

## 9. What this does not do

- **Live capture.** `stream.sh` ignores `CLOSEUPS` when capturing; close-ups are
  file mode only.
- **Crops in AR.** A crop is a patch of the 360, and in AR the 360 is neither
  drawn nor decoded. Only musicians with a close-up *video* get a panel there.
- **Segment size.** 6 s segments dominate switch latency. Shorter helps, but
  segment length has nothing to do with A/V sync — audio and video share the
  timeline — and shorter segments mean more keyframes, more bitrate for the same
  quality and more decoding, which is a bad trade on a CPU-bound machine.
- **Aim at what you see.** The focus comes from the stem's `azimuthDeg`, so the
  panel appears where the musician *sounds*, which in the current take is not
  always where they are visible.

---

## 10. Crops of the 360

A close-up does not have to be a separate video. In the editor, a musician's
close-up selector offers **✂ crop from the 360** (`"closeup": "crop"` in
`scene.json`; a checkbox in live mode). The encode then cuts a flat view of that
musician out of the 360 itself and packages it as one more close-up track.

**Encoding** (`stream.sh`). Server-side each crop becomes a `CLOSEUPS` entry
`crop:AZ:EL:HFOV`: the stem's calibrated `azimuthDeg`/`elevationDeg`, and a
width of `cropFovDeg`, or `4 × hitDeg` (8° by default → 32°), clamped to
20–90°. `stream.sh` splits the already-decoded video input and runs
`v360=input=e:output=flat` on each branch (`yaw = −azimuthDeg`,
`pitch = elevationDeg`, height from the output aspect), then `cas` (sharpening,
`CROP_SHARPEN`, default 0.5). Nothing is opened twice, so crops also work in
**live capture**, where file close-ups are dropped. Interpolation is
`CROP_INTERP`: `lanc` for files, `line` for capture, to spare the CPU.

Next to the manifest it writes **`closeups.json`**: which track
(RepresentationID) is whose (by stem name) and, for a crop, where it came from.
The player maps tracks by name with it, so it no longer depends on stem order —
which matters in live, where only the crops are encoded. Encodes from before
the file fall back to the old order rule. `upload-s3.sh` publishes it uncached.

**Display** (`placeCloseup()` in `player.js`). A crop is not shown on the
floating panel: it is laid **on the sphere, over the exact patch it was cut
from**: a plane tangent at that direction, `2·D·tan(fov/2)` across at
`D = 99` m, a child of the sphere so the zoom pushes both alike. Because the
picture under it is the same, the fade (`CROP_FADE_S`, 0.6 s, no scale-in)
reads as the image coming into focus, not as something appearing. The crop
keeps the angles of **its encode**: recalibrating a musician in the editor moves
the ring and the selection at once, but the crop only follows after re-encoding.

**Zoom.** A pinch zoom (in or out) is now a fixed-duration tween
(`VR_ZOOM_S`, 0.8 s) on a smootherstep curve, distance and direction together,
instead of an exponential ease that lurched off and then crept.

**Limits.** A crop cannot hold more detail than the 360 it comes from: a 4K
equirect has ~10.7 px per degree, so a 32° crop is ~340 source pixels across,
upscaled to the 1280×720 track. It beats zooming the sphere (more bits per
pixel than the full 360 stream, no texture stretching on the GPU), but real
detail needs a sharper source (an 8K export, or a dedicated camera).

---

## 11. WebCodecs: the close-up follows the 360's clock

With a second `<video>` (and a second Shaka) the close-up has **its own
clock**, and the only levers on it are `currentTime` (a seek: the decoder is
flushed and the picture freezes) and `playbackRate`. So it was always chasing
the 360: late when it appeared, drifting on every stall of either element,
starting over on every seek. The sync loop (`CLOSEUP_SYNC`) narrows that, it
cannot remove it.

`src/app/closeup-wc.js` (`CloseupWC`) removes the second clock. It reads the
same manifest, fetches the close-up track's segments itself, demuxes them with
mp4box.js (loaded on demand from jsDelivr) and decodes them with
`VideoDecoder` — by hardware when offered. Frames come out with their own
timestamps. On every rendered frame the player asks for **the frame due at the
360's media time** (`closeupClock()`: the `mediaTime` of the 360's last frame
from its rVFC, carried forward at most one 360 frame), and that frame goes into
the close-up texture (`texImage2D` takes a `VideoFrame`). A lookup, not a chase:
when the 360 stalls the close-up holds the same frame; when it seeks, the close-up
is rebuilt from the segment holding the new time.

- **Buffering:** segments `AHEAD_S` (2.5 s) past the clock; at most `MAX_AHEAD`
  (4) decoded frames ahead of it — hardware decoders have small output pools and
  stall if all their frames are held. After a jump it decodes from the segment's
  keyframe and feeds the decoder harder until caught up.
- **Entry:** `hasFrame()` is true only once the current frame is within ~80 ms
  of the clock, so the fade (`fresh` in `updateCloseupAnim`) never starts on one
  of the stale frames passed through while catching up.
- **Frames are owned by `CloseupWC`:** `update()` keeps the current frame open
  until it hands out the next one, then closes it.
- **Live:** a dynamic manifest is re-read every 2 s; segments are tracked by
  number, which survives the window sliding.
- **Fallback:** without `VideoDecoder`, if the codec is not supported, or with
  `?cuwc=0`, the second Shaka and the sync loop are used as before. `?cuoffset=ms`
  trims a constant offset (e.g. different encoder delays).
- **Trace:** with `?arperf=1`, `cuErr` is the current frame against the clock.

Measured: on the Quest 3 (`test.html`): VideoDecoder present, H.264 by hardware,
well above 60 fps for a 720p track while the 4K 360 plays, WebGL accepts the
frames. On desktop Chrome (software decode) with `tools/closeup-wc.harness.html`:
ready 4–13 rendered frames after a jump, then never more than 4 ms off.

**Panel placement and zoom.** The panel no longer hangs off the camera: it is
placed in the world when it appears — in the musician's direction, 2.5 m from
the head at that moment, facing it — and stays there while the head turns. It is
placed again the next time it appears, and on entering or leaving VR. A tap on
the close-up (pinch with the ray on it, or a mouse click) zooms a bit more: a
panel grows ×1.6; a crop on the sphere takes the VR zoom from 40 to 62 (or the
desktop FOV ÷1.6). A second tap goes back; hiding the close-up resets it.

---

## 12. In AR: pinch a musician, their close-up appears beside them

In passthrough the musicians are 3D figures standing in the room, and the gaze
plus zoom of VR does not exist: there is no zoom, and the focus is the AR focus
(gaze dwell, or a pinch that pins it). So the close-up follows the **pin**:

- Pinch a musician → they are pinned (spotlight, as before) **and** their
  close-up video fades in. Pinch another one → the panel fades out and comes
  back with theirs. Pinch nothing, or the pinned one again → both go.
- Pinch the panel itself → it grows ×1.6; again → back. (`CLOSEUP_TARGET` is
  999, so `xrSelect` handles it before the lock: otherwise it would pin
  "musician 999".)
- The gaze alone shows nothing and **preloads nothing**. Arming a track keeps
  it decoding unseen, which is the very cost that made AR drop frames; the price
  is that the panel takes a segment fetch plus a keyframe (≈1–2 s with 6 s
  segments) to arrive. The `fresh` gate of §2 still holds it until there is a
  picture.

**Where it goes.** `placeCloseupAR()` stands the panel beside the musician — to
their right as the viewer sees them, `AR_CU_GAP` (0.35 m) from their centre to
the panel's edge — at the height of their sound (the source's `ar.y`), turned
about Y to face the viewer, with no tilt. It is recomputed every frame, so as you
walk round it keeps to the side facing you, and it follows the room while it is
being calibrated. It is `AR_CU_W` (0.8 m) wide, or wider for a far musician: it
never drops below `AR_CU_MIN_DEG` (16°) of view. The geometry stays the 2 m
plane; the size is `closeupBase`, multiplied into the fade's scale.

**The clock.** In AR the 360 has no video track (`setVideoDisabled`), so its
rVFC stops and `__mt` freezes at the last frame before AR. `closeupClock()`
falls back to `videoEl.currentTime` while `videoDisabled`, which is the clock
the audio plays from. The second-Shaka path already compared `currentTime`s.

**Entering and leaving.** `resetCloseup()` runs on both, and now also lets the
track go (`selectCloseupTrack(-1)`): clearing the variables alone left the
transition with nothing to switch, and the last close-up decoding unseen.

**Not yet verified on the headset:** frame rate with a 720p close-up decoding
over passthrough (watch `?arperf=1`), whether the panel's side and size read
well, and the sync tag (`?cusync=1`) in AR.
