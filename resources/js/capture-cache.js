// CaptureCache — the client-side mirror of the server's per-window capture
// buffers. ONE instance per app, owned by the SplitManager. Any TerminalUnit
// that receives a TmuxCaptureData frame feeds it here via ingest(); the UI
// (Exposé tiles, optimistic paint) reads via get()/fresh(). request() sends a
// 'G' over a chosen unit's ws.
//
// Coalescing is two-layer: a short client-side debounce here stops overlapping
// UI triggers (Exposé poll + sidebar poll) from emitting a 'G' storm, and the
// server's freshness TTL stops any that slip through from re-forking tmux.
import { stateStore } from './state-store.js';

export class CaptureCache extends EventTarget {
  // sendFn(windows, force) transmits a capture request over some connected unit.
  constructor(sendFn) {
    super();
    this._send = sendFn;
    // Two views of the same server captures:
    //   byWindow    — windowId -> a REPRESENTATIVE placement (one per window). Feeds
    //                 per-window consumers: optimistic paint + the PiP/Preview.
    //   byPlacement — "session\0windowId" -> that placement. A window LINKED into
    //                 two sessions has two entries here (same screen, different
    //                 session/index) — Exposé renders one tile from each.
    this.byWindow = new Map();
    this.byPlacement = new Map();
    this._lastReqAt = 0;
    this.debounceMs = 200;
    // Access order for the Exposé "Last accessed" sort: windowId -> seq (higher
    // = more recent). Bumped whenever a window is selected/viewed. PERSISTED
    // across reloads (keyed by tmux window_id, stable while the host tmux lives).
    const persisted = loadAccess();
    this._accessSeq = persisted.seq;
    this.accessed = persisted.map;
    // Windows that have gone missing from the server-wide directory, and WHEN they
    // first did. A tombstone rather than an immediate delete: a window can be absent
    // from one push for reasons that are not death (a directory that arrived empty,
    // a server mid-restart), and forgetting a recency is not recoverable.
    this.gone = persisted.gone;
    // Accesses recorded before the first layout push. They are real — the user did
    // click something — but they must not be WRITTEN yet, because everything else we
    // hold at that moment came out of this browser's cache and the blob would carry
    // it along. Replayed on top of the authoritative state instead (see below).
    this._preload = new Set();
    // Adopt recency written by ANOTHER client (fromRemote) so the "Last accessed"
    // sort converges across browsers. Skip local echoes to avoid clobbering our own
    // map mid-write. Fire 'update' so an open Exposé re-sorts immediately.
    stateStore.subscribe((_state, fromRemote) => {
      if (!fromRemote) return;
      const cur = loadAccess();
      this._accessSeq = Math.max(this._accessSeq, cur.seq);
      this.accessed = cur.map;
      this.gone = cur.gone;
      this.dispatchEvent(new CustomEvent('update', { detail: { captures: [] } }));
    });
    // …and re-apply anything the user did before the blob arrived, on top of it.
    stateStore.onFirstLoad(() => {
      if (!this._preload.size) return;
      for (const id of this._preload) this.accessed.set(id, ++this._accessSeq);
      this._preload.clear();
      this._save();
    });
  }

  // Record that a window was just accessed (selected, or became active in any
  // region incl. the console-followed primary) — drives the "Last accessed"
  // Exposé sort, and persist so the order survives a page reload.
  markAccessed(windowId) {
    if (!windowId) return;
    this.accessed.set(windowId, ++this._accessSeq);
    this.gone.delete(windowId);        // it is plainly alive
    if (!stateStore.loadedOnce) { this._preload.add(windowId); return; }
    this._save();
  }

  // Reconcile the recency map against the server-wide window DIRECTORY
  // (layout.allWindows). Windows that stay missing long enough are forgotten; see
  // pruneRecency for why "long enough" and not "now".
  //
  // Nothing happens before the first layout push: the map we would be pruning is the
  // one read out of this browser's cache, and publishing a pruned copy of a stale map
  // over the shared blob is the same erasure this plan set exists to stop.
  noteLiveWindows(liveIds) {
    if (!stateStore.loadedOnce) return;
    const res = pruneRecency({ accessed: this.accessed, gone: this.gone, liveIds });
    if (!res.changed) return;
    this.accessed = res.accessed;
    this.gone = res.gone;
    this._save();
    this.dispatchEvent(new CustomEvent('update', { detail: { captures: [] } }));
  }

  _save() {
    saveAccess(this._accessSeq, this.accessed, this.gone);
  }

  // Forget a window's access recency (the user removed it from the recent strip)
  // so the Exposé "Last accessed" sort no longer ranks it as recent. Persists and
  // fires 'update' so an open Exposé re-sorts immediately; a closed one re-reads on
  // next open.
  forgetAccessed(windowId) {
    if (!windowId) return;
    this._preload.delete(windowId);
    if (this.accessed.delete(windowId)) {
      this.gone.delete(windowId);
      if (stateStore.loadedOnce) this._save();
      this.dispatchEvent(new CustomEvent('update', { detail: { captures: [] } }));
    }
  }

  // Ask the server to (re)capture. windows: 'all' or an array of window ids.
  // A non-forced request within debounceMs of the last is dropped (server
  // coalescing already keeps buffers fresh); force always sends.
  request(windows = 'all', force = false) {
    const now = Date.now();
    if (!force && now - this._lastReqAt < this.debounceMs) return;
    this._lastReqAt = now;
    try {
      this._send(windows, force);
    } catch (e) {
      /* no connected unit yet — ignore; the next trigger retries */
    }
  }

  // Feed a decoded TmuxCaptureData payload ({captures:[...], full}) into the cache.
  // Each capture is a (session, window) PLACEMENT; we index it both by placement
  // (for Exposé) and by window (a representative, for per-window consumers).
  //
  // When the payload is `full` (the reply to an all-windows request), it is the
  // COMPLETE current placement set, so we PRUNE any placement no longer present —
  // a closed window, or a session a window was unlinked from — so Exposé drops the
  // ghost tile without a reload. byWindow deliberately keeps its per-window
  // representative even when pruned from byPlacement, so the PiP/Preview can still
  // read the last screen to detect (and tag) a window that has closed.
  ingest(payload) {
    const caps = (payload && payload.captures) || [];
    for (const c of caps) {
      this.byWindow.set(c.windowId, c);
      this.byPlacement.set(placementKey(c.sessionName, c.windowId), c);
    }
    let pruned = false;
    if (payload && payload.full) {
      const live = new Set(caps.map((c) => placementKey(c.sessionName, c.windowId)));
      for (const key of this.byPlacement.keys()) {
        if (!live.has(key)) { this.byPlacement.delete(key); pruned = true; }
      }
    }
    if (caps.length || pruned) {
      this.dispatchEvent(new CustomEvent('update', { detail: { captures: caps } }));
    }
  }

  get(windowId) {
    return this.byWindow.get(windowId);
  }

  // How many placement tiles Exposé would show (a linked window counts per session).
  get placementCount() {
    return this.byPlacement.size;
  }

  // All cached PLACEMENTS, sorted for the Exposé grid. sort='session' (default):
  // by session name then window index. sort='recent': most-recently-accessed
  // first, with never-accessed windows falling back to session/index order. A
  // linked window appears once per session it's placed in.
  all(sort = 'session') {
    const bySession = (a, b) => a.sessionName.localeCompare(b.sessionName) || a.index - b.index;
    const arr = [...this.byPlacement.values()];
    if (sort === 'recent') {
      arr.sort((a, b) => {
        const ax = this.accessed.get(a.windowId) || 0;
        const bx = this.accessed.get(b.windowId) || 0;
        return bx - ax || bySession(a, b);
      });
    } else {
      arr.sort(bySession);
    }
    return arr;
  }

  // The cached entry for windowId iff captured within maxAgeMs — the guard for
  // optimistic paint (never blit a stale screen). capturedAt is unix seconds.
  fresh(windowId, maxAgeMs = 10000) {
    const c = this.byWindow.get(windowId);
    if (!c) return null;
    const ageMs = Date.now() - c.capturedAt * 1000;
    return ageMs <= maxAgeMs ? c : null;
  }

  // Decode a capture entry's base64 ANSI into a Uint8Array ready for xterm.write
  // (bytes, so UTF-8 in the snapshot renders correctly — same path as Output).
  static decodeAnsi(entry) {
    if (!entry || !entry.data) return new Uint8Array(0);
    const bin = atob(entry.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
}

// Composite key for a (session, window) placement in byPlacement. The space can't
// collide: tmux window ids are "@N" and session names never contain a space.
export function placementKey(sessionName, windowId) {
  return (sessionName || '') + ' ' + windowId;
}

// How long a window has to be absent from the server-wide directory before its
// recency is forgotten, and how many entries the section may hold.
//
// SEVEN DAYS, not "the moment it went missing". Being absent from one push is not
// proof of death — a directory can arrive empty, a server can be mid-restart, and
// list-windows can lose a race with a session being created. Forgetting a recency
// is not recoverable, and the cost of keeping a dead one is nil: all() only ranks
// windows that are actually in the capture set, so a stale entry is invisible until
// tmux happens to reuse its @id. What the entries do cost is BYTES in a blob that
// rides every 500ms layout push, which is what the TTL and the cap are really for —
// on a long-lived tmux server the map otherwise grows for months without bound.
export const RECENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RECENCY_CAP = 200;

// Prune the recency map against a live window directory. Pure, so the policy above
// is testable without a tmux server: takes and returns plain Map/Set values.
//
//   accessed  windowId -> seq (higher = more recent)
//   gone      windowId -> timestamp when it was FIRST seen missing (the tombstone)
//   liveIds   the ids in layout.allWindows on this push
//
// An empty/absent directory returns everything unchanged. That is the one case worth
// stating out loud: treating "the server told us nothing" as "every window died"
// would wipe the whole section on a single bad push.
export function pruneRecency({
  accessed, gone, liveIds, now = Date.now(),
  ttlMs = RECENCY_TTL_MS, cap = RECENCY_CAP,
} = {}) {
  const map = new Map(accessed || []);
  const tombs = new Map(gone || []);
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds || []);
  let changed = false;
  if (!live.size) return { accessed: map, gone: tombs, changed };

  for (const id of [...map.keys()]) {
    if (live.has(id)) {
      if (tombs.delete(id)) changed = true;      // it came back (or never left)
      continue;
    }
    const since = tombs.get(id);
    if (since === undefined) { tombs.set(id, now); changed = true; continue; }
    if (now - since > ttlMs) { map.delete(id); tombs.delete(id); changed = true; }
  }
  // Tombstones for ids that are no longer in the map at all are just litter.
  for (const id of [...tombs.keys()]) {
    if (!map.has(id)) { tombs.delete(id); changed = true; }
  }
  // Hard cap, least-recently-accessed first — the same rule the recents strip
  // evicts by, so the two never disagree about which window is "older".
  if (map.size > cap) {
    const keep = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap);
    const kept = new Map(keep);
    for (const id of [...map.keys()]) if (!kept.has(id)) { map.delete(id); changed = true; }
    for (const id of [...tombs.keys()]) if (!map.has(id)) tombs.delete(id);
  }
  return { accessed: map, gone: tombs, changed };
}

// --- persisted access order --------------------------------------------------
// Now lives in the shared StateStore under the 'recent' section:
//   { seq, windows: [[windowId, seq], …], gone: [[windowId, firstMissedAt], …] }
// so "Last accessed" survives a reload AND is shared across clients (it rides the
// tmux @wt_state blob). Stale ids (a tmux server restart reusing @N) are harmless:
// all() only ranks windows currently present in the capture set.
function loadAccess() {
  const rec = stateStore.section('recent');
  return {
    seq: Number(rec.seq) || 0,
    map: new Map(rec.windows || []),
    gone: new Map(rec.gone || []),
  };
}

function saveAccess(seq, map, gone) {
  const patch = { seq, windows: [...map] };
  // Absent rather than empty when there is nothing to remember, so the common case
  // doesn't add a key to a blob that rides every layout push.
  if (gone && gone.size) patch.gone = [...gone];
  else if (stateStore.section('recent').gone) patch.gone = [];
  stateStore.patchSection('recent', patch);
}
