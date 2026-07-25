// CopyModeArbiter — decides, key by key, whether someone is DRIVING tmux copy mode
// or TYPING at a pane they forgot was scrolled up.
//
// The problem: copy mode swallows keystrokes as commands, so typing at a scrolled-up
// pane silently does nothing (or worse, jumps the selection around). The old rule —
// "any key leaves copy mode" — fixed that but broke the mode: you couldn't press j
// twice without falling out of it.
//
// The hard part is that vi copy-mode motions ARE ordinary letters, so no single key
// can be classified. The fix is to look at a few keys before deciding, and to hold
// them until the verdict is in so nothing is lost either way:
//
//   DECISIVE — unambiguous copy-mode commands (quit, start/finish a selection,
//     search, Enter, Escape, any control byte). Never held, never "typing".
//   MOTION — real copy-mode motions that are also ordinary letters/digits. A RUN of
//     them is browsing; one mixed with anything else is a word being typed. Kept
//     deliberately narrow (no e/w/b/f/t): the fewer letters in here, the sooner a
//     real word gives itself away. "hello" breaks out on its second key.
//   everything else printable — typing.
//
// Cursor keys, PageUp/Down and the wheel never reach here (they're escape sequences
// / separate messages), so vertical scrolling — overwhelmingly the common way people
// move around copy mode — is untouched by any of this.
export const COPY_DECISIVE = new Set(['q', ' ', 'v', 'V', 'y', '/', '?', '\r', '\n', '\x1b']);
export const COPY_MOTION = new Set(['h', 'j', 'k', 'l', 'g', 'G', 'n', 'N', 'H', 'M', 'L', '0', '$', '^', '{', '}']);

export const COPY_LOOK_KEYS = 3;   // a run this long is deliberate navigation
export const COPY_LOOK_MS = 300;   // …or a lone motion, once the pause says so

export class CopyModeArbiter {
  // sendKeys(str)  — deliver these bytes to the pane (copy-mode commands, or input).
  // exitCopyMode() — leave copy mode; called BEFORE the held keys are delivered so
  //                  they land at the prompt in the order they were typed.
  // now/setTimer/clearTimer are injectable for tests.
  constructor({ sendKeys, exitCopyMode, lookKeys = COPY_LOOK_KEYS, lookMs = COPY_LOOK_MS,
                setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this._sendKeys = sendKeys;
    this._exit = exitCopyMode;
    this._lookKeys = lookKeys;
    this._lookMs = lookMs;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._held = '';
    this._timer = null;
    this._typing = false;
  }

  // Keys currently held pending a verdict (tests + diagnostics).
  get held() { return this._held; }

  // Start arbitrating again — call this whenever the pane ENTERS copy mode. Without
  // it a `typing` verdict stays latched (see handle), which is the point: once we've
  // decided someone is typing a word, the REST of that word must go straight to the
  // prompt, not get re-held because it happens to contain an `l`.
  reset() {
    if (this._timer) { this._clearTimer(this._timer); this._timer = null; }
    this._held = '';
    this._typing = false;
  }

  // Feed one onData chunk. Returns true when the arbiter has taken responsibility for
  // the bytes (held them, or sent them itself); false means "not mine, send normally".
  handle(data) {
    // Already decided this is typing: everything until copy mode is entered again
    // belongs to the shell, untouched and undelayed.
    if (this._typing) return false;
    // A paste, or any multi-byte chunk that isn't an escape sequence, is content —
    // nobody drives copy mode by pasting. Leave copy mode and let it through.
    if (data.length > 1 && data.charCodeAt(0) !== 0x1b) {
      this.flush('typing', data);
      return true;
    }
    // Escape sequences (arrows, PageUp/Down, Home/End…) are copy-mode navigation:
    // never held, never a reason to leave. This is how you actually scroll.
    if (data.charCodeAt(0) === 0x1b && data.length > 1) {
      this.flush('copy');
      return false;
    }
    if (data.length !== 1) return false;

    const ch = data;
    // Unambiguous copy-mode commands settle any pending hold and go straight through.
    if (COPY_DECISIVE.has(ch) || ch < ' ') {
      this.flush('copy');
      return false;
    }
    // A motion that's also a letter: hold it and keep looking.
    if (COPY_MOTION.has(ch)) {
      this._held += ch;
      if (this._timer) { this._clearTimer(this._timer); this._timer = null; }
      if (this._held.length >= this._lookKeys) {
        // A run this long is deliberate navigation, not the start of a word.
        this.flush('copy');
      } else {
        // A lone motion followed by a pause is navigation too — flush it so a single
        // `j` still scrolls promptly rather than waiting for a key that never comes.
        this._timer = this._setTimer(() => { this._timer = null; this.flush('copy'); }, this._lookMs);
      }
      return true;
    }
    // Anything else printable: this is a word. Whatever we were holding was its first
    // letters, so leave copy mode and deliver the lot as input.
    this.flush('typing', ch);
    return true;
  }

  // Resolve a pending hold. 'copy' sends the held keys as copy-mode commands;
  // 'typing' exits copy mode first, so the held keys plus `extra` land at the prompt
  // in the order they were typed. Either way nothing is dropped.
  flush(verdict, extra = '') {
    if (this._timer) { this._clearTimer(this._timer); this._timer = null; }
    const held = this._held;
    this._held = '';
    if (verdict === 'typing') {
      this._typing = true;      // latch until the pane enters copy mode again
      this._exit?.();
      const out = held + extra;
      if (out) this._sendKeys?.(out);
      return;
    }
    if (held) this._sendKeys?.(held);
  }
}
