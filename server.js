const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 60000;
const ROOT = __dirname;
const MEDIA_DIR = path.join(ROOT, 'media');
const SCENE_FILE = path.join(ROOT, 'scene.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mpd':  'application/dash+xml',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.webm': 'video/webm',
  '.mp4':  'video/mp4',
  '.m4s':  'video/iso.segment',
  '.m4a':  'audio/mp4',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.m4v'];
const AUDIO_EXT = ['.wav', '.mp3', '.opus', '.ogg', '.flac', '.m4a', '.aac'];

// ════════════════════════════════════════════════════════════════════════════
//  Estado del encode en curso (un único job a la vez).
// ════════════════════════════════════════════════════════════════════════════
let job = null;   // { proc, mode, log:[], speed, startedAt, exit }

function pushLog(line) {
  if (!job) return;
  line = line.replace(/\s+$/, '');
  if (!line) return;
  job.log.push(line);
  if (job.log.length > 300) job.log.shift();
  const m = /speed=\s*([0-9.]+x)/.exec(line);
  if (m) job.speed = m[1];
  const f = /frame=\s*(\d+)/.exec(line);
  if (f) job.frame = +f[1];
}

function startJob(mode, cmd, args, env) {
  if (job && job.proc) throw new Error('Ya hay un proceso en marcha (' + job.mode + ')');
  const proc = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, detached: true });
  job = { proc, mode, log: [], speed: '', frame: 0, startedAt: Date.now(), exit: null, cmd: [cmd, ...args].join(' ') };
  const onData = b => b.toString().split(/\r|\n/).forEach(pushLog);
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', e => { pushLog('ERROR spawn: ' + e.message); job.exit = -1; job.proc = null; });
  proc.on('exit', code => { pushLog('— proceso terminado (code ' + code + ') —'); job.exit = code; job.proc = null; });
  return job;
}

function stopJob() {
  if (!job || !job.proc) return false;
  try { process.kill(-job.proc.pid, 'SIGINT'); } catch (_) {}
  // Refuerzo: SIGKILL al grupo si sigue vivo tras 1.5s.
  const p = job.proc;
  setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch (_) {} }, 1500);
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
//  Puente Insta360 → cámara virtual v4l2 (x4_bridge/bridge.sh). Es un proceso
//  independiente del encode: crea /dev/video10 y la alimenta desde el SDK, para
//  que LIVE pueda capturar de esa cámara virtual. Por eso lleva su propio slot.
// ════════════════════════════════════════════════════════════════════════════
const BRIDGE_DIR = path.join(ROOT, 'x4_bridge');
const BRIDGE_BIN = path.join(BRIDGE_DIR, 'insta360_v4l2_bridge');
let bridge = null;   // { proc, log:[], startedAt, exit }

function pushBridgeLog(line) {
  if (!bridge) return;
  line = line.replace(/\s+$/, '');
  if (!line) return;
  bridge.log.push(line);
  if (bridge.log.length > 200) bridge.log.shift();
}

function startBridge() {
  if (bridge && bridge.proc) throw new Error('El puente ya está en marcha');
  if (!fs.existsSync(BRIDGE_BIN)) {
    throw new Error('Binario no compilado: ejecuta x4_bridge/build_insta360_v4l2_bridge.sh');
  }
  const proc = spawn('bash', ['bridge.sh'], { cwd: BRIDGE_DIR, env: process.env, detached: true });
  bridge = { proc, log: [], startedAt: Date.now(), exit: null };
  const onData = b => b.toString().split(/\r|\n/).forEach(pushBridgeLog);
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', e => { pushBridgeLog('ERROR spawn: ' + e.message); bridge.exit = -1; bridge.proc = null; });
  proc.on('exit', code => { pushBridgeLog('— puente terminado (code ' + code + ') —'); bridge.exit = code; bridge.proc = null; });
  return bridge;
}

function stopBridge() {
  if (!bridge || !bridge.proc) return false;
  const p = bridge.proc;
  try { process.kill(-p.pid, 'SIGINT'); } catch (_) {}
  // bridge.sh es un watchdog while-true que relanza el binario bajo sudo; hay que
  // matar el grupo entero y rematar el binario huérfano (corre como root → sudo).
  setTimeout(() => {
    try { process.kill(-p.pid, 'SIGKILL'); } catch (_) {}
    try { spawn('sudo', ['-n', 'killall', '-9', 'insta360_v4l2_bridge'], { stdio: 'ignore' }); } catch (_) {}
  }, 800);
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
//  Monitor de sync A/V: ffmpeg ligero que muxa vídeo (v4l2) + audio (ALSA, estéreo)
//  en fragmented-MP4 a stdout y se stream-ea al navegador vía MSE. Aplica el delay
//  para poder ajustarlo a ojo/oído. Cliente único: una nueva conexión reemplaza la
//  anterior. NOTA: el audio ALSA es exclusivo → no correr a la vez que el live.
// ════════════════════════════════════════════════════════════════════════════
let monitor = null;   // { proc }
const MONITOR_PID = path.join(ROOT, '.monitor.pid');

// Mata el proceso (y su grupo) cuyo PID quedó en un fichero, aunque ya no lo
// tengamos en memoria: huérfano tras refresco del navegador o reinicio del server.
function killPidFile(file) {
  let pid;
  try { pid = parseInt(fs.readFileSync(file, 'utf8'), 10); } catch (_) { return; }
  if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch (_) {} try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  try { fs.unlinkSync(file); } catch (_) {}
}

function stopMonitor() {
  if (monitor && monitor.proc) { try { process.kill(-monitor.proc.pid, 'SIGKILL'); } catch (_) {} }
  killPidFile(MONITOR_PID);   // remata cualquier huérfano sin trackear
  monitor = null;
}

// Monitor fiel con ffplay (monitor_sync.sh): ventana local en la máquina de
// producción. Comparte vídeo+audio con el monitor MSE → no coexisten.
let ffplayMon = null;   // { proc }
function stopFfplayMon() {
  if (ffplayMon && ffplayMon.proc) { try { process.kill(-ffplayMon.proc.pid, 'SIGKILL'); } catch (_) {} }
  ffplayMon = null;
}

function buildMonitorArgs(scene, delayMs) {
  const L = scene.live || {}, V = L.video || {}, A = L.audio || {};
  const args = ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay'];

  // Canales = lo configurado en el editor (campo "Total ch."). 1-2 canales =
  // prueba → se monitoriza tal cual; muchos (X32) → se aísla el canal W del FOA.
  const ch = Number(A.channels) || 2;
  const testMode = ch <= 2;

  // — Vídeo — (-use_wallclock_as_timestamps: timestamp por reloj de pared para que
  //   el offset A/V sea estable/repetible entre arranques, no según orden de llegada)
  if ((V.src || 'usb') === 'udp' && V.url) {
    args.push('-use_wallclock_as_timestamps', '1', '-i', V.url);
  } else {
    args.push('-f', 'v4l2', '-framerate', String(V.fr || 24), '-use_wallclock_as_timestamps', '1', '-i', V.device || '/dev/video10');
  }

  // — Audio — El delay NO va con -itsoffset en el input: obliga a bufferizar un
  //   stream entero para intercalar y, con captura en vivo + nobuffer, desborda
  //   el ring de ALSA → xrun/broken pipe con delays grandes (800ms casca, 80 cuela).
  //   Se aplica con el filtro adelay (silencio al principio): ambos streams en
  //   PTS 0, sin skew en el muxer, ALSA se vacía normal.
  const dms = Math.round(Number(delayMs) || 0);
  if ((A.src || 'usb') === 'udp' && A.url) {
    args.push('-use_wallclock_as_timestamps', '1', '-i', A.url);
  } else {
    args.push('-thread_queue_size', '1024', '-f', 'alsa', '-channels', String(ch), '-use_wallclock_as_timestamps', '1', '-i', A.device || 'default');
  }

  // Canal a monitorizar. En prueba (1-2 ch) reproducimos los canales reales del
  // device tal cual. En multicanal aislamos el W del FOA (omni): -ac 2 no sabe
  // bajar un device de N canales discretos (silencio) → pan a un canal concreto.
  let wch = (A.foa && Array.isArray(A.foa.ch) && A.foa.ch.length ? A.foa.ch[0] : 0);
  if (wch >= ch) wch = 0;            // el canal pedido no existe en este device
  let af = testMode
    ? (ch >= 2 ? 'pan=stereo|c0=c0|c1=c1' : 'pan=stereo|c0=c0|c1=c0')
    : `pan=stereo|c0=c${wch}|c1=c${wch}`;
  if (dms > 0) af += `,adelay=${dms}|${dms}`;

  // — Encode ligero (x264 zerolatency, 960px) + AAC estéreo → fragmented MP4 a stdout —
  args.push(
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', 'scale=960:-2,format=yuv420p',
    '-af', af,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-profile:v', 'high', '-level', '4.0', '-g', '30', '-b:v', '2500k',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '200000', '-f', 'mp4', '-',
  );
  return args;
}

// ════════════════════════════════════════════════════════════════════════════
//  Listado de medios (con nº de canales para distinguir el bed FOA de los stems).
// ════════════════════════════════════════════════════════════════════════════
function probeChannels(file) {
  return new Promise(res => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=channels', '-of', 'csv=p=0', file],
      { timeout: 5000 }, (err, out) => res(err ? null : parseInt(String(out).trim(), 10) || null));
  });
}

async function listMedia() {
  let files = [];
  try { files = fs.readdirSync(MEDIA_DIR); } catch (_) {}
  const out = [];
  for (const f of files) {
    if (f.startsWith('.')) continue;
    const full = path.join(MEDIA_DIR, f);
    let st; try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isFile()) continue;
    const ext = path.extname(f).toLowerCase();
    const kind = VIDEO_EXT.includes(ext) ? 'video' : AUDIO_EXT.includes(ext) ? 'audio' : 'other';
    const item = { file: 'media/' + f, name: f, kind, size: st.size };
    if (kind === 'audio') item.channels = await probeChannels(full);
    out.push(item);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  Dispositivos de captura (LIVE). Se enumeran en la MÁQUINA que corre el server
//  (la de producción, con la Insta360 y la X32 conectadas), no en el navegador.
//    vídeo → v4l2 (/dev/video*)   ·   audio → ALSA (hw:CARD,DEV con nº canales)
// ════════════════════════════════════════════════════════════════════════════
function run(cmd, args) {
  return new Promise(res => {
    execFile(cmd, args, { timeout: 5000 }, (err, out, errout) =>
      res(err ? '' : String(out || '') + String(errout || '')));
  });
}

async function listVideoDevices() {
  // v4l2-ctl agrupa: "Nombre (bus):\n\t/dev/videoN". Nos quedamos el primer
  // /dev/videoN de cada cámara (los demás suelen ser metadata, no captura).
  const out = await run('v4l2-ctl', ['--list-devices']);
  const devs = [];
  if (out) {
    let label = '';
    for (const raw of out.split('\n')) {
      if (!raw.trim()) { label = ''; continue; }
      if (!raw.startsWith('\t') && !raw.startsWith(' ')) { label = raw.replace(/:\s*$/, '').trim(); continue; }
      const dev = raw.trim();
      if (/^\/dev\/video\d+$/.test(dev) && !devs.some(d => d.label === label)) devs.push({ device: dev, label });
    }
  }
  if (!devs.length) {
    let files = [];
    try { files = fs.readdirSync('/dev').filter(f => /^video\d+$/.test(f)); } catch (_) {}
    for (const f of files) devs.push({ device: '/dev/' + f, label: f });
  }
  return devs;
}

async function listAudioDevices() {
  // arecord -l → "card N: id [name], device M: ... ". Construimos hw:N,M.
  const out = await run('arecord', ['-l']);
  const devs = [];
  const re = /card (\d+):\s*(\S+)\s*\[([^\]]*)\][^]*?device (\d+):\s*([^\[\n]*)/g;
  let m;
  while ((m = re.exec(out))) {
    const [, card, , cardName, dev, devName] = m;
    devs.push({ device: `hw:${card},${dev}`, label: `${cardName.trim()} · ${devName.trim()}` });
  }
  return devs;
}

// ════════════════════════════════════════════════════════════════════════════
//  API
// ════════════════════════════════════════════════════════════════════════════
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handleAPI(req, res, pathname) {
  try {
    // ── Medios disponibles ──────────────────────────────────────────────────
    if (pathname === '/api/media' && req.method === 'GET') {
      return sendJSON(res, 200, { media: await listMedia() });
    }

    // ── Dispositivos de captura para LIVE (v4l2 + ALSA) ─────────────────────
    if (pathname === '/api/devices' && req.method === 'GET') {
      const [video, audio] = await Promise.all([listVideoDevices(), listAudioDevices()]);
      return sendJSON(res, 200, { video, audio });
    }

    // ── Escena (config del player) ──────────────────────────────────────────
    if (pathname === '/api/scene' && req.method === 'GET') {
      let scene = {};
      try { scene = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8')); } catch (_) {}
      return sendJSON(res, 200, scene);
    }
    if (pathname === '/api/scene' && req.method === 'POST') {
      const scene = await readBody(req);
      fs.writeFileSync(SCENE_FILE, JSON.stringify(scene, null, 2));
      return sendJSON(res, 200, { ok: true });
    }

    // ── Lanzar encode (VOD / LIVE) usando stream.sh ─────────────────────────
    if (pathname === '/api/encode' && req.method === 'POST') {
      const { mode } = await readBody(req);
      if (mode !== 'vod' && mode !== 'live') return sendJSON(res, 400, { error: 'mode debe ser vod|live' });
      let scene;
      try { scene = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8')); }
      catch (_) { return sendJSON(res, 400, { error: 'No hay scene.json guardada' }); }

      const enc = scene.encode || {};
      const common = {
        FORMAT: scene.bedFormat || 'fuma',
        CODEC: enc.codec || 'vp9',
        SEG: String(enc.seg || 2),
        VBITRATE: enc.vbitrate || '6000k',
        KEEP: '1',
      };
      if (enc.scale) common.SCALE = enc.scale;
      // Publicación a S3 (opcional): el live sube en background, el VOD al final.
      if (enc.s3Bucket) {
        common.S3_BUCKET = enc.s3Bucket;
        if (enc.s3Region) common.S3_REGION = enc.s3Region;
      }

      let env;
      // ── LIVE por captura (USB/UDP): usa scene.live, no archivos ────────────
      if (mode === 'live' && scene.live) {
        const L = scene.live, V = L.video || {}, A = L.audio || {}, foa = A.foa || {};
        if (V.src === 'usb' && !V.device) return sendJSON(res, 400, { error: 'Falta dispositivo de vídeo USB' });
        if (V.src === 'udp' && !V.url)    return sendJSON(res, 400, { error: 'Falta URL de vídeo UDP' });
        if (A.src === 'usb' && !A.device) return sendJSON(res, 400, { error: 'Falta dispositivo de audio USB' });
        if (A.src === 'udp' && !A.url)    return sendJSON(res, 400, { error: 'Falta URL de audio UDP' });

        env = {
          ...common,
          CAPTURE: '1',
          VIDEO_SRC: V.src || 'usb',
          VIDEO_DEVICE: V.device || '',
          VIDEO_INFORMAT: V.informat || '',
          VIDEO_SIZE: V.size || '',
          VIDEO_FR: String(V.fr || 30),
          VIDEO_URL: V.url || '',
          AUDIO_SRC: A.src || 'usb',
          AUDIO_DEVICE: A.device || '',
          AUDIO_CHANNELS: String(A.channels || 32),
          AUDIO_URL: A.url || '',
          AUDIO_DELAY: String(A.delay || 0),
          FOA_CH: (foa.ch && foa.ch.length === 4 ? foa.ch : [0, 1, 2, 3]).join(','),
          FOA_AFORMAT: foa.aformat ? '1' : '0',
          STEM_CH: (scene.stems || []).map(s => (s.channel != null ? s.channel : '')).join(','),
        };
      } else {
        // ── VOD (o live de bucle de archivos) desde archivos ────────────────
        if (!scene.video || !scene.bed) return sendJSON(res, 400, { error: 'Falta vídeo o bed en la escena' });
        env = {
          ...common,
          VIDEO: scene.video,
          AUDIO: scene.bed,
          STEMS: (scene.stems || []).map(s => s.file).join(';'),
          // Close-ups (Caso B): vídeo "de cerca" por músico → pistas extra en el
          // mismo manifest. Solo los stems que tienen uno, en orden (= Representation
          // 1..N en el MPD); el player reconstruye el mapa stem→pista igual.
          CLOSEUPS: (scene.stems || []).filter(s => s.closeup).map(s => s.closeup).join(';'),
        };
        if (enc.closeupScale)    env.CLOSEUP_SCALE = enc.closeupScale;
        if (enc.closeupVbitrate) env.CLOSEUP_VBITRATE = enc.closeupVbitrate;
      }

      try {
        startJob(mode, 'bash', ['stream.sh', mode], env);
        return sendJSON(res, 200, { ok: true, mode, cmd: job.cmd });
      } catch (e) { return sendJSON(res, 409, { error: e.message }); }
    }

    // ── Proxy ligero (transcode 8-bit) para tiempo real en live ─────────────
    if (pathname === '/api/proxy' && req.method === 'POST') {
      const { src, scale, out } = await readBody(req);
      if (!src) return sendJSON(res, 400, { error: 'Falta src' });
      const sc = scale || '1920:960';
      const base = path.basename(src).replace(/\.[^.]+$/, '');
      const outFile = out || ('media/' + base + '_proxy.mp4');
      const args = ['-y', '-i', src, '-an',
        '-vf', `scale=${sc}:flags=bicubic,format=yuv420p`,
        '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast',
        '-crf', '20', '-g', '48', '-keyint_min', '48', outFile];
      try {
        startJob('proxy', 'ffmpeg', args, {});
        return sendJSON(res, 200, { ok: true, out: outFile, cmd: job.cmd });
      } catch (e) { return sendJSON(res, 409, { error: e.message }); }
    }

    // ── Estado / parar ──────────────────────────────────────────────────────
    if (pathname === '/api/encode/status' && req.method === 'GET') {
      return sendJSON(res, 200, job ? {
        running: !!job.proc, mode: job.mode, speed: job.speed, frame: job.frame,
        exit: job.exit, startedAt: job.startedAt, log: job.log.slice(-40),
      } : { running: false, log: [] });
    }
    if (pathname === '/api/encode/stop' && req.method === 'POST') {
      return sendJSON(res, 200, { ok: stopJob() });
    }

    // ── Puente Insta360 → cámara virtual v4l2 (inicializar / parar / estado) ──
    if (pathname === '/api/bridge/start' && req.method === 'POST') {
      try { startBridge(); return sendJSON(res, 200, { ok: true }); }
      catch (e) { return sendJSON(res, 409, { error: e.message }); }
    }
    if (pathname === '/api/bridge/stop' && req.method === 'POST') {
      return sendJSON(res, 200, { ok: stopBridge() });
    }
    if (pathname === '/api/bridge/status' && req.method === 'GET') {
      return sendJSON(res, 200, bridge ? {
        running: !!bridge.proc, exit: bridge.exit, startedAt: bridge.startedAt, log: bridge.log.slice(-30),
      } : { running: false, log: [] });
    }

    // ── Monitor de sync A/V (stream fragmented-MP4 para MSE) ─────────────────
    if (pathname === '/api/monitor' && req.method === 'GET') {
      // El monitor usa los mismos dispositivos que el directo (vídeo v4l2 + audio
      // ALSA exclusivo): no pueden coexistir. Rechazamos con mensaje claro.
      if (job && job.proc) {
        return sendJSON(res, 409, { error: 'Hay un encode en marcha (' + job.mode + '). Párelo antes de usar el monitor (el audio ALSA es exclusivo).' });
      }
      const delay = new URL(req.url, 'http://localhost').searchParams.get('delay');
      let scene = {};
      try { scene = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8')); } catch (_) {}
      stopMonitor();   // cliente único: mata el monitor anterior (trackeado o huérfano)
      const margs = buildMonitorArgs(scene, delay);
      console.log('[monitor] ffmpeg ' + margs.join(' '));
      const proc = spawn('ffmpeg', margs, { cwd: ROOT, detached: true });
      monitor = { proc };
      try { fs.writeFileSync(MONITOR_PID, String(proc.pid)); } catch (_) {}
      let errBuf = '';
      proc.stderr.on('data', d => { errBuf = (errBuf + d).slice(-500); });
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-cache', 'Connection': 'close' });
      proc.stdout.pipe(res);
      const cleanup = () => {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) {}
        try { if (parseInt(fs.readFileSync(MONITOR_PID, 'utf8'), 10) === proc.pid) fs.unlinkSync(MONITOR_PID); } catch (_) {}
        if (monitor && monitor.proc === proc) monitor = null;
      };
      req.on('close', cleanup);     // refresco/cierre del navegador
      res.on('close', cleanup);     // refuerzo
      proc.on('error', e => { console.warn('monitor ffmpeg error:', e.message); cleanup(); try { res.end(); } catch (_) {} });
      proc.on('exit', code => { if (code) console.warn('monitor ffmpeg exit', code, errBuf.trim()); cleanup(); try { res.end(); } catch (_) {} });
      return;
    }
    if (pathname === '/api/monitor/stop' && req.method === 'POST') {
      stopMonitor();
      return sendJSON(res, 200, { ok: true });
    }

    // ── Monitor fiel con ffplay (ventana local en la máquina de producción) ──
    if (pathname === '/api/monitor/ffplay' && req.method === 'POST') {
      if (job && job.proc) return sendJSON(res, 409, { error: 'Hay un encode en marcha (' + job.mode + '). Párelo antes (audio ALSA exclusivo).' });
      if (!process.env.DISPLAY) return sendJSON(res, 409, { error: 'El servidor no tiene DISPLAY: arráncalo desde la sesión gráfica de la máquina de producción para abrir la ventana de ffplay.' });
      const body = await readBody(req);
      let scene = {}; try { scene = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8')); } catch (_) {}
      const A = (scene.live && scene.live.audio) || {}, V = (scene.live && scene.live.video) || {};
      // Canales = lo configurado en el editor. WCH = canal a monitorizar (W del
      // FOA en multicanal; 0 en prueba 1-2 ch), clamp si no cabe en el device.
      const fCh = Number(A.channels) || 32;
      let fWch = (A.foa && Array.isArray(A.foa.ch) && A.foa.ch.length ? A.foa.ch[0] : 0);
      if (fCh <= 2 || fWch >= fCh) fWch = 0;
      const fArgs = [String(body.delay || 0), A.device || 'hw:1,0', V.device || '/dev/video10'];
      console.log('[ffplay] CH=' + fCh + ' WCH=' + fWch + ' bash monitor_sync.sh ' + fArgs.join(' '));
      stopMonitor(); stopFfplayMon();   // libera vídeo+audio (compartidos)
      const proc = spawn('bash', [path.join(ROOT, 'monitor_sync.sh'), ...fArgs],
        { cwd: ROOT, detached: true, env: { ...process.env, CH: String(fCh), WCH: String(fWch) }, stdio: ['ignore', 'ignore', 'pipe'] });
      ffplayMon = { proc };
      let errBuf = '';
      proc.stderr.on('data', d => { errBuf = (errBuf + d).slice(-500); });
      proc.on('exit', code => { if (code) console.warn('ffplay monitor exit', code, errBuf.trim()); if (ffplayMon && ffplayMon.proc === proc) ffplayMon = null; });
      return sendJSON(res, 200, { ok: true });
    }
    if (pathname === '/api/monitor/ffplay/stop' && req.method === 'POST') {
      stopFfplayMon();
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: 'API no encontrada: ' + pathname });
  } catch (e) {
    return sendJSON(res, 500, { error: e.message });
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  Servidor estático (con Range para MSE) + API.
// ════════════════════════════════════════════════════════════════════════════
const handler = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let pathname;
  try { pathname = decodeURIComponent(req.url.split('?')[0]); }
  catch { pathname = req.url.split('?')[0]; }

  if (pathname.startsWith('/api/')) return handleAPI(req, res, pathname);

  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      console.warn('404', req.url, '→', filePath);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('File not found: ' + pathname);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    // Código del player/editor: no cachear, o el navegador sirve una versión
    // vieja tras editar (ya pasó: "sigue igual" = index.html cacheado). Los
    // segmentos de media (.m4s/.webm/.mp4) sí se pueden cachear con normalidad.
    const noCache = ['.html', '.js', '.mjs', '.css', '.json'].includes(ext);
    const total = stat.size;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return;
      }
      res.writeHead(206, {
        'Content-Type': contentType, 'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': total, 'Accept-Ranges': 'bytes',
        ...(noCache ? { 'Cache-Control': 'no-cache, no-store, must-revalidate' } : {}) });
      fs.createReadStream(filePath).pipe(res);
    }
  });
};

const KEY = process.env.TLS_KEY || path.join(ROOT, 'certs', 'key.pem');
const CRT = process.env.TLS_CERT || path.join(ROOT, 'certs', 'cert.pem');

let server, scheme;
if (fs.existsSync(KEY) && fs.existsSync(CRT)) {
  server = https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT) }, handler);
  scheme = 'https';
} else {
  server = http.createServer(handler);
  scheme = 'http';
}

killPidFile(MONITOR_PID);   // limpia un monitor huérfano de un arranque anterior

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${scheme}://0.0.0.0:${PORT}  (root: ${ROOT})`);
  console.log(`  player → ${scheme}://<host>:${PORT}/index.html`);
  console.log(`  editor → ${scheme}://<host>:${PORT}/editor.html`);
  if (scheme === 'http') {
    console.warn('⚠  Sin certificados → HTTP. WebXR (VR) NO funciona por IP sin HTTPS.');
    console.warn('   Genera un certificado autofirmado:  ./gen-cert.sh   y reinicia.');
  }
});
