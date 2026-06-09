// ============================================================================
//  HOASTRotator — Rotación del campo sonoro Ambisonics (ACN/SN3D).
//  Aplica una matriz de rotación de armónicos esféricos por banda de orden,
//  de forma que el soundfield gira con la cabeza del usuario.
//  Independiente de framework. Requiere los globals `sht`
//  (spherical-harmonic-transform) y `numeric` (numericjs).
//  Basado en el proyecto HOAST (hoast360).
//
//  API pública:
//    setRotationFromQuaternion({x,y,z,w})  ← WebXR pose / THREE.Quaternion
//    setRotationFromThreeMatrix4(elements) ← THREE.Matrix4.elements (col-major)
//    setRotationMatrix3(R3)                ← matriz 3x3 ya en convención Ambisonics
//    updateRotationFromCamera(elements)    ← alias de setRotationFromThreeMatrix4
// ============================================================================

export class HOASTRotator {

    constructor(audioCtx, order) {

        this.ctx = audioCtx;
        this.order = order;
        this.nCh = (order + 1) * (order + 1);
        // Alineación fija audio↔vídeo (se ajusta en runtime):
        this.yawOffset = 0;      // rad — gira el campo p/ alinear "frente" mic↔cámara
        this.mirrorY = false;    // espejo izquierda/derecha (negar canal Y)
        this.rotMtx = numeric.identity(this.nCh);
        this.rotMtxNodes = new Array(this.order);
        // Input and output nodes
        this.in = this.ctx.createChannelSplitter(this.nCh);
        this.out = this.ctx.createChannelMerger(this.nCh);

        // Initialize rotation gains to identity matrix
        for (var n = 1; n <= this.order; n++) {

            var gains_n = new Array(2 * n + 1);
            for (var i = 0; i < 2 * n + 1; i++) {
                gains_n[i] = new Array(2 * n + 1);
                for (var j = 0; j < 2 * n + 1; j++) {
                    gains_n[i][j] = this.ctx.createGain();
                    if (i == j) gains_n[i][j].gain.value = 1;
                    else gains_n[i][j].gain.value = 0;
                }
            }
            this.rotMtxNodes[n - 1] = gains_n;
        }

        // Create connections
        this.in.connect(this.out, 0, 0); // zeroth order ch. does not rotate

        var band_idx = 1;
        for (n = 1; n <= this.order; n++) {
            for (i = 0; i < 2 * n + 1; i++) {
                for (j = 0; j < 2 * n + 1; j++) {
                    this.in.connect(this.rotMtxNodes[n - 1][i][j], band_idx + j, 0);
                    this.rotMtxNodes[n - 1][i][j].connect(this.out, 0, band_idx + i);
                }
            }
            band_idx = band_idx + 2 * n + 1;
        }
    }

    // ── Núcleo: vuelca una matriz SH completa (nCh×nCh) en las ganancias ─────
    _applyMatrix(rotMtx) {
        this.rotMtx = rotMtx;

        var band_idx = 1;
        for (let n = 1; n < this.order + 1; n++) {
            for (let i = 0; i < 2 * n + 1; i++) {
                for (let j = 0; j < 2 * n + 1; j++) {
                    let g = rotMtx[band_idx + i][band_idx + j];
                    // Espejo L/R: negar el canal de salida Y (n=1, i=0 → ACN 1).
                    if (this.mirrorY && n === 1 && i === 0) g = -g;
                    this.rotMtxNodes[n - 1][i][j].gain.value = g;
                }
            }
            band_idx = band_idx + 2 * n + 1;
        }
    }

    // Rz(φ)·R3  — añade un offset de azimut (giro en el plano horizontal).
    _applyYawOffset(R3, phi) {
        const c = Math.cos(phi), s = Math.sin(phi);
        const Rz = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
        return Rz.map(row => [0, 1, 2].map(j =>
            row[0] * R3[0][j] + row[1] * R3[1][j] + row[2] * R3[2][j]));
    }

    // ── Matriz 3x3 ya expresada en la convención de ejes Ambisonics ─────────
    setRotationMatrix3(R3) {
        if (this.yawOffset) R3 = this._applyYawOffset(R3, this.yawOffset);
        this._applyMatrix(sht.getSHrotMtx(R3, this.order));
    }

    // ── THREE.Matrix4.elements (column-major) → remap de ejes a Ambisonics ──
    //  El remap reordena la rotación 3x3 de THREE (x derecha, y arriba, −z
    //  delante) a la convención Ambisonics ACN/SN3D (x delante, y izquierda,
    //  z arriba). Se conserva exactamente el mapeo original de HOAST.
    setRotationFromThreeMatrix4(e) {
        this.setRotationMatrix3([
            [e[10], e[8], e[9]],
            [e[2],  e[0], e[1]],
            [e[6],  e[4], e[5]],
        ]);
    }

    // ── Cuaternión (WebXR pose / THREE.Quaternion) → elements → remap ───────
    //  Construye la matriz de rotación column-major igual que
    //  THREE.Matrix4.makeRotationFromQuaternion y reutiliza el mismo remap,
    //  de modo que VR y escritorio comparten exactamente la misma rotación.
    setRotationFromQuaternion(q) {
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

        this.setRotationFromThreeMatrix4(e);
    }

    // ── Alias de compatibilidad con el código original ──────────────────────
    updateRotationFromCamera(elements) {
        this.setRotationFromThreeMatrix4(elements);
    }
}
