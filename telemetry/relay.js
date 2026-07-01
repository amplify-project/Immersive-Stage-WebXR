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
// Exports createRelay() so the simulator can embed it in-process; runs
// standalone when invoked directly (node relay.js).

const http = require('http');
const { WebSocketServer } = require('ws');

/**
 * @param {object} [opt]
 * @param {number} [opt.port=8090]
 * @param {number} [opt.ttlMs=5000]    presence timeout (player considered gone after this)
 * @param {number} [opt.sweepMs=1000]  presence sweep period
 * @param {boolean}[opt.log=true]
 * @returns {{ server, wss, players: Map, close: () => void }}
 */
function createRelay({ port = 8090, ttlMs = 5000, sweepMs = 1000, log = true } = {}) {
  const players   = new Map();   // id -> { id, t, mt, p, q, gaze, z, f, meta, lastSeen }
  const consumers = new Set();   // Set<WebSocket>

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, players: players.size, consumers: consumers.size }));
    }
    res.writeHead(404); res.end();
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const path = (req.url || '/ingest').split('?')[0];
    if (path === '/consume') return onConsumer(ws);
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

  server.listen(port, () => {
    if (log) console.log(`[relay] listening on :${port}  ingest=/ingest  consume=/consume  ttl=${ttlMs}ms`);
  });

  return {
    server, wss, players,
    close() { clearInterval(sweep); for (const c of wss.clients) c.terminate(); server.close(); },
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

module.exports = { createRelay, forwardFromQuat };

if (require.main === module) {
  createRelay({
    port:    process.env.PORT     ? +process.env.PORT     : 8090,
    ttlMs:   process.env.TTL_MS   ? +process.env.TTL_MS   : 5000,
    sweepMs: process.env.SWEEP_MS ? +process.env.SWEEP_MS : 1000,
  });
}
