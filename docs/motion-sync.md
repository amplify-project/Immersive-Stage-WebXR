# Synchronised playback across devices (Motion) — spike

**Status: a spike that works end to end, with two things to fix before it is a
feature and one measurement still owed.** Desktop, two tabs, September 2026.
Nothing tried on a headset.

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
  should be, where we are, and the error.

## Running it

```
PORT=8099 node server/server.js          # the Motion server, patched — see below
https://<host>:60000/timing.html         # the manager: connect, then Play
https://<host>:60000/index.html?sync=1   # each player
```

`ws://` to localhost is allowed from an `https://` page, so the desktop spike needs
no TLS. **A headset will need `wss://` from our own origin**, because the player is
served over HTTPS and a page like that cannot open a cleartext socket. That means
mounting the timing endpoint on our own server the way the relay already mounts
`/ingest` and `/consume` — one origin, one certificate, nothing extra to accept.

## You cannot test this with two players on one machine

While a player is **actively playing in another tab**, a second player never
loads: Shaka sits in `load()` with no network request and no error — not a slow
load, a silent stall. Close the playing tab and the same page loads instantly.
Reproduced deterministically; two Shaka instances in the *same* tab coexist fine
as long as neither is playing, which points at the decoder rather than at tab
count.

The manifest offers a single representation — 2560×1440 H.264, no lighter
rendition — so there is nothing to fall back to and `?maxh` cannot dodge it.

This is the test rig, not the product: on two machines, or a machine and a
headset, it does not arise. But it will eat an afternoon if you meet it without
knowing, because it looks exactly like the synchronisation being broken. The
ten-second check that tells them apart: create a bare `shaka.Player` on a new
`<video>`, call `load()` with a timeout, and look at
`performance.getEntriesByType('resource')`. No request means it is this, not us.

## The Motion server needs a patch

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

Worth raising with the Motion maintainers rather than carrying a patch.

## What the measurements say

**Tracking, once running and undisturbed: good.** Error within ±40 ms of the
session, which is far inside anything the ear resolves for placement.

**But the default tuning wobbles the rate audibly.** The controller holds that
±40 ms by closing whatever gap it finds within one second, which means the playback
rate sitting at 0.955 or 1.043 and flipping between the two every couple of
seconds. For a talking head, invisible. For music, ±4.3% is about ±0.7 of a
semitone, wobbling.

The arithmetic is `minDiff / amortPeriod`, and both are options, so this is tuning
and not surgery. `sync.js` asks for a 50 ms dead band closed over 8 s → 0.6%,
inaudible, with the error still inside 50 ms. *(Reasoned from the constants and the
measured behaviour; not yet re-measured in isolation, because every run since has
involved a seek — see below.)*

**After a seek, there is a window where nothing is corrected at all.** A late
joiner does jump to the session position — that part works — but it lands 0.6 to
0.8 s late, because the seek costs a buffer flush and a fresh 6 s segment, and it
then holds that offset, at rate 1.0, for a while. Measured at −810 ms and −630 ms,
and once at −14.5 s after a pause/play.

The cause is `amortPeriod`, doing a second job its name does not admit. After a
seek or a play, `controlElements()` returns immediately for `amortPeriod × 2000`
milliseconds — no correction of any kind. At the default that is 2 s. At the 8 s we
ask for, **sixteen**.

So the two settings are coupled the wrong way round: the smoother the correction,
the longer the controller cannot correct. Decoupling them is a small change in the
library, which is ours.

**Once the window expires, it does close the gap — measured.** Sampling a late
joiner for 30 s past the blackout: −360 ms → −194 → −134 → −98 → −72 → −52 → −25 →
+5 → +31, then it turns round and trims the overshoot. The rate stays between 1.006
and 1.023 throughout, settling at 1.006 — nothing like the ±4.3% flapping of the
defaults, which also confirms the tuning above does what it was meant to.

So the cost of joining late is not a permanent offset. It is about 16 s blind
followed by a smooth ~30 s catch-up. (An earlier version of this document claimed
the residual was never trimmed; every sample behind that claim had been taken
inside the blind window.)

Two ways forward, neither tried:

- **In the library**: give the blind window its own constant instead of deriving it
  from `amortPeriod`, so smoothness and responsiveness stop trading against each
  other. Then re-measure the residual.
- **From outside**: watch `syncDiag().errMs` and nudge when it sits outside the
  dead band with the rate at 1. A workaround, and a second controller fighting the
  first.

Whether a late joiner landing ~0.7 s behind for ~16 s matters is the partner's
call: for pointing at the same musician it is nothing, for clapping together it is
not.

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
check afterwards that everyone was in sync. Two of the partner's three asks are
therefore done, and the downlink stays where it belongs: Case C, the camera
positions, in [`handoff.md`](handoff.md).
