# Third-party components

This repository's own code is GPLv3 (see [`LICENSE`](LICENSE)). The
components below are not ours, or not only ours, and keep their own terms.
Nothing is bundled by a package manager: browser libraries are loaded from a
CDN by the pages, and the files under `src/vendor/` travel with the repository
so the player still works without network access to them.

Every licence below is compatible with releasing this code under GPLv3. The one
component that is not open source, the Insta360 SDK, is only needed by the
optional X4 bridge.

## Loaded from a CDN at runtime

| Component | Version | Where | Licence |
|---|---|---|---|
| [Shaka Player](https://github.com/shaka-project/shaka-player) | 4.3.6 | `index.html` — DASH playback | Apache-2.0 |
| [three.js](https://github.com/mrdoob/three.js) | r128 | `index.html`, `editor.html` — rendering and WebXR | MIT |
| [numeric.js](https://github.com/sloisel/numeric) | 1.2.6 | `index.html` — matrix maths for the ambisonic rotator | MIT |
| [spherical-harmonic-transform](https://github.com/polarch/Spherical-Harmonic-Transform-JS), Archontis Politis | 0.1.1 | `index.html` — spherical-harmonic rotation matrices (`sht.getSHrotMtx` in `HOASTRotator.js`) | BSD-3-Clause |
| [mp4box.js](https://github.com/gpac/mp4box.js), GPAC | 0.5.2 | close-ups decoded with WebCodecs (`src/app/closeup-wc.js`) | BSD-3-Clause |

Pinning is deliberate: three.js r128 is the last revision this player's WebXR
and sphere code was verified against on a Quest, and moving it is a change to
test on a headset, not a version bump.

## Vendored (`src/vendor/`)

| File | Origin | Licence |
|---|---|---|
| `omnitone.min.js` | [Omnitone](https://github.com/GoogleChrome/omnitone), Google Inc. — binaural FOA decoding, HRIRs embedded as base64 | Apache-2.0 (header kept in the file) |
| `GLTFLoader.js`, `SkeletonUtils.js` | three.js examples — `.glb` loading and skinned-mesh cloning for the AR musician models | MIT (same as three.js) |
| `motion/` (12 files: `TimingObject.js`, `TimingMediaController.js`, `SocketTimingProvider.js`, `SocketSyncClock.js`, …) | **Orkestralib**, © 2022 Iñigo Tamayo Uria, Ana Domínguez Fanlo, Mikel Joseba Zorrilla Berasategui (Vicomtech) — Timing Object for shared playback (`?sync=`) | LGPL-3.0-or-later (header kept in each file) |

Orkestralib is Vicomtech background, brought into this project; it keeps its
own LGPL licence, which allows it inside this GPLv3 work.

## Derived code (`src/audio/`)

`HOASTBinDecoder.js`, `HOASTRotator.js`, `HOASTloader.js`, `MatrixMultiplier.js`
and the matrices in `zoom-matrix.js` are **based on / extracted from**
[HOAST (hoast360)](https://github.com/thomasdeppisch/hoast360), the IEM ambisonic
web player by Thomas Deppisch, licensed **GPL-3.0**. They were adapted to be
framework-independent and to accept a WebXR pose directly; the zoom matrices are
taken as they are. As a derived work they stay under GPL-3.0, which is also why
this repository as a whole is GPLv3 and could not be released under a
permissive licence.

Everything else in `src/audio/` (`ImmersiveAudioEngine.js`,
`OmnitoneFOADecoder.js`, `ambisonicAxes.js`, `opusChannelMap.js`,
`pcm-stream-worklet.js`) is ours.

## Node dependencies

| Package | Where | Licence |
|---|---|---|
| [`ws`](https://github.com/websockets/ws) | `telemetry/` — the pose relay, the timing service, voice recording and the editor's live monitor | MIT |

The rest of the server (`server.js`) uses only Node built-ins.

## Insta360 SDK (optional X4 bridge)

`x4_bridge/libs/` holds the **Insta360 CameraSDK 2.1.1** (headers and
`libCameraSDK.so`) and the **MediaSDK 3.1.1** (`.deb`), carried by Git LFS. They
are Insta360's proprietary software, not covered by this repository's licence,
and are only used by `x4_bridge/`, to open an Insta360 X4 and stitch its image.
A camera that shows up as a plain UVC webcam (e.g. the X5) does not need them.

> **«CONFIRM»** — whether Insta360's SDK terms allow redistributing these files
> in a public repository. If they do not, they must be removed from the
> repository (and its LFS history) and obtained from Insta360's developer
> programme instead; `install_insta360_sdk.sh` already installs them from
> `libs/`, wherever they came from.

## External tools

These are called as separate processes, not linked or redistributed, so their
licences do not extend to this code:

| Tool | Used for | Licence |
|---|---|---|
| **ffmpeg / ffprobe** | Every encode (`stream.sh`, the editor's encode, proxy and monitor endpoints) and media probing | LGPL-2.1+ or GPL-2.0+, depending on how the installed build was configured (GPL when built with `libx264`) |
| NVIDIA driver (NVENC) | Hardware H.264 encoding for live 4K | Proprietary |
| Node.js | `server.js` and `telemetry/` | MIT |
| AWS CLI | S3 publishing (`upload-s3.sh`) | Apache-2.0 |
| v4l2loopback | Only for the X4 bridge | GPL-2.0 |

Shipping any of them installed with this software (a machine image, a
container, a configured PC for a venue) would be distributing them, and their
own terms would then apply.

**H.264** is not a software licence but a patented standard. The live 4K path
encodes it (NVENC or `libx264`), and the browsers and headsets decode it under
their makers' licences. Using it for a paid service may involve the AVC patent
pool's terms; VP9 and Opus, used for VOD video and for all audio, are
royalty-free.

## Assets

### 3D models

`meshes/test-figure.glb`, `test-figure-b.glb` and `test-figure-c.glb` are ours:
known-good files to check a headset against.

The example scene's musician models come from [Sketchfab](https://sketchfab.com)
under **Creative Commons Attribution 4.0**. They are included unmodified (the
player scales them at load time, it does not change the files):

| File | Model | Author | Licence |
|---|---|---|---|
| `meshes/animated_musical_trem_playing_guitar_loop.glb` | [Animated Musical Trem Playing Guitar Loop](https://sketchfab.com/3d-models/animated-musical-trem-playing-guitar-loop-7dde986b68834de6b5a9deff6819d3f1) | [LasquetiSpice](https://sketchfab.com/LasquetiSpice) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| `meshes/drum_kit.glb` | [Drum Kit](https://sketchfab.com/3d-models/drum-kit-99218427e7a2424ea8afc9b8c668a5c7) | [Serg.Morgun](https://sketchfab.com/Serg.Morgun) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| `meshes/drums_bateria.glb` | [Drums (Bateria)](https://sketchfab.com/3d-models/drums-bateria-fc185ca995724857860fcc940eef53f6) | [Ju Designer](https://sketchfab.com/JuDesigner) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| `meshes/low_poly_music_box.glb` | [Low poly music box](https://sketchfab.com/3d-models/low-poly-music-box-cf644075b00c4970ba9f5b5193701ab8) | [JuanJG](https://sketchfab.com/JuanJanaG) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| `meshes/saxophone_alto.glb` | [saxophone alto](https://sketchfab.com/3d-models/saxophone-alto-08448f4bfbca474b80ba35a571648a27) | [ANDRIANIAINAToky](https://sketchfab.com/ANDRIANIAINAToky) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| `meshes/synthgen-v1_o2.glb` | [SYNTHGEN-V1 O2](https://sketchfab.com/3d-models/synthgen-v1-o2-3ebd1cb2b60e44fab636403ddd0219fe) | [AL3K](https://sketchfab.com/alexinsouratselou) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| `meshes/trumpet.glb` | [Trumpet](https://sketchfab.com/3d-models/trumpet-1dc9efd37bf14d1b9d1e3de0ca90435c) | [Kagelok](https://sketchfab.com/Kagelok) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |
| `meshes/used_trombone.glb` | [Used Trombone](https://sketchfab.com/3d-models/used-trombone-3709e96c01694bc791b118e2ce534910) | [sethgordon](https://sketchfab.com/sethgordon) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) |

Each file also carries its author, licence and source inside, in the glTF
`asset.extras` field, as Sketchfab exports it. Models a venue adds through the
editor's upload button come with whatever terms their author attached; the
button does not ask, so check them before a public show and add them here if
they are committed.

### Recorded media

The recorded media in `media/` is covered in the README's "Licence" section: it
is not free to reuse.
