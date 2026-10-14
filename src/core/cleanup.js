// Scan cleanup: weld → orient → remove floor → drop background / noise pieces → crop → align → decimate.
// Works on triangle meshes and on point clouds. Output is always Y-up with the model's min corner at the origin.

import {
  bounds, diagonal, weldMesh, subsetMesh, subsetPoints, triangleStats, meshComponents, fillComponentBounds, finishMoments,
  detectUpAxis, detectFloor, clusterDecimate, bestYaw, rotateY,
} from './geometry.js';
import { reorientToYUp } from './orient.js';

export const DEFAULT_CLEAN = {
  up: 'auto',            // 'auto' | '+y' | '-y' | '+z' | '-z' | '+x' | '-x'
  floor: true,           // remove the dominant horizontal plane the object stands on
  floorMargin: 0.012,    // extra trim above the floor plane, as a fraction of object height
  keep: 'auto',          // 'auto' (large + central) | 'largest' | 'all'
  minPiece: 0.05,        // detached pieces smaller than this fraction of the main piece are noise
  crop: null,            // { x:[0..1], y:[0..1], z:[0..1] } fractions of the remaining bounding box
  yaw: 'auto',           // 'auto' (align to the stud grid) | degrees
  targetFaces: 400000,   // decimation budget (browser memory)
  unit: 'auto',          // 'auto' | 'm' | 'cm' | 'mm' | 'in'
};

const UNITS = { m: 1000, cm: 10, mm: 1, in: 25.4 };

/** Choose the scan unit that puts the object closest to a typical 25 cm desk object. */
export function detectUnit(maxDimension) {
  let best = null;
  for (const key of ['m', 'cm', 'mm']) {
    const mm = maxDimension * UNITS[key];
    const err = Math.abs(Math.log(Math.max(mm, 1e-9) / 250));
    if (!best || err < best.err - 1e-9) best = { key, err };
  }
  return best.key;
}

/** Unit of the whole scene: a room-scale scan is typically a couple of metres across. */
export function sceneUnit(b) {
  const diag = Math.hypot(b.size[0], b.size[1], b.size[2]);
  let best = null;
  for (const key of ['m', 'cm', 'mm']) {
    const err = Math.abs(Math.log(Math.max(diag * UNITS[key], 1e-9) / 2000));
    if (!best || err < best.err - 1e-9) best = { key, err };
  }
  return UNITS[best.key];
}

/** Parse step shared by mesh + points: welds meshes, guesses the up axis, keeps results for repeated cleaning. */
export function prepareRaw(parsed, fileName = '') {
  let { positions, indices } = parsed;
  const stats = { vertices: positions.length / 3, faces: indices ? indices.length / 3 : 0 };
  if (indices) {
    const b = bounds(positions);
    const welded = weldMesh(positions, indices, Math.max(diagonal(b) * 1e-6, 1e-12));
    positions = welded.positions;
    indices = welded.indices;
    if (!indices.length) throw new Error('The mesh has no usable triangles.');
  }
  const detected = detectUpAxis(positions, indices);
  const fallback = parsed.format === 'stl' ? '+z' : '+y';
  const bb = bounds(positions);
  return {
    kind: indices ? 'mesh' : 'points',
    positions, indices, fileName, format: parsed.format,
    bounds: bb,
    upGuess: detected.confidence >= 1.25 ? detected.up : fallback,
    upConfidence: detected.confidence,
    stats: { ...stats, weldedVertices: positions.length / 3, weldedFaces: indices ? indices.length / 3 : 0 },
  };
}

function pickPieces(comps, mode, minPiece, unitMM) {
  if (!comps.length) return { kept: new Set(), main: null };
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const c of comps) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], c.min[a]); hi[a] = Math.max(hi[a], c.max[a]); }
  const cx0 = (lo[0] + hi[0]) / 2, cz0 = (lo[2] + hi[2]) / 2;
  const sigma = 0.35 * Math.max(hi[0] - lo[0], hi[2] - lo[2], 1e-9);
  let main = null, bestScore = -1;
  for (const c of comps) {
    let score = c.area;
    if (mode === 'auto') {
      const d = Math.hypot(c.cx - cx0, c.cz - cz0);
      score = c.area / (1 + (d / sigma) * (d / sigma));
      // Walls, table edges and big furniture faces are flat sheets; real objects have volume.
      // (measured along the piece's principal axes, so a rotated wall is still recognised as flat)
      const [s1, , s3] = c.sigma;
      const flatness = s1 > 0 ? s3 / s1 : 1;
      score *= Math.min(1, Math.max(0.04, flatness / 0.1));
      // Scope is 10–50 cm objects: anything much bigger than ~80 cm is room, not subject.
      const maxMM = 3.46 * s1 * unitMM;
      if (maxMM > 800) score *= Math.pow(800 / maxMM, 6);
    }
    if (score > bestScore) { bestScore = score; main = c; }
  }
  const kept = new Set([main.id]);
  const gap = 0.12 * Math.hypot(main.max[0] - main.min[0], main.max[1] - main.min[1], main.max[2] - main.min[2]);
  for (const c of comps) {
    if (c === main) continue;
    if (mode === 'all') { if (c.area >= minPiece * main.area * 0.2) kept.add(c.id); continue; }
    if (c.area < minPiece * main.area) continue;
    // a lid or handle is never bigger than the object itself; a wall whose bounding box happens to overlap is
    if (c.sigma[0] > 1.2 * main.sigma[0]) continue;
    // keep detached pieces only when they sit right next to the main piece (a lid, a handle, a hole in the scan)
    let near = true;
    for (let a = 0; a < 3; a++) {
      if (c.min[a] > main.max[a] + gap || c.max[a] < main.min[a] - gap) { near = false; break; }
    }
    if (near) kept.add(c.id);
  }
  return { kept, main };
}

/** Connected components of points on a coarse occupancy grid (26-neighbourhood). */
function pointComponents(pos, keep, cell) {
  const n = pos.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const gx = Math.floor((maxX - minX) / cell) + 3, gy = Math.floor((maxY - minY) / cell) + 3, gz = Math.floor((maxZ - minZ) / cell) + 3;
  const cells = gx * gy * gz;
  const cellOf = new Int32Array(n).fill(-1);
  const occ = new Uint8Array(cells);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const c = (Math.floor((pos[i * 3] - minX) / cell) + 1) + gx * ((Math.floor((pos[i * 3 + 1] - minY) / cell) + 1) + gy * (Math.floor((pos[i * 3 + 2] - minZ) / cell) + 1));
    cellOf[i] = c;
    occ[c] = 1;
  }
  const comp = new Int32Array(cells).fill(-1);
  let nc = 0;
  const stack = [];
  for (let s = 0; s < cells; s++) {
    if (!occ[s] || comp[s] >= 0) continue;
    comp[s] = nc;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop();
      const x = c % gx, y = Math.floor(c / gx) % gy, z = Math.floor(c / (gx * gy));
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, zz = z + dz;
        if (xx < 0 || yy < 0 || zz < 0 || xx >= gx || yy >= gy || zz >= gz) continue;
        const q = xx + gx * (yy + gy * zz);
        if (occ[q] && comp[q] < 0) { comp[q] = nc; stack.push(q); }
      }
    }
    nc++;
  }
  const comps = Array.from({ length: nc }, (_, id) => ({
    id, area: 0, cx: 0, cy: 0, cz: 0, m2: new Float64Array(6), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
  }));
  const label = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (cellOf[i] < 0) continue;
    const id = comp[cellOf[i]];
    label[i] = id;
    const c = comps[id];
    c.area++;
    for (let a = 0; a < 3; a++) {
      const v = pos[i * 3 + a];
      if (v < c.min[a]) c.min[a] = v;
      if (v > c.max[a]) c.max[a] = v;
    }
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    c.cx += x; c.cy += y; c.cz += z;
    c.m2[0] += x * x; c.m2[1] += x * y; c.m2[2] += x * z; c.m2[3] += y * y; c.m2[4] += y * z; c.m2[5] += z * z;
  }
  for (const c of comps) finishMoments(c);
  return { label, comps };
}

/**
 * Clean a prepared scan. `raw` is never modified so the user can re-run with different parameters.
 */
export async function cleanScan(raw, params = {}, job) {
  const p = { ...DEFAULT_CLEAN, ...params };
  const isMesh = raw.kind === 'mesh';
  const log = [];
  const tick = async () => { if (job) await job.tick(); };

  const sceneUnitMM = p.unit === 'auto' ? sceneUnit(raw.bounds) : UNITS[p.unit];
  const up = p.up === 'auto' ? raw.upGuess : p.up;
  const pos = reorientToYUp(Float32Array.from(raw.positions), up);
  const idx = raw.indices;
  const units = isMesh ? idx.length / 3 : pos.length / 3;
  const nVerts = pos.length / 3;
  await tick();

  // ---- sample representation (triangle centroids + areas, or the points) -------------------------------------------
  let area = null, cen = pos;
  if (isMesh) ({ area, cen } = triangleStats(pos, idx));
  const unitY = (u) => cen[u * 3 + 1];

  // ---- floor ----------------------------------------------------------------------------------------------------
  let keep = new Uint8Array(units).fill(1);
  let floor = null;
  let floorCut = -Infinity;
  if (p.floor) {
    floor = detectFloor(cen, area);
    if (floor) {
      const band = Math.max(floor.binWidth * 3, (floor.range[1] - floor.range[0]) * 0.004);
      floorCut = floor.y + band;
      for (let u = 0; u < units; u++) if (unitY(u) <= floorCut) keep[u] = 0;
      floor.band = band;
      log.push(`Floor plane found at height ${floor.y.toFixed(4)} (covers ${(floor.share * 100).toFixed(0)}% of the surface) and removed.`);
    } else {
      log.push('No dominant floor plane found; skipping floor removal.');
    }
  }
  await tick();

  // ---- component selection (background, clutter, noise) --------------------------------------------------------------
  const selectPieces = (mask) => {
    let label, comps;
    if (isMesh) {
      ({ label, comps } = meshComponents(idx, nVerts, mask, area, cen));
      fillComponentBounds(comps, label, idx, pos);
    } else {
      const b = bounds(pos);
      const cell = Math.max(Math.max(...b.size) / 160, 1e-9);
      ({ label, comps } = pointComponents(pos, mask, cell));
    }
    const { kept, main } = pickPieces(comps, p.keep, p.minPiece, sceneUnitMM);
    const out = new Uint8Array(units);
    for (let u = 0; u < units; u++) if (label[u] >= 0 && kept.has(label[u])) out[u] = 1;
    return { mask: out, main, pieces: comps.length, keptPieces: kept.size };
  };

  let sel = selectPieces(keep);
  if (!sel.main) throw new Error('Nothing is left after floor removal. Try turning floor removal off or choose another up axis.');
  keep = sel.mask;
  log.push(`Kept ${sel.keptPieces} of ${sel.pieces} separate pieces (background and noise discarded).`);
  await tick();

  // ---- trim a little more above the floor (contact area between the object and the table) ----------------------------------
  if (floor && p.floorMargin > 0) {
    const H = sel.main.max[1] - sel.main.min[1];
    const trim = floorCut + p.floorMargin * H;
    let removed = 0;
    for (let u = 0; u < units; u++) if (keep[u] && unitY(u) < trim) { keep[u] = 0; removed++; }
    if (removed) { sel = selectPieces(keep); keep = sel.mask; }
  }

  // ---- manual crop -------------------------------------------------------------------------------------------------
  if (p.crop) {
    const b = bounds(subsetPoints(cen, keep));
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const f = p.crop[['x', 'y', 'z'][a]] || [0, 1];
      lo[a] = b.min[a] + f[0] * b.size[a];
      hi[a] = b.min[a] + f[1] * b.size[a];
    }
    let changed = false;
    for (let u = 0; u < units; u++) {
      if (!keep[u]) continue;
      const x = cen[u * 3], y = cen[u * 3 + 1], z = cen[u * 3 + 2];
      if (x < lo[0] || x > hi[0] || y < lo[1] || y > hi[1] || z < lo[2] || z > hi[2]) { keep[u] = 0; changed = true; }
    }
    if (changed) {
      sel = selectPieces(keep);
      keep = sel.mask;
      if (!sel.main) throw new Error('The crop removed the whole object.');
      log.push('Applied manual crop.');
    }
  }
  await tick();

  // ---- extract ---------------------------------------------------------------------------------------------------------
  let outPos, outIdx = null;
  if (isMesh) {
    const sub = subsetMesh(pos, idx, keep);
    outPos = sub.positions; outIdx = sub.indices;
  } else {
    outPos = subsetPoints(pos, keep);
  }
  const keptUnits = isMesh ? outIdx.length / 3 : outPos.length / 3;
  if (keptUnits < 4) throw new Error('Too little geometry left after cleanup.');

  // ---- yaw alignment, translate to origin --------------------------------------------------------------------------------------
  let yaw = 0;
  if (p.yaw === 'auto') yaw = bestYaw(outPos);
  else if (typeof p.yaw === 'number') yaw = p.yaw;
  rotateY(outPos, yaw);
  const bb = bounds(outPos);
  for (let i = 0; i < outPos.length; i += 3) {
    outPos[i] -= bb.min[0]; outPos[i + 1] -= bb.min[1]; outPos[i + 2] -= bb.min[2];
  }
  const size = bb.size;
  if (yaw) log.push(`Rotated ${yaw}° about the vertical axis to line the object up with the stud grid.`);
  await tick();

  // ---- decimate -----------------------------------------------------------------------------------------------------------------
  let decimated = false;
  if (isMesh) {
    const d = clusterDecimate(outPos, outIdx, p.targetFaces);
    if (d.decimated) {
      outPos = d.positions; outIdx = d.indices; decimated = true;
      log.push(`Decimated from ${keptUnits.toLocaleString('en-US')} to ${(outIdx.length / 3).toLocaleString('en-US')} faces.`);
    }
  }

  // ---- units ---------------------------------------------------------------------------------------------------------------------
  const unitKey = p.unit === 'auto' ? detectUnit(Math.max(size[0], size[1], size[2])) : p.unit;
  const mmPerUnit = UNITS[unitKey];

  return {
    kind: raw.kind,
    positions: outPos,
    indices: outIdx,
    origin: bb.min,                        // where the cleaned model's min corner sat in the aligned scan frame
    size,                                  // source units
    sizeMM: size.map((s) => s * mmPerUnit),
    unit: unitKey,
    mmPerUnit,
    up, yaw, floor,
    decimated,
    stats: {
      inputUnits: units,
      keptUnits,
      outputUnits: isMesh ? outIdx.length / 3 : outPos.length / 3,
      removedPct: 100 * (1 - keptUnits / units),
    },
    log,
  };
}
