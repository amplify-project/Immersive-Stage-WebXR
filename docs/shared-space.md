# One room frame for every headset (WebXR shared spaces)

**Status: working between two Quests, 18 September 2026.** Two headsets in the
same room see the musicians in the same physical place, with no calibration and
nothing sent over the network. What is left is putting the room somewhere
sensible, which is a separate problem — see *The origin is arbitrary*.

Turned on with `?sharedspace=1`. Off by default, and the fallback is exactly the
behaviour that was there before: each person aligns the room by hand.

The in-headset readout (the panel and the cube at the shared origin, see *How to
tell it is not working*) is a separate flag: add `?sharedlog=1`. Without it the
shared frame works the same and nothing is drawn in front of the viewer.

## What it gives, and what it does not

A **common origin**, and nothing else. One transform.

It does not give you the other headset's boundary, the room's geometry, or
anything either headset scanned. Those are different features (`plane-detection`,
`mesh-detection`) and we do not ask for them. The scan matters only as the means
by which a headset recognises the room well enough to be placed in it; not one
byte of it reaches this code.

## What has to be true before it can work

- **Quest browser v39+**, `chrome://flags` → "WebXR experiments" → restart. Per
  headset.
- **Enhanced Spatial Services** on, in Settings → Privacy → Device Permissions
  (older builds call it "Share point cloud data"). Per headset. The shared space
  is built on Meta's Shared Spatial Anchors and this is the permission that
  covers them. Missing on one headset is enough to stop both.
- **Internet**, not just the LAN: the point cloud goes through Meta's servers.
- **Both headsets in session at the same time.** The space exists only while
  somebody is in it, so entering one after the other is not a test: the second
  simply founds a space of its own.
- **Space observed in common.** Colocation matches what this headset can see
  against the shared map. Two headsets that have only ever seen different parts
  of an L-shaped room share no features and cannot be placed relative to each
  other — not a failure, there is nothing to match. Scan the whole room on both,
  corner included, and enter standing together looking at the same wall.

## The traps, in the order they cost us an afternoon

**The space is exposed per PAGE, and `/` is not `/index.html`.** The README says
`bar.com/a.html` cannot see `bar.com/b.html`'s space, and that is true of the same
file reached by two spellings: one headset on `https://host:60000/` and the other
on `https://host:60000/index.html` get **different spaces with different uuids**,
while every other part of the system behaves perfectly. `server.js` now answers
`/` with a 302 to `/index.html`, query string preserved, instead of serving it
quietly, so both headsets end up on one URL whatever was typed. Query strings
still have to match: do not give one headset `&synclog=1` and not the other.

**Ask for the space from inside the frame loop.** The working sample does it
under `if (!spaceRequested)` in its animation loop, with the session already
running. Asking right after `setSession` is before the first frame, early enough
that the browser cannot know which room it is in, and what comes back is a space
of our own that never joins anyone's.

**The property is `UUId`.** Not `uuid`, not `UUID`, not `id`. Guessing spellings
and finding nothing led us to report that the space carried no uuid, which was a
guess failing dressed as a fact. Walk the prototype chain if you ever need to
find another one: WebIDL attributes live there, so a `for...in` over the instance
can miss them.

**And it starts empty.** `UUId` is a string from the beginning and stays `""`
until the space is really established, which the sample gives away by testing
`.length !== 0` rather than existence. Read it once at session start and you
always get the empty one. Empty is "not yet", not "not there" — the panel says
`pending` for exactly this reason.

**The shared space is a BASE for `getPose`, not a target.** The sample only ever
calls `getPose(viewer, shared)`, then hands the space to three as the reference
space. `getPose(shared, local-floor)` — the obvious way round, and what we tried
first — returns a pose that is not null, does not change from frame to frame, and
puts the room anywhere. It looks like a working reading, which is what makes it
expensive.

Three r128 has `setReferenceSpaceType` but no `setReferenceSpace`, so handing the
space to three is not open to us without an upgrade. The same transform composes
out of two viewer poses, and the only new call is the one the sample proves the
browser implements:

```
viewer → local-floor   A   (the viewer pose we already have)
viewer → shared        B   (getPose(viewer, shared))
shared → local-floor   S = A · B⁻¹
```

`roomGroup` hangs off a `sharedGroup` whose matrix is S, so the calibration
inside it is untouched and three keeps its own `local-floor`.

**A `reset` does not need re-requesting, and re-requesting is a loop.** The event
says this space's origin has moved; `getPose` on the same object already returns
the new transform. Asking for a fresh space instead gives one that resolves and
resets in turn, and the resets never stop. Recomputing S every frame absorbs the
event without handling it at all. Do not announce resets on the in-headset panel
either: the notice lasts four seconds, and resets arriving faster than that hide
the panel they were annotating.

## How to tell it is not working

**If where the room lands depends on the boundary, it is not colocated.** The
Quest takes `local-floor`'s origin and orientation from the boundary, so two
similar boundaries put the rooms nearly on top of each other — which reads as
success — and a different boundary sends the room somewhere else. When it really
works the boundary is irrelevant, which is the whole point.

Three readings, all on the in-headset panel under `?sharedspace=1&sharedlog=1`:

- `shared IDENTITY` — S is within 2 cm and a degree of nothing, so we are drawing
  in this headset's own frame whatever the feature says it granted.
- `pose N · null M` — a null pose leaves the last good matrix, which at the start
  is the identity, so without this count "never got a frame" and "got a wrong one"
  draw the same picture.
- The last six characters of the uuid. Different on the two headsets means
  different spaces, and that answers everything at once.

And a magenta cube with a one-metre axis triad sits at the shared origin. Two
headsets seeing it at the same physical point, axes the same way, is the frame
being right; the musicians can then only be wrong for reasons of our own.

`shared-space.html` answers the same question with nothing else attached — no
player, no scene, no network. The sample game cannot: what you see there depends
on PeerJS and on someone else's server, so "I see nobody" does not distinguish a
feature that is off from a network that is down.

## The origin is arbitrary

It is the origin of the first headset that founded the space — wherever that
person happened to be standing. Not the middle of the room, not a corner, and
unrelated to anybody's boundary. So the musicians appearing somewhere absurd is
the expected state of this, not a fault.

That is what the next step is for: one person places the room with the
thumbsticks as today, and that `{x, z, yaw}` is published for everyone else to
apply. In a common frame those numbers finally mean the same thing on every
headset. It needs a downlink on the relay, which is Case C in
[`handoff.md`](handoff.md) — and the same frame makes several headsets' telemetry
directly comparable, which is the other thing the partner asked for.

## What this mode switches off, and why

- **The room anchor.** Inside a common frame it decides nothing, and the quota is
  8 per site with **no way to empty it** (the runtime returns empty UUIDs), so
  spending them here throws them away. Not restored on entry, not saved on exit.
- **The stored calibration**, both directions. A saved `{x, z, yaw}` was measured
  against this headset's own origin, so applying it would give every headset its
  own error; and saving one measured against the shared origin under the same key
  would poison the ordinary path. The calibration still works during the session
  — it is T, and T is what will travel.

These three decisions are taken before the first frame, so they read the flag
rather than `sharedActive`, which is still false at that point.
