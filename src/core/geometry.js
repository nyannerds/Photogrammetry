// Mesh / point-cloud geometry helpers used by the cleanup stage. All arrays are flat typed arrays.

export function bounds(pos) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], size: [maxX - minX, maxY - minY, maxZ - minZ] };
}

export const diagonal = (b) => Math.hypot(b.size[0], b.size[1], b.size[2]);

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

/**
 * Merge vertices that coincide within `tol` and drop degenerate triangles.
 * Needed for STL (triangle soup) and for scans exported with split vertices (UV seams).
 */
export function weldMesh(pos, idx, tol) {
  const n = pos.length / 3;
  const inv = 1 / tol;
  const size = nextPow2(n * 2 + 2);
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const remap = new Int32Array(n);
  const qx = new Int32Array(n), qy = new Int32Array(n), qz = new Int32Array(n);
  const out = new Float32Array(n * 3);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const ix = Math.round(x * inv), iy = Math.round(y * inv), iz = Math.round(z * inv);
    let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask;
    let found = -1;
    for (;;) {
      const e = table[h];
      if (e < 0) break;
      if (qx[e] === ix && qy[e] === iy && qz[e] === iz) { found = e; break; }
      h = (h + 1) & mask;
    }
    if (found < 0) {
      qx[m] = ix; qy[m] = iy; qz[m] = iz;
      out[m * 3] = x; out[m * 3 + 1] = y; out[m * 3 + 2] = z;
      table[h] = m;
      found = m++;
    }
    remap[i] = found;
  }
  const tris = idx.length / 3;
  const outIdx = new Uint32Array(idx.length);
  let t = 0;
  for (let k = 0; k < tris; k++) {
    const a = remap[idx[k * 3]], b = remap[idx[k * 3 + 1]], c = remap[idx[k * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    outIdx[t * 3] = a; outIdx[t * 3 + 1] = b; outIdx[t * 3 + 2] = c;
    t++;
  }
  return { positions: out.slice(0, m * 3), indices: outIdx.slice(0, t * 3) };
}

/** Keep only the triangles flagged in `keep` and drop vertices nobody references any more. */
export function subsetMesh(pos, idx, keep) {
  const n = pos.length / 3;
  const remap = new Int32Array(n).fill(-1);
  let tris = 0, verts = 0;
  for (let t = 0; t < keep.length; t++) {
    if (!keep[t]) continue;
    tris++;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      if (remap[v] < 0) remap[v] = verts++;
    }
  }
  const outPos = new Float32Array(verts * 3);
  for (let v = 0; v < n; v++) {
    const r = remap[v];
    if (r >= 0) { outPos[r * 3] = pos[v * 3]; outPos[r * 3 + 1] = pos[v * 3 + 1]; outPos[r * 3 + 2] = pos[v * 3 + 2]; }
  }
  const outIdx = new Uint32Array(tris * 3);
  let o = 0;
  for (let t = 0; t < keep.length; t++) {
    if (!keep[t]) continue;
    outIdx[o++] = remap[idx[t * 3]]; outIdx[o++] = remap[idx[t * 3 + 1]]; outIdx[o++] = remap[idx[t * 3 + 2]];
  }
  return { positions: outPos, indices: outIdx };
}

export function subsetPoints(pos, keep) {
  let count = 0;
  for (let i = 0; i < keep.length; i++) if (keep[i]) count++;
  const out = new Float32Array(count * 3);
  let o = 0;
  for (let i = 0; i < keep.length; i++) {
    if (!keep[i]) continue;
    out[o++] = pos[i * 3]; out[o++] = pos[i * 3 + 1]; out[o++] = pos[i * 3 + 2];
  }
  return out;
}

/** Per-triangle area and centroid. */
export function triangleStats(pos, idx) {
  const tris = idx.length / 3;
  const area = new Float32Array(tris);
  const cen = new Float32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const ux = pos[b] - ax, uy = pos[b + 1] - ay, uz = pos[b + 2] - az;
    const vx = pos[c] - ax, vy = pos[c + 1] - ay, vz = pos[c + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area[t] = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    cen[t * 3] = (ax + pos[b] + pos[c]) / 3;
    cen[t * 3 + 1] = (ay + pos[b + 1] + pos[c + 1]) / 3;
    cen[t * 3 + 2] = (az + pos[b + 2] + pos[c + 2]) / 3;
  }
  return { area, cen };
}

/** Connected components of the triangles flagged in `keep` (triangles sharing a vertex are connected). */
export function meshComponents(idx, vertexCount, keep, area, cen) {
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const tris = idx.length / 3;
  for (let t = 0; t < tris; t++) {
    if (!keep[t]) continue;
    const a = find(idx[t * 3]);
    const b = find(idx[t * 3 + 1]);
    const c = find(idx[t * 3 + 2]);
    if (a !== b) parent[b] = a;
    const r = find(a);
    const c2 = find(c);
    if (r !== c2) parent[c2] = r;
  }
  const rootToId = new Map();
  const label = new Int32Array(tris).fill(-1);
  const comps = [];
  for (let t = 0; t < tris; t++) {
    if (!keep[t]) continue;
    const r = find(idx[t * 3]);
    let id = rootToId.get(r);
    if (id === undefined) {
      id = comps.length;
      rootToId.set(r, id);
      comps.push({
        id, tris: 0, area: 0, cx: 0, cy: 0, cz: 0, m2: new Float64Array(6),
        min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
      });
    }
    label[t] = id;
    const c = comps[id];
    const w = area[t];
    const x = cen[t * 3], y = cen[t * 3 + 1], z = cen[t * 3 + 2];
    c.tris++; c.area += w;
    c.cx += x * w; c.cy += y * w; c.cz += z * w;
    c.m2[0] += x * x * w; c.m2[1] += x * y * w; c.m2[2] += x * z * w;
    c.m2[3] += y * y * w; c.m2[4] += y * z * w; c.m2[5] += z * z * w;
  }
  for (const c of comps) finishMoments(c);
  return { label, comps };
}

/** Turn accumulated first and second moments into the principal spreads (std-devs) of a piece. */
export function finishMoments(c) {
  const inv = c.area > 0 ? 1 / c.area : 0;
  c.cx *= inv; c.cy *= inv; c.cz *= inv;
  const m = c.m2;
  const cov = [
    m[0] * inv - c.cx * c.cx, m[1] * inv - c.cx * c.cy, m[2] * inv - c.cx * c.cz,
    m[3] * inv - c.cy * c.cy, m[4] * inv - c.cy * c.cz, m[5] * inv - c.cz * c.cz,
  ];
  c.sigma = eigenSpread(cov);
}

/** Principal standard deviations (descending) of a symmetric 3×3 covariance [xx, xy, xz, yy, yz, zz]. */
export function eigenSpread([xx, xy, xz, yy, yz, zz]) {
  const p1 = xy * xy + xz * xz + yz * yz;
  const q = (xx + yy + zz) / 3;
  let e1, e2, e3;
  if (p1 < 1e-30) {
    [e1, e2, e3] = [xx, yy, zz].sort((a, b) => b - a);
  } else {
    const p2 = (xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * p1;
    const p = Math.sqrt(p2 / 6);
    const b = [(xx - q) / p, xy / p, xz / p, (yy - q) / p, yz / p, (zz - q) / p];
    const det = b[0] * (b[3] * b[5] - b[4] * b[4]) - b[1] * (b[1] * b[5] - b[4] * b[2]) + b[2] * (b[1] * b[4] - b[3] * b[2]);
    const r = Math.max(-1, Math.min(1, det / 2));
    const phi = Math.acos(r) / 3;
    e1 = q + 2 * p * Math.cos(phi);
    e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
    e2 = 3 * q - e1 - e3;
  }
  return [Math.sqrt(Math.max(e1, 0)), Math.sqrt(Math.max(e2, 0)), Math.sqrt(Math.max(e3, 0))];
}

/** Fill the `min` / `max` bounding box of every component (kept separate so meshComponents stays position-free). */
export function fillComponentBounds(comps, label, idx, pos) {
  for (let t = 0; t < label.length; t++) {
    if (label[t] < 0) continue;
    const c = comps[label[t]];
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3;
      for (let a = 0; a < 3; a++) {
        const val = pos[v + a];
        if (val < c.min[a]) c.min[a] = val;
        if (val > c.max[a]) c.max[a] = val;
      }
    }
  }
}

/** Robust vertical range (0.2%–99.8%) of a Y-up point set. */
export function heightRange(pts) {
  const n = pts.length / 3;
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) ys[i] = pts[i * 3 + 1];
  return percentileRange(ys, 0.002, 0.998);
}

/** Weighted histogram helper used by up-axis and floor detection. */
function weightedHistogram(values, weights, lo, hi, bins) {
  const h = new Float64Array(bins);
  const span = hi - lo || 1;
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo || v > hi) continue;
    let b = Math.floor(((v - lo) / span) * bins);
    if (b >= bins) b = bins - 1;
    const w = weights ? weights[i] : 1;
    h[b] += w;
    total += w;
  }
  return { h, total, lo, hi, bins, binWidth: span / bins };
}

function percentileRange(values, p0, p1, maxSamples = 50000) {
  const step = Math.max(1, Math.floor(values.length / maxSamples));
  const s = [];
  for (let i = 0; i < values.length; i += step) s.push(values[i]);
  s.sort((a, b) => a - b);
  return [s[Math.floor(p0 * (s.length - 1))], s[Math.floor(p1 * (s.length - 1))]];
}

/** Sample points + weights representing the surface (triangle centroids weighted by area, or the points). */
export function surfaceSamples(pos, idx) {
  if (idx) {
    const { area, cen } = triangleStats(pos, idx);
    return { pts: cen, w: area, tri: true };
  }
  return { pts: pos, w: null, tri: false };
}

/**
 * Guess the up axis. LiDAR scans are gravity aligned and almost always contain a large flat floor or table,
 * which shows up as a sharp spike in the histogram of surface area along the vertical axis.
 * Returns { up, confidence }; callers fall back to a default when confidence is low.
 */
export function detectUpAxis(pos, idx) {
  const { pts, w } = surfaceSamples(pos, idx);
  const n = pts.length / 3;
  const score = [];
  for (let a = 0; a < 3; a++) {
    const vals = new Float32Array(n);
    for (let i = 0; i < n; i++) vals[i] = pts[i * 3 + a];
    const [lo, hi] = percentileRange(vals, 0.005, 0.995);
    if (!(hi > lo)) { score.push({ a, peak: 0, where: 0.5 }); continue; }
    const hist = weightedHistogram(vals, w, lo, hi, 128);
    let best = 0, bi = 0;
    for (let b = 0; b < hist.bins; b++) {
      const s = hist.h[b] + (b > 0 ? hist.h[b - 1] : 0) + (b + 1 < hist.bins ? hist.h[b + 1] : 0);
      if (s > best) { best = s; bi = b; }
    }
    score.push({ a, peak: best / (hist.total || 1), where: (bi + 0.5) / hist.bins });
  }
  score.sort((p, q) => q.peak - p.peak);
  const top = score[0];
  const confidence = top.peak / Math.max(score[1].peak, 1e-9);
  const names = ['x', 'y', 'z'];
  const sign = top.where < 0.5 ? '+' : '-';
  return { up: sign + names[top.a], confidence, peak: top.peak };
}

/**
 * Find the dominant horizontal plane in the lower part of a Y-up scan (the floor / table the object stands on).
 * Returns null when there is no convincing plane.
 */
export function detectFloor(pts, w) {
  const n = pts.length / 3;
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) ys[i] = pts[i * 3 + 1];
  const [lo, hi] = percentileRange(ys, 0.002, 0.998);
  if (!(hi > lo)) return null;
  const bins = 512;
  const hist = weightedHistogram(ys, w, lo, hi, bins);
  // 3-bin smoothing
  const sm = new Float64Array(bins);
  for (let b = 0; b < bins; b++) sm[b] = (hist.h[b - 1] || 0) + hist.h[b] + (hist.h[b + 1] || 0);
  let maxPeak = 0;
  for (let b = 0; b < bins; b++) if (sm[b] > maxPeak) maxPeak = sm[b];
  if (maxPeak < 0.02 * hist.total) return null;
  // lowest significant local maximum inside the lower 60% of the range
  const limit = Math.floor(bins * 0.6);
  let pick = -1;
  for (let b = 1; b < limit; b++) {
    if (sm[b] >= 0.3 * maxPeak && sm[b] >= 0.015 * hist.total && sm[b] >= sm[b - 1] && sm[b] >= sm[b + 1]) {
      // climb to the local maximum
      let top = b;
      while (top + 1 < bins && sm[top + 1] > sm[top]) top++;
      pick = top;
      break;
    }
  }
  if (pick < 0) return null;
  // refine: area-weighted mean of the bins around the peak
  let sw = 0, sy = 0;
  for (let b = Math.max(0, pick - 2); b <= Math.min(bins - 1, pick + 2); b++) {
    sw += hist.h[b];
    sy += hist.h[b] * (lo + (b + 0.5) * hist.binWidth);
  }
  return { y: sw > 0 ? sy / sw : lo + (pick + 0.5) * hist.binWidth, binWidth: hist.binWidth, share: sm[pick] / hist.total, range: [lo, hi] };
}

/**
 * Vertex-clustering decimation: snap vertices to a grid and merge each cell into one vertex.
 * Cheap, robust on noisy scans, and good enough because the target is overall shape.
 */
export function clusterDecimate(pos, idx, targetFaces) {
  const tris = idx.length / 3;
  if (tris <= targetFaces) return { positions: pos, indices: idx, decimated: false };
  const { area } = triangleStats(pos, idx);
  let totalArea = 0;
  for (let t = 0; t < tris; t++) totalArea += area[t];
  const b = bounds(pos);
  let cell = Math.sqrt((2 * totalArea) / targetFaces);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = clusterOnce(pos, idx, b, cell);
    if (r.indices.length / 3 <= targetFaces * 1.3 || attempt === 3) return { ...r, decimated: true, cell };
    cell *= 1.25;
  }
  return { positions: pos, indices: idx, decimated: false };
}

function clusterOnce(pos, idx, b, cell) {
  const n = pos.length / 3;
  const inv = 1 / cell;
  const size = nextPow2(n * 2 + 2);
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const kx = new Int32Array(n), ky = new Int32Array(n), kz = new Int32Array(n);
  const sumX = new Float64Array(n), sumY = new Float64Array(n), sumZ = new Float64Array(n);
  const cnt = new Int32Array(n);
  const remap = new Int32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const ix = Math.floor((x - b.min[0]) * inv), iy = Math.floor((y - b.min[1]) * inv), iz = Math.floor((z - b.min[2]) * inv);
    let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask;
    let found = -1;
    for (;;) {
      const e = table[h];
      if (e < 0) break;
      if (kx[e] === ix && ky[e] === iy && kz[e] === iz) { found = e; break; }
      h = (h + 1) & mask;
    }
    if (found < 0) { kx[m] = ix; ky[m] = iy; kz[m] = iz; table[h] = m; found = m++; }
    remap[i] = found;
    sumX[found] += x; sumY[found] += y; sumZ[found] += z; cnt[found]++;
  }
  const outPos = new Float32Array(m * 3);
  for (let i = 0; i < m; i++) { outPos[i * 3] = sumX[i] / cnt[i]; outPos[i * 3 + 1] = sumY[i] / cnt[i]; outPos[i * 3 + 2] = sumZ[i] / cnt[i]; }
  const tris = idx.length / 3;
  const outIdx = new Uint32Array(tris * 3);
  let t = 0;
  for (let k = 0; k < tris; k++) {
    const a = remap[idx[k * 3]], bb = remap[idx[k * 3 + 1]], c = remap[idx[k * 3 + 2]];
    if (a === bb || bb === c || a === c) continue;
    outIdx[t * 3] = a; outIdx[t * 3 + 1] = bb; outIdx[t * 3 + 2] = c;
    t++;
  }
  return { positions: outPos, indices: outIdx.slice(0, t * 3) };
}

/**
 * Yaw (rotation about Y, degrees) that minimises the footprint of the axis-aligned bounding rectangle,
 * so the object lines up with the stud grid. Result is normalised so the longer side lies along X.
 */
export function bestYaw(pos, maxSamples = 20000) {
  const n = pos.length / 3;
  const step = Math.max(1, Math.floor(n / maxSamples));
  const xs = [], zs = [];
  for (let i = 0; i < n; i += step) { xs.push(pos[i * 3]); zs.push(pos[i * 3 + 2]); }
  let best = { area: Infinity, deg: 0, w: 0, d: 0 };
  for (let deg = 0; deg < 90; deg += 1) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i] * c + zs[i] * s;
      const z = -xs[i] * s + zs[i] * c;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const w = maxX - minX, d = maxZ - minZ;
    const area = w * d;
    // tiny bias toward 0° so that already-aligned scans are left alone
    if (area < best.area * 0.999) best = { area, deg, w, d };
  }
  let deg = best.deg;
  if (best.d > best.w) deg += 90;
  return deg > 90 ? deg - 180 : deg;
}

/** Rotate positions about the Y axis (in place) by `deg` degrees. Positive = counter-clockwise seen from +Y. */
export function rotateY(pos, deg) {
  if (!deg) return pos;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], z = pos[i + 2];
    pos[i] = x * c + z * s;
    pos[i + 2] = -x * s + z * c;
  }
  return pos;
}
