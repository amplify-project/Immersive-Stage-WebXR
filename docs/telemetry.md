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

## `rec`: which voice recording these poses belong to

`null` unless that player is having their voice recorded
([`voice-recording.md`](voice-recording.md)), and otherwise the name the
recording service gave the files:

```
recordings/2026-09-21T07-40-29-861Z_p-pao9ev33.webm    ← rec is the part before the extension
recordings/2026-09-21T07-40-29-861Z_p-pao9ev33.jsonl
```

It travels exactly like `frame` — declared in the `hello`'s `meta`, promoted by
the relay onto **every** record it emits — and for the same kind of reason. Poses
and voice are two files written by two different processes, and something has to
say they are the same session. Putting it on every record rather than in a
manifest means any single row, anywhere it ends up, names the audio it belongs
to: `telemetry/recorder.js` writes it as the `rec` column, and a CSV is then
self-describing with nothing to keep in step.

**This is additive and consumers can ignore it.** It does not change a field that
was there before, and a render that never reads it behaves exactly as it did.
What it is worth reading it for is knowing that a participant is being recorded
— which is a thing worth showing in a render.

The player names nothing itself: the recording service answers its hello with the
name it actually opened, and that is what gets published. The alternative — the
player composing the name from its own id and clock — advertises a reference to a
file that may not be the one on disk, since the sanitising is the service's.

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
// once, on connect — and again whenever `meta` changes mid-session (the relay
// keys on the id and merges, so a second hello is an update, not a new player)
{ "hello": "player-42", "meta": { "ua": "...", "mode": "vr", "frame": "local-floor", "rec": "2026-09-21T07-40-29-861Z_player-42" } }

// data frames (batched)
{ "b": [
  { "t": 12345.6, "w": 1785500757720, "mt": 5.62, "p": [x,y,z], "q": [x,y,z,w], "z": 0, "f": -1 }
] }

// clock probe — the relay asks, the player answers at once with its own reading
// ← { "ping": 1785500757000 }
// → { "pong": 1785500757000, "c": 12295.4 }
```

| field | meaning                                             |
|-------|-----------------------------------------------------|
| `t`   | client monotonic time (ms, `performance.now`)       |
| `w`   | client wall clock at capture (ms, `Date.now`)       |
| `mt`  | media presentation time (s) — what they were seeing |
| `p`   | head position `[x,y,z]`, in the frame named by `meta.frame` |
| `q`   | head orientation quaternion `[x,y,z,w]`, same frame |
| `z`   | zoom / attention depth, normalized `0..1`            |
| `f`   | focused musician: index into `scene.json` → `stems` (`-1` = none) |
| `g`   | *optional* real eye-gaze `[x,y,z]` (else omitted)   |

`f` is derived differently in each mode, because attention is declared
differently.

**In VR** it is whichever musician the spotlight weighs most
(`engine.getFocusedStem`, aim × zoom), reported whether or not the scene defines
`closeup` tracks — a viewer can attend to a musician without a close-up video
existing for them. It stays `-1` until `z` is high enough for one stem to
dominate.

**In AR** there is no zoom to declare intent (`z` is always `0`), so the signal is
**sustained gaze**: `engine.getGazedStem` picks the musician nearest the centre of
view — ties going to the closer one, since at 6 m a 12° cone covers 1.3 m and
several musicians share it — and the player only reports them after the gaze has
held for `dwellMs`, releasing after `releaseMs` outside a wider cone. The two
cones and two timers are deliberately asymmetric: with a single threshold, `f`
flickers between neighbouring musicians on natural head tremor, and an aggregated
attention that jumps five times a second is noise, not data. The focus is never
dropped while another musician is already dwelling, so a handover reads `A → B`
and never `A → nobody → B`.

Tune them per venue in `scene.json` — the right dwell depends on how far apart
the musicians are and how far away the audience stands:

```json
"ar": { "focus": { "coneDeg": 12, "keepDeg": 22, "dwellMs": 400, "releaseMs": 350,
                   "boostDb": 6, "duckDb": 0 } }
```

The focused musician's marker turns amber in passthrough **and** their stem is
raised by `boostDb` (the rest dropping by `duckDb`, if set), which is how you tune
these numbers: put the headset on and watch — and listen for — when the highlight
commits. `f` therefore records more than attention in AR: it records what the
listener was actually hearing louder, so a session can be read as the sequence of
musicians each spectator chose to bring forward.

### Relay → consumer (`/consume`)

```jsonc
// on connect: current state of every live player
{ "type": "snapshot", "players": [ { "id": "...", "frame": "room", "rec": null, "p": [...], "q": [...], "gaze": [...], "z": 0, "f": -1, "t": 0, "w": 0, "srv": 0, "mt": 0 } ] }

// live stream
{ "type": "update", "id": "player-42", "frame": "room", "rec": "2026-09-21T07-40-29-861Z_player-42", "t": 12345.6, "w": 1785500757720, "srv": 1785500757719.4, "mt": 5.62, "p": [x,y,z], "q": [x,y,z,w], "gaze": [x,y,z], "z": 0, "f": -1 }
{ "type": "leave",  "id": "player-42" }
```

The consumer keeps a `Dictionary<id, pose>`, applies `snapshot` then `update`s,
removes on `leave`, and **interpolates** between updates for smooth avatars
(updates arrive ~every 1000/`rateHz` ms). For a live render, drive it off arrival
order: it is the freshest thing you have and one batch of lag does not show.

## Putting two headsets on one time axis

Use **`srv`**. It is the sample expressed on the relay's clock — the only clock
every player shares — and it is what the recorder writes as `server_ms`.

Neither of the alternatives works, and both are tempting:

- **Stamping on arrival** timestamps the *batch*. Every sample in a `flushMs`
  window lands in the same millisecond, so a recording has far fewer distinct
  timestamps than rows, and no amount of care afterwards recovers the order
  inside a batch.
- **The headset's own wall clock** (`w`) is honest about the instant but not
  about the hour: two Quests agree only as well as their NTP does, and nothing
  in the system measures that.

So the relay measures it. Every `pingMs` (2 s) it sends `ping` with its own
clock; the player answers immediately with its monotonic reading; the relay
knows how long the round trip took and places that reading on its own timeline —
Cristian's algorithm, keeping the exchange with the **smallest round trip** out
of the last 16, which is NTP's filter and for the same reason: a fast exchange
had no time to queue up asymmetrically. The residual error is bounded by half
that best round trip (sub-ms on the LAN in the smoke test, a few ms over Quest
WiFi). Drift is handled by construction, since the window keeps re-measuring.

`srv` is `null` until the first probe completes — one round trip after `hello`,
so in practice only if a player sends data before answering a ping. Every
`/ingest` client should reply to `ping`; `Telemetry.js` and the simulator do.

That leaves four clocks in a recording, each with one job:

| column       | what it is                          | use it for |
|--------------|-------------------------------------|------------|
| `server_ms`  | sample on the relay's clock (`srv`) | **anything involving more than one player** |
| `client_ms`  | headset monotonic (`t`)             | deltas within one player — no steps, no estimate in the way |
| `capture_ms` | headset wall clock (`w`)            | tying a session to the outside world: a camera, a log, a notebook |
| `wall_ms`    | when the recorder saw the row       | debugging the transport; it repeats per batch |

## Sampling rate

`rateHz` is a real rate, not a per-frame budget: the client keeps a fixed grid of
deadlines and serves each one on the first render frame past it. Each sample is
therefore up to one frame late (≤14 ms at 72 Hz) but the lateness does not
accumulate, so 20 Hz records ~20 rows per second and `client_ms` deltas alternate
around 50 ms rather than sitting on a rounded-up 55.5 ms.

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
