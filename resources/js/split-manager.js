// SplitManager — owns an ordered list of TerminalUnits tiled side by side, a
// focused unit, and ONE shared sidebar. The first unit is the PRIMARY region on
// the shared base session (stays in sync with the ssh console); each added region
// gets a freshly generated grouped-session name so it has its own current window
// while sharing the window list.
//
// THE NAVIGATION MODEL (the invariants every switcher relies on):
//   1. focusedUnit is the ONE navigation target. Every switcher — sidebar window
//      tabs, sidebar session tabs, sidebar arrow keys, toolbar recents, Exposé —
//      changes what the FOCUSED pane shows, even when that means the pane hops
//      to another session. Nothing ever navigates a non-focused pane.
//   2. A window is VISIBLE in at most one pane. Windows shown (or in-flight
//      via _targetWindowId) by other panes are disabled in every switcher; the
//      single source of that set is occupiedWindowIds().
//   3. A pane's LOGICAL session is layout.sessionBase (the server resolves a
//      split's ephemeral web-* grouped session to the group's base). All display
//      and comparison uses it; the web-* shadow names never surface.
//   4. Recency has ONE write path (noteAccess -> captureCache.accessed,
//      persisted) shared by the toolbar strip and the Exposé sort.
//   5. Cross-session navigation is safe for any pane: the backend switches only
//      the pane's own tmux client (-c <its tty>) and re-groups split panes onto
//      the target session, so panes never couple with the console or each other.
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
      // Drag the divider to transfer width between the two regions it sits between.
      // (The cursor already advertised col-resize; this makes it actually work.)
      divider.addEventListener('mousedown', (e) => this._startDividerDrag(divider, e));
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
    this._equalizeRegions();   // a fresh region joins as an equal split, clearing any prior drag
    this.focus(unit);
    this._refitSoon();
    return unit;
  }

  // Return every region to equal `flex: 1 1 0` by clearing the inline flex-grow a
  // divider drag stamped on. Called on add/remove so a new/removed region doesn't
  // inherit stale grow ratios (which would render the un-stamped region as a sliver).
  _equalizeRegions() {
    for (const r of this.container.querySelectorAll('.region')) r.style.flexGrow = '';
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
    this._syncSplitClass();
    this._equalizeRegions();   // remaining regions re-split evenly
    this.focus(this.units[Math.min(idx, this.units.length - 1)] || this.units[0]);
    this._refitSoon();
  }

  focus(unit) {
    if (!unit) return;
    this.focusedUnit = unit;
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
  // most-recently-used-window auto-pick for a freshly added region.
  _onUnitLayout(unit) {
    if (unit === this.focusedUnit) this._pushLayout(unit);
    else this._pushDisabled();   // another region moved -> refresh what's occupied

    if (unit._autoPickPending && unit.layout) {
      const activeId = unit.layout.activeWindowId;
      // Windows another pane already shows (incl. in-flight switches) are off-limits.
      const used = this.occupiedWindowIds(unit);
      const recencyOf = (id) => this.captureCache.accessed.get(id) ?? 0;
      // Land the split on the MOST-RECENTLY-USED window that isn't already shown in
      // another pane — the recency store (captureCache.accessed) IS the "last used"
      // list. Windows you've never visited have recency 0 and sort last, so the
      // first/default window (the spawn's window 0) is chosen ONLY when nothing you
      // actually used is free; it no longer wins just by being first in the list.
      const target = (unit.layout.windows || [])
        .map((w) => w.id)
        .filter((id) => !used.has(id))
        .sort((a, b) => recencyOf(b) - recencyOf(a))[0];
      if (target && target !== activeId) {
        // Claim the target now (so a rapid second split can't grab the same window),
        // and mark the spawn window as already-seen so the access-note below skips
        // it: the split only PASSED THROUGH window 0 while relocating, it was never
        // really viewed, so it must not pollute the recents strip. The landing
        // window is recorded for real when its own layout arrives.
        unit._targetWindowId = target;
        unit._accessSeenId = activeId;
        unit.selectWindow(target);
      }
      unit._autoPickPending = false;
    }

    // An in-flight goToWindow target that the layout now confirms is no longer
    // "pending" — clear it even when it wasn't a change (e.g. re-selecting the
    // window the pane was already on), so it can't linger as a phantom claim.
    const newId = unit.layout?.activeWindowId;
    if (unit._targetWindowId && unit._targetWindowId === newId) unit._targetWindowId = null;

    // MRU access: a region now shows a window it wasn't = an access — UNLESS the
    // switch came from sidebar arrow-key browsing (marked in _suppressAccessIds).
    // Expose browsing doesn't switch a region, so it never lands here.
    if (newId && newId !== unit._accessSeenId) {
      unit._accessSeenId = newId;
      unit._targetWindowId = null;   // an in-flight goToWindow switch has landed
      if (!unit._suppressAccessIds.delete(newId)) this.noteAccess(newId, this._metaFor(unit, newId));
    }
    this._refreshToolbar();
  }

  // A pane's LOGICAL session: the group's base for a split's ephemeral web-*
  // grouped session (server-resolved), else the session itself. All display and
  // session comparison goes through this — shadow names never surface.
  logicalSession(unit) {
    return unit?.layout?.sessionBase || unit?.layout?.sessionName || '';
  }

  // Window ids already claimed by panes OTHER than `exclude` — the single source
  // for "disabled" in every switcher (toolbar recents + sidebar tabs/arrows).
  // A pane claims its current window AND an in-flight _targetWindowId (a switch
  // that hasn't landed), so fast clicks can't put two panes on one window.
  occupiedWindowIds(exclude) {
    return new Set(
      this.units
        .filter(u => u !== exclude)
        .map(u => u._targetWindowId || u.layout?.activeWindowId)
        .filter(Boolean)
    );
  }

  // Snapshot a window's display metadata (index/name/session) from the accessing
  // region's layout — captured at access time so recents survive across sessions
  // even when that window isn't in the focused region's window list anymore.
  _metaFor(unit, id) {
    const w = (unit.layout?.windows || []).find(x => x.id === id);
    return { index: w?.index, name: w?.name || 'bash', session: this.logicalSession(unit) };
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
      // Recents store LOGICAL session names, so coverage must too (a split's
      // own sessionName is a web-* shadow that never matches a recent's session).
      covered.add(this.logicalSession(u));
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

  // Pane-focus dots: one per region (only when >1), green on the focused pane.
  // Also surface the focused region's copy-mode state (ground truth from the
  // layout poll's #{pane_in_mode}) so the toolbar can recolor + show the status.
  _refreshPanes() {
    if (!this.toolbar) return;
    this.toolbar.panes = this.units.length > 1
      ? this.units.map(u => u === this.focusedUnit)
      : [];
    this.toolbar.copyMode = !!this.focusedUnit?.layout?.activePaneInMode;
  }

  // Toolbar copy-mode pill: toggle copy mode on the FOCUSED region's active pane.
  // Uses the layout's ground-truth mode to decide direction, and updates the
  // pill optimistically for snappy feedback (the 500ms poll then confirms it).
  toggleCopyMode() {
    const u = this.focusedUnit;
    if (!u) return;
    const inMode = !!u.layout?.activePaneInMode;
    if (inMode) u.exitCopyMode();
    else u.enterCopyMode();
    if (this.toolbar) this.toolbar.copyMode = !inMode;
  }

  _refreshToolbar() {
    if (!this.toolbar) return;
    this._refreshPanes();
    this._pruneDeletedRecents();
    const focused = this.focusedUnit;
    const activeId = focused?.layout?.activeWindowId;
    const cache = this.captureCache?.byWindow;
    // Ground-truth window metadata from every region's LIVE layout — the same
    // source the sidebar reads, refreshed by the 500ms layout poll. A tmux rename
    // lands here immediately, whereas the capture cache only refreshes when a
    // capture frame arrives (Exposé/capture poll), so we MUST trust live first or
    // renamed tabs go stale while the sidebar updates.
    const liveById = new Map();
    for (const u of this.units) {
      for (const w of (u.layout?.windows || [])) {
        if (!liveById.has(w.id)) liveById.set(w.id, w);
      }
    }
    // Windows shown by OTHER panes are not selectable here (they'd put two panes on
    // one window) — greyed out, like the sidebar. One shared source: occupiedWindowIds.
    const occupied = this.occupiedWindowIds(focused);
    this.toolbar.recent = this.recentWindows.map(e => {
      const live = liveById.get(e.id);
      // Keep the access-time snapshot fresh from the live layout so the name/index
      // stay correct even after the window later leaves every region's window list
      // (recents outlive the session they were accessed in).
      if (live?.name) e.name = live.name;
      if (live?.index != null) e.index = live.index;
      const c = cache?.get(e.id);
      return {
        id: e.id,
        index: live?.index ?? c?.index ?? e.index ?? '?',
        name: live?.name || c?.name || e.name || 'bash',
        session: c?.sessionName || e.session || '',
        active: e.id === activeId,
        disabled: occupied.has(e.id),
      };
    });
    this.toolbar.collapsed = !!this.sidebar?.collapsed;
  }

  // Navigate to a window from ANY switcher (toolbar recent-strip, Exposé tile):
  // change what the FOCUSED pane shows — the model's single navigation rule.
  //   1) Occupied by another pane -> no-op (its tab is disabled anyway).
  //   2) In the focused pane's own window list -> select it.
  //   3) In another session -> hop the pane there, then select. Safe for every
  //      pane: the backend switches only this pane's own tmux client and
  //      re-groups a split onto the target session (it never couples with the
  //      console or another pane). The two sends ride the same serialized ws,
  //      and the server's session switch refreshes its layout cache before the
  //      select resolves the window id — no timing gap, no setTimeout.
  goToWindow(id, session = '') {
    if (!id) return;
    const u = this.focusedUnit;
    if (!u) return;
    if (this.occupiedWindowIds(u).has(id)) return;
    if (u.layout?.activeWindowId === id) { u.terminal?.focus(); return; }  // already showing it
    const inList = (u.layout?.windows || []).some(w => w.id === id);
    if (!inList) {
      if (!session || !u.layout || session === this.logicalSession(u)) return; // unreachable
      u.switchSession(session);
    }
    u._targetWindowId = id;
    u.selectWindow(id);
    u.terminal?.focus();
  }

  // Keyboard nav across the recents strip: move to the VISUALLY adjacent entry
  // in the bar's stable left→right order (this.recentWindows) — NOT the recency
  // ranking that decides which windows the bar holds. Anchors on the focused
  // pane's current window, skips entries another pane already shows (same rule as
  // the greyed toolbar tabs / goToWindow's guard), and wraps at both ends since
  // the strip is short (≤5). If the focused window isn't in the bar, prev picks
  // the last entry and next the first. dir = -1 (previous/left) or +1 (next/right).
  // Selection reuses goToWindow so it inherits all the pane-targeting logic.
  // Mirrors tmux's Ctrl-b p / Ctrl-b n over the toolbar's bounded window set.
  navigateRecents(dir) {
    const list = this.recentWindows;
    if (!list || !list.length) return;
    const focused = this.focusedUnit;
    const activeId = focused?.layout?.activeWindowId;
    const occupied = this.occupiedWindowIds(focused);
    const selectable = list.filter(e => !occupied.has(e.id));
    if (!selectable.length) return;
    const idx = selectable.findIndex(e => e.id === activeId);
    const next = idx === -1
      ? selectable[dir > 0 ? 0 : selectable.length - 1]
      : selectable[(idx + dir + selectable.length) % selectable.length];
    if (next && next.id !== activeId) this.goToWindow(next.id, next.session);
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
  // Same source as the toolbar (occupiedWindowIds), so in-flight switches count.
  _pushDisabled() {
    const focused = this.focusedUnit;
    if (!focused) return;
    this.sidebar.disabledWindows = [...this.occupiedWindowIds(focused)];
  }

  // Add a region and, once its layout arrives, auto-select the most-recently-used
  // window not already shown by another region, so the split opens on something
  // useful (what you last looked at) rather than the default first window.
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

  // Divider drag-to-resize. The divider sits between two .region siblings; dragging
  // transfers width from one to the other. Regions are `flex: 1 1 0` (equal grow),
  // so we express widths as flex-grow ratios — freezing EVERY region to a grow
  // proportional to its current pixel width first, so non-adjacent regions hold
  // steady and the ratios survive later container/window resizes. Each region's
  // terminal has a ResizeObserver (fit + sendResize), so xterm reflows and tmux
  // gets the new size live as we drag; a final refit settles it on release.
  _startDividerDrag(divider, e) {
    if (e.button !== 0) return;                  // left-drag only
    const prevRegion = divider.previousElementSibling;
    const nextRegion = divider.nextElementSibling;
    if (!prevRegion?.classList.contains('region') || !nextRegion?.classList.contains('region')) return;
    e.preventDefault();

    // Pin all regions to width-proportional grow values so only this pair moves.
    for (const r of this.container.querySelectorAll('.region')) {
      r.style.flexGrow = String(Math.max(1, Math.round(r.getBoundingClientRect().width)));
    }
    const startX = e.clientX;
    const w1 = prevRegion.getBoundingClientRect().width;
    const w2 = nextRegion.getBoundingClientRect().width;
    const total = w1 + w2;
    const MIN = 80;                              // keep a usable sliver on both sides

    const onMove = (ev) => {
      let nw1 = w1 + (ev.clientX - startX);
      nw1 = Math.max(MIN, Math.min(total - MIN, nw1));
      prevRegion.style.flexGrow = String(Math.round(nw1));
      nextRegion.style.flexGrow = String(Math.round(total - nw1));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      this._refitSoon();
    };
    // userSelect/cursor overrides keep the drag from selecting page text or
    // flipping to the default cursor when the pointer briefly leaves the 4px bar.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
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
        case 'KeyP':                                   // recents: previous (left in the bar)
          this.navigateRecents(-1);
          break;
        case 'KeyN':                                   // recents: next (right in the bar)
          this.navigateRecents(+1);
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
