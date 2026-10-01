# Recording what the participant says

**Status: working on a Quest 3.** 21 September 2026. The question that decided
whether any of this was worth writing — *does Quest Browser hand out a
microphone while an immersive session is running?* — is answered: **yes**. A
37-second recording came back with 32.5 s of it captured between `enter-vr` and
`exit-vr`, no gaps (the longest hole between chunks was 1.17 s, i.e. one chunk),
and it joined the pose CSV to 19 ms. The numbers are in *What the headset said*.

Both ends also have automated tests: `npm run test:voice` in `telemetry/`.

Off by default. It records a person, so it turns on only when asked:
`?voice=1`, or `"voice": { "enabled": true }` in `scene.json`.

## What it is for

The pose telemetry records where somebody looked. It cannot record *"I can't see
the sax"*, which is the sentence that told us the azimuths were wrong. So the
microphone goes to the server in Opus chunks, and every chunk is stamped with
the player's **media time** — the same column `telemetry/recorder.js` writes as
`media_s`. The sentence and the head that was turning while it was said join on
that column; nobody has to line up two clocks afterwards, or hold a stopwatch.

## Running it

```
node server.js                                  # the service is in it, like the relay and the timing one
https://<host>:60000/index.html?voice=1&telemetry=…
```

Press **REC** on the flat page, grant the microphone, then enter VR. From the
second session on there is nothing to press: the permission is remembered per
origin and the player starts recording by itself.

Out come, in `recordings/`:

```
2026-09-21T10-31-04-882Z_p-3f8ac1.webm     the audio, raw from MediaRecorder
2026-09-21T10-31-04-882Z_p-3f8ac1.jsonl    one line per chunk, and the landmarks
```

The `.webm` has no duration and no cues — it plays, it does not seek. One copy
without re-encoding fixes it (measured: `duration=N/A` before, `36.539` after):

```
ffmpeg -i 2026-09-21T10-31-04-882Z_p-3f8ac1.webm -c copy fixed.webm
```

`Error parsing Opus packet header` on decoding is **cosmetic**: it appears once
per decode, including when seeking straight to the last two seconds, so it is
the decoder reading the container's Opus header at start-up and not a damaged
packet. Everything decodes.

## Why the microphone is asked for on the flat page

Two reasons, either one of them enough:

- **A permission prompt cannot be painted inside an immersive session.** Asking
  there is asking a question nobody can see.
- **`requestSession()` needs the user activation from the button press**, and
  awaiting a permission prompt spends it. Entering VR would then fail for a
  reason that has nothing to do with VR, which is the kind of failure that costs
  an afternoon.

Hence the REC button, and hence the player checking `navigator.permissions` on
load so that the second session onwards needs no button at all.

## The files, and why a part is a file

`MediaRecorder` produces a **stream**: the first chunk carries the container
header, and every chunk after it is undecodable without that header. So one
recorder run is one *part* and one file.

While the socket is down chunks queue **in memory** rather than being dropped —
mono Opus is about 4 KB/s, so the 16 MB default is roughly an hour — and on
reconnect they flush in order into the same file, which the service opens for
append. Only when the queue passes its cap does the part end and a new one open:

```
2026-09-21T10-31-04-882Z_p-3f8ac1_p1.webm
```

An extra file, with a header of its own, and never a corrupt one. The `.jsonl`
records the seam as a `resume` (reconnected inside the part) or an `end` + a new
part file.

## The sidecar

One line per chunk, plus a `start`/`resume` at the top, an `end` at the bottom,
and a `mark` wherever something happened:

```json
{"type":"start","id":"p-3f8ac1","stamp":"…","part":0,"mime":"audio/webm;codecs=opus","meta":{…},"srv":1758448800123}
{"p":0,"i":0,"bytes":4096,"t0":0,"t":1002.3,"mt0":12.51,"mt":13.512,"w":1758448800100,"srv":1758448800123}
{"type":"mark","ev":"enter-vr","t":4210.5,"mt":16.72,"w":1758448804310,"srv":1758448804333}
{"type":"end","chunks":842,"bytes":3412992,"secs":842.1,"srv":1758449642901}
```

- `mt0`, `mt` — media time at the start and the end of the chunk. **This is the
  one to join on.** Both ends are recorded because a single stamp gets read as
  the start by half the people who open the file and as the end by the other
  half.
- `t0`, `t` — the player's monotonic clock. Deltas within one recording.
- `w` — the headset's wall clock at capture, for correlating with something
  outside the system: a camera, a notebook, an observer's log.
- `srv` — arrival on this machine's clock. It includes the network and whatever
  the chunk spent queued, so it is for debugging the transport, not for analysis.
- `mark` — `enter-vr`, `exit-vr`, `enter-ar`, `exit-ar` today. `voice.mark('x')`
  from the console adds one. Marks are sent out of band and are not queued: one
  lost to a dropped socket costs a landmark, not a word of audio.

**Reading it against the poses.** Two things tie them together. Both carry the
same player id — the voice recorder takes the telemetry's, which is what makes a
join possible at all, so without telemetry there is nothing to join to — and the
pose side carries the **name of this recording** in its `rec` field: the service
answers the player's hello with the name it gave these files, the player puts it
in its telemetry `meta`, and the relay promotes it onto every record the way it
does `frame` (see [`telemetry.md`](telemetry.md)). So a CSV row says which audio
it belongs to, and nobody has to match up timestamps by hand or keep a manifest:

```
$ head -2 session.csv | cut -d, -f3,5,21
id,media_s,rec
p-pao9ev33,13.512,2026-09-21T07-40-29-861Z_p-pao9ev33
```

Then:

```python
import pandas as pd, json
poses  = pd.read_csv('session.csv')
chunks = pd.DataFrame([json.loads(l) for l in open('…_p-3f8ac1.jsonl')])
chunks = chunks[chunks.i.notna()]
# 'he said it at 13.5 s of media time' -> where was he looking then
poses[(poses.id == 'p-3f8ac1') & poses.media_s.between(13.5 - 1, 13.5 + 1)]
```

Media time is the right key for anything that happened while the piece was
playing. It is *not* a clock: it stands still when paused and jumps on a seek,
so use `w` or `srv` for the stretches before playback starts and across a seek —
which is also why both are written.

**And there is a second axis, free.** The sidecar's `t0`/`t` and the pose CSV's
`client_ms` are the *same clock*: both are `performance.now()` read in the same
page, so they line up with nothing to convert, for as long as the page is not
reloaded. It is the axis to use exactly where media time is no use — paused,
seeking, or before playback has started. On the session of 21 September the two
axes agree, which is the cross-check worth doing once on any recording:

```
pose:          t = 23602.4                    mt = 19.921
voice chunk 12: t = 22750.2 → 23771.7          mt = 19.069 → 20.090
```

## The bleed, and how to use it

The Quest's speakers are open, so the mix ends up in the recording underneath
the voice. Echo cancellation is on by default because intelligibility is what
this is for.

But the bleed is also a free acoustic reference: with it unprocessed, the
recording can be cross-correlated against the programme to recover the alignment
without trusting any clock at all. That is the fallback if the media-time stamps
ever look wrong, and it is why the constraints are configurable:

```json
"voice": { "enabled": true, "constraints": { "audio": { "echoCancellation": false, "channelCount": 1 } } }
```

## Configuration

`scene.json`:

```json
"voice": {
  "enabled": true,
  "timesliceMs": 1000,
  "bitsPerSecond": 32000,
  "url": "wss://otherhost:60000/voice"
}
```

By URL: `?voice=1` forces it on, `?voice=0` forces it off whatever the scene
says, `?voice=wss://host/voice` sends it somewhere else. Server side, `VOICE=0`
in the environment does not mount the service at all.

Without `url` it goes to `/voice` on the origin the player was loaded from —
same reason as `/ingest` and `/timing`: WebXR forces the player onto HTTPS, an
https:// page cannot open a cleartext `ws://`, and a service on its own port
would mean a second self-signed certificate for the headset to accept, a failure
that shows up as nothing at all.

## Recording a person

- **It shows.** A blinking red `● rec` badge on the page, and the REC button goes
  red. Inside the headset the only honest indicator is the system's own
  microphone one, which is why `stop()` releases the track immediately rather
  than when the last byte has gone: the light going out is the sign.
- **The recordings do not leave the machine.** They are in `.gitignore`, and
  `server.js` refuses to serve `recordings/` over HTTP — the filenames are a
  timestamp and a player id, which is not much to guess.
- **Consent belongs to the test protocol, not to this code.** Tell people they
  are being recorded, what it is for and how long it is kept, before the headset
  goes on. It is personal data.

## What the headset said

Quest 3, Quest Browser, 21 September 2026. One session: REC on the flat page,
grant, enter VR, talk, come out.

- **The microphone survives entering VR.** 36 chunks over 37 s, of which 32 (32.5
  s) arrived between the `enter-vr` and `exit-vr` marks. The longest gap between
  consecutive chunks was 1.17 s — one chunk — so nothing stopped and restarted at
  the session boundary. This was the one that could have sunk the feature.
- **The join lands at 19 ms**, and that is the pose grid, not the audio: 20 poses
  fall inside every one-second chunk, exactly the 20 Hz the telemetry samples at.
  Both files carried the same id (`p-pao9ev33`) without anybody arranging it.
- **What comes out is Opus, mono, 48 kHz**, averaging about 22 kbps — 97 KB for
  the 37 s. Chunk sizes ran 1.4–3.8 KB, which is the VBR following the content
  rather than encoding silence.
- **Level: mean −40 dBFS, peak −15 dBFS.** There is signal, with the headroom you
  would expect from a recording that is mostly pauses.

## What is still open

1. **Is the voice intelligible over the bleed?** Nobody has listened to the
   recording yet, and the level says nothing about what is under it. Worth
   hearing with echo cancellation on and off: what plays in the headset is loud
   and close.
2. **Does the queue behave on a real network?** Pull the server's cable mid
   session and put it back: the recording should continue in one file, with a
   `resume` line in the sidecar. Tested in simulation, not on a headset.
3. **A long one.** The session above was 37 s. An hour-long recording is a
   different test for the memory the queue is allowed and for the browser's own
   patience.
