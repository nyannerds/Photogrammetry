// Build order: layer by layer, at most `maxPerStep` new bricks per step.

/**
 * @returns { order: Int32Array (brick indices in build order), steps: [{ index, layer, start, count }] }
 */
export function buildSteps(bricks, maxPerStep = 20) {
  const B = bricks.length / 6;
  const idx = Array.from({ length: B }, (_, i) => i);
  // layer, then row (z), then column (x) – a boustrophedon scan keeps each step's bricks spatially together
  idx.sort((a, b) => {
    const ya = bricks[a * 6 + 1], yb = bricks[b * 6 + 1];
    if (ya !== yb) return ya - yb;
    const za = bricks[a * 6 + 2], zb = bricks[b * 6 + 2];
    if (za !== zb) return za - zb;
    const xa = bricks[a * 6], xb = bricks[b * 6];
    return (za & 1) ? xb - xa : xa - xb;
  });
  const steps = [];
  let i = 0;
  while (i < B) {
    const layer = bricks[idx[i] * 6 + 1];
    let j = i;
    while (j < B && bricks[idx[j] * 6 + 1] === layer) j++;
    const layerCount = j - i;
    const parts = Math.ceil(layerCount / maxPerStep);
    // spread the bricks of a layer evenly over its steps (e.g. 21 → 11 + 10, not 20 + 1)
    for (let s = 0; s < parts; s++) {
      const start = i + Math.floor((layerCount * s) / parts);
      const end = i + Math.floor((layerCount * (s + 1)) / parts);
      steps.push({ index: steps.length, layer, start, count: end - start });
    }
    i = j;
  }
  return { order: Int32Array.from(idx), steps };
}
