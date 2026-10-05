# Installation (production machine)

Step by step, from a clean Ubuntu to a server that encodes and publishes.
What each dependency is for is in the [README](../README.md#requirements).

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
