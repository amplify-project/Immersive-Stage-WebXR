// telemetry/sdk-smoke.mjs
//
// The vendored XR-telemetry SDK (src/vendor/xr-telemetry.js) against this relay:
// spec batches {s:'pose'} must reach a consumer as the same `update` records the
// compact format gives, and {s:'event'} only a consumer that asked for events.
// Node >= 22 (global WebSocket, which the SDK uses). Exits non-zero on failure.
//
//   node sdk-smoke.mjs

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { XRTelemetry } from '../src/vendor/xr-telemetry.js';

const require = createRequire(import.meta.url);
const { WebSocket: WS } = require('ws');
const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8098, BASE = `ws://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => { console.error('  ✗ ' + m); failed = true; };
const near = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

const relay = spawn(process.execPath, [join(here, 'relay.js')], { env: { ...process.env, PORT, TTL_MS: 1500, SWEEP_MS: 300 } });
relay.stderr.on('data', (d) => process.stderr.write('[relay:err] ' + d));
const cleanup = () => { try { relay.kill(); } catch (_) {} };

try {
  await wait(500);
  const plain = [], withEvents = [];
  const c1 = new WS(`${BASE}/consume`);
  const c2 = new WS(`${BASE}/consume?events=1`);
  c1.on('message', (r) => plain.push(JSON.parse(r)));
  c2.on('message', (r) => withEvents.push(JSON.parse(r)));
  await Promise.all([c1, c2].map((c) => new Promise((res) => c.on('open', res))));

  // flushMs 0: every call goes out at once; rateHz 0: no decimation in a test.
  const tel = new XRTelemetry({ url: `${BASE}/ingest`, device: 'sdk-1', rateHz: 0, flushMs: 0,
                                meta: { mode: 'vr', frame: 'local-floor' } });
  tel.start();
  await wait(300);                                    // hello + first clock probe
  const q = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };    // 90° left
  tel.pose({ x: 0.5, y: 1.6, z: -0.2 }, q, { z: 0.4, f: 2, media_t: 12.5, rec: 'rec-1', input: 'xr' });
  tel.event('closeup', 'DR', { kind: 'cam' });
  await wait(200);

  const upd = plain.find((e) => e.type === 'update' && e.id === 'sdk-1');
  if (upd) ok('a spec pose reached the consumer as an update'); else fail('no update for the SDK producer');
  if (upd && near(upd.p, [0.5, 1.6, -0.2]) && near(upd.q, [0, Math.SQRT1_2, 0, Math.SQRT1_2]))
    ok('p and q rebuilt from px..pz / qx..qw'); else fail('p/q wrong: ' + JSON.stringify(upd && [upd.p, upd.q]));
  if (upd && near(upd.gaze, [-1, 0, 0])) ok('gaze from the SDK (head-forward, 90° left = -X)');
  else fail('gaze wrong: ' + JSON.stringify(upd && upd.gaze));
  if (upd && upd.mt === 12.5 && upd.z === 0.4 && upd.f === 2) ok('media_t → mt, z and f pass through');
  else fail('mt/z/f wrong: ' + JSON.stringify(upd && { mt: upd.mt, z: upd.z, f: upd.f }));
  if (upd && upd.frame === 'local-floor' && upd.rec === 'rec-1') ok('frame from the hello, rec from the sample');
  else fail('frame/rec wrong: ' + JSON.stringify(upd && { frame: upd.frame, rec: upd.rec }));
  if (upd && typeof upd.srv === 'number' && Math.abs(upd.srv - Date.now()) < 1000) ok('srv on the relay clock');
  else fail('srv missing or off: ' + JSON.stringify(upd && upd.srv));

  const ev = withEvents.find((e) => e.type === 'event' && e.id === 'sdk-1');
  if (ev && ev.name === 'closeup' && ev.value === 'DR' && ev.kind === 'cam' && typeof ev.srv === 'number')
    ok('an event reached the consumer that asked for events, with srv');
  else fail('event missing or wrong: ' + JSON.stringify(ev));
  if (!plain.some((e) => e.type === 'event')) ok('and not the one that did not (the Unity render keeps its protocol)');
  else fail('a consumer without ?events=1 got an event');

  tel.stop();
  await wait(300);
  if (plain.some((e) => e.type === 'leave' && e.id === 'sdk-1')) ok('leave when the SDK stops');
  else fail('no leave after stop()');
  c1.close(); c2.close();
} catch (e) { console.error(e); failed = true; }
cleanup();
console.log(failed ? '\nSDK SMOKE TEST FAILED' : '\nSDK SMOKE TEST PASSED');
process.exit(failed ? 1 : 0);
