const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 60000;
const ROOT = __dirname;
const MEDIA_DIR = path.join(ROOT, 'media');
const MESH_DIR = path.join(ROOT, 'meshes');
const SCENE_FILE = path.join(ROOT, 'scene.json');
const RECORDINGS_DIR = path.join(ROOT, 'recordings');

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
  // ffmpeg rewrites its progress line ("frame= … speed=") with \r several times a
  // second. Keep only the latest one in a row, so a long live run does not push
  // the start-up output (the command, the errors) out of the buffer.
  const progress = /^\s*(frame|size)=/.test(line);
  if (progress && job.lastWasProgress) job.log[job.log.length - 1] = line;
  else job.log.push(line);
  job.lastWasProgress = progress;
  if (job.log.length > 5000) job.log.shift();
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
  job = { proc, mode, log: [], speed: '', frame: 0, startedAt: Date.now(), exit: null, cmd: [cmd, ...args].join(' '),
          env: Object.entries(env || {}).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(' ') };
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

// Cuántas entradas devuelve /api/browse por carpeta. Un directorio con miles de
// ficheros no se navega en un desplegable, y mandarlo entero solo sirve para
// hacer esperar al navegador.
const BROWSE_MAX = 500;

// Destino libre dentro de media/ para un fichero llamado `base`.
//
// Si ya hay uno con ese nombre y el MISMO tamaño damos por hecho que es el mismo
// fichero y se reutiliza: la alternativa es duplicar medios de gigabytes cada vez
// que alguien vuelve a elegir el mismo vídeo. Si el tamaño no cuadra es OTRO
// fichero que se llama igual, y entonces se numera — machacar un medio que ya
// está en una escena sería estropear el trabajo de alguien sin preguntar.
function destInMedia(base, size) {
  const ext  = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${stem}-${n}${ext}`;
    const full = path.join(MEDIA_DIR, name);
    let st; try { st = fs.statSync(full); } catch (_) { return { full, name, exists: false }; }
    if (st.isFile() && st.size === size) return { full, name, exists: true };
  }
  throw new Error(`demasiados ficheros llamados ${base} en media/`);
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

    // ── Explorador de ficheros DE LA MÁQUINA DEL SERVER ─────────────────────
    //  Mismo principio que /api/devices: el editor puede estar en otro equipo,
    //  pero lo que se va a encodear tiene que estar donde está ffmpeg. Un
    //  <input type="file"> elige en la máquina del NAVEGADOR, así que para dejar
    //  un vídeo en la carpeta de al lado habría que subirlo entero por HTTP;
    //  aquí solo viaja la ruta y la copia la hace quien tiene el fichero al lado.
    //
    //  Esto enseña el árbol de directorios a quien alcance el editor. Es el mismo
    //  trato que ya hay con /api/encode (que lanza ffmpeg) y /api/devices: este
    //  backend asume una red de confianza y no debe exponerse a internet.
    if (pathname === '/api/browse' && req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams.get('dir');
      const dir = q ? path.resolve(q) : os.homedir();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { return sendJSON(res, 400, { error: `No se puede leer ${dir}: ${e.code || e.message}` }); }

      const dirs = [], files = [];
      for (const d of entries) {
        if (d.name.startsWith('.')) continue;
        const full = path.join(dir, d.name);
        // Por stat y no por dirent: un enlace simbólico dice "symlink", no si
        // lleva a una carpeta o a un vídeo. Lo que no se pueda mirar (roto, sin
        // permiso) simplemente no aparece, que es mejor que romper el listado.
        let st; try { st = fs.statSync(full); } catch (_) { continue; }
        if (st.isDirectory()) { dirs.push({ name: d.name, path: full }); continue; }
        if (!st.isFile()) continue;
        const ext = path.extname(d.name).toLowerCase();
        const kind = VIDEO_EXT.includes(ext) ? 'video' : AUDIO_EXT.includes(ext) ? 'audio' : null;
        if (!kind) continue;              // solo medios: lo demás no se puede encodear
        files.push({ name: d.name, path: full, kind, size: st.size });
      }
      const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
      dirs.sort(cmp); files.sort(cmp);

      const parent = path.dirname(dir);
      return sendJSON(res, 200, {
        path: dir,
        parent: parent === dir ? null : parent,   // en la raíz no hay "subir"
        home: os.homedir(),
        mediaDir: MEDIA_DIR,
        dirs: dirs.slice(0, BROWSE_MAX),
        files: files.slice(0, BROWSE_MAX),
        truncated: dirs.length > BROWSE_MAX || files.length > BROWSE_MAX,
      });
    }

    // ── Traerse un medio a media/ ───────────────────────────────────────────
    //  Se elige de cualquier sitio, pero solo se escribe aquí: es la carpeta que
    //  lee listMedia() y la única ruta que las escenas saben nombrar.
    if (pathname === '/api/media/import' && req.method === 'POST') {
      const { src } = await readBody(req);
      if (!src) return sendJSON(res, 400, { error: 'Falta src' });
      const from = path.resolve(src);

      let st; try { st = fs.statSync(from); }
      catch (_) { return sendJSON(res, 404, { error: `No existe: ${from}` }); }
      if (!st.isFile()) return sendJSON(res, 400, { error: 'No es un fichero' });

      const ext = path.extname(from).toLowerCase();
      if (!VIDEO_EXT.includes(ext) && !AUDIO_EXT.includes(ext))
        return sendJSON(res, 400, { error: `Extensión no admitida: ${ext || '(sin extensión)'}` });

      // Ya está dentro: no se copia nada. Pasa en cuanto alguien navega hasta la
      // propia media/ desde el explorador, que es lo más natural del mundo.
      if (from.startsWith(MEDIA_DIR + path.sep)) {
        const name = path.basename(from);
        return sendJSON(res, 200, { ok: true, file: 'media/' + name, name, size: st.size, copied: false });
      }

      // El nombre sale del origen, pero limpio: sin separadores (no queremos que
      // el nombre invente subcarpetas) y sin puntos delante (listMedia() los
      // salta, así que el fichero se copiaría para no aparecer luego en la lista).
      const base = path.basename(from).replace(/[/\\]/g, '_').replace(/^\.+/, '') || ('media' + ext);
      try {
        const dest = destInMedia(base, st.size);
        if (!dest.exists) {
          fs.mkdirSync(MEDIA_DIR, { recursive: true });
          // COPYFILE_FICLONE: en Btrfs/XFS esto es un reflink —instantáneo y sin
          // ocupar el doble— y en el resto degrada a una copia normal.
          await fs.promises.copyFile(from, dest.full, fs.constants.COPYFILE_FICLONE);
        }
        console.log(`[media] ${dest.exists ? 'ya estaba' : 'copiado'}: ${from} → media/${dest.name}` +
                    ` (${(st.size / 1e6).toFixed(1)} MB)`);
        return sendJSON(res, 200, { ok: true, file: 'media/' + dest.name, name: dest.name,
                                    size: st.size, copied: !dest.exists });
      } catch (e) {
        return sendJSON(res, 500, { error: `No se pudo copiar: ${e.message}` });
      }
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
      console.log('\n[arlog] ── anchor log ' + '─'.repeat(46));
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
          // '-' = no live channel: stream.sh outputs silence there. Never '', or bash drops
          // the trailing empties and the stem count no longer matches scene.stems.
          STEM_CH: (scene.stems || []).map(s => (Number.isInteger(s.channel) ? s.channel : '-')).join(','),
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
    // Whole log of the last job as plain text, for the editor's "Full log" tab:
    // the exact command and its env first, so it can be rerun by hand.
    if (pathname === '/api/encode/log' && req.method === 'GET') {
      const head = job ? [
        `# ${job.mode} · started ${new Date(job.startedAt).toISOString()} · ` +
          (job.proc ? 'running' : `exit ${job.exit}`),
        `# ${job.env ? job.env + ' ' : ''}${job.cmd}`, '',
      ] : ['# no encode has run since the server started'];
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(head.concat(job ? job.log : []).join('\n') + '\n');
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

  // Y si alguien está grabando voz ahora mismo, y dónde van los ficheros.
  if (req.url === '/voice/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(voice ? voice.health() : { ok: false, reason: 'voice disabled' }));
  }

  let pathname;
  try { pathname = decodeURIComponent(req.url.split('?')[0]); }
  catch { pathname = req.url.split('?')[0]; }

  if (pathname.startsWith('/api/')) return handleAPI(req, res, pathname);

  // Redirect en vez de servir index.html calladamente en '/'. Para todo lo demás
  // las dos URLs son la misma página; para los "shared spaces" de WebXR NO: el
  // espacio se expone por página, así que un casco en '/' y otro en '/index.html'
  // acaban en espacios distintos, cada uno con su uuid, sin que nada falle por
  // ningún otro sitio. Costó una tarde. Mandando a todo el mundo a la misma URL
  // deja de poder ocurrir.
  if (pathname === '/') {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.writeHead(302, { Location: '/index.html' + qs });
    res.end();
    return;
  }

  const filePath = path.join(ROOT, path.normalize(pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

  // Las grabaciones de voz viven bajo ROOT, así que sin esto el servidor de
  // estáticos las serviría a cualquiera de la red con sólo acertar el nombre —y
  // el nombre es la fecha y el id del player, que no es adivinar mucho—. Se
  // escriben por el WebSocket y se leen desde la máquina, no por HTTP.
  if (filePath === RECORDINGS_DIR || filePath.startsWith(RECORDINGS_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Las grabaciones de voz no se sirven por HTTP');
  }

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

// ── Servicio de timing (reproducción sincronizada), en ESTE servidor ────
// Mismo argumento que el relay, y uno más: el reloj compartido es de la sesión,
// no de un proceso aparte que alguien tenga que acordarse de levantar. Ver
// telemetry/timing.js y docs/motion-sync.md.
let timing = null;
if (relay && !/^(0|off|false)$/i.test(process.env.TIMING || '')) {
  try {
    const { createTimingService } = require('./telemetry/timing');
    timing = createTimingService({ server, log: false });
  } catch (e) {
    console.warn(`⚠  Timing desactivado (${e.message}). El player funciona igual, sin sincronía.`);
  }
}

// ── Grabación de voz de los participantes, en ESTE servidor ────────────
// Lo que dice quien lleva el casco es la observación que la telemetría de pose
// no sabe hacer. Mismo argumento que los otros dos para montarlo aquí: una sola
// origen, un solo certificado. Ver telemetry/voice.js y docs/voice-recording.md.
// El player no manda nada si no se lo piden (?voice=1 o scene.json), así que
// esto abierto no graba a nadie por su cuenta.
let voice = null;
if (!/^(0|off|false)$/i.test(process.env.VOICE || '')) {
  try {
    const { createVoiceService } = require('./telemetry/voice');
    voice = createVoiceService({ server, dir: RECORDINGS_DIR, log: false });
  } catch (e) {
    const why = e.code === 'MODULE_NOT_FOUND' ? 'falta `cd telemetry && npm install`' : e.message;
    console.warn(`⚠  Grabación de voz desactivada (${why}). El player funciona igual.`);
  }
}

// Ni el relay ni el timing cierran un upgrade que no sea suyo: cada uno se
// desentiende y el siguiente oyente lo mira. Aquí se acaban los oyentes, así que
// lo que no haya reclamado nadie se cierra ahora — sin esto el socket se queda
// abierto para siempre.
const WS_PATHS = ['/ingest', '/consume', ...(timing ? [timing.path] : []), ...(voice ? [voice.path] : [])];
server.on('upgrade', (req, socket) => {
  if (!WS_PATHS.includes((req.url || '').split('?')[0])) socket.destroy();
});

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
  if (timing) {
    console.log(`  sync      → ${scheme === 'https' ? 'wss' : 'ws'}://<host>:${PORT}${timing.path}`);
    console.log(`              manager=${scheme}://<host>:${PORT}/timing.html · player=?sync=<sesión>`);
  }
  if (voice) {
    console.log(`  voz       → ${scheme === 'https' ? 'wss' : 'ws'}://<host>:${PORT}${voice.path} · health=/voice/health`);
    console.log(`              player=?voice=1 · graba en ${path.relative(ROOT, voice.dir)}/`);
  }
  if (scheme === 'http') {
    console.warn('⚠  Sin certificados → HTTP. WebXR (VR) NO funciona por IP sin HTTPS.');
    console.warn('   Genera un certificado autofirmado:  ./gen-cert.sh   y reinicia.');
  }
});
