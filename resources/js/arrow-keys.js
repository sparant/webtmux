// What bytes an arrow keypress should put on the wire.
//
// TerminalUnit intercepts arrows before xterm sees them (it wants CSI, never SS3
// — see the caller), and the first version of that intercept keyed on ev.key
// ALONE. That silently flattened every modified arrow: Option+Right, Ctrl+Right
// and Shift+Right all arrived at the pane as a bare `ESC [ C`, so word-wise
// navigation (Option+←/→ in a shell, in Claude Code, in readline) moved the
// cursor one character instead of one word, with no visible sign why.
//
// So the modifiers have to be part of the mapping, not dropped from it. The
// encoding below is the standard xterm modifyOtherKeys form that every terminal
// emits and every line editor parses:
//
//     ESC [ 1 ; <1 + bitmask> <final letter>     bitmask: shift 1, alt 2, ctrl 4, meta 8
//
// Dependency-free and pure (it only reads flags off the event) so it unit-tests
// without a browser — see test/arrow-keys.test.mjs.

// Final CSI letter per arrow, and the unmodified sequence we keep sending.
const FINAL = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };

/**
 * @param {{key: string, shiftKey?: boolean, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean}} ev
 * @param {boolean} isMac  the CLIENT's OS (see os.js) — Macs want the meta-b/meta-f form
 * @returns {string|null} bytes to send, or null if this isn't an arrow key
 */
export function arrowSequence(ev, isMac = false) {
  const final = FINAL[ev.key];
  if (!final) return null;

  const mods =
    (ev.shiftKey ? 1 : 0) |
    (ev.altKey ? 2 : 0) |
    (ev.ctrlKey ? 4 : 0) |
    (ev.metaKey ? 8 : 0);

  // Plain arrow: CSI, deliberately not SS3 (application-cursor mode), as before.
  if (!mods) return '\x1b[' + final;

  // Option/Alt + ←/→ ALONE is the word-jump chord, and it is the one combination
  // where the CSI form is not what editors listen for. Mac keyboards send it as
  // meta-b / meta-f (what "Use Option as Meta key" produces in Terminal.app and
  // iTerm2, and what Claude Code, bash and zsh bind backward-word/forward-word
  // to); elsewhere Alt+←/→ is conventionally delivered as Ctrl+←/→. Same
  // substitution xterm.js makes internally, kept here because we bypass it.
  if (mods === 2 && (final === 'C' || final === 'D')) {
    if (isMac) return final === 'C' ? '\x1bf' : '\x1bb';
    return '\x1b[1;5' + final;
  }

  return '\x1b[1;' + (mods + 1) + final;
}
