// Unit tests for HoverPreview — the shared "pointing at a window shows it, acting
// switches to it" controller. Run with:
//
//     node --test test/
//
// hover-preview.js only imports capture-cache.js (which imports state-store.js);
// none of them touch lit or xterm, so the module graph loads cleanly under node.
//
// What's worth testing here is the region-choice policy, the borrow/return
// bookkeeping, and the rule that decides WHETHER a frame may be drawn at all — the
// parts that decide whether a region gets left showing the wrong window, or a screen
// that is older than it looks. The drawing itself is one write call and there's no
// terminal in node to observe it on, but the write is recorded so tests can tell
// "painted" from "still waiting".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HoverPreview } from '../resources/js/hover-preview.js';

// A TerminalUnit stand-in that records the borrow/return calls, the geometry changes
// and what was painted. cols/rows model a region whose fit addon sized it to fill its
// container — the baseline a preview has to restore.
function fakeUnit(windowId, { cols = 80, rows = 24 } = {}) {
  return {
    layout: { activeWindowId: windowId, windows: [] },
    terminal: {
      cols, rows,
      writes: [],
      resizes: [],
      write(d) { this.writes.push(d); },
      resize(c, r) { this.cols = c; this.rows = r; this.resizes.push([c, r]); },
    },
    terminalEl: { style: {} },
    fitAddon: { fits: 0, fit() { this.fits++; } },
    region: { classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, has(c) { return this._s.has(c); } } },
    held: false,
    ends: [],
    painted: [],
    beginPreviewHold() { this.held = true; },
    endPreviewHold(opts = {}) { this.held = false; this.ends.push(opts); },
    paintOptimistic(id) { this.painted.push(id); return true; },
  };
}

// Unix SECONDS, the capture wire format's resolution.
const stamp = (agoMs = 0) => Math.floor((Date.now() - agoMs) / 1000);

// A CaptureCache stand-in that behaves like the real one plus the server behind it:
// request() is answered a round trip later with a freshly stamped frame. `autoReply`
// off leaves the tests in charge of when (or whether) a frame lands.
function fakeCache({ autoReply = true } = {}) {
  const listeners = new Set();
  return {
    byPlacement: new Map(),
    entries: new Map(),
    requests: [],
    autoReply,
    get(id) { return this.entries.get(id); },
    request(ids, force) {
      this.requests.push({ ids, force });
      if (!this.autoReply) return;
      setTimeout(() => { for (const id of ids) this.deliver(id); }, 5);
    },
    // Land a capture for `id`, as CaptureCache.ingest would: into the cache, then out
    // as an 'update' event.
    deliver(id, extra = {}) {
      const entry = { windowId: id, data: '', cols: 80, rows: 24, capturedAt: stamp(), ...extra };
      this.entries.set(id, entry);
      for (const fn of listeners) fn({ detail: { captures: [entry] } });
    },
    // Pre-load a frame WITHOUT anyone having asked for it — a leftover from some
    // earlier poll, which is exactly what a preview must refuse to open on.
    seed(id, ageMs, extra = {}) {
      this.entries.set(id, { windowId: id, data: '', cols: 80, rows: 24, capturedAt: stamp(ageMs), ...extra });
    },
    addEventListener(_t, fn) { listeners.add(fn); },
    removeEventListener(_t, fn) { listeners.delete(fn); },
  };
}

// A SplitManager stand-in.
function fakeManager(units, focused = units[0], cache = fakeCache()) {
  return {
    units,
    focusedUnit: focused,
    captureCache: cache,
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

// ---- freshness ----------------------------------------------------------------
// Capture buffers only refresh while some surface is polling them, so "whatever is
// in the cache" can be arbitrarily old — and a stale screen of a quiet window is
// indistinguishable from a live one. These pin down that a preview waits for a frame
// it actually asked for.

test('a preview asks for a capture while the pointer is still resting', async (t) => {
  const a = fakeUnit('@1');
  const cache = fakeCache({ autoReply: false });
  const mgr = fakeManager([a], a, cache);
  const hp = controller(mgr, t);

  hp.enter('@9');
  await settle(120);               // still inside the enter delay

  assert.equal(a.held, false, 'nothing is drawn yet');
  assert.deepEqual(cache.requests, [{ ids: ['@9'], force: true }],
    'but the capture is already on its way — the wait is spent on the round trip');
});

test('a stale cached frame is refused; the region is left alone until a fresh one lands', async (t) => {
  const a = fakeUnit('@1');
  const cache = fakeCache({ autoReply: false });
  cache.seed('@9', 10 * 60 * 1000);   // a ten-minute-old leftover from some earlier poll
  const mgr = fakeManager([a], a, cache);
  const hp = controller(mgr, t);

  hp.enter('@9');
  await settle();

  assert.equal(a.held, false, 'the region is NOT taken for a frame we cannot date');
  assert.equal(a.region.classList.has('previewing'), false,
    'and it is not marked as previewing — it is still showing its own live window');
  assert.deepEqual(a.terminal.writes, [], 'nothing was blitted');

  cache.deliver('@9');               // the capture we asked for finally arrives

  assert.equal(a.held, true, 'now the region is taken');
  assert.equal(a.region.classList.has('previewing'), true);
  assert.equal(a.terminal.writes.length, 2, 'cleared, then the frame written');
});

test('a frame that never arrives never takes the region, and cancelling is a no-op', async (t) => {
  const a = fakeUnit('@1');
  const mgr = fakeManager([a], a, fakeCache({ autoReply: false }));
  const hp = controller(mgr, t);

  hp.enter('@9');
  await settle();
  hp.cancel();

  assert.equal(a.held, false);
  assert.deepEqual(a.ends, [], 'no hold was ever taken, so none is handed back');
  assert.deepEqual(a.painted, [], 'and the region was never repainted — it never changed');
});

test('a hover that sweeps past a window does not fork a capture for it', async (t) => {
  const a = fakeUnit('@1');
  const cache = fakeCache({ autoReply: false });
  const mgr = fakeManager([a], a, cache);
  const hp = controller(mgr, t);

  hp.enter('@7');                    // pointer crosses three tabs on its way…
  hp.enter('@8');
  hp.enter('@9');                    // …and rests on this one
  await settle(120);

  assert.deepEqual(cache.requests, [{ ids: ['@9'], force: true }],
    'only the window actually rested on is captured');
});

// ---- geometry -----------------------------------------------------------------
// A capture is a fixed cols×rows grid of already-wrapped lines. Blitted into a
// terminal of a different width it re-wraps and shears, so the host is resized to
// the capture and scaled to fit — then put back exactly as it was.

test('the host region is resized to the captured pane and scaled down to fit', async (t) => {
  const a = fakeUnit('@1', { cols: 80, rows: 24 });
  const cache = fakeCache({ autoReply: false });
  const mgr = fakeManager([a], a, cache);
  const hp = controller(mgr, t);

  hp.enter('@9');
  await settle();
  cache.deliver('@9', { cols: 200, rows: 50 });

  assert.equal(a.terminal.cols, 200, 'the terminal takes the capture\'s width');
  assert.equal(a.terminal.rows, 50);
  // min(1, 80/200, 24/50) = 0.4 — the tighter of the two axes.
  assert.equal(a.terminalEl.style.transform, 'scale(0.4)', 'and is scaled to fit the region');

  hp.cancel();
  assert.equal(a.terminal.cols, 80, 'the region gets its own geometry back');
  assert.equal(a.terminal.rows, 24);
  assert.equal(a.terminalEl.style.transform, '', 'and its scale removed');
  assert.equal(a.fitAddon.fits, 1, 'refitted once unscaled, so the fit reads a true box');
});

test('a capture that already fits the region is drawn without scaling it', async (t) => {
  const a = fakeUnit('@1', { cols: 120, rows: 40 });
  const cache = fakeCache({ autoReply: false });
  const mgr = fakeManager([a], a, cache);
  const hp = controller(mgr, t);

  hp.enter('@9');
  await settle();
  cache.deliver('@9', { cols: 80, rows: 24 });

  assert.equal(a.terminal.cols, 80, 'still resized — the grid has to match the frame');
  assert.equal(a.terminalEl.style.transform, '', 'but nothing is scaled: it fits as it is');
});

test('browsing on within one region keeps the hold and restores the ORIGINAL geometry', async (t) => {
  const a = fakeUnit('@1', { cols: 80, rows: 24 });
  const cache = fakeCache({ autoReply: false });
  const mgr = fakeManager([a], a, cache);
  const hp = controller(mgr, t);

  hp.enter('@9');
  await settle();
  cache.deliver('@9', { cols: 200, rows: 50 });
  assert.equal(a.held, true);

  hp.enter('@8');                    // engaged: switches at once
  cache.deliver('@8', { cols: 100, rows: 30 });
  assert.equal(a.terminal.cols, 100, 'the region follows the new frame');
  assert.deepEqual(a.ends, [], 'without ever letting go of the region in between');

  hp.cancel();
  assert.equal(a.terminal.cols, 80, 'and lands back on what the region really was');
  assert.equal(a.terminal.rows, 24);
});

test('a repeated enter() on the same target does not push its capture back forever', async (t) => {
  const a = fakeUnit('@1');
  const cache = fakeCache({ autoReply: false });
  const mgr = fakeManager([a], a, cache);
  const hp = controller(mgr, t);

  // A caller that re-announces the same hover on a tick (arrow-key browsing holding a
  // key, a re-render re-binding the row) must not reset the settle timer each time.
  for (let i = 0; i < 8; i++) { hp.enter('@9'); await settle(20); }

  assert.deepEqual(cache.requests, [{ ids: ['@9'], force: true }],
    'the capture went out once, on the first settle');
});
