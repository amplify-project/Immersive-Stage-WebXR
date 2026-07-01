# telemetry/ — in-memory pose relay

Standalone WebSocket relay that fans each player's head pose + gaze out to an
external render (e.g. Unity). No Redis, no database — ephemeral by design.

```bash
npm install
npm start                      # :8090  → /ingest (players)  /consume (render)
npm run sim -- --clients 5     # embedded relay + 5 fake players — point Unity at /consume
npm test                       # end-to-end smoke test, no headset
```

`simulator.js` is the quickest way to develop the Unity consumer: one command
brings up a relay and N simulated players (seated apart, heads moving). Flags:
`--clients N --rate Hz --port P --url <ingest> --churn R --seconds S`.

Full protocol, client config and a Unity/C# consumer: [`../docs/telemetry.md`](../docs/telemetry.md).

The player client lives separately in `../src/telemetry/Telemetry.js` and is
wired into `../index.html` (opt-in via `scene.json` → `telemetry.enabled`).
