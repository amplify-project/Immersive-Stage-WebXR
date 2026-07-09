// tools/bedAnalysis.js
//
// Comprueba un bed ambisónico contra la escena, sin oído y sin abrir el player.
//
// Responde a dos preguntas que se han comido más tiempo que ninguna otra:
//
//   1) ¿El orden de canales declarado (fuma / ambix) es el real? En una toma
//      horizontal la Z es, con diferencia, el canal más flojo. Si el canal que
//      dices que es Z no lo es, el orden está mal. Además, si hay stems, la
//      elevación medida de un músico que toca de pie tiene que salir ≈ 0°.
//
//   2) ¿Cuánto estaba girado el micro respecto a la cámara? Para cada stem se
//      toman los frames en los que acapara la energía, se promedia el vector de
//      intensidad I = <W·X, W·Y, W·Z> y se compara el azimut resultante con el
//      que tiene ese músico en scene.json. El giro común es el yawOffsetDeg.
//
// Cuidado con las fuentes AMPLIFICADAS: un teclado por PA llega desde el
// altavoz, no desde el teclista. Los delata una elevación grande —el bafle no
// está a la altura del músico— y se marcan como no fiables: no entran en el
// ajuste, porque arrastrarían el giro de todos los demás.
//
// Solo Node + ffmpeg, como el resto del servidor.

const { spawn } = require('child_process');

const SR = 16000;                 // suficiente: la banda útil aquí es 300-1500 Hz
const FR = 2048, HOP = 1024;
const BAND = 'highpass=f=300,lowpass=f=1500';   // fuera bombo y siseo: menos sangrado

// Índice de cada componente según el orden declarado.
const LAYOUT = {
  fuma:  { W: 0, X: 1, Y: 2, Z: 3 },   // W,X,Y,Z
  ambix: { W: 0, Y: 1, Z: 2, X: 3 },   // ACN: W,Y,Z,X
};

/** Decodifica un canal a mono PCM float, opcionalmente filtrado en banda. */
function decode(file, ch, seconds, band) {
  return new Promise((resolve, reject) => {
    const filter = `[0:a]pan=mono|c0=c${ch}` + (band ? ',' + band : '');
    const args = ['-v', 'error', '-t', String(seconds), '-i', file,
      '-filter_complex', filter, '-ar', String(SR), '-f', 's16le', '-'];
    const p = spawn('ffmpeg', args);
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.stderr.on('data', () => {});
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg (${file} c${ch}) salió con ${code}`));
      const b = Buffer.concat(chunks);
      const n = b.length >> 1;
      const a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = b.readInt16LE(i * 2) / 32768;
      resolve(a);
    });
  });
}

/** Número de canales del primer stream de audio. */
function channels(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=channels', '-of', 'csv=p=0', file]);
    let out = '';
    p.stdout.on('data', c => out += c);
    p.on('error', reject);
    p.on('close', () => resolve(parseInt(out.trim(), 10) || 0));
  });
}

const rmsDb = (a) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return 20 * Math.log10(Math.sqrt(s / Math.max(1, a.length)) + 1e-12);
};

// Sin corrección de retardo, a propósito. Los stems ya vienen sincronizados con
// el bed (van en la misma línea de tiempo del stream), y lo único que los separa
// es la propagación del músico al micro: ~12 ms a 4 m, o sea 0.1 de un frame de
// 128 ms. Medirlo por correlación resultó ser peor que ignorarlo — la forma de
// onda engancha reflejos y la envolvente engancha el tempo de la canción — y
// fijarlo a cero deja los azimuts idénticos dentro de 2°.

const D2 = (r) => r * 180 / Math.PI;
const wrap = (a) => { while (a > 180) a -= 360; while (a <= -180) a += 360; return a; };

/** Media circular de ángulos en grados. */
function circMean(degs) {
  let x = 0, y = 0;
  for (const d of degs) { x += Math.cos(d * Math.PI / 180); y += Math.sin(d * Math.PI / 180); }
  return D2(Math.atan2(y, x));
}

/**
 * @param {object} opt
 * @param {string} opt.bed          ruta al wav del bed (4 canales)
 * @param {string} opt.bedFormat    'fuma' | 'ambix'
 * @param {Array<{file:string,name:string,azimuthDeg:number}>} opt.stems
 * @param {number} [opt.seconds=120]  cuánto material analizar
 * @param {(f:string)=>string} [opt.resolve]  mapea rutas de escena a rutas de disco
 */
async function analyze({ bed, bedFormat = 'fuma', stems = [], seconds = 120, resolve = (f) => f }) {
  const L = LAYOUT[bedFormat];
  if (!L) throw new Error(`bedFormat desconocido: ${bedFormat}`);

  // ── 1. Niveles por canal: la Z debe ser la más floja de una toma horizontal ──
  const bedPath = resolve(bed);

  // El análisis lee los canales 0..3 como W,X,Y,Z. Con más canales estaría
  // midiendo cualquier cosa y devolvería un yawOffsetDeg con toda la seguridad
  // del mundo. Mejor no dar número que dar uno inventado.
  const nch = await channels(bedPath);
  if (nch !== 4)
    throw new Error(`El lecho tiene ${nch} canales; se esperan 4 (B-format FOA). ` +
                    `Extrae los cuatro buenos con ./make-bed.sh -l "${bed}"`);

  const full = await Promise.all([0, 1, 2, 3].map(c => decode(bedPath, c, seconds, null)));
  const levels = full.map(rmsDb);
  const quietest = levels.indexOf(Math.min(...levels));

  // No basta con que la Z sea la más floja: tiene que serlo por mucho. En una
  // toma horizontal la Z anda 6-10 dB por debajo del resto. Cuatro canales con
  // la misma energía no son un B-format —da igual en qué orden estén—, y ese es
  // el aspecto que tiene un fichero que ha pasado por un editor de vídeo.
  const others = levels.filter((_, i) => i !== L.Z);
  const marginDb = Math.min(...others) - levels[L.Z];
  const spreadDb = Math.max(...levels) - Math.min(...levels);
  const zCheck = {
    declaredZChannel: L.Z,
    quietestChannel: quietest,
    marginDb: +marginDb.toFixed(1),
    spreadDb: +spreadDb.toFixed(1),
    flat: spreadDb < 3,                        // ni Z ni nada: no es ambisónico
    ok: quietest === L.Z && marginDb >= 4 && spreadDb >= 3,
    levelsDb: levels.map(v => +v.toFixed(1)),
  };

  // Sin componente vertical no hay campo ambisónico que analizar, y el ajuste
  // del giro devolvería un número con toda la confianza del mundo. Parar aquí.
  if (zCheck.flat)
    return { bedFormat, secondsAnalyzed: seconds, zCheck, stems: [], alignment: null };

  // ── 2. Dirección de llegada de cada stem ────────────────────────────────────
  const bp = await Promise.all([0, 1, 2, 3].map(c => decode(bedPath, c, seconds, BAND)));
  const W = bp[L.W], X = bp[L.X], Y = bp[L.Y], Z = bp[L.Z];

  const sig = [];
  for (const s of stems) {
    try { sig.push({ s, a: await decode(resolve(s.file), 0, seconds, BAND) }); }
    catch (_) { /* stem ilegible: fuera */ }
  }
  if (!sig.length) return { bedFormat, zCheck, stems: [], alignment: null };

  const len = Math.min(W.length, ...sig.map(x => x.a.length)) - 2000;
  const nF = Math.max(0, Math.floor((len - FR) / HOP));

  // energía por frame de cada stem
  for (const x of sig) {
    const e = new Float64Array(nF);
    for (let f = 0; f < nF; f++) {
      let sum = 0;
      for (let i = 0; i < FR; i++) { const k = f * HOP + i; if (k < x.a.length) sum += x.a[k] * x.a[k]; }
      e[f] = sum;
    }
    x.eng = e;
  }

  const results = [];
  for (const x of sig) {
    const idx = [];
    for (let f = 0; f < nF; f++) {
      const tot = sig.reduce((acc, o) => acc + o.eng[f], 0);
      if (tot > 1e-9 && x.eng[f] / tot > 0.6) idx.push(f);   // domina la mezcla
    }
    let az = null, el = null;
    if (idx.length >= 40) {
      let ix = 0, iy = 0, iz = 0;
      for (const f of idx) for (let i = 0; i < FR; i++) {
        const k = f * HOP + i, w = W[k];
        ix += w * X[k]; iy += w * Y[k]; iz += w * Z[k];
      }
      az = D2(Math.atan2(iy, ix));
      el = D2(Math.atan2(iz, Math.hypot(ix, iy)));
    }
    results.push({
      name: x.s.name, sceneAzimuthDeg: x.s.azimuthDeg,
      frames: idx.length,
      micAzimuthDeg: az == null ? null : +az.toFixed(0),
      elevationDeg: el == null ? null : +el.toFixed(0),
    });
  }

  // ── 3. Fiabilidad y ajuste del giro global ──────────────────────────────────
  // Un músico de pie da elevación ≈ 0. Una elevación grande delata una fuente
  // AMPLIFICADA: su dirección de llegada apunta al altavoz de PA, no al músico,
  // y arrastraría el ajuste. (Así se detectó el teclado en la toma de ejemplo.)
  for (const r of results) {
    const reasons = [];
    if (r.micAzimuthDeg == null) reasons.push('sin frames en solitario');
    else if (Math.abs(r.elevationDeg) > 25) reasons.push(`elevación ${r.elevationDeg}° (¿amplificado?)`);
    r.reliable = reasons.length === 0;
    r.excludedBecause = reasons.length ? reasons.join('; ') : null;
  }

  const good = results.filter(r => r.reliable && typeof r.sceneAzimuthDeg === 'number');
  const micAz = (r, mirror) => (mirror ? -r.micAzimuthDeg : r.micAzimuthDeg);
  const fit = (set, mirror) => {
    const rot = circMean(set.map(r => wrap(r.sceneAzimuthDeg - micAz(r, mirror))));
    const err = set.reduce((a, r) => a + Math.abs(wrap(micAz(r, mirror) + rot - r.sceneAzimuthDeg)), 0) / set.length;
    return { rot, err };
  };

  let alignment = null;
  if (good.length >= 2) {
    const plain = fit(good, false), mirrored = fit(good, true);
    const useMirror = mirrored.err < plain.err;
    let best = useMirror ? mirrored : plain;
    let used = good;

    // Reajuste robusto: un músico cuyo azimut de escena está mal escrito arrastra
    // el giro de todos. Si sobresale y quedan al menos tres, se aparta y se
    // reajusta. Su residuo se informa: dice que ESE azimut hay que revisarlo.
    const outliers = good.filter(r => Math.abs(wrap(micAz(r, useMirror) + best.rot - r.sceneAzimuthDeg)) > 30);
    if (outliers.length && good.length - outliers.length >= 3) {
      used = good.filter(r => !outliers.includes(r));
      best = fit(used, useMirror);
    }

    for (const r of results)
      r.residualDeg = (r.micAzimuthDeg == null || typeof r.sceneAzimuthDeg !== 'number') ? null
        : Math.round(Math.abs(wrap(micAz(r, useMirror) + best.rot - r.sceneAzimuthDeg)));

    alignment = {
      yawOffsetDeg: Math.round(best.rot),
      mirror: useMirror,
      meanResidualDeg: +best.err.toFixed(1),
      mirrorResidualDeg: +(useMirror ? plain.err : mirrored.err).toFixed(1),
      usedStems: used.map(r => r.name),
      // El giro se mide CONTRA los azimuts de la escena. Un residuo grande no
      // significa que el giro esté mal, sino que la escena no describe la toma:
      // un músico mal colocado, o un stem atribuido a quien no es.
      suspectStems: outliers.map(r => r.name),
      confident: best.err < 20 && used.length >= 3,
    };
  }

  return { bedFormat, secondsAnalyzed: seconds, zCheck, stems: results, alignment };
}

module.exports = { analyze, LAYOUT };
