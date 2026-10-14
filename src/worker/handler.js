// Message handler shared by the Web Worker and the in-page fallback. All heavy work happens here.
//
// Requests: { id, type, payload }. Replies: { id, kind: 'result' | 'progress' | 'error' | 'cancelled', ... }.
// A newer load / clean / build request makes older ones stale; they stop at their next yield and answer 'cancelled'.

import { Engine } from '../core/engine.js';
import { Cancelled, createJob } from '../core/util.js';

const STATEFUL = new Set(['load', 'demo', 'clean', 'build']);

const copyOf = (a) => (a ? a.slice() : a);

function serializeClean(c) {
  return {
    kind: c.kind,
    positions: copyOf(c.positions),
    indices: copyOf(c.indices),
    size: c.size, sizeMM: c.sizeMM, unit: c.unit, mmPerUnit: c.mmPerUnit,
    up: c.up, yaw: c.yaw, origin: c.origin, decimated: c.decimated,
    floor: c.floor ? { y: c.floor.y, share: c.floor.share, range: c.floor.range, manual: !!c.floor.manual } : null,
    stats: c.stats, log: c.log,
  };
}

function serializeModel(m) {
  return {
    bricks: copyOf(m.bricks), order: copyOf(m.order), steps: m.steps, parts: m.parts, dims: m.dims, mm: m.mm,
    bom: m.bom, report: m.report, scale: m.scale, timings: m.timings, params: m.params,
  };
}

export function createHandler(post) {
  const engine = new Engine();
  let token = 0;

  const handlers = {
    async load(payload) {
      const summary = engine.load(payload);
      return { value: summary, transfer: [summary.preview.positions.buffer, summary.preview.indices && summary.preview.indices.buffer] };
    },
    async demo(payload) {
      const summary = engine.loadDemo(payload.shape, payload.options);
      return { value: summary, transfer: [summary.preview.positions.buffer, summary.preview.indices && summary.preview.indices.buffer] };
    },
    async clean(payload, job) {
      const c = await engine.runClean(payload, job);
      const value = serializeClean(c);
      return { value, transfer: [value.positions.buffer, value.indices && value.indices.buffer] };
    },
    async build(payload, job) {
      const m = await engine.runBuild(payload, job);
      const value = serializeModel(m);
      return { value, transfer: [value.bricks.buffer, value.order.buffer] };
    },
    async catalogue(payload) {
      engine.setCatalogue(payload.catalogue, payload.prices);
      return { value: { ok: true, name: engine.catalogue.name, version: engine.catalogue.version, parts: engine.catalogue.parts.length } };
    },
  };

  return async function onMessage(msg) {
    const { id, type, payload } = msg;
    const mine = STATEFUL.has(type) ? ++token : token;
    const job = createJob({
      isStale: () => token !== mine,
      onProgress: (p) => post({ id, kind: 'progress', ...p }),
    });
    try {
      const fn = handlers[type];
      if (!fn) throw new Error('Unknown request ' + type);
      const { value, transfer } = await fn(payload, job);
      if (STATEFUL.has(type) && token !== mine) throw new Cancelled();
      post({ id, kind: 'result', value, timings: job.timings }, (transfer || []).filter(Boolean));
    } catch (e) {
      if (e instanceof Cancelled || e.name === 'Cancelled') post({ id, kind: 'cancelled' });
      else post({ id, kind: 'error', message: e && e.message ? e.message : String(e) });
    }
  };
}
