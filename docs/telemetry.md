# Pose telemetry & presence

Feeds an **external AI/render backend** with each viewer's head **rotation,
position and gaze**, in real time. Players publish; an external render (e.g.
Unity) consumes the latest pose of every player. Players never see each other in
the immersive player itself — the shared view lives entirely in the external
render.

```
 Player A ─┐
 Player B ─┼─ WS /ingest ─▶  relay (in-memory)  ─▶  WS /consume ─▶  Unity render
 Player N ─┘                 Map<id,pose> + TTL
```

## Why no Redis (yet)

Telemetry here is **ephemeral** — only the *now* matters, no history to persist.
A single Node process holds all state in a `Map`, fans out to consumers, and
does presence with a TTL sweep. That is lower latency and fewer moving parts
than Redis.

Add a Redis pub/sub backplane **only** when you actually need one of:

- more than one relay instance (horizontal scale behind a load balancer), or
- several heterogeneous consumers beyond the render (analytics, recording, …).

The wire protocol below does not change when you do, so **neither the player nor
Unity are touched** — you swap the relay's internals for a Redis-backed one.

## Coordinate frame (read this)

Which frame `p`/`q` are in **depends on the mode**: `"local-floor"` in VR,
`"room"` in AR. The player declares it in the `hello` (`meta.frame`) and the relay
puts it on **every** player record it emits, snapshot and update alike, as
`frame`. Read it rather than assuming — the day one spectator joins in AR, a
consumer that assumes will mix two frames with no error anywhere.

**VR — `local-floor`.** Origin wherever that headset established the floor at
session start, so poses from different players are **not** in a shared world.
That is fine here: the listener sits at the centre of the 360 sphere and never
walks, players don't see each other, and the external render places each one
independently (per seat / per viewport).

**AR — `room`.** Passthrough is the opposite case: the spectators share one
physical room and walk around in it. The player already holds the room→headset
transform (`roomGroup`, the manual alignment), so it publishes the head pose with
that transform undone — the **same frame as `stem.ar`**, the musicians' room
coordinates in `scene.json`, and the frame the partner's cameras will publish
into. Two headsets calibrated differently therefore report the *same* numbers for
someone standing in the same spot, and distance from a listener to a musician is
a subtraction. A session that never calibrated has an identity transform, so its
poses are unchanged — `room` is then just its own `local-floor`, and the pose is
only comparable across headsets once each has been aligned.

Consumers that place players per seat keep working unchanged in VR; in AR they
now receive co-located poses, which is what makes several spectators renderable
in one scene without a spatial anchor of their own.

## Gaze

`gaze` is the **head-forward vector** (quaternion applied to `(0,0,-1)`),
derived by the relay from `q`. It is reliable on every Quest today. Real foveal
eye-tracking (Quest Pro, experimental/permission-gated) is not wired yet; when
it is, the player sends it in the sample field `g` and the relay forwards it
verbatim instead of deriving. No consumer change needed.

## Client config

`scene.json`:

```json
"telemetry": {
  "enabled": true,
  "url": "",
  "rateHz": 20,
  "flushMs": 100
}
```

An empty `url` means `/ingest` on the origin serving the player, which `server.js`
proxies to the relay (see below) — the usual setup, and the one that avoids a
second certificate prompt on the headset. Set `url` only when the relay lives on
another machine.

URL overrides (handy for testing without editing the scene):

- `?telemetry=wss://host/ingest` — enable + point at a relay
- `?player=NAME` — set a stable, human-readable player id

The client (`src/telemetry/Telemetry.js`) is fully decoupled: it starts on VR/AR
session enter, samples the head pose already read each frame (decimated to
`rateHz`, allocation-free until a sample is taken), batches every `flushMs`,
auto-reconnects with backoff, and drops the oldest samples while offline.

## Wire protocol

### Player → relay (`/ingest`)

```jsonc
// once, on connect
{ "hello": "player-42", "meta": { "ua": "...", "mode": "vr", "frame": "local-floor" } }

// data frames (batched)
{ "b": [
  { "t": 12345.6, "mt": 5.62, "p": [x,y,z], "q": [x,y,z,w], "z": 0, "f": -1 }
] }
```

| field | meaning                                             |
|-------|-----------------------------------------------------|
| `t`   | client monotonic time (ms, `performance.now`)       |
| `mt`  | media presentation time (s) — what they were seeing |
| `p`   | head position `[x,y,z]`, in the frame named by `meta.frame` |
| `q`   | head orientation quaternion `[x,y,z,w]`, same frame |
| `z`   | zoom / attention depth, normalized `0..1`            |
| `f`   | focused musician: index into `scene.json` → `stems` (`-1` = none) |
| `g`   | *optional* real eye-gaze `[x,y,z]` (else omitted)   |

`f` is whichever musician the spotlight weighs most (`engine.getFocusedStem`), so
it is reported whether or not the scene defines `closeup` tracks — a viewer can
attend to a musician without a close-up video existing for them. It stays `-1`
until `z` is high enough for one stem to dominate, and in AR (all sources audible
at their own place) it is always `-1`.

### Relay → consumer (`/consume`)

```jsonc
// on connect: current state of every live player
{ "type": "snapshot", "players": [ { "id": "...", "frame": "room", "p": [...], "q": [...], "gaze": [...], "z": 0, "f": -1, "t": 0, "mt": 0 } ] }

// live stream
{ "type": "update", "id": "player-42", "frame": "room", "t": 12345.6, "mt": 5.62, "p": [x,y,z], "q": [x,y,z,w], "gaze": [x,y,z], "z": 0, "f": -1 }
{ "type": "leave",  "id": "player-42" }
```

The consumer keeps a `Dictionary<id, pose>`, applies `snapshot` then `update`s,
removes on `leave`, and **interpolates** between updates for smooth avatars
(updates arrive ~every 1000/`rateHz` ms). Align players in time with the relay's
receive order, not client `t` (headset clocks are unsynced).

## Running the relay

Nothing to run: `server.js` hosts the relay on its own port. Install the one
dependency once and start the player server as usual.

```bash
cd telemetry && npm install     # `ws`, the project's only npm dependency
cd .. && node server.js         # player + editor + relay, one process, one port
```

`GET /telemetry/health` reports how many headsets and consumers are attached —
the quickest way to confirm from the Quest itself that telemetry is arriving.
Set `RELAY=off` to leave the relay out; if `ws` is not installed the server says
so and serves the player anyway.

### Why it is hosted, not a separate port

WebXR only runs in a secure context, so the player is served over HTTPS — and a
browser blocks a plain `ws://` socket opened from an `https://` page as mixed
content. Giving the relay its own port would mean giving it its own certificate,
and a **self-signed** certificate has to be trusted once per host *and port*: the
headset would silently refuse the socket until you also visited the relay's port
and accepted the warning there. Hosting `/ingest` and `/consume` on the player's
server sidesteps that entirely — one origin, one port, one certificate, the one
the headset already accepted to load the player.

`createRelay({ server })` attaches to an existing server; called without it, the
relay listens on its own port exactly as before (`node telemetry/relay.js`, or
embedded by the simulator), so nothing about the wire protocol or deployment
shape is locked in. In production, nginx terminates TLS with a real certificate
and routes the same two paths to a standalone relay.

**Exposing a standalone relay directly** to browsers is opt-in TLS: `TLS=on`
reuses `../certs/{key,cert}.pem`, or name other paths with `TLS_KEY` / `TLS_CERT`.
`PORT`, `TTL_MS` and `SWEEP_MS` tune it as usual.

## Simulator (test the Unity client without headsets)

The simulator starts an **embedded relay + N fake players** in one command, so
Unity just connects to `ws://<host>:8090/consume` and sees several avatars
seated apart, turning their heads, zooming and switching focus.

```bash
npm run sim -- --clients 5                 # 5 players @ 20 Hz + embedded relay on :8090
npm run sim -- --clients 12 --rate 30      # more players, faster
npm run sim -- --clients 6 --churn 0.05    # players randomly drop/rejoin (presence test)
npm run sim -- --clients 3 --url ws://host:8090/ingest   # feed an EXISTING relay instead
```

Flags: `--clients N` `--rate Hz` `--port P` `--url <ingest>` `--churn R` `--seconds S`.

Other helpers:

```bash
npm test                  # end-to-end smoke test, asserts snapshot/update/leave
npm run demo:consumer     # prints the /consume stream (stand-in for Unity)
npm run demo:producer -- --id A   # a single fake player
```

## Unity consumer (NativeWebSocket)

Use [`endel/NativeWebSocket`](https://github.com/endel/NativeWebSocket) — one
client that works on both standalone and WebGL builds. Do **not** embed a Redis
client in Unity: WebGL has no raw TCP, and the relay already speaks WebSocket.

```csharp
using NativeWebSocket;
using UnityEngine;
using System.Collections.Generic;

[System.Serializable] public class Pose {
    public string type, id;
    public string frame;         // "local-floor" (VR) or "room" (AR) — see above
    public float[] p, q, gaze;   // JsonUtility handles float[]
    public float z, mt; public int f;
}
[System.Serializable] public class Snapshot { public string type; public Pose[] players; }

public class TelemetryClient : MonoBehaviour {
    WebSocket ws;
    readonly Dictionary<string, Pose> players = new();

    async void Start() {
        ws = new WebSocket("ws://localhost:8090/consume");
        ws.OnMessage += bytes => {
            var json = System.Text.Encoding.UTF8.GetString(bytes);
            if (json.Contains("\"snapshot\"")) {
                foreach (var p in JsonUtility.FromJson<Snapshot>(json).players) players[p.id] = p;
            } else {
                var p = JsonUtility.FromJson<Pose>(json);
                if (p.type == "leave") players.Remove(p.id);
                else players[p.id] = p;   // TODO: lerp toward this in Update()
            }
        };
        await ws.Connect();
    }
    void Update() {
    #if !UNITY_WEBGL || UNITY_EDITOR
        ws?.DispatchMessageQueue();   // pump callbacks on the main thread
    #endif
        // place/interpolate an avatar per players[id] using p (position),
        // q (rotation) and gaze (look direction).
    }
    async void OnApplicationQuit() { if (ws != null) await ws.Close(); }
}
```
