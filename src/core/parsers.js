// Fast, dependency-free parsers for the mesh / point-cloud formats phone scanning apps export.
// OBJ, PLY (ASCII + binary) and STL run inside the worker; USDZ / GLB are parsed with three.js on
// the main thread (see app/threeio.js) and arrive here as ready-made typed arrays.
//
// Every parser returns { positions: Float32Array, indices: Uint32Array | null, format }.
// indices === null means the file is a point cloud.

import { Growable } from './util.js';

export function detectFormat(name, bytes) {
  const lower = (name || '').toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (['obj', 'ply', 'stl', 'usdz', 'usd', 'usda', 'usdc', 'glb', 'gltf'].includes(ext)) return ext;
  if (bytes && bytes.length >= 4) {
    const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (head.startsWith('ply')) return 'ply';
    if (head === 'glTF') return 'glb';
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'usdz';
    if (head === 'PXR-') return 'usdc';
    if (head === 'soli') return 'stl';
  }
  return ext || 'unknown';
}

// ---------------------------------------------------------------------------------------------
// OBJ
// ---------------------------------------------------------------------------------------------

export function parseOBJ(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const n = u8.length;
  const pos = new Growable(Float32Array, 3 * 65536);
  const idx = new Growable(Uint32Array, 3 * 65536);
  let vcount = 0;
  let i = 0;

  const readNumber = () => {
    let c = u8[i];
    let neg = false;
    if (c === 45) { neg = true; c = u8[++i]; } else if (c === 43) c = u8[++i];
    let v = 0;
    while (c >= 48 && c <= 57) { v = v * 10 + (c - 48); c = u8[++i]; }
    if (c === 46) {
      c = u8[++i];
      let frac = 0;
      let scale = 1;
      while (c >= 48 && c <= 57) { frac = frac * 10 + (c - 48); scale *= 10; c = u8[++i]; }
      v += frac / scale;
    }
    if (c === 101 || c === 69) {
      c = u8[++i];
      let eneg = false;
      if (c === 45) { eneg = true; c = u8[++i]; } else if (c === 43) c = u8[++i];
      let e = 0;
      while (c >= 48 && c <= 57) { e = e * 10 + (c - 48); c = u8[++i]; }
      v *= Math.pow(10, eneg ? -e : e);
    }
    return neg ? -v : v;
  };
  const skipBlanks = () => { while (u8[i] === 32 || u8[i] === 9) i++; };
  const skipLine = () => { while (i < n && u8[i] !== 10 && u8[i] !== 13) i++; };

  const face = [];
  while (i < n) {
    skipBlanks();
    const c = u8[i];
    if (c === 118 && (u8[i + 1] === 32 || u8[i + 1] === 9)) { // "v "
      i += 2;
      skipBlanks();
      const x = readNumber(); skipBlanks();
      const y = readNumber(); skipBlanks();
      const z = readNumber();
      pos.push(x); pos.push(y); pos.push(z);
      vcount++;
    } else if (c === 102 && (u8[i + 1] === 32 || u8[i + 1] === 9)) { // "f "
      i += 2;
      face.length = 0;
      for (;;) {
        skipBlanks();
        const d = u8[i];
        if (d === 10 || d === 13 || i >= n || d === 35) break;
        let neg = false;
        let k = u8[i];
        if (k === 45) { neg = true; k = u8[++i]; }
        let v = 0;
        let digits = 0;
        while (k >= 48 && k <= 57) { v = v * 10 + (k - 48); k = u8[++i]; digits++; }
        if (digits === 0) { i++; continue; }
        face.push(neg ? vcount - v : v - 1);
        while (i < n && u8[i] !== 32 && u8[i] !== 9 && u8[i] !== 10 && u8[i] !== 13) i++; // skip /vt/vn
      }
      for (let k = 1; k + 1 < face.length; k++) {
        const a = face[0], b = face[k], cc = face[k + 1];
        if (a >= 0 && b >= 0 && cc >= 0) { idx.push(a); idx.push(b); idx.push(cc); }
      }
    }
    skipLine();
    while (i < n && (u8[i] === 10 || u8[i] === 13)) i++;
  }
  const positions = pos.toArray();
  let indices = idx.length ? idx.toArray() : null;
  if (indices) indices = sanitizeIndices(indices, vcount);
  if (!vcount) throw new Error('OBJ file contains no vertices.');
  return { positions, indices, format: 'obj' };
}

/** Drop triangles referencing vertices that do not exist (corrupt files). */
function sanitizeIndices(indices, vcount) {
  let bad = false;
  for (let k = 0; k < indices.length; k++) if (indices[k] >= vcount) { bad = true; break; }
  if (!bad) return indices;
  const out = new Growable(Uint32Array, indices.length);
  for (let t = 0; t < indices.length; t += 3) {
    if (indices[t] < vcount && indices[t + 1] < vcount && indices[t + 2] < vcount) {
      out.push(indices[t]); out.push(indices[t + 1]); out.push(indices[t + 2]);
    }
  }
  return out.toArray();
}

// ---------------------------------------------------------------------------------------------
// PLY
// ---------------------------------------------------------------------------------------------

const PLY_TYPES = {
  char: ['i8', 1], int8: ['i8', 1], uchar: ['u8', 1], uint8: ['u8', 1],
  short: ['i16', 2], int16: ['i16', 2], ushort: ['u16', 2], uint16: ['u16', 2],
  int: ['i32', 4], int32: ['i32', 4], uint: ['u32', 4], uint32: ['u32', 4],
  float: ['f32', 4], float32: ['f32', 4], double: ['f64', 8], float64: ['f64', 8],
};

export function parsePLY(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  // locate end_header
  let headerEnd = -1;
  const key = 'end_header';
  outer: for (let i = 0; i < Math.min(u8.length - key.length, 65536); i++) {
    for (let k = 0; k < key.length; k++) if (u8[i + k] !== key.charCodeAt(k)) continue outer;
    headerEnd = i + key.length;
    break;
  }
  if (headerEnd < 0) throw new Error('PLY: end_header not found.');
  let bodyStart = headerEnd;
  if (u8[bodyStart] === 13) bodyStart++;
  if (u8[bodyStart] === 10) bodyStart++;
  const header = new TextDecoder().decode(u8.subarray(0, headerEnd)).split(/\r?\n/);
  if (header[0].trim() !== 'ply') throw new Error('Not a PLY file.');

  let format = 'ascii';
  const elements = [];
  for (const raw of header) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] === 'format') format = parts[1];
    else if (parts[0] === 'element') elements.push({ name: parts[1], count: parseInt(parts[2], 10), props: [] });
    else if (parts[0] === 'property' && elements.length) {
      if (parts[1] === 'list') {
        elements[elements.length - 1].props.push({ name: parts[4], list: true, countType: parts[2], type: parts[3] });
      } else {
        elements[elements.length - 1].props.push({ name: parts[2], list: false, type: parts[1] });
      }
    }
  }
  const ascii = format === 'ascii';
  const little = format === 'binary_little_endian';
  if (!ascii && !little && format !== 'binary_big_endian') throw new Error('PLY: unsupported format ' + format);

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = bodyStart;

  // Reader for ASCII (numbers separated by whitespace) or binary scalars.
  const readAscii = () => {
    while (p < u8.length && (u8[p] === 32 || u8[p] === 10 || u8[p] === 13 || u8[p] === 9)) p++;
    let neg = false;
    let c = u8[p];
    if (c === 45) { neg = true; c = u8[++p]; } else if (c === 43) c = u8[++p];
    let v = 0;
    while (c >= 48 && c <= 57) { v = v * 10 + (c - 48); c = u8[++p]; }
    if (c === 46) {
      c = u8[++p];
      let frac = 0, scale = 1;
      while (c >= 48 && c <= 57) { frac = frac * 10 + (c - 48); scale *= 10; c = u8[++p]; }
      v += frac / scale;
    }
    if (c === 101 || c === 69) {
      c = u8[++p];
      let eneg = false;
      if (c === 45) { eneg = true; c = u8[++p]; } else if (c === 43) c = u8[++p];
      let e = 0;
      while (c >= 48 && c <= 57) { e = e * 10 + (c - 48); c = u8[++p]; }
      v *= Math.pow(10, eneg ? -e : e);
    }
    return neg ? -v : v;
  };
  const readBinary = (type) => {
    const [t, size] = PLY_TYPES[type];
    let v;
    switch (t) {
      case 'i8': v = dv.getInt8(p); break;
      case 'u8': v = dv.getUint8(p); break;
      case 'i16': v = dv.getInt16(p, little); break;
      case 'u16': v = dv.getUint16(p, little); break;
      case 'i32': v = dv.getInt32(p, little); break;
      case 'u32': v = dv.getUint32(p, little); break;
      case 'f32': v = dv.getFloat32(p, little); break;
      default: v = dv.getFloat64(p, little);
    }
    p += size;
    return v;
  };
  const read = ascii ? () => readAscii() : readBinary;

  let positions = null;
  const idx = new Growable(Uint32Array, 3 * 65536);
  let vcount = 0;
  for (const el of elements) {
    if (el.name === 'vertex') {
      vcount = el.count;
      positions = new Float32Array(el.count * 3);
      const slots = el.props.map((pr) => (pr.name === 'x' ? 0 : pr.name === 'y' ? 1 : pr.name === 'z' ? 2 : -1));
      for (let v = 0; v < el.count; v++) {
        for (let k = 0; k < el.props.length; k++) {
          const pr = el.props[k];
          if (pr.list) {
            const cnt = ascii ? readAscii() : readBinary(pr.countType);
            for (let q = 0; q < cnt; q++) ascii ? readAscii() : readBinary(pr.type);
          } else {
            const val = ascii ? readAscii() : readBinary(pr.type);
            if (slots[k] >= 0) positions[v * 3 + slots[k]] = val;
          }
        }
      }
    } else {
      for (let f = 0; f < el.count; f++) {
        for (const pr of el.props) {
          if (pr.list) {
            const cnt = ascii ? readAscii() : readBinary(pr.countType);
            const isFace = el.name === 'face' && (pr.name === 'vertex_indices' || pr.name === 'vertex_index');
            if (isFace && cnt >= 3) {
              const first = read(pr.type);
              let prev = read(pr.type);
              for (let q = 2; q < cnt; q++) {
                const cur = read(pr.type);
                idx.push(first); idx.push(prev); idx.push(cur);
                prev = cur;
              }
            } else {
              for (let q = 0; q < cnt; q++) ascii ? readAscii() : readBinary(pr.type);
            }
          } else {
            ascii ? readAscii() : readBinary(pr.type);
          }
        }
      }
    }
  }
  if (!positions || !vcount) throw new Error('PLY file contains no vertices.');
  let indices = idx.length ? idx.toArray() : null;
  if (indices) indices = sanitizeIndices(indices, vcount);
  return { positions, indices, format: 'ply' };
}

// ---------------------------------------------------------------------------------------------
// STL (binary + ASCII). STL has no shared vertices; geometry.weld() merges them afterwards.
// ---------------------------------------------------------------------------------------------

export function parseSTL(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length >= 84) {
    const tris = dv.getUint32(80, true);
    if (84 + tris * 50 === u8.length) {
      const positions = new Float32Array(tris * 9);
      for (let t = 0; t < tris; t++) {
        const off = 84 + t * 50 + 12;
        for (let k = 0; k < 9; k++) positions[t * 9 + k] = dv.getFloat32(off + k * 4, true);
      }
      return { positions, indices: sequential(tris * 3), format: 'stl' };
    }
  }
  const text = new TextDecoder().decode(u8);
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  const pos = new Growable(Float32Array, 3 * 65536);
  let m;
  let count = 0;
  while ((m = re.exec(text))) {
    pos.push(parseFloat(m[1])); pos.push(parseFloat(m[2])); pos.push(parseFloat(m[3]));
    count++;
  }
  if (!count || count % 3) throw new Error('STL: could not read triangles.');
  return { positions: pos.toArray(), indices: sequential(count), format: 'stl' };
}

function sequential(n) {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/** Dispatch by detected format. USD / GLB formats must be converted beforehand on the main thread. */
export function parseMeshFile(name, buffer) {
  const bytes = new Uint8Array(buffer);
  const fmt = detectFormat(name, bytes);
  switch (fmt) {
    case 'obj': return parseOBJ(bytes);
    case 'ply': return parsePLY(bytes);
    case 'stl': return parseSTL(bytes);
    default: throw new Error(`Unsupported file type ".${fmt}". Use OBJ, PLY, USDZ, GLB or STL.`);
  }
}
