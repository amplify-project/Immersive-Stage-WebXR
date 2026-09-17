/* ═══════════════════════════════════════════════════════════════════════════
 *  Musician meshes: loading and fitting. Shared by the player and the editor.
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
      _loader.load(url, function (g) { resolve(g.scene); }, undefined, reject);
    });
    _cache.set(url, p);
    return p;
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
    wrap.userData.fit = info;
    for (var i = 0; i < info.warnings.length; i++)
      console.warn('[mesh] "' + name + '": ' + info.warnings[i]);
    return wrap;
  }

  global.MeshFit = {
    AR_MESH_HEIGHT: AR_MESH_HEIGHT,
    AR_MESH_MAX_SPAN: AR_MESH_MAX_SPAN,
    load: loadMeshOnce,
    invalidate: invalidate,
    spec: spec,
    fit: fitMeshToRoom,
  };
})(window);
