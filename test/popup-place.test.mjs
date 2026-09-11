// Unit tests for placePopup — the one rule that decides where a hint (tooltip.js)
// or a confirmation (confirm-popup.js) lands relative to the control it belongs to.
// Run with:
//
//     node --test test/
//
// popup-place.js is pure geometry with no imports, so it loads cleanly under node.
// The controllers around it are DOM-bound and verified in a browser instead; what
// is worth pinning here is the arithmetic that decides whether a question ends up
// off screen, over the wrong panel, or on top of the thing it is asking about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placePopup, PLACE_MARGIN as M } from '../resources/js/popup-place.js';

const VIEW = { width: 1000, height: 800 };
const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });
const size = (width, height) => ({ width, height });

test('sits just below the anchor, left edges aligned', () => {
  const p = placePopup(rect(100, 100, 20, 18), size(200, 60), { viewport: VIEW });
  assert.equal(p.left, 100);
  assert.equal(p.top, 118 + M);
});

test('right-aligns to the anchor when asked (a × at a panel edge)', () => {
  const p = placePopup(rect(300, 100, 20, 18), size(200, 60), { viewport: VIEW, align: 'right' });
  assert.equal(p.left, 320 - 200);
});

test('flips ABOVE the anchor when there is no room below', () => {
  const anchor = rect(100, 760, 20, 18);            // near the bottom edge
  const p = placePopup(anchor, size(200, 60), { viewport: VIEW });
  assert.equal(p.top, 760 - 60 - M, 'sits above the anchor');
});

test('clamps into the viewport rather than running off the right edge', () => {
  const p = placePopup(rect(950, 100, 20, 18), size(200, 60), { viewport: VIEW });
  assert.equal(p.left, VIEW.width - 200 - M);
});

test('clamps to the left edge for an anchor at x=0', () => {
  const p = placePopup(rect(0, 100, 20, 18), size(200, 60), { viewport: VIEW });
  assert.equal(p.left, M);
});

test('a popup taller than the screen is pinned to the top, not floated off it', () => {
  const p = placePopup(rect(100, 400, 20, 18), size(200, 5000), { viewport: VIEW });
  assert.equal(p.top, M);
});

test('stays inside the bounds box when it fits (a question stays in its panel)', () => {
  // A 330px sidebar on the right; the × sits at its right edge, so a right-aligned
  // 280px popup would start left of the panel and hang over the terminal.
  const bounds = { left: 670, right: 1000 };
  // The × of a short tab near the panel's left edge: right-aligning a 280px popup
  // to it starts at 420, well outside the panel.
  const p = placePopup(rect(682, 200, 18, 18), size(280, 90), {
    viewport: VIEW, align: 'right', bounds,
  });
  assert.equal(p.left, bounds.left + M, 'clamped to the panel, not to the viewport');
  assert.ok(p.left + 280 <= bounds.right, 'and does not overflow the panel');
});

test('ignores a bounds box it cannot fit in, and falls back to the viewport', () => {
  const bounds = { left: 900, right: 1000 };        // 100px panel, 280px popup
  const p = placePopup(rect(982, 200, 18, 18), size(280, 90), {
    viewport: VIEW, align: 'right', bounds,
  });
  assert.equal(p.left, VIEW.width - 280 - M, 'viewport-clamped instead of squashed');
});

test('bounds never push the popup off screen', () => {
  // A panel that extends past the right edge of the viewport.
  const bounds = { left: 700, right: 1400 };
  const p = placePopup(rect(1380, 200, 18, 18), size(280, 90), {
    viewport: VIEW, align: 'right', bounds,
  });
  assert.ok(p.left + 280 <= VIEW.width - M, 'still fully on screen');
});

test('the same anchor gives a hint and a confirmation the same vertical position', () => {
  // The two differ only in horizontal alignment — the whole point of sharing this.
  const anchor = rect(400, 300, 18, 18);
  const tip = placePopup(anchor, size(200, 40), { viewport: VIEW });
  const confirm = placePopup(anchor, size(280, 90), { viewport: VIEW, align: 'right' });
  assert.equal(tip.top, confirm.top);
});

// ---- placeOnSide: a popup that hangs off a named side of a big anchor -----------
import { placeOnSide } from '../resources/js/popup-place.js';

test('placeOnSide: above a tile docked at the bottom, flush when gap is 0', () => {
  const tile = rect(100, 620, 300, 170);
  const p = placeOnSide(tile, size(280, 90), 'above', { viewport: VIEW, gap: 0 });
  assert.deepEqual(p, { left: 100, top: 620 - 90 });
});

test('placeOnSide: below a tile docked at the top, gap applied', () => {
  const tile = rect(100, 44, 300, 170);
  const p = placeOnSide(tile, size(280, 90), 'below', { viewport: VIEW, gap: M });
  assert.deepEqual(p, { left: 100, top: 44 + 170 + M });
});

test('placeOnSide: right of a left-bar tile, top edges aligned', () => {
  const tile = rect(8, 300, 184, 150);
  const p = placeOnSide(tile, size(280, 90), 'right', { viewport: VIEW, gap: 0 });
  assert.deepEqual(p, { left: 192, top: 300 });
});

test('placeOnSide: left of a right-bar tile', () => {
  const tile = rect(808, 300, 184, 150);
  const p = placeOnSide(tile, size(280, 90), 'left', { viewport: VIEW, gap: 0 });
  assert.deepEqual(p, { left: 808 - 280, top: 300 });
});

test('placeOnSide: flips to the opposite side when the named one has no room', () => {
  // "above" a tile at the very top of the screen has nowhere to go.
  const tile = rect(100, 10, 300, 150);
  const p = placeOnSide(tile, size(280, 90), 'above', { viewport: VIEW, gap: 0 });
  assert.equal(p.top, 160);
  // …and "right" of a tile hard against the right edge goes left instead.
  const q = placeOnSide(rect(800, 300, 190, 150), size(280, 90), 'right', { viewport: VIEW, gap: 0 });
  assert.equal(q.left, 800 - 280);
});

test('placeOnSide: clamps along the other axis to stay on screen', () => {
  // A tile at the far right of a bottom bar: the popup would run off the right edge.
  const p = placeOnSide(rect(900, 620, 300, 170), size(280, 90), 'above', { viewport: VIEW, gap: 0 });
  assert.equal(p.left, VIEW.width - M - 280);
  // A tile at the bottom of a left bar: the popup would run off the bottom.
  const q = placeOnSide(rect(8, 700, 184, 150), size(280, 200), 'right', { viewport: VIEW, gap: 0 });
  assert.equal(q.top, VIEW.height - M - 200);
});
