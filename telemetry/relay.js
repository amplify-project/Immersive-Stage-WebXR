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
 * @param {boolean}[opt.log=true]
 * @param {?{key: Buffer|string, cert: Buffer|string}} [opt.tls=null]  listen over wss:// when set
 * @returns {{ server, wss, players: Map, scheme: string, health: () => object, close: () => void }}
 */
function createRelay({ server: hostServer = null, port = 8090, ttlMs = 5000, sweepMs = 1000, log = true, tls = null } = {}) {
  const players   = new Map();   // id -> { id, t, mt, p, q, gaze, z, f, meta, lastSeen }
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
  // only these two paths rather than letting ws hijack every upgrade. Node only
  // auto-destroys upgrades when nobody listens, and we are listening, so an
  // unknown path has to be closed here or it would hang open.
  const wss = new WebSocketServer({ noServer: true });
  const onUpgrade = (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (!PATHS.includes(pathname)) return socket.destroy();
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
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }

      if (msg.hello) {                              // handshake
        id = String(msg.hello);
        const prev = players.get(id) || {};
        players.set(id, { ...prev, id, meta: msg.meta || {}, lastSeen: Date.now() });
        return;
      }
      if (!id || !Array.isArray(msg.b)) return;     // data frames need a prior hello

      const now = Date.now();
      for (const s of msg.b) {
        const rec = {
          id, t: s.t, mt: s.mt,
          p: s.p, q: s.q,
          gaze: s.g || forwardFromQuat(s.q),        // real eye-gaze if sent, else head-forward
          z: s.z, f: s.f,
        };
        const prev = players.get(id) || { meta: {} };
        players.set(id, { ...prev, ...rec, lastSeen: now });
        broadcast({ type: 'update', ...rec });
      }
    });
    ws.on('close', () => { if (id && players.delete(id)) broadcast({ type: 'leave', id }); });
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

module.exports = { createRelay, forwardFromQuat, resolveTls };

if (require.main === module) {
  createRelay({
    port:    process.env.PORT     ? +process.env.PORT     : 8090,
    ttlMs:   process.env.TTL_MS   ? +process.env.TTL_MS   : 5000,
    sweepMs: process.env.SWEEP_MS ? +process.env.SWEEP_MS : 1000,
    tls:     resolveTls(),
  });
}
