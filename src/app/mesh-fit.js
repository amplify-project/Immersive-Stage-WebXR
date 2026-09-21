/* ═══════════════════════════════════════════════════════════════════════════
 *  Musician meshes: loading, fitting, and the light they are seen under.
 *  Shared by the player and the editor.
 *
 *  A classic script (window.MeshFit), not an ES module, on purpose. The player
 *  is ESM but already takes THREE and GLTFLoader as globals from index.html,
 *  and the editor is one inline <script> in a single page. A module here would
 *  buy a build step, or a second copy of the fit — and a second copy is exactly
 *  what this file exists to prevent: the editor's 3D preview is only worth
 *  building if it places the model the way the headset will. "It looked fine in
 *  the editor" is the one failure this feature cannot have.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var AR_MESH_HEIGHT   = 1.7;   // height every mesh is normalised to (m)
  var AR_MESH_MAX_SPAN = 3;     // widest footprint allowed, in multiples of that height

  // ── Loading ───────────────────────────────────────────────────────────────
  // GLTFLoader is a vendored r128, the same version as the CDN three.min.js:
  // mixing versions breaks in the worst place, inside the headset.
  var _loader = null;
  var _cache  = new Map();      // url -> Promise<Object3D> (the original, uncloned)

  function loadMeshOnce(url) {
    if (_cache.has(url)) return _cache.get(url);
    var p = new Promise(function (resolve, reject) {
      if (typeof THREE === 'undefined' || typeof THREE.GLTFLoader !== 'function')
        return reject(new Error('GLTFLoader not loaded (check the <script> tags)'));
      _loader = _loader || new THREE.GLTFLoader();
      _loader.load(url, function (g) {
        // The clips arrive parsed in the same file and used to be dropped on
        // this line. They hang on the scene object — three's own convention for
        // exactly this — so load() still resolves one Object3D and nothing
        // downstream has to change shape.
        g.scene.animations = g.animations || [];
        resolve(g.scene);
      }, undefined, reject);
    });
    _cache.set(url, p);
    return p;
  }

  // Every musician gets a CLONE: several can share one file (the common
  // `ar.mesh`), and each needs nodes of its own for the mixer to drive.
  //
  // A plain clone(true) is wrong the moment the model is skinned. The copy keeps
  // a REFERENCE to the source's skeleton while its bones are new objects, so it
  // ends up driven by bones nobody animates: it renders in bind pose, or folds
  // toward the origin. SkeletonUtils.clone rebuilds the binding against the
  // cloned bones. Note this bites a skinned model used ONCE — the clone happens
  // either way — and it bites inside the headset while the editor's preview,
  // which holds the only instance, looks perfectly fine.
  function cloneMesh(src) {
    var skinned = false;
    src.traverse(function (o) { if (o.isSkinnedMesh) skinned = true; });

    var out;
    if (skinned && THREE.SkeletonUtils && typeof THREE.SkeletonUtils.clone === 'function') {
      out = THREE.SkeletonUtils.clone(src);
    } else {
      if (skinned) console.warn('[mesh] skinned model cloned without SkeletonUtils — ' +
                                'it will not animate (check the <script> tag)');
      out = src.clone(true);
    }
    // clone() carries no arbitrary property, and a clip is read-only data: every
    // instance shares the same clips and each mixer binds them to its own root
    // by node name.
    out.animations = src.animations || [];
    return out;
  }

  // Which clip, out of what the file happens to carry. Named in scene.json
  // because a GLB may hold several and "the first one" is not a decision.
  function pickClip(clips, want) {
    if (!clips || !clips.length) return null;
    if (want == null || want === '') return clips[0];
    if (typeof want === 'number') return clips[want] || null;
    for (var i = 0; i < clips.length; i++) if (clips[i].name === want) return clips[i];
    console.warn('[mesh] no clip named "' + want + '"; the file has: ' +
                 clips.map(function (c) { return '"' + c.name + '"'; }).join(', '));
    return null;
  }

  // Meshes get replaced under the same name while a scene is being tuned, and
  // this in-page cache would keep serving the old one — which in the editor
  // means uploading a fix and seeing the file you just replaced.
  function invalidate(url) {
    if (url) _cache.delete(url); else _cache.clear();
  }

  // ── The spec ──────────────────────────────────────────────────────────────
  // In scene.json a `mesh` is the bare string while nothing else is needed, and
  // an object as soon as height, yaw or the axis correction is touched. Both
  // sides read it through here so neither has to know that.
  function spec(cfg) {
    var m = (typeof cfg === 'string') ? { url: cfg } : (cfg || {});
    return {
      url:     m.url || '',
      heightM: isFinite(+m.heightM) && +m.heightM > 0 ? +m.heightM : AR_MESH_HEIGHT,
      yawDeg:  isFinite(+m.yawDeg) ? +m.yawDeg : 0,
      zUp:     !!m.zUp,
      // Animation. `clip` is a name or an index, null meaning "the first one";
      // `animOffset` is the media time at which the clip's own zero falls, which
      // is how a loop gets put on the beat; `animate:false` freezes a model that
      // moves when this scene would rather it did not.
      clip:       (typeof m.clip === 'string' && m.clip) ? m.clip
                  : (isFinite(+m.clip) && m.clip !== '' && m.clip != null ? +m.clip : null),
      animOffset: isFinite(+m.animOffset) ? +m.animOffset : 0,
      animate:    m.animate !== false,
    };
  }

  // ── The fit ───────────────────────────────────────────────────────────────
  // Normalises whatever arrives: the model is scaled to `heightM`, centred in
  // plan, stood on the floor and turned to `yawDeg`.
  //
  // Without this, anyone's first mesh shows up 100× too big or invisibly small,
  // because a GLB does not declare its units and every tool exports in its own.
  // Scaling by the bounding box makes a model in centimetres and one in metres
  // end up equally tall with nothing to configure.
  //
  // Returns a WRAPPER group holding `obj`, and never touches obj's own
  // transform: a GLB may carry one on its root node, and overwriting it (rather
  // than composing with it) would silently undo part of the file.
  //
  // Three nodes, because one Object3D applies scale, then rotation, then
  // translation — and the order this needs is rotate to Y-up, recentre, scale,
  // then yaw:
  //
  //     wrap   scale = k, rotation.y = yaw      ← spins in place
  //      └ axis  rotation.x = zUp, position = −centre
  //         └ obj  the model, exactly as the file has it
  function fitMeshToRoom(obj, opts) {
    var o = spec(opts || {});
    var name = (opts && opts.name) || o.url || 'mesh';
    var info = { raw: null, scale: 1, heightM: o.heightM, spanM: 0, warnings: [] };

    var wrap = new THREE.Group(); wrap.name = 'meshFit';
    var axis = new THREE.Group(); axis.name = 'meshAxis';
    axis.add(obj);
    wrap.add(axis);

    // The axis correction goes on FIRST, before measuring: on a Z-up export the
    // height is along Z, so measuring first would scale by the wrong dimension
    // and the model would come out lying down AND the wrong size.
    if (o.zUp) axis.rotation.x = -Math.PI / 2;

    // Pose it at the clip's own zero BEFORE measuring. A model exported in a
    // T-pose whose clip is a seated drummer would otherwise be normalised
    // against a height nobody ever sees, and stood on a floor its feet never
    // touch. The mixer is thrown away — the pose it wrote stays — and the caller
    // builds its own on the same nodes.
    var clip = o.animate ? pickClip(obj.animations, o.clip) : null;
    if (clip) {
      var poser = new THREE.AnimationMixer(obj);
      poser.clipAction(clip).play();
      poser.setTime(0);
    }

    axis.updateMatrixWorld(true);

    // Measured through matrixWorld, so `wrap` must not be parented yet — a
    // parent's transform would be measured as part of the model.
    var box  = new THREE.Box3().setFromObject(axis);
    var size = box.getSize(new THREE.Vector3());
    info.raw = { x: size.x, y: size.y, z: size.z };

    var k = (size.y > 1e-4 && isFinite(size.y)) ? o.heightM / size.y : 0;
    if (k <= 0 || !isFinite(k)) {
      // Unmeasurable box: empty geometry, compressed without its decoder, a node
      // with no mesh inside. Scaling by it would give an absurd factor, and a
      // model in centimetres left unscaled is 170 METRES of black wall in front
      // of your face — which inside the headset does not read as "a bad mesh",
      // it reads as "passthrough is broken". When in doubt, leave it alone.
      info.warnings.push('could not measure it (box ' + size.x.toFixed(2) + '×' +
                         size.y.toFixed(2) + '×' + size.z.toFixed(2) + ') → left unscaled');
      k = 1;
    }

    // And now the footprint, which is what actually protects the view.
    // Normalising the height ALONE lets impossible proportions through: a
    // 45×1.7×30 slab keeps scale 1 — its height was already right — and shows up
    // as a 45 m wall two steps from your face. That is not a hypothesis; it is
    // what the first test figure did.
    //
    // The limit is loose, not tight: a drum kit is legitimately wider than it is
    // tall, and the point is not to impose a human silhouette but that nothing
    // can black out the room.
    var span = Math.max(size.x, size.z) * k;
    var maxSpan = AR_MESH_MAX_SPAN * o.heightM;
    if (span > maxSpan) {
      info.warnings.push(span.toFixed(1) + ' m wide for ' + o.heightM.toFixed(2) +
                         ' m tall — impossible proportions, shrunk to ' + maxSpan.toFixed(1) + ' m');
      k *= maxSpan / span;
      span = maxSpan;
    }

    var c = box.getCenter(new THREE.Vector3());
    axis.position.set(-c.x, -box.min.y, -c.z);   // centred in plan, feet on the floor
    wrap.scale.setScalar(k);
    wrap.rotation.y = o.yawDeg * Math.PI / 180;

    info.scale = k;
    info.spanM = span;
    info.heightM = size.y * k;                   // what it actually ended up being
    info.clip = clip ? (clip.name || '(unnamed)') : null;
    info.clipSecs = clip ? clip.duration : 0;
    wrap.userData.fit = info;
    wrap.userData.anim = clip ? { clip: clip, offset: o.animOffset } : null;
    for (var i = 0; i < info.warnings.length; i++)
      console.warn('[mesh] "' + name + '": ' + info.warnings[i]);
    return wrap;
  }


  // ── Colour ────────────────────────────────────────────────────────────────
  // three lights the scene in linear light and then has to write a frame for a
  // display that speaks sRGB. `outputEncoding` is that last step, and r128
  // defaults to LinearEncoding: the linear number goes out raw and the panel
  // reads it as sRGB, so mid grey (0.5 linear, which should be written as 0.73)
  // arrives as 0.21. Everything looks dark and flat, and a GLB looks nothing
  // like it did in Blender — GLTFLoader marks colour textures as sRGB, so the
  // model is decoded on the way in and never encoded on the way out.
  //
  // The catch is that this is a RENDERER-wide switch. A texture that already
  // holds sRGB pixels and does not say so gets encoded without ever having been
  // decoded: the 360 video would turn milky, blacks and all. srgb() is how a
  // texture says so, and decode + encode then cancel out.
  //
  // Same for a colour written as a hex literal, which is a colour picked in
  // sRGB: colour() puts it in the linear space the shader works in. (r152 and
  // later do all of this by themselves — hence every tutorial that does not
  // mention it.)
  function setupRenderer(r) {
    if (r && THREE.sRGBEncoding !== undefined) r.outputEncoding = THREE.sRGBEncoding;
    return r;
  }

  function srgb(tex) {
    if (tex && THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function colour(hex) {
    var c = new THREE.Color(hex);
    return c.convertSRGBToLinear ? c.convertSRGBToLinear() : c;
  }

  // ── Environment ───────────────────────────────────────────────────────────
  // A metallic/roughness material has almost no diffuse response: nearly all of
  // what you see is reflection. With nothing to reflect it renders BLACK however
  // many lights are in the scene — which is why the lit drums came out fine and
  // the trumpet came out a silhouette. Lights do not fix a metal; an environment
  // does.
  //
  // It is painted here instead of shipped as an .hdr: a studio gradient with
  // three soft lamps is enough to read metal as metal, it costs no download onto
  // a headset on someone else's wifi, and it leaves no asset to keep next to the
  // scene. A venue that wants its own room can point at a real map later; this
  // is the floor, not the ceiling.
  //
  // In AR we are guessing, and worth being honest about it: the real room's
  // light is not known to us, so a reflection is plausible rather than true.
  //
  // One PMREM per renderer, cached. Call it OUTSIDE an XR session — the player
  // warms it when the scene declares meshes, before anyone enters AR — because
  // rendering to an off-screen target mid-session means arguing with the XR
  // framebuffer for nothing.
  var ENV_W = 512, ENV_H = 256;

  function envLamp(cx, x, y, r, a) {
    var g = cx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,' + a + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = g;
    cx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }

  function paintEnvironment(cx) {
    var g = cx.createLinearGradient(0, 0, 0, ENV_H);
    g.addColorStop(0.00, '#e9eff6');   // zenith
    g.addColorStop(0.46, '#a8b5c2');
    g.addColorStop(0.50, '#6c7681');   // horizon: the floor starts darker
    g.addColorStop(1.00, '#20242a');   // nadir
    cx.fillStyle = g;
    cx.fillRect(0, 0, ENV_W, ENV_H);
    // Three lamps above the horizon, none of them centred. A bare gradient is
    // reflected as a gradient — smooth, even, and unreadable as metal. What says
    // "polished" is a highlight with an edge, and the fact that it travels when
    // you move your head.
    envLamp(cx, 0.17 * ENV_W, 0.24 * ENV_H, 0.14 * ENV_W, 1.00);
    envLamp(cx, 0.55 * ENV_W, 0.16 * ENV_H, 0.09 * ENV_W, 0.85);
    envLamp(cx, 0.84 * ENV_W, 0.33 * ENV_H, 0.12 * ENV_W, 0.60);
  }

  var _env = new WeakMap();          // renderer -> PMREM texture (or null)

  function environment(renderer) {
    if (!renderer) return null;
    if (_env.has(renderer)) return _env.get(renderer);
    var tex = null;
    try {
      var c = document.createElement('canvas');
      c.width = ENV_W; c.height = ENV_H;
      paintEnvironment(c.getContext('2d'));
      var src = new THREE.CanvasTexture(c);
      src.mapping = THREE.EquirectangularReflectionMapping;
      srgb(src);
      var pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      tex = pmrem.fromEquirectangular(src).texture;
      pmrem.dispose();
      src.dispose();
    } catch (e) {
      // Without an environment a metal is black; without a player there is
      // nothing at all. This is not worth taking the session down for.
      console.warn('[mesh] no environment: ' + ((e && e.message) || e));
      tex = null;
    }
    _env.set(renderer, tex);
    return tex;
  }

  // ── The animation clock ───────────────────────────────────────────────────
  // Driven by MEDIA TIME, never by a frame delta, and that is the whole design.
  // This player has ONE media element: the multichannel audio hangs off it
  // through Web Audio and the close-up video is already slaved to its
  // currentTime. A mixer told that same number follows a seek, a pause, and the
  // playback-rate nudges the Motion controller makes for a late joiner — for
  // free, with nothing synchronised twice. A free-running mixer.update(dt)
  // drifts against the music from the first bar, and the drift is exactly what
  // anyone watching one musician is looking at.
  //
  // setTime() resets its actions to zero and re-advances, so a BACKWARDS seek
  // costs the same as a forward one and needs no special case; the looping is
  // the action's own. Absolute time also means no error accumulates and there
  // is nothing to resynchronise after a stall.
  function animator(wrap) {
    var a = wrap && wrap.userData && wrap.userData.anim;
    if (!a || !a.clip) return null;
    var mixer = new THREE.AnimationMixer(wrap);
    mixer.clipAction(a.clip).play();
    var offset = a.offset || 0;
    return {
      mixer: mixer,
      name: a.clip.name || '(unnamed)',
      duration: a.clip.duration || 0,
      offset: offset,
      // Before the offset the model simply holds its first frame: a musician
      // who starts playing at 0:12 stands still until then, which is what the
      // offset is for in the first place.
      setMediaTime: function (t) {
        var s = (t || 0) - offset;
        mixer.setTime(s > 0 ? s : 0);
      },
      dispose: function () { mixer.stopAllAction(); mixer.uncacheRoot(wrap); },
    };
  }

  global.MeshFit = {
    AR_MESH_HEIGHT: AR_MESH_HEIGHT,
    AR_MESH_MAX_SPAN: AR_MESH_MAX_SPAN,
    load: loadMeshOnce,
    invalidate: invalidate,
    spec: spec,
    fit: fitMeshToRoom,
    clone: cloneMesh,
    animator: animator,
    setupRenderer: setupRenderer,
    environment: environment,
    srgb: srgb,
    colour: colour,
  };
})(window);
