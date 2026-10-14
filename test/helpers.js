import { Engine } from '../src/core/engine.js';
import { createJob } from '../src/core/util.js';
import { CELL_MM } from '../src/core/voxelize.js';

export async function run(shape, scanOpts = {}, cleanParams = {}, buildParams = {}) {
  const eng = new Engine();
  eng.loadDemo(shape, scanOpts);
  const clean = await eng.runClean(cleanParams, createJob());
  const model = await eng.runBuild({ scaleMode: 'longest', value: 24, ...buildParams }, createJob());
  return { eng, clean, model };
}

/**
 * Volume IoU between the final outer shell and the analytic shape (the "CAD" reference), voxelised at the same
 * resolution with 3x3x3 sub-samples per cell. Only valid for yaw 0 / Y-up scans.
 */
export function iouAgainstSDF(eng, clean, model, sdf, ideal = false) {
  const [nx, ny, nz] = model.dims;
  const k = model.scale.k;
  const toSrc = [CELL_MM.x / (k * clean.mmPerUnit), CELL_MM.y / (k * clean.mmPerUnit), CELL_MM.z / (k * clean.mmPerUnit)];
  const S = 3;
  // rotateY(deg): x' = x cos + z sin, z' = -x sin + z cos. Inverse uses -deg.
  const r = (-clean.yaw * Math.PI) / 180;
  const cosY = Math.cos(r), sinY = Math.sin(r);
  const inv = { x: (x, z) => x * cosY + z * sinY, z: (x, z) => -x * sinY + z * cosY };
  let inter = 0, uni = 0;
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    let inside = 0;
    for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) for (let c = 0; c < S; c++) {
      const ax = clean.origin[0] + (x + (a + 0.5) / S) * toSrc[0];
      const py = clean.origin[1] + (y + (b + 0.5) / S) * toSrc[1];
      const az = clean.origin[2] + (z + (c + 0.5) / S) * toSrc[2];
      // undo the yaw the cleaner applied (rotateY(+yaw)) to get back into the shape's own frame
      if (sdf(inv.x(ax, az), py, inv.z(ax, az)) < 0) inside++;
    }
    const ref = inside / (S * S * S);
    const mine = ideal ? (ref >= 0.5 ? 1 : 0) : model.outer[(y * nz + z) * nx + x];
    inter += Math.min(ref, mine);
    uni += Math.max(ref, mine);
  }
  return inter / uni;
}
