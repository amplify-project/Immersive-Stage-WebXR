# Live scene setup — editor walkthrough

From cold hardware to a 360° stream with ambisonic audio and per-musician stems.
Every field of the editor's **LIVE** panel, in the order you fill it, and what each
one breaks when it is wrong.

Companion documents: **[`produccion-hardware.md`](produccion-hardware.md)** (machine,
network and S3 spec) and **[`core-api.md`](core-api.md)** (engine API).

> The editor runs on the **capture machine** — the one with the camera and the mixer
> plugged in. You reach it from any browser on the network, but the devices it lists
> are always the ones attached to the machine running `node server.js`.

---

## The idea in one picture

The ambisonic bed and every musician's stem arrive **together**, as channels of a
single multichannel capture device, and they leave together as one multichannel Opus
track inside the DASH manifest. One stream means one clock: the stems stay
sample-accurate against the bed with nothing to synchronize.

So the whole live setup reduces to one question, answered once in the editor:
**which channel carries what**.

```
ch 0..3   FOA bed — W, X, Y, Z      → binaural decode + head rotation
ch 4      musician 1                → panned at its azimuth · spotlight
ch 5      musician 2                → panned at its azimuth · spotlight
ch n      …                         → up to the device's channel count
```

```mermaid
flowchart LR
  CAM[360 camera<br/>v4l2] --> ENC
  MIX[mixer<br/>ALSA · one device] --> PAN[pan filter<br/>bed + one mono stem per channel]
  PAN --> ENC[encode<br/>NVENC video · multichannel Opus]
  ENC --> DASH[DASH manifest<br/>local folder]
  DASH --> S3[(S3 + CDN)]
  DASH --> PLAYER[player / headset]
  S3 --> PLAYER
```

---

## 1. Start the server on the capture machine

```bash
cd Livestreamed_Immersive_Player
LC_ALL=C node server.js
```

**Why `LC_ALL=C`.** The device list is parsed from `arecord -l`, whose output is
*translated*. On a machine set to Italian or Spanish it prints `scheda` / `tarjeta`
instead of `card`, the parser matches nothing, and the ALSA dropdown comes up empty
with no error anywhere. Video still works, because `v4l2-ctl` is not localized —
which makes the symptom look like an audio problem when it is a language problem.

Open `https://<capture-machine-ip>:60000/editor.html`, accept the self-signed
certificate, and switch the tab from **VOD · files** to **LIVE · USB/UDP**.

## 2. Pick the 360 video source

| Field | What to put |
|---|---|
| **Device** | Choose by label, not by number — `/dev/videoN` is reassigned when you replug. Cameras needing the Insta360 SDK bridge appear as `/dev/video10` only after pressing *Initialize Insta360 camera*; cameras the kernel already exposes as UVC show up directly, and then the bridge is not needed at all. |
| **Resolution** | Leave it empty and you get the camera's default, which on most 360 cameras is a **1920×1080 webcam mode, not equirectangular**. Set it explicitly. |
| **FPS** | Match what the driver will give, or it overrides you and logs `The driver changed the time per frame`. |
| **Input format** | `mjpeg` for anything above 1080p — raw `yuyv422` cannot fit a 4K frame down a USB cable. |

List what the camera really offers:

```bash
v4l2-ctl -d /dev/video6 --list-formats-ext
```

## 3. Point at the mixer, and declare its channel count

Ask the device what it accepts instead of guessing:

```bash
arecord -D hw:1,0 --dump-hw-params -d 1 /dev/null
```

It prints the exact `CHANNELS`, `RATE` and `FORMAT`. Usually all three are fixed, and
every one of them is a way for the encode to fail on launch. **Total ch.** must equal
`CHANNELS`.

Two things about the dropdown: if it is empty the server could not parse `arecord -l`
(go back to step 1), and the list is fetched **once, on page load** — plug the mixer
in first, then reload with `Ctrl+Shift+R`.

Leave **A/V delay** at 0; step 7 measures it.

> **`[alsa] cannot set sample format … Invalid argument`** means the device rejected
> the sample format. Professional interfaces are frequently **S32_LE only** and do not
> accept the 16-bit default. `--dump-hw-params` says so under `Available formats`.

## 4. Declare the four ambisonic channels

Four device channel indices in the order **W, X, Y, Z** — the component, never the
socket it happened to land on. The convention beside them says how the recording is
already encoded: **FuMa** is reordered and rescaled to ACN/SN3D for the player,
**AmbiX** is passed through untouched.

Tick *Convert NT-SF1 A-format → B-format* **only** if the four raw capsules arrive as
they leave the microphone. If a plugin or the DAW already converted, ticking it
rotates the sound field a second time — and nothing downstream can detect that,
because a rotated field is still a valid field. It simply sounds wrong in a way nobody
can point at.

## 5. Give every musician a channel

In LIVE mode each musician row grows a small **`ch`** box: the device channel that
musician arrives on. It is the one field in the panel with **no usable default**.

An empty `ch` does not stop the encode: that musician goes out as **silence**, so
every later musician keeps its own slot in the stream. That is also the trap — a
scene carried over from a VOD take already has the musicians, with names and
positions, and no channels, so it launches fine and the stems are simply mute. The
launch log lists the patch (`ch N → stem i`, or `(no channel) → stem i: silence`);
read it.

**Verify the mapping instead of assuming it.** Channels 4, 5, 6… is a reasonable
guess, not the truth: on a digital desk the USB sends are routed in the desk's own
menu, so channel 5 on the surface need not be channel 5 over USB.

```bash
arecord -D hw:1,0 -c 18 -f S32_LE -r 48000 -d 30 /tmp/map.wav   # each musician plays in turn
ffmpeg -i /tmp/map.wav -filter_complex astats=metadata=1 -f null - 2>&1 \
  | grep -E 'Channel:|RMS level'
```

The channel that lights up while the drummer plays is the number that goes in the
drummer's box.

## 6. Place them in space

The radar is a top-down view with the listener at the centre and the camera looking up
the page. Dragging a dot sets **azimuth, and only azimuth** — the dot rides a fixed
ring, because distance is not something the scene stores. The two rings and the cross
are there to judge angles by eye, not to mean near and far.

Read the compass off the labels, because the sign is the opposite of a clock:

```
                 FRONT 0°
                     ▲
                     │
        +90°  ◀──────●──────▶  −90°
             (left)  │  (right)
                     ▼
              behind ±180°
```

- **Top — 0°** is the front of the video, whatever the camera was pointed at.
- **Left is positive** (+90°), **right is negative** (−90°).
- **Bottom** is directly behind the listener, ±180°.

Click a musician and the panel beside the radar opens on that one:

| Field | What it is |
|---|---|
| **Azimuth °** | The number you just dragged, typed exactly — useful for round angles, or when two players overlap on the radar and the dot is hard to grab. |
| **Elevation °** | How high the musician sits, as an angle. Positive is up. Leave it at 0 for a band on the camera's floor; raise it for a choir on risers or a camera slung below the players. Drag it in the height view below, or type it here. |
| **Height m** | The same number in metres instead of degrees — see the height view. |
| **Gain dB** | A trim for the take, not a mix control. If one musician was recorded a couple of dB under the bed, the spotlight can never lift them clear of it — no amount of `maxBoost` fixes a stem that starts buried. Match them here first, then tune the spotlight. |

### Height

Under the radar, the **height view** is the same six musicians seen from the front:
azimuth runs across, height runs up, and dragging a dot vertically raises or lowers that
one. Its azimuth does not move — that belongs to the radar — so the two views never
fight over the same number.

The metres are not a second coordinate. A stem is stored as a *direction*, so a height
only becomes metres once a distance is fixed, and the one printed here is the distance
the AR markers are placed at (1.6 m, `AR_RADIUS` in `player.js`). What that buys you is
a number you can compare against the room: the dashed line is ear level, 1.30 m, where
every musician starts, and the floor is the bottom axis. A singer on a 40 cm riser is
a little above the dashed line, not a number of degrees you have to imagine.

Because it is a direction, the floor cuts the view at −54°: below that there is nothing
left to place at this radius, and the view stops rather than offer heights that cannot
be stored.

### The room, for AR

AR is not the 360 sphere, and the difference is not cosmetic. In VR the listener sits at
the centre and never moves, so a musician is a *direction* and distance is inaudible —
the engine keeps every unanchored source at the same radius from the head. In AR the
spectator walks among the musicians: distance and height above the floor are heard, and
a direction is not enough to say where somebody stands.

So the **AR room** panel places each musician as a point in metres — top view for x and
z, front view for the height — and writes it into `scene.json` as its own block:

```json
{ "name": "SAX", "azimuthDeg": -137, "elevationDeg": 0,
  "ar": { "x": 1.8, "y": 1.55, "z": -2.4 } }
```

The two placements coexist on purpose: the sphere numbers drive the 360 video, the `ar`
block drives passthrough, and neither view touches the other's numbers.

A musician you have not placed is drawn **hollow**, at the point the player falls back
to — his 360 direction at 1.6 m. Dragging him, or *Place all from the sphere*, fixes him
exactly where he already was, so seeding changes nothing you can hear; from there you
move him to where he really stood. *Unplace* hands him back to the sphere.

The origin (0,0) is not a spectator. It is the room reference the headsets align
themselves to with the thumbstick calibration, so that a musician sits in the same place
for everybody. That calibration is done **once per headset** — the player drops a
persistent WebXR anchor there and restores it on every later launch. Later the partner's cameras will publish these same coordinates and the
manual placement stops being necessary — the format does not change, only who writes it.

> **If the whole scene is rotated** — every musician equally wrong, the band coherent
> but turned as a block — do not drag them one by one. That is the **microphone turned
> relative to the camera**, and it is one scene-level number: *Analyse bed* measures it
> from the recording and reports it as a yaw offset (plus, occasionally, a mirror).
> Apply that, and every musician you placed stays placed.

Placement is read from `scene.json` when the player loads, so you can keep adjusting
angles between takes and just reload — no re-encode. The same azimuth and elevation are
what the AR mode uses to hang each musician's marker around the listener, so a scene
placed carefully here arrives placed in the headset.

## 7. Measure the A/V delay

The camera's stitching delays the picture, so the audio arrives early and you add
delay to the audio until they meet. Press **📐 Auto-measure delay**, stay quiet for a
second, then give one sharp **clap** in front of the camera — a single action that is
both seen and heard. The field fills in with the milliseconds. In a busy scene press
**📷 ROI** first and drag a box over the spot where you will clap.

**Re-measure it at every setup.** The number belongs to the *capture chain*, not to
the camera model: a plain webcam lands near 500 ms, a stitching 360 camera lands
elsewhere, and a value inherited from the last venue is simply wrong. Confirm it on
the stream you actually watch — in the player console `engine.setOutputDelay(ms)` adds
audio delay live; whatever value locks the clap, *plus* the delay already in the
field, is the correct one.

Both buttons hold the ALSA device exclusively. Stop them before going live.

## 8. Choose the encode, and where it publishes

| Field | Guidance |
|---|---|
| **Video codec** | `h264_nvenc` for anything live at 4K: the GPU encodes at fixed cost regardless of content, software encoding does not reach real time. Video in MP4 + multichannel Opus in WebM inside one manifest — mixed containers, which is what the headset browser accepts. |
| **Segment s** | Most of the end-to-end latency lives here. 6 s is the safe default over a CDN; drop to 2 while iterating locally. |
| **Publish to S3** | A bucket URL, never a CloudFront URL. Empty = everything stays local, which is the right choice for a bring-up test on the venue's network. |
| **AWS region** | Region of that bucket. Credentials live on the machine (`aws configure`), never in `scene.json` — that file is served to every client. |

**Save scene**, then **Start LIVE**.

## 9. Watch the first thirty seconds

| Signal | Meaning |
|---|---|
| `speed=1.0x` or higher | Real time. Below that the stream falls behind for good — lower resolution or bitrate. |
| `publishing → s3://…` | The uploader started. Missing line = the bucket field was empty and nothing is leaving the machine. |
| `xrun` / `underrun` | The sound card is not draining. Usually something still holds the ALSA device — the measurement tools from step 6. |
| `manifest incompleto … omitida` | Not an error. The uploader refused a manifest caught mid-rewrite; the next pass sends the complete one. |

Open the player against the local manifest first, and only through the CDN once the
local one is right:

```
index.html?src=https://<host>:60000/encoded/manifest.mpd     # local, for iterating
index.html?src=https://<cloudfront>/manifest.mpd             # published
```

On the headset use the machine's IP rather than `localhost`, and accept the
certificate warning once before an audience is waiting.

---

## Hear the desk before going on air

The stream is the wrong place to set levels: a change on the desk takes around
20 seconds to come back through the encode, the DASH segments and the player's
buffer. The **🎧 Soundcheck monitor** card (LIVE mode, under the musicians) listens
to the desk directly instead. It uses the patch set above (device, FOA channels,
each musician's `ch`) and runs the audio through the player's own engine, with no
encode and nothing published. The status line shows how far behind the room it
is, usually 100–200 ms.

- **Audience**: what a viewer hears looking straight ahead with no zoom. That is
  the bed, plus each musician at the spotlight's rest level.
- **🎯** on a musician: what a viewer hears when they zoom in on that musician.
  The listener turns to the musician's azimuth, the stem comes up and the bed
  ducks, all as in the player.
- **PFL** on any channel: that raw input alone, mono, in both ears. Use it to
  check one microphone before anything is mixed on top.
- **Gain dB** on each row applies as you type. **Save scene** keeps the value for
  the player, which reads it on load, so nothing needs re-encoding.

The meters show the raw inputs: RMS as the bar, the peak as the tick. The bar
turns yellow above −9 dBFS and red above −1 dBFS. Restart the monitor after
changing the device, the channels or the list of musicians; azimuths are also
read only at start. The monitor holds the audio device, so **Start LIVE** and
**Auto-measure delay** stop it.

## Rehearse without the desk

The whole live path can run on a laptop, from the scene's own files.
`fake-mixer.sh` mixes the bed and the stems into one multichannel signal —
channels 0–3 the FOA, then one mono channel per musician, in the scene's order —
and plays it in a loop into an ALSA loopback card. To `stream.sh` that card looks
like the desk.

```bash
sudo modprobe snd-aloop      # once per boot
./fake-mixer.sh              # leave it running
```

It prints what to set in the editor. In Live mode:
- **Audio:** USB (ALSA), the *Loopback* device ending in `,1` (the capture side).
- **Total ch.:** 4 + the number of musicians.
- **FOA ch:** 0, 1, 2, 3.
- **Musicians:** `ch` 4, 5, 6… in the order of the list.

The video stays on whatever camera is selected, so the picture will not match the
music. Everything else is the real path: the patch, the encode, the manifest, and
the player with its stems and spotlight. Moving to the venue then means changing
only the device and the channel numbers.

---

## Failures worth recognizing on sight

All of these have been hit in the field. They share a shape: the error names the
symptom, never the cause.

| What you see | What it is | Fix |
|---|---|---|
| ALSA dropdown empty, cameras fine | Device list parsed from localized `arecord` output | Start the server with `LC_ALL=C` |
| Device list stale after replugging | Devices are fetched once, on page load | `Ctrl+Shift+R` |
| Monitor or encode: `busy`, `Input/output error` | PulseAudio opened the USB card because an app listens to it (Sound settings meter, a call, a browser tab). The monitor names the app and the card | Close the app; for the mixer, `pactl set-card-profile <card> off` (the monitor prints the name) |
| `cannot set sample format` | Interface does not accept the 16-bit default | Check `--dump-hw-params`; capture as `S32_LE` |
| Stems silent, bed fine | A musician has no channel number | Fill every `ch` box, save, relaunch |
| Video is 1920×1080, not 360 | Camera defaulted to webcam mode | Set the equirectangular resolution explicitly |
| Picture plays, audio silent | Missing CORS headers taint the media element | Set CORS on the bucket or CDN |
| Nothing uploads, no error | `sudo` stripped the environment and moved `$HOME` | Run as your normal user |

## What you can change without re-encoding

Placement on the radar, spotlight tuning and the musicians' names all live in
`scene.json` and are read by the player at load — reload the page and they apply.
Only a change of *sources* (devices, channels, resolution) needs the encode restarted.
