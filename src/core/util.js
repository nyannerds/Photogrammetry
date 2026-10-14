// Shared helpers: timing, cooperative job control, seeded RNG.

export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

const sleep0 = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A job lets long synchronous algorithms yield to the event loop every ~30 ms so that
 * (a) the worker can receive a newer request and abandon this one, and (b) progress can be posted.
 */
export function createJob({ isStale = () => false, onProgress = () => {} } = {}) {
  let last = now();
  const job = {
    timings: {},
    async tick() {
      if (now() - last > 30) {
        await sleep0();
        last = now();
        if (isStale()) throw new Cancelled();
      }
    },
    progress(stage, frac, text) {
      onProgress({ stage, frac, text });
    },
    async time(name, fn) {
      const t = now();
      try {
        return await fn();
      } finally {
        job.timings[name] = (job.timings[name] || 0) + (now() - t);
      }
    },
  };
  return job;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Grow-able typed array (amortised doubling) used by parsers. */
export class Growable {
  constructor(Type, initial = 1 << 16) {
    this.Type = Type;
    this.data = new Type(initial);
    this.length = 0;
  }
  push(v) {
    if (this.length === this.data.length) {
      const next = new this.Type(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  toArray() {
    return this.data.slice(0, this.length);
  }
}
