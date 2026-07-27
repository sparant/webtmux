// Mouse click/drag behavior — the SELECTION half of the wheel's scroll-mode toggle.
//
// The problem it exists for: a program that turns mouse tracking on (Claude Code,
// vim, htop) owns every button press in its pane. xterm sees mouse reporting go
// active, switches its OWN local text selection off, and forwards the press to the
// program — so click-and-drag over the pane highlights nothing. The only way to get
// a selection was to enter tmux copy mode BY HAND first, every single time, which is
// exactly the thing nobody remembers to do before dragging over some output.
//
// So this is a second four-way toggle, deliberately shaped like the scroll one
// (see SCROLL_MODES in terminal-unit.js) because it answers the same question about
// a different gesture — "who gets this, the program or the buffer?":
//
//   app            — every press goes to the program. Its clickable UI works; no
//                    drag ever selects.
//   buffer         — every press is a selection. Nothing reaches the program.
//   adaptive-mode  — ask xterm whether anything is actually listening: a program
//                    with mouse tracking on gets the press, a plain shell doesn't.
//                    ("Does a TUI exist and respond to mouse clicks?")
//   adaptive-probe — the useful one, and the default. A CLICK still goes to the
//                    program (so Claude's buttons keep working), but a click-HOLD-
//                    and-DRAG is a selection. The two gestures don't overlap in
//                    meaning, so nothing has to be given up either way.
//
// The mechanism that makes 'buffer' possible over a mouse-grabbing program is
// xterm's own force-selection escape hatch, not tmux: see forceSelectionModifier.
//
// Dependency-free on purpose — the state machine below is where the subtle part
// lives, so it is unit-tested under node (test/mouse-mode.test.mjs).

// In the order the toolbar button cycles them. Same shape and same names as
// SCROLL_MODES so the two buttons stay learnable as one idea.
export const MOUSE_MODES = ['app', 'buffer', 'adaptive-mode', 'adaptive-probe'];

// Map any stored/unknown value onto a valid mode. Default (unset) is
// 'adaptive-probe': it is the mode this feature was built for — drag-to-select
// without losing the program's clicks — and the one that needs no explaining.
export function normalizeMouseMode(m) {
  return MOUSE_MODES.includes(m) ? m : 'adaptive-probe';
}

// How far the pointer must travel before a press counts as a DRAG rather than a
// click. Small, because the anchor is remembered from the press: the slop only
// delays recognition, it never shifts where the selection starts.
export const DRAG_SLOP_PX = 4;

// A press held this long WITHOUT moving is handed to the program. Someone who
// meant to select has started moving well before this; someone press-and-holding
// a TUI control has not. It also bounds how long a click can be swallowed.
export const HOLD_MS = 250;

export function movedEnough(dx, dy, slop = DRAG_SLOP_PX) {
  return Math.abs(dx) + Math.abs(dy) >= slop;
}

// Who gets this button press: the program ('app'), a local text selection
// ('buffer'), or "can't tell yet, watch what the gesture becomes" ('defer').
//
// `mouseTracking` is xterm's own answer to "is a program listening for the
// mouse?" (terminal.modes.mouseTrackingMode). It is the whole reason the adaptive
// modes can be honest: with nothing listening there is no pass-through to choose,
// so every mode that isn't a flat 'app' resolves to a selection.
export function resolvePress({ mode, mouseTracking = false, inCopyMode = false, detail = 1 } = {}) {
  switch (normalizeMouseMode(mode)) {
    // The two explicit modes mean exactly what they say, copy mode or not —
    // someone who pinned the toggle doesn't want it quietly overridden.
    case 'app': return 'app';
    case 'buffer': return 'buffer';
    // The adaptive modes are the ones asked to "work it out", and a pane already
    // in copy mode has answered: you are reading the buffer, not driving the app.
    case 'adaptive-mode':
      return (mouseTracking && !inCopyMode) ? 'app' : 'buffer';
    default: {
      if (!mouseTracking || inCopyMode) return 'buffer';
      // A double/triple click is never "press a button in the TUI" — it is the
      // word/line select everyone reaches for. Don't make it wait for the drag
      // heuristic it would fail.
      return detail >= 2 ? 'buffer' : 'defer';
    }
  }
}

// What a deferred press turned out to be. Only a drag is ours; a click and a
// motionless hold both belong to the program.
export function deferredVerdict(kind) {
  return kind === 'drag' ? 'buffer' : 'app';
}

// Does acting on a 'buffer' verdict require intercepting the event at all? Only
// when something is grabbing the mouse. With no mouse tracking, xterm's local
// selection is already enabled and already correct — and forcing it there would
// be actively wrong: xterm reads a shift-click on an ENABLED selection as
// "extend the existing one" (_handleIncrementalClick), so a synthesized modifier
// would turn every fresh drag into an extension of the last selection.
export function needsForcedSelection(verdict, mouseTracking) {
  return verdict === 'buffer' && !!mouseTracking;
}

// The modifier that makes xterm abandon its mouse report for one press and run a
// local text selection instead. This is xterm's documented escape hatch, not a
// trick of ours — SelectionService.shouldForceSelection() reads shift on
// Windows/Linux and option on a Mac (the latter gated behind the
// macOptionClickForcesSelection option, which the terminal turns on for this).
// Replaying the press with it set is what lets a drag select over a program that
// would otherwise have swallowed it, WITHOUT changing any tmux mode.
export function forceSelectionModifier(isMac) {
  return isMac ? { altKey: true } : { shiftKey: true };
}

// PressArbiter — holds a press back just long enough to tell a click from a drag.
//
// Used only by 'adaptive-probe', and only while a program is grabbing the mouse.
// The press is swallowed on the way in, because by the time a drag is recognisable
// it is far too late to un-send a button report; whichever way it resolves, the
// event is re-dispatched from the anchor so nothing is lost and nothing lands late.
export class PressArbiter {
  // resolve(verdict, kind) — 'buffer'/'drag', 'app'/'click', or 'app'/'hold'.
  // Timers are injectable so the hold path is testable without waiting.
  // The timer defaults are WRAPPED, not bare `setTimeout`/`clearTimeout`: stored on
  // an object and called as `this._setTimer(...)`, the bare functions get the
  // arbiter as their `this` and a browser throws "Illegal invocation" (node does
  // not, so the unit tests below are blind to it — a real page caught this one).
  constructor({ resolve, slop = DRAG_SLOP_PX, holdMs = HOLD_MS,
                setTimer = (fn, ms) => setTimeout(fn, ms),
                clearTimer = (id) => clearTimeout(id) } = {}) {
    this._resolve = resolve;
    this._slop = slop;
    this._holdMs = holdMs;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._x = 0;
    this._y = 0;
    this._timer = null;
    this._pending = false;
  }

  // Is a press currently being held back? The caller uses this to know whether a
  // move/up belongs to the arbiter or to an already-resolved gesture.
  get pending() { return this._pending; }

  start(x, y) {
    this.cancel();
    this._pending = true;
    this._x = x;
    this._y = y;
    this._timer = this._setTimer(() => { this._timer = null; this._settle('hold'); }, this._holdMs);
  }

  // Returns true when this move is what resolved the press.
  move(x, y) {
    if (!this._pending) return false;
    if (!movedEnough(x - this._x, y - this._y, this._slop)) return false;
    this._settle('drag');
    return true;
  }

  up() {
    if (this._pending) this._settle('click');
  }

  // Drop a pending press without resolving it. Only for teardown — a gesture
  // abandoned this way never reaches the program, which is why it isn't a verdict.
  cancel() {
    if (this._timer) { this._clearTimer(this._timer); this._timer = null; }
    this._pending = false;
  }

  _settle(kind) {
    this.cancel();
    this._resolve?.(deferredVerdict(kind), kind);
  }
}
