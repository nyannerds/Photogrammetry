// Web Worker entry point (bundled to a string and started from a Blob URL so it also works from file://).
import { createHandler } from './handler.js';

const handle = createHandler((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = (ev) => { handle(ev.data); };
