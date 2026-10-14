// Talks to the processing engine: a Web Worker when possible, otherwise the same code running on the page.

import { createHandler } from '../worker/handler.js';

export class Host {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.mode = 'worker';
    this.worker = null;
    try {
      const src = document.getElementById('worker-src');
      if (!src) throw new Error('no embedded worker');
      const blob = new Blob([src.textContent], { type: 'text/javascript' });
      this.url = URL.createObjectURL(blob);
      this.worker = new Worker(this.url);
      this.worker.onmessage = (ev) => this.receive(ev.data);
      this.worker.onerror = (ev) => {
        // a worker that fails to start (some locked-down browsers): fall back to running on the page
        if (this.pending.size === 0 || this.mode === 'worker') this.fallback(ev && ev.message);
      };
    } catch (e) {
      this.fallback(e && e.message);
    }
  }

  fallback(reason) {
    if (this.mode === 'inline') return;
    this.mode = 'inline';
    this.reason = reason;
    if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } }
    this.worker = null;
    this.inline = createHandler((msg) => this.receive(msg));
    // re-send anything that was waiting on the dead worker
    for (const [, p] of this.pending) this.inline({ id: p.id, type: p.type, payload: p.payload });
  }

  receive(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.kind === 'progress') { if (p.onProgress) p.onProgress(msg); return; }
    this.pending.delete(msg.id);
    if (msg.kind === 'result') p.resolve({ value: msg.value, timings: msg.timings });
    else if (msg.kind === 'cancelled') p.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    else p.reject(new Error(msg.message));
  }

  call(type, payload, { transfer = [], onProgress } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { id, type, payload, resolve, reject, onProgress });
      if (this.mode === 'worker') {
        try {
          this.worker.postMessage({ id, type, payload }, transfer.filter(Boolean));
        } catch (e) {
          this.fallback(e.message);
        }
      } else {
        // the inline engine keeps its own copies; avoid detaching the caller's buffers
        this.inline({ id, type, payload });
      }
    });
  }
}
