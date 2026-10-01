/* ═══════════════════════════════════════════════════════════════════════════
 *  Voice recording service: what the person in the headset said, kept so that
 *  it can be read against what they were doing.
 *
 *    players ──ws──▶ /voice ──▶ recordings/<stamp>_<player>_p<n>.webm + .jsonl
 *
 *  Why it is mounted on the player's own server, and not beside it: the same
 *  reason as /ingest, /consume and /timing. WebXR forces the player onto HTTPS,
 *  an https:// page cannot open a cleartext ws://, and a service on a port of
 *  its own means a second self-signed certificate for the headset to accept — a
 *  failure that shows up as nothing at all.
 *
 *  ── The protocol, in full ──────────────────────────────────────────────────
 *
 *    → {hello:"<playerId>", stamp:"<iso>", mime:"audio/webm;codecs=opus", meta:{…}}
 *    → {c:{p,i,bytes,t0,t,mt0,mt,w}}   immediately followed by ONE binary frame
 *    → {m:{ev,t,mt,w}}                 a landmark: entered VR, left AR, …
 *    → {bye:1}
 *    ← {rec:"<stamp>_<player>"}        what these files are called, back to the player
 *
 *  That one reply is what lets the pose telemetry point at the recording: the
 *  player puts it in its telemetry `hello`, the relay promotes it onto every
 *  record, and a row of poses then names the audio it belongs to. The service
 *  sends the prefix rather than a filename because a session can run to several
 *  parts, and the prefix is what they all share.
 *
 *  A **part** (`p`) is one MediaRecorder run, and therefore one file: the first
 *  chunk of a part carries the container header and every chunk after it is
 *  meaningless without it. The player opens a new part when it has had to buffer
 *  more than it is willing to, so a long disconnection costs an extra file
 *  rather than a corrupt one. Files are opened for APPEND, so a player that
 *  drops and comes back inside the same part continues the same file — which is
 *  what makes the player's buffer worth having.
 *
 *  The sidecar `.jsonl` is where a recording becomes analysable: one line per
 *  chunk, and in it `mt`, the player's media time. That is the same column the
 *  pose recorder writes (`media_s` in recorder.js), so "what he said" and "where
 *  he was looking" line up with no clock arithmetic at all. `srv` (arrival, this
 *  machine's clock) and `w` (the headset's wall clock) are there for the moments
 *  media time cannot answer for: before playback has started, and across a seek.
 *
 *  What comes out is a raw MediaRecorder stream, so it has no duration and no
 *  cues — players will play it, seek bars will not. `ffmpeg -i in.webm -c copy
 *  out.webm` fixes that in a second and without re-encoding.
 * ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Only the containers MediaRecorder actually produces. An unknown one still
// gets written — a recording in a container we did not predict is worth more
// than a refusal — it just lands as .bin and says so in the log.
const EXT = { 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a' };

const extFor = (mime) => EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || '.bin';

// The id and the stamp both come off the wire and both end up in a path.
const safe = (s, max = 64) =>
  String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, max);

/**
 * @param {object}  opt
 * @param {import('http').Server} opt.server   the server to attach to (required)
 * @param {string}  [opt.path='/voice']
 * @param {string}  [opt.dir]                  where recordings land (default ../recordings)
 * @param {number}  [opt.maxBytesPerPart=512MB]  runaway guard, per file
 * @param {boolean} [opt.log=false]
 */
function createVoiceService({ server, path: wsPath = '/voice', dir = path.join(__dirname, '..', 'recordings'),
                              maxBytesPerPart = 512 * 1024 * 1024, log = false } = {}) {
  if (!server) throw new Error('createVoiceService: needs a server to attach to');

  const active = new Map();   // ws -> session

  const wss = new WebSocketServer({ noServer: true });

  // Ours only. A path that is not ours is left alone rather than destroyed:
  // the relay and the timing service are mounted on this same server and their
  // upgrade listeners run after this one. server.js closes what nobody claimed.
  const onUpgrade = (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== wsPath) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws) => {
    const s = {
      id: null, stamp: null, mime: '', ext: '.webm', meta: {},
      part: -1, out: null, side: null, file: '', prefix: '',
      bytes: 0, chunks: 0, pending: null,
      firstT: null, lastT: null, opened: Date.now(),
    };
    active.set(ws, s);

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return body(s, raw);
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.hello) return hello(s, m, ws);
      // The header for the frame that is about to arrive. Kept on the side
      // rather than merged into the body: ws preserves order within a socket, so
      // the pairing is the arrival order and nothing has to be parsed out of the
      // audio itself.
      if (m.c) { s.pending = m.c; return; }
      if (m.m) return mark(s, m.m);
      if (m.bye) return closePart(s);
    });

    const gone = () => { closePart(s); active.delete(ws); };
    ws.on('close', gone);
    ws.on('error', gone);
  });

  function hello(s, m, ws) {
    s.id    = safe(m.hello) || 'anon';
    s.stamp = safe(m.stamp) || new Date().toISOString().replace(/[:.]/g, '-');
    s.mime  = String(m.mime || '');
    s.ext   = extFor(s.mime);
    s.meta  = (m.meta && typeof m.meta === 'object') ? m.meta : {};
    s.prefix = `${s.stamp}_${s.id}`;
    // Named here and not in the player: the sanitising is ours, so a player that
    // sent something awkward would otherwise advertise a reference to a file
    // that is not the one we opened.
    try { if (ws.readyState === 1) ws.send(JSON.stringify({ rec: s.prefix })); } catch (_) {}
    if (log) console.log(`[voice] ${s.id} connected (${s.mime || 'unknown container'})`);
  }

  // A mark can arrive before the first chunk has opened a file — entering VR
  // within the first second of recording is the normal case, not a corner one —
  // so it waits for the part rather than being dropped.
  function mark(s, m) {
    const line = JSON.stringify({ type: 'mark', ...m, srv: Date.now() }) + '\n';
    if (s.side) s.side.write(line);
    else (s.marks || (s.marks = [])).push(line);
  }

  function body(s, buf) {
    if (!s.id) return;                     // a body before the hello has no name to go under
    const c = s.pending; s.pending = null;
    if (!c) return;                        // and one we cannot place is worse than none
    const p = Number.isFinite(c.p) ? c.p : 0;
    if (p !== s.part) openPart(s, p);
    if (!s.out) return;

    if (s.bytes + buf.length > maxBytesPerPart) {
      if (s.out) { console.warn(`[voice] ${s.file}: hit ${(maxBytesPerPart / 1e6) | 0} MB, closing the part`); closePart(s); }
      return;
    }

    s.out.write(buf);
    s.side.write(JSON.stringify({ ...c, p, srv: Date.now() }) + '\n');
    s.bytes += buf.length;
    s.chunks++;
    if (s.firstT == null) s.firstT = c.t0;
    s.lastT = c.t;
  }

  function openPart(s, p) {
    closePart(s);
    fs.mkdirSync(dir, { recursive: true });
    const base = s.prefix + (p ? `_p${p}` : '');
    s.part = p;
    s.file = base + s.ext;
    const full = path.join(dir, s.file);

    // Append, not truncate: a player that dropped and reconnected inside the
    // same part is continuing a file that already holds its container header.
    // Re-opening it empty would throw away everything said before the drop and
    // leave a file whose header describes a stream that is no longer there.
    let had = 0;
    try { had = fs.statSync(full).size; } catch (_) { /* new part */ }
    s.bytes = had;
    s.out  = fs.createWriteStream(full, { flags: 'a' });
    s.side = fs.createWriteStream(path.join(dir, base + '.jsonl'), { flags: 'a' });
    s.side.write(JSON.stringify({
      type: had ? 'resume' : 'start', id: s.id, stamp: s.stamp, part: p,
      mime: s.mime, meta: s.meta, srv: Date.now(),
    }) + '\n');
    if (s.marks) { for (const line of s.marks) s.side.write(line); s.marks = null; }
    s.chunks = 0; s.firstT = null; s.lastT = null;
    if (log) console.log(`[voice] ${s.id} → ${s.file}${had ? ` (append, ${(had / 1e6).toFixed(1)} MB already)` : ''}`);
  }

  function closePart(s) {
    if (!s.out) return;
    const secs = (s.firstT != null && s.lastT != null) ? (s.lastT - s.firstT) / 1000 : 0;
    s.side.write(JSON.stringify({ type: 'end', chunks: s.chunks, bytes: s.bytes, secs: +secs.toFixed(1), srv: Date.now() }) + '\n');
    s.out.end(); s.side.end();
    s.out = null; s.side = null;
    console.log(`[voice] ${s.file} · ${s.chunks} chunks · ${(s.bytes / 1e6).toFixed(1)} MB · ${secs.toFixed(0)}s`);
    s.part = -1;
  }

  return {
    wss,
    path: wsPath,
    dir,
    active,
    health: () => ({ ok: true, recording: active.size, dir }),
    close() {
      server.removeListener('upgrade', onUpgrade);
      for (const [ws, s] of active) { closePart(s); try { ws.close(); } catch (_) {} }
      active.clear();
      wss.close();
    },
  };
}

module.exports = { createVoiceService };
