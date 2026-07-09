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
let arPrevSpot = null;               // spotlight previo (restaurar al salir de AR)
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
  sphere = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x111111 }));
  sphere.position.set(0, 0, 0);  // centrada en el origen
  scene.add(sphere);

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
  renderer.render(scene, camera);
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
    let _stems = null, _spot = null;
    try {
      const _r = await fetch('/scene.json', { cache: 'no-store' });
      if (_r.ok) {
        const _sc = await _r.json();
        if (Array.isArray(_sc.stems) && _sc.stems.length)
          _stems = _sc.stems.map(s => ({
            azimuthDeg: +s.azimuthDeg || 0, elevationDeg: +s.elevationDeg || 0,
            name: s.name, closeup: s.closeup || null }));
        if (_sc.spotlight) _spot = _sc.spotlight;
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

    engine = new ImmersiveAudioEngine({ order: 1, renderer: _renderer, stems: _stems });
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
      toast(`${_stems.length} stems · spotlight en zoom`);
    }

    // Alineación audio↔vídeo desde la URL (ajustable en el visor sin recompilar):
    //   ?ayaw=90    → offset de azimut en grados (prueba 90 / 180 / -90 / 45…)
    //   ?amirror=1  → espejo izquierda/derecha
    const _p = new URLSearchParams(location.search);
    const _ayaw = parseFloat(_p.get('ayaw') || '0') || 0;
    const _amirror = _p.get('amirror') === '1';
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

    if (telemetry) { telemetry.meta.mode = 'vr'; telemetry.start(); }

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
            engine?.setZoomNormalized(xrZoomDist / 40);
            updateCloseupFocus();   // close-up del músico enfocado (joystick zoom)

            // Telemetría: pose de cabeza + zoom/foco (decimado a rateHz en la clase).
            // pos/q son referencias de la pose ya leída → sin coste por frame.
            telemetry?.sample(pos, q, xrZoomDist, closeupStem, videoEl?.currentTime || 0);

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
const AR_RADIUS = 1.6;    // distancia de colocación inicial (m)
const AR_HEIGHT = 1.3;    // altura base de los objetos (m)

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
function makeSourceMarker(name) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.08, 1),
    new THREE.MeshBasicMaterial({ color: 0x00d4ff, wireframe: true })));
  g.add(makeLabelSprite(name));
  return g;
}

// Coloca un objeto por stem alrededor del usuario (usando su az/el) y lo vincula
// al motor: a partir de aquí el panner de ese stem sigue la posición del objeto.
function buildARSources() {
  clearARSources();
  if (!engine || !stemDefs.length) return;
  const D2R = Math.PI / 180;
  stemDefs.forEach((s, i) => {
    const az = (s.azimuthDeg || 0) * D2R, el = (s.elevationDeg || 0) * D2R;
    const ce = Math.cos(el), se = Math.sin(el);
    // misma convención que el motor: frente = −Z, izquierda = −X, arriba = +Y.
    const dir = [-ce * Math.sin(az), se, -ce * Math.cos(az)];
    const m = makeSourceMarker(s.name);
    m.position.set(dir[0] * AR_RADIUS, AR_HEIGHT + dir[1] * AR_RADIUS, dir[2] * AR_RADIUS);
    scene.add(m);
    m.updateMatrixWorld(true);          // matrixWorld válido antes de leerla en bind
    engine.bindStemToObject(i, m);
    arSources.push(m);
  });
}

function clearARSources() {
  for (const m of arSources) scene.remove(m);
  arSources = [];
  // soltar las vinculaciones del motor (conserva la última posición)
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
    if (telemetry) { telemetry.meta.mode = 'ar'; telemetry.start(); }
    renderer.setClearAlpha(0);                    // deja ver el passthrough
    document.getElementById('ar-btn').textContent = 'EXIT AR';

    if (sphere) sphere.visible = false;           // el mundo real sustituye al 360
    if (closeupMesh) { closeupMesh.visible = false; closeupStem = -1; }   // sin close-ups en AR

    // En AR cada fuente debe oírse desde su sitio (no solo al "mirar + zoom"):
    // subimos restGain a tope y anulamos el boost por zoom; la espacialización y
    // la distancia las modela el PannerNode HRTF.
    if (engine) {
      arPrevSpot = engine.getSpotlightParams();
      engine.setZoomNormalized(0);
      engine.setSpotlightParams({ restGain: 1 });
    }
    buildARSources();

    arSession.addEventListener('end', () => {
      telemetry?.stop();
      clearARSources();
      renderer.setClearAlpha(1);
      if (sphere) sphere.visible = true;
      if (engine && arPrevSpot) engine.setSpotlightParams(arPrevSpot);
      arSession = null;
      document.getElementById('ar-btn').textContent = 'AR';
      renderer.setAnimationLoop(null);
      requestAnimationFrame(renderLoop);
    });

    renderer.setAnimationLoop((time, frame) => {
      if (videoEl && videoEl.readyState >= 2 && videoTexture) videoTexture.needsUpdate = true;
      if (frame) {
        const refSpace = renderer.xr.getReferenceSpace();
        const pose = refSpace && frame.getViewerPose(refSpace);
        if (pose) {
          engine?.setRotationFromMatrix4(pose.transform.matrix);  // orientación + posición de cabeza
          engine?.update();                                       // panners siguen a los objetos anclados

          // Telemetría: pose de cabeza en AR passthrough (sin zoom/foco).
          telemetry?.sample(pose.transform.position, pose.transform.orientation,
                            0, -1, videoEl?.currentTime || 0);
        }
      }
      updateAmbiViz();
      renderer.render(scene, camera);
    });

    if (videoEl) videoEl.play();
    if (audioEl) audioEl.play().catch(() => {});
    if (audioCtx) audioCtx.resume();
    toast(`AR · ${arSources.length} fuentes ancladas`);

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
