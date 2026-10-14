// USDZ / GLB import through three.js (the path the browser uses for phone-app exports).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScan } from '../src/core/demo.js';
import { parseWithThree } from '../src/app/threeio.js';
import { weldMesh, bounds } from '../src/core/geometry.js';
import { toUSDZ, toGLB, toUSDA } from './fixtures.js';

const scan = makeScan('compact', { holes: 0, floor: false, clutter: false, cell: 0.004 });

test('R1: USDZ package (USDA layer) loads with every triangle', async () => {
  const bytes = toUSDZ(scan);
  const g = await parseWithThree('usdz', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(g.indices.length, scan.indices.length);
  // the USD composer un-shares vertices; welding gives the original mesh back
  const w = weldMesh(g.positions, g.indices, 1e-6);
  assert.equal(w.positions.length / 3, new Set(scan.indices).size);
  const used = new Float32Array([...new Set(scan.indices)].flatMap((i) => [scan.positions[i * 3], scan.positions[i * 3 + 1], scan.positions[i * 3 + 2]]));
  const a = bounds(w.positions), b = bounds(used);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a.size[i] - b.size[i]) < 1e-4);
});

test('R1: standalone USDA text loads', async () => {
  const bytes = new TextEncoder().encode(toUSDA(scan));
  const g = await parseWithThree('usda', bytes.buffer);
  assert.equal(g.indices.length, scan.indices.length);
});

test('R1: GLB loads with world transforms applied', async () => {
  const bytes = toGLB(scan);
  const g = await parseWithThree('glb', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(g.indices.length, scan.indices.length);
  assert.ok(Math.abs(g.positions[5] - scan.positions[5]) < 1e-5);
});

test('garbage USDZ gives a readable error, not a crash', async () => {
  await assert.rejects(() => parseWithThree('usdz', new Uint8Array([0x50, 0x4b, 1, 2, 3, 4, 5, 6]).buffer));
});
