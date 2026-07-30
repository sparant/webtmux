// Reader for the shared blob's 'split' section — which VIEW each region shows.
//
// Split out of SplitManager (which pulls in lit and can never load under
// `node --test`) because this function encodes a COMPATIBILITY rule whose
// violation destroys user data silently:
//
//   `regions` has always meant "the EXTRA regions, excluding the primary", and
//   blobs written by earlier builds are still in every live tmux server. The
//   primary's window is therefore a separate `primaryWindowId` field, NOT
//   regions[0]. Folding it in would reinterpret stored data — an old blob holding
//   one extra split region would read back as "primary, no splits", and that
//   region would vanish on first load with nothing logged.
//
// So the shape is deliberately a little redundant, and this is where that decision
// is pinned down and tested.
//
// A VIEW IS (SESSION, WINDOW) — NOT A WINDOW ID. A window id alone cannot be
// restored, because a pane's window LIST only covers the session it is attached to
// (the server runs `list-windows -t <session>`). So a saved id belonging to another
// session is simply not found on load, the restore silently does nothing, and the
// primary sits on whatever window the base session happens to be showing — every
// refresh, deterministically, no matter where you actually were. That is why each
// entry carries its session too.
//
// The blob is untrusted (@wt_state is a plain tmux user option anyone can set), so
// the reader is total: anything malformed degrades to "no saved view", which the
// caller already handles as "leave that region on its default".

function str(v) {
  return typeof v === 'string' && v ? v : null;
}

// -> { regions: Array<{windowId: string|null, session: string|null}>,
//      primaryWindowId: string|null, primarySession: string|null }
//
// `regions[i]` is the view for units[i+1]; a null windowId means that region had no
// window worth restoring (the caller then MRU-auto-picks one). The array's LENGTH is
// meaningful independently of its contents: it is how many extra regions to recreate,
// so an empty entry must be preserved as an entry rather than filtered out — hence
// always an object, never null.
export function readSplitState(section) {
  const s = section && typeof section === 'object' ? section : {};
  const regions = Array.isArray(s.regions)
    ? s.regions.map((r) => {
      if (!r || typeof r !== 'object') return { windowId: null, session: null };
      return { windowId: str(r.windowId), session: str(r.session) };
    })
    : [];
  // Absent on every blob written before the primary's window was persisted. null
  // means "leave the primary wherever the base session currently is" — the old
  // console-driven behavior, which is the correct thing to fall back to.
  //
  // primarySession is absent on the builds in between (window persisted, session not).
  // Those blobs are read as "the session I am attached to now", which is exactly the
  // behavior they had: a saved window is only honored if it is in the pane's own list.
  return {
    regions,
    primaryWindowId: str(s.primaryWindowId),
    primarySession: str(s.primarySession),
  };
}

// Stable content signature for a saved split view. Everything a restore would act
// on is in it — the region COUNT (how many panes to recreate), each region's
// (session, window) pair, and the primary's own pair — and nothing else, so the
// 500ms refresh tick can ask "did this really change?" for the price of one string.
export function splitSignature(view) {
  const v = view || {};
  const regions = Array.isArray(v.regions) ? v.regions : [];
  return JSON.stringify([
    regions.map((r) => [(r && r.windowId) || null, (r && r.session) || null]),
    v.primaryWindowId || null,
    v.primarySession || null,
  ]);
}

// Owns the 'split' section's half of the shared blob — the same three jobs
// RecentsPersistence does for the strip, for the same reasons (see recents-strip.js):
// a write guard, a change signature, and the rule that NOTHING MAY BE WRITTEN
// BEFORE THE FIRST READ.
//
// The split section has a second, worse version of that hazard, and it is the one
// this class was extracted for. The strip's guard only had to survive the local
// constructor order; the split's has to survive a browser opening for the FIRST
// TIME. Such a browser's offline cache is empty, so it restores "no split", and the
// eager re-persist that follows region creation writes `regions: []` into state that
// is SHARED with every other browser on that tmux server. Last-writer-wins accepts
// it, and the split someone arranged in another window disappears — from a client
// that never had one. Hence the second guard, `store.loadedOnce`: no write until the
// authoritative blob (or its absence) has been seen, and an untouched section adopts
// what the server holds instead of overwriting it.
//
// Deliberately free of DOM/lit dependencies, like RecentsPersistence, so `node --test`
// can drive the real boot order against it (split-manager.js imports lit and never
// loads under the test harness).
export class SplitPersistence {
  // `store` is the StateStore singleton — only .section()/.patchSection()/.loadedOnce
  // are used, so a plain stub works in tests.
  constructor(store, section = 'split') {
    this.store = store;
    this.sectionName = section;
    this._sig = null;
    this._restored = false;
    this._touched = false;
  }

  // Read the persisted view. Until this has run, persist() is inert.
  restore() {
    const view = readSplitState(this.store.section(this.sectionName));
    this._sig = splitSignature(view);
    this._restored = true;
    return view;
  }

  // The user has arranged this client's split by hand (navigated, split, or closed a
  // region). From here on the server's copy is no longer allowed to re-apply itself
  // over the top — adopting would yank the view out from under someone who acted.
  markTouched() {
    this._touched = true;
  }

  get touched() {
    return this._touched;
  }

  // Write the view if it actually changed AND writing is allowed yet. Returns
  // whether a write was issued. The signature only advances on an ACCEPTED write:
  // recording it for one the store swallowed would remember the change as published
  // and never write it again.
  persist(view) {
    if (!this._restored) return false;        // no write before the first read
    if (!this.store.loadedOnce) return false; // …and none before the server's answer
    const sig = splitSignature(view);
    if (sig === this._sig) return false;      // unchanged: do not bump the blob's rev
    const v = view || {};
    const ok = this.store.patchSection(this.sectionName, {
      regions: (Array.isArray(v.regions) ? v.regions : [])
        .map((r) => ({ windowId: (r && r.windowId) || null, session: (r && r.session) || null })),
      primaryWindowId: v.primaryWindowId || null,
      primarySession: v.primarySession || null,
    });
    if (ok) this._sig = sig;
    return ok;
  }

  // Re-read after the authoritative blob arrived (or another client wrote). Returns
  // the view to apply, or null when there is nothing to do: the user has touched this
  // client's split, or the blob still matches what we hold.
  adopt() {
    if (this._touched) return null;
    const view = readSplitState(this.store.section(this.sectionName));
    const sig = splitSignature(view);
    if (sig === this._sig) return null;
    this._sig = sig;
    return view;
  }
}
