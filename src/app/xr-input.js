/* ═══════════════════════════════════════════════════════════════════════════
 *  Ray and pinch: the hands-free input of the XR player (Pilot 3, T2).
 *
 *  Look at a musician and pinch (either hand, or a controller's trigger): in VR
 *  it zooms in on them, in AR it pins them and shows their close-up video
 *  beside them. Pinch with the ray on nothing to undo (zoom back out / unpin). Hold the pinch on nothing to open the menu
 *  (switch VR ↔ AR, leave). It is the Quest's own system interaction —the home
 *  menu works the same way— so there is nothing new to learn.
 *
 *  AIM. By default it is the HEAD: the viewer pose's forward axis, the
 *  look-and-pinch of the Vision Pro. Nothing is drawn while you look at nothing
 *  —a fixed reticle in the middle of the view was tried and felt wrong— only a
 *  glow ON the musician you are looking at (snapped to them, so it does not
 *  shake with the head), plus the hold ring and the flash while you pinch.
 *  With aim 'hand' (?aim=hand) each hand has its own visible ray instead:
 *
 *  Both halves come from the browser, nothing is recognised here:
 *    - the RAY is the input source's `targetRaySpace`, which for a tracked
 *      hand is the system's filtered shoulder-through-hand ray (steady at stage
 *      distance, unlike the finger's own axis), and for a controller is the
 *      controller's pointing direction;
 *    - the PINCH is the session's `selectstart`/`selectend`, which the Quest
 *      fires for index-thumb on a hand and for the trigger on a controller.
 *  So hands and controllers go through one code path.
 *
 *  What a pinch selects is decided when it STARTS, not when it ends: closing
 *  the fingers drags the ray a little, and confirming wherever it ends up
 *  picks the neighbour of the musician you meant.
 *
 *  Cost per frame: one getPose() per input source, one cone test against the
 *  musicians, and a handful of uniforms and transforms. Nothing is allocated
 *  and no geometry is re-uploaded: the beam is a fixed unit cylinder that is
 *  only moved and stretched, and every effect is a uniform in its shader.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* global THREE, MeshFit */

// A pinch up to TAP_MAX_MS is a tap. Held on nothing for HOLD_MS it opens the
// menu, with a ring filling up around the cursor in between so the hold is
// something you watch happen and not a delay you have to guess. Held on a
// musician it does nothing yet: that is where grabbing (moving musicians, the
// close-up panel) will go.
const TAP_MAX_MS = 450;
const HOLD_MS    = 700;

const OFF_PANEL  = -2;               // menu hit: the ray is not on the panel at all
export const RAY_CONE = { coneDeg: 8 };   // half-angle around the ray that counts as "on" a musician
const RAY_LEN_M  = 2.0;              // drawn length when not ending on something in the room
const BEAM_R0    = 0.004;            // beam radius at the hand (m)
const BEAM_R1    = 0.0012;           // ...and at the tip
const CURSOR_M   = 0.07;             // glow size at the end of the ray
const HEAD_CURSOR_M = 3.0;           // head aim: distance the glow is drawn at on a 360 musician
const BURST_MS   = 350;              // the flash when a pinch lands

const C_IDLE = 0xbfe9ff, C_TARGET = 0x00d4ff, C_PRESSED = 0xffd24a;

// ── Shaders ─────────────────────────────────────────────────────────────────
// Additive and without depth writes: light added on top of whatever is behind,
// which reads as a beam and not as a stick, over the video and over the room.

const BEAM_VS = `
varying float vT;
void main() {
  vT = uv.y;   // 0 at the hand, 1 at the tip (CylinderGeometry's v runs bottom→top)
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const BEAM_FS = `
uniform vec3 uColor;
uniform float uTime, uGain;
varying float vT;
void main() {
  float body  = pow(1.0 - vT, 1.6);                         // bright at the hand, gone at the tip
  float pulse = smoothstep(0.12, 0.0, abs(vT - fract(uTime * 0.9))) * 0.8;   // a pulse running out
  gl_FragColor = vec4(uColor * (body * 0.9 + pulse * (1.0 - vT)) * uGain, 1.0);
}`;

// Ring around the cursor: `uFill` (0..1) of it is drawn, clockwise from the top,
// for the hold progress; `uFill` = 1 and a growing scale make the burst.
const RING_VS = `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const RING_FS = `
uniform vec3 uColor;
uniform float uFill, uAlpha;
varying vec2 vP;
void main() {
  float a = atan(vP.x, vP.y);                    // 0 at the top, clockwise
  if (a < 0.0) a += 6.2831853;
  if (a > uFill * 6.2831853) discard;
  gl_FragColor = vec4(uColor * uAlpha, 1.0);
}`;

function additive(shader, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms, vertexShader: shader[0], fragmentShader: shader[1],
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

// Soft round glow for the cursor, drawn once into a canvas.
let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}

const _Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();

class Ray {
  constructor(scene, colours) {
    this.colours = colours;
    // Unit cylinder from y=0 (hand) to y=1 (tip), tapered; open-ended.
    const geo = new THREE.CylinderGeometry(BEAM_R1, BEAM_R0, 1, 10, 1, true);
    geo.translate(0, 0.5, 0);
    this.beamU = { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uGain: { value: 1 } };
    this.beam = new THREE.Mesh(geo, additive([BEAM_VS, BEAM_FS], this.beamU));

    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending }));

    const ringGeo = new THREE.RingGeometry(0.75, 1, 40);
    this.holdU  = { uColor: { value: new THREE.Color() }, uFill: { value: 0 }, uAlpha: { value: 1 } };
    this.hold   = new THREE.Mesh(ringGeo, additive([RING_VS, RING_FS], this.holdU));
    this.burstU = { uColor: { value: new THREE.Color() }, uFill: { value: 1 }, uAlpha: { value: 0 } };
    this.burst  = new THREE.Mesh(ringGeo, additive([RING_VS, RING_FS], this.burstU));

    for (const o of [this.beam, this.glow, this.hold, this.burst]) {
      o.renderOrder = 1001;
      o.frustumCulled = false;   // moved every frame; never mind the bounds
      o.visible = false;
      scene.add(o);
    }
    this.source = null;
    this.target = -1;            // musician under the ray, or -1
    this.menuHit = OFF_PANEL;    // menu button under the ray; -1 panel, no button
    this.burstAt = -1e9;
  }

  hide() {
    this.source = null; this.target = -1; this.menuHit = OFF_PANEL;
    this.beam.visible = this.glow.visible = this.hold.visible = this.burst.visible = false;
  }

  /** Place and paint. `o`/`d` the ray; `len` where it ends; `t` seconds.
   *  `beam`/`glow` false leave that part out (head aim draws no beam, and its
   *  glow only when it is on something). */
  draw(o, d, len, state, holdFill, now, beam = true, glow = true) {
    const c = this.colours[state];               // 0 idle, 1 on something, 2 pressed

    this.beam.position.set(o[0], o[1], o[2]);
    this.beam.quaternion.setFromUnitVectors(_Y, _v.set(d[0], d[1], d[2]));
    this.beam.scale.set(1, len, 1);
    this.beamU.uColor.value.copy(c);
    this.beamU.uTime.value = now / 1000;
    this.beamU.uGain.value = state === 0 ? 0.55 : 1;

    const ex = o[0] + d[0] * len, ey = o[1] + d[1] * len, ez = o[2] + d[2] * len;
    // Constant size on the retina: the cursor is as readable on a musician 8 m
    // away as on a button at arm's length.
    const k = Math.max(0.6, len) / 1.5;
    const pulse = state === 1 ? 1 + 0.18 * Math.sin(now / 110) : state === 2 ? 0.7 : 0.8;
    this.glow.position.set(ex, ey, ez);
    this.glow.scale.setScalar(CURSOR_M * k * pulse);
    this.glow.material.color.copy(c);

    // The rings face back along the ray, i.e. towards the user.
    for (const ring of [this.hold, this.burst]) {
      ring.position.set(ex, ey, ez);
      ring.quaternion.copy(this.beam.quaternion);
      ring.rotateX(Math.PI / 2);
    }
    this.hold.visible = holdFill > 0;
    if (holdFill > 0) {
      this.hold.scale.setScalar(CURSOR_M * 0.55 * k);
      this.holdU.uColor.value.copy(this.colours[2]);
      this.holdU.uFill.value = holdFill;
    }
    const b = (now - this.burstAt) / BURST_MS;
    this.burst.visible = b >= 0 && b < 1;
    if (this.burst.visible) {
      this.burst.scale.setScalar(CURSOR_M * k * (0.4 + 1.4 * b));
      this.burstU.uColor.value.copy(this.colours[2]);
      this.burstU.uAlpha.value = 1 - b;
    }

    this.beam.visible = beam;
    this.glow.visible = glow;
  }
}

export class RayPointer {
  /**
   * @param {THREE.Scene} scene
   * @param {object} o
   * @param {(origin:number[], dir:number[], cone:object) => number} o.pick  stem along a ray, or -1
   * @param {(i:number) => ?number[]} o.targetPos  world position of a stem that is a point of the room (AR), else null
   * @param {(target:number, source:XRInputSource) => void} o.onTap  pinch tap; target -1 = nothing
   * @param {(source:XRInputSource) => void} [o.onHold]  long pinch on nothing
   * @param {XRMenu} [o.menu]  while open, it takes the ray before the musicians do
   * @param {boolean} [o.hidden]  run everything but draw nothing (perf experiment)
   * @param {'head'|'hand'} [o.aim]  what aims: the head (default) or each hand's ray
   * @param {(i:number, origin:number[]) => ?number[]} [o.targetDir]  head aim: unit
   *   direction from `origin` to musician `i` when targetPos has no point for it
   *   (a musician of the 360), so the glow sits on them and not on the gaze
   * @param {object} [o.grab]  long pinch ON a musician grabs it, if grab.can(i):
   *   start(i, src) once, move(i, origin, dir, src) every frame while held
   *   (the arrays are reused: copy what you keep), end(i, src) on release.
   */
  constructor(scene, { pick, targetPos, onTap, onHold, menu, grab = null, hidden = false,
                       aim = 'head', targetDir = null }) {
    this._hidden = hidden;
    this._aim = aim === 'hand' ? 'hand' : 'head';
    this._targetDir = targetDir || (() => null);
    this._cd = [0, 0, 0];
    this._grab = grab;
    this._pick = pick;
    this._targetPos = targetPos;
    this._onTap = onTap;
    this._onHold = onHold || (() => {});
    this._menu = menu || null;
    this._origin = [0, 0, 0];
    this._dir = [0, 0, 0];
    const colours = [C_IDLE, C_TARGET, C_PRESSED].map(c => MeshFit.colour(c));
    this._session = null;
    this._down = new Map();      // XRInputSource → { t, target, menuHit, held }
    this._rays = { left: new Ray(scene, colours), right: new Ray(scene, colours), none: new Ray(scene, colours),
                   head: new Ray(scene, colours) };

    this._start = e => {
      const r = this._rayOf(e.inputSource);
      this._down.set(e.inputSource, { t: performance.now(), held: false,
                                      target: r ? r.target : -1, menuHit: r ? r.menuHit : OFF_PANEL });
    };
    this._end = e => {
      const d = this._down.get(e.inputSource);
      this._down.delete(e.inputSource);
      if (d && d.grab) { this._grab.end(d.target, e.inputSource); return; }
      if (!d || d.held || performance.now() - d.t > TAP_MAX_MS) return;
      const r = this._rayOf(e.inputSource);
      if (r) r.burstAt = performance.now();
      if (this._menu && this._menu.open) this._menu.tap(d.menuHit);   // off the panel closes it
      else this._onTap(d.target, e.inputSource);
    };
  }

  attach(session) {
    this.detach();
    this._session = session;
    session.addEventListener('selectstart', this._start);
    session.addEventListener('selectend', this._end);
  }

  detach() {
    if (this._session) {
      this._session.removeEventListener('selectstart', this._start);
      this._session.removeEventListener('selectend', this._end);
      this._session = null;
    }
    // A grab still held when the session ends is released, so it is saved.
    for (const [src, d] of this._down) if (d.grab) this._grab.end(d.target, src);
    this._down.clear();
    for (const k in this._rays) this._rays[k].hide();
  }

  /** The musician the main ray is on (for preloading its close-up), or -1. */
  get hovered() {
    if (this._aim === 'head') return this._rays.head.source ? this._rays.head.target : -1;
    const r = this._rays.right.source ? this._rays.right : this._rays.left;
    return r.source ? r.target : -1;
  }

  /** One frame: place each ray, find what it is on, run the hold timer. */
  update(frame, refSpace) {
    const now = performance.now();
    for (const k in this._rays) this._rays[k].source = null;
    const menuOpen = !!(this._menu && this._menu.open);
    let menuHover = -1;

    if (this._aim === 'head') menuHover = this._updateHead(frame, refSpace, now, menuOpen);
    else for (const src of frame.session.inputSources) {
      // 'gaze' sources (a headset button, no hand) have no ray worth drawing:
      // it would come out from between your eyes.
      if (src.targetRayMode !== 'tracked-pointer') continue;
      const r = this._rays[src.handedness] || this._rays.none;
      const pose = frame.getPose(src.targetRaySpace, refSpace);
      if (!pose) continue;
      r.source = src;

      const p = pose.transform.position, m = pose.transform.matrix;
      const o = this._origin, d = this._dir;
      o[0] = p.x; o[1] = p.y; o[2] = p.z;
      d[0] = -m[8]; d[1] = -m[9]; d[2] = -m[10];          // −Z of the ray space

      let len = RAY_LEN_M;
      r.menuHit = OFF_PANEL; r.target = -1;
      if (menuOpen) {
        const hit = this._menu.hit(o, d);
        if (hit) { r.menuHit = hit.button; len = hit.dist; if (hit.button >= 0) menuHover = hit.button; }
      } else {
        r.target = this._pick(o, d, RAY_CONE);
        const at = r.target >= 0 ? this._targetPos(r.target) : null;
        if (at) len = Math.max(0.05, Math.hypot(at[0] - o[0], at[1] - o[1], at[2] - o[2]) - 0.15);
      }

      const press = this._down.get(src);
      let holdFill = 0;
      if (press && press.grab) {
        // Holding a musician: the ray stays on them while it drags them.
        r.target = press.target;
        this._grab.move(press.target, o, d, src);
      } else if (press && !press.held && !menuOpen && press.target < 0) {
        // On nothing: the menu.
        const held = now - press.t;
        if (held > TAP_MAX_MS) holdFill = Math.min(1, (held - TAP_MAX_MS) / (HOLD_MS - TAP_MAX_MS));
        if (held >= HOLD_MS) { press.held = true; r.burstAt = now; this._onHold(src); }
      } else if (press && !press.held && !menuOpen && press.target >= 0 && this._grab && this._grab.can(press.target)) {
        // On a musician, where grabbing is enabled: pick it up.
        const held = now - press.t;
        if (held > TAP_MAX_MS) holdFill = Math.min(1, (held - TAP_MAX_MS) / (HOLD_MS - TAP_MAX_MS));
        if (held >= HOLD_MS) { press.held = press.grab = true; r.burstAt = now; this._grab.start(press.target, src); }
      }
      const on = r.target >= 0 || r.menuHit >= 0;
      if (!this._hidden) r.draw(o, d, len, press ? 2 : on ? 1 : 0, holdFill, now);
    }
    for (const k in this._rays) if (!this._rays[k].source) this._rays[k].hide();
    if (menuOpen) this._menu.setHover(menuHover);
  }

  /** Head aim: one ray from the viewer pose; any pinch confirms what it is on. */
  _updateHead(frame, refSpace, now, menuOpen) {
    const r = this._rays.head;
    const vp = frame.getViewerPose(refSpace);
    if (!vp) return -1;
    r.source = 'head';
    const p = vp.transform.position, m = vp.transform.matrix;
    const o = this._origin, d = this._dir;
    o[0] = p.x; o[1] = p.y; o[2] = p.z;
    d[0] = -m[8]; d[1] = -m[9]; d[2] = -m[10];

    let len = RAY_LEN_M, menuHover = -1;
    r.menuHit = OFF_PANEL; r.target = -1;
    if (menuOpen) {
      const hit = this._menu.hit(o, d);
      if (hit) { r.menuHit = hit.button; len = hit.dist; if (hit.button >= 0) menuHover = hit.button; }
    } else {
      r.target = this._pick(o, d, RAY_CONE);
    }

    // Whichever hand is pinching drives the hold and the grab.
    let press = null, psrc = null;
    for (const [s, pr] of this._down) { press = pr; psrc = s; break; }
    let holdFill = 0;
    if (press && press.grab) {
      r.target = press.target;
      this._grab.move(press.target, o, d, psrc);
    } else if (press && !press.held && !menuOpen && press.target < 0) {
      const held = now - press.t;
      if (held > TAP_MAX_MS) holdFill = Math.min(1, (held - TAP_MAX_MS) / (HOLD_MS - TAP_MAX_MS));
      if (held >= HOLD_MS) { press.held = true; r.burstAt = now; this._onHold(psrc); }
    } else if (press && !press.held && !menuOpen && press.target >= 0 && this._grab && this._grab.can(press.target)) {
      const held = now - press.t;
      if (held > TAP_MAX_MS) holdFill = Math.min(1, (held - TAP_MAX_MS) / (HOLD_MS - TAP_MAX_MS));
      if (held >= HOLD_MS) { press.held = press.grab = true; r.burstAt = now; this._grab.start(press.target, psrc); }
    }

    // The glow goes ON the musician, not where the head points: inside the
    // cone the gaze wanders, the musician does not.
    let cd = d;
    if (!menuOpen && r.target >= 0) {
      const at = this._targetPos(r.target);
      const c = this._cd;
      if (at) {
        const dist = Math.hypot(at[0] - o[0], at[1] - o[1], at[2] - o[2]) || 1;
        c[0] = (at[0] - o[0]) / dist; c[1] = (at[1] - o[1]) / dist; c[2] = (at[2] - o[2]) / dist;
        cd = c; len = Math.max(0.05, dist - 0.15);
      } else {
        const td = this._targetDir(r.target, o);
        if (td) { c[0] = td[0]; c[1] = td[1]; c[2] = td[2]; cd = c; len = HEAD_CURSOR_M; }
      }
    }
    const on = r.target >= 0 || r.menuHit !== OFF_PANEL;
    if (!this._hidden) r.draw(o, cd, len, press ? 2 : on ? 1 : 0, holdFill, now, false, on || !!press);
    return menuHover;
  }

  _rayOf(src) {
    if (this._aim === 'head') return this._rays.head.source ? this._rays.head : null;
    for (const k in this._rays) if (this._rays[k].source === src) return this._rays[k];
    return null;
  }
}

// ── Menu ────────────────────────────────────────────────────────────────────
// A floating panel of buttons, opened by a long pinch and placed in front of
// you where you are looking at that moment. It stays put in the world (it does
// not follow the head), which is what lets you aim at it. Pinch a button to
// choose; pinch anywhere off the panel to close it.
//
// Drawn into a canvas, redrawn only when what it shows changes (hover, items,
// status line) — not per frame.
const MENU_W = 0.56, MENU_PX = 1024;       // metres wide; canvas px wide
const MENU_DIST = 0.9, MENU_DROP = 0.12;   // in front of the head, a bit below eye level
const ROW_PX = 120, PAD_PX = 40, TITLE_PX = 110;

export class XRMenu {
  /**
   * @param {THREE.Scene} scene
   * @param {(id:string) => void} onChoose
   */
  constructor(scene, onChoose) {
    this._onChoose = onChoose;
    this._items = [];          // { id, label, active, disabled }
    this._hover = -1;
    this._status = '';
    this._canvas = document.createElement('canvas');
    this._canvas.width = MENU_PX;
    this._tex = MeshFit.srgb(new THREE.CanvasTexture(this._canvas));
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this._tex, transparent: true, depthTest: false, depthWrite: false }));
    this.mesh.renderOrder = 1000;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._inv = new THREE.Matrix4();
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._n = new THREE.Vector3();
  }

  get open() { return this.mesh.visible; }

  /** Show `items` in front of the head. `pose` is the viewer XRPose. */
  show(items, pose, status = '') {
    this._items = items;
    this._hover = -1;
    this._status = status;
    const p = pose.transform.position, q = pose.transform.orientation;
    // Facing you, upright: only the head's yaw, so looking down to open it
    // does not leave the panel lying on the floor.
    const fwd = this._d.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    this.mesh.position.set(p.x + fwd.x * MENU_DIST, p.y - MENU_DROP, p.z + fwd.z * MENU_DIST);
    this.mesh.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
    this._draw();
    this.mesh.updateMatrixWorld(true);
    this._inv.copy(this.mesh.matrixWorld).invert();
    this.mesh.visible = true;
  }

  close() { this.mesh.visible = false; this._hover = -1; }

  setStatus(text) { if (text !== this._status) { this._status = text; if (this.open) this._draw(); } }

  setHover(i) { if (i !== this._hover) { this._hover = i; this._draw(); } }

  /**
   * Ray against the panel, in world space (the plane is scaled non-uniformly,
   * so distances in its local space are not metres).
   * @returns {?{button:number, dist:number}} button -1 = on the panel but on no
   *          button; null = the ray misses the panel
   */
  hit(o, d) {
    if (!this.open) return null;
    const n = this._n.set(0, 0, 1).applyQuaternion(this.mesh.quaternion);
    const den = d[0] * n.x + d[1] * n.y + d[2] * n.z;
    if (Math.abs(den) < 1e-6) return null;
    const P = this.mesh.position;
    const t = ((P.x - o[0]) * n.x + (P.y - o[1]) * n.y + (P.z - o[2]) * n.z) / den;
    if (t <= 0) return null;
    const local = this._o.set(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t).applyMatrix4(this._inv);
    if (Math.abs(local.x) > 0.5 || Math.abs(local.y) > 0.5) return null;
    const py = (0.5 - local.y) * this._canvas.height;
    const row = Math.floor((py - TITLE_PX) / ROW_PX);
    const button = row >= 0 && row < this._items.length && !this._items[row].disabled ? row : -1;
    return { button, dist: t };
  }

  /** A pinch while open: choose the button; off the panel (-2) closes it. */
  tap(button) {
    if (button === OFF_PANEL) { this.close(); return; }
    const it = this._items[button];
    if (it && !it.disabled) this._onChoose(it.id);
  }

  _draw() {
    const n = this._items.length;
    const H = TITLE_PX + n * ROW_PX + (this._status ? 70 : 20) + PAD_PX / 2;
    const c = this._canvas;
    if (c.height !== H) c.height = H;
    const g = c.getContext('2d');
    g.clearRect(0, 0, MENU_PX, H);

    g.fillStyle = 'rgba(8,14,22,0.88)';
    roundRect(g, 4, 4, MENU_PX - 8, H - 8, 36); g.fill();
    g.strokeStyle = 'rgba(0,212,255,0.65)'; g.lineWidth = 4;
    roundRect(g, 4, 4, MENU_PX - 8, H - 8, 36); g.stroke();

    g.fillStyle = '#00d4ff';
    g.font = 'bold 48px sans-serif';
    g.textBaseline = 'middle';
    g.fillText('AMPLIFY', PAD_PX + 10, TITLE_PX / 2 + 6);

    this._items.forEach((it, i) => {
      const y = TITLE_PX + i * ROW_PX;
      const hover = i === this._hover;
      g.fillStyle = it.disabled ? 'rgba(255,255,255,0.04)'
                  : hover ? 'rgba(0,212,255,0.35)' : it.active ? 'rgba(255,210,74,0.16)' : 'rgba(255,255,255,0.08)';
      roundRect(g, PAD_PX, y + 10, MENU_PX - 2 * PAD_PX, ROW_PX - 20, 24); g.fill();
      if (it.active) {
        g.strokeStyle = 'rgba(255,210,74,0.8)'; g.lineWidth = 3;
        roundRect(g, PAD_PX, y + 10, MENU_PX - 2 * PAD_PX, ROW_PX - 20, 24); g.stroke();
      }
      g.fillStyle = it.disabled ? 'rgba(230,237,243,0.35)' : '#e6edf3';
      g.font = `${hover ? 'bold ' : ''}46px sans-serif`;
      g.fillText(it.label, PAD_PX + 36, y + ROW_PX / 2);
      if (it.note) {
        g.font = '32px sans-serif';
        g.fillStyle = it.active ? '#ffd24a' : 'rgba(230,237,243,0.55)';
        const w = g.measureText(it.note).width;
        g.fillText(it.note, MENU_PX - PAD_PX - 36 - w, y + ROW_PX / 2);
      }
    });
    if (this._status) {
      g.font = '32px sans-serif';
      g.fillStyle = '#ffb4a2';
      g.fillText(this._status, PAD_PX + 10, TITLE_PX + n * ROW_PX + 40);
    }

    // The plane is 1×1; scale it to the canvas aspect at MENU_W metres wide.
    this.mesh.scale.set(MENU_W, MENU_W * H / MENU_PX, 1);
    if (this.open) { this.mesh.updateMatrixWorld(true); this._inv.copy(this.mesh.matrixWorld).invert(); }
    this._tex.needsUpdate = true;
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
