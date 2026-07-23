// Client-OS helpers for keybinding labels.
//
// The webtmux SERVER runs on Linux, but the page is viewed in a browser that may
// be on a Mac, Windows, or Linux machine (typically tunnelled/port-forwarded). The
// modifier NAMES a user sees in tooltips and the shortcuts overlay must match the
// keyboard in front of them — a Mac calls the global chord "Control+Option" (⌃⌥),
// everyone else "Ctrl+Alt". The physical keys are identical (ctrlKey + altKey), so
// this only affects labels, never the actual keydown matching.
//
// Detection uses the connecting CLIENT's user-agent, not the server platform.
const _ua = (typeof navigator !== 'undefined' && navigator) || {};
const _plat =
  (_ua.userAgentData && _ua.userAgentData.platform) ||
  _ua.platform ||
  _ua.userAgent ||
  '';

export const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(_plat);

// Human-readable label for the ⌃⌥ global-chord modifier, OS-appropriate.
export const MOD_LABEL = IS_MAC ? 'Control+Option' : 'Ctrl+Alt';

// Per-key <kbd> chip labels for the two modifier keys (symbol + word on Mac,
// plain word on Windows/Linux where the symbols aren't idiomatic).
export const MOD_KEYS = IS_MAC ? ['⌃ Control', '⌥ Option'] : ['Ctrl', 'Alt'];

// Compact single-token chips for dense keycap lists (the shortcuts overlay).
export const MOD_CHIPS = IS_MAC ? ['⌃', '⌥'] : ['Ctrl', 'Alt'];

// "Control+Option+E" / "Ctrl+Alt+E" — the label for a global chord over `key`.
export function chord(key) {
  return `${MOD_LABEL}+${key}`;
}
