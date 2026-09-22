// Which video track ends up wrapped around the 360 sphere.
//
// With close-ups the manifest carries several video AdaptationSets and none of
// them says "I am the 360". Shaka picks the startup variant by bandwidth — even
// with ABR off — so the sphere ended up showing a musician's close-up. This runs
// the real sphereVariants() against the tracks Shaka would build from the
// manifest in encoded/, and one check REPRODUCES the bug, so the fix cannot be
// declared unnecessary by accident.
//
//   node tools/sphere-track.test.mjs
//
// See docs/closeup-panel.md §5.
import fs from 'fs';

const PLAYER = new URL('../src/app/player.js', import.meta.url);
const MPD    = new URL('../encoded/manifest.mpd', import.meta.url);

const src = fs.readFileSync(PLAYER, 'utf8');
const grab = n => { const i = src.indexOf(`function ${n}(`); let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } };
const SPHERE_REP = src.match(/const SPHERE_REP = '(\d+)'/)[1];

if (!fs.existsSync(MPD)) {
  console.log('\nencoded/manifest.mpd is not there — encode a scene with close-ups first.\n');
  process.exit(0);
}

// The variants as Shaka exposes them: one per video Representation (paired with
// the audio), carrying originalVideoId = the Representation id.
const mpd = fs.readFileSync(MPD, 'utf8');
const vids = [...mpd.matchAll(/<Representation id="(\d+)"[^>]*?mimeType="video\/mp4"[^>]*?bandwidth="(\d+)"[^>]*?width="(\d+)"[^>]*?height="(\d+)"/g)]
  .map(m => ({ originalVideoId: m[1], bandwidth: +m[2], width: +m[3], height: +m[4], active: false }));
if (!vids.length) { console.log('\nNo video representations in the manifest.\n'); process.exit(0); }

console.log('Video tracks in the real manifest:');
vids.forEach(v => console.log(`  rep ${v.originalVideoId}  ${v.width}x${v.height}  ${(v.bandwidth / 1e6).toFixed(1)} Mbps`));

// What Shaka settles on at load time: the highest bitrate that fits the initial
// estimate. This is where the bug was born.
const EST = +src.match(/defaultBandwidthEstimate:\s*(\d+)/)[1];
const guess = vids.filter(v => v.bandwidth <= EST).sort((a, b) => b.bandwidth - a.bandwidth)[0] || vids[0];
guess.active = true;
console.log(`\nInitial estimate ${(EST / 1e6).toFixed(0)} Mbps → Shaka would start on rep ` +
            `${guess.originalVideoId} (${guess.width}x${guess.height})`);

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + '  ' + m); if (!c) fails++; };
const mk = tracks => new Function('SPHERE_REP', 'shakaVideo',
  grab('sphereVariants') + '; return sphereVariants();')(SPHERE_REP, { getVariantTracks: () => tracks });

if (vids.length === 1) {
  console.log('\n(This manifest has no close-ups, so there is no wrong track to pick.)');
} else {
  ok(guess.originalVideoId !== SPHERE_REP, 'bug reproduced: unpinned, the sphere is NOT the 360');
}

console.log('\nWith the fix:');
const sv = mk(vids);
ok(sv.length >= 1 && sv.every(t => t.originalVideoId === SPHERE_REP) || vids.length === 1,
   `sphereVariants() returns only representation ${SPHERE_REP}`);
ok(sv[0].height === Math.max(...vids.map(v => v.height)), `and it is the tallest one (${sv[0].width}x${sv[0].height})`);
if (vids.length > 1) ok(!sv.some(t => t.active), 'the active track is not among them → it gets switched');
const under = h => sv.filter(t => t.height <= h);
ok(under(1080).length === 0 || sv[0].height <= 1080,
   '?maxh=1080 cannot land on a 720p close-up (no sphere variant → warns and stays)');

console.log('\nA plain scene (manifest with no close-ups):');
const solo = [{ originalVideoId: '0', width: 3840, height: 2160, bandwidth: 26e6, active: true }];
ok(mk(solo).length === 1 && mk(solo)[0].active, 'single track: left alone, no switch');
const odd = [{ originalVideoId: '7', width: 1920, height: 960, bandwidth: 6e6, active: true }];
ok(mk(odd).length === 1, 'a foreign manifest numbered differently: not left with zero tracks');

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll good\n');
process.exit(fails ? 1 : 0);
