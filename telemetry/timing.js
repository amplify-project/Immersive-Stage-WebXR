/* ═══════════════════════════════════════════════════════════════════════════
 *  Timing service: the shared clock a session of players plays against.
 *
 *  Speaks the wire protocol of the Motion server (W3C Timing Object), so the
 *  vendored client in src/vendor/motion talks to this without knowing, and a
 *  real motion-server can replace it by changing a URL.
 *
 *  Why it lives in OUR server rather than beside it:
 *
 *  - WebXR forces the player over HTTPS, and an https:// page cannot open a
 *    cleartext ws://. Mounted here, the headset sees one origin, one port and one
 *    certificate — the one it already accepted to load the player. On its own
 *    port it would have to accept a second self-signed certificate, and that
 *    failure is mute: the socket dies with nothing visible on the page. Exactly
 *    the reasoning that already put /ingest and /consume here.
 *  - One process. `node server.js` and everything is up, which is what anyone
 *    running a concert expects.
 *  - The motion-server we have does not implement `timerId`, so it cannot host
 *    two sessions and its replies are dropped by its own client (see
 *    docs/motion-sync.md). Rather than carry a patch to somebody else's repo,
 *    the four messages that matter are here.
 *
 *  And why it sits in telemetry/ despite not being telemetry: `ws` is the
 *  project's single npm dependency and it is installed here. A folder of its own
 *  would mean a second npm install for 200 lines.
 *
 *  ── The protocol, in full ──────────────────────────────────────────────────
 *
 *    → {type:'info',   id, clientId, timerId, duration}
 *    ← {type:'info',   id, timerId, vector}              the vector, projected to now
 *    → {type:'sync',   id, client:{sent}}
 *    ← {type:'sync',   id, client:{sent}, server:{received, sent}, delta}
 *    → {type:'update', id, clientId, timerId, vector:{position, velocity}}
 *    ← {type:'change', id, timerId, vector}              to everyone on that timerId
 *
 *  `timerId` is the session. Two of them on one service never see each other.
 * ═══════════════════════════════════════════════════════════════════════════ */

const { WebSocketServer } = require('ws');

// A vector is position + velocity stamped with the server's clock, in seconds.
// Everything else — where a player should be right now, where a late joiner
// lands — is arithmetic on these three numbers.
function project(v, nowSec) {
  const dt = nowSec - v.timestamp;
  return {
    position: v.position + v.velocity * dt + 0.5 * v.acceleration * dt * dt,
    velocity: v.velocity + v.acceleration * dt,
    acceleration: v.acceleration,
    timestamp: nowSec,
  };
}

function createTimingService({ server, path = '/timing', log = false } = {}) {
  if (!server) throw new Error('createTimingService: needs a server to attach to');

  // timerId -> { vector, conns:Set<WebSocket> }
  const sessions = new Map();

  const sessionFor = (timerId) => {
    let s = sessions.get(timerId);
    if (!s) {
      s = { vector: { position: 0, velocity: 0, acceleration: 0, timestamp: Date.now() / 1000 },
            conns: new Set() };
      sessions.set(timerId, s);
      if (log) console.log(`[timing] session "${timerId}" created`);
    }
    return s;
  };

  // The client asks for 'echo-protocol' (it is the motion-server's, inherited
  // from the sample it grew out of). ws answers with no subprotocol unless we
  // pick one, and a client that offered one and got nothing back may refuse the
  // connection — so echo it when offered, and accept a client that offers none.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('echo-protocol') ? 'echo-protocol' : false),
  });

  const onUpgrade = (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== path) return;   // not ours; someone else may claim it
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

  wss.on('connection', (ws) => {
    let joined = null;            // the session this socket belongs to

    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      const now = Date.now();

      // Clock synchronisation. Answer immediately and with no work in between:
      // the client's estimate is only as good as this reply is prompt, and
      // anything done first lands inside its measured round trip. `delta` stays
      // 0 — we impose no offset of our own, which is what the client's
      // `msg.vector.timestamp -= delta` expects when there is nothing to impose.
      if (msg.type === 'sync') {
        return send(ws, {
          type: 'sync',
          id: msg.id,
          client: { sent: (msg.client || {}).sent },
          server: { received: now, sent: now },
          delta: 0,
        });
      }

      if (msg.type === 'info') {
        // The client will not open on a reply whose timerId does not come back,
        // and it will not tell anybody why. Echo it.
        joined = sessionFor(msg.timerId);
        joined.conns.add(ws);
        if (log) console.log(`[timing] "${msg.clientId}" joined "${msg.timerId}" (${joined.conns.size} on it)`);
        return send(ws, { type: 'info', id: msg.id, timerId: msg.timerId,
                          vector: project(joined.vector, now / 1000) });
      }

      if (msg.type === 'update') {
        const s = sessionFor(msg.timerId);
        const v = msg.vector || {};
        // The client's timestamp is on the CLIENT's clock. Stamping with ours is
        // not a shortcut: this vector is about to be read by everyone else
        // against the server clock they synchronised to, so it has to be in that
        // frame. It is also what the motion-server does.
        s.vector = {
          position: Number.isFinite(v.position) ? v.position : 0,
          velocity: Number.isFinite(v.velocity) ? v.velocity : 0,
          acceleration: Number.isFinite(v.acceleration) ? v.acceleration : 0,
          timestamp: now / 1000,
        };
        if (log) console.log(`[timing] "${msg.timerId}" → pos ${s.vector.position.toFixed(2)} vel ${s.vector.velocity}`);
        // Back to the sender too: it is a client like any other, and the change
        // it receives is the one stamped on the shared clock rather than its own.
        const change = { type: 'change', id: msg.id, timerId: msg.timerId, vector: s.vector };
        for (const c of s.conns) send(c, change);
        return;
      }
    });

    const leave = () => {
      if (!joined) return;
      joined.conns.delete(ws);
      // The session outlives its clients on purpose: the manager reloading its
      // page must not reset the concert to zero, and a player that reconnects
      // has to find the session where it left it.
    };
    ws.on('close', leave);
    ws.on('error', leave);
  });

  return {
    wss,
    path,
    sessions,
    close() {
      server.removeListener('upgrade', onUpgrade);
      for (const s of sessions.values()) for (const c of s.conns) { try { c.close(); } catch (_) {} }
      wss.close();
    },
  };
}

module.exports = { createTimingService, project };
