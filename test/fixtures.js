// Builders for the scan file formats the browser tests feed to the app (USDZ, GLB, ...), written from scratch so
// the tests do not depend on the code under test.

const enc = new TextEncoder();

function crc32(bytes) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < bytes.length; n++) {
    c = (crc ^ bytes[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (stored, no compression) – enough for a USDZ package. */
export function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); header.setUint16(4, 20, true); header.setUint16(8, 0, true);
    header.setUint32(14, crc, true); header.setUint32(18, data.length, true); header.setUint32(22, data.length, true);
    header.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(header.buffer), nameBytes, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nameBytes.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

export function toUSDA(scan) {
  const pts = [];
  for (let i = 0; i < scan.positions.length; i += 3) pts.push(`(${scan.positions[i]}, ${scan.positions[i + 1]}, ${scan.positions[i + 2]})`);
  const tris = scan.indices.length / 3;
  return `#usda 1.0
(
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Root"
{
    def Mesh "Scan"
    {
        int[] faceVertexCounts = [${new Array(tris).fill(3).join(', ')}]
        int[] faceVertexIndices = [${Array.from(scan.indices).join(', ')}]
        point3f[] points = [${pts.join(', ')}]
    }
}
`;
}

export function toUSDZ(scan) {
  return makeZip([['scan.usda', enc.encode(toUSDA(scan))]]);
}

/** Binary glTF with one triangle mesh. */
export function toGLB(scan) {
  const pos = new Float32Array(scan.positions);
  const idx = new Uint32Array(scan.indices);
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pos[i + a]); max[a] = Math.max(max[a], pos[i + a]); }
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const json = {
    asset: { version: '2.0' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
  };
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  const jb = new Uint8Array(jsonBytes.length + jpad).fill(0x20); jb.set(jsonBytes);
  const bpad = (4 - (bin.length % 4)) % 4;
  const bb = new Uint8Array(bin.length + bpad); bb.set(bin);
  const total = 12 + 8 + jb.length + 8 + bb.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
  dv.setUint32(20 + jb.length, bb.length, true); dv.setUint32(24 + jb.length, 0x004e4942, true); out.set(bb, 28 + jb.length);
  return out;
}

/** Binary STL. */
export function toSTL(scan) {
  const tris = scan.indices.length / 3;
  const out = new Uint8Array(84 + tris * 50);
  const dv = new DataView(out.buffer);
  dv.setUint32(80, tris, true);
  for (let t = 0; t < tris; t++) for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) dv.setFloat32(84 + t * 50 + 12 + (k * 3 + a) * 4, scan.positions[scan.indices[t * 3 + k] * 3 + a], true);
  return out;
}
