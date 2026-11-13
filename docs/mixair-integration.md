# MIXaiR integration (proposal, not implemented)

Status: **design agreed in principle, nothing built yet** (2026-11-12).
Source: Salsa Sound's "Spatial Audio Pipeline" PDF (4 pages), plus a
follow-up answer from them: the WebSocket is **MIXaiR → server only**, on
localhost. It does not go to the clients.

## What the partner proposes

1. **MIXaiR for capture and processing.** MIXaiR is Salsa Sound's proprietary
   audio engine (C++). It runs headless on the server machine, detects the
   audio inputs, gives each mic a stable ID (`device:input`), and streams each
   active mic as mono 48 kHz float32 in 10 ms frames (480 samples) over a
   localhost WebSocket. The server is MIXaiR's GUI: it sends start/stop
   commands, and the operator sets position, gain and mute for each mic.
2. **Steam Audio on the WebXR players** as the spatial renderer, with Web
   Audio `PannerNode` as the fallback.

Their roadmap:
- Phase 1: mono mics end to end, plus the operator panning GUI.
- Phase 2: bring back ambisonic sources split into fixed-direction objects,
  and expose more of the MIXaiR API in the GUI.
- Phase 3: raw ambisonic option, per-mic processing (noise reduction, EQ,
  automatic gain), monitoring, and Steam Audio room acoustics.

### Their data contract (MIXaiR ↔ server)

One WebSocket. JSON text carries control, binary carries audio.

| Message | Direction | Content |
|---|---|---|
| `sources` | MIXaiR → server | Every mic: `id`, `name`, `sampleRate`, `frameSize`, `active`. Sent on connect and whenever a mic appears or disappears. |
| `audio` | MIXaiR → server | One 10 ms frame of one mic: `id`, `seq` (gap detection), `timestamp` (µs), 480 float32 samples. A binary header followed by the samples; the exact byte layout is **not specified yet**. |
| `command` | server → MIXaiR | e.g. `{ "type": "command", "action": "start", "id": "..." }` |

## The agreed solution: MIXaiR is an optional audio *source*

**Rule: everything must keep working without MIXaiR.** The repo is public
under GPLv3 and MIXaiR is proprietary, so MIXaiR plugs in as an extra and is
never a dependency.

From the encode onwards nothing changes: one multichannel Opus track
(FOA bed + N stems) in the same DASH MPD as the video → S3/CloudFront →
a single Shaka on the `<video>` → Web Audio. A/V sync, the CDN, the recording
(`vod/`) and the player all stay as they are. The only thing that changes is
**where the channels that go into ffmpeg come from**:

```
                     ┌─ audio device (today): X32 / 18ch mixer by channel index ─┐
editor: audio source ┤                                                            ├─> stream.sh/ffmpeg ─> Opus multichannel + video ─> DASH ─> CDN ─> player
                     └─ MIXaiR: WS (localhost) ─> server.js interleaves ─> pipe ──┘
```

### Server side (`server.js`), MIXaiR mode

1. Connect to MIXaiR's WebSocket and keep the `sources` list. Show it in the
   editor so the operator can pick mics and map them to stems.
2. **Fixed channel count.** An Opus stream cannot change channel count during
   a live. The channel layout is fixed when the live starts (from
   `scene.json`). A mic that stops or disappears **keeps its channel and gets
   silence**. Its position is kept too, as their doc already says.
3. **Interleave.** Align each mic's frames by `timestamp`/`seq`, fill gaps
   with silence, and write interleaved `f32le`, 48 kHz, N channels to a FIFO
   or to ffmpeg's stdin.
4. `stream.sh` gets a new input type that reads that pipe
   (`-f f32le -ar 48000 -ac N -i <fifo>`) in place of the ALSA device. The
   rest of the filtergraph (stems → mono, `amerge` after the FOA bed,
   `adelay`) is unchanged.

Alternative with no server code: MIXaiR outputs to a virtual sound card
(ALSA loopback / PipeWire / JACK) and `stream.sh` reads it like the X32. This
only works if MIXaiR can output to a sound device. Ask them.

### The ambisonic bed

Their phase 1 has mono mics only. We **keep the FOA bed**, because it is the
main sound and the stems are the spotlight. Either it keeps coming from the
device as today, mixed with the MIXaiR stems inside ffmpeg (two inputs:
clock drift between them must be checked), or MIXaiR passes the 4 FOA
channels through untouched. Splitting the bed into fixed objects (their
phase 2) loses quality compared with decoding the ambisonics, so it is not
the default.

### A/V offset

`live.audio.delay` still compensates it. **Re-measure** in MIXaiR mode,
because MIXaiR and the WS path add their own latency (see the clap method in
the editor's 📐 measurement).

### Live positions (worth taking from their proposal)

Today the player reads stem positions from `scene.json` at load time. Their
operator GUI moves sources during the live. That needs a small control
channel server → players (positions, gain, mute). It carries little data, its
latency barely matters and it does not touch A/V sync. The audio itself stays
in DASH.

### Steam Audio (independent, can be tried any time)

Try it as an alternative renderer inside `ImmersiveAudioEngine` behind a
flag (e.g. `?renderer=steam`), reading the same multichannel Opus. It would
fix the mismatch where the bed uses Omnitone's HRTF and the stems use
`PannerNode`'s (see `audio-pipeline.md`). It could also add reflections and
reverb. There is **no official web build**. The closest is the third-party
[three-steam-audio](https://three-steam-audio.pages.dev/getting-started/)
(WASM + AudioWorklet). Measure CPU on Quest first, where the 360 decode is
already tight. Licence: Apache 2.0, compatible with GPLv3.

## What we drop from their proposal

- **Raw PCM to the clients and the per-object client jitter buffer (their
  stage 6).** A jitter buffer is a 20–40 ms reserve that smooths uneven
  packet arrival. It only makes sense if clients receive loose real-time
  frames. With DASH, Shaka already buffers seconds. Since the WS is server-only,
  stage 6 should come out of their doc.
- "The server forwards both message types unchanged" to clients: no. The
  server forwards positions/gain/mute only. Audio goes through ffmpeg.

## Open questions for Salsa Sound

1. The binary header layout of the `audio` frame (their example shows JSON
   with base64).
2. Can MIXaiR output to a virtual sound device? That would make the server
   bridge unnecessary.
3. Can MIXaiR pass the FOA bed through untouched?
4. Is MIXaiR's `timestamp` clock the same as the system clock? How much
   latency does it add?
5. Licensing and distribution: what can live in a public GPLv3 repo (only
   our client code for their protocol, presumably)?
6. Can they confirm stage 6 (client jitter buffer) is dropped and that
   server → clients stays DASH?
7. Do they have Steam Audio running in a browser or on Quest, or is it an
   assumption?

## Work list (when we pick this up)

- [ ] Get answers to the questions above.
- [ ] `stream.sh`: a pipe/FIFO `f32le` audio input type.
- [ ] `server.js`: MIXaiR WS client, `sources` list, frame interleaver with
      silence fill, start/stop commands.
- [ ] Editor: "Audio source: device / MIXaiR" selector, mic → stem mapping.
- [ ] Decide how the FOA bed enters in MIXaiR mode; check drift if it mixes
      two inputs.
- [ ] Re-measure `live.audio.delay` in MIXaiR mode.
- [ ] Live positions channel server → players.
- [ ] Spike: Steam Audio renderer behind a flag, CPU on Quest.
