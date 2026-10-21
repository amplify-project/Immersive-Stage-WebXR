// Close-up tracks decoded with WebCodecs and slaved to the 360's clock.
//
// The close-up used to be a second <video> with its own Shaka: a second clock
// that the player kept chasing (seek past a threshold, nudge playbackRate
// below it). It arrived a few hundred ms late, drifted on every stall of either
// element, and started over on every seek. Here there is no second clock: the
// segments of the close-up track are fetched from the same manifest, demuxed
// (mp4box.js) and decoded (VideoDecoder) into frames that carry their own
// timestamps, and on every rendered frame the player asks for "the frame at
// the 360's time" — a lookup, not a chase. If the 360 stalls, the close-up
// holds the same frame; if it seeks, the close-up is rebuilt there.
//
// Ownership of frames: update() returns the current VideoFrame and keeps it
// open until it hands out the next one (then closes it). The caller uploads it
// to a texture before calling update() again, and never closes it.
//
// Measured on the Quest 3 browser with test.html: VideoDecoder available,
// H.264 by hardware, well above 60 fps for a 720p track while the 4K 360 plays,
// texImage2D(VideoFrame) accepted by WebGL.
//
// See docs/closeup-panel.md §11.

const MP4BOX_URL = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js';
const AHEAD_S = 2.5;      // keep segments fetched this far past the 360's time
const MAX_AHEAD = 4;      // decoded frames held ahead of it: hardware decoders have small
                          // output pools, and a decoder whose frames are all held stalls
const JUMP_S = 1.0;       // a time this far outside what we hold is a seek: rebuild there
const EPS_S = 0.004;      // a frame is due this much before its timestamp (rounding)

let _mp4boxP = null;
function loadMp4box() {
  if (window.MP4Box) return Promise.resolve();
  return _mp4boxP || (_mp4boxP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = MP4BOX_URL; s.onload = res; s.onerror = () => rej(new Error('mp4box.js did not load'));
    document.head.appendChild(s);
  }));
}

// init segment (+ one media segment) → { config?, chunks[] }. A fresh demuxer
// per segment: mp4box keeps every buffer appended to it, and a concert is long.
function demux(initBuf, segBuf, wantConfig) {
  return new Promise((resolve, reject) => {
    const file = window.MP4Box.createFile();
    const chunks = []; let config = null;
    file.onError = e => reject(new Error('mp4box: ' + e));
    file.onReady = info => {
      const t = info.videoTracks[0];
      if (!t) return reject(new Error('mp4box: no video track'));
      if (wantConfig) {
        const e = file.getTrackById(t.id).mdia.minf.stbl.stsd.entries[0];
        const box = e.avcC || e.hvcC;
        const ds = new window.DataStream(undefined, 0, window.DataStream.BIG_ENDIAN);
        box.write(ds);
        config = { codec: t.codec, codedWidth: t.video.width, codedHeight: t.video.height,
                   description: new Uint8Array(ds.buffer, 8) };   // without the box header
      }
      file.setExtractionOptions(t.id, null, { nbSamples: 100000 });
      file.start();
    };
    file.onSamples = (id, user, samples) => {
      for (const s of samples)
        chunks.push(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round(1e6 * s.cts / s.timescale),
          duration: Math.round(1e6 * s.duration / s.timescale), data: s.data }));
    };
    const a = initBuf.slice(0); a.fileStart = 0;      // copies: mp4box tags the buffers
    file.appendBuffer(a);
    if (segBuf) { const b = segBuf.slice(0); b.fileStart = a.byteLength; file.appendBuffer(b); }
    file.flush();
    setTimeout(() => resolve({ config, chunks }), 0);
  });
}

// Representation `rep` of an MPD with SegmentTemplate (+ SegmentTimeline, or a
// fixed duration), as stream.sh writes them. Segments carry their number, which
// stays the same across refreshes of a live manifest while indices shift.
function parseRep(doc, rep, base) {
  const r = [...doc.querySelectorAll('Representation')].find(x => x.getAttribute('id') === rep);
  if (!r) return null;
  const as = r.parentElement;
  const tpl = r.querySelector('SegmentTemplate') || as.querySelector('SegmentTemplate');
  const ts = +(tpl.getAttribute('timescale') || 1);
  const start = +(tpl.getAttribute('startNumber') || 1);
  const sub = (s, n) => s.replace('$RepresentationID$', rep)
    .replace(/\$Number%0(\d+)d\$/, (_, w) => String(n).padStart(+w, '0')).replace('$Number$', String(n));
  const media = tpl.getAttribute('media');
  const segs = [];
  const tl = tpl.querySelector('SegmentTimeline');
  if (tl) {
    let t = 0, n = start;
    for (const S of tl.querySelectorAll('S')) {
      if (S.hasAttribute('t')) t = +S.getAttribute('t');
      const d = +S.getAttribute('d'), k = +(S.getAttribute('r') || 0);
      for (let i = 0; i <= k; i++) { segs.push({ n, t: t / ts, d: d / ts }); t += d; n++; }
    }
  } else {
    const d = +tpl.getAttribute('duration') / ts;
    const total = parseDur(doc.documentElement.getAttribute('mediaPresentationDuration'));
    for (let i = 0; i * d < total; i++) segs.push({ n: start + i, t: i * d, d });
  }
  for (const s of segs) s.url = new URL(sub(media, s.n), base).href;
  return { codec: r.getAttribute('codecs') || as.getAttribute('codecs'),
           width: +r.getAttribute('width'), height: +r.getAttribute('height'),
           init: new URL(sub(tpl.getAttribute('initialization'), 0), base).href, segs };
}
function parseDur(s) {
  const m = /PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(s || '');
  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
}

export class CloseupWC {
  /**
   * @param {string} mpdUrl  absolute URL of the manifest the 360 plays
   * @param {object} [o]
   * @param {(msg:string) => void} [o.log]
   * @param {number} [o.offsetS]  added to the requested time (manual trim, s)
   */
  constructor(mpdUrl, { log = () => {}, offsetS = 0 } = {}) {
    this.mpdUrl = mpdUrl; this.log = log; this.offsetS = offsetS;
    this.reps = {}; this.inits = {};
    this.hw = 'no-preference';
    this.dynamic = false; this._mpdAt = 0;
    this.rep = null; this.epoch = 0;
    this.queue = []; this.current = null; this.pending = [];
    this.nextN = -1;          // number of the next segment to fetch; -1 = rebuild on next update
    this.fetching = false; this.decoder = null;
    this.errors = 0; this.dead = false;
    this.decoded = 0;         // frames decoded so far (diagnostics)
    this.lagMs = null;        // current frame vs requested time, ms (+ = ahead)
  }

  static available() {
    return typeof window.VideoDecoder === 'function' && typeof window.EncodedVideoChunk === 'function';
  }

  /** Parse the manifest for these Representation ids and check the codec. False = use the fallback. */
  async init(repIds) {
    await loadMp4box();
    await this._loadMpd(repIds.map(String));
    const any = this.reps[String(repIds[0])];
    if (!any) return false;
    const base = { codec: any.codec, codedWidth: any.width, codedHeight: any.height };
    if ((await VideoDecoder.isConfigSupported({ ...base, hardwareAcceleration: 'prefer-hardware' })).supported)
      this.hw = 'prefer-hardware';
    else if (!(await VideoDecoder.isConfigSupported(base)).supported) return false;
    this.log(`[closeup-wc] ${repIds.length} track(s), ${any.codec} ${any.width}x${any.height}, ${this.hw}` +
             (this.dynamic ? ', live' : ''));
    return true;
  }

  async _loadMpd(repIds) {
    const txt = await (await fetch(this.mpdUrl, { cache: 'no-store' })).text();
    const doc = new DOMParser().parseFromString(txt, 'application/xml');
    this.dynamic = doc.documentElement.getAttribute('type') === 'dynamic';
    for (const id of repIds || Object.keys(this.reps)) {
      const p = parseRep(doc, id, this.mpdUrl);
      if (p) this.reps[id] = p;
    }
    this._mpdAt = performance.now();
  }

  /** Switch to Representation `rep` (null = none). Frames start flowing on the next update(). */
  select(rep) {
    rep = rep == null ? null : String(rep);
    if (rep === this.rep) return;
    this.rep = rep;
    this._reset();
  }

  /** A frame for the requested time — not one of the stale frames shown while
   *  catching up after a jump (decoding runs from the segment's keyframe). */
  hasFrame() { return this.lagMs != null && this.lagMs > -80; }

  /**
   * One rendered frame: t = the 360's media time (s). Fetches and decodes what
   * is needed around t and returns the frame due at t (the newest with a
   * timestamp ≤ t), or null while there is none yet.
   */
  update(t) {
    if (this.dead || this.rep == null) return null;
    const R = this.reps[this.rep];
    if (!R) return null;
    t += this.offsetS;
    if (this.dynamic && performance.now() - this._mpdAt > 2000) {
      this._mpdAt = performance.now();
      this._loadMpd().catch(() => {});
    }

    // First call for this track, or a seek: rebuild from the segment holding t.
    if (this.nextN < 0) this._startAt(t, R);
    else {
      const a = this.current ? this.current.timestamp / 1e6 : (this.queue[0] ? this.queue[0].timestamp / 1e6 : null);
      const last = R.segs.find(s => s.n === this.nextN - 1);
      const b = last ? last.t + last.d : a;
      if (a != null && (t < a - JUMP_S || t > b + JUMP_S)) this._startAt(t, R);
    }

    // Due frames: the newest with timestamp ≤ t becomes current.
    while (this.queue.length && this.queue[0].timestamp / 1e6 <= t + EPS_S) {
      const f = this.queue.shift();
      if (this.current) this.current.close();
      this.current = f;
    }
    this.lagMs = this.current ? Math.round((this.current.timestamp / 1e6 - t) * 1000) : null;

    this._pump(t, R);
    return this.current;
  }

  _reset() {
    this.epoch++;
    for (const f of this.queue) f.close();
    this.queue = [];
    if (this.current) { this.current.close(); this.current = null; }
    this.pending = [];
    if (this.decoder && this.decoder.state !== 'closed') { try { this.decoder.close(); } catch (_) {} }
    this.decoder = null;
    this.fetching = false;
    this.nextN = -1;
  }

  _startAt(t, R) {
    this._reset();
    if (!R.segs.length) return;
    let s = R.segs.find(x => t < x.t + x.d);
    if (!s) s = R.segs[R.segs.length - 1];      // past the end, or at the live edge
    this.nextN = s.n;
  }

  _decoderFor(config) {
    const epoch = this.epoch;
    const d = new VideoDecoder({
      output: f => {
        if (epoch !== this.epoch) { f.close(); return; }
        this.decoded++;
        this.queue.push(f);
      },
      error: e => {
        if (epoch !== this.epoch) return;
        this.errors++;
        this.log('[closeup-wc] decoder error: ' + (e && e.message || e));
        if (this.errors > 3) { this.dead = true; this.log('[closeup-wc] giving up after repeated errors'); }
        this._reset();                           // rebuilt on the next update()
      },
    });
    d.configure({ ...config, hardwareAcceleration: this.hw, optimizeForLatency: true });
    return d;
  }

  _pump(t, R) {
    const epoch = this.epoch, rep = this.rep;
    // Fetch, one segment at a time, keeping AHEAD_S past t.
    if (!this.fetching && this.nextN >= 0) {
      const s = R.segs.find(x => x.n === this.nextN);
      if (s && s.t < t + AHEAD_S) {
        this.fetching = true;
        this._fetchSeg(rep, s).then(({ chunks, config }) => {
          if (epoch !== this.epoch) return;
          if (!this.decoder) this.decoder = this._decoderFor(config);
          this.pending.push(...chunks);
          this.nextN = s.n + 1;
          this.fetching = false;
        }).catch(e => {
          if (epoch !== this.epoch) return;
          this.fetching = false;                 // retried on a later frame
          this.log(`[closeup-wc] segment ${s.n}: ${e && e.message || e}`);
        });
      }
    }
    // Decode, holding at most MAX_AHEAD frames ahead of t. While catching up to
    // a jump target, every frame is due at once and update() consumes it.
    const d = this.decoder;
    if (!d || d.state !== 'configured') return;
    // Behind t (just after a jump): every frame decoded is due at once, so feed
    // the decoder harder until it catches up.
    const behind = !this.current || this.current.timestamp / 1e6 < t - 0.1;
    const depth = behind ? 8 : 3;
    while (this.pending.length && d.decodeQueueSize < depth &&
           this.queue.length + d.decodeQueueSize < (behind ? depth : MAX_AHEAD)) {
      d.decode(this.pending.shift());
    }
  }

  async _fetchSeg(rep, s) {
    let init = this.inits[rep];
    if (!init) {
      const buf = await (await fetch(this.reps[rep].init)).arrayBuffer();
      const { config } = await demux(buf, null, true);
      init = this.inits[rep] = { buf, config };
    }
    const r = await fetch(s.url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const { chunks } = await demux(init.buf, await r.arrayBuffer(), false);
    return { chunks, config: init.config };
  }

  close() { this.rep = null; this._reset(); }
}
