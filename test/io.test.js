// Parsers (R1) and exporters (R7, R9).

import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './helpers.js';
import { makeScan, toOBJ, toPLY } from '../src/core/demo.js';
import { parseOBJ, parsePLY, parseSTL, parseMeshFile, detectFormat } from '../src/core/parsers.js';
import { bricklinkXML, rebrickableCSV, bomCSV, ldrawExport, instructionsHTML, buildBOM } from '../src/core/exporters.js';
import { CATALOGUE } from '../src/data/catalogue.js';
import { labelLayers } from '../src/core/analysis.js';

const tiny = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]),
});

test('R1: OBJ with quads, negative indices, v/vt/vn tokens, comments and CRLF', () => {
  const text = [
    '# comment', 'mtllib x.mtl', 'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'v 0 0 1e0', 'vt 0 0', 'vn 0 0 1',
    'f 1/1/1 2/1/1 3/1/1 4/1/1', 'f -1 -2 -3', 'o x', '',
  ].join('\r\n');
  const m = parseOBJ(new TextEncoder().encode(text));
  assert.equal(m.positions.length, 15);
  assert.equal(m.indices.length, 9);                       // quad → 2 triangles, plus 1 triangle
  assert.deepEqual(Array.from(m.indices.slice(6)), [4, 3, 2]);
});

test('R1: OBJ round trip of a whole demo scan', () => {
  const scan = makeScan('compact');
  const back = parseOBJ(new TextEncoder().encode(toOBJ(scan)));
  assert.equal(back.indices.length, scan.indices.length);
  assert.equal(back.positions.length, scan.positions.length);
  for (let i = 0; i < 300; i++) assert.ok(Math.abs(back.positions[i] - scan.positions[i]) < 1e-5);
});

test('R1: binary PLY mesh and point cloud, ASCII PLY, big-endian PLY', () => {
  const scan = makeScan('sphere', { holes: 0 });
  const mesh = parsePLY(toPLY(scan));
  assert.equal(mesh.indices.length, scan.indices.length);
  assert.ok(Math.abs(mesh.positions[10] - scan.positions[10]) < 1e-6);

  const cloud = parsePLY(toPLY({ positions: scan.positions, indices: null }));
  assert.equal(cloud.indices, null);
  assert.equal(cloud.positions.length, scan.positions.length);

  const ascii = [
    'ply', 'format ascii 1.0', 'comment hi', 'element vertex 4', 'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue', 'element face 2', 'property list uchar int vertex_indices', 'end_header',
    '0 0 0 255 0 0', '1 0 0 0 255 0', '1 1 0 0 0 255', '0 1 0 9 9 9', '3 0 1 2', '4 0 1 2 3',
  ].join('\n');
  const a = parsePLY(new TextEncoder().encode(ascii));
  assert.equal(a.positions.length, 12);
  assert.equal(a.indices.length, 9);

  // big endian with extra float normal properties
  const head = 'ply\nformat binary_big_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nelement face 1\nproperty list uchar uint vertex_indices\nend_header\n';
  const hb = new TextEncoder().encode(head);
  const buf = new Uint8Array(hb.length + 3 * 16 + 13);
  buf.set(hb);
  const dv = new DataView(buf.buffer);
  let p = hb.length;
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((v) => { v.forEach((c) => { dv.setFloat32(p, c, false); p += 4; }); dv.setFloat32(p, 9, false); p += 4; });
  dv.setUint8(p++, 3); [0, 1, 2].forEach((i) => { dv.setUint32(p, i, false); p += 4; });
  const be = parsePLY(buf);
  assert.deepEqual(Array.from(be.positions.slice(3, 6)), [1, 0, 0]);
  assert.deepEqual(Array.from(be.indices), [0, 1, 2]);
});

test('R1: STL binary and ASCII', () => {
  const t = tiny();
  const bin = new Uint8Array(84 + 50 * 4);
  const dv = new DataView(bin.buffer);
  dv.setUint32(80, 4, true);
  for (let f = 0; f < 4; f++) for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) dv.setFloat32(84 + f * 50 + 12 + (k * 3 + a) * 4, t.positions[t.indices[f * 3 + k] * 3 + a], true);
  const b = parseSTL(bin);
  assert.equal(b.indices.length, 12);
  const asciiText = 'solid x\n' + [0, 1, 2, 3].map((f) => 'facet normal 0 0 1\nouter loop\n' + [0, 1, 2].map((k) => `vertex ${t.positions[t.indices[f * 3 + k] * 3]} ${t.positions[t.indices[f * 3 + k] * 3 + 1]} ${t.positions[t.indices[f * 3 + k] * 3 + 2]}`).join('\n') + '\nendloop\nendfacet').join('\n') + '\nendsolid\n';
  const a = parseSTL(new TextEncoder().encode(asciiText));
  assert.equal(a.indices.length, 12);
});

test('R1: format detection and clear errors', () => {
  assert.equal(detectFormat('Scan.OBJ'), 'obj');
  assert.equal(detectFormat('x.usdz'), 'usdz');
  assert.equal(detectFormat('noext', new Uint8Array([0x70, 0x6c, 0x79, 0x0a])), 'ply');
  assert.throws(() => parseMeshFile('a.txt', new ArrayBuffer(8)), /Unsupported/);
  assert.throws(() => parseOBJ(new TextEncoder().encode('# nothing')), /no vertices/);
});

async function model() {
  const { model } = await run('controller', {}, {}, { value: 24 });
  return model;
}

test('R7: BrickLink XML and Rebrickable CSV list the same parts, with the default colour and totals that add up', async () => {
  const m = await model();
  const xml = bricklinkXML(m.bom, CATALOGUE, 'lbg');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<INVENTORY>/);
  const items = [...xml.matchAll(/<ITEM>\s*<ITEMTYPE>P<\/ITEMTYPE>\s*<ITEMID>([^<]+)<\/ITEMID>\s*<COLOR>(\d+)<\/COLOR>\s*<MINQTY>(\d+)<\/MINQTY>\s*<\/ITEM>/g)];
  assert.equal(items.length, m.bom.lines.length);
  assert.ok(items.every((x) => x[2] === '86'));
  assert.equal(items.reduce((s, x) => s + Number(x[3]), 0), m.report.bricks);

  const csv = rebrickableCSV(m.bom, CATALOGUE, 'lbg').trim().split('\n');
  assert.equal(csv[0], 'Part,Color,Quantity');
  assert.equal(csv.length - 1, m.bom.lines.length);
  assert.ok(csv.slice(1).every((l) => l.split(',')[1] === '71'));
  assert.equal(csv.slice(1).reduce((s, l) => s + Number(l.split(',')[2]), 0), m.report.bricks);

  const bom = bomCSV(m.bom, CATALOGUE, 'lbg');
  assert.match(bom, /Total,,,/);
  assert.ok(m.bom.totalCost > 0);
  // custom prices override the catalogue
  const priced = buildBOM(m.bricks, m.parts, CATALOGUE, { '3005': 1 });
  assert.ok(priced.totalCost > m.bom.totalCost);
});

test('R9: LDraw file reproduces the model exactly (positions, rotation, steps)', async () => {
  const m = await model();
  const ldr = ldrawExport({ bricks: m.bricks, order: m.order, steps: m.steps, parts: m.parts, catalogue: CATALOGUE, colorId: 'lbg', dims: m.dims });
  const lines = ldr.trim().split('\n');
  assert.ok(lines[0].startsWith('0 '));
  assert.equal(lines.filter((l) => l === '0 STEP').length, m.steps.length);
  const refs = lines.filter((l) => l.startsWith('1 '));
  assert.equal(refs.length, m.report.bricks);

  // Re-derive occupancy from the LDraw lines and compare with the brick list.
  const [nx, ny, nz] = m.dims;
  const want = new Set();
  const { labs } = labelLayers(m.bricks, m.dims);
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) if (labs[y][z * nx + x] >= 0) want.add(`${x},${y},${z}`);
  const got = new Set();
  const files = {};
  for (const p of CATALOGUE.parts) files[`${p.ldraw}.dat`] = p;
  for (const l of refs) {
    const t = l.split(/\s+/);
    assert.equal(t[1], '71');
    const [x, y, z] = [Number(t[2]), Number(t[3]), Number(t[4])];
    const mat = t.slice(5, 14).map(Number);
    const part = files[t[14]];
    assert.ok(part, `unknown file ${t[14]}`);
    // native footprint: part.w along X, part.d along Z (LDU: 20 per stud), origin on the top face centre
    const rotated = mat[2] === 1;
    const sx = rotated ? part.d : part.w, sz = rotated ? part.w : part.d;
    if (rotated) assert.deepEqual(mat, [0, 0, 1, 0, 1, 0, -1, 0, 0]); else assert.deepEqual(mat, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const layer = Math.round(-y / 24) - 1;
    const x0 = Math.round((x - sx * 10) / 20 + nx / 2), z0 = Math.round((z - sz * 10) / 20 + nz / 2);
    for (let zz = z0; zz < z0 + sz; zz++) for (let xx = x0; xx < x0 + sx; xx++) {
      const key = `${xx},${layer},${zz}`;
      assert.ok(!got.has(key), 'overlap in LDraw');
      got.add(key);
    }
  }
  assert.equal(got.size, want.size);
  for (const k of want) assert.ok(got.has(k), `missing ${k}`);
});

test('printable instructions: one card per step, standalone HTML', async () => {
  const m = await model();
  const html = instructionsHTML({ title: 'Test', bricks: m.bricks, order: m.order, steps: m.steps, parts: m.parts, dims: m.dims, colorHex: '#a0a5a9', bom: m.bom, catalogue: CATALOGUE });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.equal((html.match(/<section class="step">/g) || []).length, m.steps.length);
  assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]+"/g, '')), 'no external resources');
});
