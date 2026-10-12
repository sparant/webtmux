// Exposé's grid size — how many tiles fill the screen, as an explicit setting.
//
// Opening and sizing used to share one ladder (closed → 2×2 → 3×3 → closed), so
// the open key doubled as a resize key and you had to press it twice to get the
// bigger grid. They are separate now: the chord and the trackpad only open and
// close Exposé, and the grid size is a toggle in Exposé's own header that is
// remembered (shared @wt_state, `expose.grid`).
//
// The value is the N of the N×N block. Dependency-free and pure so it unit-tests
// without a browser — see test/expose-density.test.mjs.

// Grid sizes the header offers, smallest block first.
export const GRID_SIZES = [2, 3];

// 3×3: nine windows at a glance is what Exposé is for; 2×2 is the opt-in for
// reading tiles on a small screen.
export const DEFAULT_GRID = 3;

/** A stored grid size, or the default for anything we don't offer. */
export function normalizeGrid(value) {
  return GRID_SIZES.includes(value) ? value : DEFAULT_GRID;
}
