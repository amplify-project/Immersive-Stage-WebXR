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
`updateCloseupFocus()` returns early in AR and only runs when there is a pose. If
the fade depended on it, entering passthrough would leave the panel frozen at
half opacity in front of your face.

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
node tools/closeup-transition.test.mjs   # 38 checks: fade, hysteresis, preload, AR, thrash
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
- **Anything in AR.** The panel is hidden in passthrough, where you walk up to
  the real object instead.
- **Segment size.** 6 s segments dominate switch latency. Shorter helps, but
  segment length has nothing to do with A/V sync — audio and video share the
  timeline — and shorter segments mean more keyframes, more bitrate for the same
  quality and more decoding, which is a bad trade on a CPU-bound machine.
- **Aim at what you see.** The focus comes from the stem's `azimuthDeg`, so the
  panel appears where the musician *sounds*, which in the current take is not
  always where they are visible.
