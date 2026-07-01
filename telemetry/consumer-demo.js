// telemetry/consumer-demo.js
//
// Stand-in for the external (Unity) render: connects to /consume, prints the
// initial snapshot and then the live update / leave stream. Use it to eyeball
// the wire format the Unity client must parse.
//
//   node consumer-demo.js --url ws://localhost:8090/consume

const { WebSocket } = require('ws');

const args = Object.fromEntries(process.argv.slice(2).flatMap((a, i, arr) =>
  a.startsWith('--') ? [[a.slice(2), arr[i + 1]]] : []));
const URL = args.url || 'ws://localhost:8090/consume';

const ws = new WebSocket(URL);
ws.on('open', () => console.log(`[consumer] connected to ${URL}`));
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.type === 'snapshot') console.log(`[snapshot] ${m.players.length} player(s):`, m.players.map(p => p.id));
  else if (m.type === 'update') console.log(`[update] ${m.id}  p=${fmt(m.p)}  gaze=${fmt(m.gaze)}  f=${m.f}`);
  else if (m.type === 'leave')  console.log(`[leave] ${m.id}`);
});
ws.on('close', () => console.log('[consumer] closed'));
ws.on('error', (e) => console.error('[consumer] error', e.message));

function fmt(v) { return Array.isArray(v) ? '[' + v.map(n => n.toFixed(2)).join(', ') + ']' : String(v); }
