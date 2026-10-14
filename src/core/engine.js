// The engine owns the session state (raw scan → cleaned scan → model) and is used by the Web Worker, by the
// in-page fallback and directly by the tests.

import { parseMeshFile } from './parsers.js';
import { prepareRaw, cleanScan, DEFAULT_CLEAN } from './cleanup.js';
import { buildModel } from './pipeline.js';
import { clusterDecimate } from './geometry.js';
import { makeScan } from './demo.js';
import { CATALOGUE, validateCatalogue } from '../data/catalogue.js';

const PREVIEW_FACES = 120000;
const PREVIEW_POINTS = 150000;

export class Engine {
  constructor() {
    this.raw = null;
    this.clean = null;
    this.model = null;
    this.catalogue = CATALOGUE;
    this.prices = {};
  }

  setCatalogue(cat, prices) {
    if (cat) { validateCatalogue(cat); this.catalogue = cat; }
    if (prices) this.prices = prices;
  }

  /** Load from a file buffer (OBJ/PLY/STL) or from already-parsed geometry (USDZ/GLB parsed by three.js). */
  load({ name, buffer, geometry }) {
    const parsed = geometry
      ? { positions: geometry.positions, indices: geometry.indices || null, format: geometry.format || 'mesh' }
      : parseMeshFile(name, buffer);
    this.raw = prepareRaw(parsed, name);
    this.clean = null;
    this.model = null;
    return this.summarizeRaw();
  }

  loadDemo(shape, options) {
    const scan = makeScan(shape, options);
    this.raw = prepareRaw({ positions: scan.positions, indices: scan.indices, format: 'demo' }, `${shape}.demo`);
    this.raw.truth = scan.truth;
    this.clean = null;
    this.model = null;
    return this.summarizeRaw();
  }

  summarizeRaw() {
    const r = this.raw;
    let preview;
    if (r.kind === 'mesh') {
      const d = clusterDecimate(r.positions, r.indices, PREVIEW_FACES);
      preview = { kind: 'mesh', positions: d.decimated ? d.positions : r.positions.slice(), indices: d.decimated ? d.indices : r.indices.slice() };
    } else {
      const n = r.positions.length / 3;
      const step = Math.max(1, Math.ceil(n / PREVIEW_POINTS));
      const out = new Float32Array(Math.ceil(n / step) * 3);
      let o = 0;
      for (let i = 0; i < n; i += step) { out[o++] = r.positions[i * 3]; out[o++] = r.positions[i * 3 + 1]; out[o++] = r.positions[i * 3 + 2]; }
      preview = { kind: 'points', positions: out.slice(0, o), indices: null };
    }
    return {
      fileName: r.fileName, kind: r.kind, format: r.format, stats: r.stats, bounds: r.bounds,
      upGuess: r.upGuess, upConfidence: r.upConfidence, preview,
    };
  }

  async runClean(params, job) {
    if (!this.raw) throw new Error('Load a scan first.');
    const c = await cleanScan(this.raw, { ...DEFAULT_CLEAN, ...params }, job);
    this.clean = c;
    this.model = null;
    return c;
  }

  async runBuild(params, job) {
    if (!this.clean) throw new Error('Clean the scan first.');
    const m = await buildModel(this.clean, params, this.catalogue, job, this.prices);
    this.model = m;
    return m;
  }
}
