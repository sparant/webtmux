// When the help overlay is on screen — the hold-to-reveal state machine.
//
// THE GESTURE: hold the global chord's two modifiers (⌃⌥ on a Mac, Ctrl+Alt
// elsewhere) WITHOUT pressing a key, and after HOLD_DELAY the overlay appears. It
// stays exactly as long as the chord is held, and every hotkey and click keeps
// working while it is up — the overlay only watches, it never takes an event.
//
// Pressing a real key (or clicking) during the hold says "I knew what I wanted",
// so the pending reveal is cancelled for the rest of that hold. Shift is the one
// key that does NOT cancel it: ⇧ is half of several chords (⇧I, ⇧N), and a user
// reaching for one of those is exactly the user the overlay is for.
//
// THE FIRST-RUN MODE ('sticky'): on a tab's first connection the overlay is
// shown without a hold, and stays until the chord is TAPPED — both modifiers down
// and up again with nothing pressed in between. That tap is also the lesson: the
// same two keys, held, bring it back.
//
// DOM-free on purpose (events are plain objects with key/ctrlKey/altKey/…) so the
// timing rules are testable under node — see test/help-hold.test.mjs.

export const HOLD_DELAY = 1000;

const isChordMod = (key) => key === 'Control' || key === 'Alt';

export class HelpHold {
  // onChange(mode) — mode is null (hidden), 'hold' or 'sticky'.
  // timers lets a test substitute setTimeout/clearTimeout.
  constructor(onChange, { delay = HOLD_DELAY, timers = globalThis } = {}) {
    this.onChange = onChange;
    this.delay = delay;
    this.timers = timers;
    this.mode = null;
    this.held = false;      // both chord modifiers are down right now
    this.dirty = false;     // something else was pressed/clicked during this hold
    this._timer = null;
  }

  _set(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onChange?.(mode);
  }

  _cancelTimer() {
    if (this._timer != null) this.timers.clearTimeout(this._timer);
    this._timer = null;
  }

  // First connection: up until tapped away.
  showSticky() { this._set('sticky'); }

  hide() {
    this._cancelTimer();
    this._set(null);
  }

  // A chord held while AltGr is the reason ctrl+alt are both set is not our chord
  // (Windows reports AltGr as Ctrl+Alt), and neither is anything with ⌘ in it.
  static _chordState(ev) {
    const altGr = typeof ev.getModifierState === 'function' && ev.getModifierState('AltGraph');
    return !!(ev.ctrlKey && ev.altKey && !ev.metaKey && !altGr);
  }

  keydown(ev) {
    const chord = HelpHold._chordState(ev);
    if (isChordMod(ev.key)) {
      if (chord && !this.held) {
        this.held = true;
        this.dirty = false;
        if (!this.mode) {
          this._cancelTimer();
          this._timer = this.timers.setTimeout(() => {
            this._timer = null;
            if (this.held && !this.dirty) this._set('hold');
          }, this.delay);
        }
      }
      return;
    }
    if (ev.key === 'Shift') return;
    if (this.held) {
      if (!chord) { this._released(); return; }   // a keyup we never saw
      this.dirty = true;
      this._cancelTimer();
    }
  }

  keyup(ev) {
    if (!this.held) return;
    if (isChordMod(ev.key) || !HelpHold._chordState(ev)) this._released();
  }

  // A click (or any pointer press) during the hold is an action, like a key.
  pointerdown(ev) {
    if (!this.held) return;
    if (!HelpHold._chordState(ev)) { this._released(); return; }
    this.dirty = true;
    this._cancelTimer();
  }

  // Pointer moves carry the modifier state too — the cheapest way to notice a
  // release that happened while the page had no keyboard focus.
  pointermove(ev) {
    if (this.held && !HelpHold._chordState(ev)) this._released();
  }

  // Switching tabs/windows swallows the keyup.
  blur() {
    this.held = false;
    this._cancelTimer();
    if (this.mode === 'hold') this._set(null);
  }

  _released() {
    const clean = !this.dirty;
    this.held = false;
    this.dirty = false;
    this._cancelTimer();
    if (this.mode === 'hold') this._set(null);
    else if (this.mode === 'sticky' && clean) this._set(null);
  }
}
