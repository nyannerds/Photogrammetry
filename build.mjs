// Bundles the app into ONE self-contained HTML file (three.js included, Web Worker embedded as a Blob source),
// so it opens straight from disk with no server and no network: dist/BrickScan.html
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const common = { bundle: true, format: 'iife', minify: true, write: false, target: 'es2020', legalComments: 'none', logLevel: 'warning' };

const worker = await build({ ...common, entryPoints: [path.join(root, 'src/worker/worker.js')] });
const app = await build({
  ...common,
  entryPoints: [path.join(root, 'src/app/main.js')],
  define: { 'process.env.NODE_ENV': '"production"' },
});

const html = fs.readFileSync(path.join(root, 'src/app/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/app/style.css'), 'utf8');
// text placed inside <script> must not contain a closing tag
const safe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const out = html
  .replace('/*STYLE*/', () => css)
  .replace('/*WORKER*/', () => safe(worker.outputFiles[0].text))
  .replace('/*SCRIPT*/', () => safe(app.outputFiles[0].text));

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const file = path.join(root, 'dist/BrickScan.html');
fs.writeFileSync(file, out);
console.log(`dist/BrickScan.html  ${(out.length / 1048576).toFixed(2)} MB (app ${(app.outputFiles[0].text.length / 1024).toFixed(0)} KB, worker ${(worker.outputFiles[0].text.length / 1024).toFixed(0)} KB)`);
