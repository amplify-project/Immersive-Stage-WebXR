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
      if (!scene.video || !scene.bed) return sendJSON(res, 400, { error: 'Falta vídeo o bed en la escena' });

      const env = {
        VIDEO: scene.video,
        AUDIO: scene.bed,
        FORMAT: scene.bedFormat || 'fuma',
        CODEC: (scene.encode && scene.encode.codec) || 'vp9',
        SEG: String((scene.encode && scene.encode.seg) || 2),
        VBITRATE: (scene.encode && scene.encode.vbitrate) || '6000k',
        STEMS: (scene.stems || []).map(s => s.file).join(';'),
        KEEP: '1',
      };
      if (scene.encode && scene.encode.scale) env.SCALE = scene.encode.scale;

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
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on ${scheme}://0.0.0.0:${PORT}  (root: ${ROOT})`);
  console.log(`  player → ${scheme}://<host>:${PORT}/index.html`);
  console.log(`  editor → ${scheme}://<host>:${PORT}/editor.html`);
  if (scheme === 'http') {
    console.warn('⚠  Sin certificados → HTTP. WebXR (VR) NO funciona por IP sin HTTPS.');
    console.warn('   Genera un certificado autofirmado:  ./gen-cert.sh   y reinicia.');
  }
});
