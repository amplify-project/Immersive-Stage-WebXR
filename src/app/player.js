import { ImmersiveAudioEngine } from '../audio/ImmersiveAudioEngine.js';
import { Telemetry } from '../telemetry/Telemetry.js';

// ──────────────────────────────────────────────────────────────────────────
//  El motor de audio inmersivo (clases HOAST*, matriz de zoom) vive ahora en
//  ./src/audio/ como módulos ESM reutilizables. Este archivo es solo la demo:
//  Three.js + Shaka + HUD + WebXR consumiendo ImmersiveAudioEngine.
// ──────────────────────────────────────────────────────────────────────────


// ══════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════
let renderer, scene, camera, sphere, videoTexture;
let videoEl   = document.getElementById('hidden-video');
let audioEl   = document.getElementById('hidden-audio');
let closeupEl = document.getElementById('hidden-closeup');
let shakaVideo = null;
let curManifestSrc = null;           // fuente en curso (recarga al entrar/salir de AR)
let shakaAudio = null;
let shakaCloseup = null;             // 3ª instancia Shaka: pista de close-up
let shakaCfg   = null;               // config compartida (la fija loadDualShaka)
// Close-ups (Caso B): plano flotante con el vídeo del músico enfocado.
let closeupTexture = null, closeupMesh = null;
let closeupReady = false;            // hay pistas de close-up en el manifest
let closeupStem  = -1;               // stem mostrado ahora (-1 = ninguno)
let closeupRepByStem = {};           // índice de stem → RepresentationID del MPD
let engine     = null;               // ImmersiveAudioEngine (motor de audio)
let audioCtx   = null, gainNode = null;  // referencias derivadas del engine
let xrSession  = null;
let arSession  = null;               // sesión WebXR immersive-ar (passthrough)
let arSources  = [];                 // Object3D por stem, anclados en la sala
let roomGroup  = null;               // marco de sala: padre de las fuentes ancladas
let arCalibrating = false;           // grip apretado: se está recolocando la sala
let arPrevSpot = null;               // spotlight previo (restaurar al salir de AR)
let arPrevBed  = null;               // nivel de bed previo (idem)
let arCfg      = {};                 // bloque `ar` de scene.json
// Cuánto se deja el bed en passthrough. 0.35 ≈ −9 dB: se sigue oyendo el
// concierto de fondo, pero los músicos anclados mandan. scene.json → ar.bedGain.
const AR_BED_GAIN = 0.35;
let stemDefs   = [];                 // definición de stems en uso (az/el/name)
let isDragging = false, prevMouse = {x:0, y:0};
let yaw = 0, pitch = 0;
let useGyro = false;
let deviceOrientation = {alpha:0, beta:90, gamma:0};
let ambiAnalyser = null, ambiTimeDomain = null;
let syncInterval = null;
let xrZoomDist = 0;   // acercamiento en VR (joystick derecho), 0 = sin zoom
let telemetry    = null;             // Telemetry: pose de cabeza → relay externo (opt-in)
let telemetryCfg = null;             // bloque telemetry de scene.json
// Diagnóstico: ?audiotest=spin → el campo sonoro gira solo (ignora la cabeza).
const AUDIO_SPIN_TEST = new URLSearchParams(location.search).get('audiotest') === 'spin';

// ══════════════════════════════════════════════════════
// THREE.JS SETUP
// ══════════════════════════════════════════════════════
function initThree() {
  const canvas = document.getElementById('three-canvas');
  // alpha:true → buffer con canal alfa para que el passthrough AR se vea por
  // detrás de la escena (en VR/escritorio la esfera 360 lo tapa todo igual).
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 1000);
  camera.position.set(0, 0, 0);  // exactamente en el origen

  // Esfera grande centrada en el origen
  // scale(-1,1,1) invierte las normales para ver desde dentro
  const geo = new THREE.SphereGeometry(100, 60, 40);
  geo.scale(-1, 1, 1);
  // Alinear la imagen con el mundo. El mapeo UV de SphereGeometry (con el
  // scale(-1,1,1)) deja el CENTRO del equirectangular (u=0.5) en -X, y en -Z
  // —el frente: adonde mira la cámara con yaw=0, y adonde apunta un stem con
  // azimuthDeg=0— cae u=0.75. Es decir, el frente del vídeo quedaba 90° a la
  // izquierda del frente del audio: los músicos se oían donde no se veían.
  // Girando -90° el centro de la imagen pasa a -Z y los tres convenios (editor,
  // vídeo, audio) coinciden. Se hornea en la geometría porque en XR el bucle de
  // render reposiciona la malla cada frame y podría pisar sphere.rotation.
  geo.rotateY(-Math.PI / 2);
  sphere = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x111111 }));
  sphere.position.set(0, 0, 0);  // centrada en el origen
  scene.add(sphere);

  // Marco de sala: de él cuelgan las fuentes ancladas en AR. Su transformada ES
  // la calibración (ver applyARCalib), así que moverlo mueve a la vez los
  // marcadores y sus panners, que siguen la matrixWorld.
  roomGroup = new THREE.Group();
  scene.add(roomGroup);

  // Close-up (Caso B): plano 16:9 ~2.5 m delante de la cámara. Como es hijo de
  // la cámara, queda siempre centrado en la vista (escritorio y XR). Oculto
  // hasta que se enfoca a un músico que tenga close-up.
  closeupMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2.0, 1.125),
    new THREE.MeshBasicMaterial({ transparent: true, depthTest: false }));
  closeupMesh.position.set(0, 0, -2.5);
  closeupMesh.renderOrder = 999;       // por encima de la esfera 360
  closeupMesh.visible = false;
  camera.add(closeupMesh);
  scene.add(camera);                   // necesario para que los hijos se rendericen

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  setupPointerControls();
  setupGyro();
  checkWebXR();
  initDebugPanel();
  renderLoop();
}

// ══════════════════════════════════════════════════════
// RENDER LOOP
// ══════════════════════════════════════════════════════
function renderLoop() {
  if (!renderer.xr.isPresenting) {
    requestAnimationFrame(renderLoop);
    applyRotation();
  }
  if (videoEl && videoEl.readyState >= 2) {
    if (videoTexture) videoTexture.needsUpdate = true;
    updateProgress();
  }
  if (closeupReady && closeupMesh.visible && closeupTexture) closeupTexture.needsUpdate = true;
  updateAmbiViz();
  updateSpotLog();
  renderer.render(scene, camera);
}

// ── HUD del spotlight (?spotlog=1) ─────────────────────────────────────────
// Un stem que no sube al hacer zoom puede fallar en tres sitios: el zoom no
// llega al motor (factor congelado), la mirada no lo enfoca (peso 0) o la
// cadena de audio no obedece (peso alto, ganancia plana). Aquí se ven los tres.
const SPOTLOG = new URLSearchParams(location.search).get('spotlog') === '1';

// ?arperf=1 — reparto del tiempo de CADA frame de AR, para saber si un bache es
// nuestro o del sistema. El bucle mide cuatro tramos y cada 2 s resume el peor.
//
// Cómo se lee: si `total` se dispara mientras los tramos siguen en décimas de
// milisegundo, el tiempo NO se va en este JavaScript — se va en el compositor de
// passthrough o en el hilo de audio (seis panners HRTF interpolando HRIRs
// mientras te desplazas), y no hay nada que optimizar aquí. Si el que sube es un
// tramo concreto, ese es el culpable y tiene arreglo.
const ARPERF = new URLSearchParams(location.search).get('arperf') === '1';
const _perf = { n: 0, t0: 0, worst: 0, sum: 0, audio: 0, focus: 0, render: 0, worstAt: '', vf0: -1 };

// Fotogramas de vídeo que el navegador lleva DECODIFICADOS. En AR la esfera está
// oculta y nadie dibuja esa textura, pero el <video> sigue reproduciendo porque
// de él sale el audio: si esta cuenta avanza, se está decodificando 360 para no
// enseñarlo a nadie, y ahí hay trabajo que quitar. Si no avanza, el navegador ya
// se lo ha ahorrado y hay que buscar el bache en otro sitio.
function decodedFrames() {
  const q = videoEl && videoEl.getVideoPlaybackQuality && videoEl.getVideoPlaybackQuality();
  return q ? q.totalVideoFrames : -1;
}

// El informe se lee DENTRO de las gafas o no se lee: en sesión inmersiva no hay
// consola, y la pantalla plana de la página no la está mirando nadie. Un sprite
// colgado delante de la cara es el único sitio donde el dato llega a tiempo.
let arPerfPanel = null;
const AR_PERF_PANEL_W = 640, AR_PERF_PANEL_H = 200;   // px de canvas (~4:1.25)

function arPerfPanelDraw(lines) {
  if (!arPerfPanel) {
    const c = document.createElement('canvas');
    c.width = AR_PERF_PANEL_W; c.height = AR_PERF_PANEL_H;
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    arPerfPanel = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    // Un sprite siempre mira a la cámara, así que basta con colocarlo: 40 cm de
    // alto a 1.2 m se lee sin esfuerzo y no tapa a los músicos.
    arPerfPanel.scale.set(0.4 * (AR_PERF_PANEL_W / AR_PERF_PANEL_H), 0.4, 1);
    arPerfPanel.renderOrder = 999;
    arPerfPanel.userData.canvas = c;
    scene.add(arPerfPanel);
  }
  const c = arPerfPanel.userData.canvas, cx = c.getContext('2d');
  cx.clearRect(0, 0, c.width, c.height);
  cx.fillStyle = 'rgba(0,0,0,0.72)';
  cx.fillRect(0, 0, c.width, c.height);
  cx.font = 'bold 30px monospace';
  cx.textBaseline = 'top';
  lines.forEach((l, i) => {
    // La línea del vídeo es la que decide la hipótesis: en verde para que no se
    // pierda entre las demás.
    cx.fillStyle = i === lines.length - 1 ? '#5dff8f' : '#00d4ff';
    cx.fillText(l, 20, 20 + i * 44);
  });
  arPerfPanel.material.map.needsUpdate = true;
}

// Delante de la cara, un poco por debajo del eje de la mirada. Se recoloca cada
// frame para que andar no lo deje atrás.
const _panelFwd = new THREE.Vector3();
const _panelQ   = new THREE.Quaternion();
function arPerfPanelPlace(pose) {
  if (!arPerfPanel) return;
  const p = pose.transform.position, q = pose.transform.orientation;
  _panelFwd.set(0, 0, -1).applyQuaternion(_panelQ.set(q.x, q.y, q.z, q.w));
  arPerfPanel.position.set(p.x + _panelFwd.x * 1.2,
                           p.y + _panelFwd.y * 1.2 - 0.25,
                           p.z + _panelFwd.z * 1.2);
}

function arPerfPanelClear() {
  if (!arPerfPanel) return;
  scene.remove(arPerfPanel);
  arPerfPanel.material.map.dispose();
  arPerfPanel.material.dispose();
  arPerfPanel = null;
}

function arPerfReport(now) {
  // La ventana arranca en el primer frame; sin esto, t0=0 contra un
  // performance.now() de varios segundos suelta un informe de 1 frame al entrar.
  if (!_perf.t0) { _perf.t0 = now; _perf.vf0 = decodedFrames(); return; }
  if (_perf.n && now - _perf.t0 >= 2000) {
    const avg = (_perf.sum / _perf.n).toFixed(2);
    // Fotogramas decodificados por segundo en esta ventana. ~24-30 = el vídeo se
    // está decodificando entero; 0 = el navegador ya no lo decodifica.
    const vf = decodedFrames();
    const vfps = (vf >= 0 && _perf.vf0 >= 0) ? ((vf - _perf.vf0) / ((now - _perf.t0) / 1000)).toFixed(1) : '?';
    console.log(`[arperf] ${_perf.n} frames · medio ${avg} ms · peor ${_perf.worst.toFixed(1)} ms (${_perf.worstAt})` +
      ` · audio ${(_perf.audio / _perf.n).toFixed(2)} · foco ${(_perf.focus / _perf.n).toFixed(2)}` +
      ` · render ${(_perf.render / _perf.n).toFixed(2)} · vídeo decodificado ${vfps} fps`);
    arPerfPanelDraw([
      `${_perf.n} frames · medio ${avg} ms`,
      `peor ${_perf.worst.toFixed(1)} ms (${_perf.worstAt})`,
      `audio ${(_perf.audio / _perf.n).toFixed(2)} · render ${(_perf.render / _perf.n).toFixed(2)}`,
      `vídeo decodificado ${vfps} fps`,
    ]);
    // Cada ventana se guarda además para el volcado de la página al salir, que
    // sobrevive a quitarse las gafas.
    window.__arperf = window.__arperf || [];
    window.__arperf.push({ frames: _perf.n, avgMs: +avg, worstMs: +_perf.worst.toFixed(1),
                           worstAt: _perf.worstAt, videoFps: +vfps });
    _perf.n = _perf.sum = _perf.worst = _perf.audio = _perf.focus = _perf.render = 0;
    _perf.t0 = now; _perf.vf0 = vf;
  }
}

// Volcado en la propia página al salir de AR. El toast dura 3 s y se lo come el
// tiempo de quitarse las gafas; esto se queda hasta que se recarga.
function arPerfDump() {
  const w = window.__arperf;
  if (!w || !w.length) return;
  let el = document.getElementById('arperf-dump');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'arperf-dump';
    el.style.cssText = 'position:fixed;right:8px;top:8px;z-index:9999;margin:0;max-height:80vh;' +
      'overflow:auto;padding:10px 12px;background:rgba(0,0,0,.82);color:#0f0;border-radius:6px;' +
      'font:12px/1.4 monospace';
    el.addEventListener('click', () => el.remove());   // molesta poco, se quita de un toque
    document.body.appendChild(el);
  }
  const peor = w.reduce((a, b) => (b.worstMs > a.worstMs ? b : a));
  const vid  = w.reduce((a, b) => a + b.videoFps, 0) / w.length;
  el.textContent =
    `[arperf] ${w.length} ventanas de 2 s   (toca aquí para cerrar)\n` +
    `peor frame  ${peor.worstMs} ms  (${peor.worstAt})\n` +
    `vídeo decodificado, media  ${vid.toFixed(1)} fps` +
    `   → ${vid > 5 ? 'SÍ se decodifica el 360 para nadie' : 'el navegador ya no lo decodifica'}\n\n` +
    w.map((x, i) => `${String(i * 2).padStart(3)}s  ${String(x.frames).padStart(4)} fr` +
      `  medio ${String(x.avgMs).padStart(6)}  peor ${String(x.worstMs).padStart(6)}` +
      `  vídeo ${String(x.videoFps).padStart(5)} fps  (${x.worstAt})`).join('\n');
}
let spotLogEl = null, spotLogNext = 0;
function updateSpotLog() {
  if (!SPOTLOG || !engine || !engine.getSpotlightState) return;
  const now = performance.now();
  if (now < spotLogNext) return;
  spotLogNext = now + 100;                 // 10 Hz: legible y sin coste
  if (!spotLogEl) {
    spotLogEl = document.createElement('pre');
    spotLogEl.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;margin:0;' +
      'padding:8px 10px;background:rgba(0,0,0,.72);color:#0f0;border-radius:6px;' +
      'font:12px/1.35 monospace;pointer-events:none';
    document.body.appendChild(spotLogEl);
    // Retícula en el centro exacto de la vista. `mirada az/el` es la dirección
    // que pasa por aquí, así que centrar un músico sobre la cruz y copiar esos
    // dos números a su entrada de scene.json lo coloca donde se le ve. A ojo el
    // centro se yerra en varios grados, que es lo que se está midiendo.
    const cross = document.createElement('div');
    cross.style.cssText = 'position:fixed;left:50%;top:50%;z-index:9999;' +
      'width:21px;height:21px;margin:-11px 0 0 -11px;pointer-events:none;' +
      'background:linear-gradient(#0f0,#0f0) center/1px 100% no-repeat,' +
      'linear-gradient(#0f0,#0f0) center/100% 1px no-repeat;opacity:.85';
    document.body.appendChild(cross);
  }
  const s = engine.getSpotlightState();
  const sgn = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0).padStart(3);
  // duck × nivel: es lo que se oye. En AR el duck está a 1 y el nivel bajo.
  const bed = (s.bedGain == null ? 1 : s.bedGain) * (s.bedLevel == null ? 1 : s.bedLevel);
  spotLogEl.textContent =
    `zoom ${(s.zN * 100).toFixed(0)}%   mirada  az ${s.gazeAzimuthDeg.toFixed(0)}°  ` +
    `el ${s.gazeElevationDeg.toFixed(0)}°   bed ${bed.toFixed(2)}\n` +
    `             te falta        peso  ganancia\n` +
    s.stems.map(t => `${t.name.padEnd(8)} az ${sgn(-t.dAzDeg)}° el ${sgn(-t.dElDeg)}°  ` +
                     `${t.weight.toFixed(2)}  ${(t.gain == null ? 0 : t.gain).toFixed(2)}`).join('\n');
}

function getZoomFactor() {
  const minFOV = 30;  // fully zoomed
  const maxFOV = 100; // fully wide

  const minScale = 1;
  const maxScale = 2.5;

  const scale = maxScale - (camera.fov - minFOV) * (maxScale - minScale) / (maxFOV - minFOV);

  return scale;
}

function applyRotation() {
  if (useGyro) {
    const a = THREE.MathUtils.degToRad(deviceOrientation.alpha || 0);
    const b = THREE.MathUtils.degToRad(deviceOrientation.beta  || 90);
    const g = THREE.MathUtils.degToRad(deviceOrientation.gamma || 0);
    camera.quaternion.setFromEuler(new THREE.Euler(b - Math.PI/2, a, -g, 'YXZ'));
  } else {
    const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), yaw);
    const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), pitch);
    camera.quaternion.copy(qY).multiply(qX);
  }

  // El motor lee la orientación de la cámara para rotar el campo sonoro.
  // matrixWorld se actualiza en renderer.render(); aquí la refrescamos antes
  // de leerla para evitar el desfase de un frame.
  if (engine) {
    camera.updateMatrixWorld();
    engine.setRotationFromMatrix4(camera.matrixWorld.elements);
    engine.setZoomByFactor(getZoomFactor());
    updateCloseupFocus();   // muestra el close-up del músico que miras al hacer zoom
  }
}

// ══════════════════════════════════════════════════════
// LOADING
// ══════════════════════════════════════════════════════
function loadFromURL() {
  const src = document.getElementById('video-url-input').value.trim();
  if (!src) return;
  startManifest(src);
}

function loadFile(input) {
  const file = input.files[0];
  if (!file) return;
  startManifest(URL.createObjectURL(file));
}

async function startManifest(src) {
  showSpinner(true);
  hideLoader();
  curManifestSrc = src;         // lo necesita la recarga sin vídeo al entrar en AR

  // Limpiar players anteriores
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  if (shakaVideo) { try { await shakaVideo.destroy(); } catch(e){} shakaVideo = null; }
  if (shakaAudio) { try { await shakaAudio.destroy(); } catch(e){} shakaAudio = null; }
  if (shakaCloseup) { try { await shakaCloseup.destroy(); } catch(e){} shakaCloseup = null; }
  closeupReady = false; closeupStem = -1; closeupRepByStem = {};
  if (closeupMesh) closeupMesh.visible = false;

  videoEl.pause();
  audioEl.pause();
  closeupEl.pause();
  videoEl.muted = true;

  if (src.endsWith('.mpd')) {
    await loadDualShaka(src);
  } else {
    // Fichero local sin ambisonics
    videoEl.src = src;
    videoEl.muted = false;
    videoEl.loop = true;
    videoEl.addEventListener('canplay', () => {
      showSpinner(false);
      attachVideoTexture();
      videoEl.play();
      updatePlayBtn();
    }, { once: true });
    videoEl.addEventListener('error', () => {
      showSpinner(false);
      toast('Error cargando fichero');
    });
    videoEl.load();
  }
}

// ══════════════════════════════════════════════════════
// DUAL SHAKA — mismo manifest
// Shaka 1 → <video> muted → Three.js
// Shaka 2 → <audio>       → Web Audio FOA
// ══════════════════════════════════════════════════════
async function loadDualShaka(src) {
  const shakaConfig = {
    streaming: {
      // Con segmentos de 2s, 1.5s no llegaba ni a un segmento → rebuffer
      // constante. Buffer holgado (~3 segmentos) para evitar cortes en directo.
      bufferingGoal: 6,
      rebufferingGoal: 2,
      bufferBehind: 10,
      segmentPrefetchLimit: 2,
      updateIntervalSeconds: 0.1,
      lowLatencyMode: true,
      inaccurateManifestTolerance: 0,
      stallEnabled: true,
      stallThreshold: 1,
      stallSkip: 0.1,
      retryParameters: {
        maxAttempts: 5,
        baseDelay: 50,
        backoffFactor: 1.2,
        fuzzFactor: 0.1,
      },
    },
    abr: { enabled: false, defaultBandwidthEstimate: 5000000 },
    manifest: {
      retryParameters: { maxAttempts: 10, baseDelay: 50, backoffFactor: 1.1 },
      dash: {
        autoCorrectDrift: true,
        ignoreSuggestedPresentationDelay: true,
      },
    },
  };
  shakaCfg = shakaConfig;   // reutilizada por la instancia de close-up (Caso B)

  try {
    // ── Shaka 1: vídeo (muted) → Three.js ──────────
    shakaVideo = new shaka.Player(videoEl);
    shakaVideo.configure(shakaConfig);
    await shakaVideo.load(src);

    // Tope de resolución de vídeo (diagnóstico de saturación de decodificado): con
    // ABR off, elegimos a mano la variante de mayor altura ≤ maxh. Si la imagen se
    // retrasa del audio por drops (decoder 4K no llega / throttling térmico),
    // ?maxh=1440 ó ?maxh=1080 lo confirma en vivo. Sin efecto si solo hay 4K.
    const _maxh = parseInt(new URLSearchParams(location.search).get('maxh') || '0', 10);
    if (_maxh > 0) {
      const _vt = shakaVideo.getVariantTracks()
        .filter(t => (t.height || 0) <= _maxh)
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      if (_vt.length) { shakaVideo.selectVariantTrack(_vt[0], /*clearBuffer*/ true); toast('vídeo ≤ ' + _maxh + 'p (' + (_vt[0].height || '?') + 'p)'); }
      else toast('no hay variante ≤ ' + _maxh + 'p (manifest de una sola resolución)');
    }

    showSpinner(false);
    attachVideoTexture();
    updatePlayBtn();

    // ── Punto de operación en directo (s por detrás del borde) ───────────────
    //  Lo dicta el propio manifest: el CDN (S3) anuncia un suggestedPresentation
    //  Delay grande (~9s) porque sus segmentos frescos tardan en propagar por el
    //  CDN; el directo de baja latencia anuncia poco. Lo honramos para NO
    //  perseguir el borde hacia segmentos que aún dan 404 (rebuffer → el delay
    //  crecía sin control sobre S3). Override manual para tuning:  ?livedelay=9
    let liveTargetDelay = 5;
    try {
      const _mpd = await (await fetch(src, { cache: 'no-store' })).text();
      const _m = _mpd.match(/suggestedPresentationDelay="PT([0-9.]+)S"/i);
      if (_m) liveTargetDelay = Math.max(2, parseFloat(_m[1]));
    } catch (_) { /* sin manifest legible → fallback 5 s */ }
    {
      const _q = parseFloat(new URLSearchParams(location.search).get('livedelay'));
      if (_q > 0) liveTargetDelay = _q;
    }
    // ≥7s de colchón ⇒ modo CDN: banda muerta amplia, sin acelerar hacia el borde.
    const CDN_LIVE = liveTargetDelay >= 7;
    const T_LIVE = CDN_LIVE ? liveTargetDelay : 5;   // el directo mantiene su 5 s

    const isLive = !isFinite(videoEl.duration);
    if (isLive) {
      document.getElementById('live-badge').style.display = 'inline';
      document.getElementById('delay-badge').style.display = 'inline';
      // Arrancar T_LIVE s por detrás del borde (no pegado): en CDN esos segmentos
      // ya han propagado; en directo son los ~5 s de siempre.
      videoEl.currentTime = Math.max(shakaVideo.seekRange().start,
                                     shakaVideo.seekRange().end - T_LIVE);
      toast(`Live edge: ${CDN_LIVE ? 'CDN' : 'directo'} · ${T_LIVE.toFixed(0)} s`);
    }
    videoEl.play();

    // ── UN SOLO Shaka ───────────────────────────────────────────────────────
    //  El <video> ya trae vídeo + audio Opus multicanal (el MPD tiene ambos
    //  adaptation sets), así que NO abrimos un 2º Shaka sobre <audio>: un decoder,
    //  un reloj → A/V sincronizados POR CONSTRUCCIÓN (como mpv), sin bucle de
    //  corrección. El audio multicanal se toma del PROPIO <video> en setupFOA con
    //  createMediaElementSource. La deriva entre los dos Shaka era el bug de fondo.
    audioEl = videoEl;   // todas las refs a audioEl operan ya sobre el <video>

    // ── Sincronía continua A/V (controlador de deriva, objetivo = cero saltos) ──
    //  El audio se pega al vídeo SOLO variando playbackRate (proporcional al
    //  desfase, con EMA y bandas de cap: cerca de 0 inaudible, mayor recupera sin
    //  saltar). Seek solo como ÚLTIMO recurso (>1.5s, tras stall/seek real). El
    //  vídeo manda la velocidad base (watchdog live-edge). Ajustable en consola:
    //  avSync.capSmall = 0.02, etc.
    const SYNC = window.avSync = {
      dead: 0.02,      // banda muerta (s): por debajo no se corrige
      kp: 0.8,         // ganancia proporcional
      capSmall: 0.03,  // cap con desfase pequeño (≤ bigErr) → inaudible
      capBig: 0.10,    // cap con desfase moderado (recupera sin saltar)
      bigErr: 0.3,     // umbral (s) entre banda pequeña y grande
      hardSeek: 1.5,   // (s) por encima → seek (último recurso)
      ema: 0.3,        // suavizado del error (0..1)
    };
    let _avErr = 0;
    // DERIVA real reloj-vídeo vs reloj-AudioContext, integrada SOLO en tramos de
    // reproducción limpia. Ojo: ctx.currentTime (reloj hardware) NO se para en un
    // stall/pausa, pero video.currentTime sí → si comparásemos totales, un stall
    // metería un salto falso (−duración del stall). Por eso, cada tick: si el vídeo
    // avanza con normalidad sumamos (dv − dc·rate) a _avDriftMs (deriva verdadera);
    // si está atascado (dv≈0 con dc>0) lo contamos como _stallMs, no como deriva.
    let _avDriftMs = 0, _stallMs = 0, _lastC = null, _lastV = null;
    // Stalls: cada 'waiting' el <video> se quedó sin datos (típico al rozar el
    // borde live). En cada stall el navegador puede descartar frames al recuperar
    // → la imagen se adelanta al audio a saltos. Los contamos para verlo.
    let _stalls = 0;
    videoEl.addEventListener('waiting', () => { _stalls++; });
    syncInterval = setInterval(() => {
      if (!audioEl || !videoEl) return;
      const base = videoEl.playbackRate;

      // — Integración de deriva A/V (excluye stalls/seek) —
      const _octx = (window.engine && window.engine.audioContext) || null;
      if (_octx && _octx.state === 'running') {
        const nowC = _octx.currentTime, nowV = videoEl.currentTime;
        if (_lastC != null) {
          const dc = nowC - _lastC, dv = nowV - _lastV;
          const clean = !videoEl.paused && !videoEl.seeking && videoEl.readyState >= 3;
          if (clean && dc > 0 && dv > 0.2 * dc * base) _avDriftMs += (dv - dc * base) * 1000;
          else if (dc > 0 && dv < 0.2 * dc) _stallMs += dc * 1000;   // parado/atascado
        }
        _lastC = nowC; _lastV = nowV;
      }
      const raw  = audioEl.currentTime - videoEl.currentTime;    // + = audio adelantado
      if (Math.abs(raw) > SYNC.hardSeek) {
        audioEl.currentTime = videoEl.currentTime;               // desfase enorme → seek
        audioEl.playbackRate = base; _avErr = 0;
        console.log('[sync] seek (desfase', raw.toFixed(2) + 's)');
      } else {
        _avErr = _avErr * (1 - SYNC.ema) + raw * SYNC.ema;
        const err = _avErr, a = Math.abs(err);
        if (a > SYNC.dead) {
          const cap = a > SYNC.bigErr ? SYNC.capBig : SYNC.capSmall;
          audioEl.playbackRate = base * (1 + Math.max(-cap, Math.min(cap, -err * SYNC.kp)));
        } else if (audioEl.playbackRate !== base) {
          audioEl.playbackRate = base;
        }
      }
      if (videoEl.paused && !audioEl.paused) audioEl.pause();
      if (!videoEl.paused && audioEl.paused) audioEl.play().catch(()=>{});

      // Close-up: misma timeline → mismo currentTime/playbackRate que el 360.
      if (closeupReady && closeupStem >= 0) {
        if (Math.abs(closeupEl.currentTime - videoEl.currentTime) > 0.5)
          closeupEl.currentTime = videoEl.currentTime;
        closeupEl.playbackRate = base;
        if (videoEl.paused && !closeupEl.paused) closeupEl.pause();
        if (!videoEl.paused && closeupEl.paused) closeupEl.play().catch(()=>{});
      }
    }, 250);

    // ── FOA decode via Web Audio ────────────────────
    await setupFOA();

    // ── Close-ups (Caso B): pistas de vídeo extra del mismo manifest ─────────
    await setupCloseups(src);

    // ── Watchdog live edge ──────────────────────────
    setInterval(() => {
      if (videoEl.paused || videoEl.seeking || videoEl.buffered.length === 0) return;
      const range = shakaVideo.seekRange();
      const delay = range.end - videoEl.currentTime;

      const badge = document.getElementById('delay-badge');
      badge.textContent = '⏱ ' + delay.toFixed(1) + 's';
      // Verde cerca del punto de operación (T_LIVE); rojo si nos quedamos atrás.
      const _over = delay - T_LIVE;
      badge.style.color       = _over > 6 ? '#ff4444' : _over > 3 ? '#ffd400' : '#34d399';
      badge.style.borderColor = badge.style.color + '40';
      badge.style.background  = badge.style.color.replace(')', ',0.08)').replace('rgb','rgba');

      if (!isFinite(videoEl.duration)) {
        if (CDN_LIVE) {
          // CDN (S3): operar ~T_LIVE s por detrás del borde y NO perseguirlo (sus
          // segmentos frescos aún no propagaron → 404/rebuffer). Banda muerta
          // amplia; acelerar muy suave solo si nos quedamos atrás, y resync duro
          // como último recurso.
          if (delay > T_LIVE + 8) {
            videoEl.currentTime = range.end - T_LIVE;   // muy atrás → resync
            videoEl.playbackRate = 1.0;
          } else if (delay > T_LIVE + 4) {
            videoEl.playbackRate = Math.min(1.05, 1 + (delay - (T_LIVE + 4)) * 0.02);
          } else if (delay < T_LIVE - 3) {
            videoEl.playbackRate = 0.97;   // demasiado cerca del borde → frenar
          } else {
            videoEl.playbackRate = 1.0;
          }
        } else {
          // Directo baja latencia (sin cambios): banda 4-9 s pegado al borde.
          if (delay > 14) {
            videoEl.currentTime = range.end - 6;   // resync solo si nos quedamos muy atrás
            videoEl.playbackRate = 1.0;
          } else if (delay > 9) {
            videoEl.playbackRate = Math.min(1.10, 1 + (delay - 9) * 0.03);
          } else if (delay < 4) {
            videoEl.playbackRate = 0.97;
          } else {
            videoEl.playbackRate = 1.0;
          }
        }
      }
    }, 500);

    // ── Diagnóstico de desfase A/V (opt-in: ?avlog=1  ·  o window.avDiag()) ───
    //  Localiza de dónde viene el desfase audio↔vídeo:
    //   · outputLatency del AudioContext = latencia que AÑADE Web Audio al
    //     enrutar el audio del <video> por Omnitone → audio RETRASADO (lado player).
    //   · buffered audio vs vídeo (getBufferedInfo) = salud de buffers; si divergen
    //     de forma persistente hay stalls/gaps, no offset de contenido.
    //   Si outputLatency es pequeño (~decenas de ms) y el audio se oye ANTES que
    //   la imagen, el desfase es de CAPTURA (adelay corto) → compénsalo con
    //   engine.setOutputDelay(ms) / ?audiodelay=ms hasta que cuadre.
    window.avDiag = () => {
      try {
        const bi = shakaVideo.getBufferedInfo();
        const sr = shakaVideo.seekRange();
        const vb = (bi.video && bi.video[0]) || null;
        const ab = (bi.audio && bi.audio[0]) || null;
        const octx = (window.engine && window.engine.audioContext) || null;
        const info = {
          t: +videoEl.currentTime.toFixed(3),
          rate: +videoEl.playbackRate.toFixed(3),
          edgeDelay_s: +(sr.end - videoEl.currentTime).toFixed(2),
          avDrift_ms: +_avDriftMs.toFixed(1),   // deriva REAL (excluye stalls); ~0 = sin drift de reloj
          stallTime_ms: +_stallMs.toFixed(0),   // tiempo total atascado/en pausa
          dropped: (videoEl.getVideoPlaybackQuality && videoEl.getVideoPlaybackQuality().droppedVideoFrames) || 0,
          stalls: _stalls,   // nº de 'waiting' desde el arranque
          video_buf: vb ? [+vb.start.toFixed(2), +vb.end.toFixed(2)] : null,
          audio_buf: ab ? [+ab.start.toFixed(2), +ab.end.toFixed(2)] : null,
          buf_end_skew_s: (vb && ab) ? +(ab.end - vb.end).toFixed(3) : null,
          webaudio_outLat_ms: octx ? +(((octx.outputLatency || 0)) * 1000).toFixed(1) : null,
          webaudio_baseLat_ms: octx ? +(((octx.baseLatency || 0)) * 1000).toFixed(1) : null,
          audioOutDelay_ms: (window.engine && window.engine.outputDelayMs) || 0,
          ctx: octx && octx.state,
        };
        console.log('[avdiag]', JSON.stringify(info));
        return info;
      } catch (e) { console.warn('[avdiag] error', e); }
    };
    if (new URLSearchParams(location.search).get('avlog') === '1') {
      setInterval(window.avDiag, 1000);
      toast('avdiag activo (consola cada 1s)');
    }

    window._shakaVideo = shakaVideo;
    window._shakaAudio = shakaAudio;
    toast('Cargando manifest…');

  } catch(e) {
    showSpinner(false);
    // Los errores de Shaka no tienen .message → mostrábamos "undefined".
    // shaka.util.Error trae code/category/data; lo exponemos para diagnosticar.
    const msg = (e && e.code != null)
      ? `Shaka ${e.category}/${e.code}` + (e.data && e.data.length ? ' · ' + JSON.stringify(e.data) : '')
      : (e && e.message) ? e.message : String(e);
    toast('Error: ' + msg);
    console.error('[load] error completo:', e, e && e.data);
  }
}

function attachVideoTexture() {
  if (videoTexture) videoTexture.dispose();
  videoTexture = new THREE.VideoTexture(videoEl);
  videoTexture.minFilter = THREE.LinearFilter;
  videoTexture.magFilter = THREE.LinearFilter;
  videoTexture.format = THREE.RGBFormat;
  sphere.material = new THREE.MeshBasicMaterial({ map: videoTexture });
}

// ══════════════════════════════════════════════════════
// FOA DECODE — B-format W/X/Y/Z → binaural estéreo
// audioEl con Shaka sí es accesible a Web Audio API
// ══════════════════════════════════════════════════════
async function setupFOA() {
  try {
    // Motor de audio inmersivo. renderer 'omnitone' → binaural HRTF real
    // (delante/detrás/elevación). Si Omnitone no cargara, cae a cardioides.
    // Override desde la URL: ?renderer=hoast
    const _renderer = new URLSearchParams(location.search).get('renderer') || 'omnitone';

    // Stems por músico (spotlight posicional). El stream multicanal trae
    // 4 FOA + N stems en los canales 4..N. La colocación 3D y los nombres los
    // define el editor (editor.html) y se guardan en /scene.json.
    // Prioridad:  ?stems= (override azimuts)  >  scene.json  >  DEFAULT_STEMS.
    //   ?stems=-50,-30,-10,10,30,50      azimut por músico (grados)
    //   ?stems=-50:5,-30,-10:-3,…        con elevación opcional «az:el»
    const DEFAULT_STEMS = [
      { azimuthDeg: -50, name: 'DR'    },   // batería
      { azimuthDeg: -30, name: 'GT'    },   // guitarra
      { azimuthDeg: -10, name: 'KEY'   },   // teclado
      { azimuthDeg:  10, name: 'SAX'   },
      { azimuthDeg:  30, name: 'TBONE' },   // trombón
      { azimuthDeg:  50, name: 'TPT'   },   // trompeta
    ];
    let _stems = null, _spot = null, _sources = null, _align = null;
    try {
      const _r = await fetch('/scene.json', { cache: 'no-store' });
      if (_r.ok) {
        const _sc = await _r.json();
        // Se copia el stem ENTERO y solo se normaliza lo que hay que normalizar.
        // Enumerar los campos a mano costó dos funciones que no llegaron nunca a
        // funcionar: el editor escribía `ar` (posición en metros de la sala) y
        // `gainDb` (trim por músico) y este map los tiraba, así que en AR todo el
        // mundo acababa en la esfera de 1,6 m —lo que el partner ve como "sigue
        // dibujando el círculo"— y el trim no llegaba al motor. Cualquier campo
        // que el editor añada mañana sobrevive por defecto, que es lo que hay que
        // dar por supuesto entre dos ficheros que ya comparten formato.
        if (Array.isArray(_sc.stems) && _sc.stems.length)
          _stems = _sc.stems.map(s => ({
            ...s,
            azimuthDeg: +s.azimuthDeg || 0, elevationDeg: +s.elevationDeg || 0,
            name: s.name, closeup: s.closeup || null }));
        if (_sc.spotlight) _spot = _sc.spotlight;
        if (_sc.sources) _sources = _sc.sources;
        if (_sc.alignment) _align = _sc.alignment;
        if (_sc.ar) arCfg = _sc.ar;
        if (_sc.telemetry) telemetryCfg = _sc.telemetry;
      }
    } catch (_) { /* sin escena → DEFAULT_STEMS */ }

    const _stemsParam = new URLSearchParams(location.search).get('stems');
    if (_stemsParam) {
      _stems = _stemsParam.split(',').map((tok, i) => {
        const [az, el] = tok.split(':');
        return { azimuthDeg: parseFloat(az) || 0, elevationDeg: parseFloat(el) || 0, name: 'músico ' + (i + 1) };
      });
    }
    if (!_stems) _stems = DEFAULT_STEMS;
    stemDefs = _stems;   // el modo AR ancla un objeto 3D por stem con su az/el

    // ?chmap=identity desactiva el remapeo de canales del decodificador Opus
    // (ver VORBIS_SRC_TO_OUT). Útil si un navegador NO reordena: compruébalo con
    // channel-test.html?src=/chtest/manifest.mpd&ch=7 antes de tocarlo.
    const _chmap = new URLSearchParams(location.search).get('chmap') || 'auto';
    engine = new ImmersiveAudioEngine({ order: 1, renderer: _renderer, stems: _stems, channelMap: _chmap });
    // El audio sale del <video> vía Web Audio: hay que desmutearlo (si no, el tap
    // recibe silencio). No hay doble salida: createMediaElementSource reencamina
    // el audio del elemento al grafo (no suena por la salida normal del <video>).
    audioEl.muted = false;
    await engine.attach(audioEl);
    window.engine = engine;   // tuning en vivo desde consola (restGain, posiciones…)

    // ── Telemetría de pose (opt-in) ───────────────────────────────────
    // Alimenta un relay externo con giro/posición de cabeza (la mirada la deriva
    // el relay a partir del cuaternión). Config en scene.json:
    //   "telemetry": { "enabled": true, "rateHz": 20 }
    // Sin "url" apunta a /ingest de este mismo origen, que server.js (o nginx)
    // reenvía al relay: mismo host, puerto y certificado que el player, así que
    // en el casco no hay que aceptar un segundo autofirmado. Pon "url" solo si
    // el relay vive en otra máquina.
    // Overrides por URL:  ?telemetry=wss://host/ingest   ?player=NOMBRE
    {
      const _tq = new URLSearchParams(location.search);
      const _sameOrigin = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ingest`;
      const _tcfg = (telemetryCfg && telemetryCfg.enabled) ? (telemetryCfg.url || _sameOrigin) : null;
      const _turl = _tq.get('telemetry') || _tcfg || null;
      if (_turl) {
        telemetry = new Telemetry({
          url: _turl,
          playerId: _tq.get('player') || (telemetryCfg && telemetryCfg.playerId) || undefined,
          rateHz:  (telemetryCfg && telemetryCfg.rateHz)  || 20,
          flushMs: (telemetryCfg && telemetryCfg.flushMs != null) ? telemetryCfg.flushMs : 100,
          meta: { ua: navigator.userAgent },
        });
        window.telemetry = telemetry;   // inspección desde consola
        toast('Telemetría lista → ' + _turl);
      }
    }
    if (_stems.length) {
      // zoomMin = vista actual (sin zoom) → en reposo los stems quedan en
      // silencio y crecen solo al acercar mirando al músico. Vale para PC y VR
      // (en VR el zoom normalizado mapea t=0 → factor=zoomMin → boost 0).
      engine.setSpotlightParams({ zoomMin: getZoomFactor() });
      if (_spot) engine.setSpotlightParams(_spot);   // maxBoost/focusExp/restGain/zoomMax
      // Curva de atenuación por distancia + suavizado de posiciones externas.
      // Solo se nota en AR: en 360 las fuentes están fijas a la esfera.
      if (_sources) engine.setSourceParams(_sources);
      toast(`${_stems.length} stems · spotlight en zoom`);
    }

    // Alineación audio↔vídeo: cuánto estaba girado el micro ambisónico respecto
    // a la cámara al grabar. Es de la TOMA, así que su sitio es scene.json:
    //   "alignment": { "yawOffsetDeg": 180, "mirror": false }
    // Overrides por URL para tantear en el visor sin tocar la escena:
    //   ?ayaw=180   → offset de azimut en grados
    //   ?amirror=1  → espejo izquierda/derecha
    const _p = new URLSearchParams(location.search);
    const _ayaw = _p.has('ayaw') ? (parseFloat(_p.get('ayaw')) || 0)
                                 : ((_align && +_align.yawOffsetDeg) || 0);
    const _amirror = _p.has('amirror') ? (_p.get('amirror') === '1')
                                       : !!(_align && _align.mirror);
    engine.setAlignment({ yawOffsetDeg: _ayaw, mirror: _amirror });
    if (_ayaw || _amirror) toast(`alineación audio · yaw ${_ayaw}° · mirror ${_amirror ? 'on' : 'off'}`);

    // Compensación de desfase A/V en el player (sin re-encodear): retrasa el audio
    // para cuadrarlo con un vídeo que llega más tarde (audio adelantado). Dial en
    // vivo:  ?audiodelay=900   ó en consola: engine.setOutputDelay(900)
    const _adly = parseFloat(_p.get('audiodelay') || '0') || 0;
    if (_adly > 0) { engine.setOutputDelay(_adly); toast(`audio +${engine.outputDelayMs} ms (A/V)`); }

    // Referencias derivadas para la UI (volumen, mute, visualizador).
    audioCtx       = engine.audioContext;
    gainNode       = engine.gainNode;
    gainNode.gain.value = document.getElementById('vol-slider').value;
    ambiAnalyser   = engine.analyser;
    ambiTimeDomain = new Uint8Array(ambiAnalyser.frequencyBinCount);

    document.getElementById('ambi-badge').style.display = 'inline';
    const _rname = engine._activeRenderer === 'omnitone' ? 'binaural HRTF (Omnitone)' : 'cardioides (HOAST)';
    toast('Ambisonics FOA · ' + _rname);
    console.log('[ambi] FOA activo —', _rname);

  } catch(e) {
    console.warn('[ambi] FOA falló:', e.message);
    // Fallback — audio nativo del vídeo
    videoEl.muted = false;
    videoEl.volume = document.getElementById('vol-slider').value;
    toast('Audio nativo (FOA no disponible)');
  }
}

// ══════════════════════════════════════════════════════
// CLOSE-UPS (Caso B) — vídeo "de cerca" por músico
// ══════════════════════════════════════════════════════
// El manifest trae pistas de vídeo extra (un AdaptationSet por close-up, misma
// timeline que el 360 y el audio). Una 3ª instancia de Shaka sobre <video> las
// reproduce sobre un plano flotante; al mirar a un músico con close-up + zoom,
// se selecciona su pista. Mismo manifest → sincronía garantizada por currentTime.
async function setupCloseups(src) {
  if (!shakaVideo || !shakaCfg) return;
  // RepresentationID 0 = 360; >0 = close-ups. Si solo hay 0, no hay nada que hacer.
  const repIds = new Set(shakaVideo.getVariantTracks().map(v => v.originalVideoId));
  if (repIds.size <= 1) return;

  // Mapa stem→RepresentationID: los stems con closeup reciben 1,2,… EN ORDEN,
  // igual que stream.sh los empaqueta (filter(closeup) en orden de escena).
  closeupRepByStem = {};
  let rep = 1;
  stemDefs.forEach((s, i) => { if (s && s.closeup) closeupRepByStem[i] = String(rep++); });
  if (!Object.keys(closeupRepByStem).length) return;

  try {
    shakaCloseup = new shaka.Player(closeupEl);
    shakaCloseup.configure(shakaCfg);
    await shakaCloseup.load(src);
    closeupEl.muted = true;   // el audio sale del motor FOA, no de aquí

    closeupTexture = new THREE.VideoTexture(closeupEl);
    closeupTexture.minFilter = THREE.LinearFilter;
    closeupTexture.magFilter = THREE.LinearFilter;
    closeupMesh.material.map = closeupTexture;
    closeupMesh.material.needsUpdate = true;

    closeupReady = true;
    toast('Close-ups disponibles · mira a un músico y haz zoom');
  } catch (e) {
    console.warn('[closeup] no disponible:', e.message);
    closeupReady = false;
  }
}

// Muestra el close-up del stem `idx` (o lo oculta con idx<0). Cambia la pista de
// vídeo de shakaCloseup; al ser el mismo manifest, sigue sincronizado.
function showCloseup(idx) {
  if (idx === closeupStem) return;          // sin cambios
  closeupStem = idx;
  const hide = () => { closeupMesh.visible = false; closeupEl.pause(); };
  if (idx < 0 || !closeupReady) return hide();
  const repId = closeupRepByStem[idx];
  if (repId == null) return hide();
  const v = shakaCloseup.getVariantTracks().find(t => t.originalVideoId === repId);
  if (!v) return hide();
  shakaCloseup.selectVariantTrack(v, /*clearBuffer*/ true);
  closeupEl.currentTime = videoEl.currentTime;
  closeupEl.play().catch(() => {});
  closeupMesh.visible = true;
}

// Selecciona el close-up del músico enfocado (mirada × zoom) o lo oculta. No
// actúa en AR (allí ya te acercas al objeto 3D real). Barato: solo conmuta.
function updateCloseupFocus() {
  if (!closeupReady || arSession) return;
  showCloseup(engine ? engine.getFocusedStem(0.3) : -1);
}

// ══════════════════════════════════════════════════════
// AMBISONICS VISUALIZER
// ══════════════════════════════════════════════════════
// Radar de DIRECCIÓN del sonido dominante (vector intensidad FOA), en marco de
// cabeza: arriba = hacia donde miras. La flecha apunta de dónde viene el sonido.
// Vector suavizado (EMA) para evitar el temblor frame a frame.
let _doaVX = 0, _doaVY = 0;
function updateAmbiViz() {
  const c = document.getElementById('ambi-canvas');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 80, 80);
  const cx = 40, cy = 40, r = 30;

  // Anillo + marca de "frente" (arriba).
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.arc(cx, cy - r, 2, 0, Math.PI * 2); ctx.fill();

  const doa = engine ? engine.getDominantDirection() : null;
  if (doa) {
    // az=0 (frente) → arriba (-π/2);  +az (izquierda) → izquierda.
    const ang = -Math.PI / 2 - doa.az;
    _doaVX += (Math.cos(ang) * doa.conf - _doaVX) * 0.2;
    _doaVY += (Math.sin(ang) * doa.conf - _doaVY) * 0.2;
  } else {
    _doaVX *= 0.9; _doaVY *= 0.9;
  }

  const len = Math.hypot(_doaVX, _doaVY);
  if (len > 0.001) {
    const k = r * Math.min(1, len * 3) / len;   // longitud ∝ confianza (clamp)
    const ex = cx + _doaVX * k, ey = cy + _doaVY * k;
    ctx.strokeStyle = '#00d4ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = '#00d4ff';
    ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(0,212,255,0.5)';
  ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
}

// ══════════════════════════════════════════════════════
// CONTROLS
// ══════════════════════════════════════════════════════
function togglePlay() {
  if (!videoEl) return;
  if (videoEl.paused) {
    videoEl.play();
    audioEl.play().catch(()=>{});
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } else {
    videoEl.pause();
    audioEl.pause();
  }
  updatePlayBtn();
}

function updatePlayBtn() {
  document.getElementById('play-btn').textContent = videoEl?.paused ? '▶' : '⏸';
}

function skipBack() {
  if (!videoEl) return;
  const t = Math.max(0, videoEl.currentTime - 10);
  videoEl.currentTime = t;
  audioEl.currentTime = t;
}

function skipFwd() {
  if (!videoEl) return;
  const t = videoEl.currentTime + 10;
  videoEl.currentTime = t;
  audioEl.currentTime = t;
}

function seekTo(e) {
  if (!videoEl || !isFinite(videoEl.duration)) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * videoEl.duration;
  videoEl.currentTime = t;
  audioEl.currentTime = t;
}

function updateProgress() {
  if (!videoEl) return;
  const dur = videoEl.duration;
  const cur = videoEl.currentTime;
  if (isFinite(dur) && dur > 0) {
    const pct = (cur / dur) * 100;
    document.getElementById('seekbar-fill').style.width = pct + '%';
    document.getElementById('seekbar-thumb').style.right = (100 - pct) + '%';
    document.getElementById('time-display').textContent = fmt(cur) + ' / ' + fmt(dur);
  } else {
    document.getElementById('time-display').textContent = fmt(cur) + ' / ∞';
  }
}

function fmt(s) {
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

function toggleMute() {
  if (gainNode) {
    const muted = gainNode.gain.value === 0;
    gainNode.gain.value = muted ? document.getElementById('vol-slider').value : 0;
    document.getElementById('mute-btn').textContent = muted ? '🔊' : '🔇';
  } else if (videoEl) {
    videoEl.muted = !videoEl.muted;
    document.getElementById('mute-btn').textContent = videoEl.muted ? '🔇' : '🔊';
  }
}

function setVolume(v) {
  if (gainNode) gainNode.gain.value = v;
  else if (videoEl) videoEl.volume = v;
}

function resetView() { yaw = 0; pitch = 0; toast('Vista centrada'); }

function toggleFS() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}

// ══════════════════════════════════════════════════════
// POINTER / TOUCH CONTROLS
// ══════════════════════════════════════════════════════
function setupPointerControls() {
  const c = renderer.domElement;
  c.addEventListener('mousedown', e => { isDragging = true; prevMouse = {x: e.clientX, y: e.clientY}; });
  window.addEventListener('mouseup', () => isDragging = false);
  window.addEventListener('mousemove', e => {
    if (!isDragging) return;
    yaw   -= (e.clientX - prevMouse.x) * 0.005;
    pitch -= (e.clientY - prevMouse.y) * 0.005;
    pitch  = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    prevMouse = {x: e.clientX, y: e.clientY};
  });

  let lastTouch = null;
  c.addEventListener('touchstart', e => { lastTouch = e.touches[0]; });
  c.addEventListener('touchmove', e => {
    if (!lastTouch) return;
    const t = e.touches[0];
    yaw   -= (t.clientX - lastTouch.clientX) * 0.005;
    pitch -= (t.clientY - lastTouch.clientY) * 0.005;
    pitch  = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    lastTouch = t;
    e.preventDefault();
  }, { passive: false });

  c.addEventListener('wheel', e => {
    camera.fov = Math.max(30, Math.min(100, camera.fov + e.deltaY * 0.05));
    camera.updateProjectionMatrix();
  });
}

// ══════════════════════════════════════════════════════
// GYROSCOPE
// ══════════════════════════════════════════════════════
function setupGyro() {
  if (!window.DeviceOrientationEvent) return;
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    document.addEventListener('click', async () => {
      if ((await DeviceOrientationEvent.requestPermission()) === 'granted') enableGyro();
    }, { once: true });
  } else {
    enableGyro();
  }
}

function enableGyro() {
  window.addEventListener('deviceorientation', e => {
    if (!e.alpha && !e.beta) return;
    deviceOrientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
    if (!useGyro) {
      useGyro = true;
      document.getElementById('gyro-badge').style.display = 'block';
      toast('Giroscopio activado');
    }
  });
}

// ══════════════════════════════════════════════════════
// DEBUG PANEL 3D — visible dentro de las Quest
// Panel flotante en la escena Three.js
// ══════════════════════════════════════════════════════
let debugCanvas = null, debugTexture = null, debugMesh = null;
let debugLines = [];

function initDebugPanel() {
    return;

  // Canvas 2D para el texto del debug
  debugCanvas = document.createElement('canvas');
  debugCanvas.width = 512;
  debugCanvas.height = 256;

  debugTexture = new THREE.CanvasTexture(debugCanvas);

  const geo = new THREE.PlaneGeometry(1.2, 0.6);
  const mat = new THREE.MeshBasicMaterial({
    map: debugTexture,
    transparent: true,
    depthTest: false,
    side: THREE.DoubleSide,
  });

  debugMesh = new THREE.Mesh(geo, mat);
  // Posición justo delante del usuario, abajo
  debugMesh.position.set(0, -0.3, -2);
  debugMesh.visible = false;
  scene.add(debugMesh);
}

function xrDebug(data) {
  if (!debugCanvas || !debugMesh) return;
  debugMesh.visible = true;

  const ctx = debugCanvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 256);

  // Fondo semitransparente
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.roundRect(4, 4, 504, 248, 12);
  ctx.fill();

  // Borde
  ctx.strokeStyle = '#00d4ff';
  ctx.lineWidth = 2;
  ctx.roundRect(4, 4, 504, 248, 12);
  ctx.stroke();

  // Título
  ctx.fillStyle = '#00d4ff';
  ctx.font = 'bold 18px monospace';
  ctx.fillText('XR DEBUG', 16, 30);

  // Líneas de datos
  ctx.font = '15px monospace';
  ctx.fillStyle = '#e6edf3';
  const lines = [
    `video: ${data.videoState} | muted: ${data.muted}`,
    `texture: ${data.hasTexture} | readyState: ${data.readyState}`,
    `pose: ${data.hasPose} | yaw: ${data.yaw}`,
    `ambi: ${data.hasAmbi} | ctx: ${data.audioCtx}`,
    `audio: ${data.audioState}`,
    `frame: ${data.frameCount}`,
  ];
  lines.forEach((l, i) => {
    ctx.fillStyle = i % 2 === 0 ? '#e6edf3' : '#8b949e';
    ctx.fillText(l, 16, 60 + i * 30);
  });

  debugTexture.needsUpdate = true;
}

// ══════════════════════════════════════════════════════
// WebXR — Oculus Quest 3
// ══════════════════════════════════════════════════════
async function checkWebXR() {
  if (!navigator.xr) return;
  const ok = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (ok) {
    document.getElementById('xr-btn').disabled = false;
    document.getElementById('xr-badge').style.display = 'inline';
  }
  const arOk = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (arOk) document.getElementById('ar-btn').disabled = false;
}

async function enterXR() {
  if (!navigator.xr) return toast('WebXR no disponible');
  try {
    if (xrSession) {
      await xrSession.end();
      return;
    }

    xrSession = await navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['bounded-floor', 'hand-tracking'],
    });

    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(xrSession);

    // frame: en qué marco viajan p/q. En VR es el del propio casco (ver arTelemetryPose).
    if (telemetry) { telemetry.meta.mode = 'vr'; telemetry.meta.frame = 'local-floor'; telemetry.start(); }

    document.getElementById('xr-btn').textContent = 'EXIT VR';

    xrSession.addEventListener('end', () => {
      xrSession = null;
      telemetry?.stop();
      if (debugMesh) debugMesh.visible = false;
      document.getElementById('xr-btn').textContent = 'VR';
      renderer.setAnimationLoop(null);
      requestAnimationFrame(renderLoop);
    });

    let frameCount = 0;

    renderer.setAnimationLoop((time, frame) => {

      frameCount++;

      // ── Actualizar textura vídeo ──────────────────
      if (videoEl && videoEl.readyState >= 2) {
        if (videoTexture) videoTexture.needsUpdate = true;
      }
      if (closeupReady && closeupMesh.visible && closeupTexture) closeupTexture.needsUpdate = true;

      let hasPose = false;
      let yawDeg = 0;

      // ── Orientación headset → ambisonics ──────────
      if (frame) {
        const refSpace = renderer.xr.getReferenceSpace();
        if (refSpace) {
          const pose = frame.getViewerPose(refSpace);
          if (pose) {
            hasPose = true;
            const q = pose.transform.orientation;
            const pos = pose.transform.position;

            // ── Rotación del campo sonoro con la cabeza ──────────────────
            // Mismo camino exacto que el PC: la MATRIZ de la pose (head→world),
            // no una conversión a mano. Con ?audiotest=spin el campo gira solo
            // (sin cabeza): si en VR lo oyes girar, el pipeline va bien y el
            // problema sería la entrada de pose.
            if (AUDIO_SPIN_TEST) {
              const a = time * 0.0006;   // ~1 vuelta cada 10 s
              engine?.setRotationFromMatrix4(new THREE.Matrix4().makeRotationY(a).elements);
            } else {
              engine?.setRotationFromMatrix4(pose.transform.matrix);
            }

            // yaw (para debug / visualizador 2D).
            yaw = Math.atan2(
              2 * (q.w * q.y + q.x * q.z),
              1 - 2 * (q.y * q.y + q.z * q.z)
            );
            yawDeg = (yaw * 180 / Math.PI).toFixed(1);

            // ── Zoom/acercamiento con el joystick derecho (eje Y) ────────
            for (const isrc of xrSession.inputSources) {
              if (isrc.handedness === 'right' && isrc.gamepad && isrc.gamepad.axes.length >= 4) {
                const jy = isrc.gamepad.axes[3];   // adelante = negativo
                if (Math.abs(jy) > 0.15)
                  xrZoomDist = Math.max(0, Math.min(80, xrZoomDist - jy * 1.2));
              }
            }

            // El zoom de VR (joystick) alimenta el spotlight de stems: en
            // escritorio lo hace el FOV vía setZoomByFactor, pero en VR no hay
            // FOV controlable, así que mapeamos xrZoomDist → zoom normalizado.
            // Boost completo a media carrera (≈40) para que responda pronto.
            const zoomN = xrZoomDist / 40;
            engine?.setZoomNormalized(zoomN);
            updateCloseupFocus();   // close-up del músico enfocado (joystick zoom)

            // Telemetría: pose de cabeza + zoom/foco (decimado a rateHz en la clase).
            // pos/q son referencias de la pose ya leída → sin coste por frame.
            //
            // El foco sale del motor, NO de closeupStem: éste solo cambia cuando la
            // escena trae pistas de close-up, y sin ellas viajaría un -1 constante
            // aunque sepamos perfectamente a qué músico mira. Y va el zoom
            // normalizado (0..1), no xrZoomDist (0..80), para que el consumidor lea
            // el mismo rango venga de VR, de escritorio o del simulador.
            // setZoomNormalized() acaba de recalcular los pesos, así que el foco es
            // el de este frame.
            telemetry?.sample(pos, q, zoomN, engine?.getFocusedStem(0.3) ?? -1,
                              videoEl?.currentTime || 0);

            // Centrar la esfera en la cabeza y desplazarla EN CONTRA de la vista
            // para "acercar" lo que miras (xrZoomDist = 0 → solo centrada).
            if (sphere) {
              const fwd = new THREE.Vector3(0, 0, -1)
                .applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
              sphere.position.set(
                pos.x - fwd.x * xrZoomDist,
                pos.y - fwd.y * xrZoomDist,
                pos.z - fwd.z * xrZoomDist);
            }

            // Debug panel fijo delante — altura ojo, 2m adelante
            if (debugMesh) {
              debugMesh.position.set(pos.x, pos.y + 0.1, pos.z - 2);
              debugMesh.visible = true;
            }
          }
        }
      }

      // ── Debug panel cada 10 frames ────────────────
      if (frameCount % 10 === 0) {
        xrDebug({
          videoState: videoEl?.paused ? 'paused' : 'playing',
          muted: videoEl?.muted,
          hasTexture: !!videoTexture,
          readyState: videoEl?.readyState,
          hasPose,
          yaw: yawDeg + '°',
          hasAmbi: !!engine,
          renderer: engine?._activeRenderer || 'none',
          spinTest: AUDIO_SPIN_TEST ? 'ON' : 'off',
          zoom: xrZoomDist.toFixed(0),
          audioCtx: audioCtx?.state || 'none',
          audioState: audioEl?.paused ? 'paused' : 'playing',
          frameCount,
        });
      }

      updateAmbiViz();
      renderer.render(scene, camera);
    });

    if (videoEl) videoEl.play();
    if (audioEl) audioEl.play().catch(()=>{});
    if (audioCtx) audioCtx.resume();
    toast('Quest 3 VR activo');

  } catch(e) {
    toast('Error WebXR: ' + e.message);
    console.error(e);
  }
}

// ══════════════════════════════════════════════════════
// WebXR AR — objetos 3D como fuentes de audio (passthrough)
// ══════════════════════════════════════════════════════
// Cada stem (músico) se ancla como un objeto 3D en la sala real (passthrough);
// su canal de audio se espacializa en esa posición con el PannerNode HRTF del
// motor (bindStemToObject + update). La cabeza se mueve por el espacio y el
// sonido viene de cada objeto, con atenuación natural por distancia.
//
// Una sala NO es la esfera del 360. En VR el oyente está en el centro y un stem
// es una DIRECCIÓN (azimut/elevación): la distancia no se oye, porque la fuente
// va siempre a `_stemRadius` de la cabeza. En AR el músico es un PUNTO de la
// sala, con su distancia y su altura reales sobre el suelo, y el espectador se
// mueve entre ellos. Por eso un stem puede traer un bloque `ar: {x,y,z}` en
// metros de sala; sin él caemos a la proyección de abajo, que coloca la
// dirección del 360 sobre una esfera a AR_RADIUS. Esa proyección es un apaño
// razonable para una escena sin colocar —todos a la misma distancia inventada—,
// no la geometría de la sala.
const AR_RADIUS = 1.6;    // distancia de colocación inicial (m)
const AR_HEIGHT = 1.3;    // altura base de los objetos (m)

// Telemetría en coordenadas de SALA (ver arTelemetryPose). Temporales de módulo:
// el bucle de AR pasa por aquí en cada frame y no conviene asignar ahí.
const _telP = new THREE.Vector3();
const _telQ = new THREE.Quaternion();
const _telR = new THREE.Quaternion();

// Pose de cabeza pasada del marco del casco al de la sala.
//
// `local-floor` pone el origen donde arrancó cada sesión: en bruto, la pose de
// dos espectadores no es comparable entre sí, ni con los músicos, que viven en
// el marco de roomGroup (stem.ar). Como T ya existe —ES roomGroup— basta con
// deshacerla: la posición al espacio local del grupo, y la orientación sin su
// yaw. En VR no aplica y se sigue enviando la pose tal cual: allí no hay sala,
// el oyente está en el centro de la esfera. El hello lleva `frame` para que el
// consumidor sepa cuál de los dos marcos está recibiendo.
const _telPair = [_telP, _telQ];     // se devuelve siempre el mismo par: sin basura por frame
function arTelemetryPose(pose) {
  const p = pose.transform.position, q = pose.transform.orientation;
  _telP.set(p.x, p.y, p.z);
  roomGroup.worldToLocal(_telP);                 // usa matrixWorld: actualizarla antes
  _telQ.set(q.x, q.y, q.z, q.w)
       .premultiply(_telR.copy(roomGroup.quaternion).invert());
  return _telPair;
}

// Punto de sala de un stem, en el marco de roomGroup: el bloque `ar` si lo trae,
// y si no la dirección del 360 proyectada sobre la esfera.
function arPosition(s) {
  const p = s.ar;
  if (p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) return [p.x, p.y, p.z];
  const D2R = Math.PI / 180;
  const az = (s.azimuthDeg || 0) * D2R, el = (s.elevationDeg || 0) * D2R;
  const ce = Math.cos(el), se = Math.sin(el);
  // misma convención que el motor: frente = −Z, izquierda = −X, arriba = +Y.
  return [-ce * Math.sin(az) * AR_RADIUS,
          AR_HEIGHT + se * AR_RADIUS,
          -ce * Math.cos(az) * AR_RADIUS];
}

// Etiqueta de texto como sprite (nombre del músico, sobre el objeto).
function makeLabelSprite(text) {
  const font = 48, pad = 24;
  const c = document.createElement('canvas');
  let cx = c.getContext('2d');
  cx.font = `bold ${font}px sans-serif`;
  c.width = Math.ceil(cx.measureText(text || '').width) + pad * 2;
  c.height = font + pad * 2;
  cx = c.getContext('2d');                       // el resize limpia el contexto
  cx.font = `bold ${font}px sans-serif`;
  cx.fillStyle = 'rgba(0,0,0,0.55)';
  cx.fillRect(0, 0, c.width, c.height);
  cx.fillStyle = '#00d4ff';
  cx.textBaseline = 'middle';
  cx.fillText(text || '', pad, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set((c.width / c.height) * 0.16, 0.16, 1);   // ~16 cm de alto
  sp.position.set(0, 0.2, 0);
  return sp;
}

// Marcador de fuente: esfera de alambre emisiva + etiqueta con el nombre.
const AR_MARK_IDLE  = 0x00d4ff;   // marcador en reposo
const AR_MARK_FOCUS = 0xffd24a;   // marcador del músico enfocado

function makeSourceMarker(name) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.08, 1),
    // Material por marcador (no compartido): el realce del foco pinta solo uno.
    new THREE.MeshBasicMaterial({ color: AR_MARK_IDLE, wireframe: true })));
  g.add(makeLabelSprite(name));
  return g;
}

// ── Mallas de los músicos ────────────────────────────────────────────────────
//
// Un GLB por músico en lugar de la esfera de alambre. Va en scene.json, junto al
// stem al que representa, porque es una propiedad de ESE músico:
//
//   "stems": [ { "name": "DR", "mesh": "meshes/bateria.glb" }, … ]
//   "stems": [ { "name": "DR", "mesh": { "url": "…", "heightM": 1.7, "yawDeg": 90 } } ]
//   "ar": { "mesh": "meshes/generico.glb" }        ← por defecto para todos
//
// El punto del stem sigue siendo el del AUDIO (la altura a la que suena, sobre
// AR_HEIGHT o el `ar.y` que traiga), mientras que la malla representa a alguien
// DE PIE en el suelo. Por eso la malla no se coloca en ese punto sino colgando de
// él hacia abajo: así el panner no se entera de que hemos puesto un muñeco, y el
// audio de una escena con mallas es idéntico al de la misma escena sin ellas.
// El cargador y el ajuste de escala viven en src/app/mesh-fit.js (window.MeshFit),
// no aquí: el editor tiene que colocar el modelo EXACTAMENTE igual que las gafas
// para que su vista previa sirva de algo, y dos copias de esta función son dos
// copias que se separan. `MeshFit.fit()` devuelve un grupo envoltorio con el
// modelo dentro —nunca toca la transformación propia del GLB— y dentro de
// `userData.fit` deja lo que midió, que es lo que el editor enseña por pantalla.

// Aro en el suelo, bajo los pies. Con malla propia el foco no puede marcarse
// repintando el material —el GLB trae los suyos, y teñirlos estropea la textura
// del músico y encima puede no verse—, así que el ámbar se va al aro, que se lee
// igual de bien sea cual sea el modelo.
function makeFocusRing() {
  const r = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.42, 32),
    new THREE.MeshBasicMaterial({ color: AR_MARK_IDLE, side: THREE.DoubleSide,
                                  transparent: true, opacity: 0.75, depthWrite: false }));
  r.rotation.x = -Math.PI / 2;
  // Un centímetro por encima del suelo, y no en y=0: ahí la base de la malla es
  // coplanar con el aro y las dos se disputan el mismo píxel — parpadeo al mover
  // la cabeza, que en las gafas se ve fatal.
  r.position.y = 0.01;
  return r;
}

// Luz para las mallas. El player no tenía ninguna, y no le hacía falta: la esfera
// del 360, los marcadores y las etiquetas son MeshBasicMaterial, que se dibuja
// tal cual. Un GLB llega con materiales PBR, y un PBR sin luces sale NEGRO —
// dentro de las gafas eso son bultos negros en medio del passthrough.
//
// Hemisférica más una direccional suave: la primera da un ambiente parejo que no
// deja ninguna cara a oscuras (en AR no hay escenario que iluminar, hay una sala
// real cuya luz no conocemos), y la segunda marca volumen para que una figura no
// se lea como una silueta plana. Sin sombras: cuestan y aquí no aportan.
let arLights = null;
function ensureARLights() {
  if (arLights) return arLights;
  arLights = new THREE.Group();
  arLights.add(new THREE.HemisphereLight(0xffffff, 0x707070, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 0.55);
  key.position.set(1, 3, 2);
  arLights.add(key);
  return arLights;
}

// Cuelga la malla del marcador ya colocado. Asíncrono a propósito: la sesión de AR
// arranca con las esferas de alambre y cada músico aparece cuando su fichero
// termina de bajar, en vez de esperar todos a que baje el último.
// ?nomesh=1 → vuelven las esferas de alambre. Para separar un problema de las
// mallas de uno del passthrough sin tener que editar la escena y volver a entrar.
const AR_NO_MESH = new URLSearchParams(location.search).get('nomesh') === '1';

function attachMeshTo(marker, cfg, floorY) {
  const spec = MeshFit.spec(cfg);
  if (!spec.url || AR_NO_MESH) return;
  MeshFit.load(spec.url).then(src => {
    // Mientras bajaba el fichero se puede haber salido de AR (o recolocado la
    // sala): si este marcador ya no está en la escena, el GLB no pinta nada aquí.
    if (!arSources.includes(marker)) return;
    const holder = new THREE.Group();
    // clone(): varios músicos pueden compartir fichero (el `ar.mesh` común) y cada
    // uno necesita su propio nodo. Ojo, un clon plano no arrastra el esqueleto de
    // una malla animada — cuando toque animar habrá que ir a SkeletonUtils.clone.
    holder.add(MeshFit.fit(src.clone(true), { ...spec, name: spec.url }));
    holder.position.y = floorY;               // del punto de audio al suelo
    holder.add(makeFocusRing());
    marker.add(holder);
    // Al colgar la primera malla, y no antes: una escena sin mallas no gasta ni
    // una luz, que es como ha funcionado el player hasta ahora.
    scene.add(ensureARLights());
    marker.userData.focusRing = holder.children[1];
    // La esfera de alambre era el sitio del músico mientras no había músico.
    marker.children[0].visible = false;
    marker.updateMatrixWorld(true);
    // El aro nace en reposo, y este músico puede estar enfocado YA: si su fichero
    // tardó más que el dwell, sin esto se le vería apagado estando en foco.
    paintARFocus();
  }).catch(e => {
    // Un GLB que no carga deja al músico con su esfera: se sigue oyendo y se
    // sigue pudiendo enfocar, que es lo que no puede perderse por un fichero malo.
    console.warn(`[ar] malla "${spec.url}":`, e.message || e);
  });
}

// ══════════════════════════════════════════════════════
// FOCO EN AR (mirada sostenida)
// ══════════════════════════════════════════════════════
// En VR el foco es puntería × zoom, y el zoom es la intención declarada: "quiero
// a ése". En AR no hay zoom, así que la intención hay que leerla del tiempo —
// mirar a alguien un rato— y del sitio, que ya está en las coordenadas de sala.
//
// Dos conos y dos tiempos, asimétricos a propósito. Con un solo umbral el foco
// parpadea entre dos músicos vecinos con el temblor natural de la cabeza, y ese
// parpadeo llega tal cual a la telemetría: una atención compartida que salta 5
// veces por segundo no es un dato, es ruido. Entrar cuesta (cono estrecho +
// permanencia); quedarse es fácil (cono ancho + margen para soltar).
//
// Del foco cuelgan tres cosas: la telemetría, el marcador ámbar y el realce del
// stem enfocado (boostDb/duckDb, que el motor aplica sobre la mezcla). El realce
// pende del MISMO veredicto que el marcador a propósito: lo que se oye subir es
// exactamente lo que se ve encenderse, así que se ajusta con las gafas puestas.
const AR_FOCUS = {
  coneDeg:    12,   // semiángulo para captar el foco
  keepDeg:    22,   // semiángulo, más ancho, para conservarlo
  dwellMs:   400,   // hay que sostener la mirada para que cuente
  releaseMs: 350,   // y perderla este rato para soltarlo
  boostDb:     6,   // cuánto sube el enfocado
  duckDb:      0,   // cuánto bajan los demás (0 = no se les toca)
};
// Los seis números salen de scene.json → `ar.focus` si están, porque son justo lo
// que hay que ajustar probándolo en la sala: la permanencia buena depende de la
// separación entre músicos y de lo lejos que esté el público, y el realce que hace
// falta, de cuánto tapa el ruido de la sala real. Se ignora en silencio lo que no
// sea un número: un valor suelto mal escrito no debe dejar el foco sin cono.
function loadARFocusCfg() {
  const c = arCfg.focus;
  if (c) for (const k of Object.keys(AR_FOCUS)) if (typeof c[k] === 'number' && isFinite(c[k])) AR_FOCUS[k] = c[k];
  // Los conos que se le pasan al motor son objetos reutilizados (ver más abajo):
  // hay que rehacerlos aquí o la escena ajustaría AR_FOCUS y el motor seguiría
  // preguntando por los grados de fábrica.
  _coneEnter.coneDeg = AR_FOCUS.coneDeg;
  _coneKeep.coneDeg  = AR_FOCUS.keepDeg;
  engine?.setFocusParams({ boostDb: AR_FOCUS.boostDb, duckDb: AR_FOCUS.duckDb });
}

let arFocus      = -1;   // músico enfocado (índice de stem) o -1
let arFocusCand  = -1;   // candidato en observación
let arFocusSince = 0;    // ms en que el candidato pasó a serlo
let arFocusLost  = 0;    // ms en que el enfocado salió del cono ancho (0 = dentro)

function resetARFocus() {
  arFocus = arFocusCand = -1;
  arFocusSince = arFocusLost = 0;
  engine?.setFocusedStem(-1);   // que no quede un músico realzado de la sesión anterior
}

// Los dos conos, como objetos fijos: se consultan 2 veces por frame y crear el
// literal ahí dentro es basura para el recolector 144 veces por segundo.
const _coneEnter = { coneDeg: AR_FOCUS.coneDeg };
const _coneKeep  = { coneDeg: AR_FOCUS.keepDeg };

// Un frame de foco. `now` es el timestamp del bucle de render (ms).
function updateARFocus(now) {
  if (!engine) return -1;
  const prev = arFocus;
  const cand = engine.getGazedStem(_coneEnter);

  if (cand !== arFocusCand) { arFocusCand = cand; arFocusSince = now; }

  // Soltar: el enfocado deja de ser el mejor del cono ANCHO. Se mide "el mejor"
  // y no "sigue dentro" para que un músico claramente más centrado te lo quite,
  // en vez de tener que salir del cono de uno para poder entrar en el del otro.
  //
  // Y no se suelta mientras haya candidato: como releaseMs < dwellMs, soltar en
  // cuanto sales del cono de A mete un -1 de unos frames antes de que B confirme
  // —el parpadeo que esto viene a evitar, y encima en el momento más informativo,
  // el del relevo. Sin candidato al que pasar, el foco se pierde de verdad.
  if (arFocus >= 0) {
    const stillOn = engine.getGazedStem(_coneKeep) === arFocus;
    if (stillOn || cand >= 0) arFocusLost = 0;
    else {
      if (!arFocusLost) arFocusLost = now;
      if (now - arFocusLost >= AR_FOCUS.releaseMs) { arFocus = -1; arFocusLost = 0; }
    }
  }

  // Coger: candidato sostenido durante dwellMs, venga de -1 o de otro músico.
  if (cand >= 0 && cand !== arFocus && now - arFocusSince >= AR_FOCUS.dwellMs) {
    arFocus = cand; arFocusLost = 0;
  }

  if (arFocus !== prev) { paintARFocus(); engine?.setFocusedStem(arFocus); }
  return arFocus;
}

function paintARFocus() {
  arSources.forEach((m, i) => {
    // Con malla manda el aro del suelo; sin ella, la esfera de alambre. Nunca las
    // dos: la esfera está oculta en cuanto hay músico que mirar.
    const mark = m.userData.focusRing || m.children[0];
    if (mark && mark.material) mark.material.color.setHex(i === arFocus ? AR_MARK_FOCUS : AR_MARK_IDLE);
  });
}

// ══════════════════════════════════════════════════════
// EN AR NO SE DECODIFICA EL 360
// ══════════════════════════════════════════════════════
// Medido con `?arperf=1` en la Quest: en passthrough el bucle va a 90 fps y
// nuestro JavaScript cuesta 0,52 ms de media —un 5% del frame— mientras el
// contador de `getVideoPlaybackQuality()` marca 24 fps, que es exactamente la
// tasa del manifest. Es decir: la esfera está oculta, nadie mira esa textura, y
// aun así se decodifica el 4K entero. Ese trabajo lo hace el decodificador
// hardware fuera del hilo principal, por eso no salía en el reparto por tramos y
// sí se notaba en el compositor de passthrough al andar.
//
// Shaka lee `manifest.disableVideo` SOLO al cargar, así que quitarlo obliga a
// recargar la fuente. Sale a cuenta: entrar en AR es un gesto explícito y poco
// frecuente, y el manifest trae el audio en su propio AdaptationSet (Opus
// multicanal en WebM), así que la variante sin vídeo se sostiene sola —el
// <video> sigue siendo el elemento del que cuelga Web Audio, solo que ya sin
// pista de imagen que decodificar.
//
// En directo se recarga al borde, que es donde quieres estar de todas formas. En
// VOD hay que guardar el `currentTime` y volver a él.
//
// `?arnovideo=0` lo desactiva, para comparar contra el comportamiento anterior
// sin tener que tocar código.
const AR_CUT_VIDEO = new URLSearchParams(location.search).get('arnovideo') !== '0';
let videoDisabled = false;

async function setVideoDisabled(off) {
  if (!shakaVideo || !curManifestSrc || off === videoDisabled) return;
  const wasPlaying = !videoEl.paused;
  const t = videoEl.currentTime;
  let live = false;
  try { live = shakaVideo.isLive(); } catch (_) { /* aún sin manifest */ }
  shakaVideo.configure({ manifest: { disableVideo: off } });
  // Shaka ignora en silencio las claves que no conoce (solo un warning en
  // consola, que aquí no ve nadie). Si el build del CDN no la tuviera, la
  // recarga saldría igual de cara y pareceríamos tontos midiendo lo mismo.
  if (shakaVideo.getConfiguration().manifest.disableVideo !== off)
    throw new Error('este build de Shaka no soporta manifest.disableVideo');
  // En directo, sin startTime: se entra por el borde. En VOD se vuelve al mismo
  // punto, o la recarga se sentiría como un salto al principio.
  await shakaVideo.load(curManifestSrc, live ? undefined : t);
  videoDisabled = off;
  // Al recuperar el vídeo hay pista nueva: la textura vieja apunta al mismo
  // elemento, pero re-crearla es barato y evita quedarse con el último fotograma
  // congelado de antes de entrar en AR.
  if (!off) attachVideoTexture();
  if (wasPlaying) videoEl.play().catch(() => {});
  if (audioEl && audioEl !== videoEl && wasPlaying) audioEl.play().catch(() => {});
}

// ══════════════════════════════════════════════════════
// CALIBRACIÓN MANUAL DE LA SALA (AR)
// ══════════════════════════════════════════════════════
// En AR el origen de `local-floor` cae donde cada usuario arrancó la sesión: es
// arbitrario y distinto en cada gafa, así que un mismo músico acaba en un sitio
// distinto para cada espectador. Lo que hace falta no es registrar la sala
// físicamente, sino que todos compartan la misma disposición.
//
// La corrección tiene solo 4 grados de libertad —giro en yaw y desplazamiento en
// XZ—, porque `local-floor` ya pone el suelo en y=0 y la IMU alinea la vertical.
// Resolver 6 GdL inclinaría la sala unos grados y sonaría raro sin dar ningún
// error. Esos tres números son la transformada de `roomGroup`.
//
// Aquí no se calcula nada: el usuario mueve la sala con los joysticks (con el
// grip apretado) hasta que los marcadores se posan sobre los músicos reales. La
// tolerancia es amplia —el oído resuelve ~5-10° fuera del eje, unos 40 cm a 3 m—,
// así que ajustar a ojo sobra. Cuando el día de mañana lleguen las posiciones de
// las cámaras, estos tres números los fijará el tracking en vez de la mano, y el
// resto del camino (marcadores dentro de roomGroup) no cambia.

const AR_CALIB_MOVE = 0.02;    // m por frame a fondo de joystick (~1.5 m/s)
const AR_CALIB_TURN = 0.015;   // rad por frame a fondo (~60 °/s)
const AR_CALIB_DEAD = 0.15;    // zona muerta, como el joystick de zoom

// Una calibración por sala: la toma se cambia sin salir de la sala, y la sala no
// se mueve entre tomas. `ar.venue` en scene.json separa sedes si hiciera falta.
function arCalibKey() { return 'arCalib:' + (arCfg.venue || 'default'); }

function loadARCalib() {
  try {
    const c = JSON.parse(localStorage.getItem(arCalibKey()));
    if (c && isFinite(c.x) && isFinite(c.z) && isFinite(c.yaw)) return c;
  } catch (_) { /* nada guardado o corrupto → sin calibrar */ }
  return { x: 0, z: 0, yaw: 0 };
}

function saveARCalib() {
  const c = { x: roomGroup.position.x, z: roomGroup.position.z, yaw: roomGroup.rotation.y };
  try { localStorage.setItem(arCalibKey(), JSON.stringify(c)); } catch (_) { /* modo privado */ }
}

function applyARCalib({ x, z, yaw }) {
  roomGroup.position.set(x, 0, z);
  roomGroup.rotation.y = yaw;
}

// Gira la sala alrededor del usuario, no de su propio origen. Girándola sobre el
// origen la escena ORBITA un punto arbitrario —se va de lado mientras gira— y
// alinear se vuelve imposible; alrededor de la cabeza el mundo gira "en torno a
// ti", que es lo que la mano espera.
function rotateRoomAroundUser(dYaw, head) {
  const c = Math.cos(dYaw), s = Math.sin(dYaw);
  const dx = roomGroup.position.x - head.x;
  const dz = roomGroup.position.z - head.z;
  roomGroup.position.x = head.x + dx * c + dz * s;
  roomGroup.position.z = head.z - dx * s + dz * c;
  roomGroup.rotation.y += dYaw;
}

// Un frame de calibración. Solo con el grip apretado, para no descolocar la sala
// sin querer con el joystick. Izquierdo desplaza, derecho gira, y pulsar el
// joystick vuelve al punto de partida si uno se pierde.
function updateARCalib(session, pose) {
  const head = pose.transform.position;
  const q = pose.transform.orientation;
  // Yaw de la cabeza: el bucle de AR no mantiene la global `yaw` (esa es la del
  // arrastre de escritorio), así que sale del cuaternión de la pose.
  const hy = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
  let active = false;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp || !gp.buttons[1] || !gp.buttons[1].pressed) continue;
    if (gp.axes.length < 4) continue;
    active = true;
    if (gp.buttons[3] && gp.buttons[3].pressed) {   // joystick pulsado → reset
      applyARCalib({ x: 0, z: 0, yaw: 0 });
      continue;
    }
    const ax = Math.abs(gp.axes[2]) > AR_CALIB_DEAD ? gp.axes[2] : 0;
    const ay = Math.abs(gp.axes[3]) > AR_CALIB_DEAD ? gp.axes[3] : 0;
    if (src.handedness === 'right') {
      if (ax) rotateRoomAroundUser(-ax * AR_CALIB_TURN, head);
    } else {
      // El desplazamiento va en el marco del usuario: "adelante" es hacia donde
      // mira, no hacia -Z del origen de la sesión.
      const fwd = -ay;                        // el eje Y del joystick da adelante = negativo
      const c = Math.cos(hy), s = Math.sin(hy);
      roomGroup.position.x += (-s * fwd + c * ax) * AR_CALIB_MOVE;
      roomGroup.position.z += (-c * fwd - s * ax) * AR_CALIB_MOVE;
    }
  }
  if (active) roomGroup.updateMatrixWorld(true);   // los panners la leen ya movida
  // Al soltar el grip se da por buena la posición y se guarda.
  if (arCalibrating && !active) { saveARCalib(); toast('Calibración guardada'); }
  arCalibrating = active;
}

// Coloca un objeto por stem alrededor del usuario (usando su az/el) y lo vincula
// al motor: a partir de aquí el panner de ese stem sigue la posición del objeto.
function buildARSources() {
  clearARSources();
  if (!engine || !stemDefs.length) return;
  // La calibración va antes que los marcadores: bindStemToObject lee la
  // matrixWorld en el momento de vincular, y esa ya debe ser la de la sala
  // colocada (si no, el primer frame suena en el sitio equivocado).
  applyARCalib(loadARCalib());
  roomGroup.updateMatrixWorld(true);
  stemDefs.forEach((s, i) => {
    const m = makeSourceMarker(s.name);
    const p = arPosition(s);
    m.position.fromArray(p);
    roomGroup.add(m);
    m.updateMatrixWorld(true);          // matrixWorld válido antes de leerla en bind
    engine.bindStemToObject(i, m);
    arSources.push(m);
    // Después del bind: la malla es decorado y no debe estar en el camino de lo
    // que suena. `-p[1]` baja del punto de audio al suelo de la sala.
    attachMeshTo(m, s.mesh || arCfg.mesh, -p[1]);
  });
}

function clearARSources() {
  for (const m of arSources) roomGroup.remove(m);
  arSources = [];
  // Fuera las luces con las mallas: en el 360 no hay nada que iluminar y una luz
  // de más es trabajo del shader por cada fotograma que nadie ve.
  if (arLights) scene.remove(arLights);
  // El foco indexa este array: dejarlo vivo señalaría a un músico que ya no está.
  resetARFocus();
  // soltar las anclas: las fuentes vuelven a la esfera solidaria a la cabeza,
  // que es la geometría del 360 al que estamos regresando
  if (engine) for (let i = 0; i < engine.stemCount; i++) engine.unbindStem(i);
}

async function enterAR() {
  if (!navigator.xr) return toast('WebXR AR no disponible');
  try {
    if (arSession) { await arSession.end(); return; }

    arSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['hand-tracking'],
    });
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(arSession);
    // 'room': mismo marco que stem.ar y que las posiciones que publicarán las cámaras.
    if (telemetry) { telemetry.meta.mode = 'ar'; telemetry.meta.frame = 'room'; telemetry.start(); }
    renderer.setClearAlpha(0);                    // deja ver el passthrough
    document.getElementById('ar-btn').textContent = 'EXIT AR';

    if (sphere) sphere.visible = false;           // el mundo real sustituye al 360
    if (closeupMesh) { closeupMesh.visible = false; closeupStem = -1; }   // sin close-ups en AR

    // En AR cada fuente debe oírse desde su sitio (no solo al "mirar + zoom"):
    // subimos restGain a tope y anulamos el boost por zoom; la espacialización y
    // la distancia las modela el PannerNode HRTF.
    //
    // Y bajamos el bed: en 360 es el concierto entero, pero en passthrough
    // compite con la sala real y tapa a los músicos anclados. No sirve el duck
    // del spotlight (con zoom 0 el peso de todo stem es 0, así que nunca actúa):
    // va por setBedLevel, que el bucle de render no reescribe.
    if (engine) {
      arPrevSpot = engine.getSpotlightParams();
      arPrevBed  = engine.getBedLevel();
      engine.setZoomNormalized(0);
      engine.setSpotlightParams({ restGain: 1 });
      engine.setBedLevel(arCfg.bedGain != null ? arCfg.bedGain : AR_BED_GAIN);
    }
    // Después del bloque de arriba: los dos escriben ganancias en el motor, y
    // hacerlo antes sería calcularlas con el restGain del 360 para pisarlas acto
    // seguido. El foco arranca suelto en cada sesión: entrar en AR no debe heredar
    // al músico que se estuviera mirando en la anterior.
    loadARFocusCfg();                             // ar.focus de la escena, si lo trae
    resetARFocus();
    buildARSources();

    arSession.addEventListener('end', () => {
      // ?arperf=1: el resumen se enseña aquí, que es cuando vuelve a haber pantalla.
      if (ARPERF) {
        arPerfPanelClear();
        arPerfDump();
        console.log('[arperf] ventanas:', window.__arperf);
      }
      telemetry?.stop();
      // Vuelve la esfera, así que vuelve a hacer falta la imagen.
      if (AR_CUT_VIDEO) setVideoDisabled(false).catch(e => console.warn('[ar] restaurar vídeo:', e));
      if (arCalibrating) { saveARCalib(); arCalibrating = false; }   // salir con el grip apretado
      resetARFocus();          // suelta el realce: el músico enfocado no puede
      clearARSources();        // seguir 6 dB arriba en el 360 al que se vuelve
      renderer.setClearAlpha(1);
      if (sphere) sphere.visible = true;
      if (engine && arPrevSpot) engine.setSpotlightParams(arPrevSpot);
      if (engine && arPrevBed != null) engine.setBedLevel(arPrevBed);
      arSession = null;
      document.getElementById('ar-btn').textContent = 'AR';
      renderer.setAnimationLoop(null);
      requestAnimationFrame(renderLoop);
    });

    renderer.setAnimationLoop((time, frame) => {
      // La esfera del 360 está oculta en passthrough, así que su textura no se
      // dibuja: marcarla sucia cada frame solo sirve para que el día que se
      // vuelva a ver suba un fotograma viejo. El <video> sigue corriendo igual
      // (es el mismo elemento del que sale el audio).
      if (sphere && sphere.visible && videoEl && videoEl.readyState >= 2 && videoTexture)
        videoTexture.needsUpdate = true;
      const _p0 = ARPERF ? performance.now() : 0;
      if (frame) {
        const refSpace = renderer.xr.getReferenceSpace();
        const pose = refSpace && frame.getViewerPose(refSpace);
        if (pose) {
          engine?.setRotationFromMatrix4(pose.transform.matrix);  // orientación + posición de cabeza
          updateARCalib(frame.session, pose);                     // recolocar la sala (grip + joysticks)
          // La sala solo se mueve mientras se calibra, y es entonces cuando su
          // matriz tiene que estar al día en el propio frame: la leen worldToLocal
          // y los panners, que siguen la matrixWorld de los marcadores. El resto
          // del tiempo ya la refresca el render, y forzarla aquí era repetir el
          // recorrido del subárbol 72 veces por segundo para nada.
          if (arCalibrating) roomGroup.updateMatrixWorld(true);
          engine?.update();                                       // panners siguen a los objetos anclados
          const _p1 = ARPERF ? performance.now() : 0;

          // Telemetría: pose de cabeza en coordenadas de sala + músico mirado.
          // El zoom sigue siendo 0: en AR no existe, y mandar otra cosa mentiría
          // al consumidor sobre en qué rango leer `z`.
          const [tp, tq] = arTelemetryPose(pose);
          telemetry?.sample(tp, tq, 0, updateARFocus(time), videoEl?.currentTime || 0);
          if (ARPERF) {
            _perf.audio += _p1 - _p0; _perf.focus += performance.now() - _p1;
            arPerfPanelPlace(pose);      // el panel sigue a la cabeza
          }
        }
      }
      // Sin updateAmbiViz(): es un canvas 2D del HUD de la página, que en sesión
      // inmersiva no se compone y por tanto nadie ve. Cuesta cuatro lecturas de
      // analyser y un bucle sobre el buffer entero (getDominantDirection) en cada
      // frame, en el hilo principal, para no dibujar nada. Al salir de AR vuelve
      // el bucle de escritorio y se repinta solo.
      const _p2 = ARPERF ? performance.now() : 0;
      renderer.render(scene, camera);
      if (ARPERF) {
        const end = performance.now(), total = end - _p0;
        _perf.render += end - _p2; _perf.sum += total; _perf.n++;
        if (total > _perf.worst) {
          _perf.worst = total;
          // El reparto del PEOR frame es lo que dice dónde se fue el tiempo.
          _perf.worstAt = `audio ${(_p2 - _p0).toFixed(1)} / render ${(end - _p2).toFixed(1)}`;
        }
        arPerfReport(end);
      }
    });

    if (videoEl) videoEl.play();
    if (audioEl) audioEl.play().catch(() => {});
    if (audioCtx) audioCtx.resume();
    toast(`AR · ${arSources.length} fuentes · grip + joystick para alinear la sala`);
    // El panel no tiene nada que enseñar hasta cerrar la primera ventana de 2 s.
    // Sin este cartel, esos dos segundos se leen como "?arperf=1 no funciona".
    if (ARPERF) { arPerfPanelDraw(['[arperf] midiendo…', '', 'primera ventana en 2 s', '']); }
    // Después de arrancar la sesión: la recarga corta el audio un instante y es
    // menos molesta con el passthrough ya puesto que retrasando la entrada.
    if (AR_CUT_VIDEO) {
      setVideoDisabled(true)
        .then(() => toast('vídeo 360 desactivado en AR'))
        .catch(e => { console.warn('[ar] cortar vídeo:', e); toast('no se pudo cortar el vídeo: ' + e.message); });
    }

  } catch (e) {
    toast('Error WebXR AR: ' + e.message);
    console.error(e);
    arSession = null;
  }
}

// ══════════════════════════════════════════════════════
// DRAG & DROP
// ══════════════════════════════════════════════════════
const dz = document.getElementById('drop-zone');
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => {
  e.preventDefault();
  dz.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) startManifest(URL.createObjectURL(file));
});

// ══════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════
function hideLoader() {
  const l = document.getElementById('loader');
  l.style.opacity = '0';
  setTimeout(() => l.style.display = 'none', 500);
}

function showSpinner(v) {
  document.getElementById('spinner').classList.toggle('show', v);
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

window.addEventListener('keydown', e => {
  switch(e.code) {
    case 'Space':      e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft':  skipBack(); break;
    case 'ArrowRight': skipFwd(); break;
    case 'KeyM':       toggleMute(); break;
    case 'KeyF':       toggleFS(); break;
    case 'KeyR':       resetView(); break;
  }
});

document.addEventListener('click', () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
});

// ══════════════════════════════════════════════════════
// EXPONER HANDLERS AL HTML
// Este <script> es un módulo (scope propio): los `onclick="..."` del HTML
// necesitan que estas funciones estén en `window`.
// ══════════════════════════════════════════════════════
Object.assign(window, {
  loadFromURL, loadFile, seekTo, togglePlay, skipBack, skipFwd,
  toggleMute, setVolume, resetView, toggleFS, enterXR, enterAR,
});

// ══════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════
// Prerrellenar la URL del manifest con la del propio servidor (cómodo en VR,
// donde escribir es un suplicio). Override con ?src=<url>.
{
  const _src = new URLSearchParams(location.search).get('src');
  document.getElementById('video-url-input').value =
    _src || (location.origin + '/encoded/manifest.mpd');
}

initThree();
