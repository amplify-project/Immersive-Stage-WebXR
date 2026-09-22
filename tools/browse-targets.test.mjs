// The "Browse…" buttons: what they offer and what they leave behind.
//
// The functions are lifted OUT OF editor.html by text, not reimplemented here,
// so this cannot quietly drift from what ships. The DOM is a fake where every id
// exists and remembers value/innerHTML, and fetch is a stub, so no server and no
// browser are involved.
//
//   node tools/browse-targets.test.mjs
//
// See README → Editor workflow.
import fs from 'fs';

const EDITOR = process.argv[2] || new URL('../editor.html', import.meta.url);
const html = fs.readFileSync(EDITOR, 'utf8');
// The editor's own code is the INLINE script. Taking the first <script> of any
// kind broke the day the mesh viewer put three.js and GLTFLoader above it.
const js = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)[1];

const grab = name => {
  const plain = js.indexOf(`function ${name}(`), asyn = js.indexOf(`async function ${name}(`);
  const at = asyn >= 0 && (plain < 0 || asyn < plain) ? asyn : plain;
  if (at < 0) throw new Error('cannot find ' + name);
  let d = 0;
  for (let k = js.indexOf('{', at); k < js.length; k++) {
    if (js[k] === '{') d++; else if (js[k] === '}' && --d === 0) return js.slice(at, k + 1);
  }
};
const slice = (from, to) => { const i = js.indexOf(from); return js.slice(i, js.indexOf(to, i)); };
const table = js.slice(js.indexOf('const BROWSE = {'), js.indexOf('\n};', js.indexOf('const BROWSE = {')) + 3);

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + '  ' + m); if (!c) fails++; };

// ── 1. Every button names a target, every target has a button ───────────────
console.log('\n1) Wiring');
const declared = [...table.matchAll(/^\s{2}(\w+):\s*\{ kind: '(\w+)'/gm)].map(m => [m[1], m[2]]);
const used = [...html.matchAll(/openBrowser\('(\w+)'/g)].map(m => m[1]);
const EXPECT = { video: 'video', bed: 'audio', stem: 'audio', proxy: 'video', closeup: 'video' };
ok(used.every(u => declared.some(([n]) => n === u)), 'every button names a declared target');
ok(declared.every(([n]) => used.includes(n)), 'no declared target is left without a button');
ok(declared.length === Object.keys(EXPECT).length, `${declared.length} targets: ${declared.map(d => d[0]).join(', ')}`);
for (const [n, k] of declared) ok(k === EXPECT[n], `${n} browses ${k}`);
ok(/event\.stopPropagation\(\);openBrowser\('closeup',\$\{i\}\)/.test(html),
   'the close-up button carries the stem index and does not select the row underneath');

// ── 2. The listing: right kind only, and names that cannot break out ────────
console.log('\n2) Listing');
const fns  = slice('const brEsc =', 'const brSize =');
const body = slice('const vids = (d.files', '\n  list.innerHTML');
const build = new Function('d', 'brTarget', 'brSize', `${fns}\n${body}\n  return rows;`);
const listing = {
  dirs:  [{ name: 'Takes', path: '/srv/Takes' }],
  files: [{ name: 'a<b> & c\'d".mp4', path: '/srv/a<b> & c\'d".mp4', kind: 'video', size: 1 },
          { name: 'clean.mp4', path: '/srv/clean.mp4', kind: 'video', size: 2 },
          { name: 'bed.wav',   path: '/srv/bed.wav',   kind: 'audio', size: 3 }],
};
const nameOf = r => r.match(/<span class="nm">([\s\S]*?)<\/span>/)[1];
const decode = t => t.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const argOf  = r => eval('(' + decode(r.match(/onclick="(?:importFile|browseTo)\((.*)\)"/)[1] + ')'));
for (const kind of ['video', 'audio']) {
  const rows = build(listing, { kind }, b => b + ' B');
  const files = rows.slice(listing.dirs.length);
  const want = listing.files.filter(f => f.kind === kind);
  ok(files.length === want.length, `browsing for ${kind}: ${files.length} file(s), the ${kind} ones`);
  ok(files.every((r, i) => argOf(r) === want[i].path), `every ${kind} path survives attribute + JS string`);
  ok(rows.every(r => !/[<>]/.test(nameOf(r))), 'no raw angle bracket inside a name');
}
ok(build(listing, { kind: 'video' }, () => '').length === 3, 'folders are listed whatever the kind');

// ── 3. What each target leaves behind, through the real buildSelectors ──────
console.log('\n3) Outcome per target');
const els = {};
const $ = id => (els[id] ||= { value: '', innerHTML: '', textContent: '', style: {} });
let imported = 'media/arrived.mp4';
const MEDIA = () => ([
  { file: 'media/video.mp4', name: 'video.mp4', kind: 'video' },
  { file: 'media/bed.wav',   name: 'bed.wav',   kind: 'audio', channels: 4 },
  { file: 'media/gt.wav',    name: 'gt.wav',    kind: 'audio', channels: 1 },
  { file: imported, name: imported.split('/')[1],
    kind: imported.endsWith('.wav') ? 'audio' : 'video', channels: 1 },
]);
const fetchStub = async url => ({ json: async () => url.startsWith('/api/media/import')
  ? { ok: true, file: imported, name: imported.split('/')[1], size: 1, copied: true }
  : { media: MEDIA() } });

let scene, media, redraws;
const mk = () => {
  scene = { video: 'media/video.mp4', bed: 'media/bed.wav', bedFormat: 'fuma',
            stems: [{ file: 'media/gt.wav', name: 'GT' }] };
  media = MEDIA(); redraws = 0;
  for (const k of Object.keys(els)) delete els[k];
  const src = `
    let scene = getScene(), media = getMedia();
    let brTarget = null, brArgv = null, brBusy = false;
    ${table}
    ${grab('importFile')}
    ${grab('buildSelectors')}
    ${grab('addStemFile')}
    return { importFile, set: (t, a) => { brTarget = BROWSE[t]; brArgv = a; } };`;
  return new Function('$', 'fetch', 'toast', 'closeBrowser', 'browseTo', 'renderStems',
                      'drawRadar', 'drawViews', 'syncSelPanel', 'selected', 'getScene', 'getMedia', 'setMedia', src)
    ($, fetchStub, () => {}, () => {}, () => {}, () => redraws++, () => {}, () => {}, () => {}, -1,
     () => scene, () => media, m => media = m);
};

const NEWV = 'media/arrived.mp4', NEWA = 'media/arrived.wav';
let P;
imported = NEWV; P = mk(); P.set('video');   await P.importFile('/anywhere/arrived.mp4');
ok(scene.video === NEWV && $('video').value === NEWV, 'video    → scene.video and the dropdown');
imported = NEWA; P = mk(); P.set('bed');     await P.importFile('/anywhere/arrived.wav');
ok(scene.bed === NEWA && $('bed').value === NEWA, 'bed      → scene.bed and the dropdown');
imported = NEWA; P = mk(); P.set('stem');    await P.importFile('/anywhere/arrived.wav');
ok(scene.stems.length === 2 && scene.stems[1].file === NEWA, 'stem     → appended to scene.stems');
ok(scene.stems[1].name === 'ARRIVED', `         named from the file (${scene.stems[1].name})`);
imported = NEWV; P = mk(); P.set('closeup', 0); await P.importFile('/anywhere/arrived.mp4');
ok(scene.stems[0].closeup === NEWV && redraws > 0, 'closeup  → the stem, and its row redrawn');
imported = NEWV; P = mk(); P.set('proxy');   await P.importFile('/anywhere/arrived.mp4');
// buildSelectors() resets proxySrc to scene.video on every run, so a target that
// writes it BEFORE the rebuild silently overwrites itself. That shipped once.
ok($('proxySrc').value === NEWV, 'proxy    → proxySrc, and it is not clobbered by the rebuild');
ok(scene.video === 'media/video.mp4', '         and the 360 is left alone');

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll good\n');
process.exit(fails ? 1 : 0);
