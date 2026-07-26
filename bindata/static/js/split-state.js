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
