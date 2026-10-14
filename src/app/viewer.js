// three.js viewport: raw scan, cleaned mesh, studded bricks (with build-step highlighting) and a ghost overlay.
// Scene units are millimetres; Y is up; one stud = 8 mm, one brick = 9.6 mm.

import {
  WebGLRenderer, Scene, PerspectiveCamera, Color, HemisphereLight, DirectionalLight, BufferGeometry, BufferAttribute,
  Mesh, MeshStandardMaterial, MeshBasicMaterial, PlaneGeometry, Points, PointsMaterial, GridHelper, Group, Box3, Vector3, DoubleSide, Matrix4,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { upMatrix } from '../core/orient.js';
import { CELL_MM } from '../core/voxelize.js';

const HIGHLIGHT = [1.0, 0.82, 0.16];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Deterministic per-brick shade so neighbouring bricks are distinguishable. */
function shade(i) {
  let h = Math.imul(i + 1, 2654435761) >>> 0;
  h ^= h >>> 15;
  return 0.9 + ((h & 1023) / 1023) * 0.16;
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.ok = true;
    this.mode = 'bricks';
    this.needsRender = false;
    this.brick = null;
    try {
      this.renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch (e) {
      this.ok = false;
      this.error = e;
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', '3D view. Drag to rotate, scroll to zoom, right-drag to pan.');
    container.appendChild(this.canvas);

    this.scene = new Scene();
    this.scene.background = new Color(0x161a21);
    this.camera = new PerspectiveCamera(40, 1, 1, 20000);
    this.camera.position.set(260, 220, 360);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(new HemisphereLight(0xffffff, 0x3a3f4a, 1.15));
    const sun = new DirectionalLight(0xffffff, 1.9);
    sun.position.set(300, 600, 400);
    this.scene.add(sun);
    const fill = new DirectionalLight(0x9db4ff, 0.5);
    fill.position.set(-400, 200, -300);
    this.scene.add(fill);

    this.groups = { raw: new Group(), clean: new Group(), bricks: new Group(), overlay: new Group(), grid: new Group() };
    for (const g of Object.values(this.groups)) this.scene.add(g);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------
  requestRender() {
    if (!this.ok || this.needsRender) return;
    this.needsRender = true;
    requestAnimationFrame(() => {
      this.needsRender = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  resize() {
    if (!this.ok) return;
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  clear(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child.geometry && !child.userData.sharedGeometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
  }

  meshFromPreview(preview, opts = {}) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(preview.positions, 3));
    if (preview.kind === 'points' || !preview.indices) {
      const pts = new Points(g, new PointsMaterial({ color: opts.color || 0xb7c0cc, size: opts.pointSize || 2, sizeAttenuation: false }));
      return pts;
    }
    g.setIndex(new BufferAttribute(preview.indices, 1));
    g.computeVertexNormals();
    const m = new Mesh(g, new MeshStandardMaterial({
      color: opts.color || 0xb7c0cc, roughness: 0.85, metalness: 0, flatShading: true, side: DoubleSide,
      transparent: !!opts.opacity, opacity: opts.opacity ?? 1, depthWrite: opts.opacity ? false : true,
    }));
    return m;
  }

  // ---- content ------------------------------------------------------------------------------------------------------
  /** Raw scan, shown upright according to the selected up axis. */
  setRaw(preview, up) {
    if (!this.ok) return;
    this.clear(this.groups.raw);
    this.rawPreview = preview;
    const obj = this.meshFromPreview(preview, { pointSize: 1.5 });
    this.groups.raw.add(obj);
    this.setRawUp(up);
  }

  setRawUp(up) {
    if (!this.ok || !this.groups.raw.children.length) return;
    const [a, b, c, d, e, f, g, h, i] = upMatrix(up);
    const obj = this.groups.raw.children[0];
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(new Matrix4().set(a, b, c, 0, d, e, f, 0, g, h, i, 0, 0, 0, 0, 1));
    obj.matrixWorldNeedsUpdate = true;
    obj.updateMatrixWorld(true);
    this.rawBox = new Box3().setFromObject(obj);
    // units are unknown for the raw scan: scale so the biggest side is ~600 units on screen
    const size = this.rawBox.getSize(new Vector3());
    const s = 600 / Math.max(size.x, size.y, size.z, 1e-9);
    this.groups.raw.scale.setScalar(s);
    this.groups.raw.updateMatrixWorld(true);
    this.rawBox = new Box3().setFromObject(this.groups.raw);
    this.requestRender();
  }

  /** Translucent plane marking where the floor is cut (raw view only). `y` is in the up-aligned scan units. */
  setFloorPlane(y) {
    if (!this.ok || !this.rawBox) return;
    const s = this.groups.raw.scale.x;
    if (!this.floorPlane) {
      this.floorPlane = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: 0xffcf00, transparent: true, opacity: 0.18, side: DoubleSide, depthWrite: false }));
      this.floorPlane.rotation.x = -Math.PI / 2;
      this.groups.raw.parent.add(this.floorPlane);
    }
    const size = this.rawBox.getSize(new Vector3());
    const c = this.rawBox.getCenter(new Vector3());
    this.floorPlane.scale.set(size.x * 1.1, size.z * 1.1, 1);
    this.floorPlane.position.set(c.x, y === null ? -1e9 : y * s, c.z);
    this.floorPlane.visible = y !== null && this.mode === 'raw';
    this.floorY = y;
    this.requestRender();
  }

  /** Cleaned mesh at real size (mm). */
  setClean(clean) {
    if (!this.ok) return;
    this.clear(this.groups.clean);
    this.clear(this.groups.overlay);
    this.cleanData = clean;
    const preview = { kind: clean.kind, positions: clean.positions, indices: clean.indices };
    const obj = this.meshFromPreview(preview, { color: 0x9fb3c8, pointSize: 2 });
    obj.scale.setScalar(clean.mmPerUnit);
    this.groups.clean.add(obj);
    this.cleanBox = new Box3().setFromObject(this.groups.clean);
    // overlay uses the same geometry, scaled to the LEGO model later
    const ghost = this.meshFromPreview(preview, { color: 0x86b7ff, opacity: 0.28, pointSize: 2 });
    ghost.userData.sharedGeometry = false;
    this.groups.overlay.add(ghost);
    this.ghost = ghost;
    this.requestRender();
  }

  /** Studded brick model. */
  setModel(model, colorHex) {
    if (!this.ok) return;
    this.clear(this.groups.bricks);
    this.clear(this.groups.grid);
    this.model = model;
    this.colorHex = colorHex;
    const built = buildBrickGeometry(model, colorHex);
    this.brick = built;
    const mesh = new Mesh(built.geometry, new MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0 }));
    this.groups.bricks.add(mesh);
    this.brickMesh = mesh;
    const [nx, , nz] = model.dims;
    const span = Math.max(nx, nz) + 10;
    const grid = new GridHelper(span * CELL_MM.x, span, 0x3a4352, 0x262d39);
    grid.position.set((nx * CELL_MM.x) / 2, -0.05, (nz * CELL_MM.z) / 2);
    this.groups.grid.add(grid);
    this.brickBox = new Box3(new Vector3(0, 0, 0), new Vector3(nx * CELL_MM.x, model.dims[1] * CELL_MM.y, nz * CELL_MM.z));
    // ghost scan scaled and placed on the grid
    if (this.ghost && this.cleanData) {
      const k = model.scale.k;
      this.ghost.scale.setScalar(this.cleanData.mmPerUnit * k);
      this.ghost.position.set(0, 0, 0);
    }
    this.setVisibleSteps(model.steps.length);
    this.requestRender();
  }

  setColor(hex) {
    if (!this.brick) return;
    this.colorHex = hex;
    this.brick.recolor(hex);
    this.requestRender();
  }

  /** Show build steps 1..n; the nth is highlighted. n === steps.length shows the finished model without highlight. */
  setVisibleSteps(n, highlight = true) {
    if (!this.brick || !this.model) return;
    const steps = this.model.steps;
    n = Math.max(1, Math.min(steps.length, n));
    const last = steps[n - 1];
    const endBrick = last.start + last.count;
    this.brick.show(endBrick, highlight && n < steps.length ? { start: last.start, count: last.count } : null);
    this.requestRender();
  }

  setMode(mode) {
    if (!this.ok) return;
    this.mode = mode;
    const g = this.groups;
    g.raw.visible = mode === 'raw';
    if (this.floorPlane) this.floorPlane.visible = mode === 'raw' && this.floorY !== null && this.floorY !== undefined;
    g.clean.visible = mode === 'clean';
    g.bricks.visible = mode === 'bricks' || mode === 'overlay';
    g.overlay.visible = mode === 'overlay';
    g.grid.visible = mode === 'bricks' || mode === 'overlay';
    this.fit();
  }

  currentBox() {
    if (this.mode === 'raw') return this.rawBox;
    if (this.mode === 'clean') return this.cleanBox;
    return this.brickBox;
  }

  fit() {
    if (!this.ok) return;
    const box = this.currentBox();
    if (!box || box.isEmpty()) { this.requestRender(); return; }
    const c = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const r = Math.max(size.x, size.y, size.z) * 0.5;
    const dist = (r / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.35 + r;
    this.controls.target.copy(c);
    this.camera.position.set(c.x + dist * 0.62, c.y + dist * 0.5, c.z + dist * 0.78);
    this.camera.near = Math.max(0.5, dist / 500);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  png() {
    if (!this.ok) return null;
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }
}

/**
 * One merged triangle soup for the whole model, in build order, so that a draw range shows "the first n bricks"
 * and a colour sub-range highlights the bricks of the current step.
 */
export function buildBrickGeometry(model, colorHex) {
  const { bricks, order, dims } = model;
  const [nx, ny, nz] = dims;
  const B = bricks.length / 6;
  const occ = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < B; i++) {
    const x = bricks[i * 6], y = bricks[i * 6 + 1], z = bricks[i * 6 + 2], w = bricks[i * 6 + 3], d = bricks[i * 6 + 4];
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) occ[(y * nz + zz) * nx + xx] = 1;
  }
  const seg = B > 3000 ? 6 : 8;
  const studVerts = seg * 6 + seg * 3;
  let studs = 0;
  const topExposed = (x, y, z) => y + 1 >= ny || !occ[((y + 1) * nz + z) * nx + x];
  for (let i = 0; i < B; i++) {
    const x = bricks[i * 6], y = bricks[i * 6 + 1], z = bricks[i * 6 + 2], w = bricks[i * 6 + 3], d = bricks[i * 6 + 4];
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) if (topExposed(xx, y, zz)) studs++;
  }
  const total = B * 36 + studs * studVerts;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  const brickStart = new Int32Array(B + 1);
  const shades = new Float32Array(B);
  let v = 0;

  const tri = (a, b, c, n) => {
    for (const p of [a, b, c]) {
      pos[v * 3] = p[0]; pos[v * 3 + 1] = p[1]; pos[v * 3 + 2] = p[2];
      nor[v * 3] = n[0]; nor[v * 3 + 1] = n[1]; nor[v * 3 + 2] = n[2];
      v++;
    }
  };
  const quad = (a, b, c, d, n) => { tri(a, b, c, n); tri(a, c, d, n); };

  const inset = 0.12;
  for (let k = 0; k < B; k++) {
    const i = order[k];
    brickStart[k] = v;
    shades[k] = shade(i);
    const x = bricks[i * 6], y = bricks[i * 6 + 1], z = bricks[i * 6 + 2], w = bricks[i * 6 + 3], d = bricks[i * 6 + 4];
    const x0 = x * CELL_MM.x + inset, x1 = (x + w) * CELL_MM.x - inset;
    const y0 = y * CELL_MM.y, y1 = (y + 1) * CELL_MM.y - 0.05;
    const z0 = z * CELL_MM.z + inset, z1 = (z + d) * CELL_MM.z - inset;
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]);      // top
    quad([x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0]);     // bottom
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);      // +z
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]);     // -z
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]);      // +x
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);     // -x
    for (let zz = z; zz < z + d; zz++) for (let xx = x; xx < x + w; xx++) {
      if (!topExposed(xx, y, zz)) continue;
      const cx = (xx + 0.5) * CELL_MM.x, cz = (zz + 0.5) * CELL_MM.z, r = 2.4, top = y1 + 1.7;
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
        const p0 = [cx + Math.cos(a0) * r, y1, cz + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, y1, cz + Math.sin(a1) * r];
        const q0 = [p0[0], top, p0[2]], q1 = [p1[0], top, p1[2]];
        const am = (a0 + a1) / 2;
        quad(p1, p0, q0, q1, [Math.cos(am), 0, Math.sin(am)]);
        tri([cx, top, cz], q1, q0, [0, 1, 0]);
      }
    }
  }
  brickStart[B] = v;

  const geometry = new BufferGeometry();
  const posAttr = new BufferAttribute(pos, 3), norAttr = new BufferAttribute(nor, 3), colAttr = new BufferAttribute(col, 3);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('normal', norAttr);
  geometry.setAttribute('color', colAttr);

  const paint = (hex) => {
    const [r, g, b] = hexToRgb(hex);
    for (let k = 0; k < B; k++) {
      const s = shades[k];
      for (let q = brickStart[k]; q < brickStart[k + 1]; q++) {
        col[q * 3] = Math.min(1, r * s); col[q * 3 + 1] = Math.min(1, g * s); col[q * 3 + 2] = Math.min(1, b * s);
      }
    }
    colAttr.needsUpdate = true;
  };
  paint(colorHex);
  let lit = null;
  const api = {
    geometry,
    recolor(hex) { paint(hex); lit = null; },
    /** Draw the first `endBrick` bricks; paint bricks [start, start+count) in the highlight colour. */
    show(endBrick, highlight) {
      if (lit) { // restore the previous highlight
        const [r, g, b] = hexToRgb(api.currentHex || colorHex);
        for (let k = lit.start; k < lit.start + lit.count; k++) {
          const s = shades[k];
          for (let q = brickStart[k]; q < brickStart[k + 1]; q++) { col[q * 3] = Math.min(1, r * s); col[q * 3 + 1] = Math.min(1, g * s); col[q * 3 + 2] = Math.min(1, b * s); }
        }
        lit = null;
      }
      if (highlight) {
        for (let k = highlight.start; k < highlight.start + highlight.count; k++) {
          for (let q = brickStart[k]; q < brickStart[k + 1]; q++) { col[q * 3] = HIGHLIGHT[0]; col[q * 3 + 1] = HIGHLIGHT[1]; col[q * 3 + 2] = HIGHLIGHT[2]; }
        }
        lit = highlight;
      }
      colAttr.needsUpdate = true;
      geometry.setDrawRange(0, brickStart[Math.min(B, endBrick)]);
    },
  };
  api.currentHex = colorHex;
  const origRecolor = api.recolor;
  api.recolor = (hex) => { api.currentHex = hex; origRecolor(hex); };
  geometry.computeBoundingSphere();
  return api;
}
