// pcm-stream-worklet.js — plays interleaved s16le PCM pushed from the main
// thread (the live monitor's WebSocket) as an N-channel audio source.
//
// Latency is the whole point, so the buffer is kept small and bounded:
//   · it starts playing once `target` frames are queued (~40 ms);
//   · if the queue grows past `max` (~200 ms) — the desk's clock runs a hair
//     faster than the sound card's, or the tab stalled — it skips ahead to
//     `target` instead of letting the delay creep up for the rest of the session;
//   · on an underrun it plays silence and primes again.
// It also measures every RAW channel (peak and RMS, before any spatialization)
// and posts them ~20 times a second for the meters, with the queue state.

class PcmStream extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.nch = o.channels;
    this.cap = o.capacityFrames || sampleRate;          // 1 s of ring
    this.target = o.targetFrames || Math.round(0.04 * sampleRate);
    this.max = o.maxFrames || Math.round(0.2 * sampleRate);
    this.buf = new Float32Array(this.cap * this.nch);   // interleaved
    this.r = 0; this.w = 0; this.fill = 0;
    this.priming = true;
    this.underruns = 0; this.skips = 0;
    this.peak = new Float32Array(this.nch);
    this.sq = new Float64Array(this.nch);
    this.mFrames = 0;
    this.meterEvery = Math.round(sampleRate / 20);
    this.port.onmessage = e => this.push(new Int16Array(e.data));
  }

  push(a) {
    const nch = this.nch, cap = this.cap, buf = this.buf;
    let n = (a.length / nch) | 0, src = 0;
    if (n > cap - this.fill) {                           // would overrun the ring: keep the newest
      const keep = Math.max(0, cap - this.fill);
      src = (n - keep) * nch; n = keep;
    }
    let w = this.w;
    for (let f = 0; f < n; f++) {
      const base = w * nch;
      for (let c = 0; c < nch; c++) buf[base + c] = a[src++] / 32768;
      if (++w === cap) w = 0;
    }
    this.w = w;
    this.fill += n;
    if (this.fill > this.max) {                          // drifted late: jump back to target
      const skip = this.fill - this.target;
      this.r = (this.r + skip) % cap;
      this.fill -= skip;
      this.skips++;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0], len = out[0].length, nch = this.nch, buf = this.buf;
    if (this.priming && this.fill >= this.target) this.priming = false;
    if (!this.priming && this.fill < len) { this.priming = true; this.underruns++; }
    if (!this.priming) {
      const nout = Math.min(out.length, nch);
      let r = this.r;
      for (let i = 0; i < len; i++) {
        const base = r * nch;
        for (let c = 0; c < nout; c++) {
          const v = buf[base + c];
          out[c][i] = v;
          const av = v < 0 ? -v : v;
          if (av > this.peak[c]) this.peak[c] = av;
          this.sq[c] += v * v;
        }
        if (++r === this.cap) r = 0;
      }
      this.r = r;
      this.fill -= len;
    }                                                    // priming: outputs stay zero
    this.mFrames += len;
    if (this.mFrames >= this.meterEvery) {
      const rms = new Float32Array(nch);
      for (let c = 0; c < nch; c++) rms[c] = Math.sqrt(this.sq[c] / this.mFrames);
      this.port.postMessage({ peak: this.peak.slice(), rms, fillMs: this.fill / sampleRate * 1000,
                              underruns: this.underruns, skips: this.skips, priming: this.priming });
      this.peak.fill(0); this.sq.fill(0); this.mFrames = 0;
    }
    return true;
  }
}

registerProcessor('pcm-stream', PcmStream);
