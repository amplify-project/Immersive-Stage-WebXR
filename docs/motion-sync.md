# Synchronised playback across devices (Motion) — spike

**Status: measured on two machines, and the late joiner is fixed.** 18 September
2026. Nothing tried on a headset.

The steady state is good: two machines held **16 ms apart**, which is the number
this feature lives or dies by. Joining late was the bad case — 40 s spent up to a
second behind, ending in a correction loud enough to hear as pitch — and the four
changes in *What was wrong with joining late* fix it, in the browser and on the
two machines that showed the fault.

What is left is the headsets, and one open question they will answer: whether the
seek cost the controller now aims ahead by is stable on a Quest, where the decoder
and the network are not the desktop's.

The partner wants a session manager: a desktop page with play / pause / stop /
restart, a list of connected headsets, and a player that, when someone joins late,
lands where everyone else is instead of at the beginning.

## Why a Timing Object and not commands of our own

His own proposal was to send commands stamped with a relay timestamp and let each
headset compute its position. That is exactly right, and exactly why we should not
write it: "position P at time T running at rate R" is the W3C Timing Object, and
Motion is our own implementation of it. Late joining, pause and restart stop being
features and become the same vector read at a different moment, and the clock
synchronisation and the convergence come with it.

It also fits this player particularly well. There is **one** media element: the
multichannel audio hangs off it through Web Audio and the close-up element is
already slaved to its `currentTime`, so a nudge to the playback rate carries sound
and close-up with it. Nothing is synchronised twice.

## What is here

- `src/vendor/motion/` — the Motion client, vendored. ES modules, no build step
  and no npm dependency: every import is relative, which is why it can be dropped
  in as-is. One file needed a fix, an import missing its `.js`.
- `src/app/sync.js` — `attachSync(videoEl, {sessionId, url, offsetSec})`, plus the
  tuning (below). Loaded by dynamic `import()` only when `?sync=` is present, so a
  player without it downloads none of this.
- `timing.html` — the session manager. It is an ordinary client of the same timing
  object that happens to be the one that writes; nothing about it is privileged.
- The player hook: `?sync=<session>`, optionally `&timing=<ws url>` and
  `&syncoffset=<seconds>`. `window.syncDiag()` reports where the vector says we
  should be, where we are, the error, and `leadMs` — what the controller has
  measured a seek to cost on this device.

## Running it

```
node server.js                           # that is all: the timing service is in it
https://<host>:60000/timing.html         # the manager: connect, then Play
https://<host>:60000/index.html?sync=1   # each player
```

The service is mounted on the player's own server at `wss://<host>:60000/timing`
(`telemetry/timing.js`), for the same reason `/ingest` and `/consume` are: WebXR
forces the player over HTTPS, an https:// page cannot open a cleartext `ws://`, and
a service on its own port would mean the headset accepting a second self-signed
certificate — a failure that shows up as nothing at all. One process, one origin,
one certificate.

`?timing=<url>` on the player, or the field on the manager, points somewhere else —
a real motion-server, for instance. Nothing in the client had to change for this:
the service speaks the same wire protocol.

## You cannot test this with two players on one machine

While a player is **actively playing in another tab**, a second player never
loads: Shaka sits in `load()` with no network request and no error — not a slow
load, a silent stall. Close the playing tab and the same page loads instantly.
Reproduced deterministically; two Shaka instances in the *same* tab coexist fine
as long as neither is playing, which points at the decoder rather than at tab
count.

The manifest offers a single representation — 2560×1440 H.264, no lighter
rendition — so there is nothing to fall back to and `?maxh` cannot dodge it.

Two *different browsers* on the one machine do not dodge it either — they load,
and then both starve. Measured on a run that looked for all the world like the
synchronisation failing:

```
stalls: 46   stallTime_ms: 305392   dropped: 465
buf_end_skew_s: -10.579             avDrift_ms: -3580
```

Five minutes stalled, the audio buffer ending ten seconds behind the video's, and
3.6 s of A/V drift *inside a single player*. That last figure is the tell: it is
the same signature as the July saturation, where the cause was the box and never
the player. One player alone on the same machine, the same minute, tracked the
session perfectly.

In the logs it reads as `err` falling by **exactly 1000 ms per second**, which
means the element is not advancing at all while the vector runs — a freeze, not a
drift. Worth knowing by sight.

This is the test rig, not the product: on two machines, or a machine and a
headset, it does not arise. But it will eat an afternoon if you meet it without
knowing. The ten-second check that tells them apart: `avDiag()`. Stalls climbing
and the video buffer ending near `t` is starvation, and it is the rig. For the
silent-load variant, create a bare `shaka.Player` on a new `<video>`, call
`load()` with a timeout, and look at `performance.getEntriesByType('resource')`.
No request means it is this, not us.

The way out, when one machine has to run two, is the lighter rendition we still
owe: `stream.sh` maps a single `0:v:0` for the 360, so the manifest offers one
2560×1440 representation and `?maxh` has nowhere to fall.

## Why the Motion server is not what we run

The client and server we have are from different generations and **do not talk to
each other as shipped**. The client tags every frame with a `timerId` (which timing
object on the service) and ignores any reply that does not carry it back. The
server has never heard of `timerId` — it keys timing objects by the service URL, so
there is one global vector per server — and its replies therefore have none. The
provider stays at `connecting` for ever, silently.

Three small changes make it work, and they are the feature the client expects —
several independent sessions on one service:

1. key `timingAndConnections` by `id + '#' + timerId` instead of `id`;
2. echo `timerId` in the `info` reply;
3. include `timerId` in the `change` broadcast, and send it to *that* timing
   object's connections rather than to a module-global `connections` array.

Rather than carry a patch to somebody else's repository, the four messages that
matter — `info`, `sync`, `update`, `change` — are implemented in
`telemetry/timing.js`, with `timerId` done properly from the start so one service
hosts as many sessions as you like. The hard half of Motion, the client with its
clock and its convergence, is untouched and still theirs. Worth raising the
mismatch with the maintainers all the same.

## What the measurements say

Two machines, one player each, 18 September 2026. Both `err` figures are taken
against the same vector, so their *difference* is the skew between the machines
and no clock alignment is needed.

**Steady state: 16 ms apart.** One player read +17 ms, the other −1 ms, and they
stayed there. That is far inside what the ear resolves for placement (~5-10°
off-axis, some 40 cm at 3 m), and it is the number the feature lives or dies by.

**The rate does not go back to 1 inside the dead band.** Both players sat at a
pinned `1.0063` — the last nudge they were given — because `controlElement()`
takes the "in sync!" branch and touches nothing. So the error does not settle at
zero: it sails slowly across the band, gets nudged at the far edge and comes back.
A limit cycle of ±50 ms at 0.6%, which is the intended behaviour and inaudible,
but it does mean a steady non-unity rate is the healthy reading, not a fault.

**Audio output latency is not the dominant term.** Web Audio adds its own delay
when the element's audio is routed through Omnitone, and it differs per machine:
56 ms and 40 ms here. 16 ms of difference, the same order as the timeline skew,
so the worst case is ~32 ms audible and no per-device correction was needed.
`avDiag().webaudio_outLat_ms` reads it; `?syncoffset=` is the knob if a device
ever needs one.

**The correction is proportional, and 0.6% was its floor, not its ceiling.** The
rate asked for is `1 + diff / amortPeriod`, recomputed ten times a second. The
`minDiff / amortPeriod` = 0.6% this document used to advertise is only the
smallest step, the one taken at the edge of the dead band. The largest is
`maxDelay / amortPeriod` = 0.8/8 = **10%**, over a semitone and a half — and it is
the one a late joiner gets, because it arrives immediately after a seek that
leaves half a second to close. Measured: `rate=1.0505` at 430 ms of error. That is
the artefact the tuning existed to prevent, hiding one case downstream of where we
looked for it.

## What was wrong with joining late

Reloading one player while the other kept going, measured on two machines:

```
08:40:53  err = -122152 ms                 starts at the beginning; the session is at 137 s
08:40:54  err =    -695 ms                 first seek: prompt, and lands 0.7 s late
08:40:55 … 08:41:09  err ≈ -950 ms, rate 1.0000     sixteen seconds, not looking
08:41:10  err =    -453 ms                 window expires, still beyond maxDelay → seek
08:41:10 … 08:41:25  err ≈ -440 ms, rate 1.0000     sixteen more
08:41:26  err =    -379 ms, rate 1.0505    and now the audible correction
```

**A flat `err` at exactly `1.0000` is the signature of a controller that is not
looking**, as against a starved one, whose `err` falls 1000 ms per second. Nobody
had written to `playbackRate`; a controller that is deciding leaves a number with
decimals in it.

And the blind spell **re-arms itself**, which is what turned 16 s into 40:

```
seek  →  buffer flushed, fresh 6 s segment  →  element not advancing
      →  controller reads it as "not playing" (readyState drops)
      →  its answer to that is to seek and go blind again
```

Its own correction creates the condition that triggers the next correction. Four
changes, all in `src/vendor/motion/TimingMediaController.js`, which is ours:

1. **`blindPeriod` is its own setting.** It used to be `amortPeriod × 2`, so asking
   for a *smoother* correction bought a *longer* spell of no correction at all —
   one knob doing two opposite jobs. 1.5 s is enough for a seek to settle.
2. **A gross error breaks the blind period.** `controlElements()` used to return
   flat while the timer was alive. It now looks first, and if an element is beyond
   `maxDelay` it cancels and acts. Deliberately blind to elements that are seeking
   or starved: there the position is not evidence yet, and seeking again would only
   buy another flush.
3. **Seeks aim ahead by what a seek costs.** A flush plus a fresh segment takes
   0.4-0.7 s, and the session clock does not wait, so seeking to the position you
   just read lands late *by definition* — and seeking again cannot close a gap that
   every seek recreates. The controller now aims at `position + seekLead` and
   re-measures `seekLead` per element, from setting `currentTime` to playback
   advancing again. `syncDiag().leadMs` reports what it currently believes.
4. **`maxRateDev` caps the correction.** ±1.5%, about a quarter of a semitone.
   It buys seconds instead of pitch, and the default is wide enough to leave the
   library's original behaviour alone.

`sync.js` passes all four. In simulation — a fake element that charges 500 ms for
every seek — joining 1.6 s late goes from *two seeks, 16 s blind twice, still
−170 ms after 25 s, peak rate 5.8%* to *one seek, inside the dead band from the
first second, peak rate 1.2%*. The simulator's "before" reproduces what the two
machines did (sixteen flat seconds, then `1.0585` against the browser's `1.0505`),
which is why its "after" is quoted here.

**Confirmed in the browser**, on the same two machines and the same reload that
produced the trace above. The figures quoted are still the simulator's: the
browser run was judged by eye and its log not kept. Worth a kept trace next time
one is to hand.

The 0.25 clamp at the end of `controlElement()` — which sets `playbackRate` to a
hard zero, freezing the video on purpose — stays as a curiosity rather than a
finding. With this arithmetic it needs the element to be 6 s *ahead*, which would
have triggered a seek first, so it can only bite when the vector is parked.

## The controller can be asleep, and a late joiner is exactly when

The player would start playing against a session that was parked. Not a race:
`TimingObject` starts its `timeupdate` heartbeat **only inside its change
listener**, and that heartbeat is the only thing that drives the media controller.
A client joining a session that already exists is told about it with `info`, not
with `change` — so nothing starts the heartbeat, the controller never runs, and our
player, which autoplays as soon as it has loaded, plays on against a stopped clock
until somebody presses a button on the manager.

That is every late joiner, which is the feature.

`sync.js` carries a 1 Hz watchdog for exactly the case where the controller is
demonstrably not doing its job — the session is parked and we are playing anyway —
and it pauses us and lands us where the session is. It deliberately does not chase
a *running* session: there the controller does wake up, and two things steering one
element is worse than either. Verified: join a parked session and the player stops
at the session's position; press Play and it follows normally; press Pause and it
stops with it.

The real fix is in the library: start the heartbeat whenever the vector has
velocity, however that vector arrived.

## One more trap: the offset is in milliseconds

`addMediaElement(element, offset)` stores `offset / 1000`, so despite the name —
and despite everything else in the API being seconds — it wants milliseconds.
`sync.js` multiplies. A per-device correction of 0.5 s passed as `0.5` would
otherwise be half a millisecond, i.e. nothing at all, silently.

## What this does not need

**No downlink on the relay.** The timing object is its own channel in both
directions, so the control page writes to it and the players follow. The relay
keeps doing what it does — and its player map is already the "list of connected
headsets" the manager wants, while `mt` and `srv` in the telemetry already let us
check afterwards that everyone was in sync. On headsets, that is the only check
there is: inside an immersive session there is no console to read and `toast()`
reaches nobody. On a desktop it records nothing at all — `sample()` runs only in
VR or AR — so there the check is `syncDiag()` in each browser. Two of the partner's three asks are
therefore done, and the downlink stays where it belongs: Case C, the camera
positions, in [`handoff.md`](handoff.md).
