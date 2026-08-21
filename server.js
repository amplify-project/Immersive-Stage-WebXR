const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 60000;
const ROOT = __dirname;
const MEDIA_DIR = path.join(ROOT, 'media');
const MESH_DIR = path.join(ROOT, 'meshes');
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
  // Mallas de los músicos (scene.json → stems[i].mesh). Con octet-stream también
  // cargarían —GLTFLoader lee el cuerpo como ArrayBuffer y no mira la cabecera—,
  // pero un tipo correcto es lo que hace que se cacheen y se depuren como es debido.
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin':  'application/octet-stream',
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

// ════════════════════════════════════════════════════════════════════════════
//  Mallas de los músicos (scene.json → stems[i].mesh). Viven en meshes/, no en
//  media/: no son material de la toma, son la representación del músico, y el
//  editor las lista por separado porque se eligen en otro sitio y otro momento.
// ════════════════════════════════════════════════════════════════════════════
const MESH_EXT = ['.glb'];
const MESH_MAX_BYTES = 64 * 1024 * 1024;

function listMeshes() {
  let files = [];
  try { files = fs.readdirSync(MESH_DIR); } catch (_) { /* aún no existe */ }
  return files
    .filter(f => !f.startsWith('.') && MESH_EXT.includes(path.extname(f).toLowerCase()))
    .map(f => {
      let st; try { st = fs.statSync(path.join(MESH_DIR, f)); } catch (_) { return null; }
      return st.isFile() ? { file: 'meshes/' + f, name: f, size: st.size } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Nombre de fichero seguro a partir de lo que mande el navegador. Se queda con el
// basename y tira todo lo que no sea alfanumérico: el nombre viaja en la URL y
// acaba en una ruta del disco, así que un "../../algo" no puede llegar a fs.
function safeMeshName(raw) {
  const base = path.basename(String(raw || '')).replace(/[^\w.-]+/g, '_');
  const ext = path.extname(base).toLowerCase();
  if (!MESH_EXT.includes(ext)) return null;
  const stem = base.slice(0, -ext.length).replace(/^[.]+/, '') || 'mesh';
  return stem.slice(0, 80) + ext;
}

// Cuerpo binario a fichero. No usa readBody() a propósito: aquél acumula texto y
// corta a 5 MB, que es lo correcto para una escena JSON y absurdo para un GLB.
function saveMeshUpload(req, dest, maxBytes) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(MESH_DIR, { recursive: true });
    const tmp = dest + '.part';                  // el editor lista este directorio:
    const out = fs.createWriteStream(tmp);       // un fichero a medias no debe aparecer
    let size = 0, failed = false;
    // Un WriteStream que falla emite 'error', y sin oyente eso NO es una promesa
    // rechazada: es un throw que se lleva por delante el proceso entero. El
    // servidor del player se caería —para todos— por una subida de más.
    out.on('error', () => { /* ya se está abortando; el fichero se borra abajo */ });
    const abort = (err, statusCode) => {
      if (failed) return; failed = true;
      err.statusCode = statusCode;
      out.destroy(); fs.unlink(tmp, () => {});
      // Sin req.destroy(): la petición se sigue drenando hasta 'end' para que la
      // respuesta de error llegue de verdad al editor. Matar el socket aquí deja
      // al navegador con una conexión caída y sin motivo que enseñar.
      reject(err);
    };
    req.on('data', c => {
      if (failed) return;                        // el stream ya no existe: escribir aquí era el crash
      size += c.length;
      if (size > maxBytes) return abort(new Error(`la malla pasa de ${Math.round(maxBytes / 1048576)} MB`), 413);
      out.write(c);
    });
    req.on('error', e => abort(e, 400));
    req.on('end', () => {
      if (failed) return;
      out.end(() => {
        // glTF binario empieza por el magic "glTF". Comprobarlo aquí evita que un
        // .zip renombrado se quede en el disco y falle luego dentro de las gafas,
        // que es el peor sitio para enterarse.
        let head = Buffer.alloc(4);
        try { const fd = fs.openSync(tmp, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd); } catch (_) {}
        if (head.toString('latin1') !== 'glTF') {
          fs.unlink(tmp, () => {});
          const e = new Error('no es un .glb (falta la cabecera glTF)');
          e.statusCode = 415;
          return reject(e);
        }
        fs.renameSync(tmp, dest);
        resolve(size);
      });
    });
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
// LC_ALL/LANG=C: `arecord -l` está traducido, y en una máquina en italiano o en
// español imprime "scheda"/"tarjeta" en vez de "card". El parser de más abajo no
// casa nada y la lista de dispositivos ALSA sale vacía sin ningún error — mientras
// el vídeo sigue funcionando, porque v4l2-ctl no está localizado. Fijamos el locale
// solo para los comandos que enumeramos.
function run(cmd, args) {
  return new Promise(res => {
    execFile(cmd, args, { timeout: 5000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (err, out, errout) => res(err ? '' : String(out || '') + String(errout || '')));
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

    // ── Mallas de los músicos ───────────────────────────────────────────────
    if (pathname === '/api/meshes' && req.method === 'GET') {
      return sendJSON(res, 200, { meshes: listMeshes() });
    }
    // Subida cruda: el nombre va en la query y el GLB en el cuerpo. Sin multipart
    // a propósito — es UN fichero, y parsearlo a mano (o traerse una dependencia)
    // para envolverlo sería trabajo de más para el mismo resultado.
    if (pathname === '/api/mesh' && req.method === 'POST') {
      const name = safeMeshName(new URL(req.url, 'http://x').searchParams.get('name'));
      if (!name) return sendJSON(res, 400, { error: 'Nombre no válido: se admite .glb' });
      try {
        const size = await saveMeshUpload(req, path.join(MESH_DIR, name), MESH_MAX_BYTES);
        console.log(`[mesh] ${name} (${(size / 1e6).toFixed(1)} MB)`);
        return sendJSON(res, 200, { ok: true, file: 'meshes/' + name, name, size });
      } catch (e) {
        return sendJSON(res, e.statusCode || 400, { error: e.message });
      }
    }

    // ── Registro del ancla de AR ────────────────────────────────────────────
    // El player lo manda al salir de AR. Dentro del casco el error se lee en un
    // cartel de 32 columnas que dura 4 s, y la consola del navegador del Quest
    // solo se alcanza por chrome://inspect: sacarlo por aquí lo pone en el
    // terminal del PC, que es donde se está mirando de todas formas.
    if (pathname === '/api/arlog' && req.method === 'POST') {
      const { log } = await readBody(req);
      console.log('\n[arlog] ── registro del ancla ' + '─'.repeat(40));
      console.log(String(log || '').split('\n').map(l => '[arlog] ' + l).join('\n'));
      console.log('[arlog] ' + '─'.repeat(58) + '\n');
      return sendJSON(res, 200, { ok: true });
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
          // Un close-up que apunta al PROPIO vídeo 360 no es un close-up: hace
          // que ffmpeg abra y decodifique otra vez el equirect entero por cada
          // stem (1000% de CPU con tres, y NVENC casi parado). Se descarta.
          CLOSEUPS: (scene.stems || [])
            .filter(s => s.closeup && s.closeup !== scene.video)
            .map(s => s.closeup).join(';'),
        };
        const bogus = (scene.stems || []).filter(s => s.closeup && s.closeup === scene.video);
        if (bogus.length)
          console.warn(`⚠  Ignorados ${bogus.length} close-up(s) que apuntaban al vídeo 360 ` +
                       `(${bogus.map(s => s.name).join(', ')}). Un close-up es un recorte aparte.`);
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

    // ── Análisis del bed ambisónico ─────────────────────────────────────────
    // Comprueba el orden de canales declarado y mide cuánto estaba girado el
    // micro respecto a la cámara. Ver tools/bedAnalysis.js.
    if (pathname === '/api/bed/analyze' && req.method === 'POST') {
      const body = await readBody(req);
      let scene = {};
      try { scene = JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8')); } catch (_) {}
      const bed = body.bed || scene.bed;
      const bedFormat = body.bedFormat || scene.bedFormat || 'fuma';
      const stems = body.stems || scene.stems || [];
      if (!bed) return sendJSON(res, 400, { error: 'No hay bed en la escena' });

      // Las rutas vienen del cliente: confinadas a media/, sin salirse con '..'
      const safe = (rel) => {
        const p = path.resolve(ROOT, rel);
        if (!p.startsWith(MEDIA_DIR + path.sep)) throw new Error(`Ruta fuera de media/: ${rel}`);
        return p;
      };
      try {
        const { analyze } = require('./tools/bedAnalysis');
        const out = await analyze({
          bed, bedFormat, stems,
          seconds: Math.min(600, Math.max(20, +body.seconds || 120)),
          resolve: safe,
        });
        return sendJSON(res, 200, out);
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }

    // ── Construcción del bed a partir de las 4 componentes sueltas ──────────
    // Quien graba con una NT-SF1 (o exporta desde un DAW) acaba con W, X, Y, Z
    // en cuatro WAV mono. El trabajo real —y el único sitio donde el orden de
    // canales se decide— vive en make-bed.sh; aquí solo se le pasan las rutas,
    // ya confinadas a media/. Se devuelve el comando exacto para poder repetirlo
    // a mano, como hace el monitor de sync.
    if (pathname === '/api/bed/build' && req.method === 'POST') {
      const body = await readBody(req);
      const fmt = body.bedFormat === 'ambix' ? 'ambix' : 'fuma';
      // Se valida en absoluto y se pasa en relativo: el script corre con cwd=ROOT
      // y su mensaje final dicta el valor de scene.json → "bed", que es relativo.
      // Con rutas absolutas ese consejo saldría inservible.
      const safe = (rel, what) => {
        if (!rel) throw new Error(`Falta la componente ${what}`);
        const p = path.resolve(ROOT, rel);
        if (!p.startsWith(MEDIA_DIR + path.sep)) throw new Error(`Ruta fuera de media/: ${rel}`);
        return path.relative(ROOT, p);
      };
      let args;
      try {
        args = ['-m', safe(body.w, 'W'), safe(body.x, 'X'), safe(body.y, 'Y'), safe(body.z, 'Z'),
                safe(body.out, 'de salida'), fmt];
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }

      const script = path.join(ROOT, 'make-bed.sh');
      const cmd = './make-bed.sh ' + args.map(a => (/^[\w./-]+$/.test(a) ? a : `'${a}'`)).join(' ');
      // Un bed de media hora son cientos de MB: holgura, pero no infinito.
      execFile('bash', [script, ...args], { cwd: ROOT, timeout: 600000, maxBuffer: 1 << 20 },
        (err, out, errout) => {
          const text = String(out || '') + String(errout || '');
          // make-bed.sh explica por qué se niega (no es mono, ya existe, otro
          // sample rate...). Ese texto es mejor error que cualquiera que invente.
          if (err) return sendJSON(res, 400, { error: text.trim() || err.message, cmd });
          return sendJSON(res, 200, { ok: true, out: body.out, bedFormat: fmt, cmd, log: text.trim() });
        });
      return;
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
    // .glb entra aquí con el código, y no con los segmentos: una malla se sustituye
    // mientras se ajusta la escena, siempre con el mismo nombre, y un modelo viejo
    // servido de caché se depura dentro de las gafas creyendo que es el nuevo.
    const noCache = ['.html', '.js', '.mjs', '.css', '.json', '.glb', '.gltf'].includes(ext);
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
