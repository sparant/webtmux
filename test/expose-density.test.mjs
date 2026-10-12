// Unit tests for Exposé's grid-size setting. Run with:
//
//     node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_SIZES, DEFAULT_GRID, normalizeGrid } from '../resources/js/expose-density.js';

test('Exposé opens at 3×3 unless told otherwise', () => {
  assert.equal(DEFAULT_GRID, 3);
  assert.equal(normalizeGrid(undefined), 3);
});

test('both offered sizes are kept as chosen', () => {
  for (const n of GRID_SIZES) assert.equal(normalizeGrid(n), n);
  assert.deepEqual(GRID_SIZES, [2, 3]);
});

test('anything else falls back to the default rather than an unstyled grid', () => {
  for (const v of [0, 1, 4, 99, '3', null]) assert.equal(normalizeGrid(v), DEFAULT_GRID);
});
