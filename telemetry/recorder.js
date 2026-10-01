// telemetry/recorder.js
//
// Records a session to CSV. Just another /consume client, so it runs alongside
// the Unity render without disturbing it (the relay broadcasts to every
// consumer) and can sit on a different machine.
//
//   node recorder.js --url wss://192.168.10.186:60000/consume --out session.csv
//
// One row per `update`. Ctrl-C (or --seconds N) closes the file cleanly and
// prints a summary. `leave` events go to stderr, not the CSV.
//
// The `rec` column names the voice recording each row belongs to, when there is
// one (docs/voice-recording.md). It is what makes a CSV self-describing: any row
// says which audio goes with it, and nobody has to keep a manifest in step.

const fs = require('fs');
const { WebSocket } = require('ws');

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, arr) =>
  a.startsWith('--') ? [[a.slice(2), arr[i + 1] ?? true]] : []));

const URL     = args.url || 'ws://localhost:8090/consume';
const OUT     = args.out || `session-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
const SECONDS = args.seconds ? +args.seconds : 0;

// New columns are appended on purpose: they don't move the ones anybody is
// already parsing. `frame` says what px/py/pz mean — this headset's local-floor
// (VR) or the shared room (AR) — which a recording of several spectators cannot
// be read without.
//
// Four clocks, and only one of them lines two headsets up. Use `server_ms`:
//
//   server_ms   the sample on the RELAY's clock, the one every player shares.
//               The relay measures each headset's offset against its own clock
//               (round-trip probe, see ClockSync) instead of trusting arrival
//               time or the headset's NTP.            ← for anything cross-player
//   capture_ms  the headset's own wall clock at capture. Correlates a session
//               with things outside the system — a camera, a log, a notebook.
//   client_ms   the headset's monotonic clock. Per-device only, but the one to
//               use for deltas within a player: no steps, no offset estimate.
//   wall_ms     when THIS process saw the row. A whole batch shares it, so it
//               repeats; kept for debugging the transport, not for analysis.
const COLS = ['wall_iso', 'wall_ms', 'id', 'client_ms', 'media_s',
              'px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw',
              'gx', 'gy', 'gz', 'zoom', 'focus', 'frame', 'capture_ms', 'server_ms', 'rec'];

const out = fs.createWriteStream(OUT, { flags: 'w' });
out.write(COLS.join(',') + '\n');

let rows = 0;
const seen = new Set();

// The player's cert is the self-signed one the headset already accepted; this
// carries head poses over the LAN, no secrets. Verifying would only reproduce
// the `self-signed certificate` failure for nothing.
const ws = new WebSocket(URL, { rejectUnauthorized: false });

ws.on('open', () => console.error(`[rec] ${URL} → ${OUT}`));

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (m.type === 'update') return row(m);
  if (m.type === 'leave')  return console.error(`[rec] leave ${m.id}`);
  if (m.type === 'snapshot' && m.players.length)
    console.error(`[rec] already present: ${m.players.map(p => p.id).join(', ')}`);
});

ws.on('close', () => finish());
ws.on('error', (e) => { console.error('[rec] error', e.message); finish(1); });

function row(m) {
  const p = m.p || [], q = m.q || [], g = m.gaze || [];
  const now = Date.now();
  out.write([
    new Date(now).toISOString(), now, m.id,
    n(m.t), n(m.mt),
    n(p[0]), n(p[1]), n(p[2]),
    n(q[0]), n(q[1]), n(q[2]), n(q[3]),
    n(g[0]), n(g[1]), n(g[2]),
    n(m.z), m.f ?? '', m.frame || '', n(m.w), n(m.srv), m.rec || '',
  ].join(',') + '\n');
  rows++;
  seen.add(m.id);
}

// Empty cell rather than the string "undefined" — pandas/R read that as NaN.
function n(v) { return (v === undefined || v === null) ? '' : v; }

let done = false;
function finish(code = 0) {
  if (done) return; done = true;
  out.end(() => {
    console.error(`[rec] ${rows} rows · ${seen.size} player(s): ${[...seen].join(', ') || '—'} → ${OUT}`);
    process.exit(code);
  });
}

process.on('SIGINT', () => { try { ws.close(); } catch (_) { finish(); } });
if (SECONDS) setTimeout(() => { try { ws.close(); } catch (_) { finish(); } }, SECONDS * 1000);
