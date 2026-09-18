/* ═══════════════════════════════════════════════════════════════════════════
 *  Playback synchronised across devices, through a Timing Object.
 *
 *  The problem is the partner's: a session manager on a desktop presses play and
 *  every headset in the room plays the same instant of the concert, including
 *  the one that joins five minutes late.
 *
 *  Written against the W3C Timing Object rather than as commands of our own. A
 *  control page owns a vector — position P at time T, running at rate R — and
 *  every client works out where it should be from that. Late joining, pause and
 *  restart are then not features, they are the same vector read at a different
 *  moment. The implementation is Motion (src/vendor/motion), ours, LGPL.
 *
 *  The convergence logic is not written here either: a client that finds itself
 *  300 ms behind must not seek — the picture would jump every time it drifts —
 *  it nudges the playback rate, seeks only on a gross error and leaves itself
 *  alone for a moment afterwards. TimingMediaController does all of that. What
 *  we do supply is its tuning, because its defaults are for video and this is
 *  music; the numbers and the measurement behind them are below.
 *
 *  It attaches to ONE element, the <video>, and that is the whole trick of it
 *  here: the multichannel audio hangs off that same element through Web Audio
 *  (createMediaElementSource), and the close-up element is already slaved to its
 *  currentTime. So a rate nudge carries sound and close-up with it, and there is
 *  no second thing to keep in step.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { TimingObject } from '../vendor/motion/TimingObject.js';
import { SocketTimingProvider } from '../vendor/motion/SocketTimingProvider.js';
import { TimingMediaController } from '../vendor/motion/TimingMediaController.js';

// The timing service, mounted on the page's own server (telemetry/timing.js).
// Same origin, same port, same certificate the headset already accepted to load
// the player: an https:// page cannot open a cleartext ws://, and a service on
// its own port would mean accepting a second self-signed certificate — a failure
// that shows up as nothing at all.
//
// It is still not our relay. Motion brings its own clock and its own channel,
// and tying the playback clock to the telemetry path would buy nothing.
// ?timing=<url> points somewhere else, e.g. a real motion-server.
export const TIMING_PATH = '/timing';

function timingUrl(override) {
  if (override) return override;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${TIMING_PATH}`;
}

/**
 * Slave a media element to a shared timing object.
 *
 * @param {HTMLMediaElement} el       the element that owns the timeline (our <video>)
 * @param {object}   opt
 * @param {string}   opt.sessionId    which timing object on the service (its "timerId")
 * @param {string}  [opt.url]         timing service URL
 * @param {number}  [opt.offsetSec]   per-device correction, seconds. A device known to
 *                                    run late gets a positive number. Not the same thing
 *                                    as the engine's output delay, which shifts audio
 *                                    against video *inside* this element.
 * @param {number}  [opt.duration]    media duration, passed to the service as the range
 * @returns {{timing: object, controller: object, close: function}}
 */
export function attachSync(el, { sessionId, url, offsetSec = 0, duration } = {}) {
  if (!el) throw new Error('attachSync: no media element');
  const clientId = 'player-' + Math.random().toString(36).slice(2, 10);
  const service = timingUrl(url);
  const dur = Number.isFinite(duration) ? duration
            : (Number.isFinite(el.duration) ? el.duration : 0);

  const provider = new SocketTimingProvider(service, sessionId, dur, clientId);
  const timing = new TimingObject();
  timing.srcObject = provider;

  // Convergence, tuned for music rather than for video. Every number below was
  // measured on two machines on 2026-09-18; see docs/motion-sync.md.
  //
  // Out of the box the controller holds the error under 40 ms by closing
  // whatever gap it finds within one second — measured here, that means the rate
  // sitting at 0.955 or 1.043 and flipping between the two every couple of
  // seconds. For a talking head nobody would notice. On a sustained chord ±4.3%
  // is about ±0.7 of a semitone, wobbling: the one artefact this player cannot
  // ship.
  //
  // The correction is proportional: the rate it asks for is 1 + diff /
  // amortPeriod, recomputed ten times a second. So minDiff / amortPeriod — the
  // 0.6% this used to advertise — is only its *smallest* step, the one it takes
  // at the edge of the dead band. Its largest is maxDelay / amortPeriod, and
  // that is the one a late joiner hears, because it arrives right after the seek
  // that leaves half a second to close: 0.8/8 = 10%, over a semitone and a half.
  // Hence maxRateDev, which caps the whole thing at something inaudible and pays
  // for it in seconds rather than in pitch.
  //
  // In the steady state none of that is reached. Two machines held 16 ms apart,
  // at a rate pinned at 1.0063: inside the dead band the controller does not
  // restore the rate to 1, so the error drifts slowly across the band and gets
  // nudged back at the far edge. A cycle of ±50 ms at 0.6%, inaudible, and far
  // inside what the ear resolves for placement (~5-10° off-axis, 40 cm at 3 m).
  //
  // blindPeriod and seekLead are what make a late joiner bearable, and both are
  // ours (the library is in src/vendor/motion). The blind spell used to be
  // amortPeriod × 2 — asking for a smoother correction bought a longer spell of
  // no correction, so at 8 s it went blind for SIXTEEN, and each seek re-armed
  // it: measured, joining late cost ~40 s at 0.4-0.95 s behind. seekLead is the
  // other half: a seek flushes the buffer and fetches a fresh 6 s segment while
  // the session clock runs on, so seeking to the position you just read lands
  // late by however long that took, every time. Aim ahead by the cost instead —
  // 0.5 s is the opening guess, and the controller re-measures it per element.
  const controller = new TimingMediaController(timing, {
    minDiff: 0.05,       // dead band: below this, leave the rate alone
    amortPeriod: 8.0,    // gain: the rate asks for 1 + diff/8
    maxDelay: 0.8,       // above this, stop nudging and seek
    blindPeriod: 1.5,    // how long a seek is given to settle, uncoupled from the gain
    maxRateDev: 0.015,   // ±1.5%, about a quarter of a semitone
    seekLead: 0.5,       // opening guess at what a seek costs; measured thereafter
  });
  // Ojo con las unidades: addMediaElement divide entre 1000, o sea que espera
  // MILISEGUNDOS pese a llamarse offset y a que todo lo demás va en segundos.
  controller.addMediaElement(el, offsetSec * 1000);

  // ── Watchdog: the controller can be asleep ──────────────────────────────
  //
  // TimingObject only starts its `timeupdate` heartbeat inside its change
  // listener, and the heartbeat is the only thing that drives the media
  // controller. A client that joins a session that already exists is told about
  // it with `info`, not with `change` — so nobody starts the heartbeat, the
  // controller never runs, and our player, which autoplays as soon as it has
  // loaded, plays happily against a clock that is stopped. That is not a corner
  // case: it is what every late joiner sees, which is the whole feature.
  //
  // This only rescues the case where the controller is demonstrably not doing
  // its job — the session is parked and we are playing anyway. It deliberately
  // does NOT try to start playback or chase the position when the session is
  // running: there the controller does wake up (a running session sends changes)
  // and two things steering one element is worse than either.
  //
  // The real fix belongs in the library: start the heartbeat whenever the vector
  // has velocity, however it arrived, rather than only on a change event.
  const WATCHDOG_MS = 1000;
  const watchdog = setInterval(() => {
    if (timing.readyState !== 'open') return;
    let v; try { v = timing.query(); } catch (_) { return; }
    if (v.velocity === 0 && !el.paused) {
      console.warn(`[sync] the session is parked at ${v.position.toFixed(2)}s and we were playing — pausing`);
      el.pause();
      // Land where the session is, not where we happened to get to.
      if (Math.abs(el.currentTime + offsetSec - v.position) > 0.05)
        el.currentTime = Math.max(0, v.position - offsetSec);
    }
  }, WATCHDOG_MS);

  // Deliberately loud while this is a spike: the failure we expect is the socket
  // never opening (wrong port, cleartext from an https page, a firewall), and
  // that failure is otherwise completely silent — the video just plays on its
  // own and looks fine until you put two of them side by side.
  timing.addEventListener('readystatechange', (e) => {
    console.log(`[sync] timing ${e.value || timing.readyState} · ${service} · session ${sessionId}`);
  });
  console.log(`[sync] connecting to ${service} as ${clientId} (session ${sessionId}, offset ${offsetSec}s)`);

  // Diagnosis from the console, and from the headset over the telemetry log:
  // where the vector says we should be, where we actually are, and the error.
  const diag = () => {
    const v = timing.query();
    const want = v.position, have = el.currentTime + offsetSec;
    const lead = controller.getSeekLead(el);
    return { state: timing.readyState, want: +want.toFixed(3), have: +have.toFixed(3),
             errMs: Math.round((have - want) * 1000), rate: el.playbackRate,
             velocity: v.velocity, paused: el.paused,
             leadMs: lead === null ? null : Math.round(lead * 1000) };
  };
  window.syncDiag = diag;

  return {
    timing, controller, diag,
    close() {
      clearInterval(watchdog);
      try { provider.close(); } catch (_) { /* already gone */ }
    },
  };
}
