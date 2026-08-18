// Unit tests for the Exposé size ladder. Run with:
//
//     node --test test/
//
// expose-density.js is dependency-free and pure, so it loads directly under node.
// The behavior these lock down: a trackpad spread used to be a one-shot "open at
// 2×2" and a pinch a one-shot "close", so the 3×3 rung was reachable only from
// the keyboard and a spread on an already-open Exposé did nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSED, growExpose, shrinkExpose, cycleExpose } from '../resources/js/expose-density.js';

test('a spread walks up the ladder: closed → 2×2 → 3×3', () => {
  assert.equal(growExpose(CLOSED), 2);
  assert.equal(growExpose(2), 3);
});

test('a spread on the biggest grid stays there — it never wraps to closed', () => {
  assert.equal(growExpose(3), 3);
});

test('a pinch walks back down, and the last one closes', () => {
  assert.equal(shrinkExpose(3), 2);
  assert.equal(shrinkExpose(2), CLOSED);
});

test('a pinch with nothing open is a no-op', () => {
  assert.equal(shrinkExpose(CLOSED), CLOSED);
});

test('spread then pinch returns to where it started, from every rung', () => {
  for (const level of [CLOSED, 2, 3]) {
    assert.equal(shrinkExpose(growExpose(level)), level === 3 ? 2 : level);
  }
});

test('the single key cycles instead of clamping: closed → 2×2 → 3×3 → closed', () => {
  assert.equal(cycleExpose(CLOSED), 2);
  assert.equal(cycleExpose(2), 3);
  assert.equal(cycleExpose(3), CLOSED);
});

test('an unrecognised level reads as closed rather than skipping a rung', () => {
  assert.equal(growExpose(undefined), 2);
  assert.equal(growExpose(99), 2);
  assert.equal(shrinkExpose(99), CLOSED);
});
