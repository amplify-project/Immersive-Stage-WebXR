# Synchronised playback across devices (Motion) — spike

**Status: a spike that works, with one finding that blocks the partner's exact use
case.** Measured on the desktop, two tabs, September 2026. Not tried on a headset.

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

> **What is not established.** Every post-seek sample above was taken *inside* that
> blind window — 7 to 12 s of sampling against a 16 s blackout — so these
> measurements do not show that the residual is never trimmed, only that it is not
> trimmed while the window is open. Whether the controller closes the gap once the
> window expires still has to be measured: seek, then sample for 30 s or more. The
> earlier version of this document claimed the stronger thing; it was wrong.

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
