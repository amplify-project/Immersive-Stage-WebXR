// Close-up transition, tested without a headset, a manifest or a browser.
//
// The functions are lifted OUT OF player.js by text, not reimplemented here, so
// this cannot quietly drift from what ships. Everything they touch — the video
// element, the Shaka instance, the Three mesh, the audio engine — is a stub, and
// the clock is virtual, so five seconds of gaze cost microseconds.
//
//   node tools/closeup-transition.test.mjs
//
// See docs/closeup-panel.md.
import fs from 'fs';

const PLAYER = new URL('../src/app/player.js', import.meta.url);
const src = fs.readFileSync(PLAYER, 'utf8');

const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('cannot find ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
};
const consts = src.match(/const CLOSEUP_FADE_S[\s\S]*?const CLOSEUP_ARM_DWELL_S\s*=\s*[-\d.]+;/)[0];
const real = [consts, grab('closeupCanShow'), grab('showCloseup'), grab('selectCloseupTrack'),
              grab('updateCloseupAnim'), grab('resetCloseup'), grab('updateCloseupFocus')].join('\n\n');

// The module-level state the lifted functions close over.
const harness = `
  let closeupStem = -1, closeupWant = -1, closeupArmed = -1, closeupFade = 0, closeupLastT = 0;
  let closeupArmCand = -1, closeupArmSince = 0;
  let closeupReady = true, closeupTexture = {}, arSession = null;
  let closeupRepByStem = { 0: '1', 3: '2' };   // only stems 0 and 3 have a close-up
  const HAS_RVFC = true;
  ${real}
  return {
    showCloseup, updateCloseupAnim, resetCloseup, updateCloseupFocus,
    st: () => ({ stem: closeupStem, want: closeupWant, armed: closeupArmed,
                 fade: +closeupFade.toFixed(3), vis: closeupMesh.visible,
                 op: +closeupMesh.material.opacity.toFixed(3), sc: +closeupMesh.scale.v.toFixed(3) }),
    map: () => ({ ...closeupRepByStem }),
    setAR: v => arSession = v,
  };`;

// ── Stubs ──────────────────────────────────────────────────────────────────
let t = 0;                                   // virtual clock (ms)
const performance = { now: () => t };
const closeupMesh = { visible: false, material: { opacity: 0 },
                      scale: { v: 1, setScalar(x) { this.v = x; } } };
let plays = 0, seeks = 0, _ct = 0;
// currentTime counts SEEKS, not values: every jump flushes the decoder, and that
// is the thing worth measuring.
const closeupEl = { readyState: 4, seeking: false, paused: true,
                    get currentTime() { return _ct; },
                    set currentTime(v) { if (v !== _ct) seeks++; _ct = v; },
                    pause() { this.paused = true; },
                    play() { this.paused = false; plays++; return { catch() {} }; } };
const videoEl = { currentTime: 10, paused: false };
let weights = [];
const engine = { getFocusedStem(min) { let bi = -1, bw = min;
  weights.forEach((w, i) => { if (w > bw) { bw = w; bi = i; } }); return bi; } };
let switches = 0;
const tracks = [{ originalVideoId: '1', active: false }, { originalVideoId: '2', active: false }];
const shakaCloseup = { getVariantTracks: () => tracks,
  selectVariantTrack(v) { switches++; tracks.forEach(x => x.active = false); v.active = true; } };

const P = new Function('performance', 'closeupMesh', 'closeupEl', 'videoEl', 'engine',
                       'shakaCloseup', 'console', harness)
            (performance, closeupMesh, closeupEl, videoEl, engine, shakaCloseup, console);

// The clock runs: the 360 never waits, the close-up advances only while playing.
// That is what lets a paused track drift and earn itself a seek.
const frame = (ms = 16.7) => {
  t += ms;
  videoEl.currentTime += ms / 1000;
  if (!closeupEl.paused) _ct += ms / 1000;
  P.updateCloseupFocus(); P.updateCloseupAnim();
};
const run = (n, ms) => { for (let i = 0; i < n; i++) frame(ms); };
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + '  ' + msg); if (!cond) fails++; };

console.log('\n1) Nothing focused → no panel');
weights = [0, 0, 0, 0]; run(30); ok(!P.st().vis && P.st().fade === 0, 'invisible, fade 0');

console.log('\n2) Stem 0 crosses ENTER → it fades in, it does not pop');
weights = [0.9, 0, 0, 0]; frame();
const f1 = P.st(); ok(f1.vis && f1.op > 0 && f1.op < 0.5, `first frame opacity ${f1.op} (partial, not 1)`);
ok(f1.sc > 0.9 && f1.sc < 1, `first frame scale ${f1.sc} (grows on the way in)`);
run(4); ok(P.st().op > f1.op, `rising: ${f1.op} → ${P.st().op}`);
run(20); ok(P.st().op === 1 && P.st().sc === 1 && P.st().stem === 0, 'reaches full opacity/scale on stem 0');

console.log('\n3) Hysteresis: weight oscillating between EXIT and ENTER → no flicker');
let flicker = 0;
for (let i = 0; i < 60; i++) { weights = [i % 2 ? 0.22 : 0.33, 0, 0, 0]; frame();
  if (!P.st().vis || P.st().op < 1) flicker++; }
ok(flicker === 0, `60 frames straddling the old single threshold: ${flicker} dropped`);

console.log('\n4) Weight falls below EXIT → fades out and lets the track go');
weights = [0.05, 0, 0, 0]; frame();
ok(P.st().vis && P.st().op < 1 && P.st().op > 0, `easing down (${P.st().op}), still visible`);
run(30); ok(!P.st().vis && P.st().stem === -1 && closeupEl.paused, 'invisible, no track, element paused');

console.log('\n5) Switching musician: one leaves before the other arrives');
weights = [0.9, 0, 0, 0]; run(30); switches = 0;
weights = [0, 0, 0, 0.9];
let cross = 0, sawZero = false;
for (let i = 0; i < 40; i++) { frame();
  if (P.st().stem === 3 && !sawZero && P.st().op > 0.02) cross++;
  if (P.st().fade === 0) sawZero = true; }
ok(sawZero, 'the panel passes through zero before the content changes');
ok(cross === 0, 'stem 3 is never shown while the panel still holds stem 0');
ok(P.st().stem === 3 && P.st().op === 1, 'ends on stem 3 at full opacity');
ok(switches === 1, `exactly one track switch (${switches})`);

console.log('\n6) An undecoded track waits: no fading in on a blank panel');
P.resetCloseup(); weights = [0, 0, 0, 0]; run(40);
closeupEl.readyState = 1; weights = [0.9, 0, 0, 0]; run(30);
ok(!P.st().vis, 'readyState=1: stays out even though the gaze asks for it');
closeupEl.seeking = true; closeupEl.readyState = 4; run(30);
ok(!P.st().vis, 'seeking: likewise');
closeupEl.seeking = false; run(30); ok(P.st().op === 1, 'with pictures decoded, in it comes');
closeupEl.readyState = 1; run(5); ok(P.st().op === 1, 'a rebuffer does NOT throw an established panel out');
closeupEl.readyState = 4;

console.log('\n7) PRELOAD: grazing a musician (EXIT) loads the track without showing it');
P.resetCloseup(); tracks.forEach(x => x.active = false); weights = [0, 0, 0, 0]; run(40);
switches = 0; weights = [0.25, 0, 0, 0];            // between EXIT and ENTER
run(3);
ok(P.st().armed === -1, 'not armed instantly: the candidate has to hold');
run(40);
ok(P.st().armed === 0 && P.st().stem === 0, "stem 0's track gets selected");
ok(switches === 1 && !closeupEl.paused, 'switched and running: already decoding');
ok(!P.st().vis && P.st().fade === 0, 'but the panel stays out: it has not won the focus');

console.log('\n8) Winning the focus shows what was preloaded, with no reload');
switches = 0; seeks = 0;
weights = [0.9, 0, 0, 0]; frame();
ok(switches === 0, 'no new switch: the track was already there');
ok(seeks === 0, 'no new seek: it kept itself in time');
ok(P.st().vis && P.st().op > 0, 'starts entering on the SAME frame it wins the focus');

console.log('\n9) A paused element is not shown, and gets played again');
P.resetCloseup(); weights = [0, 0, 0, 0]; run(40);
weights = [0.9, 0, 0, 0]; run(2); closeupEl.pause(); plays = 0; frame();
ok(plays === 1 && !closeupEl.paused, 'play() called once, not once per frame');
frame(); ok(plays === 1, 'and not repeated while it runs');
run(30); ok(P.st().op === 1, 'it does end up entering');

console.log('\n10) Grazing the preload threshold is NOT a pause/play/seek storm');
P.resetCloseup(); tracks.forEach(x => x.active = false); weights = [0, 0, 0, 0]; run(40);
switches = 0; plays = 0; seeks = 0;
for (let i = 0; i < 300; i++) {          // 5 s of gaze trembling over EXIT
  weights = [i % 2 ? 0.18 : 0.22, 0, 0, 0]; frame();
}
ok(switches <= 1, `track switches: ${switches} (was one per frame)`);
ok(seeks <= 1, `currentTime seeks: ${seeks} (each one flushes the decoder)`);
ok(plays <= 1, `play() calls: ${plays} (was 150)`);
ok(!P.st().vis, 'and the panel never comes out, which is correct');

console.log('\n11) A stem with no close-up is neither shown nor preloaded');
P.resetCloseup(); weights = [0, 0.9, 0, 0]; run(40);
ok(!P.st().vis, 'stem 1 (no track) → no panel');
ok(P.st().armed === -1, 'and nothing gets armed');

console.log('\n12) A track missing from the manifest is dropped, not retried');
P.resetCloseup(); tracks.length = 1;              // representation 2 disappears
switches = 0; weights = [0, 0, 0, 0.9]; run(40);
ok(P.map()[3] === undefined, 'stem 3 leaves the map');
ok(switches === 0 && !P.st().vis, 'no switches, no panel');
tracks.push({ originalVideoId: '2', active: false });

console.log('\n13) Entering AR kills it outright and it does not come back');
P.resetCloseup(); weights = [0.9, 0, 0, 0]; run(40); ok(P.st().op === 1, 'panel up before AR');
P.setAR({}); P.resetCloseup();
ok(!P.st().vis && P.st().op === 0 && P.st().armed === -1, 'AR: straight to zero, nothing armed');
run(30); ok(!P.st().vis, 'and it stays out however high the weight');

console.log('\n14) A very long frame (background tab) does not skip the transition');
P.setAR(null); weights = [0, 0, 0, 0]; run(40); weights = [0.9, 0, 0, 0];
frame(); const h0 = P.st().op; frame(5000); const h = P.st();
ok(h.op > h0 && h.op < 1, `dt capped: opacity ${h.op}, neither 0 nor 1 in one go`);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll good\n');
process.exit(fails ? 1 : 0);
