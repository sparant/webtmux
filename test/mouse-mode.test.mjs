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
  DRAG_SLOP_PX, isExtendPress, cellOffset, extendAnchor, selectionSpan, viewLeftItsWindow,
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

// ---- shift-click: adjust an existing selection's endpoint ---------------------

test('shift-click is an adjustment only when there is something to adjust', () => {
  // With nothing selected the press has to fall through untouched: on Linux shift
  // is also the force-selection modifier, and claiming it unconditionally would
  // eat the shift-drag that selects over a mouse-grabbing program.
  assert.equal(isExtendPress({ shiftKey: true, hasSelection: true }), true);
  assert.equal(isExtendPress({ shiftKey: true, hasSelection: false }), false);
  assert.equal(isExtendPress({ shiftKey: false, hasSelection: true }), false);
  assert.equal(isExtendPress({ shiftKey: true, hasSelection: true, button: 2 }), false,
    'right-click stays the program/browser menu');
  assert.equal(isExtendPress({}), false);
});

test('cells order by buffer position, not by column', () => {
  // The whole reason offsets exist here: row 4 column 0 comes AFTER row 3 column 70.
  assert.ok(cellOffset({ x: 0, y: 4 }, 80) > cellOffset({ x: 70, y: 3 }, 80));
});

const SEL = { start: { x: 10, y: 5 }, end: { x: 20, y: 7 } };   // a forward drag
const COLS = 80;

test('a remembered anchor is kept, so repeated shift-clicks pivot on one point', () => {
  const anchor = { x: 10, y: 5 };
  // Clicking well past the far end must NOT re-anchor on the end nearest it.
  const kept = extendAnchor(anchor, SEL, { x: 40, y: 9 }, COLS);
  assert.deepEqual(kept, anchor);
  // ...and clicking back the other way keeps the same pivot rather than flipping.
  assert.deepEqual(extendAnchor(anchor, SEL, { x: 2, y: 1 }, COLS), anchor);
});

test('an upward drag anchors at its BOTTOM end, and extending honours that', () => {
  const anchor = { x: 20, y: 7 };            // the press that started it, dragged up
  assert.deepEqual(extendAnchor(anchor, SEL, { x: 0, y: 2 }, COLS), anchor);
  // Extending from there runs from the click up to the anchor, not down from the top.
  assert.deepEqual(selectionSpan(anchor, { x: 0, y: 2 }, COLS),
    { x: 0, y: 2, length: 5 * COLS + 20 });
});

test('a selection with no anchor of ours extends from the end farthest from the click', () => {
  // Nothing else is knowable, and it is the reading that keeps the near side moving.
  assert.deepEqual(extendAnchor(null, SEL, { x: 30, y: 9 }, COLS), SEL.start);
  assert.deepEqual(extendAnchor(null, SEL, { x: 0, y: 1 }, COLS), SEL.end);
  // A stale anchor — one that is no longer an end of what is selected — is no
  // better than none, and must not be trusted just because it exists.
  assert.deepEqual(extendAnchor({ x: 3, y: 99 }, SEL, { x: 30, y: 9 }, COLS), SEL.start);
});

test('the span runs from whichever side is lower, so backwards extends work', () => {
  const anchor = { x: 10, y: 5 };
  assert.deepEqual(selectionSpan(anchor, { x: 15, y: 5 }, COLS), { x: 10, y: 5, length: 5 });
  assert.deepEqual(selectionSpan(anchor, { x: 5, y: 5 }, COLS), { x: 5, y: 5, length: 5 });
  assert.deepEqual(selectionSpan(anchor, { x: 12, y: 6 }, COLS),
    { x: 10, y: 5, length: COLS + 2 });
});

test('a click on the anchor itself leaves a cell selected, not an empty highlight', () => {
  // An emptied selection would also throw away the anchor's only proof that it is
  // still an end of the selection — the next shift-click would have to guess.
  assert.deepEqual(selectionSpan({ x: 10, y: 5 }, { x: 10, y: 5 }, COLS),
    { x: 10, y: 5, length: 1 });
});

test('an endpoint at the end of a line normalises onto the next row', () => {
  // A boundary click can land on column `cols`, which is not a cell — as an offset
  // it is simply the start of the row below, which is where select() wants it.
  assert.deepEqual(selectionSpan({ x: COLS, y: 4 }, { x: 10, y: 6 }, COLS),
    { x: 0, y: 5, length: COLS + 10 });
});

// ---- how long a selection lives ----------------------------------------------

test('a highlight ends when a different window is painted into the pane', () => {
  // The bug: the coordinates stay valid while the TEXT under them does not, so the
  // highlight sat over whatever the next window happened to print in those cells.
  assert.equal(viewLeftItsWindow({ shown: '@3', next: '@4' }), true);
  assert.equal(viewLeftItsWindow({ shown: '@3', next: '@3' }), false);
});

test('a view we cannot name is never treated as a change', () => {
  // The first layout after a connect ESTABLISHES what is on screen; reading it as a
  // switch would drop a selection nothing had disturbed. Same for a window id the
  // layout did not carry — a selection is not thrown away on a guess.
  assert.equal(viewLeftItsWindow({ shown: null, next: '@4' }), false);
  assert.equal(viewLeftItsWindow({ shown: '@3', next: null }), false);
  assert.equal(viewLeftItsWindow({}), false);
});
