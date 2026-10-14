// USDZ / USD / GLB / GLTF import through three.js. Only geometry is used; textures and colours are ignored.

import { LoadingManager } from 'three';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Scans carry big textures we never need: answer every image request with a 1x1 pixel.
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
function manager() {
  const m = new LoadingManager();
  m.setURLModifier((url) => (/^blob:|^data:image|\.(png|jpe?g|webp|avif|ktx2?)(\?|$)/i.test(url) ? PIXEL : url));
  return m;
}

/** Merge every mesh / point set below `root` into one world-space geometry. */
function collect(root) {
  root.updateMatrixWorld(true);
  const chunks = [];
  let verts = 0, tris = 0, pointsOnly = true;
  root.traverse((o) => {
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;
    if (o.isMesh) pointsOnly = false;
    if (!o.isMesh && !o.isPoints) return;
    chunks.push(o);
    verts += g.attributes.position.count;
    if (o.isMesh) tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });
  if (!chunks.length) throw new Error('No geometry found in this file.');
  const positions = new Float32Array(verts * 3);
  const indices = pointsOnly ? null : new Uint32Array(tris * 3);
  let vo = 0, io = 0;
  const e = new Float32Array(16);
  for (const o of chunks) {
    const pos = o.geometry.attributes.position;
    o.matrixWorld.toArray(e);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      positions[(vo + i) * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      positions[(vo + i) * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      positions[(vo + i) * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    if (o.isMesh && indices) {
      const idx = o.geometry.index;
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i++) indices[io++] = vo + (idx ? idx.getX(i) : i);
    }
    vo += pos.count;
  }
  return { positions, indices, format: 'three' };
}

export async function parseWithThree(ext, buffer) {
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new Promise((resolve, reject) => new GLTFLoader(manager()).parse(buffer, '', resolve, reject));
    return collect(gltf.scene);
  }
  // USD family: USDZ archive, USDC (binary), USDA (text)
  const group = new USDLoader(manager()).parse(buffer);
  return collect(group);
}
