// Orchestrates the build: scale → voxelise → hollow → layout → steps → BOM → verification.

import { voxelizeScan, CELL_MM } from './voxelize.js';
import { hollowSolid } from './hollow.js';
import { layoutBricks, QUALITY_ATTEMPTS, QUALITY_SWEEPS } from './layout.js';
import { buildSteps } from './steps.js';
import { buildBOM } from './exporters.js';
import { analyzeLayout } from './analysis.js';
import { layoutParts } from '../data/catalogue.js';
import { now } from './util.js';

export const DEFAULT_BUILD = {
  scaleMode: 'longest',  // 'height' | 'width' | 'depth' | 'longest' | 'budget'
  value: 24,             // cm of the finished model (or number of parts when scaleMode === 'budget')
  hollow: 2,             // shell thickness in studs; 0 = solid
  pillar: 6,             // spacing of support pillars inside hollow models (0 = none)
  seal: 'auto',          // hole sealing radius (fine voxels) or 'auto'
  quality: 'balanced',   // 'fast' | 'balanced' | 'best'
  brickSet: 'extended',  // 'common' | 'extended'
  color: 'lbg',
  maxPerStep: 20,
  ss: 'auto',            // voxelisation supersampling: 'auto' (3 for small grids, else 2) or 1-3
  threshold: 0.5,        // fraction of a cell that must be inside the scan to count as solid
};

export const MAX_CELLS = 4_000_000;

/** Work out the uniform scale factor k (LEGO mm per real mm) and the voxel grid size. */
export function planScale(clean, mode, value) {
  const E = clean.sizeMM;                // real mm, [x, y, z]
  const cell = [CELL_MM.x, CELL_MM.y, CELL_MM.z];
  let axis;
  let studs;
  if (mode === 'longest') {
    // the longest side of the finished model in mm
    const extents = E.map((e, i) => e); // real extents, already in mm
    axis = extents.indexOf(Math.max(...extents));
    studs = Math.max(1, Math.round((value * 10) / cell[axis]));
  } else {
    axis = mode === 'height' ? 1 : mode === 'depth' ? 2 : 0;
    studs = Math.max(1, Math.round((value * 10) / cell[axis]));
  }
  const k = (studs * cell[axis]) / E[axis];
  const dims = E.map((e, i) => Math.max(1, Math.ceil((e * k) / cell[i] - 1e-4)));
  return { k, dims, axis, studs };
}

function selectParts(catalogue, brickSet) {
  return layoutParts(catalogue, brickSet);
}

async function buildOnce(clean, p, catalogue, job, { quick = false } = {}) {
  const parts = selectParts(catalogue, p.brickSet);
  const plan = planScale(clean, p.scaleMode === 'budget' ? 'longest' : p.scaleMode, p._studsOverrideCm ?? p.value);
  const [nx, ny, nz] = plan.dims;
  if (nx * ny * nz > MAX_CELLS) throw new Error(`That is ${nx}×${nz}×${ny} cells — too big for the browser. Choose a smaller size.`);
  const t0 = now();
  if (job) job.progress('voxel', 0, 'Voxelising and filling the solid…');
  const ss = quick ? 1 : p.ss === 'auto' ? (nx * ny * nz <= 90000 ? 3 : 2) : p.ss;
  const vox = await voxelizeScan(clean, {
    mmPerUnit: clean.mmPerUnit, k: plan.k, dims: plan.dims, ss, seal: p.seal, threshold: p.threshold,
  }, job);
  const t1 = now();
  const hollowed = hollowSolid(vox.solid, vox.dims, p.hollow, p.pillar);
  if (job) job.progress('layout', 0, 'Fitting bricks…');
  const attempts = quick ? 1 : QUALITY_ATTEMPTS[p.quality] ?? QUALITY_ATTEMPTS.balanced;
  const sweeps = quick ? 0 : QUALITY_SWEEPS[p.quality] ?? 1;
  const lay = await layoutBricks(hollowed.solid, vox.dims, parts, { attempts, sweeps, original: vox.solid }, job);
  const t2 = now();
  return { parts, plan, vox, hollowed, lay, timings: { voxelize: t1 - t0, layout: t2 - t1 } };
}

/** Soft IoU between the supersampled scan occupancy and the final outer shape (before hollowing). */
function fidelity(vox) {
  const block = vox.ss * vox.ss * vox.ss;
  let inter = 0, uni = 0;
  for (let i = 0; i < vox.solid.length; i++) {
    const a = vox.soft[i] / block, b = vox.solid[i];
    inter += Math.min(a, b);
    uni += Math.max(a, b);
  }
  return uni ? inter / uni : 1;
}

/**
 * Full build. With scaleMode 'budget' the size is searched so the part count lands near the requested number.
 */
export async function buildModel(clean, params, catalogue, job, priceOverrides = {}) {
  const p = { ...DEFAULT_BUILD, ...params };
  const tStart = now();
  let result;
  let budget = null;
  if (p.scaleMode === 'budget') {
    const target = Math.max(10, p.value);
    const maxE = Math.max(...clean.sizeMM);
    const maxStuds = 240;
    let studs = 24;
    let best = null;
    const tried = new Set();
    for (let iter = 0; iter < 8; iter++) {
      studs = Math.max(3, Math.min(maxStuds, Math.round(studs)));
      if (tried.has(studs)) break;
      tried.add(studs);
      const cm = (studs * CELL_MM.x) / 10; // `longest` is measured in studs ≈ 8 mm for horizontal axes
      const probe = await buildOnce(clean, { ...p, _studsOverrideCm: cm }, catalogue, job, { quick: true });
      const parts = probe.lay.stats.bricks;
      if (!best || Math.abs(parts - target) < Math.abs(best.parts - target)) best = { studs, cm, parts };
      if (Math.abs(parts - target) / target < 0.04) break;
      studs *= Math.pow(target / Math.max(parts, 1), 1 / 2.4);
    }
    // The quick probes ignore joint optimisation, so calibrate against real builds (usually 1–3 of them).
    let chosen = null;
    let cm = best.cm;
    const seen = new Set();
    for (let round = 0; round < 3; round++) {
      const key = Math.round(cm * 10);
      if (seen.has(key)) break;
      seen.add(key);
      const full = await buildOnce(clean, { ...p, _studsOverrideCm: cm }, catalogue, job);
      const parts = full.lay.stats.bricks;
      if (!chosen || Math.abs(parts - target) < Math.abs(chosen.parts - target)) chosen = { full, parts, cm };
      if (Math.abs(parts - target) / target < 0.06) break;
      cm *= Math.pow(target / Math.max(parts, 1), 1 / 2.4);
    }
    budget = { target, studs: best.studs, cm: chosen.cm, parts: chosen.parts, maxE };
    result = chosen.full;
  } else {
    result = await buildOnce(clean, p, catalogue, job);
  }
  const { parts, plan, vox, hollowed, lay } = result;
  const dims = vox.dims;
  const bricks = lay.bricks;
  const { order, steps } = buildSteps(bricks, p.maxPerStep);
  const bom = buildBOM(bricks, parts, catalogue, priceOverrides);
  const iou = fidelity(vox);
  const totalMs = now() - tStart;
  const report = analyzeLayout(bricks, dims, parts, catalogue, {
    iou,
    stepsMax: steps.reduce((m, s) => Math.max(m, s.count), 0),
    steps: steps.length,
    seal: vox.seal,
    ss: vox.ss,
    hollowRemoved: hollowed.removed,
    solidVoxels: vox.stats.solidVoxels,
    prunedBricks: lay.stats.prunedBricks,
    restoredCells: lay.stats.restoredCells,
    bridged: lay.stats.bridged,
    warnings: vox.warnings.slice(),
    totalMs,
    estPeakBytes: vox.stats.fineCells * 9 + clean.positions.byteLength * 2,
  });
  if (lay.stats.prunedBricks) {
    report.warnings.push(`${lay.stats.prunedBricks} unsupported brick(s) were removed because nothing could hold them (overhang too long).`);
  }
  const mm = [dims[0] * CELL_MM.x, dims[1] * CELL_MM.y, dims[2] * CELL_MM.z];
  return {
    bricks, parts, dims, mm, order, steps, bom, report,
    scale: { k: plan.k, studs: plan.studs, axis: plan.axis, mode: p.scaleMode, value: p.value, budget },
    solid: lay.solid,         // final (hollowed, pruned) voxels
    outer: vox.solid,         // solid before hollowing
    soft: vox.soft,
    timings: { ...result.timings, total: totalMs },
    params: p,
  };
}
