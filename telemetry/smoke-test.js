// telemetry/smoke-test.js
//
// End-to-end check with no headset: spawns the relay, connects a consumer and a
// producer, and asserts the consumer sees snapshot -> update (with derived
// head-forward gaze) -> leave. Exits non-zero on failure.
//
//   node smoke-test.js
//
// Note: uses a distinct PORT so it won't clash with a relay you already run.

const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const PORT = 8099;
const BASE = `ws://localhost:${PORT}`;
let relay, failed = false;

const wait = (ms) => new Promise(r => setTimeout(r, ms));
function fail(msg) { console.error('  ✗ ' + msg); failed = true; }
function ok(msg) { console.log('  ✓ ' + msg); }

(async () => {
  relay = spawn(process.execPath, [__dirname + '/relay.js'], { env: { ...process.env, PORT, TTL_MS: 1500, SWEEP_MS: 300 } });
  relay.stdout.on('data', d => process.stdout.write('[relay] ' + d));
  relay.stderr.on('data', d => process.stderr.write('[relay:err] ' + d));
  await wait(500);

  const events = [];
  const consumer = new WebSocket(`${BASE}/consume`);
  consumer.on('message', raw => events.push(JSON.parse(raw)));
  await once(consumer, 'open');
  await wait(100);
  if (events[0] && events[0].type === 'snapshot') ok('consumer got snapshot on connect');
  else fail('no snapshot on connect');

  // producer sends a pose looking straight down -Z (identity quaternion)
  const producer = new WebSocket(`${BASE}/ingest`);
  await once(producer, 'open');
  producer.send(JSON.stringify({ hello: 'smoke-1', meta: { mode: 'vr' } }));
  await wait(50);
  producer.send(JSON.stringify({ b: [{ t: 1, mt: 0, p: [0, 1.6, 0], q: [0, 0, 0, 1], z: 0, f: -1 }] }));
  await wait(150);

  const upd = events.find(e => e.type === 'update' && e.id === 'smoke-1');
  if (upd) ok('consumer received update for producer');
  else fail('no update received');

  if (upd && upd.gaze && Math.abs(upd.gaze[0]) < 1e-6 && Math.abs(upd.gaze[1]) < 1e-6 && Math.abs(upd.gaze[2] + 1) < 1e-6)
    ok('relay derived head-forward gaze = [0,0,-1] for identity quaternion');
  else fail('gaze derivation wrong: ' + JSON.stringify(upd && upd.gaze));

  // drop producer -> expect a leave (either on close or via TTL sweep)
  producer.close();
  await wait(1600);
  if (events.some(e => e.type === 'leave' && e.id === 'smoke-1')) ok('consumer received leave after producer left');
  else fail('no leave received');

  consumer.close();
  cleanup();
  console.log(failed ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });

function once(ws, ev) { return new Promise((res, rej) => { ws.on(ev, res); ws.on('error', rej); }); }
function cleanup() { if (relay) try { relay.kill(); } catch (_) {} }
