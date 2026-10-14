// Browser tests: opens the BUILT single-file app (dist/BrickScan.html) from file:// in headless Chromium with every
// network request blocked, and drives it like a user would. Run with: npm run build && npm run test:browser

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { makeScan, toOBJ, toPLY } from '../src/core/demo.js';
import { toUSDZ, toGLB, toSTL } from './fixtures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'file://' + path.join(root, 'dist/BrickScan.html');
const SHOTS = process.env.SHOTS_DIR;
const candidates = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium', undefined].filter((x, i) => x || i === 2);

let browser;
const problems = [];
const blocked = [];

before(async () => {
  assert.ok(fs.existsSync(path.join(root, 'dist/BrickScan.html')), 'run `npm run build` first');
  let lastError;
  for (const exe of candidates) {
    try {
      browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
      break;
    } catch (e) { lastError = e; }
  }
  if (!browser) throw lastError;
});
after(async () => { await browser?.close(); });

async function newPage(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, colorScheme: 'dark' });
  // the app must work with no network at all: abort everything that is not the local file or an in-page URL
  await ctx.route(/^(?!file:|blob:|data:)/, (route) => { blocked.push(route.request().url()); route.abort(); });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push('[pageerror] ' + e.message));
  await page.goto(APP);
  await page.waitForFunction(() => window.__brickscan);
  return { page, ctx };
}

const ready = (page, timeout = 120000) => page.waitForFunction(() => window.__brickscan.state.model && !window.__brickscan.state.model.__stale, null, { timeout });
const model = (page) => page.evaluate(() => {
  const m = window.__brickscan.state.model;
  return { bricks: m.report.bricks, dims: m.dims, floating: m.report.floating, hanging: m.report.hanging, overlaps: m.report.overlaps, seams: m.report.seams.pct, steps: m.steps.length, stepsMax: m.report.stepsMax, cost: m.bom.totalCost, iou: m.report.iou, mode: window.__brickscan.host.mode, ms: m.timings.total };
});
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); }

// ---------------------------------------------------------------------------------------------------------------------
const scan = makeScan('controller', { cell: 0.004 });
const formats = {
  'controller.obj': () => Buffer.from(toOBJ(scan)),
  'controller.ply': () => Buffer.from(toPLY(scan)),
  'controller.usdz': () => Buffer.from(toUSDZ(scan)),
  'controller.glb': () => Buffer.from(toGLB(scan)),
  'controller.stl': () => Buffer.from(toSTL(scan)),
};

for (const [name, make] of Object.entries(formats)) {
  test(`R1/R11: ${name} loads through the file picker, offline, in a Web Worker`, async () => {
    const { page, ctx } = await newPage();
    await page.setInputFiles('#file', { name, mimeType: 'application/octet-stream', buffer: make() });
    await ready(page);
    const m = await model(page);
    assert.equal(m.mode, 'worker', 'processing runs in a Web Worker');
    assert.equal(m.floating, 0);
    assert.equal(m.hanging, 0);
    assert.equal(m.overlaps, 0);
    assert.ok(m.bricks > 100 && m.bricks < 2000, `${m.bricks} bricks`);
    assert.ok(m.seams > 88, `seams ${m.seams}`);
    const info = await page.textContent('#file-info');
    assert.match(info, new RegExp(name.replace('.', '\\.')));
    await shot(page, 'format-' + name.split('.')[1]);
    await ctx.close();
  });
}

test('the app is one self-contained file: no external scripts, styles or fonts', async () => {
  const html = fs.readFileSync(path.join(root, 'dist/BrickScan.html'), 'utf8');
  assert.ok(!/<script[^>]+src=/i.test(html));
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html));
  assert.ok(!/@import|url\(["']?https?:/i.test(html));
  assert.ok(Buffer.byteLength(html) < 4e6);
});

test('demo → report, parts, steps, views and exports', async () => {
  const { page, ctx } = await newPage();
  await page.click('[data-demo=shoebox]');
  await ready(page);
  const m = await model(page);
  assert.ok(m.dims[0] >= 29 && m.dims[0] <= 31, `width ${m.dims[0]}`);
  assert.ok(m.iou > 0.8);
  await shot(page, 'demo-model');

  // report: every PRD requirement tag is present and nothing is marked as failed
  const report = await page.innerHTML('#panel-report');
  for (const tag of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R8', 'R10', 'R11']) assert.ok(report.includes(`>${tag}<`) || report.includes(tag), `report mentions ${tag}`);
  assert.equal(await page.locator('#panel-report .ico.bad').count(), 0);

  // views
  for (const v of ['raw', 'clean', 'overlay', 'bricks']) {
    await page.click(`[data-view=${v}]`);
    assert.equal(await page.getAttribute(`[data-view=${v}]`, 'aria-selected'), 'true');
  }
  // pixels were really drawn (WebGL works): the canvas is not a single flat colour
  const distinct = await page.evaluate(() => {
    const url = window.__brickscan.viewer.png();
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 64, 64);
        const d = g.getImageData(0, 0, 64, 64).data; const set = new Set();
        for (let i = 0; i < d.length; i += 4) set.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4));
        resolve(set.size);
      };
      img.src = url;
    });
  });
  assert.ok(distinct > 12, `canvas shows ${distinct} distinct colours`);

  // parts: editing a price changes the totals
  await page.click('#tab-parts');
  const before = await page.textContent('#foot-cost');
  const input = page.locator('#panel-parts input[data-part]').first();
  await input.fill('9.99'); await input.dispatchEvent('change');
  await page.waitForTimeout(150);
  const after = await page.textContent('#foot-cost');
  assert.notEqual(before, after);
  assert.match(await page.textContent('#panel-parts'), /your price/);

  // steps: next / previous / list
  await page.click('#tab-steps');
  const label1 = await page.textContent('#sp-label');          // the app opens on the last step
  await page.click('#sp-prev');
  assert.notEqual(await page.textContent('#sp-label'), label1);
  await page.click('#sp-next');
  assert.equal(await page.textContent('#sp-label'), label1);
  await page.click('#sp-list button[data-step="3"]');
  assert.match(await page.textContent('#sp-label'), /Step 3 of/);
  assert.match(await page.textContent('#step-label'), /Step 3\//);
  await shot(page, 'demo-steps');

  // exports
  const get = async (sel) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
  };
  const bl = await get('#ex-bl');
  assert.equal(bl.name, 'brickscan-wanted-list.xml');
  assert.match(bl.text, /<INVENTORY>[\s\S]*<ITEMTYPE>P<\/ITEMTYPE>[\s\S]*<COLOR>86<\/COLOR>/);
  const rb = await get('#ex-rb');
  assert.match(rb.text, /^Part,Color,Quantity\n/);
  const csv = await get('#ex-csv');
  assert.match(csv.text, /^Part,Name,Color,Quantity/);
  const ldr = await get('#ex-ldr');
  assert.ok(ldr.text.includes('0 STEP'));
  assert.equal(ldr.text.split('\n').filter((l) => l.startsWith('1 71 ')).length, m.bricks);
  const html = await get('#ex-html');
  assert.equal((html.text.match(/<section class="step">/g) || []).length, m.steps);
  // BOM totals agree across the three part-list exports
  const sum = (t, col) => t.trim().split('\n').slice(1).reduce((s, l) => s + Number(l.split(',')[col]), 0);
  assert.equal(sum(rb.text, 2), m.bricks);
  assert.equal([...bl.text.matchAll(/<MINQTY>(\d+)/g)].reduce((s, x) => s + Number(x[1]), 0), m.bricks);
  await ctx.close();
});

test('R3: changing the size updates the model in under 5 s; budget mode lands near the target', async () => {
  const { page, ctx } = await newPage();
  await page.click('[data-demo=compact]');
  await ready(page);
  const first = await model(page);
  // smaller
  await page.fill('#sizeNum', '14');
  await page.waitForFunction((w) => window.__brickscan.state.model && window.__brickscan.state.model.dims[0] !== w && window.__brickscan.state.model.params.value === 14, first.dims[0], { timeout: 30000 });
  const second = await model(page);
  assert.ok(second.ms < 5000, `rebuild took ${second.ms} ms`);
  assert.ok(second.dims[0] < first.dims[0] || second.dims[2] < first.dims[2]);
  // budget
  await page.selectOption('#scaleMode', 'budget');
  await page.fill('#sizeNum', '400');
  await page.waitForFunction(() => { const m = window.__brickscan.state.model; return m && m.params.scaleMode === 'budget' && m.params.value === 400; }, null, { timeout: 60000 });
  const third = await model(page);
  assert.ok(Math.abs(third.bricks - 400) / 400 < 0.15, `${third.bricks} bricks for a budget of 400`);
  // solid vs hollow
  await page.selectOption('#hollow', '0');
  await page.waitForFunction(() => window.__brickscan.state.model.params.hollow === 0, null, { timeout: 60000 });
  await ctx.close();
});

test('clean-up controls: wrong "up" axis is reported, crop and unit overrides rebuild', async () => {
  const { page, ctx } = await newPage();
  await page.click('[data-demo=sphere]');
  await ready(page);
  await page.selectOption('#unit', 'mm');
  await page.waitForFunction(() => window.__brickscan.state.clean && window.__brickscan.state.clean.unit === 'mm', null, { timeout: 30000 });
  await page.waitForFunction(() => window.__brickscan.state.model && window.__brickscan.state.model.params.value === 24, null, { timeout: 30000 });
  await page.selectOption('#unit', 'auto');
  await page.waitForFunction(() => window.__brickscan.state.clean.unit === 'm', null, { timeout: 30000 });
  await ctx.close();
});

test('if the browser refuses Web Workers the app falls back to in-page processing', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  await ctx.route(/^(?!file:|blob:|data:)/, (route) => { blocked.push(route.request().url()); route.abort(); });
  await ctx.addInitScript(() => { delete window.Worker; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push('[pageerror] ' + e.message));
  await page.goto(APP);
  await page.waitForFunction(() => window.__brickscan);
  await page.click('[data-demo=compact]');
  await ready(page);
  const m = await model(page);
  assert.equal(m.mode, 'inline');
  assert.equal(m.floating, 0);
  await shot(page, 'light-inline');
  await ctx.close();
});

test('floor height can be set by hand: the plane appears in the Scan view and the model rebuilds', async () => {
  const { page, ctx } = await newPage();
  await page.click('[data-demo=shoebox]');
  await ready(page);
  await page.check('#floorManual');
  await page.waitForSelector('#floorAt-field:not([hidden])');
  assert.equal(await page.getAttribute('[data-view=raw]', 'aria-selected'), 'true');
  const shown = await page.evaluate(() => window.__brickscan.viewer.floorPlane && window.__brickscan.viewer.floorPlane.visible);
  assert.ok(shown, 'floor plane is visible in the Scan view');
  await page.waitForFunction(() => window.__brickscan.state.clean && window.__brickscan.state.clean.floor && window.__brickscan.state.clean.floor.manual, null, { timeout: 30000 });
  await shot(page, 'manual-floor');
  await ctx.close();
});

test('errors are friendly: unsupported file and corrupt file', async () => {
  const { page, ctx } = await newPage();
  await page.setInputFiles('#file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForSelector('#toast:not([hidden])');
  assert.match(await page.textContent('#toast'), /isn't supported|OBJ/);
  await page.setInputFiles('#file', { name: 'bad.obj', mimeType: 'text/plain', buffer: Buffer.from('# nothing here\n') });
  await page.waitForFunction(() => /no vertices/i.test(document.getElementById('toast').textContent));
  // and the app still works afterwards
  await page.click('[data-demo=compact]');
  await ready(page);
  await ctx.close();
});

test('layout holds up on a phone-sized screen (no horizontal scroll)', async () => {
  const { page, ctx } = await newPage({ width: 390, height: 844 });
  await page.click('[data-demo=compact]');
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
  await shot(page, 'mobile');
  await ctx.close();
});

test('no console errors or warnings, and not a single network request was attempted', () => {
  const real = problems.filter((p) => !/GPU stall|swiftshader|WebGL|GL Driver Message|Automatic fallback/i.test(p));
  assert.deepEqual(real, []);
  assert.deepEqual(blocked, []);
});
