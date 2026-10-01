// telemetry/relay.js
//
// In-memory WebSocket pose-telemetry relay (no Redis).
//
//   players ──ws──▶ /ingest ──▶ in-memory Map ──▶ /consume ──ws──▶ Unity render
//
// One process, ephemeral state. Producers (players) push batches of pose
// samples; consumers (the external render) get a snapshot of every live player
// on connect and then a live stream of updates. Presence is a TTL sweep over
// last-seen. Restart = clean slate — telemetry has no history worth keeping.
//
// Swap this for a Redis pub/sub backplane only when you actually need more than
// one relay instance or several heterogeneous consumers; the wire protocol
// (see docs/telemetry.md) stays identical, so neither the player nor Unity change.
//
// TLS: normally none, and none needed. WebXR forces the player onto HTTPS, and
// an https:// page cannot open a plain ws:// socket (mixed content) — so the
// player's server.js hosts this relay on its own HTTPS server via
// createRelay({ server }), and the headset gets one origin and one certificate.
// nginx plays that same role in production, in front of a standalone relay. Set
// TLS=on (or TLS_KEY/TLS_CERT) only to expose a standalone relay straight to
// browsers with nothing in front of it.
//
// Exports createRelay() so server.js and the simulator can embed it in-process;
// runs standalone when invoked directly (node relay.js).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PATHS = ['/ingest', '/consume'];

/**
 * Either owns an HTTP(S) server of its own (standalone: `node relay.js`) or
 * attaches to one you already have (`server`), which is how the player's
 * server.js gives the headset a single origin, port and certificate.
 *
 * @param {object} [opt]
 * @param {?import('http').Server} [opt.server=null]  attach to this server instead of listening
 * @param {number} [opt.port=8090]     ignored when `server` is given
 * @param {number} [opt.ttlMs=5000]    presence timeout (player considered gone after this)
 * @param {number} [opt.sweepMs=1000]  presence sweep period
 * @param {number} [opt.pingMs=2000]   clock-probe period per player (see ClockSync)
 * @param {boolean}[opt.log=true]
 * @param {?{key: Buffer|string, cert: Buffer|string}} [opt.tls=null]  listen over wss:// when set
 * @returns {{ server, wss, players: Map, scheme: string, health: () => object, close: () => void }}
 */
function createRelay({ server: hostServer = null, port = 8090, ttlMs = 5000, sweepMs = 1000, pingMs = 2000, log = true, tls = null } = {}) {
  const players   = new Map();   // id -> { id, t, w, srv, mt, p, q, gaze, z, f, meta, lastSeen }
  const consumers = new Set();   // Set<WebSocket>
  const attached  = !!hostServer;

  const health = () => ({ ok: true, players: players.size, consumers: consumers.size });

  const handler = (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(health()));
    }
    res.writeHead(404); res.end();
  };

  // Attached: the host server owns its own routes, we only claim the two
  // WebSocket paths below. Standalone: we own everything, /health included.
  const server = hostServer || (tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler)
                                    : http.createServer(handler));
  // An https.Server is a tls.Server, and only those carry setSecureContext.
  const secure = attached ? typeof server.setSecureContext === 'function' : !!tls;
  const scheme = secure ? 'wss' : 'ws';

  // noServer + our own upgrade listener, so that on a shared server we claim
  // only these two paths rather than letting ws hijack every upgrade.
  //
  // What we do with a path that is not ours depends on whether we are alone.
  // Standalone, nobody else is listening and Node only auto-destroys an upgrade
  // when there is no listener at all — so an unknown path would hang open and we
  // close it. Attached to the player's server we must NOT: another service is
  // mounted there too (the timing one), its upgrade listener runs after ours,
  // and destroying the socket first would kill every connection to it. Whoever
  // attached us closes what nobody claimed.
  const wss = new WebSocketServer({ noServer: true });
  const onUpgrade = (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (!PATHS.includes(pathname)) { if (!attached) socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws, req) => {
    const pathname = (req.url || '/ingest').split('?')[0];
    if (pathname === '/consume') return onConsumer(ws);
    return onProducer(ws);                          // default: /ingest
  });

  // ── Producers (players) ─────────────────────────────────────────────
  function onProducer(ws) {
    let id = null;
    const clock = new ClockSync();                  // this player's timeline -> ours
    let pinger = null;

    const probe = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ ping: Date.now() })); };

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }

      // Clock probe answered. Stamp the arrival before anything else: every
      // millisecond spent here lands in the round trip and widens the estimate.
      if (msg.pong !== undefined) return clock.observe(msg.pong, msg.c, Date.now());

      if (msg.hello) {                              // handshake
        id = String(msg.hello);
        const prev = players.get(id) || {};
        const meta = msg.meta || {};
        // Which frame p/q are in travels with every record, not just in the
        // hello: meta stays server-side, and a consumer that reads `p` without
        // knowing whether it is this headset's local-floor or the shared room
        // will silently mix the two the day one spectator is in AR.
        // `rec` rides along for the same reason as `frame`: it names the voice
        // recording these poses belong to (docs/voice-recording.md), and a
        // consumer or a CSV that has the poses without it cannot tell which
        // audio file goes with them. Null when nobody is recording.
        players.set(id, { ...prev, id, meta, frame: meta.frame || 'local-floor',
                          rec: meta.rec || null, lastSeen: Date.now() });
        // Probe at once and keep probing: the first exchange puts `srv` on the
        // very first batch, and the rest both refine it (a quieter exchange
        // measures a tighter round trip) and follow the headset's oscillator
        // drift, which over a song is worth a few ms.
        if (!pinger) { probe(); pinger = setInterval(probe, pingMs); }
        return;
      }
      if (!id || !Array.isArray(msg.b)) return;     // data frames need a prior hello

      const now = Date.now();
      for (const s of msg.b) {
        const prev = players.get(id) || { meta: {} };
        const rec = {
          id, frame: prev.frame || 'local-floor',
          rec: prev.rec || null,        // the voice recording, from the hello's meta
          // Three clocks, because no single one does the job. `t` and `w` are the
          // player's own, monotonic and wall, and travel untouched. `srv` is that
          // sample on OUR clock, which is the only one every player shares:
          // stamping on arrival would timestamp the batch rather than the sample,
          // and `w` from two headsets agrees only as well as their NTP does.
          t: s.t, w: s.w, mt: s.mt,
          srv: clock.toServer(s.t),
          p: s.p, q: s.q,
          gaze: s.g || forwardFromQuat(s.q),        // real eye-gaze if sent, else head-forward
          z: s.z, f: s.f,
        };
        players.set(id, { ...prev, ...rec, lastSeen: now });
        broadcast({ type: 'update', ...rec });
      }
    });
    ws.on('close', () => {
      clearInterval(pinger); pinger = null;
      if (id && players.delete(id)) broadcast({ type: 'leave', id });
    });
    ws.on('error', () => { /* close will follow */ });
  }

  // ── Consumers (external render, e.g. Unity) ─────────────────────────
  function onConsumer(ws) {
    consumers.add(ws);
    const snapshot = [];
    for (const p of players.values()) if (p.p) snapshot.push(stripPresence(p));
    ws.send(JSON.stringify({ type: 'snapshot', players: snapshot }));
    ws.on('close', () => consumers.delete(ws));
    ws.on('error', () => consumers.delete(ws));
  }

  function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const c of consumers) if (c.readyState === 1) c.send(data);
  }

  // ── Presence sweep ──────────────────────────────────────────────────
  const sweep = setInterval(() => {
    const cutoff = Date.now() - ttlMs;
    for (const [id, p] of players)
      if (p.lastSeen < cutoff) { players.delete(id); broadcast({ type: 'leave', id }); }
  }, sweepMs);

  if (!attached) server.listen(port, () => {
    if (log) console.log(`[relay] listening on ${scheme}://0.0.0.0:${port}  ingest=/ingest  consume=/consume  ttl=${ttlMs}ms`);
  });

  return {
    server, wss, players, scheme, health,
    close() {
      clearInterval(sweep);
      server.removeListener('upgrade', onUpgrade);
      for (const c of wss.clients) c.terminate();
      if (!attached) server.close();   // the host owns its server; leave it running
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────
function stripPresence(p) { const { lastSeen, meta, ...rest } = p; return rest; }

/**
 * One player's monotonic clock expressed on ours, Cristian's algorithm with the
 * round-trip filter NTP uses.
 *
 * We send `ping` at t1 (our clock). The player answers immediately with its own
 * reading `c`, and the answer lands at t2. The player read `c` somewhere inside
 * [t1, t2]; assuming the trip took the same either way it read it at the middle,
 * so `offset = (t1 + rtt/2) - c` turns any of its readings into ours.
 *
 * That symmetry assumption is the whole error, and it is why the smallest round
 * trip wins: a fast exchange had little queueing to be lopsided about, while a
 * slow one may be slow in one direction only. Keeping the best of a WINDOW of
 * recent exchanges — rather than the best ever — is what lets the estimate track
 * the headset's oscillator drift instead of clinging to one lucky early packet.
 */
class ClockSync {
  constructor(window = 16) { this._w = window; this._obs = []; this._best = null; }

  observe(t1, c, t2) {
    if (typeof c !== 'number' || !isFinite(c)) return;      // player predates the probe
    const rtt = t2 - t1;
    if (rtt < 0) return;                                    // clock stepped under us; drop it
    this._obs.push({ rtt, offset: (t1 + rtt / 2) - c });
    if (this._obs.length > this._w) this._obs.shift();
    this._best = this._obs.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  }

  /** Player reading -> our clock (ms). Null until the first exchange lands. */
  toServer(t) {
    if (this._best == null || typeof t !== 'number' || !isFinite(t)) return null;
    return Math.round((t + this._best.offset) * 10) / 10;
  }

  /** Half the best round trip: the bound on how wrong toServer() can be. */
  get uncertaintyMs() { return this._best ? this._best.rtt / 2 : null; }
}

// Head-forward vector = quaternion applied to (0,0,-1). Serves as gaze when no
// eye-tracking is available (reliable on every Quest today). Real foveal gaze,
// when present, arrives in `s.g` and is used verbatim instead.
function forwardFromQuat(q) {
  if (!q) return null;
  const [x, y, z, w] = q;
  return [
    round4(-2 * (x * z + w * y)),
    round4( 2 * (w * x - y * z)),
    round4( 2 * (x * x + y * y) - 1),
  ];
}
function round4(n) { return Math.round(n * 1e4) / 1e4; }

// Opt-in TLS, for a relay exposed directly to browsers with nothing in front.
// TLS=on reuses the player's ../certs/{key,cert}.pem (./gen-cert.sh); TLS_KEY /
// TLS_CERT name other paths and imply TLS=on. Default is plain ws://: behind
// server.js or nginx the hop to this relay is loopback and needs no encryption.
function resolveTls() {
  const on = /^(1|on|true)$/i.test(process.env.TLS || '');
  if (!on && !process.env.TLS_KEY && !process.env.TLS_CERT) return null;
  const root = path.join(__dirname, '..');
  const key  = process.env.TLS_KEY  || path.join(root, 'certs', 'key.pem');
  const cert = process.env.TLS_CERT || path.join(root, 'certs', 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    console.warn(`⚠  TLS requested but no certificate at ${key} / ${cert} → falling back to ws://`);
    return null;
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

module.exports = { createRelay, forwardFromQuat, resolveTls, ClockSync };

if (require.main === module) {
  createRelay({
    port:    process.env.PORT     ? +process.env.PORT     : 8090,
    ttlMs:   process.env.TTL_MS   ? +process.env.TTL_MS   : 5000,
    sweepMs: process.env.SWEEP_MS ? +process.env.SWEEP_MS : 1000,
    pingMs:  process.env.PING_MS  ? +process.env.PING_MS  : 2000,
    tls:     resolveTls(),
  });
}
