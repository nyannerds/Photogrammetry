// Voxelisation with solid fill.
//
// The scan is rasterised into a super-sampled grid (SS³ fine cells per brick cell), holes are sealed with a
// morphological closing, the exterior is flood-filled from outside (a virtual ground slab stops the flood
// entering through the open underside left by floor removal), and the result is down-sampled to brick cells.
// Brick cell size is 8 × 9.6 × 8 mm (stud pitch × brick height × stud pitch).

export const CELL_MM = { x: 8, y: 9.6, z: 8 };

/** Triangle / unit-box overlap (separating axis theorem). T holds precomputed triangle data. */
function triBoxOverlap(T, bx, by, bz) {
  const v0x = T[0] - bx, v0y = T[1] - by, v0z = T[2] - bz;
  const v1x = T[3] - bx, v1y = T[4] - by, v1z = T[5] - bz;
  const v2x = T[6] - bx, v2y = T[7] - by, v2z = T[8] - bz;
  // plane test
  const nx = T[18], ny = T[19], nz = T[20];
  const rn = 0.5 * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz)) + 1e-9;
  const dn = nx * v0x + ny * v0y + nz * v0z;
  if (dn > rn || dn < -rn) return false;
  // nine edge × axis tests
  for (let e = 0; e < 3; e++) {
    const ex = T[9 + e * 3], ey = T[10 + e * 3], ez = T[11 + e * 3];
    let p0, p1, p2, r, mn, mx;
    // axis = e × X = (0, ez, -ey)
    p0 = v0y * ez - v0z * ey; p1 = v1y * ez - v1z * ey; p2 = v2y * ez - v2z * ey;
    r = 0.5 * (Math.abs(ez) + Math.abs(ey)) + 1e-9;
    mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
    if (mn > r || mx < -r) return false;
    // axis = e × Y = (-ez, 0, ex)
    p0 = -v0x * ez + v0z * ex; p1 = -v1x * ez + v1z * ex; p2 = -v2x * ez + v2z * ex;
    r = 0.5 * (Math.abs(ez) + Math.abs(ex)) + 1e-9;
    mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
    if (mn > r || mx < -r) return false;
    // axis = e × Z = (ey, -ex, 0)
    p0 = v0x * ey - v0y * ex; p1 = v1x * ey - v1y * ex; p2 = v2x * ey - v2y * ex;
    r = 0.5 * (Math.abs(ey) + Math.abs(ex)) + 1e-9;
    mn = Math.min(p0, p1, p2); mx = Math.max(p0, p1, p2);
    if (mn > r || mx < -r) return false;
  }
  return true;
}

/** Conservative surface voxelisation of a triangle mesh into grid A (dims DX,DY,DZ; index x + DX*(z + DZ*y)). */
async function rasterizeMesh(A, DX, DY, DZ, pos, idx, map, job, near) {
  const { sx, sy, sz, ox, oy, oz } = map;
  const tris = idx.length / 3;
  const T = new Float64Array(21);
  const syStride = DX * DZ;
  for (let t = 0; t < tris; t++) {
    if ((t & 0x3fff) === 0 && job) await job.tick();
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ax = pos[a] * sx + ox, ay = pos[a + 1] * sy + oy, az = pos[a + 2] * sz + oz;
    const bx = pos[b] * sx + ox, by = pos[b + 1] * sy + oy, bz = pos[b + 2] * sz + oz;
    const cx = pos[c] * sx + ox, cy = pos[c + 1] * sy + oy, cz = pos[c + 2] * sz + oz;
    let x0 = Math.floor(Math.min(ax, bx, cx)), x1 = Math.floor(Math.max(ax, bx, cx));
    let y0 = Math.floor(Math.min(ay, by, cy)), y1 = Math.floor(Math.max(ay, by, cy));
    let z0 = Math.floor(Math.min(az, bz, cz)), z1 = Math.floor(Math.max(az, bz, cz));
    if (x1 < 0 || y1 < 0 || z1 < 0 || x0 >= DX || y0 >= DY || z0 >= DZ) continue;
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (z0 < 0) z0 = 0;
    if (x1 >= DX) x1 = DX - 1; if (y1 >= DY) y1 = DY - 1; if (z1 >= DZ) z1 = DZ - 1;
    const triNx = (by - ay) * (cz - bz) - (bz - az) * (cy - by);
    const triNy = (bz - az) * (cx - bx) - (bx - ax) * (cz - bz);
    const triNz = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    const triLen = Math.hypot(triNx, triNy, triNz);
    // remember, per cell, the triangle plane that passes closest to the cell centre
    const note = (cell, x, y, z) => {
      if (!near || triLen < 1e-12) return;
      const d = Math.abs((triNx * (x + 0.5 - ax) + triNy * (y + 0.5 - ay) + triNz * (z + 0.5 - az)) / triLen);
      if (d < near.dist[cell]) { near.dist[cell] = d; near.tri[cell] = t; }
    };
    if (x0 === x1 && y0 === y1 && z0 === z1) { const c0 = x0 + DX * (z0 + DZ * y0); A[c0] = 1; note(c0, x0, y0, z0); continue; }
    T[0] = ax; T[1] = ay; T[2] = az; T[3] = bx; T[4] = by; T[5] = bz; T[6] = cx; T[7] = cy; T[8] = cz;
    T[9] = bx - ax; T[10] = by - ay; T[11] = bz - az;
    T[12] = cx - bx; T[13] = cy - by; T[14] = cz - bz;
    T[15] = ax - cx; T[16] = ay - cy; T[17] = az - cz;
    T[18] = T[10] * T[14] - T[11] * T[13];
    T[19] = T[11] * T[12] - T[9] * T[14];
    T[20] = T[9] * T[13] - T[10] * T[12];
    for (let y = y0; y <= y1; y++) {
      const base = syStride * y;
      for (let z = z0; z <= z1; z++) {
        const row = base + DX * z;
        for (let x = x0; x <= x1; x++) {
          if (A[row + x] && !near) continue;
          if (triBoxOverlap(T, x + 0.5, y + 0.5, z + 0.5)) { A[row + x] = 1; note(row + x, x, y, z); }
        }
      }
    }
  }
}

function rasterizePoints(A, DX, DY, DZ, pos, map) {
  const { sx, sy, sz, ox, oy, oz } = map;
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const x = Math.floor(pos[i * 3] * sx + ox), y = Math.floor(pos[i * 3 + 1] * sy + oy), z = Math.floor(pos[i * 3 + 2] * sz + oz);
    if (x < 0 || y < 0 || z < 0 || x >= DX || y >= DY || z >= DZ) continue;
    A[x + DX * (z + DZ * y)] = 1;
  }
}

/** Typical gap between neighbouring points, in fine cells (sets how aggressively to close a sparse cloud). */
function pointSpacing(A, DX, DY, DZ, pos, map) {
  const n = pos.length / 3;
  const counts = new Uint8Array(A.length);
  for (let i = 0; i < n; i++) {
    const x = Math.floor(pos[i * 3] * map.sx + map.ox), y = Math.floor(pos[i * 3 + 1] * map.sy + map.oy), z = Math.floor(pos[i * 3 + 2] * map.sz + map.oz);
    if (x < 0 || y < 0 || z < 0 || x >= DX || y >= DY || z >= DZ) continue;
    const c = x + DX * (z + DZ * y);
    if (counts[c] < 2) counts[c]++;
  }
  const rings = [];
  const samples = Math.min(400, n);
  for (let s = 0; s < samples; s++) {
    const i = Math.floor((s / samples) * n);
    const x = Math.floor(pos[i * 3] * map.sx + map.ox), y = Math.floor(pos[i * 3 + 1] * map.sy + map.oy), z = Math.floor(pos[i * 3 + 2] * map.sz + map.oz);
    if (x < 0 || y < 0 || z < 0 || x >= DX || y >= DY || z >= DZ) continue;
    if (counts[x + DX * (z + DZ * y)] > 1) { rings.push(0); continue; }
    let found = 8;
    for (let r = 1; r <= 8 && found === 8; r++) {
      for (let dz = -r; dz <= r && found === 8; dz++) for (let dy = -r; dy <= r && found === 8; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const xx = x + dx, yy = y + dy, zz = z + dz;
        if (xx < 0 || yy < 0 || zz < 0 || xx >= DX || yy >= DY || zz >= DZ) continue;
        if (counts[xx + DX * (zz + DZ * yy)]) { found = r; break; }
      }
    }
    rings.push(found);
  }
  rings.sort((a, b) => a - b);
  return rings.length ? rings[Math.floor(rings.length * 0.75)] : 1;
}

/** One separable pass of dilation / erosion using running window counts. */
function morphPass(src, dst, DX, DY, DZ, axis, r, dilate) {
  const sxs = 1, szs = DX, sys = DX * DZ;
  const len = axis === 0 ? DX : axis === 1 ? DY : DZ;
  const stride = axis === 0 ? sxs : axis === 1 ? sys : szs;
  const pref = new Int32Array(len + 1);
  const full = 2 * r + 1;
  const outerA = axis === 0 ? DZ : axis === 1 ? DX : DX;
  const outerB = axis === 0 ? DY : axis === 1 ? DZ : DY;
  for (let b = 0; b < outerB; b++) {
    for (let a = 0; a < outerA; a++) {
      let base;
      if (axis === 0) base = a * szs + b * sys;           // a = z, b = y
      else if (axis === 1) base = a * sxs + b * szs;      // a = x, b = z
      else base = a * sxs + b * sys;                      // a = x, b = y
      for (let i = 0; i < len; i++) pref[i + 1] = pref[i] + (src[base + i * stride] ? 1 : 0);
      for (let i = 0; i < len; i++) {
        const lo = i - r < 0 ? 0 : i - r;
        const hi = i + r >= len ? len - 1 : i + r;
        const cnt = pref[hi + 1] - pref[lo];
        dst[base + i * stride] = dilate ? (cnt > 0 ? 1 : 0) : (cnt === full ? 1 : 0);
      }
    }
  }
}

function morph(A, DX, DY, DZ, r, dilate) {
  if (r <= 0) return A;
  const B = new Uint8Array(A.length);
  morphPass(A, B, DX, DY, DZ, 0, r, dilate);
  morphPass(B, A, DX, DY, DZ, 2, r, dilate);
  morphPass(A, B, DX, DY, DZ, 1, r, dilate);
  return B;
}

/** Mark every empty cell reachable from the outside (excluding the bottom, which is the ground slab) as 2. */
function floodExterior(G, DX, DY, DZ, stack) {
  const sz = DX, sy = DX * DZ;
  let sp = 0;
  const push = (c) => { if (G[c] === 0) { G[c] = 2; stack[sp++] = c; } };
  for (let y = 0; y < DY; y++) for (let z = 0; z < DZ; z++) { push(sy * y + sz * z); push(sy * y + sz * z + DX - 1); }
  for (let y = 0; y < DY; y++) for (let x = 0; x < DX; x++) { push(sy * y + x); push(sy * y + sz * (DZ - 1) + x); }
  for (let z = 0; z < DZ; z++) for (let x = 0; x < DX; x++) push(sy * (DY - 1) + sz * z + x);
  while (sp > 0) {
    const c = stack[--sp];
    const x = c % DX;
    const z = Math.floor(c / DX) % DZ;
    const y = Math.floor(c / sy);
    if (x > 0) push(c - 1);
    if (x < DX - 1) push(c + 1);
    if (z > 0) push(c - sz);
    if (z < DZ - 1) push(c + sz);
    if (y > 0) push(c - sy);
    if (y < DY - 1) push(c + sy);
  }
}

/**
 * Leak detector. A scan with holes lets the flood fill escape into the object, leaving a hollow shell. Empty cells inside
 * such a shell have solid material on at least 5 of their 6 axis rays (only the ray through the hole escapes).
 * A properly sealed solid has none of them. Open containers (a mug) also trip it, which is why sealing is capped.
 */
function enclosedFraction(solid, nx, ny, nz) {
  const n = solid.length;
  const hits = new Uint8Array(n);
  const sy = nx * nz;
  const sweep = (len, stride, outerA, outerB, base) => {
    for (let b = 0; b < outerB; b++) for (let a = 0; a < outerA; a++) {
      const o = base(a, b);
      let seen = false;
      for (let i = 0; i < len; i++) { const c = o + i * stride; if (solid[c]) seen = true; else if (seen) hits[c]++; }
      seen = false;
      for (let i = len - 1; i >= 0; i--) { const c = o + i * stride; if (solid[c]) seen = true; else if (seen) hits[c]++; }
    }
  };
  sweep(nx, 1, nz, ny, (z, y) => z * nx + y * sy);          // along x
  sweep(nz, nx, nx, ny, (x, y) => x + y * sy);              // along z
  sweep(ny, sy, nx, nz, (x, z) => x + z * nx);              // along y
  let cavity = 0, count = 0, deep = 0;
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const i = (y * nz + z) * nx + x;
    if (solid[i]) {
      count++;
      if (x > 0 && x < nx - 1 && z > 0 && z < nz - 1 && y > 0 && y < ny - 1 &&
        solid[i - 1] && solid[i + 1] && solid[i - nx] && solid[i + nx] && solid[i - sy] && solid[i + sy]) deep++;
    } else if (hits[i] >= 5) cavity++;
  }
  return { fraction: count + cavity ? cavity / (count + cavity) : 0, cavity, total: count, deepRatio: count ? deep / count : 0 };
}

/**
 * Conservative rasterisation marks every cell the surface touches, which inflates the solid by ~0.7 fine cells.
 * For each surface cell, look at the nearest triangle plane, work out which side is "outside" by probing the filled
 * solid ±2 cells along the plane normal, and drop the cell if its centre lies outside the surface.
 */
function debiasSurface(S, DX, DY, DZ, near, pos, idx, map) {
  const sy = DX * DZ;
  const removals = [];
  const probe = (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= DX || iy >= DY || iz >= DZ) return 0;
    return S[ix + DX * (iz + DZ * iy)];
  };
  for (let c = 0; c < near.tri.length; c++) {
    const t = near.tri[c];
    if (t < 0 || !S[c]) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, d = idx[t * 3 + 2] * 3;
    const ax = pos[a] * map.sx + map.ox, ay = pos[a + 1] * map.sy + map.oy, az = pos[a + 2] * map.sz + map.oz;
    const bx = pos[b] * map.sx + map.ox, by = pos[b + 1] * map.sy + map.oy, bz = pos[b + 2] * map.sz + map.oz;
    const cx = pos[d] * map.sx + map.ox, cy = pos[d + 1] * map.sy + map.oy, cz = pos[d + 2] * map.sz + map.oz;
    let nx = (by - ay) * (cz - bz) - (bz - az) * (cy - by);
    let ny = (bz - az) * (cx - bx) - (bx - ax) * (cz - bz);
    let nz = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len; ny /= len; nz /= len;
    const x = c % DX, z = Math.floor(c / DX) % DZ, y = Math.floor(c / sy);
    const px = x + 0.5, py = y + 0.5, pz = z + 0.5;
    const plus = probe(px + 2 * nx, py + 2 * ny, pz + 2 * nz);
    const minus = probe(px - 2 * nx, py - 2 * ny, pz - 2 * nz);
    if (plus === minus) continue;                        // thin section or ambiguous: keep the cell
    const outward = plus ? -1 : 1;                       // sign of the normal that points out of the solid
    const signed = nx * (px - ax) + ny * (py - ay) + nz * (pz - az);
    if (signed * outward > 0) removals.push(c);          // centre lies outside the surface
  }
  for (const c of removals) S[c] = 0;
  return removals.length;
}

/** Remove one-voxel speckle: a cell flips when at least `need` of its six face neighbours disagree with it. */
export function denoiseSolid(solid, nx, ny, nz, need = 5, passes = 1) {
  const sy = nx * nz;
  let changed = 0;
  for (let p = 0; p < passes; p++) {
    const flips = [];
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const c = y * sy + z * nx + x;
      const v = solid[c];
      let diff = 0;
      // cells outside the grid count as empty, except directly below the floor (the model stands on the ground)
      diff += (x > 0 ? solid[c - 1] : 0) !== v; diff += (x + 1 < nx ? solid[c + 1] : 0) !== v;
      diff += (z > 0 ? solid[c - nx] : 0) !== v; diff += (z + 1 < nz ? solid[c + nx] : 0) !== v;
      diff += (y > 0 ? solid[c - sy] : v) !== v; diff += (y + 1 < ny ? solid[c + sy] : 0) !== v;
      if (diff >= need) flips.push(c);
    }
    for (const c of flips) solid[c] = solid[c] ? 0 : 1;
    changed += flips.length;
    if (!flips.length) break;
  }
  return changed;
}

/** Keep the largest 6-connected set of solid cells; returns number of cells dropped. */
export function keepLargestComponent(solid, nx, ny, nz) {
  const n = solid.length;
  const comp = new Int32Array(n).fill(-1);
  const sy = nx * nz;
  const sizes = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!solid[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let sp = 0, size = 0;
    stack[sp++] = s; comp[s] = id;
    while (sp) {
      const c = stack[--sp];
      size++;
      const x = c % nx, z = Math.floor(c / nx) % nz, y = Math.floor(c / sy);
      const tryPush = (q) => { if (solid[q] && comp[q] < 0) { comp[q] = id; stack[sp++] = q; } };
      if (x > 0) tryPush(c - 1);
      if (x < nx - 1) tryPush(c + 1);
      if (z > 0) tryPush(c - nx);
      if (z < nz - 1) tryPush(c + nx);
      if (y > 0) tryPush(c - sy);
      if (y < ny - 1) tryPush(c + sy);
    }
    sizes.push(size);
  }
  if (sizes.length <= 1) return { dropped: 0, pieces: sizes.length };
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  let dropped = 0;
  for (let i = 0; i < n; i++) if (solid[i] && comp[i] !== best) { solid[i] = 0; dropped++; }
  return { dropped, pieces: sizes.length };
}

/**
 * @param scan   cleaned scan { kind, positions, indices }, Y-up, min corner at origin, in source units
 * @param spec   { mmPerUnit, k, dims:[nx,ny,nz], ss, seal:'auto'|number, threshold }
 *               k = LEGO millimetres per real millimetre.
 * @returns { solid, soft, dims, ss, seal, warnings, stats }
 */
export async function voxelizeScan(scan, spec, job) {
  const [nx, ny, nz] = spec.dims;
  const warnings = [];
  const maxCells = spec.maxFineCells || 24e6;
  let ss = spec.ss || 2;
  const minDim = Math.min(nx, ny, nz);
  const midDim = [nx, ny, nz].sort((a, b) => a - b)[1];
  const padFor = (r) => r + 3;
  const cellsFor = (s, r) => (nx * s + 2 * padFor(r)) * (ny * s + 2 * padFor(r)) * (nz * s + 2 * padFor(r));
  const wantAuto = spec.seal === 'auto' || spec.seal === undefined;
  // Holes keep their physical size while the grid gets finer, so the closing radius is allowed to grow up to ~22% of
  // the model's middle dimension. Beyond that an opening is a feature (a mug's mouth), not a hole.
  const sealCap = (s) => Math.max(3, Math.min(20, Math.round(0.22 * midDim * s)));
  while (ss > 1 && cellsFor(ss, wantAuto ? sealCap(ss) : spec.seal) > maxCells) ss--;
  const rCap = wantAuto ? sealCap(ss) : spec.seal;
  const P = padFor(rCap);
  const DX = nx * ss + 2 * P, DY = ny * ss + 2 * P, DZ = nz * ss + 2 * P;
  const total = DX * DY * DZ;

  const k = spec.k * spec.mmPerUnit;
  const shrink = 1 - 2e-7;
  const map = {
    sx: (k / CELL_MM.x) * ss * shrink, sy: (k / CELL_MM.y) * ss * shrink, sz: (k / CELL_MM.z) * ss * shrink,
    ox: P + 1e-7 * ss, oy: P + 1e-7 * ss, oz: P + 1e-7 * ss,
  };

  // ---- surface -----------------------------------------------------------------------------------------------------
  let surface = new Uint8Array(total);
  const debias = scan.kind === 'mesh' && spec.debias !== false;
  const near = debias ? { dist: new Float32Array(total).fill(Infinity), tri: new Int32Array(total).fill(-1) } : null;
  if (scan.kind === 'mesh') await rasterizeMesh(surface, DX, DY, DZ, scan.positions, scan.indices, map, job, near);
  else rasterizePoints(surface, DX, DY, DZ, scan.positions, map);
  let surfaceCells = 0;
  for (let i = 0; i < total; i++) if (surface[i]) surfaceCells++;
  if (!surfaceCells) throw new Error('Nothing to voxelise at this scale.');
  if (job) await job.tick();

  let minSeal = 1;
  if (scan.kind === 'points') {
    const gap = pointSpacing(surface, DX, DY, DZ, scan.positions, map);
    minSeal = Math.max(1, gap + 1);
    if (minSeal > rCap) warnings.push('The point cloud is sparse at this scale; consider a smaller model or a denser scan.');
  }

  const stack = new Int32Array(total);
  let radii;
  if (wantAuto) {
    radii = [];
    for (let r = Math.min(minSeal, rCap); r <= rCap; r = Math.max(r + 1, Math.round(r * 1.4))) radii.push(r);
  } else {
    radii = [spec.seal];
  }

  let best = null;
  for (const r of radii) {
    if (job) await job.tick();
    // closing = dilate → fill exterior → erode
    let G = new Uint8Array(surface);
    G = morph(G, DX, DY, DZ, r, true);
    // ground slab below the object
    for (let y = 0; y < P; y++) G.fill(1, y * DX * DZ, (y + 1) * DX * DZ);
    floodExterior(G, DX, DY, DZ, stack);
    const solidFine = new Uint8Array(total);
    for (let i = 0; i < total; i++) solidFine[i] = G[i] === 2 ? 0 : 1;
    G = null;
    let eroded = morph(solidFine, DX, DY, DZ, r, false);
    if (near) debiasSurface(eroded, DX, DY, DZ, near, scan.positions, scan.indices, map);
    // down-sample to brick cells
    const soft = new Uint8Array(nx * ny * nz);
    const solid = new Uint8Array(nx * ny * nz);
    const block = ss * ss * ss;
    const thr = Math.max(1, Math.ceil((spec.threshold ?? 0.5) * block - 1e-9));
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      let cnt = 0;
      for (let fy = 0; fy < ss; fy++) for (let fz = 0; fz < ss; fz++) {
        const rowBase = (P + y * ss + fy) * DX * DZ + (P + z * ss + fz) * DX + P + x * ss;
        for (let fx = 0; fx < ss; fx++) cnt += eroded[rowBase + fx];
      }
      const bi = (y * nz + z) * nx + x;
      soft[bi] = cnt;
      solid[bi] = cnt >= thr ? 1 : 0;
    }
    eroded = null;
    const en = enclosedFraction(solid, nx, ny, nz);
    // leaky shell: enclosed cavities, or hardly any material that is not on the surface
    const suspicious = minDim >= 3 && (en.fraction > 0.1 || en.deepRatio < 0.05);
    const cand = { r, solid, soft, ratio: en.fraction, suspicious, count: en.total };
    if (!best) best = cand;          // smallest radius = fallback for genuinely open / thin-walled objects
    if (!suspicious) { best = cand; break; }
  }
  const { solid, soft } = best;
  const smoothed = spec.smooth === false ? 0 : denoiseSolid(solid, nx, ny, nz, 5, 1);
  const cc = keepLargestComponent(solid, nx, ny, nz);
  if (cc.dropped) warnings.push(`Dropped ${cc.dropped} voxels in ${cc.pieces - 1} detached fragment(s).`);
  let count = 0;
  for (let i = 0; i < solid.length; i++) if (solid[i]) count++;
  if (!count) throw new Error('The model is empty at this size; make it larger.');
  if (best.suspicious) warnings.push('The model is an open container or the scan has holes too large to seal; its inside stays hollow. If the object should be solid, re-scan with fewer gaps or pick a larger hole-sealing radius.');

  return {
    solid, soft, dims: [nx, ny, nz], ss, seal: best.r, warnings,
    stats: { smoothed, surfaceCells, fineCells: total, solidVoxels: count, cavityFraction: best.ratio, droppedFragments: cc.pieces - 1 },
  };
}
