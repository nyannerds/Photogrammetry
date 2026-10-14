// BrickScan UI: wires the controls to the processing engine and renders the results.

import { Host } from './host.js';
import { Viewer } from './viewer.js';
import { parseWithThree } from './threeio.js';
import { detectFormat } from '../core/parsers.js';
import { CATALOGUE, findColor, validateCatalogue } from '../data/catalogue.js';
import { buildBOM, bricklinkXML, rebrickableCSV, bomCSV, ldrawExport, instructionsHTML } from '../core/exporters.js';
import { CELL_MM } from '../core/voxelize.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtCm = (mm) => (mm / 10).toFixed(1);

const store = {
  get(key, fallback) { try { const v = localStorage.getItem('brickscan.' + key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
  set(key, value) { try { localStorage.setItem('brickscan.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
};

const state = {
  catalogue: CATALOGUE,
  prices: store.get('prices', {}),
  raw: null, clean: null, model: null,
  view: 'bricks', step: 1, playing: false,
  runSeq: 0, lastMs: 0, lastBuildMs: 0, firstClean: true,
};

const host = new Host();
const viewer = new Viewer($('viewport'));
if (!viewer.ok) showToast('3D view unavailable: your browser could not start WebGL. Results and exports still work.', 'error', 9000);

// ----------------------------------------------------------------------------------------------------------------
// small UI helpers
// ----------------------------------------------------------------------------------------------------------------
let toastTimer;
function showToast(text, kind = 'error', ms = 6000) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast' + (kind === 'info' ? ' info' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function setStatus(text, frac, error = false) {
  const s = $('status');
  if (!text) { s.hidden = true; return; }
  s.hidden = false;
  s.classList.toggle('error', error);
  $('status-text').textContent = text;
  $('bar').style.width = `${Math.round((frac ?? 0) * 100)}%`;
}

function download(name, data, type) {
  const blob = new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ----------------------------------------------------------------------------------------------------------------
// settings → parameters
// ----------------------------------------------------------------------------------------------------------------
function cleanParams() {
  const r = (id) => Number($(id).value) / 100;
  const pair = (a, b) => [Math.min(r(a), r(b)), Math.max(r(a), r(b))];
  const crop = { x: pair('cropX0', 'cropX1'), y: pair('cropY0', 'cropY1'), z: pair('cropZ0', 'cropZ1') };
  const active = Object.values(crop).some(([a, b]) => a > 0 || b < 1);
  const mode = $('yawMode').value;
  return {
    up: $('up').value,
    floor: $('floor').checked,
    floorAt: $('floorManual').checked ? Number($('floorAt').value) / 100 : 'auto',
    floorMargin: Number($('floorMargin').value) / 100,
    keep: $('keep').value,
    minPiece: Number($('minPiece').value) / 100,
    crop: active ? crop : null,
    yaw: mode === 'auto' ? 'auto' : mode === 'off' ? 0 : Number($('yawDeg').value) || 0,
    unit: $('unit').value,
  };
}

function buildParams() {
  const num = (id) => Number($(id).value);
  const opt = (id) => ($(id).value === 'auto' ? 'auto' : num(id));
  return {
    scaleMode: $('scaleMode').value,
    value: num('sizeNum'),
    hollow: num('hollow'),
    pillar: num('pillar'),
    seal: opt('seal'),
    quality: $('quality').value,
    brickSet: $('brickSet').value,
    color: $('color').value,
    maxPerStep: Math.max(4, num('maxPerStep') || 20),
    ss: opt('ss'),
  };
}

// ----------------------------------------------------------------------------------------------------------------
// running the pipeline (debounced; a newer run cancels the older one inside the worker)
// ----------------------------------------------------------------------------------------------------------------
let timer = null;
let pendingFrom = null;

function schedule(from, delay = 320) {
  if (!state.raw) return;
  pendingFrom = pendingFrom === 'clean' || from === 'clean' ? 'clean' : 'build';
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

function onProgress(p) {
  const base = p.stage === 'voxel' ? 0.3 : p.stage === 'layout' ? 0.5 + 0.45 * (p.frac || 0) : 0.15;
  setStatus(p.text || 'Working…', base);
}

async function run() {
  const from = pendingFrom || 'build';
  pendingFrom = null;
  const seq = ++state.runSeq;
  const t0 = performance.now();
  try {
    if (from === 'clean' || !state.clean) {
      setStatus('Cleaning the scan: floor, background, noise…', 0.08);
      const { value: c } = await host.call('clean', cleanParams(), { onProgress });
      if (seq !== state.runSeq) return;
      state.clean = c;
      viewer.setClean(c);
      onCleaned(c);
    }
    const params = buildParams();
    // Big models take a while to optimise: show a quick draft first (well under 5 s), then refine it.
    if (state.lastBuildMs > 3000 && params.quality !== 'fast' && params.scaleMode !== 'budget') {
      setStatus('Quick preview…', 0.25);
      const { value: draft } = await host.call('build', { ...params, quality: 'fast' }, { onProgress });
      if (seq !== state.runSeq) return;
      draft.draft = true;
      state.model = draft;
      onBuilt(draft);
      setStatus('Preview shown — optimising joints between layers…', 0.5);
    } else {
      setStatus('Building the brick model…', 0.25);
    }
    const { value: m } = await host.call('build', params, { onProgress });
    if (seq !== state.runSeq) return;
    state.model = m;
    state.lastBuildMs = m.timings.total;
    state.lastMs = performance.now() - t0;
    onBuilt(m);
    setStatus(`Done in ${(state.lastMs / 1000).toFixed(1)} s`, 1);
    setTimeout(() => { if (seq === state.runSeq) setStatus(''); }, 2200);
  } catch (e) {
    if (e.cancelled) return;
    if (seq !== state.runSeq) return;
    setStatus(e.message, 0, true);
    showToast(e.message);
    state.model = null;
    renderReport();
    refreshButtons();
  }
}

// ----------------------------------------------------------------------------------------------------------------
// loading
// ----------------------------------------------------------------------------------------------------------------
async function loadFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  setStatus(`Reading ${file.name}…`, 0.05);
  try {
    const buf = await file.arrayBuffer();
    const fmt = detectFormat(file.name, new Uint8Array(buf, 0, Math.min(buf.byteLength, 16)));
    let summary;
    if (['usdz', 'usd', 'usda', 'usdc', 'glb', 'gltf'].includes(fmt)) {
      setStatus('Decoding the 3D file (this can take a few seconds for big scans)…', 0.1);
      await new Promise((r) => setTimeout(r, 30));
      const geometry = await parseWithThree(fmt, buf);
      const res = await host.call('load', { name: file.name, geometry }, { transfer: [geometry.positions.buffer, geometry.indices && geometry.indices.buffer] });
      summary = res.value;
    } else {
      if (!['obj', 'ply', 'stl'].includes(fmt)) throw new Error(`".${ext}" isn't supported. Export your scan as OBJ, PLY, USDZ, GLB or STL.`);
      const res = await host.call('load', { name: file.name, buffer: buf }, { transfer: [buf] });
      summary = res.value;
    }
    onLoaded(summary);
  } catch (e) {
    setStatus(e.message, 0, true);
    showToast(e.message);
  }
}

async function loadDemo(shape) {
  setStatus('Creating demo scan…', 0.05);
  try {
    const { value } = await host.call('demo', { shape, options: {} });
    onLoaded(value);
  } catch (e) {
    setStatus(e.message, 0, true);
    showToast(e.message);
  }
}

function onLoaded(summary) {
  state.raw = summary;
  state.clean = null;
  state.model = null;
  state.firstClean = true;
  $('empty').hidden = true;
  const faces = summary.kind === 'mesh' ? `${fmtInt(summary.stats.weldedFaces)} faces` : `${fmtInt(summary.stats.vertices)} points`;
  $('file-info').innerHTML = `<b>${esc(summary.fileName)}</b> · ${summary.kind === 'mesh' ? 'mesh' : 'point cloud'} · ${faces}`;
  const up = $('up').value === 'auto' ? summary.upGuess : $('up').value;
  $('up-hint').textContent = $('up').value === 'auto' ? `Detected ${summary.upGuess.toUpperCase().replace('-', '−')} (confidence ${summary.upConfidence.toFixed(1)}×)` : '';
  viewer.setRaw(summary.preview, up);
  setView('raw');
  refreshViewButtons();
  setStatus('Scan loaded.', 0.1);
  clearTimeout(timer);
  pendingFrom = 'clean';
  run();
}

function onCleaned(c) {
  const real = c.sizeMM;
  $('clean-readout').innerHTML =
    `Object <b>${fmtCm(real[0])} × ${fmtCm(real[1])} × ${fmtCm(real[2])} cm</b> (W × H × D) · units: ${esc(c.unit)}` +
    `<br>Kept ${Math.round(100 - c.stats.removedPct)}% of the scan${c.yaw ? ` · turned ${c.yaw}°` : ''}${c.floor ? '' : ' · no floor found'}`;
  if (state.firstClean) {
    state.firstClean = false;
    if ($('scaleMode').value !== 'budget') setSizeValue(24);
  }
  viewer.setFloorPlane(c.floor ? c.floor.y : null);
  refreshViewButtons();
  if (state.view === 'raw' && !$('floorManual').checked) setView('clean');
}

function onBuilt(m) {
  const [nx, ny, nz] = m.dims;
  const mm = m.mm;
  const col = findColor(state.catalogue, $('color').value);
  viewer.setModel(m, col.hex);
  state.step = m.steps.length;
  $('step-range').max = m.steps.length;
  $('step-range').value = m.steps.length;
  if (state.view === 'raw' || state.view === 'clean') setView('bricks'); else refreshStepbar();
  refreshViewButtons();
  $('size-readout').innerHTML = `<b>${nx} × ${nz} studs</b> footprint, <b>${ny}</b> bricks high<br>${fmtCm(mm[0])} × ${fmtCm(mm[1])} × ${fmtCm(mm[2])} cm · ${Math.round(m.scale.k * 100)}% of real size`;
  $('dims').hidden = false;
  refreshDims();
  refreshBOM();
  renderReport();
  renderParts();
  renderSteps();
  refreshStepbar();
  refreshButtons();
}

function refreshBOM() {
  const m = state.model;
  if (!m) return;
  m.bom = buildBOM(m.bricks, m.parts, state.catalogue, state.prices);
}

function refreshDims() {
  const m = state.model;
  if (!m) return;
  const [nx, ny, nz] = m.dims;
  $('dims').innerHTML = `W ${nx} × H ${ny} × D ${nz} studs · <b>${fmtInt(m.report.bricks)}</b> parts · ≈ <b>${m.bom.currency === 'USD' ? '$' : ''}${m.bom.totalCost.toFixed(2)}</b>`;
}

// ----------------------------------------------------------------------------------------------------------------
// views and steps
// ----------------------------------------------------------------------------------------------------------------
function setView(view) {
  state.view = view;
  document.querySelectorAll('.views [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  viewer.setMode(view);
  refreshStepbar();
}

function refreshViewButtons() {
  const has = { raw: !!state.raw, clean: !!state.clean, bricks: !!state.model, overlay: !!state.model && !!state.clean };
  document.querySelectorAll('.views [role=tab]').forEach((b) => { b.disabled = !has[b.dataset.view]; });
}

function refreshStepbar() {
  const show = state.model && (state.view === 'bricks' || state.view === 'overlay');
  $('stepbar').hidden = !show;
  if (!state.model) return;
  const n = state.model.steps.length;
  const st = state.model.steps[state.step - 1];
  $('step-range').value = state.step;
  $('step-label').textContent = state.step === n ? `All ${n} steps` : `Step ${state.step}/${n} · layer ${st.layer + 1}`;
}

function setStep(n) {
  if (!state.model) return;
  n = Math.max(1, Math.min(state.model.steps.length, n));
  state.step = n;
  viewer.setVisibleSteps(n);
  refreshStepbar();
  renderStepPanel();
}

function playToggle() {
  if (!state.model) return;
  state.playing = !state.playing;
  $('step-play').textContent = state.playing ? '❚❚' : '▶';
  if (!state.playing) return;
  if (state.step >= state.model.steps.length) setStep(1);
  const tick = () => {
    if (!state.playing) return;
    if (state.step >= state.model.steps.length) { state.playing = false; $('step-play').textContent = '▶'; return; }
    setStep(state.step + 1);
    setTimeout(tick, Math.max(80, 700 - state.model.steps.length * 2));
  };
  setTimeout(tick, 300);
}

// ----------------------------------------------------------------------------------------------------------------
// report
// ----------------------------------------------------------------------------------------------------------------
function row(kind, title, detail, tag) {
  const ico = { ok: '✓', warn: '!', bad: '✕', info: 'i' }[kind];
  return `<li class="check-row"><span class="ico ${kind}">${ico}</span><div><b>${title}</b><span class="d">${detail}</span></div>${tag ? `<span class="tag">${tag}</span>` : ''}</li>`;
}

function renderReport() {
  const p = $('panel-report');
  const raw = state.raw, clean = state.clean, m = state.model;
  if (!raw) { p.innerHTML = '<p class="muted pad">Load a scan to see the checks.</p>'; return; }
  const out = [];
  if (m && m.draft) out.push('<div class="warnbox"><b>Quick preview</b> — joints are being optimised; the report will update in a moment.</div>');
  if (m) {
    out.push(`<div class="stat-row"><div class="stat"><b>${fmtInt(m.report.bricks)}</b><span>parts</span></div><div class="stat"><b>${m.bom.currency === 'USD' ? '$' : ''}${m.bom.totalCost.toFixed(2)}</b><span>est. cost</span></div><div class="stat"><b>${m.steps.length}</b><span>build steps</span></div></div>`);
  }
  const checks = [];
  const faces = raw.kind === 'mesh' ? `${fmtInt(raw.stats.weldedFaces)} faces` : `${fmtInt(raw.stats.vertices)} points`;
  checks.push(row('ok', 'Scan loaded', `${esc(raw.fileName)} · ${raw.kind === 'mesh' ? 'mesh' : 'point cloud'}, ${faces}${clean && clean.decimated ? ` (decimated to ${fmtInt(clean.stats.outputUnits)})` : ''}`, 'R1'));
  if (clean) {
    checks.push(row(clean.floor ? 'ok' : 'info', clean.floor ? 'Floor and background removed' : 'No floor plane found',
      clean.floor ? `Table plane found; ${Math.round(clean.stats.removedPct)}% of the scan discarded (floor, walls, clutter, noise).` : 'Nothing was cut away. If a table is in the scan, check the “up” axis.', 'R2'));
  }
  if (m) {
    const r = m.report;
    const [nx, ny, nz] = m.dims;
    // size
    const sc = m.scale;
    if (sc.mode === 'budget') {
      const t = sc.budget.target;
      const off = Math.abs(r.bricks - t) / t;
      checks.push(row(off <= 0.15 ? 'ok' : 'warn', 'Brick budget', `${fmtInt(r.bricks)} parts for a target of ${fmtInt(t)} (${nx} × ${nz} × ${ny} studs/bricks).`, 'R3'));
    } else {
      const cell = [CELL_MM.x, CELL_MM.y, CELL_MM.z][sc.axis];
      const wanted = (sc.value * 10) / cell;
      const got = m.dims[sc.axis];
      const label = ['width', 'height', 'depth'][sc.axis];
      checks.push(row(Math.abs(got - wanted) <= 1 ? 'ok' : 'warn', 'Size matches the target', `${label}: ${got} ${sc.axis === 1 ? 'bricks' : 'studs'} for a requested ${wanted.toFixed(1)} (±1 allowed).`, 'R3'));
    }
    checks.push(row(m.timings.total < 5000 ? 'ok' : 'info', 'Preview speed', `${(m.timings.total / 1000).toFixed(2)} s to rebuild at this size (goal: under 5 s).`, 'R3'));
    checks.push(row(r.iou >= 0.85 ? 'ok' : 'warn', 'Shape faithful to the scan', `Volume IoU ${(r.iou * 100).toFixed(0)}% against the super-sampled scan (goal ≥ 85%). Thin or tiny features limit it.`, 'R4'));
    checks.push(row(r.floating === 0 && r.overlaps === 0 && r.hanging === 0 ? 'ok' : 'bad', 'Every brick connected and supported',
      `${r.floating} floating, ${r.hanging} unsupported, ${r.overlaps} overlapping bricks; one connected piece${r.prunedBricks ? `; ${r.prunedBricks} bricks trimmed from long overhangs` : ''}${r.restoredCells ? `; ${r.restoredCells} cells added as support columns` : ''}.`, 'R5'));
    checks.push(row(r.seams.pct >= 95 ? 'ok' : r.seams.pct >= 90 ? 'warn' : 'bad', 'Joints staggered',
      `${r.seams.pct.toFixed(1)}% of vertical joints are bridged by a brick in the next layer (goal ≥ 95%; thin hollow walls limit it).`, 'R5'));
    checks.push(row(r.balance.stable ? 'ok' : 'warn', 'Stands on its own', r.balance.stable ? `Centre of mass is ${r.balance.margin.toFixed(1)} studs inside the footprint.` : 'The centre of mass is outside the base footprint: the model may tip over. (Approximate check.)', 'R5'));
    checks.push(row(r.reductionPct >= 40 ? 'ok' : 'warn', 'Part count reduced', `${fmtInt(r.bricks)} parts vs ${fmtInt(r.baseline1x1)} for plain 1×1 bricks (−${r.reductionPct.toFixed(0)}%, goal ≥ 40%)${r.hollowRemoved ? `; hollowing removed ${fmtInt(r.hollowRemoved)} interior cells` : ''}.`, 'R6'));
    checks.push(row(r.catalogueOkPct === 100 ? 'ok' : 'bad', 'Parts in the catalogue', `${r.uniqueParts} part numbers, all current production in catalogue ${esc(state.catalogue.version)}.`, 'R6'));
    checks.push(row('ok', 'Parts list and exports', `BrickLink XML, Rebrickable CSV, parts CSV and LDraw are ready; ${m.bom.lines.length} lines in one colour (${esc(findColor(state.catalogue, $('color').value).name)}).`, 'R7 R9'));
    checks.push(row(r.stepsMax <= m.params.maxPerStep ? 'ok' : 'warn', 'Build steps', `${m.steps.length} steps, at most ${r.stepsMax} new parts per step (limit ${m.params.maxPerStep}).`, 'R8'));
    const heap = performance && performance.memory ? ` JS heap now ${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB.` : '';
    checks.push(row(m.timings.total < 120000 ? 'ok' : 'warn', 'Performance', `${(m.timings.total / 1000).toFixed(1)} s on the CPU (limit 120 s); about ${(r.estPeakBytes / 1048576).toFixed(0)} MB of working memory (limit 8 GB).${heap} Worker: ${host.mode}.`, 'R10'));
    checks.push(row('ok', 'Offline', `Nothing is sent anywhere. Prices come from the local catalogue (${esc(state.catalogue.version)}); network ${navigator.onLine ? 'is' : 'is not'} available but not needed.`, 'R11'));
    out.push(`<ul class="checks">${checks.join('')}</ul>`);
    const warns = [...(r.warnings || []), ...(clean && clean.log ? [] : [])];
    if (warns.length) out.push(`<div class="warnbox"><b>Heads-up</b><ul>${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`);
  } else {
    out.push(`<ul class="checks">${checks.join('')}</ul><p class="muted pad">Building the model…</p>`);
  }
  p.innerHTML = out.join('');
}

// ----------------------------------------------------------------------------------------------------------------
// parts panel
// ----------------------------------------------------------------------------------------------------------------
function brickIcon(w, d, color) {
  let studs = '';
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) studs += `<circle cx="${x * 8 + 4}" cy="${z * 8 + 4}" r="2.4" fill="rgba(255,255,255,.55)"/>`;
  return `<svg class="brick-ico" viewBox="-1 -1 ${w * 8 + 2} ${d * 8 + 2}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><rect x="0" y="0" width="${w * 8}" height="${d * 8}" rx="1.5" fill="${color}" stroke="rgba(0,0,0,.4)"/>${studs}</svg>`;
}

function renderParts() {
  const p = $('panel-parts');
  const m = state.model;
  if (!m) { p.innerHTML = '<p class="muted pad">The parts list appears here.</p>'; return; }
  const col = findColor(state.catalogue, $('color').value);
  const cur = m.bom.currency === 'USD' ? '$' : '';
  const rows = m.bom.lines.map((l) => `<tr>
    <td>${brickIcon(l.w, l.d, col.hex)}</td>
    <td class="name">${esc(l.name)}<small>#${esc(l.id)}${l.priceSource === 'custom' ? ' · your price' : ''}</small></td>
    <td class="num">${fmtInt(l.qty)}</td>
    <td class="num"><input type="number" min="0" step="0.01" value="${l.unitPrice.toFixed(2)}" data-part="${esc(l.id)}" aria-label="Unit price for ${esc(l.name)}"></td>
    <td class="num" data-total="${esc(l.id)}">${cur}${l.total.toFixed(2)}</td></tr>`).join('');
  p.innerHTML = `<table class="parts"><thead><tr><th></th><th>Part</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td></td><td>${m.bom.lines.length} part numbers</td><td class="num" id="foot-qty">${fmtInt(m.bom.totalParts)}</td><td></td><td class="num" id="foot-cost">${cur}${m.bom.totalCost.toFixed(2)}</td></tr></tfoot></table>
    <p class="info small pad">All parts priced as <b>${esc(col.name)}</b>. Prices are ${esc(state.catalogue.currency)} estimates from the offline catalogue (${esc(state.catalogue.version)}); edit a price or use “Import prices” for a real cart total.</p>`;
  p.querySelectorAll('input[data-part]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (!(v >= 0)) return;
      state.prices[inp.dataset.part] = v;
      store.set('prices', state.prices);
      refreshBOM();
      renderParts();
      refreshDims();
      renderReport();
    });
  });
}

// ----------------------------------------------------------------------------------------------------------------
// steps panel
// ----------------------------------------------------------------------------------------------------------------
function renderSteps() {
  const p = $('panel-steps');
  const m = state.model;
  if (!m) { p.innerHTML = '<p class="muted pad">Build steps appear here.</p>'; return; }
  p.innerHTML = `<div class="step-view">
    <div class="step-nav"><button type="button" id="sp-prev">‹ Prev</button><span id="sp-label"></span><button type="button" id="sp-next">Next ›</button></div>
    <canvas id="sp-canvas" width="300" height="300" aria-label="Top-down map of this layer"></canvas>
    <ul class="step-parts" id="sp-parts"></ul>
    <div class="step-list" id="sp-list"></div>
    <p class="info small">Yellow = place now · colour = already placed in this layer · grey = the layer below.</p></div>`;
  $('sp-prev').onclick = () => setStep(state.step - 1);
  $('sp-next').onclick = () => setStep(state.step + 1);
  if (m.steps.length <= 160) {
    $('sp-list').innerHTML = m.steps.map((s, i) => `<button type="button" data-step="${i + 1}">${i + 1}</button>`).join('');
    $('sp-list').onclick = (e) => { const b = e.target.closest('button[data-step]'); if (b) setStep(Number(b.dataset.step)); };
  }
  renderStepPanel();
}

function renderStepPanel() {
  const m = state.model;
  if (!m || !$('sp-canvas')) return;
  const st = m.steps[state.step - 1];
  const [nx, , nz] = m.dims;
  $('sp-label').textContent = `Step ${state.step} of ${m.steps.length} · layer ${st.layer + 1}`;
  document.querySelectorAll('#sp-list button').forEach((b) => b.setAttribute('aria-current', String(Number(b.dataset.step) === state.step)));
  const cell = Math.max(5, Math.min(24, Math.floor(360 / Math.max(nx, nz))));
  const cv = $('sp-canvas');
  cv.width = nx * cell; cv.height = nz * cell;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const col = findColor(state.catalogue, $('color').value).hex;
  const rect = (i, fill, stroke, lw, label) => {
    const x = m.bricks[i * 6] * cell, z = m.bricks[i * 6 + 2] * cell, w = m.bricks[i * 6 + 3] * cell, d = m.bricks[i * 6 + 4] * cell;
    g.fillStyle = fill; g.strokeStyle = stroke; g.lineWidth = lw;
    g.fillRect(x + 0.5, z + 0.5, w - 1, d - 1); g.strokeRect(x + 0.5, z + 0.5, w - 1, d - 1);
    if (label && cell >= 12) { g.fillStyle = '#111'; g.font = `${Math.min(11, cell * 0.5)}px system-ui`; g.textAlign = 'center'; g.fillText(label, x + w / 2, z + d / 2 + 4); }
  };
  const tally = new Map();
  for (let k = 0; k < m.order.length; k++) {
    const i = m.order[k];
    const y = m.bricks[i * 6 + 1];
    if (y === st.layer - 1) rect(i, '#2b323e', '#3a4352', 1);
  }
  for (let k = 0; k < m.order.length; k++) {
    const i = m.order[k];
    if (m.bricks[i * 6 + 1] === st.layer && k < st.start) rect(i, col, 'rgba(0,0,0,.5)', 1);
  }
  for (let k = st.start; k < st.start + st.count; k++) {
    const i = m.order[k];
    const part = m.parts[m.bricks[i * 6 + 5]];
    rect(i, '#ffd400', '#111', 2, `${part.d}×${part.w}`);
    tally.set(m.bricks[i * 6 + 5], (tally.get(m.bricks[i * 6 + 5]) || 0) + 1);
  }
  $('sp-parts').innerHTML = [...tally].sort((a, b) => b[1] - a[1]).map(([pi, q]) => `<li><b>${q}×</b>${brickIcon(m.parts[pi].w, m.parts[pi].d, col)}<span>${esc(m.parts[pi].name)} <small class="muted">#${esc(m.parts[pi].id)}</small></span></li>`).join('');
}

// ----------------------------------------------------------------------------------------------------------------
// controls
// ----------------------------------------------------------------------------------------------------------------
function setSizeValue(v) {
  $('sizeNum').value = v;
  $('sizeRange').value = v;
}

function applyScaleMode(initial = false) {
  const mode = $('scaleMode').value;
  const budget = mode === 'budget';
  $('size-label').textContent = { longest: 'Longest side (cm)', height: 'Height (cm)', width: 'Width (cm)', depth: 'Depth (cm)', budget: 'Number of bricks' }[mode];
  const r = $('sizeRange'), n = $('sizeNum');
  if (budget) { r.min = 100; r.max = 5000; r.step = 50; n.min = 20; n.max = 8000; n.step = 50; }
  else { r.min = 6; r.max = 60; r.step = 1; n.min = 3; n.max = 120; n.step = 1; }
  if (!initial) setSizeValue(budget ? 1000 : 24);
  $('size-presets').innerHTML = budget
    ? '<button type="button" class="chip" data-size="300">300</button><button type="button" class="chip" data-size="1000">1,000</button><button type="button" class="chip" data-size="3000">3,000</button>'
    : '<button type="button" class="chip" data-size="12">S 12 cm</button><button type="button" class="chip" data-size="24">M 24 cm</button><button type="button" class="chip" data-size="40">L 40 cm</button><button type="button" class="chip" data-size="real">Real size</button>';
}

function fillColors() {
  const sel = $('color');
  const prev = sel.value || store.get('color', 'lbg');
  sel.innerHTML = state.catalogue.colors.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  sel.value = state.catalogue.colors.some((c) => c.id === prev) ? prev : state.catalogue.colors[0].id;
  $('swatch').style.background = findColor(state.catalogue, sel.value).hex;
}

function setupControls() {
  fillColors();
  applyScaleMode(true);
  $('badge-catalogue').textContent = `Catalogue ${state.catalogue.version}`;
  $('badge-offline').textContent = navigator.onLine ? 'Runs offline' : 'Offline ✓';

  // file input / drag and drop
  $('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; $('veil').hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('veil').hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; $('veil').hidden = true;
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  $('demos').addEventListener('click', (e) => { const b = e.target.closest('[data-demo]'); if (b) loadDemo(b.dataset.demo); });

  // clean-up controls
  const cleanInputs = ['up', 'floor', 'floorManual', 'floorAt', 'floorMargin', 'keep', 'minPiece', 'yawMode', 'yawDeg', 'unit', 'cropX0', 'cropX1', 'cropY0', 'cropY1', 'cropZ0', 'cropZ1'];
  for (const id of cleanInputs) {
    $(id).addEventListener('input', () => {
      if (id === 'floorMargin') $('floorMargin-o').textContent = `${Number($(id).value).toFixed(1)}%`;
      if (id === 'minPiece') $('minPiece-o').textContent = `${$(id).value}%`;
      if (id === 'floorManual' || id === 'floor') {
        $('floorAt-field').hidden = !($('floorManual').checked && $('floor').checked);
        if ($('floorManual').checked && state.clean && state.clean.floor) {
          // start the manual floor where auto-detection put it
          const f = state.clean.floor, r = f.range;
          $('floorAt').value = Math.max(0, Math.min(100, ((f.y - r[0]) / (r[1] - r[0])) * 100)).toFixed(1);
        }
      }
      if (id === 'floorAt' || id === 'floorManual') {
        $('floorAt-o').textContent = `${Number($('floorAt').value).toFixed(1)}%`;
        const r = state.clean && state.clean.floor && state.clean.floor.range;
        if ($('floorManual').checked && r) { viewer.setFloorPlane(r[0] + (Number($('floorAt').value) / 100) * (r[1] - r[0])); if (state.view !== 'raw') setView('raw'); }
      }
      if (id === 'yawMode') $('yawDeg').disabled = $('yawMode').value !== 'custom';
      if (id === 'up' && state.raw) {
        const up = $('up').value === 'auto' ? state.raw.upGuess : $('up').value;
        viewer.setRawUp(up);
        $('up-hint').textContent = $('up').value === 'auto' ? `Detected ${state.raw.upGuess.toUpperCase().replace('-', '−')}` : '';
      }
      schedule('clean');
    });
  }

  // size controls
  $('scaleMode').addEventListener('input', () => { applyScaleMode(); schedule('build', 120); });
  $('sizeRange').addEventListener('input', () => { $('sizeNum').value = $('sizeRange').value; schedule('build', 260); });
  $('sizeNum').addEventListener('input', () => { const v = Number($('sizeNum').value); if (v > 0) { $('sizeRange').value = v; schedule('build', 500); } });
  $('size-presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-size]');
    if (!b) return;
    let v = b.dataset.size;
    if (v === 'real') v = state.clean ? Math.max(3, Math.round(Math.max(...state.clean.sizeMM) / 10)) : 24;
    setSizeValue(Number(v));
    schedule('build', 60);
  });

  // brick controls
  for (const id of ['hollow', 'quality', 'brickSet', 'seal', 'ss', 'pillar', 'maxPerStep']) $(id).addEventListener('input', () => schedule('build', 200));
  $('color').addEventListener('input', () => {
    const col = findColor(state.catalogue, $('color').value);
    $('swatch').style.background = col.hex;
    store.set('color', col.id);
    if (state.model) { viewer.setColor(col.hex); renderParts(); renderReport(); renderStepPanel(); }
  });

  // views
  document.querySelectorAll('.views [role=tab]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('btn-fit').addEventListener('click', () => viewer.fit());

  // steps
  $('step-range').addEventListener('input', () => { state.playing = false; $('step-play').textContent = '▶'; setStep(Number($('step-range').value)); });
  $('step-prev').addEventListener('click', () => setStep(state.step - 1));
  $('step-next').addEventListener('click', () => setStep(state.step + 1));
  $('step-all').addEventListener('click', () => setStep(state.model ? state.model.steps.length : 1));
  $('step-play').addEventListener('click', playToggle);
  $('viewport').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') setStep(state.step + 1);
    else if (e.key === 'ArrowLeft') setStep(state.step - 1);
  });

  // tabs
  for (const t of ['report', 'parts', 'steps']) {
    $('tab-' + t).addEventListener('click', () => {
      for (const o of ['report', 'parts', 'steps']) {
        $('tab-' + o).setAttribute('aria-selected', String(o === t));
        $('panel-' + o).hidden = o !== t;
      }
    });
  }

  // exports
  const needModel = () => { if (!state.model) { showToast('Build a model first.'); return false; } return true; };
  const colorId = () => $('color').value;
  $('ex-bl').onclick = () => needModel() && download('brickscan-wanted-list.xml', bricklinkXML(state.model.bom, state.catalogue, colorId()), 'application/xml');
  $('ex-rb').onclick = () => needModel() && download('brickscan-rebrickable.csv', rebrickableCSV(state.model.bom, state.catalogue, colorId()), 'text/csv');
  $('ex-csv').onclick = () => needModel() && download('brickscan-parts.csv', bomCSV(state.model.bom, state.catalogue, colorId()), 'text/csv');
  $('ex-ldr').onclick = () => {
    if (!needModel()) return;
    const m = state.model;
    download('brickscan-model.ldr', ldrawExport({ bricks: m.bricks, order: m.order, steps: m.steps, parts: m.parts, catalogue: state.catalogue, colorId: colorId(), dims: m.dims, name: `BrickScan – ${state.raw.fileName}` }), 'text/plain');
  };
  $('ex-html').onclick = () => {
    if (!needModel()) return;
    const m = state.model;
    const col = findColor(state.catalogue, colorId());
    download('brickscan-instructions.html', instructionsHTML({ title: `BrickScan – ${state.raw.fileName}`, bricks: m.bricks, order: m.order, steps: m.steps, parts: m.parts, dims: m.dims, colorHex: col.hex, bom: m.bom, catalogue: state.catalogue }), 'text/html');
  };
  $('ex-png').onclick = () => {
    const url = viewer.png();
    if (!url) return showToast('The 3D view is not available.');
    const a = document.createElement('a'); a.href = url; a.download = 'brickscan.png'; document.body.appendChild(a); a.click(); a.remove();
  };

  // price + catalogue import
  $('prices').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const prices = parsePrices(await f.text());
      Object.assign(state.prices, prices);
      store.set('prices', state.prices);
      refreshBOM(); renderParts(); refreshDims(); renderReport();
      showToast(`Imported ${Object.keys(prices).length} prices.`, 'info');
    } catch (err) { showToast(err.message); }
  });
  $('catfile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const cat = JSON.parse(await f.text());
      validateCatalogue(cat);
      state.catalogue = cat;
      store.set('catalogue', cat);
      await host.call('catalogue', { catalogue: cat, prices: state.prices });
      fillColors();
      $('badge-catalogue').textContent = `Catalogue ${cat.version || cat.name}`;
      showToast(`Loaded catalogue “${cat.name}” with ${cat.parts.length} parts.`, 'info');
      schedule('build', 50);
    } catch (err) { showToast('Could not load catalogue: ' + err.message); }
  });

  $('btn-help').addEventListener('click', () => $('help').showModal());
  window.addEventListener('online', () => { $('badge-offline').textContent = 'Runs offline'; });
  window.addEventListener('offline', () => { $('badge-offline').textContent = 'Offline ✓'; });
  refreshButtons();
  refreshViewButtons();
}

function parsePrices(text) {
  const t = text.trim();
  const out = {};
  if (t.startsWith('{') || t.startsWith('[')) {
    const j = JSON.parse(t);
    if (Array.isArray(j)) for (const e of j) out[String(e.id ?? e.part)] = Number(e.price);
    else for (const [k, v] of Object.entries(j)) out[k] = Number(v);
  } else {
    for (const line of t.split(/\r?\n/)) {
      const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
      if (cells.length >= 2 && cells[0] && !Number.isNaN(Number(cells[1]))) out[cells[0]] = Number(cells[1]);
    }
  }
  const clean = {};
  for (const [k, v] of Object.entries(out)) if (v >= 0 && Number.isFinite(v)) clean[k] = v;
  if (!Object.keys(clean).length) throw new Error('No prices found. Use lines like "3001,0.12" or JSON like {"3001": 0.12}.');
  return clean;
}

function refreshButtons() {
  const has = !!state.model;
  for (const id of ['ex-bl', 'ex-rb', 'ex-ldr', 'ex-csv', 'ex-html', 'ex-png']) $(id).disabled = !has;
}

// ----------------------------------------------------------------------------------------------------------------
// boot
// ----------------------------------------------------------------------------------------------------------------
async function boot() {
  const savedCat = store.get('catalogue', null);
  if (savedCat) {
    try { validateCatalogue(savedCat); state.catalogue = savedCat; } catch (e) { /* ignore a broken saved catalogue */ }
  }
  setupControls();
  if (state.catalogue !== CATALOGUE) host.call('catalogue', { catalogue: state.catalogue, prices: state.prices }).catch(() => {});
  else host.call('catalogue', { prices: state.prices }).catch(() => {});
  setView('bricks');
  // expose a tiny hook for automated tests
  window.__brickscan = { state, host, viewer, loadDemo, loadFile };
}
boot();
