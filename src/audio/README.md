# Immersive Audio Core

Motor de audio inmersivo **Ambisonics** (FOA/HOA) en Web Audio, independiente de
framework. Rota el campo sonoro con la orientación de la cabeza y lo decodifica a
estéreo binaural. Pensado para reutilizarse en vanilla JS, WebXR, React, etc.

## Módulos

| Fichero | Responsabilidad |
|---|---|
| `ImmersiveAudioEngine.js` | **API pública.** Orquesta todo el grafo. |
| `HOASTRotator.js` | Rotación del soundfield (matriz SH por banda de orden). |
| `HOASTBinDecoder.js` | Decodificación binaural (convolvers + mid/side). |
| `MatrixMultiplier.js` | "Zoom acústico" (matriz NxN de ganancias). |
| `HOASTloader.js` | Carga/concatena las IR binaurales (HRIR). |
| `zoom-matrix.js` | Datos de las matrices de zoom + helpers. |

Grafo interno:

```
mediaElement → source → rotator → multiplier → decoder → gain ─┬─→ destination
                                                               └─→ analyser
```

## Dependencias globales

Cargadas por `<script>` (no son módulos ESM): `sht` (spherical-harmonic-transform)
y `numeric` (numericjs). En un bundler, expórtalos a `window` o adapta los imports.

## Uso (vanilla / WebXR)

```js
import { ImmersiveAudioEngine } from './src/audio/ImmersiveAudioEngine.js';

const engine = new ImmersiveAudioEngine({ order: 1, irUrl: null });
await engine.attach(audioElement);          // crea AudioContext + grafo

// Escritorio (Three.js):
engine.setRotationFromMatrix4(camera.matrixWorld.elements);

// WebXR (cada frame):
engine.setRotationFromQuaternion(pose.transform.orientation);

engine.setZoomByFactor(1.4);
engine.setVolume(0.8);
```

> `irUrl: null` usa un decodificador de **cardioides** (espacialización solo
> horizontal). Para HRTF real (front/back/elevación) pasa la URL base de las IR,
> p.ej. `irUrl: './hoast360/irs.ogg'`, y aporta los ficheros `_NN-MMch.<ext>`.

## Uso en React

El core no depende de React; envuélvelo en un hook:

```jsx
import { useEffect, useRef } from 'react';
import { ImmersiveAudioEngine } from '../audio/ImmersiveAudioEngine.js';

export function useImmersiveAudio(mediaRef) {
  const engineRef = useRef(null);

  useEffect(() => {
    if (!mediaRef.current) return;
    const engine = new ImmersiveAudioEngine({ order: 1 });
    engineRef.current = engine;
    engine.attach(mediaRef.current);
    return () => { engine.dispose(); engineRef.current = null; };
  }, [mediaRef]);

  return engineRef;   // engineRef.current.setRotationFromQuaternion(...) en el render loop
}
```

## API (`ImmersiveAudioEngine`)

- `new ImmersiveAudioEngine({ order?, sampleRate?, audioContext?, irUrl? })`
- `await attach(mediaElement)` — construye el grafo.
- `loadIRs(url)` — carga HRIR e inyecta filtros en el decoder.
- `setRotationFromQuaternion({x,y,z,w})` — orientación de cabeza (3DOF).
- `setRotationFromMatrix4(elements)` — desde `THREE.Matrix4.elements`.
- `setZoomByFactor(factor)` — zoom acústico (1 … 2.5).
- `setVolume(v)` / `toggleMute()`.
- `getFrequencyData(uint8Array)` — datos del analizador para visualización.
- `resume()` / `await dispose()`.
- getters: `audioContext`, `gainNode`.
