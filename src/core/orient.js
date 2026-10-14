// Up-axis handling. Scan apps disagree on which axis is "up"; the pipeline works in Y-up.
// Every mapping is a proper rotation (determinant +1), so meshes are never mirrored.

export const UP_AXES = ['+y', '-y', '+z', '-z', '+x', '-x'];

/** Rotate positions (in place) so that the chosen source axis becomes +Y. */
export function reorientToYUp(pos, up) {
  if (up === '+y') return pos;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    switch (up) {
      case '-y': pos[i + 1] = -y; pos[i + 2] = -z; break;
      case '+z': pos[i + 1] = z; pos[i + 2] = -y; break;
      case '-z': pos[i + 1] = -z; pos[i + 2] = y; break;
      case '+x': pos[i] = -y; pos[i + 1] = x; break;
      case '-x': pos[i] = y; pos[i + 1] = -x; break;
      default: throw new Error('Unknown up axis ' + up);
    }
  }
  return pos;
}

/** Row-major 3x3 matrix for the same mapping (used by the viewer to display the raw scan). */
export function upMatrix(up) {
  switch (up) {
    case '+y': return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    case '-y': return [1, 0, 0, 0, -1, 0, 0, 0, -1];
    case '+z': return [1, 0, 0, 0, 0, 1, 0, -1, 0];
    case '-z': return [1, 0, 0, 0, 0, -1, 0, 1, 0];
    case '+x': return [0, -1, 0, 1, 0, 0, 0, 0, 1];
    case '-x': return [0, 1, 0, -1, 0, 0, 0, 0, 1];
    default: throw new Error('Unknown up axis ' + up);
  }
}

/** Next axis when the user presses "rotate 90°" in the UI. */
export function nextUp(up) {
  const order = ['+y', '+z', '-y', '-z'];
  const i = order.indexOf(up);
  return i >= 0 ? order[(i + 1) % order.length] : '+y';
}
