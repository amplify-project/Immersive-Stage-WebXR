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
  // Libera la cámara/ALSA que puedan tener abiertos los monitores, el snapshot o
  // la medición: v4l2loopback es de un solo lector, así que si algo sigue leyendo
  // el device, stream.sh lo ve "ocupado". Los paramos antes de arrancar.
  stopMeasure(); stopSnapshot();
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
//  Medición de sync (measure_sync.sh) y snapshot de cámara: abren el device de
//  vídeo/ALSA. Los trackeamos para poder liberarlos antes de un encode.
//  NOTA: el audio ALSA es exclusivo → no correr a la vez que el live.
// ════════════════════════════════════════════════════════════════════════════
let measureProc = null;
function stopMeasure() {
  if (measureProc) { try { process.kill(-measureProc.pid, 'SIGKILL'); } catch (_) {} measureProc = null; }
}
let snapProc = null;
function stopSnapshot() {
  if (snapProc) { try { process.kill(-snapProc.pid, 'SIGKILL'); } catch (_) {} snapProc = null; }
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

    // ── Snapshot de la cámara (un frame JPEG) para elegir el ROI ────────────
    //  Solo vídeo (no toca ALSA). v4l2loopback no admite dos lectores, así que
    //  liberamos monitores antes; si hay un encode, el device está ocupado.
    if (pathname === '/api/snapshot' && req.method === 'GET') {
      if (job && job.proc) return sendJSON(res, 409, { error: 'Hay un encode en marcha (' + job.mode + '). Párelo antes (la cámara está en uso).' });
      let scene = {}; try { scene = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8')); } catch (_) {}
      const V = (scene.live && scene.live.video) || {};
      const dev = V.device || '/dev/video10';
      stopMeasure(); stopSnapshot();   // libera el device
      // Descarta los primeros frames (auto-exposición) y quédate con uno.
      // detached → grupo propio para poder matarlo; timeout de seguridad para que
      // no se quede colgado con la cámara abierta si el device no entrega frames.
      const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-f', 'v4l2', '-i', dev, '-vf', "select=gte(n\\,4)", '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', '-'],
        { cwd: ROOT, detached: true });
      snapProc = proc;
      const chunks = []; let errBuf = '', sent = false;
      const done = () => { clearTimeout(killT); if (snapProc === proc) snapProc = null; };
      const fail = msg => { if (sent) return; sent = true; sendJSON(res, 500, { error: msg }); };
      const killT = setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) {} }, 6000);
      proc.stdout.on('data', d => chunks.push(d));
      proc.stderr.on('data', d => { errBuf = (errBuf + d).slice(-300); });
      proc.on('error', e => { done(); fail('ffmpeg: ' + e.message); });
      proc.on('exit', code => {
        done();
        if (sent) return;
        const buf = Buffer.concat(chunks);
        if (code === 0 && buf.length) {
          sent = true;
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
          res.end(buf);
        } else {
          fail('No se pudo capturar de ' + dev + (errBuf.trim() ? ' · ' + errBuf.trim() : ''));
        }
      });
      return;
    }

    // ── Auto-medición del delay A/V (measure_sync.sh) ───────────────────────
    //  Captura ~8s, detecta la palmada (audio) y su golpe visual (vídeo) y
    //  devuelve el desfase en ms. No abre ventana → no necesita DISPLAY.
    //  Respuesta diferida: el server contesta cuando el script termina (~DUR s).
    //  body.roi opcional: "w:h:x:y" en fracciones 0..1 (recorte de detección).
    if (pathname === '/api/monitor/measure' && req.method === 'POST') {
      if (job && job.proc) return sendJSON(res, 409, { error: 'Hay un encode en marcha (' + job.mode + '). Párelo antes (audio ALSA exclusivo).' });
      const body = await readBody(req);
      let scene = {}; try { scene = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8')); } catch (_) {}
      const A = (scene.live && scene.live.audio) || {}, V = (scene.live && scene.live.video) || {};
      const fCh = Number(A.channels) || 32;
      let fWch = (A.foa && Array.isArray(A.foa.ch) && A.foa.ch.length ? A.foa.ch[0] : 0);
      if (fCh <= 2 || fWch >= fCh) fWch = 0;
      const dur = 8;
      // ROI de detección (fracciones). Validado: 4 números 0..1 separados por ':'.
      const roiRel = (typeof body.roi === 'string' && /^(0(\.\d+)?|1(\.0+)?)(:(0(\.\d+)?|1(\.0+)?)){3}$/.test(body.roi)) ? body.roi : '';
      const mArgs = [A.device || 'hw:1,0', V.device || '/dev/video10'];
      console.log('[measure] CH=' + fCh + ' WCH=' + fWch + ' DUR=' + dur + (roiRel ? ' ROI_REL=' + roiRel : '') + ' bash measure_sync.sh ' + mArgs.join(' '));
      stopSnapshot();   // libera vídeo+audio (compartidos)
      const proc = spawn('bash', [path.join(ROOT, 'measure_sync.sh'), ...mArgs],
        { cwd: ROOT, detached: true, env: { ...process.env, CH: String(fCh), WCH: String(fWch), DUR: String(dur), ...(roiRel ? { ROI_REL: roiRel } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
      measureProc = proc;
      let out = '', err = '', sent = false;
      const reply = (code, obj) => { if (sent) return; sent = true; sendJSON(res, code, obj); };
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err = (err + d).slice(-500); });
      proc.on('error', e => { if (measureProc === proc) measureProc = null; reply(500, { error: e.message }); });
      proc.on('exit', () => {
        if (measureProc === proc) measureProc = null;
        const m = out.match(/A\/V delay\s*=\s*(-?\d+)\s*ms/i);
        if (m) return reply(200, { ok: true, delay: parseInt(m[1], 10), out: out.trim().slice(-400) });
        // Sin match: adjuntamos la cola del log (trae 'TA=… TV=…' de qué faltó).
        reply(422, { error: 'No se pudo medir · ' + (out.trim().slice(-240) || err.trim() || 'sin salida') });
      });
      return;   // respuesta diferida al exit del proceso (~DUR s)
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

  // Cuántos cascos y consumidores hay enganchados ahora mismo. Es la forma más
  // rápida de comprobar desde el propio Quest que la telemetría está llegando.
  if (req.url === '/telemetry/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(relay ? relay.health() : { ok: false, reason: 'relay disabled' }));
  }

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

// ── Relay de telemetría, colgado de ESTE servidor ──────────────────────
// WebXR obliga a servir el player por HTTPS, y una página https:// no puede
// abrir un ws:// en claro (contenido mixto). Montando /ingest y /consume en
// este mismo servidor, el casco ve un único origen, puerto y certificado: el
// que ya aceptó al cargar el player. Con el relay en su propio puerto habría
// que aceptar el autofirmado por segunda vez, y el fallo es mudo (el socket
// muere sin error visible en la página).
//
// El relay sigue siendo autónomo (`node telemetry/relay.js`, o embebido por el
// simulador): aquí solo se engancha a un servidor que ya existe. En producción
// ese papel lo hace nginx, terminando TLS con un certificado real y enrutando
// las mismas dos rutas.
//
// `ws` es la ÚNICA dependencia npm del proyecto y vive en telemetry/. Si no se
// ha hecho `npm install` ahí, el player debe seguir funcionando sin telemetría,
// así que el require va protegido.
let relay = null;
if (!/^(0|off|false)$/i.test(process.env.RELAY || '')) {
  try {
    const { createRelay } = require('./telemetry/relay');
    relay = createRelay({ server, log: false });
  } catch (e) {
    const why = e.code === 'MODULE_NOT_FOUND' ? 'falta `cd telemetry && npm install`' : e.message;
    console.warn(`⚠  Telemetría desactivada (${why}). El player funciona igual.`);
  }
}

// El relay escucha siempre (cuesta nada, y Unity conecta a /consume antes de que
// entre ningún casco). `telemetry.enabled` de scene.json es cosa del PLAYER: si
// está a false nadie enviará poses, así que lo decimos aquí en vez de anunciar
// un endpoint que parece listo y nunca recibe nada.
function sceneTelemetryEnabled() {
  try { return !!JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8')).telemetry?.enabled; }
  catch (_) { return false; }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${scheme}://0.0.0.0:${PORT}  (root: ${ROOT})`);
  console.log(`  player → ${scheme}://<host>:${PORT}/index.html`);
  console.log(`  editor → ${scheme}://<host>:${PORT}/editor.html`);
  if (relay) {
    const note = sceneTelemetryEnabled()
      ? 'scene.json: enabled'
      : 'scene.json: enabled=false → ningún player enviará (usa ?telemetry=… para probar)';
    console.log(`  telemetry → ${relay.scheme}://<host>:${PORT}/ingest · consume=/consume · health=/telemetry/health`);
    console.log(`              ${note}`);
  }
  if (scheme === 'http') {
    console.warn('⚠  Sin certificados → HTTP. WebXR (VR) NO funciona por IP sin HTTPS.');
    console.warn('   Genera un certificado autofirmado:  ./gen-cert.sh   y reinicia.');
  }
});
