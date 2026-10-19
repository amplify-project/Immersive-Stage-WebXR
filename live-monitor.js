// live-monitor.js — hear the desk live, before going on air.
//
// The live stream is the wrong tool for a soundcheck: by the time a change on
// the desk reaches the player it has been through the encode, a few DASH
// segments and the player's buffer — around 20 s. This opens the same ALSA
// device the encode would, applies the SAME channel patch (four FOA channels,
// one per musician), and sends raw PCM over a WebSocket. The editor feeds it to
// the player's own audio engine, so the technician hears what the audience will
// hear, a couple of hundred milliseconds after it happens.
//
// Protocol on /monitor:
//   client → server  first message, JSON: the patch from the editor's in-memory
//                    scene (so the monitor follows unsaved edits):
//                    { device, channels, foaCh:[4], aformat, format, stemCh:[…] }
//   server → client  JSON text: {type:'start', channels, rate, …} | {type:'error', message}
//                    binary: interleaved s16le frames, 4 + stems channels, 48 kHz,
//                    always whole frames.
//
// ALSA is exclusive: this refuses to start while an encode runs, and server.js
// stops it before starting one. One monitor at a time; a new one takes over.
//
// The filter mirrors build_inputs_capture() in stream.sh. If the patch logic
// changes there, change it here too.

const path = require('path');
const { spawn, execFile } = require('child_process');

// `ws` lives in telemetry/node_modules (the project's only npm dependency).
const { WebSocketServer } = require(require.resolve('ws', { paths: [path.join(__dirname, 'telemetry')] }));

const PATH = '/monitor';
const RATE = 48000;
const MAX_BUFFERED = 512 * 1024;   // bytes queued on the socket before we drop audio

const FOA_FILTER = {
  fuma:  'pan=4.0|c0=1.41421356*c0|c1=c2|c2=c3|c3=c1',
  ambix: 'anull',
};
// Rode NT-SF1 A-format → FuMa B-format (same matrix as stream.sh).
const A2B_FILTER = 'pan=4.0|c0=0.5*c0+0.5*c1+0.5*c2+0.5*c3|c1=0.5*c0+0.5*c1-0.5*c2-0.5*c3|c2=0.5*c0-0.5*c1+0.5*c2-0.5*c3|c3=0.5*c0-0.5*c1-0.5*c2+0.5*c3';

const isCh = v => Number.isInteger(v) && v >= 0 && v < 256;

// Validate what the browser sent. The device name ends up as an ffmpeg
// argument (spawned without a shell), but keep it to ALSA-looking names anyway.
function parsePatch(raw) {
  let p; try { p = JSON.parse(raw); } catch (_) { throw new Error('bad patch (not JSON)'); }
  const device = String(p.device || '');
  if (!/^[A-Za-z0-9_:,.=-]{1,64}$/.test(device)) throw new Error(`bad ALSA device: '${device}'`);
  const channels = Number(p.channels) || 32;
  if (!isCh(channels) || channels < 1) throw new Error('bad channel count');
  const foaCh = Array.isArray(p.foaCh) && p.foaCh.length === 4 && p.foaCh.every(isCh) ? p.foaCh : [0, 1, 2, 3];
  const stemCh = (Array.isArray(p.stemCh) ? p.stemCh : []).map(c => (isCh(c) ? c : null));
  const format = p.format === 'ambix' ? 'ambix' : 'fuma';
  return { device, channels, foaCh, stemCh, aformat: !!p.aformat, format };
}

// What the device really opens with (format and channel range), as stream.sh
// does: the X32 and other UAC2 desks only take S32_LE, a headset only S16_LE.
function probeDevice(device) {
  return new Promise(res => {
    execFile('arecord', ['-D', device, '--dump-hw-params', '-d', '1', '/dev/null'],
      { timeout: 3000, env: { ...process.env, LC_ALL: 'C' } }, (_e, out, err) => {
        const txt = String(out) + String(err);
        const fmts = (/^FORMAT:\s*(.*)$/m.exec(txt) || [])[1] || '';
        const chs = ((/^CHANNELS:\s*(.*)$/m.exec(txt) || [])[1] || '').replace(/[[\]]/g, '').trim();
        const codec = ['S32_LE', 'S16_LE', 'S24_LE'].find(f => fmts.split(/\s+/).includes(f));
        const [lo, hi] = chs ? chs.split(/\s+/).map(Number) : [];
        res({ codec: codec ? 'pcm_' + codec.replace('_', '').toLowerCase() : null,
              chMin: lo || null, chMax: hi || lo || null, busy: /busy/i.test(txt) });
      });
  });
}

// "Device or resource busy" names nobody. On a desktop it is nearly always
// PulseAudio/PipeWire: they open every USB card that appears, and keep its
// input open while any app listens to it (a Sound settings level meter, a call,
// a browser tab). Name the holder and the card, so the fix is one command
// instead of a hunt. Never changes anything itself.
const run = (cmd, args) => new Promise(res =>
  execFile(cmd, args, { timeout: 3000, env: { ...process.env, LC_ALL: 'C' } },
    (_e, out, err) => res(String(out) + String(err))));

async function whoHolds(device) {
  const m = /^(?:plug)?hw:([^,]+)(?:,(\d+))?/.exec(device);
  if (!m) return '';
  let card = m[1];
  const dev = m[2] || '0';
  if (!/^\d+$/.test(card)) {                    // hw:Loopback,1 → card number
    const cards = await run('cat', ['/proc/asound/cards']);
    const hit = new RegExp(`^\\s*(\\d+)\\s+\\[${card}\\s*\\]`, 'm').exec(cards);
    if (!hit) return '';
    card = hit[1];
  }
  // fuser prints the PIDs on stdout (and the rest on stderr): ask ps for names.
  const pids = await new Promise(res => execFile('fuser', [`/dev/snd/pcmC${card}D${dev}c`],
    { timeout: 3000 }, (_e, out) => res(String(out).trim().split(/\s+/).filter(x => /^\d+$/.test(x)))));
  if (!pids.length) return '';
  const procs = [...new Set((await run('ps', ['-o', 'comm=', '-p', pids.join(',')])).split('\n').map(s => s.trim()).filter(Boolean))];
  if (!procs.length) return '';
  if (!procs.some(p => /pulseaudio|pipewire|wireplumber/.test(p)))
    return ` — held by: ${procs.join(', ')}`;
  // Which PulseAudio card that is, and who is recording from it.
  const cards = await run('pactl', ['list', 'cards']);
  let pcard = '';
  for (const block of cards.split(/^Card #/m)) {
    if (new RegExp(`alsa\\.card = "${card}"`).test(block)) { pcard = (/Name:\s*(\S+)/.exec(block) || [])[1] || ''; break; }
  }
  const outs = await run('pactl', ['list', 'source-outputs']);
  const apps = [...new Set((outs.match(/application\.name = "([^"]+)"/g) || []).map(s => s.slice(20, -1)))];
  return ` — PulseAudio holds it` + (apps.length ? ` (recording through it: ${apps.join(', ')})` : '') +
    `. Close that app, or, if the desktop does not need this card (a mixer, not your headset: ` +
    `this also mutes its output), take it away from PulseAudio` +
    (pcard ? `: pactl set-card-profile ${pcard} off` : '');
}

// A killed ffmpeg holds the device until it has really exited, and opening it
// again before that says "busy". Every new capture waits for the previous one.
function exitOf(proc) {
  return new Promise(r => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return r();
    proc.once('exit', () => r());
    setTimeout(r, 2000);
  });
}

function buildFilter(p) {
  const [f0, f1, f2, f3] = p.foaCh;
  let fc = `[0:a]pan=4.0|c0=c${f0}|c1=c${f1}|c2=c${f2}|c3=c${f3}[foasel];`;
  // A→B lands in FuMa, so the FuMa→AmbiX step always follows it.
  fc += p.aformat ? `[foasel]${A2B_FILTER},${FOA_FILTER.fuma}[foa];`
                  : `[foasel]${FOA_FILTER[p.format]}[foa];`;
  // A musician with no channel stays as a silent channel, so channel 4+i is
  // still scene.stems[i] — same rule as the encode.
  let merge = '[foa]';
  p.stemCh.forEach((c, i) => {
    fc += c != null ? `[0:a]pan=mono|c0=c${c}[s${i}];` : `[0:a]pan=mono|c0=0*c0[s${i}];`;
    merge += `[s${i}]`;
  });
  if (!p.stemCh.length) return fc.replace(/\[foa\];$/, '[out]');
  return fc + `${merge}amerge=inputs=${p.stemCh.length + 1}[out]`;
}

function createLiveMonitor({ server, isBusy = () => null, log = true } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  let cur = null;   // { ws, proc }
  let lastProc = null;

  const onUpgrade = (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== PATH) return;   // not ours: leave it to the others
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  function stop(reason) {
    if (!cur) return false;
    const { ws, proc } = cur;
    cur = null;
    if (proc) { try { proc.kill('SIGKILL'); } catch (_) {} }
    if (ws.readyState === ws.OPEN) {
      if (reason) ws.send(JSON.stringify({ type: 'error', message: reason }));
      ws.close();
    }
    return true;
  }

  wss.on('connection', ws => {
    const send = obj => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
    ws.once('message', async raw => {
      const busy = isBusy();
      if (busy) { send({ type: 'error', message: busy }); return ws.close(); }
      let p;
      try { p = parsePatch(String(raw)); } catch (e) { send({ type: 'error', message: e.message }); return ws.close(); }

      stop('Another monitor took over.');   // one capture at a time: ALSA is exclusive
      const me = { ws, proc: null };
      cur = me;

      await exitOf(lastProc);
      if (cur !== me) return;
      const dev = await probeDevice(p.device);
      if (cur !== me) return;   // closed or taken over while probing
      let channels = p.channels;
      if (dev.chMin && dev.chMax && (channels < dev.chMin || channels > dev.chMax))
        channels = channels > dev.chMax ? dev.chMax : dev.chMin;
      const codec = dev.codec || 'pcm_s32le';
      const nch = 4 + p.stemCh.length;
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin',
        '-fflags', 'nobuffer', '-flags', 'low_delay',
        '-f', 'alsa', '-acodec', codec, '-channels', String(channels), '-sample_rate', String(RATE), '-i', p.device,
        '-filter_complex', buildFilter(p), '-map', '[out]',
        '-c:a', 'pcm_s16le', '-ar', String(RATE), '-f', 's16le', 'pipe:1'];
      if (log) console.log('[monitor] ffmpeg ' + args.map(a => (/[\s|;[\]]/.test(a) ? JSON.stringify(a) : a)).join(' '));

      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      me.proc = proc; lastProc = proc;
      send({ type: 'start', channels: nch, rate: RATE, device: p.device, codec,
             opened: channels, asked: p.channels,
             stems: p.stemCh.map(c => (c == null ? null : c)) });

      const frame = nch * 2;
      let rest = Buffer.alloc(0), err = '';
      proc.stdout.on('data', chunk => {
        if (ws.readyState !== ws.OPEN) return;
        let buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        const whole = buf.length - (buf.length % frame);
        rest = buf.subarray(whole);
        // A slow client must not make latency grow: drop rather than queue.
        if (whole && ws.bufferedAmount < MAX_BUFFERED) ws.send(buf.subarray(0, whole));
      });
      proc.stderr.on('data', d => { err = (err + d).slice(-600); });
      proc.on('error', e => { if (cur === me) stop('ffmpeg: ' + e.message); });
      proc.on('exit', async code => {
        if (cur !== me) return;
        if (!code) return stop('Capture ended.');
        let why = err.trim().split('\n').pop() || '';
        if (dev.busy || /busy|Input\/output error/i.test(err)) {
          const holder = await whoHolds(p.device);
          why = `${p.device} is busy` + (holder || ' (another program has it open)');
        }
        if (cur === me) stop(`Capture stopped (ffmpeg exit ${code}): ${why}`);
      });
    });
    ws.on('close', () => { if (cur && cur.ws === ws) stop(); });
  });

  return { path: PATH, stop, running: () => !!cur };
}

// ── Camera preview for the monitor ──────────────────────────────────────────
// GET /api/monitor/video?device=/dev/video0&size=2880x1440&fr=24&informat=mjpeg
// answers with multipart MJPEG, which an <img> plays natively: no H.264, no
// segments, so the picture is a frame or two behind the camera. Downscaled to
// 1280 wide: it is for seeing the stage, not for judging the image.
//
// v4l2 devices — and the X4 bridge's /dev/video10 in particular — take ONE
// reader, so this obeys the same rules as the audio: refused during an encode,
// stopped by Start LIVE, the delay measurement and the ROI snapshot, and a new
// preview replaces the previous one.
function createVideoPreview({ isBusy = () => null, log = true } = {}) {
  let cur = null;   // { proc, res }
  let lastProc = null, seq = 0;
  let lastError = '';   // an <img> cannot read an error body: the editor asks here

  function stop() {
    if (!cur) return false;
    const { proc, res } = cur;
    cur = null;
    try { proc.kill('SIGKILL'); } catch (_) {}
    try { res.end(); } catch (_) {}
    return true;
  }

  async function handle(req, res) {
    const q = new URL(req.url, 'http://x').searchParams;
    const device = q.get('device') || '/dev/video0';
    const size = q.get('size') || '';
    const fr = Math.min(60, Math.max(1, parseInt(q.get('fr'), 10) || 30));
    const informat = q.get('informat') || '';
    const fail = (code, msg) => { lastError = msg; res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
    if (!/^\/dev\/video\d{1,3}$/.test(device)) return fail(400, 'bad video device');
    if (size && !/^\d{2,5}x\d{2,5}$/.test(size)) return fail(400, 'bad size');
    if (informat && !/^[a-z0-9_]{1,16}$/.test(informat)) return fail(400, 'bad input format');
    const busy = isBusy();
    if (busy) return fail(409, busy);

    stop();   // one reader per device
    const mine = ++seq;
    await exitOf(lastProc);
    if (mine !== seq || res.destroyed) return;   // replaced or abandoned meanwhile
    lastError = '';
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-f', 'v4l2', '-framerate', String(fr),
      ...(informat ? ['-input_format', informat] : []),
      ...(size ? ['-video_size', size] : []),
      '-i', device,
      '-vf', 'scale=1280:-2', '-c:v', 'mjpeg', '-q:v', '6',
      '-f', 'mpjpeg', '-boundary_tag', 'frame', '-flush_packets', '1', 'pipe:1'];
    if (log) console.log('[monitor] video: ffmpeg ' + args.join(' '));
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    lastProc = proc;
    const me = { proc, res };
    cur = me;
    let started = false, err = '';
    proc.stdout.on('data', d => {
      if (!started) {
        started = true;
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
                             'Cache-Control': 'no-store', 'Connection': 'close' });
      }
      res.write(d);
    });
    proc.stderr.on('data', d => { err = (err + d).slice(-400); });
    proc.on('exit', code => {
      if (cur === me) cur = null;
      if (!started) fail(502, `Could not open ${device}` + (err.trim() ? ': ' + err.trim().split('\n').pop() : ` (ffmpeg exit ${code})`));
      else try { res.end(); } catch (_) {}
    });
    proc.on('error', e => { if (cur === me) cur = null; if (!started) fail(500, 'ffmpeg: ' + e.message); });
    res.on('close', () => { if (cur === me) stop(); });
  }

  return { handle, stop, running: () => !!cur, lastError: () => lastError };
}

module.exports = { createLiveMonitor, createVideoPreview, buildFilter, parsePatch, whoHolds };
