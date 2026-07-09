// src/audio/opusChannelMap.js
//
// Reordenado de canales del decodificador Opus multicanal.
//
// Chromium (y por tanto el navegador de la Quest) remapea el Opus multicanal a
// ORDEN VORBIS cuando la pista tiene entre 3 y 8 canales, aunque se haya
// encodeado con mapping_family 255 — canales discretos, sin layout. ffmpeg NO lo
// hace: por eso el fichero se mide perfecto en local y llega barajado a Web
// Audio. Fuera de 3..8 no hay tabla y el orden es el de codificación, que es
// justo por qué el spike de 10 canales (4 FOA + 6 stems) funcionó y ocultó esto.
//
// Con 4 FOA + 3 stems el efecto era: la salida 3 del ChannelSplitter, que el
// motor tomaba por la X del ambisónico, llevaba el stem del saxo; el stem DR
// leía la guitarra; el stem SAX leía la batería.
//
// srcToOut[s] = salida del ChannelSplitter donde aparece el canal FUENTE s.
// La fila de 7 está VERIFICADA en la Quest con chtest/ (un tono por canal). Las
// demás son la tabla kOpusVorbisChannelMap de Chromium: compruébalas con
// channel-test.html antes de fiarte.
export const VORBIS_SRC_TO_OUT = {
  3: [0, 2, 1],
  4: [0, 1, 2, 3],                    // identidad
  5: [0, 2, 1, 3, 4],
  6: [0, 2, 1, 4, 5, 3],
  7: [0, 2, 1, 5, 6, 4, 3],           // ✔ medida en Quest
  8: [0, 2, 1, 6, 7, 4, 5, 3],
};

/** Identidad de `total` canales. */
export const identityMap = (total) => Array.from({ length: total }, (_, i) => i);

/**
 * srcToOut para un total de canales.
 * @param {number} total
 * @param {'auto'|'identity'|number[]} [mode='auto']  'auto' aplica la tabla en 3..8
 * @returns {number[]}
 */
export function resolveChannelMap(total, mode = 'auto') {
  if (Array.isArray(mode)) return mode;
  if (mode === 'identity') return identityMap(total);
  return VORBIS_SRC_TO_OUT[total] || identityMap(total);
}

/** Invierte srcToOut → outToSrc (qué canal fuente lleva cada salida). */
export function invertMap(srcToOut) {
  const out = [];
  srcToOut.forEach((o, src) => { out[o] = src; });
  return out;
}
