# Shared spaces: one origin for two headsets

**Status: researched, nothing built, nothing tried on a headset.** Written in
September 2026 so the next person with two Quests in a room can settle it in ten
minutes instead of a day. Everything below about our own code is fact; everything
about the feature is documentation and one sample README, not experience.

## The problem this would solve

`local-floor` puts the origin wherever each user started their session, so the same
musician lands somewhere different for every spectator. Today that is corrected by
hand, per headset: hold the grip, move the room until it sits where it should
(see [`handoff.md`](handoff.md) → *Room alignment*).

For one person that is enough. For two it is weak, and worth being honest about:
each headset still measures from its own independent origin, and the only thing
tying them together is that two people separately eyeballed the same floor mark.
There is no way to hand one headset's alignment to the other — the WebXR anchors
module has no sharing at all, and an anchor cannot even be serialised and sent over
the network (open since 2020: immersive-web/anchors#81). Our `{x, z, yaw}` are
measured from an origin the other headset has never heard of.

Note this is *not* what the persistent room anchor solves. That one makes a single
headset find the room again on the next session. It says nothing about a second
headset.

## What the Quest browser offers

An experimental feature called **shared spaces**: headsets in the same room are
given a common coordinate system, automatically.

- Add `shared` to the features in `requestSession`, then ask for a `shared`
  reference space once the session is running.
- What comes back is proposed as `XRSharedReferenceSpace`: an ordinary reference
  space **plus a UUID string**.
- Enabled per headset in `chrome://flags` → "WebXR experiments" → restart.
  Announced for v39 of the Quest browser.

It is a proposal, not spec: it asks for `shared` to be added to
`XRReferenceSpaceType` and for the new object to exist. Quest-only — underneath it
is Meta's Shared Spatial Anchors and there is no vendor-neutral OpenXR extension.

## How the sharing actually works

Three mechanisms chained, and each one can fail on its own:

1. **Discovery — Bluetooth, local.** A headset advertises (a random UUID plus up to
   1 KB of metadata) and nearby ones listen. Range about 9 m, and only visible to
   the *same application* — for WebXR, the same site.
2. **The space itself — Meta's cloud.** What travels is not an anchor but the
   **room**: layout and scene anchors, uploaded by the host and downloaded by the
   guests against a group UUID. So it needs an internet connection, and the
   *Spatial Data* device permission (Settings → Privacy → Device Permissions).
   The customer's room map goes to Meta's cloud; somebody has to agree to that
   before the concert, not on the day.
3. **Relocalisation — against the real geometry.** The guest headset does not
   receive a pose. It receives the map and *recognises itself inside it*, which is
   why the native docs tell you to walk around the area to make it work, and why
   there is a "Clear Physical Space History" for when it comes out crooked.

The origin of the **first** headset to create the space becomes the origin of the
common space. Later arrivals relocalise onto it.

> Mechanisms 1 and 2 are documented for the native APIs (Colocation Discovery,
> Space Sharing). That the browser chains them is inference from the announcement,
> which says the feature runs on Shared Spatial Anchors. The browser's own
> documentation does not mention shared spaces at all.

## What the page can actually observe

This is the part that decides whether the feature is usable, and it is thinner
than it looks.

| State | What your code sees |
|---|---|
| Flag off, or unsupported | The feature is not granted; asking for the `shared` reference space fails. Clean and detectable. |
| On, and you were first in | A shared space, its UUID, **no `reset`**. Your origin is now the common one. |
| On, joining someone else | A *default* space for a second or two, then a `reset` on it carrying a new coordinate system and a new UUID. |
| On, but alone or never synced | A *default* space, its UUID, no `reset`. |

The last two rows of that table are the point: **locally you cannot tell whether
it worked.** "I was first" and "nobody found me" look identical — no reset in
either case. The only thing that distinguishes them is the UUID, compared with the
other headsets over a channel of your own.

That is exactly what Meta's sample does: each headset sends its shared-space UUID
to a server, which returns the list of headsets carrying the same one.

**We already have that server.** The telemetry relay would group by UUID published
in the `hello`, and that list is also the "connected headsets" the session manager
wants — the same mechanism answers both.

## What adopting it would cost

Three changes, none of them big:

1. `shared` in `optionalFeatures`, and request the `shared` reference space with a
   fallback to `local-floor`. Today we ask only for `local-floor`
   (`src/app/player.js`, `enterAR()`).
2. **Listen for `reset` and rebuild the room** — `clearARSources()` +
   `buildARSources()`, which already exist. Without this the feature is worse than
   not having it: `bindStemToObject()` reads `matrixWorld` at bind time, so if the
   origin moves two seconds after entering, every marker *and every panner* stays
   anchored to an origin that no longer exists, and the band is heard and seen
   offset right after the session starts. We have no `reset` listener anywhere.
3. Decide what happens to the persistent room anchor. In a shared frame it is no
   longer what the room hangs from.

And three traps worth writing down before anyone starts:

- **The shared space is per URL, not per origin.** The sample README is explicit:
  two pages on the same host get different spaces. So a separate `index_synced.html`
  — the shape the partner proposed for the session manager — would sit in a
  *different* shared space from `index.html`. A synced mode has to be a query
  parameter on the same page.
- **Leaving WebXR loses it.** The space is recreated on re-entry, and when the last
  participant leaves it is gone.
- **Hand calibration has to happen after the reset**, or the drag is thrown away by
  it.

## How to test it, without writing any code

Meta's sample is published and playable: `sharedshooter.arvr.social`. With two
headsets and the flag enabled, it answers everything that matters here:

- Is the flag present on this build at all, or has the feature moved or gone?
- Does it colocate *in this room*, and how long does it take?
- Does it survive one participant leaving and coming back?
- How good is the alignment, judged against a floor mark?

If it does not colocate there, it will not colocate in our player either.

## What is not verified

All of it, device-side. Also whether the feature is still behind the flag: the
announcement is from June 2025 and browsers move. **Feature-detect at runtime**
rather than trusting a version number — which we should do anyway, since the
fallback is the hand alignment we already ship.

## Sources

- <https://github.com/cabanier/shared-spaces> — the proposal and the sample, from
  Meta's browser team. The properties and API shape above come from here.
- <https://github.com/immersive-web/anchors/issues/81> — anchor sharing, still out
  of scope for the spec.
- <https://developers.meta.com/horizon/documentation/web/webxr-mixed-reality/> —
  the browser's mixed-reality documentation: persistent anchors on-device, 8 per
  site, and no mention of shared spaces.
- <https://developers.meta.com/horizon/documentation/native/android/openxr-colocation-discovery-overview/>
  — discovery by Bluetooth advertisement, ~9 m, same app.
- <https://developers.meta.com/horizon/documentation/native/android/openxr-space-sharing-api-ref/>
  — what travels (the room and its anchors), through the cloud, and the Spatial
  Data requirement.
