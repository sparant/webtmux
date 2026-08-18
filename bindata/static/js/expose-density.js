// The Exposé size ladder — how many tiles are on screen, as one ordered list.
//
// Exposé has three states, not two: closed, a 2×2 block of 4 big tiles, and a
// 3×3 block of 9 smaller ones. Two different inputs walk that ladder and they
// walk it differently, which is why the walk lives here instead of inline at
// each caller:
//
//   Ctrl+Alt+E  — one key, so it has to CYCLE: closed → 4 → 9 → closed. There is
//                 no "other direction" to press.
//   trackpad    — a pinch has a direction, so it STEPS: spread grows (closed → 4
//                 → 9), pinch shrinks (9 → 4 → closed). Stepping clamps at both
//                 ends: a spread on a full 9-tile grid keeps 9 rather than
//                 wrapping round to closed, because "spread more" never means
//                 "dismiss" to a hand that is opening something up.
//
// A "level" is 0 for closed, or the density (the N of the N×N block) when open.
// Dependency-free and pure so it unit-tests without a browser — see
// test/expose-density.test.mjs.

export const CLOSED = 0;

// Open densities, smallest block first. The ladder is closed plus these.
export const DENSITIES = [2, 3];

const LADDER = [CLOSED, ...DENSITIES];

// Where a level sits on the ladder. Anything unrecognised (a density we don't
// have a rung for) reads as closed, so a bad value can only ever under-shoot.
function rung(level) {
  const i = LADDER.indexOf(level);
  return i < 0 ? 0 : i;
}

/** One step toward more tiles; stays put at the top. */
export function growExpose(level) {
  return LADDER[Math.min(rung(level) + 1, LADDER.length - 1)];
}

/** One step toward fewer tiles; the bottom rung is closed. */
export function shrinkExpose(level) {
  return LADDER[Math.max(rung(level) - 1, 0)];
}

/** One step up, wrapping past the top back to closed — the single-key path. */
export function cycleExpose(level) {
  return LADDER[(rung(level) + 1) % LADDER.length];
}
