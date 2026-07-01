// telemetry/producer-demo.js
//
// Fake player: connects to the relay's /ingest endpoint and streams a synthetic
// head turning in a slow circle at 20 Hz. Lets you exercise the pipeline without
// a headset. Run several with different --id to simulate multiple players.
//
//   node producer-demo.js --id A --url ws://localhost:8090/ingest

const { WebSocket } = require('ws');

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, arr) =>
  a.startsWith('--') ? [[a.slice(2), arr[i + 1]]] : []));
const URL   = args.url || 'ws://localhost:8090/ingest';
const ID    = args.id  || ('demo-' + Math.random().toString(36).slice(2, 6));
const RATE  = +(args.rate || 20);

const ws = new WebSocket(URL);
ws.on('open', () => {
  console.log(`[producer ${ID}] connected to ${URL}`);
  ws.send(JSON.stringify({ hello: ID, meta: { ua: 'producer-demo', mode: 'vr' } }));

  let a = 0;
  setInterval(() => {
    a += 0.05;                                   // yaw sweep
    const qy = Math.sin(a / 2), qw = Math.cos(a / 2);   // quaternion about Y axis
    const s = {
      t: +(performance.now().toFixed(1)),
      mt: +(a.toFixed(3)),
      p: [round4(Math.sin(a) * 0.3), 1.6, round4(Math.cos(a) * 0.3)],
      q: [0, round4(qy), 0, round4(qw)],
      z: 0, f: -1,
    };
    if (ws.readyState === 1) ws.send(JSON.stringify({ b: [s] }));
  }, 1000 / RATE);
});
ws.on('close', () => console.log(`[producer ${ID}] closed`));
ws.on('error', (e) => console.error(`[producer ${ID}] error`, e.message));

function round4(n) { return Math.round(n * 1e4) / 1e4; }
