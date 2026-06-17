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
