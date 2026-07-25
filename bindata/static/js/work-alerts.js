// WorkAlerts — decides which recent tabs should be FLASHING for attention.
//
// The stoplight dot (@wt_working: 1 green working / 0 red waiting for work to do /
// 2 amber prompting you — see stoplight.js for the words) answers "what is that
// window doing", but only if you happen to be looking at an 8px dot at the moment it
// changes. This turns the moment of change into something you cannot miss: the tab
// itself flashes.
//
// The rules, and why each one is the way it is:
//
//   RAISE on the TRANSITION out of green, never on the state itself. A window that
//   has been sitting red for an hour is not news; one that stopped while you were
//   reading another window is the entire point. So we compare against the value we
//   last showed, not against a threshold.
//
//   CLEAR when the focused region is showing that window (`active`). That is the
//   literal thing the flash is asking you to do, so it's the only acknowledgement
//   that counts — a re-render, a glance at the strip, or a timeout must not dismiss
//   it. There is deliberately no expiry: a signal that gives up after 30s is exactly
//   the signal you miss when you step away for coffee.
//
//   CLEAR on a return to green. The window un-stopped by itself, so there is nothing
//   left for you to go and look at, and a flash that outlived its cause is noise.
//
//   IGNORE blank ('' — @wt_working unset or never set). It means "this window stopped
//   reporting", which is not an answer either way, so it neither raises nor clears.
//   That is also why an alert stores the value it dropped TO rather than a bare flag:
//   the flash keeps its colour even if the tmux option is cleared underneath it.
//
// Entries are keyed exactly like tabs — (session, window id), not window id alone —
// because a window linked into two sessions has a tab in each and they are
// acknowledged independently: focusing it in one session says nothing about the other.
export class WorkAlerts {
  constructor() {
    this._prev = new Map();     // key -> the @wt_working value we last showed
    this._alerts = new Map();   // key -> the value it dropped to ('0' | '2')
  }

  static key(entry) { return `${entry.session || ''}\x00${entry.id}`; }

  // Stamp every entry with `alert`: '' (quiet), '0' (stopped) or '2' (waiting for
  // you). Mutates in place — the caller hands us the array it is about to render.
  mark(entries) {
    const seen = new Set();
    for (const w of entries) {
      const key = WorkAlerts.key(w);
      seen.add(key);
      const prev = this._prev.get(key);
      this._prev.set(key, w.working);
      const stopped = w.working === '0' || w.working === '2';
      if (w.active || w.working === '1') this._alerts.delete(key);
      // Raise on the drop out of green — or, if it is ALREADY flashing, re-colour to
      // wherever it has got to since (red -> amber = "and now it wants you"). The
      // flash must never disagree with the dot right next to it.
      else if (stopped && (prev === '1' || this._alerts.has(key))) {
        this._alerts.set(key, w.working);
      }
      w.alert = this._alerts.get(key) || '';
    }
    // A tab that left the strip (evicted, ×'d, its window killed) takes its alert
    // with it — otherwise the same window re-entering later would arrive mid-flash,
    // and its stale "previous" value could raise an alert for a change you already saw.
    for (const key of this._prev.keys()) {
      if (!seen.has(key)) { this._prev.delete(key); this._alerts.delete(key); }
    }
    return entries;
  }
}
