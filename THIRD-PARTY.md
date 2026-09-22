# Third-party components

This repository's own code is BSD 2-Clause (see [`LICENSE`](LICENSE)). The
components below are not ours and keep their own terms. Nothing is bundled by a
package manager: browser libraries are loaded from a CDN by `index.html`, and
the two files under `src/vendor/` travel with the repository so the player still
works without network access to them.

## Loaded from a CDN at runtime

| Component | Version | Where | Licence |
|---|---|---|---|
| [Shaka Player](https://github.com/shaka-project/shaka-player) | 4.3.6 | `index.html` — DASH playback | Apache-2.0 |
| [three.js](https://github.com/mrdoob/three.js) | r128 | `index.html`, `editor.html` — rendering and WebXR | MIT |
| [numeric.js](https://github.com/sloisel/numeric) | 1.2.6 | `index.html` — matrix maths for the ambisonic rotator | MIT |
| [spherical-harmonic-transform](https://github.com/polarch/Spherical-Harmonic-Transform-JS) | 0.1.1 | `index.html` — SH rotation matrices | «CONFIRM» |

Pinning is deliberate: three.js r128 is the last revision this player's WebXR
and sphere code was verified against on a Quest, and moving it is a change to
test on a headset, not a version bump.

## Vendored (`src/vendor/`)

| File | Origin | Licence |
|---|---|---|
| `omnitone.min.js` | [Omnitone](https://github.com/GoogleChrome/omnitone), Google Inc. — binaural FOA decoding, HRIRs embedded as base64 | Apache-2.0 (header kept in the file) |
| `GLTFLoader.js` | three.js examples — `.glb` loading for the AR musician models | MIT (same as three.js) |

`SkeletonUtils.js`, where present, is also a three.js example under the same
terms.

## Derived code (`src/audio/`)

`HOASTBinDecoder.js`, `HOASTRotator.js`, `HOASTloader.js`, `MatrixMultiplier.js`
and the matrices in `zoom-matrix.js` are **based on / extracted from**
[HOAST (hoast360)](https://github.com/thomasdeppisch/hoast360), the IEM ambisonic
web player. They were adapted to be framework-independent and to accept a WebXR
pose directly; the zoom matrices are taken as they are.

> **«CONFIRM before publishing»** — the licence of hoast360 and whether this
> repository's BSD 2-Clause release is compatible with it. If it is a copyleft
> licence, these files must either keep that licence (and say so in their
> headers) or be replaced. Everything else in `src/audio/`
> (`ImmersiveAudioEngine.js`, `OmnitoneFOADecoder.js`, `ambisonicAxes.js`,
> `opusChannelMap.js`) is ours.

## Node dependencies

| Package | Where | Licence |
|---|---|---|
| [`ws`](https://github.com/websockets/ws) | `telemetry/` — the pose relay and the timing service | MIT |

The player and the editor server (`server.js`) use only Node built-ins.

## External tools

**ffmpeg / ffprobe** are called as external processes for every encode
(`stream.sh`, the editor's encode and proxy endpoints). They are not
redistributed here; the build you install carries its own licence, and whether
it is LGPL or GPL depends on how it was configured. The same goes for the NVENC
path, which needs NVIDIA's proprietary driver.

## Assets

`meshes/test-figure.glb` is the only 3D model in the repository — a known-good
file to check a headset against. Every other `.glb` is per-venue, git-ignored,
and comes with whatever terms its author attached; the editor's upload button
does not ask, so a model obtained from an asset marketplace must be checked
before it is shipped in a public venue.

The recorded media in `media/` is covered in the README's "Licence" section: it
is not free to reuse.
