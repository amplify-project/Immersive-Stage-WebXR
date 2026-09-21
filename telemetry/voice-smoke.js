// telemetry/voice-smoke.js
//
// End-to-end check of the voice service with no headset and no microphone: it
// mounts createVoiceService() on a throwaway server, plays the part of a player
// over the wire, and asserts what landed on disk.
//
//   node voice-smoke.js
//
// The case worth having a test for is the reconnection. A dropped socket must
// CONTINUE the file it was writing — the container header went out in the first
// chunk of the part and re-opening the file empty would leave one that decodes
// to nothing — while a new part must open a file of its own. Both are invisible
// until somebody tries to play a recording of a session that had a hiccup.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { WebSocket } = require('ws');
const { createVoiceService } = require('./voice');

let failed = false;
const ok   = (m) => console.log('  ✓ ' + m);
const fail = (m) => { console.error('  ✗ ' + m); failed = true; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const once = (ws, ev) => new Promise((res, rej) => { ws.on(ev, res); ws.on('error', rej); });

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-smoke-'));
const server = http.createServer((_, res) => { res.writeHead(404); res.end(); });
const voice = createVoiceService({ server, dir: DIR, log: false });

const STAMP = '2026-09-21T10-00-00-000Z';
const NAME  = `${STAMP}_smoke`;

// One chunk: the header frame and then the body, in that order — the pairing on
// the service is arrival order and nothing else.
function chunk(ws, p, i, payload) {
  ws.send(JSON.stringify({ c: { p, i, bytes: payload.length, t0: i * 1000, t: (i + 1) * 1000, mt0: i, mt: i + 1, w: 1758448800000 + i * 1000 } }));
  ws.send(Buffer.from(payload));
}

async function connect() {
  const ws = new WebSocket(`ws://localhost:${server.address().port}/voice`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ hello: 'smoke', stamp: STAMP, mime: 'audio/webm;codecs=opus', meta: { ua: 'smoke' } }));
  await wait(50);
  return ws;
}

const read  = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const lines = (f) => read(f).trim().split('\n').map(JSON.parse);

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  // ── one part, written across a drop ──────────────────────────────────
  let ws = await connect();
  chunk(ws, 0, 0, 'HDR');       // the container header lives here
  chunk(ws, 0, 1, 'aaa');
  ws.send(JSON.stringify({ m: { ev: 'enter-vr', t: 1500, mt: 1.5, w: 1758448801500 } }));
  await wait(100);
  ws.close();                    // the drop
  await wait(100);

  if (read(NAME + '.webm') === 'HDRaaa') ok('chunks land in the part file, in order');
  else fail('bad part file: ' + JSON.stringify(read(NAME + '.webm')));

  let l = lines(NAME + '.jsonl');
  if (l[0].type === 'start' && l[0].mime === 'audio/webm;codecs=opus') ok('sidecar opens with the hello');
  else fail('no start line: ' + JSON.stringify(l[0]));
  if (l.filter(x => x.p === 0 && x.i !== undefined).length === 2) ok('one sidecar line per chunk');
  else fail('chunk lines: ' + JSON.stringify(l));
  if (l.some(x => x.type === 'mark' && x.ev === 'enter-vr')) ok('marks are kept');
  else fail('mark missing');
  if (l[l.length - 1].type === 'end') ok('closing the socket closes the part');
  else fail('no end line: ' + JSON.stringify(l[l.length - 1]));

  // ── reconnect: same stamp, same part → the SAME file continues ────────
  ws = await connect();
  chunk(ws, 0, 2, 'bbb');
  await wait(100);
  if (read(NAME + '.webm') === 'HDRaaabbb') ok('a reconnection appends to the part instead of truncating it');
  else fail('part was not continued: ' + JSON.stringify(read(NAME + '.webm')));
  if (lines(NAME + '.jsonl').some(x => x.type === 'resume')) ok('the sidecar says it resumed');
  else fail('no resume line');

  // ── a new part is a new file, header and all ─────────────────────────
  chunk(ws, 1, 0, 'HDR2');
  await wait(100);
  if (read(NAME + '_p1.webm') === 'HDR2') ok('a new part opens a file of its own');
  else fail('no p1 file');
  if (lines(NAME + '.jsonl').filter(x => x.type === 'end').length === 2) ok('the previous part was closed when the new one opened');
  else fail('previous part left open');

  // ── a body with no header before it is not filed under a guess ────────
  ws.send(Buffer.from('orphan'));
  await wait(100);
  if (read(NAME + '_p1.webm') === 'HDR2') ok('a body with no header is dropped, not appended blind');
  else fail('orphan body was written: ' + JSON.stringify(read(NAME + '_p1.webm')));

  ws.send(JSON.stringify({ bye: 1 }));
  await wait(100);
  ws.close();
  await wait(100);

  voice.close();
  server.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(failed ? '\nVOICE SMOKE TEST FAILED' : '\nVOICE SMOKE TEST PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error(e);
  try { voice.close(); server.close(); fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
