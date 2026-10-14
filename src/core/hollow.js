// Hollowing: remove interior voxels that can never be seen, keeping a shell of `thickness` cells and a lattice of
// small support pillars so roofs over cavities stay connected to the walls and floor.

function erodeBox(src, nx, ny, nz, rx, ry, rz) {
  // separable box erosion with running counts; outside the grid counts as empty
  let cur = src;
  const run = (axis, r) => {
    if (r <= 0) return;
    const out = new Uint8Array(cur.length);
    const len = axis === 0 ? nx : axis === 1 ? ny : nz;
    const stride = axis === 0 ? 1 : axis === 1 ? nx * nz : nx;
    const pref = new Int32Array(len + 1);
    const full = 2 * r + 1;
    const dimA = axis === 0 ? nz : nx, dimB = axis === 0 ? ny : axis === 1 ? nz : ny;
    for (let b = 0; b < dimB; b++) for (let a = 0; a < dimA; a++) {
      const base = axis === 0 ? a * nx + b * nx * nz : axis === 1 ? a + b * nx : a + b * nx * nz;
      for (let i = 0; i < len; i++) pref[i + 1] = pref[i] + (cur[base + i * stride] ? 1 : 0);
      for (let i = 0; i < len; i++) {
        const lo = i - r, hi = i + r;
        out[base + i * stride] = lo >= 0 && hi < len && pref[hi + 1] - pref[lo] === full ? 1 : 0;
      }
    }
    cur = out;
  };
  run(0, rx); run(2, rz); run(1, ry);
  return cur;
}

/**
 * @returns { solid, removed }  new solid mask with the interior removed
 */
export function hollowSolid(solid, dims, thickness, pillarSpacing = 6) {
  const [nx, ny, nz] = dims;
  if (!(thickness > 0)) return { solid: Uint8Array.from(solid), removed: 0 };
  const deep = erodeBox(solid, nx, ny, nz, thickness, thickness, thickness);
  const out = Uint8Array.from(solid);
  let removed = 0;
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const c = (y * nz + z) * nx + x;
    if (!deep[c]) continue;
    // 2x2 pillars on a lattice keep the roof attached
    if (pillarSpacing >= 3 && (x % pillarSpacing) < 2 && (z % pillarSpacing) < 2) continue;
    out[c] = 0;
    removed++;
  }
  return { solid: out, removed };
}
