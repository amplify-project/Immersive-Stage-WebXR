# Insta360 live → V4L2 virtual camera

A C++ bridge that opens an Insta360 camera with the official SDK, stitches the
video in real time with `RealTimeStitcher`, and publishes the frames to a Linux
V4L2 virtual camera.

Flow:

```text
Insta360 CameraSDK -> MediaSDK RealTimeStitcher (RGBA) -> repack to RGB24 -> /dev/videoX
```

The goal is to consume the Insta360 from tools that expect a normal webcam:
`ffmpeg` (the live encode reads `/dev/video10`), OpenCV, GStreamer, OBS, browsers.

## Contents

- `insta360_v4l2_bridge.cc` — bridge source.
- `build_insta360_v4l2_bridge.sh` — build script.
- `install_insta360_sdk.sh` — installs MediaSDK + CameraSDK from `libs/`.
- `bridge.sh` — persistent watchdog launcher (modprobe + restart loop + USB reset).
- `reset_usb.sh` — software USB reset for the camera (see *USB zombie* below).
- `insta360_v4l2_bridge` — compiled binary.
- `libs/` — MediaSDK `.deb` + CameraSDK distribution (tracked via git LFS).

## Configuration (hardcoded)

> The binary takes **no CLI arguments** — `int main()` has no `argc/argv`. All
> config lives in the `Options` struct in `insta360_v4l2_bridge.cc`; to change it,
> edit the struct and rebuild. (The flags in older docs/launchers do nothing.)

Current values:

| Field | Value | Notes |
|-------|-------|-------|
| `device` | `/dev/video10` | V4L2 output node |
| output (`output_width`×`output_height`) | **2880×1440** | published frame; light downscale of the input stream |
| `fps` | **24** | announced by the V4L2 device |
| `stream_resolution` | **`RES_3072_1536P30`** | camera input stream — **this caps real quality**, not the output |
| `flowstate` | **`true`** | **mandatory**, see below |
| `stitch_type` | `TEMPLATE` | fastest/most stable mode |

- **FlowState must stay `true`.** With `false` the SDK's `DynamicStitcher` leaves
  `flow_estimator_` null and dereferences it on the first stitch → **segfault**
  (skipping gyro doesn't help). Stabilization can't be turned off to save CPU.
- **Quality is capped by the input stream**, not the output: bumping only the
  output is a wasteful upscale. To raise quality, raise `stream_resolution`
  (e.g. `RES_3840_1920P30`) too.
- Output is **`RGB24`** (`V4L2_PIX_FMT_RGB24`): the stitcher delivers RGBA and the
  bridge repacks to RGB24 (drops alpha, no color conversion, no OpenCV). The old
  `cv::cvtColor(RGBA→BGR)` was ~21% of bridge CPU (`perf`), so it was removed —
  and with it the OpenCV dependency. `ffmpeg` reads `rgb24` natively from V4L2 but
  **cannot** read the 4-byte RGBA fourcc (`AB24`), hence RGB24.

## Requirements

### SDK and libraries

The SDK ships in `libs/` (git LFS). Install it:

```bash
./install_insta360_sdk.sh
```

It runs `dpkg -i` on the MediaSDK `.deb`, copies the CameraSDK to
`/opt/insta360/CameraSDK-…`, creates the stable symlink `/opt/insta360/CameraSDK`,
and registers its `lib/` with `ldconfig`.

The build expects the CameraSDK at `/opt/insta360/CameraSDK` (override with
`CAMERA_SDK_ROOT=/path ./build_insta360_v4l2_bridge.sh`). It links
`libCameraSDK.so` + `libMediaSDK.so` and needs `g++` with C++17 and the Linux V4L2
headers. **OpenCV is no longer required.**

### V4L2 virtual camera

Needs `v4l2loopback`:

```bash
sudo apt install v4l2loopback-dkms v4l2loopback-utils v4l-utils
sudo modprobe v4l2loopback video_nr=10 card_label="Insta360 Virtual" exclusive_caps=1
```

`bridge.sh` already loads the module, so you usually don't run modprobe by hand.

## Build

```bash
./build_insta360_v4l2_bridge.sh        # produces ./insta360_v4l2_bridge
```

## Run

Preferred — the watchdog launcher (loads v4l2loopback, restarts on crash, and
**resets the USB** between restarts):

```bash
./bridge.sh
```

Or the binary directly (needs `/dev/video10` to exist already):

```bash
sudo ./insta360_v4l2_bridge      # config is hardcoded; Ctrl+C to stop
```

On startup the binary **retries device discovery up to 15× (1 s apart)** so it
self-heals through the USB re-enumeration window after a restart.

## Test the virtual camera

```bash
ffplay -f v4l2 /dev/video10        # ffplay auto-detects size/format (rgb24)
v4l2-ctl --device=/dev/video10 --all
v4l2-ctl --device=/dev/video10 --list-formats   # should show 'RGB3' 2880x1440
```

## Implementation notes

The SDK delivers stitched frames in `SetStitchRealTimeDataCallback(...)` as RGBA.
The callback repacks RGBA→RGB24 and pushes it to a **latest-frame queue (effective
size 1)** — it never writes to the device directly, so a slow V4L2 consumer can't
stall the SDK thread (old frames are dropped instead of queueing latency).

The watchdog (`bridge.sh`) on each restart: `killall -9` → `sleep 2` →
**`reset_usb.sh`** → relaunch.

## USB "zombie" after a hard kill

When the bridge is `SIGKILL`'d (watchdog), the camera session isn't closed
cleanly, so the USB interface stays claimed. The next launch then fails with:

```
timeout to wait for synchronize
error: no Insta360 camera found
```

A userspace discovery retry does **not** fix this (it's a stuck kernel-level USB
endpoint). The fix is a software USB reset via sysfs unbind/bind, done by
`reset_usb.sh` (finds the camera by vendor id `2e1a`, robust to bus/port changes)
and wired into the `bridge.sh` watchdog. To clear it manually:

```bash
sudo bash reset_usb.sh
```

If it still fails, unplug/replug the USB or power-cycle the camera.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `open /dev/video10: No such file or directory` | v4l2loopback not loaded — run `bridge.sh` or the `modprobe` above. |
| `/dev/video10 is not a V4L2 output device` | Pointed at a real webcam; use the v4l2loopback node. |
| Permission denied on `/dev/video10` | `sudo usermod -aG video "$USER"` (re-login), or run with `sudo`. |
| `timeout to wait for synchronize` / no camera found | USB zombie — `sudo bash reset_usb.sh` (see above). |
| `Device or resource busy` on the camera node | Another consumer/the live encode holds it; v4l2loopback allows multiple readers, but the ALSA audio is exclusive. |
| Black image / wrong colors | Confirm the consumer reads `rgb24` 2880×1440; `ffplay -f v4l2 /dev/video10` auto-detects. |

The `h264 ... switch to software decoding` log line on startup is **benign SDK
noise** — the camera-stream decode is cheap and not a CPU concern.
