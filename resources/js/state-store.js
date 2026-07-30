// StateStore — the SHARED, durable UI visual-state store. One blob of JSON that
// lives in the tmux SERVER-global user option @wt_state (written via TmuxSetState,
// read back on every TmuxLayoutUpdate as layout.state). Because it lives in the
// tmux server it is shared by every client/browser and survives reconnects and
// webtmux server/client restarts — it dies only with the tmux server (kill-server
// / reboot), which is correct: the sessions it describes are gone then too.
//
// Two stores, split by lifetime (see client-store.js for the other half):
//   • StateStore  — SHARED durable config (sidebar prefs, session order, renderer,
//                   expose/pip/toolbar prefs, split window assignment, the recents
//                   strip, and access recency).
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
// Sync protocol:
//   • Read on connect: the server includes `state` in every layout push. The first
//     valid blob is adopted (appliedRev = blob.rev); later pushes apply when they
//     are newer, or when they carry DIFFERENT content at the same rev (see the
//     tie-break below). Our own writes echo back unchanged and are ignored.
//   • Write-back: a local UI change → patch() → debounce ~400ms → bump rev →
//     send TmuxSetState. Client-authoritative rev; last-writer-wins across clients.
//   • Echo/loop guard: while applying a remote (or any) blob to subscribers the
//     `_applying` flag makes component setters that call patch() no-ops, so an
//     apply can never loop back into a write.
//
// FOUR RULES MAKE THAT PROTOCOL CONVERGE. Each of them exists because its absence
// silently destroyed state that a user had arranged by hand:
//
//   1. NOTHING IS FLUSHED BEFORE THE FIRST load(). The offline cache makes the
//      first paint instant, but it must never win a race against the authoritative
//      blob. A browser opening for the first time holds {} — and `regions: []` is a
//      perfectly valid last-writer-wins update, so flushing it erased the split
//      every OTHER browser was showing. `loadedOnce` / `onFirstLoad()` let each
//      section wait for the server's real answer (or its "I hold nothing"), which
//      arrives within one 500ms layout push.
//
//   2. UN-FLUSHED LOCAL PATCHES SURVIVE AN ADOPT. Adoption replaces the whole blob
//      (another client may have REMOVED a key, so merging would resurrect it), which
//      would otherwise drop any local edit still sitting in the 400ms debounce. Each
//      patch is recorded in `_pending` and replayed on top of whatever we adopt,
//      until the server hands back a blob at or past the rev we sent it in.
//
//   3. EQUAL REVS ARE A COLLISION, NOT A TIE. The rev is client-authoritative, so
//      two clients editing at once genuinely produce two different rev-N blobs.
//      Ignoring everything that is not strictly newer left them on different content
//      at the same number *forever*, with nothing on screen to say so. An equal rev
//      with a different content hash is therefore adopted: the server's copy wins,
//      visibly, in one push.
//
//   4. A SEND THAT DID NOT LEAVE IS STILL PENDING. The sender reports failure (the
//      ws is not OPEN) by returning false; the store then keeps the change dirty and
//      does NOT claim the rev, so a reconnect (`resync()`) re-flushes it instead of
//      leaving a rev burned on a write nobody ever saw.
//
// …and one more, about WHOSE state it is: the cache is keyed per tmux server
// (`load(blob, serverId)`), so pointing the same browser at a different socket does
// not let a stale rev from the old server suppress the new one's blob.

const CACHE_KEY = 'webtmux-state';        // single offline-cache localStorage key
// Which tmux server the cache above was written under, so the next boot reads the
// right one. Absent for caches written by builds before per-server keying, and for
// servers too old to report an identity — both fall back to the bare CACHE_KEY.
const SERVER_KEY = 'webtmux-state-server';
const WRITE_DEBOUNCE_MS = 400;

function cacheKeyFor(serverId) {
  return serverId ? CACHE_KEY + ':' + serverId : CACHE_KEY;
}

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

// --- content identity ---------------------------------------------------------
// The rev tie-break (rule 3) needs "is this the same blob we already applied?",
// which JSON.stringify cannot answer: two clients serialize the same object with
// different key order, and an echo would then look like a collision and re-apply
// forever. So: a key-sorted rendering, hashed, with the rev/version envelope left
// out (a re-send of identical content at a new rev is still the same content).
function stableRender(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableRender).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableRender(v[k])).join(',') + '}';
}

export function contentHash(state) {
  const rest = {};
  for (const k of Object.keys(state || {})) {
    if (k === 'rev' || k === 'v') continue;
    rest[k] = state[k];
  }
  // FNV-1a, 32-bit. Not a security hash — a collision costs one skipped re-apply,
  // and the next push corrects it.
  const s = stableRender(rest);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export class StateStore {
  constructor() {
    this._send = null;          // (json) => boolean|void; wired by SplitManager once a ws exists
    this._subs = new Set();     // change listeners: fn(state, fromRemote)
    this._applying = false;     // guards setters from looping an apply back into a write
    this._writeTimer = null;
    this._everReceived = false; // seen at least one layout push?
    this._seededFromRemote = false;

    this.appliedRev = 0;        // highest rev we've adopted (remote or our own writes)
    this.lastWrittenRev = 0;

    // Rule 1: the first-load gate. Flipped by the first load() — including one that
    // carries no blob, which is still the server answering "I hold nothing".
    this.loadedOnce = false;
    this._firstLoadCbs = [];

    // Rule 3: the content identity of the blob we last applied/sent.
    this._appliedHash = null;

    // Rule 2/4: local patches not yet known to have reached the server, in order.
    this._pending = [];
    this._sentRev = 0;          // rev of the flush waiting to be acked (0 = none)
    this._sentCount = 0;        // how many _pending entries that flush covered
    this._dirty = false;        // local change not yet on the wire

    // Which tmux server this browser's cache belongs to. Read back from its own
    // key so a boot picks up the cache it last wrote for THIS server.
    this._serverId = readServerId();
    this._cacheKey = cacheKeyFor(this._serverId);

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
    else if (this._pendingSend) { this._pendingSend = false; this._scheduleWrite(); }
  }

  // The transport came back after a drop (TerminalUnit calls this on reconnect).
  // Anything we were told we could not send — or sent without ever seeing it come
  // back — is re-flushed on top of the server's current blob, which arrives on the
  // next layout push. Re-flushing a write that DID land is harmless: the pending
  // entries are the same values, so the replay is idempotent.
  resync() {
    this._sentRev = 0;
    this._sentCount = 0;
    if (this._dirty || this._pendingSend || this._pending.length) {
      this._pendingSend = false;
      this._scheduleWrite();
    }
  }

  // Run `cb` once the authoritative server blob (or its absence) is known. Fires
  // immediately if that has already happened, so a late caller can't miss it.
  // This is how a section waits out rule 1 without polling.
  onFirstLoad(cb) {
    if (typeof cb !== 'function') return;
    if (this.loadedOnce) { this._runFirstLoadCb(cb); return; }
    this._firstLoadCbs.push(cb);
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
  // Merge a shallow partial into the top-level blob. Returns whether the write was
  // ACCEPTED: false while applying a remote blob (so a component setter reacting to
  // an apply can't write back), true otherwise. Callers that track "what have I
  // published" — RecentsPersistence, SplitPersistence — must only advance their
  // change signature on true, or a swallowed write is remembered as published and
  // the real change is never written at all.
  patch(partial) {
    if (this._applying) return false;
    return this._localPatch({ partial });
  }

  // Merge `partial` into a named section (e.g. patchSection('sidebar', {pinned:true})).
  patchSection(name, partial) {
    if (this._applying) return false;
    return this._localPatch({ section: name, partial });
  }

  _localPatch(entry) {
    this._pending.push(entry);
    this._applyEntry(entry);
    this._dirty = true;
    this._writeCache();
    this._scheduleWrite();
    this._emit(false);
    return true;
  }

  // Apply one recorded patch to the current state. Replayed verbatim after an adopt,
  // which is what makes an un-flushed local edit survive another client's blob.
  _applyEntry(e) {
    if (e.section) this.state[e.section] = { ...this.section(e.section), ...e.partial };
    else Object.assign(this.state, e.partial);
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
  // `serverId` identifies the tmux server the push came from (layout.serverStart);
  // omit it for callers that have none — the cache then keeps its legacy key.
  load(incoming, serverId) {
    try {
      this._loadInner(incoming, serverId);
    } finally {
      // Even a push that carried nothing is an answer: the server holds no blob.
      // Sections waiting on rule 1 must be released either way, or a fresh tmux
      // server would never accept a write at all.
      this._markLoaded();
    }
  }

  _loadInner(incoming, serverId) {
    const firstCall = !this._everReceived;
    this._everReceived = true;
    this._bindServer(serverId);

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
    const hash = contentHash(blob);

    // Our own write has reached the server (this blob is at or past the rev we sent),
    // so the patches that flush covered are published and must not be replayed again
    // — otherwise a key another client later REMOVED would keep coming back.
    if (this._sentRev && rev >= this._sentRev) {
      this._pending.splice(0, this._sentCount);
      this._sentCount = 0;
      this._sentRev = 0;
    }

    // Once we've adopted a remote blob OR written one ourselves, ignore anything
    // older, and ignore an equal rev only when it carries the SAME content — that
    // is the echo of our own write. An equal rev with different content is a real
    // collision between two clients (the rev is client-authoritative, so both
    // legitimately produced one): adopt it, or the two clients sit on different
    // state at the same number forever. The very first remote blob on a client that
    // has neither seeded nor written is always adopted (it establishes the baseline).
    if (this._seededFromRemote || this.lastWrittenRev > 0) {
      if (rev < this.appliedRev) return;
      if (rev === this.appliedRev && hash === this._appliedHash) return;
    }

    // Adopt the remote blob wholesale (another client may have removed a key, so a
    // merge would resurrect it). The server is authoritative and wins over our cache.
    this.state = blob;
    this.appliedRev = rev;
    this.lastWrittenRev = Math.max(this.lastWrittenRev, rev);
    this._appliedHash = hash;
    this._seededFromRemote = true;
    this._dirtySeed = false;

    // Rule 2: local edits the server has not acknowledged go back on top, in order.
    if (this._pending.length) {
      for (const e of this._pending) this._applyEntry(e);
      this._dirty = true;
      this._scheduleWrite();
    }

    this._writeCache();
    this._emit(true);
  }

  // Bind the offline cache to a tmux server identity (decision 6). Called from every
  // load(); a push without an identity (an older webtmux server) leaves today's key
  // in place, so nothing regresses for them.
  //
  // A DIFFERENT identity means the same browser is now talking to a different tmux
  // server — a socket swap, or the old server was killed and restarted. Its rev
  // sequence restarts at 1 while our cache still holds, say, rev 40; under one shared
  // key that stale rev would suppress every push until the new server climbed past
  // it, which is the whole bug. So the cache is re-read under the new key and the
  // foreign rev is dropped.
  _bindServer(serverId) {
    const next = serverId == null ? '' : String(serverId);
    if (!next || next === this._serverId) return;
    const swapped = this._serverId !== '';
    this._serverId = next;
    this._cacheKey = cacheKeyFor(next);
    writeServerId(next);
    if (!swapped) {
      // First time this browser learns any identity: the cache it booted from is
      // almost certainly THIS server's (written under the legacy key), so keep it
      // and just start writing under the keyed name from now on.
      this._writeCache();
      return;
    }
    const mine = this._readCache();
    this.state = mine && Object.keys(mine).length ? mine : {};
    this.appliedRev = Number(this.state.rev) || 0;
    this.lastWrittenRev = this.appliedRev;
    this._appliedHash = null;
    this._seededFromRemote = false;
    this._dirtySeed = false;
    // Patches recorded against the OTHER server's state are meaningless here.
    this._pending = [];
    this._sentRev = 0;
    this._sentCount = 0;
  }

  _markLoaded() {
    if (this.loadedOnce) return;
    this.loadedOnce = true;
    const cbs = this._firstLoadCbs;
    this._firstLoadCbs = [];
    for (const cb of cbs) this._runFirstLoadCb(cb);
    // Anything held back by rule 1 can go out now.
    if (this._dirty || this._pending.length) this._scheduleWrite();
  }

  _runFirstLoadCb(cb) {
    try { cb(this.state); } catch (e) { console.warn('StateStore onFirstLoad error', e); }
  }

  // --- internals -------------------------------------------------------------
  _scheduleWrite() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => this._flush(), WRITE_DEBOUNCE_MS);
  }

  // Push the current blob to tmux. Returns whether it actually went out.
  //
  // The rev is only CLAIMED on a send that succeeded (rule 4): the payload is built
  // as a copy, and this.state/appliedRev/lastWrittenRev move only afterwards. A
  // failed send therefore leaves the store exactly as it was — dirty, at the old
  // rev — so resync() can retry it rather than the change disappearing with a rev
  // burned on a write nobody received.
  _flush() {
    this._writeTimer = null;
    if (!this._send) { this._pendingSend = true; return false; }
    // Rule 1: never write over a blob we have not read.
    if (!this.loadedOnce) { this._pendingSend = true; return false; }

    const rev = Math.max(this.appliedRev, this.lastWrittenRev) + 1;
    const payload = { ...this.state, v: 1, rev };
    let ok = false;
    try { ok = this._send(JSON.stringify(payload)) !== false; }
    catch (e) { ok = false; console.warn('StateStore send failed', e); }
    if (!ok) {
      this._pendingSend = true;
      this._dirty = true;
      return false;
    }

    this.state.v = 1;
    this.state.rev = rev;
    this.appliedRev = rev;
    this.lastWrittenRev = rev;
    this._appliedHash = contentHash(this.state);
    this._sentRev = rev;
    this._sentCount = this._pending.length;
    this._dirty = false;
    this._writeCache();
    return true;
  }

  _readCache() {
    try {
      const raw = localStorage.getItem(this._cacheKey);
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : null;
    } catch (e) { return null; }
  }

  _writeCache() {
    try { localStorage.setItem(this._cacheKey, JSON.stringify(this.state)); } catch (e) { /* best-effort */ }
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

function readServerId() {
  try { return localStorage.getItem(SERVER_KEY) || ''; } catch (e) { return ''; }
}

function writeServerId(id) {
  try { localStorage.setItem(SERVER_KEY, id); } catch (e) { /* best-effort */ }
}

// The single shared instance every component imports.
export const stateStore = new StateStore();
