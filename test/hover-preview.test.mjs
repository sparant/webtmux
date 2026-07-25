// Unit tests for HoverPreview — the shared "pointing at a window shows it, acting
// switches to it" controller. Run with:
//
//     node --test test/
//
// hover-preview.js only imports capture-cache.js (which imports state-store.js);
// none of them touch lit or xterm, so the module graph loads cleanly under node.
//
// What's worth testing here is the region-choice policy and the borrow/return
// bookkeeping — the parts that decide whether a region gets left showing the wrong
// window. The drawing itself (blitting a capture into an xterm) isn't: it's one
// write call, and there's no terminal in node to observe it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HoverPreview } from '../resources/js/hover-preview.js';

// A TerminalUnit stand-in that records the borrow/return calls and what was painted.
function fakeUnit(windowId) {
  return {
    layout: { activeWindowId: windowId, windows: [] },
    terminal: { writes: [], write(d) { this.writes.push(d); } },
    region: { classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, has(c) { return this._s.has(c); } } },
    held: false,
    ends: [],
    painted: [],
    beginPreviewHold() { this.held = true; },
    endPreviewHold(opts = {}) { this.held = false; this.ends.push(opts); },
    paintOptimistic(id) { this.painted.push(id); return true; },
  };
}

// A SplitManager stand-in. The capture cache is stubbed to always have a frame, so
// _paint takes its normal path.
function fakeManager(units, focused = units[0]) {
  return {
    units,
    focusedUnit: focused,
    captureCache: {
      byPlacement: new Map(),
      get: () => ({ data: '', cols: 80, rows: 24 }),
      request() {},
      addEventListener() {},
      removeEventListener() {},
    },
    navigations: [],
    goToWindowIn(unit, id, session) { this.navigations.push({ unit, id, session }); },
    onHoverPreviewChange() {},
  };
}

// enter() pauses before the first preview; drive that wait explicitly.
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// A live preview keeps a poll interval running, so every test must end with the
// controller idle or node never exits. This wraps that up.
function controller(mgr, t) {
  const hp = new HoverPreview(mgr);
  t.after(() => hp.cancel());
  return hp;
}

test('previewing borrows a region, and leaving gives it back with a repaint', async (t) => {
  const a = fakeUnit('@1');
  const mgr = fakeManager([a]);
  const hp = controller(mgr, t);

  hp.enter('@9', 'services');
  assert.equal(a.held, false, 'nothing is borrowed during the hover pause');
  await settle();

  assert.equal(a.held, true, 'the focused region is lent to the preview');
  assert.equal(a.region.classList.has('previewing'), true, 'the region is marked transient');
  assert.equal(hp.windowId, '@9');

  hp.cancel();
  assert.equal(a.held, false, 'the region is handed back');
  assert.deepEqual(a.ends, [{ restore: true }], 'and told to restore itself');
  assert.deepEqual(a.painted, ['@1'], 'its own window is repainted from the capture cache');
  assert.equal(a.region.classList.has('previewing'), false);
  assert.equal(hp.windowId, '');
});

test('a preview lands in the region that last displayed the window, not the focused one', async (t) => {
  const a = fakeUnit('@1');
  const b = fakeUnit('@2');
  const mgr = fakeManager([a, b], a);
  const hp = controller(mgr, t);
  hp.noteRendered('@9', b);      // @9 was last seen in region b

  hp.enter('@9');
  await settle();

  assert.equal(b.held, true, 'the remembered region hosts it');
  assert.equal(a.held, false, 'the focused region is left alone');
});

test('a remembered region that has since closed falls back to the focused region', async (t) => {
  const a = fakeUnit('@1');
  const gone = fakeUnit('@2');
  const mgr = fakeManager([a], a);   // `gone` is no longer in units
  const hp = controller(mgr, t);
  hp.noteRendered('@9', gone);

  hp.enter('@9');
  await settle();

  assert.equal(gone.held, false, 'the dead region is never chosen');
  assert.equal(a.held, true);
});

test('a window already on screen is not mirrored into another region', async (t) => {
  const a = fakeUnit('@1');
  const b = fakeUnit('@9');          // region b is really showing @9
  const mgr = fakeManager([a, b], a);
  const hp = controller(mgr, t);

  hp.enter('@9');
  await settle();

  assert.equal(a.held, false, 'no region is borrowed — it is already visible');
  assert.equal(b.held, false);
  assert.equal(hp.windowId, '@9', 'but it is still the commit target');
});

test('once engaged, moving to another window switches with no second pause', async (t) => {
  const a = fakeUnit('@1');
  const mgr = fakeManager([a]);
  const hp = controller(mgr, t);

  hp.enter('@9');
  await settle();
  assert.equal(hp.windowId, '@9');

  hp.leave();                        // pointer crosses the gap between two tabs
  hp.enter('@8');                    // …and lands on the next one immediately
  assert.equal(hp.windowId, '@8', 'the next window previews at once, no re-pause');
  assert.equal(a.held, true, 'the region stays borrowed across the swap');
});

test('leaving for good tears the preview down after the grace window', async (t) => {
  const a = fakeUnit('@1');
  const mgr = fakeManager([a]);
  const hp = controller(mgr, t);

  hp.enter('@9');
  await settle();
  hp.leave();
  assert.equal(a.held, true, 'still up during the grace window');

  await settle(400);
  assert.equal(a.held, false, 'torn down once the grace elapses');
  assert.equal(hp.windowId, '');
});

test('committing switches the region that was showing the preview, without restoring it', async (t) => {
  const a = fakeUnit('@1');
  const b = fakeUnit('@2');
  const mgr = fakeManager([a, b], a);
  const hp = controller(mgr, t);
  hp.noteRendered('@9', b);

  hp.enter('@9', 'services');
  await settle();
  hp.commit();

  assert.deepEqual(mgr.navigations, [{ unit: b, id: '@9', session: 'services' }],
    'the window lands in the region you were looking at it in');
  assert.deepEqual(b.ends, [{ restore: false }],
    'no restore — the switch itself repaints, and the buffered output is stale');
  assert.deepEqual(b.painted, [], 'and the old window is not repainted first');
  assert.equal(hp.windowId, '');
});

test('committing works with no preview drawn (a click with no hover)', (t) => {
  const a = fakeUnit('@1');
  const mgr = fakeManager([a]);
  const hp = controller(mgr, t);

  hp.commit('@9', 'services');

  assert.deepEqual(mgr.navigations, [{ unit: a, id: '@9', session: 'services' }]);
});

test('closing the region hosting a preview releases it and forgets it', async (t) => {
  const a = fakeUnit('@1');
  const b = fakeUnit('@2');
  const mgr = fakeManager([a, b], a);
  const hp = controller(mgr, t);
  hp.noteRendered('@9', b);

  hp.enter('@9');
  await settle();
  assert.equal(b.held, true);

  hp.forgetUnit(b);
  assert.equal(b.held, false, 'the dying region is handed back');

  // With b forgotten, the next preview of @9 falls back to the focused region.
  mgr.units = [a];
  hp.enter('@9');
  await settle();
  assert.equal(a.held, true);
});
