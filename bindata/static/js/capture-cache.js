// CaptureCache — the client-side mirror of the server's per-window capture
// buffers. ONE instance per app, owned by the SplitManager. Any TerminalUnit
// that receives a TmuxCaptureData frame feeds it here via ingest(); the UI
// (Exposé tiles, optimistic paint) reads via get()/fresh(). request() sends a
// 'G' over a chosen unit's ws.
//
// Coalescing is two-layer: a short client-side debounce here stops overlapping
// UI triggers (Exposé poll + sidebar poll) from emitting a 'G' storm, and the
// server's freshness TTL stops any that slip through from re-forking tmux.
export class CaptureCache extends EventTarget {
  // sendFn(windows, force) transmits a capture request over some connected unit.
  constructor(sendFn) {
    super();
    this._send = sendFn;
    this.byWindow = new Map(); // windowId -> {windowId, sessionName, index, name, cols, rows, capturedAt, data}
    this._lastReqAt = 0;
    this.debounceMs = 200;
    // Access order for the Exposé "Last accessed" sort: windowId -> seq (higher
    // = more recent). Bumped whenever a window is selected/viewed. PERSISTED
    // across reloads (keyed by tmux window_id, stable while the host tmux lives).
    const persisted = loadAccess();
    this._accessSeq = persisted.seq;
    this.accessed = persisted.map;
  }

  // Record that a window was just accessed (selected, or became active in any
  // region incl. the console-followed primary) — drives the "Last accessed"
  // Exposé sort, and persist so the order survives a page reload.
  markAccessed(windowId) {
    if (!windowId) return;
    this.accessed.set(windowId, ++this._accessSeq);
    saveAccess(this._accessSeq, this.accessed);
  }

  // Forget a window's access recency (the user removed it from the recent strip)
  // so the Exposé "Last accessed" sort no longer ranks it as recent. Persists and
  // fires 'update' so an open Exposé re-sorts immediately; a closed one re-reads on
  // next open.
  forgetAccessed(windowId) {
    if (!windowId) return;
    if (this.accessed.delete(windowId)) {
      saveAccess(this._accessSeq, this.accessed);
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

  // Feed a decoded TmuxCaptureData payload ({captures:[...]}) into the cache.
  ingest(payload) {
    const caps = (payload && payload.captures) || [];
    for (const c of caps) this.byWindow.set(c.windowId, c);
    if (caps.length) {
      this.dispatchEvent(new CustomEvent('update', { detail: { captures: caps } }));
    }
  }

  get(windowId) {
    return this.byWindow.get(windowId);
  }

  // All cached entries, sorted for the Exposé grid. sort='session' (default):
  // by session name then window index. sort='recent': most-recently-accessed
  // first, with never-accessed windows falling back to session/index order.
  all(sort = 'session') {
    const bySession = (a, b) => a.sessionName.localeCompare(b.sessionName) || a.index - b.index;
    const arr = [...this.byWindow.values()];
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

// --- persisted access order --------------------------------------------------
// Stored as { seq, entries: [[windowId, seq], …] } so "Last accessed" survives a
// reload. Stale ids (a tmux server restart reusing @N) are harmless: all() only
// ranks windows currently present in the capture set.
const ACCESS_KEY = 'webtmux-expose-accessed';

function loadAccess() {
  try {
    const raw = localStorage.getItem(ACCESS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      return { seq: Number(obj.seq) || 0, map: new Map(obj.entries || []) };
    }
  } catch (e) {
    /* corrupt/unavailable storage — start fresh */
  }
  return { seq: 0, map: new Map() };
}

function saveAccess(seq, map) {
  try {
    localStorage.setItem(ACCESS_KEY, JSON.stringify({ seq, entries: [...map] }));
  } catch (e) {
    /* storage full/unavailable — ordering is best-effort */
  }
}
