# Livestreamed Immersive Player

Web player for **360° video + Ambisonics (FOA) audio**, binaurally decoded, that
runs in a desktop browser and in **WebXR on a Meta Quest**. Each musician also has
their own stem: **look at a musician and zoom in, and they come forward** from
their position in space.

- **Visual editor** to place each musician in the scene and launch VOD and live
  encodes from the browser.
- **Live capture** from a 360° camera and a multichannel mixing desk.
- **AR passthrough** mode: musicians as positional sources (and 3D models) in
  your room, shared between headsets.
- **Close-up videos** per musician, synced to the audio.
- **Pose telemetry** and voice recording for user studies.

> **Research prototype from the AMPLIFY project**, built at
> [Vicomtech](https://www.vicomtech.org) and tested on real hardware: a Meta
> Quest 3, a 360° camera and a 32-channel desk in a room with musicians. The code
> is BSD 2-Clause; the sample recording in `media/` is **not** free to reuse —
> see [Licence](#licence).

---

## How it works

Audio travels as **one multichannel Opus stream** in the same DASH manifest as the
video:

```
channels 0..3  → FOA Ambisonics (ACN/SN3D)  → binaural HRTF decode (Omnitone) + head rotation
channels 4..N  → one mono stem per musician  → GainNode → PannerNode(HRTF) at its azimuth → spotlight
```

One stream means **one timeline, one decoder, zero drift**: the stems stay
sample-accurate with the ambisonic bed, live included. The *spotlight* raises a
stem's gain as a function of **where you look × how much you zoom**. The full
path, mic to ears, is in [`docs/audio-pipeline.md`](docs/audio-pipeline.md).

---

## Quick start

Requirements: **Node.js**, **ffmpeg/ffprobe** on `PATH` (with `libvpx-vp9`,
`libopus`, `libx264`) and **git-lfs**.

```bash
git lfs install && git lfs pull       # fetch the sample media
./gen-cert.sh                         # self-signed cert: WebXR over IP needs HTTPS (once)
cd telemetry && npm install && cd ..  # `ws`, only needed for pose telemetry
node server.js                        # start the server (https if certs exist)
```

- **Editor** → `https://<host>:60000/editor.html`
- **Player** → `https://<host>:60000/index.html`

On the Quest use the **PC's IP** (not `localhost`) and accept the self-signed
certificate. Desktop controls: drag to look, mouse wheel to zoom, space to play.

---

## Documentation

**Using it**

| Guide | What it covers |
|-------|----------------|
| [Preparing and encoding a scene](docs/encoding.md) | Editor workflow, the ambisonic bed, `stream.sh`, and the three Quest pitfalls |
| [Live scene setup](docs/live-editor-tutorial.md) | From cold hardware to a live stream: the editor's LIVE panel, A/V delay, publishing |
| [Production hardware](docs/produccion-hardware.md) | The capture/encode PC, NVENC, S3/CloudFront publishing |
| [`x4_bridge/`](x4_bridge/README.md) | Insta360 X4 → virtual camera bridge |
| [Reference](docs/reference.md) | Player controls, debug flags, test tools, file map, `/api/*`, `scene.json` schema |

**How it is built**

| Guide | What it covers |
|-------|----------------|
| [Architecture](docs/architecture.md) | How the pieces fit, the invariants, how to extend — **start here to contribute** |
| [Audio pipeline](docs/audio-pipeline.md) | How the sound is built, mic to ears, and its known limitations |
| [Core API](docs/core-api.md) | `ImmersiveAudioEngine` API, AR mode, close-up multi-track |

**Features**

| Guide | Status |
|-------|--------|
| [Close-up panel](docs/closeup-panel.md) | Zoom turns into a flat close-up video |
| [Musician meshes in AR](docs/musician-meshes.md) | 3D model per musician: sizing, editor, upload, animation |
| [Shared room frame](docs/shared-space.md) | Two headsets see the musicians in the same place — working on two Quests |
| [Pose telemetry](docs/telemetry.md) · [relay](telemetry/README.md) | Head pose, zoom and focus streamed to an external render (e.g. Unity) |
| [Voice recording](docs/voice-recording.md) | What the participant says, joined to the pose telemetry |
| [Motion sync](docs/motion-sync.md) | Synchronised playback across devices — spike, not tried on a headset |
| [Shared spaces research](docs/shared-spaces.md) | Background research behind the shared room frame |
| [Partner handoff](docs/handoff.md) | Features handed to partners, and what is missing in each |

Each document states at the top how far it got and on what hardware — that line
is the one to trust. `tools/docs-bundle.sh` concatenates them all into one file.

---

## The project

This is the software side of one work package of **AMPLIFY**, a European research
project: capturing a live concert in 360° with an ambisonic bed and one stem per
musician, and letting a remote audience listen to it in a headset — where
**looking at a musician is what brings them forward**.

It is a **research prototype**: there is no build step, no package to install, and
the deployment it knows about is `node server.js` on the machine standing next to
the camera. What it does have is mileage — every session with real musicians left
something in `docs/`, from the A/V offset a USB camera introduces to the frame
budget of passthrough on a Quest 3.

### Funding

Funded by the European Union under grant agreement No «NNNNNN» («AMPLIFY —
full project title», «call / programme»). Views and opinions expressed are
however those of the author(s) only and do not necessarily reflect those of the
European Union or «the granting authority». Neither the European Union nor the
granting authority can be held responsible for them.

---

## Licence

The **code** is BSD 2-Clause — see [`LICENSE`](LICENSE). Third-party components
keep their own terms, listed in [`THIRD-PARTY.md`](THIRD-PARTY.md); that file
also flags the two things to check before reusing this in another project.

The **sample media** in `media/` — the 360° video, the ambisonic bed and the six
stems, carried by Git LFS — is **not** covered by that licence and is **not free
to reuse**. It is a recording of identifiable performers, included so that the
player can be run against real material instead of a test tone. Reuse,
redistribution, or any derivative of that recording needs written permission —
ask first. The same applies to media reachable through the repository's history,
including takes no longer in the working tree.

`meshes/test-figure.glb` is the one 3D model that travels with the repository, as
a known-good file to check a headset against. Every other `.glb` is per-venue,
git-ignored, and carries its author's own terms.

---

## Personal data

The pose telemetry records **where a person looked** (head orientation, zoom,
musician in focus, at 20 Hz, tagged with the session's name), and `?voice=1`
records **what they said**. For anyone wearing the headset, both are personal data.

- Both are **off by default** (`"telemetry": { "enabled": false }` in
  `scene.json`; voice only with `?voice=1`).
- The player only samples pose **inside a VR or AR session**; a desktop browser
  sends nothing, whatever the flag says.
- Data goes to the same server that served the player, and nowhere else.
- Recordings are git-ignored, never served over HTTP, and **no recorded session
  is in this repository**.

Running this with participants — telling them what is recorded, and getting their
consent — is the operator's responsibility, under their own institution's ethics
and data-protection rules.

---

## Citing and contact

If this work is useful in academic work, please cite the AMPLIFY project
«publication / deliverable reference». Questions about the code, or about reusing
the recording, go to «contact e-mail».
