// Independent verification of a brick layout. Nothing here trusts the layout code: everything is recomputed from the
// final brick list, so the numbers in the report are the numbers a physical builder would experience.

/** Rebuild per-layer label grids from a brick list (stride 6: x, y, z, w, d, part). */
export function labelLayers(bricks, dims) {
  const [nx, ny, nz] = dims;
  const N = nx * nz;
  const labs = Array.from({ length: ny }, () => new Int32Array(N).fill(-1));
  let overlaps = 0, outOfBounds = 0;
  const count = bricks.length / 6;
  for (let i = 0; i < count; i++) {
    const x = bricks[i * 6], y = bricks[i * 6 + 1], z = bricks[i * 6 + 2], w = bricks[i * 6 + 3], d = bricks[i * 6 + 4];
    if (x < 0 || z < 0 || y < 0 || x + w > nx || z + d > nz || y >= ny) { outOfBounds++; continue; }
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) {
      const c = zz * nx + xx;
      if (labs[y][c] >= 0) overlaps++;
      labs[y][c] = i;
    }
  }
  return { labs, overlaps, outOfBounds };
}

export function connectivity(bricks, dims, labs) {
  const [nx, ny, nz] = dims;
  const N = nx * nz;
  const B = bricks.length / 6;
  const parent = new Int32Array(B);
  for (let i = 0; i < B; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let y = 1; y < ny; y++) {
    for (let c = 0; c < N; c++) {
      const a = labs[y][c], b = labs[y - 1][c];
      if (a >= 0 && b >= 0) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    }
  }
  const size = new Map();
  for (let i = 0; i < B; i++) {
    const r = find(i);
    size.set(r, (size.get(r) || 0) + bricks[i * 6 + 3] * bricks[i * 6 + 4]);
  }
  let mainRoot = -1, best = -1;
  for (const [r, s] of size) if (s > best) { best = s; mainRoot = r; }
  let floating = 0;
  for (let i = 0; i < B; i++) if (find(i) !== mainRoot) floating++;
  return { components: size.size, floating };
}

/** Bricks (above the first layer) with no brick directly underneath: they cannot be placed bottom-up. */
export function hangingCount(bricks, dims, labs) {
  const [nx] = dims;
  const B = bricks.length / 6;
  let hanging = 0;
  for (let i = 0; i < B; i++) {
    const x = bricks[i * 6], y = bricks[i * 6 + 1], z = bricks[i * 6 + 2], w = bricks[i * 6 + 3], d = bricks[i * 6 + 4];
    if (y === 0) continue;
    let ok = false;
    for (let zz = z; zz < z + d && !ok; zz++) for (let xx = x; xx < x + w; xx++) if (labs[y - 1][zz * nx + xx] >= 0) { ok = true; break; }
    if (!ok) hanging++;
  }
  return hanging;
}

/** Fraction of vertical joints that are bridged by a brick in the next layer up. */
export function seamStats(dims, labs) {
  const [nx, ny, nz] = dims;
  let total = 0, bridged = 0;
  for (let y = 0; y + 1 < ny; y++) {
    const a = labs[y], b = labs[y + 1];
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const c = z * nx + x;
      if (a[c] < 0) continue;
      for (let dir = 0; dir < 2; dir++) {
        const q = dir === 0 ? (x + 1 < nx ? c + 1 : -1) : (z + 1 < nz ? c + nx : -1);
        if (q < 0 || a[q] < 0 || a[q] === a[c]) continue;   // not a joint between two bricks
        if (b[c] < 0 || b[q] < 0) continue;                 // nothing above: no crack to bridge
        total++;
        if (b[c] === b[q]) bridged++;
      }
    }
  }
  return { total, bridged, pct: total ? (100 * bridged) / total : 100 };
}

function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }

function convexHull(points) {
  const pts = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Approximate stability: does the centre of mass lie over the footprint of the bottom layer? */
export function balance(bricks, dims, labs) {
  const [nx, ny, nz] = dims;
  let mass = 0, mx = 0, mz = 0;
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    if (labs[y][z * nx + x] < 0) continue;
    mass++; mx += x + 0.5; mz += z + 0.5;
  }
  if (!mass) return { stable: false, margin: 0 };
  mx /= mass; mz /= mass;
  // footprint = convex hull of every cell in the lowest occupied layer
  let base = 0;
  while (base < ny && labs[base].every((v) => v < 0)) base++;
  const pts = [];
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    if (labs[base][z * nx + x] < 0) continue;
    pts.push([x, z], [x + 1, z], [x, z + 1], [x + 1, z + 1]);
  }
  const hull = convexHull(pts);
  if (hull.length < 3) return { stable: false, margin: 0, com: [mx, mz] };
  // signed distance of COM to hull edges (positive = inside)
  let margin = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    margin = Math.min(margin, cross(a, b, [mx, mz]) / len);
  }
  return { stable: margin > 0, margin, com: [mx, mz] };
}

/**
 * Everything the report needs.
 * @param parts  parts used by `bricks` (partIndex → catalogue entry)
 */
export function analyzeLayout(bricks, dims, parts, catalogue, extra = {}) {
  const [nx, ny, nz] = dims;
  const B = bricks.length / 6;
  const { labs, overlaps, outOfBounds } = labelLayers(bricks, dims);
  const conn = connectivity(bricks, dims, labs);
  const seams = seamStats(dims, labs);
  const bal = balance(bricks, dims, labs);
  let cells = 0;
  const known = new Set(catalogue.parts.map((p) => p.id));
  let inCatalogue = 0;
  const usage = new Map();
  for (let i = 0; i < B; i++) {
    cells += bricks[i * 6 + 3] * bricks[i * 6 + 4];
    const part = parts[bricks[i * 6 + 5]];
    if (known.has(part.id) && part.inProduction !== false) inCatalogue++;
    usage.set(part.id, (usage.get(part.id) || 0) + 1);
  }
  let layers = 0;
  for (let y = 0; y < ny; y++) if (labs[y].some((v) => v >= 0)) layers = y + 1;
  return {
    bricks: B,
    cells,
    overlaps, outOfBounds,
    components: conn.components,
    floating: conn.floating,
    hanging: hangingCount(bricks, dims, labs),
    seams,
    balance: bal,
    baseline1x1: cells,
    reductionPct: cells ? (100 * (1 - B / cells)) : 0,
    catalogueOkPct: B ? (100 * inCatalogue) / B : 100,
    uniqueParts: usage.size,
    layers,
    dimsStuds: [nx, ny, nz],
    ...extra,
  };
}
