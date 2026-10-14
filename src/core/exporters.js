// Bill of materials, BrickLink XML, Rebrickable CSV, LDraw and printable instructions.

import { findColor } from '../data/catalogue.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => v.toFixed(2);

/** Parts used by the layout, in a stable order (biggest quantity first). */
export function buildBOM(bricks, parts, catalogue, priceOverrides = {}) {
  const counts = new Map();
  const B = bricks.length / 6;
  for (let i = 0; i < B; i++) {
    const pi = bricks[i * 6 + 5];
    counts.set(pi, (counts.get(pi) || 0) + 1);
  }
  const lines = [];
  for (const [pi, qty] of counts) {
    const part = parts[pi];
    const override = priceOverrides[part.id];
    const unit = override !== undefined ? override : part.price;
    lines.push({
      partIndex: pi, id: part.id, name: part.name, w: part.w, d: part.d, qty,
      unitPrice: unit, total: unit * qty, priceSource: override !== undefined ? 'custom' : 'catalogue',
      bricklink: part.bricklink || part.id, rebrickable: part.rebrickable || part.id, ldraw: part.ldraw || part.id,
    });
  }
  lines.sort((a, b) => b.qty - a.qty || a.id.localeCompare(b.id));
  const totalParts = lines.reduce((s, l) => s + l.qty, 0);
  const totalCost = lines.reduce((s, l) => s + l.total, 0);
  return { lines, totalParts, totalCost, currency: catalogue.currency || 'USD' };
}

export function bricklinkXML(bom, catalogue, colorId) {
  const color = findColor(catalogue, colorId);
  const items = bom.lines.map((l) =>
    `  <ITEM>\n    <ITEMTYPE>P</ITEMTYPE>\n    <ITEMID>${esc(l.bricklink)}</ITEMID>\n    <COLOR>${color.bricklink}</COLOR>\n    <MINQTY>${l.qty}</MINQTY>\n  </ITEM>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<INVENTORY>\n${items.join('\n')}\n</INVENTORY>\n`;
}

export function rebrickableCSV(bom, catalogue, colorId) {
  const color = findColor(catalogue, colorId);
  return ['Part,Color,Quantity', ...bom.lines.map((l) => `${l.rebrickable},${color.rebrickable},${l.qty}`)].join('\n') + '\n';
}

export function bomCSV(bom, catalogue, colorId) {
  const color = findColor(catalogue, colorId);
  const rows = bom.lines.map((l) => `${l.id},"${l.name}",${color.name},${l.qty},${money(l.unitPrice)},${money(l.total)}`);
  return ['Part,Name,Color,Quantity,Unit price (' + bom.currency + '),Total (' + bom.currency + ')', ...rows,
    `Total,,,${bom.totalParts},,${money(bom.totalCost)}`].join('\n') + '\n';
}

/**
 * LDraw model with one `0 STEP` per build step. LDraw: 1 stud = 20 LDU, brick height = 24 LDU, -Y is up and part
 * origins sit at the centre of the top face of a brick.
 */
export function ldrawExport({ bricks, order, steps, parts, catalogue, colorId, dims, name = 'BrickScan model' }) {
  const color = findColor(catalogue, colorId);
  const [nx, , nz] = dims;
  const lines = [`0 ${name}`, '0 Name: brickscan-model.ldr', '0 Author: BrickScan', '0 BFC CERTIFY CCW'];
  for (const st of steps) {
    for (let k = st.start; k < st.start + st.count; k++) {
      const i = order[k];
      const x = bricks[i * 6], y = bricks[i * 6 + 1], z = bricks[i * 6 + 2], w = bricks[i * 6 + 3], d = bricks[i * 6 + 4];
      const part = parts[bricks[i * 6 + 5]];
      const rotate = d > w;
      const cx = (x + w / 2 - nx / 2) * 20;
      const cz = (z + d / 2 - nz / 2) * 20;
      const cy = -(y + 1) * 24;
      const m = rotate ? '0 0 1 0 1 0 -1 0 0' : '1 0 0 0 1 0 0 0 1';
      lines.push(`1 ${color.ldraw} ${cx} ${cy} ${cz} ${m} ${part.ldraw || part.id}.dat`);
    }
    lines.push('0 STEP');
  }
  return lines.join('\n') + '\n';
}

/** Standalone printable HTML with a top-down map of every step (works offline, no dependencies). */
export function instructionsHTML({ title, bricks, order, steps, parts, dims, colorHex, bom, catalogue }) {
  const [nx, , nz] = dims;
  const cell = Math.max(8, Math.min(26, Math.floor(560 / Math.max(nx, nz))));
  const W = nx * cell, H = nz * cell;
  const label = (p) => `${p.d}×${p.w}`;
  const shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
    return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
  };
  const rect = (i, fill, stroke, sw, text) => {
    const x = bricks[i * 6] * cell, z = bricks[i * 6 + 2] * cell, w = bricks[i * 6 + 3] * cell, d = bricks[i * 6 + 4] * cell;
    let s = `<rect x="${x + 0.5}" y="${z + 0.5}" width="${w - 1}" height="${d - 1}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
    if (text && cell >= 12) {
      s += `<text x="${x + w / 2}" y="${z + d / 2 + 4}" text-anchor="middle" font-size="${Math.min(12, cell * 0.5)}" fill="#111">${text}</text>`;
    }
    return s;
  };
  const byLayer = new Map();
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const y = bricks[i * 6 + 1];
    if (!byLayer.has(y)) byLayer.set(y, []);
    byLayer.get(y).push({ i, k });
  }
  const cards = steps.map((st) => {
    const below = (byLayer.get(st.layer - 1) || []).map(({ i }) => rect(i, '#e8e8e8', '#cfcfcf', 1, '')).join('');
    const layerBricks = byLayer.get(st.layer) || [];
    const done = layerBricks.filter(({ k }) => k < st.start).map(({ i }) => rect(i, shade(colorHex, 0.9), '#555', 1, '')).join('');
    const fresh = layerBricks.filter(({ k }) => k >= st.start && k < st.start + st.count);
    const news = fresh.map(({ i }) => rect(i, '#ffd400', '#111', 2, label(parts[bricks[i * 6 + 5]]))).join('');
    const tally = new Map();
    for (const { i } of fresh) tally.set(bricks[i * 6 + 5], (tally.get(bricks[i * 6 + 5]) || 0) + 1);
    const list = [...tally].sort((a, b) => b[1] - a[1]).map(([pi, q]) => `<li><b>${q}×</b> ${esc(parts[pi].name)} <span>(${esc(parts[pi].id)})</span></li>`).join('');
    return `<section class="step"><h2>Step ${st.index + 1} <small>layer ${st.layer + 1}</small></h2>
<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Layer ${st.layer + 1} map">${below}${done}${news}</svg>
<ul>${list}</ul></section>`;
  });
  const bomRows = bom.lines.map((l) => `<tr><td>${esc(l.id)}</td><td>${esc(l.name)}</td><td>${l.qty}</td><td>${money(l.unitPrice)}</td><td>${money(l.total)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} – build instructions</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:24px;color:#111}h1{margin:0 0 4px}.sub{color:#555;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(${Math.max(W + 32, 300)}px,1fr));gap:16px}
.step{border:1px solid #ccc;border-radius:10px;padding:12px;break-inside:avoid;background:#fff}.step h2{margin:0 0 8px;font-size:17px}.step small{color:#777;font-weight:400}
svg{background:#fafafa;border:1px solid #ddd;max-width:100%;height:auto}ul{margin:8px 0 0;padding-left:18px}li span{color:#777}
table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:4px 10px;text-align:left}
.legend{margin:6px 0 18px;color:#444}@media print{body{margin:8px}.grid{grid-template-columns:repeat(2,1fr)}}</style></head><body>
<h1>${esc(title)}</h1>
<div class="sub">${nx} × ${nz} studs footprint · ${steps.length} steps · ${bom.totalParts} parts · est. ${money(bom.totalCost)} ${esc(bom.currency)}</div>
<div class="legend">Top-down view of one layer per step. <b style="background:#ffd400;padding:0 6px;border:1px solid #111">Yellow</b> = bricks to place now, coloured = already placed in this layer, grey = layer below.</div>
<h2>Parts list</h2><table><tr><th>Part</th><th>Name</th><th>Qty</th><th>Unit</th><th>Total</th></tr>${bomRows}</table>
<h2 style="margin-top:24px">Steps</h2><div class="grid">${cards.join('\n')}</div></body></html>`;
}
