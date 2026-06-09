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
   */
  constructor({ order = 1, sampleRate = 48000, audioContext = null,
                renderer = 'omnitone', irUrl = null } = {}) {
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
    this._viewR3 = null;       // rotación de cabeza (3x3 ambisónico) para DoA
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

    // Renderer 'omnitone' por defecto; si la librería no está, cae a 'hoast'.
    let mode = this.renderer;
    if (mode === 'omnitone' && typeof Omnitone === 'undefined') {
      console.warn('[engine] Omnitone no disponible → fallback a cardioides (hoast)');
      mode = 'hoast';
    }
    this._activeRenderer = mode;

    if (mode === 'omnitone') {
      // source → OmnitoneFOADecoder (binaural HRTF + rotación) → gain
      this.decoder = new OmnitoneFOADecoder(this.ctx);
      await this.decoder.initialize();
      this.source.connect(this.decoder.input);
      this.decoder.output.connect(this.gain);
    } else {
      // source → rotator → multiplier(zoom) → HOASTBinDecoder → gain
      this.rotator    = new HOASTRotator(this.ctx, this.order);
      this.multiplier = new MatrixMultiplier(this.ctx, this.order);
      this.decoder    = new HOASTBinDecoder(this.ctx, this.order);
      this.source.connect(this.rotator.in);
      this.rotator.out.connect(this.multiplier.in);
      this.multiplier.out.connect(this.decoder.in);
      this.decoder.out.connect(this.gain);
      if (this.irUrl) this.loadIRs(this.irUrl);
    }

    // Reaplica una alineación fijada antes de attach (si la hubo).
    if (this._alignment) this.setAlignment(this._alignment);

    this.gain.connect(this.ctx.destination);
    this.gain.connect(this.analyser);   // rama de análisis (no llega a destino)

    this._setupDoA();   // estimador de dirección de llegada (tap del source)

    this._attached = true;
  }

  // Tap al SOURCE (campo en marco del micro) → 4 analizadores de dominio
  // temporal. La rotación de cabeza y la alineación se aplican luego en JS
  // (getDominantDirection), así funciona igual con cualquier renderer.
  _setupDoA() {
    const splitter = this.ctx.createChannelSplitter(4);
    this.source.connect(splitter);
    const analysers = [], bufs = [];
    for (let i = 0; i < 4; i++) {
      const a = this.ctx.createAnalyser();
      a.fftSize = 2048;
      splitter.connect(a, i);
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
  }

  /** Orientación desde THREE.Matrix4.elements (column-major). */
  setRotationFromMatrix4(elements) {
    this._viewR3 = threeMatrix4ToAmbiR3(elements);                 // para DoA
    if (this.decoder && this._activeRenderer === 'omnitone') {
      this.decoder.setRotationFromMatrix4(elements);
    } else if (this.rotator) {
      this.rotator.setRotationFromThreeMatrix4(elements);
    }
  }

  /**
   * Alineación fija audio↔vídeo (independiente del giro de cabeza).
   * @param {object}  [opts]
   * @param {number}  [opts.yawOffsetDeg=0]  Gira el campo sonoro p/ alinear el
   *        "frente" del micro con el centro de la imagen. Prueba 90 / 180 / -90.
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
    if (!this.multiplier) return;
    const idx = zoomFactorToIndex(factor);
    if (idx !== this._zoomIndex) {
      this.multiplier.updateMtx(zoomMtx[idx]);
      this._zoomIndex = idx;
    }
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
