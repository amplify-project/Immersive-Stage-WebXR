#!/usr/bin/env node
// Reads a perflog/perf-<session>.jsonl written by the player with ?arperf=1
// and splits the dropped frames by what they had in common: hands or
// controllers tracked, head turning, a video upload in that frame, GPU time.
//
//   node tools/perf-analyze.js                 # latest file in perflog/
//   node tools/perf-analyze.js perflog/perf-X.jsonl
'use strict';
const fs = require('fs');
const path = require('path');

let file = process.argv[2];
if (!file) {
  const dir = path.join(__dirname, '..', 'perflog');
  const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort() : [];
  if (!all.length) { console.error('no perflog/*.jsonl yet'); process.exit(1); }
  file = path.join(dir, all[all.length - 1]);
}
const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const info = (lines.find(l => l.info) || {}).info || {};
const wins = lines.filter(l => l.summary);

console.log(file);
console.log('info', JSON.stringify(info, null, 1), '\n');
console.log('  t  mode  fps slow  gpuAvg gpuWorst hands pads headMax  360fps  cu fps  dropped360  vrate  rate  cuErr(avg/max ms)');
wins.forEach((w, i) => {
  const s = w.summary;
  console.log(`${String(i * 2).padStart(3)}  ${String(s.mode || 'xr').padEnd(3)} ${String(s.fps).padStart(4)} ${String(s.slow).padStart(4)}` +
    `  ${String(s.gpuAvg ?? '-').padStart(6)} ${String(s.gpuWorst ?? '-').padStart(8)}` +
    ` ${String(s.hands).padStart(5)} ${String(s.pads).padStart(4)} ${String(s.headMax).padStart(7)}` +
    ` ${String(s.videoFps).padStart(7)} ${String(s.closeupFps).padStart(7)} ${String(s.dropped360).padStart(11)}  ${String(s.vrate ?? '-').padStart(5)}  ${s.rate ?? '-'}  ${s.cuErrAvg != null ? s.cuErrAvg + '/' + s.cuErrMax : '-'}`);
});

// Flatten rows with their window's input state. A frame is "dropped" when it
// came more than 1.5 periods after the previous one; the cost that caused it
// is usually in the frame BEFORE the gap, so `prev` is kept too.
// The frame period comes from the frames themselves (median interval): the
// session can start at one rate and switch (?xrfps=72 lands after the info).
const _dts = wins.flatMap(w => w.rows.map(r => r.dt)).filter(x => x > 0).sort((a, b) => a - b);
const period = _dts.length ? _dts[_dts.length >> 1] : 1000 / (info.frameRate || 72);
const rows = [];
for (const w of wins) {
  let prev = null;
  for (const r of w.rows) {
    rows.push({ ...r, hands: w.summary.hands, pads: w.summary.pads, prev });
    prev = r;
  }
}
const drop = r => r.dt > 1.5 * period;
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
const avg = (xs) => xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '-';

function split(label, groups) {
  console.log(`\n${label}`);
  for (const [name, f] of groups) {
    const g = rows.filter(f), d = g.filter(drop);
    console.log(`  ${name.padEnd(28)} ${String(g.length).padStart(6)} frames  dropped ${pct(d.length, g.length).padStart(6)}` +
      `   gpu avg ${avg(g.map(r => r.gpu).filter(x => x != null))} ms`);
  }
}

console.log(`\n${rows.length} frames, period ${period.toFixed(1)} ms, dropped ${pct(rows.filter(drop).length, rows.length)}`);
split('by input', [
  ['nothing tracked', r => !r.hands && !r.pads],
  ['hands', r => r.hands > 0],
  ['controllers', r => r.pads > 0],
]);
split('by head speed (deg/s)', [
  ['still  < 30', r => r.w < 30],
  ['slow   30-120', r => r.w >= 30 && r.w < 120],
  ['fast   >= 120', r => r.w >= 120],
]);
split('by video upload in the frame before the gap', [
  ['360 upload', r => r.prev && r.prev.v],
  ['close-up upload', r => r.prev && r.prev.cu],
  ['no upload', r => r.prev && !r.prev.v && !r.prev.cu],
]);
split('turning fast x input', [
  ['fast + nothing', r => r.w >= 120 && !r.hands && !r.pads],
  ['fast + hands', r => r.w >= 120 && r.hands > 0],
  ['fast + controllers', r => r.w >= 120 && r.pads > 0],
]);

// Segment downloads (player builds after the network markers were added).
// A frame is "during a download" when it falls between a request and its
// response, or up to 500 ms after the response (append + demux).
const ev = wins.flatMap(w => w.ev || []);
if (ev.length && rows.some(r => r.t != null)) {
  const spans = [];
  for (const e of ev.filter(e => e.k.endsWith('>'))) {
    const done = ev.find(x => x.k === e.k[0] + '<' && x.u === e.u && x.t >= e.t);
    if (done) spans.push({ a: e.t, b: done.t + 500, u: e.u, mb: (done.b / 1e6).toFixed(1), ms: done.t - e.t });
  }
  console.log('\nsegment downloads');
  spans.forEach(s => console.log(`  ${s.u.padEnd(34)} ${String(s.mb).padStart(5)} MB  ${String(s.ms).padStart(5)} ms`));
  const inDl = r => spans.some(s => r.t >= s.a && r.t <= s.b);
  split('by segment download', [
    ['during download / append', r => r.t != null && inDl(r)],
    ['no download', r => r.t != null && !inDl(r)],
  ]);
}

const withGpu = rows.filter(r => r.gpu != null);
if (withGpu.length) {
  const over = withGpu.filter(r => r.gpu > period * 0.9);
  console.log(`\nGPU: ${withGpu.length} frames measured, ${pct(over.length, withGpu.length)} above 90% of the period` +
    ` · avg before a gap ${avg(rows.filter(drop).map(r => r.prev && r.prev.gpu).filter(x => x != null))} ms` +
    ` vs overall ${avg(withGpu.map(r => r.gpu))} ms`);
} else {
  console.log('\nGPU: no timer query on this browser — run `adb logcat -s VrApi` alongside for GPU%');
}
const cpu = rows.map(r => r.js + r.rd);
console.log(`CPU js+render: avg ${avg(cpu)} ms, worst ${Math.max(...cpu).toFixed(1)} ms`);
