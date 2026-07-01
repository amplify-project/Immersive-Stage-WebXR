// telemetry/simulator.js
//
// Telemetry simulator for testing the Unity consumer without headsets.
//
// Spins up N fake players, each seated at a distinct spot, turning/leaning their
// head with its own rhythm, occasionally zooming and switching focus. By default
// it also starts an embedded relay, so you run ONE command and Unity just
// connects to  ws://<host>:8090/consume.
//
//   node simulator.js --clients 5
//   node simulator.js --clients 12 --rate 30 --port 8090 --churn 0.05
//   node simulator.js --clients 3 --url ws://other-host:8090/ingest   # external relay
//
// Flags:
//   --clients N   number of simulated players            (default 4)
//   --rate Hz     samples per second per client          (default 20)
//   --port P      embedded relay port                    (default 8090)
//   --url U       target an EXISTING relay's /ingest; disables the embedded one
//   --churn R     per-second probability each client drops & rejoins (presence test, default 0)
//   --seconds S   auto-stop after S seconds              (default: run until Ctrl-C)

const { WebSocket } = require('ws');

const args = parseArgs(process.argv.slice(2));
const N        = Math.max(1, +(args.clients ?? 4));
const RATE     = Math.max(1, +(args.rate ?? 20));
const PORT     = +(args.port ?? 8090);
const CHURN    = Math.max(0, +(args.churn ?? 0));
const SECONDS  = args.seconds ? +args.seconds : 0;
const EXTERNAL = args.url || null;
const INGEST   = EXTERNAL || `ws://localhost:${PORT}/ingest`;

// ── one simulated player ──────────────────────────────────────────────
class SimClient {
  constructor(i, total) {
    this.id = `sim-${String(i + 1).padStart(2, '0')}`;
    // seat: spread clients along an arc so Unity sees them at distinct spots
    const ang = (i / Math.max(1, total - 1) - 0.5) * (Math.PI * 0.6);   // ±54°
    this.seat = [Math.sin(ang) * 2.0, 1.5 + (i % 3) * 0.05, Math.cos(ang) * 2.0 - 2.5];
    // per-client rhythm
    this.phase = Math.random() * Math.PI * 2;
    this.yawSpeed = 0.4 + Math.random() * 0.8;
    this.pitchSpeed = 0.3 + Math.random() * 0.5;
    this.mode = (i % 2) ? 'vr' : 'ar';
    this.t0 = Date.now();
    this.timer = null;
    this.ws = null;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(INGEST);
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ hello: this.id, meta: { ua: 'simulator', mode: this.mode } }));
      this.timer = setInterval(() => this.tick(), 1000 / RATE);
    });
    ws.on('close', () => { clearInterval(this.timer); this.timer = null; });
    ws.on('error', () => { /* close follows; bounce()/reconnect handles it */ });
  }

  tick() {
    if (!this.ws || this.ws.readyState !== 1) return;
    const dt = (Date.now() - this.t0) / 1000;
    const yaw = Math.sin(dt * this.yawSpeed + this.phase) * (Math.PI * 0.5);   // look ±90°
    const pitch = Math.sin(dt * this.pitchSpeed + this.phase) * 0.25;          // small nod
    const sway = 0.04;
    const p = [
      round4(this.seat[0] + Math.sin(dt * 0.3 + this.phase) * sway),
      round4(this.seat[1] + Math.sin(dt * 0.7 + this.phase) * 0.02),
      round4(this.seat[2] + Math.cos(dt * 0.3 + this.phase) * sway),
    ];
    const q = eulerToQuat(yaw, pitch);
    // occasional zoom + focus changes so the fields aren't static
    const z = Math.max(0, Math.sin(dt * 0.2 + this.phase)) * 1.5;
    const f = z > 0.9 ? Math.floor((dt * 0.25 + this.phase) % 6) : -1;

    const s = { t: +(Date.now() - this.t0).toFixed(1), mt: round4(dt), p, q, z: round4(z), f };
    this.ws.send(JSON.stringify({ b: [s] }));
  }

  // drop and rejoin shortly after (presence leave/join test)
  bounce() {
    if (!this.ws) return;
    try { this.ws.close(); } catch (_) { /* noop */ }
    clearInterval(this.timer); this.timer = null;
    this.ws = null;
    setTimeout(() => this.connect(), 500 + Math.random() * 1500);
  }

  stop() {
    clearInterval(this.timer); this.timer = null;
    if (this.ws) { try { this.ws.close(); } catch (_) { /* noop */ } this.ws = null; }
  }
}

// ── main ──────────────────────────────────────────────────────────────
let relay = null;
if (!EXTERNAL) {
  const { createRelay } = require('./relay');
  relay = createRelay({ port: PORT });
  console.log(`[sim] embedded relay up — Unity should connect to  ws://<host>:${PORT}/consume`);
} else {
  console.log(`[sim] using external relay at ${EXTERNAL}`);
}
console.log(`[sim] ${N} client(s) @ ${RATE} Hz${CHURN ? `  churn=${CHURN}/s` : ''}`);

const clients = [];
for (let i = 0; i < N; i++) clients.push(new SimClient(i, N));

let churnTimer = null;
if (CHURN > 0) {
  churnTimer = setInterval(() => {
    for (const c of clients) if (Math.random() < CHURN) c.bounce();
  }, 1000);
}

if (SECONDS > 0) setTimeout(shutdown, SECONDS * 1000);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('\n[sim] stopping…');
  clearInterval(churnTimer);
  for (const c of clients) c.stop();
  if (relay) relay.close();
  setTimeout(() => process.exit(0), 200);
}

// ── helpers ───────────────────────────────────────────────────────────
function eulerToQuat(yaw, pitch) {                 // yaw about Y then pitch about X
  const sy = Math.sin(yaw / 2), cy = Math.cos(yaw / 2);
  const sp = Math.sin(pitch / 2), cp = Math.cos(pitch / 2);
  return [round4(cy * sp), round4(sy * cp), round4(-sy * sp), round4(cy * cp)];
}
function round4(n) { return Math.round(n * 1e4) / 1e4; }
function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1];
  return o;
}
