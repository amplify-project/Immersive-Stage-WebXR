// live-monitor.js (browser) — the editor's soundcheck monitor.
//
// Opens /monitor (live-monitor.js on the server), which captures the desk with
// the live channel patch and streams raw PCM: 4 FOA channels + one per musician.
// The PCM goes through a small AudioWorklet buffer into the PLAYER'S OWN audio
// engine, so what comes out of the headphones is the audience's mix: the bed
// decoded binaurally and every musician spatialized at their azimuth, with
// their Gain dB. Nothing is encoded and nothing is published.
//
// Three ways to listen:
//   · audience       — looking straight ahead, no zoom: what a viewer hears at rest
//   · spotlight(i)   — turned towards musician i with full zoom: what a viewer
//                      hears when they zoom in on that musician
//   · pfl(ch)        — one raw channel, mono, in both ears (pre-fader listen):
//                      to check a single input on its own, before any processing
//
//   const mon = await startLiveMonitor({ scene, onMeters, onStatus });
//   mon.spotlight(2); mon.setStemGainDb(2, 3.5); mon.pfl(4); mon.audience(); mon.stop();

const RATE = 48000;
const D2R = Math.PI / 180;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
}

// Head turned by `yawDeg` (scene.json convention: azimuth of the musician),
// as THREE.Matrix4.elements, column-major. −Z of the result points at the
// musician, which is how the engine reads "where the listener looks".
function yawMatrix(azDeg) {
  const a = azDeg * D2R, c = Math.cos(a), s = Math.sin(a);
  return [c, 0, -s, 0,  0, 1, 0, 0,  s, 0, c, 0,  0, 0, 0, 1];
}

/**
 * @param {object} o
 * @param {object} o.scene        the editor's in-memory scene (unsaved edits count)
 * @param {(m:object)=>void} [o.onMeters]  {peak[], rms[], fillMs, underruns, skips, priming}
 * @param {(s:object)=>void} [o.onStatus]  {type:'start'|'error'|'closed', …}
 */
export async function startLiveMonitor({ scene, onMeters = () => {}, onStatus = () => {} }) {
  const A = (scene.live && scene.live.audio) || {};
  const foa = A.foa || {};
  const stems = scene.stems || [];
  const nch = 4 + stems.length;

  // The engine's renderer. Without Omnitone it falls back to the HOAST path,
  // which needs two more global libraries the editor does not load.
  if (typeof Omnitone === 'undefined') await loadScript('./src/vendor/omnitone.min.js');
  const { ImmersiveAudioEngine } = await import('../audio/ImmersiveAudioEngine.js');

  const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('./src/audio/pcm-stream-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm-stream', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [nch],
    processorOptions: { channels: nch },
  });
  node.port.onmessage = e => onMeters(e.data);

  const engine = new ImmersiveAudioEngine({
    order: 1, renderer: 'omnitone', audioContext: ctx, channelMap: 'identity',
    stems: stems.map((s, i) => ({ azimuthDeg: +s.azimuthDeg || 0, elevationDeg: +s.elevationDeg || 0,
                                  name: s.name || 'stem' + i, gainDb: +s.gainDb || 0 })),
  });
  await engine.attach(node);
  // Same spotlight as the player: zoomMin = the view at rest (factor 1 here).
  const zoomMin = 1;
  const spot = { zoomMin, ...(scene.spotlight || {}) };
  if (stems.length) engine.setSpotlightParams(spot);
  if (scene.sources) engine.setSourceParams(scene.sources);
  const al = scene.alignment || {};
  engine.setAlignment({ yawOffsetDeg: +al.yawOffsetDeg || 0, mirror: !!al.mirror });

  // PFL path: raw channel → mono → both ears, alongside the engine.
  const split = ctx.createChannelSplitter(nch);
  node.connect(split);
  const pflGain = ctx.createGain();
  pflGain.gain.value = 0;
  pflGain.connect(ctx.destination);
  let pflCh = -1;

  let volume = 1;
  const look = az => { engine.setRotationFromMatrix4(yawMatrix(az)); };
  const setMode = (m) => { mode = m; };
  let mode = 'audience';

  const api = {
    ctx, engine, channels: nch,
    get mode() { return mode; },
    get pflChannel() { return pflCh; },
    audience() {
      api._pflOff(); engine.setVolume(volume);
      look(0); engine.setZoomByFactor(zoomMin); setMode('audience');
    },
    spotlight(i) {
      const s = stems[i]; if (!s) return;
      api._pflOff(); engine.setVolume(volume);
      look(+s.azimuthDeg || 0);
      engine.setZoomByFactor(engine.getSpotlightParams().zoomMax);
      setMode('spotlight:' + i);
    },
    pfl(ch) {
      if (!(ch >= 0 && ch < nch)) return;
      api._pflOff();
      split.connect(pflGain, ch, 0);
      pflCh = ch;
      pflGain.gain.value = volume;
      engine.setVolume(0);
      setMode('pfl:' + ch);
    },
    _pflOff() {
      if (pflCh >= 0) { try { split.disconnect(pflGain, pflCh, 0); } catch (_) {} }
      pflCh = -1; pflGain.gain.value = 0;
    },
    setStemGainDb(i, dB) { if (stems[i]) engine.setStemGainDb(i, +dB || 0); },
    setVolume(v) {
      volume = Math.max(0, +v || 0);
      if (pflCh >= 0) pflGain.gain.value = volume; else engine.setVolume(volume);
    },
    latencyMs() { return ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000; },
    stop() {
      closing = true;
      try { ws.close(); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
      ctx.close().catch(() => {});
    },
  };

  // — The socket: patch first, then binary PCM straight into the worklet —
  let closing = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/monitor`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({
    device: A.device || '', channels: +A.channels || 32,
    foaCh: Array.isArray(foa.ch) && foa.ch.length === 4 ? foa.ch.map(Number) : [0, 1, 2, 3],
    aformat: !!foa.aformat, format: scene.bedFormat || 'fuma',
    stemCh: stems.map(s => (Number.isInteger(s.channel) ? s.channel : null)),
  }));
  ws.onmessage = e => {
    if (typeof e.data === 'string') {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      onStatus(m);
      return;
    }
    node.port.postMessage(e.data, [e.data]);
  };
  ws.onclose = () => { if (!closing) onStatus({ type: 'closed' }); api.stop(); };

  if (ctx.state === 'suspended') await ctx.resume();
  api.audience();
  return api;
}
