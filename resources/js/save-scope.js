// WHICH of a pane's two buffers a save means.
//
// A tmux pane holds two different things, and for a long time the save button
// only ever produced the smaller one. "Download" was built on the same capture
// the Exposé thumbnails read — a snapshot of the VISIBLE SCREEN, 24-odd rows —
// because that is all a thumbnail needs. But the reason anyone saves a terminal
// buffer is the part that has already scrolled past: the build output, the
// stack trace, the log. That was the one thing the button could not give you,
// and nothing on screen said so, because a screenful of text looks exactly like
// a successful save of everything.
//
// So the scope is a choice the dropdown states out loud, and it defaults to the
// whole buffer: asking for a terminal's output and getting only the last screen
// is the surprise worth designing out, while the reverse (a bigger file than you
// needed) is visible the moment you open it.
//
// The same two values drive BOTH destinations — the browser download and the
// file written on the machine tmux runs on — so the dropdown never has to
// explain that its scope means one thing for one button and another for the
// other. They ride the wire as these strings (see webtty/tmux.go).

export const SCOPE_SCROLLBACK = 'scrollback';
export const SCOPE_SCREEN = 'screen';

// The default, and the answer to "what does the button do if nobody chose?".
export const DEFAULT_SAVE_SCOPE = SCOPE_SCROLLBACK;

// Anything unrecognized (a stale persisted value, a typo) resolves to the
// default rather than to the smaller buffer: an unreadable preference must not
// quietly reinstate the behavior this exists to replace.
export function normalizeScope(scope) {
  return scope === SCOPE_SCREEN ? SCOPE_SCREEN : SCOPE_SCROLLBACK;
}

export function isScrollback(scope) {
  return normalizeScope(scope) === SCOPE_SCROLLBACK;
}

// The two radio options, in the order they are offered. `note` is the second
// line: what the choice actually costs or omits, since neither option is wrong
// and the difference is invisible from the screen you are looking at.
export const SCOPE_OPTIONS = [
  {
    value: SCOPE_SCROLLBACK,
    label: 'Entire scrollback buffer',
    note: "everything tmux still holds for this pane, including what has scrolled off screen",
  },
  {
    value: SCOPE_SCREEN,
    label: 'Visible screen only',
    note: 'just the rows on screen right now',
  },
];

// Label for the download button, which is also the clearest statement of what
// the current scope means — it is the button that acts immediately, with no
// filename step in between to reconsider at.
export function downloadLabel(scope) {
  return isScrollback(scope) ? 'Download entire buffer' : 'Download visible screen';
}

// Label for the button that writes a file on the machine tmux runs on. Short:
// it sits beside a path input that already says what it does.
export function saveButtonLabel(scope) {
  return isScrollback(scope) ? 'Save all' : 'Save screen';
}

// What a save of this scope is FETCHING, for the progress line. A scrollback
// read forks a tmux capture over the whole history and can visibly take a
// moment on a deep buffer, which is exactly when a button that looks like it did
// nothing gets clicked again.
export function fetchingText(scope) {
  return isScrollback(scope)
    ? 'Reading the whole buffer…'
    : 'Reading the screen…';
}
