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
import { TerminalUnit, MSG } from './terminal-unit.js';
import { CaptureCache } from './capture-cache.js';
import { HoverPreview } from './hover-preview.js';
import { WorkAlerts } from './work-alerts.js';
import { MAX_RECENTS, sanitizeRecents, recentsSignature } from './recents-strip.js';
import { IS_MAC } from './os.js';
import { stateStore } from './state-store.js';
import { clientStore } from './client-store.js';

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

    // The ONE transient-preview controller. Every switcher (toolbar recents, sidebar
    // rows + arrow browsing, Preview tiles) points at a window through this, and
    // commits through it — so "hovering shows it, acting switches to it" is a single
    // behavior with a single implementation rather than one popup per surface.
    this.hover = new HoverPreview(this);

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

    // The keyboard-shortcuts overlay (hidden until opened via Ctrl+Alt+/ or the
    // sidebar's "Keyboard shortcuts" button — makes the hotkeys discoverable).
    this.shortcuts = document.createElement('webtmux-shortcuts');
    this.container.appendChild(this.shortcuts);

    // The live Preview (Picture-in-Picture for one window, a docked edge bar for
    // several). Hidden until a window is added via Ctrl+Alt+I or the toolbar button.
    // Reads from the same shared CaptureCache; any change to its set/hidden state
    // syncs the toolbar's preview buttons via onChange.
    this.pip = document.createElement('webtmux-pip');
    this.pip.cache = this.captureCache;
    this.pip.manager = this;
    this.pip.onChange = () => this._refreshToolbar();
    this.container.appendChild(this.pip);

    // Top toolbar (above #app): most-recently-accessed windows + sidebar toggle.
    // Recent-windows strip: entries keep a STABLE display position — re-accessing
    // a shown window never reorders it. Recency itself is NOT tracked here: the
    // single source of truth is this.captureCache.accessed (persisted), fed by
    // noteAccess() and also read by the Exposé "Last accessed" sort — one code
    // path for both. This list holds only the toolbar's bounded/stable view.
    // Persisted (shared 'recentTabs' section) so the strip survives a reload — see
    // _persistRecents/_restoreRecents. Recency lives in captureCache.accessed; this
    // list is the bounded/stable ORDER, which recency alone can't reconstruct.
    this.recentWindows = [];         // {id,index,name,session}, stable order (MAX_RECENTS)
    // Which recent tabs are flashing for attention because their stoplight dropped
    // out of green while you were looking elsewhere (see work-alerts.js).
    this.workAlerts = new WorkAlerts();
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

    // Restore visual state that used to be lost on reload, now that a unit exists
    // (so capture requests have a ws) and the StateStore sender is wired:
    //   • the Preview/PiP window set + hidden flag (shared 'pip' section),
    //   • the recents strip itself (shared 'recentTabs' section),
    //   • any saved split-view regions (shared 'split' section, per-client widths).
    this.pip.restoreState();
    this._restoreRecents();
    this._restoreSplitState();
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
    // Back-reference so components bound to a unit (the shared sidebar) can reach
    // app-wide services — chiefly the one HoverPreview every switcher goes through.
    unit.manager = this;
    // The shared StateStore writes @wt_state over the PRIMARY unit's ws (any ws
    // works — @wt_state is server-global — but the primary is always present and
    // console-synced). Its layout pushes carry the blob back; feed them in below.
    if (primary) stateStore.setSender((json) => unit.sendMessage(MSG.TmuxSetState, json));
    unit.onFocus = (u) => this.focus(u);
    unit.onLayout = (u) => this._onUnitLayout(u);
    // Every tmux command this region sends ticks the toolbar's activity spinner.
    unit.onTmuxActivity = () => this.pulseTmuxActivity();
    // Route this unit's capture replies into the shared cache, and give the unit
    // read access for optimistic paint on window switch.
    unit.captureCache = this.captureCache;
    unit.onCaptureData = (payload) => this.captureCache.ingest(payload);
    // Server-side "save pane buffer to file" outcome -> toolbar dropdown feedback.
    unit.onSaveResult = (res) => this.onSaveResult(res);
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
    if (!primary) this._persistSplitState();  // region count changed → shared 'split'
    return unit;
  }

  // Return every region to equal `flex: 1 1 0` by clearing the inline flex-grow a
  // divider drag stamped on. Called on add/remove so a new/removed region doesn't
  // inherit stale grow ratios (which would render the un-stamped region as a sliver).
  _equalizeRegions() {
    for (const r of this.container.querySelectorAll('.region')) r.style.flexGrow = '';
  }

  // --- split-view persistence --------------------------------------------------
  // Shared: which windows the EXTRA (non-primary) regions show, in order. The
  // primary is always recreated and console-driven, so it's excluded — regions[i]
  // here corresponds to units[i+1]. Per-client width/focus live in ClientStore.
  _persistSplitState() {
    if (this._restoringSplit) return;
    const regions = this.units.slice(1).map((u) => ({
      windowId: u._targetWindowId || u.layout?.activeWindowId || null,
    }));
    stateStore.patchSection('split', { regions });
  }

  // Per-client: the divider ratios (inline flex-grow) in region DOM order. A reload
  // restores your own pane sizes without sharing them across browsers.
  _persistWidths() {
    if (this._restoringSplit) return;
    const widths = [...this.container.querySelectorAll('.region')].map((r) => r.style.flexGrow || '');
    clientStore.patch({ splitWidths: widths });
  }

  // Recreate the saved extra regions (shared) and re-apply per-client widths + focus.
  // Called once from the constructor after the primary unit + StateStore sender exist.
  // Defensive: a stale/absent window just leaves that region on its default (handled
  // in _onUnitLayout via _restoreWindowId); no saved regions => a no-op.
  _restoreSplitState() {
    const saved = stateStore.section('split').regions;
    const list = Array.isArray(saved) ? saved : [];
    if (list.length) {
      this._restoringSplit = true;
      try {
        for (const r of list) {
          const unit = this.addUnit({});
          if (r && r.windowId) unit._restoreWindowId = r.windowId;
          else unit._autoPickPending = true;   // no saved window → MRU auto-pick
        }
      } finally {
        this._restoringSplit = false;
      }
      this._persistSplitState();   // refresh the shared blob's rev to match reality
    }

    // Per-client widths (applied AFTER regions exist; _equalizeRegions cleared them).
    const widths = clientStore.get('splitWidths', null);
    if (Array.isArray(widths) && widths.length) {
      const rgs = [...this.container.querySelectorAll('.region')];
      widths.forEach((w, i) => { if (rgs[i] && w) rgs[i].style.flexGrow = w; });
      this._refitSoon();
    }

    // Per-client focused region.
    const fi = clientStore.get('focusedIndex', 0);
    if (Number.isInteger(fi) && this.units[fi]) this.focus(this.units[fi]);
  }

  removeUnit(unit) {
    if (!unit || unit.primary) return;   // never remove the console-synced primary
    const idx = this.units.indexOf(unit);
    if (idx === -1) return;

    // Drop it from the hover preview's "where does this window live" memory (and
    // release it if it happens to be hosting a preview right now) BEFORE it dies.
    this.hover.forgetUnit(unit);

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
    this._persistSplitState();       // region count changed → shared 'split'
    this._persistWidths();           // regions re-equalized → drop stale per-client widths
  }

  focus(unit) {
    if (!unit) return;
    // Focusing a region is a deliberate act, so it settles any transient preview:
    // clicking INTO the region that is showing one is "yes, this window" (commit);
    // clicking anywhere else abandons the browse (restore). Same rule the sidebar's
    // keyboard browse always had — click-away accepted what you were looking at.
    if (this.hover.windowId) {
      if (this.hover.activeUnit === unit) this.hover.commit();
      else this.hover.cancel();
    }
    this.focusedUnit = unit;
    // Compat shim: mobile-controls + any global shortcut target the focused unit.
    window.webtmux = unit;
    for (const u of this.units) {
      u.region.classList.toggle('focused', u === unit);
    }
    // Re-point the single shared sidebar at the focused region and paint its state.
    this.sidebar.unit = unit;
    this._pushLayout(unit);
    // Focusing a region "accesses" the window it's showing (MRU toolbar) — this is
    // the commit point for a previewed session/window, so clear any pending
    // preview-suppression so it can't swallow this or a later real access.
    unit._suppressAccessNext = false;
    const win = unit.layout?.activeWindowId;
    if (win) { unit._accessSeenId = win; this.noteAccess(win, this._metaFor(unit, win)); }
    else this._refreshToolbar();
    unit.terminal?.focus();
    // Which region is focused is per-client viewport state → ClientStore (a reload
    // restores your own focus without leaking to other browsers).
    if (!this._restoringSplit) clientStore.patch({ focusedIndex: this.units.indexOf(unit) });
  }

  // Forward a unit's layout to the shared sidebar ONLY when it is the focused
  // region (so the one sidebar always reflects the focused window), and drive the
  // most-recently-used-window auto-pick for a freshly added region.
  _onUnitLayout(unit) {
    // Shared visual state rides every layout push (layout.state === @wt_state). Feed
    // it from the primary unit only — the blob is identical across units, so one
    // authority avoids redundant applies. StateStore ignores echoes of our own write.
    if (unit.primary) stateStore.load(unit.layout && unit.layout.state);

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

    // Restore-target: a region recreated by _restoreSplitState() wants to land on the
    // specific window it showed last session. Navigate there once its layout arrives,
    // but only if that window still exists and isn't already claimed by another region
    // (a tmux server restart may have changed the window set — then we just stay put).
    if (unit._restoreWindowId && unit.layout) {
      const target = unit._restoreWindowId;
      unit._restoreWindowId = null;
      const used = this.occupiedWindowIds(unit);
      const exists = (unit.layout.windows || []).some((w) => w.id === target);
      if (exists && !used.has(target) && target !== unit.layout.activeWindowId) {
        unit._targetWindowId = target;
        unit._accessSeenId = unit.layout.activeWindowId;
        unit.selectWindow(target);
      }
    }

    // An in-flight goToWindow target that the layout now confirms is no longer
    // "pending" — clear it even when it wasn't a change (e.g. re-selecting the
    // window the pane was already on), so it can't linger as a phantom claim.
    const newId = unit.layout?.activeWindowId;
    if (unit._targetWindowId && unit._targetWindowId === newId) unit._targetWindowId = null;

    // Remember which region each window really lives in, so a later hover preview of
    // it reappears where you're used to seeing it rather than hijacking the focused
    // region (HoverPreview rule 1).
    if (unit.layout?.activeWindowId) this.hover.noteRendered(unit.layout.activeWindowId, unit);

    // MRU access: a region now shows a window it wasn't = an access — UNLESS the
    // switch came from sidebar browsing (marked in _suppressAccessIds for arrow-key
    // WINDOW nav, or _suppressAccessNext for ←/→ SESSION nav where the landing
    // window id isn't known ahead of time). Browsing only PREVIEWS in the pane; the
    // window is committed to recents when the pane actually takes focus (see focus()).
    // Expose browsing doesn't switch a region, so it never lands here.
    if (newId && newId !== unit._accessSeenId) {
      unit._accessSeenId = newId;
      unit._targetWindowId = null;   // an in-flight goToWindow switch has landed
      const landSession = this.logicalSession(unit);
      let suppressed = unit._suppressAccessIds.delete(newId) || unit._suppressAccessNext;
      unit._suppressAccessNext = false;
      // Cross-session-hop transient guard: an intermediate layout that still shows
      // the hopped window in the OLD session must not be recorded — otherwise
      // cycling recents (Ctrl+Alt+N) onto a linked window resurrects the very tab
      // you removed. Skip ONLY that exact (id, old-session) pair; the real landing
      // (same id, NEW session) records normally and clears the guard.
      if (unit._navSuppress && unit._navSuppress.id === newId &&
          unit._navSuppress.session === landSession) {
        suppressed = true;
      }
      if (unit._navSuppress && landSession !== unit._navSuppress.session) unit._navSuppress = null;
      if (!suppressed) this.noteAccess(newId, this._metaFor(unit, newId));
      // A non-primary region landing on a new window changes the saved split layout
      // (the primary's window is console-driven and never restored, so skip it).
      if (!unit.primary) this._persistSplitState();
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
  //
  // Entries are keyed by (SESSION, window-id), not window-id alone: a window LINKED
  // into two sessions is reachable in each, so it earns a tab per session you've
  // visited it through — otherwise the second session's view was unreachable from
  // the strip (it collapsed onto the first). meta.session is the logical session
  // the access happened in.
  noteAccess(id, meta = {}) {
    if (!id) return;
    // Bump recency in the ONE shared store (also drives the Exposé sort + persists).
    this.captureCache.markAccessed(id);
    const recencyOf = (wid) => this.captureCache.accessed.get(wid) ?? 0;
    const session = meta.session || '';
    const existing = this.recentWindows.find(e => e.id === id && e.session === session);
    if (existing) {
      if (meta.name) existing.name = meta.name;
      if (meta.index != null) existing.index = meta.index;
    } else {
      const entry = { id, index: meta.index, name: meta.name || 'bash', session };
      const list = [...this.recentWindows];
      if (list.length < MAX_RECENTS) {
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

  // --- recents-strip persistence -----------------------------------------------
  // The strip is SHARED durable state (like the PiP window set): the tabs you built
  // up are a view of the tmux server, so every browser on that server should see the
  // same ones, and they should outlive a reload. captureCache.accessed already
  // persists RECENCY, but it cannot rebuild the strip: entries are keyed by
  // (session, id) so a linked window earns a tab per session, and the display ORDER
  // is deliberately stable/drag-arranged rather than recency-derived.
  //
  // Called from _refreshToolbar — the one funnel every mutation routes through
  // (noteAccess, removeRecent, reorderRecent, _pruneDeletedRecents) — so there is no
  // path that changes the strip without persisting it. Because that funnel also runs
  // on every 500ms layout push, the signature guard is what keeps this from writing
  // (and bumping @wt_state's rev) 2x/second: only a real change schedules a write.
  _persistRecents() {
    const sig = recentsSignature(this.recentWindows);
    if (sig === this._recentsSig) return;
    this._recentsSig = sig;
    // Only the durable identity fields. active/disabled/working are derived per
    // render from live layouts and must never be frozen into the blob.
    stateStore.patchSection('recentTabs', {
      windows: this.recentWindows.map(e => ({
        id: e.id, index: e.index, name: e.name, session: e.session,
      })),
    });
  }

  // Seed the strip from the shared blob at boot, and adopt it when ANOTHER client
  // changes it. Entries are sanitized (the blob is user-writable tmux state) and
  // capped at MAX_RECENTS, the same bound noteAccess enforces. Windows that died while this
  // client was away are NOT filtered here — no layout has arrived yet, so there is
  // nothing to compare against; _pruneDeletedRecents drops them on the first push.
  _restoreRecents() {
    const read = () => sanitizeRecents(stateStore.section('recentTabs').windows);

    this.recentWindows = read();
    // Match the signature to what we just read, so the restore itself can't be
    // mistaken for a local edit and echo straight back out as a write.
    this._recentsSig = recentsSignature(this.recentWindows);

    // A remote write (another browser) replaces the strip wholesale — same
    // last-writer-wins rule the rest of the blob follows. The refresh below runs
    // inside StateStore's _applying guard, so the _persistRecents it triggers is a
    // no-op and cannot loop the adopted value back to the server.
    stateStore.subscribe((_state, fromRemote) => {
      if (!fromRemote) return;
      const next = read();
      const sig = recentsSignature(next);
      if (sig === this._recentsSig) return;
      this.recentWindows = next;
      this._recentsSig = sig;
      this._refreshToolbar();
    });

    if (this.recentWindows.length) this._refreshToolbar();
  }

  // Remove a window from the recent strip WITHOUT killing the tmux window — the
  // per-tab × affordance. Also forget its access recency so the Exposé "Last
  // accessed" sort stops ranking it as recent (refreshes an open Exposé).
  //
  // When there are 2+ regions and a NON-primary split region is currently showing
  // this window, closing the tab also CLOSES that region — so × on a recent is a
  // de-facto "kill the split that was showing this window". (The primary region is
  // console-synced and never closed; the tmux window itself keeps running.)
  removeRecent(entry) {
    // Accept the full entry (id + session) so only THIS session's tab is removed;
    // tolerate a bare id string for older callers.
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (!id) return;
    const session = (entry && typeof entry === 'object') ? (entry.session ?? null) : null;
    const matches = (e) => e.id === id && (session == null || e.session === session);
    // The tab being removed may be the one under the pointer, with its preview up —
    // and it's about to stop existing. Drop the preview first so it can't outlive
    // the tab that owns it (nothing would ever fire the matching leave).
    if (this.hover.windowId === id) this.hover.cancel();
    // If the focused pane is currently VIEWING this exact (window, session), closing
    // its tab would strand the pane on a window that's no longer in the strip. So
    // first move the view to the next available recent — exactly what Ctrl+Option+N
    // does. (No-op if there's nothing else to step to.)
    if (this.focusedUnit?.layout?.activeWindowId === id &&
        (session == null || this.logicalSession(this.focusedUnit) === session)) {
      this.navigateRecents(+1);
    }
    if (this.units.length > 1) {
      const holder = this.units.find(u => !u.primary && u.layout?.activeWindowId === id);
      if (holder) this.removeUnit(holder);
    }
    const before = this.recentWindows.length;
    this.recentWindows = this.recentWindows.filter(e => !matches(e));
    // Only forget the shared access recency once NO remaining tab references this
    // window id (a linked window may still have another session's tab in the strip).
    if (!this.recentWindows.some(e => e.id === id)) this.captureCache?.forgetAccessed(id);
    if (this.recentWindows.length !== before) this._refreshToolbar();
  }

  // Remove the FOCUSED pane's CURRENT window from the recents strip — the keyboard
  // equivalent of clicking × on the recent tab you're looking at (Ctrl+Alt+D). It
  // reuses removeRecent, so it inherits the same "step the view to the next recent"
  // pick and the same close-the-split-holder behavior. No-op if the current window
  // isn't in the strip (nothing to remove). Prefer the tab for the pane's own
  // session; fall back to any tab for this window id.
  removeFocusedFromRecents() {
    const u = this.focusedUnit;
    const id = u?.layout?.activeWindowId;
    if (!id) return;
    const session = this.logicalSession(u);
    const entry = this.recentWindows.find(e => e.id === id && e.session === session)
      || this.recentWindows.find(e => e.id === id);
    if (entry) this.removeRecent(entry);
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

  // Save the FOCUSED pane's entire captured buffer to a downloaded text file.
  // We do the tmux capture-pane → save-buffer flow ourselves off the shared
  // CaptureCache (the same snapshot Exposé/Preview read): force a fresh capture of
  // this one window, then — as soon as its frame lands (or a short grace period
  // elapses) — decode it, strip SGR colour codes, and hand the browser a .txt
  // download named for the session + window.
  savePaneBuffer() {
    const u = this.focusedUnit;
    const id = u?.layout?.activeWindowId;
    if (!id) return;
    const cache = this.captureCache;
    const win = (u.layout?.windows || []).find((w) => w.id === id);
    const sess = this.logicalSession(u) || 'session';
    const idx = win?.index ?? 0;
    const name = win?.name || 'bash';
    const fname = sanitizeFilename(`${sess}-${idx}-${name}`) + '.txt';

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cache.removeEventListener('update', onUpdate);
      const entry = cache.get(id);
      if (!entry) return; // nothing captured yet — nothing to write
      downloadText(fname, paneBufferText(entry));
    };
    const onUpdate = () => finish();
    // Write on the next capture frame (our forced one), with a grace-period fallback
    // so a slow/missing reply still saves the best snapshot already cached.
    cache.addEventListener('update', onUpdate);
    cache.request([id], true);
    setTimeout(finish, 1200);
  }

  // A sensible default filename for the FOCUSED pane's buffer: "session-index-name.txt".
  // Used to prefill the save dropdown's path input.
  suggestedSaveName() {
    const u = this.focusedUnit;
    const id = u?.layout?.activeWindowId;
    if (!id) return 'pane.txt';
    const win = (u.layout?.windows || []).find((w) => w.id === id);
    const sess = this.logicalSession(u) || 'session';
    const idx = win?.index ?? 0;
    const name = win?.name || 'bash';
    return sanitizeFilename(`${sess}-${idx}-${name}`) + '.txt';
  }

  // Save the FOCUSED pane's buffer to a file ON THE MACHINE TMUX RUNS ON at the
  // user-typed `path`. Unlike savePaneBuffer (a browser download), the server does
  // the capture + write itself and resolves a relative path against the pane's own
  // working directory. The outcome arrives via onSaveResult (toolbar feedback).
  savePaneBufferToPath(path) {
    const u = this.focusedUnit;
    const id = u?.layout?.activeWindowId;
    if (!id || !u) return;
    const p = String(path || '').trim();
    if (!p) return;
    if (this.toolbar) this.toolbar.saveStatus = { state: 'saving', text: 'Saving…' };
    u.sendSavePaneFile(id, p);
  }

  // Surface a server-side save outcome in the toolbar's save dropdown. Success
  // shows the absolute path it landed at and auto-dismisses; an error stays up so
  // the user can read it and correct the path.
  onSaveResult(res) {
    if (!this.toolbar) return;
    if (res && res.ok) {
      this.toolbar.saveStatus = { state: 'ok', text: 'Saved: ' + (res.path || '') };
      setTimeout(() => {
        if (this.toolbar && this.toolbar.saveStatus?.state === 'ok') {
          this.toolbar.saveOpen = false;
          this.toolbar.saveStatus = null;
        }
      }, 1800);
    } else {
      this.toolbar.saveStatus = { state: 'err', text: (res && res.error) || 'Save failed' };
    }
  }

  _refreshToolbar() {
    if (!this.toolbar) return;
    this._refreshPanes();
    this._pruneDeletedRecents();
    const focused = this.focusedUnit;
    const activeId = focused?.layout?.activeWindowId;
    const focusedSession = focused ? this.logicalSession(focused) : '';
    const cache = this.captureCache?.byWindow;
    // Ground-truth window metadata from every region's LIVE layout — the same
    // source the sidebar reads, refreshed by the 500ms layout poll. A tmux rename
    // lands here immediately, whereas the capture cache only refreshes when a
    // capture frame arrives (Exposé/capture poll), so we MUST trust live first or
    // renamed tabs go stale while the sidebar updates. Keyed by (session, id) so a
    // linked window resolves to ITS OWN index/name in each session (they can differ),
    // with a by-id fallback for sessions no region currently covers.
    const liveByKey = new Map();
    const liveById = new Map();
    for (const u of this.units) {
      const sess = this.logicalSession(u);
      for (const w of (u.layout?.windows || [])) {
        const k = sess + '\x00' + w.id;
        if (!liveByKey.has(k)) liveByKey.set(k, w);
        if (!liveById.has(w.id)) liveById.set(w.id, w);
      }
    }
    // Global @wt_working for EVERY window id, regardless of which session each region
    // is attached to. Each region's `layout.windows` only lists ITS OWN session, so a
    // window in another session (a claude-editors tab while this region views services)
    // had no status and its dot flipped blank/stale as focus roamed. `allWorking` is
    // the server's `list-windows -a` snapshot (same on every layout); merge across
    // regions so it's populated even before the focused region's first layout arrives.
    const workingById = new Map();
    for (const u of this.units) {
      const aw = u.layout?.allWorking;
      if (aw) for (const id in aw) if (!workingById.has(id)) workingById.set(id, aw[id]);
    }
    // Windows shown by OTHER panes are not selectable here (they'd put two panes on
    // one window) — greyed out, like the sidebar. One shared source: occupiedWindowIds.
    const occupied = this.occupiedWindowIds(focused);
    this.toolbar.recent = this.recentWindows.map(e => {
      const live = liveByKey.get(e.session + '\x00' + e.id) || liveById.get(e.id);
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
        // Keep the entry's OWN logical session — never overwrite it with the capture
        // cache's single label, or the two linked-window tabs would collapse to one.
        session: e.session || c?.sessionName || '',
        // Active only when the focused pane shows this window IN THIS entry's session.
        active: e.id === activeId && e.session === focusedSession,
        disabled: occupied.has(e.id),
        // Self-reported work status from @wt_working: "1" working (green), "0" stopped
        // (red), "" unset (unfilled dot). Prefer the global map (correct across sessions)
        // and fall back to the focused region's per-session copy only if absent.
        working: workingById.has(e.id) ? workingById.get(e.id) : (live?.working || ''),
      };
    });
    // Flash the tabs whose stoplight dropped out of green behind your back. Runs on
    // the SAME entries the toolbar is about to render, so what raises an alert is
    // exactly the dot the user would have had to notice.
    this.workAlerts.mark(this.toolbar.recent);
    // Persist AFTER the loop above refreshed each entry's name/index from the live
    // layouts, so a tmux rename is durable too (and after the prune, so a deleted
    // window doesn't come back on the next reload). Signature-guarded — see
    // _persistRecents; the common no-change case costs one JSON.stringify.
    this._persistRecents();
    this.toolbar.collapsed = !!this.sidebar?.collapsed;
    // Keep the toolbar's scroll-mode label reflecting the focused pane's setting.
    if (focused?.scrollMode) this.toolbar.scrollMode = focused.scrollMode;
    // The same working map the recents dots read, handed to the Preview so its tiles
    // (and the corner box) can show each window's stoplight in their top-right corner.
    this.pip?.setWorking(workingById);
    this.toolbar.previewWindow = this.hover?.windowId || '';
    // Preview button state: how many windows are queued, whether it's hidden, and
    // whether the FOCUSED pane's current window is one of them (so the add/remove
    // button can show it's already in the preview).
    this.toolbar.previewCount = this.pip?.count || 0;
    this.toolbar.previewHidden = !!this.pip?.hidden;
    this.toolbar.previewHasFocused = !!(activeId && this.pip?.hasWindow(activeId));
    // Tell the preview which window the focused pane shows, so a single-window PiP
    // of that very window blanks itself (it'd only duplicate what's already on
    // screen). Reappears the instant the focused pane moves to another window.
    this.pip?.setFocusedWindow(activeId);
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
    this.goToWindowIn(this.focusedUnit, id, session);
  }

  // goToWindow, but into an EXPLICIT region. The rule in (1) above — "the focused
  // pane is the one navigation target" — holds for every switcher the user drives
  // blind; committing a hover preview is the one case where the user has already
  // SEEN the window somewhere specific, so it switches there instead (and focuses
  // it, which makes it the navigation target from then on). Everything else routes
  // through goToWindow and lands on the focused region exactly as before.
  goToWindowIn(unit, id, session = '') {
    if (!id) return;
    const u = unit || this.focusedUnit;
    if (!u) return;
    // Any real navigation ends an in-progress browse. Reached from commit() this is
    // already a no-op (commit clears the preview before calling us); it matters for
    // the switchers that navigate outright — Exposé, ⌃⌥P/N, the MRU walk — which
    // must not leave a region stuck holding someone else's screen.
    this.hover.cancel();
    if (u !== this.focusedUnit) this.focus(u);
    if (this.occupiedWindowIds(u).has(id)) return;
    const curSession = this.logicalSession(u);
    // A target session that differs from the pane's current one means HOP there —
    // even if the pane is already on this window id (a window linked into two
    // sessions: switching from its session-A view to its session-B view is a real
    // navigation, not a no-op).
    const needHop = !!session && session !== curSession;
    if (u.layout?.activeWindowId === id && !needHop) { u.terminal?.focus(); return; }  // already showing it here
    const inList = (u.layout?.windows || []).some(w => w.id === id);
    if (needHop) {
      // Guard the hop's intermediate layout: it may flash this window in the session
      // we're LEAVING before the switch completes, which would (re)note an access in
      // the old session — see _onUnitLayout's _navSuppress handling.
      u._navSuppress = { id, session: curSession };
      u.switchSession(session);
    } else if (!inList) {
      if (!session || !u.layout || session === curSession) return; // unreachable
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
    const activeSession = focused ? this.logicalSession(focused) : '';
    const occupied = this.occupiedWindowIds(focused);
    const selectable = list.filter(e => !occupied.has(e.id));
    if (!selectable.length) return;
    // Anchor on the entry for the exact (window, session) the focused pane shows, so
    // stepping walks past a linked window's OTHER-session tab rather than sticking.
    const isActive = (e) => e.id === activeId && e.session === activeSession;
    const idx = selectable.findIndex(isActive);
    const next = idx === -1
      ? selectable[dir > 0 ? 0 : selectable.length - 1]
      : selectable[(idx + dir + selectable.length) % selectable.length];
    if (next && !isActive(next)) this.goToWindow(next.id, next.session);
  }

  // Ctrl+Alt+L recent-window cycle — the "hold the chord and tap L" MRU walker,
  // like alt-tab. Distinct from navigateRecents (the ≤5 stable strip on P/N): this
  // walks the FULL access history newest→oldest. The order is SNAPSHOTTED when a
  // cycle starts and reused until the chord is released (_endMruCycle): each hop
  // really switches tmux — which re-ranks recency — so re-reading the order mid-walk
  // would make it squirm under you. dir = +1 forward (older), -1 backward (Shift+L).
  navigateMru(dir) {
    const focused = this.focusedUnit;
    if (!focused) return;
    if (!this._mruCycle) {
      const occupied = this.occupiedWindowIds(focused);
      const curId = focused.layout?.activeWindowId;
      const curSession = this.logicalSession(focused);
      // Every captured window, most-recently-accessed first (the shared Exposé
      // "recent" sort), DEDUPED by window id: a window linked into two sessions has
      // two placements, but the walk must visit it once — else a tap could land on
      // the SAME screen (its other placement) and look like it did nothing. Drop
      // placements another pane already shows; always keep our own current window.
      const seen = new Set();
      const order = this.captureCache.all('recent')
        .map((c) => ({ id: c.windowId, session: c.sessionName || '' }))
        .filter((e) => {
          if (!(e.id === curId || !occupied.has(e.id))) return false;
          if (seen.has(e.id)) return false;
          seen.add(e.id);
          return true;
        });
      // Pin the current window to position 0 (match by id, robust to a session-name
      // mismatch between the capture and the pane's logical session) so the first
      // forward tap lands on the PREVIOUS window — classic alt-tab feel.
      let pos = order.findIndex((e) => e.id === curId);
      if (pos === -1) order.unshift({ id: curId, session: curSession });
      else if (pos > 0) order.unshift(order.splice(pos, 1)[0]);
      if (order.length < 2) return; // nothing else to cycle to
      this._mruCycle = { order, pos: 0, unit: focused, last: null };
    }
    const c = this._mruCycle;
    c.pos = (c.pos + dir + c.order.length) % c.order.length;
    const t = c.order[c.pos];
    if (t) {
      c.last = t;
      // DEFER the recency commit until the chord is released: each hop only PREVIEWS
      // the window (like arrow-browsing the sidebar), so mid-walk hops don't re-rank
      // recency and make the order squirm under you. Suppress this hop's access-note;
      // the window we finally land on is committed once in _endMruCycle.
      focused._suppressAccessIds.add(t.id);
      this.goToWindow(t.id, t.session);
    }
  }

  // End the held-chord MRU walk (Ctrl/Alt keyup or window blur). Commit the window
  // we actually LANDED on as a single access now — the per-hop notes were suppressed
  // while cycling (see navigateMru), mirroring how sidebar browsing commits on
  // release, not on every step. The next chord then starts a fresh, correctly-ranked
  // walk (so tapping again toggles back to where you came from).
  _endMruCycle() {
    const c = this._mruCycle;
    this._mruCycle = null;
    if (!c || !c.last) return;
    const unit = c.unit || this.focusedUnit;
    if (!unit) return;
    const t = c.last;
    unit._accessSeenId = t.id;   // it's the shown window now; keep the layout path from re-noting
    const meta = this._metaFor(unit, t.id);
    const cap = this.captureCache.get(t.id);
    this.noteAccess(t.id, {
      index: meta.index != null ? meta.index : cap?.index,
      name: meta.name || cap?.name || 'bash',
      session: t.session || meta.session || '',
    });
  }

  // Toolbar recent-tab click -> COMMIT the preview you were already looking at (so
  // it lands in the region that showed it), falling back to a plain navigation when
  // nothing was previewed (a click with no hover — touch, or a very fast click).
  pickRecentWindow(entry) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    const session = (typeof entry === 'object' && entry.session) || '';
    this.hover.commit(id, session);
  }

  // Move a recents tab to a new slot (drag-and-drop reorder). The strip's order is
  // otherwise deliberately STABLE — re-accessing a window never moves its tab — so
  // dragging is the only way to arrange it, and the arrangement survives everything
  // except the tab being evicted. `toIndex` is the target GAP (0..length).
  reorderRecent(entry, toIndex) {
    const list = [...this.recentWindows];
    const from = list.findIndex(e => e.id === entry?.id && e.session === entry?.session);
    if (from === -1) return;
    // Translate the insertion gap into a final slot: removing the dragged tab first
    // shifts everything after it down one, so a gap past the source maps one lower.
    let to = toIndex > from ? toIndex - 1 : toIndex;
    to = Math.max(0, Math.min(list.length - 1, to));
    if (to === from) return;
    list.splice(to, 0, list.splice(from, 1)[0]);
    this.recentWindows = list;
    this._refreshToolbar();
  }

  // Tick the toolbar's tmux-activity spinner. Debounced so a burst of commands (a
  // window switch fires several) reads as one increment rather than a blur.
  pulseTmuxActivity() {
    const now = Date.now();
    if (now - (this._lastPulseAt || 0) < 200) return;
    this._lastPulseAt = now;
    this.toolbar?.tickActivity?.();
  }

  // A hover preview appeared/moved/ended: repaint the switchers' "being previewed"
  // highlight. Cheap — both are Lit components that diff.
  onHoverPreviewChange() {
    if (this.toolbar) this.toolbar.previewWindow = this.hover.windowId;
    if (this.sidebar) this.sidebar.previewWindow = this.hover.windowId;
  }

  _pushLayout(unit) {
    const sb = this.sidebar;
    sb.layout = unit.layout || null;
    sb.activePane = unit.layout?.activePaneId || '';
    sb.activeWindow = unit.layout?.activeWindowId || '';
    sb.previewWindow = this.hover?.windowId || '';
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

  // Create a new tmux window in the FOCUSED pane's own session (Command+Option+C /
  // Ctrl+Option+C). The server creates it with `new-window -t <that pane's session>`
  // and tmux switches to it, so the focused pane lands on the fresh window — and,
  // for a split region, it joins the shared (base) window list like any other.
  newWindowInFocused() {
    this.focusedUnit?.newWindow();
  }

  // Ctrl+Alt+, (tmux's `,` = rename-window): open the sidebar if it's collapsed
  // and begin inline-renaming the focused pane's current window. The sidebar owns
  // the rename input, so wait for it to render before starting.
  //
  // append:true — the caret goes to the END of the existing name rather than
  // selecting it. Reaching for this chord mid-work is nearly always "add something
  // to what this window is called"; a select-all would make the very next keystroke
  // wipe the name you were extending.
  renameActiveWindow() {
    const u = this.focusedUnit;
    const id = u?.layout?.activeWindowId;
    if (!id) return;
    const sb = this.sidebar;
    if (sb.collapsed) sb.collapsed = false;
    sb.updateComplete.then(() => sb.startRename(id, { append: true }));
  }

  // Add/remove the FOCUSED region's current window to/from the live preview
  // (Ctrl+Alt+I and the toolbar preview button). One window shows as a corner PiP
  // box; a second flips it to a docked edge bar. onChange keeps the toolbar synced.
  toggleFocusedInPreview() {
    if (!this.pip) return;
    const u = this.focusedUnit;
    const id = u?.layout?.activeWindowId;
    if (!id) return;   // nothing to preview yet (no layout) — no-op
    this.pip.toggleWindow(id, this._metaFor(u, id));
  }

  // Hide/show the whole preview without forgetting which windows are in it.
  togglePreviewHidden() {
    this.pip?.toggleHidden();
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
    // Measure EVERY width in one pass BEFORE writing any flex-grow: interleaving
    // read/write forces a reflow between iterations, so region N would be measured
    // AFTER region N-1 already grabbed the space (grow 700 vs 1) — collapsing it to
    // its min and snapping the divider hard to one side on the first mousedown.
    const regions = [...this.container.querySelectorAll('.region')];
    const widths = regions.map(r => Math.max(1, Math.round(r.getBoundingClientRect().width)));
    regions.forEach((r, i) => { r.style.flexGrow = String(widths[i]); });
    const startX = e.clientX;
    const w1 = widths[regions.indexOf(prevRegion)];
    const w2 = widths[regions.indexOf(nextRegion)];
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
      this._persistWidths();   // final divider ratios → per-client ClientStore
    };
    // userSelect/cursor overrides keep the drag from selecting page text or
    // flipping to the default cursor when the pointer briefly leaves the 4px bar.
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }

  _installControls() {
    // Global shortcuts (capture phase, Ctrl+Alt / Ctrl+Option based so they never
    // hit tmux's own Ctrl-b prefix and browsers don't reserve them). Where tmux has
    // a natural key AFTER its prefix we reuse that same letter, so muscle memory
    // carries over (Ctrl+Alt+<key> here == Ctrl-b <key> in tmux):
    //   w  choose-tree (window/session list) -> toggle the sidebar
    //   p  previous-window / n  next-window   -> step the recents strip
    //   x  kill-pane                          -> close the focused region
    //   [  copy-mode                          -> toggle copy/normal on the focused pane
    //   ?  list-keys                          -> the shortcuts overlay (physical '/')
    // Split-add has no unmodified tmux letter (tmux uses % / ", both need Shift), so
    // it keeps the intuitive Enter. Exposé ('e'), Picture-in-Picture add ('i' = pIp),
    // preview hide/show ('h' = Hide) and remove-current-from-recents ('d' = Dismiss)
    // are webtmux-only, so they keep their own mnemonic letters.
    // stopPropagation keeps xterm from seeing them.
    window.addEventListener('keydown', (ev) => {
      // New window in the focused pane's session: Command+Option+C (Mac) OR
      // Ctrl+Option+C. Handled BEFORE the ⌃⌥-only guard below so the Cmd variant
      // (metaKey, no ctrlKey) is caught too, and swallowed so xterm never sees it
      // as a bare Ctrl+C (which would interrupt the foreground job — see the copy
      // handler in terminal-unit.js).
      if (ev.altKey && (ev.ctrlKey || ev.metaKey) && ev.code === 'KeyC') {
        this.newWindowInFocused();
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (!ev.ctrlKey || !ev.altKey || ev.metaKey) return;
      switch (ev.code) {
        case 'KeyW':                                   // tmux 'w' (choose-tree): toggle sidebar
          this.sidebar?.toggleCollapsed();
          break;
        case 'Enter':                                  // add a split region
          this.splitAdd();
          break;
        case 'KeyX':                                   // tmux 'x' (kill-pane): close focused region
        case 'Backspace':                              // legacy alias, kept for muscle memory
          this.closeFocused();
          break;
        case 'KeyE':                                   // toggle the Exposé overlay
          this.expose?.toggle();
          break;
        case 'KeyI':                                   // add/remove focused window in the preview (i = pIp)
          this.toggleFocusedInPreview();
          break;
        case 'KeyH':                                   // hide/show the whole preview (h = Hide)
          this.togglePreviewHidden();
          break;
        case 'KeyD':                                   // remove the current window from recents/view (d = Dismiss)
          this.removeFocusedFromRecents();
          break;
        case 'KeyP':                                   // tmux 'p' (previous-window): recents left
          this.navigateRecents(-1);
          break;
        case 'KeyN':                                   // tmux 'n' (next-window): recents right
          this.navigateRecents(+1);
          break;
        case 'KeyL':                                   // hold ⌃⌥ + tap L: cycle MRU windows (⇧ reverses)
          if (!ev.repeat) this.navigateMru(ev.shiftKey ? -1 : +1);  // deliberate taps, not key-repeat runaway
          break;
        case 'Slash':                                  // tmux '?' (list-keys): shortcuts overlay
          this.shortcuts?.toggle();
          break;
        case 'Comma':                                  // tmux ',' (rename-window): rename current
          this.renameActiveWindow();
          break;
        case 'BracketLeft':                            // tmux '[' (copy-mode): toggle copy/normal
          this.toggleCopyMode();
          break;
        case 'KeyB':                                   // show/hide the build-id chip
          this.toolbar?.toggleBuild();
          break;
        default:
          return;                                      // not ours — let it through
      }
      ev.preventDefault();
      ev.stopPropagation();
    }, true);

    // Releasing either half of the Ctrl+Alt chord ends an in-progress MRU walk, so
    // the next hold restarts from the freshly-updated recency order. A window blur
    // (tab switch, devtools) can swallow the keyup, so end there too.
    window.addEventListener('keyup', (ev) => {
      if (this._mruCycle && (ev.key === 'Control' || ev.key === 'Alt')) this._endMruCycle();
    }, true);
    window.addEventListener('blur', () => this._endMruCycle());

    // Mac trackpad 2-finger PINCH → Exposé. Browsers report a trackpad pinch as a
    // `wheel` event with ctrlKey set (the same signal used for pinch-zoom): deltaY
    // < 0 = spread (fingers apart / zoom-in), > 0 = pinch (fingers together). We
    // accumulate that signal and, on a decisive SPREAD, open Exposé; a decisive
    // pinch closes it. Each such wheel is swallowed so the page never zooms. This
    // ctrlKey-wheel path is the one signal every engine emits for a trackpad pinch
    // (Chrome/Edge/Firefox/Safari), so there's enough info on the Mac to do this.
    // Gated to Mac so a Ctrl+scroll on a Windows/Linux mouse still zooms as usual.
    if (IS_MAC) {
      this._pinchAccum = 0;
      this._pinchAt = 0;
      window.addEventListener('wheel', (ev) => {
        if (!ev.ctrlKey) return;              // only the pinch-zoom gesture sets ctrlKey
        ev.preventDefault();                   // never let the pinch zoom the page
        ev.stopPropagation();                  // and never let it scroll the terminal
        const now = Date.now();
        if (now - this._pinchAt > 250) this._pinchAccum = 0;   // a pause = a fresh gesture
        this._pinchAt = now;
        this._pinchAccum += -ev.deltaY;        // spread accumulates positive, pinch negative
        const THRESH = 40;                     // deliberate-gesture threshold
        if (this._pinchAccum >= THRESH) {
          this._pinchAccum = 0;
          if (!this.expose?.open) this.expose?.openOverlay(2);
        } else if (this._pinchAccum <= -THRESH) {
          this._pinchAccum = 0;
          if (this.expose?.open) this.expose?.closeOverlay();
        }
      }, { passive: false, capture: true });
    }

    // Buttons in the sidebar dispatch these (composed, cross shadow DOM).
    window.addEventListener('webtmux-split-add', () => this.splitAdd());
    window.addEventListener('webtmux-split-close', (e) => this.removeUnit(e.detail?.unit || this.focusedUnit));
    window.addEventListener('webtmux-expose-open', () => this.expose?.openOverlay());
    window.addEventListener('webtmux-shortcuts-open', () => this.shortcuts?.toggle());
    window.addEventListener('webtmux-pip-toggle', () => this.toggleFocusedInPreview());
  }
}

// --- pane-buffer save helpers ------------------------------------------------

// Decode a capture entry to plain text: base64 ANSI -> UTF-8, then strip SGR
// colour codes (the capture is stored WITH colour, same as the Exposé thumbnails)
// so the saved file is clean readable text.
function paneBufferText(entry) {
  if (!entry || !entry.data) return '';
  const text = new TextDecoder().decode(CaptureCache.decodeAnsi(entry));
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

// Turn a "session-index-name" stub into a safe download filename.
function sanitizeFilename(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'pane';
}

// Hand the browser a text file download (Blob + object URL + synthetic click).
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
