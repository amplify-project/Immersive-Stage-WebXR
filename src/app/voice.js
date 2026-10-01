/* ═══════════════════════════════════════════════════════════════════════════
 *  Recording the participant's voice, for reading afterwards.
 *
 *  What someone says while they are inside the piece — "I can't see the sax",
 *  "now it's behind me" — is the observation the pose telemetry cannot make. So
 *  this ships the microphone to the server in Opus chunks, each one stamped with
 *  the **media time** of the player at the moment it was captured. That is the
 *  same column the pose recorder writes (`media_s`), so the sentence and the
 *  head that was turning while it was said line up by a join, not by a guess.
 *
 *  ── The microphone is asked for on the flat page, never on entering XR ──────
 *
 *  Two reasons, and either alone is enough:
 *
 *  - A permission prompt cannot be painted inside an immersive session. Asking
 *    there is asking a question nobody can see.
 *  - `requestSession()` needs the user activation from the button press. Awaiting
 *    a permission prompt first spends it — the prompt outlives the activation
 *    window — and entering VR then fails for a reason that has nothing to do
 *    with VR.
 *
 *  So: press REC on the page, grant once, then enter VR. The permission is
 *  remembered per origin, so from the second session onwards the player starts
 *  recording by itself (player.js checks `navigator.permissions` for that) and
 *  the person in the headset has nothing to press.
 *
 *  ── Parts, and why a dropped socket does not cost a recording ───────────────
 *
 *  One MediaRecorder run is one **part** and one file, because the first chunk
 *  carries the container header and the rest are undecodable without it. While
 *  the socket is down chunks queue in memory (mono Opus is ~4 KB/s, so the 16 MB
 *  default is about an hour), and on reconnect they flush in order into the same
 *  file — the service opens parts for append. Only when the queue passes its cap
 *  does the part end and a new one begin: an extra file, never a corrupt one.
 *
 *  ── On the bleed ───────────────────────────────────────────────────────────
 *
 *  The Quest's speakers are open, so the mix ends up in the recording underneath
 *  the voice. Echo cancellation is on by default because intelligibility is what
 *  this is for — but the bleed is also a free acoustic reference: with
 *  `echoCancellation:false` the recording can be cross-correlated against the
 *  programme to recover the alignment without trusting any clock. Hence the
 *  constraints being a parameter and not a constant.
 * ═══════════════════════════════════════════════════════════════════════════ */

// In preference order. Opus in WebM is what every Chromium gives, and what the
// rest of the project already speaks; the others are here so that a browser we
// have not tested records something rather than nothing.
const MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

const DEFAULT_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,          // a voice; the spatial audio is not what we are keeping
  },
};

export class VoiceRecorder {
  /**
   * @param {object}   opt
   * @param {string}   opt.url                     ws:// or wss:// URL of the /voice endpoint
   * @param {string}  [opt.playerId]               the SAME id as the pose telemetry, or the join is manual
   * @param {number}  [opt.timesliceMs=1000]       chunk length
   * @param {number}  [opt.bitsPerSecond=32000]    Opus mono; ~4 KB/s
   * @param {object}  [opt.constraints]            getUserMedia constraints (see the header on bleed)
   * @param {object}  [opt.meta={}]                free-form, goes in the sidecar's first line
   * @param {() => number} [opt.mediaTime]         the player's media time, read per chunk
   * @param {number}  [opt.maxBufferBytes=16e6]    how much to hold while the socket is down
   * @param {(state: string, info: object) => void} [opt.onState]
   */
  constructor({ url, playerId, timesliceMs = 1000, bitsPerSecond = 32000, constraints = DEFAULT_CONSTRAINTS,
                meta = {}, mediaTime = () => 0, maxBufferBytes = 16e6, onState = () => {} } = {}) {
    if (!url) throw new Error('VoiceRecorder: `url` is required');
    this.url = url;
    this.playerId = playerId || ('p-' + Math.random().toString(36).slice(2, 10));
    this.timesliceMs = timesliceMs;
    this.bitsPerSecond = bitsPerSecond;
    this.constraints = constraints;
    this.meta = meta;
    this.mediaTime = mediaTime;
    this.maxBufferBytes = maxBufferBytes;
    this.onState = onState;

    this.state = 'idle';               // idle | recording | offline | error
    this.stamp = null;                 // names the files; one per start()
    // What the SERVICE called this recording, as it answers the hello. The pose
    // telemetry carries it so that a row of poses names the audio it belongs to
    // (see docs/telemetry.md, `rec`). Null until the first socket has opened, so
    // whoever publishes it has to be told rather than read it once.
    this.recRef = null;
    this.part = 0;
    this.chunksSent = 0;
    this.bytesSent = 0;

    this._stream = null;
    this._rec = null;
    this._ws = null;
    this._queue = [];                  // [{head, blob}] — never reordered: the container depends on it
    this._queued = 0;                  // bytes in _queue
    this._sending = false;
    this._stopped = true;
    this._newPart = false;
    this._backoff = 500;
    this._reconnectTimer = null;
    this._chunk = 0;
    this._t0 = 0; this._mt0 = 0;
    this._onHide = () => { try { this._rec && this._rec.state === 'recording' && this._rec.requestData(); } catch (_) {} };
  }

  /** Ask for the microphone, open the socket, start recording. Call it from a click. */
  async start() {
    if (!this._stopped) return;
    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined')
      throw new Error('Este navegador no graba audio (MediaRecorder / getUserMedia)');

    // First, and on its own: if this is refused there is nothing else to undo.
    this._stream = await navigator.mediaDevices.getUserMedia(this.constraints);

    // Chosen here and not in _startPart(): the hello carries it, and the socket
    // may open before the first part does.
    this._mime = MIMES.find(m => MediaRecorder.isTypeSupported(m)) || '';

    this._stopped = false;
    this.stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.part = 0; this.chunksSent = 0; this.bytesSent = 0;
    addEventListener('pagehide', this._onHide);
    this._connect();
    this._startPart();
    this._set('recording');
  }

  /** Stop, release the microphone, flush what is left and close. Idempotent. */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    removeEventListener('pagehide', this._onHide);
    clearTimeout(this._reconnectTimer); this._reconnectTimer = null;
    // stop() on the recorder fires one last `dataavailable` and THEN `onstop`,
    // both asynchronously. So closing the socket here would cut off the final
    // second of what was said: _finish() has to wait for that chunk to have been
    // queued, which is what onstop tells us. The timer is for the browser that
    // never fires it — a socket and a poll left open for ever is worse than a
    // lost tail.
    const rec = this._rec; this._rec = null;
    let tail = false;
    try { if (rec && rec.state !== 'inactive') { rec.stop(); tail = true; } } catch (_) {}
    // Releasing the track is what puts out the system's microphone indicator.
    // It is the only honest sign the person in the headset has that we stopped,
    // so it happens now and not when the last byte has gone.
    try { this._stream && this._stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    this._stream = null;
    this.recRef = null;                                 // what follows belongs to no recording
    this._set('idle');
    if (tail) setTimeout(() => this._finish(), 3000);   // backstop; onstop normally gets there first
    else this._finish();
  }

  get recording() { return !this._stopped; }

  /**
   * Note something worth finding later in the sidecar — entering VR, leaving
   * AR — as its own line, stamped like a chunk. Sent out of band and not
   * queued: a mark is a pointer into a recording that is being kept anyway, and
   * one lost to a dropped socket costs a landmark, not a word of the audio.
   */
  mark(ev, data = {}) {
    if (this._stopped) return;
    this._send({ m: { ev: String(ev).slice(0, 64), t: r1(nowMs()), mt: r3(this._mt()), w: Date.now(), ...data } });
  }

  /** What to print when somebody asks whether this is working. */
  diag() {
    return {
      state: this.state, id: this.playerId, stamp: this.stamp, part: this.part,
      chunksSent: this.chunksSent, bytesSent: this.bytesSent,
      queued: this._queue.length, queuedBytes: this._queued,
      queuedParts: [...new Set(this._queue.map(q => q.head.p))],
      recRef: this.recRef,
      socket: this._isOpen() ? 'open' : 'down',
    };
  }

  // ── internals ──────────────────────────────────────────────

  // `next` is what makes this a NEW part. The increment lives here and not in
  // _overflow() on purpose: stopping a recorder flushes one last chunk, which
  // arrives after _overflow() has returned. Numbered there, that tail would be
  // labelled with the part it does not belong to and land in the new part's
  // file — ahead of the header chunk — leaving two files, one truncated and one
  // that does not decode at all.
  _startPart({ next = false } = {}) {
    if (this._stopped || !this._stream) return;
    if (next) this.part++;
    const opt = { audioBitsPerSecond: this.bitsPerSecond };
    if (this._mime) opt.mimeType = this._mime;
    this._chunk = 0;
    this._t0 = nowMs(); this._mt0 = this._mt();
    this._newPart = false;

    const rec = new MediaRecorder(this._stream, opt);
    rec.ondataavailable = (ev) => this._onData(ev.data);
    rec.onerror = (e) => { console.warn('[voice] MediaRecorder:', e.error || e); this._set('error', { error: String(e.error || e) }); };
    rec.onstop = () => { if (this._stopped) this._finish(); };
    this._rec = rec;
    rec.start(this.timesliceMs);
  }

  _onData(blob) {
    if (!blob || !blob.size) return;
    const t = nowMs(), mt = this._mt();
    // The chunk covers the slice that ENDS now, so both ends of it are recorded:
    // a single stamp would be read as its start by half the people who open the
    // file and as its end by the other half.
    const head = {
      p: this.part, i: this._chunk++, bytes: blob.size,
      t0: r1(this._t0), t: r1(t), mt0: r3(this._mt0), mt: r3(mt), w: Date.now(),
    };
    this._t0 = t; this._mt0 = mt;

    this._queue.push({ head, blob });
    this._queued += blob.size;
    if (this._queued > this.maxBufferBytes) this._overflow();
    this._pump();
  }

  // The socket has been down long enough that we are holding more than we said
  // we would. The queue is NOT dropped — it is a valid file from its header on,
  // and it flushes when the socket comes back. What ends is the part: the
  // recorder restarts, and the next file begins with a header of its own.
  _overflow() {
    if (this._newPart) return;
    console.warn(`[voice] ${(this._queued / 1e6).toFixed(1)} MB buffered with no socket — ending part ${this.part}`);
    this._newPart = true;
    try { if (this._rec && this._rec.state !== 'inactive') this._rec.stop(); } catch (_) {}
    this._rec = null;
  }

  _pump() {
    if (this._sending || !this._isOpen() || !this._queue.length) return;
    this._sending = true;
    (async () => {
      try {
        while (this._queue.length && this._isOpen()) {
          // Reading the blob is async, which is the whole reason for a pump: two
          // chunks racing through here would interleave their header and body
          // frames, and the pairing on the server is arrival order.
          const { head, blob } = this._queue[0];
          const buf = await blob.arrayBuffer();
          if (!this._isOpen()) break;                   // died while we were reading
          // Let the socket drain rather than grow a send buffer we cannot see.
          if (this._ws.bufferedAmount > 4e6) { setTimeout(() => this._pump(), 250); break; }
          this._ws.send(JSON.stringify({ c: head }));
          this._ws.send(buf);
          this._queue.shift();
          this._queued -= head.bytes;
          this.chunksSent++; this.bytesSent += head.bytes;
        }
      } catch (e) {
        console.warn('[voice] send failed:', e.message || e);
      } finally {
        this._sending = false;
      }
    })();
  }

  _connect() {
    if (this._stopped) return;
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (_) { return this._scheduleReconnect(); }
    this._ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this._backoff = 500;
      this._send({ hello: this.playerId, stamp: this.stamp, mime: this._mime || '', meta: this.meta });
      // A part that ended while the socket was down starts now, behind whatever
      // is still queued: order is the queue's, so the old part flushes first.
      if (this._newPart && !this._stopped) this._startPart({ next: true });
      if (!this._stopped) this._set('recording');
      this._pump();
    };
    // The only thing that comes down this socket: the name the service gave the
    // recording. Handed on through onState, because by then whoever wanted it
    // has already been told we are recording.
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.rec && m.rec !== this.recRef) {
        this.recRef = m.rec;
        try { this.onState(this.state, { recRef: m.rec }); } catch (_) {}
      }
    };
    ws.onclose = () => {
      if (this._ws !== ws) return;
      this._ws = null;
      if (!this._stopped) { this._set('offline'); this._scheduleReconnect(); }
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._connect(); }, this._backoff);
    this._backoff = Math.min(this._backoff * 2, 5000);
  }

  // stop() cannot close the socket: the final chunk is still on its way out of
  // MediaRecorder. Wait for the queue, with a deadline — an unreachable server
  // must not leave a socket and a timer behind for ever.
  _finish(deadline = nowMs() + 5000) {
    this._pump();
    if (this._queue.length && this._isOpen() && nowMs() < deadline)
      return void setTimeout(() => this._finish(deadline), 150);
    if (this._queue.length) console.warn(`[voice] ${this._queue.length} chunk(s) never sent`);
    this._send({ bye: 1 });
    if (this._ws) { try { this._ws.close(); } catch (_) {} this._ws = null; }
    this._queue.length = 0; this._queued = 0;
  }

  _send(obj) {
    if (!this._isOpen()) return false;
    try { this._ws.send(JSON.stringify(obj)); return true; }
    catch (_) { return false; }
  }

  _isOpen() { return !!this._ws && this._ws.readyState === 1; }
  _mt() { try { return this.mediaTime() || 0; } catch (_) { return 0; } }
  _set(state, info = {}) { if (state === this.state) return; this.state = state; try { this.onState(state, info); } catch (_) {} }
}

// Monotonic, like the telemetry's `t`: an NTP step mid-session would otherwise
// move chunks under an offset measured before it.
function nowMs() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
function r1(n) { return Math.round(n * 10) / 10; }
function r3(n) { return Math.round(n * 1e3) / 1e3; }
