// src/telemetry/Telemetry.js
//
// Head-pose telemetry client — fully decoupled from the player.
//
// It knows nothing about WebXR, Three.js or the audio engine: it receives
// duck-typed position / orientation objects ({x,y,z} and {x,y,z,w}) plus a few
// scalars, decimates them to a fixed rate, batches, and ships them over a
// single WebSocket to an external relay. The relay fans every player's latest
// pose + gaze out to whatever consumes it (e.g. a Unity render).
//
// Hot path is allocation-free until a sample is actually taken: the decimation
// gate is the first statement, so calling sample() on every render frame
// (72–120 Hz) costs almost nothing while the rate cap (default 20 Hz) holds.
//
// Wire protocol (client -> relay), one JSON frame per WebSocket message:
//   hello : {"hello":"<playerId>","meta":{...}}                 // once per connection
//   data  : {"b":[{t,w,mt,p:[x,y,z],q:[x,y,z,w],z,f[,g]}, ...]} // batched samples
// The relay derives head-forward gaze from q (or uses g if real eye-tracking
// is present) and re-emits to consumers. See docs/telemetry.md for that side.

export class Telemetry {
  /**
   * @param {object}   opt
   * @param {string}   opt.url                 ws:// or wss:// URL of the relay ingest endpoint
   * @param {string}  [opt.playerId]           stable id for this player (random if omitted)
   * @param {number}  [opt.rateHz=20]          samples per second (held on a fixed grid; 0 = every call)
   * @param {number}  [opt.flushMs=100]        batch window; <= 0 sends every sample immediately
   * @param {number}  [opt.maxQueue=120]       max samples buffered while offline (drops oldest)
   * @param {object}  [opt.meta={}]            free-form metadata sent in the hello frame
   * @param {boolean} [opt.autoReconnect=true] reconnect with backoff on drop
   */
  constructor({ url, playerId, rateHz = 20, flushMs = 100, maxQueue = 120, meta = {}, autoReconnect = true } = {}) {
    if (!url) throw new Error('Telemetry: `url` is required');
    this.url = url;
    this.playerId = playerId || ('p-' + Math.random().toString(36).slice(2, 10));
    this.meta = meta;

    this._interval = rateHz > 0 ? 1000 / rateHz : 0;
    this._flushMs = flushMs;
    this._maxQueue = maxQueue;
    this._autoReconnect = autoReconnect;

    this._ws = null;
    this._queue = [];
    this._nextSample = 0;
    this._flushTimer = null;
    this._reconnectTimer = null;
    this._backoff = 500;              // ms, doubles up to _backoffMax
    this._backoffMax = 5000;
    this._stopped = true;
    this._onHide = () => this._flush();   // best-effort flush when the tab goes away
  }

  /** Open the connection and start the flush loop. Idempotent. */
  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._nextSample = 0;            // first sample() of the session takes it
    this._connect();
    if (this._flushMs > 0 && !this._flushTimer)
      this._flushTimer = setInterval(() => this._flush(), this._flushMs);
    if (typeof addEventListener === 'function')
      addEventListener('pagehide', this._onHide);
  }

  /** Flush, close, and stop reconnecting. Idempotent. */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (typeof removeEventListener === 'function')
      removeEventListener('pagehide', this._onHide);
    clearInterval(this._flushTimer); this._flushTimer = null;
    clearTimeout(this._reconnectTimer); this._reconnectTimer = null;
    this._flush();
    if (this._ws) { try { this._ws.close(); } catch (_) { /* already gone */ } this._ws = null; }
    this._queue.length = 0;
  }

  /**
   * Record one pose sample (decimated to rateHz). Safe to call every frame.
   * Reads the objects by reference — no allocation is forced on the caller.
   * @param {{x:number,y:number,z:number}}          position     head position
   * @param {{x:number,y:number,z:number,w:number}} orientation  head orientation quaternion
   * @param {number}    [zoom=0]     zoom / attention depth
   * @param {number}    [focus=-1]   focused source index (-1 = none)
   * @param {number}    [mediaTime=0] media presentation time in seconds (content correlation)
   * @param {?number[]} [gaze=null]  real eye-gaze vector [x,y,z] if available; omit for head-gaze
   */
  sample(position, orientation, zoom = 0, focus = -1, mediaTime = 0, gaze = null) {
    const now = nowMs();
    if (now < this._nextSample - GRID_EPS_MS) return;   // decimation gate (hot path)

    // The deadline advances on a fixed grid instead of from the sample actually
    // taken. Both look the same on paper and are not: sample() is called from the
    // render loop, so "last + interval" can only fire on a frame boundary, and at
    // 72 Hz the first frame past a 50 ms deadline is the 4th one — 55.5 ms, a
    // steady 18 Hz for a rateHz of 20 (measured on Quest 3, CWI 31-7-26 sessions).
    // On the grid a deadline is still served late by up to one frame, but the
    // lateness does not accumulate: the long-run rate is exactly rateHz.
    this._nextSample += this._interval;
    if (this._nextSample <= now) this._nextSample = now + this._interval;   // first call, or after a stall

    const s = {
      t: Math.round(now * 10) / 10,
      w: Date.now(),   // capture wall clock: the recorder's arrival stamp is batched
      mt: round(mediaTime, 3),
      p: [round4(position.x), round4(position.y), round4(position.z)],
      q: [round4(orientation.x), round4(orientation.y), round4(orientation.z), round4(orientation.w)],
      z: round(zoom, 2),
      f: focus,
    };
    if (gaze) s.g = [round4(gaze[0]), round4(gaze[1]), round4(gaze[2])];

    this._queue.push(s);
    if (this._queue.length > this._maxQueue) this._queue.shift();   // backpressure: keep newest
    if (this._flushMs <= 0) this._flush();
  }

  /** True while the socket is open and shipping. */
  get connected() { return this._isOpen(); }

  // ── internals ──────────────────────────────────────────────

  _connect() {
    if (this._stopped) return;
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (_) { return this._scheduleReconnect(); }
    this._ws = ws;
    ws.onopen = () => {
      this._backoff = 500;
      this._send({ hello: this.playerId, meta: this.meta });
    };
    // The relay's clock probe, and the only thing that comes down this socket
    // today. Answer it in the handler itself, without touching the queue or any
    // timer: the estimate the relay builds is only as good as this reply is
    // prompt, and anything we do before sending goes straight into its error.
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.ping !== undefined) this._send({ pong: m.ping, c: nowMs() });
    };
    ws.onclose = () => { if (this._ws === ws) { this._ws = null; this._scheduleReconnect(); } };
    ws.onerror = () => { try { ws.close(); } catch (_) { /* noop */ } };
  }

  _scheduleReconnect() {
    if (this._stopped || !this._autoReconnect || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._connect(); }, this._backoff);
    this._backoff = Math.min(this._backoff * 2, this._backoffMax);
  }

  _flush() {
    if (!this._queue.length || !this._isOpen()) return;   // stay buffered (capped) until reconnect
    const batch = this._queue;
    this._queue = [];
    this._send({ b: batch });
  }

  _send(obj) {
    if (!this._isOpen()) return false;
    try { this._ws.send(JSON.stringify(obj)); return true; }
    catch (_) { return false; }
  }

  _isOpen() { return !!this._ws && this._ws.readyState === 1; }
}

// Slack on the grid deadline, well under any frame period: guards the case where
// the render rate divides rateHz exactly (90 Hz / 20 Hz) and a frame lands on the
// deadline a float hair early, which would otherwise cost that beat a whole frame.
const GRID_EPS_MS = 1;

// Monotonic where it exists. `t` and the pong share it on purpose: the relay maps
// this one timeline onto its own clock, and a wall clock that can be stepped by
// NTP mid-session would move the samples under an offset measured before the step.
function nowMs() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }
function round4(n) { return Math.round(n * 1e4) / 1e4; }
