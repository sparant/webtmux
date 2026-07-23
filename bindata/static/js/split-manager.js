// SplitManager — owns an ordered list of TerminalUnits tiled side by side, a
// focused unit, and ONE shared sidebar. The first unit is the PRIMARY region on
// the shared base session (stays in sync with the ssh console); each added region
// gets a freshly generated grouped-session name so it has its own current window
// while sharing the window list.
//
// One-sidebar illusion: there is a SINGLE <webtmux-sidebar> element, always in the
// same spot, bound to whichever region is FOCUSED. Clicking a region's terminal
// focuses it and the shared sidebar re-points to reflect/control that region.
import { TerminalUnit } from './terminal-unit.js';
import { CaptureCache } from './capture-cache.js';

export class SplitManager {
  constructor(container) {
    this.container = container;   // #app — holds .region elements, .divider bars, and the shared sidebar
    this.units = [];
    this.focusedUnit = null;
    // The last NON-PRIMARY (split) region to hold focus. The toolbar/Exposé window
    // switch targets THIS (not focusedUnit, which drifts to the console-synced
    // primary when you click a tab whose window the primary is showing).
    this._lastFocusedSplit = null;

    // ONE client-side capture cache for the whole app. Requests go out over any
    // connected unit's ws (capture is server-global, so the connection is
    // irrelevant); every unit routes the TmuxCaptureData reply back here.
    this.captureCache = new CaptureCache((windows, force) => {
      const unit = (this.focusedUnit && this.focusedUnit.isConnected() && this.focusedUnit)
        || this.units.find((u) => u.isConnected());
      if (unit) unit.sendCaptureRequest(windows, force);
    });

    // The single shared sidebar (last child of #app; its own CSS floats it at the
    // right — viewport-fixed in overlay/collapsed mode, or a 330px column in
    // side-by-side mode). Regions are inserted BEFORE it.
    this.sidebar = document.createElement('webtmux-sidebar');
    this.container.appendChild(this.sidebar);

    // The Exposé overlay (hidden until opened via Ctrl+Alt+E or the sidebar).
    this.expose = document.createElement('webtmux-expose');
    this.expose.cache = this.captureCache;
    this.expose.manager = this;
    this.container.appendChild(this.expose);

    // Top toolbar (above #app): most-recently-accessed windows + sidebar toggle.
    // Recent-windows strip: entries keep a STABLE display position — re-accessing
    // a shown window never reorders it. Recency itself is NOT tracked here: the
    // single source of truth is this.captureCache.accessed (persisted), fed by
    // noteAccess() and also read by the Exposé "Last accessed" sort — one code
    // path for both. This list holds only the toolbar's bounded/stable view.
    this.recentWindows = [];         // {id,index,name,session}, stable order (max 5)
    this.toolbar = document.createElement('webtmux-toolbar');
    this.toolbar.manager = this;
    this.container.parentNode.insertBefore(this.toolbar, this.container);
    // Keep the toolbar's toggle icon in sync with the sidebar's collapsed state.
    window.addEventListener('webtmux-sidebar-collapsed', (e) => {
      this.toolbar.collapsed = !!e.detail?.collapsed;
    });

    this._installControls();

    // The primary/shared region (session '' => base 'services').
    this.addUnit({ sessionName: '', primary: true });
  }

  // Short, sanitized, unique-ish grouped session name (server also sanitizes).
  genSessionName() {
    const rnd = Math.random().toString(36).slice(2, 8);
    return `web-${rnd}`;
  }

  addUnit({ sessionName = null, primary = false } = {}) {
    if (sessionName === null) sessionName = this.genSessionName();

    // Region DOM = just the terminal area (the sidebar is shared, not per-region).
    // A divider precedes every region after the first. Insert BEFORE the shared
    // sidebar so it stays rightmost.
    if (this.units.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'divider';
      this.container.insertBefore(divider, this.sidebar);
    }
    const region = document.createElement('div');
    region.className = 'region';
    region.dataset.session = sessionName || 'primary';
    const term = document.createElement('div');
    term.className = 'region-term';
    region.appendChild(term);
    this.container.insertBefore(region, this.sidebar);

    const unit = new TerminalUnit({ sessionName, terminalEl: term, primary });
    unit.region = region;
    unit.onFocus = (u) => this.focus(u);
    unit.onLayout = (u) => this._onUnitLayout(u);
    // Route this unit's capture replies into the shared cache, and give the unit
    // read access for optimistic paint on window switch.
    unit.captureCache = this.captureCache;
    unit.onCaptureData = (payload) => this.captureCache.ingest(payload);
    // Clicking the terminal collapses the shared sidebar out of the way (unless pinned).
    unit.onTerminalMousedown = () => {
      const sb = this.sidebar;
      if (sb && !sb.collapsed && !sb.pinned) sb.collapsed = true;
    };
    // Clicking anywhere in the region (even outside the terminal) focuses it.
    region.addEventListener('mousedown', () => this.focus(unit), true);

    this.units.push(unit);
    this._syncSplitClass();
    this.focus(unit);
    this._refitSoon();
    return unit;
  }

  removeUnit(unit) {
    if (!unit || unit.primary) return;   // never remove the console-synced primary
    const idx = this.units.indexOf(unit);
    if (idx === -1) return;

    unit.destroy();   // closes its ws -> the grouped session self-reaps (destroy-unattached)

    // Remove the region and exactly one adjacent divider.
    const region = unit.region;
    const prev = region.previousElementSibling;
    const next = region.nextElementSibling;
    if (prev && prev.classList.contains('divider')) prev.remove();
    else if (next && next.classList.contains('divider')) next.remove();
    region.remove();

    this.units.splice(idx, 1);
    if (!this.units.includes(this._lastFocusedSplit)) {
      this._lastFocusedSplit = this.units.find(u => !u.primary) || null;
    }
    this._syncSplitClass();
    this.focus(this.units[Math.min(idx, this.units.length - 1)] || this.units[0]);
    this._refitSoon();
  }

  focus(unit) {
    if (!unit) return;
    this.focusedUnit = unit;
    if (!unit.primary) this._lastFocusedSplit = unit;   // remember the last split focused
    // Compat shim: mobile-controls + any global shortcut target the focused unit.
    window.webtmux = unit;
    for (const u of this.units) {
      u.region.classList.toggle('focused', u === unit);
    }
    // Re-point the single shared sidebar at the focused region and paint its state.
    this.sidebar.unit = unit;
    this._pushLayout(unit);
    // Focusing a region "accesses" the window it's showing (MRU toolbar).
    const win = unit.layout?.activeWindowId;
    if (win) { unit._accessSeenId = win; this.noteAccess(win, this._metaFor(unit, win)); }
    else this._refreshToolbar();
    unit.terminal?.focus();
  }

  // Forward a unit's layout to the shared sidebar ONLY when it is the focused
  // region (so the one sidebar always reflects the focused window), and drive the
  // "next unused window" auto-pick for a freshly added region.
  _onUnitLayout(unit) {
    if (unit === this.focusedUnit) this._pushLayout(unit);
    else this._pushDisabled();   // another region moved -> refresh what's occupied

    if (unit._autoPickPending && unit.layout) {
      const used = new Set(
        this.units.filter(x => x !== unit).map(x => x.layout?.activeWindowId).filter(Boolean)
      );
      const winIds = new Set((unit.layout.windows || []).map(w => w.id));
      const free = (id) => winIds.has(id) && !used.has(id) && id !== unit.layout.activeWindowId;
      // Prefer the MOST-RECENTLY-ACCESSED window that isn't already visible in
      // another region (and is available in this region's window list) — so a new
      // split lands on what you were most recently looking at, not just the first
      // free window. Fall back to the first unused window.
      const recent = this.recentWindows
        .map((e) => e.id)
        .filter(free)
        .sort((a, b) => (this.captureCache.accessed.get(b) ?? 0) - (this.captureCache.accessed.get(a) ?? 0));
      const target = recent[0] || (unit.layout.windows || []).find((w) => !used.has(w.id))?.id;
      if (target && target !== unit.layout.activeWindowId) unit.selectWindow(target);
      unit._autoPickPending = false;
    }

    // MRU access: a region now shows a window it wasn't = an access — UNLESS the
    // switch came from sidebar arrow-key browsing (marked in _suppressAccessIds).
    // Expose browsing doesn't switch a region, so it never lands here.
    const newId = unit.layout?.activeWindowId;
    if (newId && newId !== unit._accessSeenId) {
      unit._accessSeenId = newId;
      unit._targetWindowId = null;   // an in-flight goToWindow switch has landed
      if (!unit._suppressAccessIds.delete(newId)) this.noteAccess(newId, this._metaFor(unit, newId));
    }
    this._refreshToolbar();
  }

  // Snapshot a window's display metadata (index/name/session) from the accessing
  // region's layout — captured at access time so recents survive across sessions
  // even when that window isn't in the focused region's window list anymore.
  _metaFor(unit, id) {
    const w = (unit.layout?.windows || []).find(x => x.id === id);
    return { index: w?.index, name: w?.name || 'bash', session: unit.layout?.sessionName || '' };
  }

  // Record an access. Order is STABLE: if the window is already shown it keeps its
  // slot (only its recency + metadata update); a NEW window appends while there's
  // room, else it replaces the least-recently-accessed slot in place. So the tab
  // order only changes when the SET of shown windows changes.
  noteAccess(id, meta = {}) {
    if (!id) return;
    // Bump recency in the ONE shared store (also drives the Exposé sort + persists).
    this.captureCache.markAccessed(id);
    const recencyOf = (wid) => this.captureCache.accessed.get(wid) ?? 0;
    const existing = this.recentWindows.find(e => e.id === id);
    if (existing) {
      if (meta.name) existing.name = meta.name;
      if (meta.index != null) existing.index = meta.index;
      if (meta.session) existing.session = meta.session;
    } else {
      const entry = { id, index: meta.index, name: meta.name || 'bash', session: meta.session || '' };
      const list = [...this.recentWindows];
      if (list.length < 5) {
        list.push(entry);
      } else {
        // Evict the least-recently-accessed slot (recency from the shared store).
        let lru = 0, lruSeq = Infinity;
        list.forEach((e, i) => { const s = recencyOf(e.id); if (s < lruSeq) { lruSeq = s; lru = i; } });
        list[lru] = entry;
      }
      this.recentWindows = list;
    }
    this._refreshToolbar();
  }

  // Rebuild the toolbar's recent strip. Resolve each id to fresh index/name/session
  // from the server-wide capture cache (so windows in OTHER sessions still show),
  // falling back to the snapshot taken at access time. Mark the focused region's
  // current window active. Never dropped for being outside the focused session.
  // Drop recents whose window no longer exists. A region's layout.windows is the
  // live window list for its session; grouped/primary regions all share the base
  // (services) list. So a recent window is deleted if it's absent from the union
  // of all regions' live windows AND its session is one a region currently covers
  // (we only prune sessions we can actually observe — never false-positive a
  // window in a session no region is on).
  _pruneDeletedRecents() {
    if (!this.recentWindows.length) return;
    const live = new Set();
    const covered = new Set();
    for (const u of this.units) {
      if (!u.layout) continue;
      covered.add(u.layout.sessionName);
      for (const w of (u.layout.windows || [])) live.add(w.id);
    }
    if (!live.size) return;
    const kept = this.recentWindows.filter(e => live.has(e.id) || !covered.has(e.session));
    if (kept.length !== this.recentWindows.length) this.recentWindows = kept;
  }

  // Remove a window from the recent strip WITHOUT killing the tmux window — the
  // per-tab × affordance. Also forget its access recency so the Exposé "Last
  // accessed" sort stops ranking it as recent (refreshes an open Exposé).
  //
  // When there are 2+ regions and a NON-primary split region is currently showing
  // this window, closing the tab also CLOSES that region — so × on a recent is a
  // de-facto "kill the split that was showing this window". (The primary region is
  // console-synced and never closed; the tmux window itself keeps running.)
  removeRecent(id) {
    if (this.units.length > 1) {
      const holder = this.units.find(u => !u.primary && u.layout?.activeWindowId === id);
      if (holder) this.removeUnit(holder);
    }
    const before = this.recentWindows.length;
    this.recentWindows = this.recentWindows.filter(e => e.id !== id);
    this.captureCache?.forgetAccessed(id);
    if (this.recentWindows.length !== before) this._refreshToolbar();
  }

  _refreshToolbar() {
    if (!this.toolbar) return;
    this._pruneDeletedRecents();
    const activeId = this.focusedUnit?.layout?.activeWindowId;
    const cache = this.captureCache?.byWindow;
    this.toolbar.recent = this.recentWindows.map(e => {
      const c = cache?.get(e.id);
      return {
        id: e.id,
        index: c?.index ?? e.index ?? '?',
        name: c?.name || e.name || 'bash',
        session: c?.sessionName || e.session || '',
        active: e.id === activeId,
      };
    });
    this.toolbar.collapsed = !!this.sidebar?.collapsed;
  }

  // The region a toolbar/Exposé window-switch acts on: the last-focused SPLIT
  // region, falling back to the focused region (the primary) in single-view.
  _switchTargetRegion() {
    if (this._lastFocusedSplit && this.units.includes(this._lastFocusedSplit)) {
      return this._lastFocusedSplit;
    }
    return this.focusedUnit || this.units[0] || null;
  }

  // Navigate to a window from ANY switcher (toolbar recent-strip, Exposé tile).
  //   1) If some region already shows it, jump focus to that region (a window is
  //      only ever in one region, so this handles "already open").
  //   2) Otherwise switch the LAST-FOCUSED SPLIT region to it (not whatever is
  //      currently focused — clicking a tab whose window the primary shows would
  //      otherwise leave focus on the primary and switch IT on the next click).
  //      Move that region to the window's session first if needed, then focus it so
  //      you can type immediately and the strip keeps targeting it.
  // Single entry point so every switcher behaves identically.
  goToWindow(id, session = '') {
    if (!id) return;
    // "Already shown" includes a region whose switch to this window is in flight
    // (its layout hasn't caught up yet) — so a fast second click focuses it instead
    // of switching another region onto the same window (which would sync them).
    const holder = this.units.find(u => u.layout?.activeWindowId === id || u._targetWindowId === id);
    if (holder) { this.focus(holder); return; }
    const u = this._switchTargetRegion();
    if (!u) return;
    const finish = () => { u._targetWindowId = id; u.selectWindow(id); this.focus(u); };
    // Only hop sessions when the window truly isn't in this region's list. Grouped
    // split sessions SHARE the base (services) window list, so a services window is
    // already selectable here even though the region's session name differs — never
    // switch-client onto the shared console session for it (that drags the console).
    const inList = (u.layout?.windows || []).some(w => w.id === id);
    if (!inList && session && u.layout && session !== u.layout.sessionName) {
      u.switchSession(session);
      setTimeout(finish, 300);
    } else {
      finish();
    }
  }

  // Toolbar recent-tab click -> shared navigation.
  pickRecentWindow(entry) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    const session = (typeof entry === 'object' && entry.session) || '';
    this.goToWindow(id, session);
  }

  _pushLayout(unit) {
    const sb = this.sidebar;
    sb.layout = unit.layout || null;
    sb.activePane = unit.layout?.activePaneId || '';
    sb.activeWindow = unit.layout?.activeWindowId || '';
    this._pushDisabled();
  }

  // Tell the shared sidebar which windows are already shown by OTHER regions, so it
  // can grey them out / skip them — two panes on the same window share it (tmux
  // grouped sessions) and would stay in sync, which is exactly what we prevent.
  _pushDisabled() {
    const focused = this.focusedUnit;
    if (!focused) return;
    this.sidebar.disabledWindows = this.units
      .filter(u => u !== focused)
      .map(u => u.layout?.activeWindowId)
      .filter(Boolean);
  }

  // Add a region and, once its layout arrives, auto-select a window not already
  // shown by another region ("next unused window") so the split is immediately useful.
  splitAdd() {
    const unit = this.addUnit({});
    unit._autoPickPending = true;
    return unit;
  }

  closeFocused() {
    if (this.focusedUnit && !this.focusedUnit.primary) this.removeUnit(this.focusedUnit);
  }

  // #app gets .split-active only with >1 region, so single-view keeps its exact
  // old look (no focus outline, no divider).
  _syncSplitClass() {
    this.container.classList.toggle('split-active', this.units.length > 1);
  }

  _refitSoon() {
    setTimeout(() => { for (const u of this.units) { try { u.fit(); } catch (e) {} } }, 60);
  }

  _installControls() {
    // Global shortcuts (capture phase, Alt-based so they never hit tmux's Ctrl-b
    // and browsers don't reserve them). stopPropagation keeps xterm from seeing them.
    window.addEventListener('keydown', (ev) => {
      if (!ev.ctrlKey || !ev.altKey || ev.metaKey) return;
      switch (ev.code) {
        case 'KeyB':                                   // toggle the shared sidebar
          this.sidebar?.toggleCollapsed();
          break;
        case 'Enter':                                  // add a split region
          this.splitAdd();
          break;
        case 'Backspace':                              // close focused region
          this.closeFocused();
          break;
        case 'KeyE':                                   // toggle the Exposé overlay
          this.expose?.toggle();
          break;
        default:
          return;                                      // not ours — let it through
      }
      ev.preventDefault();
      ev.stopPropagation();
    }, true);

    // Buttons in the sidebar dispatch these (composed, cross shadow DOM).
    window.addEventListener('webtmux-split-add', () => this.splitAdd());
    window.addEventListener('webtmux-split-close', (e) => this.removeUnit(e.detail?.unit || this.focusedUnit));
    window.addEventListener('webtmux-expose-open', () => this.expose?.openOverlay());
  }
}
