// three r186 as ES modules, republished as the global `THREE` that the classic
// scripts (mesh-fit.js, the editor's inline script) and xr-input.js expect.
// The module namespace is frozen, hence the copy: GLTFLoader and SkeletonUtils
// are hung on it the way the r128 UMD builds used to.
// Must be the first <script type="module"> of the page.
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

window.THREE = Object.assign({}, T, { GLTFLoader, SkeletonUtils });
window.dispatchEvent(new Event('three-ready'));
