// ============================================================================
//  ImmersiveAudioEngine — API pública del motor de audio inmersivo Ambisonics.
//
//  Encapsula toda la cadena de Web Audio y expone una superficie mínima e
//  independiente de framework (vanilla / React / Vue / WebXR):
//
//      mediaElement → [source] → rotator → multiplier → decoder → gain ─┬─→ destination
//                                                                       └─→ analyser
//
//  Uso típico:
//      const engine = new ImmersiveAudioEngine({ order: 1 });
//      await engine.attach(audioElement);          // crea contexto + grafo
//      engine.setRotationFromQuaternion(pose.orientation);   // WebXR
//      engine.setRotationFromMatrix4(camera.matrixWorld.elements); // escritorio
//      engine.setZoomByFactor(1.4);
//      engine.setVolume(0.8);
//
//  Fuentes espaciales dinámicas (objetos 3D / anclas AR):
//      engine.bindStemToObject('violin', violinObject3D);  // sigue su matrixWorld
//      engine.setStemPosition(0, 1.2, 0, -2);              // posición mundo fija
//      engine.update();                                    // 1×/frame en el render loop
//
//  Dependencias globales (cargadas por <script> en el navegador):
//      sht      — spherical-harmonic-transform
//      numeric  — numericjs
// ============================================================================

import { HOASTRotator }     from './HOASTRotator.js';
import { HOASTBinDecoder }  from './HOASTBinDecoder.js';
import { HOASTloader }      from './HOASTloader.js';
import { MatrixMultiplier } from './MatrixMultiplier.js';
import { OmnitoneFOADecoder } from './OmnitoneFOADecoder.js';
import { zoomMtx, zoomFactorToIndex } from './zoom-matrix.js';
import { threeMatrix4ToAmbiR3, quaternionToMatrix4, mat3MulVec3 } from './ambisonicAxes.js';

// ── Reordenado de canales del decodificador Opus ────────────────────────────
// Chromium (y por tanto el navegador de la Quest) reordena el Opus multicanal a
// ORDEN VORBIS cuando la pista tiene entre 3 y 8 canales, aunque se haya
// encodeado con mapping_family 255 (canales discretos, sin layout). ffmpeg NO lo
// hace: por eso el fichero se ve perfecto en local y sale barajado en el
// navegador. Fuera de 3..8 no hay tabla y el orden es el de codificación — que es
// justo por qué el spike de 10 canales (4 FOA + 6 stems) funcionó y nadie lo vio.
//
// srcToOut[s] = salida del ChannelSplitter donde aparece el canal FUENTE s.
// La fila de 7 está verificada de forma empírica con chtest/ (un tono por canal)
// en el navegador de la Quest; las demás son la tabla kOpusVorbisChannelMap de
// Chromium. Verifica cualquier otra con channel-test.html antes de fiarte.
const VORBIS_SRC_TO_OUT = {
  3: [0, 2, 1],
  4: [0, 1, 2, 3],                    // identidad
  5: [0, 2, 1, 3, 4],
  6: [0, 2, 1, 4, 5, 3],
  7: [0, 2, 1, 5, 6, 4, 3],           // ✔ medida en Quest
  8: [0, 2, 1, 6, 7, 4, 5, 3],
};

export class ImmersiveAudioEngine {

  /**
   * @param {object}  [opts]
   * @param {number}  [opts.order=1]        Orden Ambisonics (1 = FOA).
   * @param {number}  [opts.sampleRate=48000]
   * @param {AudioContext} [opts.audioContext]  Reutiliza un contexto existente.
   * @param {string}  [opts.renderer='omnitone']  Decodificador binaural:
   *        'omnitone' → HRTF real (delante/detrás/elevación). Recomendado.
   *        'hoast'    → cardioides (horizontal, sin HRTF). Fallback.
   * @param {string|null}  [opts.irUrl=null]    Solo modo 'hoast': URL de IRs.
   * @param {Array<{azimuthDeg:number, elevationDeg?:number, name?:string}>} [opts.stems=[]]
   *        Stems por músico que llegan en los canales 4..(4+N-1) del mismo
   *        stream multicanal (un Opus, una línea de tiempo → sync a muestra).
   *        Cada uno se espacializa con un PannerNode HRTF en su azimut y sube
   *        al mirarlo + hacer zoom (spotlight). Sin stems → comportamiento
   *        idéntico al de 4 canales FOA de siempre.
   */
  constructor({ order = 1, sampleRate = 48000, audioContext = null,
                renderer = 'omnitone', irUrl = null, stems = [], channelMap = 'auto' } = {}) {
    this.channelMap = channelMap;   // 'auto' | 'identity' | array srcToOut explícito
    this._chMap = null;             // resuelto en attach(), cuando se sabe el total
    this.order = order;
    this.sampleRate = sampleRate;
    this.irUrl = irUrl;
    this.renderer = renderer;

    this.ctx = audioContext;
    this.ownsContext = !audioContext;

    this.source = null;
    this.rotator = null;       // modo 'hoast'
    this.multiplier = null;    // modo 'hoast' (zoom)
    this.decoder = null;       // HOASTBinDecoder ('hoast') u OmnitoneFOADecoder
    this.gain = null;
    this.analyser = null;

    this._mediaEl = null;
    this._zoomIndex = -1;
    this._lastVolume = 1;
    this._attached = false;
    this._outDelaySec = 0;     // retardo de salida A/V (compensa audio adelantado)
    this._viewR3 = null;       // rotación de cabeza (3x3 ambisónico) para DoA

    // ── Stems / fuentes espaciales (spotlight posicional) ────────────────────
    // Hay DOS geometrías, y confundirlas rompe el spotlight:
    //
    //   · No anclada (360). Colocada por azimut/elevación sobre una esfera
    //     SOLIDARIA A LA CABEZA, igual que la malla del vídeo 360, que el player
    //     recentra en la cabeza cada frame. La dirección cabeza→fuente es su
    //     `dir` tal cual, y su posición mundo se recalcula al moverse la cabeza.
    //     Restarle la posición de la cabeza sería un error: en el Quest (marco
    //     local-floor, cabeza a ~1.6 m) mandaría las fuentes bajo el suelo.
    //
    //   · Anclada (AR). Vive en coordenadas de sala, fijada con setStemPosition()
    //     o vinculada a un Object3D con bindStemToObject(). Ahí sí: la dirección
    //     y la distancia se miden restando la posición de la cabeza, que es lo
    //     que permite acercarse andando a un músico.
    const D2R = Math.PI / 180;
    this._stems = (stems || []).map((s, i) => ({
      az:   (s.azimuthDeg   || 0) * D2R,
      el:   (s.elevationDeg || 0) * D2R,
      name: s.name || ('stem' + i),
      gain: null, panner: null, dir: null,
      pos: null,          // posición mundo [x,y,z] (anclada) o derivada de dir
      anchored: false,    // true → coordenadas de sala; false → esfera en la cabeza
      object3d: null,     // fuente vinculada (lee su matrixWorld) o null
    }));
    this._stemRadius  = 1;            // radio de la colocación estática por az/el
    this._listenerPos = [0, 0, 0];    // posición de cabeza en marco mundo (AR)
    this._chSplitter = null;
    this._stemBus    = null;
    this._lookForward = [0, 0, -1];   // frente de cabeza en marco mundo
    this._zoomFactor  = 1;
    // Parámetros del spotlight (ajustables con setSpotlightParams).
    this._restGain  = 0;     // nivel de stem en reposo (0 = solo aparece en zoom)
    this._maxBoost  = 1.5;   // ganancia extra al mirar de lleno con zoom máximo
    this._focusExp  = 4;     // cuán cerrado es el cono de "mirar a" (mayor = más estrecho)
    this._zoomMin   = 1;     // factor de zoom a partir del cual empieza el spotlight
    this._zoomMax   = 2.5;   // factor de zoom que da el boost completo
    this._bedDuck   = 0;     // cuánto se agacha el bed al enfocar (0 = nada, 1 = a cero)
    this._bedGain   = null;  // GainNode del bed (creado en attach)
    // Atenuación por distancia de cada fuente (ajustable con setSourceParams).
    // Manda en AR, donde uno se acerca andando; en el 360 las fuentes están
    // siempre a _stemRadius de la cabeza y la curva es irrelevante.
    this._distanceModel = 'inverse';
    this._refDistance   = 1;
    this._rolloffFactor = 1;
    this._maxDistance   = 10000;
    this._posSmoothSec  = 0.05;  // rampa al recolocar por red (0 = salto seco)
  }

  // ── Ciclo de vida ────────────────────────────────────────────────────────

  /**
   * Conecta un <audio>/<video> y construye el grafo completo.
   * @param {HTMLMediaElement} mediaElement
   * @returns {Promise<void>}
   */
  async attach(mediaElement) {
    if (this._attached) throw new Error('ImmersiveAudioEngine: ya está adjunto');

    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ sampleRate: this.sampleRate });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this._mediaEl = mediaElement;
    this.source = this.ctx.createMediaElementSource(mediaElement);

    this.gain = this.ctx.createGain();
    this.gain.gain.value = this._lastVolume;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 64;

    // Con stems, el stream trae 4 (FOA) + N canales. Separamos los 4 primeros
    // para el decoder FOA y dejamos los canales 4..N para las cadenas de stem.
    // Sin stems, el source va directo al decoder (comportamiento de siempre).
    let foaInput = this.source;
    this._chMap = this._resolveChannelMap(4 + this._stems.length);
    if (this._stems.length) {
      const total = 4 + this._stems.length;
      this._chSplitter = this.ctx.createChannelSplitter(total);
      this.source.connect(this._chSplitter);
      const foaMerger = this.ctx.createChannelMerger(4);
      // El canal FOA i del fichero puede salir por otra salida del splitter.
      for (let i = 0; i < 4; i++) this._chSplitter.connect(foaMerger, this._out(i), i);
      foaInput = foaMerger;
    }

    // Renderer 'omnitone' por defecto; si la librería no está, cae a 'hoast'.
    let mode = this.renderer;
    if (mode === 'omnitone' && typeof Omnitone === 'undefined') {
      console.warn('[engine] Omnitone no disponible → fallback a cardioides (hoast)');
      mode = 'hoast';
    }
    this._activeRenderer = mode;

    // Ganancia propia del bed (los 4 canales FOA), antes del maestro. Permite
    // AGACHARLO al enfocar a un músico: el bed lleva la mezcla completa del
    // concierto, con los músicos dentro, así que sin esto el spotlight solo
    // puede sumar el stem encima de su propia copia — suena más fuerte, no más
    // solo, y el total se acerca al recorte. Con el duck, acercarse a alguien
    // aparta el fondo. Ver _updateSpotlight().
    this._bedGain = this.ctx.createGain();
    this._bedGain.gain.value = 1;
    this._bedGain.connect(this.gain);

    if (mode === 'omnitone') {
      // FOA → OmnitoneFOADecoder (binaural HRTF + rotación) → bedGain → gain
      this.decoder = new OmnitoneFOADecoder(this.ctx);
      await this.decoder.initialize();
      foaInput.connect(this.decoder.input);
      this.decoder.output.connect(this._bedGain);
    } else {
      // FOA → rotator → multiplier(zoom) → HOASTBinDecoder → bedGain → gain
      this.rotator    = new HOASTRotator(this.ctx, this.order);
      this.multiplier = new MatrixMultiplier(this.ctx, this.order);
      this.decoder    = new HOASTBinDecoder(this.ctx, this.order);
      foaInput.connect(this.rotator.in);
      this.rotator.out.connect(this.multiplier.in);
      this.multiplier.out.connect(this.decoder.in);
      this.decoder.out.connect(this._bedGain);
      if (this.irUrl) this.loadIRs(this.irUrl);
    }

    // Cadenas de stem: canal 4+i → gain → PannerNode(HRTF) → bus → gain maestro.
    if (this._stems.length) this._buildStems();

    // Reaplica una alineación fijada antes de attach (si la hubo).
    if (this._alignment) this.setAlignment(this._alignment);

    // DelayNode de salida: compensa el desfase A/V residual cuando el audio va
    // ADELANTADO respecto al vídeo (típico si el stitching del 360 retrasa el
    // vídeo y el adelay de captura se quedó corto). Solo puede RETRASAR audio.
    this._outDelay = this.ctx.createDelay(2.0);            // hasta 2 s
    this._outDelay.delayTime.value = this._outDelaySec;
    this.gain.connect(this._outDelay);
    this._outDelay.connect(this.ctx.destination);
    this.gain.connect(this.analyser);   // análisis PRE-delay (no llega a destino)

    this._setupDoA();   // estimador de dirección de llegada (tap del source)

    this._attached = true;
  }

  // Tap al SOURCE (campo en marco del micro) → 4 analizadores de dominio
  // temporal. La rotación de cabeza y la alineación se aplican luego en JS
  // (getDominantDirection), así funciona igual con cualquier renderer.
  // Salida del ChannelSplitter que lleva el canal `src` del fichero.
  _out(src) { return this._chMap ? this._chMap[src] : src; }

  /**
   * Resuelve srcToOut para un total de canales dado. 'auto' aplica la tabla
   * Vorbis en 3..8 (lo que hace Chromium) e identidad fuera de ese rango.
   */
  _resolveChannelMap(total) {
    if (Array.isArray(this.channelMap)) return this.channelMap;
    const identity = Array.from({ length: total }, (_, i) => i);
    if (this.channelMap === 'identity') return identity;
    const map = VORBIS_SRC_TO_OUT[total];
    if (!map) return identity;
    console.info(`[engine] ${total} canales → remapeo Vorbis del decodificador: [${map}]`);
    return map;
  }

  _setupDoA() {
    // El splitter debe tener TODOS los canales: creado con 4 sobre una pista de
    // 7, Web Audio descarta los sobrantes ANTES de partir, y los 4 primeros ya
    // vienen permutados (con 7 canales, la salida 3 trae un stem, no la X).
    const total = 4 + this._stems.length;
    const splitter = this.ctx.createChannelSplitter(total);
    this.source.connect(splitter);
    const analysers = [], bufs = [];
    for (let i = 0; i < 4; i++) {
      const a = this.ctx.createAnalyser();
      a.fftSize = 2048;
      splitter.connect(a, this._out(i));
      analysers.push(a);
      bufs.push(new Float32Array(a.fftSize));
    }
    this._doa = { splitter, analysers, bufs };
  }

  /**
   * Carga las respuestas al impulso binaurales y las inyecta en el decoder.
   * (En el código original esto nunca se invocaba correctamente.)
   * @param {string} url  URL base, p.ej. './hoast360/irs.ogg'
   */
  loadIRs(url) {
    const loader = new HOASTloader(this.ctx, this.order, url, (foaBuffer, hoaBuffer) => {
      this.decoder.updateFilters(foaBuffer, hoaBuffer);
    });
    loader.load();   // ← la llamada que faltaba en el original
    this._irLoader = loader;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  }

  async dispose() {
    try { this.source && this.source.disconnect(); } catch (_) {}
    try { this._bedGain && this._bedGain.disconnect(); } catch (_) {}
    try { this.gain && this.gain.disconnect(); } catch (_) {}
    if (this.ownsContext && this.ctx) {
      try { await this.ctx.close(); } catch (_) {}
    }
    this._attached = false;
  }

  // ── Rotación del campo sonoro ────────────────────────────────────────────

  /** Orientación de cabeza desde una pose WebXR o THREE.Quaternion {x,y,z,w}. */
  setRotationFromQuaternion(q) {
    this._viewR3 = threeMatrix4ToAmbiR3(quaternionToMatrix4(q));   // para DoA
    if (this.decoder && this._activeRenderer === 'omnitone') {
      this.decoder.setRotationFromQuaternion(q);
    } else if (this.rotator) {
      this.rotator.setRotationFromQuaternion(q);
    }
    this._applyHeadOrientation(quaternionToMatrix4(q));            // stems
  }

  /** Orientación desde THREE.Matrix4.elements (column-major). */
  setRotationFromMatrix4(elements) {
    this._viewR3 = threeMatrix4ToAmbiR3(elements);                 // para DoA
    if (this.decoder && this._activeRenderer === 'omnitone') {
      this.decoder.setRotationFromMatrix4(elements);
    } else if (this.rotator) {
      this.rotator.setRotationFromThreeMatrix4(elements);
    }
    this._applyHeadOrientation(elements);                          // stems
  }

  // Stems: el AudioListener (PannerNode HRTF) sigue la misma cabeza que Omnitone,
  // y el frente de cabeza alimenta el cálculo del spotlight. Three.js, WebXR y
  // Web Audio comparten convención (frente = −Z, arriba = +Y), así que las
  // columnas de la matriz mundo se usan tal cual.
  _applyHeadOrientation(e) {
    if (!this._stems.length) return;
    const fwd = [-e[8], -e[9], -e[10]];   // −Z mundo = hacia donde miras
    const up  = [ e[4],  e[5],  e[6]];    // +Y mundo
    this._lookForward = fwd;
    const L = this.ctx.listener;
    if (L.forwardX) {
      L.forwardX.value = fwd[0]; L.forwardY.value = fwd[1]; L.forwardZ.value = fwd[2];
      L.upX.value = up[0]; L.upY.value = up[1]; L.upZ.value = up[2];
    } else if (L.setOrientation) {
      L.setOrientation(fwd[0], fwd[1], fwd[2], up[0], up[1], up[2]);
    }
    // Posición de la cabeza (traslación de la matriz mundo). En 360 puro es el
    // origen; en AR la cabeza se mueve por la sala y las fuentes ancladas deben
    // espacializarse relativas a ella.
    const px = e[12] || 0, py = e[13] || 0, pz = e[14] || 0;
    this._listenerPos = [px, py, pz];
    if (L.positionX) {
      L.positionX.value = px; L.positionY.value = py; L.positionZ.value = pz;
    } else if (L.setPosition) {
      L.setPosition(px, py, pz);
    }
    this._reseatStaticStems();   // la esfera del 360 viaja con la cabeza
    this._updateSpotlight();
  }

  /**
   * Alineación fija audio↔vídeo (independiente del giro de cabeza).
   *
   * Gira SOLO el campo sonoro ambisónico (el bed), no los stems: corrige que el
   * micro no apuntase al mismo sitio que la cámara al grabar. Con la esfera ya
   * alineada (el centro de la imagen cae en -Z), si micro y cámara miraban al
   * frente lo correcto es 0; los múltiplos de 90 que antes hacían falta
   * compensaban el desfase del mapeo UV, no el micro.
   *
   * @param {object}  [opts]
   * @param {number}  [opts.yawOffsetDeg=0]  Giro del campo sonoro, en grados.
   * @param {boolean} [opts.mirror=false]    Espejo izquierda/derecha.
   */
  setAlignment({ yawOffsetDeg = 0, mirror = false } = {}) {
    this._alignment = { yawOffsetDeg, mirror };
    const rad = yawOffsetDeg * Math.PI / 180;
    if (this.rotator) {                       // modo 'hoast'
      this.rotator.yawOffset = rad;
      this.rotator.mirrorY = !!mirror;
    }
    if (this.decoder && this._activeRenderer === 'omnitone') {
      this.decoder.yawOffset = rad;
      this.decoder.mirror = !!mirror;
    }
  }

  // ── Zoom acústico ────────────────────────────────────────────────────────

  /** @param {number} factor  Factor de zoom (1 = sin zoom … 2.5 = máximo). */
  setZoomByFactor(factor) {
    this._zoomFactor = factor;
    if (this.multiplier) {                     // zoom acústico ambisónico (hoast)
      const idx = zoomFactorToIndex(factor);
      if (idx !== this._zoomIndex) {
        this.multiplier.updateMtx(zoomMtx[idx]);
        this._zoomIndex = idx;
      }
    }
    this._updateSpotlight();                   // spotlight de stems (cualquier modo)
  }

  /**
   * Zoom normalizado 0..1 para el spotlight, cuando el zoom NO viene del FOV de
   * la cámara (p.ej. en WebXR, donde se controla con el joystick). 0 = sin
   * boost, 1 = boost completo. Se mapea al rango [zoomMin, zoomMax] interno.
   */
  setZoomNormalized(t) {
    t = Math.min(1, Math.max(0, Number(t) || 0));
    this._zoomFactor = this._zoomMin + t * (this._zoomMax - this._zoomMin);
    this._updateSpotlight();
  }

  // ── Stems por músico (spotlight posicional) ───────────────────────────────

  /**
   * Construye una cadena por stem: canal (4+i) del splitter → gain → PannerNode
   * HRTF en el azimut/elevación del músico → bus de stems → gain maestro.
   * Radio 1 (sin atenuación por distancia): el nivel lo controla el spotlight.
   */
  _buildStems() {
    this._stemBus = this.ctx.createGain();
    this._stemBus.connect(this.gain);
    this._stems.forEach((s, i) => {
      const ch = 4 + i;
      // Dirección mundo del músico (frente = −Z, izquierda = −X, arriba = +Y).
      const ce = Math.cos(s.el), se = Math.sin(s.el);
      const dir = [-ce * Math.sin(s.az), se, -ce * Math.cos(s.az)];
      s.dir = dir;
      // Posición inicial: la fijada de antemano (setStemPosition/bind antes de
      // attach) si está anclada; si no, sobre la esfera centrada en la cabeza.
      if (!s.anchored) s.pos = this._staticPos(s);

      const g = this.ctx.createGain();
      g.gain.value = this._restGain;

      const p = this.ctx.createPanner();
      p.panningModel  = 'HRTF';
      p.distanceModel = this._distanceModel;   // atenuación por distancia (manda en AR)
      p.refDistance   = this._refDistance;
      p.rolloffFactor = this._rolloffFactor;
      p.maxDistance   = this._maxDistance;

      this._chSplitter.connect(g, this._out(ch), 0);   // canal 4+i (mono) → gain
      g.connect(p);
      p.connect(this._stemBus);
      s.gain = g; s.panner = p;
      this._setPannerPos(s, s.pos);          // coloca el panner en su posición
    });
  }

  // Posición mundo de una fuente NO anclada: su dirección az/el, a _stemRadius,
  // desde donde esté la cabeza. Así el PannerNode la sitúa siempre a la misma
  // distancia y en el mismo rumbo relativo, como la esfera del 360.
  _staticPos(s) {
    const lp = this._listenerPos, R = this._stemRadius;
    return [lp[0] + s.dir[0] * R, lp[1] + s.dir[1] * R, lp[2] + s.dir[2] * R];
  }

  // Recoloca las no ancladas tras mover la cabeza (las ancladas no se tocan).
  _reseatStaticStems() {
    for (const s of this._stems) {
      if (s.anchored || !s.panner || !s.dir) continue;
      s.pos = this._staticPos(s);
      this._setPannerPos(s, s.pos);
    }
  }

  // ── Fuentes espaciales dinámicas (posición fija o ancla AR) ────────────────

  // Resuelve el índice de stem a partir de un índice numérico o de su nombre.
  _stemIndex(ref) {
    if (typeof ref === 'number') return ref;
    return this._stems.findIndex(s => s.name === ref);
  }

  // Extrae una posición mundo [x,y,z] de: un Object3D (matrixWorld de Three.js),
  // un array [x,y,z], un {x,y,z} o un {position:{x,y,z}}. null si no puede.
  _extractPos(src) {
    if (!src) return null;
    if (Array.isArray(src)) return [src[0], src[1], src[2]];
    if (src.matrixWorld && src.matrixWorld.elements) {
      const e = src.matrixWorld.elements;
      return [e[12], e[13], e[14]];
    }
    if (typeof src.x === 'number') return [src.x, src.y, src.z];
    if (src.position && typeof src.position.x === 'number')
      return [src.position.x, src.position.y, src.position.z];
    return null;
  }

  // Coloca el PannerNode de un stem en una posición mundo.
  /**
   * Coloca el panner. `smoothSec > 0` interpola en vez de saltar.
   *
   * El salto instantáneo vale para lo que se recalcula cada frame (la esfera
   * solidaria a la cabeza, un Object3D vinculado): ahí ya hay continuidad. Pero
   * una posición que llega por red a 10–20 Hz sí salta, y un PannerNode movido a
   * saltos produce zipper noise. Con `setTargetAtTime` la posición persigue el
   * objetivo con una constante de tiempo del orden del intervalo de llegada.
   */
  _setPannerPos(s, pos, smoothSec = 0) {
    if (!s || !s.panner || !pos) return;
    const p = s.panner;
    if (p.positionX) {
      if (smoothSec > 0 && this.ctx && p.positionX.setTargetAtTime) {
        const now = this.ctx.currentTime;
        p.positionX.setTargetAtTime(pos[0], now, smoothSec);
        p.positionY.setTargetAtTime(pos[1], now, smoothSec);
        p.positionZ.setTargetAtTime(pos[2], now, smoothSec);
      } else {
        p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2];
      }
    } else if (p.setPosition) {
      p.setPosition(pos[0], pos[1], pos[2]);   // API heredada: sin rampa posible
    }
  }

  /**
   * Curva de atenuación por distancia de las fuentes y suavizado de sus saltos
   * de posición. Relevante sobre todo en AR, donde el volumen de cada músico lo
   * decide el acercarse andando y no el zoom.
   *
   * @param {object}  [o]
   * @param {string}  [o.distanceModel]  'inverse' | 'linear' | 'exponential'
   * @param {number}  [o.refDistance]    distancia a la que la fuente suena a 1
   * @param {number}  [o.rolloffFactor]  cuán rápido cae al alejarse (1 = natural)
   * @param {number}  [o.maxDistance]    distancia a partir de la cual no cae más
   * @param {number}  [o.smoothSec]      constante de tiempo al recolocar (0 = salto)
   */
  setSourceParams({ distanceModel, refDistance, rolloffFactor, maxDistance, smoothSec } = {}) {
    if (distanceModel  != null) this._distanceModel = distanceModel;
    if (refDistance    != null) this._refDistance   = refDistance;
    if (rolloffFactor  != null) this._rolloffFactor = rolloffFactor;
    if (maxDistance    != null) this._maxDistance   = maxDistance;
    if (smoothSec      != null) this._posSmoothSec  = Math.max(0, smoothSec);
    this._applySourceParams();
  }

  getSourceParams() {
    return { distanceModel: this._distanceModel, refDistance: this._refDistance,
             rolloffFactor: this._rolloffFactor, maxDistance: this._maxDistance,
             smoothSec: this._posSmoothSec };
  }

  // Vuelca la curva de atenuación sobre los panners ya creados.
  _applySourceParams() {
    for (const s of this._stems) {
      if (!s.panner) continue;
      s.panner.distanceModel  = this._distanceModel;
      s.panner.refDistance    = this._refDistance;
      s.panner.rolloffFactor  = this._rolloffFactor;
      s.panner.maxDistance    = this._maxDistance;
    }
  }

  /**
   * Fija la posición mundo de una fuente (stem). La fuente deja de seguir
   * cualquier Object3D vinculado previamente.
   * @param {number|string} ref  Índice (0..N-1) o nombre del stem.
   * @param {number|number[]|{x,y,z}} x  X, o un [x,y,z] / {x,y,z}.
   * @param {number} [y]
   * @param {number} [z]
   */
  setStemPosition(ref, x, y, z) {
    const s = this._stems[this._stemIndex(ref)];
    if (!s) return;
    const pos = (typeof x === 'number') ? [x, y, z] : this._extractPos(x);
    if (!pos) return;
    s.object3d = null;        // posición explícita → desvincula del Object3D
    s.anchored = true;        // coordenadas de sala: distancia y rumbo vs. cabeza
    s.pos = pos;
    // Punto de entrada de las posiciones externas (tracking por cámaras, etc.):
    // llegan a decenas de Hz como mucho, así que se interpolan.
    this._setPannerPos(s, pos, this._posSmoothSec);
    this._updateSpotlight();
  }

  /**
   * Vincula una fuente (stem) a un Object3D (p.ej. un ancla AR de Three.js). A
   * partir de update() la posición del panner sigue su matrixWorld cada frame.
   * @param {number|string} ref  Índice o nombre del stem.
   * @param {object} object3d    Object3D con matrixWorld (o array/{x,y,z}).
   */
  bindStemToObject(ref, object3d) {
    const s = this._stems[this._stemIndex(ref)];
    if (!s) return;
    s.object3d = object3d || null;
    s.anchored = !!s.object3d;
    if (s.object3d) {
      const pos = this._extractPos(s.object3d);
      if (pos) { s.pos = pos; this._setPannerPos(s, pos); }
    }
  }

  /** Desvincula la fuente de su Object3D (conserva la última posición conocida). */
  // Suelta el ancla: la fuente vuelve a la esfera solidaria a la cabeza (az/el),
  // que es lo que procede al salir de AR y recuperar el 360.
  unbindStem(ref) {
    const s = this._stems[this._stemIndex(ref)];
    if (!s) return;
    s.object3d = null;
    s.anchored = false;
    // Suavizado: el salto de la sala a la esfera de la cabeza puede sonar a clic.
    if (s.dir && s.panner) { s.pos = this._staticPos(s); this._setPannerPos(s, s.pos, this._posSmoothSec); }
    this._updateSpotlight();
  }

  /** Radio de la colocación estática por azimut/elevación (por defecto 1). */
  setStemRadius(r) { this._stemRadius = Number(r) || 1; }

  /** Nº de fuentes/stems espaciales activas. */
  get stemCount() { return this._stems.length; }

  /**
   * Refresca las posiciones de las fuentes vinculadas a un Object3D y recalcula
   * el spotlight. Llamar una vez por frame desde el bucle de render cuando se
   * usan fuentes ancladas (AR). Sin fuentes vinculadas no hace trabajo extra.
   */
  update() {
    if (!this._stems.length) return;
    let moved = false;
    for (const s of this._stems) {
      if (!s.object3d) continue;
      const pos = this._extractPos(s.object3d);
      if (!pos) continue;
      s.pos = pos;
      this._setPannerPos(s, pos);
      moved = true;
    }
    if (moved) this._updateSpotlight();
  }

  // Reparte ganancia a cada stem según mirada (alineación con su dirección) y
  // zoom. En reposo (sin zoom) → _restGain; mirando de lleno con zoom máximo →
  // _restGain + _maxBoost. Suavizado para no chasquear.
  _updateSpotlight() {
    if (!this._stems.length || !this.ctx) return;
    const f = this._lookForward, lp = this._listenerPos;
    const lo = this._zoomMin, hi = this._zoomMax;
    const zN = Math.min(1, Math.max(0, (this._zoomFactor - lo) / (hi - lo)));
    const now = this.ctx.currentTime;
    let maxW = 0;                       // peso del stem más enfocado → duck del bed
    for (const s of this._stems) {
      if (!s.gain) continue;
      // Dirección actual cabeza→fuente (normalizada). En las NO ancladas es su
      // `dir`: la esfera va con la cabeza, así que restarle _listenerPos metería
      // el error de la altura de ojos (en VR, ~1.6 m ⇒ el frente cae 58° bajo el
      // horizonte y nada llega nunca al umbral de foco). Las ancladas sí se
      // miden contra la cabeza, que es lo que da acercarse andando en AR.
      let dx, dy, dz;
      if (s.anchored) {
        if (!s.pos) continue;
        dx = s.pos[0] - lp[0]; dy = s.pos[1] - lp[1]; dz = s.pos[2] - lp[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len; dy /= len; dz /= len;
      } else {
        if (!s.dir) continue;
        [dx, dy, dz] = s.dir;                         // ya unitario
      }
      const dot = dx * f[0] + dy * f[1] + dz * f[2];
      const aim = Math.max(0, dot);                  // 1 = mirándola de frente
      const focus = Math.pow(aim, this._focusExp);
      s._weight = focus * zN;                         // 0..1: cuán "enfocada" está
      if (s._weight > maxW) maxW = s._weight;
      const target = this._restGain + s._weight * this._maxBoost;
      s.gain.gain.setTargetAtTime(target, now, 0.08);
    }

    // Duck del bed, gobernado por el peso del stem MÁS enfocado, no por el zoom
    // a secas: acercarse sin mirar a nadie no debe apartar el fondo. Misma rampa
    // que los stems, así que fondo y solista se cruzan sin escalones. Se escribe
    // siempre (con bedDuck=0 el objetivo es 1), o al desactivar el duck en
    // caliente el bed se quedaría agachado para siempre.
    if (this._bedGain)
      this._bedGain.gain.setTargetAtTime(1 - this._bedDuck * maxW, now, 0.08);
  }

  /**
   * Índice del stem actualmente más enfocado (mirada × zoom), o -1 si ninguno
   * supera el umbral. Reutiliza el peso del spotlight, así que sirve para
   * disparar el close-up del músico al que miras (Caso B) con el mismo criterio
   * que el realce de audio.
   * @param {number} [minWeight=0.2]
   * @returns {number}
   */
  getFocusedStem(minWeight = 0.2) {
    let bi = -1, bw = minWeight;
    for (let i = 0; i < this._stems.length; i++) {
      const w = this._stems[i]._weight || 0;
      if (w > bw) { bw = w; bi = i; }
    }
    return bi;
  }

  /**
   * Ajusta el comportamiento del spotlight.
   * @param {object} [o]
   * @param {number} [o.restGain]  Nivel de stem en reposo (0 = solo en zoom).
   * @param {number} [o.maxBoost]  Ganancia extra al mirar de lleno con zoom máx.
   * @param {number} [o.focusExp]  Cierre del cono de enfoque (mayor = más estrecho).
   * @param {number} [o.zoomMin]   Factor de zoom a partir del cual empieza el boost.
   * @param {number} [o.zoomMax]   Factor de zoom que da el boost completo.
   */
  setSpotlightParams({ restGain, maxBoost, focusExp, zoomMin, zoomMax, bedDuck } = {}) {
    if (restGain != null) this._restGain = restGain;
    if (maxBoost != null) this._maxBoost = maxBoost;
    if (focusExp != null) this._focusExp = focusExp;
    if (zoomMin  != null) this._zoomMin  = zoomMin;
    if (zoomMax  != null) this._zoomMax  = zoomMax;
    if (bedDuck  != null) this._bedDuck  = Math.min(1, Math.max(0, bedDuck));
    this._updateSpotlight();
  }

  /** Parámetros actuales del spotlight (para guardar/restaurar, p.ej. al entrar/salir de AR). */
  getSpotlightParams() {
    return { restGain: this._restGain, maxBoost: this._maxBoost,
             focusExp: this._focusExp, zoomMin: this._zoomMin, zoomMax: this._zoomMax,
             bedDuck: this._bedDuck };
  }

  // ── Volumen ──────────────────────────────────────────────────────────────

  setVolume(v) {
    v = Number(v);
    if (this.gain) this.gain.gain.value = v;
    if (v > 0) this._lastVolume = v;
  }

  /** @returns {boolean} nuevo estado de mute */
  toggleMute() {
    if (!this.gain) return false;
    const muted = this.gain.gain.value === 0;
    this.gain.gain.value = muted ? this._lastVolume : 0;
    return !muted;
  }

  // Retardo de salida en ms (compensación A/V). Solo retrasa audio; 0..2000.
  //   window.engine.setOutputDelay(900)   // ajústalo en vivo desde consola
  setOutputDelay(ms) {
    this._outDelaySec = Math.max(0, Math.min(2, (+ms || 0) / 1000));
    if (this._outDelay) this._outDelay.delayTime.value = this._outDelaySec;
    return this._outDelaySec * 1000;
  }
  get outputDelayMs() { return (this._outDelaySec || 0) * 1000; }

  // ── Acceso para visualización ────────────────────────────────────────────

  get audioContext() { return this.ctx; }
  get gainNode()     { return this.gain; }

  /** Rellena `array` (Uint8Array) con los datos de frecuencia del analizador. */
  getFrequencyData(array) {
    if (this.analyser) this.analyser.getByteFrequencyData(array);
  }

  /**
   * Dirección de llegada del sonido dominante, en el marco de cabeza (tras la
   * rotación y la alineación). Vector intensidad acústica FOA: I = W·[X,Y,Z].
   * @returns {{az:number, el:number, conf:number}|null}
   *   az  azimut en rad (0 = al frente / donde miras, + = izquierda)
   *   el  elevación en rad (+ = arriba)
   *   conf 0..1 (cuán direccional es; ~1 onda plana, ~0 difuso/silencio)
   */
  getDominantDirection() {
    if (!this._doa) return null;
    const { analysers, bufs } = this._doa;
    for (let i = 0; i < 4; i++) analysers[i].getFloatTimeDomainData(bufs[i]);
    const W = bufs[0], Y = bufs[1], Z = bufs[2], X = bufs[3];  // ACN/SN3D (marco micro)
    let ix = 0, iy = 0, iz = 0, e = 0;
    const N = W.length;
    for (let n = 0; n < N; n++) {
      ix += W[n] * X[n];
      iy += W[n] * Y[n];
      iz += W[n] * Z[n];
      e  += W[n] * W[n] + X[n] * X[n] + Y[n] * Y[n] + Z[n] * Z[n];
    }
    const mag = Math.hypot(ix, iy, iz);
    const conf = Math.min(1, mag / (0.5 * e + 1e-9));

    // Llevar el vector del marco del micro al marco de cabeza:
    // alineación (espejo + offset azimut) y luego la rotación de cabeza.
    let v = [ix, iy, iz];
    const al = this._alignment;
    if (al) {
      if (al.mirror) v[1] = -v[1];
      if (al.yawOffsetDeg) {
        const p = al.yawOffsetDeg * Math.PI / 180, c = Math.cos(p), s = Math.sin(p);
        const nx = c * v[0] - s * v[1], ny = s * v[0] + c * v[1];
        v[0] = nx; v[1] = ny;
      }
    }
    if (this._viewR3) v = mat3MulVec3(this._viewR3, v);

    return {
      az: Math.atan2(v[1], v[0]),
      el: Math.atan2(v[2], Math.hypot(v[0], v[1])),
      conf,
    };
  }
}
