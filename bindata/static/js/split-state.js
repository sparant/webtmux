// Reader for the shared blob's 'split' section — which window each region shows.
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
// The blob is untrusted (@wt_state is a plain tmux user option anyone can set), so
// the reader is total: anything malformed degrades to "no saved window", which the
// caller already handles as "leave that region on its default".

// -> { regions: Array<string|null>, primaryWindowId: string|null }
//
// `regions[i]` is the window id for units[i+1], or null when that region had no
// window worth restoring (the caller then MRU-auto-picks one). The array's LENGTH
// is meaningful independently of its contents: it is how many extra regions to
// recreate, so a null entry must be preserved rather than filtered out.
export function readSplitState(section) {
  const s = section && typeof section === 'object' ? section : {};
  const regions = Array.isArray(s.regions)
    ? s.regions.map((r) => {
      if (!r || typeof r !== 'object') return null;
      return typeof r.windowId === 'string' && r.windowId ? r.windowId : null;
    })
    : [];
  // Absent on every blob written before the primary's window was persisted. null
  // means "leave the primary wherever the base session currently is" — the old
  // console-driven behavior, which is the correct thing to fall back to.
  const primaryWindowId = typeof s.primaryWindowId === 'string' && s.primaryWindowId
    ? s.primaryWindowId
    : null;
  return { regions, primaryWindowId };
}
