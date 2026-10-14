// Offline parts catalogue snapshot (cached locally so the whole pipeline runs without internet).
//
// IDs: BrickLink item numbers, Rebrickable part numbers and LDraw file names coincide for these basic bricks.
// Prices are rough USD estimates for new parts in common colours; they are meant for budgeting only.
// Replace them with real BrickLink / Rebrickable numbers through the app ("Import prices") or by loading
// a catalogue JSON with the same shape ("Load catalogue").

const brick = (id, w, d, price, set = 'common') => ({
  id,
  name: `Brick ${Math.min(w, d)} x ${Math.max(w, d)}`,
  w: Math.max(w, d),       // long side in studs
  d: Math.min(w, d),       // short side in studs
  h: 3,                    // height in plates (a standard brick = 3 plates = 9.6 mm)
  bricklink: id,
  rebrickable: id,
  ldraw: id,
  price,
  inProduction: true,
  set,
});

export const CATALOGUE = {
  name: 'BrickScan built-in snapshot',
  version: '2026-10-14',
  currency: 'USD',
  note:
    'Standard rectangular bricks. Part numbers are shared by BrickLink, Rebrickable and LDraw. ' +
    'Prices are offline estimates (new, common colours); import real prices for an accurate cart total.',
  colors: [
    { id: 'lbg', name: 'Light Bluish Gray', bricklink: 86, rebrickable: 71, ldraw: 71, hex: '#a0a5a9' },
    { id: 'dbg', name: 'Dark Bluish Gray', bricklink: 85, rebrickable: 72, ldraw: 72, hex: '#6c6e68' },
    { id: 'white', name: 'White', bricklink: 1, rebrickable: 15, ldraw: 15, hex: '#f2f3f2' },
    { id: 'black', name: 'Black', bricklink: 11, rebrickable: 0, ldraw: 0, hex: '#1b2a34' },
    { id: 'red', name: 'Red', bricklink: 5, rebrickable: 4, ldraw: 4, hex: '#c91a09' },
    { id: 'blue', name: 'Blue', bricklink: 7, rebrickable: 1, ldraw: 1, hex: '#0055bf' },
    { id: 'yellow', name: 'Yellow', bricklink: 3, rebrickable: 14, ldraw: 14, hex: '#f2cd37' },
    { id: 'green', name: 'Green', bricklink: 6, rebrickable: 2, ldraw: 2, hex: '#237841' },
    { id: 'orange', name: 'Orange', bricklink: 4, rebrickable: 25, ldraw: 25, hex: '#fe8a18' },
    { id: 'tan', name: 'Tan', bricklink: 2, rebrickable: 19, ldraw: 19, hex: '#e4cd9e' },
    { id: 'brown', name: 'Reddish Brown', bricklink: 88, rebrickable: 70, ldraw: 70, hex: '#582a12' },
  ],
  parts: [
    brick('3005', 1, 1, 0.04),
    brick('3004', 1, 2, 0.05),
    brick('3622', 1, 3, 0.07),
    brick('3010', 1, 4, 0.08),
    brick('3009', 1, 6, 0.13),
    brick('3008', 1, 8, 0.18),
    brick('3003', 2, 2, 0.06),
    brick('3002', 2, 3, 0.09),
    brick('3001', 2, 4, 0.11),
    brick('2456', 2, 6, 0.20),
    brick('3007', 2, 8, 0.34),
    brick('6111', 1, 10, 0.25, 'extended'),
    brick('6112', 1, 12, 0.32, 'extended'),
    brick('2465', 1, 16, 0.85, 'extended'),
    brick('3006', 2, 10, 0.45, 'extended'),
    brick('2356', 4, 6, 0.35, 'extended'),
  ],
};

/** Validate a user supplied catalogue (JSON import). Throws with a readable message. */
export function validateCatalogue(cat) {
  if (!cat || !Array.isArray(cat.parts) || !cat.parts.length) throw new Error('Catalogue needs a "parts" array.');
  if (!Array.isArray(cat.colors) || !cat.colors.length) throw new Error('Catalogue needs a "colors" array.');
  for (const p of cat.parts) {
    for (const k of ['id', 'w', 'd', 'price']) if (p[k] === undefined) throw new Error(`Part ${p.id || '?'} is missing "${k}".`);
    if (!(p.w >= 1 && p.d >= 1)) throw new Error(`Part ${p.id} has invalid size.`);
  }
  if (!cat.parts.some((p) => p.w === 1 && p.d === 1)) throw new Error('Catalogue must include the 1 x 1 brick.');
  return true;
}

/** Parts allowed for the layout, filtered to those currently in production. */
export function layoutParts(cat, set = 'extended') {
  return cat.parts
    .filter((p) => p.inProduction !== false && (set === 'extended' || (p.set || 'common') === 'common'))
    .map((p) => ({ ...p, w: Math.max(p.w, p.d), d: Math.min(p.w, p.d) }));
}

export function findColor(cat, id) {
  return cat.colors.find((c) => c.id === id) || cat.colors[0];
}
