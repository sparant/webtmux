// Unit tests for planRegionMove — "put THAT window in THIS pane", the rule behind
// the toolbar's region picker and a recents tab dropped on a region. Run with:
//
//     node --test test/
//
// What matters here is the exchange: a window is visible in at most one region, so
// sending one that is already on screen has to move the OTHER region too, and it
// must never end with two regions on one window or a region left blank.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRegionMove } from '../resources/js/region-move.js';

const views = (...pairs) => pairs.map(([windowId, session = 'services']) => ({ windowId, session }));

test('a free window is simply placed in the region asked for', () => {
  const plan = planRegionMove({
    views: views(['@1'], ['@2']), target: 1, windowId: '@9', session: 'services',
  });
  assert.deepEqual(plan.moves, [{ index: 1, windowId: '@9', session: 'services' }]);
  assert.equal(plan.focus, 1);
  assert.equal(plan.vacate, null);
});

test('a window another region has is EXCHANGED, so neither region is left blank', () => {
  // Region 0 shows @9; the user sends @9 to region 1, which shows @2.
  const plan = planRegionMove({
    views: views(['@9'], ['@2']), target: 1, windowId: '@9', session: 'services',
  });
  assert.deepEqual(plan.moves, [
    { index: 1, windowId: '@9', session: 'services' },
    { index: 0, windowId: '@2', session: 'services' },
  ], 'the target moves first, then the region that gave the window up takes its view');
  assert.equal(plan.focus, 1, 'focus follows the window you aimed');
  assert.equal(plan.vacate, null);
});

test('the exchange is its own inverse — doing it again puts both panes back', () => {
  const start = views(['@9'], ['@2']);
  const first = planRegionMove({ views: start, target: 1, windowId: '@9' });
  const after = start.map((v) => ({ ...v }));
  for (const m of first.moves) after[m.index] = { windowId: m.windowId, session: m.session };

  const back = planRegionMove({ views: after, target: 0, windowId: '@9' });
  for (const m of back.moves) after[m.index] = { windowId: m.windowId, session: m.session };
  assert.deepEqual(after.map((v) => v.windowId), ['@9', '@2']);
});

test('asking for the window a region already shows just focuses that region', () => {
  const plan = planRegionMove({
    views: views(['@1'], ['@9']), target: 1, windowId: '@9', session: 'services',
  });
  assert.deepEqual(plan.moves, [], 'nothing is sent to tmux');
  assert.equal(plan.focus, 1);
});

test('…but the SAME window in another session is a real move, not a focus', () => {
  // @9 is linked into two sessions; region 1 is looking at it through 'services'
  // and the tab dragged over is its 'build' view. Different view, same id.
  const plan = planRegionMove({
    views: views(['@1', 'services'], ['@9', 'services']), target: 1, windowId: '@9', session: 'build',
  });
  assert.deepEqual(plan.moves, [{ index: 1, windowId: '@9', session: 'build' }]);
});

test('a region that has nothing to give in exchange is sent to pick for itself', () => {
  // Region 1 has not landed on a window yet (mid-boot). Sending its neighbour's
  // window there would otherwise leave region 0 showing the same window twice over.
  const plan = planRegionMove({
    views: [{ windowId: '@9', session: 'services' }, { windowId: null, session: null }],
    target: 1, windowId: '@9',
  });
  assert.deepEqual(plan.moves, [{ index: 1, windowId: '@9', session: '' }]);
  assert.equal(plan.vacate, 0, 'the displaced region auto-picks rather than mirroring');
});

test('a single region is a legal target — the picker is not the only caller', () => {
  const plan = planRegionMove({ views: views(['@1']), target: 0, windowId: '@9' });
  assert.deepEqual(plan.moves, [{ index: 0, windowId: '@9', session: '' }]);
});

test('nonsense is refused rather than planned', () => {
  assert.equal(planRegionMove({ views: views(['@1']), target: 3, windowId: '@9' }), null);
  assert.equal(planRegionMove({ views: views(['@1']), target: 0, windowId: '' }), null);
  assert.equal(planRegionMove({ views: null, target: 0, windowId: '@9' }), null);
  assert.equal(planRegionMove(), null);
});
