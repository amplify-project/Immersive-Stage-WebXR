# Hardware specification · Production PC for immersive 360 live streaming

PC to capture and live-stream 360 video + ambisonic audio with per-musician spotlight.
The **video is encoded on an NVIDIA GPU (NVENC)**, so the rest of the machine can be
modest: the CPU does not encode video. The DASH output is **published to S3**; viewers
(Quest headsets) pull from S3, so the PC does not serve clients over local WiFi.

## Executive summary

> Desktop with an **NVIDIA RTX (NVENC)** GPU, a **6-core** CPU, **16–32 GB RAM**, an
> **NVMe SSD**, **Ubuntu Linux**, on a **wired internet connection with stable upload**
> to push the live stream to S3. The camera delivers already-stitched 360 (equirectangular)
> over USB.

Verified performance: H.264 via NVENC encodes 4K 360 at **~2.6× real time** even on the
most modest current NVIDIA GPU; throughput is **content-independent** (fixed-function
silicon). Software (CPU) encoding does not reach real time at 4K.

## Specification

| Component | Recommended | Minimum | Why |
|---|---|---|---|
| **GPU** | **NVIDIA RTX 4060** (8 GB) | RTX 3050 (8 GB) | NVENC encodes the video. The 4060 (Ada) adds **AV1 NVENC** and low power (~115 W). Any RTX 30/40 works. |
| **CPU** | Ryzen 5 7600 / Core i5-13400 (6 cores) | Ryzen 5 5600 / i5-12400 | Only USB input decode + multichannel Opus + DASH mux + upload. Does **not** encode video. |
| **RAM** | 32 GB DDR4/DDR5 | 16 GB | 16 is enough; 32 is comfortable if recording VOD in parallel. |
| **Disk** | NVMe 1 TB | 500 GB SSD | Live segments are small; space for VOD recording and the upload buffer. |
| **Internet** | **Wired**, stable upload **≥ 25 Mbit/s** | Wired, ≥ 15 Mbit/s upload | The live stream (~13 Mbit/s) is pushed to S3 in real time; leave headroom. |
| **USB** | Board with multiple USB 3.x controllers | USB 3.0 + powered hub | X32 (32 ch) and the camera on **separate buses** so they don't compete. |
| **PSU** | 550 W 80+ Bronze | 450 W | Headroom for the RTX. |
| **OS** | Ubuntu 22.04/24.04 LTS | — | NVIDIA driver ≥ 550 + ffmpeg with NVENC (what the project uses). |

## NVIDIA GPU — details

- **Any RTX 30/40** works (all include NVENC). The **RTX 4060** is the sweet spot:
  cheap, ~115 W, and brings **AV1 NVENC** in case that codec is wanted later.
- **One live stream = one NVENC session**, so a **consumer GeForce is enough** (no need
  for a Quadro/professional card). The GeForce session limit does not apply here.
- **Avoid**: cards without NVENC (e.g. GT 1030), the **GTX 16 series** (no AV1, end of life),
  and any option that forces **CPU/software** encoding.

## Connectivity — the critical part (more than raw PC power)

1. **Internet upload**: wired connection to the router with **stable upload bandwidth**.
   The PC pushes the live DASH segments to **S3** in real time; the stream is ~13 Mbit/s
   (12 Mbit/s H.264 video + multichannel Opus), so plan for **≥ 25 Mbit/s upload** with
   headroom. Higher bitrates or multiple renditions need proportionally more.
2. **Publishing path**: the PC writes DASH segments to a local folder; an uploader
   (`aws s3 sync` loop, or an S3 mount such as `goofys`/`s3fs`) pushes them to the bucket.
   Front the bucket with **CloudFront** (CDN) so viewers get low latency and the origin
   upload stays light. No local WiFi access point is required.
3. **USB**: the **X32** (multichannel audio) and the **Insta360** (4K) on **separate USB
   controllers**. On a mini-PC/laptop with a single hub there can be bandwidth contention.

## What is NOT needed (avoid overspending)

- **High-end / many-core CPU**: unnecessary — the GPU does the video.
- **Professional GPU (Quadro / RTX Ada pro)**: a consumer RTX covers one live stream.
- **Local WiFi access point / client-serving network**: delivery is via S3 + CDN.
- **64 GB+ RAM, RAID storage, etc.**: out of scope for this use.

## Software stack

- Ubuntu LTS · proprietary NVIDIA driver (≥ 550) · `ffmpeg` with `--enable-nvenc`.
- Capture: video via **v4l2** (Insta360 as a UVC webcam, equirectangular) or **UDP**;
  multichannel audio via **ALSA** (X32 over USB) or **UDP**.
- Output: one DASH manifest with **H.264 (NVENC) in MP4 + multichannel Opus in WebM**
  (mixed containers) — compatible with the Quest browser — published to **S3 (+ CloudFront)**.

## Publishing to S3 — bucket, credentials, CORS

Publishing is split in two: **non-secret config** (bucket + region) lives in the scene,
while **credentials** live only on the production machine. Never put AWS keys in the
browser or in `scene.json` — that file is served to any client, so a secret key there
is a credential leak.

### Our setup

| What | Value |
| --- | --- |
| S3 bucket | `s3://mi-360-streaming` |
| Region | `eu-west-2` |
| CloudFront (player origin) | `https://d2niecnaz2acxt.cloudfront.net/manifest.mpd` |
| AWS profile | `default` (`aws configure`) |

Keys are **not** in this repo — they are shared out of band and installed on the
production machine (see *Credentials* below). Wiring:

- **Editor** (`editor.html` → `scene.json`): `Publish to S3` = `s3://mi-360-streaming`,
  `AWS region` = `eu-west-2`, `Player URL` = `https://d2niecnaz2acxt.cloudfront.net/manifest.mpd`.
  With a bucket and a Player URL, **Open player** plays the CloudFront stream (what the
  audience gets); without either, it plays the local `encoded/` output.
- **Player**: open with
  `index.html?src=https://d2niecnaz2acxt.cloudfront.net/manifest.mpd`.

### Bucket & region (from the editor)
`editor.html` has the **Publish to S3** and **AWS region** fields. They are saved to
`scene.json` (`encode.s3Bucket` / `encode.s3Region`) and `server.js` forwards them to
`stream.sh` as `S3_BUCKET` / `S3_REGION`. `S3_BUCKET` must be the bucket
(`s3://bucket/prefix`), **not** the CloudFront URL — `upload-s3.sh` rejects an http(s)
value. Leave the field empty to keep the output local (no upload).

### Credentials (on the production machine only)
`server.js` spawns the encode/upload processes inheriting its own environment
(`env: { ...process.env }`), so the chain `server.js → stream.sh → upload-s3.sh` picks up
whatever AWS credentials exist on the machine that runs the server. The AWS CLI resolves
them the standard way — pick one:

- **`aws configure`** (simplest, persistent): writes `~/.aws/credentials` +
  `~/.aws/config`. Every later `server.js` start on that machine is authenticated.
  ```bash
  aws configure       # Access Key ID · Secret Access Key · default region
  ```
- **Environment variables** before launching the server (handy in containers):
  ```bash
  export AWS_ACCESS_KEY_ID=AKIA...
  export AWS_SECRET_ACCESS_KEY=...
  export AWS_DEFAULT_REGION=eu-west-1
  node server.js
  ```
- **IAM instance role** if the production PC is an EC2 instance — no keys to manage
  (most secure).

Minimum IAM permissions for `upload-s3.sh` (`aws s3 sync` + `aws s3 cp`):
`s3:ListBucket` on the bucket, and `s3:PutObject` / `s3:GetObject` on `bucket/*`.

### CORS (required for playback, not upload)
The player's `<video>`/`<audio>` elements use `crossorigin="anonymous"` because the
multichannel audio is tapped with `createMediaElementSource` for the FOA engine. If the
bucket/CDN does not return CORS headers, video may show but the **ambisonic audio is
silent** (tainted media), and Shaka also needs the `Range` header. Bucket CORS:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3000
  }
]
```

Serve the bucket publicly or via CloudFront (OAC). If using CloudFront, forward `Origin`
and `Range`, and respect the `no-cache` that `upload-s3.sh` sets on `manifest.mpd` so the
live timeline is re-read fresh. Point the player at the manifest with
`index.html?src=https://<cloudfront-or-s3>/manifest.mpd`.

### How the uploader is launched (lifecycle)
`stream.sh` does **not** upload anything itself. In LIVE it spawns `upload-s3.sh` as a
**background child** — and only if `S3_BUCKET` is set:

```bash
if [[ -n "${S3_BUCKET:-}" ]]; then
  bash upload-s3.sh &        # child of stream.sh; killed by its EXIT/INT/TERM trap
fi
```

Consequences worth remembering:
- The uploader shares `stream.sh`'s terminal, so `ps`/`pgrep -af upload-s3.sh` is how you
  confirm it is actually running — you won't "see" it otherwise.
- It exists only while `stream.sh` runs, and dies when you stop the stream.
- **Editing `upload-s3.sh` does not affect a running stream.** A live `stream.sh` keeps the
  old uploader it already spawned; to pick up changes you must **restart `stream.sh`**
  (there is no separate uploader to restart). At startup it prints
  `publishing → s3://… (upload-s3.sh en background)` — if that line is missing, `S3_BUCKET`
  was empty and nothing is being uploaded (any truncated `.mpd` on S3 is then a leftover
  from an earlier run).

### Troubleshooting

**Manifest truncated on S3 but fine locally (torn read).**
`ffmpeg` rewrites `manifest.mpd` in place on every segment (no atomic temp+rename — verified
on ffmpeg n8.0). If `aws s3 cp` reads it mid-write it uploads a truncated MPD and the player
sees an incomplete timeline. `upload-s3.sh` guards against this: it snapshots the manifest
locally and uploads it **only if it is complete** (ends with `</MPD>`); otherwise it skips
that pass and the next one (~`INTERVAL`s later) picks up the closed file. Occasional
`⚠ manifest incompleto … subida omitida` in the log is the guard working, not an error.
Verify the object is well-formed:

```bash
aws s3 cp s3://mi-360-streaming/manifest.mpd - --region eu-west-2 | tail -c 12   # → </MPD>
```

**Do not run `stream.sh` under `sudo`.** `sudo` breaks S3 publishing in two silent ways:
1. It strips the environment, so `S3_BUCKET`/`S3_REGION` don't reach `stream.sh` → the
   uploader is never launched (you only see `stream.sh`, no `upload-s3.sh`).
2. It changes `$HOME` to `/root`, so the AWS CLI looks for credentials in `/root/.aws/`
   instead of your `~/.aws/` (from `aws configure`) → uploads fail (swallowed by
   `--only-show-errors`).

Run it as your normal user. Capture devices don't need root if the user is in the right
groups:

```bash
sudo usermod -aG video,audio "$USER"   # then log out/in; check with `groups`
```

If sudo is genuinely required (e.g. the X4 USB-bridge reset), preserve both the environment
and the credentials home explicitly:

```bash
sudo -E env S3_BUCKET=s3://mi-360-streaming S3_REGION=eu-west-2 HOME="$HOME" ./stream.sh live
```

## A/V sync — measuring the audio delay

The camera/X4 bridge adds noticeable video latency, so the live audio arrives **earlier**
than the picture. The **A/V delay (ms)** field in the editor (`scene.json`
`live.audio.delay`) delays the audio to line it up; the encode applies it with `adelay`.
The question is only *how many milliseconds*.

### Measure it — don't eyeball it, and don't apply delay to measure

`measure_sync.sh` computes the number automatically. It captures a few seconds of
video+audio with wall-clock timestamps, auto-detects the transient in each stream, and
prints the offset in ms:

```bash
./measure_sync.sh                     # hw:1,0 + /dev/video10, 8 s
DUR=6 CH=32 WCH=0 THRESH=-30 ./measure_sync.sh hw:1,0 /dev/video10
```

Method: it's **one action** that is both seen and heard — when it starts, stay ~1 s
**silent**, then a sharp **clap** in front of the camera (the hands meeting are the visual
event *and* the sound; a clapperboard works too — no phone flash, no extra hands). The clap
breaks the silence (audio onset via `silencedetect`) and makes a scene change (video onset).
It prints `A/V delay = <N> ms` → enter `N` in the editor. Detection is robust by design: the
audio onset (`silencedetect`) anchors the time, and the video onset is the point of **maximum
motion in a window around it** (`WIN`, default 1.2 s) — not a global threshold, so background
motion in a busy 360 scene doesn't fool it. Run it 2-3 times and average if it wanders; raise
`THRESH` (−25/−20 dB) if the clap isn't heard, and use an **ROI** (below) if the clap isn't
seen.

The raw offset at `delay=0` **is** the delay — you never need to apply a delay to measure it.

**Caveat — `measure_sync.sh` under-measures large delays.** The video onset is only searched
within `±WIN` of the audio onset (default 1.2 s), so if the true video latency exceeds `WIN`
the number is clipped, and the argmax can even latch onto the *arm wind-up before* the clap
(more moving pixels than the contact itself) and report a physically impossible **negative**
delay. It also measures wall-clock *arrival* latency, which the live encode (CFR `-framerate`
video + native ALSA audio) does not preserve 1:1. Treat its output as a rough starting point,
raise `WIN` (e.g. `WIN=3 DUR=14`) if needed, and **confirm the value in the player** (below) —
that's the only measurement taken on the stream you actually watch.

**Restricting where it looks (ROI).** In a busy 360 scene, the video detector can latch onto
background motion instead of the clap. Restrict detection to the region where you clap:

- From the **editor**: click **📷 ROI**, which grabs a still snapshot from the camera
  (`GET /api/snapshot`, video-only, no ALSA); drag a rectangle over where you'll clap
  (right-click = whole frame). The rectangle is sent to the measurement as fractions and
  applied with ffmpeg `iw/ih`, so it is independent of capture resolution.
- From the **terminal**: `ROI="w:h:x:y"` (pixels) or `ROI_REL="w:h:x:y"` (fractions 0..1).

### Verify and fine-tune in the player (ground truth)

The delay that matters is the one on the **played** stream. ffprobe confirms audio and video
leave the encoder on the same PTS timeline (no muxer offset), and routing the `<video>` audio
through Web Audio adds only ~50 ms (`audioContext.outputLatency`) — so any residual A/V
mismatch is the capture-side stitching latency. Measure/tune it directly in the player:

- In the browser console: `engine.setOutputDelay(<ms>)` — a Web Audio `DelayNode` on the
  output that delays **audio only**. Bump it until a clap locks (audio arrives early, so you
  only ever *add* audio delay). That value **plus** the current `live.audio.delay` is the
  correct `live.audio.delay`; put it in the editor and reset the player to 0.
- URL knobs: `?audiodelay=<ms>` (apply on load), `?avlog=1` / `avDiag()` (logs buffered
  ranges + `outputLatency` each second).

**The value is setup-dependent — re-measure it whenever the camera or audio device changes.**
It's the video-vs-audio latency of the *capture chain*, not a fixed camera number: a plain
USB webcam lands around ~**500 ms**, while the Insta360 X4 (v4l2 bridge + FlowState stitching)
adds more. It lives in `scene.json` `live.audio.delay`, so it applies to every client — reset
the player-side `setOutputDelay` to 0 once it's baked into the encode.

### The editor buttons

- **📐 Auto-medir delay** → runs `measure_sync.sh` on the server, you clap, it fills the
  *A/V delay (ms)* field. Recommended. No `DISPLAY` needed.
- **📷 ROI** → snapshot + draw the detection region (optional, for busy scenes).
- **🎯 Medir sync (ffplay)** → faithful live window to eyeball it; use at delay 0 (its
  delay mode can xrun the audio). Needs `DISPLAY`.

All three use the ALSA audio device exclusively — stop them before going live.

### Why not measure with the live ffplay monitor

`monitor_sync.sh` is a faithful low-latency preview (clap test in real time). It works fine
at `delay=0`, but its `delay_ms` mode applies `adelay`, which forces ffmpeg to hold audio in
the muxer; with live ALSA + `nobuffer` that stops draining the sound card → `snd_pcm_recover
underrun` → broken pipe (the audio "cuts out"). So: **use the monitor only at `delay=0`**
(or just use `measure_sync.sh`); apply the delay in the editor and verify it in the real
output, not by re-running the monitor with a delay.

### Iterating without fighting the ~20 s live delay

End-to-end live latency (≈20 s) comes mostly from `SEG` (6 s segments) plus the
S3 → CloudFront path, and is **irrelevant to sync** — only the *relative* A/V offset matters.
To iterate quickly, don't test through CloudFront: run a **local** encode (no `S3_BUCKET` →
`stream.sh` auto-selects low latency + a small window) with a small `SEG` (e.g. `2`), and
point the player at the **local** manifest instead of the CDN:

```
index.html?src=https://<host>:60000/encoded/manifest.mpd
```

Reserve the CloudFront player URL for the final end-to-end check.
