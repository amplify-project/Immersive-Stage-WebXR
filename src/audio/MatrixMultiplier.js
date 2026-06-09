// ============================================================================
//  MatrixMultiplier — Multiplica el vector de canales Ambisonics por una matriz
//  NxN de ganancias (se usa para el "zoom acústico"). Independiente de framework.
//  Requiere el global `numeric` (numericjs) para la identidad por defecto.
//  Basado en el proyecto HOAST (hoast360).
// ============================================================================

export class MatrixMultiplier {

    constructor(audioCtx, order) {
        this.ctx = audioCtx;
        this.order = order;
        this.nCh = (order + 1) * (order + 1);

        this.mtx = numeric.identity(this.nCh);
        this.bypassed = false;

        // Input and output nodes
        this.in = this.ctx.createChannelSplitter(this.nCh);
        this.out = this.ctx.createChannelMerger(this.nCh);

        this.gain = new Array(this.nCh);

        for (var row = 0; row < this.nCh; row++) {
            this.gain[row] = new Array(this.nCh);

            for (var col = 0; col < this.nCh; col++) {

                this.gain[row][col] = this.ctx.createGain();
                this.gain[row][col].gain.value = this.mtx[row][col];

                this.in.connect(this.gain[row][col], col, 0);
                this.gain[row][col].connect(this.out, 0, row);
            }
        }
    }

    updateMtx(mtx) {
        if (this.bypassed)
            return;

        this.mtx = mtx;

        for (var row = 0; row < this.nCh; row++) {       //outputs
            for (var col = 0; col < this.nCh; col++) {	   //inputs
                this.gain[row][col].gain.value = this.mtx[row][col]; //set new gains
            }
        }
    }

    bypass(shouldBeActive) {
        if (shouldBeActive) {
            this.updateMtx(numeric.identity(this.nCh));
            this.bypassed = true;
        }
        else {
            this.bypassed = false;
        }
    }

    printGainMtx() {
        console.log(this);
    }
}
