// telemetry/voice-client-smoke.mjs
//
// The browser half of the voice recording, exercised with no browser: doubles
// for WebSocket, MediaRecorder and getUserMedia, and then the invariants that
// stay invisible until a recording will not play.
//
//   node voice-client-smoke.mjs
//
// The one worth the trouble is the ORDER. Reading a chunk out of a Blob is
// async, so two of them racing through the sender would interleave their header
// and body frames — and the pairing on the service is arrival order, so every
// body would be filed under the wrong header and the .jsonl would describe a
// recording that does not exist. Nothing about that shows up until somebody
// opens the sidecar months later.
//
// src/app/voice.js is loaded through a copy with an .mjs extension: src/ has no
// package.json, so Node reads a .js there as CommonJS and refuses it, while the
// browser (<script type="module">) never asks the question.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = new URL('../src/app/voice.js', import.meta.url);
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-client-'));
const TMP = path.join(TMPDIR, 'voice.mjs');
fs.copyFileSync(SRC, TMP);

// ── the doubles ──────────────────────────────────────────────────────
const sent = [];            // everything that went out, in order
let socket = null;
let recorder = null;

globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

class FakeWS {
  constructor(url) {
    this.url = url; this.readyState = 0; this.bufferedAmount = 0; socket = this;
    setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 5);
  }
  send(d) {
    sent.push(typeof d === 'string' ? JSON.parse(d) : Buffer.from(d).toString());
    // The service answers the hello with the name it gave the recording.
    if (typeof d === 'string' && JSON.parse(d).hello)
      setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ rec: 'STAMP_p1' }) }), 1);
  }
  close() { const was = this.readyState; this.readyState = 3; if (was !== 3) this.onclose && this.onclose(); }
  drop()  { this.readyState = 3; this.onclose && this.onclose(); }
}
globalThis.WebSocket = FakeWS;

class FakeMediaRecorder {
  static isTypeSupported(m) { return m === 'audio/webm;codecs=opus'; }
  constructor(stream, opt) { this.state = 'inactive'; this.mimeType = opt.mimeType; recorder = this; }
  start() { this.state = 'recording'; }
  // Real order, and the reason stop() cannot close the socket itself: one last
  // `dataavailable` with whatever was in the encoder, and only then `onstop`.
  stop() {
    this.state = 'inactive';
    setTimeout(() => {
      this.ondataavailable({ data: new Blob(['tail']) });
      this.onstop && this.onstop();
    }, 0);
  }
  requestData() {}
  emit(text) { this.ondataavailable({ data: new Blob([text]) }); }   // one timeslice
}
globalThis.MediaRecorder = FakeMediaRecorder;

Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  configurable: true,
});

const { VoiceRecorder } = await import(pathToFileURL(TMP));

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) bad++; };

// ── the run ──────────────────────────────────────────────────────────
let mt = 0;
// A 12-byte buffer cap so two chunks overflow it: the real one is 16 MB, which
// is about an hour of mono Opus and not a thing a test can wait for.
const v = new VoiceRecorder({ url: 'wss://x/voice', playerId: 'p1', mediaTime: () => mt, maxBufferBytes: 12 });
await v.start();
await wait(20);
ok(sent[0] && sent[0].hello === 'p1' && sent[0].mime === 'audio/webm;codecs=opus', 'hello first, with the chosen container');

ok(v.recRef === 'STAMP_p1', 'the name the service gave the recording comes back and is kept');

mt = 1.5; recorder.emit('HDR');
mt = 2.5; recorder.emit('aaa');
await wait(30);
const p = sent.slice(1);
ok(p[0].c && p[0].c.i === 0 && p[1] === 'HDR', 'header frame then body, in that order');
ok(p[2].c.i === 1 && p[3] === 'aaa', 'and the next chunk after it, never interleaved');
ok(p[2].c.mt === 2.5 && p[2].c.mt0 === 1.5, 'each chunk carries both ends of its media-time span');

socket.drop();
mt = 3.5; recorder.emit('bbb');
await wait(30);
ok(v.diag().queued === 1 && v.state === 'offline', 'a chunk with no socket is queued, and the state says offline');

await wait(600);
const back = sent.slice(-2);
ok(back[0].c && back[0].c.p === 0 && back[1] === 'bbb', 'the queue flushes on reconnect, still part 0 — same file');
ok(v.state === 'recording', 'and it is recording again');

socket.drop();
recorder.emit('cccccccc'); recorder.emit('dddddddd');     // 16 bytes over a 12-byte cap
await wait(30);
ok(v.diag().queued === 3, 'overflowing keeps what was buffered, plus the chunk that ending the part flushed');
ok(String(v.diag().queuedParts) === '0', 'and every one of them is still part 0, tail included');

await wait(800);
recorder.emit('HDR2');
await wait(30);
const tail = sent.slice(-2);
ok(v.part === 1, 'the part only advances when the new recorder actually starts');
ok(tail[0].c.p === 1 && tail[0].c.i === 0, 'and it numbers itself from zero, with a header chunk of its own');

v.mark('enter-vr');
await wait(10);
ok(sent[sent.length - 1].m && sent[sent.length - 1].m.ev === 'enter-vr', 'marks go out as their own frame');

v.stop();
await wait(400);
ok(sent.includes('tail'), 'the chunk MediaRecorder emits on stop() still goes out');
ok(sent[sent.length - 1].bye === 1, 'and the goodbye comes after it, not before');
ok(!v.recording, 'and it is stopped');
ok(v.recRef === null, 'and the reference is dropped: what follows belongs to no recording');

fs.rmSync(TMPDIR, { recursive: true, force: true });
console.log(bad ? '\nVOICE CLIENT TEST FAILED' : '\nVOICE CLIENT TEST PASSED');
process.exit(bad ? 1 : 0);
