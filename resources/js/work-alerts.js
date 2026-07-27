// WorkAlerts — decides which windows should be FLASHING for attention.
//
// The stoplight dot (@wt_working: 1 green working / 0 red waiting for work to do /
// 2 amber prompting you — see stoplight.js for the words) answers "what is that
// window doing", but only if you happen to be looking at an 8px dot at the moment it
// changes. This turns the moment of change into something you cannot miss: the
// surfaces showing that window flash.
//
// SCOPE. This runs over EVERY (session, window) placement on the tmux server, not
// just the ≤5 in the recents strip. It used to be fed the strip alone, which meant a
// window that dropped out of green while its tab was evicted produced no signal at
// all, anywhere — the exact gap the strip's overflow arrow exists to close. The
// consumers (recents strip, sidebar window list, preview/PiP tiles, overflow arrow)
// all read their flash out of the ONE registry below, so a window can never be
// flashing in one surface and quiet in another.
//
// The rules, and why each one is the way it is:
//
//   RAISE on the TRANSITION out of green, never on the state itself. A window that
//   has been sitting red for an hour is not news; one that stopped while you were
//   reading another window is the entire point. So we compare against the value we
//   last showed, not against a threshold.
//
//   CLEAR when the window is on screen (`active`) ANYWHERE — see the keying note
//   below for why "anywhere" and not "in this session". That is the literal thing the
//   flash is asking you to do, so it's the only acknowledgement that counts — a
//   re-render, a glance at the strip, or a timeout must not dismiss it. There is
//   deliberately no expiry: a signal that gives up after 30s is exactly the signal
//   you miss when you step away for coffee. (The caller decides what "on screen"
//   means; SplitManager passes "some terminal region is displaying this placement".)
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
// so a window linked into two sessions flashes in BOTH of its tabs. They are raised
// independently (each placement watches its own transition), but ACKNOWLEDGED
// TOGETHER: looking at the window in one session clears the flash in every session.
//
// That last rule is the opposite of what this module shipped with, and the reversal is
// the point. The flash asks you to go and LOOK at a window; the two tabs of a linked
// window are two doors onto one screen, so walking through either one answers the
// question. Under the old per-placement rule the second tab kept flashing about news
// you had already read, and the only way to quiet it was to visit the same screen
// again through the other door — which taught you to dismiss flashes instead of trust
// them. The keying stays per placement because that is what the SURFACES are: each tab
// still has to be told whether it is flashing.
//
// Every raise also carries a SEQUENCE number. Without one there is no "most recent"
// among several flashing windows, and taking you to the latest one is the overflow
// arrow's whole job. A re-colour (red -> amber, "and now it wants you") bumps it too:
// that is fresh news, not a continuation.
export class WorkAlerts {
  constructor() {
    this._prev = new Map();     // key -> the @wt_working value we last showed
    this._alerts = new Map();   // key -> { value: '0'|'2', seq }
    this._seq = 0;
  }

  static key(entry) { return WorkAlerts.keyOf(entry.session, entry.id); }

  static keyOf(session, id) { return `${session || ''}\x00${id}`; }

  // Stamp every entry with `alert`: '' (quiet), '0' (stopped) or '2' (waiting for
  // you), plus `alertSeq` (0 when quiet) for "which of these is the most recent".
  // Mutates in place — the caller hands us the array it is about to render.
  mark(entries) {
    // Which WINDOWS have been acknowledged this poll — on screen somewhere, or back to
    // green. Collected in a first pass over every placement, and by window id rather
    // than by (session, id), because that is what makes a linked window's two tabs
    // stop flashing together: the second placement is normally visited LATER in the
    // list than the one you are actually looking at, so a single pass would have
    // already re-raised (or left standing) an alert the acknowledgement should have
    // cleared.
    const acked = new Set();
    for (const w of entries) {
      if (w.active || w.working === '1') acked.add(w.id);
    }
    const seen = new Set();
    for (const w of entries) {
      const key = WorkAlerts.key(w);
      seen.add(key);
      const prev = this._prev.get(key);
      this._prev.set(key, w.working);
      const stopped = w.working === '0' || w.working === '2';
      const cur = this._alerts.get(key);
      if (acked.has(w.id)) this._alerts.delete(key);
      // Raise on the drop out of green — or, if it is ALREADY flashing, re-colour to
      // wherever it has got to since (red -> amber = "and now it wants you"). The
      // flash must never disagree with the dot right next to it.
      //
      // Re-stamping an unchanged alert on every poll would make "most recent" mean
      // "whichever window the 500ms loop happened to touch last", so the sequence
      // only moves when the value actually changed.
      else if (stopped && (prev === '1' || cur) && (!cur || cur.value !== w.working)) {
        this._alerts.set(key, { value: w.working, seq: ++this._seq });
      }
      const a = this._alerts.get(key);
      w.alert = a ? a.value : '';
      w.alertSeq = a ? a.seq : 0;
    }
    // A placement that went away (window killed, unlinked from a session) takes its
    // alert with it — otherwise the same window re-appearing later would arrive
    // mid-flash, and its stale "previous" value could raise an alert for a change you
    // already saw.
    for (const key of this._prev.keys()) {
      if (!seen.has(key)) { this._prev.delete(key); this._alerts.delete(key); }
    }
    return entries;
  }

  // A flat, freshly-allocated view of the live alerts — the ONE thing every surface
  // that renders its own list (the recents strip, the sidebar window rows, the
  // preview tiles) reads its flash out of, via alertOf().
  //
  // Freshly allocated because that is what makes it a reactive property at all: lit
  // re-renders on IDENTITY change, so handing over this registry (a long-lived object
  // that mutates in place) would leave every row showing whatever it showed on first
  // paint. Cheap by construction — there are only ever a handful of live alerts.
  //
  // Each alert is filed under BOTH its (session, window) key and its bare window id.
  // The bare id is the "any placement of this window" fallback alertOf() reads when a
  // surface's session label is missing or stale; pre-computing it here keeps every
  // lookup a single map hit rather than a scan on the 500ms path.
  snapshot() {
    const out = new Map();
    for (const [key, a] of this._alerts) {
      out.set(key, a.value);
      const id = key.slice(key.indexOf('\x00') + 1);
      if (!out.has(id)) out.set(id, a.value);
    }
    return out;
  }
}

// Read one placement's alert out of a WorkAlerts.snapshot(). Falls back to any
// placement of the same window, so a recents entry restored without a session, or a
// preview tile holding a session the window has since been unlinked from, still
// flashes rather than silently going quiet.
export function alertOf(snapshot, session, id) {
  if (!snapshot || !id) return '';
  return snapshot.get(WorkAlerts.keyOf(session, id)) || snapshot.get(id) || '';
}

// The flashing placements that have NOWHERE TO SHOW THEMSELVES, most recent first.
//
// This is the overflow arrow's entire reason to exist. The recents strip holds five
// tabs; the preview bar holds whatever you put in it; each region shows one window.
// A window that drops out of green outside all of those flashes into an empty room,
// and the arrow is the one surface that can say "there are N more, and here is the
// latest". Whichever placement is FIRST in this list is where clicking it takes you.
//
// Covered-ness is by window id, not by placement: if a window is already flashing in
// the strip under session A, the same window under session B is drawing your eye
// anyway — counting it again would inflate the arrow with news you can already see.
//
// `entries` are placements already marked by WorkAlerts.mark (so they carry
// alert/alertSeq); `coveredIds` is the set of window ids visible somewhere.
export function hiddenAlerts(entries, coveredIds) {
  const covered = coveredIds instanceof Set ? coveredIds : new Set(coveredIds || []);
  return (entries || [])
    .filter((w) => w.alert && !covered.has(w.id))
    .sort((a, b) => (b.alertSeq || 0) - (a.alertSeq || 0));
}
