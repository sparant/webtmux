// Unit tests for the mouse click/drag mode — who gets a button press, the program
// or a local text selection. Run with:
//
//     node --test test/
//
// mouse-mode.js is dependency-free, so it loads directly under node. The arbiter's
// timers are injected, so the "held still, never moved" path is exercised without
// waiting 250ms for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOUSE_MODES, normalizeMouseMode, resolvePress, deferredVerdict, movedEnough,
  needsForcedSelection, forceSelectionModifier, leaveCopyModeFirst, PressArbiter,
  DRAG_SLOP_PX,
} from '../resources/js/mouse-mode.js';

// ---- mode normalisation ------------------------------------------------------

test('an unset or unknown mode lands on adaptive-probe', () => {
  // The default has to be the drag-to-select one: it is the whole point of the
  // toggle, and the only mode nobody has to be told about.
  assert.equal(normalizeMouseMode(undefined), 'adaptive-probe');
  assert.equal(normalizeMouseMode(''), 'adaptive-probe');
  assert.equal(normalizeMouseMode('nonsense'), 'adaptive-probe');
  for (const m of MOUSE_MODES) assert.equal(normalizeMouseMode(m), m, `${m} survives`);
});

// ---- press resolution --------------------------------------------------------

test('the explicit modes ignore everything else about the press', () => {
  for (const tracking of [true, false]) {
    for (const copy of [true, false]) {
      const ctx = { mouseTracking: tracking, inCopyMode: copy };
      assert.equal(resolvePress({ mode: 'app', ...ctx }), 'app');
      assert.equal(resolvePress({ mode: 'buffer', ...ctx }), 'buffer');
    }
  }
});

test('auto hands the press over only while a program is grabbing the mouse', () => {
  assert.equal(resolvePress({ mode: 'adaptive-mode', mouseTracking: true }), 'app');
  assert.equal(resolvePress({ mode: 'adaptive-mode', mouseTracking: false }), 'buffer');
});

test('auto+ defers a lone click over a mouse-grabbing program, and only then', () => {
  // The deferral is the expensive bit (the press is swallowed until it resolves),
  // so it must not happen when there is nothing to pass the press to.
  assert.equal(resolvePress({ mode: 'adaptive-probe', mouseTracking: true }), 'defer');
  assert.equal(resolvePress({ mode: 'adaptive-probe', mouseTracking: false }), 'buffer');
});

test('a pane already in copy mode is reading, so auto selects', () => {
  assert.equal(resolvePress({ mode: 'adaptive-mode', mouseTracking: true, inCopyMode: true }), 'buffer');
});

test('auto+ keeps giving the program its clicks even in copy mode', () => {
  // Selecting now ENTERS copy mode, so short-circuiting here would mean one
  // drag-select quietly turns every later click into a selection as well — the
  // same "you are stuck in a mode you never chose" friction, just moved.
  assert.equal(resolvePress({ mode: 'adaptive-probe', mouseTracking: true, inCopyMode: true }), 'defer');
  // Still 'buffer' with nothing listening: there is no program to click.
  assert.equal(resolvePress({ mode: 'adaptive-probe', mouseTracking: false, inCopyMode: true }), 'buffer');
});

test('a click handed to the program leaves copy mode first, in auto+ only', () => {
  assert.equal(leaveCopyModeFirst({ mode: 'adaptive-probe', verdict: 'app', inCopyMode: true }), true);
  // Nothing to leave.
  assert.equal(leaveCopyModeFirst({ mode: 'adaptive-probe', verdict: 'app', inCopyMode: false }), false);
  // A selection obviously must not drop the mode it just entered.
  assert.equal(leaveCopyModeFirst({ mode: 'adaptive-probe', verdict: 'buffer', inCopyMode: true }), false);
  // The flat modes never enter copy mode themselves, so they don't get to exit a
  // copy mode the user put the pane in deliberately.
  assert.equal(leaveCopyModeFirst({ mode: 'app', verdict: 'app', inCopyMode: true }), false);
  assert.equal(leaveCopyModeFirst({ mode: 'adaptive-mode', verdict: 'app', inCopyMode: true }), false);
});

test('a double-click selects immediately instead of waiting to be a drag', () => {
  // Double-click-to-select-a-word can never pass the drag test (it does not move),
  // so deferring it would send both clicks to the program and select nothing.
  const ctx = { mode: 'adaptive-probe', mouseTracking: true };
  assert.equal(resolvePress({ ...ctx, detail: 1 }), 'defer');
  assert.equal(resolvePress({ ...ctx, detail: 2 }), 'buffer');
  assert.equal(resolvePress({ ...ctx, detail: 3 }), 'buffer');
});

// ---- the force-selection escape hatch ----------------------------------------

test('a selection is only forced when something would otherwise steal the press', () => {
  assert.equal(needsForcedSelection('buffer', true), true);
  // With no mouse tracking xterm already selects, and forcing it would be WRONG:
  // a shift-press on an enabled selection EXTENDS the previous one.
  assert.equal(needsForcedSelection('buffer', false), false);
  assert.equal(needsForcedSelection('app', true), false);
  assert.equal(needsForcedSelection('defer', true), false);
});

test('the forced-selection modifier matches what xterm looks for per platform', () => {
  assert.deepEqual(forceSelectionModifier(false), { shiftKey: true });
  assert.deepEqual(forceSelectionModifier(true), { altKey: true });
});

// ---- drag threshold ----------------------------------------------------------

test('the drag threshold is a distance, not a per-axis one', () => {
  assert.equal(movedEnough(0, 0), false);
  assert.equal(movedEnough(DRAG_SLOP_PX - 1, 0), false);
  assert.equal(movedEnough(DRAG_SLOP_PX, 0), true);
  assert.equal(movedEnough(0, -DRAG_SLOP_PX), true, 'direction is irrelevant');
  // Diagonal drift that clears neither axis alone still clears the threshold.
  assert.equal(movedEnough(2, 2), true);
});

// ---- the arbiter -------------------------------------------------------------

// Records verdicts and lets a test fire the pending hold timer by hand.
function arb(opts = {}) {
  const log = [];
  let pending = null;
  const a = new PressArbiter({
    resolve: (verdict, kind) => log.push(`${verdict}/${kind}`),
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => { pending = null; },
    ...opts,
  });
  return [a, log, {
    hold: () => { const f = pending; pending = null; if (f) f(); },
    holdArmed: () => pending !== null,
  }];
}

test('a press that moves is a selection', () => {
  const [a, log] = arb();
  a.start(100, 100);
  assert.equal(a.move(101, 100), false, 'a pixel of tremor is not a drag');
  assert.deepEqual(log, [], 'and nothing has been decided yet');
  assert.equal(a.move(120, 100), true, 'clearing the threshold resolves it');
  assert.deepEqual(log, ['buffer/drag']);
});

test('a press that is released without moving is the program\'s click', () => {
  const [a, log] = arb();
  a.start(10, 10);
  a.up();
  assert.deepEqual(log, ['app/click']);
});

test('a press held still is handed over without waiting for the release', () => {
  // Press-and-hold on a TUI control must not stay swallowed until mouseup, or the
  // program sees the press only after the gesture it was meant to start is over.
  const [a, log, t] = arb();
  a.start(10, 10);
  assert.equal(t.holdArmed(), true);
  t.hold();
  assert.deepEqual(log, ['app/hold']);
});

test('a press resolves exactly once, however the rest of the gesture plays out', () => {
  const [a, log, t] = arb();
  a.start(0, 0);
  a.move(50, 50);                 // -> buffer/drag
  assert.equal(t.holdArmed(), false, 'the hold timer is cancelled on resolution');
  assert.equal(a.move(80, 80), false, 'later moves are not the arbiter\'s any more');
  a.up();                         // the release must not add a second verdict
  assert.deepEqual(log, ['buffer/drag']);
});

test('the drag threshold is measured from the anchor, not the last move', () => {
  // Otherwise a slow drag never resolves: each individual move is under the slop.
  const [a, log] = arb();
  a.start(0, 0);
  a.move(1, 0);
  a.move(2, 0);
  a.move(3, 0);
  assert.deepEqual(log, [], 'still inside the slop from the anchor');
  a.move(4, 0);
  assert.deepEqual(log, ['buffer/drag']);
});

test('cancel drops a pending press without giving anyone a verdict', () => {
  const [a, log, t] = arb();
  a.start(5, 5);
  a.cancel();
  assert.equal(a.pending, false);
  assert.equal(t.holdArmed(), false, 'and takes the timer with it');
  a.up();
  a.move(999, 999);
  assert.deepEqual(log, [], 'a cancelled press stays cancelled');
});

test('starting a fresh press abandons a stale one instead of stacking timers', () => {
  const [a, log, t] = arb();
  a.start(0, 0);
  a.start(200, 200);              // e.g. a mouseup that never arrived
  t.hold();
  assert.deepEqual(log, ['app/hold'], 'one verdict, from the second press');
  a.move(201, 200);
  assert.deepEqual(log, ['app/hold'], 'and the first press left nothing behind');
});

test('deferredVerdict keeps drag as the only gesture the buffer claims', () => {
  assert.equal(deferredVerdict('drag'), 'buffer');
  assert.equal(deferredVerdict('click'), 'app');
  assert.equal(deferredVerdict('hold'), 'app');
});
