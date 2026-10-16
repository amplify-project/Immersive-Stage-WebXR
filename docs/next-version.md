# Next version — notes from the client deployment

Open items gathered after the first on-site live deployment (July 2026) and the
follow-up in October 2026. Each one says what we saw, what is already done, and
what is left. Status as of 2026-10-16.

## 1. Device monitors open ALSA in the wrong format — fixed

`monitor_sync.sh` and `measure_sync.sh` (the editor's **Medir sync**) opened ALSA
without `-acodec`, so ffmpeg asked for S16_LE. The client's mixer only takes
**S32_LE, 18 channels**, so both failed at open, while the live encode worked
(`stream.sh` already queried the device since 17b0ecb).

Done: both scripts source `alsa_probe.sh`, which asks the device with
`arecord --dump-hw-params` (under `LC_ALL=C`) and picks S32_LE, else S16_LE. The
channel count from the editor is kept unless the device would refuse it. The
camera frame rate is no longer hard-coded to 24: `FPS=`, which the server fills
from `live.video.fr` for Medir sync (the X5 over UVC only gives 30).

Left: `stream.sh` still has its own inline copy of the query; move it to
`alsa_probe.sh`. Its fallback to `S24_LE` maps to `pcm_s24le`, which is packed
3-byte (ALSA `S24_3LE`), not ALSA's `S24_LE` — drop it, as `alsa_probe.sh` does.
`monitor_sync.sh` still defaults to `/dev/video10` (the X4 bridge); the client's
X5 is `/dev/video6`.

## 2. Italian locale — fixed, plus a belt-and-braces option

`arecord -l` is translated ("scheda" for "card"), so the editor's ALSA list came up
empty. Fixed in 873003e (enumeration runs under `LC_ALL=C`). For older copies
without that commit, start the server under `LC_ALL=C.UTF-8 LANG=C.UTF-8`;
`tools/install-service.sh` does this and starts the server at boot as a systemd
service (the client had already set up autostart on their own).

## 3. `scene.json` is in git and holds per-machine settings

The `live` section (camera device, size, fps, ALSA device, channels, delay) is
machine-specific, but `scene.json` is tracked, so updating a site from `main`
replaces its capture settings with our lab's (`/dev/video0`, 1 channel, 24 fps).
Split the per-machine `live` block into an untracked file (e.g. `live.local.json`),
or ship `scene.example.json` and stop tracking `scene.json`.

## 4. Chrome fails on the client's machines, Firefox works — open

Seen on two machines (Ubuntu 22.04 and probably a Mac): "format" errors in Chrome,
fine in Firefox; fine in our Chrome. Not resolved. Our streams carry 10-channel
Opus and play in Chrome, so ">8 Opus channels" alone is not it. To collect:

- `chrome://version` (Chromium snap or Google Chrome?)
- the Shaka error code from the console (1xxx network · 4032 unsupported codec ·
  3014/3016 decoder)
- `MediaSource.isTypeSupported` for the codecs in their `manifest.mpd`
- their `manifest.mpd`: channel count and video resolution/level differ from ours
  (18-channel mixer, X5 camera)
- whether our Chrome plays **their** stream URL

## 5. Watching the live with low latency during production setup

Through S3 + CloudFront the live is ~20 s behind, too slow to set up a production.
What exists today:

| Need | Tool | Latency |
| --- | --- | --- |
| Raw camera + mixer channels, A/V delay | `monitor_sync.sh` (or mpv/ffplay on the devices) — before the encode only | < 0.3 s |
| Final result, spatial audio | local encode without `S3_BUCKET` (LL-DASH) + **Open player** | ~5 s |
| Final result as the audience gets it | CloudFront player | ~20 s |

Left:

- The devices are exclusive (ALSA `hw:`, one v4l2 reader), so the raw monitor
  cannot run during the encode. To watch them while live: share the audio with
  `dsnoop` and the camera through `v4l2loopback`.
- In local mode the player sits at a fixed 5 s (`player.js`, `T_LIVE`);
  `?livedelay=` can only raise it. Let it go down to ~2 s on the local
  LL-DASH stream and test at 4K for rebuffering.

## 6. Mute / solo stems for production tests

Everything travels in one multichannel stream (4 FOA + N stems), so muting a
musician at the mixer mutes them for the audience too. Checking stems one by one
has to happen in the player, which only affects that viewer.

Note that at rest the stems are silent (`restGain = 0`): they only come up with the
zoom/AR focus, and the bed carries the music. So "mute a stem" alone tells you
little; what a sound engineer needs is **solo**: hear stem *i* alone, at full level,
whatever the spotlight is doing, with the bed and the other stems off.

Proposed design:

- An extra GainNode per stem **after** the spotlight gain (`trim → spotlight →
  mute → panner`), so the spotlight keeps writing its gain and the test controls
  never fight it. Same for the bed.
- Engine API: `setStemMute(i, on)`, `setStemSolo(i | null)`, `setBedMute(on)`.
  Solo forces that stem to unity and mutes everything else.
- UI: an operator panel in the player, behind `?operator=1` (one M/S button per
  stem with its name, plus Bed), not saved to `scene.json`.
- Later: drive it from the editor through the server, so the engineer at the desk
  can solo a stem on the player someone else is wearing.
