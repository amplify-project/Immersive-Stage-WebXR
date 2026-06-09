// ============================================================================
//  OmnitoneFOADecoder — Decodificador binaural FOA basado en Omnitone (Google).
//
//  Hace decodificación binaural con HRTF + rotación del campo sonoro de forma
//  correcta (delante/detrás/elevación), a diferencia del fallback de cardioides.
//  Espera audio Ambisonics ACN/SN3D (AmbiX) — el mismo que produce stream.sh
//  tras la conversión FuMa→AmbiX.
//
//  Requiere el global `Omnitone` (cargado por <script src=.../omnitone.min.js>).
//  Los HRIR vienen embebidos en Base64 en la propia librería → funciona offline.
//
//  Interfaz (compatible con el resto del engine):
//     .input / .output                  nodos de Web Audio
//     await initialize()
//     setRotationFromMatrix4(elements)   THREE.Matrix4.elements (cámara)
//     setRotationFromQuaternion(q)       WebXR pose / THREE.Quaternion
//     yawOffset (rad) / mirror (bool)    alineación fija audio↔vídeo
// ============================================================================

import { quaternionToMatrix4, rotationYMatrix4, mat4Mul } from './ambisonicAxes.js';

export class OmnitoneFOADecoder {

  constructor(audioCtx, { channelMap = [0, 1, 2, 3] } = {}) {
    this.ctx = audioCtx;
    // ACN/SN3D por defecto. createFOARenderer sin hrirPathList usa los HRIR
    // embebidos en Base64.
    this._renderer = Omnitone.createFOARenderer(audioCtx, { channelMap });
    this.yawOffset = 0;       // rad (offset de azimut fijo)
    this._mirror = false;
    this.input = null;
    this.output = null;
  }

  async initialize() {
    await this._renderer.initialize();

    // Nodo de espejo L/R (negar canal Y / ACN 1) intercalado antes de Omnitone.
    this._split = this.ctx.createChannelSplitter(4);
    this._merge = this.ctx.createChannelMerger(4);
    this._gains = [];
    for (let i = 0; i < 4; i++) {
      const g = this.ctx.createGain();
      g.gain.value = (i === 1 && this._mirror) ? -1 : 1;
      this._split.connect(g, i, 0);
      g.connect(this._merge, 0, i);
      this._gains.push(g);
    }
    this._merge.connect(this._renderer.input);

    this.input = this._split;
    this.output = this._renderer.output;
    this._renderer.setRenderingMode('ambisonic');
  }

  set mirror(v) {
    this._mirror = !!v;
    if (this._gains) this._gains[1].gain.value = this._mirror ? -1 : 1;
  }
  get mirror() { return this._mirror; }

  // Omnitone invierte internamente la matriz de cámara; le pasamos la matriz de
  // orientación de cabeza, opcionalmente pre-rotada por el offset de azimut.
  _passMatrix4(elements) {
    if (this.yawOffset) elements = mat4Mul(rotationYMatrix4(this.yawOffset), elements);
    this._renderer.setRotationMatrixFromCamera({ elements });
  }

  setRotationFromMatrix4(elements) { this._passMatrix4(elements); }
  setRotationFromQuaternion(q) { this._passMatrix4(quaternionToMatrix4(q)); }
}
