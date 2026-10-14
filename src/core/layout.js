// Brick layout: turns a solid voxel grid into a set of standard bricks.
//
// Each horizontal layer is tiled with rectangles taken from the parts catalogue. Tiling is greedy and
// randomised; candidates are scored to (a) use big bricks, (b) avoid placing brick edges directly above
// the edges of the layer below (staggered joints) and (c) overlap several bricks underneath (interlocking).
// Several attempts are made per layer and the best is kept. A repair pass then guarantees that the finished
// model is one connected piece (bricks are connected when their footprints overlap in adjacent layers).

import { mulberry32 } from './util.js';
import { seamStats } from './analysis.js';

export const QUALITY_ATTEMPTS = { fast: 2, balanced: 10, best: 24 };
export const QUALITY_SWEEPS = { fast: 0, balanced: 2, best: 3 };

/** All rectangle footprints (both orientations) the catalogue can fill, biggest first. */
export function buildRects(parts) {
  const rects = [];
  parts.forEach((p, partIndex) => {
    rects.push({ w: p.w, d: p.d, area: p.w * p.d, part: partIndex });
    if (p.w !== p.d) rects.push({ w: p.d, d: p.w, area: p.w * p.d, part: partIndex });
  });
  rects.sort((a, b) => b.area - a.area || b.w - a.w);
  if (!rects.some((r) => r.w === 1 && r.d === 1)) throw new Error('The parts list must contain a 1x1 brick.');
  return rects;
}

// Tunables (exported so experiments / tests can inspect them).
export const TUNING = {
  crackGreedy: 8,   // penalty per brick edge that lines up with an edge in the layer below (greedy choice)
  spanBonus: 0.5,     // reward per distinct brick below that this one overlaps (max 2)
  noSupport: 4,       // penalty for a brick that rests on nothing
  crackCost: 5,       // weight of an aligned joint when comparing whole-layer tilings
  sweepPolish: true,  // extra neighbour-aware sweeps while too many joints line up
  seamPolish: true,   // spanning-brick fixes for individual aligned joints
  hangingRepair: true,
};

/**
 * Greedy tiling of the cells in S. `variant` picks the scan direction (3 bits: flipX, flipZ, zMajor).
 * Returns the placed rectangles and a label grid (index into `placed`).
 */
export function tileLayer(S, prev, next, nx, nz, rects, variant, jitter, rng) {
  const N = nx * nz;
  const lab = new Int32Array(N).fill(-1);
  const placed = [];
  const flipX = (variant & 1) !== 0, flipZ = (variant & 2) !== 0, zMajor = (variant & 4) !== 0;
  const seen = [0, 0, 0];

  /** Score for putting rectangle R with min corner (x0, z0) down now; -Infinity when it does not fit. */
  const scoreRect = (x0, z0, R, needSupport) => {
    if (x0 < 0 || z0 < 0 || x0 + R.w > nx || z0 + R.d > nz) return -Infinity;
    let supported = false, distinct = 0, supCells = 0;
    seen[0] = seen[1] = seen[2] = -2;
    for (let zz = z0; zz < z0 + R.d; zz++) {
      const row = zz * nx;
      for (let xx = x0; xx < x0 + R.w; xx++) {
        const q = row + xx;
        if (!S[q] || lab[q] >= 0) return -Infinity;
        if (prev) {
          const pl = prev[q];
          if (pl >= 0) {
            supported = true;
            supCells++;
            if (distinct < 3 && pl !== seen[0] && pl !== seen[1] && pl !== seen[2]) seen[distinct++] = pl;
          }
        }
      }
    }
    if (needSupport && !supported) return -Infinity;
    let score = R.area;
    // overhang pass: favour bricks that cover many overhanging cells and use up few of the scarce supported ones
    if (needSupport) score += 2 * (R.area - supCells) - 0.7 * supCells;
    if (jitter) score += rng() * jitter;
    if (prev) score += supported ? TUNING.spanBonus * Math.min(distinct - 1, 2) : -TUNING.noSupport;
    if (prev || next) {
      let cracks = 0;
      const edge = (pi, qi) => {
        // p inside the rect, q outside and still to be tiled: the two will be different bricks
        if (S[qi] && lab[qi] < 0) {
          if (prev) { const a = prev[pi], b = prev[qi]; if (a >= 0 && b >= 0 && a !== b) cracks++; }
          if (next) { const a = next[pi], b = next[qi]; if (a >= 0 && b >= 0 && a !== b) cracks++; }
        }
      };
      if (z0 > 0) for (let xx = x0; xx < x0 + R.w; xx++) edge(z0 * nx + xx, (z0 - 1) * nx + xx);
      if (z0 + R.d < nz) for (let xx = x0; xx < x0 + R.w; xx++) edge((z0 + R.d - 1) * nx + xx, (z0 + R.d) * nx + xx);
      if (x0 > 0) for (let zz = z0; zz < z0 + R.d; zz++) edge(zz * nx + x0, zz * nx + x0 - 1);
      if (x0 + R.w < nx) for (let zz = z0; zz < z0 + R.d; zz++) edge(zz * nx + x0 + R.w - 1, zz * nx + x0 + R.w);
      score -= TUNING.crackGreedy * cracks;
    }
    return score;
  };
  const place = (x0, z0, R, ri) => {
    const id = placed.length;
    placed.push({ x: x0, z: z0, w: R.w, d: R.d, r: ri });
    for (let zz = z0; zz < z0 + R.d; zz++) for (let xx = x0; xx < x0 + R.w; xx++) lab[zz * nx + xx] = id;
  };

  // Phase 1 – overhang: every cell with nothing underneath is covered, nearest-to-support first, by a brick that
  // also reaches a supported cell, so the finished layer can be built bottom-up.
  if (prev) {
    const dist = new Int16Array(N).fill(-1);
    const queue = [];
    for (let c = 0; c < N; c++) if (S[c] && prev[c] >= 0) { dist[c] = 0; queue.push(c); }
    if (queue.length) {
      for (let qi = 0; qi < queue.length; qi++) {
        const c = queue[qi];
        const x = c % nx, z = (c - x) / nx;
        const nb = [x > 0 ? c - 1 : -1, x + 1 < nx ? c + 1 : -1, z > 0 ? c - nx : -1, z + 1 < nz ? c + nx : -1];
        for (const q of nb) if (q >= 0 && S[q] && dist[q] < 0) { dist[q] = dist[c] + 1; queue.push(q); }
      }
      // overhanging cells, nearest to support first; ties broken by this attempt's scan direction (and noise)
      const over = [];
      for (let qi = 0; qi < queue.length; qi++) if (dist[queue[qi]] > 0) over.push(queue[qi]);
      const key = (u) => {
        const x = u % nx, z = (u - x) / nx;
        const a = zMajor ? z : x, b = zMajor ? x : z;
        const fa = (zMajor ? flipZ : flipX) ? -a : a, fb = (zMajor ? flipX : flipZ) ? -b : b;
        return fa * 1000 + fb + (jitter ? rng() * 40 : 0);
      };
      const keys = new Map(over.map((u) => [u, key(u)]));
      over.sort((a, b) => dist[a] - dist[b] || keys.get(a) - keys.get(b));
      for (const u of over) {
        if (lab[u] >= 0) continue;
        const ux = u % nx, uz = (u - ux) / nx;
        let best = -Infinity, bx = 0, bz = 0, br = -1;
        for (let ri = 0; ri < rects.length; ri++) {
          const R = rects[ri];
          for (let x0 = ux - R.w + 1; x0 <= ux; x0++) for (let z0 = uz - R.d + 1; z0 <= uz; z0++) {
            const sc = scoreRect(x0, z0, R, true);
            if (sc > best) { best = sc; bx = x0; bz = z0; br = ri; }
          }
        }
        if (br >= 0) place(bx, bz, rects[br], br);
      }
    }
  }

  // Phase 2 – everything else, greedy in scan order.
  const outerN = zMajor ? nz : nx, innerN = zMajor ? nx : nz;
  for (let oi = 0; oi < outerN; oi++) {
    for (let ii = 0; ii < innerN; ii++) {
      let x, z;
      if (zMajor) { z = flipZ ? nz - 1 - oi : oi; x = flipX ? nx - 1 - ii : ii; }
      else { x = flipX ? nx - 1 - oi : oi; z = flipZ ? nz - 1 - ii : ii; }
      const c = x + z * nx;
      if (!S[c] || lab[c] >= 0) continue;
      let best = -Infinity, bx = x, bz = z, br = -1;
      for (let ri = 0; ri < rects.length; ri++) {
        const R = rects[ri];
        const x0 = flipX ? x - R.w + 1 : x;
        const z0 = flipZ ? z - R.d + 1 : z;
        const sc = scoreRect(x0, z0, R, false);
        if (sc > best) { best = sc; bx = x0; bz = z0; br = ri; }
      }
      if (br < 0) { br = rects.findIndex((r) => r.w === 1 && r.d === 1); }
      place(bx, bz, rects[br], br);
    }
  }
  return { placed, lab };
}

/** Number of joints in `lab` that line up with a joint in `ref` (a continuous vertical crack between two layers). */
function countCracks(lab, ref, nx, nz) {
  let cracks = 0;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const c = z * nx + x;
      if (lab[c] < 0 || ref[c] < 0) continue;
      if (x + 1 < nx) {
        const q = c + 1;
        if (lab[q] >= 0 && lab[q] !== lab[c] && ref[q] >= 0 && ref[q] !== ref[c]) cracks++;
      }
      if (z + 1 < nz) {
        const q = c + nx;
        if (lab[q] >= 0 && lab[q] !== lab[c] && ref[q] >= 0 && ref[q] !== ref[c]) cracks++;
      }
    }
  }
  return cracks;
}

/** Cost of a tiling: brick count + weighted joint alignments + bricks resting on nothing. */
function tilingCost(t, prev, next, nx, nz, crackW) {
  let cost = t.placed.length;
  if (prev) {
    cost += crackW * countCracks(t.lab, prev, nx, nz);
    let hanging = 0;
    for (const r of t.placed) {
      let ok = false;
      for (let zz = r.z; zz < r.z + r.d && !ok; zz++) for (let xx = r.x; xx < r.x + r.w; xx++) if (prev[zz * nx + xx] >= 0) { ok = true; break; }
      if (!ok) hanging++;
    }
    cost += 40 * hanging;
  }
  if (next) cost += crackW * countCracks(t.lab, next, nx, nz);
  return cost;
}

export function bestTiling(S, prev, next, nx, nz, rects, attempts, rng, crackW) {
  let best = null;
  for (let k = 0; k < attempts; k++) {
    const variant = k % 8;
    const jitter = k >= 8 ? 0.9 : 0;
    const t = tileLayer(S, prev, next, nx, nz, rects, variant, jitter, rng);
    t.cost = tilingCost(t, prev, next, nx, nz, crackW);
    if (!best || t.cost < best.cost) best = t;
  }
  return best;
}

/**
 * @param solidIn  Uint8Array nx*ny*nz  (index (y*nz+z)*nx+x)
 * @param parts    catalogue parts to use: [{w, d, ...}]
 * @returns { bricks: Int32Array [x,y,z,w,d,partIndex]*, solid, stats }
 */
export async function layoutBricks(solidIn, dims, parts, opts = {}, job) {
  const [nx, ny, nz] = dims;
  const N = nx * nz;
  const rects = buildRects(parts);
  const rng = mulberry32(opts.seed ?? 20240607);
  const attempts = opts.attempts ?? QUALITY_ATTEMPTS.balanced;
  const crackW = opts.crackWeight ?? TUNING.crackCost;
  const solid = Uint8Array.from(solidIn);

  let bricks = []; // {id, x, y, z, w, d, r, alive}
  let labs = new Array(ny);
  const layerMask = (y) => solid.subarray(y * N, (y + 1) * N);

  /** First pass: tile every layer bottom-up, each layer aware only of the one below it. */
  const initialPass = async (tries) => {
    bricks = [];
    labs = new Array(ny);
    for (let y = 0; y < ny; y++) {
      const S = layerMask(y);
      const lab = new Int32Array(N).fill(-1);
      labs[y] = lab;
      let any = false;
      for (let c = 0; c < N; c++) if (S[c]) { any = true; break; }
      if (!any) continue;
      const t = bestTiling(S, y > 0 ? labs[y - 1] : null, null, nx, nz, rects, tries, rng, crackW);
      for (const r of t.placed) {
        const id = bricks.length;
        bricks.push({ id, x: r.x, y, z: r.z, w: r.w, d: r.d, r: r.r, alive: true });
        for (let zz = r.z; zz < r.z + r.d; zz++) for (let xx = r.x; xx < r.x + r.w; xx++) lab[zz * nx + xx] = id;
      }
      if (job) {
        await job.tick();
        if ((y & 3) === 0) job.progress('layout', (y + 1) / ny, `Fitting bricks: layer ${y + 1} of ${ny}`);
      }
    }
  };

  // Refinement sweeps: now that every layer exists, re-tile each one knowing both its neighbours.
  const sweep = async (tries) => {
    for (let y = 0; y < ny; y++) {
      const S = layerMask(y);
      const cur = labs[y];
      let any = false;
      for (let c = 0; c < N; c++) if (S[c]) { any = true; break; }
      if (!any) continue;
      const prev = y > 0 ? labs[y - 1] : null;
      const next = y + 1 < ny ? labs[y + 1] : null;
      // cost of the tiling we already have, measured the same way
      const oldPlaced = [];
      for (const b of bricks) if (b.alive && b.y === y) oldPlaced.push({ x: b.x, z: b.z, w: b.w, d: b.d, r: b.r });
      const oldCost = tilingCost({ placed: oldPlaced, lab: cur }, prev, next, nx, nz, crackW);
      const t = bestTiling(S, prev, next, nx, nz, rects, tries, rng, crackW);
      if (t.cost >= oldCost - 1e-9) continue;
      for (const b of bricks) if (b.alive && b.y === y) b.alive = false;
      cur.fill(-1);
      for (const r of t.placed) {
        const id = bricks.length;
        bricks.push({ id, x: r.x, y, z: r.z, w: r.w, d: r.d, r: r.r, alive: true });
        for (let zz = r.z; zz < r.z + r.d; zz++) for (let xx = r.x; xx < r.x + r.w; xx++) cur[zz * nx + xx] = id;
      }
      if (job && (y & 3) === 0) await job.tick();
    }
    if (job) job.progress('layout', 1, 'Refining joints between layers…');
  };
  const sweeps = opts.sweeps ?? 1;
  const refine = async () => {
    for (let i = 0; i < sweeps; i++) await sweep(attempts);
    // polish: keep going (with more attempts) while too many joints still line up from layer to layer
    if (sweeps > 0 && opts.polish !== false && TUNING.sweepPolish) {
      for (let extra = 0; extra < 4; extra++) {
        const st = seamStats(dims, labs);
        if (st.total < 1 || st.pct >= 97) break;
        await sweep(attempts * 2);
      }
    }
  };

  // ------------------------------------------------------------------------------------------------------------------
  // Connectivity repair
  // ------------------------------------------------------------------------------------------------------------------
  const components = () => {
    const B = bricks.length;
    const parent = new Int32Array(B);
    for (let i = 0; i < B; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let y = 1; y < ny; y++) {
      const a = labs[y], b = labs[y - 1];
      for (let c = 0; c < N; c++) {
        const p = a[c], q = b[c];
        if (p >= 0 && q >= 0) { const rp = find(p), rq = find(q); if (rp !== rq) parent[rp] = rq; }
      }
    }
    const root = new Int32Array(B).fill(-1);
    const size = new Float64Array(B);
    let count = 0;
    for (let i = 0; i < B; i++) {
      if (!bricks[i].alive) continue;
      const r = find(i);
      root[i] = r;
      if (size[r] === 0) count++;
      size[r] += bricks[i].w * bricks[i].d;
    }
    let main = -1, mainSize = -1;
    for (let i = 0; i < B; i++) if (root[i] === i && size[i] > mainSize) { main = i; mainSize = size[i]; }
    return { root, size, count, main };
  };

  const rectsFit = (M, px, pz, qx, qz) => {
    // rectangles (catalogue sizes) fully inside mask M that contain both cells p and q, biggest first
    const out = [];
    for (let ri = 0; ri < rects.length; ri++) {
      const R = rects[ri];
      const xLo = Math.max(px, qx) - R.w + 1, xHi = Math.min(px, qx);
      const zLo = Math.max(pz, qz) - R.d + 1, zHi = Math.min(pz, qz);
      for (let x0 = Math.max(0, xLo); x0 <= Math.min(xHi, nx - R.w); x0++) {
        for (let z0 = Math.max(0, zLo); z0 <= Math.min(zHi, nz - R.d); z0++) {
          let ok = true;
          for (let zz = z0; zz < z0 + R.d && ok; zz++) for (let xx = x0; xx < x0 + R.w; xx++) if (!M[zz * nx + xx]) { ok = false; break; }
          if (ok) out.push({ x: x0, z: z0, w: R.w, d: R.d, r: ri, area: R.area });
        }
      }
      if (out.length >= 6) break;
    }
    return out;
  };

  /** Merge bricks b and n (same layer, edge-adjacent) by re-tiling their cells around a brick that spans the joint. */
  const tryBridge = (b, n, p, q, M, which = 0) => {
    const y = b.y;
    const lab = labs[y];
    const cells = [];
    for (const br of [b, n]) for (let zz = br.z; zz < br.z + br.d; zz++) for (let xx = br.x; xx < br.x + br.w; xx++) cells.push(zz * nx + xx);
    M.fill(0);
    for (const c of cells) M[c] = 1;
    const spans = rectsFit(M, p % nx, Math.floor(p / nx), q % nx, Math.floor(q / nx));
    if (!spans.length) return null;
    if (which >= spans.length) return null;
    const R = spans[which]; // which-th biggest catalogue brick that spans the joint
    const S2 = new Uint8Array(N);
    for (const c of cells) S2[c] = 1;
    for (let zz = R.z; zz < R.z + R.d; zz++) for (let xx = R.x; xx < R.x + R.w; xx++) S2[zz * nx + xx] = 0;
    const prev = y > 0 ? labs[y - 1] : null;
    const next = y + 1 < ny ? labs[y + 1] : null;
    let rest = { placed: [] };
    for (let c = 0; c < N; c++) {
      if (S2[c]) { rest = bestTiling(S2, prev, next, nx, nz, rects, 4, rng, crackW); break; }
    }
    const undo = { cells, old: cells.map((c) => lab[c]), len: bricks.length, b, n };
    b.alive = false; n.alive = false;
    const add = (r) => {
      const id = bricks.length;
      bricks.push({ id, x: r.x, y, z: r.z, w: r.w, d: r.d, r: r.r, alive: true });
      for (let zz = r.z; zz < r.z + r.d; zz++) for (let xx = r.x; xx < r.x + r.w; xx++) lab[zz * nx + xx] = id;
    };
    add(R);
    for (const r of rest.placed) add(r);
    return () => {
      bricks.length = undo.len;
      undo.cells.forEach((c, i) => { lab[c] = undo.old[i]; });
      b.alive = true; n.alive = true;
    };
  };

  const M = new Uint8Array(N);
  let bridged = 0, prunedBricks = 0, prunedCells = 0, evals = 0;

  const pruneBrick = (b) => {
    b.alive = false;
    prunedBricks++;
    for (let zz = b.z; zz < b.z + b.d; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) {
      labs[b.y][zz * nx + xx] = -1;
      solid[(b.y * nz + zz) * nx + xx] = 0;
      prunedCells++;
    }
  };

  /** Edge-adjacent bricks of `b` in its own layer: candidate joints for a bridging brick. */
  const neighbours = (b, accept) => {
    const out = [];
    const lab = labs[b.y];
    const consider = (pi, qi) => {
      const nb = lab[qi];
      if (nb >= 0 && nb !== b.id && accept(bricks[nb])) out.push({ b, n: bricks[nb], p: pi, q: qi });
    };
    for (let xx = b.x; xx < b.x + b.w; xx++) {
      if (b.z > 0) consider(b.z * nx + xx, (b.z - 1) * nx + xx);
      if (b.z + b.d < nz) consider((b.z + b.d - 1) * nx + xx, (b.z + b.d) * nx + xx);
    }
    for (let zz = b.z; zz < b.z + b.d; zz++) {
      if (b.x > 0) consider(zz * nx + b.x, zz * nx + b.x - 1);
      if (b.x + b.w < nx) consider(zz * nx + b.x + b.w - 1, zz * nx + b.x + b.w);
    }
    return out;
  };

  /** Make the whole model one connected piece (bricks connect when footprints overlap in adjacent layers). */
  const repairFloating = async () => {
    for (let iter = 0; iter < 400; iter++) {
      const comp = components();
      if (comp.count <= 1) return;
      if (job) await job.tick();
      let target = -1, targetSize = Infinity;
      for (let i = 0; i < bricks.length; i++) {
        if (comp.root[i] === i && i !== comp.main && comp.size[i] < targetSize) { target = i; targetSize = comp.size[i]; }
      }
      if (target < 0) return;
      const cands = [];
      for (const b of bricks) {
        if (!b.alive || comp.root[b.id] !== target) continue;
        for (const c of neighbours(b, (nb) => comp.root[nb.id] !== target)) {
          c.toMain = comp.root[c.n.id] === comp.main ? 0 : 1;
          cands.push(c);
        }
      }
      cands.sort((a, c) => a.toMain - c.toMain);
      let fixed = false;
      for (const cand of cands.slice(0, 10)) {
        evals++;
        const undo = tryBridge(cand.b, cand.n, cand.p, cand.q, M);
        if (!undo) continue;
        if (components().count < comp.count) { fixed = true; bridged++; break; }
        undo();
      }
      if (!fixed) {
        // nothing can hold this piece: remove it (reported to the user)
        for (const b of bricks) if (b.alive && comp.root[b.id] === target) pruneBrick(b);
      }
    }
  };

  /** Bricks with nothing beneath them can't be placed bottom-up. */
  const hangingBricks = () => {
    const out = [];
    for (const b of bricks) {
      if (!b.alive || b.y === 0) continue;
      const below = labs[b.y - 1];
      let ok = false;
      for (let zz = b.z; zz < b.z + b.d && !ok; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) if (below[zz * nx + xx] >= 0) { ok = true; break; }
      if (!ok) out.push(b);
    }
    return out;
  };

  /** Give every brick something to sit on: bridge it to a supported neighbour, otherwise trim it (lowest layer first). */
  const repairHanging = async () => {
    for (let iter = 0; iter < 1200; iter++) {
      const hang = hangingBricks();
      if (!hang.length) return;
      if (job) await job.tick();
      hang.sort((a, b) => a.y - b.y);
      const h = hang[0];
      const below = labs[h.y - 1];
      const hangSet = new Set(hang.map((x) => x.id));
      const cands = neighbours(h, (nb) => !hangSet.has(nb.id));
      cands.forEach((c) => { c.rank = below[c.q] >= 0 ? 0 : 1; });
      cands.sort((a, c) => a.rank - c.rank);
      const before = { hang: hang.length, comps: components().count };
      let fixed = false;
      for (const cand of cands.slice(0, 8)) {
        evals++;
        const undo = tryBridge(cand.b, cand.n, cand.p, cand.q, M);
        if (!undo) continue;
        if (hangingBricks().length < before.hang && components().count <= before.comps) { fixed = true; bridged++; break; }
        undo();
      }
      if (!fixed) pruneBrick(h);
    }
  };

  // Build, then give hanging bricks a support column wherever the gap underneath is only a hollowing choice
  // (opts.original = the solid before hollowing); then refine and repair what is left.
  await initialPass(opts.original ? Math.min(attempts, 4) : attempts);
  let restored = 0;
  for (let r = 0; r < 3 && opts.original; r++) {
    let added = 0;
    for (const h of hangingBricks()) {
      for (let zz = h.z; zz < h.z + h.d; zz++) for (let xx = h.x; xx < h.x + h.w; xx++) {
        for (let yy = h.y - 1; yy >= 0; yy--) {
          const i = (yy * nz + zz) * nx + xx;
          if (solid[i] || !opts.original[i]) break;
          solid[i] = 1; added++;
        }
      }
    }
    if (!added) break;
    restored += added;
    await initialPass(opts.original ? Math.min(attempts, 4) : attempts);
  }
  const initialBricks = bricks.length;
  const stages = { afterInitial: hangingBricks().length };
  await refine();
  stages.afterRefine = hangingBricks().length;

  for (let round = 0; round < 6; round++) {
    await repairFloating();
    if (TUNING.hangingRepair) await repairHanging();
    if (components().count <= 1 && !hangingBricks().length) break;
  }

  /** Ruin & recreate: re-tile every brick of layer y that touches a window around cell c; returns an undo function. */
  const windowRetile = (y, c, radius, tries) => {
    const lab = labs[y];
    const cx = c % nx, cz = (c - cx) / nx;
    const ids = new Set();
    for (let zz = Math.max(0, cz - radius); zz <= Math.min(nz - 1, cz + radius); zz++) {
      for (let xx = Math.max(0, cx - radius); xx <= Math.min(nx - 1, cx + radius); xx++) {
        if (lab[zz * nx + xx] >= 0) ids.add(lab[zz * nx + xx]);
      }
    }
    if (ids.size < 2) return null;
    const olds = [...ids].map((id) => bricks[id]);
    const S2 = new Uint8Array(N);
    const cells = [];
    for (const b of olds) for (let zz = b.z; zz < b.z + b.d; zz++) for (let xx = b.x; xx < b.x + b.w; xx++) { S2[zz * nx + xx] = 1; cells.push(zz * nx + xx); }
    const prev = y > 0 ? labs[y - 1] : null;
    const next = y + 1 < ny ? labs[y + 1] : null;
    const t = bestTiling(S2, prev, next, nx, nz, rects, tries, rng, crackW);
    const undo = { cells, old: cells.map((q) => lab[q]), len: bricks.length };
    for (const b of olds) b.alive = false;
    for (const q of cells) lab[q] = -1;
    for (const r of t.placed) {
      const id = bricks.length;
      bricks.push({ id, x: r.x, y, z: r.z, w: r.w, d: r.d, r: r.r, alive: true });
      for (let zz = r.z; zz < r.z + r.d; zz++) for (let xx = r.x; xx < r.x + r.w; xx++) lab[zz * nx + xx] = id;
    }
    return () => {
      bricks.length = undo.len;
      undo.cells.forEach((q, i) => { lab[q] = undo.old[i]; });
      for (const b of olds) b.alive = true;
    };
  };

  stages.afterRepair = hangingBricks().length;
  // Seam polish: joints that still line up from one layer to the next get a spanning brick on either side of the joint.
  const localCost = (y) => {
    let count = 0;
    for (const b of bricks) if (b.alive && b.y === y) count++;
    let c = count;
    if (y > 0) c += crackW * countCracks(labs[y], labs[y - 1], nx, nz);
    if (y + 1 < ny) c += crackW * countCracks(labs[y], labs[y + 1], nx, nz);
    return c;
  };
  if (opts.polish !== false && TUNING.seamPolish && (opts.sweeps ?? 1) > 0) {
    let polished = 0;
    for (let pass = 0; pass < 3; pass++) {
      const cracks = [];
      for (let y = 0; y + 1 < ny; y++) {
        const a = labs[y], b = labs[y + 1];
        for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
          const c = z * nx + x;
          if (a[c] < 0 || b[c] < 0) continue;
          for (let dir = 0; dir < 2; dir++) {
            const q = dir === 0 ? (x + 1 < nx ? c + 1 : -1) : (z + 1 < nz ? c + nx : -1);
            if (q < 0 || a[q] < 0 || b[q] < 0 || a[q] === a[c] || b[q] === b[c]) continue;
            cracks.push({ y, c, q });
          }
        }
      }
      if (!cracks.length) break;
      let improved = 0;
      let hangNow = hangingBricks().length, compNow = components().count;
      for (const cr of cracks) {
        const a = labs[cr.y], b = labs[cr.y + 1];
        if (a[cr.c] < 0 || a[cr.q] < 0 || a[cr.c] === a[cr.q] || b[cr.c] < 0 || b[cr.q] < 0 || b[cr.c] === b[cr.q]) continue; // already fixed
        let done = false;
        for (const layer of [cr.y + 1, cr.y]) {
          const lab = labs[layer];
          for (let which = 0; which < 4 && !done; which++) {
            const before = localCost(layer);
            const undo = tryBridge(bricks[lab[cr.c]], bricks[lab[cr.q]], cr.c, cr.q, M, which);
            if (!undo) break;
            evals++;
            const hang = hangingBricks().length, comps = components().count;
            if (localCost(layer) < before - 1e-9 && hang <= hangNow && comps <= compNow) { improved++; polished++; hangNow = hang; compNow = comps; done = true; break; }
            undo();
          }
          if (done) break;
        }
        for (const layer of [cr.y + 1, cr.y]) {
          for (const radius of [2, 3]) {
            if (done) break;
            const before = localCost(layer);
            const undo = windowRetile(layer, cr.c, radius, 10);
            if (!undo) continue;
            evals++;
            const hang = hangingBricks().length, comps = components().count;
            if (localCost(layer) < before - 1e-9 && hang <= hangNow && comps <= compNow) { improved++; polished++; hangNow = hang; compNow = comps; done = true; break; }
            undo();
          }
        }
        if (job && (improved & 15) === 15) await job.tick();
      }
      if (!improved) break;
    }
    bridged += polished;
  }
  stages.afterPolish = hangingBricks().length;

  // ------------------------------------------------------------------------------------------------------------------
  const alive = bricks.filter((b) => b.alive);
  const out = new Int32Array(alive.length * 6);
  alive.forEach((b, i) => {
    out[i * 6] = b.x; out[i * 6 + 1] = b.y; out[i * 6 + 2] = b.z; out[i * 6 + 3] = b.w; out[i * 6 + 4] = b.d;
    out[i * 6 + 5] = rects[b.r].part;
  });
  return {
    bricks: out,
    solid,
    stats: { initialBricks, bricks: alive.length, bridged, prunedBricks, prunedCells, restoredCells: restored, bridgeEvaluations: evals, hangingStages: stages },
  };
}
