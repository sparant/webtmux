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
import { WorkAlerts, hiddenAlerts, alertOf } from './work-alerts.js';
import { clampRecentsMax, RecentsPersistence } from './recents-strip.js';
import { buildMruOrder } from './mru-order.js';
import { SplitPersistence } from './split-state.js';
import { resolveRestoreView, planRestoreLanding } from './restore-view.js';
import { saveResultBanner } from './save-target.js';
import { IS_MAC } from './os.js';
import { stateStore } from './state-store.js';
import { clientStore } from './client-store.js';
import { READ_ONLY_NOTICE } from './write-guard.js';

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
    this.recentWindows = [];         // {id,index,name,session}, stable order (recentsMax)
    // How many tabs the strip holds. A shared pref (toolbar.recentMax) rather than a
    // constant — see recents-strip.js. Read BEFORE addUnit(): that path can already
    // reach noteAccess, which enforces this bound.
    this.recentsMax = clampRecentsMax(stateStore.section('toolbar').recentMax);
    // Must exist before addUnit() below: that path reaches _refreshToolbar (and so
    // _persistRecents) while the strip is still empty and unrestored.
    this._recents = new RecentsPersistence(stateStore, 'recentTabs', this.recentsMax);
    // Same no-write-before-first-read rule for the 'split' section, plus the
    // shared one (nothing before the tmux server's own blob has been seen) and the
    // adopt/touched bookkeeping — all of it in SplitPersistence, which is testable
    // without a DOM. `_splitRestored` mirrors its read flag for the per-client
    // focusedIndex write in focus(), which is not part of the shared section.
    this._split = new SplitPersistence(stateStore, 'split');
    this._splitRestored = false;
    // Which WINDOWS — every window on the server, not just the five in the strip —
    // are flashing for attention because their stoplight dropped out of green while
    // you were looking elsewhere (see work-alerts.js). Every surface that can show a
    // window reads its flash from this one registry.
    this.workAlerts = new WorkAlerts();
    // Every (session, window) placement on the server, marked with its alert — the
    // universe the registry was last run over, kept so the overflow arrow can be
    // recomputed (and survive a push that arrived without a directory).
    this._placements = [];
    // The flashing windows with nowhere to show themselves: not in the strip, not in
    // the preview, not on screen in any region. The strip's overflow arrow renders
    // them, and its click target is the first of them. Most recent first.
    this.overflowAlerts = [];
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

  // --- write authority ----------------------------------------------------------
  // A webtmux started without `-w` refuses everything that would change tmux or
  // write a file (webtty/authority.go). The browser is told at connect; this is
  // what it does with the answer.
  //
  // Two halves, and both are needed. The `readonly` ATTRIBUTE on each overlay
  // greys its mutating controls out, so a viewer isn't hunting for the click that
  // works — nothing here is a security measure, the server already refused. And
  // the shared StateStore is put in read-only mode: @wt_state is a tmux write, so
  // a viewer's UI arrangement stays in their own browser instead of being queued
  // forever against a server that will never accept it.
  applyWriteAuthority(permit) {
    const ro = permit === false;
    if (this._readOnly === ro) return;
    this._readOnly = ro;
    for (const el of [this.toolbar, this.sidebar, this.expose, this.pip]) {
      el?.toggleAttribute?.('readonly', ro);
    }
    if (this.toolbar) this.toolbar.readOnly = ro;
    if (this.sidebar) this.sidebar.readOnly = ro;
    stateStore.setReadOnly(ro);
    if (ro) this.showNotice(READ_ONLY_NOTICE);
  }

  // Is this connection read-only? Read by the surfaces that build their controls
  // imperatively (Exposé tiles) rather than from a template.
  get readOnly() { return !!this._readOnly; }

  // One transient line in the toolbar. Used for the read-only refusal and for the
  // controller's "refuse, don't guess" errors (TmuxError) — the two cases where an
  // action did nothing for a reason the user cannot see in the terminal.
  showNotice(text) {
    if (!this.toolbar || !text) return;
    this.toolbar.notice = String(text);
    clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => {
      if (this.toolbar) this.toolbar.notice = '';
    }, 6000);
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
    // …and losing/regaining the socket recolors it — see _refreshConnection.
    unit.onConnectionChange = () => this._refreshConnection();
    // The server's write authority, learned from the preferences frame at connect
    // (webtty/authority.go). Every region's connection carries the same answer;
    // applying it from whichever arrives first is idempotent.
    unit.onWriteAuthority = (permit) => this.applyWriteAuthority(permit);
    // A refused control (read-only) explains itself once in the toolbar rather
    // than looking broken.
    unit.onNotice = (text) => this.showNotice(text);
    // Route this unit's capture replies into the shared cache, and give the unit
    // read access for optimistic paint on window switch.
    unit.captureCache = this.captureCache;
    unit.onCaptureData = (payload) => this.captureCache.ingest(payload);
    // Server-side "save pane buffer to file" outcome -> toolbar dropdown feedback,
    // and the pre-save "where would this land?" answer that goes with it.
    unit.onSaveResult = (res) => this.onSaveResult(res);
    unit.onSaveInfo = (info) => this.onSaveInfo(info);
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
    if (!primary) {
      this._touchSplit();                  // a new region is this client's own arrangement
      this._persistSplitState();           // region count changed → shared 'split'
    }
    return unit;
  }

  // Return every region to equal `flex: 1 1 0` by clearing the inline flex-grow a
  // divider drag stamped on. Called on add/remove so a new/removed region doesn't
  // inherit stale grow ratios (which would render the un-stamped region as a sliver).
  _equalizeRegions() {
    for (const r of this.container.querySelectorAll('.region')) r.style.flexGrow = '';
  }

  // --- split-view persistence --------------------------------------------------
  // Shared: which VIEW each region shows — (session, window), never a window id
  // alone. `regions` covers the EXTRA regions only — regions[i] is units[i+1] — and
  // the primary's view is a SEPARATE `primaryWindowId`/`primarySession` pair rather
  // than regions[0].
  //
  // That split looks redundant but is deliberate: `regions` already exists in every
  // saved blob with the meaning "extras only". Folding the primary in as regions[0]
  // would silently reinterpret that stored data, and a blob holding one extra region
  // would read back as "primary, no splits" — quietly destroying a split on first
  // load. A new key is unambiguous for old and new blobs alike.
  //
  // The SESSION is half the address, not a nice-to-have: a pane's window list only
  // covers the session it is attached to, and every reload re-attaches the primary to
  // the shared base (attach-web.sh mode 2), so a window id saved while the pane was
  // viewing another session cannot be found on load. Without the session the restore
  // just no-ops and the primary parks on the base session's current window — which is
  // why a refresh always landed on the same base-session window instead of where you
  // were. See split-state.js.
  //
  // The primary's view is real tmux state (its attach is SHARED with the ssh
  // console — server/handlers.go), not a private browser view, so it belongs in the
  // shared blob rather than ClientStore. Restoring it re-selects the base session's
  // current window, which moves the console too; that is the accepted trade for the
  // main region remembering where you were. Per-client width/focus stay in ClientStore.
  // The whole saved view: the extra regions plus the primary's own pair.
  _splitView() {
    const primary = this._viewOf(this.units[0]);
    return {
      regions: this.units.slice(1).map((u) => this._viewOf(u)),
      primaryWindowId: primary.windowId,
      primarySession: primary.session,
    };
  }

  // Publish the current view. Both write guards live in SplitPersistence (see
  // split-state.js): nothing before this client has READ the section, and nothing
  // before the first layout push has told us what the tmux server actually holds.
  // The second one is what stops a browser opening for the first time from
  // publishing its empty cache over everyone else's split.
  _persistSplitState() {
    if (this._restoringSplit) return false;
    return this._split.persist(this._splitView());
  }

  // The user has arranged THIS client's split by hand — navigated a region, added
  // one, closed one. From here the shared blob no longer re-applies itself over the
  // top (see _adoptSplitState); adopting after a deliberate act would yank the view
  // out from under them. Restore-driven changes are not touches, hence the guard.
  _touchSplit() {
    if (!this._restoringSplit) this._split.markTouched();
  }

  // A region's saveable view: the window it shows (or is on its way to) plus the
  // LOGICAL session it shows it in — the pair every restore needs. In-flight values
  // win over the live layout, for two reasons:
  //   • a save mid-switch should record where the pane is going, not what it is leaving;
  //   • a cross-session hop emits an intermediate layout that reports the TARGET window
  //     while still naming the OLD session (the transient _navSuppress guards against).
  //     Reading the session off that layout would save a pair that cannot be honored,
  //     so the pending _targetSession — the session we asked for — is used instead.
  // A region recreated by _restoreSplitState has neither yet, only the view it is
  // waiting to land on; without that branch any persist that happens between the
  // region being created and its first layout arriving would replace every saved
  // region view with a null.
  _viewOf(unit) {
    if (!unit) return { windowId: null, session: null };
    if (unit._restoreWindowId) {
      return { windowId: unit._restoreWindowId, session: unit._restoreSession || null };
    }
    return {
      windowId: unit._targetWindowId || unit.layout?.activeWindowId || null,
      session: unit._targetSession || this.logicalSession(unit) || null,
    };
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
  // Defensive: a stale/absent view just leaves that region on its default (handled
  // in _onUnitLayout via _applyRestoreTarget); no saved regions => a no-op.
  _restoreSplitState() {
    // Read BEFORE anything can write (SplitPersistence enforces that). readSplitState
    // also owns the rule that `regions` excludes the primary — see split-state.js.
    const saved = this._split.restore();

    // Every read of the blob is done, so writes are safe from here on. Region
    // creation below is covered separately by _restoringSplit.
    this._splitRestored = true;

    this._applySplitView(saved, { boot: true });

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

    // ADOPT, DON'T RESTORE-ONCE. Everything above came out of this browser's own
    // localStorage cache, which on a first-ever visit is empty and on a stale one is
    // wrong. The tmux server's copy is the shared truth, and it lands one layout push
    // later — so re-apply from it, unless the user has already arranged this client's
    // split by hand in the meantime.
    stateStore.onFirstLoad(() => this._adoptSplitState());
  }

  // Put a saved view on screen. At boot the extra regions don't exist yet, so this
  // creates them. On an ADOPT the current ones are torn down first — reached only
  // when the user hasn't touched this client's split, so nothing of theirs is lost.
  //
  // The primary's view is claimed before the extras so that a stale blob naming the
  // same window twice resolves deterministically in the primary's favour rather than
  // by whichever layout happens to arrive first. A view with no primaryWindowId
  // (blobs written before it was persisted) leaves the primary on whatever window
  // the base session is showing — the old console-driven behavior.
  _applySplitView(view, { boot = false } = {}) {
    const list = (view && view.regions) || [];
    if (!boot && !list.length && this.units.length === 1 && !view.primaryWindowId) return;
    this._restoringSplit = true;
    try {
      if (!boot) {
        for (const u of this.units.slice(1)) this.removeUnit(u);
      }
      if (view && view.primaryWindowId && this.units[0]) {
        this.units[0]._restoreWindowId = view.primaryWindowId;
        this.units[0]._restoreSession = view.primarySession;
      }
      for (const v of list) {
        const unit = this.addUnit({});
        if (v.windowId) {
          unit._restoreWindowId = v.windowId;
          unit._restoreSession = v.session;
        } else {
          unit._autoPickPending = true;   // no saved window → MRU auto-pick
        }
      }
    } finally {
      this._restoringSplit = false;
    }
  }

  // Re-apply the split from the authoritative blob (decision 2). A no-op when the
  // server agrees with what we already show, and when the user has taken over.
  _adoptSplitState() {
    const view = this._split.adopt();
    if (!view) return;
    this._applySplitView(view);
    // The region COUNT may have changed, so this client's saved widths no longer
    // describe anything; add/remove already re-equalized, so record that.
    this._persistWidths();
    this._refitSoon();
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
    // A closed region takes its (possibly dead) socket with it — the warning must go
    // with it, or closing the broken region leaves the toolbar claiming tmux is gone.
    this._refreshConnection();
    this._syncSplitClass();
    this._equalizeRegions();   // remaining regions re-split evenly
    this.focus(this.units[Math.min(idx, this.units.length - 1)] || this.units[0]);
    this._refitSoon();
    this._touchSplit();              // closing a region is this client's own arrangement
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
    // restores your own focus without leaking to other browsers). Gated on
    // _splitRestored like _persistSplitState: the constructor's addUnit() focuses
    // the primary before _restoreSplitState has read the saved index, and that
    // write would clobber it with 0 (ClientStore writes synchronously).
    if (this._splitRestored && !this._restoringSplit) {
      clientStore.patch({ focusedIndex: this.units.indexOf(unit) });
    }
  }

  // Forward a unit's layout to the shared sidebar ONLY when it is the focused
  // region (so the one sidebar always reflects the focused window), and drive the
  // most-recently-used-window auto-pick for a freshly added region.
  _onUnitLayout(unit) {
    // Shared visual state rides every layout push (layout.state === @wt_state). Feed
    // it from the primary unit only — the blob is identical across units, so one
    // authority avoids redundant applies. StateStore ignores echoes of our own write.
    // The serverStart half is the tmux SERVER's identity: it keys the browser's
    // offline cache, so a socket swap (or a killed-and-restarted server, whose rev
    // sequence restarts at 1) can't have a stale cached rev suppress the new
    // server's real blob. Absent from older servers => the legacy single key.
    if (unit.primary) stateStore.load(unit.layout && unit.layout.state, unit.layout && unit.layout.serverStart);

    // The same push carries the server-wide window DIRECTORY, which is the only
    // thing that can tell the recency store that a window it still ranks no longer
    // exists. Fed from the primary alone (the directory is identical on every unit).
    if (unit.primary && unit.layout?.allWindows?.length) {
      this.captureCache.noteLiveWindows(new Set(unit.layout.allWindows.map((w) => w.id)));
    }

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
        unit._targetSession = this.logicalSession(unit);   // same session — no hop
        unit._accessSeenId = activeId;
        unit.selectWindow(target);
      }
      unit._autoPickPending = false;
    }

    this._applyRestoreTarget(unit);

    // An in-flight goToWindow target that the layout now confirms is no longer
    // "pending" — clear it even when it wasn't a change (e.g. re-selecting the
    // window the pane was already on), so it can't linger as a phantom claim.
    const newId = unit.layout?.activeWindowId;
    if (unit._targetWindowId && unit._targetWindowId === newId) unit._targetWindowId = null;
    // The session half of the same claim (read by _viewOf while a hop is in flight)
    // clears only once the pane really is on that session — a cross-session hop's
    // intermediate layout reports the target window with the OLD session still named,
    // and dropping the claim there would persist a (session, window) pair that never
    // existed. A hop that never lands keeps the claim, exactly as the window half
    // above already does.
    if (unit._targetSession && unit._targetSession === this.logicalSession(unit)) {
      unit._targetSession = null;
    }

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
      // Any region landing on a new window changes the saved layout — including the
      // primary, whose view is now restored too (primaryWindowId + primarySession).
      this._persistSplitState();
    }

    // A pane can change SESSION without changing window: a window LINKED into two
    // sessions, viewed through the other one. The saved view is a pair, so that hop
    // needs its own trigger — the window-change branch above never fires for it, and
    // the blob would keep naming the session we left.
    const nowSession = this.logicalSession(unit);
    if (unit._seenSession !== nowSession) {
      unit._seenSession = nowSession;
      this._persistSplitState();
    }
    this._refreshToolbar();
  }

  // Restore-target: a region wants to land on the VIEW — (session, window) — it showed
  // last time, either an extra region recreated by _restoreSplitState() or the primary
  // restored from primaryWindowId/primarySession. Runs once per region, on the first
  // layout after boot. WHICH view (and why the session half is not optional) is
  // resolveRestoreView's job — see restore-view.js; this is the part that has to touch
  // the live pane.
  //
  // When the resolved view is in another session we HOP first, exactly as goToWindowIn
  // does for a live switch: that is what brings a window outside this pane's own
  // session list within reach of select-window.
  //
  // For the PRIMARY a select-window acts on the base session, whose attach is SHARED
  // with the ssh console, so the console follows. The already-there check below means
  // that only happens when the view actually differs — a reload that lands where tmux
  // already is stays silent.
  _applyRestoreTarget(unit) {
    if (!unit.layout) return;
    if (!unit._restoreWindowId) {
      // The PRIMARY can reach its first layout with no saved view at all (a blob from
      // before primaryWindowId was persisted, a cold localStorage cache, a first-ever
      // visit). That layout shows wherever the attach parked it — the base session's
      // current window — and it is an attach, not a visit: mark it seen so the
      // access-note in _onUnitLayout doesn't put it in the recents strip. Every other
      // unit arrives with a restore target or _autoPickPending, which own their own
      // suppression; _accessSeenId is only ever null before the first layout, so this
      // cannot swallow a later real switch.
      if (unit.primary && unit._accessSeenId == null) {
        unit._accessSeenId = unit.layout.activeWindowId;
      }
      return;
    }
    const saved = { windowId: unit._restoreWindowId, session: unit._restoreSession };
    unit._restoreWindowId = null;
    unit._restoreSession = null;

    const cur = this.logicalSession(unit);
    const view = resolveRestoreView({
      saved,
      session: cur,
      windows: (unit.layout.windows || []).map((w) => w.id),
      placements: this._windowPlacements(unit),
      occupied: this.occupiedWindowIds(unit),
      recents: this.recentWindows,
      recency: (id) => this.captureCache.accessed.get(id) ?? 0,
    });

    // The boot window is a visit only if the USER picks it later; whether to mark it
    // seen — including on the stay-put outcomes, which used to leak it into the
    // recents strip on every reload — is planRestoreLanding's job (restore-view.js),
    // where the rules are pinned by tests. The linked-window exception (same id,
    // other session: marking would swallow the landing's real access) lives there
    // too; its intermediate layout is covered by _navSuppress below instead.
    const bootId = unit.layout.activeWindowId;
    const plan = planRestoreLanding({ view, bootId, session: cur });
    if (plan.markSeen) unit._accessSeenId = plan.markSeen;
    if (!plan.nav) return;   // nothing restorable, or already there
    unit._targetWindowId = plan.nav.id;
    unit._targetSession = plan.nav.session;
    if (plan.nav.hop) {
      // Same transient guard the live switcher uses (see _onUnitLayout's _navSuppress).
      unit._navSuppress = { id: plan.nav.id, session: cur };
      unit.switchSession(plan.nav.session);
    }
    unit.selectWindow(plan.nav.id);
  }

  // Every (session, window) placement on the tmux server, from the directory that
  // rides every layout push (layout.allWindows — see pkg/tmux/types.go). Empty when a
  // server sends no directory; the caller owns what to do then (resolveRestoreView
  // falls back to the pane's own single-session window list).
  //
  // Not to be confused with the `_placements` FIELD, which is the alert-marked
  // universe the flash registry was last run over — a different question about the
  // same directory.
  _windowPlacements(unit) {
    return (unit.layout?.allWindows || []).map((w) => ({ id: w.id, session: w.session || '' }));
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
        .map(u => this._shownWindowId(u))
        .filter(Boolean)
    );
  }

  // The window a region shows, or is on its way to showing. A pending
  // _restoreWindowId counts as a claim too: during boot several regions hold a
  // restore target and none has navigated yet, so without this two of them could
  // resolve onto the same window depending on which layout arrived first.
  //
  // One accessor because "is this window taken" and "which region has it" are the
  // same question asked twice (occupiedWindowIds / _unitShowing) — answering them
  // from different expressions is how they end up disagreeing.
  _shownWindowId(u) {
    return u._targetWindowId || u._restoreWindowId || u.layout?.activeWindowId;
  }

  // The region OTHER than `exclude` that is showing (or claiming) `id`, if any.
  _unitShowing(id, exclude) {
    return this.units.find(u => u !== exclude && this._shownWindowId(u) === id) || null;
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
      if (list.length < this.recentsMax) {
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

  // Change how many tabs the strip holds (the "Recent ▾" menu, or another browser
  // writing toolbar.recentMax). Raising it just leaves room the next accesses fill;
  // LOWERING it has to evict, and it evicts by the same rule noteAccess does — least
  // recently accessed first — so shrinking the strip and then letting it refill by
  // hand land on the same tabs. The survivors keep their display ORDER, because that
  // order is arranged by hand (drag) and re-sorting it by recency would silently undo
  // the arrangement as a side effect of a size change.
  setRecentsMax(max) {
    const next = clampRecentsMax(max);
    if (next === this.recentsMax) return;
    this.recentsMax = next;
    this._recents.setMax(next);
    if (this.recentWindows.length > next) {
      const recencyOf = (e) => this.captureCache.accessed.get(e.id) ?? 0;
      const keep = new Set(
        [...this.recentWindows]
          .sort((a, b) => recencyOf(b) - recencyOf(a))
          .slice(0, next),
      );
      this.recentWindows = this.recentWindows.filter((e) => keep.has(e));
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
  //
  // That funnel ALSO runs during construction (addUnit -> focus -> _refreshToolbar),
  // before _restoreRecents has read anything. RecentsPersistence.persist is inert
  // until restore() has run precisely because of that: writing there would clobber
  // the saved strip with [] and make the restore read back its own empty write.
  _persistRecents() {
    this._recents.persist(this.recentWindows);
  }

  // Seed the strip from the shared blob at boot, and adopt it when ANOTHER client
  // changes it. Entries are sanitized (the blob is user-writable tmux state) and
  // capped at recentsMax, the same bound noteAccess enforces. Windows that died while this
  // client was away are NOT filtered here — no layout has arrived yet, so there is
  // nothing to compare against; _pruneDeletedRecents drops them on the first push.
  _restoreRecents() {
    this.recentWindows = this._recents.restore();

    // A remote write (another browser) replaces the strip wholesale — same
    // last-writer-wins rule the rest of the blob follows. The refresh below runs
    // inside StateStore's _applying guard, so the _persistRecents it triggers is a
    // no-op and cannot loop the adopted value back to the server.
    stateStore.subscribe((_state, fromRemote) => {
      // The cap first, and on LOCAL writes too: the "Recent ▾" menu patches the blob
      // and this is what turns that into an actual resize. setRecentsMax is a no-op
      // when the value hasn't moved, which is every other write to the blob.
      this.setRecentsMax(stateStore.section('toolbar').recentMax);
      if (!fromRemote) return;
      const next = this._recents.adopt();
      if (!next) return;                // echo of our own write, or another section
      this.recentWindows = next;
      // OUT of the apply, deliberately. This subscriber runs inside StateStore's
      // _applying guard, which swallows every write — and the refresh is not just a
      // render: it PRUNES tabs whose window has died (_pruneDeletedRecents) and has
      // to publish that. Swallowed, the prune happened locally and never reached the
      // blob, so the next push handed the dead tab straight back and the two clients
      // traded it forever. A microtask is the smallest possible delay that lands
      // after the apply has finished.
      queueMicrotask(() => this._refreshToolbar());
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
    const fname = this.suggestedSaveName();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cache.removeEventListener('update', onUpdate);
      const entry = cache.get(id);
      if (!entry) return; // nothing captured yet — nothing to write
      downloadText(fname, paneBufferText(entry));
    };
    // Only OUR window's frame finishes the save: 'update' also fires for every
    // other surface's poll (PiP 1.5s, sidebar 5s) and for the empty recency-only
    // events, any of which would download whatever stale snapshot the cache held
    // while the forced capture was still in flight.
    const onUpdate = (e) => {
      if ((e.detail?.captures || []).some((c) => c.windowId === id)) finish();
    };
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
  savePaneBufferToPath(path, overwrite = false) {
    const u = this.focusedUnit;
    const id = u?.layout?.activeWindowId;
    if (!id || !u) return;
    const p = String(path || '').trim();
    if (!p) return;
    // Remember what was asked for: the server refuses an existing file on the
    // first ask, and answering "Overwrite" has to re-send the SAME path rather
    // than re-read an input the user may have clicked away from.
    this._lastSaveRequest = { windowId: id, path: p, unit: u };
    if (this.toolbar) this.toolbar.saveStatus = { state: 'saving', text: 'Saving…' };
    u.sendSavePaneFile(id, p, this.saveDir(), overwrite);
  }

  // "Overwrite" in the save dropdown: re-send the refused request with the answer
  // attached. Bound to the request that was refused, not to the input box.
  confirmOverwriteSave() {
    const req = this._lastSaveRequest;
    if (!req || !req.unit) return;
    if (this.toolbar) this.toolbar.saveStatus = { state: 'saving', text: 'Saving…' };
    req.unit.sendSavePaneFile(req.windowId, req.path, this.saveDir(), true);
  }

  // Ask the server where a save for the FOCUSED window would land. Called when the
  // save dropdown opens: the answer (onSaveInfo) replaces the dropdown's hint, so
  // a container's invisible pane directory is disclosed BEFORE a failed save
  // rather than as an open(2) error afterwards. See save-target.js.
  requestSaveInfo() {
    const u = this.focusedUnit;
    const id = u?.layout?.activeWindowId;
    if (!id || !u) return;
    u.sendSaveInfoRequest(id, this.saveDir());
  }

  // The save directory the user named when webtmux had none of its own (a
  // container that shares no directory with the machine tmux runs on — see
  // save-target.js). Kept in the SHARED @wt_state rather than per browser: it is a
  // fact about this deployment ("/workspace is the mounted one"), true for every
  // client on this tmux server, and worth answering once rather than per browser.
  saveDir() {
    return String(stateStore.section('toolbar').saveDir || '');
  }

  // Remember (or clear) that directory and re-probe, so the dropdown immediately
  // shows the destination it produces — or the reason it was rejected.
  setSaveDir(dir) {
    stateStore.patchSection('toolbar', { saveDir: String(dir || '').trim() });
    this.requestSaveInfo();
  }

  // The server's answer. Held on the toolbar, which renders it as the dropdown's
  // hint line and keeps it for the success banner's wording.
  onSaveInfo(info) {
    if (this.toolbar) this.toolbar.saveInfo = info || null;
  }

  // Surface a server-side save outcome in the toolbar's save dropdown. Success
  // shows the absolute path it landed at and auto-dismisses; an error stays up so
  // the user can read it and correct the path.
  onSaveResult(res) {
    if (!this.toolbar) return;
    // The reply carries the environment it was resolved against; keep it so the
    // banner and the hint below it can't tell different stories.
    if (res && res.env && res.env.baseDir) this.toolbar.saveInfo = res.env;
    // Three outcomes, not two: 'confirm' is "that file already exists", which the
    // dropdown answers in place with an Overwrite button. See save-target.js.
    const banner = saveResultBanner(res);
    this.toolbar.saveStatus = { state: banner.state, text: banner.text };
    if (banner.state !== 'ok') return;
    setTimeout(() => {
      if (this.toolbar && this.toolbar.saveStatus?.state === 'ok') {
        this.toolbar.saveOpen = false;
        this.toolbar.saveStatus = null;
      }
    }, 1800);
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
    // Raise/clear the attention flashes across the WHOLE server before anything is
    // rendered, so every surface below reads one settled answer.
    this._placements = this._markWorkAlerts(workingById);
    const alerts = this.workAlerts.snapshot();
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
        // Flash this tab if its window dropped out of green behind your back. Read
        // from the server-wide registry rather than computed here, so a tab that gets
        // evicted and later returns shows the same alert the sidebar and the preview
        // have been showing for it all along.
        alert: alertOf(alerts, e.session, e.id),
      };
    });
    // Persist AFTER the loop above refreshed each entry's name/index from the live
    // layouts, so a tmux rename is durable too (and after the prune, so a deleted
    // window doesn't come back on the next reload). Signature-guarded — see
    // _persistRecents; the common no-change case costs one JSON.stringify.
    this._persistRecents();
    this.toolbar.collapsed = !!this.sidebar?.collapsed;
    // Keep the toolbar's mode labels reflecting the focused pane's settings.
    if (focused?.scrollMode) this.toolbar.scrollMode = focused.scrollMode;
    if (focused?.mouseMode) this.toolbar.mouseMode = focused.mouseMode;
    // The same working map the recents dots read, handed to the Preview and to Exposé
    // so their tiles show each window's stoplight in their top-right corner. One map,
    // four surfaces (strip, sidebar list, preview, Exposé) — a window's light can
    // never say different things in two places.
    this.pip?.setWorking(workingById);
    this.expose?.setWorking(workingById);
    // …and the same for the attention flashes: the sidebar's window rows and the
    // preview's thumbnails flash for exactly the windows the strip's tabs do. Between
    // them and the overflow arrow below, EVERY window that needs you is announced
    // somewhere, which is the whole point — five tabs could never promise that.
    if (this.sidebar) this.sidebar.alerts = alerts;
    this.pip?.setAlerts(alerts);
    this._refreshOverflowAlerts();
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

  // ---- attention flashes -------------------------------------------------------

  // Run the alert state machine over EVERY (session, window) placement on the tmux
  // server and return the marked list.
  //
  // The universe is `layout.allWindows` — the server-wide directory that rides every
  // layout push (see pkg/tmux/types.go). It has to be the whole server, not the
  // strip: an alert that is only computed for windows the strip happens to be holding
  // is an alert you can only get for windows you were already watching, which is
  // precisely backwards.
  //
  // ACKNOWLEDGEMENT (`active`) is "some region is displaying this placement" — the
  // flash asks you to go and look at the window, and having it on screen IS having
  // looked. Scoped per PLACEMENT, not per window: a linked window watched through
  // session A says nothing about the tab you keep for it in session B, matching how
  // the strip has always treated the two as separate tabs.
  _markWorkAlerts(workingById) {
    const shown = new Set();
    for (const u of this.units) {
      const id = u.layout?.activeWindowId;
      if (id) shown.add(WorkAlerts.keyOf(this.logicalSession(u), id));
    }
    const placements = [];
    const seen = new Set();
    for (const u of this.units) {
      for (const w of (u.layout?.allWindows || [])) {
        const key = WorkAlerts.keyOf(w.session, w.id);
        if (seen.has(key)) continue;       // every region carries the same directory
        seen.add(key);
        placements.push({
          id: w.id,
          session: w.session || '',
          index: w.index,
          name: w.name || 'bash',
          // The directory's own copy can be a refresh behind the map the dots read;
          // prefer the map so a flash can never disagree with the dot beside it.
          working: workingById.has(w.id) ? workingById.get(w.id) : (w.working || ''),
          active: shown.has(key),
        });
      }
    }
    // No directory yet (first paint, or a tmux error swallowed the listing): leave the
    // registry ALONE. Marking an empty universe would evict every live alert as
    // "gone", and the windows would then have to drop out of green a second time
    // before anyone heard about it again.
    if (!placements.length) return this._placements || [];
    return this.workAlerts.mark(placements);
  }

  // Recompute the strip's overflow arrow: the flashing windows that have no surface
  // of their own. A window is COVERED when it has a recents tab, sits in the preview,
  // or is on screen in a region — in each case something else is already flashing (or
  // simply visible) on its behalf.
  _refreshOverflowAlerts() {
    const covered = new Set();
    for (const e of (this.toolbar?.recent || [])) covered.add(e.id);
    for (const id of (this.pip?.windowIds?.() || [])) covered.add(id);
    for (const u of this.units) {
      const id = u.layout?.activeWindowId;
      if (id) covered.add(id);
    }
    this.overflowAlerts = hiddenAlerts(this._placements || [], covered);
    if (this.toolbar) this.toolbar.overflowAlerts = this.overflowAlerts;
  }

  // Click on the strip's overflow arrow: go and find the window it is flashing about.
  //
  // It deliberately does NOT switch to that window. It reuses the browse the whole app
  // already speaks — open the window list, PREVIEW the target in a region, leave the
  // commit to the user (Enter, or a click) — because the arrow's own claim is only
  // "something over here changed", and an arrow that hijacked your focused region to
  // prove it would be worse than the problem it solves. Escape restores exactly what
  // was on screen, like every other browse.
  revealOverflowAlert() {
    const target = this.overflowAlerts[0];   // most recently raised
    if (!target || !this.sidebar) return;
    this.sidebar.revealWindow(target.id, target.session);
  }

  // Navigate to a window from ANY switcher (toolbar recent-strip, Exposé tile):
  // change what the FOCUSED pane shows — the model's single navigation rule.
  //   1) Already shown by another pane -> go to THAT pane (see goToWindowIn).
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
    // Already on screen in ANOTHER region: go there. A window is visible in at
    // most one pane, so "show me this window" can only mean the pane that has it.
    //
    // This used to `return`. Every switcher that can SEE the rule handles it
    // first — the toolbar and sidebar grey those tabs out, the keyboard walkers
    // skip them — so the branch was only ever reached by one that can't: Exposé,
    // whose tiles are plain thumbnails with no disabled state. Clicking one whose
    // window happened to live in the other pane did nothing at all, with nothing
    // on screen to say why. Keyed on the window ALONE, not the (session, window)
    // placement: a linked window's two tiles are the same screen, so honouring the
    // session half would put identical content in two regions.
    const holder = this._unitShowing(id, u);
    if (holder) { this.focus(holder); return; }   // focus() focuses its terminal too
    if (u !== this.focusedUnit) this.focus(u);
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
    // A deliberate navigation: from here the shared blob stops re-applying itself
    // over this client's view (see _adoptSplitState).
    this._touchSplit();
    // Claim BOTH halves of the view we're switching to: the window (so no other pane
    // grabs it mid-flight) and the session (so a save mid-hop records where we're
    // going — see _viewOf).
    u._targetSession = session || curSession;
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

  // Keyboard nav across the focused pane's OWN tmux window list (⌃⌥⇧N / ⌃⌥⇧P, and
  // ⌘⌥⇧N/P on a Mac) — the direct analogue of tmux's next-window / previous-window.
  // It walks EVERY window of the session that pane is attached to, in tmux's index
  // order (the same order the sidebar lists), and never leaves that session. That
  // is what makes it worth its own key next to navigateRecents, which walks the ≤5
  // hand-ordered strip and will happily hop sessions.
  // Windows another region already shows are skipped, not landed on (occupiedWindowIds,
  // the one rule every switcher shares — two panes on one window would just mirror),
  // and the walk wraps at both ends exactly like tmux's. If the pane's current
  // window somehow isn't in the list, next starts at the first entry and previous
  // at the last. dir = -1 (previous) or +1 (next).
  navigateWindows(dir) {
    const focused = this.focusedUnit;
    const windows = focused?.layout?.windows || [];
    if (!windows.length) return;
    const activeId = focused.layout?.activeWindowId;
    const occupied = this.occupiedWindowIds(focused);
    const found = windows.findIndex(w => w.id === activeId);
    // Start one step BEFORE the first candidate so the loop's first advance lands on it.
    let i = found === -1 ? (dir > 0 ? -1 : 0) : found;
    for (let n = 0; n < windows.length; n++) {
      i = ((i + dir) % windows.length + windows.length) % windows.length;
      const cand = windows[i];
      if (!cand || cand.id === activeId) continue;   // wrapped back to where we started
      if (occupied.has(cand.id)) continue;           // already on screen in another region
      this.goToWindow(cand.id, this.logicalSession(focused));
      return;
    }
    // Every other window in this session is occupied — nothing to move to.
  }

  // Ctrl+Alt+L recent-window cycle — the "hold the chord and tap L" MRU walker,
  // like alt-tab. Distinct from navigateRecents (the ≤5 stable strip on P/N): this
  // walks the FULL access history newest→oldest. The order is SNAPSHOTTED when a
  // cycle starts and reused until the chord is released (_endMruCycle): each hop
  // really switches tmux — which re-ranks recency — so re-reading the order mid-walk
  // would make it squirm under you. dir = +1 forward (older), -1 backward (Shift+L).
  //
  // The ranking itself lives in mru-order.js. It used to be built here from
  // captureCache.all('recent') alone, which meant the chord did NOTHING for the first
  // few seconds after a browser reload with the sidebar collapsed: nothing was
  // requesting captures, so there were no candidates to rank (the recency map itself
  // reloads fine — it rides @wt_state). The candidate set is now the server-wide
  // window directory, which arrives with every layout push whether or not anything is
  // capturing. See mru-order.js.
  navigateMru(dir) {
    const focused = this.focusedUnit;
    if (!focused) return;
    if (!this._mruCycle) {
      const order = buildMruOrder({
        placements: this._placements || [],
        captures: this.captureCache.all('recent'),
        recents: this.recentWindows,
        accessed: this.captureCache.accessed,
        currentId: focused.layout?.activeWindowId,
        currentSession: this.logicalSession(focused),
        occupied: this.occupiedWindowIds(focused),
      });
      // Fewer than two stops means there is nowhere to go — no layout has landed yet,
      // or this really is the only window. Either way, do nothing rather than
      // "cycling" back into the window we are already in.
      if (order.length < 2) return;
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
    // Drop the walk's per-hop suppressions: rapid taps are coalesced by the 500ms
    // layout poll, so skipped intermediate hops never land and their entries would
    // otherwise sit in the set forever — silently swallowing the access note the
    // next time one of those windows is genuinely visited. The landed window is
    // covered by _accessSeenId below, not by its (now removed) suppress entry.
    for (const e of c.order) unit._suppressAccessIds.delete(e.id);
    unit._accessSeenId = t.id;   // it's the shown window now; keep the layout path from re-noting
    const cap = this.captureCache.get(t.id);
    // Label the new strip entry from the pane's live window list, then the capture,
    // then the window DIRECTORY — the last of which is the only source that covers a
    // window in a session this pane isn't attached to when nothing has captured it.
    // That is the same gap that used to make the walk itself come up empty after a
    // reload; without it the tab lands in the strip labelled 'bash'. (Deliberately
    // not _metaFor: its 'bash' placeholder is always truthy and would swallow both
    // fallbacks.)
    const live = (unit.layout?.windows || []).find((w) => w.id === t.id);
    const dir = (this._placements || []).find(
      (p) => p.id === t.id && (!t.session || p.session === t.session),
    ) || (this._placements || []).find((p) => p.id === t.id);
    this.noteAccess(t.id, {
      index: live?.index ?? cap?.index ?? dir?.index,
      name: live?.name || cap?.name || dir?.name || 'bash',
      session: t.session || this.logicalSession(unit) || '',
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

  // Recolor that same spinner when a region's socket drops or comes back.
  //
  // It goes on the SPINNER rather than in a banner because the spinner is already the
  // one thing on screen that means "the tmux side is alive" — it ticks when webtmux
  // talks to tmux, so a dead connection expresses itself as a spinner that simply
  // stops. That is indistinguishable from an idle one, which is the whole problem:
  // the panes keep showing their last painted screen, the window list keeps listing
  // windows, and nothing looks wrong until you type into a terminal that answers
  // nothing. Red on the control you already read for liveness says it in the place
  // you were already looking.
  //
  // ANY region counts. A split's regions each hold their own socket, and one of them
  // going dark means part of what's on screen is a photograph — the toolbar spinner
  // is global, so it reports the worst case and the tooltip names the count.
  //
  // The two failures are counted separately because they need different words. A
  // CLOSED socket is self-healing: the retry loop is already running and the tooltip
  // can honestly say to wait. A STALLED one — open, mute, see TerminalUnit's heartbeat
  // — is not: nothing is retrying, because as far as the browser is concerned nothing
  // is wrong. Telling someone to sit tight in that case is telling them to keep typing
  // into a socket that will never answer.
  _refreshConnection() {
    if (!this.toolbar) return;
    const closed = this.units.filter((u) => u._wasClosed && !u.isConnected()).length;
    const stalled = this.units.filter((u) => u.isStalled?.()).length;
    this.toolbar.lostRegions = closed;
    this.toolbar.stalledRegions = stalled;
    this.toolbar.disconnected = closed + stalled > 0;
  }

  // A hover preview appeared/moved/ended: repaint the switchers' "being previewed"
  // highlight. Cheap — both are Lit components that diff.
  onHoverPreviewChange() {
    if (this.toolbar) this.toolbar.previewWindow = this.hover.windowId;
    if (this.sidebar) {
      this.sidebar.previewWindow = this.hover.windowId;
      // …and WHICH placement: the sidebar's tree view lists a linked window once per
      // session, and only the row the preview belongs to should light up.
      this.sidebar.previewSession = this.hover.session || '';
    }
  }

  _pushLayout(unit) {
    const sb = this.sidebar;
    sb.layout = unit.layout || null;
    sb.activePane = unit.layout?.activePaneId || '';
    sb.activeWindow = unit.layout?.activeWindowId || '';
    sb.previewWindow = this.hover?.windowId || '';
    sb.previewSession = this.hover?.session || '';
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
    //   P  previous-window / N  next-window   -> step the SESSION's window list
    //   x  kill-pane                          -> close the focused region
    //   [  copy-mode                          -> toggle copy/normal on the focused pane
    //   ?  list-keys                          -> the shortcuts overlay (physical '/')
    // Split-add has no unmodified tmux letter (tmux uses % / ", both need Shift), so
    // it keeps the intuitive Enter. Exposé ('e'), Picture-in-Picture add ('i' = pIp),
    // preview hide/show ('h' = Hide) and remove-current-from-recents ('d' = Dismiss)
    // are webtmux-only, so they keep their own mnemonic letters.
    // stopPropagation keeps xterm from seeing them.
    window.addEventListener('keydown', (ev) => {
      // AltGr on Windows (and some Linux layouts) reports as Ctrl+Alt, so without
      // this guard every AltGr+letter — € on German, ę/ń/ć on Polish — would fire
      // a chord (KeyX closes a region, KeyC opens a window) and never reach the
      // terminal. AltGraph is never part of our chords.
      if (ev.getModifierState && ev.getModifierState('AltGraph')) return;
      // An open modal layer owns the keyboard. Its own capture listener can't
      // shield us — stopPropagation doesn't reach other listeners on the same
      // target, and this one was registered first — so the refusal lives here:
      // while a confirm question, the shortcuts overlay, or Exposé is up, the only
      // chord that still acts is the one that toggles that layer itself.
      if (this.sidebar?._confirm?.open) return;
      if (this.shortcuts?.open && ev.code !== 'Slash') return;
      if (this.expose?.open && ev.code !== 'KeyE') return;
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
      // CAPITAL N / P (i.e. the chord + Shift): step the focused pane's own tmux
      // WINDOW LIST, in tmux's index order — literally tmux's ⌃b n / ⌃b p. The
      // lowercase n/p in the switch below step the recents strip instead; the two
      // are different lists (the strip holds ≤5 windows, can span sessions, and is
      // hand-ordered), so they get different keys rather than one key that guesses.
      // Matched HERE, above the ⌃⌥-only guard, so Command+Option+⇧N/P works on a
      // Mac too — same both-hands-fit reasoning as the ⌥C new-window chord above.
      if (ev.altKey && ev.shiftKey && (ev.ctrlKey || ev.metaKey) &&
          (ev.code === 'KeyN' || ev.code === 'KeyP')) {
        this.navigateWindows(ev.code === 'KeyN' ? +1 : -1);
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
    //
    // HOW MUCH FINGER TRAVEL IT TAKES IS OURS, not the OS's: the browser reports
    // every increment of the gesture and PINCH_THRESH decides how much of it is
    // "decisive". It started at 40, which was most of a full spread across the
    // trackpad before anything happened — the gesture felt broken rather than
    // deliberate. 12 fires about a third of the way in, still well past the
    // accidental two-finger jitter of a scroll (which doesn't set ctrlKey anyway).
    // The cost of over-sensitivity is small and self-correcting: the opposite
    // gesture is the undo, and _pinchFired keeps ONE gesture from toggling twice.
    if (IS_MAC) {
      this._pinchAccum = 0;
      this._pinchAt = 0;
      this._pinchFired = false;
      const PINCH_THRESH = 12;
      const PINCH_GAP = 250;                   // a pause this long = a fresh gesture
      window.addEventListener('wheel', (ev) => {
        if (!ev.ctrlKey) return;              // only the pinch-zoom gesture sets ctrlKey
        ev.preventDefault();                   // never let the pinch zoom the page
        ev.stopPropagation();                  // and never let it scroll the terminal
        const now = Date.now();
        if (now - this._pinchAt > PINCH_GAP) { // fresh gesture: forget the last one
          this._pinchAccum = 0;
          this._pinchFired = false;
        }
        this._pinchAt = now;
        // Already acted on this gesture — keep swallowing its tail (so it can't
        // zoom the page) but don't toggle again until the fingers come off.
        if (this._pinchFired) return;
        this._pinchAccum += -ev.deltaY;        // spread accumulates positive, pinch negative
        if (this._pinchAccum >= PINCH_THRESH) {
          this._pinchFired = true;
          if (!this.expose?.open) this.expose?.openOverlay(2);
        } else if (this._pinchAccum <= -PINCH_THRESH) {
          this._pinchFired = true;
          if (this.expose?.open) this.expose?.closeOverlay();
        }
      }, { passive: false, capture: true });
    }

    // The sidebar's close-region × dispatches this (composed, cross shadow DOM).
    window.addEventListener('webtmux-split-close', (e) => this.removeUnit(e.detail?.unit || this.focusedUnit));
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
