// ============================================================================
//  ambisonicAxes.js — Helpers de conversión de ejes/rotaciones compartidos por
//  el rotador HOAST, el decoder Omnitone y el estimador de dirección (DoA).
// ============================================================================

/**
 * THREE.Matrix4.elements (column-major) → matriz 3x3 en la convención de ejes
 * Ambisonics (ACN/SN3D). Es el mismo remap que usa el rotador HOAST: convierte
 * de ejes THREE (x dcha, y arriba, −z delante) a Ambisonics (x delante, y izq,
 * z arriba).
 */
export function threeMatrix4ToAmbiR3(e) {
  return [
    [e[10], e[8], e[9]],
    [e[2],  e[0], e[1]],
    [e[6],  e[4], e[5]],
  ];
}

/** Cuaternión {x,y,z,w} → matriz 4x4 column-major (estilo THREE.Matrix4). */
export function quaternionToMatrix4(q) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const e = new Array(16).fill(0);
  e[0] = 1 - (yy + zz); e[4] = xy - wz;       e[8]  = xz + wy;
  e[1] = xy + wz;       e[5] = 1 - (xx + zz); e[9]  = yz - wx;
  e[2] = xz - wy;       e[6] = yz + wx;       e[10] = 1 - (xx + yy);
  e[15] = 1;
  return e;
}

/** Producto matriz 3x3 · vector 3. */
export function mat3MulVec3(R, v) {
  return [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
  ];
}

/** Rotación Ry(φ) como matriz 4x4 column-major (estilo THREE.Matrix4). */
export function rotationYMatrix4(phi) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const e = new Array(16).fill(0);
  e[0] = c;  e[8]  = s;
  e[5] = 1;
  e[2] = -s; e[10] = c;
  e[15] = 1;
  return e;
}

/** Producto de dos matrices 4x4 column-major: devuelve a·b. */
export function mat4Mul(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
