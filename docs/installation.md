# Installation (production machine)

Step by step, from a clean Ubuntu to a server that encodes and publishes. For a
development checkout the README's *Quick start* is enough.

## What each dependency is for

| Dependency | Needed for | Package (Ubuntu) |
| --- | --- | --- |
| **Node.js** (developed on v22) | `server.js` — player, editor, API. Built-in modules only. | `nodejs` (or nvm) |
| `ws` (npm) | Pose telemetry and voice recording only. Without it the server warns once and runs with them disabled. | `cd telemetry && npm install` |
| **ffmpeg** + **ffprobe** on `PATH`, with `libvpx-vp9`, `libopus`, `libx264` | Every encode (`stream.sh`, VOD and live) and media probing in the editor. | `ffmpeg` |
| ffmpeg built with **NVENC** + NVIDIA driver ≥ 550 | Live 4K (`CODEC=h264_nvenc`). Software encoders cannot keep up at 4K. | below |
| **git-lfs** | Media files (`*.mp4 / *.wav / *.mp3`) and the Insta360 SDK in `x4_bridge/libs/`. | `git-lfs` |
| **openssl** | `./gen-cert.sh` — WebXR over a LAN IP needs HTTPS. | `openssl` |
| **v4l2-ctl** | Live: listing USB video devices in the editor. | `v4l-utils` |
| **arecord** | Live: listing USB audio devices in the editor. | `alsa-utils` |
| **AWS CLI** + credentials | Live: publishing to S3 (`upload-s3.sh`). Not needed for local output. | below |
| `v4l2loopback` + Insta360 SDK | Only for an Insta360 X4 through the USB bridge. A camera that shows up as a plain UVC webcam does not need it. | see [`x4_bridge/README.md`](../x4_bridge/README.md) |

## Steps

Ubuntu 22.04 / 24.04 LTS. Hardware sizing is in
[`docs/produccion-hardware.md`](produccion-hardware.md).

**1. System packages**

```bash
sudo apt update
sudo apt install -y git git-lfs ffmpeg openssl v4l-utils alsa-utils
# Node.js 22: from NodeSource or nvm — the distro package is often too old
node --version
```

Add your user to the capture groups instead of running anything under `sudo`
(log out and back in afterwards; check with `groups`):

```bash
sudo usermod -aG video,audio "$USER"
```

**2. ffmpeg with NVENC (live 4K only)**

Install the proprietary NVIDIA driver (≥ 550), then check that your ffmpeg can
use it:

```bash
nvidia-smi                          # driver loaded, GPU visible
ffmpeg -hide_banner -encoders | grep nvenc    # must list h264_nvenc
```

If `h264_nvenc` is missing, the distro ffmpeg was built without it: install an
ffmpeg build with `--enable-nvenc` (a static build, or compile from source with
`nv-codec-headers`). VOD encoding and HD tests work without it.

**3. Repository and media**

```bash
git clone <repo-url> && cd Livestreamed_Immersive_Player
git lfs install && git lfs pull
./gen-cert.sh                          # HTTPS cert with your LAN IPs
cd telemetry && npm install && cd ..   # optional: telemetry + voice
```

**4. AWS CLI and credentials (S3 publishing only)**

There is no login step and nothing is mounted. The AWS CLI reads the keys from
`~/.aws/credentials` and signs each upload request with them, so you only have to
configure it once per machine and user:

```bash
sudo apt install -y awscli     # or the official AWS CLI v2 installer
aws configure                  # Access Key ID · Secret Access Key · region · json
aws sts get-caller-identity    # which AWS identity the keys belong to
aws s3 ls s3://<bucket>        # the keys can reach the bucket
```

`aws configure` writes `~/.aws/credentials` (keys) and `~/.aws/config` (region).
The keys are shared out of band — never commit them or put them in `scene.json`.
Run `node server.js` as that same user, **not under `sudo`**: `sudo` moves `$HOME`
to `/root`, the CLI no longer finds the keys, and nothing is uploaded, with no
error. Bucket, region, IAM permissions and CORS are in
[`docs/produccion-hardware.md`](produccion-hardware.md#publishing-to-s3--bucket-credentials-cors).

**5. Insta360 X4 bridge (only if you use one)**

Follow [`x4_bridge/README.md`](../x4_bridge/README.md): `install_insta360_sdk.sh`,
`v4l2loopback`, then the bridge publishes the stitched camera on `/dev/video10`.

**6. Check**

```bash
node server.js     # prints https://… if the certs exist
```

Open `https://<host>:60000/editor.html`. In the live section, the device lists
come from `v4l2-ctl` and `arecord`: if they are empty, recheck step 1 and the
groups.
