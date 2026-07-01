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

Each player's pose is in **its own `local-floor` space** — origin wherever that
headset established the floor at session start. Poses from different players are
**not** in a shared world. Since players are only shown in the external render
(and don't see each other), the render places each one independently (per seat /
per viewport). If you ever need them co-located in one scene, add a shared
spatial anchor — that is a render-side decision, not a telemetry-pipeline one.

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
  "url": "wss://your-relay.example/ingest",
  "rateHz": 20,
  "flushMs": 100
}
```

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
{ "hello": "player-42", "meta": { "ua": "...", "mode": "vr" } }

// data frames (batched)
{ "b": [
  { "t": 12345.6, "mt": 5.62, "p": [x,y,z], "q": [x,y,z,w], "z": 0, "f": -1 }
] }
```

| field | meaning                                             |
|-------|-----------------------------------------------------|
| `t`   | client monotonic time (ms, `performance.now`)       |
| `mt`  | media presentation time (s) — what they were seeing |
| `p`   | head position `[x,y,z]`                             |
| `q`   | head orientation quaternion `[x,y,z,w]`            |
| `z`   | zoom / attention depth                              |
| `f`   | focused source index (`-1` = none)                  |
| `g`   | *optional* real eye-gaze `[x,y,z]` (else omitted)   |

### Relay → consumer (`/consume`)

```jsonc
// on connect: current state of every live player
{ "type": "snapshot", "players": [ { "id": "...", "p": [...], "q": [...], "gaze": [...], "z": 0, "f": -1, "t": 0, "mt": 0 } ] }

// live stream
{ "type": "update", "id": "player-42", "t": 12345.6, "mt": 5.62, "p": [x,y,z], "q": [x,y,z,w], "gaze": [x,y,z], "z": 0, "f": -1 }
{ "type": "leave",  "id": "player-42" }
```

The consumer keeps a `Dictionary<id, pose>`, applies `snapshot` then `update`s,
removes on `leave`, and **interpolates** between updates for smooth avatars
(updates arrive ~every 1000/`rateHz` ms). Align players in time with the relay's
receive order, not client `t` (headset clocks are unsynced).

## Running the relay

```bash
cd telemetry
npm install
npm start                 # listens on :8090  (PORT, TTL_MS, SWEEP_MS env vars)
```

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
