// StateStore — the SHARED, durable UI visual-state store. One blob of JSON that
// lives in the tmux SERVER-global user option @wt_state (written via TmuxSetState,
// read back on every TmuxLayoutUpdate as layout.state). Because it lives in the
// tmux server it is shared by every client/browser and survives reconnects and
// webtmux server/client restarts — it dies only with the tmux server (kill-server
// / reboot), which is correct: the sessions it describes are gone then too.
//
// Two stores, split by lifetime (see client-store.js for the other half):
//   • StateStore  — SHARED durable config (sidebar prefs, session order, renderer,
//                   expose/pip/toolbar prefs, split window assignment, recency).
//   • ClientStore — per-tab ephemeral (focused window/pane, split flex widths).
// Every persisted field lives in exactly ONE of the two.
//
// A single module-level singleton (`stateStore`, exported below) is imported
// directly by the custom-element components — they run their constructors at
// createElement time, before any dependency injection could reach them, so a
// synchronously-available singleton is the only thing they can read at boot. The
// singleton seeds itself from a localStorage OFFLINE CACHE (one key, not the old
// scattered keys) so the first paint after a reload is correct before the tmux
// blob arrives ~500ms later; tmux remains the shared source of truth and wins on
// first receipt.
//
// Sync protocol (see webtmux-state-persistence-plan.md):
//   • Read on connect: the server includes `state` in every layout push. The first
//     valid blob is adopted (appliedRev = blob.rev); later pushes apply only if
//     rev > appliedRev (i.e. another client wrote). Our own writes echo back with
//     the same rev and are ignored.
//   • Write-back: a local UI change → patch() → debounce ~400ms → bump rev →
//     send TmuxSetState. Client-authoritative rev; last-writer-wins across clients.
//   • Echo/loop guard: while applying a remote (or any) blob to subscribers the
//     `_applying` flag makes component setters that call patch() no-ops, so an
//     apply can never loop back into a write.

const CACHE_KEY = 'webtmux-state';        // single offline-cache localStorage key
const WRITE_DEBOUNCE_MS = 400;

// Legacy per-feature localStorage keys, migrated ONCE into the blob (task 14).
// Each maps an old key to a (section, field, decode) target in the blob schema.
const LEGACY = [
  { key: 'webtmux-session-order', apply: (s, v) => { try { s.sessionOrder = JSON.parse(v); } catch (e) {} } },
  { key: 'webtmux-overlay',       apply: (s, v) => sect(s, 'sidebar').overlay = v !== 'false' },
  { key: 'webtmux-pinned',        apply: (s, v) => sect(s, 'sidebar').pinned = v === 'true' },
  { key: 'webtmux-webgl',         apply: (s, v) => sect(s, 'renderer').webgl = v === '1' },
  { key: 'webtmux-scroll-mode',   apply: (s, v) => sect(s, 'renderer').scrollMode = v },
  { key: 'webtmux-expose-sort',   apply: (s, v) => sect(s, 'expose').sort = v === 'recent' ? 'recent' : 'session' },
  { key: 'webtmux-expose-search-buffers', apply: (s, v) => sect(s, 'expose').searchBuffers = v === '1' },
  { key: 'webtmux-show-build',    apply: (s, v) => sect(s, 'toolbar').showBuild = v === 'true' },
  { key: 'webtmux-pip-corner',    apply: (s, v) => sect(s, 'pip').corner = v },
  { key: 'webtmux-preview-edge',  apply: (s, v) => sect(s, 'pip').previewEdge = v },
  {
    key: 'webtmux-expose-accessed',
    apply: (s, v) => {
      try {
        const o = JSON.parse(v);
        sect(s, 'recent').seq = Number(o.seq) || 0;
        sect(s, 'recent').windows = o.entries || [];
      } catch (e) {}
    },
  },
];

function sect(state, name) {
  if (!state[name] || typeof state[name] !== 'object') state[name] = {};
  return state[name];
}

export class StateStore {
  constructor() {
    this._send = null;          // (json) => void; wired by SplitManager once a ws exists
    this._subs = new Set();     // change listeners: fn(state, fromRemote)
    this._applying = false;     // guards setters from looping an apply back into a write
    this._writeTimer = null;
    this._everReceived = false; // seen at least one layout push?
    this._seededFromRemote = false;

    this.appliedRev = 0;        // highest rev we've adopted (remote or our own writes)
    this.lastWrittenRev = 0;

    // Boot from the offline cache (synchronous, so component constructors read real
    // values immediately). If the cache is empty, migrate the legacy scattered keys
    // one time. Either way `_dirtySeed` marks whether we hold state worth pushing to
    // a fresh tmux server that has no @wt_state yet.
    const cached = this._readCache();
    if (cached && Object.keys(cached).length) {
      this.state = cached;
      this.appliedRev = Number(cached.rev) || 0;
      this.lastWrittenRev = this.appliedRev;
      this._dirtySeed = true;
    } else {
      this.state = this._migrateLegacy();
      this._dirtySeed = Object.keys(this.state).length > 0;
      if (this._dirtySeed) this._writeCache();
    }
  }

  // Wire the transport (primary unit's ws). If a seed/local change is already
  // pending, flush it now that we can actually send.
  setSender(fn) {
    this._send = fn;
    if (this._writeTimer) { /* a debounce is already scheduled; it will use _send */ }
    else if (this._pendingSend) { this._pendingSend = false; this._flush(); }
  }

  // --- reads -----------------------------------------------------------------
  get(key, dflt) {
    const v = this.state[key];
    return v === undefined ? dflt : v;
  }

  // A section object (e.g. 'sidebar', 'pip'); always an object, never undefined.
  section(name) {
    const v = this.state[name];
    return v && typeof v === 'object' ? v : {};
  }

  // --- writes ----------------------------------------------------------------
  // Merge a shallow partial into the top-level blob. No-op while applying a remote
  // blob (so a component setter reacting to an apply can't write back).
  patch(partial) {
    if (this._applying) return;
    Object.assign(this.state, partial);
    this._writeCache();
    this._scheduleWrite();
    this._emit(false);
  }

  // Merge `partial` into a named section (e.g. patchSection('sidebar', {pinned:true})).
  patchSection(name, partial) {
    if (this._applying) return;
    this.patch({ [name]: { ...this.section(name), ...partial } });
  }

  // --- subscription ----------------------------------------------------------
  // fn(state, fromRemote) runs on every change. Subscribers must be READ-ONLY
  // (apply state to their UI); they must not write back — the `_applying` guard
  // enforces that during the callback anyway.
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _emit(fromRemote) {
    const prev = this._applying;
    this._applying = true;
    for (const fn of this._subs) {
      try { fn(this.state, fromRemote); } catch (e) { console.warn('StateStore subscriber error', e); }
    }
    this._applying = prev;
  }

  // --- sync from server ------------------------------------------------------
  // Called with layout.state (a JSON string or object, or undefined) on every push.
  load(incoming) {
    const firstCall = !this._everReceived;
    this._everReceived = true;

    let blob = null;
    if (incoming) {
      try { blob = typeof incoming === 'string' ? JSON.parse(incoming) : incoming; }
      catch (e) { blob = null; }
    }

    // Server has no @wt_state yet. On the very first push, seed it from our cache /
    // migrated legacy state so the shared store is initialized from this client.
    if (!blob || typeof blob !== 'object') {
      if (firstCall && this._dirtySeed) {
        if (this._send) this._scheduleWrite();
        else this._pendingSend = true;
      }
      return;
    }

    const rev = Number(blob.rev) || 0;
    // Once we've adopted a remote blob OR written one ourselves, ignore anything not
    // strictly newer — that covers the echo of our own write (rev === appliedRev) and
    // any stale/duplicate push. The very first remote blob on a client that has
    // neither seeded nor written is always adopted (it establishes the baseline).
    if ((this._seededFromRemote || this.lastWrittenRev > 0) && rev <= this.appliedRev) return;

    // Adopt the remote blob wholesale (another client may have removed a key, so a
    // merge would resurrect it). The server is authoritative and wins over our cache.
    this.state = blob;
    this.appliedRev = rev;
    this.lastWrittenRev = Math.max(this.lastWrittenRev, rev);
    this._seededFromRemote = true;
    this._dirtySeed = false;
    this._writeCache();
    this._emit(true);
  }

  // --- internals -------------------------------------------------------------
  _scheduleWrite() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this._flush(), WRITE_DEBOUNCE_MS);
  }

  _flush() {
    this._writeTimer = null;
    if (!this._send) { this._pendingSend = true; return; }
    const rev = Math.max(this.appliedRev, this.lastWrittenRev) + 1;
    this.appliedRev = rev;
    this.lastWrittenRev = rev;
    this.state.v = 1;
    this.state.rev = rev;
    this._writeCache();
    try { this._send(JSON.stringify(this.state)); } catch (e) { console.warn('StateStore send failed', e); }
  }

  _readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : null;
    } catch (e) { return null; }
  }

  _writeCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(this.state)); } catch (e) { /* best-effort */ }
  }

  // One-time migration of the old scattered per-feature keys into a single blob.
  _migrateLegacy() {
    const s = {};
    for (const { key, apply } of LEGACY) {
      let v = null;
      try { v = localStorage.getItem(key); } catch (e) {}
      if (v !== null) apply(s, v);
    }
    return s;
  }
}

// The single shared instance every component imports.
export const stateStore = new StateStore();
