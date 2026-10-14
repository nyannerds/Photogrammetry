# BrickScan

Turn a phone LiDAR scan of an object (10–50 cm) into a **buildable LEGO model**: cleaned mesh, scale preview, brick layout with
staggered joints, parts list with cost estimate, step-by-step build order, and exports for BrickLink, Rebrickable and LDraw.

**It is one HTML file that runs offline in your browser.** No server, no install, no network.

```
dist/BrickScan.html      ← double-click this (about 0.9 MB; three.js and the processing worker are inside)
```

## Using it

1. **Scan** an object with a LiDAR phone app (Polycam, Scaniverse, 3D Scanner App…) on a flat, plain surface, indoors.
   Export **OBJ, PLY, USDZ, GLB or STL** (geometry only; colours and textures are ignored).
2. Open `dist/BrickScan.html`, then **drop the file** on the page (or use *Choose a scan*). No scan handy? The five *demo* buttons
   generate synthetic scans (shoebox, powder compact, game controller, mug, ball) with a table, wall, clutter, noise and holes.
3. BrickScan cleans the scan, builds the model and shows the result. Tweak anything on the left; it rebuilds as you go:
   * **Clean up** – up axis, floor removal (auto or by hand with a live plane), what to keep, noise filter, alignment to the stud grid, units, crop box.
   * **Size** – set the model's size by longest side / height / width / depth (in cm), or by a **brick budget**. S/M/L/“Real size” shortcuts.
   * **Bricks** – solid or hollow (shell thickness), optimisation effort, brick set, colour, and advanced options (hole sealing, detail, support pillars, parts per step).
4. Read the **Report** (every PRD check with ✓ / ! / ✕), the **Parts** tab (editable prices) and the **Steps** tab (layer maps; the 3D view highlights the current step — use the slider or ←/→).
5. **Export:** BrickLink wanted-list XML · Rebrickable CSV · LDraw `.ldr` (with `0 STEP`, opens in BrickLink Studio / LDCad) · parts CSV · printable instructions (HTML) · picture.

Views: **Scan** (raw, with the floor plane) · **Cleaned** (real size) · **Bricks** (studded model with build steps) · **Overlay** (scan ghosted over the bricks — a quick scale/shape check).

## How it works

```
file ─► parse (OBJ/PLY/STL in a Web Worker; USDZ/GLB via three.js) ─► weld
     ─► orient (auto up-axis) ─► find & cut the floor ─► keep the object (size, flatness and centrality prior; drops walls, clutter, specks)
     ─► crop ─► align to the stud grid (min-area yaw) ─► decimate (vertex clustering, ≤400k faces) ─► detect units
     ─► scale (±1 stud snap) ─► super-sampled voxelisation (triangle–box SAT) ─► hole sealing (closing, grown until the shell stops leaking)
     ─► exterior flood fill with a virtual ground slab ─► surface de-biasing ─► down-sample ─► speckle denoise ─► hollow (shell + support pillars)
     ─► brick layout (per-layer greedy tiling, joint stagger, overhang support, refinement sweeps, seam polish, connectivity repair)
     ─► BOM + cost ─► build steps (≤ 20 parts) ─► independent verification ─► BrickLink / Rebrickable / LDraw / instructions
```

Everything heavy runs in a Web Worker (with an in-page fallback if a browser refuses workers on `file://`). The processing code
under `src/core/` has no DOM or browser dependency, so the same code is unit-tested in Node.

## PRD coverage

| ID | Requirement | How it is met | Evidence (this repo's tests, synthetic scans with analytic ground truth) |
|----|-------------|---------------|-----------|
| R1 | Accept OBJ / PLY / USDZ | OBJ, PLY (ASCII, binary LE/BE, meshes and point clouds), STL in the worker; USDZ / USD(A/C) and GLB/GLTF through three.js's loaders | All five formats load through the real file input in headless Chromium. A **1.08 M-face OBJ (40 MB)** loads in 2.0 s and builds without trouble (~650 MB RSS) |
| R2 | Remove floor/background, noise, make a solid | Floor plane detection (or manual height), piece selection with size/flatness/centrality prior, noise filter, hole sealing + flood fill with ground slab | Floor, wall, second object and specks removed on every demo scan, any up axis (±Y/±Z), units (m/cm/mm) and yaw. Scans with holes up to ~40% of the object's width fill solid; open containers (mug) correctly stay open |
| R3 | Set size by height/width/budget; ±1 stud; preview < 5 s | Size modes + budget search; scale snapped to whole studs/bricks; fast draft first on big models | Height/width/depth within ±1 stud; budget lands within 15% of target; rebuilds take 0.3–1.1 s at demo sizes, 6–13 s at 3,400–6,900 parts (a fast preview appears in ~1.5 s) |
| R4 | Recognisable shape, volume IoU ≥ 0.85 | Anisotropic cell (8×9.6×8 mm), super-sampled fill, surface de-biasing so curved surfaces are not inflated | IoU against the analytic "CAD" (3×3×3 samples per cell): shoebox **0.90**, ball **0.90**, powder compact **0.84**, controller **0.83** (noise 1.2 mm, holes included). Compact and controller are just under 0.85: thin and small features limit what 8 mm studs can resolve |
| R5 | Every brick connected, joints staggered, no floaters | Layer tiling that penalises aligned joints; overhang support planning; connectivity + support repair; independent verifier | **0 floating, 0 unsupported-from-below, 0 overlapping** bricks on every output tested. Bridged vertical joints: solid models **97.5–99.4%**; hollow shells **92–99%** (thin 2-stud walls have little freedom — the report flags < 95%) |
| R6 | Merge into bigger bricks, hollow, ≥ 40% fewer parts, parts in production | 16 standard rectangular bricks (1×1 … 1×16, 2×2 … 2×10, 4×6); hollowing with pillars | **79–93% fewer parts** than 1×1 on every test; 100% of part numbers are in the catalogue |
| R7 | BOM + price, BrickLink XML, Rebrickable CSV, one default colour | Colour picker with BrickLink/Rebrickable/LDraw ids; editable prices | Exports parsed and totals cross-checked in tests. Prices are **offline estimates** — see limits |
| R8 | ≤ 20 new parts per step | Steps are layer-ordered; layers are split evenly into ≤ 20-brick steps | Verified; each brick is placed after everything beneath it |
| R9 | LDraw export | `.ldr` with `0 STEP`, correct origin/rotation | Re-derives the model from the LDraw lines and checks cell-for-cell equality. *Not opened in Studio / LDCad here — see limits* |
| R10 | < 2 min and < 8 GB for up to 5,000 parts, CPU only | Everything in a worker, typed arrays, no GPU | ~5,000-part builds take 6–13 s in Node on this container (budget mode ≈ 1 min worst case) and < 700 MB RSS |
| R11 | Fully offline | No network calls; catalogue embedded | Browser test blocks every non-local request and asserts none was attempted; also runs with the network off |

## Honest limits

* **No real iPhone scans were available while building this**, so accuracy was measured on synthetic scans (SDF shapes meshed with
  surface nets, then given LiDAR-style noise, holes, missing underside, table, wall, clutter and floating specks). Real scans will behave
  differently; the manual floor height, crop box, piece selection and up-axis controls are there for that reason. A good next step is to
  run the PRD's reference protocol (scan 3D-printed objects with known CAD) and compare in CloudCompare.
* **USDC (binary USD) inside iPhone USDZ files** is decoded by three.js's `USDLoader`; it is covered by a test only for USDA-in-USDZ,
  because no binary sample was available here.
* **Prices are estimates.** The embedded catalogue (`src/data/catalogue.js`, dated 2026-10-14) has part numbers from memory of
  BrickLink / Rebrickable / LDraw and rough new-part prices in common colours; part availability ("in production") has not been
  re-checked against a live catalogue. Use **Import prices** (CSV `part,price` or JSON) or **Load catalogue** (JSON, same shape) for a
  trustworthy cart total. Live price lookup (optional in the PRD) is **not implemented**: BrickLink's API needs OAuth keys and is not
  browser-friendly.
* **LDraw / BrickLink XML / Rebrickable CSV were validated against their specs and by round-tripping, not opened in the real tools.**
* **Stability is approximate** (centre of mass over the base footprint, connectivity and support checks); no physics simulation.
* Overhangs longer than the longest brick that are not hollowing artefacts are **trimmed** (and reported), not propped up.
* One colour only (no mosaic / colour art), bricks only (no plates, slopes, curves), objects ≈ 10–50 cm.
* Seam bridging dips just under 95% on thin hollow curved shells (92–96% measured); choose *Solid* or *Hollow (3 studs)* for more.

## Developing

```bash
npm install          # three.js, esbuild, playwright-core (build/test only; nothing is needed to *run* the app)
npm run build        # → dist/BrickScan.html (single file)
npm test             # 28 unit/integration tests in Node (parsers, pipeline vs ground truth, exports, USDZ/GLB import)
npm run test:browser # 14 tests in headless Chromium against the built file (offline, all formats, exports, UI)
```

`SHOTS_DIR=some/dir npm run test:browser` also saves screenshots. Set `CHROMIUM_PATH` if Chromium is not in the default location.

```
src/core/      pipeline (no DOM): parsers, cleanup, geometry, voxelize, hollow, layout, analysis, steps, exporters, demo scans, engine
src/worker/    Web Worker entry + message handler (also used in-page as fallback)
src/app/       UI: index.html, style.css, main.js, viewer.js (three.js), host.js (worker bridge), threeio.js (USDZ/GLB)
src/data/      parts catalogue snapshot (BrickLink / Rebrickable / LDraw ids, colours, prices)
test/          node:test suites + Playwright browser test + file-format fixtures
build.mjs      esbuild: bundles everything into dist/BrickScan.html
```

### Catalogue JSON shape

```json
{ "name": "My catalogue", "version": "2026-11-01", "currency": "USD",
  "colors": [{ "id": "lbg", "name": "Light Bluish Gray", "bricklink": 86, "rebrickable": 71, "ldraw": 71, "hex": "#a0a5a9" }],
  "parts":  [{ "id": "3001", "name": "Brick 2 x 4", "w": 4, "d": 2, "price": 0.11,
               "bricklink": "3001", "rebrickable": "3001", "ldraw": "3001", "inProduction": true, "set": "common" }] }
```
