// Procedural "phone scans" with known ground truth.
//
// Objects are signed-distance functions (SDFs) meshed with surface nets, then degraded the way a real LiDAR scan is:
// vertex noise, holes, an unscanned underside, a table plane, background clutter and floating specks.
// They power the built-in demo scans and the automated tests (the SDF is the "CAD" reference).

import { mulberry32 } from './util.js';

// ---- SDF primitives (metres, Y-up, object resting on y = 0) ---------------------------------------------------------
const len3 = (x, y, z) => Math.hypot(x, y, z);
const sdBox = (px, py, pz, cx, cy, cz, hx, hy, hz) => {
  const qx = Math.abs(px - cx) - hx, qy = Math.abs(py - cy) - hy, qz = Math.abs(pz - cz) - hz;
  return len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
};
const sdCylY = (px, py, pz, cx, cy, cz, r, hh) => {
  const dx = Math.hypot(px - cx, pz - cz) - r, dy = Math.abs(py - cy) - hh;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
};
const sdEllipsoid = (px, py, pz, cx, cy, cz, rx, ry, rz) => {
  const k = len3((px - cx) / rx, (py - cy) / ry, (pz - cz) / rz);
  return (k - 1) * Math.min(rx, ry, rz);
};
const sdCapsule = (px, py, pz, ax, ay, az, bx, by, bz, r) => {
  const pax = px - ax, pay = py - ay, paz = pz - az, bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
  return len3(pax - bax * h, pay - bay * h, paz - baz * h) - r;
};
const sdTorusZ = (px, py, pz, cx, cy, cz, R, r) => {
  const qx = Math.hypot(px - cx, py - cy) - R;
  return Math.hypot(qx, pz - cz) - r;
};
const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

export const SHAPES = {
  shoebox: {
    label: 'Shoebox',
    size: [0.31, 0.115, 0.19],
    sdf: (x, y, z) => Math.min(
      sdBox(x, y, z, 0, 0.0475, 0, 0.15, 0.0475, 0.09),
      sdBox(x, y, z, 0, 0.1025, 0, 0.155, 0.0125, 0.095)),
  },
  compact: {
    label: 'Powder compact',
    size: [0.095, 0.024, 0.1],
    sdf: (x, y, z) => Math.min(
      sdCylY(x, y, z, 0, 0.011, 0, 0.045, 0.011),
      sdBox(x, y, z, 0, 0.011, -0.05, 0.02, 0.011, 0.006),
      sdCylY(x, y, z, 0, 0.021, 0, 0.035, 0.003)),
  },
  controller: {
    label: 'Game controller',
    size: [0.187, 0.052, 0.115],
    sdf: (x, y, z) => {
      const body = sdEllipsoid(x, y, z, 0, 0.03, 0.0, 0.075, 0.022, 0.034);
      const gl = sdCapsule(x, y, z, -0.052, 0.026, 0.012, -0.072, 0.022, 0.058, 0.0215);
      const gr = sdCapsule(x, y, z, 0.052, 0.026, 0.012, 0.072, 0.022, 0.058, 0.0215);
      return smin(smin(body, gl, 0.02), gr, 0.02);
    },
  },
  mug: {
    label: 'Mug (open top, handle)',
    size: [0.115, 0.09, 0.08],
    sdf: (x, y, z) => {
      const outer = sdCylY(x, y, z, 0, 0.045, 0, 0.04, 0.045);
      const inner = sdCylY(x, y, z, 0, 0.056, 0, 0.034, 0.045);
      const cup = Math.max(outer, -inner);
      const handle = Math.max(sdTorusZ(x, y, z, 0.044, 0.046, 0, 0.026, 0.007), 0.036 - x);
      return Math.min(cup, handle);
    },
  },
  sphere: {
    label: 'Ball',
    size: [0.1, 0.1, 0.1],
    sdf: (x, y, z) => sdEllipsoid(x, y, z, 0, 0.05, 0, 0.05, 0.05, 0.05),
  },
};

/** Surface-nets mesher: returns triangles whose winding follows the SDF gradient. */
export function surfaceNets(sdf, lo, hi, cell) {
  const nx = Math.ceil((hi[0] - lo[0]) / cell) + 2, ny = Math.ceil((hi[1] - lo[1]) / cell) + 2, nz = Math.ceil((hi[2] - lo[2]) / cell) + 2;
  const vals = new Float32Array(nx * ny * nz);
  const vi = (i, j, k) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    vals[vi(i, j, k)] = sdf(lo[0] + i * cell, lo[1] + j * cell, lo[2] + k * cell);
  }
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellId = new Int32Array(cx * cy * cz).fill(-1);
  const positions = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    const v = corner.map(([a, b, c]) => vals[vi(i + a, j + b, k + c)]);
    let neg = 0;
    for (const x of v) if (x < 0) neg++;
    if (neg === 0 || neg === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      sx += corner[a][0] + t * (corner[b][0] - corner[a][0]);
      sy += corner[a][1] + t * (corner[b][1] - corner[a][1]);
      sz += corner[a][2] + t * (corner[b][2] - corner[a][2]);
      n++;
    }
    cellId[i + cx * (j + cy * k)] = positions.length / 3;
    positions.push(lo[0] + (i + sx / n) * cell, lo[1] + (j + sy / n) * cell, lo[2] + (k + sz / n) * cell);
  }
  const indices = [];
  const cid = (i, j, k) => cellId[i + cx * (j + cy * k)];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c); else indices.push(a, b, c, a, c, d);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v0 = vals[vi(i, j, k)];
    if (i + 1 < nx && j > 0 && k > 0 && i < cx && j < cy && k < cz) {
      const v1 = vals[vi(i + 1, j, k)];
      if ((v0 < 0) !== (v1 < 0)) quad(cid(i, j - 1, k - 1), cid(i, j, k - 1), cid(i, j, k), cid(i, j - 1, k), v0 < 0);
    }
    if (j + 1 < ny && i > 0 && k > 0 && i < cx && j < cy && k < cz) {
      const v1 = vals[vi(i, j + 1, k)];
      if ((v0 < 0) !== (v1 < 0)) quad(cid(i - 1, j, k - 1), cid(i, j, k - 1), cid(i, j, k), cid(i - 1, j, k), v0 >= 0);
    }
    if (k + 1 < nz && i > 0 && j > 0 && i < cx && j < cy && k < cz) {
      const v1 = vals[vi(i, j, k + 1)];
      if ((v0 < 0) !== (v1 < 0)) quad(cid(i - 1, j - 1, k), cid(i, j - 1, k), cid(i, j, k), cid(i - 1, j, k), v0 < 0);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

function gaussian(rng) {
  return Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
}

/**
 * Build a scan-like mesh.
 * @param {string} shape key of SHAPES
 * @param {object} o { seed, noise (m), holes, holeRadius [min,max] (m), yawDeg, up ('+y' | '+z'), units ('m' | 'cm' | 'mm'), clutter }
 * @returns { kind:'mesh', positions, indices, format, truth }
 */
export function makeScan(shape, o = {}) {
  const S = SHAPES[shape];
  if (!S) throw new Error('Unknown demo shape ' + shape);
  const opt = { seed: 7, noise: 0.0012, holes: 3, holeRadius: [0.005, 0.011], yawDeg: 0, up: '+y', units: 'm', clutter: true, floor: true, cell: null, ...o };
  const rng = mulberry32(opt.seed);
  const pad = 0.02;
  const lo = [-S.size[0] / 2 - pad, -0.004, -S.size[2] / 2 - pad - 0.04];
  const hi = [S.size[0] / 2 + pad, S.size[1] + pad, S.size[2] / 2 + pad + 0.04];
  const cell = opt.cell || Math.max(0.0025, Math.max(...S.size) / 70);
  const mesh = surfaceNets(S.sdf, lo, hi, cell);
  let pos = Array.from(mesh.positions);
  let idx = Array.from(mesh.indices);

  // unscanned underside: drop triangles within the lowest 6 mm
  const keep = [];
  for (let t = 0; t < idx.length; t += 3) {
    const cy = (pos[idx[t] * 3 + 1] + pos[idx[t + 1] * 3 + 1] + pos[idx[t + 2] * 3 + 1]) / 3;
    if (cy > 0.006) keep.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  idx = keep;
  // holes: delete everything within a radius of a few random surface points
  const holeCenters = [];
  for (let h = 0; h < opt.holes; h++) {
    const t = Math.floor(rng() * (idx.length / 3)) * 3;
    holeCenters.push([pos[idx[t] * 3], pos[idx[t] * 3 + 1], pos[idx[t] * 3 + 2], opt.holeRadius[0] + rng() * (opt.holeRadius[1] - opt.holeRadius[0])]);
  }
  const kept2 = [];
  for (let t = 0; t < idx.length; t += 3) {
    const cx = (pos[idx[t] * 3] + pos[idx[t + 1] * 3] + pos[idx[t + 2] * 3]) / 3;
    const cy = (pos[idx[t] * 3 + 1] + pos[idx[t + 1] * 3 + 1] + pos[idx[t + 2] * 3 + 1]) / 3;
    const cz = (pos[idx[t] * 3 + 2] + pos[idx[t + 1] * 3 + 2] + pos[idx[t + 2] * 3 + 2]) / 3;
    if (holeCenters.some((h) => Math.hypot(cx - h[0], cy - h[1], cz - h[2]) < h[3])) continue;
    kept2.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  idx = kept2;
  // noise
  for (let i = 0; i < pos.length; i++) pos[i] += gaussian(rng) * opt.noise;

  const addVertex = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
  const addTri = (a, b, c) => idx.push(a, b, c);

  if (opt.floor) {
    // table plane with a gap under the object footprint, 1.2 m wide
    const n = 60, half = 0.6, step = (2 * half) / n;
    const grid = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      grid.push(addVertex(-half + i * step, gaussian(rng) * 0.0015, -half + j * step));
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * step, z = -half + (j + 0.5) * step;
      if (Math.abs(x) < S.size[0] / 2 + 0.01 && Math.abs(z) < S.size[2] / 2 + 0.01) continue;
      const a = grid[i + (n + 1) * j], b = grid[i + 1 + (n + 1) * j], c = grid[i + 1 + (n + 1) * (j + 1)], d = grid[i + (n + 1) * (j + 1)];
      addTri(a, d, b); addTri(b, d, c);
    }
  }
  if (opt.clutter) {
    // a wall patch behind, a second object to one side and a big box far away
    const wall = 20;
    const wv = [];
    for (let j = 0; j <= wall; j++) for (let i = 0; i <= wall; i++) wv.push(addVertex(-0.6 + (i * 1.2) / wall, (j * 0.7) / wall, -0.55 + gaussian(rng) * 0.002));
    for (let j = 0; j < wall; j++) for (let i = 0; i < wall; i++) {
      const a = wv[i + (wall + 1) * j], b = wv[i + 1 + (wall + 1) * j], c = wv[i + 1 + (wall + 1) * (j + 1)], d = wv[i + (wall + 1) * (j + 1)];
      addTri(a, b, c); addTri(a, c, d);
    }
    const blob = surfaceNets((x, y, z) => sdEllipsoid(x, y, z, 0.38, 0.05, 0.33, 0.05, 0.05, 0.05), [0.3, -0.004, 0.25], [0.46, 0.12, 0.41], 0.006);
    const base = pos.length / 3;
    for (let i = 0; i < blob.positions.length; i++) pos.push(blob.positions[i]);
    for (let i = 0; i < blob.indices.length; i++) idx.push(blob.indices[i] + base);
    // floating specks
    for (let s = 0; s < 40; s++) {
      const x = (rng() - 0.5) * 0.5, y = 0.03 + rng() * 0.2, z = (rng() - 0.5) * 0.5;
      const a = addVertex(x, y, z), b = addVertex(x + 0.003, y, z), c = addVertex(x, y + 0.003, z);
      addTri(a, b, c);
    }
  }

  // yaw about Y, then convert up axis and unit
  const f32 = Float32Array.from(pos);
  const yaw = (opt.yawDeg * Math.PI) / 180;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const unit = { m: 1, cm: 100, mm: 1000 }[opt.units];
  for (let i = 0; i < f32.length; i += 3) {
    const x = f32[i], y = f32[i + 1], z = f32[i + 2];
    let X = x * cs + z * sn, Y = y, Z = -x * sn + z * cs;
    if (opt.up === '+z') { const t = Y; Y = -Z; Z = t; }   // Z-up: (x, y, z) → (x, -z, y)
    f32[i] = X * unit; f32[i + 1] = Y * unit; f32[i + 2] = Z * unit;
  }
  return {
    kind: 'mesh',
    positions: f32,
    indices: Uint32Array.from(idx),
    format: 'demo',
    truth: { shape, size: S.size, sdf: S.sdf, yawDeg: opt.yawDeg },
  };
}

/** Serialise a scan as OBJ text (used by tests and the "download demo" helper). */
export function toOBJ(scan) {
  const lines = ['# BrickScan demo scan'];
  for (let i = 0; i < scan.positions.length; i += 3) lines.push(`v ${scan.positions[i]} ${scan.positions[i + 1]} ${scan.positions[i + 2]}`);
  for (let i = 0; i < scan.indices.length; i += 3) lines.push(`f ${scan.indices[i] + 1} ${scan.indices[i + 1] + 1} ${scan.indices[i + 2] + 1}`);
  return lines.join('\n') + '\n';
}

/** Binary little-endian PLY (mesh or point cloud). */
export function toPLY(scan) {
  const nv = scan.positions.length / 3;
  const nf = scan.indices ? scan.indices.length / 3 : 0;
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${nv}\nproperty float x\nproperty float y\nproperty float z\n` +
    (nf ? `element face ${nf}\nproperty list uchar int vertex_indices\n` : '') + 'end_header\n';
  const hb = new TextEncoder().encode(header);
  const out = new Uint8Array(hb.length + nv * 12 + nf * 13);
  out.set(hb);
  const dv = new DataView(out.buffer);
  let p = hb.length;
  for (let i = 0; i < scan.positions.length; i++) { dv.setFloat32(p, scan.positions[i], true); p += 4; }
  for (let f = 0; f < nf; f++) {
    dv.setUint8(p++, 3);
    for (let k = 0; k < 3; k++) { dv.setInt32(p, scan.indices[f * 3 + k], true); p += 4; }
  }
  return out;
}
