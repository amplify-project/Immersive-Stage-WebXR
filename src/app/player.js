import { ImmersiveAudioEngine } from '../audio/ImmersiveAudioEngine.js';
import { Telemetry } from '../telemetry/Telemetry.js';
import { RayPointer, XRMenu, RAY_CONE } from './xr-input.js';
import { CloseupWC } from './closeup-wc.js';

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
// ¿Sabe el navegador avisar de cada fotograma nuevo? Chrome y el de la Quest sí.
const HAS_RVFC = typeof HTMLVideoElement !== 'undefined' &&
                 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

// RepresentationID del 360 en los manifests de stream.sh: mapea `-map 0:v:0`
// primero, así que la esfera es siempre la 0 y los close-ups van del 1 en
// adelante (ver "AdaptationSets dinámicos" en stream.sh).
const SPHERE_REP = '0';

// Close-ups (Caso B): plano flotante con el vídeo del músico enfocado.
let closeupTexture = null, closeupMesh = null;
let closeupReady = false;            // hay pistas de close-up en el manifest
let closeupStem  = -1;               // stem cuya PISTA está seleccionada (-1 = ninguna)
let closeupWant  = -1;               // stem que pide el foco: destino de la transición
let closeupArmed = -1;               // stem precargado: decodificando pero aún sin verse
let closeupArmCand = -1;             // candidato a precargar, aún sin cumplir la espera
let closeupArmSince = 0;             // desde cuándo es el candidato (performance.now)
let closeupFade  = 0;                // 0..1, cuánto ha entrado el panel
let closeupLastT = 0;                // reloj de la transición (performance.now, ms)
let closeupRepByStem = {};           // índice de stem → RepresentationID del MPD
// RepresentationID → where that close-up was cut from the 360 ({azimuthDeg,
// elevationDeg, hFovDeg, vFovDeg}, from closeups.json), for the crops only. A
// crop is shown ON the sphere, over the very patch it came from; a close-up
// video is shown on the floating panel.
let closeupCropByRep = {};
let closeupPlaced = undefined;       // what the mesh is placed for ('<stem>:panel|crop'), undefined = re-place
// The close-up's frames come from WebCodecs (CloseupWC), slaved to the 360's
// clock, when the browser has VideoDecoder; otherwise from a second Shaka on
// closeupEl, kept in step by the sync loop. ?cuwc=0 forces the second.
let closeupWC = null;
const CU_WC = new URLSearchParams(location.search).get('cuwc') !== '0';
// Tap on the close-up: a bit more zoom. A panel grows by this factor; a crop
// (on the sphere) takes the VR zoom further, or the desktop FOV narrower.
let closeupZoom = 1, closeupZoomGoal = 1, cuDeskFov = null;
const CLOSEUP_MORE = 1.6;
const VR_PINCH_ZOOM_MORE = 62;
const CLOSEUP_TARGET = 999;          // what the pointer's pick returns for the close-up itself

// Transición del close-up: ni aparece ni desaparece de golpe. Entra subiendo
// opacidad y escala a la vez —el panel "se acerca" en vez de encenderse— y sale
// por el mismo camino. Un cuarto de segundo es suficiente para que no dé un
// respingo y poco para que no llegue tarde a lo que estás mirando.
const CLOSEUP_FADE_S   = 0.25;
// Close-up ↔ 360 sync (see the sync loop): error in seconds, + = close-up ahead.
//   err 0.1 s → 15% faster/slower; capped at 30%, so 0.5 s is made up in ~2 s.
//   Within `dead` (about one frame at 24-30 fps) nothing is touched.
// Runs in the 250 ms sync loop shared with the audio controller (tuned for
// that tick, so it is not changed for this).
const CLOSEUP_SYNC = { dead: 0.03, kp: 1.5, cap: 0.3, hardSeek: 1.5 };
const CLOSEUP_SCALE_IN = 0.92;       // escala con la que entra y a la que se va

// Histéresis del foco: hace falta un peso de ENTER para sacar el panel, pero
// basta EXIT para mantenerlo. Con un solo umbral, un peso que oscile alrededor
// de él enciende y apaga el close-up cada pocos frames, y la mirada oscila
// siempre: nadie sostiene la cabeza tan quieta.
const CLOSEUP_ENTER = 0.35;
const CLOSEUP_EXIT  = 0.20;

// Y el candidato a PRECARGAR no se acepta hasta que se sostiene. La mirada roza
// el umbral sin parar, y cada cambio de armado es un pause/play sobre el
// elemento de vídeo —y, si la pista llevaba parada más de medio segundo, además
// un salto de currentTime, que vacía el decodificador. A 60 Hz eso no es
// precargar: es una tormenta que tira la reproducción entera.
const CLOSEUP_ARM_DWELL_S = 0.4;
let engine     = null;               // ImmersiveAudioEngine (motor de audio)
let audioCtx   = null, gainNode = null;  // referencias derivadas del engine
let xrSession  = null;
let arSession  = null;               // sesión WebXR immersive-ar (passthrough)
let arSources  = [];                 // Object3D por stem, anclados en la sala
let arMeshAnims = [];                // MeshFit.animator() por malla animada (se mueven con el medio)
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
// Ray and pinch (src/app/xr-input.js). In VR, a pinch on a musician zooms in
// to THEM: the sphere moves along that musician's direction, not along the
// head's, so the zoom stays on them while you look around, and their close-up
// shows. A pinch on nothing zooms back out. The joystick still works and
// cancels the goal.
let xrZoomGoal = null;               // target xrZoomDist set by a pinch, or null
let xrZoomStem = -1;                 // musician zoomed in by a pinch, or -1
let xrZoomDir  = null;               // THREE.Vector3 the sphere moves along; null = the head's forward
// Whether the zoom moves the 360 sphere. A pinch on a musician whose close-up
// is a panel does NOT: the picture jumping under you while you look at it
// confused people, and the panel already is the "closer" view. So the zoom
// there is only audio (spotlight) + the panel, and the 360 stays put. A crop
// close-up still needs it (it lies on the sphere), and so does the stick.
// ?vrzoom=move brings back moving the sphere on every pinch.
const VR_ZOOM_MOVE = new URLSearchParams(location.search).get('vrzoom') === 'move';
let xrZoomMoves = true;
// The musician the pinch zoom's audio spotlight belongs to. It outlives
// xrZoomStem through the zoom-out, so the soloist fades with the zoom instead of
// switching to whoever the head happens to face on the way out.
let xrSpotStem = -1;
const xrZoomDirGoal = [0, 0, -1];    // where xrZoomDir is easing to
// A pinch zoom is a tween of fixed duration from where it was (distance and
// direction) to where it is going, on an ease-in-out curve: it starts and lands
// softly and always takes the same time. The exponential ease it replaces
// lurched off fast and then crept the last metres, which is when the close-up
// crop fades in — the part that most needs to be smooth.
let xrZoomFrom = 0, xrZoomT0 = 0;
const xrZoomDirFrom = new THREE.Vector3(0, 0, -1);
function xrZoomTo(goal) {
  xrZoomFrom = xrZoomDist;
  xrZoomT0 = performance.now();
  if (xrZoomDir) xrZoomDirFrom.copy(xrZoomDir);
  xrZoomGoal = goal;
}
let xrLastT    = 0;                  // XR frame clock for the zoom easing (ms)
let pointer = null, xrMenu = null;
let xrLastPose = null;               // viewer pose of the last XR frame (to place the menu)
let xrPending  = null;               // 'vr' | 'ar': mode to enter once the current session has ended
let vrOk = false, arOk = false;      // what this browser/headset supports (checkWebXR)
const _zoomFwd = new THREE.Vector3(), _zoomQ = new THREE.Quaternion();   // per-frame temps
// Perf experiments (the ray costs frames on the Quest; these isolate why):
//   ?nojoints=1  do not request 'hand-tracking'. Hands should still give a ray
//                and pinch, just without the 25 joint poses per hand per frame,
//                which we no longer read.
//   ?noray=1     keep the ray logic (pick, pinch, menu) but draw nothing.
const XR_NO_JOINTS = new URLSearchParams(location.search).get('nojoints') === '1';
const XR_NO_RAY    = new URLSearchParams(location.search).get('noray') === '1';
//   ?aim=hand    aim with each hand's system ray instead of the head (default:
//                look at a musician and pinch).
const XR_AIM       = new URLSearchParams(location.search).get('aim') === 'hand' ? 'hand' : 'head';
const HAND_FEATS   = XR_NO_JOINTS ? [] : ['hand-tracking'];

// Headroom experiments. With hands in view and the head turning fast, the
// Quest's own hand tracking competes with us for the same CPU/GPU, and the
// 4K decode already takes most of it. We cannot make the tracking cheaper, only
// leave it room:
//   ?xrfps=72    ask for 72 Hz instead of 90: 13.9 ms per frame instead of
//                11.1, and a steady 72 looks better than 90 dropping to 50.
//   ?fovea=1     fixed foveated rendering, 0..1: fewer pixels shaded at the
//                edges of the lenses, where they are blurred anyway.
//   ?xrscale=0.8 render the eye buffers at 80% resolution.
const _xrq = new URLSearchParams(location.search);
const XR_FPS   = Number(_xrq.get('xrfps')) || 0;
const XR_FOVEA = _xrq.has('fovea') ? Math.min(1, Math.max(0, Number(_xrq.get('fovea')) || 0)) : null;
const XR_SCALE = Number(_xrq.get('xrscale')) || 0;

// Before setSession: the framebuffer scale is read when the layer is made.
function xrHeadroomBefore() {
  if (XR_SCALE > 0) renderer.xr.setFramebufferScaleFactor(XR_SCALE);
}

// After setSession: the layer exists, and so does the session's frame rate.
function xrHeadroomAfter(session) {
  const layer = session.renderState && session.renderState.baseLayer;
  if (XR_FOVEA != null && layer && 'fixedFoveation' in layer) layer.fixedFoveation = XR_FOVEA;
  if (XR_FPS && session.updateTargetFrameRate) {
    const rates = session.supportedFrameRates ? Array.from(session.supportedFrameRates) : [];
    // The nearest rate the headset offers: asking for one it lacks rejects.
    const want = rates.length ? rates.reduce((a, b) => Math.abs(b - XR_FPS) < Math.abs(a - XR_FPS) ? b : a) : XR_FPS;
    session.updateTargetFrameRate(want).catch(e => console.warn('[xr] frame rate:', e.message));
  }
  console.log('[xr] headroom: fps', XR_FPS || 'default', '· fovea', XR_FOVEA ?? 'default',
              '· scale', XR_SCALE || 1, '· rates', session.supportedFrameRates ? Array.from(session.supportedFrameRates).join('/') : '?');
}
const VR_PINCH_ZOOM = 40;            // where a pinch zooms to: full spotlight boost (see zoomN)
const VR_ZOOM_S     = 0.8;           // s: how long a pinch zoom (in or out) takes
let telemetry    = null;             // Telemetry: pose de cabeza → relay externo (opt-in)
let telemetryCfg = null;             // bloque telemetry de scene.json
let voice        = null;             // VoiceRecorder: micro del participante → /voice (opt-in)
let voiceCfg     = null;             // bloque voice de scene.json
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
  // Espacio de color de salida (ver src/app/mesh-fit.js → Colour). Va aquí y no
  // en las mallas porque es del renderer entero: a partir de esta línea TODA
  // textura que lleve píxeles sRGB tiene que declararlo, o sale codificada dos
  // veces. Las nuestras son el vídeo (makeVideoTexture) y los canvas de texto.
  MeshFit.setupRenderer(renderer);

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
  sphere = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: MeshFit.colour(0x111111) }));
  sphere.position.set(0, 0, 0);  // centrada en el origen
  scene.add(sphere);

  // Marco de sala: de él cuelgan las fuentes ancladas en AR. Su transformada ES
  // la calibración (ver applyARCalib), así que moverlo mueve a la vez los
  // marcadores y sus panners, que siguen la matrixWorld.
  // El marco compartido entre cascos (ver SHAREDSPACE). Sin él es la identidad y
  // esto es exactamente lo de siempre: roomGroup colgando de la escena.
  sharedGroup = new THREE.Group();
  sharedGroup.matrixAutoUpdate = false;   // su matriz la pone la pose, no un TRS
  scene.add(sharedGroup);

  roomGroup = new THREE.Group();
  sharedGroup.add(roomGroup);

  // Close-up (Caso B): plano 16:9 ~2.5 m delante de la cámara. Como es hijo de
  // la cámara, queda siempre centrado en la vista (escritorio y XR). Oculto
  // hasta que se enfoca a un músico que tenga close-up.
  closeupMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2.0, 1.125),
    new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, opacity: 0 }));
  closeupMesh.position.set(0, 0, -2.5);
  closeupMesh.renderOrder = 999;       // por encima de la esfera 360
  closeupMesh.visible = false;
  camera.add(closeupMesh);
  scene.add(camera);                   // necesario para que los hijos se rendericen

  // Hands-free input for both XR modes; nothing of it shows on desktop.
  xrMenu = new XRMenu(scene, xrMenuChoose);
  pointer = new RayPointer(scene, {
    pick: (o, d) => pickStem(o, d),
    targetPos: xrStemWorldPos,
    onTap: xrSelect,
    onHold: xrOpenMenu,
    menu: xrMenu,
    grab: markGrabXR,
    hidden: XR_NO_RAY,
    aim: XR_AIM,
    targetDir: xrStemDirFrom,
  });

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  setupStemMarkMouse();          // before the view's handlers: it claims clicks on a ring
  setupCloseupClick();
  setupPointerControls();
  setupGyro();
  checkWebXR();
  initDebugPanel();
  renderLoop();
}

// ══════════════════════════════════════════════════════
// TELEMETRY MODES — screen (desktop/tablet), vr, ar
// ══════════════════════════════════════════════════════
// Every mode puts p/q in a different frame, and the relay reads the frame from
// the hello. So a switch is stop() + start(), not a meta patch: stop() flushes
// the samples taken under the old mode and drops what could not be sent, and the
// new connection's hello carries the new frame before any sample in it.
const TELEMETRY_MODES = {
  screen: { frame: 'screen' },        // the 360 view on a screen: q only, p = 0
  vr:     { frame: 'local-floor' },   // the headset's own floor (see arTelemetryPose)
  ar:     { frame: 'room' },          // same frame as stem.ar
};
let telemetryScreen = false;          // screen mode enabled for this page

function screenInput() {
  if (useGyro) return 'gyro';
  return matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
}

function telemetrySetMode(mode) {
  if (!telemetry) return;
  if (mode === 'screen') telemetryScreen = true;
  telemetry.stop();
  Object.assign(telemetry.meta, {
    mode, frame: TELEMETRY_MODES[mode].frame,
    input: mode === 'screen' ? screenInput() : 'xr',
    rec: voice?.recRef || null,   // en el hello, que es donde el relay lee el meta
  });
  telemetry.start();
}

// Leaving VR/AR: back to the screen view if this page reports it, else silence.
function telemetryLeaveXR() {
  if (telemetryScreen) telemetrySetMode('screen');
  else telemetry?.stop();
}

// The view on a screen has no head position: p is the centre of the sphere,
// where the camera sits. q is the camera's orientation (mouse/touch drag or the
// gyroscope), z the FOV zoom on the same 0..1 scale VR reports.
const _telScreenP = { x: 0, y: 0, z: 0 };
function sampleScreenTelemetry() {
  if (!telemetry || telemetry.meta.mode !== 'screen') return;
  telemetry.sample(_telScreenP, camera.quaternion, engine?.getZoomNormalized() ?? 0,
                   engine?.getFocusedStem(0.3) ?? -1, videoEl?.currentTime || 0);
}

// ══════════════════════════════════════════════════════
// RENDER LOOP
// ══════════════════════════════════════════════════════
function renderLoop(time) {
  const desk = !renderer.xr.isPresenting;
  // ?arperf=1 also measures the flat page: on the Quest the 2D page plays the
  // video sluggishly while VR is smooth, and only the same trace in both modes
  // says which part differs.
  const _p0 = (ARPERF && desk && time) ? perfDeskStart(time) : 0;
  if (desk) {
    requestAnimationFrame(renderLoop);
    applyRotation();
    sampleScreenTelemetry();
  }
  if (videoEl && videoEl.readyState >= 2) {
    if (videoTexture && !HAS_RVFC) videoTexture.needsUpdate = true;
    updateProgress();
  }
  updateCloseupAnim();
  updateAmbiViz();
  updateSpotLog();
  updateStemMarks();
  const _p2 = _p0 ? perfRenderBegin() : 0;
  renderer.render(scene, camera);
  if (_p0) perfFrameEnd(_p0, _p2, time);
}

function perfDeskStart(time) {
  if (_trace.mode !== '2d') { _perf.t0 = _perf.lastT = 0; perfTraceStart('2d'); }
  return perfFrameStart(time);
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
let ARPERF = new URLSearchParams(location.search).get('arperf') === '1';

// ?synclog=1 — el error de sincronía, DENTRO de las gafas.
//
// `syncDiag()` se lee en la consola, y en sesión inmersiva no hay consola: el
// número que dice si dos cascos van juntos es justo el que no se puede mirar
// cuando hay dos cascos puestos.
//
// Va al mismo sprite en VR y en AR. El panel XR DEBUG de más abajo parecía el
// sitio natural en VR, pero `initDebugPanel()` empieza con un `return`: lleva
// desactivado desde hace tiempo y escribir ahí no enseña nada. El sprite,
// además, es lo que queremos: mira siempre a la cámara y se recoloca cada frame,
// así que girarse no lo deja atrás. Se comparte con ?arperf=1 y con los avisos
// del ancla —dos carteles delante de la cara no caben—, así que espera detrás de
// un aviso y se aparta entero si ?arperf=1 pide el mismo sitio.
//
// Cómo se lee: `err` es contra la SESIÓN, no contra el otro casco. Leídos los dos
// a la vez, la resta es el desfase entre ellos. Y `lead` es lo que el controlador
// ha medido que cuesta un seek en ESTE aparato — en escritorio son ~640 ms, y si
// en la Quest sale otra cosa o no para quieto, ahí está la respuesta a si el que
// llega tarde aterriza donde debe.
const SYNCLOG = new URLSearchParams(location.search).get('synclog') === '1';

// ?sharedspace=1 — un marco común entre cascos, sin calibrar cada uno el suyo.
//
// Hoy `roomGroup` guarda la calibración {x, z, yaw} en el `local-floor` de ESTE
// casco, que es distinto en cada uno: por eso cada persona tiene que alinear la
// sala a mano. El navegador de la Quest sabe dar un marco común a los cascos de
// una misma habitación (feature `shared`), y con él la misma T significa lo
// mismo en todos.
//
// La montamos SIN quitarle a three su reference space, que en la r128 no se
// puede cambiar: `roomGroup` pasa a colgar de `sharedGroup`, cuya matriz es
// `frame.getPose(espacio compartido, mi local-floor)` — o sea, dónde cae el
// origen común en mi marco. Esa S es distinta en cada casco; la T de dentro es
// la misma para todos, y es la que habrá que repartir por el relay (Caso C).
//
// Recalcular S cada frame sale casi gratis y además se come el `reset` que el
// navegador dispara a los pocos segundos —cambia coordenadas y UUID— sin
// tratarlo como caso especial: la sala simplemente sigue al origen nuevo.
//
// Hace falta el flag del navegador (chrome://flags → "WebXR experiments") Y el
// permiso del sistema en cada casco (Settings → Privacy → Device Permissions →
// Enhanced Spatial Services), porque por debajo son los Shared Spatial Anchors.
const SHAREDSPACE = new URLSearchParams(location.search).get('sharedspace') === '1';

// ?sharedlog=1 — the shared-frame readout in the headset: the panel (uuid, pose
// and null counts, resets, S) and the magenta cube with axes at the common
// origin. They are how you judge whether the frame is right, and they get in the
// way once it is, so they come only when asked for. Needs ?sharedspace=1.
const SHAREDLOG = SHAREDSPACE && new URLSearchParams(location.search).get('sharedlog') === '1';
let sharedGroup = null;      // S: origen compartido → mi local-floor
let arSharedSpace = null;    // el XRReferenceSpace de tipo 'shared'
let arViewerSpace = null;    // 'viewer', el puente para leer el marco común
let sharedActive = false;
// Salud del marco: sin esto, "la sala está girada" no distingue entre no haber
// tenido nunca una pose (y estar dibujando en la identidad, o sea en el origen
// de ESTE casco) y tenerla y estar mal.
const _shared = { ok: 0, nulls: 0, resets: 0, everOk: false, yawDeg: 0, lastResetAt: 0,
                  x: 0, z: 0, uuid: '' };

function syncReading() {
  return (window.syncDiag && window.syncDiag()) || null;
}
const _perf = { n: 0, t0: 0, worst: 0, sum: 0, audio: 0, focus: 0, render: 0, worstAt: '', vf0: -1,
                lastT: 0, slow: 0, cf0: -1 };

// ?arperf=1 works in VR too. Two loops share these two helpers, so the numbers
// mean the same in both.
//
// `slow` counts frames that arrived more than 1.5 frame periods after the
// previous one, i.e. frames the headset had to drop or reproject. That is the
// number that matches "it stutters when I turn": our JavaScript can be cheap
// while the GPU or the video decoders miss the frame anyway, and then only the
// interval between frames shows it.
function perfFrameStart(time) {
  if (_perf.lastT) {
    const rate = renderer.xr.getSession()?.frameRate || 72;
    if (time - _perf.lastT > 1.5 * 1000 / rate) _perf.slow++;
  }
  _perf.lastT = time;
  return performance.now();
}

// ── Per-frame trace (?arperf=1) ─────────────────────────────────────────────
// The window summary says THAT frames drop; this says what each dropped frame
// had in common. One row per frame, posted to /api/perflog every 2 s and read
// with tools/perf-analyze.js:
//   dt   interval since the previous frame (ms) — > 1.5 periods = dropped
//   js   our JavaScript before render (ms)
//   rd   renderer.render() on the CPU (ms)
//   gpu  GPU time of renderer.render() (ms), from EXT_disjoint_timer_query_webgl2
//        when the browser exposes it; null otherwise or while still pending
//   v/cu 1 when the 360 / close-up texture was re-uploaded in this frame
//   w    head angular speed (deg/s)
//   dc   draw calls of the frame
// Each window also carries how many hands and controllers were tracked, so
// "hands vs controllers" and "turning vs still" can be split afterwards.
const _trace = { rows: [], session: '', gl: null, ext: null, q: null, pend: [],
                 ev: [], ver: -1, cuVer: -1, qx: 0, qy: 0, qz: 0, qw: 1, lastT: 0, row: null, gpuOk: false };

function perfTraceStart(mode = 'xr') {
  _trace.mode = mode;
  _trace.session = new Date().toISOString().replace(/[:.]/g, '-');
  _trace.rows = []; _trace.pend = []; _trace.ev = []; _trace.lastT = 0;
  _trace.ct0 = videoEl ? videoEl.currentTime : 0; _trace.wall0 = performance.now();
  const gl = _trace.gl = renderer.getContext();
  _trace.ext = (gl.getExtension && gl.getExtension('EXT_disjoint_timer_query_webgl2')) || null;
  _trace.gpuOk = !!_trace.ext && typeof gl.createQuery === 'function';
  const s = renderer.xr.getSession();
  const bl = s && s.renderState && s.renderState.baseLayer;
  const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
  perfPost({ info: {
    ua: navigator.userAgent,
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    gpuTimer: _trace.gpuOk,
    frameRate: s && s.frameRate, supportedFrameRates: s && s.supportedFrameRates && [...s.supportedFrameRates],
    fb: bl ? [bl.framebufferWidth, bl.framebufferHeight] : null,
    foveation: bl && bl.fixedFoveation,
    blend: s && s.environmentBlendMode,
    video: videoEl ? [videoEl.videoWidth, videoEl.videoHeight] : null,
    closeup: closeupEl ? [closeupEl.videoWidth, closeupEl.videoHeight] : null,
    url: location.search, mode,
    canvas: [renderer.domElement.width, renderer.domElement.height], dpr: devicePixelRatio,
  } });
}

// Segment requests and responses of a Shaka player, with byte counts, on the
// same clock as the frame rows (`t`), so drops can be lined up with downloads.
function perfWatchNet(player, tag) {
  if (!ARPERF) return;
  const ne = player.getNetworkingEngine && player.getNetworkingEngine();
  if (!ne) return;
  const SEG = shaka.net.NetworkingEngine.RequestType.SEGMENT;
  ne.registerRequestFilter((type, req) => {
    if (_trace.ev.length > 500) _trace.ev.shift();   // outside XR nobody flushes
    if (type === SEG) _trace.ev.push({ t: Math.round(performance.now()), k: tag + '>', u: String(req.uris[0]).split('/').pop() });
  });
  ne.registerResponseFilter((type, resp) => {
    if (type === SEG) _trace.ev.push({ t: Math.round(performance.now()), k: tag + '<', u: String(resp.uri).split('/').pop(),
                                       b: resp.data ? resp.data.byteLength : 0 });
  });
}

function perfPost(body) {
  body.session = _trace.session;
  fetch('/api/perflog', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body) }).catch(() => {});
}

// Called right before renderer.render(): opens the GPU query and notes whether
// this render is going to upload a new video frame (three bumps
// texture.version on needsUpdate and uploads at the next draw that uses it).
function perfRenderBegin() {
  const t = performance.now();
  const row = _trace.row = { dt: 0, js: 0, rd: 0, gpu: null, v: 0, cu: 0, w: 0, dc: 0 };
  if (videoTexture && sphere && sphere.visible) {
    row.v = videoTexture.version !== _trace.ver ? 1 : 0; _trace.ver = videoTexture.version;
  }
  if (closeupTexture && closeupMesh && closeupMesh.visible) {
    row.cu = closeupTexture.version !== _trace.cuVer ? 1 : 0; _trace.cuVer = closeupTexture.version;
  }
  if (_trace.gpuOk && !_trace.q) {
    const gl = _trace.gl, q = gl.createQuery();
    gl.beginQuery(_trace.ext.TIME_ELAPSED_EXT, q);
    _trace.q = q; _trace.pend.push({ q, row });
  }
  return t;
}

function perfTraceFrame(time, p0, p2, end) {
  const row = _trace.row; if (!row) return;
  _trace.row = null;
  const gl = _trace.gl;
  if (_trace.q) { gl.endQuery(_trace.ext.TIME_ELAPSED_EXT); _trace.q = null; }
  // Results arrive a few frames later and in order; a disjoint event (GPU
  // frequency change, context switch) invalidates the ones in flight.
  if (_trace.pend.length) {
    const disjoint = gl.getParameter(_trace.ext.GPU_DISJOINT_EXT);
    while (_trace.pend.length) {
      const p = _trace.pend[0];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) p.row.gpu = +(gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6).toFixed(2);
      gl.deleteQuery(p.q); _trace.pend.shift();
    }
    if (_trace.pend.length > 16) {               // never answered: stop asking
      _trace.pend.forEach(p => gl.deleteQuery(p.q)); _trace.pend = []; _trace.gpuOk = false;
    }
  }
  row.t = Math.round(time);
  row.dt = _trace.lastT ? +(time - _trace.lastT).toFixed(1) : 0;
  _trace.lastT = time;
  row.js = +(p2 - p0).toFixed(2); row.rd = +(end - p2).toFixed(2);
  row.dc = renderer.info.render.calls;
  // Close-up vs 360 (ms, + = close-up ahead), while one is on screen.
  if (closeupWC) { if (closeupStem >= 0 && closeupFade > 0 && closeupWC.lagMs != null) row.ce = closeupWC.lagMs; }
  else if (closeupStem >= 0 && closeupFade > 0 && !closeupEl.paused)
    row.ce = Math.round((closeupEl.currentTime - videoEl.currentTime) * 1000);
  // In XR, three r128 copies the head pose into `camera` inside render().
  const q = camera.quaternion;
  const dot = Math.min(1, Math.abs(q.x * _trace.qx + q.y * _trace.qy + q.z * _trace.qz + q.w * _trace.qw));
  if (row.dt) row.w = Math.round((2 * Math.acos(dot) * 180 / Math.PI) / (row.dt / 1000));
  _trace.qx = q.x; _trace.qy = q.y; _trace.qz = q.z; _trace.qw = q.w;
  _trace.rows.push(row);
}

function perfTraceFlush(win) {
  if (!_trace.session) return;
  let hands = 0, pads = 0;
  const s = renderer.xr.getSession();
  if (s) for (const src of s.inputSources) { if (src.hand) hands++; else if (src.gamepad) pads++; }
  const rows = _trace.rows; _trace.rows = [];
  const ev = _trace.ev; _trace.ev = [];
  const g = rows.map(r => r.gpu).filter(x => x != null);
  // Media seconds per wall second: ~1.0 = the video runs at real speed (any
  // sluggishness is in how often the picture is redrawn); < 1 = it really
  // plays slower (stalls, rate control).
  const now = performance.now(), ct = videoEl ? videoEl.currentTime : 0;
  const vrate = videoEl && now > _trace.wall0 ? +((ct - _trace.ct0) / ((now - _trace.wall0) / 1000)).toFixed(3) : null;
  _trace.ct0 = ct; _trace.wall0 = now;
  perfPost({ summary: {
    ...win, hands, pads, mode: _trace.mode, vrate,
    rate: videoEl ? videoEl.playbackRate : null, paused: videoEl ? videoEl.paused : null,
    ready: videoEl ? videoEl.readyState : null,
    gpuAvg: g.length ? +(g.reduce((a, b) => a + b, 0) / g.length).toFixed(2) : null,
    gpuWorst: g.length ? Math.max(...g) : null,
    headMax: rows.reduce((a, r) => Math.max(a, r.w), 0),
    cuErrAvg: (() => { const c = rows.filter(r => r.ce != null); return c.length ? Math.round(c.reduce((a, r) => a + Math.abs(r.ce), 0) / c.length) : null; })(),
    cuErrMax: (() => { const c = rows.filter(r => r.ce != null); return c.length ? Math.max(...c.map(r => Math.abs(r.ce))) : null; })(),
    dropped360: (videoEl && videoEl.getVideoPlaybackQuality) ? videoEl.getVideoPlaybackQuality().droppedVideoFrames : null,
    mem: { tex: renderer.info.memory.textures, geo: renderer.info.memory.geometries },
  }, rows, ev });
}

function perfFrameEnd(p0, p2, time) {
  const end = performance.now(), total = end - p0;
  perfTraceFrame(time, p0, p2, end);
  _perf.render += end - p2; _perf.sum += total; _perf.n++;
  if (total > _perf.worst) {
    _perf.worst = total;
    // El reparto del PEOR frame es lo que dice dónde se fue el tiempo.
    _perf.worstAt = `js ${(p2 - p0).toFixed(1)} / render ${(end - p2).toFixed(1)}`;
  }
  arPerfReport(end);
}

function closeupDecodedFrames() {
  if (closeupWC) return closeupWC.decoded;
  const q = closeupEl && closeupEl.getVideoPlaybackQuality && closeupEl.getVideoPlaybackQuality();
  return q ? q.totalVideoFrames : -1;
}

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
    const tex = MeshFit.srgb(new THREE.CanvasTexture(c));
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

// El informe de sincronía en el sprite de AR, una vez por segundo. La última
// línea la pinta arPerfPanelDraw en verde, y aquí es la que toca: `lead` es el
// dato que venimos a buscar a las gafas.
let _syncPanelAt = 0;
function syncPanelReport(now) {
  if (now - _syncPanelAt < 1000) return;
  _syncPanelAt = now;
  // Con ?sharedspace=1 el panel enseña el marco: es lo que se está mirando, y
  // `pose` a cero con la sala girada dice por sí solo que estamos dibujando en la
  // identidad, o sea en el origen de este casco y no en el común.
  // Los dos flags a la vez: caben cuatro líneas en el sprite y no más, así que la
  // vista conjunta se queda con lo que se mira EN MARCHA —quién soy en el marco y
  // cuánto me separo de la sesión— y suelta los resets y el `lead`, que son de
  // mientras se monta. Cada flag por su cuenta sigue enseñando lo suyo entero.
  if (SHAREDLOG && SYNCLOG) {
    const d = syncReading();
    const uu = _shared.uuid ? _shared.uuid.slice(-6) : 'pending';
    arPerfPanelDraw([
      `shared ${sharedActive ? 'ON' : 'off'} · ${uu}`,
      d ? `sync ${d.errMs}ms x${d.rate.toFixed(4)}` : 'sync: sin ?sync=',
      `pose ${_shared.ok} · null ${_shared.nulls}`,
      `S ${_shared.x.toFixed(2)},${_shared.z.toFixed(2)} y${_shared.yawDeg.toFixed(0)}`,
    ]);
    return;
  }
  if (SHAREDLOG) {
    // Lo que decide no es cuántos resets hubo, sino si han PARADO: un marco que
    // se resetea cada pocos segundos no se ha asentado, y la sala no puede estar
    // quieta encima de él.
    const since = _shared.lastResetAt
      ? ((performance.now() - _shared.lastResetAt) / 1000).toFixed(0) + 's'
      : '—';
    // S es la transformada del origen común a MI local-floor. Si sale la
    // identidad, el "espacio compartido" que nos han dado es nuestro propio
    // marco —el provisional del que avisa el README— y no hay colocalización
    // ninguna, por mucho que la feature esté concedida. Un S identidad en los dos
    // cascos explica que la sala dependa del boundary: el local-floor del Quest
    // nace del boundary, así que dos boundaries parecidos casi coinciden y uno
    // distinto manda la sala a otro sitio.
    const ident = Math.abs(_shared.x) < 0.02 && Math.abs(_shared.z) < 0.02
               && Math.abs(_shared.yawDeg) < 1.0;
    // El uuid es la identidad del espacio: seis caracteres bastan para que dos
    // personas lo comparen de viva voz, y distintos = espacios distintos, que es
    // la pregunta entera.
    // Vacío no es "no hay": es "aún no se ha establecido". Son cosas distintas y
    // la primera lectura siempre es esa.
    const uu = _shared.uuid ? _shared.uuid.slice(-6) : 'pending';
    arPerfPanelDraw(sharedActive
      ? [`shared ${ident ? 'IDENTITY' : 'ON'} · ${uu}`,
         `pose ${_shared.ok} · null ${_shared.nulls}`,
         `resets ${_shared.resets} · last ${since}`,
         `S ${_shared.x.toFixed(2)},${_shared.z.toFixed(2)} y${_shared.yawDeg.toFixed(0)}`]
      : ['shared space: OFF', '', 'flag + Enhanced', 'Spatial Services']);
    return;
  }
  const d = syncReading();
  arPerfPanelDraw(d
    ? [`sync ${d.state}${d.paused ? ' PAUSED' : ''}  v=${d.velocity}`,
       `err  ${String(d.errMs).padStart(6)} ms`,
       `rate ${d.rate.toFixed(4)}`,
       `lead ${d.leadMs === null ? '—' : d.leadMs + ' ms'}`]
    : ['[synclog] esperando', '', 'sin ?sync= en la URL', '']);
}

function arPerfPanelClear() {
  if (!arPerfPanel) return;
  scene.remove(arPerfPanel);
  arPerfPanel.material.map.dispose();
  arPerfPanel.material.dispose();
  arPerfPanel = null;
}

// El mismo problema que el informe, para los avisos sueltos: `toast()` escribe
// en el DOM de la página, que en sesión inmersiva no se compone, así que dentro
// de las gafas no se ve NADA de lo que diga. Los avisos del ancla —que son justo
// los que hay que leer mientras se calibra— van por el sprite de arriba. Es el
// mismo panel a propósito: dos carteles delante de la cara no caben.
const AR_NOTICE_MS   = 4000;
const AR_NOTICE_COLS = 32;      // caben ~34 chars a 30px monospace en 640 px
let   arNoticeUntil  = 0;

// Lo que se lee dentro de las gafas cabe en cuatro segundos y en 32 columnas, y
// el error de verdad —nombre Y mensaje— no cabe. Se guarda cada paso aquí y se
// vuelca en la página al salir de AR, que es donde hay teclado para copiarlo.
const arLog = [];
function arLogAdd(msg, e) {
  const t = arSession ? (performance.now() / 1000).toFixed(1) + 's' : '—';
  arLog.push(`${t.padStart(7)}  ${msg}` +
    (e ? `\n         ${e.name || 'error'}: ${e.message || String(e)}` : ''));
}

function arNotice(msg) {
  console.log('[ar]', msg);
  arLogAdd(msg);
  // Outside an immersive session the page is visible; inside VR or AR only
  // the panel in front of the face is.
  if (!renderer.xr.isPresenting) { toast(msg); return; }
  const lines = [];
  let line = '';
  for (const w of msg.split(' ')) {
    if (line && (line + ' ' + w).length > AR_NOTICE_COLS) { lines.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  arPerfPanelDraw(lines);
  arNoticeUntil = performance.now() + AR_NOTICE_MS;
}

function arPerfReport(now) {
  // La ventana arranca en el primer frame; sin esto, t0=0 contra un
  // performance.now() de varios segundos suelta un informe de 1 frame al entrar.
  if (!_perf.t0) { _perf.t0 = now; _perf.vf0 = decodedFrames(); _perf.cf0 = closeupDecodedFrames(); _perf.slow = 0; return; }
  if (_perf.n && now - _perf.t0 >= 2000) {
    const avg = (_perf.sum / _perf.n).toFixed(2);
    // Fotogramas decodificados por segundo en esta ventana. ~24-30 = el vídeo se
    // está decodificando entero; 0 = el navegador ya no lo decodifica.
    const vf = decodedFrames();
    const secs = (now - _perf.t0) / 1000;
    const vfps = (vf >= 0 && _perf.vf0 >= 0) ? ((vf - _perf.vf0) / secs).toFixed(1) : '?';
    const cf = closeupDecodedFrames();
    const cfps = (cf >= 0 && _perf.cf0 >= 0) ? ((cf - _perf.cf0) / secs).toFixed(1) : '?';
    const fps = (_perf.n / secs).toFixed(0);
    console.log(`[arperf] ${_perf.n} frames · medio ${avg} ms · peor ${_perf.worst.toFixed(1)} ms (${_perf.worstAt})` +
      ` · audio ${(_perf.audio / _perf.n).toFixed(2)} · foco ${(_perf.focus / _perf.n).toFixed(2)}` +
      ` · render ${(_perf.render / _perf.n).toFixed(2)} · vídeo decodificado ${vfps} fps` +
      ` · close-up ${cfps} fps · ${fps} fps reales · ${_perf.slow} frames lentos`);
    // Un aviso vivo manda sobre el informe: el informe vuelve en 2 s, el aviso no.
    // In the flat page the sprite has no place to hang (it is positioned by the
    // XR loops); there the numbers go to /api/perflog only.
    if (!arNoticeUntil && renderer.xr.isPresenting) arPerfPanelDraw([
      `${fps} fps · ${_perf.slow} slow · js+render ${avg} ms`,
      `worst ${_perf.worst.toFixed(1)} ms (${_perf.worstAt})`,
      `render ${(_perf.render / _perf.n).toFixed(2)} ms`,
      `decoded: 360 ${vfps} · close-up ${cfps} fps`,
    ]);
    // Cada ventana se guarda además para el volcado de la página al salir, que
    // sobrevive a quitarse las gafas.
    window.__arperf = window.__arperf || [];
    window.__arperf.push({ frames: _perf.n, avgMs: +avg, worstMs: +_perf.worst.toFixed(1),
                           worstAt: _perf.worstAt, videoFps: +vfps, closeupFps: +cfps,
                           fps: +fps, slow: _perf.slow });
    perfTraceFlush({ fps: +fps, slow: _perf.slow, avgMs: +avg, videoFps: +vfps, closeupFps: +cfps });
    _perf.n = _perf.sum = _perf.worst = _perf.audio = _perf.focus = _perf.render = _perf.slow = 0;
    _perf.t0 = now; _perf.vf0 = vf; _perf.cf0 = cf;
  }
}

// Volcado en la propia página al salir de AR. El toast dura 3 s y se lo come el
// tiempo de quitarse las gafas; esto se queda hasta que se recarga.
function arLogDump() {
  if (!arLog.length) return;
  let el = document.getElementById('arlog-dump');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'arlog-dump';
    el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;margin:0;max-height:80vh;' +
      'overflow:auto;padding:10px 12px;background:rgba(0,0,0,.82);color:#7fd;border-radius:6px;' +
      'font:12px/1.4 monospace;white-space:pre-wrap;max-width:46vw';
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
  }
  el.textContent = '[ar] anchor log   (tap to close)\n\n' + arLog.join('\n');
  arLogSend();
}

// Al terminal del PC, que es donde hay teclado para copiarlo: la página vive en
// el navegador del casco y leerla ahí obliga a transcribir a mano. Se manda dos
// veces —al entrar en AR y al salir— porque la de entrada llega en cuanto te
// pones las gafas y ya dice si el casco está ejecutando este código; esperar a
// la de salida deja la duda abierta toda la sesión. Si el player se sirve desde
// otro sitio (S3) no hay a quién mandarlo, y el fallo se queda en el registro.
function arLogSend() {
  if (!arLog.length) return;
  fetch('/api/arlog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ log: arLog.join('\n') }),
  }).catch(e => arLogAdd('POST /api/arlog failed', e));
}

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
    `[arperf] ${w.length} windows of 2 s   (tap to close)\n` +
    `worst frame  ${peor.worstMs} ms  (${peor.worstAt})\n` +
    `video decoded, average  ${vid.toFixed(1)} fps` +
    `   → ${vid > 5 ? 'the 360 IS being decoded for nobody' : 'the browser no longer decodes it'}\n\n` +
    w.map((x, i) => `${String(i * 2).padStart(3)}s  ${String(x.frames).padStart(4)} fr` +
      `  avg ${String(x.avgMs).padStart(6)}  worst ${String(x.worstMs).padStart(6)}` +
      `  video ${String(x.videoFps).padStart(5)} fps  (${x.worstAt})`).join('\n');
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
  stopLiveWatch();
  if (shakaVideo) { try { await shakaVideo.destroy(); } catch(e){} shakaVideo = null; }
  if (shakaAudio) { try { await shakaAudio.destroy(); } catch(e){} shakaAudio = null; }
  if (shakaCloseup) { try { await shakaCloseup.destroy(); } catch(e){} shakaCloseup = null; }
  if (closeupWC) { closeupWC.close(); closeupWC = null; }
  closeupReady = false; closeupRepByStem = {}; closeupCropByRep = {};
  resetCloseup();

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
      // Ignored by the Shaka we load (4.3.6): segment prefetch arrived in a
      // later 4.x. Kept so an upgrade behaves as this config was meant to.
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
    perfWatchNet(shakaVideo, 'v');
    await shakaVideo.load(src);

    // Con close-ups el manifest trae VARIAS AdaptationSets de vídeo y ninguna
    // dice "yo soy el 360". La variante de arranque la elige Shaka por ancho de
    // banda —también con ABR apagado—, y el 4K (26 Mbps) no cabe en la
    // estimación inicial (5 Mbps): se quedaba con un close-up de 1,8 Mbps y la
    // esfera mostraba a un músico en primer plano como si fuera la escena
    // entera. La esfera se pide por su Representation, no por su bitrate.
    const _sv = pinSphereTrack();

    // Tope de resolución de vídeo (diagnóstico de saturación de decodificado): con
    // ABR off, elegimos a mano la variante de mayor altura ≤ maxh. Si la imagen se
    // retrasa del audio por drops (decoder 4K no llega / throttling térmico),
    // ?maxh=1440 ó ?maxh=1080 lo confirma en vivo. Sin efecto si solo hay 4K.
    // Solo entre las variantes del 360: un close-up "cabe" en cualquier tope y
    // sería la forma más tonta de acabar otra vez con la esfera equivocada.
    const _maxh = parseInt(new URLSearchParams(location.search).get('maxh') || '0', 10);
    if (_maxh > 0) {
      const _vt = _sv
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
    if (isLive) startLiveWatch(src);

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

      // Close-up: same timeline, but its own <video> and its own clock — two
      // Shaka instances do not share one. It used to be corrected only past
      // 0.5 s, by a seek, and left alone below that: a close-up that started
      // 300 ms late (play() lags the seek) stayed 300 ms late for good, which on
      // a drum hit is plainly visible. Now it is steered like the audio is,
      // through playbackRate, continuously. It is muted, so the rate can move
      // far more than the audio's ever could without anyone hearing it.
      if (closeupReady && closeupStem >= 0 && !closeupWC) {
        if (videoEl.paused && !closeupEl.paused) closeupEl.pause();
        if (!videoEl.paused && closeupEl.paused) closeupEl.play().catch(()=>{});
        const err = closeupEl.currentTime - videoEl.currentTime;    // + = close-up ahead
        const a = Math.abs(err);
        if (a > CLOSEUP_SYNC.hardSeek) {
          closeupEl.currentTime = videoEl.currentTime;
          closeupEl.playbackRate = base;
        } else if (a > CLOSEUP_SYNC.dead && !closeupEl.paused && !closeupEl.seeking) {
          const k = Math.max(-CLOSEUP_SYNC.cap, Math.min(CLOSEUP_SYNC.cap, -err * CLOSEUP_SYNC.kp));
          closeupEl.playbackRate = base * (1 + k);
        } else if (closeupEl.playbackRate !== base) {
          closeupEl.playbackRate = base;
        }
      }
    }, 250);

    // ── FOA decode via Web Audio ────────────────────
    await setupFOA();

    // ── Close-ups (Caso B): pistas de vídeo extra del mismo manifest ─────────
    await setupCloseups(src);

    // ── Sincronía entre dispositivos (?sync=<sesión>) ────────────────────────
    // Esclaviza este player a un timing object compartido: una página de control
    // manda, y todos los que miren a la misma sesión reproducen el mismo instante
    // —incluido el que llegue tarde—. Se engancha AQUÍ, después de cargar, porque
    // el servicio quiere la duración y antes no la hay.
    //
    // import() dinámico a propósito: sin ?sync no se baja ni una línea de Motion,
    // igual que una escena sin mallas no gasta una luz. Y el fallo que esperamos
    // —que el socket no abra— no puede llevarse por delante la reproducción: el
    // player tiene que seguir funcionando solo, que es como funciona hoy.
    const _syncSession = new URLSearchParams(location.search).get('sync');
    if (_syncSession) {
      try {
        const q = new URLSearchParams(location.search);
        const { attachSync } = await import('./sync.js');
        attachSync(videoEl, {
          sessionId: _syncSession,
          url: q.get('timing') || undefined,
          offsetSec: parseFloat(q.get('syncoffset')) || 0,
        });
      } catch (e) {
        console.warn('[sync] no se pudo enganchar:', e.message || e);
        toast('Sincronía no disponible');
      }
    }

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

// ── Live source watchdog ─────────────────────────────────────────────────────
//
// When one track stops at the source (a USB audio interface that drops off the
// bus, a camera unplugged), ffmpeg can keep running and keep publishing the
// OTHER track. Shaka then waits forever for the dead one: playback freezes and
// nothing reports an error. So: if a live stream has not advanced for a while,
// read the manifest and say which track stopped and how long ago. The track
// comparison uses only the manifest's own times, so it does not depend on this
// device's clock; "nothing new at all" does (publishTime vs now), hence the
// wider margin there.
const LIVE_STALL_S = 8;          // playback frozen this long → look at the source
const LIVE_STALE_TRACK_S = 10;   // a track this far behind the newest one is dead
const LIVE_STALE_MPD_S = 30;     // no new manifest for this long → source stopped
let liveWatchTimer = null;

function stopLiveWatch() {
  if (liveWatchTimer) { clearInterval(liveWatchTimer); liveWatchTimer = null; }
}

// Where each adaptation set's timeline ends, in seconds since the Period start.
function mpdTrackEnds(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out = [];
  for (const as of doc.getElementsByTagName('AdaptationSet')) {
    const tpl = as.getElementsByTagName('SegmentTemplate')[0];
    if (!tpl) continue;
    const ts = +tpl.getAttribute('timescale') || 1;
    const pto = +tpl.getAttribute('presentationTimeOffset') || 0;
    let t = 0, end = 0;
    for (const S of tpl.getElementsByTagName('S')) {
      if (S.hasAttribute('t')) t = +S.getAttribute('t');
      const d = +S.getAttribute('d'), r = +(S.getAttribute('r') || 0);
      t += d * (r + 1); end = t;
    }
    const rep = as.getElementsByTagName('Representation')[0];
    const kind = as.getAttribute('contentType') ||
      ((rep && rep.getAttribute('mimeType')) || '').split('/')[0] || 'track';
    out.push({ kind, id: as.getAttribute('id'), end: (end - pto) / ts });
  }
  return { doc, tracks: out };
}

function startLiveWatch(src) {
  stopLiveWatch();
  let lastT = -1, frozenSince = 0, lastWarn = 0;
  liveWatchTimer = setInterval(async () => {
    const now = performance.now();
    if (videoEl.paused) { frozenSince = 0; return; }        // paused on purpose
    const t = videoEl.currentTime;
    if (t !== lastT) { lastT = t; frozenSince = 0; return; }
    if (!frozenSince) { frozenSince = now; return; }
    if (now - frozenSince < LIVE_STALL_S * 1000 || now - lastWarn < 10000) return;
    lastWarn = now;
    const frozen = Math.round((now - frozenSince) / 1000);
    let msg = `Live stalled ${frozen} s: `;
    try {
      const xml = await (await fetch(src, { cache: 'no-store' })).text();
      const { doc, tracks } = mpdTrackEnds(xml);
      const mpd = doc.documentElement;
      const newest = Math.max(...tracks.map(k => k.end));
      const dead = tracks.filter(k => newest - k.end > LIVE_STALE_TRACK_S);
      const pub = Date.parse(mpd.getAttribute('publishTime') || '');
      const age = isFinite(pub) ? (Date.now() - pub) / 1000 : 0;
      if (dead.length) {
        msg += dead.map(k => `${k.kind} (set ${k.id}) stopped ${Math.round(newest - k.end)} s ago`)
          .join(', ') + ' at the source, the rest keeps coming. Check that capture device and restart the live.';
      } else if (age > LIVE_STALE_MPD_S) {
        msg += `the source has published nothing for ${Math.round(age)} s (encoder or upload stopped).`;
      } else {
        msg += 'the source looks alive; the network or the CDN is not delivering segments.';
      }
    } catch (e) {
      msg += `cannot read the manifest (${e.message}).`;
    }
    console.warn('[live]', msg);
    arNotice(msg);
  }, 1000);
}

// Textura de vídeo que se sube SOLO cuando hay fotograma nuevo.
//
// El three que usamos es la r128, anterior a que VideoTexture conociera
// requestVideoFrameCallback: su `update()` marca `needsUpdate` en CADA render
// mientras el elemento tenga datos. Con un 360 de 24 fps eso significa subir a la
// GPU la MISMA imagen de 8 Mpx 60 veces por segundo en escritorio y 90 dentro de
// las gafas — más del doble del trabajo necesario, y todo en el hilo principal.
//
// Una Texture normal no se auto-marca, así que la marcamos nosotros desde rVFC,
// que dispara exactamente una vez por fotograma presentado. Sin rVFC volvemos al
// comportamiento de antes (lo marcan los bucles de render).
function makeVideoTexture(el) {
  const tex = new THREE.Texture(el);
  // El vídeo YA viene en sRGB. Sin decirlo, con outputEncoding puesto se
  // codificaría a la salida sin haberse decodificado nunca: 360 lavado y negros
  // lechosos. Diciéndolo, decodificar y codificar se cancelan y pasa intacto.
  MeshFit.srgb(tex);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;   // 8 Mpx: generar mipmaps por fotograma, ni de broma
  tex.needsUpdate = true;
  if (HAS_RVFC) {
    const tick = (now, md) => {
      if (tex.__stop) return;    // textura ya reemplazada: no resucitarla
      tex.needsUpdate = true;
      // The media time of the frame this texture now shows: the clock the
      // WebCodecs close-up follows (see closeupClock).
      el.__mt = md ? md.mediaTime : el.currentTime; el.__mtAt = performance.now();
      el.requestVideoFrameCallback(tick);
    };
    el.requestVideoFrameCallback(tick);
  }
  return tex;
}

function attachVideoTexture() {
  if (videoTexture) { videoTexture.__stop = true; videoTexture.dispose(); }
  videoTexture = makeVideoTexture(videoEl);
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
        if (_sc.voice) voiceCfg = _sc.voice;
        if (_sc.debug) enableDebugMode();
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

    // Entorno de las mallas (MeshFit.environment), calentado AQUÍ y no al colgar
    // la primera: construirlo es un pase PMREM a un render target, y hacer eso
    // con una sesión inmersiva en marcha es discutirle el framebuffer al
    // compositor sin ninguna necesidad. Queda cacheado por renderer, así que
    // ensureARLights() ya sólo lo asigna. Sólo si la escena declara mallas: una
    // que no las tiene sigue sin gastar nada.
    if (_stems.some(s => s.mesh) || arCfg.mesh) MeshFit.environment(renderer);

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
        // Desktop / tablet: report the view too, unless the scene opts out with
        // "screen": false. VR/AR switch the mode on session enter and back here on exit.
        if (telemetryCfg?.screen !== false || _tq.get('telemetry')) telemetrySetMode('screen');
      }
    }

    // ── Grabación de voz del participante (opt-in) ────────────────────
    // Lo que dice mientras está dentro —"no veo el saxo", "ahora lo tengo
    // detrás"— es la observación que la pose no sabe hacer. Se guarda en el
    // servidor troceada en Opus, y cada trozo lleva el tiempo de medio del
    // player: la misma columna que escribe el recorder de poses (media_s), así
    // que la frase y la cabeza que se estaba girando al decirla se cruzan por
    // un join. Config en scene.json:
    //   "voice": { "enabled": true }
    // Overrides por URL:  ?voice=1   ?voice=0   ?voice=wss://otra/voice
    // Ver docs/voice-recording.md — y ojo: esto graba a una persona, así que
    // sale por defecto apagado y con un piloto que se ve desde fuera.
    {
      const _vp = new URLSearchParams(location.search).get('voice');
      const _von = _vp !== null ? !/^(0|off|false)$/i.test(_vp) : !!(voiceCfg && voiceCfg.enabled);
      // Sin await: si el permiso está concedido esto arranca el micro, y un
      // getUserMedia que se quede pensando (dispositivo ocupado) no puede dejar
      // a medias la carga del player. setupVoice() se traga sus propios errores.
      if (_von) setupVoice(_vp);
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
  closeupRepByStem = {}; closeupCropByRep = {};
  let rep = 1;
  stemDefs.forEach((s, i) => { if (s && s.closeup) closeupRepByStem[i] = String(rep++); });
  // stream.sh writes which track is whose next to the manifest. With it the map
  // goes by name and does not depend on order — in LIVE only the crops are
  // encoded, so counting the stems that have a close-up would be off — and it
  // says where each crop sits. Encodes from before it fall back to the order.
  try {
    const r = await fetch(new URL('closeups.json', src).href, { cache: 'no-store' });
    if (r.ok) {
      const list = (await r.json()).closeups || [];
      closeupRepByStem = {};
      for (const c of list) {
        const i = stemDefs.findIndex(s => s && s.name === c.name);
        if (i >= 0) closeupRepByStem[i] = String(c.rep);
        if (c.crop) closeupCropByRep[String(c.rep)] = c.crop;
      }
    }
  } catch (_) { /* local file or no sidecar: order it is */ }
  if (!Object.keys(closeupRepByStem).length) return;

  // WebCodecs first: frames slaved to the 360's clock. Any failure here falls
  // back to the second Shaka below.
  if (CU_WC && CloseupWC.available()) {
    try {
      const off = parseFloat(new URLSearchParams(location.search).get('cuoffset') || '0') / 1000 || 0;
      const wc = new CloseupWC(new URL(src, location.href).href, { log: m => console.log(m), offsetS: off });
      if (await wc.init([...new Set(Object.values(closeupRepByStem))])) {
        closeupWC = wc;
        closeupTexture = new THREE.Texture();
        MeshFit.srgb(closeupTexture);
        closeupTexture.minFilter = THREE.LinearFilter;
        closeupTexture.magFilter = THREE.LinearFilter;
        closeupTexture.generateMipmaps = false;
        closeupMesh.material.map = closeupTexture;
        closeupMesh.material.needsUpdate = true;
        closeupReady = true;
        toast('Close-ups (WebCodecs) · mira a un músico y haz zoom');
        return;
      }
    } catch (e) { console.warn('[closeup-wc] falling back to a second Shaka:', e); }
  }

  try {
    shakaCloseup = new shaka.Player(closeupEl);
    perfWatchNet(shakaCloseup, 'c');
    // El audio de este manifest es el Opus multicanal del motor: que la segunda
    // instancia no se lo descargue otra vez para tirarlo (va muteada).
    // Colchón corto: a esta instancia se le pide arrancar pronto, no aguantar.
    // El 360 no puede permitirse un corte —es toda la escena— pero un close-up
    // que se atasca está casi siempre oculto, y el fundido ya espera a que haya
    // imagen. Con el colchón de 2 s del 360, el panel llegaba tarde siempre.
    shakaCloseup.configure({ ...shakaCfg,
      streaming: { ...shakaCfg.streaming, rebufferingGoal: 0.5, bufferingGoal: 4 },
      manifest: { ...shakaCfg.manifest, disableAudio: true } });
    await shakaCloseup.load(src);
    closeupEl.muted = true;   // el audio sale del motor FOA, no de aquí

    // Clavarla en un close-up desde el principio. Si la dejamos elegir, puede
    // quedarse con el 360 y estaríamos decodificando el 4K DOS veces sin que se
    // vea: el mismo agujero de rendimiento que ya nos comió los frames en AR.
    const firstRep = Object.values(closeupRepByStem)[0];
    const firstV = shakaCloseup.getVariantTracks().find(t => t.originalVideoId === firstRep);
    if (firstV) shakaCloseup.selectVariantTrack(firstV, /*clearBuffer*/ true);
    closeupEl.pause();        // no se ve nada hasta que el foco lo pida

    // Mismo cuidado que con disableVideo: si el build lo ignora, que se sepa por
    // consola y no en la factura de ancho de banda.
    if (shakaCloseup.getConfiguration().manifest.disableAudio !== true)
      console.warn('[closeup] este build de Shaka ignora manifest.disableAudio: ' +
                   'la 2ª instancia se bajará el Opus multicanal para tirarlo');

    closeupTexture = makeVideoTexture(closeupEl);
    closeupMesh.material.map = closeupTexture;
    closeupMesh.material.needsUpdate = true;

    closeupReady = true;
    toast('Close-ups disponibles · mira a un músico y haz zoom');
  } catch (e) {
    console.warn('[closeup] no disponible:', e.message);
    closeupReady = false;
  }
}

// Variantes del 360 (las que NO son close-up), de mayor a menor altura. Un
// manifest sin close-ups tiene una sola AdaptationSet de vídeo y entonces valen
// todas: así esto no cambia nada en las escenas de siempre.
function sphereVariants() {
  const all = shakaVideo ? shakaVideo.getVariantTracks() : [];
  const own = all.filter(t => t.originalVideoId === SPHERE_REP);
  return (own.length ? own : all).sort((a, b) => (b.height || 0) - (a.height || 0));
}

// Clava la esfera en su Representation. Hay que llamarlo DESPUÉS DE CADA carga
// del manifest —son dos caminos, la carga inicial y la recarga al salir de AR—
// porque cada una vuelve a elegir variante por ancho de banda. Devuelve las
// variantes del 360 para quien quiera seguir filtrando entre ellas.
function pinSphereTrack() {
  const sv = sphereVariants();
  if (sv.length && !sv.some(t => t.active))
    shakaVideo.selectVariantTrack(sv[0], /*clearBuffer*/ true);
  return sv;
}

// ¿Tiene este stem una pista de close-up? Mira solo el mapa, no el manifest: se
// pregunta en cada frame y `getVariantTracks()` construye un array cada vez.
function closeupCanShow(idx) {
  return idx >= 0 && closeupReady && closeupRepByStem[idx] != null;
}

// Pide el close-up del stem `idx` (o pide ocultarlo con idx<0). Aquí no se
// conmuta nada: solo se deja el destino, y la transición lo alcanza en
// updateCloseupAnim(). Un stem sin pista en el manifest equivale a no pedir nada.
function showCloseup(idx) {
  closeupWant = closeupCanShow(idx) ? idx : -1;
}

// Conmuta la pista de vídeo de shakaCloseup al stem `idx`; al ser el mismo
// manifest que el 360, sigue sincronizado. Solo se llama con el panel a cero:
// cambiar el contenido a media opacidad se vería como un corte.
function selectCloseupTrack(idx) {
  closeupStem = -1;
  if (closeupWC) {
    closeupWC.select(closeupCanShow(idx) ? closeupRepByStem[idx] : null);
    if (closeupCanShow(idx)) closeupStem = idx;
    return;
  }
  if (!closeupCanShow(idx)) return closeupEl.pause();
  const repId = closeupRepByStem[idx];
  const v = shakaCloseup.getVariantTracks().find(t => t.originalVideoId === repId);
  if (!v) {
    // No debería pasar: el mapa se construye a partir del propio manifest. Si
    // pasa, hay que borrarlo o lo reintentaríamos en CADA frame para siempre.
    console.warn(`[closeup] el stem ${idx} apunta a la Representation ${repId}, ` +
                 'que no está en el manifest');
    delete closeupRepByStem[idx];
    return closeupEl.pause();
  }
  // Reseleccionar la pista que ya está activa cuesta un `clearBuffer` y volver a
  // bajarse el segmento: justo lo que estamos intentando ahorrar.
  if (!v.active) shakaCloseup.selectVariantTrack(v, /*clearBuffer*/ true);
  // Y saltar cuando ya se está en el sitio deja al elemento en `seeking` y para
  // la imagen sin necesidad. Mismo margen que el lazo de sync.
  if (Math.abs(closeupEl.currentTime - videoEl.currentTime) > 0.5)
    closeupEl.currentTime = videoEl.currentTime;
  closeupEl.play().catch(() => {});
  closeupStem = idx;
}

// Avanza la transición un frame y refresca la textura. Vive en los DOS bucles de
// render, no en el foco: el panel tiene que terminar de irse aunque el foco deje
// de actualizarse —al entrar en AR, o cuando no hay pose— y no quedarse
// congelado a medio fundido delante de la cara.
function updateCloseupAnim() {
  if (!closeupMesh) return;
  const now = performance.now();
  // Un dt sin tope convierte cualquier pausa (pestaña de fondo, carga larga) en
  // un salto: mejor que la transición se coma un frame largo a que se salte.
  const dt = closeupLastT ? Math.min((now - closeupLastT) / 1000, 0.1) : 0;
  closeupLastT = now;

  // La pista que queremos DECODIFICANDO no es la que queremos ver. Con el panel
  // fuera cargamos ya la del candidato —el que la mirada roza pero todavía no ha
  // ganado—, para que cuando gane no empiece por bajarse un segmento entero. Con
  // segmentos de 6 s esa descarga es la mayor parte de lo que se tarda en
  // aparecer, y sucede justo mientras el espectador sigue haciendo zoom.
  const load = closeupWant >= 0 ? closeupWant : closeupArmed;
  if (closeupFade <= 0 && closeupStem !== load) selectCloseupTrack(load);

  // Si la pista está parada, que siga parada FUERA de cámara. El elemento se
  // queda en pausa más a menudo de lo que parece: el salto de `currentTime`
  // aborta el `play()` anterior, y Shaka no da imagen hasta llenar su colchón.
  if (!closeupWC && closeupStem >= 0 && closeupEl.paused && !videoEl.paused)
    closeupEl.play().catch(() => {});

  // WebCodecs: the frame due at the 360's time, into the texture. Runs while
  // the track is selected, shown or not, so it is decoded when it is wanted.
  if (closeupWC && closeupStem >= 0) {
    const f = closeupWC.update(closeupClock());
    if (f && f !== closeupTexture.image) { closeupTexture.image = f; closeupTexture.needsUpdate = true; }
  }

  // No empezar a entrar hasta que la pista nueva tenga imagen Y esté corriendo:
  // selectVariantTrack con clearBuffer más el salto de currentTime dejan unos
  // frames sin decodificar, y el panel entraría con el fotograma congelado del
  // músico ANTERIOR, que es justo el corte que este fundido viene a evitar. Solo
  // condiciona el arranque: una vez dentro, un rebuffer no lo echa fuera y lo
  // vuelve a meter, que se vería peor que un parón de medio segundo.
  const fresh  = closeupWC ? closeupWC.hasFrame()
                            : closeupEl.readyState >= 3 && !closeupEl.seeking && !closeupEl.paused;
  const want   = closeupStem >= 0 && closeupStem === closeupWant;
  const target = (want && (closeupFade > 0 || fresh)) ? 1 : 0;
  const crop   = closeupStem >= 0 ? (closeupCropByRep[closeupRepByStem[closeupStem]] || null) : null;
  // A crop fades slower than the panel: it lands during the zoom (it rides the
  // sphere), and over the same picture a long fade just reads as focusing.
  const step   = dt / (crop ? CROP_FADE_S : CLOSEUP_FADE_S);
  closeupFade  = target > closeupFade ? Math.min(target, closeupFade + step)
                                      : Math.max(target, closeupFade - step);

  closeupMesh.visible = closeupFade > 0.001;
  if (!closeupMesh.visible) {
    // Gone: the next appearance is placed afresh, where the viewer is then,
    // and starts without the extra zoom.
    closeupPlaced = undefined;
    if (closeupZoomGoal !== 1) closeupZoomReset();
    return;
  }
  const key = closeupStem + (crop ? ':crop' : ':panel');
  if (key !== closeupPlaced) placeCloseup(closeupStem, crop, key);
  const e = closeupFade * closeupFade * (3 - 2 * closeupFade);   // smoothstep
  closeupMesh.material.opacity = e;
  // A crop must sit exactly on its patch of the sphere: no scale-in, only the
  // fade — the picture underneath is the same, so it reads as sharpening.
  closeupZoom += (closeupZoomGoal - closeupZoom) * Math.min(1, dt * 8);
  if (!crop) closeupMesh.scale.setScalar((CLOSEUP_SCALE_IN + (1 - CLOSEUP_SCALE_IN) * e) * closeupZoom);
  if (!closeupWC && closeupTexture && !HAS_RVFC) closeupTexture.needsUpdate = true;
}

// The 360's media time for the frame on screen, from its rVFC (exact), carried
// forward between its frames so a close-up at a higher frame rate can step at
// its own pace — never more than one 360 frame ahead of what is shown.
function closeupClock() {
  const v = videoEl;
  if (v.__mtAt == null) return v.currentTime;
  if (v.paused || v.seeking) return v.__mt;
  return v.__mt + Math.min(1 / 24, (performance.now() - v.__mtAt) / 1000 * v.playbackRate);
}

// A tap on the close-up: a bit more zoom, a second tap back.
function closeupZoomTap() {
  const crop = closeupStem >= 0 ? closeupCropByRep[closeupRepByStem[closeupStem]] : null;
  const more = closeupZoomGoal === 1;
  closeupZoomGoal = more ? CLOSEUP_MORE : 1;
  if (!crop) return;                       // a panel just grows
  if (xrSession) xrZoomTo(more ? VR_PINCH_ZOOM_MORE : VR_PINCH_ZOOM);
  else if (more) { cuDeskFov = camera.fov; camera.fov = Math.max(30, camera.fov / CLOSEUP_MORE); camera.updateProjectionMatrix(); }
  else if (cuDeskFov) { camera.fov = cuDeskFov; cuDeskFov = null; camera.updateProjectionMatrix(); }
}
function closeupZoomReset() {
  closeupZoomGoal = 1; closeupZoom = 1;
  if (cuDeskFov) { camera.fov = cuDeskFov; cuDeskFov = null; camera.updateProjectionMatrix(); }
}

// Is a ray on the close-up? Then the world point it hits, else null.
const _cuRay = new THREE.Raycaster();
function closeupHit(o, d) {
  if (!closeupMesh || !closeupMesh.visible || closeupFade < 0.5) return null;
  _cuRay.ray.origin.set(o[0], o[1], o[2]);
  _cuRay.ray.direction.set(d[0], d[1], d[2]);
  const h = _cuRay.intersectObject(closeupMesh, false)[0];
  return h ? h.point : null;
}

// Where the close-up mesh goes. A close-up VIDEO is a panel hanging 2.5 m in
// front of the camera. A CROP of the 360 is laid on the sphere over the patch
// it was cut from: a flat view of h × v degrees, seen from the sphere's centre,
// is a plane tangent at that direction, 2·D·tan(fov/2) across at distance D.
// As a child of the sphere it rides the zoom with it — the zoom pushes the
// sphere, and the crop is pushed alike — so it never slides over the picture.
// lookAt() with the default up gives the same no-roll orientation as v360's
// yaw/pitch.
const CROP_D = 99;                   // just inside the 100 m sphere
const CROP_FADE_S = 0.6;             // s: fade of a crop over its patch of the sphere
const _cropC = new THREE.Vector3();
const CLOSEUP_DIST = 2.5;             // m from the head to the panel
const _cuHead = new THREE.Vector3(), _cuDir = new THREE.Vector3();
function placeCloseup(stem, crop, key) {
  closeupPlaced = key;
  if (!crop) {
    // The panel stays where it appeared — in the musician's direction, 2.5 m
    // from the head at that moment — instead of hanging off the camera and
    // following every turn of the head. Seen face-on from where the viewer was.
    scene.add(closeupMesh);
    camera.getWorldPosition(_cuHead);
    const d = engine && stem >= 0 ? engine.getStemDirection(stem) : null;
    if (d) _cuDir.set(d[0], d[1], d[2]);
    else camera.getWorldDirection(_cuDir);
    closeupMesh.position.copy(_cuHead).addScaledVector(_cuDir.normalize(), CLOSEUP_DIST);
    closeupMesh.lookAt(_cuHead);
    closeupMesh.scale.setScalar(1);
    return;
  }
  sphere.add(closeupMesh);
  const az = crop.azimuthDeg * Math.PI / 180, el = crop.elevationDeg * Math.PI / 180;
  const ce = Math.cos(el);
  closeupMesh.position.set(-ce * Math.sin(az) * CROP_D, Math.sin(el) * CROP_D, -ce * Math.cos(az) * CROP_D);
  // The geometry is 2 × 1.125 (the panel's 16:9).
  closeupMesh.scale.set(CROP_D * Math.tan(crop.hFovDeg * Math.PI / 360),
                        CROP_D * Math.tan(crop.vFovDeg * Math.PI / 360) * 2 / 1.125, 1);
  sphere.updateMatrixWorld(true);
  closeupMesh.lookAt(sphere.getWorldPosition(_cropC));
}

// Deja el close-up a cero de golpe, sin transición: cambio de manifest o entrada
// en AR, donde no hay nada que fundir porque la escena entera desaparece.
function resetCloseup() {
  closeupStem = -1; closeupWant = -1; closeupFade = 0;
  closeupArmed = closeupArmCand = -1; closeupArmSince = 0;
  if (closeupMesh) { closeupMesh.visible = false; closeupMesh.material.opacity = 0; }
}

// Selecciona el close-up del músico enfocado (mirada × zoom) o lo oculta. No
// actúa en AR (allí ya te acercas al objeto 3D real). Barato: dos barridos de
// los stems y una asignación; el trabajo de verdad lo hace la transición.
function updateCloseupFocus() {
  if (!closeupReady || arSession || !engine) { closeupArmed = -1; return showCloseup(-1); }
  // Pinched: that musician's close-up, whatever the head is looking at.
  if (xrZoomStem >= 0) { closeupArmed = -1; return showCloseup(xrZoomStem); }
  const enter = engine.getFocusedStem(CLOSEUP_ENTER);   // quién se lo gana de sobra
  const stay  = engine.getFocusedStem(CLOSEUP_EXIT);    // quién manda con el listón bajo
  // Cruzar EXIT no saca el panel, pero sí manda ir cargando esa pista... si el
  // candidato se sostiene CLOSEUP_ARM_DWELL_S. Ver el comentario de la constante.
  const cand = closeupCanShow(stay) ? stay : -1;
  const now = performance.now();
  if (cand !== closeupArmCand) { closeupArmCand = cand; closeupArmSince = now; }
  if (closeupArmed !== cand && now - closeupArmSince >= CLOSEUP_ARM_DWELL_S * 1000)
    closeupArmed = cand;
  if (closeupWant < 0)                          showCloseup(enter);
  else if (enter >= 0 && enter !== closeupWant) showCloseup(enter);   // otro se lo gana
  else                                          showCloseup(stay === closeupWant ? closeupWant : -1);
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

  // Touch: one finger looks around, two fingers pinch to zoom (the wheel's
  // job on a PC: everything the zoom drives, audio spotlight and close-ups,
  // follows camera.fov). The page itself must not zoom: without touch-action
  // the browser took the pinch and scaled the whole page instead.
  c.style.touchAction = 'none';
  let lastTouch = null, pinchDist = 0, pinchFov = 0;
  const touchDist = ts => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  const touchStart = e => {
    if (e.touches.length >= 2) {
      lastTouch = null;
      pinchDist = touchDist(e.touches); pinchFov = camera.fov;
    } else {
      // Back to one finger after a pinch: restart the drag from where it is
      // now, or the view would jump by the distance between the fingers.
      pinchDist = 0;
      lastTouch = e.touches[0] || null;
    }
  };
  c.addEventListener('touchstart', touchStart);
  c.addEventListener('touchend', touchStart);
  c.addEventListener('touchcancel', touchStart);
  c.addEventListener('touchmove', e => {
    e.preventDefault();
    if (pinchDist && e.touches.length >= 2) {
      // Fingers apart → narrower field of view (zoom in), as a picture would.
      setFov(pinchFov * pinchDist / Math.max(1, touchDist(e.touches)));
      return;
    }
    if (!lastTouch) return;
    const t = e.touches[0];
    yaw   -= (t.clientX - lastTouch.clientX) * 0.005;
    pitch -= (t.clientY - lastTouch.clientY) * 0.005;
    pitch  = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    lastTouch = t;
  }, { passive: false });

  c.addEventListener('wheel', e => setFov(camera.fov + e.deltaY * 0.05));
}

// The screen zoom: field of view between 30° (fully in) and 100° (wide).
function setFov(fov) {
  camera.fov = Math.max(30, Math.min(100, fov));
  camera.updateProjectionMatrix();
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
      if (telemetry?.meta.mode === 'screen') telemetry.setMeta({ input: 'gyro' });
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

  debugTexture = MeshFit.srgb(new THREE.CanvasTexture(debugCanvas));

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
// GRABACIÓN DE VOZ DEL PARTICIPANTE
// ══════════════════════════════════════════════════════
// El micro se pide desde la página plana y nunca al entrar en XR: dentro de una
// sesión inmersiva el diálogo de permiso no se puede pintar, y esperarlo antes
// de requestSession() se gasta el gesto de usuario que ésta necesita —con lo que
// falla el VR por algo que no tiene nada que ver con el VR—. La contrapartida es
// un botón que hay que tocar una vez; a partir de la segunda sesión el permiso
// ya está concedido para este origen y arranca solo.
async function setupVoice(param) {
  const q = new URLSearchParams(location.search);
  const _same = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice`;
  const url = (param && /^wss?:\/\//i.test(param) ? param : null) || (voiceCfg && voiceCfg.url) || _same;
  try {
    // import() dinámico, como Motion: sin ?voice no se baja ni una línea de esto.
    const { VoiceRecorder } = await import('./voice.js');
    voice = new VoiceRecorder({
      url,
      // El MISMO id que la telemetría, que es lo que permite cruzar la voz con
      // las poses después. Sin telemetría no hay con qué cruzar, así que vale
      // cualquiera —pero que sea el de ?player si lo han puesto.
      playerId: telemetry ? telemetry.playerId : (q.get('player') || undefined),
      timesliceMs:   (voiceCfg && voiceCfg.timesliceMs)   || 1000,
      bitsPerSecond: (voiceCfg && voiceCfg.bitsPerSecond) || 32000,
      constraints:   (voiceCfg && voiceCfg.constraints)   || undefined,
      meta: { ua: navigator.userAgent, player: q.get('player') || null },
      mediaTime: () => videoEl?.currentTime || 0,
      onState: (state, info) => { voiceBadge(state); voiceRefToTelemetry(state, info); },
    });
    window.voice = voice;
    const btn = document.getElementById('rec-btn');
    if (btn) btn.style.display = '';

    // Si ya nos dieron el micro en una sesión anterior, no hay nada que tocar.
    // Un navegador sin Permissions API (o que no conoce 'microphone') deja esto
    // en false y se queda el botón, que es el comportamiento seguro.
    let granted = false;
    try { granted = (await navigator.permissions.query({ name: 'microphone' })).state === 'granted'; }
    catch (_) { /* sin Permissions API: que lo pulse */ }
    if (granted) await toggleVoice();
    else toast('Grabación de voz: pulsa REC');
  } catch (e) {
    console.warn('[voice] no se pudo preparar:', e.message || e);
    toast('Grabación de voz no disponible');
  }
}

async function toggleVoice() {
  if (!voice) return toast('Grabación de voz desactivada (?voice=1)');
  if (voice.recording) { voice.stop(); return toast('Grabación detenida'); }
  try {
    await voice.start();
    toast('Grabando voz → ' + voice.url);
  } catch (e) {
    // NotAllowedError (lo han denegado) y NotFoundError (no hay micro) son las
    // dos que se ven de verdad, y las dos se arreglan fuera de aquí. Un Error
    // pelado no tiene nombre que decir, así que ahí vale más el mensaje.
    console.warn('[voice] start:', e);
    const _why = (e.name && e.name !== 'Error') ? e.name : (e.message || e);
    toast('Micrófono no disponible: ' + _why);
  }
}

// La referencia a la grabación viaja EN la telemetría de pose: el servicio de
// voz contesta al hello con el nombre que le ha puesto a los ficheros, y ese
// nombre se mete en el meta del hello de la telemetría. El relay lo promueve a
// cada registro igual que hace con `frame`, así que sale por /consume y acaba en
// la columna `rec` del CSV. Resultado: una fila de poses dice a qué audio
// pertenece, sin manifiesto que mantener en pie ni nombres que cuadrar a mano.
// Ver docs/telemetry.md y docs/voice-recording.md.
function voiceRefToTelemetry(state, info) {
  if (!telemetry) return;
  // Al parar, recRef ya es null: las poses que vengan después no son de ninguna
  // grabación, y decir lo contrario sería peor que no decir nada.
  const ref = (state === 'idle') ? null : ((info && info.recRef) || (voice && voice.recRef) || null);
  if ((telemetry.meta.rec || null) === ref) return;
  telemetry.setMeta({ rec: ref });
}

// El piloto. Grabar la voz de alguien tiene que notarse desde fuera del casco
// —dentro, el único aviso honesto es el indicador de micro del sistema, que se
// apaga al soltar la pista en stop()—.
function voiceBadge(state) {
  const on = state === 'recording' || state === 'offline';
  const b = document.getElementById('rec-badge');
  if (b) {
    b.style.display = on ? '' : 'none';
    b.textContent = state === 'offline' ? '● rec · sin red' : '● rec';
    b.classList.toggle('badge-rec-off', state === 'offline');
  }
  const btn = document.getElementById('rec-btn');
  if (btn) { btn.classList.toggle('rec-on', on); btn.textContent = on ? '■ REC' : 'REC'; }
}

// ══════════════════════════════════════════════════════
// WebXR — Oculus Quest 3
// ══════════════════════════════════════════════════════
async function checkWebXR() {
  if (!navigator.xr) return;
  const ok = vrOk = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (ok) {
    document.getElementById('xr-btn').disabled = false;
    document.getElementById('xr-badge').style.display = 'inline';
  }
  arOk = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (arOk) document.getElementById('ar-btn').disabled = false;
  maybeShowIntro();
}

// ══════════════════════════════════════════════════════
// HEADSET INTRO — one tap into VR or AR
// ══════════════════════════════════════════════════════
// In the headset the flat page is only a doorway (and a poor screen: the 2D
// page plays the 360 choppily on the Quest), so it opens on two big buttons
// that go straight into a mode. The source loads while the intro is up: the
// tap is the user gesture requestSession() needs, and awaiting a manifest
// load in between could spend it. Leaving VR/AR comes back here, which also
// covers a VR <-> AR switch from the in-headset menu that the browser refused.
// A PC keeps the web page. ?intro=1 forces the intro, ?intro=0 disables it.
const INTRO_Q = new URLSearchParams(location.search).get('intro');
let introOn = false;

function maybeShowIntro() {
  if (INTRO_Q === '0') return;
  const headset = /OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent) || arOk;
  if (INTRO_Q !== '1' && !(headset && (vrOk || arOk))) return;
  introOn = true;
  document.getElementById('intro-ar').style.display = arOk ? '' : 'none';
  introShow(true);
  if (curManifestSrc) introReady(true);
  else introLoad();
}

function introShow(v) {
  if (!introOn) return;
  document.getElementById('xr-intro').classList.toggle('show', v);
}

function introStatus(text) { document.getElementById('intro-status').textContent = text; }

function introReady(ok) {
  document.getElementById('intro-vr').disabled = !(ok && vrOk);
  document.getElementById('intro-ar').disabled = !(ok && arOk);
  introStatus(ok ? '' : 'Could not load the stream — use web mode to pick another source');
}

async function introLoad() {
  const src = document.getElementById('video-url-input').value.trim();
  if (!src) return introReady(false);
  introReady(false); introStatus('Loading…');
  // The buttons wake up with the first picture, not when startManifest()
  // returns: after the load it still sets up audio, live sync and close-ups,
  // and none of that has to finish before a session can start.
  videoEl.addEventListener('loadeddata', () => introReady(true), { once: true });
  try { await startManifest(src); } catch (e) { console.warn('[intro] load:', e); }
  const ok = videoEl.readyState >= 1 && !videoEl.error;
  // A recording waits at the start for whoever puts the headset on; the
  // session start plays it. A live stream keeps running: its place is the edge.
  if (ok && isFinite(videoEl.duration) && introOn &&
      document.getElementById('xr-intro').classList.contains('show')) {
    videoEl.pause(); videoEl.currentTime = 0; updatePlayBtn();
  }
  introReady(ok);
}

// The tap has to start the audio too. The intro loads the source WITHOUT a
// gesture, so the engine's AudioContext is born suspended and engine.attach()
// sits in `await ctx.resume()` until one comes — and everything after it waits
// with it: the musicians' directions (so the pinch picked nobody and the zoom
// did nothing), `audioCtx`, spotlight, close-ups. `audioCtx` is only assigned
// after attach returns, so the context has to be taken from the engine.
function resumeAudio() {
  const ctx = audioCtx || (engine && engine.audioContext);
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

function introGo(mode) {
  resumeAudio();
  (mode === 'ar' ? enterAR : enterXR)();
}

function introWeb() {
  introShow(false);
  introOn = false;         // web mode chosen: leaving XR later lands on the page
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
      optionalFeatures: ['bounded-floor', ...HAND_FEATS],
    });

    renderer.xr.setReferenceSpaceType('local-floor');
    xrHeadroomBefore();
    await renderer.xr.setSession(xrSession);
    xrHeadroomAfter(xrSession);

    // frame: en qué marco viajan p/q. En VR es el del propio casco (ver arTelemetryPose).
    telemetrySetMode('vr');
    voice?.mark('enter-vr');

    document.getElementById('xr-btn').textContent = 'EXIT VR';
    introShow(false);
    closeupPlaced = undefined;     // the head is somewhere else now: re-place the panel
    pointer.attach(xrSession);
    xrZoomGoal = null; xrZoomStem = -1; xrZoomDir = null; xrLastT = 0; xrSpotStem = -1; xrZoomMoves = true;

    xrSession.addEventListener('end', () => {
      xrSession = null;
      pointer.detach();
      xrMenu.close();
      xrZoomGoal = null; xrZoomStem = -1; xrZoomDir = null; xrSpotStem = -1; xrZoomMoves = true; engine?.setSpotlightStem(-1);
      telemetryLeaveXR();
      voice?.mark('exit-vr');   // la grabación sigue: lo que se dice al salir vale tanto como lo de dentro
      if (debugMesh) debugMesh.visible = false;
      if (SYNCLOG || SHAREDLOG || ARPERF) arPerfPanelClear();
      document.getElementById('xr-btn').textContent = 'VR';
      closeupPlaced = undefined; closeupZoomReset();
      renderer.setAnimationLoop(null);
      requestAnimationFrame(renderLoop);
      introShow(true);
      xrResumePending();
    });

    let frameCount = 0;

    renderer.setAnimationLoop((time, frame) => {

      frameCount++;
      const _p0 = ARPERF ? perfFrameStart(time) : 0;

      // ── Actualizar textura vídeo ──────────────────
      if (videoEl && videoEl.readyState >= 2) {
        if (videoTexture && !HAS_RVFC) videoTexture.needsUpdate = true;
      }
      updateCloseupAnim();

      let hasPose = false;
      let yawDeg = 0;

      // ── Orientación headset → ambisonics ──────────
      if (frame) {
        const refSpace = renderer.xr.getReferenceSpace();
        if (refSpace) {
          const pose = frame.getViewerPose(refSpace);
          if (pose) {
            hasPose = true;
            xrLastPose = pose;
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
              if (markGrab >= 0) break;            // the stick is resizing a grabbed ring
              if (isrc.handedness === 'right' && isrc.gamepad && isrc.gamepad.axes.length >= 4) {
                const jy = isrc.gamepad.axes[3];   // adelante = negativo
                if (Math.abs(jy) > 0.15) {
                  xrZoomGoal = null; xrZoomStem = -1;   // the stick takes over from a point
                  // From a still-sphere pinch zoom: start the stick from zero,
                  // or the sphere would leap to where the audio zoom was.
                  if (!xrZoomMoves) { xrZoomDist = 0; xrZoomDir = null; xrZoomMoves = true; }
                  xrSpotStem = -1;                        // the stick zooms where you look
                  xrZoomDist = Math.max(0, Math.min(80, xrZoomDist - jy * 1.2));
                }
              }
            }
            // ...or towards where a pinch asked for (see xrSelect).
            const dt = xrLastT ? Math.min((time - xrLastT) / 1000, 0.1) : 0;
            xrLastT = time;
            if (xrZoomGoal != null) {
              // Smootherstep: zero speed AND acceleration at both ends.
              const p = Math.min(1, (performance.now() - xrZoomT0) / 1000 / VR_ZOOM_S);
              const e = p * p * p * (p * (p * 6 - 15) + 10);
              xrZoomDist = xrZoomFrom + (xrZoomGoal - xrZoomFrom) * e;
              // Pinching one musician after another swings the zoom across
              // instead of cutting to them, on the same curve.
              if (xrZoomDir) {
                xrZoomDir.set(xrZoomDirFrom.x + (xrZoomDirGoal[0] - xrZoomDirFrom.x) * e,
                              xrZoomDirFrom.y + (xrZoomDirGoal[1] - xrZoomDirFrom.y) * e,
                              xrZoomDirFrom.z + (xrZoomDirGoal[2] - xrZoomDirFrom.z) * e).normalize();
              }
              if (p >= 1) xrZoomGoal = null;
            }
            // Back at zero zoom the direction no longer matters and the head's
            // forward takes over again.
            if (xrZoomDist <= 0 && xrZoomGoal == null) { xrZoomDir = null; xrZoomMoves = true; xrSpotStem = -1; }

            // El zoom de VR (joystick) alimenta el spotlight de stems: en
            // escritorio lo hace el FOV vía setZoomByFactor, pero en VR no hay
            // FOV controlable, así que mapeamos xrZoomDist → zoom normalizado.
            // Boost completo a media carrera (≈40) para que responda pronto.
            const zoomN = xrZoomDist / 40;
            engine?.setSpotlightStem(xrSpotStem);
            engine?.setZoomNormalized(zoomN);
            updateCloseupFocus();   // close-up del músico enfocado (joystick zoom)
            pointer.update(frame, refSpace);

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
            // A musician zoomed in by a pinch is the focus wherever the head is.
            telemetry?.sample(pos, q, zoomN,
                              xrZoomStem >= 0 ? xrZoomStem : (engine?.getFocusedStem(0.3) ?? -1),
                              videoEl?.currentTime || 0);

            // Centrar la esfera en la cabeza y desplazarla EN CONTRA de la vista
            // para "acercar" lo que miras (xrZoomDist = 0 → solo centrada).
            if (sphere) {
              const fwd = xrZoomDir || _zoomFwd.set(0, 0, -1)
                .applyQuaternion(_zoomQ.set(q.x, q.y, q.z, q.w));
              const k = xrZoomMoves ? xrZoomDist : 0;
              sphere.position.set(
                pos.x - fwd.x * k,
                pos.y - fwd.y * k,
                pos.z - fwd.z * k);
            }

            // Debug panel fijo delante — altura ojo, 2m adelante
            if (debugMesh) {
              debugMesh.position.set(pos.x, pos.y + 0.1, pos.z - 2);
              debugMesh.visible = true;
            }

            // ?synclog=1: el error de sincronía delante de la cara, el mismo
            // sprite que en AR. Aquí no hay avisos del ancla con los que
            // turnarse, así que va derecho.
            if (SYNCLOG || SHAREDLOG) {
              arPerfPanelPlace(pose);
              syncPanelReport(performance.now());
            } else if (ARPERF || arNoticeUntil) arPerfPanelPlace(pose);
            // A notice (e.g. "GT saved" from the calibration rings) expires
            // as in AR; the panel stays if there is a report to show.
            if (arNoticeUntil && performance.now() > arNoticeUntil) {
              arNoticeUntil = 0;
              if (!ARPERF && !SYNCLOG && !SHAREDLOG) arPerfPanelClear();
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

      // Sin updateAmbiViz(), como en AR: es un canvas 2D del HUD de la página,
      // que en sesión inmersiva no se ve, y costaba cuatro lecturas de analyser y
      // un barrido del buffer en cada frame del hilo principal.
      updateStemMarks();
      const _p2 = ARPERF ? perfRenderBegin() : 0;
      renderer.render(scene, camera);
      if (ARPERF) perfFrameEnd(_p0, _p2, time);
    });

    if (videoEl) videoEl.play();
    if (audioEl) audioEl.play().catch(()=>{});
    if (audioCtx) audioCtx.resume();
    toast('Quest 3 VR activo');
    if (ARPERF) { _perf.t0 = _perf.lastT = 0; perfTraceStart(); arPerfPanelDraw(['[perf] measuring…', '', 'first window in 2 s', '']); }

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
  // La rotación, en MUNDO y no la local. `roomGroup.quaternion` es su giro
  // respecto al padre, y mientras el padre fue la escena las dos eran la misma
  // cosa; desde que cuelga de sharedGroup (el marco común entre cascos) ya no, y
  // usar la local metía el giro del marco compartido en cada muestra — justo en
  // las coordenadas que existen para poder comparar cascos entre sí.
  _telQ.set(q.x, q.y, q.z, q.w)
       .premultiply(roomGroup.getWorldQuaternion(_telR).invert());
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
  const tex = MeshFit.srgb(new THREE.CanvasTexture(c));
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set((c.width / c.height) * 0.16, 0.16, 1);   // ~16 cm de alto
  sp.position.set(0, 0.2, 0);
  return sp;
}

// Marcador de fuente: esfera de alambre emisiva + etiqueta con el nombre.
const AR_MARK_IDLE  = 0x00d4ff;   // marcador en reposo
const AR_MARK_FOCUS = 0xffd24a;   // marcador del músico enfocado
const AR_MARK_LOCK  = 0xff7a1a;   // enfocado y fijado con un pinch

function makeSourceMarker(name) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.08, 1),
    // Material por marcador (no compartido): el realce del foco pinta solo uno.
    new THREE.MeshBasicMaterial({ color: MeshFit.colour(AR_MARK_IDLE), wireframe: true })));
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
// Un modelo que NO es una persona de pie —una trompeta suelta, un micro colgado—
// se sube con `offsetYM`, que son metros sobre el suelo de la sala y tampoco toca
// el audio: mover el muñeco y mover la fuente siguen siendo dos cosas distintas.
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
    new THREE.MeshBasicMaterial({ color: MeshFit.colour(AR_MARK_IDLE), side: THREE.DoubleSide,
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
//
// Y el entorno, que no es un adorno de las luces sino lo único que ilumina un
// metal: un material metálico no tiene difuso que iluminar, así que con luces y
// sin entorno sale negro igual. La hemisférica baja a la mitad al entrar el
// entorno, que ya hace el ambiente; con las dos a tope la malla se lava.
let arLights = null;
// Un solo número para todas: el que marca el <video>, que es de donde cuelga
// todo lo demás en este player. Barato aunque no haya ninguna (el caso normal).
function updateMeshAnims() {
  if (!arMeshAnims.length) return;
  const t = videoEl?.currentTime || 0;
  for (const a of arMeshAnims) a.setMediaTime(t);
}

function ensureARLights() {
  if (arLights) return arLights;
  arLights = new THREE.Group();
  arLights.add(new THREE.HemisphereLight(0xffffff, 0x707070, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 0.5);
  key.position.set(1, 3, 2);
  arLights.add(key);
  scene.environment = MeshFit.environment(renderer);
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
    // MeshFit.clone(): varios músicos pueden compartir fichero (el `ar.mesh`
    // común) y cada uno necesita sus propios nodos para que su mixer los mueva.
    // Y si la malla tiene esqueleto, un clon plano se queda atado al esqueleto
    // del original y no se mueve — de eso se encarga ya MeshFit.clone().
    const fitted = MeshFit.fit(MeshFit.clone(src), { ...spec, name: spec.url });
    holder.add(fitted);
    // La animación la mueve el tiempo de medio (ver MeshFit.animator), así que
    // basta con registrarla: el bucle de AR le pasa el currentTime del <video>.
    const anim = MeshFit.animator(fitted);
    if (anim) {
      arMeshAnims.push(anim);
      // Colocada ya en su primer fotograma, no en reposo: la malla aparece a
      // mitad de una sesión que lleva rato corriendo y tiene que entrar donde
      // va, no dar un salto en el frame siguiente.
      anim.setMediaTime(videoEl?.currentTime || 0);
      console.log(`[mesh] "${spec.url}" animada · clip "${anim.name}" · ${anim.duration.toFixed(1)}s` +
                  (anim.offset ? ` · desfase ${anim.offset}s` : ''));
    }
    holder.position.y = floorY;               // del punto de audio al suelo
    // El aro va en el holder, o sea SIEMPRE en el suelo, y no en la malla: con
    // `offsetYM` la figura puede ir por el aire (una trompeta a la altura a la
    // que se toca), y un aro flotando a media altura no marca ningún sitio.
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
let arLocked     = -1;   // músico fijado con un pinch: el foco no lo suelta la mirada

function resetARFocus() {
  arFocus = arFocusCand = arLocked = -1;
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
  // A pinned musician stays focused wherever the head goes: that is the point of
  // pinning, listening to one player while looking around the room.
  if (arLocked >= 0) return arLocked;
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
    const c = i !== arFocus ? AR_MARK_IDLE : i === arLocked ? AR_MARK_LOCK : AR_MARK_FOCUS;
    if (mark && mark.material) mark.material.color.copy(MeshFit.colour(c));
  });
}

// Pin the focus on musician `i` (a pinch on them), or unpin with -1. Pinning
// skips the gaze dwell: the pinch already is the deliberate "this one". Unpinning
// hands the focus back to the gaze policy as it stands —if you are still
// looking at them they stay focused, otherwise they go after releaseMs— rather
// than dropping it at once, which would be a jump in the mix for no reason.
function lockARFocus(i) {
  arLocked = i;
  arFocusLost = 0;
  if (i >= 0) arFocus = i;
  paintARFocus();
  engine?.setFocusedStem(arFocus);
}

// ── Ray and pinch (both XR modes) ──────────────────────────────────────────
// A pinch (or trigger) tap with the hand's ray on musician `target`, or on
// nothing (-1):
//   VR: on a musician → zoom in to them (close-up and spotlight follow); on
//       another one while zoomed → the zoom swings across; on nothing → out.
//   AR: on a musician → pin them; on the pinned one or on nothing → unpin.
function xrSelect(target) {
  if (arSession) {
    if (target >= 0 && target !== arLocked) lockARFocus(target);
    else if (arLocked >= 0) lockARFocus(-1);
    return;
  }
  if (!xrSession) return;
  if (target === CLOSEUP_TARGET) return closeupZoomTap();
  // Pinch on nothing, or on the musician already zoomed in: zoom back out.
  const d = (target >= 0 && target !== xrZoomStem) ? engine?.getStemDirection(target) : null;
  if (!d) {
    xrZoomStem = -1;
    if (xrZoomDist > 0 || xrZoomGoal) xrZoomTo(0);
    return;
  }
  xrZoomStem = target;
  xrSpotStem = target;
  // Only a crop close-up (or ?vrzoom=move) moves the sphere; see xrZoomMoves.
  // Switching musicians mid-zoom keeps what the first pinch chose, so the
  // sphere never jumps.
  if (xrZoomDist <= 0 && !xrZoomGoal)
    xrZoomMoves = VR_ZOOM_MOVE || !!closeupCropByRep[closeupRepByStem[target]];
  xrZoomDirGoal[0] = d[0]; xrZoomDirGoal[1] = d[1]; xrZoomDirGoal[2] = d[2];
  // Start from where the zoom already is: along the head if it came from the
  // stick, or the previous musician — so it swings rather than jumps.
  if (!xrZoomDir) {
    xrZoomDir = xrZoomDist > 0 ? camera.getWorldDirection(new THREE.Vector3())
                               : new THREE.Vector3(d[0], d[1], d[2]);
  }
  xrZoomTo(VR_PINCH_ZOOM);
}

// ── ?stemmarks=1 — where each musician's selection falls, and moving it ─────
// A calibration aid. Each musician gets a ring on the 360 at the direction the
// player uses for them (azimuthDeg/elevationDeg from the editor), as wide as
// the cone that selects them (hitDeg, or the pointer's default), with their
// name and angles. A ring that does not sit on its musician in the video can
// be moved and resized right there:
//   PC:      drag the ring with the mouse; wheel over it changes its size.
//   Headset: long pinch on the ring grabs it, move the hand, let go; while
//            holding, the controller stick changes its size.
// Every change is saved on release to scene.json through /api/scene/stems,
// which touches only those three fields; the editor notices and reloads them,
// so its next save does not undo them.
// Also switched on for every client by the editor's debug mode (scene.debug).
// Colours: yellow = idle, cyan = under the ray/mouse, green = zoomed / grabbed.
let STEM_MARKS = new URLSearchParams(location.search).get('stemmarks') === '1';
const STEM_MARK_R = 98;              // just inside the 100 m sphere
const HIT_MIN = 2, HIT_MAX = 30;     // selection half-angle limits (deg)
let stemMarks = null, stemMarksEngine = null;
let markGrab = -1;                   // musician being dragged (PC or headset), or -1
let markHover = -1;                  // musician under the mouse on the PC
const _mo = new THREE.Vector3(), _md = new THREE.Vector3();

// The point of the PICTURE a ray is on, as a direction from the sphere's
// centre. This is what a musician's direction means; with the sphere centred
// on the head it is the ray's own direction, but the zoom pushes the sphere
// off-centre and then the two differ. In AR there is no sphere: the ray as is.
function sphereDir(o, d) {
  if (!sphere || !sphere.visible) return d;
  const c = sphere.position, R = 100;
  const ox = o[0] - c.x, oy = o[1] - c.y, oz = o[2] - c.z;
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const t = -b + Math.sqrt(Math.max(0, b * b - (ox * ox + oy * oy + oz * oz - R * R)));
  const px = ox + d[0] * t, py = oy + d[1] * t, pz = oz + d[2] * t;
  const n = Math.hypot(px, py, pz) || 1;
  return [px / n, py / n, pz / n];
}

const _cuHitPos = [0, 0, 0];
function pickStem(o, d) {
  // The close-up is in front of the musicians: a ray on it is on it.
  const h = closeupHit(o, d);
  if (h) { _cuHitPos[0] = h.x; _cuHitPos[1] = h.y; _cuHitPos[2] = h.z; return CLOSEUP_TARGET; }
  return engine ? engine.getStemAlong(o, sphereDir(o, d), { ...RAY_CONE, perStem: true }) : -1;
}

function stemHitDeg(i) { return (engine && engine.getStemHitDeg(i)) || RAY_CONE.coneDeg; }

function buildStemMarks() {
  if (stemMarks) { scene.remove(stemMarks); stemMarks.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); }
  stemMarks = new THREE.Group();
  stemMarks.userData.items = [];
  for (let i = 0; i < engine.stemCount; i++) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.9,
                                              depthTest: false, side: THREE.DoubleSide });
    // Unit ring, scaled to the cone in placeStemMark().
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 64), mat);
    const dot  = new THREE.Mesh(new THREE.CircleGeometry(1, 16), mat);
    ring.renderOrder = dot.renderOrder = 998;
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const tex = MeshFit.srgb(new THREE.CanvasTexture(c));
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    label.renderOrder = 999;
    g.add(ring, dot, label);
    stemMarks.add(g);
    stemMarks.userData.items[i] = { g, mat, ring, dot, label, c, tex };
    placeStemMark(i);
  }
  scene.add(stemMarks);
  stemMarksEngine = engine;
}

// Put mark `i` where the engine has musician `i` now, at its cone size, and
// redraw its label. Called on build and on every drag/resize step.
function placeStemMark(i) {
  const it = stemMarks && stemMarks.userData.items[i];
  const d = engine.getStemDirection(i);
  if (!it || !d) return;
  const hit = stemHitDeg(i);
  const rr = STEM_MARK_R * Math.tan(hit * Math.PI / 180);
  it.g.position.set(d[0] * STEM_MARK_R, d[1] * STEM_MARK_R, d[2] * STEM_MARK_R);
  it.g.lookAt(0, 0, 0);
  it.ring.scale.setScalar(rr);
  it.dot.scale.setScalar(STEM_MARK_R * Math.tan(8 * Math.PI / 180) * 0.06);   // fixed size
  const def = (stemDefs && stemDefs[i]) || {};
  const cx = it.c.getContext('2d');
  cx.clearRect(0, 0, 512, 128);
  cx.fillStyle = 'rgba(0,0,0,0.6)'; cx.fillRect(0, 0, 512, 128);
  cx.fillStyle = '#fff'; cx.font = 'bold 52px sans-serif'; cx.textAlign = 'center';
  cx.fillText(`${i + 1} · ${def.name || 'stem ' + (i + 1)}`, 256, 56);
  cx.font = '34px monospace'; cx.fillStyle = '#ffd24a';
  cx.fillText(`az ${(+def.azimuthDeg || 0).toFixed(1)}  el ${(+def.elevationDeg || 0).toFixed(1)}  ⌀ ${hit.toFixed(1)}°`, 256, 108);
  it.tex.needsUpdate = true;
  const lw = STEM_MARK_R * Math.tan(8 * Math.PI / 180);
  it.label.scale.set(lw * 1.6, lw * 0.4, 1);
  it.label.position.set(0, -(rr + lw * 0.35), 0);
}

function updateStemMarks() {
  if (!STEM_MARKS || !engine || !sphere) return;
  // Built once the engine knows the directions (they exist after attach), and
  // again if a new source brought a new engine.
  if (stemMarksEngine !== engine) {
    if (!engine.stemCount || !engine.getStemDirection(0)) return;
    buildStemMarks();
  }
  // In the 360 the musicians are directions from the head: the marks ride with
  // the sphere (head-centred, pushed by the zoom). AR hides the sphere, and them.
  stemMarks.visible = sphere.visible;
  stemMarks.position.copy(sphere.position);
  const hov = (xrSession && pointer) ? pointer.hovered : markHover;
  stemMarks.userData.items.forEach((it, i) => {
    if (it) it.mat.color.setHex(i === markGrab || i === xrZoomStem ? 0x5dff8f : i === hov ? 0x00d4ff : 0xffd24a);
  });
}

// Move musician `i` to the picture point direction `d` (unit, from the sphere
// centre): the engine (selection + sound), the scene definition (labels, AR)
// and the mark.
function setStemFromDir(i, d) {
  const az = Math.round(Math.atan2(-d[0], -d[2]) * 180 / Math.PI * 2) / 2;
  const el = Math.round(Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180 / Math.PI * 2) / 2;
  engine.setStemAngles(i, az, el);
  if (stemDefs[i]) { stemDefs[i].azimuthDeg = az; stemDefs[i].elevationDeg = el; }
  placeStemMark(i);
}

function setStemHit(i, deg) {
  const h = Math.round(Math.max(HIT_MIN, Math.min(HIT_MAX, deg)) * 2) / 2;
  engine.setStemHitDeg(i, h);
  if (stemDefs[i]) stemDefs[i].hitDeg = h;
  placeStemMark(i);
}

// Saved one musician at a time, and only the three fields this tool edits.
function saveStem(i) {
  const s = stemDefs[i];
  if (!s) return;
  fetch('/api/scene/stems', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stems: [{ i, name: s.name, azimuthDeg: s.azimuthDeg, elevationDeg: s.elevationDeg,
                                     hitDeg: stemHitDeg(i) }] }),
  }).then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(new Error(j.error || r.status))))
    .then(() => arNotice(`${s.name || 'stem ' + (i + 1)} saved`))
    // A server older than this endpoint answers 404: that one needs a restart.
    .catch(e => arNotice(`NOT saved: ${s.name || 'stem ' + (i + 1)} (${e.message}) - restart server`));
}

// Headset: long pinch on a ring (see RayPointer's grab).
const markGrabXR = {
  can: i => STEM_MARKS && !!xrSession && engine && i < engine.stemCount,
  start: (i) => { markGrab = i; },
  move: (i, o, d, src) => {
    setStemFromDir(i, sphereDir(o, d));
    const gp = src.gamepad;
    if (gp && gp.axes.length >= 4 && Math.abs(gp.axes[3]) > 0.15)
      setStemHit(i, stemHitDeg(i) - gp.axes[3] * 0.25);      // stick forward = bigger
  },
  end: (i) => { markGrab = -1; saveStem(i); },
};

// PC: the mouse. Registered in the capture phase so that, on a ring, it
// claims the event before the view-drag and FOV-wheel handlers see it.
function setupStemMarkMouse() {
  const c = renderer.domElement;
  const rc = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const dirAt = e => {
    const r = c.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, camera);
    _mo.copy(rc.ray.origin); _md.copy(rc.ray.direction);
    return sphereDir([_mo.x, _mo.y, _mo.z], [_md.x, _md.y, _md.z]);
  };
  const active = () => STEM_MARKS && engine && stemMarks && !renderer.xr.isPresenting;
  c.addEventListener('mousedown', e => {
    if (!active()) return;
    const i = engine.getStemAlong([0, 0, 0], dirAt(e), { ...RAY_CONE, perStem: true });
    if (i < 0) return;
    markGrab = i;
    e.stopImmediatePropagation();
  }, { capture: true });
  window.addEventListener('mousemove', e => {
    if (!active()) return;
    if (markGrab >= 0) { setStemFromDir(markGrab, dirAt(e)); return; }
    if (e.target !== c) return;
    markHover = engine.getStemAlong([0, 0, 0], dirAt(e), { ...RAY_CONE, perStem: true });
    c.style.cursor = markHover >= 0 ? 'grab' : '';
  });
  window.addEventListener('mouseup', () => {
    if (markGrab < 0) return;
    const i = markGrab; markGrab = -1; saveStem(i);
  });
  let wheelSave = null;
  c.addEventListener('wheel', e => {
    if (!active() || markHover < 0) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const i = markHover;
    setStemHit(i, stemHitDeg(i) - Math.sign(e.deltaY) * 0.5);
    clearTimeout(wheelSave);
    wheelSave = setTimeout(() => saveStem(i), 600);
  }, { capture: true, passive: false });
}

// PC: a click (not a drag) on the close-up zooms it a bit more; another, back.
function setupCloseupClick() {
  const c = renderer.domElement;
  const rc = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  c.addEventListener('mousedown', e => { down = { x: e.clientX, y: e.clientY }; });
  c.addEventListener('click', e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || renderer.xr.isPresenting) return;
    const r = c.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, camera);
    const o = rc.ray.origin, d = rc.ray.direction;
    if (closeupHit([o.x, o.y, o.z], [d.x, d.y, d.z])) closeupZoomTap();
  });
}

// The editor's debug mode (scene.debug = true): what ?stemmarks=1&arperf=1 do,
// for every client that loads while it is on.
function enableDebugMode() {
  STEM_MARKS = true;
  ARPERF = true;
  toast('Debug mode (from the editor): musician marks + performance');
}

// World position of musician `i` when it is a point of the room (AR), so the
// ray can end on them. In the 360 they are at infinity: null.
const _stemPos = [0, 0, 0];
const _stemV = new THREE.Vector3();
function xrStemWorldPos(i) {
  if (i === CLOSEUP_TARGET) return _cuHitPos;      // the ray ends on the close-up
  if (!arSession || !arSources[i]) return null;
  arSources[i].getWorldPosition(_stemV);
  _stemPos[0] = _stemV.x; _stemPos[1] = _stemV.y; _stemPos[2] = _stemV.z;
  return _stemPos;
}

// Direction from `o` to musician `i` on the 360 sphere (moved by the zoom), for
// the head-aim glow; null for anything targetPos already places.
const _stemDir = [0, 0, 0];
function xrStemDirFrom(i, o) {
  if (!engine || i < 0 || i === CLOSEUP_TARGET) return null;
  const d = engine.getStemDirection(i);
  if (!d) return null;
  const c = sphere && sphere.visible ? sphere.position : { x: 0, y: 0, z: 0 }, R = 100;
  const x = c.x + d[0] * R - o[0], y = c.y + d[1] * R - o[1], z = c.z + d[2] * R - o[2];
  const n = Math.hypot(x, y, z) || 1;
  _stemDir[0] = x / n; _stemDir[1] = y / n; _stemDir[2] = z / n;
  return _stemDir;
}

// ── XR menu (long pinch on nothing) ─────────────────────────────────────────
function xrOpenMenu() {
  if (!xrLastPose) return;
  const inVR = !!xrSession, inAR = !!arSession;
  xrMenu.show([
    { id: 'vr',   label: 'VR · 360°',        active: inVR, note: inVR ? 'now' : '', disabled: !vrOk },
    { id: 'ar',   label: 'AR · passthrough', active: inAR, note: inAR ? 'now' : arOk ? '' : 'not available', disabled: !arOk },
    { id: 'exit', label: 'Exit immersive' },
  ], xrLastPose);
}

function xrMenuChoose(id) {
  xrMenu.close();
  if (id === 'exit') { (xrSession || arSession)?.end(); return; }
  if ((id === 'vr' && xrSession) || (id === 'ar' && arSession)) return;   // already there
  xrPending = id;
  (xrSession || arSession)?.end();
}

// Switching mode is ending one session and requesting the other: WebXR has no
// way to turn a VR session into an AR one. requestSession() needs a user
// gesture, and the pinch that chose the option is one — select events are user
// activation in the Quest browser — as long as the new request comes soon
// after it, which it does: the old session ends in a few frames. If the
// browser refuses anyway, the user lands on the page with a toast saying which
// button to press, rather than stuck in a mode they did not pick.
function xrResumePending() {
  const m = xrPending;
  xrPending = null;
  if (!m) return;
  const go = m === 'ar' ? enterAR : enterXR;
  go().catch(e => toast(`No se pudo entrar en ${m.toUpperCase()}: pulsa el botón ${m.toUpperCase()} (${e.message})`));
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
  // congelado de antes de entrar en AR. Y hay que volver a clavar la esfera: esta
  // recarga elige variante igual que la carga inicial, así que sin esto se vuelve
  // del passthrough con un close-up envolviendo la escena.
  if (!off) { pinSphereTrack(); attachVideoTexture(); }
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

// Dónde cae el origen compartido en MI local-floor, este frame. No forzamos el
// updateMatrixWorld: el render ya recorre el árbol y marcar la rama sucia cuesta
// lo mismo que hoy. Los panners van entonces un frame por detrás — 14 ms a 72 Hz,
// que para colocar una fuente no es nada.
// El ORIGEN del marco común, dibujado a pelo: un cubo y tres ejes de un metro
// colgando de sharedGroup, o sea en 0,0,0 del espacio compartido.
//
// Con los músicos no se puede depurar esto: si dos cascos los ven en sitios
// distintos, la culpa puede ser del navegador (que os colocalice mal — una L
// tiene dos brazos parecidos y una relocalización puede encajar en el equivocado
// y quedarse ahí, firme) o nuestra (que la S se aplique al revés). Los ejes lo
// parten en dos: si los dos cascos ven el cubo en el MISMO punto físico y los
// ejes apuntando igual, el marco es correcto y el fallo está río abajo. Si no,
// el marco que os dan ya es distinto y no hay nada que arreglar en este código.
// Todo lo que el espacio lleva encima, propiedades del prototipo incluidas. Los
// atributos de WebIDL se definen ahí, no en la instancia, así que un `for...in`
// —que es lo que se intentó primero— puede no verlos.
function describeSpace(space) {
  const out = [];
  const seen = new Set();
  for (let o = space; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (seen.has(k) || k === 'constructor') continue;
      seen.add(k);
      let v;
      try { v = space[k]; } catch (_) { continue; }
      if (typeof v === 'function') continue;
      out.push(`${k}=${typeof v === 'object' ? (v && v.constructor ? v.constructor.name : v) : v}`);
    }
  }
  return out.join(' · ') || '(nada legible)';
}

// El espacio compartido se pide DESDE EL BUCLE, con la sesión ya rodando, que es
// lo que hace el ejemplo que funciona (`if (!spaceRequested)` dentro de su frame
// loop). Pedirlo justo después de setSession —lo que se hizo primero— es antes
// del primer frame, con la sesión aún sin rodar y el navegador todavía sin saber
// en qué habitación está; y lo que devuelve entonces es un espacio propio que ya
// no se junta con el de nadie.
//
// Y la otra mitad del mismo problema, que no está en el código: el espacio se
// expone POR PÁGINA. Dos cascos con la misma página pero distinta query pueden
// acabar con espacios distintos, así que la URL tiene que ser idéntica en los
// dos, carácter por carácter.
let sharedRequested = false;
function requestSharedSpace(session) {
  if (sharedRequested) return;
  sharedRequested = true;
  Promise.all([session.requestReferenceSpace('shared'),
               session.requestReferenceSpace('viewer')])
    .then(([shared, viewer]) => {
      arSharedSpace = shared; arViewerSpace = viewer;
      sharedActive = true;
      attachSharedReset(shared);
      if (SHAREDLOG) showSharedOrigin(true);
      arLogAdd(`shared space: concedido (${shared.constructor && shared.constructor.name})`);
      arLogAdd('shared space: ' + describeSpace(shared));
    })
    .catch((e) => {
      arLogAdd('shared space: NO', e);
      arLogAdd('→ flag "WebXR experiments" + Enhanced Spatial Services en cada casco');
    });
}

let sharedOriginMarker = null;
function showSharedOrigin(on) {
  if (!on) {
    if (sharedOriginMarker) { sharedGroup.remove(sharedOriginMarker); sharedOriginMarker = null; }
    return;
  }
  if (sharedOriginMarker) return;
  sharedOriginMarker = new THREE.Group();
  const axes = new THREE.AxesHelper(1);          // X rojo, Y verde, Z azul
  axes.material.depthTest = false;
  sharedOriginMarker.add(axes);
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.12, 0.12),
    new THREE.MeshBasicMaterial({ color: MeshFit.colour(0xff00ff), depthTest: false }));
  sharedOriginMarker.add(cube);
  sharedOriginMarker.renderOrder = 998;
  sharedGroup.add(sharedOriginMarker);           // en el origen del marco común
}

// S (origen compartido → mi local-floor), sacada por el visor.
//
// El primer intento fue `getPose(espacio compartido, local-floor)`, que devolvía
// algo —no nulo, estable— pero colocaba la sala en cualquier parte. El ejemplo de
// Cabanier, que funciona, nunca usa el espacio compartido como objetivo: lo usa
// siempre como BASE, `getPose(viewer, shared)`. Y entrega ese espacio a three
// como reference space (`renderer.xr.setReferenceSpace`), que la r128 no tiene.
//
// Se puede tener lo mismo sin tocar three ni cambiar de versión, componiendo las
// dos poses del visor, que es un sitio que ambos marcos saben expresar:
//
//     visor → local-floor   A   (getViewerPose, la que ya tenemos)
//     visor → compartido    B   (getPose(viewer, shared), la del ejemplo)
//     compartido → local    S = A · B⁻¹
//
// Así la única llamada nueva es la que el ejemplo demuestra que el navegador
// implementa de verdad.
const _mA = new THREE.Matrix4();
function updateSharedFrame(frame, refSpace, pose) {
  if (!arViewerSpace) { _shared.nulls++; return; }
  const b = frame.getPose(arViewerSpace, arSharedSpace);
  if (!b) { _shared.nulls++; return; }   // sin pose: se queda la última buena
  _shared.ok++; _shared.everOk = true;
  _mA.fromArray(pose.transform.matrix);                  // A: visor → local-floor
  sharedGroup.matrix.fromArray(b.transform.inverse.matrix)   // B⁻¹: compartido → visor
             .premultiply(_mA);                          // S = A · B⁻¹
  sharedGroup.matrixWorldNeedsUpdate = true;
  const e = sharedGroup.matrix.elements;
  _shared.x = e[12]; _shared.z = e[14];
  _shared.yawDeg = Math.atan2(-e[8], e[0]) * 180 / Math.PI;
  // `UUId`, con esa grafía, y se relee: nace VACÍO y se rellena cuando el espacio
  // queda establecido de verdad. El ejemplo lo delata al comprobar `.length !== 0`
  // en vez de la existencia. Leerlo una vez al arrancar la sesión —que es lo que
  // se hizo primero— devuelve siempre la cadena vacía, y una cadena vacía se lee
  // como "este espacio no trae uuid" cuando lo que dice es "todavía no".
  _shared.uuid = arSharedSpace.UUId || '';
}

// El `reset` del espacio compartido: el navegador entra con un marco provisional
// —el origen de este casco— y a los pocos segundos lo cambia por el de la sala de
// verdad. Ahí está la diferencia entre los dos cascos: el primero en entrar funda
// el espacio y no recibe reset nunca, y el segundo sí.
//
// No se vuelve a pedir el espacio: un `reset` dice que el origen de ESTE espacio
// ha cambiado, y `getPose` sobre el mismo objeto ya devuelve la transformada
// nueva. Pedirlo otra vez —que es lo que se intentó primero— crea un espacio que
// vuelve a resolverse y a resetearse, y el remedio se convierte en el bucle.
// Tampoco se avisa por pantalla: el aviso dura cuatro segundos y con resets
// seguidos tapa para siempre el panel que hay que leer. Se cuentan y ya.
function onSharedReset() {
  _shared.resets++;
  _shared.lastResetAt = performance.now();
  arLogAdd(`shared space: reset #${_shared.resets}`);
}

function attachSharedReset(space) {
  if (space && space.addEventListener) space.addEventListener('reset', onSharedReset);
}

// La cabeza, en el marco del PADRE de roomGroup, que es donde vive la
// calibración. Sin espacio compartido eso es el local-floor y no cambia nada;
// con él, mover y girar la sala se haría si no con una cabeza de otro marco, y
// la sala se iría de lado al tocar el joystick.
const _headLocal = new THREE.Vector3();
const _headQ     = new THREE.Quaternion();
const _sharedQ   = new THREE.Quaternion();
function headInRoomFrame(pose) {
  const p = pose.transform.position, q = pose.transform.orientation;
  _headLocal.set(p.x, p.y, p.z);
  _headQ.set(q.x, q.y, q.z, q.w);
  if (sharedActive) {
    sharedGroup.updateMatrixWorld(true);
    sharedGroup.worldToLocal(_headLocal);
    _headQ.premultiply(sharedGroup.getWorldQuaternion(_sharedQ).invert());
  }
  const hy = Math.atan2(2 * (_headQ.w * _headQ.y + _headQ.x * _headQ.z),
                        1 - 2 * (_headQ.y * _headQ.y + _headQ.z * _headQ.z));
  return { head: _headLocal, hy };
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
function updateARCalib(frame, refSpace, pose) {
  const session = frame.session;
  // Cabeza y yaw en el marco donde vive la calibración (ver headInRoomFrame).
  // El yaw sale del cuaternión de la pose porque el bucle de AR no mantiene la
  // global `yaw`: esa es la del arrastre de escritorio.
  const { head, hy } = headInRoomFrame(pose);
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
  // El ancla NO se suelta al empezar a mover: el bucle ya deja de seguirla
  // mientras `arCalibrating` esté puesto, y soltarla obligaba a crear otra al
  // terminar. Lo que cambia con el joystick es el desfase de la sala respecto al
  // ancla, no el ancla, que es un punto físico de la sala y no se mueve.
  // Al soltar el grip se da por buena la posición: se guarda y se fija como
  // ancla, que es lo que hace que esto no haya que repetirlo nunca más.
  // Con marco común no se guarda NADA al soltar. Ni el ancla —el cupo es de 8
  // por sitio y no hay forma de vaciarlo, así que gastarlas en un marco que ya
  // sabe dónde está la sala es tirarlas— ni la calibración, que está medida
  // contra el origen compartido y envenenaría la de siempre si se reusara la
  // misma clave. La T de aquí viaja por el relay (Caso C), no por localStorage.
  if (arCalibrating && !active && SHAREDSPACE) { /* la T se comparte, no se guarda */ }
  else if (arCalibrating && !active) { saveARCalib(); saveRoomAnchor(frame, refSpace); }
  // Reintento tras barrer el cupo (ver saveRoomAnchor): necesita este `frame`,
  // vivo, y que no se esté moviendo la sala otra vez.
  else if (arAnchorRedo && !active) { arAnchorRedo = false; saveRoomAnchor(frame, refSpace); }
  arCalibrating = active;
}

// ══════════════════════════════════════════════════════
// ANCLA PERSISTENTE DE SALA
// ══════════════════════════════════════════════════════
// La calibración de arriba se guarda en localStorage, pero esos tres números
// están medidos desde el origen de `local-floor`, que cae donde arrancó la
// sesión: en el arranque siguiente ese origen está en otro sitio y el mismo
// {x,z,yaw} deja la sala en cualquier parte. Por eso había que recalibrar cada
// vez — no es falta de precisión, es que el número guardado no significa nada
// fuera de su sesión.
//
// Lo que falta es un punto de referencia FÍSICO al que colgarlo, y el navegador
// del Quest lo da: createAnchor() crea un ancla, requestPersistentHandle()
// devuelve un UUID que guardamos nosotros, y en la sesión siguiente
// restorePersistentAnchor() devuelve un ancla en el mismo sitio real, porque el
// casco la re-localiza contra su propio mapa de la sala (el Space Setup). Se
// guarda el UUID en lugar de las coordenadas y la sala vuelve sola.
//
// Y de paso resuelve lo de varios espectadores sin que hablen entre ellos: si
// cada casco ancló una vez al mismo sitio de la sala, todos coinciden en cada
// arranque sin canal compartido, sin servidor y sin cámaras. Las anclas
// compartidas entre dispositivos (colocation) NO están expuestas a WebXR; el
// truco es justo que cada uno persista por su cuenta contra el mismo punto.
//
// Límites del runtime: 8 anclas persistentes por sitio (usamos 1), ninguna
// persiste en modo privado, y borrar el historial del navegador las borra. En
// todos esos casos se cae a los joysticks de arriba, que siguen siendo además
// el camino para poner el ancla la primera vez. ?noanchor=1 los fuerza.

let arAnchor        = null;    // XRAnchor de la sala en esta sesión, si lo hay
let arAnchorPending = false;   // creación en vuelo: no encadenar dos guardados
let arAnchorPruned  = false;   // el barrido del cupo, una vez por sesión
let arAnchorRedo    = false;   // reintento pendiente: lo lanza el frame siguiente
let arAnchorTries   = 0;      // reintentos gastados, para no repetir sin fin
let arAnchorLogged  = false;  // la primera colocación de la sesión, ya registrada
const AR_ANCHOR_TRIES = 30;   // ~medio segundo de frames buscando pose del ancla

// Umbral para no repasar el subárbol de la sala por ruido de tracking: el ancla
// está quieta casi siempre y updateMatrixWorld(true) no es gratis.
const AR_ANCHOR_EPS_M   = 0.002;    // 2 mm
const AR_ANCHOR_EPS_RAD = 0.002;    // ~0.1°
const AR_NO_ANCHOR = new URLSearchParams(location.search).get('noanchor') === '1';
// Salida manual por si el cupo se llena de una forma que el barrido automático
// de saveRoomAnchor no cubre: entra con ?resetanchors=1, borra todas las anclas
// del sitio y alinea una vez más. Vale también para empezar de cero en una sala
// nueva sin bucear en el almacenamiento del navegador.
const AR_RESET_ANCHORS = new URLSearchParams(location.search).get('resetanchors') === '1';

// Un ancla por sala, con la misma clave que la calibración a mano.
function arAnchorKey() { return 'arAnchorId:' + (arCfg.venue || 'default'); }
function arOffsetKey() { return 'arAnchorOff:' + (arCfg.venue || 'default'); }
function arAnchorIdsKey() { return 'arAnchorIds:' + (arCfg.venue || 'default'); }

// TODO el historial de UUID que hemos persistido, no solo el vigente. Borrar es
// lo único que libera el cupo de 8 y solo funciona con un UUID válido: los de
// `persistentAnchors` vienen vacíos en el Quest, así que los únicos buenos son
// los nuestros. Si uno se pierde —un borrado que falla, una sesión que se cierra
// entre crear y borrar—, esa ancla se queda en el cupo PARA SIEMPRE y la única
// salida es borrar los datos del sitio a mano. Guardarlos todos hace que siempre
// se pueda barrer lo nuestro; el vigente se mantiene aparte en arAnchorKey().
function loadAnchorIds() {
  try {
    const v = JSON.parse(localStorage.getItem(arAnchorIdsKey()));
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string' && x);
  } catch (_) { /* nada guardado o corrupto */ }
  return [];
}

function rememberAnchorId(id) {
  const ids = loadAnchorIds();
  if (ids.includes(id)) return;
  ids.push(id);
  try { localStorage.setItem(arAnchorIdsKey(), JSON.stringify(ids)); } catch (_) { /* modo privado */ }
}

// Borra las nuestras menos `keep`, y solo saca de la lista las que el runtime
// confirma: una que falle hoy se vuelve a intentar en la sesión siguiente, que es
// justo lo que no pasaba cuando el único registro era el UUID vigente.
async function pruneOwnAnchors(session, keep) {
  if (!session.deletePersistentAnchor) return { ok: 0, fail: 0 };
  const ids = loadAnchorIds();
  const quedan = [], fallidas = [];
  let ok = 0;
  for (const id of ids) {
    if (id === keep) { quedan.push(id); continue; }
    try {
      await session.deletePersistentAnchor(id);
      ok++;
      arLogAdd(`own anchor deleted (${id})`);
      // Si era la vigente, el puntero deja de apuntar a nada: dejarlo haría que
      // la sesión siguiente intentara restaurar un ancla que ya no existe.
      try {
        if (localStorage.getItem(arAnchorKey()) === id) localStorage.removeItem(arAnchorKey());
      } catch (_) { /* modo privado */ }
    }
    catch (e) { quedan.push(id); fallidas.push(id); arLogAdd(`could not delete own anchor (${id})`, e); }
  }
  if (ok) { try { localStorage.setItem(arAnchorIdsKey(), JSON.stringify(quedan)); } catch (_) { /* modo privado */ } }
  return { ok, fail: fallidas.length };
}

// El ancla marca UN punto físico de la sala; dónde queda la escena respecto a ese
// punto es otra cosa, y es la que cambia al recalibrar. Guardarlas juntas —un
// ancla nueva por cada suelta de grip— agota en una tarde de pruebas el cupo de 8
// anclas por sitio, y cuando se llena, persistir falla con "Maximum number of
// anchors reached!" y ya no hay forma de arreglarlo desde la página: el runtime
// enumera las anclas pero devuelve sus UUID vacíos, así que no se pueden borrar.
// Con el desfase aparte se ancla UNA vez y las recalibraciones son tres números
// en localStorage, que no tienen cupo.
let arRoomOff = { dx: 0, dz: 0, dyaw: 0 };

function loadRoomOffset() {
  arRoomOff = { dx: 0, dz: 0, dyaw: 0 };
  try {
    const o = JSON.parse(localStorage.getItem(arOffsetKey()));
    if (o && isFinite(o.dx) && isFinite(o.dz) && isFinite(o.dyaw)) arRoomOff = o;
  } catch (_) { /* nada guardado o corrupto → sala sobre el ancla */ }
}

// Yaw de una pose alrededor de Y, que es el único giro que se hereda del ancla.
function poseYaw(q) {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
}

// Desfase = la posición actual de la sala LEÍDA DESDE el ancla, para que deje de
// depender del origen de la sesión igual que el ancla. Es la inversa exacta de la
// composición que hace followRoomAnchor.
function saveRoomOffset(pose) {
  const p = pose.transform.position;
  const ayaw = poseYaw(pose.transform.orientation);
  const c = Math.cos(ayaw), s = Math.sin(ayaw);
  const ex = roomGroup.position.x - p.x, ez = roomGroup.position.z - p.z;
  arRoomOff = { dx: ex * c - ez * s, dz: ex * s + ez * c, dyaw: roomGroup.rotation.y - ayaw };
  try { localStorage.setItem(arOffsetKey(), JSON.stringify(arRoomOff)); } catch (_) { /* modo privado */ }
  arLogAdd(`offset saved  dx=${arRoomOff.dx.toFixed(2)} dz=${arRoomOff.dz.toFixed(2)}` +
           ` dyaw=${(arRoomOff.dyaw * 180 / Math.PI).toFixed(1)}°` +
           `  · anchor at x=${p.x.toFixed(2)} z=${p.z.toFixed(2)} yaw=${(ayaw * 180 / Math.PI).toFixed(1)}°`);
}

// Recupera el ancla al entrar en AR. No coloca nada todavía: leer su pose exige
// un XRFrame, así que la aplica el bucle en el primer frame que la tenga (ver
// followRoomAnchor). Hasta entonces vale el {x,z,yaw} guardado.
async function restoreRoomAnchor(session) {
  arAnchor = null;
  if (AR_NO_ANCHOR) return;
  // Cada salida de aquí deja la sala en el {x,z,yaw} viejo, o sea EN CUALQUIER
  // PARTE, que desde dentro de las gafas se lee igual en los cuatro casos. Sin
  // decir cuál ha sido no hay forma de distinguir "no se guardó" de "no se
  // recuperó", así que ninguna se va callando.
  if (!session.restorePersistentAnchor) return arNotice('No anchors on this headset: align every session');
  // La pregunta de fondo cuando nada de esto funciona, y no hay consola dentro de
  // las gafas para responderla: ¿concedió el runtime 'anchors'?
  const feats = session.enabledFeatures ? Array.from(session.enabledFeatures) : null;
  const n = session.persistentAnchors ? session.persistentAnchors.length : '?';
  const lista = session.persistentAnchors ? Array.from(session.persistentAnchors) : null;
  console.log('[ar] features:', feats || 'no expuestas', '· anclas persistentes:', lista || 'no expuestas');
  arLogAdd(`features: ${feats ? feats.join(' ') : 'not exposed'}`);
  arLogAdd(`persistentAnchors: ${lista ? lista.length + ' · ' + (typeof lista[0]) + ' ' + lista[0] : 'not exposed'}`);
  arLogAdd(`methods: create=${typeof (window.XRFrame && XRFrame.prototype.createAnchor)}` +
           ` restore=${typeof session.restorePersistentAnchor}` +
           ` delete=${typeof session.deletePersistentAnchor}`);
  arLogSend();      // el entorno ya está: que llegue sin esperar a salir de AR
  if (feats && !feats.includes('anchors'))
    return arNotice(`'anchors' not granted: the room cannot be saved`);
  if (AR_RESET_ANCHORS) {
    const { ok, fail, why, err } = await pruneOrphanAnchors(session, null);
    try { localStorage.removeItem(arAnchorKey()); } catch (_) { /* modo privado */ }
    return arNotice(why ? `Cannot delete the anchors: ${why}`
                        : `${ok} deleted${fail ? `, ${fail} failed: ${err}` : ''}`);
  }
  let id = null;
  try { id = localStorage.getItem(arAnchorKey()); } catch (_) { /* modo privado */ }
  // Este sitio usa UNA ancla: cualquier otra es un resto de una recalibración
  // cuyo borrado se perdió, y son las que llenan el cupo de 8 hasta que persistir
  // deja de funcionar. Se barren al entrar, que es cuando sobra tiempo, en vez de
  // esperar a que el fallo aparezca a mitad de una calibración. Sin await: la
  // sala no depende de esto. Sin `id` guardado no hay ninguna que salvar — sin su
  // UUID un ancla ya no se puede recuperar, así que caen todas.
  // Las NUESTRAS primero, que son las únicas con UUID bueno. La lista del runtime
  // solo sirve donde sí devuelva UUID, así que queda de refuerzo para otros
  // visores, no para el Quest.
  if (loadAnchorIds().length > (id ? 1 : 0))
    pruneOwnAnchors(session, id).then(({ ok }) => ok && console.log('[ar] anclas propias borradas:', ok));
  else if (session.persistentAnchors && session.persistentAnchors.length > (id ? 1 : 0))
    pruneOrphanAnchors(session, id).then(({ ok }) => ok && console.log('[ar] anclas huérfanas borradas:', ok));
  if (!id) return arNotice(`No anchor saved (${n} on this site): align and release the grip`);
  let a = null;
  try { a = await session.restorePersistentAnchor(id); }
  catch (e) { arLogAdd('restorePersistentAnchor', e); console.warn('[ar] ancla no restaurada:', e); return arNotice(`Headset does not recognise the anchor · ${n} on this site`); }
  // Puede resolverse tarde, cuando el usuario ya ha recalibrado a mano y puesto
  // un ancla nueva: entonces la vieja ya no manda.
  loadRoomOffset();
  if (session === arSession && !arAnchor && !arCalibrating) { arAnchor = a; arNotice(`Room restored from its anchor · ${n} on this site`); }
}

// Coloca `roomGroup` sobre el ancla, en cada frame. Hacerlo por frame sale gratis
// y absorbe solo lo que un estimador tendría que perseguir: la deriva de
// `local-floor` y los `reset` del espacio de referencia (recentrar, quitarse las
// gafas) mueven el origen de la sesión, no el ancla, así que la sala se queda
// donde está en vez de saltar.
//
// Del ancla se toman X, Z y yaw y nada más: los 4 GdL del comentario de arriba
// siguen valiendo, la Y la pone el suelo de `local-floor` y la vertical la
// alinea la IMU. Heredar del ancla un par de grados de inclinación torcería la
// sala sin corregir ningún error real.
function followRoomAnchor(frame, refSpace) {
  if (!arAnchor) return;
  let pose = null;
  try { pose = frame.getPose(arAnchor.anchorSpace, refSpace); }
  catch (_) { arAnchor = null; return; }   // borrada a mitad de sesión
  if (!pose) return;               // sin tracking este frame: se queda donde estaba
  const p = pose.transform.position;
  const ayaw = poseYaw(pose.transform.orientation);
  // La sala cuelga del ancla: su sitio es el del ancla más el desfase, girado por
  // el yaw del ancla para que el desfase se lea en el marco de la propia ancla.
  const c = Math.cos(ayaw), s = Math.sin(ayaw);
  const x = p.x + arRoomOff.dx * c + arRoomOff.dz * s;
  const z = p.z - arRoomOff.dx * s + arRoomOff.dz * c;
  const yaw = ayaw + arRoomOff.dyaw;
  // Diferencia de ángulos envuelta: rotation.y viene de acumular giros de
  // joystick y puede haberse ido de (-π, π].
  const d = yaw - roomGroup.rotation.y;
  const dYaw = Math.atan2(Math.sin(d), Math.cos(d));
  if (Math.abs(x - roomGroup.position.x) < AR_ANCHOR_EPS_M &&
      Math.abs(z - roomGroup.position.z) < AR_ANCHOR_EPS_M &&
      Math.abs(dYaw) < AR_ANCHOR_EPS_RAD) return;
  if (!arAnchorLogged) {
    arAnchorLogged = true;
    arLogAdd(`anchor placed  anchor x=${p.x.toFixed(2)} z=${p.z.toFixed(2)} yaw=${(ayaw * 180 / Math.PI).toFixed(1)}°` +
             `  · offset dx=${arRoomOff.dx.toFixed(2)} dz=${arRoomOff.dz.toFixed(2)} dyaw=${(arRoomOff.dyaw * 180 / Math.PI).toFixed(1)}°` +
             `  → room x=${x.toFixed(2)} z=${z.toFixed(2)} yaw=${(yaw * 180 / Math.PI).toFixed(1)}°`);
  }
  applyARCalib({ x, z, yaw });
  roomGroup.updateMatrixWorld(true);     // la leen worldToLocal y los panners
}

// La cuota del runtime son 8 anclas persistentes por sitio y nosotros usamos
// una: las demás son restos de recalibraciones cuyo borrado falló (va con
// `.catch()` vacío) o de sesiones que se cerraron entre crear y borrar. Con el
// cupo lleno, persistir la siguiente falla con InvalidStateError y desde dentro
// de las gafas eso se lee como "el ancla no funciona" — cuando lo que pasa es
// que sobran. Aquí no hay ancla de nadie más, así que todo lo que no sea `keep`
// se puede borrar.
async function pruneOrphanAnchors(session, keep) {
  const list = session.persistentAnchors ? Array.from(session.persistentAnchors) : null;
  // Las tres salidas de aquí son distintas y hay que poder contarlas: no hay API
  // para listar, no hay API para borrar, o el borrado falla ancla por ancla.
  if (!list) return { ok: 0, fail: 0, why: 'no list', err: '' };
  if (!session.deletePersistentAnchor) return { ok: 0, fail: 0, why: 'no delete API', err: '' };
  // El runtime del Quest enumera las anclas pero devuelve sus UUID VACÍOS, y sin
  // identificador no hay nada que borrar: `deletePersistentAnchor('')` contesta
  // OperationError tantas veces como anclas haya. Se detecta aquí en vez de
  // gastar una llamada por ancla para acabar en el mismo sitio, y sobre todo para
  // poder decirlo: con el cupo lleno y sin UUID, esto no se arregla desde la
  // página. Los únicos UUID buenos son los que guardamos nosotros al persistir.
  if (list.length && !list.some(u => u))
    return { ok: 0, fail: 0, why: 'the headset gives no UUIDs', err: '' };
  console.log('[ar] a borrar:', list.length, 'entradas, la primera es', typeof list[0], list[0]);
  let ok = 0, fail = 0, err = '';
  for (const uuid of list) {
    if (!uuid || uuid === keep) continue;
    try { await session.deletePersistentAnchor(uuid); ok++; }
    catch (e) {
      fail++;
      // El primero basta: nueve rechazos del mismo runtime son el mismo motivo,
      // y ese motivo es lo único que no sabemos todavía.
      if (!err) err = (e && (e.name || e.message)) ? (e.name || e.message) : String(e);
      if (fail === 1) arLogAdd(`deletePersistentAnchor(${uuid})`, e);
      console.warn('[ar] no se pudo borrar el ancla', uuid, e);
    }
  }
  return { ok, fail, why: '', err };
}

// Fija como ancla persistente la calibración que se acaba de hacer a mano. A
// partir de aquí esta sala ya no se vuelve a calibrar en este casco.
async function saveRoomAnchor(frame, refSpace) {
  if (arAnchorPending) return;
  if (AR_NO_ANCHOR) { arNotice('Alignment saved (?noanchor=1)'); return; }
  if (!frame.createAnchor) { arNotice('Saved for this session only: no anchors'); return; }
  // Con un ancla ya puesta —recién restaurada o creada en esta sesión— no se crea
  // ninguna: lo que ha cambiado es dónde está la sala respecto a ella. Este es el
  // camino normal de toda recalibración a partir de la primera, y el que hace que
  // el cupo de 8 no se vuelva a tocar.
  if (arAnchor) {
    let pose = null;
    try { pose = frame.getPose(arAnchor.anchorSpace, refSpace); } catch (_) { /* ancla borrada */ }
    if (pose) { arAnchorTries = 0; saveRoomOffset(pose); arNotice('Alignment saved onto the anchor'); return; }
    // Sin pose del ancla en ESTE frame no hay desde dónde medir. Se reintenta en
    // el siguiente en vez de crear otra ancla, que es lo que llenó el cupo. Con
    // tope: reintentar sin fin repintaría el cartel en cada frame, y media
    // segundo sin pose ya no es un hueco de tracking sino un ancla perdida.
    if (arAnchorTries++ < AR_ANCHOR_TRIES) { arAnchorRedo = true; return; }
    arNotice('The anchor gives no pose: align again');
    return;
  }
  arAnchorPending = true;
  const session = frame.session;
  // Aquí se crea ancla nueva: o es la primera de este sitio, o la guardada no se
  // ha podido restaurar. Lo segundo, repetido, es lo que llena el cupo, y como
  // las ajenas no se pueden borrar conviene decirlo antes de que no quepa
  // ninguna, no cuando ya falle.
  const usadas = session.persistentAnchors ? session.persistentAnchors.length : 0;
  if (usadas >= 6) arLogAdd(`WARNING: ${usadas} anchors on this site and the quota is 8`);
  let old = null;
  try { old = localStorage.getItem(arAnchorKey()); } catch (_) { /* modo privado */ }
  // Los dos pasos fallan distinto y hasta ahora se veían igual: crear el ancla
  // es cosa del frame, persistirla es cosa de la cuota del sitio.
  let step = 'create the anchor';
  try {
    // Antes del primer await: `frame` solo vale dentro de su callback, y la
    // llamada a createAnchor tiene que salir de aquí. La promesa ya resuelve
    // cuando quiera.
    const yaw = roomGroup.rotation.y;
    const a = await frame.createAnchor(new XRRigidTransform(
      { x: roomGroup.position.x, y: 0, z: roomGroup.position.z },
      { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }), refSpace);
    step = 'persist the anchor';
    const id = await a.requestPersistentHandle();
    arAnchor = a;
    // Se ha creado EN la posición de la sala, así que no hay desfase todavía.
    arRoomOff = { dx: 0, dz: 0, dyaw: 0 };
    try { localStorage.setItem(arOffsetKey(), JSON.stringify(arRoomOff)); } catch (_) { /* modo privado */ }
    try { localStorage.setItem(arAnchorKey(), id); } catch (_) { /* modo privado */ }
    rememberAnchorId(id);
    // Solo con la nueva ya en la mano: son 8 como mucho por sitio, y dejar las
    // viejas colgando acabaría llenando el cupo. Este es el ÚNICO borrado que se
    // hace con un UUID bueno —el que guardamos al persistir— porque los de
    // `persistentAnchors` vienen vacíos; que fallara en silencio es lo que dejó
    // que se acumularan nueve sin que nadie se enterara.
    if (old && old !== id && session.deletePersistentAnchor)
      session.deletePersistentAnchor(old)
        .then(() => {
          arLogAdd(`previous anchor deleted (${old})`);
          const ids = loadAnchorIds().filter(x => x !== old);
          try { localStorage.setItem(arAnchorIdsKey(), JSON.stringify(ids)); } catch (_) { /* modo privado */ }
        })
        .catch(e => arLogAdd(`could not delete the previous one (${old})`, e));
    arNotice('Room anchored: no need to do this again');
  } catch (e) {
    const name = (e && (e.name || e.message)) ? (e.name || e.message) : String(e);
    const n = session.persistentAnchors ? session.persistentAnchors.length : '?';
    arLogAdd(`failed to ${step}, ${n} persistent`, e);
    console.warn(`[ar] fallo al ${step} el ancla (${n} persistentes):`, e);
    // Cupo lleno: se barren las anclas del sitio y se reintenta. No se mira QUÉ
    // error fue: el runtime lo llama InvalidStateError, pero atar la limpieza a
    // ese nombre exacto ya falló una vez —basta con que la excepción no traiga
    // `name`— y el barrido no estropea nada si la causa era otra, porque el
    // reintento vuelve a crear la única ancla que este sitio usa.
    //
    // El reintento no puede ser aquí: tras el await `frame` ya está muerto y
    // createAnchor exige uno vivo, así que lo recoge el bucle en el frame
    // siguiente. Una vez por sesión: si tras limpiar sigue fallando, la causa es
    // otra y repetir solo taparía el error de verdad.
    if (step === 'persist the anchor' && !arAnchorPruned) {
      arAnchorPruned = true;
      // Sin `keep`: la creación acaba de fallar, así que no hay ancla nueva que
      // proteger y todo lo nuestro sobra. Las nuestras primero porque con el cupo
      // lleno son las únicas que se pueden liberar de verdad — las de la lista
      // del runtime vienen sin UUID. Un UUID solo se olvida cuando el runtime
      // confirma el borrado: tirarlo antes deja esa ancla en el cupo para
      // siempre, sin nadie que sepa ya su identificador.
      const propias = await pruneOwnAnchors(session, null);
      const { ok: ajenas, fail, why, err } = propias.ok
        ? { ok: 0, fail: 0, why: '', err: '' }
        : await pruneOrphanAnchors(session, null);
      const ok = propias.ok + ajenas;
      if (ok) { arAnchorRedo = true; arNotice(`Quota full (${n}): ${ok} deleted, retrying`); }
      else arNotice(`Could not ${step}: ${name} · ${n} anchors · delete: ${why || err || fail + ' failures'}`);
    } else {
      arNotice(`Could not ${step}: ${name} · ${n} anchors`);
    }
  } finally {
    arAnchorPending = false;
  }
}

// Coloca un objeto por stem alrededor del usuario (usando su az/el) y lo vincula
// al motor: a partir de aquí el panner de ese stem sigue la posición del objeto.
function buildARSources() {
  clearARSources();
  if (!engine || !stemDefs.length) return;
  // La calibración va antes que los marcadores: bindStemToObject lee la
  // matrixWorld en el momento de vincular, y esa ya debe ser la de la sala
  // colocada (si no, el primer frame suena en el sitio equivocado).
  // Con marco común se empieza en la identidad: la calibración guardada se midió
  // contra el local-floor de este casco, o sea contra un origen que ya no es el
  // que manda, y aplicarla dejaría a cada casco con su propio error.
  applyARCalib(SHAREDSPACE ? { x: 0, z: 0, yaw: 0 } : loadARCalib());
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
  // Los mixers apuntan a nodos que se van con los marcadores: sin soltarlos, la
  // siguiente sesión de AR anima mallas que ya no están en la escena.
  for (const a of arMeshAnims) a.dispose();
  arMeshAnims = [];
  // Fuera las luces con las mallas: en el 360 no hay nada que iluminar y una luz
  // de más es trabajo del shader por cada fotograma que nadie ve. El entorno se
  // suelta igual (la textura sigue cacheada: volver a AR no la reconstruye).
  if (arLights) { scene.remove(arLights); scene.environment = null; }
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
      // 'anchors': el ancla persistente de sala (ver restoreRoomAnchor). Va en
      // opcionales para no dejar sin AR a un runtime que no la traiga: sin ella
      // se cae a la calibración a mano, que sigue entera.
      optionalFeatures: SHAREDSPACE
        // 'unbounded' porque el ejemplo que funciona lo pide junto a 'shared'.
        ? [...HAND_FEATS, 'anchors', 'shared', 'unbounded']
        : [...HAND_FEATS, 'anchors'],
    });
    // Lo primero a descartar cuando la sala no vuelve a su sitio: sin 'anchors'
    // concedida no hay nada que persistir, y como va en optionalFeatures la
    // sesión arranca igual sin decir ni pío.
    const arFeats = arSession.enabledFeatures ? Array.from(arSession.enabledFeatures) : null;
    console.log('[ar] features:', arFeats ? arFeats.join(' ') : 'no expuestas');
    renderer.xr.setReferenceSpaceType('local-floor');
    xrHeadroomBefore();
    await renderer.xr.setSession(arSession);
    xrHeadroomAfter(arSession);

    // El marco común se pide en el primer frame, no aquí: ver requestSharedSpace.
    sharedActive = false; arSharedSpace = null; arViewerSpace = null;
    sharedRequested = false;
    _shared.ok = _shared.nulls = _shared.resets = 0;
    _shared.everOk = false; _shared.lastResetAt = 0; _shared.uuid = '';
    sharedGroup.matrix.identity();
    sharedGroup.matrixWorldNeedsUpdate = true;
    // 'room': mismo marco que stem.ar y que las posiciones que publicarán las cámaras.
    telemetrySetMode('ar');
    voice?.mark('enter-ar');
    renderer.setClearAlpha(0);                    // deja ver el passthrough
    document.getElementById('ar-btn').textContent = 'EXIT AR';
    introShow(false);

    if (sphere) sphere.visible = false;           // el mundo real sustituye al 360
    resetCloseup();                               // sin close-ups en AR

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
    // Sin await: no hay pose de ancla que leer hasta que haya un XRFrame, así
    // que la sala arranca con el {x,z,yaw} guardado y el bucle la corrige en
    // cuanto el ancla esté. Un frame en el sitio viejo no lo ve nadie.
    // El ancla es un punto de ESTE casco: dentro del marco común no decide nada,
    // y restaurarla gasta tiempo y toca el cupo de 8 para nada.
    if (!SHAREDSPACE) restoreRoomAnchor(arSession);
    buildARSources();
    pointer.attach(arSession);

    arSession.addEventListener('end', () => {
      // ?arperf=1: el resumen se enseña aquí, que es cuando vuelve a haber pantalla.
      // Salir con un aviso en pantalla dejaría el sprite colgado en el 360.
      arNoticeUntil = 0;
      arPerfPanelClear();
      arLogDump();       // sin depender de ?arperf=1: esto es lo que hay que leer
      if (ARPERF) {
        arPerfDump();
        console.log('[arperf] ventanas:', window.__arperf);
      }
      telemetryLeaveXR();
      voice?.mark('exit-ar');
      pointer.detach();
      xrMenu.close();
      // Vuelve la esfera, así que vuelve a hacer falta la imagen.
      if (AR_CUT_VIDEO) setVideoDisabled(false).catch(e => console.warn('[ar] restaurar vídeo:', e));
      // salir con el grip apretado (en marco común no se persiste: ver updateARCalib)
      if (arCalibrating) { if (!SHAREDSPACE) saveARCalib(); arCalibrating = false; }
      // El espacio compartido muere con la sesión (y del todo cuando sale el
      // último), así que no hay nada que conservar: la sala vuelve a la escena.
      sharedActive = false; arSharedSpace = null; arViewerSpace = null;
      sharedRequested = false;
      showSharedOrigin(false);
      sharedGroup.matrix.identity();
      sharedGroup.matrixWorldNeedsUpdate = true;
      resetARFocus();          // suelta el realce: el músico enfocado no puede
      clearARSources();        // seguir 6 dB arriba en el 360 al que se vuelve
      renderer.setClearAlpha(1);
      if (sphere) sphere.visible = true;
      if (engine && arPrevSpot) engine.setSpotlightParams(arPrevSpot);
      if (engine && arPrevBed != null) engine.setBedLevel(arPrevBed);
      arAnchor = null; arAnchorPending = false;   // el XRAnchor muere con la sesión
      arAnchorPruned = false; arAnchorRedo = false; arAnchorTries = 0; arAnchorLogged = false;
      arSession = null;
      document.getElementById('ar-btn').textContent = 'AR';
      renderer.setAnimationLoop(null);
      requestAnimationFrame(renderLoop);
      introShow(true);
      xrResumePending();
    });

    renderer.setAnimationLoop((time, frame) => {
      // La esfera del 360 está oculta en passthrough, así que su textura no se
      // dibuja: marcarla sucia cada frame solo sirve para que el día que se
      // vuelva a ver suba un fotograma viejo. El <video> sigue corriendo igual
      // (es el mismo elemento del que sale el audio).
      if (sphere && sphere.visible && videoEl && videoEl.readyState >= 2 && videoTexture)
        videoTexture.needsUpdate = true;
      // Las mallas animadas, contra el reloj del medio. Va antes del render y
      // fuera del `if (frame)`: es la escena la que tiene que estar al día,
      // haya pose de visor o no.
      updateMeshAnims();
      const _p0 = ARPERF ? perfFrameStart(time) : 0;
      if (frame) {
        const refSpace = renderer.xr.getReferenceSpace();
        const pose = refSpace && frame.getViewerPose(refSpace);
        if (pose) {
          xrLastPose = pose;
          engine?.setRotationFromMatrix4(pose.transform.matrix);  // orientación + posición de cabeza
          if (SHAREDSPACE && !sharedRequested) requestSharedSpace(frame.session);
          if (sharedActive) updateSharedFrame(frame, refSpace, pose);  // S: el marco común, este frame
          updateARCalib(frame, refSpace, pose);                   // recolocar la sala (grip + joysticks)
          // El ancla manda salvo mientras la mano la está moviendo. Con espacio
          // compartido NO: el ancla es un punto de ESTE casco y el marco común ya
          // dice dónde está la sala; dos fuentes de verdad se pelean.
          if (!arCalibrating && !SHAREDSPACE) followRoomAnchor(frame, refSpace);
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
          pointer.update(frame, refSpace);
          if (ARPERF) {
            _perf.audio += _p1 - _p0; _perf.focus += performance.now() - _p1;
          }
          // El panel sigue a la cabeza mientras haya algo que enseñar: el
          // informe de ?arperf=1, o un aviso hasta que caduque.
          if (ARPERF || SYNCLOG || SHAREDLOG || arNoticeUntil) arPerfPanelPlace(pose);
          if (arNoticeUntil && performance.now() > arNoticeUntil) {
            arNoticeUntil = 0;
            // Con ?arperf=1 o ?synclog=1 el panel se queda: tiene qué enseñar.
            if (!ARPERF && !SYNCLOG && !SHAREDLOG) arPerfPanelClear();
          }
          // Después del aviso, no encima: los carteles del ancla son de cuatro
          // segundos y son los que se leen mientras se calibra.
          if ((SYNCLOG || SHAREDLOG) && !ARPERF && !arNoticeUntil) syncPanelReport(performance.now());
        }
      }
      // Sin updateAmbiViz(): es un canvas 2D del HUD de la página, que en sesión
      // inmersiva no se compone y por tanto nadie ve. Cuesta cuatro lecturas de
      // analyser y un bucle sobre el buffer entero (getDominantDirection) en cada
      // frame, en el hilo principal, para no dibujar nada. Al salir de AR vuelve
      // el bucle de escritorio y se repinta solo.
      updateStemMarks();
      const _p2 = ARPERF ? perfRenderBegin() : 0;
      renderer.render(scene, camera);
      if (ARPERF) perfFrameEnd(_p0, _p2, time);
    });

    if (videoEl) videoEl.play();
    if (audioEl) audioEl.play().catch(() => {});
    if (audioCtx) audioCtx.resume();
    toast(`AR · ${arSources.length} fuentes · grip + joystick para alinear la sala`);
    // El panel no tiene nada que enseñar hasta cerrar la primera ventana de 2 s.
    // Sin este cartel, esos dos segundos se leen como "?arperf=1 no funciona".
    if (ARPERF) { _perf.t0 = _perf.lastT = 0; perfTraceStart(); arPerfPanelDraw(['[arperf] measuring…', '', 'first window in 2 s', '']); }
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

document.addEventListener('click', resumeAudio);

// ══════════════════════════════════════════════════════
// EXPONER HANDLERS AL HTML
// Este <script> es un módulo (scope propio): los `onclick="..."` del HTML
// necesitan que estas funciones estén en `window`.
// ══════════════════════════════════════════════════════
Object.assign(window, {
  loadFromURL, loadFile, seekTo, togglePlay, skipBack, skipFwd,
  toggleMute, setVolume, resetView, toggleFS, enterXR, enterAR, toggleVoice,
  introGo, introWeb,
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
