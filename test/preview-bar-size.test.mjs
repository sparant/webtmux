// Unit tests for the docked preview bar's drag-resizable THICKNESS: clamping, the
// per-axis memory, and — the point of the feature's storage shape — that the size is
// kept per webtmux INSTANCE inside the one shared @wt_state blob, so two webtmux
// servers fronting the same tmux server never overwrite each other's bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAR_THICK_DEFAULT, BAR_THICK_MIN, barAxis, clampBarThick, barThickFor, withBarThick,
  dragThick,
} from '../resources/js/preview-slots.js';

test('top/bottom share one axis, left/right the other', () => {
  assert.equal(barAxis('top'), 'tb');
  assert.equal(barAxis('bottom'), 'tb');
  assert.equal(barAxis('left'), 'lr');
  assert.equal(barAxis('right'), 'lr');
});

test('a thickness is clamped to [MIN, 75% of the viewport]', () => {
  assert.equal(clampBarThick(10, 1000), BAR_THICK_MIN);
  assert.equal(clampBarThick(900, 1000), 750);
  assert.equal(clampBarThick(321.6, 1000), 322);
  assert.equal(clampBarThick('junk', 1000), BAR_THICK_DEFAULT);
  // A viewport too small for MIN still yields MIN, never less.
  assert.equal(clampBarThick(500, 60), BAR_THICK_MIN);
  assert.equal(clampBarThick(5000), 5000);
});

test('nothing stored reads back as the default', () => {
  assert.equal(barThickFor({}, '8090', 'bottom'), BAR_THICK_DEFAULT);
  assert.equal(barThickFor(undefined, '8090', 'left'), BAR_THICK_DEFAULT);
  assert.equal(barThickFor({ barSize: { 8090: { tb: -3 } } }, '8090', 'top'), BAR_THICK_DEFAULT);
});

test('sizes are kept per instance and per axis', () => {
  let pip = {};
  pip = { barSize: withBarThick(pip, '8090', 'bottom', 320) };
  pip = { barSize: withBarThick(pip, '8090', 'left', 260) };
  pip = { barSize: withBarThick(pip, '9000', 'top', 140) };
  assert.equal(barThickFor(pip, '8090', 'top'), 320);
  assert.equal(barThickFor(pip, '8090', 'right'), 260);
  assert.equal(barThickFor(pip, '9000', 'bottom'), 140);
  assert.equal(barThickFor(pip, '9000', 'left'), BAR_THICK_DEFAULT);
  assert.equal(barThickFor(pip, '7777', 'top'), BAR_THICK_DEFAULT);
});

test('withBarThick does not mutate the section it was given', () => {
  const pip = { barSize: { 8090: { tb: 300 } } };
  const next = withBarThick(pip, '8090', 'left', 250);
  assert.deepEqual(pip.barSize, { 8090: { tb: 300 } });
  assert.deepEqual(next, { 8090: { tb: 300, lr: 250 } });
});

test('a drag measures from the docked edge, minus the bar\'s own offset', () => {
  // 1000x800 window, toolbar 44px above top/side bars.
  assert.equal(dragThick('top', 0, 344, 1000, 800, 44), 300);
  assert.equal(dragThick('bottom', 0, 500, 1000, 800, 0), 300);
  assert.equal(dragThick('left', 250, 0, 1000, 800, 0), 250);
  assert.equal(dragThick('right', 700, 0, 1000, 800, 0), 300);
});
